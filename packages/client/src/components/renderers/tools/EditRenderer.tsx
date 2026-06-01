import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useExpandedDiff } from "../../../hooks/useExpandedDiff";
import {
  classifyToolError,
  getErrorClassSuffix,
  isUserRejection,
} from "../../../lib/classifyToolError";
import { makeDisplayPath } from "../../../lib/text";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { FilePathLink } from "../../FilePathLink";
import { FilePathDisplay } from "../../ui/FilePathDisplay";
import { FixedFontMathToggle } from "../../ui/FixedFontMathToggle";
import { Modal } from "../../ui/Modal";
import type { EditInput, EditResult, PatchHunk, ToolRenderer } from "./types";

const MAX_VISIBLE_LINES = 12;

/** Extended input type with embedded augment data from server */
interface EditInputWithAugment extends EditInput {
  _structuredPatch?: PatchHunk[];
  _diffHtml?: string;
  _rawPatch?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractRawPatchFromInput(input?: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (!isRecord(input)) {
    return undefined;
  }
  const rawPatch = input._rawPatch;
  return typeof rawPatch === "string" ? rawPatch : undefined;
}

function extractFilePathsFromRawPatch(rawPatch?: string): string[] {
  if (typeof rawPatch !== "string" || rawPatch.trim().length === 0) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s+(.+?)\s*$/,
    );
    if (match?.[1]) {
      const path = match[1].trim();
      if (path && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }

  return paths;
}

function extractFilePathsFromChanges(input?: unknown): string[] {
  if (!isRecord(input) || !Array.isArray(input.changes)) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const change of input.changes) {
    if (!isRecord(change) || typeof change.path !== "string") {
      continue;
    }
    const path = change.path.trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function extractEditFilePaths(
  input?: unknown,
  result?: Partial<EditResult>,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const addPath = (path: unknown) => {
    if (typeof path !== "string") return;
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    paths.push(trimmed);
  };

  addPath(result?.filePath);
  if (isRecord(input)) {
    addPath(input.file_path);
  }
  for (const path of extractFilePathsFromRawPatch(
    extractRawPatchFromInput(input),
  )) {
    addPath(path);
  }
  for (const path of extractFilePathsFromChanges(input)) {
    addPath(path);
  }
  return paths;
}

function extractFilePathFromRawPatch(rawPatch?: string): string | undefined {
  return extractFilePathsFromRawPatch(rawPatch)[0];
}

function getEditFilePath(
  input?: unknown,
  result?: Partial<EditResult>,
): string {
  return extractEditFilePaths(input, result)[0] ?? "";
}

/**
 * Extract filename from path.
 * Some Codex tool aliases (e.g. apply_patch -> Edit) may not include file_path.
 */
function getFileName(filePath?: string): string {
  if (typeof filePath !== "string") return "Patch";
  const trimmed = filePath.trim();
  if (!trimmed) return "Patch";
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

function getPatchTargetSummary(
  input?: unknown,
  result?: Partial<EditResult>,
): string {
  const filePaths = extractEditFilePaths(input, result);
  const firstPath = filePaths[0];
  if (!firstPath) return "Patch";
  const firstFileName = getFileName(firstPath);
  if (filePaths.length <= 1) return firstFileName;
  return `${firstFileName} +${filePaths.length - 1} files`;
}

function getPatchTargetTitle(
  input: unknown,
  result: Partial<EditResult> | undefined,
  projectPath: string | null,
): string | undefined {
  const displayPaths = getPatchTargetDisplayPaths(input, result, projectPath);
  return displayPaths.length > 0 ? displayPaths.join("\n") : undefined;
}

function getPatchTargetDisplayPaths(
  input: unknown,
  result: Partial<EditResult> | undefined,
  projectPath: string | null,
): string[] {
  return extractEditFilePaths(input, result).map((path) =>
    makeDisplayPath(path, projectPath),
  );
}

/**
 * Check if this is a Claude plan file
 */
function isPlanFile(filePath: string): boolean {
  return filePath.includes(".claude/plans/");
}

/**
 * Compute change summary from structuredPatch
 */
function computeChangeSummary(structuredPatch: PatchHunk[]): string | null {
  if (!structuredPatch || structuredPatch.length === 0) return null;

  const additions = structuredPatch
    .flatMap((h) => h.lines)
    .filter((l) => l.startsWith("+")).length;
  const deletions = structuredPatch
    .flatMap((h) => h.lines)
    .filter((l) => l.startsWith("-")).length;

  if (additions > 0 && deletions > 0) {
    return `Modified ${additions + deletions} lines`;
  }
  if (additions > 0) {
    return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
  }
  if (deletions > 0) {
    return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
  }
  return null;
}

function diffTextToNewSide(diffText: string): string {
  const lines = diffText.split("\n");
  const newSideLines: string[] = [];
  for (const line of lines) {
    const prefix = line[0];
    if (prefix === "-") {
      continue;
    }
    if (prefix === "+" || prefix === " ") {
      newSideLines.push(line.slice(1));
      continue;
    }
    if (line.trim().length > 0 && !line.startsWith("@@")) {
      newSideLines.push(line);
    }
  }
  return newSideLines.join("\n");
}

function truncateByLines(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

function renderFixedFontMathPanel(html: string, className: string) {
  return (
    <div className={`${className} fixed-font-rendered-panel`}>
      <div
        className="fixed-font-rendered__content"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted HTML from local rendering
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function DiffCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    },
    [text],
  );

  return (
    <button
      type="button"
      className={`diff-copy-button ${copied ? "copied" : ""}`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={handleCopy}
      aria-label="Copy post-change text"
      title="Copy post-change text"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function DiffMathView({
  sourceText,
  sourceView,
  truncated = false,
  diffAware = true,
  baseFilePath,
  copyText,
}: {
  sourceText: string;
  sourceView: ReactNode;
  truncated?: boolean;
  diffAware?: boolean;
  baseFilePath?: string;
  copyText?: string;
}) {
  const effectiveCopyText =
    copyText ?? (diffAware ? diffTextToNewSide(sourceText) : sourceText);
  return (
    <FixedFontMathToggle
      sourceText={sourceText}
      diffAware={diffAware}
      baseFilePath={baseFilePath}
      sourceView={
        <div className={`diff-view-container ${truncated ? "truncated" : ""}`}>
          <div className="diff-view">{sourceView}</div>
          {effectiveCopyText && <DiffCopyButton text={effectiveCopyText} />}
          {truncated && <div className="diff-fade-overlay" />}
        </div>
      }
      renderRenderedView={(html) => (
        <div className={`diff-view-container ${truncated ? "truncated" : ""}`}>
          <div className="diff-view">
            {renderFixedFontMathPanel(html, "diff-content")}
          </div>
          {effectiveCopyText && <DiffCopyButton text={effectiveCopyText} />}
          {truncated && <div className="diff-fade-overlay" />}
        </div>
      )}
    />
  );
}

/**
 * Render diff lines (shared between pending preview and result fallback)
 * Memoized to prevent scroll reset when parent re-renders.
 */
const DiffLines = memo(function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          // Use line content hash for stable keys
          const key = `${i}-${line.slice(0, 50)}`;
          return (
            <div key={key} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

/**
 * Render pre-highlighted diff HTML from shiki.
 * Used when diffHtml is available from the augment.
 * Memoized to prevent scroll reset when parent re-renders.
 */
const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
  truncateLines,
}: {
  diffHtml: string;
  truncateLines?: number;
}) {
  // If truncation is needed, we need to limit the visible lines
  // The HTML is wrapped in <pre class="shiki"><code>...</code></pre>
  // Each line is a <span class="line ...">...</span>
  const htmlToRender = useMemo(() => {
    if (!truncateLines) return diffHtml;

    // Parse and truncate by counting line spans
    // Match any span with class starting with "line" (e.g. "line", "line line-deleted")
    const lineRegex = /<span class="line[^"]*">/g;
    const matches = [...diffHtml.matchAll(lineRegex)];
    if (matches.length <= truncateLines) return diffHtml;

    // Find the position to truncate at (after truncateLines lines)
    const lastMatch = matches[truncateLines - 1];
    if (!lastMatch) return diffHtml;

    // Find the closing </span> for this line
    const startPos = (lastMatch.index ?? 0) + lastMatch[0].length;
    const closeSpanPos = diffHtml.indexOf("</span>", startPos);
    if (closeSpanPos === -1) return diffHtml;

    // Truncate and close tags
    return `${diffHtml.slice(0, closeSpanPos + 7)}</code></pre>`;
  }, [diffHtml, truncateLines]);

  return (
    <div
      className="highlighted-diff"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
      dangerouslySetInnerHTML={{ __html: htmlToRender }}
    />
  );
});

/**
 * Render a single diff hunk (without @@ header for cleaner display)
 * Memoized to prevent scroll reset when parent re-renders.
 */
const DiffHunk = memo(function DiffHunk({ hunk }: { hunk: PatchHunk }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {hunk.lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div key={`${hunk.oldStart}-${i}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

function RawPatchPreview({
  rawPatch,
  truncateLines,
  baseFilePath,
}: {
  rawPatch: string;
  truncateLines?: number;
  baseFilePath?: string;
}) {
  const preview = useMemo(() => {
    if (!truncateLines) {
      return { text: rawPatch, truncated: false };
    }
    return truncateByLines(rawPatch, truncateLines);
  }, [rawPatch, truncateLines]);

  return (
    <FixedFontMathToggle
      sourceText={preview.text}
      diffAware
      baseFilePath={baseFilePath ?? extractFilePathFromRawPatch(rawPatch)}
      sourceView={
        <div
          className={`diff-view-container ${preview.truncated ? "truncated" : ""}`}
        >
          <div className="diff-view">
            <pre className="code-block">
              <code>{preview.text}</code>
            </pre>
          </div>
          {preview.truncated && <div className="diff-fade-overlay" />}
        </div>
      }
      renderRenderedView={(html) => (
        <div
          className={`diff-view-container ${preview.truncated ? "truncated" : ""}`}
        >
          <div className="diff-view">
            {renderFixedFontMathPanel(html, "code-block")}
          </div>
          {preview.truncated && <div className="diff-fade-overlay" />}
        </div>
      )}
    />
  );
}

function RawPatchModalContent({
  rawPatch,
  baseFilePath,
}: {
  rawPatch: string;
  baseFilePath?: string;
}) {
  return (
    <div className="diff-modal-content">
      <FixedFontMathToggle
        sourceText={rawPatch}
        diffAware
        baseFilePath={baseFilePath ?? extractFilePathFromRawPatch(rawPatch)}
        sourceView={
          <pre className="code-block">
            <code>{rawPatch}</code>
          </pre>
        }
        renderRenderedView={(html) =>
          renderFixedFontMathPanel(html, "code-block")
        }
      />
    </div>
  );
}

/**
 * Edit tool use - shows file path and diff preview
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
function EditToolUse({ input }: { input: EditInputWithAugment }) {
  // Show loading state if augment data not yet available
  if (!input._structuredPatch || input._structuredPatch.length === 0) {
    if (input._rawPatch) {
      return (
        <div className="edit-result">
          <RawPatchPreview
            rawPatch={input._rawPatch}
            baseFilePath={getEditFilePath(input)}
          />
        </div>
      );
    }
    return (
      <div className="edit-result">
        <div className="edit-loading">Computing diff...</div>
      </div>
    );
  }

  const diffLines = input._structuredPatch.flatMap((hunk) => hunk.lines);
  const filePath = getEditFilePath(input);
  const changeSummary = computeChangeSummary(input._structuredPatch);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <div className="edit-result">
      {changeSummary && (
        <div className="edit-change-summary">{changeSummary}</div>
      )}
      <DiffMathView
        sourceText={diffLines.join("\n")}
        baseFilePath={filePath}
        truncated={isTruncated}
        sourceView={
          input._diffHtml ? (
            <HighlightedDiff
              diffHtml={input._diffHtml}
              truncateLines={isTruncated ? MAX_VISIBLE_LINES : undefined}
            />
          ) : (
            <DiffLines lines={diffLines} />
          )
        }
      />
    </div>
  );
}

/**
 * Modal content for viewing complete diff with optional full file context.
 * Full context toggle is only available when originalFile is provided.
 */
function DiffModalContent({
  diffHtml,
  structuredPatch,
  filePath,
  oldString,
  newString,
  originalFile,
}: {
  diffHtml?: string;
  structuredPatch: PatchHunk[];
  filePath: string;
  oldString: string;
  newString: string;
  /** Complete file content from SDK Edit result (never truncated). Null for file creation. */
  originalFile?: string | null;
}) {
  const sessionMetadata = useOptionalSessionMetadata();
  const projectPath = sessionMetadata?.projectPath ?? null;
  const [showFullContext, setShowFullContext] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Only fetch expanded diff when originalFile is available (not for file creation)
  // The SDK's originalFile is never truncated - it's the complete file content.
  const canExpandContext = !!originalFile;
  const { loading, error, result, fetchExpandedDiff } = useExpandedDiff({
    filePath,
    oldString,
    newString,
    originalFile: originalFile ?? "", // Empty string won't be used if canExpandContext is false
  });

  const handleToggle = useCallback(async () => {
    if (!canExpandContext) return;
    if (!showFullContext && !result) {
      await fetchExpandedDiff();
    }
    setShowFullContext(!showFullContext);
  }, [canExpandContext, showFullContext, result, fetchExpandedDiff]);

  // Scroll to the first changed line when showing full context
  useEffect(() => {
    if (showFullContext && result && contentRef.current) {
      // Wait for DOM to update with new content
      requestAnimationFrame(() => {
        const firstChange = contentRef.current?.querySelector(
          ".line-deleted, .line-inserted",
        );
        if (firstChange) {
          firstChange.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }
  }, [showFullContext, result]);

  // Use expanded result when showing full context
  const displayHtml =
    showFullContext && result?.diffHtml ? result.diffHtml : diffHtml;
  const displayPatch =
    showFullContext && result?.structuredPatch
      ? result.structuredPatch
      : structuredPatch;

  // Strip project path prefix for display
  const displayPath = makeDisplayPath(filePath, projectPath);

  return (
    <div className="diff-modal-content" ref={contentRef}>
      <div className="diff-context-controls">
        {sessionMetadata?.projectId ? (
          <FilePathLink
            projectId={sessionMetadata.projectId}
            filePath={filePath}
            displayText={displayPath}
          />
        ) : (
          <span className="diff-context-path">{displayPath}</span>
        )}
        {canExpandContext && (
          <button
            type="button"
            className="diff-context-toggle"
            onClick={handleToggle}
            disabled={loading}
          >
            {loading
              ? "Loading..."
              : showFullContext
                ? "Show diff only"
                : "Show full context"}
          </button>
        )}
        {error && <span className="diff-context-error">{error}</span>}
      </div>

      <DiffMathView
        sourceText={displayPatch.flatMap((h) => h.lines).join("\n")}
        baseFilePath={displayPath}
        sourceView={
          displayHtml ? (
            <HighlightedDiff diffHtml={displayHtml} />
          ) : (
            <DiffLines lines={displayPatch.flatMap((h) => h.lines)} />
          )
        }
      />
    </div>
  );
}

function EditModalTitle({
  filePath,
  displayText,
}: {
  filePath: string;
  displayText?: string;
}) {
  const sessionMetadata = useOptionalSessionMetadata();
  const text = displayText ?? getFileName(filePath);

  if (sessionMetadata?.projectId && filePath) {
    return (
      <FilePathLink
        projectId={sessionMetadata.projectId}
        filePath={filePath}
        displayText={text}
      />
    );
  }

  return (
    <span className="file-path" title={filePath}>
      {text}
    </span>
  );
}

/**
 * Collapsed preview showing diff with expand button
 * Clicking opens a modal with the full diff.
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
function EditCollapsedPreview({
  input,
  result,
  isError,
}: {
  input: EditInputWithAugment;
  result: EditResult | undefined;
  isError: boolean;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isError) {
        setIsModalOpen(true);
      }
    },
    [isError],
  );

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  // Use result data if available, fall back to input
  const filePath = getEditFilePath(input, result);
  const fileName = getFileName(filePath);
  const oldString = result?.oldString ?? input.old_string;
  const newString = result?.newString ?? input.new_string;
  const originalFile = result?.originalFile;

  // Get structuredPatch - prefer result, then input augment
  const structuredPatch =
    result?.structuredPatch ?? input._structuredPatch ?? [];

  // Get diffHtml from input augment (only used for tool_use display)
  const diffHtml = input._diffHtml;
  const rawPatch = input._rawPatch;

  if (isError) {
    // Extract error message - can be a string or object with content
    let errorMessage: string | null = null;
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }

    // Classify the error for appropriate styling
    const classification = errorMessage
      ? classifyToolError(errorMessage)
      : {
          classification: "unknown" as const,
          label: "Error",
          cleanedMessage: "",
        };
    const classSuffix = getErrorClassSuffix(classification.classification);
    const isRejection = isUserRejection(classification.classification);

    // For user rejections, show the proposed diff alongside the declined badge
    const hasProposedDiff =
      isRejection &&
      input._structuredPatch &&
      input._structuredPatch.length > 0;
    const proposedDiffLines = hasProposedDiff
      ? (input._structuredPatch?.flatMap((hunk) => hunk.lines) ?? [])
      : [];
    const proposedDiffTruncated = proposedDiffLines.length > MAX_VISIBLE_LINES;

    return (
      <>
        <div className={`edit-collapsed-preview edit-collapsed-${classSuffix}`}>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <span className={`badge badge-${classSuffix}`}>
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </span>
          {classification.userReason ? (
            <span className="edit-error-message">
              {classification.userReason}
            </span>
          ) : classification.cleanedMessage && !isRejection ? (
            <span className="edit-error-message">
              {classification.cleanedMessage}
            </span>
          ) : null}
          {hasProposedDiff && (
            <DiffMathView
              sourceText={proposedDiffLines.join("\n")}
              baseFilePath={filePath}
              truncated={proposedDiffTruncated}
              sourceView={
                input._diffHtml ? (
                  <HighlightedDiff
                    diffHtml={input._diffHtml}
                    truncateLines={
                      proposedDiffTruncated ? MAX_VISIBLE_LINES : undefined
                    }
                  />
                ) : (
                  <DiffLines lines={proposedDiffLines} />
                )
              }
            />
          )}
          {hasProposedDiff && proposedDiffTruncated && (
            <button
              type="button"
              className="diff-expand-button"
              onClick={(e) => {
                e.stopPropagation();
                setIsModalOpen(true);
              }}
            >
              Show full diff
            </button>
          )}
        </div>
        {isModalOpen && hasProposedDiff && (
          <Modal
            title={<EditModalTitle filePath={filePath} displayText={fileName} />}
            onClose={handleClose}
          >
            <DiffModalContent
              diffHtml={diffHtml}
              structuredPatch={structuredPatch}
              filePath={filePath}
              oldString={oldString}
              newString={newString}
            />
          </Modal>
        )}
      </>
    );
  }

  // Pending edit without augment data yet
  if (structuredPatch.length === 0) {
    if (result === undefined) {
      return (
        <div className="edit-collapsed-preview">
          <div className="edit-loading">Computing diff...</div>
        </div>
      );
    }

    if (rawPatch) {
      const rawPatchPreview = truncateByLines(rawPatch, MAX_VISIBLE_LINES);
      return (
        <>
          <div className="edit-collapsed-preview">
            {showValidationWarning && validationErrors && (
              <SchemaWarning toolName="Edit" errors={validationErrors} />
            )}
            <RawPatchPreview
              rawPatch={rawPatch}
              truncateLines={MAX_VISIBLE_LINES}
              baseFilePath={filePath}
            />
            {rawPatchPreview.truncated && (
              <button
                type="button"
                className="diff-expand-button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsModalOpen(true);
                }}
              >
                Show full patch
              </button>
            )}
          </div>
          {isModalOpen && (
            <Modal
              title={
                <EditModalTitle filePath={filePath} displayText={fileName} />
              }
              onClose={handleClose}
            >
              <RawPatchModalContent
                rawPatch={rawPatch}
                baseFilePath={filePath}
              />
            </Modal>
          )}
        </>
      );
    }

    return (
      <div className="edit-collapsed-preview">
        <span>Patch preview unavailable</span>
      </div>
    );
  }

  const diffLines = structuredPatch.flatMap((hunk) => hunk.lines);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <>
      <div className="edit-collapsed-preview">
        {result?.userModified && (
          <span className="badge badge-info">User modified</span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
        <DiffMathView
          sourceText={diffLines.join("\n")}
          baseFilePath={filePath}
          truncated={isTruncated}
          sourceView={
            diffHtml ? (
              <HighlightedDiff
                diffHtml={diffHtml}
                truncateLines={isTruncated ? MAX_VISIBLE_LINES : undefined}
              />
            ) : (
              <DiffLines lines={diffLines} />
            )
          }
        />
        {isTruncated && (
          <button
            type="button"
            className="diff-expand-button"
            onClick={handleClick}
          >
            Show full diff
          </button>
        )}
      </div>
      {isModalOpen && (
        <Modal
          title={<EditModalTitle filePath={filePath} displayText={fileName} />}
          onClose={handleClose}
        >
          <DiffModalContent
            diffHtml={diffHtml}
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString}
            newString={newString}
            originalFile={originalFile}
          />
        </Modal>
      )}
    </>
  );
}

/**
 * Interactive summary for Edit tool - shows filename and change summary inline
 * Similar to Read tool's interactive summary
 */
function EditInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: EditInputWithAugment;
  result: EditResult | undefined;
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
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  const projectPath = useOptionalSessionMetadata()?.projectPath ?? null;
  const filePath = getEditFilePath(input, result);
  const fileName = getPatchTargetSummary(input, result);
  const fileTitle = getPatchTargetTitle(input, result, projectPath);
  const displayPaths = getPatchTargetDisplayPaths(input, result, projectPath);
  const oldString = result?.oldString ?? input.old_string;
  const newString = result?.newString ?? input.new_string;
  const originalFile = result?.originalFile;

  // Get structuredPatch - prefer result, then input augment
  const structuredPatch =
    result?.structuredPatch ?? input._structuredPatch ?? [];
  const diffHtml = input._diffHtml;
  const changeSummary = computeChangeSummary(structuredPatch);

  if (isError) {
    return (
      <span title={fileTitle}>
        {fileName}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
      </span>
    );
  }

  // Show loading state if no patch yet
  if (structuredPatch.length === 0) {
    return (
      <>
        <button
          type="button"
          className="file-link-inline"
          title={fileTitle}
          onClick={(e) => {
            e.stopPropagation();
            setShowModal(true);
          }}
        >
          {fileName}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
        </button>
        {showModal && (
          <Modal
            title={
              <EditModalTitle filePath={filePath} displayText={fileName} />
            }
            onClose={() => setShowModal(false)}
          >
            <div className="diff-modal-content">
              <div className="diff-context-controls">
                <span className="diff-context-path" title={fileTitle}>
                  {displayPaths.length > 0 ? displayPaths[0] : fileName}
                </span>
              </div>
              <div className="edit-target-paths">
                {displayPaths.length > 0 ? (
                  displayPaths.map((displayPath) => (
                    <div className="edit-target-path" key={displayPath}>
                      <FilePathDisplay displayPath={displayPath} />
                    </div>
                  ))
                ) : (
                  <div className="edit-target-path">
                    Patch target unavailable
                  </div>
                )}
              </div>
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className="file-link-inline"
        title={fileTitle}
        onClick={(e) => {
          e.stopPropagation();
          setShowModal(true);
        }}
      >
        {fileName}
        {changeSummary && (
          <span className="file-line-count-inline">{changeSummary}</span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
      </button>
      {showModal && (
        <Modal
          title={
            <EditModalTitle filePath={filePath} displayText={fileName} />
          }
          onClose={() => setShowModal(false)}
        >
          <DiffModalContent
            diffHtml={diffHtml}
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString}
            newString={newString}
            originalFile={originalFile}
          />
        </Modal>
      )}
    </>
  );
}

/**
 * Edit tool result - shows diff view with truncation and modal expand
 */
function EditToolResult({
  result,
  input,
  isError,
}: {
  result: EditResult;
  input?: EditInput;
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
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  // Count total lines in all hunks
  const totalLines = useMemo(() => {
    if (!result?.structuredPatch) return 0;
    return result.structuredPatch.reduce(
      (sum, hunk) => sum + hunk.lines.length + 1, // +1 for hunk header
      0,
    );
  }, [result?.structuredPatch]);

  const isTruncated = totalLines > MAX_VISIBLE_LINES;

  // Compute change summary
  const changeSummary = useMemo(() => {
    if (!result?.structuredPatch) return null;
    const additions = result.structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("+")).length;
    const deletions = result.structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("-")).length;

    if (additions > 0 && deletions > 0) {
      return `Modified ${additions + deletions} lines`;
    }
    if (additions > 0) {
      return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
    }
    if (deletions > 0) {
      return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
    }
    return null;
  }, [result?.structuredPatch]);

  if (isError) {
    // Extract error message - can be a string or object with content
    let errorMessage: string | null = null;
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }

    // Classify the error for appropriate styling
    const classification = errorMessage
      ? classifyToolError(errorMessage)
      : {
          classification: "unknown" as const,
          label: "Error",
          cleanedMessage: "",
        };
    const classSuffix = getErrorClassSuffix(classification.classification);
    const isRejection = isUserRejection(classification.classification);

    // For user rejections, show the proposed diff alongside the declined badge
    const inputWithAugment = input as EditInputWithAugment | undefined;
    const hasProposedDiff =
      isRejection &&
      inputWithAugment?._structuredPatch &&
      inputWithAugment._structuredPatch.length > 0;
    const proposedDiffLines = hasProposedDiff
      ? (inputWithAugment._structuredPatch?.flatMap((hunk) => hunk.lines) ?? [])
      : [];
    const proposedDiffTruncated = proposedDiffLines.length > MAX_VISIBLE_LINES;

    const filePath = getEditFilePath(inputWithAugment);
    const fileName = getFileName(filePath);

    return (
      <>
        <div className={`edit-result edit-result-${classSuffix}`}>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <span className={`badge badge-${classSuffix}`}>
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </span>
          {classification.userReason ? (
            <div className="edit-error-message">
              {classification.userReason}
            </div>
          ) : classification.cleanedMessage && !isRejection ? (
            <div className="edit-error-message">
              {classification.cleanedMessage}
            </div>
          ) : null}
          {hasProposedDiff && (
            <>
              <DiffMathView
                sourceText={proposedDiffLines.join("\n")}
                baseFilePath={filePath}
                truncated={proposedDiffTruncated}
                sourceView={
                  inputWithAugment?._diffHtml ? (
                    <HighlightedDiff
                      diffHtml={inputWithAugment._diffHtml}
                      truncateLines={
                        proposedDiffTruncated ? MAX_VISIBLE_LINES : undefined
                      }
                    />
                  ) : (
                    <DiffLines lines={proposedDiffLines} />
                  )
                }
              />
              {proposedDiffTruncated && (
                <button
                  type="button"
                  className="diff-expand-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowModal(true);
                  }}
                >
                  Show full diff
                </button>
              )}
            </>
          )}
        </div>
        {showModal && hasProposedDiff && inputWithAugment && (
          <Modal
            title={<EditModalTitle filePath={filePath} displayText={fileName} />}
            onClose={() => setShowModal(false)}
          >
            <DiffModalContent
              diffHtml={inputWithAugment._diffHtml}
              structuredPatch={inputWithAugment._structuredPatch ?? []}
              filePath={filePath}
              oldString={inputWithAugment.old_string}
              newString={inputWithAugment.new_string}
            />
          </Modal>
        )}
      </>
    );
  }

  // Handle case where result doesn't have structuredPatch
  // Use input data as fallback when result data is missing
  if (!result?.structuredPatch || result.structuredPatch.length === 0) {
    const filePath = getEditFilePath(input, result);
    const oldString = result?.oldString || input?.old_string || "";
    const newString = result?.newString || input?.new_string || "";
    const isPlan = filePath ? isPlanFile(filePath) : false;

    return (
      <div className="edit-result">
        <div className="edit-header">
          <span className="file-path">
            {filePath ? getFileName(filePath) : "File"}
          </span>
          {isPlan && <span className="badge badge-muted">Plan</span>}
          {result?.userModified && (
            <span className="badge badge-info">User modified</span>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
        </div>
        <div className="edit-simple">
          <div className="edit-old">
            <div className="edit-label">Removed:</div>
            <pre className="code-block">
              <code>{oldString || "(empty)"}</code>
            </pre>
          </div>
          <div className="edit-new">
            <div className="edit-label">Added:</div>
            <pre className="code-block">
              <code>{newString || "(empty)"}</code>
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="edit-result">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
        {changeSummary && (
          <div className="edit-change-summary">{changeSummary}</div>
        )}
        {result.userModified && (
          <span className="badge badge-info">User modified</span>
        )}
        <DiffMathView
          sourceText={result.structuredPatch
            .flatMap((hunk) => hunk.lines)
            .join("\n")}
          baseFilePath={result.filePath}
          truncated={isTruncated}
          sourceView={result.structuredPatch.map((hunk, i) => (
            <DiffHunk key={`hunk-${hunk.oldStart}-${i}`} hunk={hunk} />
          ))}
        />
        {isTruncated && (
          <button
            type="button"
            className="diff-expand-button"
            onClick={(e) => {
              e.stopPropagation();
              setShowModal(true);
            }}
          >
            Click to expand
          </button>
        )}
      </div>
      {showModal && (
        <Modal
          title={
            <EditModalTitle
              filePath={result.filePath}
              displayText={getFileName(result.filePath)}
            />
          }
          onClose={() => setShowModal(false)}
        >
          <DiffModalContent
            structuredPatch={result.structuredPatch}
            filePath={result.filePath}
            oldString={result.oldString ?? input?.old_string ?? ""}
            newString={result.newString ?? input?.new_string ?? ""}
            originalFile={result.originalFile}
          />
        </Modal>
      )}
    </>
  );
}

export const editRenderer: ToolRenderer<EditInput, EditResult> = {
  tool: "Edit",
  displayName: "Edit",

  renderToolUse(input) {
    return <EditToolUse input={input as EditInputWithAugment} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <EditToolResult
        result={result as EditResult}
        input={input as EditInput | undefined}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return getPatchTargetSummary(input);
  },

  getResultSummary(result, isError, input) {
    if (isError) {
      // Extract error message for classification
      let errorMessage: string | null = null;
      if (typeof result === "string") {
        errorMessage = result;
      } else if (typeof result === "object" && result !== null) {
        const errorResult = result as { content?: unknown };
        if (errorResult.content) {
          errorMessage = String(errorResult.content);
        }
      }
      if (errorMessage) {
        const classification = classifyToolError(errorMessage);
        return classification.label;
      }
      return "Error";
    }
    const r = result as EditResult;
    return getPatchTargetSummary(input, r);
  },

  renderCollapsedPreview(input, result, isError) {
    return (
      <EditCollapsedPreview
        input={input as EditInputWithAugment}
        result={result as EditResult | undefined}
        isError={isError}
      />
    );
  },

  renderInteractiveSummary(input, result, isError, _context) {
    return (
      <EditInteractiveSummary
        input={input as EditInputWithAugment}
        result={result as EditResult | undefined}
        isError={isError}
      />
    );
  },
};
