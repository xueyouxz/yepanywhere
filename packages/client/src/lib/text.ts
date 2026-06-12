export function truncateText(text: string, maxLength = 60): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:\//;
const WINDOWS_DRIVE_PREFIX_RE = /^([a-zA-Z]):/;

function isWindowsComparablePath(path: string): boolean {
  return WINDOWS_DRIVE_PATH_RE.test(path) || path.startsWith("//");
}

export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

export function stripTrailingPathSeparators(path: string): string {
  const normalized = normalizePathSeparators(path);
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized.replace(
      WINDOWS_DRIVE_PREFIX_RE,
      (_match, drive) => `${drive.toUpperCase()}:`,
    );
  }
  return normalized
    .replace(
      WINDOWS_DRIVE_PREFIX_RE,
      (_match, drive) => `${drive.toUpperCase()}:`,
    )
    .replace(/\/+$/, "");
}

function normalizeForPathComparison(path: string): string {
  return stripTrailingPathSeparators(path.trim());
}

function comparisonKey(path: string): string {
  return isWindowsComparablePath(path) ? path.toLowerCase() : path;
}

function isAbsoluteLikePath(path: string): boolean {
  const normalized = normalizePathSeparators(path);
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    WINDOWS_DRIVE_PATH_RE.test(normalized)
  );
}

function normalizeRelativeDisplayPath(path: string): string {
  return normalizePathSeparators(path).replace(/^\.\/+/, "");
}

/**
 * Return a project-relative path if filePath is inside projectPath.
 *
 * The returned path uses forward slashes for display and project file-viewer
 * URLs, while callers keep the raw path separately when they need it.
 */
export function getProjectRelativePath(
  filePath: string,
  projectPath: string | null | undefined,
): string | null {
  if (!projectPath) {
    return null;
  }

  const file = normalizeForPathComparison(filePath);
  const project = normalizeForPathComparison(projectPath);
  if (!file || !project) {
    return null;
  }

  const fileKey = comparisonKey(file);
  const projectKey = comparisonKey(project);
  if (fileKey === projectKey) {
    return ".";
  }

  const prefix = `${project}/`;
  const prefixKey = `${projectKey}/`;
  if (!fileKey.startsWith(prefixKey)) {
    return null;
  }

  return file.slice(prefix.length);
}

export function getPathBasename(filePath: string): string {
  const trimmed = stripTrailingPathSeparators(filePath);
  if (!trimmed) {
    return filePath;
  }
  if (/^[a-zA-Z]:\/$/.test(trimmed) || trimmed === "/") {
    return trimmed;
  }

  const lastSlash = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) || trimmed : trimmed;
}

export function splitDisplayPath(displayPath: string): {
  dir: string;
  name: string;
} {
  const lastSlash = Math.max(
    displayPath.lastIndexOf("/"),
    displayPath.lastIndexOf("\\"),
  );
  return lastSlash >= 0
    ? {
        dir: displayPath.slice(0, lastSlash + 1),
        name: displayPath.slice(lastSlash + 1),
      }
    : { dir: "", name: displayPath };
}

/**
 * Shorten path by replacing home directory with ~
 */
export function shortenPath(path: string): string {
  const normalized = normalizePathSeparators(path);
  const homePatterns = [
    /^\/home\/[^/]+/, // Linux: /home/username
    /^\/Users\/[^/]+/, // macOS: /Users/username
    /^[a-zA-Z]:\/Users\/[^/]+/, // Windows: C:/Users/username
  ];

  for (const pattern of homePatterns) {
    if (pattern.test(normalized)) {
      return normalized.replace(pattern, "~");
    }
  }

  return isAbsoluteLikePath(path) ? path : normalizeRelativeDisplayPath(path);
}

/**
 * Return the most readable form of filePath:
 * - project-relative if the file is under projectPath (e.g. "src/foo.ts")
 * - ~/… relative if the file is under the home directory
 * - absolute path otherwise
 */
export function makeDisplayPath(
  filePath: string,
  projectPath: string | null | undefined,
): string {
  const projectRelativePath = getProjectRelativePath(filePath, projectPath);
  if (projectRelativePath !== null) return projectRelativePath;
  return shortenPath(filePath);
}
