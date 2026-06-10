import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { normalizeWindowsDrivePathname } from "@yep-anywhere/shared";
import type { ProjectScanner } from "../projects/scanner.js";

type LocalResourceScanner = Pick<ProjectScanner, "listProjects">;

interface LocalResourcePolicyDeps {
  allowedPaths: string[];
  scanner?: LocalResourceScanner;
  platform?: NodeJS.Platform;
}

interface LocalResourceFile {
  resolvedPath: string;
  stats: Stats;
}

interface LocalResourceFileError {
  error: string;
  status: 400 | 403 | 404;
}

type LocalResourceFileResult =
  | { file: LocalResourceFile; ok: true }
  | (LocalResourceFileError & { ok: false });

export const LOCAL_FILE_CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/x-toml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
};

export const LOCAL_MEDIA_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
};

export const LOCAL_MEDIA_EXTENSIONS = new Set(
  Object.keys(LOCAL_MEDIA_CONTENT_TYPES),
);

export function isSupportedAbsoluteLocalPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const isPosixAbsolute =
    filePath.startsWith("/") && !filePath.startsWith("//");
  if (platform === "win32") {
    return isPosixAbsolute || /^[A-Za-z]:[\\/]/.test(filePath);
  }
  return isPosixAbsolute;
}

export function isPathInsideDirectory(
  filePath: string,
  directory: string,
): boolean {
  const relative = path.relative(directory, filePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function createLocalResourcePathPolicy(deps: LocalResourcePolicyDeps) {
  const platform = deps.platform ?? process.platform;
  let resolvedAllowedPaths: string[] | null = null;

  function normalizePathForPlatform(filePath: string): string {
    return platform === "win32"
      ? normalizeWindowsDrivePathname(filePath)
      : filePath;
  }

  async function realpathOrOriginal(value: string): Promise<string> {
    try {
      return await realpath(value);
    } catch {
      return value;
    }
  }

  async function getConfiguredAllowedPaths(): Promise<string[]> {
    if (!resolvedAllowedPaths) {
      resolvedAllowedPaths = await Promise.all(
        deps.allowedPaths.map(realpathOrOriginal),
      );
    }
    return resolvedAllowedPaths;
  }

  async function getProjectAllowedPaths(): Promise<string[]> {
    if (!deps.scanner) {
      return [];
    }

    const projects = await deps.scanner.listProjects();
    const projectPaths = await Promise.all(
      projects.map(async (project) => {
        try {
          return await realpath(project.path);
        } catch {
          return null;
        }
      }),
    );
    return projectPaths.filter((projectPath): projectPath is string =>
      Boolean(projectPath),
    );
  }

  async function getAllowedPaths(): Promise<string[]> {
    return Array.from(
      new Set([
        ...(await getConfiguredAllowedPaths()),
        ...(await getProjectAllowedPaths()),
      ]),
    );
  }

  async function resolveAllowedFilePath(
    filePath: string,
  ): Promise<LocalResourceFileResult> {
    const normalizedFilePath = normalizePathForPlatform(filePath);
    if (!isSupportedAbsoluteLocalPath(normalizedFilePath, platform)) {
      return { error: "Path must be absolute", ok: false, status: 400 };
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(normalizedFilePath);
    } catch {
      return { error: "File not found", ok: false, status: 404 };
    }

    const allowed = await getAllowedPaths();
    const isAllowed = allowed.some((prefix) =>
      isPathInsideDirectory(resolvedPath, prefix),
    );
    if (!isAllowed) {
      return {
        error: "Path not in allowed directories",
        ok: false,
        status: 403,
      };
    }

    try {
      const stats = await stat(resolvedPath);
      if (!stats.isFile()) {
        return { error: "Not a file", ok: false, status: 404 };
      }
      return { file: { resolvedPath, stats }, ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { error: "File not found", ok: false, status: 404 };
      }
      throw err;
    }
  }

  return {
    getAllowedPaths,
    isAbsolutePath(filePath: string) {
      return isSupportedAbsoluteLocalPath(
        normalizePathForPlatform(filePath),
        platform,
      );
    },
    resolveAllowedFilePath,
  };
}
