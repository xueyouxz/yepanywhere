import { useEffect, useMemo, useState } from "react";
import { useScrollPreservingToggle } from "../../../lib/scrollAnchor";
import {
  FixedFontMathToggle,
  renderFixedFontMath,
  renderFixedFontRichContent,
} from "../../ui/FixedFontMathToggle";
import type { ZodError } from "zod";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useInlineImages } from "../../../hooks/useInlineImages";
import { makeDisplayPath } from "../../../lib/text";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { SessionFilePathLink } from "../../SessionFilePathLink";
import { FilePathDisplay } from "../../ui/FilePathDisplay";
import { Modal } from "../../ui/Modal";
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
  session_id?: string | number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getReadSessionId(result: unknown): string | number | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const sessionId = result.session_id;
  if (typeof sessionId === "string" || typeof sessionId === "number") {
    return sessionId;
  }
  return undefined;
}

function isPtyHandoffTextRead(
  result: ReadResultWithAugment | undefined,
): boolean {
  if (result?.type !== "text") {
    return false;
  }
  const sessionId = getReadSessionId(result);
  if (sessionId === undefined) {
    return false;
  }
  const file = result.file as TextFile | undefined;
  return !!file && file.content.length === 0;
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
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

/**
 * Read tool use - shows file path being read
 */
function ReadToolUse({ input }: { input: ReadInput }) {
  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(input.file_path, meta?.projectPath);
  return (
    <div className="read-tool-use">
      <span className="file-path">
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={input.file_path}
          lineNumber={input.offset}
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
  const clientMarkdownPreview = useMemo(() => {
    if (renderedMarkdownHtml) {
      return null;
    }
    const rendered = renderFixedFontRichContent(file.content, {
      baseFilePath: file.filePath,
    });
    return rendered.changed ? rendered.html : null;
  }, [file.content, file.filePath, renderedMarkdownHtml]);
  const markdownHtml = renderedMarkdownHtml ?? clientMarkdownPreview;
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

  const lines = (file.content ?? "").split("\n");

  const sourceView = highlightedHtml ? (
    <div className="file-viewer-code file-viewer-code-highlighted">
      <div
        className="shiki-container"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
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
      <div className="markdown-preview">
        <div
          className="markdown-rendered"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
          dangerouslySetInnerHTML={{ __html: markdownHtml }}
        />
      </div>
    ) : highlightedHtml ? (
      // Code file: show math-rendered plain text when toggled on, Shiki otherwise.
      // Math mode loses syntax colouring intentionally — you asked for the formula.
      showMath && mathRendered ? (
        renderReadMathPanel(mathRendered.html)
      ) : (
        sourceView
      )
    ) : (
      // Plain text / log / output: full ANSI + math + markdown table detection.
      <FixedFontMathToggle
        sourceText={file.content}
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
  isPtyHandoff = false,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
  isPtyHandoff?: boolean;
}) {
  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(file.filePath, meta?.projectPath);
  const showRange = file.startLine > 1 || file.numLines < file.totalLines;

  if (isPtyHandoff) {
    return (
      <div className="read-text-result">
        <span className="file-path">
          <SessionFilePathLink
            displayPath={displayPath}
            filePath={file.filePath}
            lineNumber={file.startLine}
          />
        </span>{" "}
        <span className="file-line-count">continues in Shell</span>
      </div>
    );
  }

  return (
    <div className="read-text-result read-text-inline">
      {showRange && (
        <div className="file-range-inline">
          lines {file.startLine}–{file.startLine + file.numLines - 1} of{" "}
          {file.totalLines}
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
function ImageFilePreview({ file }: { file: ImageFile }) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const { dimensions } = file;
  const hasDimensions =
    dimensions?.originalWidth != null && dimensions?.originalHeight != null;

  return (
    <div className="read-image-result">
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
      <img
        className="read-image"
        src={`data:${file.type};base64,${file.base64}`}
        alt="File content"
        width={dimensions?.displayWidth}
        height={dimensions?.displayHeight}
      />
    </div>
  );
}

function ImageFileResult({
  file,
  fileName = "File content",
  forceInline = false,
}: {
  file: ImageFile;
  fileName?: string;
  forceInline?: boolean;
}) {
  const { inlineImagesEnabled } = useInlineImages();
  const [showModal, setShowModal] = useState(false);

  if (forceInline || inlineImagesEnabled) {
    return <ImageFilePreview file={file} />;
  }

  return (
    <div className="read-image-result">
      <button
        type="button"
        className="file-link-button"
        onClick={() => setShowModal(true)}
      >
        {fileName}
        <span className="file-line-count">(image)</span>
      </button>
      {showModal && (
        <Modal title={fileName} onClose={() => setShowModal(false)}>
          <ImageFilePreview file={file} />
        </Modal>
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
  result,
  isError,
}: {
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
        <PdfFileResult file={result.file as PdfFile} />
      </>
    );
  }

  if (result.type === "image") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <ImageFileResult file={result.file as ImageFile} />
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
        isPtyHandoff={isPtyHandoffTextRead(result)}
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
  const [showModal, setShowModal] = useState(false);
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
  const fileName = getFileName(input.file_path);

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
    const pdfFile = result.file as PdfFile;
    return (
      <button
        type="button"
        className="file-link-inline"
        onClick={(e) => {
          e.stopPropagation();
          openPdfInNewTab(pdfFile.base64);
        }}
      >
        <FilePathDisplay displayPath={displayPath} />
        <span className="file-line-count-inline">(PDF)</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </button>
    );
  }

  if (result.type === "image") {
    const imageFile = result.file as ImageFile;
    return (
      <>
        <button
          type="button"
          className="file-link-inline"
          onClick={(e) => {
            e.stopPropagation();
            setShowModal(true);
          }}
        >
          <FilePathDisplay displayPath={displayPath} />
          <span className="file-line-count-inline">(image)</span>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Read" errors={validationErrors} />
          )}
        </button>
        {showModal && (
          <Modal title={fileName} onClose={() => setShowModal(false)}>
            <ImageFileResult file={imageFile} fileName={fileName} forceInline />
          </Modal>
        )}
      </>
    );
  }

  const file = result.file as TextFile;
  const isPtyHandoff = isPtyHandoffTextRead(result);

  if (isPtyHandoff) {
    return (
      <span>
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={file.filePath}
          lineNumber={file.startLine}
        />{" "}
        <span className="file-line-count-inline">continues in Shell</span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="file-link-inline"
        onClick={(e) => {
          e.stopPropagation();
          setShowModal(true);
        }}
      >
        <FilePathDisplay displayPath={displayPath} />{" "}
        <span className="file-line-count-inline">{file.numLines} lines</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </button>
      {showModal && (
        <Modal title={fileName} onClose={() => setShowModal(false)}>
          <TextFileResult
            file={file}
            highlightedHtml={result._highlightedContentHtml}
            highlightedTruncated={result._highlightedTruncated}
            renderedMarkdownHtml={result._renderedMarkdownHtml}
          />
        </Modal>
      )}
    </>
  );
}

export const readRenderer: ToolRenderer<ReadInput, ReadResult> = {
  tool: "Read",

  renderToolUse(input, _context) {
    return <ReadToolUse input={input as ReadInput} />;
  },

  renderToolResult(result, isError, _context) {
    return (
      <ReadToolResult
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
    if (isPtyHandoffTextRead(r)) return "continues in Shell";
    if (r.type === "pdf") return "PDF";
    if (r.type === "image") return "Image";
    return getFileName((r.file as TextFile).filePath);
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
