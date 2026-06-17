import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useInlineMedia } from "../../../hooks/useInlineMedia";
import { isMarkdownLikeFile } from "../../../lib/markdownFiles";
import { useScrollPreservingToggle } from "../../../lib/scrollAnchor";
import { compactShikiLineBreaks } from "../../../lib/shikiHtml";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { validateToolResult } from "../../../lib/validateToolResult";
import {
  FILE_MARKDOWN_PREVIEW_BASE_DENSITY,
  MarkdownPreview,
} from "../../MarkdownPreview";
import { SchemaWarning } from "../../SchemaWarning";
import { SessionFilePathLink } from "../../SessionFilePathLink";
import {
  FixedFontMathToggle,
  renderFixedFontMath,
  renderFixedFontRichContent,
} from "../../ui/FixedFontMathToggle";
import { RenderModeGlyph } from "../../ui/RenderModeGlyph";
import type {
  ImageFile,
  PdfFile,
  ReadInput,
  ReadResult,
  TextFile,
  ToolRenderer,
} from "./types";

/** Extended result type with server-rendered syntax highlighting */
interface ReadResultWithAugment extends ReadResult {
  _highlightedContentHtml?: string;
  _highlightedLanguage?: string;
  _highlightedTruncated?: boolean;
  _renderedMarkdownHtml?: string;
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return getPathBasename(filePath);
}

function getReadLineRange(file: TextFile): {
  lineEnd?: number;
  lineNumber?: number;
} {
  if (file.numLines <= 0) {
    return {};
  }
  const hasRange = file.startLine > 1 || file.numLines < file.totalLines;
  if (!hasRange) {
    return {};
  }
  const lineEnd = file.startLine + Math.max(1, file.numLines) - 1;
  return {
    lineEnd: lineEnd > file.startLine ? lineEnd : undefined,
    lineNumber: file.startLine,
  };
}

function getReadInputLineRange(input: ReadInput): {
  lineEnd?: number;
  lineNumber?: number;
} {
  if (input.offset === undefined) {
    return {};
  }
  const lineEnd =
    input.limit !== undefined
      ? input.offset + Math.max(1, input.limit) - 1
      : undefined;
  return {
    lineEnd:
      lineEnd !== undefined && lineEnd > input.offset ? lineEnd : undefined,
    lineNumber: input.offset,
  };
}

function renderReadMathPanel(html: string) {
  return (
    <div className="file-viewer-code fixed-font-rendered-panel">
      <div
        className="fixed-font-rendered__content"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted HTML from local rendering
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function ReadFilePathSummary({
  children,
  displayPath,
  filePath,
  lineEnd,
  lineNumber,
}: {
  children?: ReactNode;
  displayPath: string;
  filePath: string;
  lineEnd?: number;
  lineNumber?: number;
}) {
  return (
    <span className="file-link-inline">
      <SessionFilePathLink
        displayPath={displayPath}
        filePath={filePath}
        lineEnd={lineEnd}
        lineNumber={lineNumber}
      />
      {children && <> {children}</>}
    </span>
  );
}

function ReadRangeLink({
  filePath,
  lineEnd,
  lineNumber,
  text,
}: {
  filePath: string;
  lineEnd?: number;
  lineNumber?: number;
  text: string;
}) {
  return (
    <SessionFilePathLink
      displayPath={text}
      filePath={filePath}
      lineEnd={lineEnd}
      lineNumber={lineNumber}
      showLineSuffix={false}
      viewMode="range"
    />
  );
}

/**
 * Read tool use - shows file path being read
 */
function ReadToolUse({ input }: { input: ReadInput }) {
  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(input.file_path, meta?.projectPath);
  const lineRange = getReadInputLineRange(input);
  return (
    <div className="read-tool-use">
      <span className="file-path">
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={input.file_path}
          lineEnd={lineRange.lineEnd}
          lineNumber={lineRange.lineNumber}
        />
      </span>
      {(input.offset !== undefined || input.limit !== undefined) && (
        <span
          className="read-range"
          title={`offset ${input.offset ?? 0}, limit ${input.limit ?? "∞"}`}
        >
          {input.offset !== undefined && ` from line ${input.offset}`}
          {input.limit !== undefined && ` (${input.limit} lines)`}
        </span>
      )}
    </div>
  );
}

/**
 * Modal content for viewing file contents
 */
function FileModalContent({
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
}) {
  const isMarkdown = isMarkdownLikeFile(file.filePath);
  const clientMarkdownPreview = useMemo(() => {
    if (!isMarkdown || renderedMarkdownHtml) {
      return null;
    }
    const rendered = renderFixedFontRichContent(file.content, {
      baseFilePath: file.filePath,
    });
    return rendered.changed ? rendered.html : null;
  }, [file.content, file.filePath, isMarkdown, renderedMarkdownHtml]);
  const markdownHtml = isMarkdown
    ? (renderedMarkdownHtml ?? clientMarkdownPreview)
    : null;
  const hasMarkdownPreview = !!markdownHtml;
  const [showPreview, setShowPreview] = useState(false);

  // For Shiki-highlighted code files: offer KaTeX-only math rendering (default off).
  // Uses renderFixedFontMath (not renderFixedFontRichContent) so markdown structural
  // transforms (headings, lists, tables) are never applied to source code.
  const mathRendered = useMemo(
    () => (highlightedHtml ? renderFixedFontMath(file.content) : null),
    [highlightedHtml, file.content],
  );
  const hasMathToggle = !!mathRendered?.changed;
  const [showMath, setShowMath] = useState(false);
  const { btnRef: mathBtnRef, handleClick: handleMathToggle } =
    useScrollPreservingToggle(showMath, () => setShowMath((v) => !v));

  const lines = file.content.length > 0 ? file.content.split("\n") : [];

  const sourceView =
    file.content.length === 0 ? (
      <div className="file-viewer-empty-content">No content read</div>
    ) : highlightedHtml ? (
      <div className="file-viewer-code file-viewer-code-highlighted">
        <div
          className="shiki-container"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
          dangerouslySetInnerHTML={{
            __html: compactShikiLineBreaks(highlightedHtml) ?? "",
          }}
        />
        {highlightedTruncated && (
          <div className="file-viewer-truncated">
            Content truncated for highlighting (showing first 2000 lines)
          </div>
        )}
      </div>
    ) : (
      <div className="file-content-with-lines">
        <div className="line-numbers">
          {lines.map((_, i) => (
            <div key={`ln-${i + 1}`}>{file.startLine + i}</div>
          ))}
        </div>
        <pre className="line-content">
          <code>{file.content}</code>
        </pre>
      </div>
    );

  const content =
    showPreview && markdownHtml ? (
      <MarkdownPreview
        html={markdownHtml}
        density={FILE_MARKDOWN_PREVIEW_BASE_DENSITY}
      />
    ) : highlightedHtml ? (
      // Code file: show math-rendered plain text when toggled on, Shiki otherwise.
      // Math mode loses syntax colouring intentionally — you asked for the formula.
      showMath && mathRendered ? (
        renderReadMathPanel(mathRendered.html)
      ) : (
        sourceView
      )
    ) : (
      // Filename-affiliated non-Markdown files use math-only rendering to avoid
      // treating source-code backticks, arrays, or operators as Markdown.
      <FixedFontMathToggle
        sourceText={file.content}
        renderMode={isMarkdown ? "rich" : "math"}
        sourceView={sourceView}
        renderRenderedView={(html) => renderReadMathPanel(html)}
      />
    );

  const toggleButton = hasMarkdownPreview && (
    <div className="markdown-view-toggle">
      <button
        type="button"
        className={`toggle-btn ${!showPreview ? "active" : ""}`}
        onClick={() => setShowPreview(false)}
      >
        Source
      </button>
      <button
        type="button"
        className={`toggle-btn ${showPreview ? "active" : ""}`}
        onClick={() => setShowPreview(true)}
      >
        Preview
      </button>
    </div>
  );
  const showSigma = !hasMarkdownPreview && hasMathToggle;

  return (
    <div className="file-content-modal">
      {toggleButton}
      {showSigma ? (
        <div className="fixed-font-render-toggle">
          {content}
          <button
            ref={mathBtnRef}
            type="button"
            className={`fixed-font-render-toggle__button ${showMath ? "is-rendered" : ""}`}
            onClick={handleMathToggle}
            aria-label={showMath ? "Show source" : "Render math (LaTeX)"}
            title={showMath ? "Show source" : "Render math (LaTeX)"}
            aria-pressed={showMath}
          >
            <RenderModeGlyph />
          </button>
        </div>
      ) : (
        content
      )}
    </div>
  );
}

/**
 * Text file result - clickable filename that opens modal
 */
function TextFileResult({
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
}) {
  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(file.filePath, meta?.projectPath);
  const hasReadLines = file.numLines > 0;
  const showRange =
    hasReadLines && (file.startLine > 1 || file.numLines < file.totalLines);
  const lineRange = getReadLineRange(file);

  return (
    <div className="read-text-result read-text-inline">
      <div className="file-range-inline">
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={file.filePath}
          lineEnd={lineRange.lineEnd}
          lineNumber={lineRange.lineNumber}
        />
      </div>
      {showRange && (
        <div className="file-range-inline">
          <ReadRangeLink
            filePath={file.filePath}
            lineEnd={lineRange.lineEnd}
            lineNumber={lineRange.lineNumber}
            text={`lines ${file.startLine}–${file.startLine + file.numLines - 1}`}
          />{" "}
          of {file.totalLines}
        </div>
      )}
      {!hasReadLines && (
        <div className="file-range-inline">
          <span className="file-line-count-inline">0 lines</span>
          {file.totalLines > 0 && <> of {file.totalLines}</>}
        </div>
      )}
      <FileModalContent
        file={file}
        highlightedHtml={highlightedHtml}
        highlightedTruncated={highlightedTruncated}
        renderedMarkdownHtml={renderedMarkdownHtml}
      />
    </div>
  );
}

/**
 * Image file result - renders as img tag
 */
function ImageFileResult({
  file,
  filePath,
}: {
  file: ImageFile;
  filePath?: string;
}) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const { dimensions } = file;
  const meta = useOptionalSessionMetadata();
  const displayPath = filePath
    ? makeDisplayPath(filePath, meta?.projectPath)
    : null;
  const hasDimensions =
    dimensions?.originalWidth != null && dimensions?.originalHeight != null;

  // Respect the "Expand Inline Media by Default" appearance setting. Like the
  // markdown/transcript media previews, start collapsed unless the user opts in,
  // and let the setting drive expansion until the user toggles this preview.
  const { inlineMediaExpandedByDefault } = useInlineMedia();
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? inlineMediaExpandedByDefault;

  return (
    <div className="read-image-result">
      <div className="local-media-link-group">
        <button
          type="button"
          className="local-media-inline-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse image" : "Expand image"}
          title={expanded ? "Collapse inline preview" : "Expand inline preview"}
          onClick={() => setOverride(!expanded)}
        >
          {expanded ? "-" : "+"}
        </button>
        {filePath && displayPath ? (
          <span className="file-range-inline">
            <SessionFilePathLink
              displayPath={displayPath}
              filePath={filePath}
            />
          </span>
        ) : (
          <span className="local-media-type">image</span>
        )}
      </div>
      {(hasDimensions || sizeKB > 0) && (
        <div className="image-info">
          {hasDimensions && (
            <>
              {dimensions.originalWidth}x{dimensions.originalHeight}
            </>
          )}
          {hasDimensions && sizeKB > 0 && " "}
          {sizeKB > 0 && <>({sizeKB}\u202fkb)</>}
        </div>
      )}
      {expanded && (
        <img
          className="read-image"
          src={`data:${file.type};base64,${file.base64}`}
          alt="File content"
          width={dimensions?.displayWidth}
          height={dimensions?.displayHeight}
        />
      )}
    </div>
  );
}

/**
 * Open base64 PDF data in a new browser tab
 */
function openPdfInNewTab(base64Data: string) {
  const byteChars = atob(base64Data);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

/**
 * PDF file result - button to open in new tab
 */
function PdfFileResult({
  file,
  filePath,
}: {
  file: PdfFile;
  filePath?: string;
}) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const fileName = filePath ? getFileName(filePath) : "document.pdf";
  const meta = useOptionalSessionMetadata();
  const displayPath = filePath
    ? makeDisplayPath(filePath, meta?.projectPath)
    : null;

  if (filePath && displayPath) {
    return (
      <div className="read-pdf-result">
        <ReadFilePathSummary displayPath={displayPath} filePath={filePath}>
          {sizeKB > 0 && (
            <span className="file-line-count-inline">({sizeKB}\u202fkb)</span>
          )}
          <span className="file-line-count-inline">PDF</span>
        </ReadFilePathSummary>
      </div>
    );
  }

  return (
    <div className="read-pdf-result">
      <button
        type="button"
        className="file-link-button"
        onClick={() => openPdfInNewTab(file.base64)}
      >
        {fileName}
        {sizeKB > 0 && (
          <span className="file-line-count">({sizeKB}\u202fkb)</span>
        )}
        <span className="file-line-count">Open PDF</span>
      </button>
    </div>
  );
}

/**
 * Read tool result - dispatches to text or image handler
 */
function ReadToolResult({
  input,
  result,
  isError,
}: {
  input?: ReadInput;
  result: ReadResultWithAugment;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Read", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Read", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Read");

  if (isError || !result?.file) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="read-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to read file"}
      </div>
    );
  }

  if (result.type === "pdf") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <PdfFileResult
          file={result.file as PdfFile}
          filePath={input?.file_path}
        />
      </>
    );
  }

  if (result.type === "image") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <ImageFileResult
          file={result.file as ImageFile}
          filePath={input?.file_path}
        />
      </>
    );
  }

  return (
    <>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Read" errors={validationErrors} />
      )}
      <TextFileResult
        file={result.file as TextFile}
        highlightedHtml={result._highlightedContentHtml}
        highlightedTruncated={result._highlightedTruncated}
        renderedMarkdownHtml={result._renderedMarkdownHtml}
      />
    </>
  );
}

/**
 * Interactive summary for Read tool - clickable filename that opens modal
 */
function ReadInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: ReadInput;
  result: ReadResultWithAugment | undefined;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Read", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Read", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Read");

  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(input.file_path, meta?.projectPath);

  if (isError) {
    return (
      <span>
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={input.file_path}
        />
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </span>
    );
  }

  if (!result?.file) {
    return (
      <span>
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={input.file_path}
        />
      </span>
    );
  }

  if (result.type === "pdf") {
    return (
      <ReadFilePathSummary displayPath={displayPath} filePath={input.file_path}>
        <span className="file-line-count-inline">(PDF)</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </ReadFilePathSummary>
    );
  }

  if (result.type === "image") {
    return (
      <ReadFilePathSummary displayPath={displayPath} filePath={input.file_path}>
        <span className="file-line-count-inline">(image)</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </ReadFilePathSummary>
    );
  }

  const file = result.file as TextFile;

  if (file.numLines <= 0) {
    return (
      <ReadFilePathSummary displayPath={displayPath} filePath={file.filePath}>
        <span className="file-line-count-inline">0 lines</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </ReadFilePathSummary>
    );
  }

  return (
    <ReadFilePathSummary
      displayPath={displayPath}
      filePath={file.filePath}
      {...getReadLineRange(file)}
    >
      <span className="file-line-count-inline">
        <ReadRangeLink
          filePath={file.filePath}
          text={`${file.numLines} lines`}
          {...getReadLineRange(file)}
        />
      </span>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Read" errors={validationErrors} />
      )}
    </ReadFilePathSummary>
  );
}

export const readRenderer: ToolRenderer<ReadInput, ReadResult> = {
  tool: "Read",

  renderToolUse(input, _context) {
    return <ReadToolUse input={input as ReadInput} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <ReadToolResult
        input={input as ReadInput | undefined}
        result={result as ReadResultWithAugment}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return getFileName((input as ReadInput).file_path);
  },

  getResultSummary(result, isError, input?) {
    if (isError && input) return getFileName((input as ReadInput).file_path);
    if (isError) return "Error";
    const r = result as ReadResultWithAugment;
    if (!r?.file) return "Reading...";
    if (r.type === "pdf") return "PDF";
    if (r.type === "image") return "Image";
    const file = r.file as TextFile;
    return file.numLines <= 0 ? "0 lines" : getFileName(file.filePath);
  },

  renderInteractiveSummary(input, result, isError, _context) {
    return (
      <ReadInteractiveSummary
        input={input as ReadInput}
        result={result as ReadResultWithAugment | undefined}
        isError={isError}
      />
    );
  },
};
