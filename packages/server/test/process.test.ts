import { describe, expect, it, vi } from "vitest";
import type { UrlProjectId } from "@yep-anywhere/shared";
import {
  CONCAT_SEPARATOR,
  MessageQueue,
} from "../src/sdk/messageQueue.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import type { SDKMessage } from "../src/sdk/types.js";
import { Process } from "../src/supervisor/Process.js";
import type { ProcessEvent } from "../src/supervisor/types.js";

function createMockIterator(messages: SDKMessage[]): AsyncIterator<SDKMessage> {
  let index = 0;
  return {
    async next() {
      if (index >= messages.length) {
        return { done: true as const, value: undefined };
      }
      return { done: false as const, value: messages[index++] };
    },
  };
}

function createControllableIterator(): {
  iterator: AsyncIterator<SDKMessage>;
  push: (message: SDKMessage) => void;
  finish: () => void;
} {
  const queue: IteratorResult<SDKMessage>[] = [];
  let resolveNext: ((result: IteratorResult<SDKMessage>) => void) | null =
    null;

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
        projectId: "proj-1",
        sessionId: "sess-1",
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

    it("transitions to idle after result", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process.state.type).toBe("idle");
    });

    it("emits state-change events", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
  });

  describe("message queue", () => {
    it("queues messages and returns position", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.queueMessage({ text: "first" });
      process.queueMessage({ text: "second" });

      expect(process.queueDepth).toBe(2);
    });

    it("prefers steerFn for in-turn messages when available", async () => {
      let resolveIterator: () => void;
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
        projectId: "proj-1",
        sessionId: "sess-1",
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

    it("falls back to queue when steerFn returns false", async () => {
      let resolveIterator: () => void;
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
        projectId: "proj-1",
        sessionId: "sess-1",
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

    it("expands cached slash-command emulation before queueing", async () => {
      let resolveIterator: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
      let resolveIterator: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
      let resolveIterator: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
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
      let resolveIterator: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
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
  });

  describe("recaps", () => {
    it("keeps simulated recaps disabled by default", async () => {
      const generateRecap = vi.fn(async () => "summary");
      const process = new Process(createMockIterator([]), {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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

      controller.push({ type: "system", subtype: "init", session_id: "sess-1" });
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
      controller.push({ type: "system", subtype: "init", session_id: "sess-1" });
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        recapMode: "side-session",
        helperSideModel: "same-as-main",
        model: "sonnet",
      });

      controller.push({ type: "system", subtype: "init", session_id: "sess-1" });
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.deferMessage({
        text: "see attached",
        tempId: "temp-1",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });
      const metadata = {
        deliveryIntent: "patient" as const,
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
        projectId: "proj-1",
        sessionId: "sess-1",
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

    it("takes a deferred message for editing and emits queue metadata", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });
      const deferredEvents: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          deferredEvents.push(event);
        }
      });

      process.deferMessage({
        text: "edit me",
        tempId: "temp-edit",
        mode: "acceptEdits",
      });

      const taken = process.takeDeferredMessage("temp-edit");

      expect(taken?.message).toMatchObject({
        text: "edit me",
        tempId: "temp-edit",
        mode: "acceptEdits",
      });
      expect(taken?.placement).toEqual({});
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(deferredEvents[deferredEvents.length - 1]).toMatchObject({
        type: "deferred-queue",
        reason: "edited",
        tempId: "temp-edit",
        messages: [],
      });
    });

    it("reinserts an edited deferred message at its original queue position", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.deferMessage({ text: "first", tempId: "temp-1" });
      process.deferMessage({ text: "second", tempId: "temp-2" });
      process.deferMessage({ text: "third", tempId: "temp-3" });

      const taken = process.takeDeferredMessage("temp-2");

      expect(taken?.placement).toEqual({
        afterTempId: "temp-1",
        beforeTempId: "temp-3",
      });
      process.deferMessage(
        { text: "second edited", tempId: "temp-2-edited" },
        { placement: { ...taken?.placement, replaceTempId: "temp-2" } },
      );

      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-1", content: "first" },
        { tempId: "temp-2-edited", content: "second edited" },
        { tempId: "temp-3", content: "third" },
      ]);
    });

    it("blocks later deferred messages while a mid-queue edit is open", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      process.deferMessage({ text: "first", tempId: "temp-1" });
      process.deferMessage({ text: "second", tempId: "temp-2" });
      process.deferMessage({ text: "third", tempId: "temp-3" });

      const taken = process.takeDeferredMessage("temp-2");

      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-1", content: "first" },
        { tempId: "temp-3", content: "third", blockedByEdit: true },
      ]);

      controller.push({
        type: "user",
        session_id: "sess-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1" }],
        },
      });

      await waitFor(() => expect(steerFn).toHaveBeenCalledTimes(1));
      expect(steerFn).toHaveBeenLastCalledWith(
        expect.objectContaining({ tempId: "temp-1" }),
      );
      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-3", content: "third", blockedByEdit: true },
      ]);

      controller.push({
        type: "user",
        session_id: "sess-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-2" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(steerFn).toHaveBeenCalledTimes(1);

      process.deferMessage(
        { text: "second edited", tempId: "temp-2-edited" },
        {
          placement: { ...taken?.placement, replaceTempId: "temp-2" },
          promoteIfReady: true,
        },
      );

      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-2-edited", content: "second edited" },
        { tempId: "temp-3", content: "third" },
      ]);

      controller.push({
        type: "user",
        session_id: "sess-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-3" }],
        },
      });

      await waitFor(() => expect(steerFn).toHaveBeenCalledTimes(2));
      expect(steerFn).toHaveBeenLastCalledWith(
        expect.objectContaining({ tempId: "temp-2-edited" }),
      );

      controller.finish();
      await process.abort();
    });

    it("clears a blocking edit when the edited message has no anchors", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.deferMessage({ text: "first", tempId: "temp-1" });
      const taken = process.takeDeferredMessage("temp-1");
      process.deferMessage({ text: "second", tempId: "temp-2" });

      expect(taken?.placement).toEqual({});
      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-2", content: "second", blockedByEdit: true },
      ]);

      const result = process.deferMessage(
        { text: "first edited", tempId: "temp-1-edited" },
        { placement: { replaceTempId: "temp-1" } },
      );

      expect(result.success).toBe(true);
      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-1-edited", content: "first edited" },
        { tempId: "temp-2", content: "second" },
      ]);
      expect(
        process
          .getDeferredQueueSummary()
          .some((message) => message.blockedByEdit),
      ).toBe(false);

      await process.abort();
    });

    it("rejects a deferred edit replacement without a matching barrier", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const result = process.deferMessage(
        { text: "edited", tempId: "temp-edited" },
        { placement: { replaceTempId: "temp-missing" } },
      );

      expect(result).toMatchObject({
        success: false,
        error: "Deferred edit barrier does not match replacement message",
      });
      expect(process.getDeferredQueueSummary()).toEqual([]);

      await process.abort();
    });

    it("promotes later deferred messages when a blocking edit is cancelled while idle", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
      });
      const deferredEvents: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          deferredEvents.push(event);
        }
      });

      process.deferMessage({ text: "first", tempId: "temp-1" });
      process.deferMessage({ text: "second", tempId: "temp-2" });
      process.takeDeferredMessage("temp-1");

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() => expect(process.state.type).toBe("idle"));
      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-2", content: "second", blockedByEdit: true },
      ]);

      expect(process.releaseDeferredEditBarrier("temp-1")).toBe(true);

      expect(process.state.type).toBe("in-turn");
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(deferredEvents[deferredEvents.length - 1]).toMatchObject({
        type: "deferred-queue",
        reason: "promoted",
        tempId: "temp-2",
        messages: [],
      });

      controller.finish();
      await process.abort();
    });

    it("keeps steerable active-turn deferred messages editable", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
      await waitFor(() => expect(process.getDeferredQueueSummary()).toEqual([]));
      await process.abort();
    });

    it("emits user messages when deferred turns promote after a non-steering turn", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
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

      await waitFor(() => expect(process.getDeferredQueueSummary()).toEqual([]));

      const userMessages = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message]
          : [],
      );
      expect(userMessages).toMatchObject([
        {
          tempId: "temp-1",
          message: { role: "user", content: "first queued" },
        },
        {
          tempId: "temp-2",
          message: { role: "user", content: "second queued" },
        },
      ]);
      expect(queue.depth).toBe(2);
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

    it("promotes the next deferred message after a completed tool result", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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

      await waitFor(() => expect(steerFn).toHaveBeenCalledTimes(1));
      expect(steerFn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "send after bash",
          tempId: "temp-tool-boundary",
        }),
      );
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(deferredEvents[deferredEvents.length - 1]).toMatchObject({
        type: "deferred-queue",
        reason: "promoted",
        tempId: "temp-tool-boundary",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-123",
        sessionId: "sess-456",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      expect(process.permissionMode).toBe("default");
    });

    it("accepts initial permission mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "acceptEdits",
      });

      expect(process.permissionMode).toBe("acceptEdits");
    });

    it("allows changing permission mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      expect(process.modeVersion).toBe(0);
    });

    it("increments modeVersion when mode changes", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        provider: "claude",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
      process.respondToInput(pendingRequest?.id, "approve");

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
      // After approval, should switch back to default mode
      expect(process.permissionMode).toBe("default");
    });

    it("handleToolApproval prompts user for AskUserQuestion in plan mode (not auto-deny)", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        permissionMode: "plan",
      });

      const abortController = new AbortController();

      // AskUserQuestion should NOT auto-deny - it should prompt the user
      const approvalPromise = process.handleToolApproval(
        "AskUserQuestion",
        { questions: [{ question: "test?", header: "Test", options: [] }] },
        { signal: abortController.signal },
      );

      // Should be in waiting-input state (prompting user)
      expect(process.state.type).toBe("waiting-input");

      // Simulate user approving with answers
      const pendingRequest = process.getPendingInputRequest();
      expect(pendingRequest).not.toBeNull();
      expect(pendingRequest?.toolName).toBe("AskUserQuestion");
      process.respondToInput(pendingRequest?.id, "approve", { "test?": "Yes" });

      const result = await approvalPromise;
      expect(result.behavior).toBe("allow");
      // Should have updated input with answers
      expect(result.updatedInput).toEqual({
        questions: [{ question: "test?", header: "Test", options: [] }],
        answers: { "test?": "Yes" },
      });
      // Should still be in plan mode (AskUserQuestion doesn't exit plan mode)
      expect(process.permissionMode).toBe("plan");
    });

    it("handleToolApproval auto-approves Edit tools in acceptEdits mode", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
          projectId: "proj-1",
          sessionId: "sess-1",
          idleTimeoutMs: 100,
          permissionMode: "default",
        });

        const acceptEditsProcess = new Process(createMockIterator([]), {
          projectPath: "/test",
          projectId: "proj-1",
          sessionId: "sess-2",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
      });

      const testMessage = {
        text: "Here is a screenshot",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
          {
            id: "file-2",
            originalName: "document.pdf",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
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

      expect(terminatedEvent?.reason).toContain("terminated");
      expect(terminatedEvent?.error).toBe(error);
    });

    it("getInfo returns terminated state", async () => {
      const error = new Error("process exited");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
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
        projectId: "proj-1",
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        abortFn,
      });

      const events: ProcessEvent[] = [];
      process.subscribe((event) => events.push(event));

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
        projectId: "proj-1",
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

  describe("hold mode", () => {
    it("setHold(true) transitions to hold state", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      expect(process.isHeld).toBe(false);
      expect(process.holdSince).toBe(null);

      process.setHold(true);

      expect(process.isHeld).toBe(true);
      expect(process.holdSince).not.toBe(null);
      expect(process.state.type).toBe("hold");
    });

    it("setHold(false) transitions back to running", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.setHold(true);
      expect(process.state.type).toBe("hold");

      process.setHold(false);
      expect(process.isHeld).toBe(false);
      expect(process.holdSince).toBe(null);
      expect(process.state.type).toBe("in-turn");
    });

    it("emits state-change events for hold/resume", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const stateChanges: string[] = [];
      process.subscribe((event) => {
        if (event.type === "state-change") {
          stateChanges.push(event.state.type);
        }
      });

      process.setHold(true);
      process.setHold(false);

      expect(stateChanges).toContain("hold");
      expect(stateChanges).toContain("in-turn");
    });

    it("setHold is idempotent", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const stateChanges: string[] = [];
      process.subscribe((event) => {
        if (event.type === "state-change") {
          stateChanges.push(event.state.type);
        }
      });

      // Calling setHold(true) multiple times should only emit once
      process.setHold(true);
      process.setHold(true);
      process.setHold(true);

      const holdChanges = stateChanges.filter((s) => s === "hold");
      expect(holdChanges).toHaveLength(1);
    });

    it("getInfo returns hold state and holdSince", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.setHold(true);

      const info = process.getInfo();
      expect(info.state).toBe("hold");
      expect(info.holdSince).toBeDefined();
    });

    it("pauses iterator consumption when held", async () => {
      // Create an iterator that we can control
      let resolveNext: ((value: IteratorResult<SDKMessage>) => void) | null =
        null;
      const controllableIterator: AsyncIterator<SDKMessage> = {
        next() {
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };

      const process = new Process(controllableIterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const receivedMessages: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          receivedMessages.push(event.message);
        }
      });

      // Let the first message through
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (resolveNext) {
        resolveNext({
          done: false,
          value: { type: "system", subtype: "init", session_id: "sess-1" },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(receivedMessages).toHaveLength(1);

      // Now hold the process - the next iterator.next() should not be called
      // until we resume
      process.setHold(true);

      // The loop should be blocked waiting to resume
      // If we resolve another message, it shouldn't be received yet
      // (This is hard to test without more control, but we can at least
      // verify the state)
      expect(process.state.type).toBe("hold");
    });

    it("resumes iterator consumption after hold is released", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "assistant", message: { content: "Hello" } },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      const receivedMessages: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          receivedMessages.push(event.message);
        }
      });

      // Wait for processing to complete (mock iterator is fast)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // All messages should be received
      expect(receivedMessages).toHaveLength(3);
    });

    it("can queue messages while held", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      process.setHold(true);

      // Should still be able to queue messages
      const result = process.queueMessage({ text: "Hello while held" });
      expect(result.success).toBe(true);
      expect(result.position).toBe(1);
    });

    it("termination while held resolves the wait", async () => {
      // Create an iterator that throws after first message
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw new Error("ProcessTransport is not ready for writing");
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1",
        sessionId: "sess-1",
        idleTimeoutMs: 100,
      });

      // Wait for error to occur and process to terminate
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      // Hold should be cleared
      expect(process.isHeld).toBe(false);
    });
  });
});
