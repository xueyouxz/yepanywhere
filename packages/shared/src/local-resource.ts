import { parseLineColumn } from "./filePathDetection.js";

export type LocalResourceKind =
  | "local-file"
  | "local-media"
  | "project-file"
  | "project-raw-file";

export type LocalResourceMediaType = "image" | "video";

export interface LocalResourceRef {
  kind: LocalResourceKind;
  path: string;
  projectId?: string;
  lineNumber?: number;
  lineEnd?: number;
  columnNumber?: number;
  renderMarkdown?: boolean;
  download?: boolean;
  mediaType?: LocalResourceMediaType;
}

export type LocalResourceAttributes = Record<string, string | null | undefined>;

export interface ParseLocalResourceOptions {
  currentHref?: string;
}

const FALLBACK_BASE_URL = "http://localhost";
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "svg",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv", "ogv"]);

function parsePositiveInteger(
  value: string | null | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string | null | undefined): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return undefined;
}

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function parseUrl(href: string, currentHref?: string): URL | null {
  try {
    return new URL(href, currentHref ?? FALLBACK_BASE_URL);
  } catch {
    return null;
  }
}

function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parsePathReference(
  rawPath: string,
  explicitLine?: number,
  explicitColumn?: number,
): {
  columnNumber?: number;
  lineNumber?: number;
  path: string;
} {
  const parsed = parseLineColumn(rawPath);
  return {
    path: parsed.path,
    lineNumber: explicitLine ?? parsed.line,
    columnNumber: explicitColumn ?? parsed.column,
  };
}

function inferLocalMediaType(path: string): LocalResourceMediaType | undefined {
  const extension = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (!extension) {
    return undefined;
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return undefined;
}

function normalizeKind(
  value: string | null | undefined,
): LocalResourceKind | null {
  switch (value) {
    case "local-file":
    case "local-media":
    case "project-file":
    case "project-raw-file":
      return value;
    default:
      return null;
  }
}

function normalizeMediaType(
  value: string | null | undefined,
): LocalResourceMediaType | undefined {
  switch (value) {
    case "image":
    case "video":
      return value;
    default:
      return undefined;
  }
}

/**
 * Parse a legacy local-resource href into YA's structured local resource model.
 *
 * This is descriptive only. It says what the link appears to reference; the
 * server route that eventually serves the resource still owns authorization,
 * approved-folder checks, path containment, and content-type policy.
 */
export function parseLocalResourceHref(
  href: string,
  options: ParseLocalResourceOptions = {},
): LocalResourceRef | null {
  const url = parseUrl(href, options.currentHref);
  if (!url) {
    return null;
  }

  const pathname = trimTrailingSlash(url.pathname);

  if (pathname === "/api/local-file") {
    const rawPath = url.searchParams.get("path");
    if (!rawPath) {
      return null;
    }
    const reference = parsePathReference(
      rawPath,
      parsePositiveInteger(url.searchParams.get("line")),
      parsePositiveInteger(url.searchParams.get("column")),
    );
    return {
      kind: "local-file",
      path: reference.path,
      lineNumber: reference.lineNumber,
      columnNumber: reference.columnNumber,
      renderMarkdown: parseBoolean(url.searchParams.get("render")),
      download: parseBoolean(url.searchParams.get("download")),
    };
  }

  if (pathname === "/api/local-image") {
    const path = url.searchParams.get("path");
    if (!path) {
      return null;
    }
    return {
      kind: "local-media",
      path,
      mediaType: inferLocalMediaType(path),
    };
  }

  const projectFileMatch = /(?:^|\/)projects\/([^/]+)\/file$/.exec(pathname);
  if (projectFileMatch?.[1]) {
    const projectId = decodeURIComponentSafe(projectFileMatch[1]);
    const path = url.searchParams.get("path");
    if (!projectId || !path) {
      return null;
    }
    return {
      kind: "project-file",
      projectId,
      path,
      lineNumber: parsePositiveInteger(url.searchParams.get("line")),
      lineEnd: parsePositiveInteger(url.searchParams.get("lineEnd")),
      columnNumber: parsePositiveInteger(url.searchParams.get("column")),
    };
  }

  const rawProjectFileMatch = /^\/api\/projects\/([^/]+)\/files\/raw$/.exec(
    pathname,
  );
  if (rawProjectFileMatch?.[1]) {
    const projectId = decodeURIComponentSafe(rawProjectFileMatch[1]);
    const path = url.searchParams.get("path");
    if (!projectId || !path) {
      return null;
    }
    return {
      kind: "project-raw-file",
      projectId,
      path,
      download: parseBoolean(url.searchParams.get("download")),
    };
  }

  return null;
}

/**
 * Parse YA-owned semantic local-resource attributes.
 *
 * Attributes are UI routing metadata, not authorization. They may be rendered
 * from agent-visible text and must remain subordinate to server-side checks.
 */
export function parseLocalResourceAttributes(
  attributes: LocalResourceAttributes,
): LocalResourceRef | null {
  const kind = normalizeKind(attributes["data-ya-resource"]);
  const path = attributes["data-ya-path"];
  if (!kind || !path) {
    return null;
  }

  const projectId = attributes["data-ya-project-id"] ?? undefined;
  if ((kind === "project-file" || kind === "project-raw-file") && !projectId) {
    return null;
  }

  return {
    kind,
    path,
    projectId,
    lineNumber: parsePositiveInteger(attributes["data-ya-line"]),
    lineEnd: parsePositiveInteger(attributes["data-ya-line-end"]),
    columnNumber: parsePositiveInteger(attributes["data-ya-column"]),
    renderMarkdown: parseBoolean(attributes["data-ya-render-markdown"]),
    download: parseBoolean(attributes["data-ya-download"]),
    mediaType:
      normalizeMediaType(attributes["data-ya-media-type"]) ??
      (kind === "local-media" ? inferLocalMediaType(path) : undefined),
  };
}

/**
 * Parse a rendered link, preferring YA semantic attributes when present and
 * falling back to legacy href shapes for already-rendered content.
 */
export function parseLocalResourceLink(
  input: {
    attributes?: LocalResourceAttributes;
    href?: string | null;
  },
  options: ParseLocalResourceOptions = {},
): LocalResourceRef | null {
  if (input.attributes) {
    const fromAttributes = parseLocalResourceAttributes(input.attributes);
    if (fromAttributes) {
      return fromAttributes;
    }
  }

  return input.href ? parseLocalResourceHref(input.href, options) : null;
}
