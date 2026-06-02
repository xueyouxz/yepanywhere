import { type ReactNode, useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
import type { GrepInput, GrepMatch, GrepResult, ToolRenderer } from "./types";

const MAX_FILES_COLLAPSED = 20;
const MAX_LINES_COLLAPSED = 30;

function countGrepMatches(content: string | undefined): number {
  if (!content) {
    return 0;
  }
  return content.split("\n").filter((line) => /(^|:)\d+:/.test(line)).length;
}

const MAX_GREP_MATCH_ROWS = 100;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHighlightRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) {
    return null;
  }
  try {
    const regex = new RegExp(pattern, "g");
    return regex.source === "(?:)" ? null : regex;
  } catch {
    const escaped = escapeRegExp(pattern);
    return escaped ? new RegExp(escaped, "gi") : null;
  }
}

function renderHighlightedRanges(text: string, ranges: GrepMatch["ranges"]) {
  if (!ranges || ranges.length === 0) {
    return null;
  }
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const [key, range] of ranges.entries()) {
    const start = Math.max(0, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    if (end > start) {
      nodes.push(
        <mark className="grep-match-highlight" key={`match-${key}`}>
          {text.slice(start, end)}
        </mark>,
      );
    }
    lastIndex = end;
    if (key >= 50) {
      break;
    }
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : null;
}

function renderHighlightedText(
  text: string,
  ranges: GrepMatch["ranges"],
  pattern: string | undefined,
) {
  const rangeNodes = renderHighlightedRanges(text, ranges);
  if (rangeNodes) {
    return rangeNodes;
  }
  const regex = getHighlightRegex(pattern);
  if (!regex) {
    return text;
  }

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(regex)) {
    const matchText = match[0];
    const index = match.index ?? 0;
    if (!matchText) {
      break;
    }
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }
    nodes.push(
      <mark className="grep-match-highlight" key={`match-${key}`}>
        {matchText}
      </mark>,
    );
    key += 1;
    lastIndex = index + matchText.length;
    if (key >= 50) {
      break;
    }
  }
  if (nodes.length === 0) {
    return text;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function GrepMatchDrilldown({
  label,
  matches,
  pattern,
}: {
  label: string;
  matches: GrepMatch[];
  pattern?: string;
}) {
  const [showModal, setShowModal] = useState(false);
  const displayMatches = matches.slice(0, MAX_GREP_MATCH_ROWS);

  if (matches.length === 0) {
    return <span className="grep-count">{label}</span>;
  }

  return (
    <>
      <button
        type="button"
        className="grep-match-count-button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setShowModal(true);
        }}
      >
        {label}
      </button>
      {showModal && (
        <Modal title={label} onClose={() => setShowModal(false)}>
          <div className="grep-match-modal">
            <table className="grep-match-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Line</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                {displayMatches.map((match, index) => (
                  <tr
                    key={`${match.filePath}:${match.lineNumber}:${match.columnNumber ?? ""}:${index}`}
                  >
                    <td className="grep-match-file">{match.filePath}</td>
                    <td className="grep-match-line">
                      {match.columnNumber
                        ? `${match.lineNumber}:${match.columnNumber}`
                        : match.lineNumber}
                    </td>
                    <td className="grep-match-text">
                      {renderHighlightedText(match.text, match.ranges, pattern)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {matches.length > displayMatches.length && (
              <div className="grep-match-truncated">
                Showing first {displayMatches.length} of {matches.length}{" "}
                matches
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Grep tool use - shows search pattern
 */
function GrepToolUse({ input }: { input: GrepInput }) {
  return (
    <div className="grep-tool-use">
      <span className="grep-pattern">{input.pattern}</span>
      {input.glob && <span className="grep-glob">({input.glob})</span>}
      {input.path && <span className="grep-path">in {input.path}</span>}
    </div>
  );
}

/**
 * File list view (for files_with_matches mode)
 */
function FileListView({
  filenames,
  isExpanded,
  setIsExpanded,
}: {
  filenames: string[];
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
}) {
  const needsCollapse = filenames.length > MAX_FILES_COLLAPSED;
  const displayFiles =
    needsCollapse && !isExpanded
      ? filenames.slice(0, MAX_FILES_COLLAPSED)
      : filenames;

  return (
    <>
      <div className="file-list">
        {displayFiles.map((file) => (
          <div key={file} className="file-list-item">
            <span className="file-path">{getFileName(file)}</span>
            <span className="file-dir">{file}</span>
          </div>
        ))}
        {needsCollapse && !isExpanded && (
          <div className="file-list-more">
            ... and {filenames.length - MAX_FILES_COLLAPSED} more
          </div>
        )}
      </div>
      {needsCollapse && (
        <button
          type="button"
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${filenames.length} files`}
        </button>
      )}
    </>
  );
}

/**
 * Content view (for content mode)
 */
function ContentView({
  content,
  isExpanded,
  setIsExpanded,
}: {
  content: string;
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
}) {
  const lines = content.split("\n");
  const needsCollapse = lines.length > MAX_LINES_COLLAPSED;
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_LINES_COLLAPSED) : lines;

  return (
    <>
      <pre className="grep-content code-block">
        <code>{displayLines.join("\n")}</code>
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
    </>
  );
}

/**
 * Grep tool result - shows search results based on mode
 */
function GrepToolResult({
  input,
  result,
  isError,
}: {
  input?: GrepInput;
  result: GrepResult;
  isError: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Grep", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Grep", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Grep");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="grep-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Search failed"}
      </div>
    );
  }

  if (!result) {
    return <div className="grep-empty">No results</div>;
  }

  const { mode, filenames, numFiles, content, appliedLimit } = result;

  // Count mode - just show summary
  if (mode === "count") {
    return (
      <div className="grep-result">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
        <div className="grep-count-summary">
          {numFiles} {numFiles === 1 ? "file" : "files"} matched
        </div>
      </div>
    );
  }

  // Content mode - show search results
  if (mode === "content" && content) {
    const matches = result.matches ?? [];
    const matchCount = matches.length || countGrepMatches(content);
    const matchLabel = `${matchCount} ${matchCount === 1 ? "match" : "matches"}`;

    return (
      <div className="grep-result">
        <div className="grep-header">
          <GrepMatchDrilldown
            label={matchLabel}
            matches={matches}
            pattern={input?.pattern}
          />
          {appliedLimit && (
            <span className="badge badge-info">limit: {appliedLimit}</span>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Grep" errors={validationErrors} />
          )}
        </div>
        <ContentView
          content={content}
          isExpanded={isExpanded}
          setIsExpanded={setIsExpanded}
        />
      </div>
    );
  }

  // files_with_matches mode (default) - show file list
  if (!filenames || filenames.length === 0) {
    return (
      <div className="grep-empty">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
        No matches found
      </div>
    );
  }

  return (
    <div className="grep-result">
      <div className="grep-header">
        <span className="grep-count">{numFiles} files</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
      </div>
      <FileListView
        filenames={filenames}
        isExpanded={isExpanded}
        setIsExpanded={setIsExpanded}
      />
    </div>
  );
}

function getGrepUseSummary(input: GrepInput): string {
  const parts = [input.pattern];
  const scope = input.path || input.glob;
  if (scope) {
    parts.push(`in ${scope}`);
  }
  return parts.filter(Boolean).join(" ");
}

function getGrepResultLabel(result: GrepResult): {
  matches: GrepMatch[];
  text: string;
} {
  if (result.mode === "content") {
    const matches = result.matches ?? [];
    const matchCount = matches.length || countGrepMatches(result.content);
    return {
      matches,
      text: `${matchCount} ${matchCount === 1 ? "match" : "matches"}`,
    };
  }

  if (result.numFiles === 0) {
    return { matches: [], text: "0 matches" };
  }

  return {
    matches: [],
    text:
      result.numFiles !== undefined
        ? `${result.numFiles} ${result.numFiles === 1 ? "file" : "files"}`
        : "Results",
  };
}

function GrepInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: GrepInput;
  result: GrepResult | undefined;
  isError: boolean;
}) {
  if (isError || !result) {
    return null;
  }
  const resultLabel = getGrepResultLabel(result);
  return (
    <span className="grep-inline-summary">
      <span>{getGrepUseSummary(input)}</span>
      <span aria-hidden="true"> → </span>
      <GrepMatchDrilldown
        label={resultLabel.text}
        matches={resultLabel.matches}
        pattern={input.pattern}
      />
    </span>
  );
}

export const grepRenderer: ToolRenderer<GrepInput, GrepResult> = {
  tool: "Grep",
  displayName: "Grep",

  renderToolUse(input, _context) {
    return <GrepToolUse input={input as GrepInput} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <GrepToolResult
        input={input as GrepInput | undefined}
        result={result as GrepResult}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return getGrepUseSummary(input as GrepInput);
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as GrepResult;
    if (!r) return "Results";
    return getGrepResultLabel(r).text;
  },

  renderInteractiveSummary(input, result, isError) {
    return (
      <GrepInteractiveSummary
        input={input as GrepInput}
        result={result as GrepResult | undefined}
        isError={isError}
      />
    );
  },
};
