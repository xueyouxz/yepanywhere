/**
 * Unit tests for OpenCodeProvider.startSession() blocking session-ID resolution.
 *
 * The core invariant: startSession() must resolve with an iterator whose FIRST
 * yield is already the init message carrying the real ses_* session ID.  That
 * allows Process.waitForSessionId() to resolve immediately without racing the
 * 5-second timeout and returning a stale UUID to the client.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- helpers ---

function makeFakeProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.pid = 12345;
  emitter.killed = false;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  const fakeStream = new EventEmitter() as unknown as import("stream").Readable;
  emitter.stdout = fakeStream;
  emitter.stderr = fakeStream;
  return emitter;
}

// Minimal Response-like object for mocking global fetch
function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenCodeProvider.startSession — blocking session ID", () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let fakeProcess: ChildProcess;

  beforeEach(async () => {
    fakeProcess = makeFakeProcess();
    spawnMock = vi.fn(() => fakeProcess);
    fetchMock = vi.fn();

    // Patch module-level imports
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: spawnMock,
        exec: actual.exec,
        execFile: actual.execFile,
      };
    });

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: (p: string) =>
          p.includes("opencode") || actual.existsSync(p),
      };
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("startSession resolves before the iterator is consumed and first yield is init with ses_ ID", async () => {
    const expectedSessionId = "ses_abc123testid";

    // GET /session (waitForServer poll) → OK
    // POST /session (session creation) → { id: "ses_abc123testid" }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: expectedSessionId }));
      }
      // GET — server health check
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });

    // startSession must resolve (blocking work done) before we pull from iterator
    const session = await provider.startSession({
      cwd: "/tmp/test",
    });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      "/fake/opencode",
      expect.arrayContaining(["serve"]),
      expect.any(Object),
    );

    // The very first value from the iterator must be the init message
    const first = await session.iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: expectedSessionId,
    });

    // Abort to clean up (kills the fake server process)
    session.abort();
  });

  it("returns error iterator immediately when opencode binary is not found", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      // existsSync returns false for everything → binary not found
      return { ...actual, existsSync: () => false };
    });

    // Also make exec (which command) fail
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: spawnMock,
        exec: (
          _cmd: string,
          _opts: unknown,
          cb: (err: Error | null) => void,
        ) => {
          cb(new Error("not found"));
          return {} as ChildProcess;
        },
        execFile: actual.execFile,
      };
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider();

    const session = await provider.startSession({ cwd: "/tmp/test" });

    const first = await session.iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "error" });
    expect((first.value as { error: string }).error).toMatch(/not found/i);

    // spawn should not have been called
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns error iterator when server fails to start within timeout", async () => {
    // Simulate server never becoming ready
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    // Short timeout so the test doesn't actually wait 10 seconds
    const provider = new OpenCodeProvider({
      opencodePath: "/fake/opencode",
      timeout: 100,
    });

    // Override waitForServer by giving a minimal timeout via a subclass
    // We need to test this faster — use a derived class with tiny timeout
    const fastProvider = Object.create(provider) as typeof provider;
    // Access private method via prototype to inject a short timeout
    const origWaitForServer = (
      provider as unknown as {
        waitForServer: (url: string, timeout: number) => Promise<boolean>;
      }
    ).waitForServer.bind(provider);
    (
      fastProvider as unknown as {
        waitForServer: (url: string, timeout: number) => Promise<boolean>;
      }
    ).waitForServer = (_url: string) => origWaitForServer(_url, 200);

    const session = await fastProvider.startSession({ cwd: "/tmp/test" });

    const first = await session.iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "error" });
    expect((first.value as { error: string }).error).toMatch(/failed to start/i);
  });

  it("uses ses_ resumeSessionId directly without creating a new session", async () => {
    const resumeId = "ses_existing_session";

    // GET /session for health check
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });

    const session = await provider.startSession({
      cwd: "/tmp/test",
      resumeSessionId: resumeId,
    });

    // POST /session should NOT have been called (we resumed)
    const postCalls = fetchMock.mock.calls.filter(
      ([, init]: [string, RequestInit?]) => init?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);

    const first = await session.iterator.next();
    expect(first.value).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: resumeId,
    });

    session.abort();
  });

  it("sends explicit provider/model selection in the message body", async () => {
    const sessionId = "ses_model_selection";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "session.status",
              properties: { sessionID: sessionId, status: { type: "busy" } },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });

    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hello" },
      model: "opencode/gpt-5-nano",
    });

    await session.iterator.next();
    await session.iterator.next();
    await session.iterator.next();

    const messagePost = fetchMock.mock.calls.find(
      ([url, init]: [string, RequestInit?]) =>
        url.endsWith(`/session/${sessionId}/message`) &&
        init?.method === "POST",
    );
    expect(messagePost).toBeDefined();
    expect(JSON.parse(String(messagePost?.[1]?.body))).toMatchObject({
      model: { providerID: "opencode", modelID: "gpt-5-nano" },
      parts: [{ type: "text", text: "hello" }],
    });

    expect(session.getProviderActivity?.()).toMatchObject({
      lastRawProviderEventSource: "opencode:sse:session.idle",
    });

    session.abort();
  });

  it("does not render OpenCode user text parts as assistant messages", async () => {
    const sessionId = "ses_user_part_filter";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/event")) {
        return Promise.resolve(
          sseResponse([
            {
              type: "message.updated",
              properties: {
                info: { id: "msg_user", sessionID: sessionId, role: "user" },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_user",
                  sessionID: sessionId,
                  messageID: "msg_user",
                  type: "text",
                  text: "hello",
                },
              },
            },
            {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_assistant",
                  sessionID: sessionId,
                  role: "assistant",
                },
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_assistant",
                  sessionID: sessionId,
                  messageID: "msg_assistant",
                  type: "text",
                  text: "assistant reply",
                },
              },
            },
            { type: "session.idle", properties: { sessionID: sessionId } },
          ]),
        );
      }
      if (url.endsWith(`/session/${sessionId}/message`)) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({
      cwd: "/tmp/test",
      initialMessage: { text: "hello" },
    });

    const messages = [];
    for (let i = 0; i < 6; i += 1) {
      const next = await session.iterator.next();
      if (next.done) {
        break;
      }
      messages.push(next.value);
      if (next.value.type === "result") {
        break;
      }
    }

    const assistantTexts = messages
      .filter((message) => message.type === "assistant")
      .map((message) => message.message?.content);
    expect(assistantTexts).toEqual(["assistant reply"]);

    session.abort();
  });

  it("reports OpenCode session/status as active liveness evidence", async () => {
    const sessionId = "ses_active_status";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/session/status")) {
        return Promise.resolve(jsonResponse({ [sessionId]: { type: "busy" } }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    await expect(session.probeLiveness?.()).resolves.toMatchObject({
      status: "active",
      source: "opencode:session/status",
    });

    session.abort();
  });

  it("reports OpenCode retry session/status as active liveness evidence", async () => {
    const sessionId = "ses_retry_status";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/session/status")) {
        return Promise.resolve(
          jsonResponse({
            [sessionId]: {
              type: "retry",
              attempt: 2,
              message: "rate limited",
              next: Date.now() + 1000,
            },
          }),
        );
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    await expect(session.probeLiveness?.()).resolves.toMatchObject({
      status: "active",
      source: "opencode:session/status",
      detail: "OpenCode is retrying attempt 2: rate limited",
    });

    session.abort();
  });

  it("reports a missing OpenCode session/status entry as idle", async () => {
    const sessionId = "ses_idle_status";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/session/status")) {
        return Promise.resolve(jsonResponse({}));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    await expect(session.probeLiveness?.()).resolves.toMatchObject({
      status: "idle",
      source: "opencode:session/status",
    });

    session.abort();
  });

  it("reports an unrecognized OpenCode session/status entry as an error", async () => {
    const sessionId = "ses_bad_status";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/session/status")) {
        return Promise.resolve(
          jsonResponse({ [sessionId]: { type: "paused" } }),
        );
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: sessionId }));
      }
      return Promise.resolve(jsonResponse({ sessions: [] }));
    });

    const { OpenCodeProvider } = await import(
      "../../../src/sdk/providers/opencode.js"
    );
    const provider = new OpenCodeProvider({ opencodePath: "/fake/opencode" });
    const session = await provider.startSession({ cwd: "/tmp/test" });

    await expect(session.probeLiveness?.()).resolves.toMatchObject({
      status: "error",
      source: "opencode:session/status",
    });

    session.abort();
  });
});
