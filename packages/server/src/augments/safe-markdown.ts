import katex from "katex";
import {
  Marked,
  type RendererObject,
  type RendererThis,
  type Tokens,
} from "marked";
import sanitizeHtml from "sanitize-html";

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

/**
 * Check if a string looks like an absolute local file path.
 * Must start with / (but not //) and contain a file extension.
 */
function isLocalFilePath(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  // Must have a file extension after the last /
  const basename = trimmed.split("/").pop() ?? "";
  return basename.includes(".");
}

/**
 * Get the file extension from a path (lowercase, without the dot).
 */
function getExtension(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

/**
 * Get the filename from a path.
 */
function getFileName(path: string): string {
  return path.trim().split("/").pop() ?? path;
}

/**
 * Rewrite a local media path to the local-image API endpoint.
 */
function localMediaApiUrl(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path.trim())}`;
}

/**
 * Rewrite a local text file path to the local-file API endpoint.
 */
function localFileApiUrl(path: string): string {
  return `/api/local-file?path=${encodeURIComponent(path.trim())}`;
}

/**
 * Render a local media file as a clickable placeholder link.
 * The client intercepts clicks on .local-media-link to open a modal.
 */
function renderLocalMediaLink(
  path: string,
  label: string,
  ext: string,
): string {
  const trimmedPath = path.trim();
  const apiUrl = escapeHtml(localMediaApiUrl(trimmedPath));
  const escapedPath = escapeHtml(trimmedPath);
  const escapedLabel = escapeHtml(label || getFileName(path));
  const mediaType = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  const typeLabel = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  return `<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="true" aria-label="Collapse ${mediaType}" aria-expanded="true" title="Collapse inline preview">-</button><a href="${apiUrl}" class="local-media-link" data-media-type="${mediaType}">${escapedLabel}<span class="local-media-type">(${typeLabel})</span></a></span><span class="local-media-inline-preview" data-media-path="${escapedPath}" data-media-type="${mediaType}" data-expanded="true"></span>`;
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
    // Check for local file paths first — rewrite to clickable media placeholder
    if (isLocalFilePath(href)) {
      const ext = getExtension(href);
      const renderedText = this.parser.parseInline(tokens);

      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(href, renderedText, ext);
      }
      // Other local file — render as a link to the API
      const apiUrl = escapeHtml(localFileApiUrl(href));
      const titleAttr = ` title="${escapeHtml(title ?? href)}"`;
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
    // Check for local file paths first — rewrite to clickable media placeholder
    if (isLocalFilePath(href)) {
      const ext = getExtension(href);

      if (MEDIA_EXTENSIONS.has(ext)) {
        return renderLocalMediaLink(href, text, ext);
      }
      // Unrecognized extension — just show text
      return escapeHtml(text || getFileName(href));
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
export function renderSafeMarkdown(markdown: string): string {
  katexBuffer = [];
  const rendered = markdownRenderer.parse(markdown, { async: false });
  const html = typeof rendered === "string" ? rendered : "";
  const sanitized = sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
  const substituted = sanitized.replace(
    /<span class="yepkatex-placeholder yepkatex-id-(\d+)"><\/span>/g,
    (_match, idxStr) => katexBuffer[Number(idxStr)] ?? "",
  );
  katexBuffer = [];
  return substituted.trim();
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
