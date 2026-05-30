import { getModelContextWindow } from "@yep-anywhere/shared";
import { useCallback, useRef } from "react";
import { getMessageId } from "../lib/mergeMessages";
import type { ContentBlock, Message } from "../types";
import { getStreamingEnabled } from "./useStreamingEnabled";

/** Adaptive bounds for batching streaming UI updates */
const STREAMING_UPDATE_BASE_MS = 100;
const STREAMING_UPDATE_MAX_MS = 750;
const STREAMING_FLUSH_BUDGET_MS = 16;
const STREAMING_BURST_EVENT_THRESHOLD = 40;

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Callbacks for streaming markdown events (augment/pending from SSE) */
export interface StreamingMarkdownCallbacks {
  onAugment?: (augment: {
    blockIndex: number;
    html: string;
    type: string;
    messageId?: string;
  }) => void;
  onPending?: (pending: { html: string }) => void;
  onStreamEnd?: () => void;
  setCurrentMessageId?: (messageId: string | null) => void;
  captureHtml?: () => string | null;
}

/** Context usage info for subagent progress tracking */
export interface ContextUsage {
  inputTokens: number;
  percentage: number;
}

/** Options for useStreamingContent hook */
export interface UseStreamingContentOptions {
  /** Called when a streaming message needs to be updated in state */
  onUpdateMessage: (message: Message, agentId?: string) => void;
  /** Streaming markdown callbacks (passed through) */
  streamingMarkdownCallbacks?: StreamingMarkdownCallbacks;
  /** Callback when toolUseId→agentId mapping is discovered */
  onToolUseMapping?: (toolUseId: string, agentId: string) => void;
  /** Callback for agent context usage updates */
  onAgentContextUsage?: (agentId: string, usage: ContextUsage) => void;
  /** Fallback context window size when stream metadata doesn't include one */
  contextWindowSize?: number;
}

/** Result from useStreamingContent hook */
export interface UseStreamingContentResult {
  /** Process a stream_event SSE message. Returns true if handled. */
  handleStreamEvent: (data: Record<string, unknown>) => boolean;
  /** Clear all streaming state (called when assistant message arrives) */
  clearStreaming: () => void;
  /** Cleanup function for useEffect (clears timers) */
  cleanup: () => void;
  /** Get the current streaming agent ID (for routing assistant messages) */
  getCurrentAgentId: () => string | null;
}

/** Internal streaming state for a message */
interface StreamingState {
  blocks: ContentBlock[];
  isStreaming: boolean;
  agentId?: string;
}

/**
 * Hook for managing streaming content accumulation from SSE stream_event messages.
 *
 * This hook handles:
 * - Accumulating content blocks from streaming API events
 * - Throttling UI updates to avoid overwhelming React with re-renders
 * - Routing subagent streams via agentId
 * - Notifying streaming markdown context of updates
 */
export function useStreamingContent(
  options: UseStreamingContentOptions,
): UseStreamingContentResult {
  const {
    onUpdateMessage,
    streamingMarkdownCallbacks,
    onToolUseMapping,
    onAgentContextUsage,
    contextWindowSize: defaultContextWindowSize,
  } = options;

  // Streaming state: accumulates content from stream_event messages
  // Key is the message uuid, value is the accumulated content blocks
  const streamingContentRef = useRef<Map<string, StreamingState>>(new Map());

  // Track current streaming message ID (from message_start event)
  // Each stream_event has its own uuid, but they all belong to the same message
  const currentStreamingIdRef = useRef<string | null>(null);

  // Track current streaming agentId (if this is a subagent stream)
  const currentStreamingAgentIdRef = useRef<string | null>(null);

  // Throttle streaming UI updates to avoid overwhelming React with re-renders
  // Data accumulates in streamingContentRef immediately, but state updates are batched
  const streamingThrottleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pendingIds: Set<string>;
    pendingEventCount: number;
    intervalMs: number;
  }>({
    timer: null,
    pendingIds: new Set(),
    pendingEventCount: 0,
    intervalMs: STREAMING_UPDATE_BASE_MS,
  });

  // Update messages with streaming content
  // Creates or updates a streaming placeholder message with accumulated content
  const updateStreamingMessage = useCallback(
    (messageId: string) => {
      const streaming = streamingContentRef.current.get(messageId);
      if (!streaming) return;

      const streamingMessage: Message = {
        id: messageId,
        type: "assistant",
        role: "assistant",
        message: {
          role: "assistant",
          content: streaming.blocks,
        },
        _isStreaming: true,
        _source: "sdk",
      };

      // Call the update callback with optional agentId for routing
      onUpdateMessage(streamingMessage, streaming.agentId);
    },
    [onUpdateMessage],
  );

  const tuneStreamingInterval = useCallback(
    (durationMs: number, eventCount: number) => {
      const throttle = streamingThrottleRef.current;
      if (
        durationMs > STREAMING_FLUSH_BUDGET_MS ||
        eventCount > STREAMING_BURST_EVENT_THRESHOLD
      ) {
        throttle.intervalMs = Math.min(
          STREAMING_UPDATE_MAX_MS,
          Math.max(200, Math.ceil(throttle.intervalMs * 1.5)),
        );
        return;
      }

      if (durationMs < STREAMING_FLUSH_BUDGET_MS / 2 && eventCount <= 8) {
        throttle.intervalMs = Math.max(
          STREAMING_UPDATE_BASE_MS,
          Math.floor(throttle.intervalMs * 0.8),
        );
      }
    },
    [],
  );

  const flushStreamingUpdates = useCallback(() => {
    const throttle = streamingThrottleRef.current;
    if (throttle.timer) {
      clearTimeout(throttle.timer);
      throttle.timer = null;
    }
    if (throttle.pendingIds.size === 0) {
      throttle.pendingEventCount = 0;
      return;
    }

    const pendingIds = [...throttle.pendingIds];
    const eventCount = throttle.pendingEventCount;
    throttle.pendingIds.clear();
    throttle.pendingEventCount = 0;

    const startMs = nowMs();
    for (const id of pendingIds) {
      updateStreamingMessage(id);
    }
    tuneStreamingInterval(nowMs() - startMs, eventCount);
  }, [tuneStreamingInterval, updateStreamingMessage]);

  // Throttled version of updateStreamingMessage for delta events
  // Batches rapid updates to reduce React re-renders during streaming. Slow
  // devices naturally move toward larger chunks instead of one-token UI work.
  const throttledUpdateStreamingMessage = useCallback(
    (messageId: string) => {
      const throttle = streamingThrottleRef.current;
      throttle.pendingIds.add(messageId);
      throttle.pendingEventCount += 1;

      // If no timer running, start one
      if (!throttle.timer) {
        throttle.timer = setTimeout(
          flushStreamingUpdates,
          throttle.intervalMs,
        );
      }
    },
    [flushStreamingUpdates],
  );

  // Process a stream_event SSE message
  // Returns true if the event was handled, false if it should be processed elsewhere
  const handleStreamEvent = useCallback(
    (data: Record<string, unknown>): boolean => {
      // Only handle stream_event messages when streaming is enabled
      const msgType = data.type as string | undefined;
      if (msgType !== "stream_event" || !getStreamingEnabled()) {
        return false;
      }

      const event = data.event as Record<string, unknown> | undefined;
      if (!event) return true; // Handled but no event data

      const eventType = event.type as string | undefined;

      // Check if this is a subagent stream (marked by server via markSubagent)
      // Legacy SDK: uses parentToolUseId as routing key
      // SDK 0.2.76+: uses agentId directly (no parentToolUseId)
      const isSubagentStream =
        data.isSubagent &&
        (typeof data.parentToolUseId === "string" ||
          typeof data.agentId === "string");
      const streamAgentId = isSubagentStream
        ? ((data.parentToolUseId as string) ?? (data.agentId as string))
        : undefined;

      // Set toolUseToAgent mapping for subagent streams so TaskRenderer can find content
      if (streamAgentId && onToolUseMapping) {
        onToolUseMapping(streamAgentId, streamAgentId);
      }

      // Handle message_start to capture the message ID for this streaming response
      // Each stream_event has its own uuid, but they all belong to the same API message
      if (eventType === "message_start") {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.id) {
          currentStreamingIdRef.current = message.id as string;
          // Also track if this is a subagent stream
          currentStreamingAgentIdRef.current = streamAgentId ?? null;
          // Notify streaming markdown context of new message
          streamingMarkdownCallbacks?.setCurrentMessageId?.(
            message.id as string,
          );

          // Extract context usage for subagent progress tracking
          // Note: We only update subagent context usage from message_start, not main session.
          // Main session context usage comes from the API (which reads from JSONL after
          // the assistant message is complete with full usage data).
          if (streamAgentId && onAgentContextUsage) {
            const usage = message.usage as
              | { input_tokens?: number }
              | undefined;
            if (usage?.input_tokens) {
              const inputTokens = usage.input_tokens;
              const model =
                typeof message.model === "string" ? message.model : undefined;
              const modelContextWindow =
                typeof message.model_context_window === "number"
                  ? message.model_context_window
                  : undefined;
              const contextWindow =
                modelContextWindow && modelContextWindow > 0
                  ? modelContextWindow
                  : model
                    ? getModelContextWindow(model)
                    : (defaultContextWindowSize ??
                      getModelContextWindow(undefined));
              const percentage = (inputTokens / contextWindow) * 100;
              onAgentContextUsage(streamAgentId, { inputTokens, percentage });
            }
          }
        }
        return true;
      }

      // Use the captured message ID, or fall back to generating one
      const streamingId =
        currentStreamingIdRef.current ?? `stream-${Date.now()}`;
      // Use tracked agentId, falling back to current message's agentId
      const agentId = currentStreamingAgentIdRef.current ?? streamAgentId;

      // Handle different stream event types
      if (eventType === "content_block_start") {
        // New content block starting
        const index = event.index as number;
        const contentBlock = event.content_block as Record<
          string,
          unknown
        > | null;
        if (contentBlock) {
          const streaming = streamingContentRef.current.get(streamingId) ?? {
            blocks: [],
            isStreaming: true,
            agentId, // Track which agent this stream belongs to
          };
          // Ensure array is long enough
          while (streaming.blocks.length <= index) {
            streaming.blocks.push({ type: "text", text: "" });
          }
          // Initialize the block with its type
          streaming.blocks[index] = {
            type: (contentBlock.type as string) ?? "text",
            text: (contentBlock.text as string) ?? "",
            thinking: (contentBlock.thinking as string) ?? undefined,
          };
          streamingContentRef.current.set(streamingId, streaming);
          updateStreamingMessage(streamingId);
        }
      } else if (eventType === "content_block_delta") {
        // Content delta - append to existing block
        // Use throttled updates to avoid overwhelming React with re-renders
        const index = event.index as number;
        const delta = event.delta as Record<string, unknown> | null;
        if (delta) {
          const streaming = streamingContentRef.current.get(streamingId);
          if (streaming?.blocks[index]) {
            const block = streaming.blocks[index];
            const deltaType = delta.type as string;
            if (deltaType === "text_delta" && delta.text) {
              block.text = (block.text ?? "") + (delta.text as string);
            } else if (deltaType === "thinking_delta" && delta.thinking) {
              block.thinking =
                (block.thinking ?? "") + (delta.thinking as string);
            }
            throttledUpdateStreamingMessage(streamingId);
          }
        }
      } else if (eventType === "content_block_stop") {
        // Block complete - nothing special needed, final message will replace
      } else if (eventType === "message_stop") {
        flushStreamingUpdates();
        // Message complete - clean up streaming ref state
        // DON'T clear currentStreamingIdRef here - we need it to remove the
        // streaming placeholder when the final assistant message arrives
        streamingContentRef.current.delete(streamingId);
        // Notify streaming markdown context that stream has ended
        streamingMarkdownCallbacks?.onStreamEnd?.();
      }

      return true; // Event was handled
    },
    [
      updateStreamingMessage,
      throttledUpdateStreamingMessage,
      flushStreamingUpdates,
      streamingMarkdownCallbacks,
      onToolUseMapping,
      onAgentContextUsage,
      defaultContextWindowSize,
    ],
  );

  // Clear all streaming state (called when assistant message arrives)
  const clearStreaming = useCallback(() => {
    const throttle = streamingThrottleRef.current;
    if (throttle.timer) {
      clearTimeout(throttle.timer);
      throttle.timer = null;
    }
    throttle.pendingIds.clear();
    throttle.pendingEventCount = 0;
    throttle.intervalMs = STREAMING_UPDATE_BASE_MS;
    streamingContentRef.current.clear();
    currentStreamingIdRef.current = null;
    currentStreamingAgentIdRef.current = null;
  }, []);

  // Get the current streaming agent ID (for routing assistant messages)
  const getCurrentAgentId = useCallback(() => {
    return currentStreamingAgentIdRef.current;
  }, []);

  // Cleanup function for useEffect (clears timers)
  const cleanup = useCallback(() => {
    if (streamingThrottleRef.current.timer) {
      clearTimeout(streamingThrottleRef.current.timer);
      streamingThrottleRef.current.timer = null;
    }
    streamingThrottleRef.current.pendingIds.clear();
    streamingThrottleRef.current.pendingEventCount = 0;
  }, []);

  return {
    handleStreamEvent,
    clearStreaming,
    cleanup,
    getCurrentAgentId,
  };
}
