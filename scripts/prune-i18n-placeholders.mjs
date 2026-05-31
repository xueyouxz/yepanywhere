#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const i18nDir = path.join(repoRoot, "packages", "client", "src", "i18n");
const englishLocale = "en";

function usage() {
  console.log(`Usage: node scripts/prune-i18n-placeholders.mjs --check|--write

Options:
  --check  Report non-English entries exactly equal to en.json and exit 1
           when any are found.
  --write  Remove non-English entries exactly equal to en.json.
  --help   Show this message.
`);
}

function parseArgs(argv) {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    return "help";
  }

  const check = args.has("--check");
  const write = args.has("--write");
  const unknown = argv.filter(
    (arg) =>
      arg !== "--check" &&
      arg !== "--write" &&
      arg !== "--help" &&
      arg !== "-h",
  );

  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  }
  if (check === write) {
    throw new Error("Pass exactly one of --check or --write.");
  }

  return write ? "write" : "check";
}

async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

function findExactEnglishDuplicates(localeMessages, englishMessages) {
  return Object.entries(localeMessages)
    .filter(
      ([key, value]) =>
        Object.hasOwn(englishMessages, key) && englishMessages[key] === value,
    )
    .map(([key]) => key);
}

function omitKeys(object, keysToOmit) {
  const omitted = new Set(keysToOmit);
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !omitted.has(key)),
  );
}

async function main() {
  const mode = parseArgs(process.argv.slice(2));
  if (mode === "help") {
    usage();
    return;
  }

  const files = (await readdir(i18nDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const englishPath = path.join(i18nDir, `${englishLocale}.json`);
  const englishMessages = await readJson(englishPath);

  let totalDuplicates = 0;
  const results = [];

  for (const file of files) {
    const locale = path.basename(file, ".json");
    if (locale === englishLocale) continue;

    const filePath = path.join(i18nDir, file);
    const messages = await readJson(filePath);
    const duplicateKeys = findExactEnglishDuplicates(messages, englishMessages);
    totalDuplicates += duplicateKeys.length;
    results.push({ file, duplicateKeys });

    if (mode === "write" && duplicateKeys.length > 0) {
      const pruned = omitKeys(messages, duplicateKeys);
      await writeFile(filePath, `${JSON.stringify(pruned, null, 2)}\n`);
    }
  }

  for (const { file, duplicateKeys } of results) {
    const verb = mode === "write" ? "removed" : "found";
    console.log(`${file}: ${verb} ${duplicateKeys.length}`);
    if (mode === "check" && duplicateKeys.length > 0) {
      const sample = duplicateKeys.slice(0, 12).join(", ");
      const suffix = duplicateKeys.length > 12 ? ", ..." : "";
      console.log(`  ${sample}${suffix}`);
    }
  }

  if (totalDuplicates === 0) {
    console.log("No exact English placeholders found in non-English locales.");
    return;
  }

  if (mode === "write") {
    console.log(`Removed ${totalDuplicates} exact English placeholder(s).`);
    return;
  }

  console.error(
    `Found ${totalDuplicates} exact English placeholder(s). Run pnpm i18n:prune to remove them.`,
  );
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
}
