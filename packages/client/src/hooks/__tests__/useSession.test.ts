import { act, renderHook } from "@testing-library/react";
import type {
  SessionLivenessSnapshot,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import type {
  SessionStatusEvent,
  SessionUpdatedEvent,
} from "../../lib/activityBus";
import type { SessionStatus } from "../../types";
import { useSession } from "../useSession";

const apiMocks = vi.hoisted(() => ({
  getSessionMetadata: vi.fn(),
  setPermissionMode: vi.fn(),
}));

const sessionMessagesMock = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  provider: "codex",
}));

const fetchNewMessages = vi.fn(async () => {});
const fetchSessionMetadata = vi.fn(async () => {});

let fileActivityOptions:
  | {
      onSessionStatusChange?: (event: SessionStatusEvent) => void;
      onSessionUpdated?: (event: SessionUpdatedEvent) => void;
      onReconnect?: () => void | Promise<void>;
    }
  | undefined;

let sessionStreamHandler:
  | ((data: { eventType: string; [key: string]: unknown }) => void)
  | null = null;

const PROJECT_ID = "proj-1" as unknown as UrlProjectId;

function mockLiveness(
  overrides: Partial<SessionLivenessSnapshot> = {},
): SessionLivenessSnapshot {
  return {
    checkedAt: "2026-04-24T00:06:00.000Z",
    derivedStatus: "long-silent-unverified",
    activeWorkKind: "agent-turn",
    state: "in-turn",
    evidence: ["provider-message-stale"],
    lastProviderMessageAt: "2026-04-24T00:00:00.000Z",
    lastRawProviderEventAt: null,
    lastRawProviderEventSource: null,
    lastStateChangeAt: "2026-04-23T23:59:00.000Z",
    lastVerifiedProgressAt: "2026-04-24T00:00:00.000Z",
    lastVerifiedIdleAt: null,
    lastLivenessProbeAt: null,
    lastLivenessProbeStatus: null,
    lastLivenessProbeSource: null,
    silenceMs: 360_000,
    longSilenceThresholdMs: 300_000,
    processAlive: true,
    queueDepth: 0,
    deferredQueueDepth: 0,
    ...overrides,
  };
}

function installLocalStorageMock(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
      key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
      get length() {
        return store.size;
      },
    },
  });
}

vi.mock("../useSessionMessages", () => ({
  useSessionMessages: vi.fn(() => ({
    messages: sessionMessagesMock.messages,
    agentContent: {},
    toolUseToAgent: new Map(),
    loading: false,
    session: {
      id: "sess-1",
      projectId: "proj-1",
      provider: sessionMessagesMock.provider,
      model: "gpt-5.4",
      messages: [],
    },
    setSession: vi.fn(),
    handleStreamingUpdate: vi.fn(),
    handleStreamMessageEvent: vi.fn(),
    handleStreamSubagentMessage: vi.fn(),
    registerToolUseAgent: vi.fn(),
    setAgentContent: vi.fn(),
    setToolUseToAgent: vi.fn(),
    setMessages: vi.fn(),
    fetchNewMessages,
    fetchSessionMetadata,
    pagination: undefined,
    loadingOlder: false,
    loadOlderMessages: vi.fn(async () => {}),
  })),
}));

vi.mock("../../api/client", () => ({
  api: apiMocks,
}));

vi.mock("../useFileActivity", () => ({
  useFileActivity: vi.fn((options) => {
    fileActivityOptions = options;
  }),
}));

vi.mock("../useSessionStream", () => ({
  useSessionStream: vi.fn((_sessionId, options) => {
    sessionStreamHandler = options.onMessage;
    return { connected: true, reconnect: vi.fn() };
  }),
}));

vi.mock("../useSessionWatchStream", () => ({
  useSessionWatchStream: vi.fn(() => ({ connected: false })),
}));

vi.mock("../useStreamingContent", () => ({
  useStreamingContent: vi.fn(() => ({
    handleStreamEvent: vi.fn(() => false),
    clearStreaming: vi.fn(),
    cleanup: vi.fn(),
  })),
}));

describe("useSession completion reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    apiMocks.getSessionMetadata.mockReset();
    apiMocks.setPermissionMode.mockReset();
    apiMocks.setPermissionMode.mockResolvedValue({
      permissionMode: "acceptEdits",
      modeVersion: 1,
    });
    installLocalStorageMock();
    fileActivityOptions = undefined;
    sessionStreamHandler = null;
    sessionMessagesMock.messages = [];
    sessionMessagesMock.provider = "codex";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes persisted messages when the live stream completes", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(sessionStreamHandler).not.toBeNull();

    act(() => {
      sessionStreamHandler?.({ eventType: "complete" });
    });

    expect(result.current.processState).toBe("idle");
    expect(result.current.status).toEqual({ owner: "none" });
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("refreshes persisted messages when ownership drops to none", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(fileActivityOptions?.onSessionStatusChange).toBeDefined();

    act(() => {
      fileActivityOptions?.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        ownership: { owner: "none" } as SessionStatus,
        timestamp: "2026-04-23T00:00:00.000Z",
      });
    });

    expect(result.current.processState).toBe("idle");
    expect(result.current.status).toEqual({ owner: "none" });
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("does not refresh for unrelated session status events", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      fileActivityOptions?.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "other-session",
        projectId: PROJECT_ID,
        ownership: { owner: "none" } as SessionStatus,
        timestamp: "2026-04-23T00:00:00.000Z",
      });
    });

    expect(fetchNewMessages).not.toHaveBeenCalled();
  });

  it("syncs metadata process state when reconnect keeps ownership self", async () => {
    apiMocks.getSessionMetadata.mockResolvedValue({
      session: {},
      ownership: {
        owner: "self",
        processId: "proc-1",
      },
      processState: "idle",
      pendingInputRequest: null,
    });
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(result.current.processState).toBe("in-turn");

    await act(async () => {
      await fileActivityOptions?.onReconnect?.();
    });

    expect(result.current.status).toMatchObject({
      owner: "self",
      processId: "proc-1",
    });
    expect(result.current.processState).toBe("idle");
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("clears deferred queue chips when the queued turn is echoed as a user message", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-queued",
            content: "i see it already.",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
        ],
      });
    });

    expect(result.current.deferredMessages).toHaveLength(1);

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "user",
        uuid: "uuid-queued",
        tempId: "temp-queued",
        message: {
          role: "user",
          content: "i see it already.",
        },
      });
    });

    expect(result.current.deferredMessages).toEqual([]);
  });

  it("clears all deferred chips contained in a merged provider user turn", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-first",
            content: "first queued",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
          {
            tempId: "temp-second",
            content: "second queued",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
          {
            tempId: "temp-third",
            content: "third queued",
            timestamp: "2026-04-24T00:00:02.000Z",
          },
        ],
      });
    });

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "user",
        uuid: "uuid-merged",
        tempId: "temp-first",
        message: {
          role: "user",
          content:
            "first queued\n\n--------\n\nsecond queued\n\n--------\n\nthird queued",
        },
      });
    });

    expect(result.current.deferredMessages).toEqual([]);
  });

  it("does not re-add a promoted queued chip after the user echo already arrived", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "user",
        uuid: "uuid-promoted",
        tempId: "temp-promoted",
        message: {
          role: "user",
          content: "already promoted",
        },
      });
    });

    act(() => {
      result.current.addDeferredMessage({
        tempId: "temp-promoted",
        content: "already promoted",
        timestamp: "2026-04-24T00:00:00.000Z",
        deliveryState: "sending",
      });
    });

    expect(result.current.deferredMessages).toEqual([]);
  });

  it("clears pending direct sends when persisted history contains the user turn", () => {
    const { result, rerender } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addPendingMessage(
        "does origin have both parts",
        undefined,
        "2026-05-23T04:36:39.900Z",
      );
    });

    expect(result.current.pendingMessages).toHaveLength(1);

    sessionMessagesMock.messages = [
      {
        type: "user",
        uuid: "uuid-user",
        timestamp: "2026-05-23T04:36:39.966Z",
        message: {
          role: "user",
          content: "does origin have both parts",
        },
      },
      {
        type: "assistant",
        uuid: "uuid-assistant",
        timestamp: "2026-05-23T04:36:49.441Z",
        message: {
          role: "assistant",
          content: "No. The fetched origin/master has neither part.",
        },
      },
    ];

    rerender();

    expect(result.current.pendingMessages).toEqual([]);
  });

  it("keeps pending direct sends when only older duplicate history matches", () => {
    const { result, rerender } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addPendingMessage(
        "repeatable question",
        undefined,
        "2026-05-23T04:36:39.900Z",
      );
    });

    sessionMessagesMock.messages = [
      {
        type: "user",
        uuid: "uuid-old-user",
        timestamp: "2026-05-23T04:30:00.000Z",
        message: {
          role: "user",
          content: "repeatable question",
        },
      },
    ];

    rerender();

    expect(result.current.pendingMessages).toMatchObject([
      {
        content: "repeatable question",
      },
    ]);
  });

  it("keeps deferred queue chips on an idle status boundary", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-stale",
            content: "stale queued text",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
        ],
      });
    });

    expect(result.current.deferredMessages).toHaveLength(1);

    act(() => {
      sessionStreamHandler?.({ eventType: "status", state: "idle" });
    });

    expect(result.current.deferredMessages).toMatchObject([
      {
        tempId: "temp-stale",
        content: "stale queued text",
        deliveryState: "queued",
      },
    ]);
  });

  it("marks queue entries as verifying when connected snapshot omits them", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addDeferredMessage({
        tempId: "temp-verifying",
        content: "needs verification",
        timestamp: "2026-04-24T00:00:00.000Z",
      });
    });

    act(() => {
      sessionStreamHandler?.({
        eventType: "connected",
        state: "idle",
        deferredMessages: [],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      {
        tempId: "temp-verifying",
        content: "needs verification",
        deliveryState: "verifying",
      },
    ]);
  });

  it("captures session liveness snapshots from stream status events", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "status",
        state: "in-turn",
        liveness: mockLiveness(),
      });
    });

    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "long-silent-unverified",
      activeWorkKind: "agent-turn",
    });
  });

  it("captures session liveness snapshots from stream heartbeats", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "heartbeat",
        liveness: mockLiveness({
          derivedStatus: "verified-progressing",
          lastVerifiedProgressAt: "2026-04-24T00:06:00.000Z",
          silenceMs: 0,
        }),
      });
    });

    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "verified-progressing",
      lastVerifiedProgressAt: "2026-04-24T00:06:00.000Z",
    });
  });

  it("moves stale liveness to live on user-visible stream progress", () => {
    const eventStart = new Date("2026-04-24T01:00:00.000Z");
    vi.setSystemTime(eventStart);
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "status",
        state: "in-turn",
        liveness: mockLiveness({
          checkedAt: "2026-04-24T00:00:00.000Z",
          lastVerifiedProgressAt: "2026-04-24T00:00:00.000Z",
          silenceMs: 3_600_000,
          derivedStatus: "long-silent-unverified",
        }),
      });
    });

    expect(result.current.sessionLiveness?.derivedStatus).toBe(
      "long-silent-unverified",
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hello",
          },
        },
      });
    });

    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "verified-progressing",
      lastVerifiedProgressAt: eventStart.toISOString(),
      evidence: expect.arrayContaining(["stream_event"]),
      lastRawProviderEventSource: "stream_event",
      silenceMs: 0,
    });
  });

  it("keeps stale liveness when stream_event has no user-visible content", () => {
    const eventStart = new Date("2026-04-24T01:00:00.000Z");
    vi.setSystemTime(eventStart);
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "status",
        state: "in-turn",
        liveness: mockLiveness({
          checkedAt: "2026-04-24T00:00:00.000Z",
          lastVerifiedProgressAt: "2026-04-24T00:00:00.000Z",
          silenceMs: 3_600_000,
          derivedStatus: "long-silent-unverified",
        }),
      });
    });

    expect(result.current.sessionLiveness?.derivedStatus).toBe(
      "long-silent-unverified",
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "stream_event",
      });
    });

    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "long-silent-unverified",
      lastVerifiedProgressAt: "2026-04-24T00:00:00.000Z",
      silenceMs: 3_600_000,
    });
  });

  it("drops live markdown events when response streaming is disabled", () => {
    window.localStorage.setItem(UI_KEYS.streamingEnabled, "false");
    const streamingMarkdownCallbacks = {
      onAugment: vi.fn(),
      onPending: vi.fn(),
      onStreamEnd: vi.fn(),
      setCurrentMessageId: vi.fn(),
      captureHtml: vi.fn(() => null),
    };
    const { result } = renderHook(() =>
      useSession(
        PROJECT_ID,
        "sess-1",
        {
          owner: "self",
          processId: "proc-1",
        },
        streamingMarkdownCallbacks,
      ),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "markdown-augment",
        blockIndex: 0,
        html: "<p>partial</p>",
        type: "text",
      });
      sessionStreamHandler?.({
        eventType: "pending",
        html: "<p>pending</p>",
      });
      sessionStreamHandler?.({
        eventType: "markdown-augment",
        messageId: "assistant-1",
        html: "<p>complete</p>",
      });
    });

    expect(streamingMarkdownCallbacks.onAugment).not.toHaveBeenCalled();
    expect(streamingMarkdownCallbacks.onPending).not.toHaveBeenCalled();
    expect(result.current.markdownAugments).toEqual({
      "assistant-1": { html: "<p>complete</p>" },
    });
  });

  it("marks a promoted deferred queue chip as sending without Codex catch-up", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addDeferredMessage({
        tempId: "temp-promoted",
        content: "promote this",
        timestamp: "2026-04-24T00:00:00.000Z",
      });
    });

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        reason: "promoted",
        tempId: "temp-promoted",
        messages: [],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      {
        tempId: "temp-promoted",
        content: "promote this",
        deliveryState: "sending",
      },
    ]);
    expect(fetchNewMessages).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(fetchNewMessages).not.toHaveBeenCalled();
  });

  it("fetches catch-up for a Claude promoted deferred queue chip", () => {
    sessionMessagesMock.provider = "claude";
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addDeferredMessage({
        tempId: "temp-promoted",
        content: "promote this",
        timestamp: "2026-04-24T00:00:00.000Z",
      });
    });

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        reason: "promoted",
        tempId: "temp-promoted",
        messages: [],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      {
        tempId: "temp-promoted",
        content: "promote this",
        deliveryState: "sending",
      },
    ]);
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(2);
  });

  it("clears a promoted deferred batch from a concatenated user echo", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addDeferredMessage({
        tempId: "temp-1",
        content: "first queued",
        timestamp: "2026-04-24T00:00:00.000Z",
      });
      result.current.addDeferredMessage({
        tempId: "temp-2",
        content: "second queued",
        timestamp: "2026-04-24T00:00:01.000Z",
      });
    });

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        reason: "promoted",
        messages: [],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-1", deliveryState: "sending" },
      { tempId: "temp-2", deliveryState: "sending" },
    ]);

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "user",
        uuid: "uuid-combined",
        tempId: "temp-1",
        message: {
          role: "user",
          content: "first queued\n\n--------\n\nsecond queued",
        },
      });
    });

    expect(result.current.deferredMessages).toEqual([]);
  });

  it("prunes persisted deferred chips after loading a concatenated provider turn", () => {
    window.localStorage.setItem(
      "queued-message-sess-1",
      JSON.stringify([
        {
          tempId: "temp-1",
          content: "first queued",
          timestamp: "2026-04-24T00:00:00.000Z",
        },
        {
          tempId: "temp-2",
          content: "second queued",
          timestamp: "2026-04-24T00:00:01.000Z",
        },
      ]),
    );
    sessionMessagesMock.messages = [
      {
        type: "user",
        uuid: "uuid-combined",
        message: {
          role: "user",
          content: "first queued\n\n--------\n\nsecond queued",
        },
      },
    ];

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(result.current.deferredMessages).toEqual([]);
    expect(window.localStorage.getItem("queued-message-sess-1")).toBeNull();
  });

  it("uses server queue order when a REST sync inserts an edited message", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addDeferredMessage({
        tempId: "temp-1",
        content: "first",
        timestamp: "2026-04-24T00:00:00.000Z",
      });
      result.current.addDeferredMessage({
        tempId: "temp-3",
        content: "third",
        timestamp: "2026-04-24T00:00:02.000Z",
      });
    });

    act(() => {
      result.current.syncDeferredMessages(
        [
          {
            tempId: "temp-1",
            content: "first",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
          {
            tempId: "temp-2-edited",
            content: "second edited",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
          {
            tempId: "temp-3",
            content: "third",
            timestamp: "2026-04-24T00:00:02.000Z",
          },
        ],
        {
          reason: "queued",
          tempId: "temp-2-edited",
          source: "rest",
        },
      );
    });

    expect(result.current.deferredMessages.map((message) => message.tempId)).toEqual(
      ["temp-1", "temp-2-edited", "temp-3"],
    );
  });

  it("preserves queued attachment metadata across server summaries", () => {
    const attachment = {
      id: "file-1",
      originalName: "notes.txt",
      name: "file-1-notes.txt",
      size: 12,
      mimeType: "text/plain",
      path: "/uploads/notes.txt",
    };

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addDeferredMessage({
        tempId: "temp-with-file",
        content: "see attached",
        timestamp: "2026-04-24T00:00:00.000Z",
        attachmentCount: 1,
        attachments: [attachment],
        mode: "acceptEdits",
      });
    });

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-with-file",
            content: "see attached",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
        ],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      {
        tempId: "temp-with-file",
        content: "see attached",
        attachmentCount: 1,
        attachments: [attachment],
        mode: "acceptEdits",
        deliveryState: "queued",
      },
    ]);
  });

  it("does not load permission mode from localStorage on session view mount", () => {
    window.localStorage.setItem(
      "yep-anywhere-permission-mode",
      "bypassPermissions",
    );

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1"),
    );

    expect(result.current.permissionMode).toBe("default");
    expect(apiMocks.setPermissionMode).not.toHaveBeenCalled();
  });

  it("treats backend default mode as authoritative instead of reapplying localStorage", async () => {
    window.localStorage.setItem(
      "yep-anywhere-permission-mode",
      "bypassPermissions",
    );

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    await act(async () => {
      sessionStreamHandler?.({
        eventType: "connected",
        sessionId: "sess-1",
        state: "idle",
        permissionMode: "default",
        modeVersion: 0,
        provider: "codex",
      });
    });

    expect(result.current.permissionMode).toBe("default");
    expect(apiMocks.setPermissionMode).not.toHaveBeenCalled();
  });

  it("uses explicit initial owned permission mode for newly started sessions", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
        permissionMode: "bypassPermissions",
        modeVersion: 2,
      }),
    );

    expect(result.current.permissionMode).toBe("bypassPermissions");
    expect(result.current.modeVersion).toBe(2);
  });

  it("keeps the same-page toolbar mode after ownership drops", async () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    await act(async () => {
      await result.current.setPermissionMode("acceptEdits");
    });

    expect(result.current.permissionMode).toBe("acceptEdits");
    expect(window.localStorage.getItem("yep-anywhere-permission-mode")).toBeNull();

    act(() => {
      fileActivityOptions?.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        ownership: { owner: "none" } as SessionStatus,
        timestamp: "2026-04-23T00:00:00.000Z",
      });
    });

    expect(result.current.status).toEqual({ owner: "none" });
    expect(result.current.permissionMode).toBe("acceptEdits");
  });
});
