/**
 * OpenCode Provider implementation using `opencode serve`.
 *
 * This provider enables using OpenCode as an agent backend.
 * It spawns a per-session OpenCode server and communicates via HTTP/SSE.
 *
 * Architecture:
 * - Each session gets its own `opencode serve` process on a unique port
 * - Messages are sent via HTTP POST to /session/:id/message
 * - Responses are streamed via SSE from /event
 * - Server is killed when session is aborted or times out
 */

import { type ChildProcess, exec, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelInfo,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodePart,
  OpenCodeSSEEvent,
  OpenCodeSessionStatus,
  OpenCodeSessionStatusEvent,
} from "@yep-anywhere/shared";
import { parseOpenCodeSSEEvent } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { whichCommand } from "../cli-detection.js";
import { MessageQueue } from "../messageQueue.js";
import type {
  ProviderActivitySnapshot,
  ProviderLivenessProbeResult,
  SDKMessage,
} from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Configuration for OpenCode provider.
 */
export interface OpenCodeProviderConfig {
  /** Path to opencode binary (auto-detected if not specified) */
  opencodePath?: string;
  /** Request timeout in ms (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Base port to start from (auto-selects if not specified) */
  basePort?: number;
}

/** Port counter for unique port assignment */
let nextPort = 14100;

interface OpenCodeModelSelection {
  providerID: string;
  modelID: string;
}

interface OpenCodeRuntimeState {
  baseUrl: string;
  opencodeSessionId: string;
  serverProcess: ChildProcess;
  lastRawProviderEventAt: Date | null;
  lastRawProviderEventSource: string | null;
  lastSessionStatus: OpenCodeSessionStatus | null;
  lastSessionStatusAt: Date | null;
}

/**
 * Get next available port for OpenCode server.
 */
function getNextPort(): number {
  return nextPort++;
}

function parseOpenCodeModelSelection(
  model: string | undefined,
): OpenCodeModelSelection | undefined {
  if (!model || model === "default" || model === "auto") {
    return undefined;
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new Error(
      `OpenCode model must use provider/model format, got "${model}"`,
    );
  }

  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
}

function isProcessStillAlive(process: ChildProcess): boolean {
  return (
    !process.killed &&
    process.exitCode === null &&
    process.signalCode === null
  );
}

function updateOpenCodeRuntimeEvent(
  runtime: OpenCodeRuntimeState,
  event: OpenCodeSSEEvent,
): void {
  const now = new Date();
  runtime.lastRawProviderEventAt = now;
  runtime.lastRawProviderEventSource = `opencode:sse:${event.type}`;

  if (event.type === "session.status") {
    const statusEvent = event as OpenCodeSessionStatusEvent;
    runtime.lastSessionStatus = statusEvent.properties.status;
    runtime.lastSessionStatusAt = now;
  } else if (event.type === "session.idle") {
    runtime.lastSessionStatus = { type: "idle" };
    runtime.lastSessionStatusAt = now;
  }
}

function getOpenCodeEventSessionId(event: OpenCodeSSEEvent): string | undefined {
  switch (event.type) {
    case "session.status":
    case "session.idle":
    case "session.diff":
      return event.properties.sessionID;
    case "session.updated":
      return event.properties.info.id;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    default:
      return undefined;
  }
}

/**
 * OpenCode Provider implementation.
 *
 * Uses `opencode serve` to run a per-session server, communicating via HTTP/SSE.
 */
export class OpenCodeProvider implements AgentProvider {
  readonly name = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly supportsPermissionMode = false; // OpenCode has its own permission model
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;
  readonly supportsSteering = false;

  private readonly opencodePath?: string;
  private readonly timeout: number;

  constructor(config: OpenCodeProviderConfig = {}) {
    this.opencodePath = config.opencodePath;
    this.timeout = config.timeout ?? 300000; // 5 minutes default
  }

  /**
   * Check if the OpenCode CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    const path = await this.findOpenCodePath();
    return path !== null;
  }

  /**
   * Check if OpenCode is authenticated.
   * OpenCode handles auth internally via `opencode auth`.
   */
  async isAuthenticated(): Promise<boolean> {
    // OpenCode is authenticated if installed - it has built-in free models
    return this.isInstalled();
  }

  /**
   * Get detailed authentication status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        enabled: false,
      };
    }

    // OpenCode is always authenticated if installed (has free models)
    return {
      installed: true,
      authenticated: true,
      enabled: true,
    };
  }

  /**
   * Get available OpenCode models.
   * Queries the OpenCode CLI for available models.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const opencodePath = await this.findOpenCodePath();
    if (!opencodePath) {
      return [];
    }

    try {
      const { stdout: result } = await execFileAsync(opencodePath, ["models"], {
        encoding: "utf-8",
        timeout: 10000,
      });

      // Synthetic "default" entry defers to whatever opencode.json configures
      const models: ModelInfo[] = [
        { id: "default", name: "Default" },
      ];

      for (const line of result.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("─")) {
          models.push({
            id: trimmed,
            name: trimmed,
          });
        }
      }

      return models;
    } catch {
      // Return default models if command fails
      return [
        { id: "opencode/big-pickle", name: "Big Pickle (Free)" },
        { id: "auto", name: "Auto (recommended)" },
      ];
    }
  }

  /**
   * Start a new OpenCode session.
   *
   * This method is intentionally blocking: it spawns the opencode server,
   * waits for it to be ready, and creates the session via HTTP before
   * returning. This ensures the real ses_* session ID is known before the
   * iterator is handed to the Supervisor, so waitForSessionId() resolves
   * immediately on the first init yield rather than racing a 5-second timeout.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const log = getLogger();
    const opencodePath = await this.findOpenCodePath();

    if (!opencodePath) {
      return this.errorSession("OpenCode CLI not found");
    }

    const port = getNextPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    let serverProcess: ChildProcess;
    try {
      serverProcess = spawn(
        opencodePath,
        ["serve", "--port", String(port), "--print-logs"],
        {
          cwd: options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
          shell: process.platform === "win32",
        },
      );

      serverProcess.stdout?.on("data", (chunk: Buffer) => {
        log.debug({ port, line: chunk.toString().trim() }, "OpenCode server stdout");
      });
      serverProcess.stderr?.on("data", (chunk: Buffer) => {
        log.debug({ port, line: chunk.toString().trim() }, "OpenCode server stderr");
      });
    } catch (error) {
      return this.errorSession(
        `Failed to spawn OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Block until server is ready before returning to the Supervisor
    const serverReady = await this.waitForServer(baseUrl, 10000);
    if (!serverReady) {
      serverProcess.kill("SIGTERM");
      return this.errorSession("OpenCode server failed to start");
    }

    log.info({ port, cwd: options.cwd }, "OpenCode server ready");

    // Resolve the opencode session ID synchronously (relative to Supervisor startup)
    let opencodeSessionId: string;
    if (options.resumeSessionId?.startsWith("ses_")) {
      opencodeSessionId = options.resumeSessionId;
      log.info({ opencodeSessionId }, "Resuming existing OpenCode session");
    } else {
      try {
        const sessionResponse = await fetch(`${baseUrl}/session`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Yep Anywhere Session" }),
        });

        if (!sessionResponse.ok) {
          throw new Error(`Failed to create session: ${sessionResponse.status}`);
        }

        const sessionData = (await sessionResponse.json()) as { id: string };
        opencodeSessionId = sessionData.id;
        log.info({ opencodeSessionId, port }, "OpenCode session created");
      } catch (error) {
        serverProcess.kill("SIGTERM");
        return this.errorSession(
          `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const queue = new MessageQueue();
    const abortController = new AbortController();
    const pidRef = { value: serverProcess.pid };
    const runtime: OpenCodeRuntimeState = {
      baseUrl,
      opencodeSessionId,
      serverProcess,
      lastRawProviderEventAt: null,
      lastRawProviderEventSource: null,
      lastSessionStatus: null,
      lastSessionStatusAt: null,
    };

    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(
      options.cwd,
      queue,
      abortController.signal,
      options,
      port,
      runtime,
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
      isProcessAlive: () => isProcessStillAlive(serverProcess),
      probeLiveness: () => this.probeLiveness(runtime),
      getProviderActivity: () => this.getProviderActivity(runtime),
      get pid() {
        return pidRef.value;
      },
    };
  }

  /**
   * Return a minimal AgentSession whose iterator immediately yields one error message.
   */
  private errorSession(errorMsg: string): AgentSession {
    const queue = new MessageQueue();
    return {
      iterator: (async function* () {
        yield { type: "error", error: errorMsg } as SDKMessage;
      })(),
      queue,
      abort: () => {},
    };
  }

  private getProviderActivity(
    runtime: OpenCodeRuntimeState,
  ): ProviderActivitySnapshot {
    return {
      lastRawProviderEventAt: runtime.lastRawProviderEventAt,
      lastRawProviderEventSource: runtime.lastRawProviderEventSource,
    };
  }

  private async probeLiveness(
    runtime: OpenCodeRuntimeState,
  ): Promise<ProviderLivenessProbeResult> {
    const checkedAt = new Date();
    const source = "opencode:session/status";

    if (!isProcessStillAlive(runtime.serverProcess)) {
      return {
        status: "unavailable",
        source: "opencode:process",
        detail: "OpenCode server process is not alive",
        checkedAt,
      };
    }

    try {
      const response = await fetch(`${runtime.baseUrl}/session/status`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          status: "error",
          source,
          detail: `OpenCode status request failed with HTTP ${response.status}`,
          checkedAt,
        };
      }

      const statuses = await response.json();
      if (
        !statuses ||
        typeof statuses !== "object" ||
        Array.isArray(statuses)
      ) {
        return {
          status: "error",
          source,
          detail: "OpenCode status response was not a session status map",
          checkedAt,
        };
      }

      const statusMap = statuses as Record<string, unknown>;
      const hasStatus = Object.prototype.hasOwnProperty.call(
        statusMap,
        runtime.opencodeSessionId,
      );
      if (!hasStatus) {
        return {
          status: "idle",
          source,
          detail: "OpenCode status map has no active entry for this session",
          checkedAt,
        };
      }

      const status = this.parseSessionStatus(
        statusMap[runtime.opencodeSessionId],
      );

      if (!status) {
        return {
          status: "error",
          source,
          detail: "OpenCode status entry for this session was not recognized",
          checkedAt,
        };
      }

      runtime.lastSessionStatus = status;
      runtime.lastSessionStatusAt = checkedAt;

      if (status.type === "busy") {
        return {
          status: "active",
          source,
          detail: "OpenCode reports the session is busy",
          checkedAt,
        };
      }

      if (status.type === "retry") {
        return {
          status: "active",
          source,
          detail: `OpenCode is retrying attempt ${status.attempt}: ${status.message}`,
          checkedAt,
        };
      }

      return {
        status: "idle",
        source,
        detail: "OpenCode reports the session is idle",
        checkedAt,
      };
    } catch (error) {
      return {
        status: "error",
        source,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }

  private parseSessionStatus(value: unknown): OpenCodeSessionStatus | null {
    if (!value || typeof value !== "object" || !("type" in value)) {
      return null;
    }

    const status = value as {
      type?: unknown;
      attempt?: unknown;
      message?: unknown;
      next?: unknown;
    };
    if (status.type === "busy" || status.type === "idle") {
      return { type: status.type };
    }
    if (status.type === "retry") {
      return {
        type: "retry",
        attempt: typeof status.attempt === "number" ? status.attempt : 0,
        message:
          typeof status.message === "string"
            ? status.message
            : "retrying request",
        next: typeof status.next === "number" ? status.next : 0,
      };
    }
    return null;
  }

  /**
   * Main session loop.
   * Server is already started and opencodeSessionId is already known
   * (resolved in startSession before the iterator was constructed).
   * The first yield is always the init message, so waitForSessionId() in
   * Process resolves immediately.
   */
  private async *runSession(
    cwd: string,
    queue: MessageQueue,
    signal: AbortSignal,
    options: StartSessionOptions,
    port: number,
    runtime: OpenCodeRuntimeState,
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    // opencode session ID is the YA session ID for opencode sessions
    const sessionId = runtime.opencodeSessionId;

    // Handle abort
    const abortHandler = () => {
      log.info({ port }, "Aborting OpenCode server");
      runtime.serverProcess.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler);

    // Emit init message immediately — this is what resolves waitForSessionId()
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd,
    } as SDKMessage;

    try {
      let isFirstNewMessage = true;
      for await (const message of queue) {
        if (signal.aborted) break;

        let userPrompt = this.extractTextFromMessage(message);

        if (isFirstNewMessage && options.globalInstructions) {
          userPrompt = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userPrompt}`;
        }
        isFirstNewMessage = false;

        yield {
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userPrompt,
          },
        } as SDKMessage;

        yield* this.sendMessageAndStream(
          runtime,
          sessionId,
          userPrompt,
          options.model,
          signal,
        );
      }
    } finally {
      log.info({ port, sessionId }, "Shutting down OpenCode server");
      signal.removeEventListener("abort", abortHandler);

      if (!runtime.serverProcess.killed) {
        runtime.serverProcess.kill("SIGTERM");
      }
    }
  }

  /**
   * Send a message to OpenCode and stream the response via SSE.
   */
  private async *sendMessageAndStream(
    runtime: OpenCodeRuntimeState,
    sessionId: string,
    text: string,
    model: string | undefined,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    let modelSelection: OpenCodeModelSelection | undefined;
    try {
      modelSelection = parseOpenCodeModelSelection(model);
    } catch (error) {
      yield {
        type: "error",
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      } as SDKMessage;
      return;
    }

    const sseUrl = `${runtime.baseUrl}/event`;
    const sseController = new AbortController();

    // Event buffer and signaling for producer/consumer pattern
    // Using an object to avoid TypeScript control flow issues across async boundaries
    const state = {
      eventBuffer: [] as SDKMessage[],
      sseError: null as Error | null,
      sseComplete: false,
      resolveWaiting: null as (() => void) | null,
    };

    // Start SSE connection immediately (runs in background)
    const ssePromise = (async () => {
      try {
        const response = await fetch(sseUrl, {
          headers: { Accept: "text/event-stream" },
          signal: sseController.signal,
        });

        if (!response.ok || !response.body) {
          log.error({ status: response.status }, "Failed to connect to SSE");
          state.sseError = new Error(
            `SSE connection failed: ${response.status}`,
          );
          return;
        }

        log.debug({ sseUrl }, "SSE connected");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentAssistantMessageId: string | null = null;
        const messageRolesById = new Map<string, "user" | "assistant">();

        while (!sseController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.slice(6);
            const event = parseOpenCodeSSEEvent(data);
            if (!event) continue;

            log.trace({ event }, "SSE event received");

            const eventSessionId = getOpenCodeEventSessionId(event);
            if (
              eventSessionId !== undefined &&
              eventSessionId !== runtime.opencodeSessionId
            ) {
              continue;
            }

            updateOpenCodeRuntimeEvent(runtime, event);
            if (event.type === "message.updated") {
              const messageEvent = event as OpenCodeMessageUpdatedEvent;
              messageRolesById.set(
                messageEvent.properties.info.id,
                messageEvent.properties.info.role,
              );
            }

            // Convert to SDK message
            const sdkMessage = this.convertSSEEventToSDKMessage(
              event,
              sessionId,
              currentAssistantMessageId,
              messageRolesById,
            );

            if (sdkMessage) {
              // Track assistant message ID for consistent streaming
              if (
                sdkMessage.type === "assistant" &&
                "uuid" in sdkMessage &&
                sdkMessage.uuid
              ) {
                currentAssistantMessageId = sdkMessage.uuid as string;
              }
              state.eventBuffer.push(sdkMessage);
              // Wake up consumer if waiting
              state.resolveWaiting?.();
            }

            // Stop on session.idle
            if (event.type === "session.idle") {
              log.debug(
                { opencodeSessionId: runtime.opencodeSessionId },
                "Session idle, stopping SSE",
              );
              return;
            }
          }
        }
      } catch (error) {
        if (!sseController.signal.aborted) {
          log.error({ error }, "SSE connection error");
          state.sseError =
            error instanceof Error ? error : new Error(String(error));
        }
      } finally {
        state.sseComplete = true;
        state.resolveWaiting?.();
      }
    })();

    // Wait briefly for SSE connection to establish
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send the message
    try {
      log.debug(
        {
          opencodeSessionId: runtime.opencodeSessionId,
          textLength: text.length,
          model: modelSelection,
        },
        "Sending message to OpenCode",
      );
      const response = await fetch(
        `${runtime.baseUrl}/session/${runtime.opencodeSessionId}/message`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...(modelSelection ? { model: modelSelection } : {}),
            parts: [{ type: "text", text }],
          }),
          signal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to send message: ${response.status} ${errorText}`,
        );
      }
      log.debug(
        { opencodeSessionId: runtime.opencodeSessionId },
        "Message sent successfully",
      );
    } catch (error) {
      sseController.abort();
      if (signal.aborted) {
        return;
      }
      log.error({ error }, "Failed to send message to OpenCode");
      yield {
        type: "error",
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      } as SDKMessage;
      return;
    }

    // Yield events from buffer as they arrive
    try {
      while (!signal.aborted) {
        // Yield any buffered events
        while (state.eventBuffer.length > 0) {
          const event = state.eventBuffer.shift();
          if (event) yield event;
        }

        // Check if done
        if (state.sseComplete) break;
        if (state.sseError) {
          yield {
            type: "error",
            session_id: sessionId,
            error: state.sseError.message,
          } as SDKMessage;
          break;
        }

        // Wait for more events
        await new Promise<void>((resolve) => {
          state.resolveWaiting = resolve;
          // Also resolve after a short timeout to check conditions
          setTimeout(resolve, 100);
        });
        state.resolveWaiting = null;
      }
    } finally {
      sseController.abort();
      await ssePromise; // Ensure SSE task completes
    }

    // Emit result message
    yield {
      type: "result",
      session_id: sessionId,
    } as SDKMessage;
  }

  /**
   * Convert an OpenCode SSE event to an SDK message.
   */
  private convertSSEEventToSDKMessage(
    event: OpenCodeSSEEvent,
    sessionId: string,
    currentMessageId: string | null,
    messageRolesById: ReadonlyMap<string, "user" | "assistant">,
  ): SDKMessage | null {
    switch (event.type) {
      case "message.part.updated": {
        const partEvent = event as OpenCodeMessagePartUpdatedEvent;
        const part = partEvent.properties.part;
        const delta = partEvent.properties.delta;

        return this.convertPartToSDKMessage(
          part,
          sessionId,
          delta,
          currentMessageId,
          messageRolesById.get(part.messageID),
        );
      }

      case "session.idle":
      case "session.status":
      case "session.updated":
      case "session.diff":
      case "message.updated":
      case "server.connected":
        // These are status events, not content - skip
        return null;

      default:
        return null;
    }
  }

  /**
   * Convert an OpenCode part to an SDK message.
   */
  private convertPartToSDKMessage(
    part: OpenCodePart,
    sessionId: string,
    delta: string | undefined,
    currentMessageId: string | null,
    messageRole: "user" | "assistant" | undefined,
  ): SDKMessage | null {
    switch (part.type) {
      case "text": {
        if (messageRole === "user") {
          return null;
        }

        // Use delta if available (streaming), otherwise full text
        const text = delta ?? part.text ?? "";
        if (!text) return null;

        return {
          type: "assistant",
          session_id: sessionId,
          uuid: currentMessageId ?? part.messageID,
          message: {
            role: "assistant",
            content: text,
          },
        } as SDKMessage;
      }

      case "step-start":
        // Start of a processing step - no content to emit
        return null;

      case "step-finish": {
        // End of processing step - emit usage info if available
        if (part.tokens) {
          return {
            type: "result",
            session_id: sessionId,
            usage: {
              input_tokens: part.tokens.input ?? 0,
              output_tokens: part.tokens.output ?? 0,
            },
          } as SDKMessage;
        }
        return null;
      }

      case "tool-use": {
        // Tool invocation
        return {
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: part.id,
                name: part.tool ?? "unknown",
                input: part.input ?? {},
              },
            ],
          },
        } as SDKMessage;
      }

      case "tool-result": {
        // Tool result
        return {
          type: "user",
          session_id: sessionId,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: part.id,
                content: part.error ?? String(part.output ?? ""),
              },
            ],
          },
        } as SDKMessage;
      }

      default:
        return null;
    }
  }

  /**
   * Wait for server to be ready.
   */
  private async waitForServer(
    baseUrl: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${baseUrl}/session`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return false;
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: SDKUserMessage): string {
    const content = message.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      // Extract text from content blocks
      return content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" && block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }

  /**
   * Find the OpenCode CLI path.
   */
  private async findOpenCodePath(): Promise<string | null> {
    // Use configured path if provided
    if (this.opencodePath && existsSync(this.opencodePath)) {
      return this.opencodePath;
    }

    // Check common locations
    const commonPaths = [
      join(homedir(), ".local", "bin", "opencode"),
      "/usr/local/bin/opencode",
      join(homedir(), "bin", "opencode"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    // Try to find in PATH using which
    try {
      const { stdout } = await execAsync(whichCommand("opencode"), {
        encoding: "utf-8",
      });
      const result = stdout.trim();
      if (result && existsSync(result)) {
        return result;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }
}

/**
 * Default OpenCode provider instance.
 */
export const opencodeProvider = new OpenCodeProvider();
