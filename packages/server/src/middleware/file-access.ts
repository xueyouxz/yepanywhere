/**
 * File-access policy state (mirrors allowed-hosts.ts).
 *
 * One effective set of allowed path prefixes governs BOTH HTTP file doors — the
 * media routes (/api/local-image, /api/local-file) and the project-files route
 * (/api/projects/:id/files + /files/raw). This limits what the HTTP/viewer layer
 * can read; it does NOT constrain what the agent process itself can do.
 *
 * The set is modeled as independent, additive sources (checkboxes) plus a
 * free-form custom list — see docs/tactical/018-file-access-scoping.md.
 *
 * Precedence:
 *   1. Env override (ALLOWED_FILE_PATHS / ALLOWED_IMAGE_PATHS) — replaces the
 *      editable set and pins the UI read-only. Uploads + projects stay unioned
 *      in (parity with prior behavior) so env mode never strands them.
 *   2. Persisted `fileAccess` setting (this module's mutable state).
 *   3. Built-in defaults (DEFAULT_FILE_ACCESS).
 */

export interface FileAccessSettings {
  /** All scanned project paths (gates absolute paths landing inside a project). */
  projects: boolean;
  /** The managed uploads directory. */
  uploads: boolean;
  /** Per-OS temp prefixes (getDefaultAllowedImagePaths). */
  temp: boolean;
  /** The home directory (os.homedir()). */
  home: boolean;
  /** Literal absolute prefixes, one per entry; `~` is expanded. */
  custom: string[];
}

export const DEFAULT_FILE_ACCESS: FileAccessSettings = {
  projects: true,
  uploads: true,
  temp: true,
  home: false,
  custom: [],
};

interface FileAccessDeps {
  uploadsDir: string;
  homeDir: string;
  tempPaths: string[];
  /** null = no env override (use the persisted/default settings). */
  envPaths: string[] | null;
}

let deps: FileAccessDeps | null = null;
let current: FileAccessSettings = DEFAULT_FILE_ACCESS;

/** Seed the resolved deps once at startup. */
export function initFileAccess(d: FileAccessDeps): void {
  deps = d;
}

/** Coerce an untrusted/partial settings object into a complete one. */
export function normalizeFileAccess(
  settings: Partial<FileAccessSettings> | undefined,
): FileAccessSettings {
  if (!settings) return DEFAULT_FILE_ACCESS;
  return {
    projects: settings.projects ?? DEFAULT_FILE_ACCESS.projects,
    uploads: settings.uploads ?? DEFAULT_FILE_ACCESS.uploads,
    temp: settings.temp ?? DEFAULT_FILE_ACCESS.temp,
    home: settings.home ?? DEFAULT_FILE_ACCESS.home,
    custom: Array.isArray(settings.custom)
      ? settings.custom
          .filter((p): p is string => typeof p === "string")
          .map((p) => p.trim())
          .filter(Boolean)
      : [],
  };
}

/**
 * Apply file-access settings at runtime. Called on startup (from persisted
 * settings) and whenever the user changes the setting via the UI.
 */
export function updateFileAccess(
  settings: Partial<FileAccessSettings> | undefined,
): void {
  current = normalizeFileAccess(settings);
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const separator = home.includes("\\") ? "\\" : "/";
    const normalizedHome = home.replace(/[\\/]+$/u, "");
    const relativePath = p.slice(2).replace(/[\\/]+/gu, separator);
    return `${normalizedHome}${separator}${relativePath}`;
  }
  return p;
}

/** True when an env var pins the allow-set (UI must render read-only). */
export function isFileAccessEnvPinned(): boolean {
  return deps?.envPaths != null;
}

/**
 * The non-project allowed prefixes. Project paths are unioned separately by the
 * path policy (it realpath-resolves scanned projects); see shouldIncludeProjects.
 */
export function getAllowedFilePaths(): string[] {
  if (!deps) return [];
  if (deps.envPaths != null) {
    return Array.from(new Set([deps.uploadsDir, ...deps.envPaths]));
  }
  const out: string[] = [];
  if (current.uploads) out.push(deps.uploadsDir);
  if (current.temp) out.push(...deps.tempPaths);
  if (current.home) out.push(deps.homeDir);
  for (const entry of current.custom) {
    const expanded = expandHome(entry, deps.homeDir).trim();
    if (expanded) out.push(expanded);
  }
  return Array.from(new Set(out));
}

/** Whether scanned project paths are part of the effective allow-set. */
export function shouldIncludeProjects(): boolean {
  // Env pin preserves the prior always-union-projects behavior.
  if (deps?.envPaths != null) return true;
  return current.projects;
}

/** Read-only info for the settings UI (hints + env-pinned state). */
export function getFileAccessInfo(): {
  envPinned: boolean;
  envPaths: string[];
  tempPaths: string[];
  uploadsDir: string;
  homeDir: string;
} {
  return {
    envPinned: deps?.envPaths != null,
    envPaths: deps?.envPaths ?? [],
    tempPaths: deps?.tempPaths ?? [],
    uploadsDir: deps?.uploadsDir ?? "",
    homeDir: deps?.homeDir ?? "",
  };
}
