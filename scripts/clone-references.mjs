#!/usr/bin/env node
/**
 * Clone upstream source repos into ./references for local reading.
 *
 * `references/` is gitignored and absent on a fresh checkout. It holds upstream
 * source that agents/devs grep when working on a related YA surface — currently
 * the Codex Rust source (codex-rs), which is invaluable for the Codex provider,
 * schema, scanner, normalization, and app-server protocol work.
 *
 * Clones are shallow (read-only reading material) and idempotent: an existing
 * `references/<name>` is left untouched. Delete it and re-run to refresh.
 *
 * Usage:
 *   pnpm clone-references
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const REFERENCES_DIR = join(REPO_ROOT, "references");

// Upstream repos worth reading locally. The Codex CLI lives at openai/codex;
// its Rust workspace is the `codex-rs/` subdir. Add { name, url, note } entries
// here to grow the set.
const REFERENCES = [
  {
    name: "codex",
    url: "https://github.com/openai/codex.git",
    note: "Codex CLI source; Rust workspace in codex-rs/",
  },
];

function clone({ name, url, note }) {
  const dest = join(REFERENCES_DIR, name);
  if (existsSync(dest)) {
    console.log(`✓ ${name} already present (${note}) — skipping`);
    return true;
  }

  console.log(`↓ cloning ${name} from ${url} …`);
  const result = spawnSync(
    "git",
    ["clone", "--depth", "1", url, dest],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    console.error(`✗ failed to clone ${name} (git exited ${result.status})`);
    return false;
  }

  console.log(`✓ ${name} cloned into references/${name} (${note})`);
  return true;
}

function main() {
  mkdirSync(REFERENCES_DIR, { recursive: true });

  let ok = true;
  for (const ref of REFERENCES) {
    ok = clone(ref) && ok;
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

main();
