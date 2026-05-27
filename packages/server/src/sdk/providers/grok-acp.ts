/**
 * Grok Build ACP Provider implementation using Agent Client Protocol.
 *
 * Phase 1 (live supervision prototype): core startSession -> iterator/queue/abort,
 * ACPClient wiring for `grok agent stdio`, hardcoded `grok-build` model,
 * basic install/auth detection via ~/.grok/bin/grok + ~/.grok/auth.json,
 * normalization of ACP events (agent_thought_chunk, tool_call*,
 * agent_message_chunk, plan) into SDKMessage (thinking blocks + tool_use/tool_result + approvals).
 *
 * Effort mapping: YA EffortLevel is passed through to Grok's top-level --effort flag.
 *
 * **STRICT ISOLATION (per topics/grok.md + AGENTS.md + CLAUDE.local.md)**:
 * - No edits to Process.ts, Supervisor.ts, core routing, messageQueue, other providers,
 *   shared hot paths, or any non-registration files.
 * - Gated behind `ENABLED_PROVIDERS=grok` (or equivalent filter); when the env var
 *   does not list "grok", this code is unreachable and other providers are 100% unaffected.
 *
 * Modeled *closely* on gemini-acp.ts + ACPClient (patterns copied/adapted *into this file only*;
 * no shared refactoring or extraction until Grok proven in later phases).
 *
 * Authoritative references (highest priority):
 * - /local/graehl/yepanywhere/topics/grok.md (full contract, Phase plan, non-goals)
 * - /home/graehl/.grok/docs/user-guide/15-agent-mode.md ("grok agent stdio", ACP events,
 *   stdio transport, extension methods, integration example using spawn("grok", ["agent", "stdio"]))
 * - /home/graehl/.grok/docs/user-guide/17-sessions.md (agent stdio session management via ACP)
 * - /home/graehl/.grok/docs/user-guide/02-authentication.md (auth.json location + semantics)
 * - /home/graehl/.grok/docs/user-guide/03-keyboard-shortcuts.md + 14-headless-mode.md (effort,
 *   permission modes, interject for future phases)
 * - Local ~/.grok/models_cache.json + `grok models` + `~/.grok/bin/grok --help` (model info)
 * Steering, native ACP fork, scanner/history, full /btw, tests, docs updates = later phases.
 *
 * Beta software (grok 0.1.220 as of 2026-05); surfaces can change. All claims grounded in
 * local binary + docs inspection.
 */

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { whichCommand } from "../cli-detection.js";
import { MessageQueue } from "../messageQueue.js";
import type {
  PermissionMode,
  SDKMessage,
  ToolApprovalResult,
} from "../types.js";
import { ACPClient } from "./acp/client.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

const execAsync = promisify(exec);

/** Stable Grok Build model info from the local CLI (`grok models`). */
const GROK_MODELS: ModelInfo[] = [
  {
    id: "grok-build",
    name: "Grok Build",
    description: "Best for advanced coding tasks",
    contextWindow: 512000,
    isDefault: true,
  },
];

interface GrokAuthProfile {
  access_token?: unknown;
  refresh_token?: unknown;
  session?: unknown;
  key?: unknown;
  api_key?: unknown;
  expires_at?: unknown;
  expiry_date?: unknown;
  email?: unknown;
  name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  [key: string]: unknown;
}

/**
 * Configuration for Grok ACP provider (rarely needed; auto-detects preferred ~/.grok/bin/grok).
 */
export interface GrokACPProviderConfig {
  /** Path to grok binary (auto-detected if not specified) */
  grokPath?: string;
  /** Test seam for deterministic ACP client injection. */
  createClient?: () => ACPClient;
  /** Test seam for deterministic install detection. */
  pathExists?: (path: string) => boolean;
}

/**
 * Grok Build ACP Provider (Phase 1).
 *
 * Uses the Grok CLI's `grok agent stdio` subcommand for ACP protocol support
 * (JSON-RPC over stdio). The agent manages its own tool loop + sandbox; we
 * surface thoughts, tool calls (with diffs/locations via protocol), and route
 * permission requests to YA's approval flow.
 */
export class GrokACPProvider implements AgentProvider {
  readonly name: ProviderName = "grok";
  readonly displayName = "Grok Build (ACP)";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true; // Effort via CLI --effort flag (attempted even if model cache says false)
  readonly supportsSlashCommands = false;
  readonly supportsSteering = false; // Explicitly Phase 1 scope (steering/interject + native fork later per topic + user query)

  private readonly grokPath?: string;
  private readonly createClient: () => ACPClient;
  private readonly pathExists: (path: string) => boolean;
  private log = getLogger();

  constructor(config: GrokACPProviderConfig = {}) {
    this.grokPath = config.grokPath;
    this.createClient = config.createClient ?? (() => new ACPClient());
    this.pathExists = config.pathExists ?? existsSync;
  }

  /**
   * Check if the Grok Build CLI is installed (prefers ~/.grok/bin/grok per local install layout).
   */
  async isInstalled(): Promise<boolean> {
    const path = await this.findGrokPath();
    return path !== null;
  }

  /**
   * Check if Grok is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status using ~/.grok/auth.json (and binary presence).
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

    const authPath = join(homedir(), ".grok", "auth.json");
    if (!existsSync(authPath)) {
      return {
        installed: true,
        authenticated: false,
        enabled: false,
      };
    }

    try {
      const rawAuth: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
      const profile = this.findAuthenticatedProfile(rawAuth);
      if (!profile) {
        return {
          installed: true,
          authenticated: false,
          enabled: false,
        };
      }

      const expiresAt = this.parseAuthExpiry(profile);
      const hasRefreshToken = this.hasStringCredential(profile, [
        "refresh_token",
      ]);
      const expiredWithoutRefresh =
        expiresAt !== undefined && expiresAt.getTime() <= Date.now() && !hasRefreshToken;
      const authenticated = !expiredWithoutRefresh;

      return {
        installed: true,
        authenticated,
        enabled: authenticated,
        expiresAt,
        user: this.extractAuthUser(profile),
      };
    } catch {
      return {
        installed: true,
        authenticated: false,
        enabled: false,
      };
    }
  }

  /**
   * Get available Grok models (always just the single grok-build entry).
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    return [...GROK_MODELS];
  }

  /**
   * Start a new Grok ACP session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();

    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const client = this.createClient();
    const iterator = this.runSession(
      client,
      options,
      queue,
      abortController.signal,
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        client.close();
      },
      get pid() {
        return client.pid;
      },
    };
  }

  /**
   * Main session loop using ACP protocol over `grok agent stdio`.
   */
  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const grokPath = await this.findGrokPath();
    if (!grokPath) {
      yield {
        type: "error",
        error:
          "Grok Build CLI not found. Ensure ~/.grok/bin/grok exists or is in PATH. See ~/.grok/docs/user-guide/15-agent-mode.md for `grok agent stdio`.",
      } as SDKMessage;
      return;
    }

    // Build args for `grok agent stdio` (per 15-agent-mode.md and 17-sessions.md).
    // Global flags (--effort, -m) before subcommand where possible.
    const args: string[] = [];
    if (options.effort) {
      args.push("--effort", options.effort);
    }
    if (options.model && options.model !== "grok-build") {
      args.push("-m", options.model);
    }
    args.push("agent", "stdio");

    // (Optional future: --yolo for bypassPermissions, but ACP permission routing is preferred for supervision)

    const updateQueue: SessionNotification[] = [];

    client.setSessionUpdateCallback((update) => {
      updateQueue.push(update);
    });

    this.log.debug(
      { hasOnToolApproval: !!options.onToolApproval },
      "Setting up Grok ACP permission handler (Phase 1)",
    );
    client.setPermissionRequestCallback(async (request) => {
      this.log.debug({ request }, "Grok permission callback invoked");
      return this.handlePermissionRequest(request, options, signal);
    });

    try {
      const connectStart = Date.now();
      await client.connect({
        command: grokPath,
        args,
        cwd: options.cwd,
      });
      this.log.info(
        { durationMs: Date.now() - connectStart, args },
        "Grok ACP connected (agent stdio mode)",
      );

      const initStart = Date.now();
      await client.initialize({});
      this.log.debug(
        { durationMs: Date.now() - initStart },
        "Grok ACP initialized",
      );

      // Create or resume (ACP protocol, same as other ACP providers)
      let sessionId: string;
      if (options.resumeSessionId) {
        try {
          sessionId = await client.resumeSession(
            options.resumeSessionId,
            options.cwd,
          );
          this.log.debug({ sessionId }, "Grok ACP session resumed");
        } catch (resumeErr) {
          this.log.warn(
            { err: resumeErr, resumeSessionId: options.resumeSessionId },
            "Failed to resume Grok ACP session, creating new",
          );
          sessionId = await client.newSession(options.cwd);
          this.log.debug(
            { sessionId, originalSessionId: options.resumeSessionId },
            "Created new Grok ACP session (resume failed)",
          );
        }
      } else {
        sessionId = await client.newSession(options.cwd);
        this.log.debug({ sessionId }, "Grok ACP session created");
      }

      // Emit init
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
      } as SDKMessage;

      // Process messages from the queue (identical pattern to gemini-acp)
      const messageGen = queue;
      let isFirstNewMessage = true;
      for await (const message of messageGen) {
        if (signal.aborted) break;

        let userText = this.extractTextFromMessage(message);

        if (isFirstNewMessage && options.globalInstructions) {
          userText = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userText}`;
        }
        isFirstNewMessage = false;

        const userUuid = (message as { uuid?: string }).uuid ?? randomUUID();
        yield {
          type: "user",
          uuid: userUuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userText,
          },
        } as SDKMessage;

        updateQueue.length = 0;

        const promptStart = Date.now();
        this.log.debug(
          { textLength: userText.length },
          "Sending prompt to Grok",
        );
        const promptPromise = client.prompt(sessionId, userText);

        for await (const msg of this.yieldUpdates(
          promptPromise,
          updateQueue,
          sessionId,
          signal,
        )) {
          yield msg;
        }
        this.log.debug(
          { durationMs: Date.now() - promptStart },
          "Grok prompt complete",
        );

        yield {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
      }
    } catch (err) {
      this.log.error({ err }, "Grok ACP session error");
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      } as SDKMessage;
    } finally {
      client.close();
    }
  }

  /**
   * Handle ACP permission request (identical structure + Grok logging to gemini-acp.ts:453).
   */
  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const { onToolApproval, permissionMode } = options;
    const toolCall = request.toolCall;
    const kind = toolCall.kind ?? "other";

    if (this.shouldAutoApprove(kind, permissionMode)) {
      this.log.debug(
        { kind, permissionMode },
        "Auto-approving Grok ACP permission request",
      );
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOnceOption?.optionId ?? "proceed_once",
        },
      };
    }

    if (!onToolApproval) {
      this.log.warn(
        { kind, permissionMode },
        "No Grok approval callback available; cancelling permission request",
      );
      return { outcome: { outcome: "cancelled" } };
    }

    const toolName = this.mapKindToToolName(kind, toolCall.title ?? undefined);

    const toolInput = {
      kind,
      title: toolCall.title,
      locations: toolCall.locations,
      content: toolCall.content,
      rawInput: toolCall.rawInput,
    };

    this.log.debug(
      { toolName, toolInput },
      "Requesting user approval for Grok ACP permission",
    );

    const result = await onToolApproval(toolName, toolInput, { signal });

    return this.convertApprovalResultToACPResponse(result, request);
  }

  private shouldAutoApprove(
    kind: ToolKind | null | undefined,
    permissionMode?: PermissionMode,
  ): boolean {
    switch (permissionMode) {
      case "bypassPermissions":
        return true;
      case "acceptEdits":
        return kind === "edit" || kind === "read" || kind === "search";
      case "plan":
        return kind === "read" || kind === "search" || kind === "fetch";
      default:
        return false;
    }
  }

  private mapKindToToolName(
    kind: ToolKind | null | undefined,
    title?: string,
  ): string {
    switch (kind) {
      case "edit":
        return "Write";
      case "delete":
        return "Delete";
      case "move":
        return "Move";
      case "execute":
        return "Bash";
      case "read":
        return "Read";
      case "search":
        return "Search";
      case "fetch":
        return "WebFetch";
      case "think":
        return "Think";
      case "switch_mode":
        return "SwitchMode";
      default:
        return title ?? "GrokTool";
    }
  }

  private convertApprovalResultToACPResponse(
    result: ToolApprovalResult,
    request: RequestPermissionRequest,
  ): RequestPermissionResponse {
    if (result.behavior === "allow") {
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      const allowAlwaysOption = request.options.find(
        (o) => o.kind === "allow_always",
      );
      const selectedOption = allowOnceOption ?? allowAlwaysOption;

      if (selectedOption) {
        return {
          outcome: {
            outcome: "selected",
            optionId: selectedOption.optionId,
          },
        };
      }
      return {
        outcome: {
          outcome: "selected",
          optionId: "proceed_once",
        },
      };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  /**
   * Async generator to yield session updates as SDKMessages (adapted for Grok events).
   */
  private async *yieldUpdates(
    promptPromise: Promise<unknown>,
    updateQueue: SessionNotification[],
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    let promptDone = false;
    let promptError: unknown = null;

    promptPromise
      .then(() => {
        promptDone = true;
      })
      .catch((err) => {
        promptDone = true;
        promptError = err;
        this.log.error({ err }, "Grok prompt error");
      });

    let assistantTextBuffer = "";
    let assistantMessageId: string | null = null;
    const toolStates = new Map<
      string,
      { name: string; input: Record<string, unknown> }
    >();

    // Accumulate agent_thought_chunk deltas so we emit growing (not per-token) thinking blocks.
    // Prevents the "Thinking ▸ word Thinking ▸ user ..." cascade seen in live testing.
    let thinkingBuffer = "";
    let thinkingMessageId: string | null = null;

    while (!signal.aborted && (!promptDone || updateQueue.length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 50));

      while (updateQueue.length > 0) {
        const notification = updateQueue.shift();
        if (!notification) break;

        const sessionUpdate = notification.update;

        // Handle both text and thought chunks by accumulating (Grok streams thoughts
        // as many small agent_thought_chunk events, just like message chunks).
        if (
          (sessionUpdate.sessionUpdate === "agent_message_chunk" ||
            sessionUpdate.sessionUpdate === "agent_thought_chunk") &&
          "content" in sessionUpdate
        ) {
          const content = (sessionUpdate as any).content;
          if (
            content &&
            typeof content === "object" &&
            "type" in content &&
            content.type === "text" &&
            "text" in content
          ) {
            if (sessionUpdate.sessionUpdate === "agent_thought_chunk") {
              thinkingBuffer += content.text;
              if (!thinkingMessageId) {
                thinkingMessageId = randomUUID();
              }
              continue; // keep accumulating; flush later with other content or on done
            }
            assistantTextBuffer += content.text;
            if (!assistantMessageId) {
              assistantMessageId = randomUUID();
            }
            continue;
          }
        }

        // Flush any pending thinking buffer before yielding non-thought content
        // (e.g. tool calls, final text). This produces one (or few) growing thinking blocks
        // instead of dozens of tiny ones.
        if (thinkingBuffer) {
          yield {
            type: "assistant",
            uuid: thinkingMessageId ?? undefined,
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: thinkingBuffer,
                },
              ],
            },
          } as SDKMessage;
          thinkingBuffer = "";
          thinkingMessageId = null;
        }

        if (assistantTextBuffer) {
          yield {
            type: "assistant",
            uuid: assistantMessageId ?? undefined,
            session_id: sessionId,
            message: {
              role: "assistant",
              content: assistantTextBuffer,
            },
          } as SDKMessage;
          assistantTextBuffer = "";
          assistantMessageId = null;
        }

        const sdkMessage = this.convertUpdateToSDKMessage(
          sessionUpdate,
          sessionId,
          toolStates,
        );
        if (sdkMessage) {
          yield sdkMessage;
        }
      }
    }

    // Final flush: thinking first (so reasoning appears before any trailing text), then text.
    if (thinkingBuffer) {
      yield {
        type: "assistant",
        uuid: thinkingMessageId ?? undefined,
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: thinkingBuffer,
            },
          ],
        },
      } as SDKMessage;
    }
    if (assistantTextBuffer) {
      yield {
        type: "assistant",
        uuid: assistantMessageId ?? undefined,
        session_id: sessionId,
        message: {
          role: "assistant",
          content: assistantTextBuffer,
        },
      } as SDKMessage;
    }

    if (promptError) {
      throw promptError;
    }
  }

  /**
   * Convert ACP SessionUpdate to SDKMessage (Phase 1 normalization for Grok events).
   * Handles: agent_thought_chunk (thinking), agent_message_chunk, tool_call/tool_call_update,
   * plan. Based on gemini-acp.ts:706 + Grok 15-agent-mode.md table.
   */
  private convertUpdateToSDKMessage(
    update: SessionUpdate,
    sessionId: string,
    toolStates: Map<string, { name: string; input: Record<string, unknown> }>,
  ): SDKMessage | null {
    const updateType = update.sessionUpdate;

    switch (updateType) {
      case "agent_message_chunk": {
        // Streaming text chunks are primarily buffered + emitted from yieldUpdates.
        // This path is a fallback for non-buffered cases.
        if ("content" in update) {
          const contentBlock = (update as any).content;
          if (
            contentBlock &&
            typeof contentBlock === "object" &&
            "type" in contentBlock &&
            contentBlock.type === "text" &&
            "text" in contentBlock
          ) {
            return {
              type: "assistant",
              session_id: sessionId,
              message: {
                role: "assistant",
                content: contentBlock.text as string,
              },
            } as SDKMessage;
          }
        }
        return null;
      }
      case "agent_thought_chunk": {
        // Streaming thoughts are accumulated in yieldUpdates (thinkingBuffer) to avoid
        // emitting a brand-new tiny thinking block per token/chunk (the root cause of the
        // repeated "Thinking ▸ <word>" symptom). We return null here so the buffered
        // growing block is the only one the client sees.
        return null;
      }

      case "tool_call": {
        const toolUpdate = update as ToolCall & { sessionUpdate: "tool_call" };
        return this.buildToolUseMessage(toolUpdate, sessionId, toolStates);
      }

      case "tool_call_update": {
        const toolResultUpdate = update as ToolCallUpdate & {
          sessionUpdate: "tool_call_update";
          error?: string;
        };
        if (this.isTerminalToolUpdate(toolResultUpdate)) {
          const toolCallId = toolResultUpdate.toolCallId ?? "";
          return {
            type: "user",
            uuid: toolCallId ? `${toolCallId}:result` : undefined,
            session_id: sessionId,
            toolUseResult: this.buildStructuredToolResult(
              toolResultUpdate,
              toolStates.get(toolCallId)?.input,
            ),
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolCallId,
                  is_error:
                    toolResultUpdate.status === "failed" ||
                    !!toolResultUpdate.error,
                  content: this.formatToolResultContent(toolResultUpdate),
                },
              ],
            },
          } as SDKMessage;
        }
        if (this.hasToolUseMetadata(toolResultUpdate)) {
          return this.buildToolUseMessage(
            toolResultUpdate,
            sessionId,
            toolStates,
          );
        }
        return null;
      }

      case "plan": {
        const entries = update.entries ?? [];
        if (entries.length > 0) {
          return {
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: entries
                    .map((entry) => `${entry.status}: ${entry.content}`)
                    .join("\n"),
                },
              ],
            },
          } as SDKMessage;
        }
        return null;
      }

      default:
        this.log.trace(
          { updateType, update },
          "Unhandled Grok ACP update type (Phase 1 placeholder - extend in later phase)",
        );
        return null;
    }
  }

  /**
   * Extract text content from a user message (identical to gemini-acp.ts:822).
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    const userMsg = message as { text?: string };
    if (typeof userMsg.text === "string") {
      return userMsg.text;
    }

    const sdkMsg = message as {
      message?: { content?: string | unknown[] };
    };
    const content = sdkMsg.message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (typeof block === "string") return block;
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            return (block as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  /**
   * Find the Grok CLI path (strongly prefers ~/.grok/bin/grok per local layout + topic).
   */
  private async findGrokPath(): Promise<string | null> {
    if (this.grokPath) {
      return this.pathExists(this.grokPath) ? this.grokPath : null;
    }

    const home = homedir();
    const preferred = join(home, ".grok", "bin", "grok");
    if (this.pathExists(preferred)) {
      return preferred;
    }

    const commonPaths = [
      join(home, ".local", "bin", "grok"),
      "/usr/local/bin/grok",
      join(home, "bin", "grok"),
      join(home, ".grok", "grok"),
    ];

    for (const path of commonPaths) {
      if (this.pathExists(path)) {
        return path;
      }
    }

    try {
      const { stdout } = await execAsync(whichCommand("grok"), {
        encoding: "utf-8",
      });
      const result = stdout.trim().split("\n")[0];
      if (result && this.pathExists(result)) {
        return result;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }

  private findAuthenticatedProfile(rawAuth: unknown): GrokAuthProfile | null {
    const profiles = this.collectAuthProfiles(rawAuth);
    return (
      profiles.find((profile) =>
        this.hasStringCredential(profile, [
          "access_token",
          "refresh_token",
          "session",
          "key",
          "api_key",
        ]),
      ) ?? null
    );
  }

  private collectAuthProfiles(rawAuth: unknown): GrokAuthProfile[] {
    if (!rawAuth || typeof rawAuth !== "object" || Array.isArray(rawAuth)) {
      return [];
    }

    const root = rawAuth as GrokAuthProfile;
    const profiles = [root];
    for (const value of Object.values(root)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        profiles.push(value as GrokAuthProfile);
      }
    }
    return profiles;
  }

  private hasStringCredential(
    profile: GrokAuthProfile,
    fields: string[],
  ): boolean {
    return fields.some((field) => {
      const value = profile[field];
      return typeof value === "string" && value.trim().length > 0;
    });
  }

  private parseAuthExpiry(profile: GrokAuthProfile): Date | undefined {
    const expiresAt = profile.expires_at;
    if (typeof expiresAt === "string") {
      const parsed = new Date(expiresAt);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }

    const expiryDate = profile.expiry_date;
    if (typeof expiryDate === "number") {
      const parsed = new Date(expiryDate);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }

    return undefined;
  }

  private extractAuthUser(profile: GrokAuthProfile): AuthStatus["user"] {
    const email = typeof profile.email === "string" ? profile.email : undefined;
    const name =
      typeof profile.name === "string"
        ? profile.name
        : [profile.first_name, profile.last_name]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.length > 0,
            )
            .join(" ") || undefined;

    return email || name ? { email, name } : undefined;
  }

  private buildToolUseMessage(
    toolUpdate: ToolCall | ToolCallUpdate,
    sessionId: string,
    toolStates: Map<string, { name: string; input: Record<string, unknown> }>,
  ): SDKMessage {
    const toolCallId = toolUpdate.toolCallId ?? randomUUID();
    const previous = toolStates.get(toolCallId);
    const name = this.mapToolUpdateToToolName(toolUpdate, previous);
    const input = this.buildToolInput(toolUpdate, previous?.input);
    toolStates.set(toolCallId, { name, input });
    return {
      type: "assistant",
      uuid: toolCallId,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name,
            input,
          },
        ],
      },
    } as SDKMessage;
  }

  private mapToolUpdateToToolName(
    toolUpdate: ToolCall | ToolCallUpdate,
    previous?: { name: string },
  ): string {
    const kind = "kind" in toolUpdate ? toolUpdate.kind : undefined;
    const title = "title" in toolUpdate ? toolUpdate.title : undefined;
    if (kind) {
      return this.mapKindToToolName(kind, title ?? undefined);
    }
    switch (title) {
      case "read_file":
        return "Read";
      case "run_terminal_command":
        return "Bash";
      default:
        return title ?? previous?.name ?? "GrokTool";
    }
  }

  private buildToolInput(
    toolUpdate: ToolCall | ToolCallUpdate,
    previousInput?: Record<string, unknown>,
  ): Record<string, unknown> {
    const input: Record<string, unknown> = { ...previousInput };
    const kind = "kind" in toolUpdate ? toolUpdate.kind : undefined;
    const title = "title" in toolUpdate ? toolUpdate.title : undefined;
    const rawInput = this.asRecord(
      "rawInput" in toolUpdate ? toolUpdate.rawInput : undefined,
    );
    const locations =
      "locations" in toolUpdate && toolUpdate.locations?.length
        ? toolUpdate.locations
        : undefined;
    const firstPath = this.firstLocationPath(locations);

    if (this.isReadTool(kind, title)) {
      const filePath = this.stringField(rawInput, "target_file") ?? firstPath;
      if (filePath) input.file_path = filePath;
    }
    if (this.isExecuteTool(kind, title)) {
      const command = this.stringField(rawInput, "command");
      const description = this.stringField(rawInput, "description");
      const timeout = this.numberField(rawInput, "timeout");
      if (command) input.command = command;
      if (description) input.description = description;
      if (timeout !== undefined) input.timeout = timeout;
    }

    if ("kind" in toolUpdate && toolUpdate.kind) input.kind = toolUpdate.kind;
    if ("title" in toolUpdate && toolUpdate.title) input.title = toolUpdate.title;
    if ("status" in toolUpdate && toolUpdate.status) input.status = toolUpdate.status;
    if (locations) input.locations = locations;
    if ("rawInput" in toolUpdate && toolUpdate.rawInput !== undefined) {
      input.rawInput = toolUpdate.rawInput;
    }
    if ("content" in toolUpdate && toolUpdate.content?.length) {
      input.content = toolUpdate.content;
    }
    return input;
  }

  private isTerminalToolUpdate(update: ToolCallUpdate & { error?: string }) {
    return (
      update.status === "completed" || update.status === "failed" || !!update.error
    );
  }

  private hasToolUseMetadata(update: ToolCallUpdate): boolean {
    return (
      !!update.kind ||
      !!update.title ||
      !!update.status ||
      !!update.locations?.length ||
      update.rawInput !== undefined ||
      update.content !== undefined
    );
  }

  private formatToolResultContent(
    update: ToolCallUpdate & { error?: string },
  ): string {
    if (update.error) return update.error;
    if (typeof update.rawOutput === "string") return update.rawOutput;
    if (update.rawOutput !== undefined) return JSON.stringify(update.rawOutput);
    if (update.content !== undefined) return JSON.stringify(update.content);
    return update.status ?? "completed";
  }

  private buildStructuredToolResult(
    update: ToolCallUpdate & { error?: string },
    toolInput?: Record<string, unknown>,
  ): unknown {
    if (update.error) return update.error;
    const rawOutput = this.asRecord(update.rawOutput);
    if (!rawOutput) {
      return update.content ?? update.status ?? "completed";
    }

    if (rawOutput.type === "Bash") {
      return {
        stdout:
          this.decodeByteArray(rawOutput.output) ??
          this.stringField(rawOutput, "output_for_prompt") ??
          "",
        stderr: "",
        interrupted: false,
        isImage: false,
      };
    }

    if (rawOutput.type === "ReadFile") {
      const fileContent = this.asRecord(rawOutput.FileContent);
      const content = this.stringField(fileContent, "content") ?? "";
      const totalLines =
        this.numberField(fileContent, "total_lines") ??
        (content ? content.split("\n").length : 0);
      const filePath =
        this.stringField(fileContent, "absolute_path") ??
        this.firstLocationPath(update.locations) ??
        this.stringField(this.asRecord(update.rawInput), "target_file") ??
        this.stringField(toolInput, "file_path") ??
        "";
      return {
        type: "text",
        file: {
          filePath,
          content,
          numLines: totalLines,
          startLine: 1,
          totalLines,
        },
      };
    }

    return update.rawOutput;
  }

  private isReadTool(
    kind: ToolKind | null | undefined,
    title: string | null | undefined,
  ): boolean {
    return kind === "read" || title === "read_file";
  }

  private isExecuteTool(
    kind: ToolKind | null | undefined,
    title: string | null | undefined,
  ): boolean {
    return kind === "execute" || title === "run_terminal_command";
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringField(
    record: Record<string, unknown> | undefined,
    field: string,
  ): string | undefined {
    const value = record?.[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private numberField(
    record: Record<string, unknown> | undefined,
    field: string,
  ): number | undefined {
    const value = record?.[field];
    return typeof value === "number" ? value : undefined;
  }

  private firstLocationPath(
    locations: ToolCall["locations"] | ToolCallUpdate["locations"] | undefined,
  ): string | undefined {
    const first = locations?.[0] as { path?: unknown } | undefined;
    return typeof first?.path === "string" ? first.path : undefined;
  }

  private decodeByteArray(value: unknown): string | undefined {
    if (
      !Array.isArray(value) ||
      !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      return undefined;
    }
    return new TextDecoder().decode(Uint8Array.from(value as number[]));
  }
}

/**
 * Default Grok ACP provider instance.
 */
export const grokACPProvider = new GrokACPProvider();
