import {
  type CSSProperties,
  type MouseEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  OUTPUT_APPEARANCE_CHANGE_EVENT,
  useOutputToolPreviewLineCount,
} from "../../hooks/useOutputAppearance";
import { useStableToolPreviewRendering } from "../../hooks/useStableToolPreviewRendering";
import { getDisplayBashCommandFromInput } from "../../lib/bashCommand";
import { PREDICTIVE_SCROLL_ROOT_MARGIN } from "../../lib/predictiveScroll";
import { parseShellToolOutput } from "../../lib/shellToolOutput";
import type { ToolCallItem, ToolResultData } from "../../types/renderItems";
import { toolRegistry } from "../renderers/tools";
import type { RenderContext } from "../renderers/types";
import { getToolSummary } from "../tools/summaries";

interface Props {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: ToolCallItem["status"];
  sessionProvider?: string;
}

export const DEFERRED_PREVIEW_HEIGHT = {
  outputRowChromePx: 12,
  previewBorderPx: 2,
  emptyOutputRowPx: 28,
  minOutputRowPx: 35,
  outputLineHeightPx: 18,
  maxOutputPx: 80,
  minPx: 28,
  maxPx: 94,
  defaultContentWidthPx: 720,
  minCharsPerLine: 24,
  maxCharsPerLine: 160,
  averageCharWidthPx: 7.5,
} as const;

interface DeferredPreviewTypographyMetrics {
  averageCharWidthPx: number;
  outputLineHeightPx: number;
  outputRowChromePx: number;
}

const DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY: DeferredPreviewTypographyMetrics = {
  averageCharWidthPx: DEFERRED_PREVIEW_HEIGHT.averageCharWidthPx,
  outputLineHeightPx: DEFERRED_PREVIEW_HEIGHT.outputLineHeightPx,
  outputRowChromePx: DEFERRED_PREVIEW_HEIGHT.outputRowChromePx,
};

type DeferredPreviewStyle = CSSProperties & {
  "--tool-row-deferred-preview-height"?: string;
};

interface CommandPreview {
  text: string;
  hiddenLabel: string | null;
}

const COMMAND_PREVIEW_MAX_CHARS_PER_LINE = 220;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTypographyMetrics(
  metrics?: Partial<DeferredPreviewTypographyMetrics>,
): DeferredPreviewTypographyMetrics {
  return {
    averageCharWidthPx: clamp(
      metrics?.averageCharWidthPx ??
        DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.averageCharWidthPx,
      4,
      18,
    ),
    outputLineHeightPx: clamp(
      metrics?.outputLineHeightPx ??
        DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.outputLineHeightPx,
      12,
      42,
    ),
    outputRowChromePx: clamp(
      metrics?.outputRowChromePx ??
        DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.outputRowChromePx,
      4,
      32,
    ),
  };
}

function estimatePreviewCharsPerLine(
  rowWidthPx?: number | null,
  typography?: DeferredPreviewTypographyMetrics,
): number {
  const contentWidthPx =
    typeof rowWidthPx === "number" && rowWidthPx > 0
      ? Math.max(120, rowWidthPx - 112)
      : DEFERRED_PREVIEW_HEIGHT.defaultContentWidthPx;
  const metrics = normalizeTypographyMetrics(typography);
  return clamp(
    Math.floor(contentWidthPx / metrics.averageCharWidthPx),
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

function formatHiddenCommandLabel({
  hiddenChars,
  hiddenLines,
}: {
  hiddenChars: number;
  hiddenLines: number;
}): string | null {
  const parts: string[] = [];
  if (hiddenLines > 0) {
    parts.push(`+${hiddenLines} ${hiddenLines === 1 ? "line" : "lines"}`);
  }
  if (hiddenChars > 0) {
    parts.push(`+${hiddenChars} ${hiddenChars === 1 ? "char" : "chars"}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function getCommandPreview(
  command: string,
  visibleLineCount: number,
): CommandPreview {
  const maxLines = clamp(Math.round(visibleLineCount), 1, 8);
  const lines = command.replace(/\r\n/g, "\n").split("\n");
  const visibleLines = lines.slice(0, maxLines);
  let hiddenChars = 0;
  const text = visibleLines
    .map((line) => {
      if (line.length <= COMMAND_PREVIEW_MAX_CHARS_PER_LINE) {
        return line;
      }
      hiddenChars += line.length - COMMAND_PREVIEW_MAX_CHARS_PER_LINE;
      return `${line.slice(0, COMMAND_PREVIEW_MAX_CHARS_PER_LINE)}...`;
    })
    .join("\n");
  const hiddenLines = Math.max(0, lines.length - visibleLines.length);

  return {
    text,
    hiddenLabel: formatHiddenCommandLabel({ hiddenChars, hiddenLines }),
  };
}

export function estimateDeferredPreviewHeightPx(params: {
  toolName: string;
  toolInput: unknown;
  result: unknown;
  status: ToolCallItem["status"];
  rowWidthPx?: number | null;
  typography?: Partial<DeferredPreviewTypographyMetrics>;
}): number | null {
  if (
    !canDeferRichToolRow(params.status) ||
    !isBashLikeToolName(params.toolName)
  ) {
    return null;
  }

  const output = getBashResultOutputForRichPreview(params.result).trimEnd();
  if (params.result === undefined && !output) {
    return null;
  }

  const typography = normalizeTypographyMetrics(params.typography);
  const charsPerLine = estimatePreviewCharsPerLine(
    params.rowWidthPx,
    typography,
  );
  const outputPx = output
    ? Math.max(
        DEFERRED_PREVIEW_HEIGHT.minOutputRowPx,
        Math.min(
          DEFERRED_PREVIEW_HEIGHT.maxOutputPx,
          estimateWrappedLineCount(output, charsPerLine) *
            typography.outputLineHeightPx,
        ) + typography.outputRowChromePx,
      )
    : params.result
      ? DEFERRED_PREVIEW_HEIGHT.emptyOutputRowPx
      : 0;

  return clamp(
    outputPx + DEFERRED_PREVIEW_HEIGHT.previewBorderPx,
    DEFERRED_PREVIEW_HEIGHT.minPx,
    DEFERRED_PREVIEW_HEIGHT.maxPx,
  );
}

function readDeferredPreviewTypographyMetrics(): DeferredPreviewTypographyMetrics {
  if (typeof document === "undefined") {
    return DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY;
  }

  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.left = "-9999px";
  probe.style.top = "-9999px";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = "var(--output-prose-font-family)";
  probe.style.fontSize = "var(--output-prose-font-size)";
  probe.style.lineHeight = "var(--output-prose-line-height)";
  probe.textContent =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  document.body.appendChild(probe);
  const computed = window.getComputedStyle(probe);
  const rect = probe.getBoundingClientRect();
  const fontSizePx = Number.parseFloat(computed.fontSize);
  const lineHeightPx = Number.parseFloat(computed.lineHeight);
  probe.remove();

  const effectiveFontSizePx = Number.isFinite(fontSizePx)
    ? fontSizePx
    : DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.outputLineHeightPx / 1.5;
  const averageCharWidthPx =
    rect.width > 0 && probe.textContent
      ? rect.width / probe.textContent.length
      : effectiveFontSizePx * 0.5;
  const outputLineHeightPx = Number.isFinite(lineHeightPx)
    ? lineHeightPx
    : effectiveFontSizePx * 1.5;
  const outputRowChromePx =
    DEFERRED_PREVIEW_HEIGHT.outputRowChromePx +
    (outputLineHeightPx -
      DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.outputLineHeightPx) *
      0.5;

  return normalizeTypographyMetrics({
    averageCharWidthPx,
    outputLineHeightPx,
    outputRowChromePx,
  });
}

function useDeferredPreviewTypographyMetrics(): DeferredPreviewTypographyMetrics {
  const [metrics, setMetrics] = useState(readDeferredPreviewTypographyMetrics);

  useEffect(() => {
    const updateMetrics = () =>
      setMetrics(readDeferredPreviewTypographyMetrics());
    updateMetrics();
    window.addEventListener(OUTPUT_APPEARANCE_CHANGE_EVENT, updateMetrics);
    return () =>
      window.removeEventListener(OUTPUT_APPEARANCE_CHANGE_EVENT, updateMetrics);
  }, []);

  return metrics;
}

function isBashLikeToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "exec_command" ||
    normalized === "shell_command"
  );
}

function canDeferRichToolRow(
  status: ToolCallItem["status"],
  deferRichContent = true,
): boolean {
  return deferRichContent && (status === "complete" || status === "error");
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

function useNearViewportHydration(
  status: ToolCallItem["status"],
  deferRichContent: boolean,
): {
  rowRef: RefObject<HTMLDivElement | null>;
  shouldHydrate: boolean;
  hydrateNow: () => void;
  rowWidthPx: number | null;
} {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [rowWidthPx, setRowWidthPx] = useState<number | null>(null);
  const [shouldHydrate, setShouldHydrate] = useState(
    () =>
      !canDeferRichToolRow(status, deferRichContent) ||
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (!canDeferRichToolRow(status, deferRichContent)) {
      setShouldHydrate(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setShouldHydrate(true);
      return;
    }
    setShouldHydrate(false);
  }, [status, deferRichContent]);

  useLayoutEffect(() => {
    if (shouldHydrate || !canDeferRichToolRow(status, deferRichContent)) {
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
  }, [shouldHydrate, status, deferRichContent]);

  useEffect(() => {
    if (shouldHydrate || !canDeferRichToolRow(status, deferRichContent)) {
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
  }, [shouldHydrate, status, deferRichContent]);

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
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [bashCommandExpanded, setBashCommandExpanded] = useState(false);
  const outputToolPreviewLineCount = useOutputToolPreviewLineCount();
  const deferredPreviewTypography = useDeferredPreviewTypographyMetrics();
  const toggleSummaryExpanded = useCallback(() => {
    setSummaryExpanded((current) => !current);
  }, []);

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
  const interactiveSummaryContext: RenderContext = useMemo(
    () => ({
      ...renderContext,
      summaryExpanded,
      toggleSummaryExpanded,
    }),
    [renderContext, summaryExpanded, toggleSummaryExpanded],
  );

  // Get structured result for interactive summary
  const structuredResult = toolResult?.structured ?? toolResult?.content;
  const { stableToolPreviewRendering } = useStableToolPreviewRendering();
  const {
    rowRef,
    shouldHydrate: shouldHydrateRichContent,
    hydrateNow,
    rowWidthPx,
  } = useNearViewportHydration(status, !stableToolPreviewRendering);

  // Check if this tool renders inline (bypasses entire tool-row structure)
  const hasInlineRenderer = toolRegistry.hasInlineRenderer(toolName);
  const hasOnlyRedundantBashDetail = isRedundantBashResultExpansion(
    toolName,
    structuredResult,
    status,
  );
  const suppressCollapsedPreview = shouldSuppressBashCollapsedPreview(
    toolName,
    structuredResult,
    status,
  );
  const rendererToolName = toolRegistry.get(toolName).tool;
  const mayHaveCollapsedPreview =
    toolRegistry.hasCollapsedPreview(toolName) && !suppressCollapsedPreview;
  const isEditTool = rendererToolName === "Edit";
  const isReadTool = rendererToolName === "Read";
  const isBashTool = rendererToolName === "Bash";
  const isGrepTool = rendererToolName === "Grep";
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
        typography: deferredPreviewTypography,
      }),
    [
      toolName,
      toolInput,
      structuredResult,
      status,
      rowWidthPx,
      deferredPreviewTypography,
    ],
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
      interactiveSummaryContext,
    );
  }, [
    status,
    toolName,
    toolInput,
    structuredResult,
    toolResult,
    interactiveSummaryContext,
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
  const hasBashPreviewToggle = isBashTool && hasCollapsedPreview;
  const hasDeferredPreviewShell =
    !shouldHydrateRichContent &&
    mayHaveCollapsedPreview &&
    deferredPreviewHeightPx !== null;
  const hasDeferredInteractiveShell =
    !shouldHydrateRichContent &&
    (mayHaveCollapsedPreview || mayHaveInteractiveSummary);
  const [bashPreviewExpanded, setBashPreviewExpanded] = useState(true);
  // Tools with collapsed preview or interactive summary don't expand
  const isNonExpandable =
    hasOnlyRedundantBashDetail ||
    hasInteractiveSummary ||
    hasCollapsedPreview ||
    hasDeferredInteractiveShell;

  // Edit and TodoWrite tools are expanded by default
  const [expanded, setExpanded] = useState(
    !isNonExpandable && (toolName === "Edit" || toolName === "TodoWrite"),
  );

  // Dot-expanded: inline full result for preview-first rows (starts collapsed).
  const [dotExpanded, setDotExpanded] = useState(false);
  const shouldFocusExpandedTopRef = useRef(false);
  const canInlineExpandToolResult =
    isNonExpandable &&
    hasInteractiveSummary &&
    shouldHydrateRichContent &&
    (isReadTool || (isEditTool && toolResult !== undefined));
  const hasSummaryDotToggle = isGrepTool && mayHaveInteractiveSummary;

  // Dot button: expandable rows + preview-first rows with an inline result.
  const showDotBtn =
    !hasOnlyRedundantBashDetail &&
    (!isNonExpandable ||
      canInlineExpandToolResult ||
      hasBashPreviewToggle ||
      hasSummaryDotToggle);

  // Header toggles dotExpanded for preview-first inline result rows.
  const hasHeaderDotToggle = canInlineExpandToolResult;
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
    } else if (hasSummaryDotToggle) {
      setSummaryExpanded((current) => !current);
    } else if (!isNonExpandable) {
      setExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    } else if (canInlineExpandToolResult) {
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
  const headerCommand = isBashTool
    ? getDisplayBashCommandFromInput(toolInput)
    : "";
  const hasBashDescription =
    isBashTool &&
    isRecord(toolInput) &&
    typeof toolInput.description === "string" &&
    toolInput.description.trim().length > 0;
  const showBashCommandTarget =
    isBashTool && !hasBashDescription && headerCommand.length > 0;
  const bashCommandPreview = useMemo(
    () => getCommandPreview(headerCommand, outputToolPreviewLineCount),
    [headerCommand, outputToolPreviewLineCount],
  );

  useEffect(() => {
    setBashCommandExpanded(false);
  }, [headerCommand]);

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
      : hasSummaryDotToggle
        ? summaryExpanded
          ? "Collapse summary"
          : "Expand summary"
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
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer/focus events only hydrate deferred rich content
    <div
      ref={rowRef}
      onPointerEnter={hydrateNow}
      onFocus={hydrateNow}
      className={`tool-row timeline-item ${expanded ? "expanded" : "collapsed"} status-${status} ${isNonExpandable ? "interactive" : ""} ${shouldHydrateRichContent ? "" : "rich-deferred"} ${isBashTool ? "ran-tool-row" : ""}`}
    >
      {showDotBtn && (
        <button
          type="button"
          className="timeline-dot-btn"
          onClick={handleDotClick}
          aria-label={dotAriaLabel}
        />
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: interactive header has role, tabIndex, and keyboard handlers when enabled */}
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
          <span className="tool-spinner" role="status" aria-label="Running">
            <Spinner />
          </span>
        )}
        {status === "aborted" && (
          <span
            className="tool-aborted-icon"
            role="img"
            aria-label="Interrupted"
          >
            ⨯
          </span>
        )}
        {status === "incomplete" && (
          <span
            className="tool-incomplete-icon"
            role="img"
            aria-label="Result unavailable"
          >
            ?
          </span>
        )}

        <span className="tool-name">
          {toolRegistry.getDisplayName(toolName)}
        </span>

        {hasInteractiveSummary && canRenderInteractiveSummary ? (
          <span
            className={`tool-summary interactive-summary${hasSummaryDotToggle ? " outline-summary" : ""}`}
          >
            {interactiveSummaryContent}
          </span>
        ) : showBashCommandTarget ? (
          <button
            type="button"
            className={`tool-summary tool-summary-command${bashCommandExpanded ? " is-expanded" : ""}`}
            title={headerCommand}
            aria-label={
              bashCommandExpanded ? "Collapse command" : "Show full command"
            }
            aria-expanded={bashCommandExpanded}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setBashCommandExpanded((current) => !current);
            }}
          >
            <span className="tool-summary-command-text">
              {bashCommandExpanded ? headerCommand : bashCommandPreview.text}
            </span>
            {!bashCommandExpanded && bashCommandPreview.hiddenLabel && (
              <span className="tool-summary-command-more">
                {bashCommandPreview.hiddenLabel}
              </span>
            )}
          </button>
        ) : (
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
        )}

        {headerCommand && (
          <ToolHeaderCopyButton text={headerCommand} label="Copy command" />
        )}

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
      {hasCollapsedPreview &&
        bashPreviewExpanded &&
        !(dotExpanded && isEditTool) && (
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

      {dotExpanded && canInlineExpandToolResult && (
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
  result: unknown,
  status?: ToolCallItem["status"],
): boolean {
  if (!isBashLikeToolName(toolName)) {
    return false;
  }

  if (status === "pending") {
    return true;
  }

  return (
    result === undefined ||
    isRedundantBashResultExpansion(toolName, result, status)
  );
}

function isRedundantBashResultExpansion(
  toolName: string,
  result: unknown,
  status?: ToolCallItem["status"],
): boolean {
  if (!isBashLikeToolName(toolName) || status !== "complete") {
    return false;
  }
  if (result === undefined) {
    return false;
  }
  if (getBashResultOutputForRichPreview(result).trim().length > 0) {
    return false;
  }
  if (!isRecord(result)) {
    return true;
  }
  return result.interrupted !== true && result.backgroundTaskId === undefined;
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

function ToolHeaderCopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={`tool-header-copy ${copied ? "copied" : ""}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 3000);
          })
          .catch((error) => {
            console.error("Failed to copy tool header text:", error);
          });
      }}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
