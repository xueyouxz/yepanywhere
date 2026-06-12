import {
  fromUrlProjectId,
  isUrlProjectId,
  parseLineColumn,
} from "@yep-anywhere/shared";
import { createContext, type ReactNode, useContext } from "react";
import {
  getProjectRelativePath,
  normalizePathSeparators,
  stripTrailingPathSeparators,
} from "../lib/text";

export interface PublicShareContextValue {
  projectId: string | null;
  relayUrl: string;
  relayUsername: string;
  secret: string;
}

export type PublicShareFileViewMode = "full" | "range";

const PublicShareContext = createContext<PublicShareContextValue | null>(null);

export function PublicShareProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: PublicShareContextValue;
}) {
  return (
    <PublicShareContext.Provider value={value}>
      {children}
    </PublicShareContext.Provider>
  );
}

export function usePublicShareContext(): PublicShareContextValue | null {
  return useContext(PublicShareContext);
}

function normalizeRelativePath(filePath: string): string | null {
  const parts: string[] = [];
  for (const part of filePath.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function getProjectRoot(projectId: string | null): string | null {
  if (!projectId || !isUrlProjectId(projectId)) {
    return null;
  }
  try {
    return stripTrailingPathSeparators(fromUrlProjectId(projectId));
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

export function normalizePublicShareFilePath(
  filePath: string,
  projectId: string | null,
): { lineNumber?: number; path: string } | null {
  const parsed = parseLineColumn(filePath);
  const parsedPath = normalizePathSeparators(parsed.path);
  const projectRoot = getProjectRoot(projectId);
  const projectRelativePath = getProjectRelativePath(parsedPath, projectRoot);
  if (projectRelativePath === ".") {
    return null;
  }
  if (projectRelativePath !== null) {
    const relativePath = normalizeRelativePath(projectRelativePath);
    return relativePath
      ? { lineNumber: parsed.line, path: relativePath }
      : null;
  }
  if (parsedPath.startsWith("/") || /^[a-zA-Z]:\//.test(parsedPath)) {
    return null;
  }

  const relativePath = normalizeRelativePath(parsedPath);
  return relativePath ? { lineNumber: parsed.line, path: relativePath } : null;
}

export function buildPublicShareFileHref(
  context: PublicShareContextValue,
  options: {
    columnNumber?: number;
    currentHref?: string;
    filePath: string;
    lineEnd?: number;
    lineNumber?: number;
    viewMode?: PublicShareFileViewMode;
  },
): string | null {
  const normalized = normalizePublicShareFilePath(
    options.filePath,
    context.projectId,
  );
  if (!normalized) {
    return null;
  }

  const url = new URL(
    `/share/${encodeURIComponent(context.secret)}/file`,
    options.currentHref ?? window.location.href,
  );
  url.searchParams.set("path", normalized.path);
  url.searchParams.set("h", context.relayUsername);
  url.searchParams.set("r", context.relayUrl);
  if (context.projectId) {
    url.searchParams.set("projectId", context.projectId);
  }
  const lineNumber = options.lineNumber ?? normalized.lineNumber;
  if (lineNumber !== undefined) {
    url.searchParams.set("line", String(lineNumber));
  }
  if (options.lineEnd !== undefined) {
    url.searchParams.set("lineEnd", String(options.lineEnd));
  }
  if (options.columnNumber !== undefined) {
    url.searchParams.set("column", String(options.columnNumber));
  }
  if (options.viewMode === "range") {
    url.searchParams.set("view", "range");
  }
  return `${url.pathname}${url.search}`;
}

export interface PublicShareFileReference {
  columnNumber?: number;
  lineEnd?: number;
  lineNumber?: number;
  path: string;
  viewMode?: PublicShareFileViewMode;
}

export function getPublicShareFileReferenceFromLocalAppHref(
  href: string,
  context: PublicShareContextValue,
  currentHref = window.location.href,
): PublicShareFileReference | null {
  let url: URL;
  try {
    url = new URL(href, currentHref);
  } catch {
    return null;
  }

  const currentUrl = new URL(currentHref);
  if (url.origin !== currentUrl.origin) {
    return null;
  }
  if (
    url.pathname === `/share/${encodeURIComponent(context.secret)}/file` ||
    url.pathname === `/remote/share/${encodeURIComponent(context.secret)}/file`
  ) {
    return null;
  }

  const projectFileMatch = /^\/projects\/([^/]+)\/file$/.exec(url.pathname);
  if (projectFileMatch?.[1]) {
    const linkProjectId = decodeURIComponentSafe(projectFileMatch[1]);
    if (!linkProjectId) {
      return null;
    }
    if (context.projectId && linkProjectId !== context.projectId) {
      return null;
    }
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return null;
    }
    const normalized = normalizePublicShareFilePath(
      filePath,
      context.projectId,
    );
    return normalized
      ? {
          path: normalized.path,
          lineEnd: parsePositiveInteger(url.searchParams.get("lineEnd")),
          lineNumber:
            parsePositiveInteger(url.searchParams.get("line")) ??
            normalized.lineNumber,
          viewMode:
            url.searchParams.get("view") === "range" ? "range" : undefined,
        }
      : null;
  }

  const rawProjectFileMatch = /^\/api\/projects\/([^/]+)\/files\/raw$/.exec(
    url.pathname,
  );
  if (rawProjectFileMatch?.[1]) {
    const linkProjectId = decodeURIComponentSafe(rawProjectFileMatch[1]);
    if (!linkProjectId) {
      return null;
    }
    if (context.projectId && linkProjectId !== context.projectId) {
      return null;
    }
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return null;
    }
    const normalized = normalizePublicShareFilePath(
      filePath,
      context.projectId,
    );
    return normalized ? { path: normalized.path } : null;
  }

  if (
    url.pathname === "/api/local-file" ||
    url.pathname === "/api/local-image"
  ) {
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return null;
    }
    const normalized = normalizePublicShareFilePath(
      filePath,
      context.projectId,
    );
    return normalized
      ? {
          path: normalized.path,
          columnNumber: parsePositiveInteger(url.searchParams.get("column")),
          lineEnd: parsePositiveInteger(url.searchParams.get("lineEnd")),
          lineNumber:
            parsePositiveInteger(url.searchParams.get("line")) ??
            normalized.lineNumber,
          viewMode:
            url.searchParams.get("view") === "range" ? "range" : undefined,
        }
      : null;
  }

  return null;
}

export function rewritePublicShareLocalAppHref(
  href: string,
  context: PublicShareContextValue,
  currentHref = window.location.href,
): string | null {
  const reference = getPublicShareFileReferenceFromLocalAppHref(
    href,
    context,
    currentHref,
  );
  if (!reference) {
    return null;
  }
  return buildPublicShareFileHref(context, {
    currentHref,
    filePath: reference.path,
    columnNumber: reference.columnNumber,
    lineEnd: reference.lineEnd,
    lineNumber: reference.lineNumber,
    viewMode: reference.viewMode,
  });
}

export function buildPublicShareRawFileApiPath(
  context: PublicShareContextValue,
  filePath: string,
): string | null {
  const normalized = normalizePublicShareFilePath(filePath, context.projectId);
  if (!normalized) {
    return null;
  }
  const params = new URLSearchParams({ path: normalized.path });
  return `/public-api/shares/${encodeURIComponent(context.secret)}/files/raw?${params}`;
}

export function rewritePublicShareLocalAppLinks(
  root: ParentNode,
  context: PublicShareContextValue,
  currentHref = window.location.href,
): void {
  for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    const rewritten = rewritePublicShareLocalAppHref(
      href,
      context,
      currentHref,
    );
    if (rewritten && href !== rewritten) {
      anchor.setAttribute("href", rewritten);
      anchor.setAttribute("data-public-share-file-link", "true");
    }
  }

  for (const image of Array.from(root.querySelectorAll("img[src]"))) {
    const src = image.getAttribute("src");
    if (!src) {
      continue;
    }
    const reference = getPublicShareFileReferenceFromLocalAppHref(
      src,
      context,
      currentHref,
    );
    if (reference) {
      image.setAttribute("data-public-share-src-path", reference.path);
    }
  }

  for (const preview of Array.from(
    root.querySelectorAll<HTMLElement>(".local-media-inline-preview"),
  )) {
    const filePath = preview.getAttribute("data-media-path");
    if (!filePath) {
      continue;
    }
    const normalized = normalizePublicShareFilePath(
      filePath,
      context.projectId,
    );
    if (normalized) {
      preview.setAttribute("data-public-share-src-path", normalized.path);
    }
  }
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
