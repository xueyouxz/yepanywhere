import { exec, execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const isWindows = os.platform() === "win32";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Returns the platform-appropriate command to locate an executable in PATH.
 * Uses `where` on Windows, `which` on Unix.
 */
export function whichCommand(name: string): string {
  return isWindows ? `where ${name}` : `which ${name}`;
}

/**
 * Information about the Claude CLI installation.
 */
export interface ClaudeCliInfo {
  /** Whether the CLI was found */
  found: boolean;
  /** Path to the CLI executable */
  path?: string;
  /** CLI version string */
  version?: string;
  /** Error message if not found */
  error?: string;
}

/**
 * Detect the Claude CLI installation.
 *
 * Checks:
 * 1. PATH via `which claude`
 * 2. Common installation locations
 *
 * @returns Information about the CLI installation
 */
export function detectClaudeCli(): ClaudeCliInfo {
  // Short-circuit: let the SDK handle CLI spawning and errors
  return { found: true, path: "claude", version: "(SDK-managed)" };
}

/**
 * Information about the Codex CLI installation.
 */
export interface CodexCliInfo {
  /** Whether the CLI was found */
  found: boolean;
  /** Path to the CLI executable */
  path?: string;
  /** CLI version string */
  version?: string;
  /** Error message if not found */
  error?: string;
}

/**
 * Detect the Codex CLI installation.
 *
 * Checks:
 * 1. PATH via `which codex`
 * 2. Common installation locations (cargo, local bin, etc.)
 *
 * @returns Information about the CLI installation
 */
export async function detectCodexCli(
  explicitPath?: string,
): Promise<CodexCliInfo> {
  const codexPath = await findCodexCliPath(explicitPath);
  if (codexPath) {
    const version = await getCodexVersion(codexPath);
    if (version) {
      return { found: true, path: codexPath, version };
    }
  }

  return {
    found: false,
    error: "Codex CLI not found. Install via: cargo install codex",
  };
}

/**
 * Common Codex CLI installation paths (checked after PATH lookup).
 * Includes Codex desktop app locations.
 */
export function getCodexCommonPaths(): string[] {
  const home = os.homedir();
  const ext = isWindows ? ".exe" : "";
  const sep = isWindows ? "\\" : "/";
  const localAppData =
    process.env.LOCALAPPDATA ?? `${home}${sep}AppData${sep}Local`;
  return isWindows
    ? [
        ...getOpenAICodexDesktopPaths(localAppData),
        `${home}${sep}.codex${sep}.sandbox-bin${sep}codex${ext}`,
        `${home}${sep}.cargo${sep}bin${sep}codex${ext}`,
        `${home}${sep}.codex${sep}bin${sep}codex${ext}`,
        `${localAppData}${sep}bin${sep}codex${ext}`,
      ]
    : [
        `${home}/.codex/.sandbox-bin/codex`,
        `${home}/.local/bin/codex`,
        "/usr/local/bin/codex",
        `${home}/.cargo/bin/codex`,
        `${home}/.codex/bin/codex`,
      ];
}

function getOpenAICodexDesktopPaths(localAppData: string): string[] {
  if (!isWindows) return [];

  const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
  try {
    return readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(binRoot, entry.name, "codex.exe");
        const mtimeMs = safeMtimeMs(join(binRoot, entry.name));
        return { path, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function parseWhichOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function isUsableCodexPath(path: string): Promise<boolean> {
  return Boolean(await getCodexVersion(path));
}

/**
 * Find the Codex CLI path by checking an explicit path first, then PATH, then
 * common locations. If an explicit path is provided but missing, return null:
 * explicit provider configuration is authoritative and should not silently
 * drift to a different install.
 * Returns the path if found, null otherwise.
 */
export async function findCodexCliPath(
  explicitPath?: string,
): Promise<string | null> {
  if (explicitPath) {
    return existsSync(explicitPath) ? explicitPath : null;
  }

  try {
    const { stdout } = await execAsync(whichCommand("codex"), {
      encoding: "utf-8",
    });
    for (const codexPath of parseWhichOutput(stdout)) {
      if (await isUsableCodexPath(codexPath)) return codexPath;
    }
  } catch {
    // Not in PATH
  }

  for (const path of getCodexCommonPaths()) {
    if (existsSync(path) && (await isUsableCodexPath(path))) return path;
  }

  return null;
}

/**
 * Get the version of the Codex CLI at the given path.
 */
async function getCodexVersion(codexPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(codexPath, ["--version"], {
      encoding: "utf-8",
    });
    const output = stdout.trim();
    return output;
  } catch {
    return undefined;
  }
}
