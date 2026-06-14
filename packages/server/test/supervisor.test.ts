import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/sdk/messageQueue.js";
import { MockClaudeSDK, createMockScenario } from "../src/sdk/mock.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";
import type { RealClaudeSDKInterface } from "../src/sdk/types.js";
import {
  type ResumeCompactionError,
  Supervisor,
} from "../src/supervisor/Supervisor.js";
import {
  type SessionSummary,
  encodeProjectId,
} from "../src/supervisor/types.js";
import { type BusEvent, EventBus } from "../src/watcher/EventBus.js";

describe("Supervisor", () => {
  let mockSdk: MockClaudeSDK;
  let supervisor: Supervisor;

  beforeEach(() => {
    mockSdk = new MockClaudeSDK();
    supervisor = new Supervisor({ sdk: mockSdk, idleTimeoutMs: 100 });
  });

  describe("startSession", () => {
    it("starts a session and returns a process", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      expect(process.id).toBeDefined();
      expect(process.projectPath).toBe("/tmp/test");
    });

    it("tracks process in getAllProcesses", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisor.startSession("/tmp/test", { text: "hi" });

      expect(supervisor.getAllProcesses()).toHaveLength(1);
    });

    it("encodes projectId correctly", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      // /tmp/test in base64url
      expect(process.projectId).toBe(
        Buffer.from("/tmp/test").toString("base64url"),
      );
    });

    it("queues the initial message", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      // The message was queued
      expect(process.queueDepth).toBeGreaterThanOrEqual(0);
    });
  });

  describe("resumeSession", () => {
    it("resumes an existing session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "continue",
      });

      expect(process.sessionId).toBe("sess-123");
    });

    it("reuses existing process for same session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "First"));

      const process1 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "first",
      });

      const process2 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "second",
      });

      expect(process1.id).toBe(process2.id);
    });

    it("restarts an existing process when thinking display changes", async () => {
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system" as const,
              subtype: "init" as const,
              session_id: options.resumeSessionId ?? "display-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process1 = await supervisorWithProvider.resumeSession(
        "display-session",
        "/tmp/test",
        { text: "first" },
        undefined,
        { thinking: { type: "adaptive" } },
      );

      const process2 = await supervisorWithProvider.resumeSession(
        "display-session",
        "/tmp/test",
        { text: "second" },
        undefined,
        { thinking: { type: "adaptive", display: "summarized" } },
      );

      expect(process1.id).not.toBe(process2.id);
      expect(startSession).toHaveBeenCalledTimes(2);
      expect(startSession.mock.calls[1]?.[0].thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });

      await supervisorWithProvider.abortProcess(process2.id);
    });

    it("creates new process for different session", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "First"));
      mockSdk.addScenario(createMockScenario("sess-456", "Second"));

      const process1 = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "first",
      });

      const process2 = await supervisor.resumeSession("sess-456", "/tmp/test", {
        text: "second",
      });

      expect(process1.id).not.toBe(process2.id);
    });

    it("runs Claude compact-first resume before the user turn", async () => {
      const delivered: string[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "new-session",
            };

            for await (const sdkMessage of queue) {
              if (aborted) {
                return;
              }
              const content = sdkMessage.message.content;
              const text =
                typeof content === "string"
                  ? content
                  : ((content[0] as { text?: string } | undefined)?.text ?? "");
              delivered.push(text);

              if (text === "/compact") {
                yield {
                  type: "system",
                  subtype: "status",
                  status: "compacting",
                  session_id: options.resumeSessionId ?? "new-session",
                };
                yield {
                  type: "system",
                  subtype: "status",
                  status: null,
                  compact_result: "success",
                  session_id: options.resumeSessionId ?? "new-session",
                };
                yield {
                  type: "system",
                  subtype: "compact_boundary",
                  session_id: options.resumeSessionId ?? "new-session",
                };
                continue;
              }

              yield {
                type: "result",
                session_id: options.resumeSessionId ?? "new-session",
              };
              return;
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands: async () => [
              { name: "compact", description: "Compact conversation" },
            ],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithProvider.resumeSession(
        "claude-old",
        "/tmp/test",
        { text: "continue" },
        undefined,
        { providerName: "claude", resumeMode: "compact-first" },
      );

      if (!("id" in process)) {
        throw new Error("expected process");
      }
      expect(process.sessionId).toBe("claude-old");
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({ resumeSessionId: "claude-old" }),
      );
      expect(startSession.mock.calls[0]?.[0].initialMessage).toBeUndefined();
      await vi.waitFor(() => {
        expect(delivered).toEqual(["/compact", "continue"]);
      });
    });

    it("reports compact-first resume as unavailable without /compact", async () => {
      const delivered: string[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          let aborted = false;

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "new-session",
            };
            for await (const sdkMessage of queue) {
              if (aborted) {
                return;
              }
              const content = sdkMessage.message.content;
              delivered.push(typeof content === "string" ? content : "");
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
              queue.push({ text: "__abort__" });
            },
            supportedCommands: async () => [],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      await expect(
        supervisorWithProvider.resumeSession(
          "claude-old",
          "/tmp/test",
          { text: "continue" },
          undefined,
          { providerName: "claude", resumeMode: "compact-first" },
        ),
      ).rejects.toMatchObject({
        name: "ResumeCompactionError",
        recovery: "full-resume",
        attempt: {
          status: "unavailable",
          reason: "no compact/compress slash command advertised",
        },
      } satisfies Partial<ResumeCompactionError>);
      expect(delivered).toEqual([]);
      expect(
        supervisorWithProvider.getProcessForSession("claude-old"),
      ).toBeUndefined();
    });
  });

  describe("getProcess", () => {
    it("returns process by id", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });
      const found = supervisor.getProcess(process.id);

      expect(found).toBe(process);
    });

    it("returns undefined for unknown id", () => {
      const found = supervisor.getProcess("unknown-id");
      expect(found).toBeUndefined();
    });
  });

  describe("getProcessForSession", () => {
    it("returns process by session id", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "hi",
      });
      const found = supervisor.getProcessForSession("sess-123");

      expect(found).toBe(process);
    });

    it("returns undefined for unknown session", () => {
      const found = supervisor.getProcessForSession("unknown-session");
      expect(found).toBeUndefined();
    });
  });

  describe("getProcessInfoList", () => {
    it("returns info for all processes", async () => {
      mockSdk.addScenario(createMockScenario("sess-1", "First"));
      mockSdk.addScenario(createMockScenario("sess-2", "Second"));

      await supervisor.startSession("/tmp/test1", { text: "one" });
      await supervisor.startSession("/tmp/test2", { text: "two" });

      const infoList = supervisor.getProcessInfoList();

      expect(infoList).toHaveLength(2);
      expect(infoList[0]?.id).toBeDefined();
      expect(infoList[1]?.id).toBeDefined();
    });
  });

  describe("abortProcess", () => {
    it("aborts and removes process", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.startSession("/tmp/test", {
        text: "hi",
      });

      const result = await supervisor.abortProcess(process.id);

      expect(result).toBe(true);
      expect(supervisor.getAllProcesses()).toHaveLength(0);
    });

    it("returns false for unknown process", async () => {
      const result = await supervisor.abortProcess("unknown-id");
      expect(result).toBe(false);
    });

    it("removes session mapping on abort", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      const process = await supervisor.resumeSession("sess-123", "/tmp/test", {
        text: "hi",
      });

      await supervisor.abortProcess(process.id);

      expect(supervisor.getProcessForSession("sess-123")).toBeUndefined();
    });

    it("records a terminated process only once when abort emits completion", async () => {
      let aborted = false;

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "abort-once-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              aborted = true;
            },
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.startSession("/tmp/test", {
        text: "hi",
      });

      await expect(
        supervisorWithRealSdk.abortProcess(process.id),
      ).resolves.toBe(true);

      expect(
        supervisorWithRealSdk.getRecentlyTerminatedProcesses(),
      ).toHaveLength(1);
    });
  });

  describe("interruptProcess", () => {
    it("hard-aborts and unregisters when interrupt reports incomplete", async () => {
      let aborted = false;
      const interrupt = vi.fn(async () => false);

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "interrupt-fallback-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              aborted = true;
            },
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-fallback-session",
        "/tmp/test",
        { text: "hi" },
      );

      const result = await supervisorWithRealSdk.interruptProcess(process.id);

      expect(result).toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(aborted).toBe(true);
      expect(
        supervisorWithRealSdk.getProcessForSession(
          "interrupt-fallback-session",
        ),
      ).toBeUndefined();
    });

    it("times out a stalled interrupt before hard-aborting", async () => {
      let aborted = false;
      const interrupt = vi.fn(() => new Promise<boolean>(() => {}));

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          const queue = new MessageQueue();
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "interrupt-timeout-session",
            };
            await queue[Symbol.asyncIterator]().next();
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
        interruptTimeoutMs: 10,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-timeout-session",
        "/tmp/test",
        { text: "hi" },
      );

      const startedAt = Date.now();
      const result = await supervisorWithRealSdk.interruptProcess(process.id);

      expect(result).toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(aborted).toBe(true);
      expect(
        supervisorWithRealSdk.getProcessForSession("interrupt-timeout-session"),
      ).toBeUndefined();
    });

    it("recovers deferred messages onto a replacement after hard abort", async () => {
      let startCount = 0;
      const aborts: Array<() => void> = [];
      const interrupt = vi.fn(async () => false);

      const realSdk: RealClaudeSDKInterface = {
        startSession: async (options) => {
          startCount++;
          const run = { aborted: false };
          const queue = new MessageQueue();

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ?? `interrupt-recovery-${startCount}`,
            };
            await queue[Symbol.asyncIterator]().next();
            while (!run.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          const abort = () => {
            run.aborted = true;
          };
          aborts.push(abort);

          return {
            iterator: iterator(),
            queue,
            abort,
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-fallback-session",
        "/tmp/test",
        { text: "hi" },
      );
      process.deferMessage(
        { text: "ping", tempId: "temp-ping" },
        { promoteIfReady: true },
      );

      const result = await supervisorWithRealSdk.interruptProcess(process.id);

      expect(result).toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      await vi.waitFor(() => {
        const replacement = supervisorWithRealSdk.getProcessForSession(
          "interrupt-fallback-session",
        );
        const recovered = replacement
          ?.getMessageHistory()
          .find((message) => message.tempId === "temp-ping");
        expect(recovered?.message?.content).toBe("ping");
      });

      const replacement = supervisorWithRealSdk.getProcessForSession(
        "interrupt-fallback-session",
      );
      expect(replacement).toBeDefined();
      expect(replacement?.id).not.toBe(process.id);
      expect(aborts).toHaveLength(2);

      await replacement?.abort();
    });

    it("recovers queued provider messages onto a replacement after hard abort", async () => {
      let startCount = 0;
      const aborts: Array<() => void> = [];
      const interrupt = vi.fn(async () => false);

      const realSdk: RealClaudeSDKInterface = {
        startSession: async (options) => {
          startCount++;
          const run = { aborted: false };
          const queue = new MessageQueue();

          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ??
                `interrupt-queue-recovery-${startCount}`,
            };
            await queue[Symbol.asyncIterator]().next();
            while (!run.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          const abort = () => {
            run.aborted = true;
          };
          aborts.push(abort);

          return {
            iterator: iterator(),
            queue,
            abort,
            interrupt,
          };
        },
      };

      const supervisorWithRealSdk = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithRealSdk.resumeSession(
        "interrupt-queued-provider-session",
        "/tmp/test",
        { text: "hi" },
      );
      process.queueMessage({ text: "ping", tempId: "temp-ping" });

      const result = await supervisorWithRealSdk.interruptProcess(process.id);

      expect(result).toMatchObject({
        success: false,
        supported: true,
        hardAborted: true,
      });
      await vi.waitFor(() => {
        const replacement = supervisorWithRealSdk.getProcessForSession(
          "interrupt-queued-provider-session",
        );
        const recovered = replacement
          ?.getMessageHistory()
          .find((message) => message.tempId === "temp-ping");
        expect(recovered?.message?.content).toBe("ping");
        expect(recovered?.uuid).toBeDefined();
      });

      const replacement = supervisorWithRealSdk.getProcessForSession(
        "interrupt-queued-provider-session",
      );
      expect(replacement).toBeDefined();
      expect(replacement?.id).not.toBe(process.id);

      await replacement?.abort();
    });
  });

  describe("prompt suggestion options", () => {
    it("passes native prompt suggestions only for supporting providers", async () => {
      const startedOptions: Array<
        Parameters<AgentProvider["startSession"]>[0]
      > = [];
      const makeProvider = (
        supportsNativePromptSuggestions: boolean,
      ): AgentProvider => ({
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        supportsNativePromptSuggestions,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession: async (options) => {
          startedOptions.push(options);
          const queue = new MessageQueue();
          let aborted = false;
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? randomSessionId(),
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
          };
        },
      });
      const randomSessionId = () =>
        `prompt-suggestion-${startedOptions.length}`;

      const nativeSupervisor = new Supervisor({
        provider: makeProvider(true),
        idleTimeoutMs: 100,
      });
      const nativeProcess = await nativeSupervisor.startSession("/tmp/test", {
        text: "hi",
      });
      if (!("id" in nativeProcess)) {
        throw new Error("expected process");
      }

      const explicitOffProcess = await nativeSupervisor.startSession(
        "/tmp/test",
        { text: "hi" },
        undefined,
        { promptSuggestionMode: "off" },
      );
      if (!("id" in explicitOffProcess)) {
        throw new Error("expected process");
      }

      const unsupportedSupervisor = new Supervisor({
        provider: makeProvider(false),
        idleTimeoutMs: 100,
      });
      const unsupportedProcess = await unsupportedSupervisor.startSession(
        "/tmp/test",
        { text: "hi" },
        undefined,
        { promptSuggestionMode: "native" },
      );
      if (!("id" in unsupportedProcess)) {
        throw new Error("expected process");
      }

      expect(
        startedOptions.map((options) => options.promptSuggestions),
      ).toEqual([true, false, false]);
      expect(nativeProcess.promptSuggestionMode).toBe("native");
      expect(explicitOffProcess.promptSuggestionMode).toBe("off");
      expect(unsupportedProcess.promptSuggestionMode).toBe("off");

      await nativeProcess.abort();
      await explicitOffProcess.abort();
      await unsupportedProcess.abort();
    });
  });

  describe("queue propagation", () => {
    it("expands emulated slash commands for the first provider message", async () => {
      let aborted = false;
      const queues: MessageQueue[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          queues.push(queue);
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "slash-emulation-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            supportedCommands: async () => [
              {
                name: "goal",
                description: "Keep working until done",
                emulation: { providerText: "/loop wish {{argument}}" },
              },
            ],
          };
        },
      );
      const provider: AgentProvider = {
        name: "claude",
        displayName: "Claude",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: true,
        supportsSteering: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        startSession,
        getAvailableModels: async () => [],
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const process = await supervisorWithProvider.startSession("/tmp/test", {
        text: "/goal Make tests pass",
      });
      if (!("id" in process)) {
        throw new Error("expected process");
      }

      expect(startSession.mock.calls[0]?.[0].initialMessage).toBeUndefined();
      const queuedProviderTurn = await queues[0]
        ?.[Symbol.asyncIterator]()
        .next();
      expect(queuedProviderTurn?.value?.message.content).toBe(
        "/loop wish Make tests pass",
      );
      expect(
        process
          .getMessageHistory()
          .some(
            (message) =>
              message.type === "user" &&
              message.message?.content === "/loop wish Make tests pass",
          ),
      ).toBe(true);

      await process.abort();
    });

    it("preserves model settings when a queued session starts later", async () => {
      let aborted = false;
      const queues: MessageQueue[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          queues.push(queue);
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ?? `queued-session-${queues.length}`,
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
          };
        },
      );

      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        startSession,
        getAvailableModels: async () => [],
      };

      const supervisorWithQueue = new Supervisor({
        provider,
        idleTimeoutMs: 100,
        maxWorkers: 1,
        idlePreemptThresholdMs: 60_000,
      });

      const first = await supervisorWithQueue.startSession("/tmp/test", {
        text: "first",
      });
      expect("id" in first).toBe(true);

      const queued = await supervisorWithQueue.startSession(
        "/tmp/test",
        { text: "second" },
        undefined,
        {
          model: "gpt-5.4",
          serviceTier: "priority",
          thinking: { type: "adaptive" },
          effort: "high",
        },
      );
      expect("queued" in queued && queued.queued).toBe(true);

      aborted = true;
      await supervisorWithQueue.abortProcess((first as { id: string }).id);

      await vi.waitFor(() => {
        expect(startSession).toHaveBeenCalledTimes(2);
      });

      expect(startSession.mock.calls[1]?.[0]).toMatchObject({
        model: "gpt-5.4",
        serviceTier: "priority",
        thinking: { type: "adaptive" },
        effort: "high",
      });
      expect(startSession.mock.calls[1]?.[0].initialMessage).toBeUndefined();
      const secondMessage = await queues[1]?.[Symbol.asyncIterator]().next();
      expect(secondMessage?.value?.message.content).toBe("second");
    });

    it("steers active turns without restarting for composer thinking drift", async () => {
      let aborted = false;
      const steeredMessages: string[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: options.resumeSessionId ?? "steering-session",
            };
            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {
              aborted = true;
            },
            steer: async (message) => {
              steeredMessages.push(message.text);
              return true;
            },
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        supportsSteering: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };
      const supervisorWithProvider = new Supervisor({
        provider,
        idleTimeoutMs: 100,
      });

      const started = await supervisorWithProvider.resumeSession(
        "steering-session",
        "/tmp/test",
        { text: "start" },
        undefined,
        {
          model: "gpt-5.5",
          thinking: { type: "adaptive" },
          effort: "high",
        },
      );
      if (!("id" in started)) {
        throw new Error("expected process");
      }
      await vi.waitFor(() => {
        expect(started.state.type).toBe("in-turn");
      });

      const result = await supervisorWithProvider.queueMessageToSession(
        "steering-session",
        "/tmp/test",
        {
          text: "steer me",
          metadata: { deliveryIntent: "steer" as const },
        },
        undefined,
        {
          model: "gpt-5.5",
          thinking: { type: "adaptive" },
          effort: "max",
        },
      );

      expect(result).toMatchObject({ success: true, restarted: false });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(
        supervisorWithProvider.getProcessForSession("steering-session"),
      ).toBe(started);
      await vi.waitFor(() => {
        expect(steeredMessages).toEqual(["steer me"]);
      });

      await supervisorWithProvider.abortProcess(started.id);
    });
  });

  describe("heartbeat turns", () => {
    it("requires verified idle liveness before queueing a synthetic turn", async () => {
      vi.useFakeTimers();
      let aborted = false;

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-session-1",
              };
              await queue[Symbol.asyncIterator]().next();
              yield { type: "result", session_id: "heartbeat-session-1" };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");

        const originalSnapshot = started.getLivenessSnapshot.bind(started);
        const livenessSpy = vi
          .spyOn(started, "getLivenessSnapshot")
          .mockImplementation((now?: Date) => ({
            ...originalSnapshot(now),
            derivedStatus: "long-silent-unverified",
            activeWorkKind: "agent-turn",
            lastVerifiedIdleAt: null,
          }));

        await vi.advanceTimersByTimeAsync(60_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);

        livenessSpy.mockImplementation((now?: Date) => originalSnapshot(now));

        await vi.advanceTimersByTimeAsync(30_000);
        expect(started.state.type).toBe("in-turn");
        expect(started.queueDepth).toBe(1);

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not queue heartbeat turns while provider retention is active", async () => {
      vi.useFakeTimers();
      let aborted = false;

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-provider-retained-session",
              };
              await queue[Symbol.asyncIterator]().next();
              yield {
                type: "result",
                session_id: "heartbeat-provider-retained-session",
              };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
              getProviderRetention: () => ({
                retained: true,
                reasons: ["stop-hook-background-tasks:1"],
                backgroundTaskCount: 1,
                sessionCronCount: 0,
                liveTaskCount: 0,
              }),
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 120_000,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");
        expect(started.getLivenessSnapshot().derivedStatus).toBe(
          "verified-waiting-provider",
        );
        expect(supervisorWithHeartbeat.getWorkerActivity()).toMatchObject({
          activeWorkers: 1,
          hasActiveWork: true,
        });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);
        expect(supervisorWithHeartbeat.getWorkerActivity().hasActiveWork).toBe(
          true,
        );

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("promotes patient deferred messages after verified quiet", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "patient-deferred-heartbeat-session",
              };
              await queue[Symbol.asyncIterator]().next();
              yield {
                type: "result",
                session_id: "patient-deferred-heartbeat-session",
              };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: false,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");

        const deferred = started.deferMessage(
          {
            text: "patient follow-up",
            tempId: "temp-patient",
            metadata: { deliveryIntent: "patient" },
          },
          { promoteIfReady: true },
        );
        expect(deferred).toMatchObject({ success: true, deferred: true });
        expect(started.getDeferredQueueSummary()).toMatchObject([
          {
            tempId: "temp-patient",
            content: "patient follow-up",
            metadata: { deliveryIntent: "patient" },
          },
        ]);

        await vi.advanceTimersByTimeAsync(29_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);
        expect(started.getDeferredQueueSummary()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(started.state.type).toBe("in-turn");
        expect(started.queueDepth).toBe(1);
        expect(started.getDeferredQueueSummary()).toEqual([]);

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the heartbeat timeout on real liveness signals", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-session-2",
              };
              await queue[Symbol.asyncIterator]().next();
              yield { type: "result", session_id: "heartbeat-session-2" };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("idle");

        const originalSnapshot = started.getLivenessSnapshot.bind(started);
        const rawActivityAtMs = Date.parse("2026-05-06T00:00:45.000Z");
        const rawActivityAt = new Date(rawActivityAtMs).toISOString();
        vi.spyOn(started, "getLivenessSnapshot").mockImplementation(
          (now?: Date) => {
            const snapshot = originalSnapshot(now);
            const checkedAtMs = now?.getTime() ?? Date.now();
            return checkedAtMs >= rawActivityAtMs
              ? {
                  ...snapshot,
                  lastRawProviderEventAt: rawActivityAt,
                  lastRawProviderEventSource: "test:raw-provider",
                }
              : snapshot;
          },
        );

        await vi.advanceTimersByTimeAsync(60_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(started.state.type).toBe("idle");
        expect(started.queueDepth).toBe(0);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(started.state.type).toBe("in-turn");
        expect(started.queueDepth).toBe(1);

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("steers heartbeat turns into quiet doubtful active sessions", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;
      const steeredMessages: string[] = [];

      try {
        const provider: AgentProvider = {
          name: "codex",
          displayName: "Codex",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: false,
          supportsSteering: true,
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession: async () => {
            const queue = new MessageQueue();
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "heartbeat-active-session",
              };
              await queue[Symbol.asyncIterator]().next();

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue,
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
              steer: async (message) => {
                steeredMessages.push(message.text);
                return true;
              },
            };
          },
        };

        const supervisorWithHeartbeat = new Supervisor({
          provider,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
        });

        const started = await supervisorWithHeartbeat.startSession(
          "/tmp/test",
          {
            text: "start",
          },
        );
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(started.state.type).toBe("in-turn");

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => {
          expect(steeredMessages).toEqual(["heartbeat check"]);
        });
        expect(started.state.type).toBe("in-turn");

        const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes unowned stale pending-tool sessions with heartbeat text", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;
      const queues: MessageQueue[] = [];
      const startSession = vi.fn(
        async (options: Parameters<AgentProvider["startSession"]>[0]) => {
          const queue = new MessageQueue();
          queues.push(queue);
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id:
                options.resumeSessionId ?? "heartbeat-unowned-session",
            };
            yield {
              type: "result",
              session_id:
                options.resumeSessionId ?? "heartbeat-unowned-session",
            };

            while (!aborted) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          return {
            iterator: iterator(),
            queue,
            abort: () => {
              aborted = true;
            },
            isProcessAlive: () => !aborted,
          };
        },
      );
      const provider: AgentProvider = {
        name: "codex",
        displayName: "Codex",
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsSlashCommands: false,
        supportsSteering: true,
        isInstalled: async () => true,
        isAuthenticated: async () => true,
        getAuthStatus: async () => ({
          installed: true,
          authenticated: true,
          enabled: true,
        }),
        getAvailableModels: async () => [],
        startSession,
      };

      try {
        const supervisorWithHeartbeat = new Supervisor({
          provider,
          idleTimeoutMs: 100,
          getHeartbeatTurnSettings: () => ({
            enabled: true,
            afterMinutes: 1,
            text: "heartbeat check",
          }),
          getHeartbeatTurnCandidates: () => [
            {
              sessionId: "heartbeat-unowned-session",
              projectId: encodeProjectId("/tmp/test"),
              projectPath: "/tmp/test",
              provider: "codex",
              model: "gpt-5.5",
              updatedAt: "2026-05-06T00:00:00.000Z",
              hasPendingToolCall: true,
            },
          ],
        });

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => {
          expect(startSession).toHaveBeenCalledTimes(1);
        });
        expect(startSession.mock.calls[0]?.[0]).toMatchObject({
          resumeSessionId: "heartbeat-unowned-session",
          model: "gpt-5.5",
        });
        expect(startSession.mock.calls[0]?.[0].initialMessage).toBeUndefined();
        const heartbeatMessage = await queues[0]
          ?.[Symbol.asyncIterator]()
          .next();
        expect(heartbeatMessage?.value?.message.content).toBe(
          "heartbeat check",
        );

        const started = supervisorWithHeartbeat.getProcessForSession(
          "heartbeat-unowned-session",
        );
        expect(started).toBeDefined();
        if (started) {
          const abortPromise = supervisorWithHeartbeat.abortProcess(started.id);
          await vi.advanceTimersByTimeAsync(5000);
          await expect(abortPromise).resolves.toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("active liveness probes", () => {
    it("probes provider status for long-silent active sessions", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-06T00:00:00.000Z"));
      let aborted = false;
      const probeLiveness = vi.fn(async () => ({
        status: "active" as const,
        source: "test:probe",
        checkedAt: new Date(),
      }));

      try {
        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "liveness-probe-session",
              };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
              probeLiveness,
            };
          },
        };

        const supervisorWithProbe = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
        });

        const started = await supervisorWithProbe.startSession("/tmp/test", {
          text: "start",
        });
        if (!("id" in started)) {
          throw new Error("expected process");
        }

        expect(probeLiveness).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30 * 1000);
        await vi.waitFor(() => {
          expect(probeLiveness).toHaveBeenCalledTimes(1);
        });
        expect(started.lastLivenessProbe).toMatchObject({
          status: "active",
          source: "test:probe",
        });
        expect(started.getLivenessSnapshot().derivedStatus).toBe(
          "verified-waiting-provider",
        );

        const abortPromise = supervisorWithProbe.abortProcess(started.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("eventBus integration", () => {
    it("emits process-state-changed event when session starts", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const supervisorWithBus = new Supervisor({
        sdk: mockSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisorWithBus.startSession("/tmp/test", { text: "hi" });

      // Find process-state-changed events
      const processStateEvents = events.filter(
        (e) => e.type === "process-state-changed",
      );

      console.log(
        "All events emitted:",
        events.map((e) => e.type),
      );
      console.log("Process state events:", processStateEvents);

      expect(processStateEvents.length).toBeGreaterThanOrEqual(1);
      expect(processStateEvents[0]).toMatchObject({
        type: "process-state-changed",
        activity: "in-turn",
      });
    });

    it("emits session-status-changed event when session starts", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const supervisorWithBus = new Supervisor({
        sdk: mockSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      mockSdk.addScenario(createMockScenario("sess-123", "Hello!"));

      await supervisorWithBus.startSession("/tmp/test", { text: "hi" });

      // Find session-status-changed events
      const statusEvents = events.filter(
        (e) => e.type === "session-status-changed",
      );

      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
      expect(statusEvents[0]).toMatchObject({
        type: "session-status-changed",
        ownership: { owner: "self" },
      });
    });

    it("emits optimistic title/messageCount in session-created for real SDK sessions", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "real-session-1",
            };
            yield { type: "result", session_id: "real-session-1" };
          }
          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {},
          };
        },
      };

      const supervisorWithBus = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      await supervisorWithBus.startSession("/tmp/test", {
        text: "Optimistic title from request",
      });

      const created = events.find(
        (e): e is Extract<BusEvent, { type: "session-created" }> =>
          e.type === "session-created",
      );
      expect(created).toBeDefined();
      expect(created?.session.title).toBe("Optimistic title from request");
      expect(created?.session.messageCount).toBe(1);
    });

    it("emits timed session-updated reconciliation from onSessionSummary", async () => {
      vi.useFakeTimers();
      try {
        const eventBus = new EventBus();
        const events: BusEvent[] = [];
        eventBus.subscribe((event) => events.push(event));

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "reconcile-session-1",
              };
            }
            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {},
            };
          },
        };

        const onSessionSummary = vi.fn(
          async (
            sessionId: string,
            projectId: string,
          ): Promise<SessionSummary | null> => ({
            id: sessionId,
            projectId,
            title: "Reconciled title",
            fullTitle: "Reconciled title",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(1000).toISOString(),
            messageCount: 1,
            ownership: { owner: "self", processId: "test-proc" },
            provider: "claude",
          }),
        );

        const supervisorWithBus = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          eventBus,
          onSessionSummary,
        });

        await supervisorWithBus.startSession("/tmp/test", {
          text: "Seed title",
        });

        // Allow init event and first reconciliation window.
        await vi.advanceTimersByTimeAsync(20);
        await vi.advanceTimersByTimeAsync(1100);

        expect(onSessionSummary).toHaveBeenCalled();

        const updated = events.find(
          (event): event is Extract<BusEvent, { type: "session-updated" }> =>
            event.type === "session-updated" &&
            event.sessionId === "reconcile-session-1",
        );
        expect(updated).toBeDefined();
        expect(updated?.title).toBe("Reconciled title");
        expect(updated?.messageCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("emits process-terminated when the underlying process exits unexpectedly", async () => {
      const eventBus = new EventBus();
      const events: BusEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const realSdk: RealClaudeSDKInterface = {
        startSession: async () => {
          async function* iterator() {
            yield {
              type: "system",
              subtype: "init",
              session_id: "terminated-session-1",
            };
            throw new Error("process exited");
          }

          return {
            iterator: iterator(),
            queue: new MessageQueue(),
            abort: () => {},
          };
        },
      };

      const supervisorWithBus = new Supervisor({
        realSdk,
        idleTimeoutMs: 100,
        eventBus,
      });

      await expect(
        supervisorWithBus.startSession("/tmp/test", {
          text: "Trigger failure",
        }),
      ).rejects.toThrow(/Process terminated|Failed to queue initial message/);

      await vi.waitFor(() => {
        expect(
          events.some((event) => event.type === "process-terminated"),
        ).toBe(true);
      });

      const terminated = events.find(
        (event): event is Extract<BusEvent, { type: "process-terminated" }> =>
          event.type === "process-terminated",
      );
      expect(terminated).toMatchObject({
        type: "process-terminated",
        sessionId: "terminated-session-1",
        reason: "underlying process terminated",
      });
    });

    it("reaps idle sessions even when the underlying process is still alive", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        const eventBus = new EventBus();
        const events: BusEvent[] = [];
        eventBus.subscribe((event) => events.push(event));

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "idle-alive-session-1",
              };
              yield { type: "result", session_id: "idle-alive-session-1" };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
            };
          },
        };

        const supervisorWithAliveProcess = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
          eventBus,
        });

        const process = await supervisorWithAliveProcess.startSession(
          "/tmp/test",
          {
            text: "Keep this session alive",
          },
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(process.state.type).toBe("idle");

        await vi.advanceTimersByTimeAsync(150);

        expect(
          supervisorWithAliveProcess.getProcessForSession(
            "idle-alive-session-1",
          ),
        ).toBeUndefined();
        expect(aborted).toBe(true);

        const abortedIndex = events.findIndex(
          (event) =>
            event.type === "session-aborted" &&
            event.sessionId === "idle-alive-session-1",
        );
        const releasedIndex = events.findIndex(
          (event) =>
            event.type === "session-status-changed" &&
            event.sessionId === "idle-alive-session-1" &&
            event.ownership.owner === "none",
        );
        expect(abortedIndex).toBeGreaterThanOrEqual(0);
        expect(releasedIndex).toBeGreaterThan(abortedIndex);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not run prompt-cache keepalive without a viewer lease", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        const refreshPromptCache = vi.fn(async () => ({
          mode: "no-context-pollution-nudge" as const,
          refreshed: true,
        }));
        const provider: AgentProvider = {
          name: "claude",
          displayName: "Claude",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: true,
          supportsSteering: true,
          promptCacheKeepalive: {
            supportsNoContextPollutionNudge: true,
            defaultMode: "auto",
            defaultInactivityMinutes: 1,
          },
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "keepalive-no-viewer-session",
              };
              yield {
                type: "result",
                session_id: "keepalive-no-viewer-session",
              };
              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
              refreshPromptCache,
            };
          },
        };
        const supervisorWithProvider = new Supervisor({
          provider,
          idleTimeoutMs: 10 * 60 * 1000,
          getPromptCacheKeepaliveSettings: () => ({
            enabled: true,
            inactivityMinutes: 1,
          }),
        });

        const created = await supervisorWithProvider.createSession("/tmp/test");
        if ("queued" in created || "error" in created) {
          throw new Error("Expected process");
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(created.state.type).toBe("idle");

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

        expect(refreshPromptCache).not.toHaveBeenCalled();

        const abortPromise = supervisorWithProvider.abortProcess(created.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs prompt-cache keepalive only while a viewer lease is active", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        const refreshPromptCache = vi.fn(async () => ({
          mode: "no-context-pollution-nudge" as const,
          refreshed: true,
        }));
        const provider: AgentProvider = {
          name: "claude",
          displayName: "Claude",
          supportsPermissionMode: true,
          supportsThinkingToggle: true,
          supportsSlashCommands: true,
          supportsSteering: true,
          promptCacheKeepalive: {
            supportsNoContextPollutionNudge: true,
            defaultMode: "auto",
            defaultInactivityMinutes: 1,
          },
          isInstalled: async () => true,
          isAuthenticated: async () => true,
          getAuthStatus: async () => ({
            installed: true,
            authenticated: true,
            enabled: true,
          }),
          getAvailableModels: async () => [],
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "keepalive-viewer-session",
              };
              yield {
                type: "result",
                session_id: "keepalive-viewer-session",
              };
              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
              },
              isProcessAlive: () => !aborted,
              refreshPromptCache,
            };
          },
        };
        const supervisorWithProvider = new Supervisor({
          provider,
          idleTimeoutMs: 10 * 60 * 1000,
          getPromptCacheKeepaliveSettings: () => ({
            enabled: true,
            inactivityMinutes: 1,
          }),
        });

        const created = await supervisorWithProvider.createSession("/tmp/test");
        if ("queued" in created || "error" in created) {
          throw new Error("Expected process");
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(created.state.type).toBe("idle");
        const lastProviderMessageAt =
          created.getLivenessSnapshot().lastProviderMessageAt;

        const cleanup =
          supervisorWithProvider.registerPromptCacheKeepaliveViewer(created);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(refreshPromptCache).toHaveBeenCalledTimes(1);
        expect(created.getLivenessSnapshot().lastProviderMessageAt).toBe(
          lastProviderMessageAt,
        );

        cleanup();
        await vi.advanceTimersByTimeAsync(2 * 60_000);

        expect(refreshPromptCache).toHaveBeenCalledTimes(1);

        const abortPromise = supervisorWithProvider.abortProcess(created.id);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not terminate long-silent active sessions without liveness", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;

        const realSdk: RealClaudeSDKInterface = {
          startSession: async () => {
            async function* iterator() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "silent-unknown-liveness-session",
              };

              while (!aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }

            return {
              iterator: iterator(),
              queue: new MessageQueue(),
              abort: () => {
                aborted = true;
              },
            };
          },
        };

        const supervisorWithUnknownLiveness = new Supervisor({
          realSdk,
          idleTimeoutMs: 100,
        });

        const process = await supervisorWithUnknownLiveness.startSession(
          "/tmp/test",
          {
            text: "Run quietly",
          },
        );

        await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

        expect(process.state.type).toBe("in-turn");
        expect(
          supervisorWithUnknownLiveness.getProcessForSession(
            "silent-unknown-liveness-session",
          ),
        ).toBe(process);
        expect(aborted).toBe(false);

        const abortPromise = supervisorWithUnknownLiveness.abortProcess(
          process.id,
        );
        await vi.advanceTimersByTimeAsync(5000);
        await expect(abortPromise).resolves.toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
