import {
  type CSSProperties,
  type MouseEvent,
  memo,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getDisplayBashCommandFromInput,
  isCodexLikeBashInput,
} from "../../lib/bashCommand";
import { PREDICTIVE_SCROLL_ROOT_MARGIN } from "../../lib/predictiveScroll";
import { parseShellToolOutput } from "../../lib/shellToolOutput";
import type { ToolCallItem, ToolResultData } from "../../types/renderItems";
import { toolRegistry } from "../renderers/tools";
import type { RenderContext } from "../renderers/types";
import { getToolSummary } from "../tools/summaries";
import { mayHaveFixedFontRichContent } from "../ui/FixedFontMathToggle";

interface Props {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: ToolCallItem["status"];
  sessionProvider?: string;
}

export const DEFERRED_PREVIEW_HEIGHT = {
  commandRowPx: 42,
  outputRowChromePx: 12,
  emptyOutputRowPx: 28,
  minOutputRowPx: 35,
  outputLineHeightPx: 18,
  maxOutputPx: 80,
  minPx: 32,
  maxPx: 134,
  defaultContentWidthPx: 720,
  minCharsPerLine: 24,
  maxCharsPerLine: 160,
  averageCharWidthPx: 7.5,
} as const;

type DeferredPreviewStyle = CSSProperties & {
  "--tool-row-deferred-preview-height"?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function estimatePreviewCharsPerLine(rowWidthPx?: number | null): number {
  const contentWidthPx =
    typeof rowWidthPx === "number" && rowWidthPx > 0
      ? Math.max(120, rowWidthPx - 112)
      : DEFERRED_PREVIEW_HEIGHT.defaultContentWidthPx;
  return clamp(
    Math.floor(contentWidthPx / DEFERRED_PREVIEW_HEIGHT.averageCharWidthPx),
    DEFERRED_PREVIEW_HEIGHT.minCharsPerLine,
    DEFERRED_PREVIEW_HEIGHT.maxCharsPerLine,
  );
}

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let count = 0;
  for (const line of lines) {
    count += Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  return count;
}

export function estimateDeferredPreviewHeightPx(params: {
  toolName: string;
  toolInput: unknown;
  result: unknown;
  status: ToolCallItem["status"];
  rowWidthPx?: number | null;
}): number | null {
  if (!canDeferRichToolRow(params.status) || params.toolName !== "Bash") {
    return null;
  }

  const command = getDisplayBashCommandFromInput(params.toolInput);
  const output = getBashResultOutputForRichPreview(params.result).trimEnd();
  if (!command && !output) {
    return null;
  }

  const charsPerLine = estimatePreviewCharsPerLine(params.rowWidthPx);
  const outputPx = output
    ? Math.max(
        DEFERRED_PREVIEW_HEIGHT.minOutputRowPx,
        Math.min(
          DEFERRED_PREVIEW_HEIGHT.maxOutputPx,
          estimateWrappedLineCount(output, charsPerLine) *
            DEFERRED_PREVIEW_HEIGHT.outputLineHeightPx,
        ) + DEFERRED_PREVIEW_HEIGHT.outputRowChromePx,
      )
    : params.result
      ? DEFERRED_PREVIEW_HEIGHT.emptyOutputRowPx
      : 0;

  return clamp(
    DEFERRED_PREVIEW_HEIGHT.commandRowPx + outputPx,
    DEFERRED_PREVIEW_HEIGHT.minPx,
    DEFERRED_PREVIEW_HEIGHT.maxPx,
  );
}

function canDeferRichToolRow(status: ToolCallItem["status"]): boolean {
  return status === "complete" || status === "error";
}

function findNearestScrollContainer(element: HTMLElement): HTMLElement | null {
  let scrollEl = element.parentElement;
  while (scrollEl) {
    const { overflowY } = window.getComputedStyle(scrollEl);
    if (overflowY === "auto" || overflowY === "scroll") {
      return scrollEl;
    }
    scrollEl = scrollEl.parentElement;
  }
  return null;
}

function scrollExpandedToolTopIntoView(row: HTMLElement | null) {
  if (!row) {
    return;
  }

  const scrollEl = findNearestScrollContainer(row);
  if (!scrollEl) {
    return;
  }

  const scrollRect = scrollEl.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const nextTop = Math.max(
    0,
    scrollEl.scrollTop + rowRect.top - scrollRect.top - 12,
  );
  scrollEl.scrollTop = nextTop;
  scrollEl.dispatchEvent(new Event("scroll"));
}

function queueExpandedToolTopFocus(rowRef: RefObject<HTMLDivElement | null>) {
  const focusTop = () => scrollExpandedToolTopIntoView(rowRef.current);
  focusTop();
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(focusTop);
  }
  window.setTimeout(focusTop, 80);
}

function useNearViewportHydration(status: ToolCallItem["status"]): {
  rowRef: RefObject<HTMLDivElement | null>;
  shouldHydrate: boolean;
  hydrateNow: () => void;
  rowWidthPx: number | null;
} {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [rowWidthPx, setRowWidthPx] = useState<number | null>(null);
  const [shouldHydrate, setShouldHydrate] = useState(
    () =>
      !canDeferRichToolRow(status) ||
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (!canDeferRichToolRow(status)) {
      setShouldHydrate(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setShouldHydrate(true);
      return;
    }
    setShouldHydrate(false);
  }, [status]);

  useLayoutEffect(() => {
    if (shouldHydrate || !canDeferRichToolRow(status)) {
      return;
    }
    const node = rowRef.current;
    if (!node) {
      return;
    }
    const width = Math.round(node.getBoundingClientRect().width);
    if (width > 0) {
      setRowWidthPx((current) => (current === width ? current : width));
    }
  }, [shouldHydrate, status]);

  useEffect(() => {
    if (shouldHydrate || !canDeferRichToolRow(status)) {
      return;
    }

    const node = rowRef.current;
    if (!node) {
      setShouldHydrate(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldHydrate(true);
          observer.disconnect();
        }
      },
      { root: null, rootMargin: PREDICTIVE_SCROLL_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldHydrate, status]);

  return {
    rowRef,
    shouldHydrate,
    hydrateNow: () => setShouldHydrate(true),
    rowWidthPx,
  };
}

export const ToolCallRow = memo(function ToolCallRow({
  id,
  toolName,
  toolInput,
  toolResult,
  status,
  sessionProvider,
}: Props) {
  // Create a minimal render context for tool renderers
  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: status === "pending",
      theme: "dark",
      toolUseId: id,
      provider: sessionProvider,
    }),
    [status, id, sessionProvider],
  );

  // Get structured result for interactive summary
  const structuredResult = toolResult?.structured ?? toolResult?.content;
  const {
    rowRef,
    shouldHydrate: shouldHydrateRichContent,
    hydrateNow,
    rowWidthPx,
  } = useNearViewportHydration(status);

  // Check if this tool renders inline (bypasses entire tool-row structure)
  const hasInlineRenderer = toolRegistry.hasInlineRenderer(toolName);
  const suppressCollapsedPreview = shouldSuppressBashCollapsedPreview(
    toolName,
    toolInput,
    structuredResult,
    sessionProvider,
    status,
  );
  const mayHaveCollapsedPreview =
    toolRegistry.hasCollapsedPreview(toolName) && !suppressCollapsedPreview;
  const isEditTool = toolRegistry.get(toolName).tool === "Edit";
  const canRenderInteractiveSummary =
    status === "complete" || (status === "pending" && isEditTool);
  const mayHaveInteractiveSummary =
    canRenderInteractiveSummary && toolRegistry.hasInteractiveSummary(toolName);
  const deferredPreviewHeightPx = useMemo(
    () =>
      estimateDeferredPreviewHeightPx({
        toolName,
        toolInput,
        result: structuredResult,
        status,
        rowWidthPx,
      }),
    [toolName, toolInput, structuredResult, status, rowWidthPx],
  );

  const interactiveSummaryContent = useMemo(() => {
    if (!canRenderInteractiveSummary || !shouldHydrateRichContent) {
      return null;
    }
    return toolRegistry.renderInteractiveSummary(
      toolName,
      toolInput,
      structuredResult,
      toolResult?.isError ?? false,
      renderContext,
    );
  }, [
    status,
    toolName,
    toolInput,
    structuredResult,
    toolResult,
    renderContext,
    shouldHydrateRichContent,
    canRenderInteractiveSummary,
  ]);

  const hasInteractiveSummary =
    interactiveSummaryContent !== null &&
    interactiveSummaryContent !== undefined &&
    interactiveSummaryContent !== false;

  const collapsedPreviewContent = useMemo(() => {
    if (suppressCollapsedPreview || !shouldHydrateRichContent) {
      return null;
    }
    return toolRegistry.renderCollapsedPreview(
      toolName,
      toolInput,
      structuredResult,
      toolResult?.isError ?? false,
      renderContext,
    );
  }, [
    suppressCollapsedPreview,
    toolName,
    toolInput,
    structuredResult,
    toolResult,
    renderContext,
    shouldHydrateRichContent,
  ]);

  const hasCollapsedPreview =
    collapsedPreviewContent !== null &&
    collapsedPreviewContent !== undefined &&
    collapsedPreviewContent !== false;
  const hasBashPreviewToggle = toolName === "Bash" && hasCollapsedPreview;
  const hasDeferredPreviewShell =
    !shouldHydrateRichContent &&
    mayHaveCollapsedPreview &&
    deferredPreviewHeightPx !== null;
  const hasDeferredInteractiveShell =
    !shouldHydrateRichContent &&
    (mayHaveCollapsedPreview || mayHaveInteractiveSummary);
  const [bashPreviewExpanded, setBashPreviewExpanded] = useState(true);
  const hideSummaryWhenPreviewVisible =
    hasBashPreviewToggle && bashPreviewExpanded;
  // Tools with collapsed preview or interactive summary don't expand
  const isNonExpandable =
    hasInteractiveSummary || hasCollapsedPreview || hasDeferredInteractiveShell;

  // Edit and TodoWrite tools are expanded by default
  const [expanded, setExpanded] = useState(
    !isNonExpandable && (toolName === "Edit" || toolName === "TodoWrite"),
  );

  // Dot-expanded: inline file content for Read rows (starts collapsed).
  // Not used for Edit — its interactive summary + modal is already the full view.
  const [dotExpanded, setDotExpanded] = useState(false);
  const shouldFocusExpandedTopRef = useRef(false);

  // Dot button: expandable rows + Read rows with interactive summary.
  const showDotBtn =
    !isNonExpandable ||
    (hasInteractiveSummary && toolName === "Read") ||
    hasBashPreviewToggle;

  // Header toggles dotExpanded for Read rows — same pattern as thinking blocks.
  const hasHeaderDotToggle =
    isNonExpandable &&
    hasInteractiveSummary &&
    shouldHydrateRichContent &&
    toolName === "Read";
  const hasBashHeaderToggle = hasBashPreviewToggle && shouldHydrateRichContent;

  const handleDotClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    hydrateNow();
    if (hasBashPreviewToggle) {
      setBashPreviewExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    } else if (!isNonExpandable) {
      setExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    } else if (hasInteractiveSummary && toolName === "Read" && shouldHydrateRichContent) {
      setDotExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    }
  };

  const summary = useMemo(() => {
    return getToolSummary(toolName, toolInput, toolResult, status);
  }, [toolName, toolInput, toolResult, status]);

  const handleToggle = () => {
    hydrateNow();
    if (!isNonExpandable) {
      setExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    }
  };
  const handleBashPreviewToggle = () => {
    setBashPreviewExpanded((v) => {
      if (!v) {
        shouldFocusExpandedTopRef.current = true;
      }
      return !v;
    });
  };
  const dotAriaLabel = !isNonExpandable
    ? expanded
      ? "Collapse"
      : "Expand"
    : hasBashPreviewToggle
      ? bashPreviewExpanded
        ? "Collapse preview"
        : "Expand preview"
      : dotExpanded
        ? "Collapse inline view"
        : "Expand inline view";

  useLayoutEffect(() => {
    if (
      !shouldFocusExpandedTopRef.current ||
      (!expanded && !dotExpanded && !bashPreviewExpanded)
    ) {
      return;
    }
    shouldFocusExpandedTopRef.current = false;
    queueExpandedToolTopFocus(rowRef);
  }, [bashPreviewExpanded, expanded, dotExpanded, rowRef]);

  // Inline renderers bypass the entire tool-row structure
  if (hasInlineRenderer) {
    return (
      <div className="tool-inline timeline-item">
        {toolRegistry.renderInline(
          toolName,
          toolInput,
          structuredResult,
          toolResult?.isError ?? false,
          status,
          renderContext,
        )}
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      onPointerEnter={hydrateNow}
      onFocus={hydrateNow}
      className={`tool-row timeline-item ${expanded ? "expanded" : "collapsed"} status-${status} ${isNonExpandable ? "interactive" : ""} ${shouldHydrateRichContent ? "" : "rich-deferred"}`}
    >
      {showDotBtn && (
        <button
          type="button"
          className="timeline-dot-btn"
          onClick={handleDotClick}
          aria-label={dotAriaLabel}
        />
      )}
      <div
        className={`tool-row-header ${isNonExpandable ? "non-expandable" : ""}`}
        onClick={
          hasDeferredInteractiveShell
            ? hydrateNow
            : hasBashHeaderToggle
              ? handleBashPreviewToggle
              : hasHeaderDotToggle
                ? () =>
                    setDotExpanded((v) => {
                      if (!v) {
                        shouldFocusExpandedTopRef.current = true;
                      }
                      return !v;
                    })
                : isNonExpandable
                  ? undefined
                  : handleToggle
        }
        onKeyDown={
          hasDeferredInteractiveShell
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  hydrateNow();
                }
              }
            : hasBashHeaderToggle
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleBashPreviewToggle();
                  }
                }
            : hasHeaderDotToggle
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDotExpanded((v) => {
                      if (!v) {
                        shouldFocusExpandedTopRef.current = true;
                      }
                      return !v;
                    });
                  }
                }
                : isNonExpandable
                  ? undefined
                  : (e) => e.key === "Enter" && handleToggle()
        }
        role={
          hasDeferredInteractiveShell ||
          hasBashHeaderToggle ||
          hasHeaderDotToggle ||
          !isNonExpandable
            ? "button"
            : "presentation"
        }
        tabIndex={
          hasDeferredInteractiveShell ||
          hasBashHeaderToggle ||
          hasHeaderDotToggle ||
          !isNonExpandable
            ? 0
            : undefined
        }
      >
        {status === "pending" && (
          <span className="tool-spinner" aria-label="Running">
            <Spinner />
          </span>
        )}
        {status === "aborted" && (
          <span className="tool-aborted-icon" aria-label="Interrupted">
            ⨯
          </span>
        )}
        {status === "incomplete" && (
          <span className="tool-incomplete-icon" aria-label="Result unavailable">
            ?
          </span>
        )}

        <span className="tool-name">
          {toolRegistry.getDisplayName(toolName)}
        </span>

        {hasInteractiveSummary && canRenderInteractiveSummary ? (
          <span className="tool-summary interactive-summary">
            {interactiveSummaryContent}
          </span>
        ) : !hideSummaryWhenPreviewVisible ? (
          <span className="tool-summary">
            {summary}
            {status === "aborted" && (
              <span className="tool-aborted-label"> (interrupted)</span>
            )}
            {status === "incomplete" && (
              <span className="tool-incomplete-label">
                {" "}
                (result unavailable)
              </span>
            )}
          </span>
        ) : null}

        {!isNonExpandable && (
          <span className="expand-chevron" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        )}
        {hasHeaderDotToggle && (
          <span className="expand-chevron" aria-hidden="true">
            {dotExpanded ? "▾" : "▸"}
          </span>
        )}
      </div>

      {/* Collapsed preview - shown when tool supports it (non-expandable) */}
      {hasCollapsedPreview && bashPreviewExpanded && (
        <div className="tool-row-collapsed-preview">
          {hasBashPreviewToggle && (
            <ToolRowCollapseStrip
              onCollapse={() => setBashPreviewExpanded(false)}
              ariaLabel="Collapse preview from left gutter"
            />
          )}
          {collapsedPreviewContent}
        </div>
      )}
      {hasDeferredPreviewShell && (
        <div
          className="tool-row-collapsed-preview tool-row-deferred-preview"
          style={
            {
              "--tool-row-deferred-preview-height": `${deferredPreviewHeightPx}px`,
            } as DeferredPreviewStyle
          }
          aria-hidden="true"
        >
          <div className="tool-row-deferred-preview-box" />
        </div>
      )}

      {dotExpanded && isNonExpandable && hasInteractiveSummary && toolName === "Read" && (
        <div className="tool-row-content">
          <ToolRowCollapseStrip onCollapse={() => setDotExpanded(false)} />
          <ToolResultExpanded
            toolName={toolName}
            toolInput={toolInput}
            toolResult={toolResult}
            context={renderContext}
          />
        </div>
      )}

      {expanded && !isNonExpandable && (
        <div className="tool-row-content">
          <ToolRowCollapseStrip onCollapse={() => setExpanded(false)} />
          {status === "pending" ||
          status === "aborted" ||
          status === "incomplete" ? (
            <ToolUseExpanded
              toolName={toolName}
              toolInput={toolInput}
              context={renderContext}
            />
          ) : (
            <ToolResultExpanded
              toolName={toolName}
              toolInput={toolInput}
              toolResult={toolResult}
              context={renderContext}
            />
          )}
        </div>
      )}
    </div>
  );
});

function ToolRowCollapseStrip({
  onCollapse,
  ariaLabel = "Collapse expanded tool row",
}: {
  onCollapse: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className="tool-row-collapse-strip"
      onClick={(event) => {
        event.stopPropagation();
        onCollapse();
      }}
      aria-label={ariaLabel}
      title={ariaLabel}
    />
  );
}

function shouldSuppressBashCollapsedPreview(
  toolName: string,
  toolInput: unknown,
  result: unknown,
  sessionProvider?: string,
  status?: ToolCallItem["status"],
): boolean {
  if (toolName !== "Bash") {
    return false;
  }

  if (!isCodexLikeBashInput(toolInput, sessionProvider)) {
    return false;
  }

  // Keep Codex bash rows compact by default (header + expandable details) for
  // ordinary commands, but surface markdown-like output so the render toggle is
  // reachable from the row instead of requiring an expansion first.
  if (status === "pending") {
    return true;
  }
  if (
    status === "complete" ||
    status === "error" ||
    status === "aborted" ||
    status === "incomplete"
  ) {
    const output = getBashResultOutputForRichPreview(result);
    return !output || !mayHaveFixedFontRichContent(output);
  }

  const command = getDisplayBashCommandFromInput(toolInput);
  if (!command) {
    return false;
  }

  return /^(rg|grep|sed|nl|cat)\b/.test(command.trimStart());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getBashResultOutputForRichPreview(result: unknown): string {
  if (typeof result === "string") {
    const parsed = parseShellToolOutput(result);
    return parsed.hasEnvelope ? parsed.output : result;
  }

  if (!isRecord(result)) {
    return "";
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stdout || stderr) {
    return [stdout, stderr].filter(Boolean).join("\n");
  }

  if (typeof result.content === "string") {
    const parsed = parseShellToolOutput(result.content);
    return parsed.hasEnvelope ? parsed.output : result.content;
  }

  return "";
}

function ToolUseExpanded({
  toolName,
  toolInput,
  context,
}: {
  toolName: string;
  toolInput: unknown;
  context: RenderContext;
}) {
  return (
    <div className="tool-use-expanded">
      {toolRegistry.renderToolUse(toolName, toolInput, context)}
    </div>
  );
}

function ToolResultExpanded({
  toolName,
  toolInput,
  toolResult,
  context,
}: {
  toolName: string;
  toolInput: unknown;
  toolResult: ToolResultData | undefined;
  context: RenderContext;
}) {
  if (!toolResult) {
    return <div className="tool-no-result">No result data</div>;
  }

  // Use structured result if available, otherwise fall back to content
  const result = toolResult.structured ?? toolResult.content;

  return (
    <div className="tool-result-expanded">
      {toolRegistry.renderToolResult(
        toolName,
        result,
        toolResult.isError,
        context,
        toolInput,
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="spinner"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="24"
        strokeDashoffset="8"
      />
    </svg>
  );
}
