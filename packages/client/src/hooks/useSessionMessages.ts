import { useCallback, useEffect, useRef, useState } from "react";
import { type PaginationInfo, api } from "../api/client";
import {
  getMessageTimestampMs,
  hasEquivalentJsonlMessage,
  reconcileLinearMessages,
} from "../lib/linearMessageDedup";
import {
  findMessageIndexById,
  getMessageId,
  mergeJSONLMessages,
  mergeStreamMessage,
} from "../lib/mergeMessages";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import { getProvider } from "../providers/registry";
import { getStreamingEnabled } from "./useStreamingEnabled";
import type { Message, SessionMetadata, SessionStatus } from "../types";

/** Content from a subagent (Task tool) */
export interface AgentContent {
  messages: Message[];
  status: "pending" | "running" | "completed" | "failed";
  /** Real-time context usage from message_start events */
  contextUsage?: {
    inputTokens: number;
    percentage: number;
  };
}

/** Map of agentId → agent content */
export type AgentContentMap = Record<string, AgentContent>;

/** Result from initial session load */
export interface SessionLoadResult {
  session: SessionMetadata;
  status: SessionStatus;
  pendingInputRequest?: unknown;
  slashCommands?: Array<{
    name: string;
    description: string;
    argumentHint?: string;
  }> | null;
}

/** Options for useSessionMessages */
export interface UseSessionMessagesOptions {
  projectId: string;
  sessionId: string;
  tailTurns?: number;
  tailFrom?: string;
  /** Called when initial load completes with session data */
  onLoadComplete?: (result: SessionLoadResult) => void;
  /** Called on load error */
  onLoadError?: (error: Error) => void;
}

/** Result from useSessionMessages hook */
export interface UseSessionMessagesResult {
  /** Messages in the session */
  messages: Message[];
  /** Subagent content keyed by agentId */
  agentContent: AgentContentMap;
  /** Mapping from Task tool_use_id → agentId */
  toolUseToAgent: Map<string, string>;
  /** Whether initial load is in progress */
  loading: boolean;
  /** Session data from initial load */
  session: SessionMetadata | null;
  /** Set session data (for stream connected event) */
  setSession: React.Dispatch<React.SetStateAction<SessionMetadata | null>>;
  /** Handle streaming content updates (for useStreamingContent) */
  handleStreamingUpdate: (message: Message, agentId?: string) => void;
  /** Handle stream message event (buffered until initial load completes) */
  handleStreamMessageEvent: (incoming: Message) => void;
  /** Handle stream subagent message event */
  handleStreamSubagentMessage: (incoming: Message, agentId: string) => void;
  /** Register toolUse → agent mapping */
  registerToolUseAgent: (toolUseId: string, agentId: string) => void;
  /** Update agent content (for lazy loading) */
  setAgentContent: React.Dispatch<React.SetStateAction<AgentContentMap>>;
  /** Update toolUseToAgent mapping */
  setToolUseToAgent: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  /** Direct messages setter (for clearing streaming placeholders) */
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Fetch new messages incrementally (for file change events) */
  fetchNewMessages: () => Promise<void>;
  /** Fetch session metadata only */
  fetchSessionMetadata: () => Promise<void>;
  /** Pagination info from compact-boundary-based loading */
  pagination: PaginationInfo | undefined;
  /** Whether older messages are being loaded */
  loadingOlder: boolean;
  /** Load the next chunk of older messages */
  loadOlderMessages: () => Promise<void>;
}

interface SessionLoadCacheEntry {
  messages: Message[];
  session: SessionMetadata;
  pagination?: PaginationInfo;
  agentContent: AgentContentMap;
  toolUseToAgentEntries: Array<[string, string]>;
  lastMessageId?: string;
  maxPersistedTimestampMs: number;
}

interface SessionLoadCacheGlobal {
  __YA_SESSION_LOAD_CACHE__?: Map<string, SessionLoadCacheEntry>;
}

type SessionLoadCacheEnv = Pick<
  ImportMetaEnv,
  "DEV" | "VITE_SESSION_LOAD_CACHE"
>;

export function isSessionLoadCacheEnabled(
  env: SessionLoadCacheEnv = import.meta.env,
): boolean {
  return env.DEV === true && env.VITE_SESSION_LOAD_CACHE === "true";
}

function cloneForCache<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function getSessionLoadCache(): Map<string, SessionLoadCacheEntry> {
  const globalCache = globalThis as typeof globalThis & SessionLoadCacheGlobal;
  if (!globalCache.__YA_SESSION_LOAD_CACHE__) {
    globalCache.__YA_SESSION_LOAD_CACHE__ = new Map();
  }
  return globalCache.__YA_SESSION_LOAD_CACHE__;
}

function getSessionLoadCacheKey(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`;
}

function getSessionLoadVariantKey(options: {
  projectId: string;
  sessionId: string;
  tailTurns?: number;
  tailFrom?: string;
}): string {
  const variant = [
    options.tailTurns !== undefined ? `tailTurns=${options.tailTurns}` : "",
    options.tailFrom ? `tailFrom=${options.tailFrom}` : "",
  ]
    .filter(Boolean)
    .join("&");
  return variant
    ? `${options.projectId}:${options.sessionId}?${variant}`
    : getSessionLoadCacheKey(options.projectId, options.sessionId);
}

function readSessionLoadCache(
  projectId: string,
  sessionId: string,
  tailTurns?: number,
  tailFrom?: string,
): SessionLoadCacheEntry | undefined {
  if (!isSessionLoadCacheEnabled()) return undefined;
  if (typeof window === "undefined") return undefined;
  return getSessionLoadCache().get(
    getSessionLoadVariantKey({ projectId, sessionId, tailTurns, tailFrom }),
  );
}

function writeSessionLoadCache(
  projectId: string,
  sessionId: string,
  entry: SessionLoadCacheEntry,
  tailTurns?: number,
  tailFrom?: string,
): void {
  if (!isSessionLoadCacheEnabled()) return;
  if (typeof window === "undefined") return;
  getSessionLoadCache().set(
    getSessionLoadVariantKey({ projectId, sessionId, tailTurns, tailFrom }),
    cloneForCache(entry),
  );
}

function usesApproxMessageDedup(provider?: string): boolean {
  return getProvider(provider).capabilities.needsApproxMessageDedup;
}

// Options for the approx-dedup backstop. Codex tool messages dedup by call_id,
// so they are excluded here; the backstop keeps covering non-tool messages.
function approxDedupOptions(provider?: string): { excludeTools: boolean } {
  return {
    excludeTools:
      getProvider(provider).capabilities.approxDedupExcludesTools === true,
  };
}

function isDurableRecapOverlay(message: Message): boolean {
  return typeof message.yaRecapSource === "string";
}

/**
 * Find the id of the newest JSONL-sourced message.
 *
 * The incremental-fetch cursor (afterMessageId) must only advance over
 * rows actually delivered from JSONL. Live stream rows also land in the
 * array (and get persisted to the file), so cursoring on the array tail
 * lets streaming advance the cursor past JSONL rows that were never
 * fetched — permanently skipping them, including chain connector rows
 * (attachment, system/api_error) that only exist in JSONL. Over-fetching
 * is safe (merge dedupes by uuid); gaps are not.
 */
function findLastJsonlMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      (message._source ?? "sdk") === "jsonl" &&
      !isDurableRecapOverlay(message)
    ) {
      return getMessageId(message);
    }
  }
  return undefined;
}

function shouldSuppressLiveStreamingMessage(message: Message): boolean {
  return message._isStreaming === true && !getStreamingEnabled();
}

function clearStreamingMessages(messages: Message[]): Message[] {
  const filtered = messages.filter((message) => !message._isStreaming);
  return filtered.length === messages.length ? messages : filtered;
}

function isEmptyAssistantContent(message: Message): boolean {
  if (message.type !== "assistant") {
    return false;
  }

  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim().length === 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }

    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type === "text") {
      return (
        typeof typedBlock.text !== "string" || typedBlock.text.trim() === ""
      );
    }
    if (typedBlock.type === "thinking") {
      return (
        typeof typedBlock.thinking !== "string" ||
        typedBlock.thinking.trim() === ""
      );
    }
    return false;
  });
}

/**
 * Hook for managing session messages with stream buffering.
 *
 * Handles:
 * - Initial REST load of messages
 * - Buffering stream messages until initial load completes
 * - Merging stream and JSONL messages
 * - Routing subagent messages to agentContent
 */
export function useSessionMessages(
  options: UseSessionMessagesOptions,
): UseSessionMessagesResult {
  const {
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
    onLoadComplete,
    onLoadError,
  } = options;
  const cachedLoad = readSessionLoadCache(
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
  );

  // Core state
  const [messages, setMessages] = useState<Message[]>(
    () => cachedLoad?.messages ?? [],
  );
  const [agentContent, setAgentContent] = useState<AgentContentMap>(
    () => cachedLoad?.agentContent ?? {},
  );
  const [toolUseToAgent, setToolUseToAgent] = useState<Map<string, string>>(
    () => new Map(cachedLoad?.toolUseToAgentEntries ?? []),
  );
  const [loading, setLoading] = useState(!cachedLoad);
  const [session, setSession] = useState<SessionMetadata | null>(
    () => cachedLoad?.session ?? null,
  );
  const [pagination, setPagination] = useState<PaginationInfo | undefined>(
    () => cachedLoad?.pagination,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Buffering: queue stream messages until initial load completes
  const streamBufferRef = useRef<
    Array<
      | { type: "message"; msg: Message }
      | { type: "subagent"; msg: Message; agentId: string }
    >
  >([]);
  const initialLoadCompleteRef = useRef(false);

  // Track provider for DAG ordering decisions
  const providerRef = useRef<string | undefined>(undefined);

  // Track last message ID for incremental fetching
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  // Highest timestamp observed from persisted JSONL messages.
  // Used to suppress startup replay events that are already on disk.
  const maxPersistedTimestampMsRef = useRef<number>(Number.NEGATIVE_INFINITY);

  const updatePersistedTimestampWatermark = useCallback(
    (persistedMessages: Message[]) => {
      let maxMs = maxPersistedTimestampMsRef.current;
      for (const message of persistedMessages) {
        if (isDurableRecapOverlay(message)) {
          continue;
        }
        const ts = getMessageTimestampMs(message);
        if (ts !== null && ts > maxMs) {
          maxMs = ts;
        }
      }
      maxPersistedTimestampMsRef.current = maxMs;
    },
    [],
  );

  // Update lastMessageIdRef when messages change.
  // Cursor on the newest JSONL-sourced row, not the array tail (see
  // findLastJsonlMessageId).
  useEffect(() => {
    const lastJsonlId = findLastJsonlMessageId(messages);
    if (lastJsonlId) {
      lastMessageIdRef.current = lastJsonlId;
    }
  }, [messages]);

  // Process a stream message event.
  // When replaying buffered startup events for Codex, suppress entries that are
  // semantically identical to already-loaded JSONL messages but have different UUIDs.
  const processStreamMessage = useCallback(
    (incoming: Message, fromBufferedReplay = false) => {
      const provider = providerRef.current;
      const isReplay = incoming.isReplay === true;
      const shouldApplyReplayDedupe =
        (fromBufferedReplay || isReplay) && usesApproxMessageDedup(provider);
      const incomingTimestampMs = getMessageTimestampMs(incoming);
      const isPersistedReplay =
        isReplay &&
        incomingTimestampMs !== null &&
        incomingTimestampMs <= maxPersistedTimestampMsRef.current;
      const suppressStreaming = shouldSuppressLiveStreamingMessage(incoming);

      setMessages((prev) => {
        if (suppressStreaming) {
          return clearStreamingMessages(prev);
        }

        // Replay history from the stream should not re-add messages that are
        // already persisted and loaded from JSONL.
        if (isPersistedReplay) {
          return prev;
        }

        if (shouldApplyReplayDedupe) {
          if (isEmptyAssistantContent(incoming)) {
            return prev;
          }
          if (
            hasEquivalentJsonlMessage(
              prev,
              incoming,
              approxDedupOptions(provider),
            )
          ) {
            return prev;
          }
        }

        const result = mergeStreamMessage(prev, incoming);
        return usesApproxMessageDedup(provider)
          ? reconcileLinearMessages(
              result.messages,
              approxDedupOptions(provider),
            )
          : result.messages;
      });
    },
    [],
  );

  // Process a buffered stream subagent message
  const processStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      setAgentContent((prev) => {
        const existing = prev[agentId] ?? {
          messages: [],
          status: "running" as const,
        };
        if (shouldSuppressLiveStreamingMessage(incoming)) {
          const messages = clearStreamingMessages(existing.messages);
          if (messages === existing.messages) {
            return prev;
          }
          if (messages.length === 0 && existing.contextUsage === undefined) {
            const next = { ...prev };
            delete next[agentId];
            return next;
          }
          return {
            ...prev,
            [agentId]: {
              ...existing,
              messages,
            },
          };
        }
        const incomingId = getMessageId(incoming);
        if (findMessageIndexById(existing.messages, incomingId) !== -1) {
          return prev;
        }
        return {
          ...prev,
          [agentId]: {
            ...existing,
            messages: [...existing.messages, incoming],
            status: "running",
          },
        };
      });
    },
    [],
  );

  // Flush buffered stream messages after initial load
  const flushBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    streamBufferRef.current = [];
    for (const item of buffer) {
      if (item.type === "message") {
        processStreamMessage(item.msg, true);
      } else {
        processStreamSubagentMessage(item.msg, item.agentId);
      }
    }
  }, [processStreamMessage, processStreamSubagentMessage]);

  // Initial load. When a warm in-tab cache exists, the REST request is an
  // incremental refresh after the cached tail; merge that delta instead of
  // replacing the cached transcript.
  useEffect(() => {
    const warmLoad = readSessionLoadCache(
      projectId,
      sessionId,
      tailTurns,
      tailFrom,
    );
    markReloadPerfPhase("session_initial_load_start", {
      projectId,
      sessionId,
      tailCompactions: 2,
      tailTurns,
      tailFrom,
    });
    initialLoadCompleteRef.current = false;
    streamBufferRef.current = [];
    if (warmLoad) {
      maxPersistedTimestampMsRef.current = warmLoad.maxPersistedTimestampMs;
      providerRef.current = warmLoad.session.provider;
      lastMessageIdRef.current = warmLoad.lastMessageId;
      setMessages(warmLoad.messages);
      setAgentContent(warmLoad.agentContent);
      setToolUseToAgent(new Map(warmLoad.toolUseToAgentEntries));
      setSession(warmLoad.session);
      setPagination(warmLoad.pagination);
      setLoading(false);
    } else {
      maxPersistedTimestampMsRef.current = Number.NEGATIVE_INFINITY;
      providerRef.current = undefined;
      lastMessageIdRef.current = undefined;
      setLoading(true);
      setAgentContent({});
      setToolUseToAgent(new Map());
      setSession(null);
      setPagination(undefined);
    }

    api
      .getSession(projectId, sessionId, lastMessageIdRef.current, {
        tailCompactions: 2,
        tailTurns,
        tailFrom,
      })
      .then((data) => {
        markReloadPerfPhase("session_initial_load_data_ready", {
          messages: data.messages.length,
          provider: data.session.provider,
          totalMessages: data.pagination?.totalMessageCount,
          hasOlderMessages: data.pagination?.hasOlderMessages,
        });
        setSession(data.session);
        providerRef.current = data.session.provider;

        // Tag messages from JSONL as authoritative
        const taggedMessages = data.messages.map((m) => ({
          ...m,
          _source: "jsonl" as const,
        }));
        updatePersistedTimestampWatermark(taggedMessages);
        const warmMessages = warmLoad?.messages;
        const shouldMergeWarmDelta =
          warmMessages !== undefined && Boolean(lastMessageIdRef.current);
        const loadedMessages = shouldMergeWarmDelta
          ? (() => {
              const result = mergeJSONLMessages(warmMessages, taggedMessages, {
                skipDagOrdering: !getProvider(data.session.provider)
                  .capabilities.supportsDag,
              });
              return usesApproxMessageDedup(data.session.provider)
                ? reconcileLinearMessages(
                    result.messages,
                    approxDedupOptions(data.session.provider),
                  )
                : result.messages;
            })()
          : usesApproxMessageDedup(data.session.provider)
            ? reconcileLinearMessages(
                taggedMessages,
                approxDedupOptions(data.session.provider),
              )
            : taggedMessages;
        setMessages(loadedMessages);
        setPagination(data.pagination ?? warmLoad?.pagination);
        markReloadPerfPhase("session_initial_messages_state_queued", {
          messages: taggedMessages.length,
          totalMessages: loadedMessages.length,
          provider: data.session.provider,
        });

        // Update lastMessageIdRef synchronously to avoid race condition:
        // stream "connected" event calls fetchNewMessages() immediately, but the
        // useEffect that normally updates lastMessageIdRef runs asynchronously.
        // Without this, fetchNewMessages() would use undefined and refetch everything.
        const lastJsonlId = findLastJsonlMessageId(loadedMessages);
        if (lastJsonlId) {
          lastMessageIdRef.current = lastJsonlId;
        }

        // Mark ready and flush buffer
        initialLoadCompleteRef.current = true;
        flushBuffer();

        setLoading(false);
        markReloadPerfPhase("session_initial_load_complete", {
          messages: taggedMessages.length,
        });

        writeSessionLoadCache(
          projectId,
          sessionId,
          {
            messages: loadedMessages,
            session: data.session,
            pagination: data.pagination ?? warmLoad?.pagination,
            agentContent: {},
            toolUseToAgentEntries: [],
            lastMessageId: lastMessageIdRef.current,
            maxPersistedTimestampMs: maxPersistedTimestampMsRef.current,
          },
          tailTurns,
          tailFrom,
        );

        // Notify parent
        onLoadComplete?.({
          session: data.session,
          status: data.ownership,
          pendingInputRequest: data.pendingInputRequest,
          slashCommands: data.slashCommands,
        });
      })
      .catch((err) => {
        markReloadPerfPhase("session_initial_load_error", {
          message: err instanceof Error ? err.message : String(err),
        });
        setLoading(false);
        onLoadError?.(err);
      });
  }, [
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
    onLoadComplete,
    onLoadError,
    flushBuffer,
    updatePersistedTimestampWatermark,
  ]);

  // Handle streaming content updates (from useStreamingContent)
  const handleStreamingUpdate = useCallback(
    (streamingMessage: Message, agentId?: string) => {
      const messageId = getMessageId(streamingMessage);
      if (!messageId) return;

      if (agentId) {
        // Route to agentContent
        setAgentContent((prev) => {
          const existing = prev[agentId] ?? {
            messages: [],
            status: "running" as const,
          };
          const existingIdx = findMessageIndexById(
            existing.messages,
            messageId,
          );

          if (existingIdx >= 0) {
            const updated = [...existing.messages];
            updated[existingIdx] = streamingMessage;
            return { ...prev, [agentId]: { ...existing, messages: updated } };
          }
          return {
            ...prev,
            [agentId]: {
              ...existing,
              messages: [...existing.messages, streamingMessage],
            },
          };
        });
        return;
      }

      // Route to main messages
      setMessages((prev) => {
        const existingIdx = findMessageIndexById(prev, messageId);
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = streamingMessage;
          return updated;
        }
        return [...prev, streamingMessage];
      });
    },
    [],
  );

  // Handle stream message event (with buffering)
  const handleStreamMessageEvent = useCallback(
    (incoming: Message) => {
      if (!initialLoadCompleteRef.current) {
        streamBufferRef.current.push({ type: "message", msg: incoming });
        return;
      }
      processStreamMessage(incoming);
    },
    [processStreamMessage],
  );

  // Handle stream subagent message event (with buffering)
  const handleStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      if (!initialLoadCompleteRef.current) {
        streamBufferRef.current.push({
          type: "subagent",
          msg: incoming,
          agentId,
        });
        return;
      }
      processStreamSubagentMessage(incoming, agentId);
    },
    [processStreamSubagentMessage],
  );

  // Register toolUse → agent mapping
  const registerToolUseAgent = useCallback(
    (toolUseId: string, agentId: string) => {
      setToolUseToAgent((prev) => {
        if (prev.has(toolUseId)) return prev;
        const next = new Map(prev);
        next.set(toolUseId, agentId);
        return next;
      });
    },
    [],
  );

  const fetchNewMessagesInFlightRef = useRef<Promise<void> | null>(null);

  // Fetch new messages incrementally (for file change events)
  const fetchNewMessages = useCallback(() => {
    if (fetchNewMessagesInFlightRef.current) {
      return fetchNewMessagesInFlightRef.current;
    }

    const request = (async () => {
      try {
        const data = await api.getSession(
          projectId,
          sessionId,
          lastMessageIdRef.current,
        );
        if (data.messages.length > 0) {
          updatePersistedTimestampWatermark(data.messages);
          setMessages((prev) => {
            const result = mergeJSONLMessages(prev, data.messages, {
              skipDagOrdering: !getProvider(data.session.provider).capabilities
                .supportsDag,
            });
            return usesApproxMessageDedup(data.session.provider)
              ? reconcileLinearMessages(
                  result.messages,
                  approxDedupOptions(data.session.provider),
                )
              : result.messages;
          });
        }
        // Update session metadata (including title, model, contextUsage) which may have changed
        // For new sessions, prev may be null if JSONL didn't exist on initial load
        setSession((prev) =>
          prev ? { ...prev, ...data.session } : data.session,
        );
      } catch {
        // Silent fail for incremental updates
      }
    })();

    fetchNewMessagesInFlightRef.current = request;
    void request.finally(() => {
      if (fetchNewMessagesInFlightRef.current === request) {
        fetchNewMessagesInFlightRef.current = null;
      }
    });

    return request;
  }, [projectId, sessionId, updatePersistedTimestampWatermark]);

  // Load older messages (previous chunk before the current truncation point)
  const loadOlderMessages = useCallback(async () => {
    if (!pagination?.hasOlderMessages || !pagination.truncatedBeforeMessageId) {
      return;
    }
    setLoadingOlder(true);
    try {
      const data = await api.getSession(projectId, sessionId, undefined, {
        tailCompactions: 2,
        beforeMessageId: pagination.truncatedBeforeMessageId,
      });
      setMessages((prev) => {
        const taggedOlder = data.messages.map((m) => ({
          ...m,
          _source: "jsonl" as const,
        }));
        updatePersistedTimestampWatermark(taggedOlder);
        const combined = [...taggedOlder, ...prev];
        return usesApproxMessageDedup(data.session.provider)
          ? reconcileLinearMessages(
              combined,
              approxDedupOptions(data.session.provider),
            )
          : combined;
      });
      setPagination(data.pagination);
    } catch {
      // Silent fail for loading older messages
    } finally {
      setLoadingOlder(false);
    }
  }, [projectId, sessionId, pagination, updatePersistedTimestampWatermark]);

  // Fetch session metadata only
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      const metadataSession = {
        ...data.session,
        ownership: data.ownership,
      };
      // For new sessions, prev may be null if JSONL didn't exist on initial load
      setSession((prev) =>
        prev ? { ...prev, ...metadataSession } : metadataSession,
      );
    } catch {
      // Silent fail for metadata updates
    }
  }, [projectId, sessionId]);

  return {
    messages,
    agentContent,
    toolUseToAgent,
    loading,
    session,
    setSession,
    handleStreamingUpdate,
    handleStreamMessageEvent,
    handleStreamSubagentMessage,
    registerToolUseAgent,
    setAgentContent,
    setToolUseToAgent,
    setMessages,
    fetchNewMessages,
    fetchSessionMetadata,
    pagination,
    loadingOlder,
    loadOlderMessages,
  };
}
