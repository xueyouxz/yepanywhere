import katex from "katex";
import {
  Marked,
  type RendererObject,
  type RendererThis,
  type Tokens,
} from "marked";
import { isAbsolute, normalize, resolve } from "node:path";
import sanitizeHtml from "sanitize-html";
import { parseLineColumn } from "@yep-anywhere/shared";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const ALLOWED_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

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

const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

export interface SafeMarkdownRenderOptions {
  /**
   * Directory that relative local markdown links are resolved against.
   *
   * Relative links containing `..` are left as ordinary text/links. Project
   * file endpoints still perform their own containment checks; this renderer
   * only resolves same-directory or child-directory links for previews.
   */
  localFileBasePath?: string;
  /**
   * Emit direct <img> tags for local images instead of the interactive YA
   * inline-media placeholder. Used by standalone rendered documents that do
   * not run the React inline-preview hydrator.
   */
  inlineLocalImages?: boolean;
}

let activeRenderOptions: SafeMarkdownRenderOptions = {};

interface LocalPathReference {
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
}

function stripHrefSuffix(href: string): string {
  return href.split(/[?#]/, 1)[0] ?? "";
}

function parseLocalPathReference(path: string): LocalPathReference {
  const parsed = parseLineColumn(stripHrefSuffix(path.trim()));
  return {
    filePath: parsed.path,
    lineNumber: parsed.line,
    columnNumber: parsed.column,
  };
}

function formatLocalPathReference(reference: LocalPathReference): string {
  let display = reference.filePath;
  if (reference.lineNumber !== undefined) {
    display += `:${reference.lineNumber}`;
    if (reference.columnNumber !== undefined) {
      display += `:${reference.columnNumber}`;
    }
  }
  return display;
}

/**
 * Check if a string looks like an absolute local file path.
 * Must start with / (but not //) and contain a file extension.
 */
function isLocalFilePath(href: string): boolean {
  const trimmed = parseLocalPathReference(href).filePath;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  // Must have a file extension after the last /
  const basename = trimmed.split("/").pop() ?? "";
  return basename.includes(".");
}

/**
 * Get the file extension from a path (lowercase, without the dot).
 */
function getExtension(path: string): string {
  return (parseLocalPathReference(path).filePath.split(".").pop() ?? "")
    .toLowerCase();
}

/**
 * Get the filename from a path.
 */
function getFileName(path: string): string {
  return parseLocalPathReference(path).filePath.split("/").pop() ?? path;
}

function isMarkdownExtension(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext);
}

/**
 * Rewrite a local media path to the local-image API endpoint.
 */
function localMediaApiUrl(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(
    parseLocalPathReference(path).filePath,
  )}`;
}

/**
 * Rewrite a local text file path to the local-file API endpoint.
 */
function localFileApiUrl(
  reference: LocalPathReference,
  options: { renderMarkdown?: boolean } = {},
): string {
  let url = `/api/local-file?path=${encodeURIComponent(reference.filePath)}`;
  if (options.renderMarkdown) {
    url += "&render=1";
  }
  if (reference.lineNumber !== undefined) {
    url += `&line=${reference.lineNumber}`;
  }
  if (reference.columnNumber !== undefined) {
    url += `&column=${reference.columnNumber}`;
  }
  return url;
}

/**
 * Render a local media file as a clickable placeholder link.
 * The client intercepts clicks on .local-media-link to open a modal.
 */
function renderLocalMediaLink(
  reference: LocalPathReference,
  label: string,
  ext: string,
): string {
  const apiUrl = escapeHtml(localMediaApiUrl(reference.filePath));
  const escapedPath = escapeHtml(reference.filePath);
  const escapedLabel = escapeHtml(label || getFileName(reference.filePath));
  const mediaType = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  const typeLabel = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  return `<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="true" aria-label="Collapse ${mediaType}" aria-expanded="true" title="Collapse inline preview">-</button><a href="${apiUrl}" class="local-media-link" data-media-type="${mediaType}">${escapedLabel}<span class="local-media-type">(${typeLabel})</span></a></span><span class="local-media-inline-preview" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="true"></span>`;
}

function renderDirectLocalImage(path: string, altText: string, title?: string) {
  const src = escapeHtml(localMediaApiUrl(path));
  const altAttr = altText ? ` alt="${escapeHtml(altText)}"` : ' alt=""';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${src}"${altAttr}${titleAttr}>`;
}

function resolveLocalMarkdownHref(href: string): LocalPathReference | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  if (isLocalFilePath(trimmed)) {
    return parseLocalPathReference(trimmed);
  }

  const basePath = activeRenderOptions.localFileBasePath;
  if (!basePath) {
    return null;
  }

  if (
    isAbsolute(trimmed) ||
    trimmed.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return null;
  }

  const parsed = parseLocalPathReference(trimmed);
  const normalized = normalize(parsed.filePath);
  const segments = normalized.split(/[\\/]+/);
  if (
    !normalized ||
    normalized === "." ||
    segments.some((segment) => segment === "..")
  ) {
    return null;
  }

  return {
    filePath: resolve(basePath, normalized),
    lineNumber: parsed.lineNumber,
    columnNumber: parsed.columnNumber,
  };
}

const MARKDOWN_SANITIZE_OPTIONS = {
  allowedTags: [
    "a",
    "blockquote",
    "br",
    "button",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "class", "data-media-type"],
    button: [
      "type",
      "class",
      "data-media-path",
      "data-media-type",
      "data-expanded",
      "aria-label",
      "aria-expanded",
      "title",
    ],
    code: ["class"],
    img: ["src", "alt", "title"],
    input: ["type", "checked", "disabled"],
    ol: ["start"],
    span: ["class", "data-media-path", "data-media-type", "data-expanded"],
    td: ["align"],
    th: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
    img: ["http", "https"],
  },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "escape" as const,
};

const renderer: RendererObject<string, string> = {
  html({ text }) {
    // Disable raw HTML passthrough from markdown by escaping it.
    return escapeHtml(text);
  },
  link(
    this: RendererThis<string, string>,
    { href, title, tokens }: Tokens.Link,
  ) {
    const localPath = resolveLocalMarkdownHref(href);
    if (localPath) {
      const ext = getExtension(localPath.filePath);
      const renderedText = this.parser.parseInline(tokens);

      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(localPath, renderedText, ext);
      }
      const apiUrl = escapeHtml(
        localFileApiUrl(localPath, {
          renderMarkdown: isMarkdownExtension(ext),
        }),
      );
      const titleAttr = ` title="${escapeHtml(
        title ?? formatLocalPathReference(localPath),
      )}"`;
      return `<a href="${apiUrl}"${titleAttr}>${renderedText}</a>`;
    }

    const safeHref = sanitizeUrl(href);
    const renderedText = this.parser.parseInline(tokens);

    if (!safeHref) {
      // Keep readable text when URL protocol is unsafe.
      return renderedText;
    }

    const escapedHref = escapeHtml(safeHref);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapedHref}"${titleAttr}>${renderedText}</a>`;
  },
  image({ href, title, text }: Tokens.Image) {
    const localPath = resolveLocalMarkdownHref(href);
    if (localPath) {
      const ext = getExtension(localPath.filePath);

      if (MEDIA_EXTENSIONS.has(ext)) {
        if (
          activeRenderOptions.inlineLocalImages &&
          IMAGE_EXTENSIONS.has(ext)
        ) {
          return renderDirectLocalImage(
            localPath.filePath,
            text,
            title ?? undefined,
          );
        }
        return renderLocalMediaLink(localPath, text, ext);
      }
      // Unrecognized extension — just show text
      return escapeHtml(text || getFileName(localPath.filePath));
    }

    const safeSrc = sanitizeUrl(href, ALLOWED_IMAGE_PROTOCOLS);
    if (!safeSrc) {
      return escapeHtml(text);
    }

    const escapedSrc = escapeHtml(safeSrc);
    const altAttr = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapedSrc}"${altAttr}${titleAttr}>`;
  },
};

const markdownRenderer = new Marked({
  async: false,
  gfm: true,
});

// KaTeX output is generated inside the marked renderer and stashed in
// this buffer; the renderer emits placeholder spans that survive
// sanitize-html unchanged, and we substitute the real HTML back in
// after sanitization. This keeps katex's complex span/svg markup out
// of the sanitize allowlist while still running the rest of the
// markdown through strict sanitization.
//
// Safe as module state because `renderSafeMarkdown` is synchronous and
// Node is single-threaded — no interleaving is possible between reset
// and substitute.
let katexBuffer: string[] = [];

function renderKatexPlaceholder(tex: string, displayMode: boolean): string {
  let html: string;
  try {
    html = katex.renderToString(tex, {
      throwOnError: false,
      displayMode,
      output: "html",
      strict: "ignore",
      trust: false,
    });
  } catch {
    html = `<span class="katex-error">${escapeHtml(tex)}</span>`;
  }
  const id = katexBuffer.length;
  katexBuffer.push(html);
  return `<span class="yepkatex-placeholder yepkatex-id-${id}"></span>`;
}

markdownRenderer.use({
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start(src: string) {
        const idx = src.indexOf("$$");
        return idx < 0 ? undefined : idx;
      },
      tokenizer(src: string) {
        const match = /^\$\$\s*([\s\S]+?)\s*\$\$(?:\n|$)/.exec(src);
        if (!match) return undefined;
        return {
          type: "mathBlock",
          raw: match[0],
          text: match[1] ?? "",
        };
      },
      renderer(token) {
        const tex = (token as { text?: string }).text ?? "";
        return renderKatexPlaceholder(tex, true);
      },
    },
    {
      name: "mathInline",
      level: "inline",
      start(src: string) {
        const idx = src.indexOf("$");
        return idx < 0 ? undefined : idx;
      },
      tokenizer(src: string) {
        // Require non-space immediately after opening $ and before
        // closing $; require non-digit/non-$ after closing $ to avoid
        // matching prices like "$100 and $200".
        const match = /^\$(?!\s)([^\n$]+?)(?<!\s)\$(?![\d$])/.exec(src);
        if (!match) return undefined;
        return {
          type: "mathInline",
          raw: match[0],
          text: match[1] ?? "",
        };
      },
      renderer(token) {
        const tex = (token as { text?: string }).text ?? "";
        return renderKatexPlaceholder(tex, false);
      },
    },
  ],
});

markdownRenderer.use({ renderer });

/**
 * Return a safe absolute URL for markdown links, or null for unsupported schemes.
 */
export function sanitizeUrl(
  url: string,
  allowedProtocols: ReadonlySet<string> = ALLOWED_LINK_PROTOCOLS,
): string | null {
  const trimmed = url.trim();
  if (!trimmed || /\p{C}/u.test(trimmed)) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, "");
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (!allowedProtocols.has(parsed.protocol.toLowerCase())) {
      return null;
    }
  } catch {
    return null;
  }

  return normalized;
}

/**
 * Render markdown to sanitized HTML with raw HTML disabled.
 */
export function renderSafeMarkdown(
  markdown: string,
  options: SafeMarkdownRenderOptions = {},
): string {
  activeRenderOptions = options;
  katexBuffer = [];
  try {
    const rendered = markdownRenderer.parse(markdown, { async: false });
    const html = typeof rendered === "string" ? rendered : "";
    const sanitized = sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
    const substituted = sanitized.replace(
      /<span class="yepkatex-placeholder yepkatex-id-(\d+)"><\/span>/g,
      (_match, idxStr) => katexBuffer[Number(idxStr)] ?? "",
    );
    return substituted.trim();
  } finally {
    katexBuffer = [];
    activeRenderOptions = {};
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export {
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isLocalFilePath,
  localFileApiUrl,
  localMediaApiUrl,
};
