import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useOutputToolPreviewLineCount } from "../../../hooks/useOutputAppearance";
import {
  getDisplayBashCommandFromInput,
  isCodexProvider,
} from "../../../lib/bashCommand";
import { parseShellToolOutput } from "../../../lib/shellToolOutput";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { AnsiText } from "../../ui/AnsiText";
import {
  FixedFontMathToggle,
  type RenderedMathResult,
  renderFixedFontRichContent,
} from "../../ui/FixedFontMathToggle";
import { Modal } from "../../ui/Modal";
import type { BashInput, BashResult, ToolRenderer } from "./types";

const MAX_LINES_COLLAPSED = 20;
const MAX_LINES_TOOL_USE = 12;
const PREVIEW_MAX_CHARS_PER_LINE = 110;
const RICH_PREVIEW_LINES = 20;
const RICH_PREVIEW_MAX_CHARS = 4000;
const NO_FIXED_FONT_RICH_CONTENT: RenderedMathResult = {
  html: "",
  changed: false,
};

const CODEX_NOISE_PATTERNS = [
  /^npm warn (?:unknown env config|config)\s+["']recursive["']/i,
  /^this will stop working in the next major version of npm\.?$/i,
];

/**
 * Normalize bash result - handles both structured objects and plain strings
 * SDK may return a plain string for errors instead of { stdout, stderr }
 */
function normalizeBashResult(
  result: BashResult | string | undefined,
  isError: boolean,
): BashResult {
  if (!result) {
    return { stdout: "", stderr: "", interrupted: false, isImage: false };
  }
  if (typeof result === "string") {
    const parsed = parseShellToolOutput(result);
    const output = parsed.hasEnvelope ? parsed.output : result;
    // Plain string result - put in stderr if error, stdout otherwise
    return {
      stdout: isError ? "" : output,
      stderr: isError ? output : "",
      interrupted: false,
      isImage: false,
    };
  }
  return result;
}

function getBashCommand(input: BashInput): string {
  return getDisplayBashCommandFromInput(input);
}

function sanitizeOutputForPreview(output: string, provider?: string): string {
  const normalized = output.replace(/\r\n/g, "\n");
  if (!isCodexProvider(provider)) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }
    return !CODEX_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  });

  if (filtered.length === 0) {
    return normalized;
  }

  return filtered.join("\n");
}

function getPreviewLimits(lineCount: number): {
  maxLines: number;
  maxChars: number;
} {
  const normalizedLineCount = Math.max(1, Math.round(lineCount));
  return {
    maxLines: normalizedLineCount,
    maxChars: normalizedLineCount * PREVIEW_MAX_CHARS_PER_LINE,
  };
}

function renderFixedFontMathPanel(html: string, className = "code-block") {
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

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 10.5H2.5A1.5 1.5 0 0 1 1 9V2.5A1.5 1.5 0 0 1 2.5 1H9a1.5 1.5 0 0 1 1.5 1.5V3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5 6.5 12 13 4" />
    </svg>
  );
}

function BashCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 3000);
      } catch (error) {
        console.error("Failed to copy bash section:", error);
      }
    },
    [text],
  );

  return (
    <button
      type="button"
      className={`bash-section-copy ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      disabled={!text}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function BashSectionHeader({
  label,
  copyText,
  copyLabel,
}: {
  label: ReactNode;
  copyText: string;
  copyLabel: string;
}) {
  return (
    <div className="bash-section-header">
      <div className="bash-modal-label">{label}</div>
      <BashCopyButton text={copyText} label={copyLabel} />
    </div>
  );
}

/**
 * Modal content for viewing full bash input and output
 */
function BashModalContent({
  input,
  result: rawResult,
  isError,
}: {
  input: BashInput;
  result: BashResult | string | undefined;
  isError: boolean;
}) {
  // Normalize result to handle both structured and string formats
  const result = rawResult
    ? normalizeBashResult(rawResult, isError)
    : undefined;
  const command = getBashCommand(input);
  const stdout = result?.stdout || "";
  const stderr = result?.stderr || "";

  return (
    <div className="bash-modal-sections">
      <div className="bash-modal-section">
        <BashSectionHeader
          label="Command"
          copyText={command}
          copyLabel="Copy command"
        />
        <div className="bash-modal-code">
          <pre className="code-block">
            <code>{command}</code>
          </pre>
        </div>
      </div>
      {stdout && (
        <div className="bash-modal-section">
          <BashSectionHeader
            label="Output"
            copyText={stdout}
            copyLabel="Copy output"
          />
          <div className="bash-modal-code">
            <FixedFontMathToggle
              sourceText={stdout}
              sourceView={
                <pre className="code-block">
                  <AnsiText text={stdout} />
                </pre>
              }
              renderRenderedView={(html) => renderFixedFontMathPanel(html)}
            />
          </div>
        </div>
      )}
      {stderr && (
        <div className="bash-modal-section">
          <BashSectionHeader
            label={
              <span className="bash-modal-label-error">
                {isError ? "Error" : "Stderr"}
              </span>
            }
            copyText={stderr}
            copyLabel={isError ? "Copy error output" : "Copy stderr"}
          />
          <div className="bash-modal-code bash-modal-code-error">
            <FixedFontMathToggle
              sourceText={stderr}
              sourceView={
                <pre className="code-block code-block-error">
                  <AnsiText text={stderr} />
                </pre>
              }
              renderRenderedView={(html) =>
                renderFixedFontMathPanel(html, "code-block code-block-error")
              }
            />
          </div>
        </div>
      )}
      {!stdout && !stderr && result && !result.interrupted && (
        <div className="bash-modal-section">
          <div className="bash-modal-label">Output</div>
          <div className="bash-modal-empty">No output</div>
        </div>
      )}
      {result?.interrupted && (
        <div className="bash-modal-section">
          <span className="badge badge-warning">Interrupted</span>
        </div>
      )}
      {result?.backgroundTaskId && (
        <div className="bash-modal-section">
          <span className="badge badge-info">
            Background: {result.backgroundTaskId}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Bash tool use - shows command in code block with collapse for long commands
 */
function BashToolUse({ input }: { input: BashInput }) {
  const command = getBashCommand(input);
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = command.split("\n");
  const needsCollapse = lines.length > MAX_LINES_TOOL_USE;
  const displayCommand =
    needsCollapse && !isExpanded
      ? `${lines.slice(0, MAX_LINES_TOOL_USE).join("\n")}\n...`
      : command;

  return (
    <div className="bash-tool-use">
      <div className="bash-inline-section-header">
        <span className="bash-inline-section-label">Command</span>
        <BashCopyButton text={command} label="Copy command" />
      </div>
      <pre className="code-block">
        <code>{displayCommand}</code>
      </pre>
      {needsCollapse && (
        <button
          type="button"
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/**
 * Bash tool result - shows stdout/stderr with collapse for long output
 */
function BashToolResult({
  result: rawResult,
  isError,
  input,
}: {
  result: BashResult | string;
  isError: boolean;
  input?: BashInput;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  // Normalize result to handle both structured and string formats
  const result = normalizeBashResult(rawResult, isError);

  useEffect(() => {
    if (enabled && rawResult && typeof rawResult === "object") {
      const validation = validateToolResult("Bash", rawResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Bash", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, rawResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Bash");

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const command = input ? getBashCommand(input) : "";
  const sessionMetadata = useOptionalSessionMetadata();
  const stdoutLines = stdout.split("\n");
  const richStdout = useMemo(
    () =>
      renderFixedFontRichContent(stdout, {
        projectId: sessionMetadata?.projectId,
      }),
    [stdout, sessionMetadata?.projectId],
  );
  const richStderr = useMemo(
    () =>
      renderFixedFontRichContent(stderr, {
        projectId: sessionMetadata?.projectId,
      }),
    [stderr, sessionMetadata?.projectId],
  );
  const needsCollapse = stdoutLines.length > MAX_LINES_COLLAPSED;
  const displayStdout =
    needsCollapse && !isExpanded
      ? `${stdoutLines.slice(0, MAX_LINES_COLLAPSED).join("\n")}\n...`
      : stdout;
  const stdoutRenderText = richStdout.changed ? stdout : displayStdout;

  return (
    <div className={`bash-result ${isError ? "bash-result-error" : ""}`}>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Bash" errors={validationErrors} />
      )}
      {command && (
        <div className="bash-expanded-section bash-expanded-command-section">
          <div className="bash-inline-section-header">
            <span className="bash-inline-section-label">Command</span>
            <BashCopyButton text={command} label="Copy command" />
          </div>
          <pre className="code-block">
            <code>{command}</code>
          </pre>
        </div>
      )}
      {result?.interrupted && (
        <span className="badge badge-warning">Interrupted</span>
      )}
      {result?.backgroundTaskId && (
        <span className="badge badge-info">
          Background: {result.backgroundTaskId}
        </span>
      )}
      {stdout && (
        <div className="bash-stdout bash-expanded-section">
          <div className="bash-inline-section-header">
            <span className="bash-inline-section-label">Output</span>
            <BashCopyButton text={stdout} label="Copy output" />
          </div>
          <FixedFontMathToggle
            sourceText={stdoutRenderText}
            precomputedRendered={
              stdoutRenderText === stdout
                ? richStdout
                : NO_FIXED_FONT_RICH_CONTENT
            }
            sourceView={
              <pre className="code-block">
                <AnsiText text={displayStdout} />
              </pre>
            }
            renderRenderedView={(html) => renderFixedFontMathPanel(html)}
          />
          {needsCollapse && (
            <button
              type="button"
              className="expand-button"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded
                ? "Show less"
                : `Show all ${stdoutLines.length} lines`}
            </button>
          )}
        </div>
      )}
      {stderr && (
        <div className="bash-stderr bash-expanded-section">
          <div className="bash-inline-section-header">
            <span className="bash-inline-section-label">
              {isError ? "Error" : "Stderr"}
            </span>
            <BashCopyButton
              text={stderr}
              label={isError ? "Copy error output" : "Copy stderr"}
            />
          </div>
          <FixedFontMathToggle
            sourceText={stderr}
            precomputedRendered={richStderr}
            sourceView={
              <pre className="code-block code-block-error">
                <AnsiText text={stderr} />
              </pre>
            }
            renderRenderedView={(html) =>
              renderFixedFontMathPanel(html, "code-block code-block-error")
            }
          />
        </div>
      )}
      {!stdout && !stderr && !result?.interrupted && (
        <div className="bash-empty">No output</div>
      )}
    </div>
  );
}

/**
 * Truncate text to a maximum number of lines and characters
 */
function truncateOutput(
  text: string,
  limits: { maxLines: number; maxChars: number },
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let result = "";
  let charCount = 0;
  let lineCount = 0;

  for (const line of lines) {
    if (lineCount >= limits.maxLines || charCount >= limits.maxChars) {
      return { text: result.trimEnd(), truncated: true };
    }
    const remaining = limits.maxChars - charCount;
    if (line.length > remaining) {
      result += `${line.slice(0, remaining)}...`;
      return { text: result.trimEnd(), truncated: true };
    }
    result += `${line}\n`;
    charCount += line.length + 1;
    lineCount++;
  }

  return { text: result.trimEnd(), truncated: false };
}

/**
 * Collapsed preview showing command output; the command itself lives in the
 * shared "Ran ..." row header.
 */
function BashCollapsedPreview({
  input,
  result: rawResult,
  isError,
  provider,
}: {
  input: BashInput;
  result: BashResult | string | undefined;
  isError: boolean;
  provider?: string;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const outputToolPreviewLineCount = useOutputToolPreviewLineCount();
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  // Normalize result to handle both structured and string formats
  const result = rawResult
    ? normalizeBashResult(rawResult, isError)
    : undefined;

  useEffect(() => {
    if (enabled && rawResult && typeof rawResult === "object") {
      const validation = validateToolResult("Bash", rawResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Bash", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, rawResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Bash");
  const sessionMetadata = useOptionalSessionMetadata();
  const output = sanitizeOutputForPreview(
    result?.stdout || result?.stderr || "",
    provider,
  );
  const fullRichPreview = useMemo(
    () =>
      renderFixedFontRichContent(output, {
        projectId: sessionMetadata?.projectId,
      }),
    [output, sessionMetadata?.projectId],
  );
  const { text: previewText, truncated } = truncateOutput(
    output,
    fullRichPreview.changed
      ? { maxLines: RICH_PREVIEW_LINES, maxChars: RICH_PREVIEW_MAX_CHARS }
      : getPreviewLimits(outputToolPreviewLineCount),
  );
  const previewRichContent = useMemo(() => {
    if (previewText === output) {
      return fullRichPreview;
    }
    if (!fullRichPreview.changed) {
      return NO_FIXED_FONT_RICH_CONTENT;
    }
    return renderFixedFontRichContent(previewText, {
      projectId: sessionMetadata?.projectId,
    });
  }, [previewText, output, fullRichPreview, sessionMetadata?.projectId]);
  const hasOutput = previewText.length > 0;

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (target?.closest?.("button,a")) {
      return;
    }
    setIsModalOpen(true);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setIsModalOpen(true);
      }
    },
    [],
  );

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label="View bash command output"
        className="bash-collapsed-preview"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {showValidationWarning && validationErrors && (
          <div className="bash-preview-row bash-preview-warning-row">
            <SchemaWarning toolName="Bash" errors={validationErrors} />
          </div>
        )}
        {hasOutput && (
          <div className="bash-preview-row bash-preview-output-row">
            <div
              className={`bash-preview-output ${truncated ? "bash-preview-truncated" : ""} ${isError || result?.stderr ? "bash-preview-error" : ""}`}
            >
              <FixedFontMathToggle
                sourceText={previewText}
                precomputedRendered={previewRichContent}
                sourceView={
                  <pre>
                    <AnsiText text={previewText} />
                  </pre>
                }
                renderRenderedView={(html) => (
                  <pre>
                    <div
                      className="fixed-font-rendered__content"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted HTML from local rendering
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  </pre>
                )}
              />
              {truncated && <div className="bash-preview-fade" />}
            </div>
            <BashCopyButton
              text={output}
              label={result?.stderr ? "Copy stderr" : "Copy output"}
            />
          </div>
        )}
        {!hasOutput && result && !result.interrupted && (
          <div className="bash-preview-row">
            <span className="bash-preview-empty">No output</span>
          </div>
        )}
        {result?.interrupted && (
          <div className="bash-preview-row">
            <span className="bash-preview-interrupted">Interrupted</span>
          </div>
        )}
      </div>
      {isModalOpen && (
        <Modal
          title={input.description || "Bash Command"}
          onClose={handleClose}
        >
          <BashModalContent input={input} result={result} isError={isError} />
        </Modal>
      )}
    </>
  );
}

export const bashRenderer: ToolRenderer<BashInput, BashResult> = {
  tool: "Bash",
  displayName: "Ran",
  pendingDisplayName: "Running",

  renderToolUse(input, _context) {
    return <BashToolUse input={input as BashInput} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <BashToolResult
        result={result as BashResult}
        isError={isError}
        input={input as BashInput | undefined}
      />
    );
  },

  getUseSummary(input) {
    const i = input as BashInput;
    const command = getBashCommand(i);
    // Show description if available, otherwise truncated command.
    // Row-level truncation is handled by CSS (.tool-summary text-overflow),
    // but we also truncate here to avoid massive strings in the approval panel.
    if (i.description) {
      return i.description;
    }
    if (!command) {
      return "Bash command";
    }
    // Truncate long commands (e.g., heredocs) - first line only, max 200 chars
    const firstLine = command.split("\n")[0] ?? command;
    if (firstLine.length > 200) {
      return `${firstLine.slice(0, 200)}...`;
    }
    if (command.includes("\n")) {
      return `${firstLine}...`;
    }
    return command;
  },

  getResultSummary(result, isError) {
    const r = result as BashResult;
    if (r?.interrupted) return "Interrupted";
    if (isError || r?.stderr) return "Error";
    // Return empty string - the preview shows the output
    return "";
  },

  renderCollapsedPreview(input, result, isError, context) {
    return (
      <BashCollapsedPreview
        input={input as BashInput}
        result={result as BashResult | undefined}
        isError={isError}
        provider={context.provider}
      />
    );
  },
};
