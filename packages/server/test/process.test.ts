import { describe, expect, it, vi } from "vitest";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { CONCAT_SEPARATOR, MessageQueue } from "../src/sdk/messageQueue.js";
import { getLogger } from "../src/logging/logger.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import type {
  ProviderRetentionSnapshot,
  SDKMessage,
} from "../src/sdk/types.js";
import { Process } from "../src/supervisor/Process.js";
import type { ProcessEvent } from "../src/supervisor/types.js";

function createMockIterator(messages: SDKMessage[]): AsyncIterator<SDKMessage> {
  let index = 0;
  return {
    async next() {
      if (index >= messages.length) {
        return { done: true as const, value: undefined };
      }
      return { done: false as const, value: messages[index++]! };
    },
  };
}

function createControllableIterator(): {
  iterator: AsyncIterator<SDKMessage>;
  push: (message: SDKMessage) => void;
  finish: () => void;
} {
  const queue: IteratorResult<SDKMessage>[] = [];
  let resolveNext: ((result: IteratorResult<SDKMessage>) => void) | null = null;

  const pushResult = (result: IteratorResult<SDKMessage>) => {
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(result);
      return;
    }
    queue.push(result);
  };

  return {
    iterator: {
      next() {
        const queued = queue.shift();
        if (queued) {
          return Promise.resolve(queued);
        }
        return new Promise<IteratorResult<SDKMessage>>((resolve) => {
          resolveNext = resolve;
        });
      },
    },
    push(message: SDKMessage) {
      pushResult({ done: false, value: message });
    },
    finish() {
      pushResult({ done: true, value: undefined });
    },
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const timeoutAt = Date.now() + 1000;
  while (Date.now() < timeoutAt) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assertion();
}

function createRecapProvider(
  generateRecap: AgentProvider["generateRecap"],
): AgentProvider {
  return {
    name: "claude",
    displayName: "Claude",
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: true,
    supportsSteering: false,
    supportsRecaps: true,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    startSession: async () => {
      throw new Error("not used");
    },
    generateRecap,
  };
}

describe("MessageQueue", () => {
  it("settles a pending iterator return without another queued message", async () => {
    const queue = new MessageQueue();
    const iterator = queue.generator();
    const pendingNext = iterator.next();
    await waitFor(() => expect(queue.isWaiting).toBe(true));

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const returnResult = await Promise.race([
      iterator
        .return()
        .then((result) => ({ type: "returned" as const, result })),
      new Promise<{ type: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ type: "timeout" }), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(returnResult.type).toBe("returned");
    if (returnResult.type === "returned") {
      expect(returnResult.result).toEqual({ done: true, value: undefined });
    }
    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});

describe("Process", () => {
  describe("event subscription", () => {
    it("emits message events", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "assistant", message: { content: "Hi" } },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const received: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          received.push(event.message);
        }
      });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(3);
      expect(received[0]?.type).toBe("system");
      expect(received[1]?.type).toBe("assistant");
      expect(received[2]?.type).toBe("result");
    });

    it("suppresses the user echo for hidden injected messages", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const userEchoes: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message" && event.message.type === "user") {
          userEchoes.push(event.message);
        }
      });

      const visible = process.queueMessage({ text: "hello" });
      const compact = process.queueMessage({
        text: "/compact",
        metadata: { hidden: true },
      });

      expect(visible.success).toBe(true);
      expect(compact.success).toBe(true);

      // Let any emit flush, then confirm only the visible turn echoed — the
      // hidden /compact (queued, so compaction still runs) shows no user turn.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(userEchoes).toHaveLength(1);
    });

    it("emits a context-window-observed event per modelUsage entry (recorded exactly as observed)", async () => {
      const messages = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "result",
          session_id: "sess-1",
          modelUsage: {
            "claude-opus-4-8": { contextWindow: 1_000_000 },
            "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
            "claude-sonnet-4-6[1m]": { contextWindow: 1_000_000 },
            "zero-window-model": { contextWindow: 0 },
          },
        },
      ] as unknown as SDKMessage[];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const observed: Array<{ model: string; contextWindow: number }> = [];
      let observedProvider: string | undefined;
      process.subscribe((event) => {
        if (event.type === "context-window-observed") {
          observed.push({
            model: event.model,
            contextWindow: event.contextWindow,
          });
          observedProvider = event.provider;
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // One event per non-zero entry; the zero-window entry is skipped. Keys
      // are recorded verbatim (no [1m] munging).
      expect(observed).toEqual([
        { model: "claude-opus-4-8", contextWindow: 1_000_000 },
        { model: "claude-haiku-4-5-20251001", contextWindow: 200_000 },
        { model: "claude-sonnet-4-6[1m]", contextWindow: 1_000_000 },
      ]);
      expect(observedProvider).toBe("claude");
      // Live-override window is still the max across entries.
      expect(process.contextWindow).toBe(1_000_000);
    });

    it("transitions to idle after result", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process.state.type).toBe("idle");
    });

    it("publishes the provider session id for agentctl-active shells", async () => {
      const publishAgentctlSessionIdFn = vi.fn();
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-real" },
      ]);

      new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "temp-session",
        provider: "claude",
        idleTimeoutMs: 100,
        publishAgentctlSessionIdFn,
      });

      await waitFor(() =>
        expect(publishAgentctlSessionIdFn).toHaveBeenCalledWith("sess-real"),
      );
    });

    it("emits state-change events", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const stateChanges: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "state-change") {
          stateChanges.push(event);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have at least one state change to idle
      expect(stateChanges.length).toBeGreaterThan(0);
      const lastChange = stateChanges[stateChanges.length - 1];
      expect(lastChange?.type).toBe("state-change");
      if (lastChange?.type === "state-change") {
        expect(lastChange.state.type).toBe("idle");
      }
    });

    it("uses Claude session_state_changed idle as a turn boundary", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        session_id: "sess-1",
        uuid: "11111111-1111-4111-8111-111111111111",
      });

      await waitFor(() => expect(process.state.type).toBe("idle"));
    });

    it("treats Claude requires_action as non-idle evidence without fabricating input", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        session_id: "sess-1",
        uuid: "11111111-1111-4111-8111-111111111111",
      });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      controller.push({
        type: "system",
        subtype: "session_state_changed",
        state: "requires_action",
        session_id: "sess-1",
        uuid: "22222222-2222-4222-8222-222222222222",
      });

      await waitFor(() => expect(process.state.type).toBe("in-turn"));
      expect(process.getLivenessSnapshot().lastWakeReason).toMatchObject({
        fromState: "idle",
        reason: "session-state-requires-action",
      });
      expect(process.getPendingInputRequest()).toBeNull();
    });

    it("defers idle reaping while provider retention is active and reaps when it clears", async () => {
      vi.useFakeTimers();
      try {
        let providerRetention: ProviderRetentionSnapshot = {
          retained: true,
          reasons: ["stop-hook-background-tasks:1"],
          backgroundTaskCount: 1,
          sessionCronCount: 0,
          liveTaskCount: 0,
        };
        const abortFn = vi.fn();
        const controller = createControllableIterator();
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          abortFn,
          getProviderRetentionFn: () => providerRetention,
        });

        controller.push({
          type: "system",
          subtype: "init",
          session_id: "sess-1",
        });
        controller.push({ type: "result", session_id: "sess-1" });

        await vi.advanceTimersByTimeAsync(0);
        expect(process.state.type).toBe("idle");
        expect(process.getLivenessSnapshot()).toMatchObject({
          derivedStatus: "verified-waiting-provider",
          activeWorkKind: "agent-turn",
          providerRetention: {
            retained: true,
            reasons: ["stop-hook-background-tasks:1"],
            backgroundTaskCount: 1,
          },
        });

        await vi.advanceTimersByTimeAsync(150);
        expect(abortFn).not.toHaveBeenCalled();

        providerRetention = { retained: false, reasons: [] };
        process.handleProviderRetentionChanged();
        await vi.advanceTimersByTimeAsync(0);

        expect(abortFn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("wakes retained idle on provider work before an immediate idle reap", async () => {
      vi.useFakeTimers();
      try {
        let providerRetention: ProviderRetentionSnapshot = {
          retained: true,
          reasons: ["stop-hook-background-tasks:1"],
          backgroundTaskCount: 1,
          sessionCronCount: 0,
          liveTaskCount: 0,
        };
        const abortFn = vi.fn();
        const controller = createControllableIterator();
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          abortFn,
          getProviderRetentionFn: () => providerRetention,
        });

        controller.push({
          type: "system",
          subtype: "init",
          session_id: "sess-1",
        });
        controller.push({ type: "result", session_id: "sess-1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(process.state.type).toBe("idle");

        await vi.advanceTimersByTimeAsync(150);
        expect(abortFn).not.toHaveBeenCalled();

        providerRetention = { retained: false, reasons: [] };
        process.handleProviderRetentionChanged();
        controller.push({
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          status: "completed",
          session_id: "sess-1",
        } as SDKMessage);

        await Promise.resolve();
        await Promise.resolve();
        expect(process.state.type).toBe("in-turn");

        await vi.advanceTimersByTimeAsync(0);
        expect(abortFn).not.toHaveBeenCalled();
        expect(process.getLivenessSnapshot()).toMatchObject({
          derivedStatus: "verified-progressing",
          lastWakeReason: {
            fromState: "idle",
            reason: "provider-message-after-idle",
            messageType: "system",
            messageSubtype: "task_notification",
          },
          providerRetention: {
            retained: false,
            reasons: [],
          },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not wake a finished idle process on a prompt_suggestion message", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      // prompt_suggestion is a top-level type emitted after the turn's result.
      // It is bookkeeping (a predicted next prompt), never followed by another
      // result, so it must not pin the process in-turn. See doc 015.
      controller.push({
        type: "prompt_suggestion",
        suggestion: "Try the next thing",
        session_id: "sess-1",
      } as unknown as SDKMessage);

      await Promise.resolve();
      await Promise.resolve();
      expect(process.state.type).toBe("idle");
      expect(process.getLivenessSnapshot().lastWakeReason ?? null).toBeNull();
    });

    it("does not wake a finished idle process on unmodeled bookkeeping messages", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      // Default-deny: known non-work subtypes and an invented future subtype all
      // stay idle rather than pinning the process in-turn.
      for (const subtype of [
        "status",
        "compact_boundary",
        "stop_hook_summary",
        "some_future_subtype_we_do_not_model",
      ]) {
        controller.push({
          type: "system",
          subtype,
          session_id: "sess-1",
        } as unknown as SDKMessage);
      }

      await Promise.resolve();
      await Promise.resolve();
      expect(process.state.type).toBe("idle");
      expect(process.getLivenessSnapshot().lastWakeReason ?? null).toBeNull();
    });

    it("wakes a finished idle process on assistant turn content", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      controller.push({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "resuming after background work" }],
        },
        session_id: "sess-1",
        uuid: "33333333-3333-4333-8333-333333333333",
      } as unknown as SDKMessage);

      await waitFor(() => expect(process.state.type).toBe("in-turn"));
      expect(process.getLivenessSnapshot().lastWakeReason).toMatchObject({
        fromState: "idle",
        reason: "provider-message-after-idle",
        messageType: "assistant",
      });
    });

    it("keeps Claude idle with session crons out of verified-idle liveness", async () => {
      const providerRetention: ProviderRetentionSnapshot = {
        retained: true,
        reasons: ["stop-hook-session-crons:1"],
        backgroundTaskCount: 0,
        sessionCronCount: 1,
        liveTaskCount: 0,
      };
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
        getProviderRetentionFn: () => providerRetention,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        session_id: "sess-1",
        uuid: "11111111-1111-4111-8111-111111111111",
      });

      await waitFor(() => expect(process.state.type).toBe("idle"));
      const liveness = process.getLivenessSnapshot();
      expect(liveness.derivedStatus).toBe("verified-waiting-provider");
      expect(liveness.evidence).toContain("provider-retained");
      expect(liveness.evidence).toContain(
        "provider-retention:stop-hook-session-crons:1",
      );
    });

    it("logs listener failures without blocking other listeners", async () => {
      const warnSpy = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });
      const received: ProcessEvent[] = [];

      process.subscribe(() => {
        throw new Error("broken listener");
      });
      process.subscribe((event) => {
        if (event.type === "message") {
          received.push(event);
        }
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });

      await waitFor(() => expect(received).toHaveLength(1));
      await waitFor(() =>
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "process_listener_error",
            emittedEventType: "message",
            error: "broken listener",
          }),
          "Process listener failed",
        ),
      );

      warnSpy.mockRestore();
    });
  });

  describe("message queue", () => {
    it("queues messages and returns position", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const result1 = process.queueMessage({ text: "first" });
      const result2 = process.queueMessage({ text: "second" });

      expect(result1.success).toBe(true);
      expect(result1.position).toBe(1);
      expect(result2.success).toBe(true);
      expect(result2.position).toBe(2);
    });

    it("reports queue depth", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      process.queueMessage({ text: "first" });
      process.queueMessage({ text: "second" });

      expect(process.queueDepth).toBe(2);
    });

    it("prefers steerFn for in-turn messages when available", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      const result = process.queueMessage({ text: "steer me" });

      expect(result.success).toBe(true);
      expect(result.position).toBe(0);
      expect(steerFn).toHaveBeenCalledTimes(1);
      expect(process.queueDepth).toBe(0);

      // Let the iterator complete so abort() doesn't hang
      resolveIterator?.();
      await process.abort();
    });

    it("marks Claude steer-now messages with now priority", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      process.queueMessage({
        text: "steer immediately",
        metadata: { deliveryIntent: "steer", steerNow: true },
      });

      expect(steerFn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "steer immediately",
          priority: "now",
        }),
      );

      resolveIterator?.();
      await process.abort();
    });

    it("falls back to queue when steerFn returns false", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => false);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      const result = process.queueMessage({ text: "fallback me" });
      expect(result.success).toBe(true);
      expect(result.position).toBe(0);

      // steerFn returns a resolved promise, then .then() pushes to queue —
      // need 2 microtask ticks for both to settle
      await Promise.resolve();
      await Promise.resolve();
      expect(process.queueDepth).toBe(1);

      // Let the iterator complete so abort() doesn't hang
      resolveIterator?.();
      await process.abort();
    });

    it("reports handled:false for providers without native command dispatch", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue: new MessageQueue(),
      });

      const result = await process.runProviderCommand("compact", "preserve X");
      expect(result).toEqual({ handled: false });

      resolveIterator?.();
      await process.abort();
    });

    it("delegates native commands to runProviderCommandFn", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const runProviderCommandFn = vi.fn(async () => ({ handled: true }));
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        queue: new MessageQueue(),
        runProviderCommandFn,
      });

      const result = await process.runProviderCommand("compact", "preserve X");
      expect(result).toEqual({ handled: true });
      expect(runProviderCommandFn).toHaveBeenCalledWith("compact", "preserve X");

      resolveIterator?.();
      await process.abort();
    });

    it("expands cached slash-command emulation before queueing", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        supportedCommandsFn: async () => [
          {
            name: "goal",
            description: "Keep working until done",
            emulation: { providerText: "/loop wish {{argument}}" },
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "/goal Make tests pass",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "/loop wish Make tests pass",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "/loop wish Make tests pass",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("expands hyphenated slash-command emulation before queueing", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        supportedCommandsFn: async () => [
          {
            name: "harsh-review",
            description: "Strict review",
            emulation: { providerText: "@harsh-review {{argument}}" },
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "/harsh-review on last 3 commits",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "@harsh-review on last 3 commits",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "@harsh-review on last 3 commits",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("rewrites unknown Codex slash commands to skill mentions", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
        provider: "codex",
        supportedCommandsFn: async () => [
          {
            name: "goal",
            description: "Keep working until done",
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "/harsh-review on last 3 commits",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "@harsh-review on last 3 commits",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "@harsh-review on last 3 commits",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("keeps native Codex slash commands as slash commands", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
        provider: "codex",
        supportedCommandsFn: async () => [
          {
            name: "goal",
            description: "Keep working until done",
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "/goal Make tests pass",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "/goal Make tests pass",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "/goal Make tests pass",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("keeps native Codex compact as a slash command before commands are cached", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
        provider: "codex",
        supportedCommandsFn: async () => [],
      });

      const result = process.queueMessage({
        text: "/compact",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe("/compact");
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe("/compact");

      resolveIterator?.();
      await process.abort();
    });
  });

  describe("recaps", () => {
    it("keeps simulated recaps disabled by default", async () => {
      const generateRecap = vi.fn(async () => "summary");
      const process = new Process(createMockIterator([]), {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const result = await process.requestRecap(
        createRecapProvider(generateRecap),
      );

      expect(result).toMatchObject({
        supported: true,
        emitted: false,
        reason: "recaps disabled for this session",
      });
      expect(generateRecap).not.toHaveBeenCalled();
    });

    it("does not run the simulated recap generator in native mode", async () => {
      const generateRecap = vi.fn(async () => "summary");
      const process = new Process(createMockIterator([]), {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapMode: "native",
      });
      const provider = {
        ...createRecapProvider(generateRecap),
        supportsNativeRecaps: true,
      };

      const result = await process.requestRecap(provider);

      expect(result).toMatchObject({
        supported: true,
        emitted: false,
        reason: "native recaps are provider-owned",
      });
      expect(generateRecap).not.toHaveBeenCalled();
    });

    it("summarizes only assistant turns after the away boundary", async () => {
      const controller = createControllableIterator();
      const generateRecap = vi.fn(async (recent: string[]) =>
        recent.join(" | "),
      );
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapsEnabled: true,
      });
      const recaps: SDKMessage[] = [];
      process.subscribe((event) => {
        if (
          event.type === "message" &&
          event.message.type === "system" &&
          event.message.subtype === "away_summary"
        ) {
          recaps.push(event.message);
        }
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "assistant", message: { content: "before" } });
      await waitFor(() =>
        expect(process.getRecentAssistantText()).toEqual(["before"]),
      );
      const sinceMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.push({ type: "assistant", message: { content: "after" } });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      const result = await process.requestRecap(
        createRecapProvider(generateRecap),
        { sinceMs },
      );

      expect(result).toMatchObject({ supported: true, emitted: true });
      expect(generateRecap).toHaveBeenCalledWith(["after"], {
        model: "cheapest",
      });
      expect(recaps.at(-1)?.content).toBe("after");
      controller.finish();
      await process.abort();
    });

    it("defers recap generation until the active turn completes", async () => {
      const controller = createControllableIterator();
      const generateRecap = vi.fn(async (recent: string[]) =>
        recent.join(" | "),
      );
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapsEnabled: true,
      });
      const recaps: SDKMessage[] = [];
      process.subscribe((event) => {
        if (
          event.type === "message" &&
          event.message.type === "system" &&
          event.message.subtype === "away_summary"
        ) {
          recaps.push(event.message);
        }
      });

      const sinceMs = Date.now() - 1;
      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "assistant", message: { content: "during" } });
      await waitFor(() =>
        expect(process.getRecentAssistantText()).toEqual(["during"]),
      );

      const result = await process.requestRecap(
        createRecapProvider(generateRecap),
        { sinceMs },
      );

      expect(result).toMatchObject({
        supported: true,
        emitted: false,
        reason: "recap deferred until turn completes",
      });
      expect(generateRecap).not.toHaveBeenCalled();

      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() =>
        expect(generateRecap).toHaveBeenCalledWith(["during"], {
          model: "cheapest",
        }),
      );
      expect(recaps.at(-1)?.content).toBe("during");
      controller.finish();
      await process.abort();
    });

    it("resolves same-as-main helper model for recap generation", async () => {
      const controller = createControllableIterator();
      const generateRecap = vi.fn(async (recent: string[]) =>
        recent.join(" | "),
      );
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        recapMode: "side-session",
        helperSideModel: "same-as-main",
        model: "sonnet",
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "assistant", message: { content: "after" } });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));
      await process.requestRecap(createRecapProvider(generateRecap));

      expect(generateRecap).toHaveBeenCalledWith(["after"], {
        model: "sonnet",
      });
      controller.finish();
      await process.abort();
    });
  });

  describe("deferred queue", () => {
    it("includes attachment count in deferred queue summaries", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      process.deferMessage({
        text: "see attached",
        tempId: "temp-1",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            name: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
        ],
      });

      expect(process.getDeferredQueueSummary()).toEqual([
        {
          tempId: "temp-1",
          content: "see attached",
          timestamp: expect.any(String),
          attachmentCount: 1,
          attachments: [
            {
              id: "file-1",
              originalName: "screenshot.png",
              name: "screenshot.png",
              size: 1024,
              mimeType: "image/png",
              path: "/uploads/screenshot.png",
            },
          ],
        },
      ]);
    });

    it("includes user message metadata in deferred queue summaries", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });
      const metadata = {
        deliveryIntent: "deferred" as const,
        composition: {
          typingStartedAt: "2026-04-25T00:00:10.000Z",
          typingEndedAt: "2026-04-25T00:00:20.000Z",
          lastEditedAt: "2026-04-25T00:00:19.000Z",
          submittedAt: "2026-04-25T00:00:20.000Z",
        },
        clientTimestamp: 1770000000123,
        serverReceivedAt: "2026-04-25T00:00:20.250Z",
      };

      process.deferMessage({
        text: "later",
        tempId: "temp-meta",
        metadata,
      });

      expect(process.getDeferredQueueSummary()).toEqual([
        {
          tempId: "temp-meta",
          content: "later",
          timestamp: expect.any(String),
          metadata,
        },
      ]);
    });

    it("drains deferred messages for replacement process recovery", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });
      const deferredEvents: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          deferredEvents.push(event);
        }
      });

      process.deferMessage({ text: "first", tempId: "temp-1" });
      process.deferMessage({ text: "second", tempId: "temp-2" });

      const drained = process.drainDeferredMessages("promoted");

      expect(drained).toMatchObject([
        { text: "first", tempId: "temp-1" },
        { text: "second", tempId: "temp-2" },
      ]);
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(deferredEvents[deferredEvents.length - 1]).toMatchObject({
        type: "deferred-queue",
        reason: "promoted",
        tempId: "temp-1",
        messages: [],
      });
    });

    it("keeps steerable active-turn deferred messages editable", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });
      const deferredEvents: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          deferredEvents.push(event);
        }
      });

      const result = process.deferMessage(
        { text: "keep queued", tempId: "temp-queued" },
        { promoteIfReady: true },
      );

      expect(result).toMatchObject({
        success: true,
        deferred: true,
      });
      expect(steerFn).not.toHaveBeenCalled();
      expect(process.getDeferredQueueSummary()).toMatchObject([
        {
          tempId: "temp-queued",
          content: "keep queued",
        },
      ]);
      expect(deferredEvents[deferredEvents.length - 1]).toMatchObject({
        type: "deferred-queue",
        reason: "queued",
        tempId: "temp-queued",
      });

      controller.finish();
      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );
      await process.abort();
    });

    it("emits a stitched user message when deferred turns promote after a non-steering turn", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        // Stitched flush is the opt-in path (YEP_DEFERRED_JOIN_WINDOW_S).
        deferredDelivery: { joinWindowSeconds: 3600, composeAnchors: false },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      process.deferMessage({ text: "first queued", tempId: "temp-1" });
      process.deferMessage({ text: "second queued", tempId: "temp-2" });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userMessages = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message]
          : [],
      );
      expect(userMessages).toMatchObject([
        {
          tempId: "temp-1",
          message: {
            role: "user",
            content: `first queued\n\n${CONCAT_SEPARATOR}\n\nsecond queued`,
          },
        },
      ]);
      expect(queue.depth).toBe(1);
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        `first queued\n\n${CONCAT_SEPARATOR}\n\nsecond queued`,
      );
      expect(process.state.type).toBe("in-turn");
      expect(events[events.length - 1]).toMatchObject({
        type: "state-change",
        state: { type: "in-turn" },
      });

      controller.finish();
      await process.abort();
    });

    it("lets regular deferred messages pass patient messages at turn end", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      process.deferMessage({
        text: "patient queued",
        tempId: "temp-patient",
        metadata: { deliveryIntent: "patient" },
      });
      process.deferMessage({
        text: "regular queued",
        tempId: "temp-regular",
        metadata: { deliveryIntent: "deferred" },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toMatchObject([
          {
            tempId: "temp-patient",
            content: "patient queued",
            metadata: { deliveryIntent: "patient" },
          },
        ]),
      );
      expect(queue.depth).toBe(1);
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe("regular queued");

      controller.finish();
      await process.abort();
    });

    it("marks Claude queued delivery with later priority after turn end", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      process.deferMessage({
        text: "claude queued",
        tempId: "temp-claude-queued",
        metadata: { deliveryIntent: "deferred" },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() => expect(queue.depth).toBe(1));
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value).toMatchObject({
        priority: "later",
        message: {
          content: "claude queued",
        },
      });

      controller.finish();
      await process.abort();
    });

    it("keeps deferred messages queued at completed tool-result boundaries", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      process.deferMessage({
        text: "patient queued",
        tempId: "temp-patient",
        metadata: { deliveryIntent: "patient" },
      });
      process.deferMessage({
        text: "regular queued",
        tempId: "temp-regular",
        metadata: { deliveryIntent: "deferred" },
      });

      controller.push({
        type: "user",
        session_id: "sess-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(steerFn).not.toHaveBeenCalled();
      expect(queue.depth).toBe(0);
      expect(process.getDeferredQueueSummary()).toMatchObject([
        {
          tempId: "temp-patient",
          content: "patient queued",
          metadata: { deliveryIntent: "patient" },
        },
        {
          tempId: "temp-regular",
          content: "regular queued",
          metadata: { deliveryIntent: "deferred" },
        },
      ]);

      controller.finish();
      await process.abort();
    });

    it("promotes patient deferred messages only through the patient promotion path", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      const immediate = process.deferMessage(
        {
          text: "patient queued",
          tempId: "temp-patient",
          metadata: { deliveryIntent: "patient" },
        },
        { promoteIfReady: true },
      );

      expect(immediate).toMatchObject({ success: true, deferred: true });
      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() => expect(process.state.type).toBe("idle"));
      expect(process.getDeferredQueueSummary()).toMatchObject([
        {
          tempId: "temp-patient",
          content: "patient queued",
          metadata: { deliveryIntent: "patient" },
        },
      ]);

      expect(
        process.promoteEligiblePatientDeferredMessages({
          quietSinceMs: Date.now() - 30_000,
        }),
      ).toMatchObject({ promoted: true });
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(process.state.type).toBe("in-turn");
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe("patient queued");

      controller.finish();
      await process.abort();
    });

    it("promotes one verbatim deferred turn per delivery boundary", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      process.deferMessage({
        text: "first queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
        },
      });
      process.deferMessage({
        text: "second queued",
        tempId: "temp-2",
        metadata: {
          deliveryIntent: "deferred",
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      // Default (vanilla) delivery: exactly one turn leaves the deferred
      // queue per completed-turn boundary, with the user's text untouched.
      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toHaveLength(1),
      );
      const firstContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(firstContents).toEqual(["first queued"]);

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );
      const allContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(allContents).toEqual(["first queued", "second queued"]);

      controller.finish();
      await process.abort();
    });

    it("flushes deferred turns as one separator-joined turn when sends fall within the join window", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: { joinWindowSeconds: 3600, composeAnchors: false },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      process.deferMessage({
        text: "first queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
        },
      });
      process.deferMessage({
        text: "second queued",
        tempId: "temp-2",
        metadata: {
          deliveryIntent: "deferred",
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(userContents).toHaveLength(1);
      expect(userContents[0]).toBe(
        `first queued\n\n${CONCAT_SEPARATOR}\n\nsecond queued`,
      );

      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(userContents[0]);

      controller.finish();
      await process.abort();
    });

    it("splits queued turns at compose-time gaps wider than the join window", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: { joinWindowSeconds: 60, composeAnchors: false },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      // Sliding window: each send within 60s of the previous send extends
      // the group. first→second gap is 30s (joins); second→third is 68s
      // (splits), so the third delivers at the next boundary on its own.
      const now = Date.now();
      process.deferMessage({
        text: "first queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 100_000).toISOString(),
        },
      });
      process.deferMessage({
        text: "second queued",
        tempId: "temp-2",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 70_000).toISOString(),
        },
      });
      process.deferMessage({
        text: "third queued",
        tempId: "temp-3",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 2_000).toISOString(),
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toHaveLength(1),
      );
      const firstContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(firstContents).toEqual([
        `first queued\n\n${CONCAT_SEPARATOR}\n\nsecond queued`,
      ]);

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );
      const allContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(allContents[allContents.length - 1]).toBe("third queued");

      controller.finish();
      await process.abort();
    });

    it("prefixes promoted deferred turns with compose-time anchors when opted in", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: { joinWindowSeconds: 3600, composeAnchors: true },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      // Anchor on metadata.serverReceivedAt so age is computed against real
      // now() at promotion without fake timers: first composed 45s ago, second
      // 15s ago (a 30s gap between the two).
      const now = Date.now();
      process.deferMessage({
        text: "first queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 45_000).toISOString(),
        },
      });
      process.deferMessage({
        text: "second queued",
        tempId: "temp-2",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 15_000).toISOString(),
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      // First chunk anchors against delivery time (~45s ago); second against
      // the first chunk's compose time (exactly 30s later). The live echo is
      // the same stitched turn that the provider receives.
      expect(userContents).toHaveLength(1);
      expect(userContents[0]).toMatch(
        new RegExp(
          `^\\(\\d+s ago\\)\\n\\nfirst queued\\n\\n${CONCAT_SEPARATOR}\\n\\n\\(30s later\\)\\n\\nsecond queued$`,
        ),
      );

      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(userContents[0]);

      controller.finish();
      await process.abort();
    });

    it("promotes deferred messages after turn completion, not completed tool results", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });
      const deferredEvents: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          deferredEvents.push(event);
        }
      });

      process.deferMessage(
        { text: "send after bash", tempId: "temp-tool-boundary" },
        { promoteIfReady: true },
      );

      controller.push({
        type: "user",
        session_id: "sess-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "done",
            },
          ],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(steerFn).not.toHaveBeenCalled();
      expect(queue.depth).toBe(0);
      expect(process.getDeferredQueueSummary()).toMatchObject([
        {
          tempId: "temp-tool-boundary",
          content: "send after bash",
        },
      ]);

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() => expect(queue.depth).toBe(1));
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message).toMatchObject({
        content: "send after bash",
      });
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(deferredEvents[deferredEvents.length - 1]).toMatchObject({
        type: "deferred-queue",
        reason: "promoted",
        messages: [],
      });

      controller.finish();
      await process.abort();
    });

    it("promotes deferred messages immediately when the process is already idle", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(process.state.type).toBe("idle");

      const result = process.deferMessage(
        { text: "idle race", tempId: "temp-idle" },
        { promoteIfReady: true },
      );

      expect(result).toMatchObject({
        success: true,
        deferred: false,
        promoted: true,
        position: 1,
      });
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(process.queueDepth).toBe(1);
    });
  });

  describe("getInfo", () => {
    it("returns process info", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test/path",
        projectId: "proj-123" as UrlProjectId,
        sessionId: "sess-456",
        provider: "claude",
        idleTimeoutMs: 100,
        promptSuggestionMode: "native",
      });

      const info = process.getInfo();

      expect(info.id).toBe(process.id);
      expect(info.sessionId).toBe("sess-456");
      expect(info.projectId).toBe("proj-123");
      expect(info.projectPath).toBe("/test/path");
      expect(info.startedAt).toBeDefined();
      expect(info.promptSuggestionMode).toBe("native");
    });
  });

  describe("abort", () => {
    it("emits complete event on abort", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      let completed = false;
      process.subscribe((event) => {
        if (event.type === "complete") {
          completed = true;
        }
      });

      await process.abort();

      expect(completed).toBe(true);
    });

    it("clears listeners after abort", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      let completeCount = 0;
      process.subscribe((event) => {
        if (event.type === "complete") {
          completeCount++;
        }
      });

      await process.abort();

      // Listener should have been called once for complete event
      expect(completeCount).toBe(1);
    });
  });

  describe("interrupt", () => {
    it("propagates provider soft-interrupt failure", async () => {
      const controller = createControllableIterator();
      const interruptFn = vi.fn(async () => false);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        interruptFn,
      });

      await expect(process.interrupt()).resolves.toBe(false);
      expect(interruptFn).toHaveBeenCalledTimes(1);

      controller.finish();
      await process.abort();
    });

    it("drains all queued messages into a single packet after successful interrupt", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const interruptFn = vi.fn(async () => true);

      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        interruptFn,
      });

      // Queue two messages while agent is "working"
      queue.push({ text: "first" });
      queue.push({ text: "second" });

      expect(process.queueDepth).toBe(2);

      // Interrupt should drain both into one combined message
      const result = await process.interrupt();
      expect(result).toBe(true);

      // The two messages should have been drained and re-queued as a single packet
      // The depth should be 1 (the combined message), not 2
      expect(process.queueDepth).toBe(1);

      controller.finish();
      await process.abort();
    });

    it("drains deferred messages into interrupt packet alongside direct queue", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const interruptFn = vi.fn(async () => true);

      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        interruptFn,
      });

      // One direct queued message and one deferred
      queue.push({ text: "direct" });
      process.deferMessage({ text: "deferred", tempId: "temp-d" });

      expect(process.queueDepth).toBe(1);
      expect(process.getDeferredQueueSummary()).toHaveLength(1);

      await process.interrupt();

      // Deferred queue should be empty (drained into the interrupt packet)
      expect(process.getDeferredQueueSummary()).toHaveLength(0);
      // Direct queue should have exactly one combined message
      expect(process.queueDepth).toBe(1);

      controller.finish();
      await process.abort();
    });

    it("does not re-queue when interrupt drains an empty queue", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const interruptFn = vi.fn(async () => true);

      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        interruptFn,
      });

      // No messages queued
      expect(process.queueDepth).toBe(0);
      await process.interrupt();

      // Still empty — no phantom empty message was enqueued
      expect(process.queueDepth).toBe(0);

      controller.finish();
      await process.abort();
    });
  });

  describe("input request handling", () => {
    it("transitions to waiting-input on input_request message", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "system",
          subtype: "input_request",
          input_request: {
            id: "req-123",
            type: "tool-approval",
            prompt: "Allow file write?",
          },
        },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process.state.type).toBe("waiting-input");
      if (process.state.type === "waiting-input") {
        expect(process.state.request.id).toBe("req-123");
        expect(process.state.request.type).toBe("tool-approval");
        expect(process.state.request.prompt).toBe("Allow file write?");
      }
    });
  });

  describe("permission mode", () => {
    it("defaults to 'default' mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      expect(process.permissionMode).toBe("default");
    });

    it("accepts initial permission mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "acceptEdits",
      });

      expect(process.permissionMode).toBe("acceptEdits");
    });

    it("allows changing permission mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      process.setPermissionMode("bypassPermissions");
      expect(process.permissionMode).toBe("bypassPermissions");

      process.setPermissionMode("plan");
      expect(process.permissionMode).toBe("plan");
    });

    it("initializes modeVersion to 0", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      expect(process.modeVersion).toBe(0);
    });

    it("increments modeVersion when mode changes", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      expect(process.modeVersion).toBe(0);

      process.setPermissionMode("acceptEdits");
      expect(process.modeVersion).toBe(1);

      process.setPermissionMode("bypassPermissions");
      expect(process.modeVersion).toBe(2);

      process.setPermissionMode("plan");
      expect(process.modeVersion).toBe(3);
    });

    it("emits mode-change event when mode changes", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "mode-change") {
          events.push(event);
        }
      });

      process.setPermissionMode("acceptEdits");
      process.setPermissionMode("bypassPermissions");

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "mode-change",
        mode: "acceptEdits",
        version: 1,
      });
      expect(events[1]).toEqual({
        type: "mode-change",
        mode: "bypassPermissions",
        version: 2,
      });
    });

    it("handleToolApproval auto-approves in bypassPermissions mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "bypassPermissions",
      });

      const abortController = new AbortController();
      const result = await process.handleToolApproval(
        "Bash",
        { command: "rm -rf /" },
        { signal: abortController.signal },
      );

      expect(result.behavior).toBe("allow");
    });

    it("handleToolApproval auto-allows read-only tools in plan mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();

      // Read-only tools should be auto-allowed in plan mode
      for (const tool of ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]) {
        const result = await process.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );
        expect(result.behavior).toBe("allow");
      }
    });

    it("handleToolApproval prompts user for mutating tools in plan mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();

      // Edit should prompt the user, not auto-deny
      const approvalPromise = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      // Should be in waiting-input state (prompting user)
      expect(process.state.type).toBe("waiting-input");

      // Simulate user denying
      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("Edit");
      process.respondToInput(pendingRequest?.id ?? "", "deny");

      const result = await approvalPromise;
      expect(result.behavior).toBe("deny");
    });

    it("queues deny feedback as follow-up message for Codex approvals", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        provider: "codex",
        queue: new MessageQueue(),
      });

      const abortController = new AbortController();
      const approvalPromise = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();

      const accepted = process.respondToInput(
        pendingRequest?.id ?? "",
        "deny",
        undefined,
        "edit src/foo.ts instead",
      );

      expect(accepted).toBe(true);
      const result = await approvalPromise;
      expect(result.behavior).toBe("deny");
      expect(result.message).toBe("edit src/foo.ts instead");
      expect(result.interrupt).toBe(false);
      expect(process.queueDepth).toBe(1);
    });

    it("does not queue deny feedback follow-up for non-Codex providers", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue: new MessageQueue(),
      });

      const abortController = new AbortController();
      const approvalPromise = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();

      const accepted = process.respondToInput(
        pendingRequest?.id ?? "",
        "deny",
        undefined,
        "edit src/foo.ts instead",
      );

      expect(accepted).toBe(true);
      const result = await approvalPromise;
      expect(result.behavior).toBe("deny");
      expect(result.message).toBe("edit src/foo.ts instead");
      expect(result.interrupt).toBe(false);
      expect(process.queueDepth).toBe(0);
    });

    it("handleToolApproval prompts user for ExitPlanMode in plan mode (not auto-approve)", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();

      // ExitPlanMode should NOT auto-approve - it should prompt the user
      const approvalPromise = process.handleToolApproval(
        "ExitPlanMode",
        {},
        { signal: abortController.signal },
      );

      // Should be in waiting-input state (prompting user)
      expect(process.state.type).toBe("waiting-input");

      // Simulate user approving
      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("ExitPlanMode");
      process.respondToInput(pendingRequest?.id ?? "", "approve");

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
      // After approval, should switch back to default mode
      expect(process.permissionMode).toBe("default");
    });

    it("surfaces AskUserQuestion as a user question in plan mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();
      const input = {
        questions: [{ question: "test?", header: "Test", options: [] }],
      };

      const approvalPromise = process.handleToolApproval(
        "AskUserQuestion",
        input,
        { signal: abortController.signal },
      );

      expect(process.state.type).toBe("waiting-input");

      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("AskUserQuestion");
      expect(pendingRequest?.type).toBe("question");
      expect(pendingRequest?.prompt).toBe("test?");
      process.respondToInput(pendingRequest?.id ?? "", "approve", {
        "test?": "Yes",
      });

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput).toEqual({
        ...input,
        answers: { "test?": "Yes" },
      });
      expect(process.permissionMode).toBe("plan");
    });

    it("does not let permission rules answer AskUserQuestion", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissions: { deny: ["AskUserQuestion(*)"] },
      });

      const abortController = new AbortController();
      const input = {
        questions: [
          {
            question: "Which checks?",
            header: "Checks",
            options: [
              { label: "Unit", description: "Run unit tests" },
              { label: "Types", description: "Run typecheck" },
            ],
            multiSelect: true,
          },
        ],
      };
      const approvalPromise = process.handleToolApproval(
        "AskUserQuestion",
        input,
        {
          signal: abortController.signal,
        },
      );

      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest?.type).toBe("question");
      expect(pendingRequest?.toolName).toBe("AskUserQuestion");

      process.respondToInput(pendingRequest?.id ?? "", "approve", {
        "Which checks?": ["Unit", "Types"],
      });

      const result = await approvalPromise;
      expect(result).toEqual({
        behavior: "allow",
        updatedInput: {
          ...input,
          answers: { "Which checks?": ["Unit", "Types"] },
        },
      });
    });

    it("handleToolApproval auto-approves Edit tools in acceptEdits mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "acceptEdits",
      });

      const abortController = new AbortController();

      // Edit should be auto-approved
      const editResult = await process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );
      expect(editResult.behavior).toBe("allow");

      // Write should be auto-approved
      const writeResult = await process.handleToolApproval(
        "Write",
        { file: "test.ts" },
        { signal: abortController.signal },
      );
      expect(writeResult.behavior).toBe("allow");
    });

    it("handleToolApproval auto-allows read-only tools in default mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });

      const abortController = new AbortController();

      // Read-only tools should be auto-allowed in default mode (ask before EDITS, not reads)
      for (const tool of [
        "Read",
        "Glob",
        "Grep",
        "LSP",
        "WebFetch",
        "WebSearch",
        "Task",
        "TaskOutput",
      ]) {
        const result = await process.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );
        expect(result.behavior).toBe("allow");
      }
    });

    it("handleToolApproval auto-allows read-only tools in acceptEdits mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "acceptEdits",
      });

      const abortController = new AbortController();

      // Read-only tools should also be auto-allowed in acceptEdits mode
      // (acceptEdits is strictly more permissive than default)
      for (const tool of [
        "Read",
        "Glob",
        "Grep",
        "LSP",
        "WebFetch",
        "WebSearch",
        "Task",
        "TaskOutput",
      ]) {
        const result = await process.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );
        expect(result.behavior).toBe("allow");
      }
    });

    it("acceptEdits mode is strictly more permissive than default mode", async () => {
      // This test ensures the permission hierarchy is maintained:
      // bypassPermissions > acceptEdits > default > plan
      // Any tool auto-approved in default should also be auto-approved in acceptEdits
      const abortController = new AbortController();

      // Test all common tools across both modes
      const testTools = [
        "Read",
        "Glob",
        "Grep",
        "LSP",
        "WebFetch",
        "WebSearch",
        "Task",
        "TaskOutput",
        "Edit",
        "Write",
        "NotebookEdit",
        "Bash",
        "AskUserQuestion",
      ];

      for (const tool of testTools) {
        // Create fresh processes for each tool to avoid state pollution
        const defaultProcess = new Process(createMockIterator([]), {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          permissionMode: "default",
        });

        const acceptEditsProcess = new Process(createMockIterator([]), {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-2",
          provider: "claude",
          idleTimeoutMs: 100,
          permissionMode: "acceptEdits",
        });

        // Start both approval requests
        const defaultPromise = defaultProcess.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );
        const acceptEditsPromise = acceptEditsProcess.handleToolApproval(
          tool,
          {},
          { signal: abortController.signal },
        );

        // Check immediate states (before any user response)
        const defaultNeedsApproval =
          defaultProcess.state.type === "waiting-input";
        const acceptEditsNeedsApproval =
          acceptEditsProcess.state.type === "waiting-input";

        // If default auto-approves, acceptEdits must also auto-approve
        if (!defaultNeedsApproval) {
          expect(acceptEditsNeedsApproval).toBe(false);
          // Both should return allow
          const [defaultResult, acceptEditsResult] = await Promise.all([
            defaultPromise,
            acceptEditsPromise,
          ]);
          expect(defaultResult.behavior).toBe("allow");
          expect(acceptEditsResult.behavior).toBe("allow");
        } else {
          // If default needs approval, acceptEdits might auto-approve (e.g., Edit)
          // but we need to resolve the pending promise for default
          const pendingRequest = defaultProcess.getPendingInputRequest();
          if (pendingRequest) {
            defaultProcess.respondToInput(pendingRequest.id, "approve");
          }

          // Also resolve acceptEdits if it's waiting
          if (acceptEditsNeedsApproval) {
            const acceptEditsPendingRequest =
              acceptEditsProcess.getPendingInputRequest();
            if (acceptEditsPendingRequest) {
              acceptEditsProcess.respondToInput(
                acceptEditsPendingRequest.id,
                "approve",
              );
            }
          }

          await Promise.all([defaultPromise, acceptEditsPromise]);
        }
      }
    });

    it("handleToolApproval prompts user for mutating tools in default mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });

      const abortController = new AbortController();

      // Edit should prompt the user in default mode
      const approvalPromise = process.handleToolApproval(
        "Edit",
        { file: "test.ts" },
        { signal: abortController.signal },
      );

      // Should be in waiting-input state (prompting user)
      expect(process.state.type).toBe("waiting-input");

      // Simulate user approving
      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("Edit");
      if (pendingRequest) {
        process.respondToInput(pendingRequest.id, "approve");
      }

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
    });

    it("handles concurrent tool approvals (queues them)", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        permissionMode: "default",
      });

      const abortController = new AbortController();

      // Start two concurrent tool approvals for tools that require approval (Bash, not Read)
      const approval1 = process.handleToolApproval(
        "Bash",
        { command: "ls -la" },
        { signal: abortController.signal },
      );
      const approval2 = process.handleToolApproval(
        "Bash",
        { command: "pwd" },
        { signal: abortController.signal },
      );

      // Both should be pending - first one should be shown
      const firstRequest = process.getPendingInputRequest();
      expect(firstRequest).not.toBeNull();
      expect(firstRequest?.toolName).toBe("Bash");

      // Process should be in waiting-input state
      expect(process.state.type).toBe("waiting-input");

      // Approve the first request
      if (!firstRequest) throw new Error("firstRequest should not be null");
      const firstId = firstRequest.id;
      const responded1 = process.respondToInput(firstId, "approve");
      expect(responded1).toBe(true);

      // First approval should resolve
      const result1 = await approval1;
      expect(result1.behavior).toBe("allow");

      // Second request should now be pending
      const secondRequest = process.getPendingInputRequest();
      expect(secondRequest).not.toBeNull();
      expect(secondRequest?.id).not.toBe(firstId);

      // Approve the second request
      if (!secondRequest) throw new Error("secondRequest should not be null");
      const responded2 = process.respondToInput(secondRequest.id, "approve");
      expect(responded2).toBe(true);

      // Second approval should resolve
      const result2 = await approval2;
      expect(result2.behavior).toBe("allow");

      // No more pending requests
      expect(process.getPendingInputRequest()).toBeNull();
      expect(process.state.type).toBe("in-turn");
    });
  });

  describe("messageHistory", () => {
    it("should add user messages to history for real SDK sessions (with queue)", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue, // Real SDK provides queue
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // User message SHOULD be in history for replay to late-joining clients.
      // Client-side deduplication (mergeStreamMessage, mergeJSONLMessages) handles
      // any duplicates when JSONL is eventually fetched.
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.message?.content).toBe("test message");
    });

    it("should add user messages to history for mock SDK sessions (no queue)", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        // No queue = mock SDK
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // User message SHOULD be in history (mock SDK needs replay)
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.message?.content).toBe("test message");
    });

    it("should always emit user messages via stream regardless of SDK type", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue, // Real SDK
      });

      const emittedMessages: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          emittedMessages.push(event.message);
        }
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // Message should still be emitted for live stream subscribers
      const userEmits = emittedMessages.filter((m) => m.type === "user");
      expect(userEmits).toHaveLength(1);
    });

    it("should include attachment info in user message content", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      // Queue a user message with attachments
      process.queueMessage({
        text: "Here is a screenshot",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            name: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
        ],
      });

      // User message should include attachment info in content
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      const content = userMessages[0]?.message?.content as string;
      expect(content).toContain("Here is a screenshot");
      expect(content).toContain("User uploaded files in .attachments:");
      expect(content).toContain("screenshot.png");
      expect(content).toContain("1\u202fkb");
      expect(content).toContain("image/png");
      expect(content).toContain("/uploads/screenshot.png");
    });

    it("should produce identical content format as MessageQueue for deduplication", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      const testMessage = {
        text: "Here is a screenshot",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            name: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
          {
            id: "file-2",
            originalName: "document.pdf",
            name: "document.pdf",
            size: 2048576, // ~2 MB
            mimeType: "application/pdf",
            path: "/uploads/document.pdf",
          },
        ],
      };

      // Queue the message through Process
      process.queueMessage(testMessage);

      // Get what Process put in history
      const historyContent = process.getMessageHistory()[0]?.message
        ?.content as string;

      // Get what MessageQueue would send to SDK via its generator
      const gen = queue.generator();
      const sdkMessage = await gen.next();
      const sdkContent = sdkMessage.value?.message?.content as string;

      // Both should produce identical content for deduplication to work
      expect(historyContent).toBe(sdkContent);
    });
  });

  describe("process termination", () => {
    it("isTerminated returns false for new process", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      expect(process.isTerminated).toBe(false);
      expect(process.terminationReason).toBe(null);
    });

    it("queueMessage returns error when process is terminated", async () => {
      // Create an iterator that throws a process termination error
      const error = new Error("ProcessTransport is not ready for writing");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      // Wait for the iterator to process and fail
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      // Now queueMessage should return an error
      const result = process.queueMessage({ text: "should fail" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("terminated");
    });

    it("emits terminated event when process dies", async () => {
      const error = new Error("ProcessTransport is not ready for writing");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      let terminatedEvent: { reason: string; error?: Error } | null = null;
      process.subscribe((event) => {
        if (event.type === "terminated") {
          terminatedEvent = { reason: event.reason, error: event.error };
        }
      });

      // Wait for the terminated event
      await vi.waitFor(() => {
        expect(terminatedEvent).not.toBe(null);
      });

      // terminatedEvent is only assigned inside the subscribe callback, so
      // control-flow analysis narrows it back to its `null` initializer here;
      // read through the declared type to access the captured fields.
      const captured = terminatedEvent as {
        reason: string;
        error?: Error;
      } | null;
      expect(captured?.reason).toContain("terminated");
      expect(captured?.error).toBe(error);
    });

    it("getInfo returns terminated state", async () => {
      const error = new Error("process exited");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      // Wait for termination
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      const info = process.getInfo();
      expect(info.state).toBe("terminated");
    });

    it("terminates after emitting a Claude SDK API error message", async () => {
      const apiError: SDKMessage = {
        type: "assistant",
        uuid: "25f342b9-efa8-416c-9e9b-e617f61af756",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary.",
            },
          ],
        },
        isApiErrorMessage: true,
        apiErrorStatus: 529,
      };
      const abortFn = vi.fn();
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
        apiError,
      ]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        abortFn,
      });

      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      const messageEventIndex = events.findIndex(
        (event) =>
          event.type === "message" &&
          event.message.type === "assistant" &&
          event.message.uuid === apiError.uuid &&
          event.message.isApiErrorMessage === true &&
          event.message.apiErrorStatus === 529,
      );
      const terminatedEventIndex = events.findIndex(
        (event) => event.type === "terminated",
      );

      expect(messageEventIndex).toBeGreaterThanOrEqual(0);
      expect(terminatedEventIndex).toBeGreaterThan(messageEventIndex);
      expect(process.terminationReason).toBe(
        "Claude SDK API error; restart required",
      );
      expect(abortFn).toHaveBeenCalledOnce();
      expect(process.queueMessage({ text: "should fail" }).success).toBe(false);
    });

    it("does not terminate non-Claude processes on Claude-shaped API errors", async () => {
      const apiError: SDKMessage = {
        type: "assistant",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: "API Error: 529 Overloaded.",
        },
        isApiErrorMessage: true,
        apiErrorStatus: 529,
      };
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
        apiError,
        { type: "result", session_id: "sess-1" },
      ]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      await vi.waitFor(() => {
        expect(process.state.type).toBe("idle");
      });

      expect(process.isTerminated).toBe(false);
    });
  });
});
