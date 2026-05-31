#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const i18nDir = path.join(repoRoot, "packages", "client", "src", "i18n");
const clientSrcDir = path.join(repoRoot, "packages", "client", "src");
const englishLocale = "en";

function usage() {
  console.log(`Usage: node scripts/prune-i18n-placeholders.mjs --check|--write|--health

Options:
  --check  Report non-English entries exactly equal to en.json and exit 1
           when any are found.
  --write  Remove non-English entries exactly equal to en.json.
  --health Report placeholder duplicates, non-English keys absent from en.json,
           and candidate unused English keys. Candidate unused keys are advisory.
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
  const health = args.has("--health");
  const unknown = argv.filter(
    (arg) =>
      arg !== "--check" &&
      arg !== "--write" &&
      arg !== "--health" &&
      arg !== "--help" &&
      arg !== "-h",
  );

  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  }
  if ([check, write, health].filter(Boolean).length !== 1) {
    throw new Error("Pass exactly one of --check, --write, or --health.");
  }

  if (write) return "write";
  if (health) return "health";
  return "check";
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

function findExtraLocaleKeys(localeMessages, englishMessages) {
  return Object.keys(localeMessages).filter(
    (key) => !Object.hasOwn(englishMessages, key),
  );
}

function omitKeys(object, keysToOmit) {
  const omitted = new Set(keysToOmit);
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => !omitted.has(key)),
  );
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...(await collectSourceFiles(entryPath)));
      continue;
    }

    if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

async function findCandidateUnusedEnglishKeys(englishMessages) {
  const sourceFiles = await collectSourceFiles(clientSrcDir);
  const sourceText = (
    await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))
  ).join("\n");

  return Object.keys(englishMessages).filter(
    (key) => !sourceText.includes(key),
  );
}

function printKeySample(keys) {
  const sample = keys.slice(0, 12).join(", ");
  const suffix = keys.length > 12 ? ", ..." : "";
  console.log(`  ${sample}${suffix}`);
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
  let totalExtraKeys = 0;
  const results = [];

  for (const file of files) {
    const locale = path.basename(file, ".json");
    if (locale === englishLocale) continue;

    const filePath = path.join(i18nDir, file);
    const messages = await readJson(filePath);
    const duplicateKeys = findExactEnglishDuplicates(messages, englishMessages);
    const extraKeys = findExtraLocaleKeys(messages, englishMessages);
    totalDuplicates += duplicateKeys.length;
    totalExtraKeys += extraKeys.length;
    results.push({ file, duplicateKeys, extraKeys });

    if (mode === "write" && duplicateKeys.length > 0) {
      const pruned = omitKeys(messages, duplicateKeys);
      await writeFile(filePath, `${JSON.stringify(pruned, null, 2)}\n`);
    }
  }

  for (const { file, duplicateKeys, extraKeys } of results) {
    if (mode === "health") {
      console.log(
        `${file}: exact English placeholders ${duplicateKeys.length}`,
      );
    } else {
      const verb = mode === "write" ? "removed" : "found";
      console.log(`${file}: ${verb} ${duplicateKeys.length}`);
    }
    if ((mode === "check" || mode === "health") && duplicateKeys.length > 0) {
      printKeySample(duplicateKeys);
    }
    if (mode === "health") {
      console.log(`${file}: extra keys ${extraKeys.length}`);
      if (extraKeys.length > 0) {
        printKeySample(extraKeys);
      }
    }
  }

  if (mode === "health") {
    const candidateUnusedEnglishKeys =
      await findCandidateUnusedEnglishKeys(englishMessages);
    console.log(
      `en.json: candidate unused keys ${candidateUnusedEnglishKeys.length}`,
    );
    if (candidateUnusedEnglishKeys.length > 0) {
      printKeySample(candidateUnusedEnglishKeys);
      console.log(
        "Candidate unused keys are advisory; inspect dynamic references before removal.",
      );
    }

    if (totalDuplicates === 0 && totalExtraKeys === 0) {
      console.log("No blocking i18n key health issues found.");
      return;
    }

    console.error(
      `Found ${totalDuplicates} exact English placeholder(s) and ${totalExtraKeys} extra locale key(s).`,
    );
    process.exitCode = 1;
    return;
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
