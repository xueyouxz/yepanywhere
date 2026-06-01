import {
  fromUrlProjectId,
  isUrlProjectId,
  parseLineColumn,
} from "@yep-anywhere/shared";
import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

export interface PublicShareContextValue {
  projectId: string | null;
  relayUrl: string;
  relayUsername: string;
  secret: string;
}

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
    return fromUrlProjectId(projectId).replace(/\/+$/, "");
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
  const parsedPath = parsed.path.replaceAll("\\", "/");
  if (parsedPath.startsWith("/")) {
    const projectRoot = getProjectRoot(projectId);
    if (!projectRoot) {
      return null;
    }
    if (parsedPath === projectRoot) {
      return null;
    }
    const prefix = `${projectRoot}/`;
    if (!parsedPath.startsWith(prefix)) {
      return null;
    }
    const relativePath = normalizeRelativePath(parsedPath.slice(prefix.length));
    return relativePath
      ? { lineNumber: parsed.line, path: relativePath }
      : null;
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
  return `${url.pathname}${url.search}`;
}

export function rewritePublicShareLocalAppHref(
  href: string,
  context: PublicShareContextValue,
  currentHref = window.location.href,
): string | null {
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
    return buildPublicShareFileHref(context, {
      currentHref,
      filePath,
      lineEnd: parsePositiveInteger(url.searchParams.get("lineEnd")),
      lineNumber: parsePositiveInteger(url.searchParams.get("line")),
    });
  }

  if (
    url.pathname === "/api/local-file" ||
    url.pathname === "/api/local-image"
  ) {
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      return null;
    }
    return buildPublicShareFileHref(context, {
      columnNumber: parsePositiveInteger(url.searchParams.get("column")),
      currentHref,
      filePath,
      lineNumber: parsePositiveInteger(url.searchParams.get("line")),
    });
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
    return buildPublicShareFileHref(context, { currentHref, filePath });
  }

  return null;
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
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
