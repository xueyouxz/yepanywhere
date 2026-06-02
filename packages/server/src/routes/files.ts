import { createReadStream, type Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  normalize,
  relative,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";
import {
  type FileContentResponse,
  type FileMetadata,
  isUrlProjectId,
  type PatchHunk,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { computeEditAugment } from "../augments/edit-augments.js";
import { renderMarkdownToHtml } from "../augments/markdown-augments.js";
import { renderSafeMarkdown } from "../augments/safe-markdown.js";
import { highlightFile } from "../highlighting/index.js";
import type { ProjectScanner } from "../projects/scanner.js";

export interface FilesDeps {
  scanner: ProjectScanner;
}

/** Maximum file size to include content inline (1MB) */
const MAX_INLINE_SIZE = 1024 * 1024;
const MAX_TARGET_WINDOW_SIZE = MAX_INLINE_SIZE;
const MAX_EMBEDDED_MARKDOWN_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_MARKDOWN_MEDIA_FILE_BYTES = 2 * 1024 * 1024;

/** MIME type mappings by extension */
const MIME_TYPES: Record<string, string> = {
  // Text/code files
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".sass": "text/x-sass",
  ".less": "text/x-less",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/x-toml",
  ".ini": "text/x-ini",
  ".conf": "text/plain",
  ".cfg": "text/plain",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".fish": "text/x-shellscript",
  ".ps1": "text/x-powershell",
  ".bat": "text/x-batch",
  ".cmd": "text/x-batch",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".kt": "text/x-kotlin",
  ".scala": "text/x-scala",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".hpp": "text/x-c++",
  ".cc": "text/x-c++",
  ".cs": "text/x-csharp",
  ".swift": "text/x-swift",
  ".m": "text/x-objectivec",
  ".mm": "text/x-objectivec",
  ".php": "text/x-php",
  ".pl": "text/x-perl",
  ".pm": "text/x-perl",
  ".lua": "text/x-lua",
  ".r": "text/x-r",
  ".R": "text/x-r",
  ".sql": "text/x-sql",
  ".graphql": "text/x-graphql",
  ".gql": "text/x-graphql",
  ".vue": "text/x-vue",
  ".svelte": "text/x-svelte",
  ".astro": "text/x-astro",
  ".elm": "text/x-elm",
  ".ex": "text/x-elixir",
  ".exs": "text/x-elixir",
  ".erl": "text/x-erlang",
  ".hrl": "text/x-erlang",
  ".hs": "text/x-haskell",
  ".lhs": "text/x-haskell",
  ".clj": "text/x-clojure",
  ".cljs": "text/x-clojure",
  ".cljc": "text/x-clojure",
  ".ml": "text/x-ocaml",
  ".mli": "text/x-ocaml",
  ".fs": "text/x-fsharp",
  ".fsx": "text/x-fsharp",
  ".dart": "text/x-dart",
  ".nim": "text/x-nim",
  ".zig": "text/x-zig",
  ".v": "text/x-v",
  ".sol": "text/x-solidity",
  ".proto": "text/x-protobuf",
  ".prisma": "text/x-prisma",
  ".dockerfile": "text/x-dockerfile",
  ".makefile": "text/x-makefile",
  ".cmake": "text/x-cmake",
  ".gradle": "text/x-gradle",
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".editorconfig": "text/plain",
  ".prettierrc": "application/json",
  ".eslintrc": "application/json",
  ".babelrc": "application/json",
  // Image files
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".avif": "image/avif",
  // Other binary
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Extensions that are considered text files */
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonl",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".swift",
  ".m",
  ".mm",
  ".php",
  ".pl",
  ".pm",
  ".lua",
  ".r",
  ".R",
  ".sql",
  ".graphql",
  ".gql",
  ".vue",
  ".svelte",
  ".astro",
  ".elm",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".hs",
  ".lhs",
  ".clj",
  ".cljs",
  ".cljc",
  ".ml",
  ".mli",
  ".fs",
  ".fsx",
  ".dart",
  ".nim",
  ".zig",
  ".v",
  ".sol",
  ".proto",
  ".prisma",
  ".dockerfile",
  ".makefile",
  ".cmake",
  ".gradle",
  ".svg", // SVG is XML-based, can be treated as text
]);

/**
 * Get MIME type from file extension.
 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function parsePositiveIntegerQuery(
  value: string | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getLineRange(
  lineNumber: number | undefined,
  lineEnd: number | undefined,
): { end: number; start: number } | null {
  if (lineNumber === undefined) {
    return null;
  }
  return {
    end: Math.max(lineNumber, lineEnd ?? lineNumber),
    start: lineNumber,
  };
}

function isBlankMarkdownLine(line: string): boolean {
  return line.trim() === "";
}

function getMarkdownFenceMarker(
  line: string,
): { char: "`" | "~"; length: number } | null {
  const match = /^(`{3,}|~{3,})/.exec(line.trimStart());
  if (!match?.[1]) {
    return null;
  }
  return {
    char: match[1][0] as "`" | "~",
    length: match[1].length,
  };
}

function expandMarkdownSplitRange(
  lines: string[],
  startIndex: number,
  endIndexExclusive: number,
): { endIndexExclusive: number; startIndex: number } {
  let start = startIndex;
  let end = endIndexExclusive;

  const expandToBlankBoundaries = () => {
    while (start > 0 && !isBlankMarkdownLine(lines[start - 1] ?? "")) {
      start -= 1;
    }
    while (end < lines.length && !isBlankMarkdownLine(lines[end] ?? "")) {
      end += 1;
    }
  };

  expandToBlankBoundaries();

  let openFence: {
    char: "`" | "~";
    length: number;
    startIndex: number;
  } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = getMarkdownFenceMarker(lines[index] ?? "");
    if (!marker) {
      continue;
    }
    if (
      openFence &&
      marker.char === openFence.char &&
      marker.length >= openFence.length
    ) {
      const fenceEnd = index + 1;
      if (openFence.startIndex < end && fenceEnd > start) {
        start = Math.min(start, openFence.startIndex);
        end = Math.max(end, fenceEnd);
      }
      openFence = null;
    } else if (!openFence) {
      openFence = { ...marker, startIndex: index };
    }
  }
  if (openFence && openFence.startIndex < end) {
    start = Math.min(start, openFence.startIndex);
    end = lines.length;
  }

  expandToBlankBoundaries();

  return { startIndex: start, endIndexExclusive: end };
}

function collectMarkdownDefinitionLines(lines: string[]): string[] {
  const definitions: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s{0,3}\[[^\]]+]:/.test(line)) {
      continue;
    }

    definitions.push(line);
    for (let next = index + 1; next < lines.length; next += 1) {
      const continuation = lines[next] ?? "";
      if (!/^(?:\t| {4,})\S/.test(continuation)) {
        break;
      }
      definitions.push(continuation);
      index = next;
    }
  }
  return definitions;
}

function appendMarkdownDefinitionContext(
  markdown: string,
  definitions: string[],
): string {
  if (!markdown.trim() || definitions.length === 0) {
    return markdown;
  }
  return `${markdown.replace(/\s+$/, "")}\n\n${definitions.join("\n")}`;
}

async function renderMarkdownFilePreview(
  content: string,
  options: { localFileBasePath: string },
  contentStartLine: number,
  requestedRange: { end: number; start: number } | null,
  viewMode: FileViewMode,
): Promise<string> {
  if (!requestedRange) {
    return await renderMarkdownToHtml(content, options);
  }

  const lines = content.split("\n");
  const startIndex = Math.max(0, requestedRange.start - contentStartLine);
  const endIndexExclusive = Math.min(
    lines.length,
    requestedRange.end - contentStartLine + 1,
  );
  if (startIndex >= endIndexExclusive) {
    return await renderMarkdownToHtml(content, options);
  }

  const snappedRange = expandMarkdownSplitRange(
    lines,
    startIndex,
    endIndexExclusive,
  );
  const spanStartLine = contentStartLine + snappedRange.startIndex;
  const spanEndLine = contentStartLine + snappedRange.endIndexExclusive - 1;
  const before = lines.slice(0, snappedRange.startIndex).join("\n");
  const span = lines
    .slice(snappedRange.startIndex, snappedRange.endIndexExclusive)
    .join("\n");
  const after = lines.slice(snappedRange.endIndexExclusive).join("\n");
  const definitionLines = collectMarkdownDefinitionLines(lines);
  const renderChunk = (markdown: string) =>
    definitionLines.length > 0
      ? renderSafeMarkdown(
          appendMarkdownDefinitionContext(markdown, definitionLines),
          options,
        )
      : renderMarkdownToHtml(markdown, options);

  const parts: string[] = [];
  if (viewMode !== "range" && before.trim()) {
    parts.push(await renderChunk(before));
  }
  parts.push(
    `<div class="markdown-preview-line-boundary markdown-preview-line-boundary-start" data-line="${spanStartLine}"></div>`,
  );
  parts.push(
    `<div class="markdown-preview-span markdown-preview-span-start" data-line-start="${spanStartLine}" data-line-end="${spanEndLine}">${await renderChunk(span)}</div>`,
  );
  parts.push(
    `<div class="markdown-preview-line-boundary markdown-preview-line-boundary-end" data-line="${spanEndLine}"></div>`,
  );
  if (viewMode !== "range" && after.trim()) {
    parts.push(await renderChunk(after));
  }

  return parts.filter(Boolean).join("\n");
}

interface TextContentSlice {
  content: string;
  endLine: number;
  startLine: number;
  totalLines?: number;
  truncated: boolean;
}

type FileViewMode = "full" | "range";

interface LineEntry {
  bytes: number;
  lineNumber: number;
  text: string;
}

function lineBytes(text: string): number {
  return Buffer.byteLength(`${text}\n`, "utf8");
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

function trimLineWindowToBudget(
  lines: LineEntry[],
  byteBudget: number,
): number {
  let bytes = lines.reduce((total, line) => total + line.bytes, 0);
  while (bytes > byteBudget && lines.length > 0) {
    const removed = lines.shift();
    bytes -= removed?.bytes ?? 0;
  }
  return bytes;
}

async function readTargetedTextWindow(
  filePath: string,
  range: { end: number; start: number },
): Promise<TextContentSlice> {
  const beforeLines: LineEntry[] = [];
  const targetLines: LineEntry[] = [];
  const afterLines: LineEntry[] = [];
  let beforeBytes = 0;
  let targetBytes = 0;
  let afterBytes = 0;
  let lineNumber = 0;
  let completed = true;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: stream,
  });

  try {
    for await (const line of reader) {
      lineNumber += 1;
      const entry: LineEntry = {
        bytes: lineBytes(line),
        lineNumber,
        text: line,
      };

      if (lineNumber < range.start) {
        beforeLines.push(entry);
        beforeBytes += entry.bytes;
        beforeBytes = trimLineWindowToBudget(
          beforeLines,
          Math.floor(MAX_TARGET_WINDOW_SIZE / 2),
        );
        continue;
      }

      if (lineNumber <= range.end) {
        const remainingTargetBytes = MAX_TARGET_WINDOW_SIZE - targetBytes;
        if (remainingTargetBytes <= 0) {
          completed = false;
          break;
        }
        if (entry.bytes > remainingTargetBytes) {
          beforeLines.length = 0;
          afterLines.length = 0;
          beforeBytes = 0;
          afterBytes = 0;
          if (targetLines.length === 0) {
            const text = truncateUtf8(entry.text, MAX_TARGET_WINDOW_SIZE);
            targetLines.push({
              bytes: Buffer.byteLength(text, "utf8"),
              lineNumber,
              text,
            });
            targetBytes = targetLines[0]?.bytes ?? 0;
          }
          completed = false;
          break;
        }

        targetLines.push(entry);
        targetBytes += entry.bytes;
        const beforeBudget = Math.max(
          0,
          Math.floor((MAX_TARGET_WINDOW_SIZE - targetBytes) / 2),
        );
        beforeBytes = trimLineWindowToBudget(beforeLines, beforeBudget);
        if (targetBytes >= MAX_TARGET_WINDOW_SIZE) {
          beforeLines.length = 0;
          beforeBytes = 0;
          completed = false;
          break;
        }
        continue;
      }

      const remaining =
        MAX_TARGET_WINDOW_SIZE - beforeBytes - targetBytes - afterBytes;
      if (remaining <= 0 || entry.bytes > remaining) {
        completed = false;
        break;
      }
      afterLines.push(entry);
      afterBytes += entry.bytes;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  const included = [...beforeLines, ...targetLines, ...afterLines];
  if (included.length === 0) {
    return {
      content: "",
      endLine: lineNumber,
      startLine: 1,
      totalLines: completed ? lineNumber : undefined,
      truncated: true,
    };
  }

  const startLine = included[0]?.lineNumber ?? 1;
  const endLine = included.at(-1)?.lineNumber ?? startLine;
  return {
    content: included.map((line) => line.text).join("\n"),
    endLine,
    startLine,
    totalLines: completed ? lineNumber : undefined,
    truncated: startLine > 1 || !completed,
  };
}

function sliceContentToRange(
  content: string,
  range: { end: number; start: number },
): TextContentSlice {
  const lines = content.split("\n");
  const startIndex = Math.max(0, range.start - 1);
  const endIndex = Math.min(lines.length, range.end);
  const selected = lines.slice(startIndex, endIndex);
  const endLine =
    selected.length > 0 ? range.start + selected.length - 1 : range.start;
  return {
    content: selected.join("\n"),
    endLine,
    startLine: range.start,
    totalLines: lines.length,
    truncated: range.start > 1 || endLine < lines.length,
  };
}

async function readExactTextRange(
  filePath: string,
  range: { end: number; start: number },
): Promise<TextContentSlice> {
  const selected: LineEntry[] = [];
  let bytes = 0;
  let lineNumber = 0;
  let completed = true;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: stream,
  });

  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < range.start) {
        continue;
      }
      if (lineNumber > range.end) {
        completed = false;
        break;
      }

      const entry: LineEntry = {
        bytes: lineBytes(line),
        lineNumber,
        text: line,
      };
      if (bytes + entry.bytes > MAX_TARGET_WINDOW_SIZE) {
        if (selected.length === 0) {
          const text = truncateUtf8(entry.text, MAX_TARGET_WINDOW_SIZE);
          selected.push({
            bytes: Buffer.byteLength(text, "utf8"),
            lineNumber,
            text,
          });
        }
        completed = false;
        break;
      }
      selected.push(entry);
      bytes += entry.bytes;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  const startLine = selected[0]?.lineNumber ?? range.start;
  const endLine = selected.at(-1)?.lineNumber ?? startLine;
  return {
    content: selected.map((line) => line.text).join("\n"),
    endLine,
    startLine,
    totalLines: completed ? lineNumber : undefined,
    truncated: startLine > 1 || !completed,
  };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function collectRenderedMarkdownMediaPaths(html: string): string[] {
  const paths = new Set<string>();
  const dataMediaPathPattern = /\bdata-media-path\s*=\s*(["'])(.*?)\1/gi;
  const localImageSrcPattern = /\bsrc\s*=\s*(["'])(.*?)\1/gi;

  for (const match of html.matchAll(dataMediaPathPattern)) {
    const rawPath = match[2];
    if (rawPath) {
      paths.add(decodeHtmlAttribute(rawPath));
    }
  }

  for (const match of html.matchAll(localImageSrcPattern)) {
    const rawSrc = match[2];
    if (!rawSrc) {
      continue;
    }
    try {
      const url = new URL(decodeHtmlAttribute(rawSrc), "http://local");
      if (
        url.origin === "http://local" &&
        url.pathname === "/api/local-image"
      ) {
        const rawPath = url.searchParams.get("path");
        if (rawPath) {
          paths.add(rawPath);
        }
      }
    } catch {
      // Ignore malformed generated HTML references.
    }
  }

  return Array.from(paths);
}

async function collectEmbeddedMarkdownMedia(
  html: string,
  projectRoot: string,
): Promise<FileContentResponse["embeddedMedia"] | undefined> {
  const mediaPaths = collectRenderedMarkdownMediaPaths(html);
  if (mediaPaths.length === 0) {
    return undefined;
  }

  const realRoot = await realpath(projectRoot).catch(() => null);
  if (!realRoot) {
    return undefined;
  }

  let totalBytes = 0;
  const embeddedMedia: NonNullable<FileContentResponse["embeddedMedia"]> = {};
  for (const rawPath of mediaPaths) {
    if (!rawPath || !isAbsolute(rawPath)) {
      continue;
    }
    const realPath = await realpath(rawPath).catch(() => null);
    if (!realPath || !isPathInsideDirectory(realPath, realRoot)) {
      continue;
    }

    const stats = await stat(realPath).catch(() => null);
    if (
      !stats?.isFile() ||
      stats.size > MAX_EMBEDDED_MARKDOWN_MEDIA_FILE_BYTES ||
      totalBytes + stats.size > MAX_EMBEDDED_MARKDOWN_MEDIA_BYTES
    ) {
      continue;
    }

    const mimeType = getMimeType(realPath);
    if (!mimeType.startsWith("image/")) {
      continue;
    }

    const data = (await readFile(realPath)).toString("base64");
    const value = { data, mimeType };
    totalBytes += stats.size;
    embeddedMedia[rawPath] = value;
    embeddedMedia[realPath] = value;
    embeddedMedia[relative(realRoot, realPath).replaceAll("\\", "/")] = value;
  }

  return Object.keys(embeddedMedia).length > 0 ? embeddedMedia : undefined;
}

/** Dotfiles (files starting with .) that are text files */
const TEXT_DOTFILES = new Set([
  ".env",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".prettierrc",
  ".prettierignore",
  ".eslintrc",
  ".eslintignore",
  ".babelrc",
  ".npmrc",
  ".nvmrc",
  ".dockerignore",
  ".browserslistrc",
  ".stylelintrc",
]);

/**
 * Check if file is a text file based on extension.
 */
function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (ext) {
    return TEXT_EXTENSIONS.has(ext);
  }
  // Handle dotfiles (files with no extension but starting with .)
  const fileName = filePath.split("/").pop() || filePath;
  return TEXT_DOTFILES.has(fileName.toLowerCase());
}

function expandHomePath(requestedPath: string): string {
  if (requestedPath === "~") {
    return homedir();
  }
  if (requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")) {
    return resolve(homedir(), requestedPath.slice(2));
  }
  return requestedPath;
}

/**
 * Validate and resolve a file path for authenticated project file APIs.
 *
 * Relative paths stay project-contained and symlink-safe. Absolute and
 * home-relative paths are intentionally allowed here because the authenticated
 * YA operator can already inspect host files through provider actions. Public
 * share file routes use separate share-scoped resolution.
 */
async function resolveFilePath(
  projectRoot: string,
  relativePath: string,
): Promise<string | null> {
  // Normalize the path to handle . and ..
  const normalized = normalize(expandHomePath(relativePath));

  if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return (await realpath(normalized).catch(() => null)) ?? normalized;
  }

  // Reject paths that try to escape (after normalization, should not start with ..)
  if (normalized.startsWith("..")) {
    return null;
  }

  // Resolve to absolute path
  const resolved = resolve(projectRoot, normalized);

  // Verify the resolved path is still within project root
  const normalizedRoot = resolve(projectRoot);
  if (!isPathInsideDirectory(resolved, normalizedRoot)) {
    return null;
  }

  const realRoot = await realpath(normalizedRoot).catch(() => null);
  if (!realRoot) {
    return null;
  }

  const realResolved = await realpath(resolved).catch(() => null);
  if (!realResolved) {
    return resolved;
  }

  // The lexical check above blocks ordinary traversal. This second check is
  // the security boundary for symlinks inside a project; keeping it here keeps
  // the file API simple while allowing normal in-project symlinks.
  if (!isPathInsideDirectory(realResolved, realRoot)) {
    return null;
  }

  return realResolved;
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(filePath));
  return (
    relativePath === "" ||
    (relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath))
  );
}

export function createFilesRoutes(deps: FilesDeps): Hono {
  const routes = new Hono();

  /**
   * GET /api/projects/:projectId/files
   * Get file metadata and content.
   * Query params:
   *   - path: relative path to file (required)
   *   - highlight: if "true", include syntax-highlighted HTML
   */
  routes.get("/:projectId/files", async (c) => {
    const projectId = c.req.param("projectId");
    const relativePath = c.req.query("path");
    const highlight = c.req.query("highlight") === "true";
    const viewMode: FileViewMode =
      c.req.query("view") === "range" ? "range" : "full";
    const requestedRange = getLineRange(
      parsePositiveIntegerQuery(c.req.query("line")),
      parsePositiveIntegerQuery(c.req.query("lineEnd")),
    );

    // Validate project ID format
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Validate path parameter
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    // Get project
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Get the project's working directory
    const projectRoot = project.path;

    // Resolve and validate file path
    const filePath = await resolveFilePath(projectRoot, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    // Check file exists and get stats
    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    // Must be a file, not a directory
    if (!stats.isFile()) {
      return c.json({ error: "Path is not a file" }, 400);
    }

    const mimeType = getMimeType(filePath);
    const isText = isTextFile(filePath);

    const metadata: FileMetadata = {
      path: relativePath,
      size: stats.size,
      mimeType,
      isText,
    };

    // Build raw URL
    const rawUrl = `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(relativePath)}`;

    const response: FileContentResponse = {
      metadata,
      rawUrl,
    };

    // For text files under size limit, include the whole file unless the link
    // explicitly asks for a compact range view. For targeted links into larger
    // files, include a bounded window centered on the target.
    if (isText && (stats.size <= MAX_INLINE_SIZE || requestedRange)) {
      try {
        const fullInlineContent =
          stats.size <= MAX_INLINE_SIZE
            ? await readFile(filePath, "utf-8")
            : undefined;
        const slice =
          viewMode === "range" && requestedRange
            ? fullInlineContent !== undefined
              ? sliceContentToRange(fullInlineContent, requestedRange)
              : await readExactTextRange(filePath, requestedRange)
            : fullInlineContent !== undefined
              ? {
                  content: fullInlineContent,
                  endLine: undefined,
                  startLine: 1,
                  totalLines: undefined,
                  truncated: false,
                }
              : await readTargetedTextWindow(filePath, requestedRange!);
        const { content } = slice;
        response.content = content;
        response.contentStartLine = slice.startLine;
        if (slice.endLine !== undefined) {
          response.contentEndLine = slice.endLine;
        }
        if (slice.totalLines !== undefined) {
          response.contentTotalLines = slice.totalLines;
        }
        if (slice.truncated) {
          response.contentTruncated = true;
        }

        // Add syntax highlighting if requested
        if (highlight) {
          const result = await highlightFile(content, relativePath);
          if (result) {
            response.highlightedHtml = result.html;
            response.highlightedLanguage = result.language;
            response.highlightedTruncated = result.truncated;
          }

          // Render markdown preview for .md files
          const ext = extname(relativePath).toLowerCase();
          if (ext === ".md" || ext === ".markdown") {
            try {
              const largeRangePreviewSlice =
                fullInlineContent === undefined &&
                viewMode === "range" &&
                requestedRange
                  ? await readTargetedTextWindow(filePath, requestedRange)
                  : undefined;
              const previewContent =
                fullInlineContent !== undefined && requestedRange
                  ? fullInlineContent
                  : (largeRangePreviewSlice?.content ?? content);
              const previewStartLine =
                fullInlineContent !== undefined && requestedRange
                  ? 1
                  : (largeRangePreviewSlice?.startLine ?? slice.startLine);
              const renderedMarkdownHtml = await renderMarkdownFilePreview(
                previewContent,
                {
                  localFileBasePath: dirname(filePath),
                },
                previewStartLine,
                requestedRange,
                viewMode,
              );
              response.renderedMarkdownHtml = renderedMarkdownHtml;
              response.embeddedMedia = await collectEmbeddedMarkdownMedia(
                renderedMarkdownHtml,
                projectRoot,
              );
            } catch {
              // Ignore markdown rendering errors
            }
          }
        }
      } catch {
        // If we can't read as text, just omit content
      }
    }

    return c.json(response);
  });

  /**
   * GET /api/projects/:projectId/files/raw
   * Get raw file content with appropriate Content-Type.
   * Query params:
   *   - path: relative path to file (required)
   *   - download: if "true", set Content-Disposition to attachment
   */
  routes.get("/:projectId/files/raw", async (c) => {
    const projectId = c.req.param("projectId");
    const relativePath = c.req.query("path");
    const download = c.req.query("download") === "true";

    // Validate project ID format
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Validate path parameter
    if (!relativePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    // Get project
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Get the project's working directory
    const projectRoot = project.path;

    // Resolve and validate file path
    const filePath = await resolveFilePath(projectRoot, relativePath);
    if (!filePath) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    // Check file exists and get stats
    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    // Must be a file, not a directory
    if (!stats.isFile()) {
      return c.json({ error: "Path is not a file" }, 400);
    }

    // Read file content
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      return c.json({ error: "Failed to read file" }, 500);
    }

    const mimeType = getMimeType(filePath);
    const fileName = relativePath.split("/").pop() || "file";

    // Set headers
    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Content-Length": String(content.length),
    };

    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    } else {
      headers["Content-Disposition"] = `inline; filename="${fileName}"`;
    }

    // Convert Buffer to Uint8Array for Response compatibility
    return new Response(new Uint8Array(content), { headers });
  });

  /**
   * POST /api/projects/:projectId/diff/expand
   * Compute an expanded diff with full file context.
   *
   * Uses originalFile from the SDK's Edit tool result directly - the SDK never
   * truncates this field (verified up to 150KB+ files).
   *
   * Body:
   *   - filePath: path to file (for syntax highlighting detection)
   *   - oldString: the original text being replaced
   *   - newString: the new text to insert
   *   - originalFile: complete file content from SDK Edit result
   */
  routes.post("/:projectId/diff/expand", async (c) => {
    // Parse body
    let body: {
      filePath: string;
      oldString: string;
      newString: string;
      originalFile: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { filePath, oldString, newString, originalFile } = body;

    if (
      !filePath ||
      typeof oldString !== "string" ||
      typeof newString !== "string" ||
      typeof originalFile !== "string"
    ) {
      return c.json(
        {
          error:
            "Missing required fields: filePath, oldString, newString, originalFile",
        },
        400,
      );
    }

    // Compute the new file content by applying the edit
    const newFullContent = originalFile.replace(oldString, newString);

    // Compute augment with large context (entire file)
    const augment = await computeEditAugment(
      "expand",
      {
        file_path: filePath,
        old_string: originalFile,
        new_string: newFullContent,
      },
      999999, // Full file context
    );

    return c.json({
      structuredPatch: augment.structuredPatch as PatchHunk[],
      diffHtml: augment.diffHtml,
    });
  });

  return routes;
}
