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
  requestRecap: vi.fn(),
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

function installVisibilityStateMock(initial: DocumentVisibilityState) {
  let visibilityState = initial;
  const descriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });

  return {
    set(value: DocumentVisibilityState) {
      visibilityState = value;
    },
    restore() {
      if (descriptor) {
        Object.defineProperty(document, "visibilityState", descriptor);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    },
  };
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
    apiMocks.requestRecap.mockReset();
    apiMocks.requestRecap.mockResolvedValue({ supported: true });
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

  it("clears compacting state when the live stream completes", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);

    act(() => {
      sessionStreamHandler?.({ eventType: "complete" });
    });

    expect(result.current.isCompacting).toBe(false);
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

  it("clears compacting state when ownership drops to none", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);

    act(() => {
      fileActivityOptions?.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        ownership: { owner: "none" } as SessionStatus,
        timestamp: "2026-04-23T00:00:00.000Z",
      });
    });

    expect(result.current.isCompacting).toBe(false);
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

  it("clears compacting state when reconnect reports no owner", async () => {
    apiMocks.getSessionMetadata.mockResolvedValue({
      session: {},
      ownership: { owner: "none" },
      processState: null,
      pendingInputRequest: null,
    });
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);

    await act(async () => {
      await fileActivityOptions?.onReconnect?.();
    });

    expect(result.current.isCompacting).toBe(false);
  });

  it("keeps compacting state when an old compact boundary was already loaded", () => {
    sessionMessagesMock.messages = [
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "old-boundary",
        timestamp: "2026-04-23T00:00:00.000Z",
        content: "Context compacted",
      },
    ];

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);
  });

  it("clears compacting state when fetched messages add a compact boundary", () => {
    const { result, rerender } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);

    sessionMessagesMock.messages = [
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "new-boundary",
        timestamp: "2026-04-23T00:01:00.000Z",
        content: "Context compacted",
      },
    ];

    act(() => {
      rerender();
    });

    expect(result.current.isCompacting).toBe(false);
  });

  it("mirrors the server deferred-queue event", () => {
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
            tempId: "temp-a",
            content: "alpha message",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
          {
            tempId: "temp-b",
            content: "beta message",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
        ],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-a", content: "alpha message" },
      { tempId: "temp-b", content: "beta message" },
    ]);
  });

  it("replaces the deferred mirror wholesale on each server event", () => {
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
            tempId: "temp-a",
            content: "alpha",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
          {
            tempId: "temp-b",
            content: "beta",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
        ],
      });
    });
    expect(result.current.deferredMessages).toHaveLength(2);

    // The server promotes temp-a and reports the remaining queue. The client
    // mirrors it wholesale — no merge, no fuzzy matching against the echo.
    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        reason: "promoted",
        tempId: "temp-a",
        messages: [
          {
            tempId: "temp-b",
            content: "beta",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
        ],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-b", content: "beta" },
    ]);
  });

  it("does not clear deferred chips from a user-message echo", () => {
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
            tempId: "temp-a",
            content: "still queued",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
        ],
      });
    });

    // A user echo with matching text must NOT remove the chip — only a server
    // deferred-queue event can change the mirror.
    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "user",
        uuid: "uuid-echo",
        tempId: "temp-a",
        message: { role: "user", content: "still queued" },
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-a", content: "still queued" },
    ]);
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

  it("does not load permission mode from localStorage on session view mount", () => {
    window.localStorage.setItem(
      "yep-anywhere-permission-mode",
      "bypassPermissions",
    );

    const { result } = renderHook(() => useSession(PROJECT_ID, "sess-1"));

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
    expect(
      window.localStorage.getItem("yep-anywhere-permission-mode"),
    ).toBeNull();

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

  it("uses the configured away threshold for recap requests", () => {
    vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
    const visibility = installVisibilityStateMock("visible");

    try {
      renderHook(() =>
        useSession(PROJECT_ID, "sess-1", {
          owner: "self",
          processId: "proc-1",
          recapAfterSeconds: 2,
        }),
      );

      act(() => {
        visibility.set("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(1_999);
        visibility.set("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(apiMocks.requestRecap).not.toHaveBeenCalled();

      act(() => {
        visibility.set("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
        visibility.set("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(apiMocks.requestRecap).toHaveBeenCalledTimes(1);
      expect(apiMocks.requestRecap).toHaveBeenCalledWith(
        "proc-1",
        Date.parse("2026-04-24T00:00:01.999Z"),
      );
    } finally {
      visibility.restore();
    }
  });
});

describe("useSession permission mode persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getSessionMetadata.mockReset();
    apiMocks.setPermissionMode.mockReset();
    apiMocks.setPermissionMode.mockResolvedValue({
      permissionMode: "bypassPermissions",
      modeVersion: 1,
    });
    installLocalStorageMock();
    fileActivityOptions = undefined;
    sessionStreamHandler = null;
    sessionMessagesMock.messages = [];
    sessionMessagesMock.provider = "codex";
  });

  it("restores the stored mode when no live process reports one", () => {
    window.localStorage.setItem("permission-mode-sess-1", "bypassPermissions");

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", undefined),
    );

    expect(result.current.permissionMode).toBe("bypassPermissions");
  });

  it("prefers a live process mode over the stored mode", () => {
    window.localStorage.setItem("permission-mode-sess-1", "bypassPermissions");

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
        permissionMode: "plan",
      }),
    );

    expect(result.current.permissionMode).toBe("plan");
  });

  it("persists the selected mode to storage", async () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", undefined),
    );

    await act(async () => {
      await result.current.setPermissionMode("bypassPermissions");
    });

    expect(window.localStorage.getItem("permission-mode-sess-1")).toBe(
      "bypassPermissions",
    );
  });
});
