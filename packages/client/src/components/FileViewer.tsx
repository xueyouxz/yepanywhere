import type { FileContentResponse } from "@yep-anywhere/shared";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { getEmbeddedFileMediaBlob } from "../lib/embeddedFileMedia";
import { compactShikiLineBreaks } from "../lib/shikiHtml";
import {
  fetchMediaBlob,
  LocalMediaModal,
  type LocalMediaSource,
  useLocalMediaClick,
  useLocalMediaInlinePreviews,
} from "./LocalMediaModal";
import {
  combineDensityOffsets,
  FILE_MARKDOWN_PREVIEW_BASE_DENSITY,
  FILE_SOURCE_BASE_DENSITY,
  FileViewerDensityControls,
  getSourceViewStyle,
  MarkdownPreview,
  MarkdownViewToggle,
  useFileViewerDensity,
} from "./MarkdownPreview";

export interface FileViewerSource {
  loadFile: (
    projectId: string,
    filePath: string,
    highlight: boolean,
    lineNumber?: number,
    lineEnd?: number,
    viewMode?: FileViewerMode,
  ) => Promise<FileContentResponse>;
  getRawFileUrl?: (
    projectId: string,
    filePath: string,
    download: boolean,
  ) => string | null;
  fetchRawFileBlob?: (
    fileData: FileContentResponse,
    filePath: string,
    download: boolean,
  ) => Promise<Blob>;
  createMediaSource?: (
    fileData: FileContentResponse | null,
  ) => LocalMediaSource | undefined;
  transformRenderedMarkdownHtml?: (
    html: string,
    fileData: FileContentResponse,
  ) => string;
}

interface FileViewerProps {
  projectId: string;
  filePath: string;
  source?: FileViewerSource;
  openInNewTabUrl?: string | null;
  onClose?: () => void;
  /** If true, renders as standalone page layout instead of modal content */
  standalone?: boolean;
  /** Line number to scroll to and highlight (1-indexed) */
  lineNumber?: number;
  /** End line for range highlighting (1-indexed). If not provided, only lineNumber is highlighted. */
  lineEnd?: number;
  /** Full shows context; range shows only the requested line range. */
  viewMode?: FileViewerMode;
}

export type FileViewerMode = "full" | "range";

/**
 * Format file size for display.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
}

/**
 * Get language hint from file extension for potential future syntax highlighting.
 */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    php: "php",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    md: "markdown",
    markdown: "markdown",
  };
  return langMap[ext] || "plaintext";
}

/**
 * Check if file is an image.
 */
function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Check if file is markdown.
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

/**
 * Get filename from path.
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getHighlightRange(
  lineNumber?: number,
  lineEnd?: number,
): { end: number; start: number } | null {
  if (lineNumber === undefined) {
    return null;
  }
  return {
    end: Math.max(lineNumber, lineEnd ?? lineNumber),
    start: lineNumber,
  };
}

function getContentStartLine(fileData: FileContentResponse | null): number {
  return fileData?.contentStartLine ?? 1;
}

function getContentEndLine(fileData: FileContentResponse): number | undefined {
  if (fileData.contentEndLine !== undefined) {
    return fileData.contentEndLine;
  }
  if (fileData.content === undefined) {
    return undefined;
  }
  return (
    getContentStartLine(fileData) + fileData.content.split("\n").length - 1
  );
}

function getContentWindowLabel(fileData: FileContentResponse): string | null {
  if (!fileData.contentTruncated) {
    return null;
  }
  const endLine = getContentEndLine(fileData);
  const total = fileData.contentTotalLines
    ? ` of ${fileData.contentTotalLines}`
    : "";
  return `Showing lines ${getContentStartLine(fileData)}-${endLine}${total}`;
}

function annotateHighlightedHtmlLines(
  html: string | undefined,
  contentStartLine: number,
  lineNumber?: number,
  lineEnd?: number,
): string | undefined {
  if (!html) {
    return html;
  }
  const range = getHighlightRange(lineNumber, lineEnd);
  if (!range) {
    return html;
  }

  const singleLine = range.start === range.end;
  let currentLine = 0;
  return html.replace(/<span class="([^"]*)">/g, (match, className: string) => {
    if (!className.split(/\s+/).includes("line")) {
      return match;
    }
    currentLine += 1;
    const actualLine = contentStartLine + currentLine - 1;
    const inRange = actualLine >= range.start && actualLine <= range.end;
    const classes = [
      className,
      singleLine && inRange ? "highlighted-line" : "",
      actualLine === range.start ? "highlighted-line-start" : "",
      actualLine === range.end ? "highlighted-line-end" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `<span class="${classes}" data-line="${actualLine}">`;
  });
}

const DEFAULT_FILE_VIEWER_SOURCE: FileViewerSource = {
  loadFile: (projectId, filePath, highlight, lineNumber, lineEnd, viewMode) =>
    api.getFile(projectId, filePath, highlight, lineNumber, lineEnd, viewMode),
  getRawFileUrl: (projectId, filePath, download) =>
    api.getFileRawUrl(projectId, filePath, download),
  createMediaSource: (fileData) =>
    fileData
      ? {
          fetchBlob: async (_path, apiPath) => {
            const embedded = getEmbeddedFileMediaBlob(fileData, _path);
            return embedded ?? fetchMediaBlob(apiPath);
          },
        }
      : undefined,
};

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getTargetTopWithinContainer(
  container: HTMLElement,
  target: HTMLElement,
): number {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.top - containerRect.top + container.scrollTop;
}

function getFileViewerTargetScrollTop(
  container: HTMLElement,
  target: HTMLElement,
): number {
  if (container.scrollHeight <= container.clientHeight) {
    return 0;
  }
  const targetTop = getTargetTopWithinContainer(container, target);
  const leadIn = container.clientHeight * 0.1;
  const maxScrollTop = Math.max(
    0,
    container.scrollHeight - container.clientHeight,
  );
  return Math.max(0, Math.min(maxScrollTop, targetTop - leadIn));
}

/**
 * FileViewer component - displays file content with appropriate formatting.
 */
export const FileViewer = memo(function FileViewer({
  projectId,
  filePath,
  source = DEFAULT_FILE_VIEWER_SOURCE,
  openInNewTabUrl,
  onClose,
  standalone = false,
  lineNumber,
  lineEnd,
  viewMode = "full",
}: FileViewerProps) {
  const { t } = useI18n();
  const [fileData, setFileData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [imageObjectUrl, setImageObjectUrl] = useState<string | null>(null);
  const [highlightedLineRef, setHighlightedLineRef] =
    useState<HTMLElement | null>(null);
  const viewerDensity = useFileViewerDensity();
  const sourceDensity = combineDensityOffsets(
    FILE_SOURCE_BASE_DENSITY,
    viewerDensity.density,
  );
  const markdownDensity = combineDensityOffsets(
    FILE_MARKDOWN_PREVIEW_BASE_DENSITY,
    viewerDensity.density,
  );
  const sourceStyle = getSourceViewStyle(sourceDensity);
  const fileViewerBodyRef = useRef<HTMLDivElement>(null);
  const markdownPreviewRef = useRef<HTMLDivElement>(null);
  const {
    modal: localMediaModal,
    handleClick: handleLocalMediaClick,
    closeModal: closeLocalMediaModal,
  } = useLocalMediaClick();
  const handleLocalMediaKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== " ") return;
      const target = (event.target as HTMLElement).closest?.(
        "a.local-media-link",
      ) as HTMLAnchorElement | null;
      if (!target) return;

      event.preventDefault();
      target.click();
    },
    [],
  );
  const mediaSource = useMemo(
    () => source.createMediaSource?.(fileData),
    [fileData, source],
  );
  const renderedMarkdownHtml = useMemo(() => {
    if (!fileData?.renderedMarkdownHtml) {
      return null;
    }
    return source.transformRenderedMarkdownHtml
      ? source.transformRenderedMarkdownHtml(
          fileData.renderedMarkdownHtml,
          fileData,
        )
      : fileData.renderedMarkdownHtml;
  }, [fileData, source]);
  const highlightedHtml = useMemo(() => {
    const annotated = annotateHighlightedHtmlLines(
      fileData?.highlightedHtml,
      getContentStartLine(fileData),
      lineNumber,
      lineEnd,
    );
    return compactShikiLineBreaks(annotated);
  }, [fileData, lineEnd, lineNumber]);
  useLocalMediaInlinePreviews(
    markdownPreviewRef,
    showPreview ? renderedMarkdownHtml : null,
    mediaSource,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHighlightedLineRef(null);

    // Request highlighting for code files
    source
      .loadFile(projectId, filePath, true, lineNumber, lineEnd, viewMode)
      .then((data) => {
        if (!cancelled) {
          setFileData(data);
          setShowPreview(
            lineNumber === undefined &&
              isMarkdownFile(filePath) &&
              Boolean(data.renderedMarkdownHtml),
          );
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("fileViewerLoadFailed" as never));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, filePath, lineEnd, lineNumber, source, t, viewMode]);

  useEffect(() => {
    if (!fileData || !isImageFile(fileData.metadata.mimeType)) {
      setImageObjectUrl(null);
      return;
    }
    if (!source.fetchRawFileBlob) {
      setImageObjectUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setImageObjectUrl(null);
    void source
      .fetchRawFileBlob(fileData, filePath, false)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageObjectUrl(objectUrl);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [fileData, filePath, source]);

  // Handle Escape key to exit fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen]);

  // Scroll to highlighted line when it's rendered
  useEffect(() => {
    if (lineNumber === undefined) {
      return;
    }
    const highlightedLine =
      highlightedLineRef ??
      fileViewerBodyRef.current?.querySelector<HTMLElement>(
        ".highlighted-line-start, .markdown-preview-span-start",
      );
    const viewerBody = fileViewerBodyRef.current;
    if (highlightedLine && viewerBody) {
      requestAnimationFrame(() => {
        viewerBody.scrollTop = getFileViewerTargetScrollTop(
          viewerBody,
          highlightedLine,
        );
      });
    }
  }, [fileData, highlightedLineRef, lineEnd, lineNumber, showPreview]);

  const handleCopy = useCallback(async () => {
    if (fileData?.content === undefined) return;
    try {
      await navigator.clipboard.writeText(fileData.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [fileData?.content]);

  const fileName = getFileName(filePath);
  const language = getLanguageFromPath(filePath);

  const handleDownload = useCallback(() => {
    if (!fileData) return;
    if (source.fetchRawFileBlob) {
      void source
        .fetchRawFileBlob(fileData, filePath, true)
        .then((blob) => downloadBlob(blob, fileName))
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      return;
    }
    const url =
      source.getRawFileUrl?.(projectId, filePath, true) ?? fileData.rawUrl;
    if (url) {
      window.open(url, "_blank");
    }
  }, [fileData, fileName, filePath, projectId, source]);

  const handleOpenInNewTab = useCallback(() => {
    if (openInNewTabUrl) {
      window.open(openInNewTabUrl, "_blank");
      return;
    }
    const searchParams = new URLSearchParams({ path: filePath });
    if (lineNumber !== undefined) {
      searchParams.set("line", String(lineNumber));
    }
    if (lineEnd !== undefined) {
      searchParams.set("lineEnd", String(lineEnd));
    }
    if (viewMode === "range") {
      searchParams.set("view", "range");
    }
    const url = `/projects/${projectId}/file?${searchParams}`;
    window.open(url, "_blank");
  }, [projectId, filePath, lineNumber, lineEnd, openInNewTabUrl, viewMode]);

  // Render loading state
  if (loading) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-loading">
          {t("fileViewerLoading" as never, { name: fileName })}
        </div>
      </div>
    );
  }

  // Render error state
  if (error || !fileData) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-error">
          {error || t("fileViewerNotFound" as never)}
        </div>
      </div>
    );
  }

  const { metadata, content, rawUrl } = fileData;
  const isImage = isImageFile(metadata.mimeType);
  const rawFileUrl =
    source.getRawFileUrl?.(projectId, filePath, false) ?? rawUrl;
  const canDownload = Boolean(source.fetchRawFileBlob || rawFileUrl);
  const hasMarkdownPreview =
    content !== undefined && isMarkdownFile(filePath) && !!renderedMarkdownHtml;

  // Render content based on file type
  const renderContent = () => {
    // Image files
    if (isImage) {
      const imageUrl = source.fetchRawFileBlob ? imageObjectUrl : rawFileUrl;
      return (
        <div className="file-viewer-image">
          {imageUrl ? (
            <img src={imageUrl} alt={fileName} />
          ) : (
            <div className="file-viewer-loading">
              {t("fileViewerLoading" as never, { name: fileName })}
            </div>
          )}
        </div>
      );
    }

    // Text files
    if (content !== undefined) {
      // Show rendered markdown preview
      if (showPreview && renderedMarkdownHtml) {
        return (
          <MarkdownPreview
            html={renderedMarkdownHtml}
            density={markdownDensity}
            ariaLabel={t("fileViewerPreview" as never)}
            onClick={handleLocalMediaClick}
            onKeyDown={handleLocalMediaKeyDown}
            ref={markdownPreviewRef}
          />
        );
      }

      // Server-rendered syntax highlighting (preferred)
      if (highlightedHtml) {
        const contentWindowLabel = getContentWindowLabel(fileData);
        return (
          <div
            className="file-viewer-code file-viewer-code-highlighted"
            data-language={fileData.highlightedLanguage ?? language}
            style={sourceStyle}
          >
            <div
              className="shiki-container"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
            {fileData.highlightedTruncated && (
              <div className="file-viewer-truncated">
                {t("fileViewerHighlightTruncated" as never)}
              </div>
            )}
            {contentWindowLabel && (
              <div className="file-viewer-truncated">{contentWindowLabel}</div>
            )}
          </div>
        );
      }

      // Fallback: plain code (no syntax highlighting available)
      const lines = content.length > 0 ? content.split("\n") : [];
      const contentStartLine = getContentStartLine(fileData);
      const highlightStart = lineNumber ?? 0;
      const highlightEnd = Math.max(highlightStart, lineEnd ?? highlightStart);
      const singleLineHighlight = highlightStart === highlightEnd;
      const contentWindowLabel = getContentWindowLabel(fileData);

      return (
        <div
          className="file-viewer-code"
          data-language={language}
          style={sourceStyle}
        >
          {lines.length > 0 ? (
            <div className="code-highlighter-plain">
              <div className="code-line-numbers">
                {lines.map((_, i) => {
                  const num = contentStartLine + i;
                  return <div key={`ln-${num}`}>{num}</div>;
                })}
              </div>
              <pre className="code-content">
                <code>
                  {lines.map((line, i) => {
                    const num = contentStartLine + i;
                    const inRange =
                      lineNumber !== undefined &&
                      num >= highlightStart &&
                      num <= highlightEnd;
                    const classes = [
                      singleLineHighlight && inRange ? "highlighted-line" : "",
                      num === highlightStart ? "highlighted-line-start" : "",
                      num === highlightEnd ? "highlighted-line-end" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <div
                        key={`line-${num}`}
                        ref={
                          lineNumber !== undefined && num === highlightStart
                            ? (el) => setHighlightedLineRef(el)
                            : undefined
                        }
                        className={classes || undefined}
                        data-line={num}
                      >
                        {line || " "}
                      </div>
                    );
                  })}
                </code>
              </pre>
            </div>
          ) : (
            <div className="file-viewer-empty-content">No content read</div>
          )}
          {contentWindowLabel && (
            <div className="file-viewer-truncated">{contentWindowLabel}</div>
          )}
        </div>
      );
    }

    // Binary files or files too large
    return (
      <div className="file-viewer-binary">
        <p>{t("fileViewerBinary" as never)}</p>
        <p>
          <strong>{t("fileViewerType" as never)}</strong> {metadata.mimeType}
        </p>
        <p>
          <strong>{t("fileViewerSize" as never)}</strong>{" "}
          {formatFileSize(metadata.size)}
        </p>
        {canDownload && (
          <button
            type="button"
            className="file-viewer-download-btn"
            onClick={handleDownload}
          >
            {t("fileViewerDownloadFile" as never)}
          </button>
        )}
      </div>
    );
  };

  // Header with file info and actions
  const header = (
    <div className="file-viewer-header">
      <div className="file-viewer-info">
        <span className="file-viewer-path" title={filePath}>
          {filePath}
        </span>
        <span className="file-viewer-meta">
          {formatFileSize(metadata.size)}
          {metadata.isText && content !== undefined && (
            <>
              {" \u2022 "}
              {fileData.contentTruncated
                ? `lines ${getContentStartLine(fileData)}-${getContentEndLine(fileData)}${
                    fileData.contentTotalLines
                      ? ` of ${fileData.contentTotalLines}`
                      : ""
                  }`
                : t("fileViewerLines" as never, {
                    count: content.length > 0 ? content.split("\n").length : 0,
                  })}
            </>
          )}
        </span>
      </div>
      <div className="file-viewer-actions">
        {hasMarkdownPreview && (
          <MarkdownViewToggle
            sourceLabel={t("fileViewerSource" as never)}
            previewLabel={t("fileViewerPreview" as never)}
            showPreview={showPreview}
            onShowSource={() => setShowPreview(false)}
            onShowPreview={() => setShowPreview(true)}
          />
        )}
        {metadata.isText && content !== undefined && (
          <FileViewerDensityControls
            zoom={viewerDensity.zoom}
            canZoomIn={viewerDensity.canZoomIn}
            canZoomOut={viewerDensity.canZoomOut}
            onZoomIn={viewerDensity.zoomIn}
            onZoomOut={viewerDensity.zoomOut}
          />
        )}
        {content !== undefined && (
          <button
            type="button"
            className={`file-viewer-action ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            title={
              copied
                ? t("fileViewerCopied" as never)
                : t("fileViewerCopyContent" as never)
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        )}
        {!standalone && (
          <button
            type="button"
            className="file-viewer-action"
            onClick={handleOpenInNewTab}
            title={t("fileViewerOpenNewTab" as never)}
          >
            <ExternalLinkIcon />
          </button>
        )}
        {canDownload && (
          <button
            type="button"
            className="file-viewer-action"
            onClick={handleDownload}
            title={t("fileViewerDownload" as never)}
          >
            <DownloadIcon />
          </button>
        )}
        <button
          type="button"
          className="file-viewer-action"
          onClick={() => setFullscreen(!fullscreen)}
          title={
            fullscreen
              ? t("fileViewerExitFullscreen" as never)
              : t("fileViewerFullscreen" as never)
          }
        >
          {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
        {onClose && (
          <button
            type="button"
            className="file-viewer-action file-viewer-close"
            onClick={onClose}
            title={t("modalClose")}
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );

  const viewerClass = [
    "file-viewer",
    standalone && "file-viewer-standalone",
    fullscreen && "file-viewer-fullscreen",
    viewMode === "range" && "file-viewer-compact",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={viewerClass}>
      {header}
      <div className="file-viewer-body" ref={fileViewerBodyRef}>
        {renderContent()}
      </div>
      {localMediaModal ? (
        <LocalMediaModal
          path={localMediaModal.path}
          mediaType={localMediaModal.mediaType}
          mediaSource={mediaSource}
          onClose={closeLocalMediaModal}
        />
      ) : null}
    </div>
  );
});

// Icons
function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v9M4 8l4 4 4-4M2 14h12" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4M9 2h5v5M6 10l8-8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" />
    </svg>
  );
}

function ExitFullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 2v3H2M14 5h-3V2M11 14v-3h3M2 11h3v3" />
    </svg>
  );
}
