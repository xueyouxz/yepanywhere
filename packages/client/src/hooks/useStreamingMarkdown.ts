import { useCallback, useEffect, useRef, useState } from "react";

const STREAMING_MARKDOWN_BASE_UPDATE_MS = 100;
const STREAMING_MARKDOWN_MAX_UPDATE_MS = 750;
const STREAMING_MARKDOWN_FLUSH_BUDGET_MS = 16;
const STREAMING_MARKDOWN_BURST_EVENT_THRESHOLD = 20;

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// Debug logging - enable via window.__STREAMING_DEBUG__ = true
declare global {
  interface Window {
    __STREAMING_DEBUG__?: boolean;
  }
}

function debugLog(
  category: "augment" | "pending" | "event" | "dom",
  message: string,
  data?: Record<string, unknown>,
): void {
  if (typeof window !== "undefined" && window.__STREAMING_DEBUG__) {
    const prefix = {
      augment: "[AUGMENT]",
      pending: "[PENDING]",
      event: "[EVENT]",
      dom: "[DOM]",
    }[category];
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    console.log(`%c${prefix} ${message}${dataStr}`, getLogStyle(category));
  }
}

function getLogStyle(category: string): string {
  const styles: Record<string, string> = {
    augment: "color: #4caf50; font-weight: bold",
    pending: "color: #ff9800; font-weight: bold",
    event: "color: #2196f3; font-weight: bold",
    dom: "color: #9c27b0; font-weight: bold",
  };
  return styles[category] || "";
}

export interface StreamingMarkdownState {
  containerRef: React.RefObject<HTMLDivElement | null>;
  pendingRef: React.RefObject<HTMLSpanElement | null>;
  isStreaming: boolean;
}

export interface AugmentEvent {
  blockIndex: number;
  html: string;
  type: string;
}

export interface PendingEvent {
  html: string;
}

/**
 * Hook for consuming streaming markdown augments from the server.
 *
 * Uses refs instead of state for HTML content to avoid React re-renders during
 * streaming. The containerRef holds completed block HTML, and pendingRef shows
 * the incomplete/trailing text with inline formatting.
 *
 * @example
 * ```tsx
 * const { containerRef, pendingRef, isStreaming, onAugment, onPending, onStreamEnd, reset } =
 *   useStreamingMarkdown();
 *
 * // Attach refs to DOM elements
 * <div ref={containerRef} />
 * <span ref={pendingRef} className="streaming-pending" />
 *
 * // Call handlers when events arrive
 * onAugment({ blockIndex: 0, html: '<p>Hello</p>', type: 'paragraph' });
 * onPending({ html: '<strong>partial</strong> text...' });
 * onStreamEnd();
 * ```
 */
export function useStreamingMarkdown(): StreamingMarkdownState & {
  onAugment: (augment: AugmentEvent) => void;
  onPending: (pending: PendingEvent) => void;
  onStreamEnd: () => void;
  reset: () => void;
  captureHtml: () => string | null;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<HTMLSpanElement | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  // Track which block indices we've received to handle out-of-order augments
  // Maps blockIndex -> DOM element for that block
  const blocksRef = useRef<Map<number, HTMLElement>>(new Map());

  // Track the highest block index we've seen to maintain order
  const maxBlockIndexRef = useRef(-1);
  const bufferedAugmentsRef = useRef<Map<number, AugmentEvent>>(new Map());
  const bufferedPendingHtmlRef = useRef<string | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushAtRef = useRef(Number.NEGATIVE_INFINITY);
  const adaptiveFlushMsRef = useRef(STREAMING_MARKDOWN_BASE_UPDATE_MS);
  const pendingEventCountRef = useRef(0);

  const markStreaming = useCallback(() => {
    setIsStreaming((current) => (current ? current : true));
  }, []);

  /**
   * Apply a completed block augment.
   * Creates a div with the augment's HTML and inserts it at the correct position.
   */
  const applyAugment = useCallback((augment: AugmentEvent) => {
    const container = containerRef.current;

    debugLog("augment", "Received augment", {
      blockIndex: augment.blockIndex,
      type: augment.type,
      htmlLength: augment.html.length,
      htmlPreview: augment.html.substring(0, 100),
    });

    if (!container) {
      debugLog(
        "augment",
        "ERROR: containerRef.current is null - refs not attached!",
      );
      return;
    }

    // Mark as streaming on first augment
    markStreaming();

    const { blockIndex, html } = augment;

    // Check if we already have this block (dedupe)
    if (blocksRef.current.has(blockIndex)) {
      // Update existing block's content
      const existingBlock = blocksRef.current.get(blockIndex);
      if (existingBlock) {
        debugLog("dom", "Updating existing block", { blockIndex });
        existingBlock.innerHTML = html;
      }
      return;
    }

    // Create new block element
    const blockElement = document.createElement("div");
    blockElement.className = "streaming-block";
    blockElement.dataset.blockIndex = String(blockIndex);
    blockElement.innerHTML = html;

    debugLog("dom", "Created new block element", {
      blockIndex,
      className: blockElement.className,
    });

    // Find the correct position to insert
    // Blocks should be ordered by blockIndex
    if (blockIndex > maxBlockIndexRef.current) {
      // This is the newest block, append to end
      container.appendChild(blockElement);
      maxBlockIndexRef.current = blockIndex;
      debugLog("dom", "Appended block to end", {
        blockIndex,
        maxBlockIndex: maxBlockIndexRef.current,
      });
    } else {
      // Out-of-order block, find where to insert
      let inserted = false;
      const children = container.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i] as HTMLElement;
        const childIndex = Number.parseInt(
          child.dataset.blockIndex ?? "-1",
          10,
        );
        if (childIndex > blockIndex) {
          container.insertBefore(blockElement, child);
          inserted = true;
          debugLog("dom", "Inserted block before", {
            blockIndex,
            beforeIndex: childIndex,
          });
          break;
        }
      }
      if (!inserted) {
        container.appendChild(blockElement);
        debugLog("dom", "Appended out-of-order block to end", { blockIndex });
      }
    }

    // Track this block
    blocksRef.current.set(blockIndex, blockElement);
    debugLog("dom", "Block tracking updated", {
      totalBlocks: blocksRef.current.size,
    });
  }, [markStreaming]);

  /**
   * Apply pending/incomplete text update.
   * Updates the pendingRef's innerHTML with the pending HTML.
   */
  const applyPending = useCallback((pending: PendingEvent) => {
    const pendingElement = pendingRef.current;

    debugLog("pending", "Received pending update", {
      htmlLength: pending.html.length,
      htmlPreview: pending.html.substring(0, 80),
    });

    if (!pendingElement) {
      debugLog(
        "pending",
        "ERROR: pendingRef.current is null - refs not attached!",
      );
      return;
    }

    // Mark as streaming on first pending update
    markStreaming();

    pendingElement.innerHTML = pending.html;
    debugLog("pending", "Updated pending element innerHTML");
  }, [markStreaming]);

  const clearScheduledFlush = useCallback(() => {
    if (flushTimerRef.current === null) return;
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
  }, []);

  const flushBufferedUpdates = useCallback(() => {
    clearScheduledFlush();

    const bufferedAugments = bufferedAugmentsRef.current;
    const bufferedPendingHtml = bufferedPendingHtmlRef.current;
    if (bufferedAugments.size === 0 && bufferedPendingHtml === null) {
      pendingEventCountRef.current = 0;
      return;
    }

    const augments = [...bufferedAugments.values()].sort(
      (a, b) => a.blockIndex - b.blockIndex,
    );
    const eventCount = pendingEventCountRef.current;
    bufferedAugments.clear();
    bufferedPendingHtmlRef.current = null;
    pendingEventCountRef.current = 0;

    const startMs = nowMs();
    for (const augment of augments) {
      applyAugment(augment);
    }
    if (bufferedPendingHtml !== null) {
      applyPending({ html: bufferedPendingHtml });
    }

    const durationMs = nowMs() - startMs;
    if (
      durationMs > STREAMING_MARKDOWN_FLUSH_BUDGET_MS ||
      eventCount > STREAMING_MARKDOWN_BURST_EVENT_THRESHOLD
    ) {
      adaptiveFlushMsRef.current = Math.min(
        STREAMING_MARKDOWN_MAX_UPDATE_MS,
        Math.max(200, Math.ceil(adaptiveFlushMsRef.current * 1.5)),
      );
    } else if (
      durationMs < STREAMING_MARKDOWN_FLUSH_BUDGET_MS / 2 &&
      eventCount <= 6
    ) {
      adaptiveFlushMsRef.current = Math.max(
        STREAMING_MARKDOWN_BASE_UPDATE_MS,
        Math.floor(adaptiveFlushMsRef.current * 0.8),
      );
    }

    lastFlushAtRef.current = nowMs();
  }, [applyAugment, applyPending, clearScheduledFlush]);

  const scheduleBufferedFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;

    const now = nowMs();
    const elapsed = now - lastFlushAtRef.current;
    const updateMs = adaptiveFlushMsRef.current;
    if (elapsed >= updateMs) {
      flushBufferedUpdates();
      return;
    }

    flushTimerRef.current = setTimeout(
      flushBufferedUpdates,
      updateMs - elapsed,
    );
  }, [flushBufferedUpdates]);

  /**
   * Handle a completed block augment at a bounded cadence. Streaming code blocks
   * can re-render the same block on every token; keep only the newest version.
   */
  const onAugment = useCallback(
    (augment: AugmentEvent) => {
      bufferedAugmentsRef.current.set(augment.blockIndex, augment);
      pendingEventCountRef.current += 1;
      scheduleBufferedFlush();
    },
    [scheduleBufferedFlush],
  );

  /**
   * Handle pending/incomplete text at a bounded cadence. This preserves the
   * latest partial output without rewriting innerHTML on every token.
   */
  const onPending = useCallback(
    (pending: PendingEvent) => {
      bufferedPendingHtmlRef.current = pending.html;
      pendingEventCountRef.current += 1;
      scheduleBufferedFlush();
    },
    [scheduleBufferedFlush],
  );

  /**
   * Handle stream end.
   * Clears pending text and sets streaming to false.
   */
  const onStreamEnd = useCallback(() => {
    debugLog("event", "Stream ended");
    flushBufferedUpdates();

    const pendingElement = pendingRef.current;
    if (pendingElement) {
      pendingElement.innerHTML = "";
      debugLog("event", "Cleared pending element");
    }
    setIsStreaming(false);
    debugLog("event", "Set isStreaming to false");
  }, [flushBufferedUpdates]);

  /**
   * Reset all state.
   * Clears container, pending, and tracking state.
   */
  const reset = useCallback(() => {
    debugLog("event", "Reset called");
    clearScheduledFlush();
    bufferedAugmentsRef.current.clear();
    bufferedPendingHtmlRef.current = null;
    pendingEventCountRef.current = 0;
    adaptiveFlushMsRef.current = STREAMING_MARKDOWN_BASE_UPDATE_MS;

    const container = containerRef.current;
    const pendingElement = pendingRef.current;

    if (container) {
      container.innerHTML = "";
      debugLog("event", "Cleared container");
    }
    if (pendingElement) {
      pendingElement.innerHTML = "";
      debugLog("event", "Cleared pending element");
    }

    const previousBlockCount = blocksRef.current.size;
    blocksRef.current.clear();
    maxBlockIndexRef.current = -1;
    setIsStreaming(false);

    debugLog("event", "Reset complete", {
      previousBlockCount,
      maxBlockIndexReset: true,
    });
  }, [clearScheduledFlush]);

  /**
   * Capture the current streaming HTML for persistence.
   * Returns the container's innerHTML or null if not available.
   */
  const captureHtml = useCallback((): string | null => {
    flushBufferedUpdates();
    const container = containerRef.current;
    if (!container) return null;
    const html = container.innerHTML;
    debugLog("event", "Captured HTML", { length: html.length });
    return html || null;
  }, [flushBufferedUpdates]);

  useEffect(() => {
    return () => {
      clearScheduledFlush();
    };
  }, [clearScheduledFlush]);

  return {
    containerRef,
    pendingRef,
    isStreaming,
    onAugment,
    onPending,
    onStreamEnd,
    reset,
    captureHtml,
  };
}
