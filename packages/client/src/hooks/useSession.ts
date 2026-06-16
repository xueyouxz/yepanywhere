import {
  type MarkdownAugment,
  type ContextUsage,
  type ProviderName,
  type SessionLivenessSnapshot,
  type UploadedFile,
  type UserMessageMetadata,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";
import { getMessageId } from "../lib/mergeMessages";
import { findPendingTasks } from "../lib/pendingTasks";
import { extractSessionIdFromFileEvent } from "../lib/sessionFile";
import type {
  InputRequest,
  Message,
  PermissionMode,
  SessionStatus,
} from "../types";
import {
  type FileChangeEvent,
  type ProcessStateEvent,
  type SessionMetadataChangedEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
  useFileActivity,
} from "./useFileActivity";
import {
  type SessionLoadResult,
  useSessionMessages,
} from "./useSessionMessages";
import { useSessionStream } from "./useSessionStream";
import { useSessionWatchStream } from "./useSessionWatchStream";
import {
  type StreamingMarkdownCallbacks,
  useStreamingContent,
} from "./useStreamingContent";
import { getStreamingEnabled } from "./useStreamingEnabled";

export type ProcessState = "idle" | "in-turn" | "waiting-input";

// Re-export types from useSessionMessages
export type { AgentContent, AgentContentMap } from "./useSessionMessages";

const THROTTLE_MS = 500;
const STREAM_ACTIVITY_TOKEN_UPDATE_MS = 500;
const STREAM_LIVENESS_UPDATE_MS = 500;
const FALLBACK_STREAM_LONG_SILENCE_THRESHOLD_MS = 300_000;
const RECAP_AWAY_THRESHOLD_MS = 5 * 60 * 1000;
const RECAP_REQUEST_COOLDOWN_MS = 30_000;

function hasUserVisibleStreamProgress(
  streamEvent: Record<string, unknown>,
): boolean {
  // "user-visible liveness": only content chunks that can render visible text/thinking
  // count as actual progress for stale->live transition.
  const eventType = streamEvent.type;
  if (typeof eventType !== "string") {
    return false;
  }

  if (eventType === "content_block_delta") {
    const delta = streamEvent.delta;
    if (!delta || typeof delta !== "object") {
      return false;
    }
    const text = (delta as Record<string, unknown>).text;
    const thinking = (delta as Record<string, unknown>).thinking;
    return (
      (typeof text === "string" && text.length > 0) ||
      (typeof thinking === "string" && thinking.length > 0)
    );
  }

  if (eventType === "content_block_start") {
    const contentBlock = streamEvent.content_block;
    if (!contentBlock || typeof contentBlock !== "object") {
      return false;
    }
    const text = (contentBlock as Record<string, unknown>).text;
    const thinking = (contentBlock as Record<string, unknown>).thinking;
    return (
      (typeof text === "string" && text.length > 0) ||
      (typeof thinking === "string" && thinking.length > 0)
    );
  }

  return false;
}

function getContextUsageFromTokenUsageMessage(
  message: Record<string, unknown>,
  fallbackModel?: string,
  fallbackProvider?: ProviderName,
): ContextUsage | undefined {
  const usage =
    message.usage && typeof message.usage === "object"
      ? (message.usage as Record<string, unknown>)
      : null;
  const inputTokens =
    usage && typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  if (inputTokens === null) {
    return undefined;
  }

  const outputTokens =
    usage && typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : undefined;
  const cacheReadTokens =
    usage && typeof usage.cached_input_tokens === "number"
      ? usage.cached_input_tokens
      : undefined;

  const contextWindowCandidate =
    message.model_context_window &&
    typeof message.model_context_window === "number" &&
    Number.isFinite(message.model_context_window)
      ? message.model_context_window
      : getModelContextWindow(fallbackModel, fallbackProvider);
  const contextWindow =
    contextWindowCandidate > 0 ? contextWindowCandidate : undefined;

  return {
    inputTokens,
    percentage:
      contextWindow && contextWindow > 0
        ? (inputTokens / contextWindow) * 100
        : 0,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
}

function parseProcessState(value: unknown): ProcessState | null {
  if (
    value === "idle" ||
    value === "in-turn" ||
    value === "waiting-input"
  ) {
    return value;
  }
  return null;
}

// Re-export StreamingMarkdownCallbacks for consumers
export type { StreamingMarkdownCallbacks } from "./useStreamingContent";

/** Pending message waiting for server confirmation */
export interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  clientOrder?: number;
  /** Display status text (e.g. "Uploading...", "Sending..."). Defaults to "Sending..." */
  status?: string;
  attachments?: UploadedFile[];
}

/**
 * Deferred message queued server-side, waiting for the agent's turn to end.
 *
 * This is a pure mirror of the server's queue summary — the client never
 * persists it, never reconciles it by text, and never adds delivery states of
 * its own. The server is the single source of truth.
 */
export interface DeferredMessage {
  tempId?: string;
  content: string;
  timestamp: string;
  metadata?: UserMessageMetadata;
  attachmentCount?: number;
  attachments?: UploadedFile[];
}

const CONCATENATED_USER_TURN_SEPARATOR = "\n\n--------\n\n";
const USER_ECHO_CLOCK_SKEW_MS = 60_000;

// Older transcripts can contain a leading relative-time marker on queued turns,
// e.g. "(343s ago)" or "(13s later)" (optionally preceded by a "---" rule).
// That prefix was never part of the user's typed text, so strip it before
// matching a delivered turn against a persisted queued message.
const QUEUED_TURN_TIME_MARKER = /^(?:-{2,}\s*)?\(\d+\w* (?:ago|later)\)\s*/;

function stripQueuedTurnTimeMarker(text: string): string {
  return text.replace(QUEUED_TURN_TIME_MARKER, "");
}

function parseMessageTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function extractUserMessageText(
  sdkMessage: Record<string, unknown>,
): string | null {
  const message = sdkMessage.message as
    | { content?: unknown; role?: unknown }
    | undefined;
  const content = message?.content ?? sdkMessage.content;

  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter((part) => part.length > 0);
    if (textParts.length === 0) return null;
    const joined = textParts.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }

  return null;
}

function userTextContainsDeferredContent(
  userText: string,
  deferredContent: string,
): boolean {
  const normalizedUserText = userText.trim();
  const normalizedDeferredContent = deferredContent.trim();
  if (!normalizedUserText || !normalizedDeferredContent) {
    return false;
  }

  // A delivered chunk matches when, after dropping any legacy time marker, it
  // equals the queued text or begins with it (a queued message may itself be
  // multi-paragraph, hence the trailing "\n\n" prefix form).
  const partMatches = (part: string): boolean => {
    const normalizedPart = stripQueuedTurnTimeMarker(part.trim());
    return (
      normalizedPart === normalizedDeferredContent ||
      normalizedPart.startsWith(`${normalizedDeferredContent}\n\n`)
    );
  };

  if (partMatches(normalizedUserText)) {
    return true;
  }

  return normalizedUserText
    .split(CONCATENATED_USER_TURN_SEPARATOR)
    .some(partMatches);
}

const PERMISSION_MODE_KEY_PREFIX = "permission-mode-";

function getPermissionModeStorageKey(sessionId: string): string {
  return `${PERMISSION_MODE_KEY_PREFIX}${sessionId}`;
}

// The UI-selected permission mode is persisted per session so a page reload or
// server-process teardown restores the user's choice instead of silently
// dropping to "default" — which would re-enable provider sandboxing and approval
// prompts the user had deliberately turned off.
function loadStoredPermissionMode(
  sessionId: string,
): PermissionMode | undefined {
  if (typeof localStorage === "undefined") {
    return undefined;
  }
  try {
    const raw = localStorage.getItem(getPermissionModeStorageKey(sessionId));
    return raw === "default" ||
      raw === "acceptEdits" ||
      raw === "plan" ||
      raw === "bypassPermissions"
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

function saveStoredPermissionMode(
  sessionId: string,
  mode: PermissionMode,
): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(getPermissionModeStorageKey(sessionId), mode);
  } catch {
    // localStorage may be unavailable or full; the in-memory mode still applies
    // for the current page.
  }
}

function removeEchoedQueueMessage<
  T extends { tempId?: string; content: string },
>(messages: T[], tempIds?: string[], incomingText?: string | null): T[] {
  let next = messages;
  if (tempIds?.length) {
    const ids = new Set(tempIds);
    next = next.filter(
      (message) => !(message.tempId && ids.has(message.tempId)),
    );
  }

  if (!incomingText) {
    return next;
  }

  return next.filter(
    (message) =>
      !userTextContainsDeferredContent(incomingText, message.content),
  );
}

function userTurnMatchesPending(
  message: Message,
  pending: PendingMessage,
): boolean {
  if (message.type !== "user" && message.role !== "user") {
    return false;
  }
  if (message.tempId === pending.tempId) {
    return true;
  }

  const text = extractUserMessageText(message as Record<string, unknown>);
  if (!text || !userTextContainsDeferredContent(text, pending.content)) {
    return false;
  }

  const messageTimestampMs = parseMessageTimestampMs(message.timestamp);
  const pendingTimestampMs = parseMessageTimestampMs(pending.timestamp);
  if (messageTimestampMs === null || pendingTimestampMs === null) {
    return false;
  }

  return messageTimestampMs + USER_ECHO_CLOCK_SKEW_MS >= pendingTimestampMs;
}

function removeDeliveredPendingMessages(
  pendingMessages: PendingMessage[],
  messages: Message[],
): PendingMessage[] {
  if (pendingMessages.length === 0 || messages.length === 0) {
    return pendingMessages;
  }

  const recentMessages = messages.slice(-30);
  const filtered = pendingMessages.filter(
    (pending) =>
      !recentMessages.some((message) =>
        userTurnMatchesPending(message, pending),
      ),
  );
  return filtered.length === pendingMessages.length
    ? pendingMessages
    : filtered;
}

export function useSession(
  projectId: string,
  sessionId: string,
  initialStatus?: {
    owner: "self";
    processId: string;
    permissionMode?: PermissionMode;
    modeVersion?: number;
  },
  streamingMarkdownCallbacks?: StreamingMarkdownCallbacks,
  options?: { tailTurns?: number; tailFrom?: string },
) {
  // Use initial status if provided (from navigation state) to connect stream immediately
  const [status, setStatus] = useState<SessionStatus>(
    initialStatus ?? { owner: "none" },
  );
  // If we have initial status, assume process is in-turn (just started)
  const [processState, setProcessState] = useState<ProcessState>(
    initialStatus ? "in-turn" : "idle",
  );
  const [pendingInputRequest, setPendingInputRequest] =
    useState<InputRequest | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Actual session ID from server (may differ from URL sessionId during temp→real ID transition)
  // This happens when createSession returns before the SDK sends the real session ID
  const [actualSessionId, setActualSessionId] = useState<string>(sessionId);

  // Track last stream activity timestamp for engagement tracking
  // This includes both main session and subagent messages, so we can properly
  // mark sessions as "seen" even when subagent content arrives (which doesn't
  // update the parent session file's mtime until completion)
  const [lastStreamActivityAt, setLastStreamActivityAt] = useState<
    string | null
  >(null);
  const streamActivityRef = useRef<{
    lastUpdateMs: number;
    pendingIso: string | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({
    lastUpdateMs: Number.NEGATIVE_INFINITY,
    pendingIso: null,
    timer: null,
  });

  const noteStreamActivity = useCallback((immediate = false) => {
    const nowMs = Date.now();
    const iso = new Date(nowMs).toISOString();
    const ref = streamActivityRef.current;
    const elapsedMs = nowMs - ref.lastUpdateMs;

    if (immediate || elapsedMs >= STREAM_ACTIVITY_TOKEN_UPDATE_MS) {
      if (ref.timer) {
        clearTimeout(ref.timer);
        ref.timer = null;
      }
      ref.pendingIso = null;
      ref.lastUpdateMs = nowMs;
      setLastStreamActivityAt(iso);
      return;
    }

    ref.pendingIso = iso;
    if (!ref.timer) {
      ref.timer = setTimeout(() => {
        const pendingIso = ref.pendingIso;
        ref.pendingIso = null;
        ref.timer = null;
        ref.lastUpdateMs = Date.now();
        if (pendingIso) {
          setLastStreamActivityAt(pendingIso);
        }
      }, STREAM_ACTIVITY_TOKEN_UPDATE_MS - elapsedMs);
    }
  }, []);

  const buildStreamProgressLiveness = useCallback(
    (nowMs: number, previous: SessionLivenessSnapshot | null) => {
      const now = new Date(nowMs).toISOString();
      const previousEvidence = previous?.evidence ?? [];
      const evidence = Array.from(
        new Set([...previousEvidence, "stream_event"]),
      );

      return {
        checkedAt: now,
        derivedStatus: "verified-progressing" as const,
        activeWorkKind: previous?.activeWorkKind ?? "agent-turn",
        state: previous?.state ?? "in-turn",
        evidence,
        lastProviderMessageAt: previous?.lastProviderMessageAt ?? null,
        lastRawProviderEventAt: now,
        lastRawProviderEventSource: "stream_event",
        lastStateChangeAt: previous?.lastStateChangeAt ?? now,
        lastVerifiedProgressAt: now,
        lastVerifiedIdleAt: previous?.lastVerifiedIdleAt ?? null,
        lastLivenessProbeAt: previous?.lastLivenessProbeAt ?? null,
        lastLivenessProbeStatus: previous?.lastLivenessProbeStatus ?? null,
        lastLivenessProbeSource: previous?.lastLivenessProbeSource ?? null,
        ...(previous?.lastLivenessProbeDetail
          ? { lastLivenessProbeDetail: previous.lastLivenessProbeDetail }
          : {}),
        silenceMs: 0,
        longSilenceThresholdMs:
          previous?.longSilenceThresholdMs ??
          FALLBACK_STREAM_LONG_SILENCE_THRESHOLD_MS,
        processAlive: previous?.processAlive ?? true,
        queueDepth: previous?.queueDepth ?? 0,
        deferredQueueDepth: previous?.deferredQueueDepth ?? 0,
      };
    },
    [],
  );

  const noteStreamProgressLiveness = useCallback(() => {
    const nowMs = Date.now();

    setSessionLiveness((previous) => {
      const nowVerifiedProgressMs = Date.parse(
        previous?.lastVerifiedProgressAt ?? previous?.checkedAt ?? "",
      );

      if (
        previous &&
        previous.derivedStatus === "verified-progressing" &&
        Number.isFinite(nowVerifiedProgressMs) &&
        nowMs - nowVerifiedProgressMs < STREAM_LIVENESS_UPDATE_MS
      ) {
        return previous;
      }

      return buildStreamProgressLiveness(nowMs, previous);
    });
  }, [buildStreamProgressLiveness]);

  useEffect(() => {
    return () => {
      const timer = streamActivityRef.current.timer;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  // Pending messages queue - messages waiting for server confirmation
  // These are displayed separately from the main message list
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);

  // Deferred messages queue — a pure mirror of the server's queue summary.
  // The server is authoritative: the client never persists this or reconciles
  // it by text. It is replaced wholesale whenever the server reports new state
  // (connected event, deferred-queue event, or a queue/cancel REST response).
  const [deferredMessages, setDeferredMessages] = useState<DeferredMessage[]>(
    [],
  );

  // Reset when switching sessions; the server's connected event repopulates it.
  useEffect(() => {
    setDeferredMessages([]);
  }, [sessionId]);

  // Compacting state - true when context is being compressed
  const [isCompacting, setIsCompacting] = useState(false);
  const [sessionLiveness, setSessionLiveness] =
    useState<SessionLivenessSnapshot | null>(null);

  // Markdown augments loaded from REST response (keyed by message ID)
  const [markdownAugments, setMarkdownAugments] = useState<
    Record<string, MarkdownAugment>
  >({});

  // Permission mode state: localMode is UI-selected, serverMode is confirmed by server.
  // A live process's mode (from initialStatus) stays authoritative; only when there
  // is no live-process mode do we restore the user's last choice from storage instead
  // of dropping to "default".
  const initialPermissionMode =
    initialStatus?.permissionMode ??
    loadStoredPermissionMode(sessionId) ??
    "default";
  const initialModeVersion = initialStatus?.modeVersion ?? 0;
  const [localMode, setLocalMode] =
    useState<PermissionMode>(initialPermissionMode);
  const [, setServerMode] = useState<PermissionMode>(initialPermissionMode);
  const [modeVersion, setModeVersion] =
    useState<number>(initialModeVersion);
  const localModeRef = useRef<PermissionMode>(localMode);
  // In-place session switches reuse this hook instance (page reloads remount it and
  // use the initializer above). Restore the switched-to session's stored mode, but
  // skip the initial mount so a live process's authoritative mode is not clobbered.
  const restoredModeSessionRef = useRef(sessionId);
  useEffect(() => {
    if (restoredModeSessionRef.current === sessionId) {
      return;
    }
    restoredModeSessionRef.current = sessionId;
    setLocalMode(loadStoredPermissionMode(sessionId) ?? "default");
  }, [sessionId]);
  // Track whether we've already processed a stream "connected" event in this mount.
  // For Codex providers, the first connected-event catch-up fetch can duplicate
  // freshly streamed messages because JSONL and stream IDs are not yet aligned.
  const hasHandledConnectedEventRef = useRef(false);
  const hiddenSinceMsRef = useRef<number | null>(null);
  const lastRecapRequestMsRef = useRef<number | null>(null);
  const liveProcessId = status.owner === "self" ? status.processId : null;

  // Reset connected-event tracking when switching sessions.
  useEffect(() => {
    hasHandledConnectedEventRef.current = false;
    setSessionLiveness(null);
  }, [sessionId]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      const nowMs = Date.now();
      if (document.visibilityState === "hidden") {
        hiddenSinceMsRef.current = nowMs;
        return;
      }
      if (document.visibilityState !== "visible") {
        return;
      }

      const hiddenSinceMs = hiddenSinceMsRef.current;
      hiddenSinceMsRef.current = null;
      if (hiddenSinceMs === null || !liveProcessId) {
        return;
      }

      const hiddenDurationMs = nowMs - hiddenSinceMs;
      const previousRequestMs = lastRecapRequestMsRef.current;
      const isCoolingDown =
        previousRequestMs !== null &&
        nowMs - previousRequestMs < RECAP_REQUEST_COOLDOWN_MS;
      if (hiddenDurationMs < RECAP_AWAY_THRESHOLD_MS || isCoolingDown) {
        return;
      }

      lastRecapRequestMsRef.current = nowMs;
      void api.requestRecap(liveProcessId, hiddenSinceMs).catch((error) => {
        console.warn("Failed to request recap:", error);
      });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [liveProcessId]);

  // Slash commands available for this session (from init message)
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  // Tools available for this session (from init message)
  const [sessionTools, setSessionTools] = useState<string[]>([]);
  // MCP servers available for this session (from init message)
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const lastKnownModeVersionRef = useRef<number>(initialModeVersion);

  useEffect(() => {
    localModeRef.current = localMode;
  }, [localMode]);

  // Apply server mode update only if version is >= our last known version
  // This syncs local mode only when the server update is authoritative.
  const applyServerModeUpdate = useCallback(
    (mode: PermissionMode, version: number) => {
      if (version >= lastKnownModeVersionRef.current) {
        lastKnownModeVersionRef.current = version;
        setServerMode(mode);
        setModeVersion(version);
        localModeRef.current = mode;
        setLocalMode(mode);
        saveStoredPermissionMode(sessionId, mode);
      }
    },
    [sessionId],
  );

  // Handle initial load completion from useSessionMessages
  const handleLoadComplete = useCallback(
    (result: SessionLoadResult) => {
      // Only update status from REST if we don't already have an owned status from navigation.
      // This prevents a race condition where:
      // 1. Session created with initialStatus = {owner: "self"}
      // 2. stream connects because status.owner === "self"
      // 3. REST API returns status = {owner: "none"} (stale)
      // 4. setStatus({owner: "none"}) disconnects stream before it receives events
      // The owned status from initialStatus should only be changed by stream events.
      setStatus((prev) => {
        // If we already have owned status (from initialStatus), keep it unless REST also says owned
        if (prev.owner === "self" && result.status.owner !== "self") {
          return prev;
        }
        return result.status;
      });

      // Sync permission mode from server if owned
      if (
        result.status.owner === "self" &&
        result.status.permissionMode &&
        result.status.modeVersion !== undefined
      ) {
        applyServerModeUpdate(
          result.status.permissionMode,
          result.status.modeVersion,
        );
      }
      // Set pending input request from API response immediately
      // This fixes race condition where stream connection is delayed but tool approval is pending
      if (result.pendingInputRequest) {
        setPendingInputRequest(result.pendingInputRequest as InputRequest);
      }
      // Set slash commands from API response so the "/" button appears reliably.
      // The SSE init message that normally carries these is discarded after
      // ~30s; stopped providers with static commands also rely on this payload.
      setSlashCommands(result.slashCommands?.map((c) => c.name) ?? []);
    },
    [applyServerModeUpdate],
  );

  // Handle initial load error
  const handleLoadError = useCallback((err: Error) => {
    setError(err);
  }, []);

  // Use the session messages hook for message state and stream buffering
  const {
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
    pagination,
    loadingOlder,
    loadOlderMessages,
  } = useSessionMessages({
    projectId,
    sessionId,
    tailTurns: options?.tailTurns,
    tailFrom: options?.tailFrom,
    onLoadComplete: handleLoadComplete,
    onLoadError: handleLoadError,
  });
  const nextClientOrderRef = useRef(0);

  useEffect(() => {
    nextClientOrderRef.current = 0;
  }, [sessionId]);

  // Optimistic pending sends (the normal-send flow) reconcile against the
  // transcript by content. Deferred messages do not: the server removes them
  // from its queue and pushes the updated list, which we mirror directly.
  useEffect(() => {
    setPendingMessages((prev) =>
      removeDeliveredPendingMessages(prev, messages),
    );
  }, [messages]);

  // Update local mode (UI selection) and sync to server if process is active
  const setPermissionMode = useCallback(
    async (mode: PermissionMode) => {
      localModeRef.current = mode;
      setLocalMode(mode);
      saveStoredPermissionMode(sessionId, mode);

      // If there's an active process, immediately sync to server
      if (status.owner === "self" || status.owner === "external") {
        try {
          const result = await api.setPermissionMode(sessionId, mode);
          // Update server-confirmed mode
          if (result.modeVersion >= lastKnownModeVersionRef.current) {
            lastKnownModeVersionRef.current = result.modeVersion;
            setServerMode(result.permissionMode);
            setModeVersion(result.modeVersion);
          }
        } catch (err) {
          // If API fails (e.g., no active process), mode will be sent on next message
          console.warn("Failed to sync permission mode:", err);
        }
      }
    },
    [sessionId, status.owner],
  );

  // Throttle state for incremental fetching
  const throttleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: boolean;
  }>({ timer: null, pending: false });

  // Add a message to the pending queue
  // Generates a tempId that will be sent to the server and echoed back in stream
  const addPendingMessage = useCallback(
    (
      content: string,
      attachments?: UploadedFile[],
      timestamp = new Date().toISOString(),
    ): { tempId: string; clientOrder: number } => {
      const clientOrder = nextClientOrderRef.current++;
      const tempId = `temp-${Date.now()}-${clientOrder}`;
      logSessionUiTrace("pending-add", {
        sessionId,
        tempId,
        clientOrder,
        textLength: content.length,
      });
      setPendingMessages((prev) => [
        ...prev,
        {
          tempId,
          content,
          timestamp,
          clientOrder,
          ...(attachments?.length ? { attachments } : {}),
        },
      ]);
      return { tempId, clientOrder };
    },
    [sessionId],
  );

  // Remove a pending message by tempId (used when server confirms or send fails)
  const removePendingMessage = useCallback(
    (tempId: string) => {
      logSessionUiTrace("pending-remove", { sessionId, tempId });
      setPendingMessages((prev) => prev.filter((p) => p.tempId !== tempId));
    },
    [sessionId],
  );

  // Update a pending message's fields (e.g. status text)
  const updatePendingMessage = useCallback(
    (tempId: string, updates: Partial<PendingMessage>) => {
      logSessionUiTrace("pending-update", {
        sessionId,
        tempId,
        hasStatus: updates.status !== undefined,
      });
      setPendingMessages((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, ...updates } : p)),
      );
    },
    [sessionId],
  );

  // Track if we've loaded pending agents for this session
  const pendingAgentsLoadedRef = useRef<string | null>(null);

  // Load pending agent content on session load
  // This handles page reload while Tasks are running: loads agent content-so-far
  useEffect(() => {
    // Only run once per session after initial load
    if (loading || pendingAgentsLoadedRef.current === sessionId) return;
    if (messages.length === 0) return;

    const loadPendingAgents = async () => {
      // Mark as loaded to prevent re-running
      pendingAgentsLoadedRef.current = sessionId;

      // Find pending Tasks (tool_use without matching tool_result)
      const pendingTasks = findPendingTasks(messages);
      if (pendingTasks.length === 0) return;

      try {
        // Get agent mappings (toolUseId → agentId)
        const { mappings } = await api.getAgentMappings(projectId, sessionId);
        const mappingsMap = new Map(
          mappings.map((m) => [m.toolUseId, m.agentId]),
        );

        // Update the toolUseToAgent state with loaded mappings
        // This allows TaskRenderer to access agentContent even after page reload
        setToolUseToAgent((prev) => {
          const next = new Map(prev);
          for (const [toolUseId, agentId] of mappingsMap) {
            if (!next.has(toolUseId)) {
              next.set(toolUseId, agentId);
            }
          }
          return next;
        });

        // Load content for each pending task that has an agent file
        for (const task of pendingTasks) {
          const agentId = mappingsMap.get(task.toolUseId);
          if (!agentId) continue;

          try {
            const agentData = await api.getAgentSession(
              projectId,
              sessionId,
              agentId,
            );

            // Merge into agentContent state, deduping by message ID
            // Use getMessageId to prefer uuid over id
            setAgentContent((prev) => {
              const existing = prev[agentId];
              if (existing && existing.messages.length > 0) {
                // Already have content (maybe from stream), merge without duplicates
                const existingIds = new Set(
                  existing.messages.map((m) => getMessageId(m)),
                );
                const newMessages = agentData.messages.filter(
                  (m) => !existingIds.has(getMessageId(m)),
                );
                return {
                  ...prev,
                  [agentId]: {
                    messages: [...existing.messages, ...newMessages],
                    status: agentData.status,
                  },
                };
              }
              // No existing content, use loaded data
              return {
                ...prev,
                [agentId]: agentData,
              };
            });
          } catch {
            // Skip agents that can't be loaded
          }
        }
      } catch {
        // Silent fail for agent mappings - not critical
      }
    };

    loadPendingAgents();
  }, [
    loading,
    messages,
    projectId,
    sessionId,
    setAgentContent,
    setToolUseToAgent,
  ]);

  // Leading + trailing edge throttle:
  // - Leading: fires immediately on first call
  // - Trailing: fires again after timeout if events came during window
  // This ensures no updates are lost
  const throttledFetch = useCallback(() => {
    const ref = throttleRef.current;

    if (!ref.timer) {
      // No active throttle - fire immediately (LEADING EDGE)
      fetchNewMessages();
      ref.timer = setTimeout(() => {
        ref.timer = null;
        if (ref.pending) {
          ref.pending = false;
          throttledFetch(); // Fire again (TRAILING EDGE)
        }
      }, THROTTLE_MS);
    } else {
      // Throttled - mark as pending for trailing edge
      ref.pending = true;
    }
  }, [fetchNewMessages]);

  // Handle file changes - for non-owned sessions only
  // For owned sessions, stream provides real-time messages and session-updated events
  // provide metadata (title, messageCount), so we don't need to poll the API
  const handleFileChange = useCallback(
    (event: FileChangeEvent) => {
      // Only care about session files
      if (event.fileType !== "session" && event.fileType !== "agent-session") {
        return;
      }

      // Check if file matches current session (exact match to avoid false positives)
      // File format is: projects/<projectId>/<sessionId>.jsonl
      const fileSessionId = extractSessionIdFromFileEvent(event);
      if (fileSessionId !== sessionId) {
        return;
      }

      // For owned sessions: messages come via stream stream, metadata via session-updated event
      // No API call needed - skip file change processing entirely
      if (status.owner === "self") {
        return;
      }

      // For external/idle sessions: fetch both messages and metadata via API
      throttledFetch();
    },
    [sessionId, status.owner, throttledFetch],
  );

  // Handle session content updates via stream (title, messageCount, updatedAt, contextUsage)
  const handleSessionUpdated = useCallback(
    (event: SessionUpdatedEvent) => {
      if (event.sessionId !== sessionId) return;

      // Update session metadata from stream event (no API call needed)
      setSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ...(event.title !== undefined && { title: event.title }),
          ...(event.messageCount !== undefined && {
            messageCount: event.messageCount,
          }),
          ...(event.updatedAt !== undefined && {
            updatedAt: event.updatedAt,
          }),
          ...(event.contextUsage !== undefined && {
            contextUsage: event.contextUsage,
          }),
          ...(event.model !== undefined && { model: event.model }),
        };
      });
    },
    [sessionId, setSession],
  );

  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      if (event.sessionId !== sessionId) return;

      setSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ...(event.title !== undefined && { customTitle: event.title }),
          ...(event.archived !== undefined && { isArchived: event.archived }),
          ...(event.starred !== undefined && { isStarred: event.starred }),
          ...(event.parentSessionId !== undefined && {
            parentSessionId: event.parentSessionId ?? undefined,
          }),
          ...(event.heartbeatTurnsEnabled !== undefined && {
            heartbeatTurnsEnabled: event.heartbeatTurnsEnabled,
          }),
          ...(event.heartbeatTurnsAfterMinutes !== undefined && {
            heartbeatTurnsAfterMinutes:
              event.heartbeatTurnsAfterMinutes ?? undefined,
          }),
          ...(event.heartbeatTurnText !== undefined && {
            heartbeatTurnText: event.heartbeatTurnText ?? undefined,
          }),
          ...(event.heartbeatForceAfterMinutes !== undefined && {
            heartbeatForceAfterMinutes:
              event.heartbeatForceAfterMinutes ?? undefined,
          }),
          ...(event.promptSuggestionMode !== undefined && {
            promptSuggestionMode: event.promptSuggestionMode,
          }),
        };
      });
    },
    [sessionId, setSession],
  );

  // Listen for session status changes via stream
  const handleSessionStatusChange = useCallback(
    (event: SessionStatusEvent) => {
      if (event.sessionId !== sessionId) return;

      const ownershipDropped =
        status.owner !== "none" && event.ownership.owner === "none";

      logSessionUiTrace("activity-session-status", {
        sessionId,
        previousOwner: status.owner,
        nextOwner: event.ownership.owner,
        processId:
          event.ownership.owner === "self" ? event.ownership.processId : null,
        permissionMode:
          event.ownership.owner === "self"
            ? event.ownership.permissionMode
            : null,
      });
      setStatus(event.ownership);

      if (ownershipDropped) {
        setProcessState("idle");
        setPendingInputRequest(null);
        throttledFetch();
      }
    },
    [sessionId, status.owner, throttledFetch],
  );

  // Listen for process state changes via activity bus as a backup for session stream
  // This handles the race condition where the session stream might miss a status event
  // (e.g., when backgrounding the tab quickly after starting a session)
  const handleProcessStateChange = useCallback(
    async (event: ProcessStateEvent) => {
      if (event.sessionId !== sessionId) return;

      // Update process state from activity bus
      if (
        event.activity === "idle" ||
        event.activity === "in-turn" ||
        event.activity === "waiting-input"
      ) {
        logSessionUiTrace("activity-process-state", {
          sessionId,
          activity: event.activity,
          pendingInputType: event.pendingInputType ?? null,
        });
        setProcessState(event.activity);
      }

      // If activity bus says waiting-input but we don't have the request,
      // fetch it via REST as a backup
      if (event.activity === "waiting-input" && event.pendingInputType) {
        setPendingInputRequest((current) => {
          if (current) return current; // Already have it, don't fetch

          // Fetch pending request in background (can't return promise from setState)
          api.getSessionMetadata(projectId, sessionId).then((result) => {
            if (result.pendingInputRequest) {
              setPendingInputRequest(result.pendingInputRequest);
            }
          });

          return current; // Return unchanged for now, will update when fetch completes
        });
      }
    },
    [projectId, sessionId],
  );

  // Handle activity bus reconnection (e.g., after phone screen wake).
  // Catches up on messages and ownership changes that occurred while disconnected.
  // Without this, a session that completed while the screen was off would show stale
  // data because the session stream unsubscribes when ownership becomes "none" and
  // nobody triggers fetchNewMessages().
  const handleActivityReconnect = useCallback(async () => {
    fetchNewMessages();
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      const metadataProcessState = parseProcessState(data.processState);
      setStatus(data.ownership);
      if (metadataProcessState) {
        setProcessState(metadataProcessState);
      }
      if (data.ownership.owner === "none") {
        setProcessState("idle");
        setPendingInputRequest(null);
      } else if (
        metadataProcessState === "waiting-input" &&
        data.pendingInputRequest
      ) {
        setPendingInputRequest(data.pendingInputRequest);
      } else if (
        metadataProcessState &&
        metadataProcessState !== "waiting-input"
      ) {
        setPendingInputRequest(null);
      }
    } catch {
      // Silent fail - non-critical
    }
  }, [projectId, sessionId, fetchNewMessages]);

  useFileActivity({
    onSessionStatusChange: handleSessionStatusChange,
    onFileChange: handleFileChange,
    onSessionMetadataChange: handleSessionMetadataChange,
    onSessionUpdated: handleSessionUpdated,
    onProcessStateChange: handleProcessStateChange,
    onReconnect: handleActivityReconnect,
  });

  // Focused watch stream for non-owned sessions.
  // This is a targeted server-side watch of the currently viewed session file,
  // independent from broad global activity-tree watch behavior.
  const handleSessionWatchChange = useCallback(() => {
    if (status.owner === "self") return;
    throttledFetch();
  }, [status.owner, throttledFetch]);

  const { connected: sessionWatchConnected } = useSessionWatchStream(
    status.owner !== "self"
      ? {
          sessionId,
          projectId,
          provider: session?.provider,
        }
      : null,
    {
      onChange: handleSessionWatchChange,
    },
  );

  // Cleanup throttle timers
  useEffect(() => {
    return () => {
      if (throttleRef.current.timer) {
        clearTimeout(throttleRef.current.timer);
      }
    };
  }, []);

  // Callback for agent context usage updates
  const handleAgentContextUsage = useCallback(
    (agentId: string, usage: { inputTokens: number; percentage: number }) => {
      setAgentContent((prev) => {
        const existing = prev[agentId] ?? {
          messages: [],
          status: "running",
        };
        return {
          ...prev,
          [agentId]: { ...existing, contextUsage: usage },
        };
      });
    },
    [setAgentContent],
  );

  // Use streaming content hook for handling stream_event stream messages
  const {
    handleStreamEvent,
    clearStreaming,
    cleanup: cleanupStreaming,
  } = useStreamingContent({
    onUpdateMessage: handleStreamingUpdate,
    onToolUseMapping: registerToolUseAgent,
    onAgentContextUsage: handleAgentContextUsage,
    contextWindowSize: getModelContextWindow(session?.model, session?.provider),
    streamingMarkdownCallbacks,
  });

  // Cleanup streaming timers on unmount
  useEffect(() => {
    return () => {
      cleanupStreaming();
    };
  }, [cleanupStreaming]);

  // Subscribe to live updates
  const handleStreamMessage = useCallback(
    (data: { eventType: string; [key: string]: unknown }) => {
      logSessionUiTrace("session-stream-dispatch", {
        sessionId,
        eventType: data.eventType,
        sdkType: typeof data.type === "string" ? data.type : undefined,
        subtype: typeof data.subtype === "string" ? data.subtype : undefined,
        state: typeof data.state === "string" ? data.state : undefined,
        tempId: typeof data.tempId === "string" ? data.tempId : undefined,
      });
      if (data.eventType === "message") {
        // The message event contains the SDK message directly
        // Pass through all fields without stripping
        const sdkMessage = data as Record<string, unknown> & {
          eventType: string;
        };

        // Extract id - prefer uuid, fall back to id field, then generate
        const rawUuid = sdkMessage.uuid;
        const rawId = sdkMessage.id;
        const id: string =
          (typeof rawUuid === "string" ? rawUuid : null) ??
          (typeof rawId === "string" ? rawId : null) ??
          `msg-${Date.now()}`;

        // Extract type and role
        const msgType =
          typeof sdkMessage.type === "string" ? sdkMessage.type : undefined;
        const msgRole = sdkMessage.role as Message["role"] | undefined;
        const isLiveStreamingUpdate =
          msgType === "stream_event" || sdkMessage._isStreaming === true;
        const hasUserVisibleLiveness =
          msgType === "stream_event" &&
          hasUserVisibleStreamProgress(
            (sdkMessage.event as Record<string, unknown>) ?? {},
          );

        // Track stream activity for engagement/freshness UI. Queue state,
        // status, and full user/assistant messages stay immediate; live
        // token/delta freshness is coalesced.
        noteStreamActivity(!isLiveStreamingUpdate);

        if (hasUserVisibleLiveness) {
          noteStreamProgressLiveness();
        }

        // Handle stream_event messages (partial content from streaming API)
        // Delegate to useStreamingContent hook
        if (msgType === "stream_event") {
          if (handleStreamEvent(sdkMessage)) {
            return; // Event was handled, don't process as regular message
          }
        }

        // Predicted next-user-prompt suggestion: store and don't add to message list
        if (msgType === "prompt_suggestion") {
          const suggestion = sdkMessage.suggestion;
          if (typeof suggestion === "string" && suggestion.trim()) {
            setPromptSuggestion(suggestion);
          }
          return;
        }

        // For assistant messages, clear streaming state and remove ALL streaming placeholders
        if (msgType === "assistant") {
          // Check if this is a subagent message
          // Use parentToolUseId as the routing key (it's the Task tool_use id)
          const isSubagentMsg =
            sdkMessage.isSubagent &&
            typeof sdkMessage.parentToolUseId === "string";
          const msgAgentId = isSubagentMsg
            ? (sdkMessage.parentToolUseId as string)
            : undefined;

          // Clear streaming state via hook
          clearStreaming();

          if (msgAgentId) {
            // Remove streaming placeholders from this agent's content
            setAgentContent((prev) => {
              const existing = prev[msgAgentId];
              if (!existing) return prev;
              const filtered = existing.messages.filter((m) => !m._isStreaming);
              if (filtered.length === existing.messages.length) return prev;
              return {
                ...prev,
                [msgAgentId]: { ...existing, messages: filtered },
              };
            });
          } else {
            // Remove ALL streaming placeholder messages from main messages
            setMessages((prev) => prev.filter((m) => !m._isStreaming));
          }
        }

        // Build message object, preserving all SDK fields
        const incoming: Message = {
          ...(sdkMessage as Partial<Message>),
          id,
          type: msgType,
          // Ensure role is set for user/assistant types
          role:
            msgRole ??
            (msgType === "user" || msgType === "assistant"
              ? msgType
              : undefined),
        };

        // Remove eventType from the message (it's stream envelope, not message data)
        (incoming as { eventType?: string }).eventType = undefined;

        // Extract slash_commands, tools, and mcp_servers from init messages
        if (msgType === "system" && sdkMessage.subtype === "init") {
          if (Array.isArray(sdkMessage.slash_commands)) {
            setSlashCommands(sdkMessage.slash_commands as string[]);
          }
          if (Array.isArray(sdkMessage.tools)) {
            setSessionTools(sdkMessage.tools as string[]);
          }
          if (Array.isArray(sdkMessage.mcp_servers)) {
            setMcpServers(sdkMessage.mcp_servers as string[]);
          }
        }

        // Handle synthetic token usage messages from provider-specific
        // notifications so context usage reflects actual provider state.
        if (msgType === "system" && sdkMessage.subtype === "token_usage") {
          const usage = getContextUsageFromTokenUsageMessage(
            sdkMessage,
            session?.model,
            session?.provider,
          );
          if (usage) {
            setSession((prev) =>
              prev ? { ...prev, contextUsage: usage } : prev,
            );
          }
          // Token usage messages are telemetry, not transcript content.
          return;
        }

        // Handle status messages (compacting indicator)
        if (msgType === "system" && sdkMessage.subtype === "status") {
          const status = sdkMessage.status as "compacting" | null;
          setIsCompacting(status === "compacting");
          // Don't add status messages to the message list - they're transient
          return;
        }

        // Clear compacting state when compact_boundary arrives (compaction complete)
        if (msgType === "system" && sdkMessage.subtype === "compact_boundary") {
          setIsCompacting(false);
          // Let the message be added to show the completed compaction indicator
        }

        // Handle tempId for pending message resolution
        // When server echoes back tempId, remove from pending/deferred queues.
        // Deferred promotion should also be reflected by a deferred-queue event,
        // but this reconciles clients that miss that event across reconnects.
        const tempId = sdkMessage.tempId as string | undefined;
        // A delivered queued bundle echoes back every merged chunk's id; an
        // unbundled turn carries just the single tempId. Clearing by this id set
        // is what lets all chips of a time-marked merged turn resolve without
        // re-matching their original text.
        const echoedTempIds = Array.isArray(sdkMessage.tempIds)
          ? (sdkMessage.tempIds as string[]).filter(
              (id): id is string => typeof id === "string",
            )
          : tempId
            ? [tempId]
            : [];
        if (msgType === "user") {
          setPromptSuggestion(null);
          const incomingText = extractUserMessageText(sdkMessage);
          logSessionUiTrace("user-echo", {
            sessionId,
            tempId: tempId ?? null,
            textLength: incomingText?.length ?? 0,
          });
          // Clear optimistic pending sends (the normal-send flow) by id, or by
          // content for providers that omit tempId on the user echo. Deferred
          // messages are not reconciled here — the server removes them from its
          // queue on promotion and the deferred-queue event mirrors that.
          if (echoedTempIds.length) {
            for (const id of echoedTempIds) {
              removePendingMessage(id);
            }
          } else if (incomingText) {
            setPendingMessages((prev) =>
              removeEchoedQueueMessage(prev, undefined, incomingText),
            );
          }
        }

        // Route subagent messages to agentContent instead of main messages
        // This keeps the parent session's DAG clean and allows proper nesting in UI
        // Use parentToolUseId as the routing key (it's the Task tool_use id)
        if (
          sdkMessage.isSubagent &&
          typeof sdkMessage.parentToolUseId === "string"
        ) {
          const agentId = sdkMessage.parentToolUseId;

          // Capture toolUseId → agentId mapping on first subagent message
          // This allows TaskRenderer to access agentContent immediately
          // Note: Since agentId === parentToolUseId === toolUseId, the mapping is identity
          registerToolUseAgent(agentId, agentId);

          handleStreamSubagentMessage(incoming, agentId);
          return; // Don't add to main messages
        }

        handleStreamMessageEvent(incoming);
      } else if (data.eventType === "status") {
        const statusData = data as {
          eventType: string;
          state: string;
          request?: InputRequest;
          liveness?: SessionLivenessSnapshot;
        };
        if (statusData.liveness) {
          setSessionLiveness(statusData.liveness);
        }
        // Track process state (in-turn, idle, waiting-input)
        if (
          statusData.state === "idle" ||
          statusData.state === "in-turn" ||
          statusData.state === "waiting-input"
        ) {
          logSessionUiTrace("stream-status", {
            sessionId,
            state: statusData.state,
            hasRequest: !!statusData.request,
          });
          setProcessState(statusData.state as ProcessState);
        }
        // Capture pending input request when waiting for user input
        if (statusData.state === "waiting-input" && statusData.request) {
          setPendingInputRequest(statusData.request);
          // Also update actualSessionId from request in case it differs from URL
          // This handles the temp→real ID transition when state-change arrives
          // after the connected event (which may have had the temp ID)
          if (
            statusData.request.sessionId &&
            statusData.request.sessionId !== sessionId
          ) {
            setActualSessionId(statusData.request.sessionId);
          }
        } else {
          // Clear pending request when state changes away from waiting-input
          setPendingInputRequest(null);
        }
      } else if (data.eventType === "heartbeat") {
        const heartbeatData = data as {
          eventType: string;
          liveness?: SessionLivenessSnapshot;
        };
        if (heartbeatData.liveness) {
          setSessionLiveness(heartbeatData.liveness);
        }
      } else if (data.eventType === "deferred-queue") {
        const deferredData = data as {
          eventType: string;
          messages: DeferredMessage[];
          reason?: "queued" | "cancelled" | "edited" | "promoted";
          tempId?: string;
        };
        logSessionUiTrace("stream-deferred-queue", {
          sessionId,
          reason: deferredData.reason ?? null,
          tempId: deferredData.tempId ?? null,
          count: deferredData.messages?.length ?? 0,
        });
        // Mirror the server's authoritative queue wholesale.
        setDeferredMessages(deferredData.messages ?? []);
        const sessionProvider = session?.provider;
        const needsDeferredPromotionCatchUp =
          deferredData.reason === "promoted" &&
          (deferredData.messages?.length ?? 0) === 0 &&
          sessionProvider !== "codex" &&
          sessionProvider !== "codex-oss";
        if (needsDeferredPromotionCatchUp) {
          throttledFetch();
          // A second call asks the existing throttle for a trailing catch-up in
          // case the provider user echo lands just after the promotion event.
          throttledFetch();
        }
      } else if (data.eventType === "complete") {
        logSessionUiTrace("stream-complete", { sessionId });
        setProcessState("idle");
        setStatus({ owner: "none" });
        setSessionLiveness(null);
        setPendingInputRequest(null);
        throttledFetch();
      } else if (data.eventType === "connected") {
        // Sync state and permission mode from connected event
        const connectedData = data as {
          eventType: string;
          sessionId?: string;
          state?: string;
          permissionMode?: PermissionMode;
          modeVersion?: number;
          request?: InputRequest;
          provider?: ProviderName;
          model?: string;
          deferredMessages?: DeferredMessage[];
          liveness?: SessionLivenessSnapshot;
        };
        setSessionLiveness(connectedData.liveness ?? null);

        // Update actual session ID if server reports a different one
        // This handles the temp→real ID transition when createSession returns
        // before the SDK sends the real session ID
        // Check both the connected event's sessionId and the request's sessionId
        const serverSessionId =
          connectedData.sessionId ?? connectedData.request?.sessionId;
        logSessionUiTrace("stream-connected", {
          sessionId,
          serverSessionId: serverSessionId ?? null,
          state: connectedData.state ?? null,
          permissionMode: connectedData.permissionMode ?? null,
          modeVersion: connectedData.modeVersion ?? null,
          provider: connectedData.provider ?? null,
          model: connectedData.model ?? null,
          deferredCount: connectedData.deferredMessages?.length ?? 0,
        });
        if (serverSessionId && serverSessionId !== sessionId) {
          setActualSessionId(serverSessionId);
        }

        // Sync process state so watching tabs see "processing" indicator
        if (
          connectedData.state === "idle" ||
          connectedData.state === "in-turn" ||
          connectedData.state === "waiting-input"
        ) {
          setProcessState(connectedData.state as ProcessState);
        }
        // Restore pending input request if state is waiting-input, clear if not
        // (handles reconnection after another tab already approved/denied)
        if (connectedData.state === "waiting-input" && connectedData.request) {
          setPendingInputRequest(connectedData.request);
        } else {
          setPendingInputRequest(null);
        }
        if (
          connectedData.permissionMode &&
          connectedData.modeVersion !== undefined
        ) {
          applyServerModeUpdate(
            connectedData.permissionMode,
            connectedData.modeVersion,
          );
        }

        // Update session with provider/model from connected event (belt-and-suspenders)
        // This ensures the ProviderBadge shows even if the initial session load returned
        // incomplete data (e.g., JSONL not yet written for new sessions)
        const sseProvider = connectedData.provider;
        const sseModel = connectedData.model;
        if (sseProvider) {
          setSession((prev) => {
            if (!prev) return prev;
            // Always update model if the connected event has a resolved model
            // (provider won't change, but model resolves from undefined/"Default" to actual name)
            return {
              ...prev,
              provider: prev.provider || sseProvider,
              ...(sseModel && { model: sseModel }),
            };
          });
        }

        // Mirror the server's authoritative queue from the connected event.
        // This is why a refresh, a new tab, or another device all converge on
        // the same queue: the server reports it and the client renders it.
        setDeferredMessages(connectedData.deferredMessages ?? []);

        // Fetch messages from JSONL since last known message.
        // For Codex providers, skip the very first connected-event fetch because
        // it can duplicate fresh stream messages (ID mismatch between stream and
        // early JSONL normalization). Reconnects still fetch as normal.
        const connectedProvider = connectedData.provider ?? session?.provider;
        const isCodexProvider =
          connectedProvider === "codex" || connectedProvider === "codex-oss";
        const isFirstConnectedEvent = !hasHandledConnectedEventRef.current;
        hasHandledConnectedEventRef.current = true;

        if (!(isFirstConnectedEvent && isCodexProvider)) {
          fetchNewMessages();
        }
      } else if (data.eventType === "mode-change") {
        // Handle mode change from another tab/client
        const modeData = data as {
          eventType: string;
          permissionMode?: PermissionMode;
          modeVersion?: number;
        };
        if (modeData.permissionMode && modeData.modeVersion !== undefined) {
          applyServerModeUpdate(modeData.permissionMode, modeData.modeVersion);
        }
      } else if (data.eventType === "markdown-augment") {
        // Handle markdown augment events (server-rendered)
        const augmentData = data as {
          eventType: string;
          blockIndex?: number;
          html: string;
          type?: string;
          messageId?: string;
        };

        // Two types of markdown-augment events:
        // 1. Final message augment: has messageId (uuid), no blockIndex
        //    → Store in markdownAugments for completed message rendering
        // 2. Streaming block augment: has blockIndex and type
        //    → Dispatch to streaming context for live rendering
        if (
          augmentData.messageId &&
          augmentData.blockIndex === undefined &&
          augmentData.html
        ) {
          // Final message augment - store in markdownAugments
          setMarkdownAugments((prev) => ({
            ...prev,
            [augmentData.messageId as string]: { html: augmentData.html },
          }));
        } else if (
          augmentData.blockIndex !== undefined &&
          getStreamingEnabled()
        ) {
          // Streaming block augment - dispatch to context
          streamingMarkdownCallbacks?.onAugment?.({
            blockIndex: augmentData.blockIndex,
            html: augmentData.html,
            type: augmentData.type ?? "text",
            messageId: augmentData.messageId,
          });
        }
      } else if (data.eventType === "pending") {
        // Handle streaming markdown pending text events
        const pendingData = data as {
          eventType: string;
          html: string;
        };
        if (getStreamingEnabled()) {
          streamingMarkdownCallbacks?.onPending?.({
            html: pendingData.html,
          });
        }
      } else if (data.eventType === "session-id-changed") {
        // Handle session ID change (temp ID → real SDK ID)
        // This event means the URL should be updated to use the new session ID
        const changeData = data as {
          eventType: string;
          oldSessionId: string;
          newSessionId: string;
        };
        if (changeData.newSessionId && changeData.newSessionId !== sessionId) {
          setActualSessionId(changeData.newSessionId);
          // Also update pendingInputRequest.sessionId if it matches the old ID
          // This prevents approval panel from hiding due to ID mismatch after
          // the temp→real transition
          setPendingInputRequest((prev) => {
            if (prev && prev.sessionId === changeData.oldSessionId) {
              return { ...prev, sessionId: changeData.newSessionId };
            }
            return prev;
          });
        }
      }
    },
    [
      applyServerModeUpdate,
      sessionId,
      handleStreamEvent,
      noteStreamActivity,
      clearStreaming,
      removePendingMessage,
      setDeferredMessages,
      streamingMarkdownCallbacks,
      handleStreamMessageEvent,
      handleStreamSubagentMessage,
      registerToolUseAgent,
      setAgentContent,
      setMessages,
      setSession,
      fetchNewMessages,
      throttledFetch,
      session?.provider,
      session?.model,
    ],
  );

  // Handle stream errors by checking if process is still alive
  // If process died (idle timeout), transition to idle state
  // Uses lightweight metadata endpoint to avoid re-fetching all messages
  const handleStreamError = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      const metadataProcessState = parseProcessState(data.processState);
      if (data.ownership.owner !== "self") {
        setStatus({ owner: "none" });
        setProcessState("idle");
        setPendingInputRequest(null);
        return;
      }
      setStatus(data.ownership);
      if (metadataProcessState) {
        setProcessState(metadataProcessState);
        if (
          metadataProcessState === "waiting-input" &&
          data.pendingInputRequest
        ) {
          setPendingInputRequest(data.pendingInputRequest);
        } else if (metadataProcessState !== "waiting-input") {
          setPendingInputRequest(null);
        }
      }
    } catch {
      // If session fetch fails, assume process is dead
      setStatus({ owner: "none" });
      setProcessState("idle");
      setPendingInputRequest(null);
    }
  }, [projectId, sessionId]);

  // Only connect to session stream when we own the session
  // External sessions are tracked via the activity stream instead
  const { connected, reconnect: reconnectStream } = useSessionStream(
    status.owner === "self" ? sessionId : null,
    { onMessage: handleStreamMessage, onError: handleStreamError },
  );

  const sessionUpdatesConnected =
    status.owner === "self"
      ? connected
      : status.owner === "external"
        ? sessionWatchConnected
        : false;

  // Allow external model update (e.g., after /model command switches mid-session)
  const setSessionModel = useCallback(
    (model: string) => {
      setSession((prev) => (prev ? { ...prev, model } : prev));
    },
    [setSession],
  );

  return {
    session,
    setSessionModel,
    messages,
    agentContent, // Subagent messages keyed by agentId (for Task tool)
    setAgentContent, // Setter for merging lazy-loaded agent content
    toolUseToAgent, // Mapping from Task tool_use_id → agentId (for rendering during streaming)
    markdownAugments, // Pre-rendered markdown HTML from REST response (keyed by blockId)
    status,
    processState,
    sessionLiveness,
    isCompacting, // True when context is being compressed
    pendingInputRequest,
    setIsCompacting,
    actualSessionId, // Real session ID from server (may differ from URL during temp→real transition)
    permissionMode: localMode, // UI-selected mode (sent with next message)
    modeVersion,
    loading,
    error,
    connected,
    sessionWatchConnected,
    sessionUpdatesConnected,
    lastStreamActivityAt, // Last stream message timestamp for engagement tracking
    setStatus,
    setProcessState,
    setPendingInputRequest,
    setPermissionMode,
    pendingMessages, // Messages waiting for server confirmation
    addPendingMessage, // Add to pending queue, returns tempId
    removePendingMessage, // Remove from pending by tempId
    updatePendingMessage, // Update pending message fields (e.g. status)
    deferredMessages, // Server-authoritative queued-message mirror
    setDeferredMessages, // Replace the mirror from a server queue/cancel response
    slashCommands, // Available slash commands from init message
    sessionTools, // Available tools from init message
    mcpServers, // Available MCP servers from init message
    promptSuggestion, // Predicted next user prompt from prompt_suggestion SDK message
    dismissPromptSuggestion: () => setPromptSuggestion(null),
    pagination, // Compact-boundary pagination metadata
    loadingOlder, // Whether older messages are being loaded
    loadOlderMessages, // Load next chunk of older messages
    reconnectStream, // Force session stream reconnection (e.g., after process restart)
  };
}
