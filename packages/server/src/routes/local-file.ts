import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseLineColumn } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import type { ProjectScanner } from "../projects/scanner.js";

interface LocalFileDeps {
  allowedPaths: string[];
  scanner?: Pick<ProjectScanner, "listProjects">;
}

const LOCAL_FILE_CONTENT_TYPES: Record<string, string> = {
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

const LOCAL_MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".svg",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
]);

interface LocalFileReference {
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
  hadInlineLocation: boolean;
}

function isMarkdownPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

function isHtmlPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLocalFileReference(
  rawPath: string,
  explicitLine?: number,
  explicitColumn?: number,
): LocalFileReference {
  const parsed = parseLineColumn(rawPath);
  return {
    filePath: parsed.path,
    lineNumber: explicitLine ?? parsed.line,
    columnNumber: explicitColumn ?? parsed.column,
    hadInlineLocation: parsed.path !== rawPath,
  };
}

function localFileHref(
  filePath: string,
  options: {
    renderMarkdown?: boolean;
    lineNumber?: number;
    columnNumber?: number;
  } = {},
): string {
  const parsed = parseLocalFileReference(
    filePath,
    options.lineNumber,
    options.columnNumber,
  );
  const params = new URLSearchParams({ path: parsed.filePath });
  if (options.renderMarkdown && isMarkdownPath(parsed.filePath)) {
    params.set("render", "1");
  }
  if (parsed.lineNumber !== undefined) {
    params.set("line", String(parsed.lineNumber));
  }
  if (parsed.columnNumber !== undefined) {
    params.set("column", String(parsed.columnNumber));
  }
  return `/api/local-file?${params.toString().replaceAll("&", "&amp;")}`;
}

function localMediaHref(filePath: string): string {
  return `/api/local-image?path=${encodeURIComponent(filePath)}`;
}

function rewriteLocalHtmlReferences(html: string, filePath: string): string {
  let basePath = dirname(filePath);
  const withoutLocalBase = html.replace(
    /<base\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi,
    (match, _quote: string, href: string) => {
      const resolvedBase = resolveHtmlLocalReference(href, basePath);
      if (!resolvedBase || !href.trim().toLowerCase().startsWith("file:")) {
        return match;
      }
      basePath = href.trim().endsWith("/")
        ? resolvedBase.filePath
        : dirname(resolvedBase.filePath);
      return "";
    },
  );

  return withoutLocalBase.replace(
    /\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi,
    (match, attr: string, quote: string, href: string) => {
      const rewritten = rewriteHtmlLocalReference(href, basePath, attr);
      return rewritten ? `${attr}=${quote}${rewritten}${quote}` : match;
    },
  );
}

function rewriteHtmlLocalReference(
  href: string,
  basePath: string,
  attr: string,
): string | null {
  const resolvedReference = resolveHtmlLocalReference(href, basePath);
  if (!resolvedReference) {
    return null;
  }

  const ext = extname(resolvedReference.filePath).toLowerCase();
  if (LOCAL_MEDIA_EXTENSIONS.has(ext)) {
    return localMediaHref(resolvedReference.filePath);
  }

    if (LOCAL_FILE_CONTENT_TYPES[ext]) {
      const rewrittenHref = localFileHref(resolvedReference.filePath, {
        renderMarkdown: isMarkdownPath(resolvedReference.filePath),
      });
      return attr.toLowerCase() === "href"
        ? `${rewrittenHref}${resolvedReference.hash}`
        : rewrittenHref;
  }

  return null;
}

function resolveHtmlLocalReference(
  href: string,
  basePath: string,
): { filePath: string; hash: string } | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return null;
  }
  if (/^(?:https?|mailto|data|blob|javascript):/i.test(trimmed)) {
    return null;
  }

  try {
    const baseUrl = pathToFileURL(`${basePath}/`);
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "file:") {
      return null;
    }
    return {
      filePath: resolve(fileURLToPath(url)),
      hash: url.hash,
    };
  } catch {
    return null;
  }
}

function renderMarkdownDocument(filePath: string, bodyHtml: string): string {
  const title = basename(filePath);
  const rawUrl = localFileHref(filePath);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      background: Canvas;
      color: CanvasText;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    .document-actions {
      position: fixed;
      top: 0.75rem;
      right: 0.75rem;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 6px;
      background: color-mix(in srgb, Canvas 88%, transparent);
      box-shadow: 0 4px 20px color-mix(in srgb, CanvasText 12%, transparent);
      backdrop-filter: blur(8px);
    }
    .document-actions.is-docked {
      position: absolute;
    }
    .document-actions a,
    .document-actions__dock {
      border: 0;
      border-radius: 4px;
      background: transparent;
      padding: 0.25rem 0.55rem;
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .document-actions a {
      color: LinkText;
    }
    .document-actions__dock {
      width: 1.6rem;
      color: color-mix(in srgb, CanvasText 72%, transparent);
    }
    .document-actions a:hover,
    .document-actions__dock:hover {
      background: color-mix(in srgb, CanvasText 10%, transparent);
    }
    .document-actions.is-docked .document-actions__dock {
      display: none;
    }
    main {
      box-sizing: border-box;
      max-width: 980px;
      margin: 0 auto;
      padding: 1.25rem;
    }
    h1, h2, h3, h4, h5, h6 {
      line-height: 1.25;
      margin: 1.4em 0 0.5em;
    }
    h1:first-child, h2:first-child { margin-top: 0; }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Monaco, Consolas, monospace;
    }
    code {
      border-radius: 3px;
      background: color-mix(in srgb, CanvasText 10%, transparent);
      padding: 0.1em 0.3em;
    }
    pre {
      overflow: auto;
      border-radius: 6px;
      background: color-mix(in srgb, CanvasText 8%, transparent);
      padding: 0.85rem;
    }
    pre code { background: transparent; padding: 0; }
    table {
      width: 100%;
      margin: 1rem 0;
      border-collapse: collapse;
    }
    th, td {
      border: 1px solid color-mix(in srgb, CanvasText 24%, transparent);
      padding: 0.45rem 0.6rem;
      text-align: left;
    }
    blockquote {
      margin: 1rem 0;
      border-left: 4px solid color-mix(in srgb, CanvasText 24%, transparent);
      padding-left: 1rem;
      color: color-mix(in srgb, CanvasText 72%, transparent);
    }
    img {
      max-width: 100%;
      height: auto;
    }
    @media print {
      .document-actions { display: none; }
      main {
        max-width: none;
        padding: 0;
      }
    }
  </style>
</head>
<body>
  <nav class="document-actions" aria-label="Document actions">
    <a href="${escapeHtml(rawUrl)}">Raw</a>
    <button class="document-actions__dock" type="button" aria-label="Keep raw link at document top" title="Keep at document top" onclick="this.closest('.document-actions').classList.add('is-docked')">&times;</button>
  </nav>
  <main class="markdown-rendered">
${bodyHtml}
  </main>
</body>
</html>`;
}

/**
 * Create routes for serving local files from allowed paths.
 *
 * Security: Only serves files that:
 * 1. Have a recognized extension
 * 2. Resolve (after symlink resolution) to a path under an allowed prefix
 * 3. Are regular files (not directories, devices, etc.)
 */
export function createLocalFileRoutes(deps: LocalFileDeps) {
  const routes = new Hono();

  let resolvedAllowedPaths: string[] | null = null;
  async function getAllowedPaths(): Promise<string[]> {
    if (!resolvedAllowedPaths) {
      resolvedAllowedPaths = await Promise.all(
        deps.allowedPaths.map(async (p) => {
          try {
            return await realpath(p);
          } catch {
            return p;
          }
        }),
      );
    }
    if (!deps.scanner) {
      return resolvedAllowedPaths;
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

    return Array.from(
      new Set([
        ...resolvedAllowedPaths,
        ...projectPaths.filter((path): path is string => Boolean(path)),
      ]),
    );
  }

  routes.get("/", async (c) => {
    const rawFilePath = c.req.query("path");
    if (!rawFilePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }
    const requested = parseLocalFileReference(
      rawFilePath,
      parsePositiveInteger(c.req.query("line")),
      parsePositiveInteger(c.req.query("column")),
    );
    const filePath = requested.filePath;

    if (!filePath.startsWith("/")) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = LOCAL_FILE_CONTENT_TYPES[ext];
    if (!contentType) {
      return c.json({ error: "Not a supported local file" }, 415);
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    const allowed = await getAllowedPaths();
    const isAllowed = allowed.some((prefix) =>
      resolvedPath.startsWith(`${prefix}/`),
    );
    if (!isAllowed) {
      return c.json({ error: "Path not in allowed directories" }, 403);
    }

    try {
      const stats = await stat(resolvedPath);
      if (!stats.isFile()) {
        return c.json({ error: "Not a file" }, 404);
      }

      if (
        (c.req.query("render") === "1" || requested.hadInlineLocation) &&
        isMarkdownPath(resolvedPath)
      ) {
        const markdown = await readFile(resolvedPath, "utf-8");
        const html = await renderMarkdownToHtml(markdown, {
          localFileBasePath: dirname(resolvedPath),
          inlineLocalImages: true,
        });

        c.header("Content-Type", "text/html; charset=utf-8");
        c.header("Content-Disposition", "inline");
        c.header("Cache-Control", "private, max-age=60");
        c.header("X-Content-Type-Options", "nosniff");
        return c.html(renderMarkdownDocument(resolvedPath, html));
      }

      if (isHtmlPath(resolvedPath)) {
        const html = await readFile(resolvedPath, "utf-8");
        const rewrittenHtml = rewriteLocalHtmlReferences(html, resolvedPath);

        c.header("Content-Type", contentType);
        c.header("Content-Disposition", "inline");
        c.header("Cache-Control", "private, max-age=60");
        c.header("X-Content-Type-Options", "nosniff");
        return c.html(rewrittenHtml);
      }

      c.header("Content-Type", contentType);
      c.header("Content-Length", stats.size.toString());
      c.header("Content-Disposition", "inline");
      c.header("Cache-Control", "private, max-age=60");
      c.header("X-Content-Type-Options", "nosniff");

      return stream(c, async (s) => {
        const readable = createReadStream(resolvedPath);
        for await (const chunk of readable) {
          await s.write(chunk);
        }
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "File not found" }, 404);
      }
      console.error("[LocalFile] Error serving file:", err);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return routes;
}
