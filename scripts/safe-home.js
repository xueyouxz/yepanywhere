import fs from "node:fs";
import path from "node:path";

const ALLOW_ENV_VAR = "YEP_ALLOW_SUSPICIOUS_HOME";
const LEGACY_ALLOW_ENV_VAR = "YEP_ANYWHERE_ALLOW_SUSPICIOUS_HOME";

function normalizeSafeHomeEnv(env = process.env) {
  if (
    env[ALLOW_ENV_VAR] === undefined &&
    env[LEGACY_ALLOW_ENV_VAR] !== undefined
  ) {
    env[ALLOW_ENV_VAR] = env[LEGACY_ALLOW_ENV_VAR];
  }
  delete env[LEGACY_ALLOW_ENV_VAR];
}

function pathEqualsOrContains(parentPath, childPath) {
  if (parentPath === childPath) return true;
  const relative = path.relative(parentPath, childPath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function findRepoRoot(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    if (
      fs.existsSync(path.join(current, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(current, ".git"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function getSuspiciousHomeReason({
  cwd = process.cwd(),
  home = process.env.HOME,
} = {}) {
  if (!home) return null;

  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home);
  const repoRoot = findRepoRoot(resolvedCwd);
  if (!repoRoot) return null;

  if (pathEqualsOrContains(repoRoot, resolvedHome)) {
    return {
      repoRoot,
      resolvedCwd,
      resolvedHome,
      reason: "HOME points inside the repository worktree",
    };
  }

  return null;
}

export function assertSafeHome({
  cwd = process.cwd(),
  home = process.env.HOME,
  entrypoint = "this command",
} = {}) {
  normalizeSafeHomeEnv();
  if (process.env[ALLOW_ENV_VAR] === "true") return;

  const problem = getSuspiciousHomeReason({ cwd, home });
  if (!problem) return;

  const message = [
    `[safe-home] Refusing to start ${entrypoint}.`,
    `[safe-home] ${problem.reason}.`,
    `[safe-home] HOME=${problem.resolvedHome}`,
    `[safe-home] repo=${problem.repoRoot}`,
    "[safe-home] This can redirect pnpm/corepack caches into the repo (for example ./Library/pnpm).",
    "[safe-home] Use narrower overrides like LOG_DIR, LOG_TO_FILE=false, or YEP_DATA_DIR instead of changing HOME.",
    `[safe-home] If this is truly intentional, rerun with ${ALLOW_ENV_VAR}=true.`,
  ].join("\n");

  throw new Error(message);
}

export function exitIfUnsafeHome(options) {
  try {
    assertSafeHome(options);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `[safe-home] ${String(error)}`;
    console.error(message);
    process.exit(1);
  }
}

export { ALLOW_ENV_VAR };
