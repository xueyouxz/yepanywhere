import { exec } from "node:child_process";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getLogger } from "../logging/logger.js";
import { detectCodexCli } from "../sdk/cli-detection.js";

const execAsync = promisify(exec);

const GITHUB_LATEST_URL =
  "https://api.github.com/repos/openai/codex/releases/latest";
const DEFAULT_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

const log = getLogger().child({ component: "codex-update-checker" });

/** How YA can update Codex on this host. */
export type CodexUpdateMethod = "npm" | "manual";

interface CodexInstallMetadata {
  installedPackage: string | null;
  updateMethod: CodexUpdateMethod;
  /** Best-effort copy-pasteable upgrade command for this install path. */
  manualInstallCommand: string | null;
}

export interface CodexUpdateStatus {
  installed: string | null;
  installedPath: string | null;
  /** npm package name (e.g. "@openai/codex") if install path is npm-global. */
  installedPackage: string | null;
  /**
   * How the install can be updated. "npm" means YA can shell out to `npm i -g`
   * itself. "manual" means the user needs to run a platform-specific command.
   */
  updateMethod: CodexUpdateMethod;
  /**
   * A shell command the user can run to upgrade Codex themselves. Populated
   * for npm / homebrew / cargo installs; null when we can't confidently infer
   * the right command.
   */
  manualInstallCommand: string | null;
  latest: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}

export interface CodexUpdateCheckerOptions {
  /** Override the remote fetch (for tests). */
  fetchLatest?: () => Promise<{ tagName: string | null; htmlUrl: string | null }>;
  /** Override the local CLI detection (for tests). */
  detectInstalled?: () => Promise<{
    version: string | null;
    path: string | null;
  }>;
  /** Override install metadata detection (for tests). */
  detectInstallMetadata?: (
    installedPath: string | null,
  ) => Promise<CodexInstallMetadata>;
  /** Override the package install command (for tests). Returns combined stdout/stderr. */
  runInstall?: (pkg: string) => Promise<string>;
  /** Refresh TTL in ms (default: 24h). */
  refreshTtlMs?: number;
}

const INITIAL_STATUS: CodexUpdateStatus = {
  installed: null,
  installedPath: null,
  installedPackage: null,
  updateMethod: "manual",
  manualInstallCommand: null,
  latest: null,
  releaseUrl: null,
  updateAvailable: false,
  lastCheckedAt: null,
  error: null,
};

const DEFAULT_INSTALL_METADATA: CodexInstallMetadata = {
  installedPackage: null,
  updateMethod: "manual",
  manualInstallCommand: null,
};

export class CodexUpdateChecker {
  private status: CodexUpdateStatus = INITIAL_STATUS;
  private inflight: Promise<CodexUpdateStatus> | null = null;
  private readonly fetchLatest: NonNullable<
    CodexUpdateCheckerOptions["fetchLatest"]
  >;
  private readonly detectInstalled: NonNullable<
    CodexUpdateCheckerOptions["detectInstalled"]
  >;
  private readonly detectInstallMetadata: NonNullable<
    CodexUpdateCheckerOptions["detectInstallMetadata"]
  >;
  private readonly runInstall: NonNullable<
    CodexUpdateCheckerOptions["runInstall"]
  >;
  private readonly refreshTtlMs: number;

  constructor(options: CodexUpdateCheckerOptions = {}) {
    this.fetchLatest = options.fetchLatest ?? fetchLatestFromGitHub;
    this.detectInstalled = options.detectInstalled ?? detectInstalledFromCli;
    this.detectInstallMetadata =
      options.detectInstallMetadata ?? detectInstallMetadataFromPath;
    this.runInstall = options.runInstall ?? runNpmGlobalInstall;
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
  }

  async getStatus(options?: { force?: boolean }): Promise<CodexUpdateStatus> {
    const stale =
      options?.force === true ||
      this.status.lastCheckedAt === null ||
      Date.now() - this.status.lastCheckedAt > this.refreshTtlMs;
    if (stale) {
      await this.refresh();
    }
    return { ...this.status };
  }

  async refresh(): Promise<CodexUpdateStatus> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<CodexUpdateStatus> {
    let installed: string | null = null;
    let installedPath: string | null = null;
    let installMetadata = DEFAULT_INSTALL_METADATA;
    try {
      const info = await this.detectInstalled();
      installed = normalizeVersion(info.version);
      installedPath = info.path;
      installMetadata = await this.detectInstallMetadata(installedPath);
    } catch (error) {
      log.debug({ error }, "detectInstalled failed");
    }

    let latest: string | null = null;
    let releaseUrl: string | null = null;
    let error: string | null = null;
    try {
      const result = await this.fetchLatest();
      latest = normalizeVersion(result.tagName);
      releaseUrl = result.htmlUrl;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log.debug({ error: e }, "fetchLatest failed");
    }

    const updateAvailable =
      installed !== null &&
      latest !== null &&
      compareVersions(installed, latest) < 0;

    this.status = {
      installed,
      installedPath,
      installedPackage: installMetadata.installedPackage,
      updateMethod: installMetadata.updateMethod,
      manualInstallCommand: installMetadata.manualInstallCommand,
      latest,
      releaseUrl,
      updateAvailable,
      lastCheckedAt: Date.now(),
      error,
    };
    return { ...this.status };
  }

  /**
   * Run `npm install -g <pkg>@latest` when the install is npm-global.
   * Refreshes status on success. Returns combined stdout/stderr.
   */
  async install(): Promise<{
    success: boolean;
    output: string;
    status: CodexUpdateStatus;
    error?: string;
  }> {
    const current = await this.getStatus();
    if (current.updateMethod !== "npm" || !current.installedPackage) {
      return {
        success: false,
        output: "",
        status: current,
        error:
          "Codex was not installed via npm; update the CLI manually with your package manager",
      };
    }
    const pkg = current.installedPackage;
    log.info({ pkg }, "Running npm install -g for Codex CLI update");
    try {
      const output = await this.runInstall(pkg);
      const refreshed = await this.getStatus({ force: true });
      return { success: true, output, status: refreshed };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      const output = [err.stdout ?? "", err.stderr ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim();
      log.warn({ error: err.message }, "npm install -g failed for Codex CLI");
      return {
        success: false,
        output,
        status: current,
        error: err.message,
      };
    }
  }
}

async function detectInstalledFromCli(): Promise<{
  version: string | null;
  path: string | null;
}> {
  const info = await detectCodexCli();
  return {
    version: info.version ?? null,
    path: info.path ?? null,
  };
}

async function detectInstallMetadataFromPath(
  installedPath: string | null,
): Promise<CodexInstallMetadata> {
  if (!installedPath) {
    return { ...DEFAULT_INSTALL_METADATA };
  }

  let resolvedInstalledPath = path.resolve(installedPath);
  try {
    resolvedInstalledPath = await realpath(installedPath);
  } catch {
    // Keep the original resolved path if realpath fails (e.g. broken symlink).
  }

  const npmGlobalRoot = await getNpmGlobalRoot();
  const installedPackage = npmGlobalRoot
    ? extractNpmGlobalPackageName(resolvedInstalledPath, npmGlobalRoot)
    : null;

  if (installedPackage) {
    return {
      installedPackage,
      updateMethod: "npm",
      manualInstallCommand: `npm install -g ${installedPackage}@latest`,
    };
  }

  return {
    installedPackage: null,
    updateMethod: "manual",
    manualInstallCommand: inferManualInstallCommand(resolvedInstalledPath),
  };
}

/**
 * Best-effort inference of an upgrade command from an install path.
 * Recognized: Homebrew (any prefix containing /Cellar/), cargo installs
 * under ~/.cargo/bin. Returns null when we can't be sure.
 */
export function inferManualInstallCommand(
  resolvedInstalledPath: string,
): string | null {
  if (resolvedInstalledPath.includes(`${path.sep}Cellar${path.sep}`)) {
    return "brew upgrade codex";
  }
  if (resolvedInstalledPath.includes(`${path.sep}.cargo${path.sep}bin${path.sep}`)) {
    return "cargo install --locked codex";
  }
  return null;
}

async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("npm root -g", {
      encoding: "utf-8",
    });
    const npmGlobalRoot = stdout.trim();
    if (!npmGlobalRoot) return null;
    try {
      return await realpath(npmGlobalRoot);
    } catch {
      return path.resolve(npmGlobalRoot);
    }
  } catch {
    return null;
  }
}

function extractNpmGlobalPackageName(
  installedPath: string,
  npmGlobalRoot: string,
): string | null {
  const relativePath = path.relative(npmGlobalRoot, installedPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  const firstSegment = segments[0];
  if (!firstSegment) return null;

  if (firstSegment.startsWith("@")) {
    const secondSegment = segments[1];
    return secondSegment ? `${firstSegment}/${secondSegment}` : null;
  }

  return firstSegment;
}

async function runNpmGlobalInstall(pkg: string): Promise<string> {
  const { stdout, stderr } = await execAsync(`npm install -g ${pkg}@latest`, {
    timeout: 5 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

async function fetchLatestFromGitHub(): Promise<{
  tagName: string | null;
  htmlUrl: string | null;
}> {
  const res = await fetch(GITHUB_LATEST_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "yep-anywhere-update-checker",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status}`);
  }
  const body = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
  };
  return {
    tagName: typeof body.tag_name === "string" ? body.tag_name : null,
    htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
  };
}

function normalizeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/);
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return pre ? `${major}.${minor}.${patch}-${pre}` : `${major}.${minor}.${patch}`;
}

function compareVersions(a: string, b: string): number {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const av = pa.parts[i] ?? 0;
    const bv = pb.parts[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

function splitVersion(v: string): { parts: number[]; pre: string | null } {
  const dash = v.indexOf("-");
  const core = dash === -1 ? v : v.slice(0, dash);
  const pre = dash === -1 ? null : v.slice(dash + 1);
  const parts = core.split(".").map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { parts, pre };
}

export const __testing__ = {
  normalizeVersion,
  compareVersions,
  extractNpmGlobalPackageName,
  inferManualInstallCommand,
};
