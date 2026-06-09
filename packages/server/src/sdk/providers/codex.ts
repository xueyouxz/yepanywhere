/**
 * Codex Provider implementation using codex app-server JSON-RPC.
 *
 * Uses `codex app-server --listen stdio://` for turn execution so we can handle
 * server-initiated permission requests (command/file approval).
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  HELPER_SIDE_MODEL_CHEAPEST,
  type ModelInfo,
  type SlashCommand,
} from "@yep-anywhere/shared";
import {
  isCodexCorrelationDebugEnabled,
  logCodexCorrelationDebug,
  summarizeCodexNormalizedMessage,
} from "../../codex/correlationDebugLogger.js";
import {
  canonicalizeCodexToolName,
  isCodexBackgroundProcessOutput,
  isCodexInterruptedToolOutput,
  type CodexToolCallContext,
  normalizeCodexCommandExecutionOutput,
  normalizeCodexToolInvocation,
  normalizeCodexToolOutputWithContext,
  parseCodexToolArguments,
} from "../../codex/normalization.js";
import { getLogger } from "../../logging/logger.js";
import { findCodexCliPath } from "../cli-detection.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import type {
  ProviderActivitySnapshot,
  ProviderLivenessProbeResult,
  SDKMessage,
  TimestampedSDKMessage,
  UserMessage,
} from "../types.js";
import type { ToolApprovalResult } from "../types.js";
import type {
  AgentMessageDeltaNotification,
  AskForApproval as CodexAskForApproval,
  CommandExecutionOutputDeltaNotification,
  ErrorNotification as CodexErrorNotification,
  FileChangeOutputDeltaNotification,
  ItemCompletedNotification as CodexItemCompletedNotification,
  ItemStartedNotification as CodexItemStartedNotification,
  PlanDeltaNotification,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  RawResponseItemCompletedNotification,
  ReasoningSummaryTextDeltaNotification,
  SandboxMode as CodexSandboxMode,
  ThreadReadParams,
  ThreadItem as CodexThreadItem,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./codex-protocol/index.js";
import { createAgentctlSessionEnvBridge } from "./agentctl-session-env.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

const log = getLogger().child({ component: "codex-provider" });
const execFileAsync = promisify(execFile);

function logSdkCorrelationDebug(
  sessionId: string,
  message: SDKMessage,
  metadata: {
    eventKind?: string;
    turnId?: string;
    itemId?: string;
    callId?: string;
    phase?: string;
    sourceEvent?: string;
    status?: string;
  } = {},
): void {
  if (!isCodexCorrelationDebugEnabled()) return;
  logCodexCorrelationDebug({
    sessionId,
    channel: "sdk",
    authority: "transient",
    ...metadata,
    ...summarizeCodexNormalizedMessage(message),
  });
}

function withCodexTimestamp<T extends SDKMessage>(
  message: T,
  timestamp = new Date().toISOString(),
): TimestampedSDKMessage<T> {
  if (
    typeof message.timestamp === "string" &&
    message.timestamp.trim().length > 0
  ) {
    return message as TimestampedSDKMessage<T>;
  }
  return {
    ...message,
    timestamp,
  } as TimestampedSDKMessage<T>;
}

function stringifyTraceValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 8000;
const APP_SERVER_INIT_REQUEST_ID = 1;
const APP_SERVER_MODEL_LIST_REQUEST_ID = 2;
const APP_SERVER_SHUTDOWN_GRACE_MS = 1500;
const CODEX_CLI_GPT55_MIN_VERSION = "0.124.0";
const CODEX_FAILURE_TRACE_LIMIT = 12;
const CODEX_FAILURE_PREVIEW_CHARS = 240;
const CODEX_RECAP_TIMEOUT_MS = 20_000;
const CODEX_RECAP_MAX_TOTAL_CHARS = 6000;
const CODEX_RECAP_CHEAPEST_MODEL_PREFERENCES = [
  "gpt-5.4-mini",
  "gpt-5.1-codex-mini",
  "gpt-5.3-codex-spark",
] as const;
const CODEX_DISABLE_LIVE_DELTAS_ENV = "YA_CODEX_DISABLE_LIVE_DELTAS";
const CODEX_LIVE_DELTA_NOTIFICATION_METHODS = new Set<string>([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
]);
function isCodexLiveDeltaSuppressionEnabled(): boolean {
  return process.env[CODEX_DISABLE_LIVE_DELTAS_ENV] === "true";
}
function isCodexLiveDeltaNotificationMethod(method: string): boolean {
  return CODEX_LIVE_DELTA_NOTIFICATION_METHODS.has(method);
}
const CODEX_BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "goal",
    description: "Keep working toward a verifiable end state until it is met",
    argumentHint: "<verifiable end state>",
  },
];
const CODEX_THINKING_OFF_MIN_REASONING_EFFORT_PREFIXES = [
  "gpt-5.3-codex-spark",
] as const;

/**
 * Local debug knobs for Codex app-server policy behavior.
 *
 * Set `approvalPolicy` to `"untrusted"` to force Codex to request approval for
 * command/file actions more aggressively, even when `"on-request"` would not.
 * Leave as `null` for normal behavior.
 */
const CODEX_POLICY_OVERRIDES: {
  approvalPolicy: CodexAskForApproval | null;
  sandbox: CodexSandboxMode | null;
} = {
  approvalPolicy: null,
  sandbox: null,
};

interface CodexThreadPolicy {
  approvalPolicy: CodexAskForApproval;
  sandbox: CodexSandboxMode;
}

interface CodexThreadReadResponse {
  thread?: {
    id?: string;
    status?: {
      type?: string;
      activeFlags?: unknown;
    };
  };
}

type CodexThreadResumeParamsForRequest = ThreadResumeParams;

/**
 * When enabled, declare Codex session originator as "Codex Desktop"
 * when initializing app-server sessions.
 */
const DECLARE_CODEX_ORIGINATOR = true;
const DECLARED_CODEX_ORIGINATOR = "Codex Desktop";
const YEP_ANYWHERE_ORIGINATOR = "yep-anywhere";

const PREFERRED_MODEL_ORDER = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.1-codex-mini",
] as const;

const FALLBACK_CODEX_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    description:
      "Frontier model for complex coding, research, and real-world work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      {
        reasoningEffort: "low",
        description: "Fast responses with lighter reasoning",
      },
      {
        reasoningEffort: "medium",
        description: "Balances speed and reasoning depth for everyday tasks",
      },
      {
        reasoningEffort: "high",
        description: "Greater reasoning depth for complex problems",
      },
      {
        reasoningEffort: "xhigh",
        description: "Extra high reasoning depth for complex problems",
      },
    ],
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "Strong model for everyday coding.",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      {
        reasoningEffort: "low",
        description: "Fast responses with lighter reasoning",
      },
      {
        reasoningEffort: "medium",
        description: "Balances speed and reasoning depth for everyday tasks",
      },
      {
        reasoningEffort: "high",
        description: "Greater reasoning depth for complex problems",
      },
      {
        reasoningEffort: "xhigh",
        description: "Extra high reasoning depth for complex problems",
      },
    ],
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    description:
      "Small, fast, and cost-efficient model for simpler coding tasks.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      {
        reasoningEffort: "low",
        description: "Fast responses with lighter reasoning",
      },
      {
        reasoningEffort: "medium",
        description: "Balances speed and reasoning depth for everyday tasks",
      },
      {
        reasoningEffort: "high",
        description: "Greater reasoning depth for complex problems",
      },
      {
        reasoningEffort: "xhigh",
        description: "Extra high reasoning depth for complex problems",
      },
    ],
    inputModalities: ["text", "image"],
    supportsPersonality: true,
  },
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3-Codex-Spark" },
  { id: "gpt-5.2", name: "GPT-5.2" },
];

const LEGACY_FALLBACK_CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
  { id: "gpt-5.2-codex", name: "GPT-5.2-Codex" },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1-Codex-Max" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1-Codex-Mini" },
];

type JsonRpcId = string | number;

interface JsonRpcError {
  message?: string;
  code?: number;
  data?: unknown;
}

interface JsonRpcResponse {
  id?: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

interface AppServerModel {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  upgrade?: string | null;
  upgradeInfo?: { model?: string | null } | null;
  hidden?: boolean | null;
  isDefault?: boolean | null;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: Array<{
    reasoningEffort?: string | null;
    description?: string | null;
  }> | null;
  inputModalities?: string[] | null;
  supportsPersonality?: boolean | null;
  serviceTiers?: Array<{
    id?: string | null;
    name?: string | null;
    description?: string | null;
  }> | null;
}

interface TokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextWindow?: number;
}

interface CodexTurnRuntimeState {
  threadId: string;
  activeTurnId: string | null;
  activeToolCallIds: Set<string>;
  backgroundToolCallIds: Set<string>;
}

function normalizeSemver(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/);
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return pre
    ? `${major}.${minor}.${patch}-${pre}`
    : `${major}.${minor}.${patch}`;
}

function compareSemver(a: string, b: string): number {
  const parsedA = splitSemver(a);
  const parsedB = splitSemver(b);
  for (let i = 0; i < 3; i++) {
    const partA = parsedA.parts[i] ?? 0;
    const partB = parsedB.parts[i] ?? 0;
    if (partA !== partB) return partA < partB ? -1 : 1;
  }
  if (parsedA.pre === null && parsedB.pre === null) return 0;
  if (parsedA.pre === null) return 1;
  if (parsedB.pre === null) return -1;
  return parsedA.pre < parsedB.pre ? -1 : parsedA.pre > parsedB.pre ? 1 : 0;
}

function splitSemver(version: string): { parts: number[]; pre: string | null } {
  const dashIndex = version.indexOf("-");
  const core = dashIndex === -1 ? version : version.slice(0, dashIndex);
  const pre = dashIndex === -1 ? null : version.slice(dashIndex + 1);
  return {
    parts: core.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    pre,
  };
}

async function terminateChildProcess(
  child: ChildProcess | null | undefined,
  graceMs = APP_SERVER_SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (!child?.pid || child.killed || child.exitCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  const killTarget =
    process.platform !== "win32" && child.pid > 0 ? -child.pid : child.pid;

  try {
    process.kill(killTarget, "SIGTERM");
  } catch {
    return;
  }

  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    try {
      process.kill(killTarget, "SIGKILL");
    } catch {
      // Ignore escalation failures during shutdown.
    }
  }, graceMs);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

interface NormalizedFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff?: string;
}

interface CodexLiveEventState {
  streamingTextByItemKey: Map<string, string>;
  streamingReasoningSummaryByItemKey: Map<string, string[]>;
  streamingToolOutputByItemKey: Map<string, string>;
  toolCallContexts: Map<string, CodexToolCallContext>;
  resultBackedToolItemsByTurnId: Map<string, Set<string>>;
}

interface CodexFailureTraceEvent {
  at: string;
  sourceEvent: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  status?: string;
  phase?: string;
  toolName?: string;
  command?: string;
  deltaChars?: number;
  outputChars?: number;
  errorMessage?: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
  openaiRequestId?: string;
}

interface CodexFailureTrace {
  sessionId?: string;
  activeTurnId?: string | null;
  lastUserMessage?: {
    uuid?: string;
    chars: number;
  };
  lastNotification?: CodexFailureTraceEvent;
  lastEmittedMessage?: CodexFailureTraceEvent;
  recentNotifications: CodexFailureTraceEvent[];
}

type NormalizedThreadItem =
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "agent_message"; text: string }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output: string;
      exit_code?: number;
      status: string;
    }
  | {
      id: string;
      type: "file_change";
      changes: NormalizedFileChange[];
      status: string;
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server: string;
      tool: string;
      arguments: unknown;
      mcpAppResourceUri?: string;
      result?: unknown;
      error?: { message: string };
      status: string;
    }
  | {
      id: string;
      type: "dynamic_tool_call";
      namespace?: string | null;
      tool: string;
      arguments: unknown;
      status: string;
      content_items?: unknown[] | null;
      success?: boolean | null;
    }
  | { id: string; type: "web_search"; query: string }
  | {
      id: string;
      type: "todo_list";
      items: Array<{ text: string; completed: boolean }>;
    }
  | { id: string; type: "context_compaction" }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "image_view"; path: string };

/**
 * Configuration for Codex provider.
 */
export interface CodexProviderConfig {
  /** Path to codex binary (auto-detected if not specified) */
  codexPath?: string;
  /** API base URL override */
  baseUrl?: string;
  /** API key override (normally read from ~/.codex/auth.json) */
  apiKey?: string;
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private closedError: Error | null = null;

  push(item: T): void {
    if (this.closedError) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(error?: Error): void {
    if (this.closedError) return;
    this.closedError = error ?? new Error("Queue closed");
    for (const waiter of this.waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(this.closedError);
    }
    this.waiters = [];
    this.items = [];
  }

  async shift(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      const item = this.items.shift();
      if (item === undefined) {
        throw new Error("Queue underflow");
      }
      return item;
    }

    if (this.closedError) {
      throw this.closedError;
    }

    return await new Promise<T>((resolve, reject) => {
      const waiter: {
        resolve: (value: T) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("Operation aborted"));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }
}

type AppServerRequestHandler = (
  request: JsonRpcServerRequest,
) => Promise<unknown>;

class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private stdoutBuffer = "";

  /** OS PID of the spawned app-server child process */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  isAlive(): boolean {
    const child = this.process;
    return Boolean(child?.pid && child.exitCode === null && !child.killed);
  }
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    JsonRpcId,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly notifications = new AsyncQueue<JsonRpcNotification>();
  private onServerRequest: AppServerRequestHandler | null = null;
  private closed = false;
  private lastRawProviderEventAt: Date | null = null;
  private lastRawProviderEventSource: string | null = null;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly shouldSuppressNotification?: (
      notification: JsonRpcNotification,
    ) => boolean,
  ) {}

  setServerRequestHandler(handler: AppServerRequestHandler): void {
    this.onServerRequest = handler;
  }

  getProviderActivity(): ProviderActivitySnapshot {
    return {
      lastRawProviderEventAt: this.lastRawProviderEventAt,
      lastRawProviderEventSource: this.lastRawProviderEventSource,
    };
  }

  async connect(): Promise<void> {
    if (this.process) {
      throw new Error("Codex app-server already connected");
    }

    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      shell: process.platform === "win32",
    });

    this.process = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf-8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        this.handleJsonRpcLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const stderr = chunk.toString("utf-8").trim();
      if (stderr) {
        log.debug({ stderr }, "codex app-server stderr");
      }
    });

    child.on("error", (error) => {
      this.handleProcessClose(error);
    });

    child.on("exit", (code, signal) => {
      this.handleProcessClose(
        new Error(
          `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private handleJsonRpcLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.debug({ line }, "Ignoring non-JSON app-server line");
      return;
    }

    const method =
      typeof message.method === "string" ? (message.method as string) : null;
    const hasId =
      typeof message.id === "string" || typeof message.id === "number";

    // Server request/notification
    if (method) {
      if (hasId) {
        this.recordRawProviderEvent(`codex:request:${method}`);
        const request: JsonRpcServerRequest = {
          id: message.id as JsonRpcId,
          method,
          params: message.params,
        };
        this.handleServerRequest(request);
        return;
      }

      const notification = { method, params: message.params };
      if (this.shouldSuppressNotification?.(notification)) {
        return;
      }

      this.recordRawProviderEvent(`codex:notification:${method}`);
      this.notifications.push(notification);
      return;
    }

    // Response to our request
    if (hasId) {
      const id = message.id as JsonRpcId;
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(id);

      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonRpcError;
        const rpcError = new Error(error.message ?? "JSON-RPC request failed");
        Object.assign(rpcError, {
          jsonRpcCode: error.code,
          jsonRpcData: error.data,
          jsonRpcRequestId: id,
        });
        pending.reject(rpcError);
        return;
      }

      pending.resolve(message.result);
    }
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const respond = (payload: Record<string, unknown>) => {
      this.sendRaw({
        jsonrpc: "2.0",
        id: request.id,
        ...payload,
      });
    };

    if (!this.onServerRequest) {
      respond({
        error: {
          code: -32601,
          message: `Unhandled server request: ${request.method}`,
        },
      });
      return;
    }

    void this.onServerRequest(request)
      .then((result) => {
        respond({ result: result ?? {} });
      })
      .catch((error) => {
        respond({
          error: {
            code: -32000,
            message:
              error instanceof Error ? error.message : "Server request failed",
          },
        });
      });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new Error("Codex app-server client is closed");
    }

    const id = this.nextRequestId++;

    const resultPromise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
      });
    });

    this.sendRaw({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return await resultPromise;
  }

  notify(method: string, params?: unknown): void {
    this.sendRaw({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private recordRawProviderEvent(source: string): void {
    this.lastRawProviderEventAt = new Date();
    this.lastRawProviderEventSource = source;
  }

  injectNotification(notification: JsonRpcNotification): void {
    this.notifications.push(notification);
  }

  async nextNotification(signal?: AbortSignal): Promise<JsonRpcNotification> {
    return await this.notifications.shift(signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    const closeError = new Error("Codex app-server client closed");
    for (const pending of this.pendingRequests.values()) {
      pending.reject(closeError);
    }
    this.pendingRequests.clear();
    this.notifications.close(closeError);

    const child = this.process;
    this.process = null;
    void terminateChildProcess(child);
  }

  private handleProcessClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    // Emit a terminal error notification so consumers can surface it.
    this.notifications.push({
      method: "error",
      params: {
        error: { message: error.message },
        willRetry: false,
      },
    });
    this.notifications.close(error);
    this.process = null;
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.process?.stdin || this.closed) {
      return;
    }

    try {
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.handleProcessClose(
        error instanceof Error
          ? error
          : new Error("Failed to write to codex app-server stdin"),
      );
    }
  }
}

/**
 * Codex Provider implementation using app-server JSON-RPC.
 */
export class CodexProvider implements AgentProvider {
  readonly name = "codex" as const;
  readonly displayName = "Codex";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;
  readonly supportsSteering = true;
  readonly supportsRecaps = true;
  readonly supportsNativePromptSuggestions = false;

  private readonly config: CodexProviderConfig;
  private modelCache: { models: ModelInfo[]; expiresAt: number } | null = null;

  constructor(config: CodexProviderConfig = {}) {
    this.config = config;
  }

  setCodexPath(codexPath: string | undefined): void {
    this.config.codexPath = codexPath;
    this.modelCache = null;
  }

  /**
   * Check if the Codex CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    return this.isCodexCliInstalled();
  }

  /**
   * Check if Codex CLI is installed by looking in PATH and common locations.
   */
  private async isCodexCliInstalled(): Promise<boolean> {
    return (await findCodexCliPath(this.config.codexPath)) !== null;
  }

  /**
   * Resolve the codex command: explicit config, PATH, or common install locations.
   */
  private async resolveCodexCommand(): Promise<string> {
    if (this.config.codexPath) return this.config.codexPath;
    return (await findCodexCliPath()) ?? "codex";
  }

  private getCodexClientName(overrideClientName?: string): string {
    const normalizedClientName =
      typeof overrideClientName === "string" ? overrideClientName.trim() : "";
    if (normalizedClientName.length > 0) {
      return normalizedClientName;
    }
    return DECLARE_CODEX_ORIGINATOR
      ? DECLARED_CODEX_ORIGINATOR
      : YEP_ANYWHERE_ORIGINATOR;
  }

  /**
   * Build environment overrides for Codex subprocesses.
   */
  private getCodexEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.config.baseUrl) {
      env.OPENAI_BASE_URL = this.config.baseUrl;
    }
    if (this.config.apiKey) {
      env.OPENAI_API_KEY = this.config.apiKey;
    }
    return env;
  }

  /**
   * Check if Codex is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status.
   * If Codex CLI is installed, assume it's authenticated.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isCodexCliInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
    };
  }

  /**
   * Get available models for Codex cloud.
   * Queries Codex app-server's model/list endpoint with a static fallback.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelCache && this.modelCache.expiresAt > now) {
      return this.modelCache.models;
    }

    let models: ModelInfo[] = [];
    if (await this.isCodexCliInstalled()) {
      models = await this.getModelsFromAppServer();
    }

    if (models.length === 0) {
      models = await this.getFallbackCodexModels();
    }

    this.modelCache = {
      models,
      expiresAt: now + MODEL_CACHE_TTL_MS,
    };

    return models;
  }

  private async getModelsFromAppServer(): Promise<ModelInfo[]> {
    try {
      const appServerModels = await this.requestAppServerModelList();
      return this.normalizeModelList(appServerModels);
    } catch (error) {
      log.debug(
        { error },
        "Failed to query Codex app-server model list, using fallback models",
      );
      return [];
    }
  }

  private async requestAppServerModelList(): Promise<AppServerModel[]> {
    const codexCommand = await this.resolveCodexCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(
        codexCommand,
        ["app-server", "--listen", "stdio://"],
        {
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: this.getCodexEnv(),
          shell: process.platform === "win32",
        },
      );

      let settled = false;
      let stdoutBuffer = "";
      const stderrChunks: string[] = [];

      const finish = (handler: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        void terminateChildProcess(child);
        handler();
      };

      const parseAndHandleLine = (line: string) => {
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          return;
        }

        if (message.id === APP_SERVER_INIT_REQUEST_ID) {
          if (message.error) {
            const errorMessage =
              message.error.message ?? "Codex app-server initialize failed";
            finish(() => reject(new Error(errorMessage)));
            return;
          }

          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: APP_SERVER_MODEL_LIST_REQUEST_ID,
              method: "model/list",
              params: { limit: 100 },
            })}\n`,
          );
          return;
        }

        if (message.id !== APP_SERVER_MODEL_LIST_REQUEST_ID) {
          return;
        }

        if (message.error) {
          const errorMessage =
            message.error.message ?? "Codex app-server model/list failed";
          finish(() => reject(new Error(errorMessage)));
          return;
        }

        const result = message.result as { data?: unknown[] } | undefined;
        const data = Array.isArray(result?.data) ? result.data : [];
        const models: AppServerModel[] = [];

        for (const item of data) {
          if (!item || typeof item !== "object") continue;
          const model = item as AppServerModel;
          if (typeof model.id !== "string") continue;
          models.push(model);
        }

        finish(() => resolve(models));
      };

      const timeoutHandle = setTimeout(() => {
        const stderr = stderrChunks.join("").trim();
        finish(() =>
          reject(
            new Error(
              stderr
                ? `Timed out querying Codex app-server model list: ${stderr}`
                : "Timed out querying Codex app-server model list",
            ),
          ),
        );
      }, MODEL_LIST_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf-8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          parseAndHandleLine(line);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString("utf-8"));
      });

      child.on("error", (error) => {
        finish(() => reject(error));
      });

      child.on("exit", (code, signal) => {
        if (settled) return;
        const stderr = stderrChunks.join("").trim();
        const details = stderr ? ` stderr: ${stderr}` : "";
        finish(() =>
          reject(
            new Error(
              `Codex app-server exited before model/list response (code=${code ?? "null"}, signal=${signal ?? "null"}).${details}`,
            ),
          ),
        );
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: APP_SERVER_INIT_REQUEST_ID,
          method: "initialize",
          params: {
            clientInfo: {
              name: this.getCodexClientName(),
              version: "dev",
            },
            capabilities: null,
          },
        })}\n`,
      );
    });
  }

  private normalizeModelList(models: AppServerModel[]): ModelInfo[] {
    const orderLookup = new Map<string, number>(
      PREFERRED_MODEL_ORDER.map((id, idx) => [id, idx]),
    );
    const deduped = new Map<
      string,
      { model: ModelInfo; serverIndex: number }
    >();

    for (const [serverIndex, model] of models.entries()) {
      if (model.hidden === true) continue;

      const modelId = (model.model || model.id || "").trim();
      if (!modelId) continue;

      deduped.set(modelId, {
        model: {
          id: modelId,
          name: this.formatModelName(model.displayName || modelId),
          description: model.description,
          ...(model.isDefault === true ? { isDefault: true } : {}),
          ...this.normalizeModelReasoningMetadata(model),
          ...(Array.isArray(model.inputModalities)
            ? { inputModalities: model.inputModalities }
            : {}),
          ...(typeof model.supportsPersonality === "boolean"
            ? { supportsPersonality: model.supportsPersonality }
            : {}),
          ...this.normalizeModelServiceTierMetadata(model),
        },
        serverIndex,
      });

      const upgradeId =
        model.upgrade?.trim() ||
        (typeof model.upgradeInfo?.model === "string"
          ? model.upgradeInfo.model.trim()
          : "");
      if (upgradeId && !deduped.has(upgradeId)) {
        deduped.set(upgradeId, {
          model: {
            id: upgradeId,
            name: this.formatModelName(upgradeId),
          },
          serverIndex,
        });
      }
    }

    return [...deduped.values()]
      .map((entry, index) => ({
        model: entry.model,
        index,
        rank: this.getModelSortRank(
          entry.model,
          entry.serverIndex,
          orderLookup,
        ),
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.model);
  }

  private normalizeModelReasoningMetadata(
    model: AppServerModel,
  ): Pick<ModelInfo, "defaultReasoningEffort" | "supportedReasoningEfforts"> {
    const metadata: Pick<
      ModelInfo,
      "defaultReasoningEffort" | "supportedReasoningEfforts"
    > = {};
    if (typeof model.defaultReasoningEffort === "string") {
      metadata.defaultReasoningEffort = model.defaultReasoningEffort;
    }
    if (Array.isArray(model.supportedReasoningEfforts)) {
      const efforts = model.supportedReasoningEfforts
        .map((effort) => {
          if (typeof effort.reasoningEffort !== "string") return null;
          return {
            reasoningEffort: effort.reasoningEffort,
            ...(typeof effort.description === "string"
              ? { description: effort.description }
              : {}),
          };
        })
        .filter(
          (
            effort,
          ): effort is {
            reasoningEffort: string;
            description?: string;
          } => effort !== null,
        );
      if (efforts.length > 0) {
        metadata.supportedReasoningEfforts = efforts;
      }
    }
    return metadata;
  }

  private normalizeModelServiceTierMetadata(
    model: AppServerModel,
  ): Pick<ModelInfo, "serviceTiers"> {
    if (!Array.isArray(model.serviceTiers)) {
      return {};
    }
    const serviceTiers = model.serviceTiers
      .map((tier) => {
        const id = typeof tier.id === "string" ? tier.id.trim() : "";
        const name = typeof tier.name === "string" ? tier.name.trim() : "";
        if (!id || !name) return null;
        return {
          id,
          name,
          ...(typeof tier.description === "string"
            ? { description: tier.description }
            : {}),
        };
      })
      .filter((tier): tier is NonNullable<typeof tier> => tier !== null);

    return serviceTiers.length > 0 ? { serviceTiers } : {};
  }

  private getModelSortRank(
    model: ModelInfo,
    serverIndex: number,
    orderLookup: Map<string, number>,
  ): number {
    if (model.id === "gpt-5.5") {
      return 0;
    }
    if (model.isDefault) {
      return 1;
    }
    const preferredRank = orderLookup.get(model.id);
    if (preferredRank !== undefined) {
      return 2 + preferredRank;
    }
    return 2 + PREFERRED_MODEL_ORDER.length + serverIndex;
  }

  private async getFallbackCodexModels(): Promise<ModelInfo[]> {
    const version = await this.getInstalledCodexCliVersion();
    if (version && compareSemver(version, CODEX_CLI_GPT55_MIN_VERSION) < 0) {
      return LEGACY_FALLBACK_CODEX_MODELS;
    }
    return FALLBACK_CODEX_MODELS;
  }

  private async getInstalledCodexCliVersion(): Promise<string | null> {
    try {
      const codexCommand = await this.resolveCodexCommand();
      const { stdout } = await execFileAsync(codexCommand, ["--version"], {
        encoding: "utf-8",
        timeout: 3000,
      });
      return normalizeSemver(stdout);
    } catch {
      return null;
    }
  }

  private formatModelName(value: string): string {
    return value
      .trim()
      .split("-")
      .map((part) => {
        const lower = part.toLowerCase();
        if (lower === "gpt") return "GPT";
        if (lower === "codex") return "Codex";
        if (lower === "mini") return "Mini";
        if (lower === "max") return "Max";
        if (lower.length === 0) return "";
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("-");
  }

  private mapEffortToReasoningEffort(
    effort?: import("@yep-anywhere/shared").EffortLevel,
    thinking?: import("@yep-anywhere/shared").ThinkingConfig,
    model?: StartSessionOptions["model"],
  ): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
    if (thinking?.type === "disabled") {
      const normalizedModel = model?.trim().toLowerCase();
      const hasSparkModelPrefix =
        CODEX_THINKING_OFF_MIN_REASONING_EFFORT_PREFIXES.some((prefix) =>
          normalizedModel?.startsWith(prefix),
        );
      if (hasSparkModelPrefix) {
        return "low";
      }
      return "none";
    }
    if (!effort) {
      return undefined;
    }
    switch (effort) {
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      case "xhigh":
      case "max":
        return "xhigh";
    }
  }

  private mapPermissionModeToThreadPolicy(
    permissionMode?: StartSessionOptions["permissionMode"],
  ): CodexThreadPolicy {
    const applyOverrides = (policy: CodexThreadPolicy): CodexThreadPolicy => ({
      approvalPolicy:
        CODEX_POLICY_OVERRIDES.approvalPolicy ?? policy.approvalPolicy,
      sandbox: CODEX_POLICY_OVERRIDES.sandbox ?? policy.sandbox,
    });

    if (permissionMode === "bypassPermissions") {
      return applyOverrides({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    }

    if (permissionMode === "plan") {
      return applyOverrides({
        approvalPolicy: "on-request",
        sandbox: "read-only",
      });
    }

    return applyOverrides({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  }

  /**
   * Start a new Codex session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const runtimeState: CodexTurnRuntimeState = {
      threadId: options.resumeSessionId ?? "",
      activeTurnId: null,
      activeToolCallIds: new Set(),
      backgroundToolCallIds: new Set(),
    };

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    let activeClient: CodexAppServerClient | null = null;
    const iterator = this.runSession(
      options,
      queue,
      abortController.signal,
      runtimeState,
      (client) => {
        activeClient = client;
      },
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        activeClient?.close();
      },
      isProcessAlive: () => activeClient?.isAlive() ?? false,
      getProviderActivity: () =>
        activeClient?.getProviderActivity() ?? {
          lastRawProviderEventAt: null,
          lastRawProviderEventSource: null,
        },
      get pid() {
        return activeClient?.pid;
      },
      probeLiveness: async () =>
        this.probeCodexLiveness(activeClient, runtimeState),
      supportedCommands: async () => [...CODEX_BUILTIN_COMMANDS],
      steer: async (message) => {
        if (!activeClient) return false;
        if (!runtimeState.threadId || !runtimeState.activeTurnId) return false;

        const userPrompt = this.extractTextFromMessage(message);
        if (!userPrompt) return true;

        try {
          const steerResult = await activeClient.request<TurnSteerResponse>(
            "turn/steer",
            {
              threadId: runtimeState.threadId,
              input: [{ type: "text", text: userPrompt, text_elements: [] }],
              expectedTurnId: runtimeState.activeTurnId,
            } satisfies TurnSteerParams,
          );
          if (steerResult.turnId) {
            runtimeState.activeTurnId = steerResult.turnId;
          }
          return true;
        } catch (error) {
          log.warn(
            {
              threadId: runtimeState.threadId,
              turnId: runtimeState.activeTurnId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Codex turn/steer failed; caller should queue message instead",
          );
          return false;
        }
      },
      interrupt: async () => {
        if (!activeClient) return false;
        if (!runtimeState.threadId || !runtimeState.activeTurnId) return false;
        await activeClient.request<TurnInterruptResponse>("turn/interrupt", {
          threadId: runtimeState.threadId,
          turnId: runtimeState.activeTurnId,
        } satisfies TurnInterruptParams);
        return true;
      },
    };
  }

  private async probeCodexLiveness(
    activeClient: CodexAppServerClient | null,
    runtimeState: CodexTurnRuntimeState,
  ): Promise<ProviderLivenessProbeResult> {
    const checkedAt = new Date();
    const source = "codex:thread/read";

    if (!activeClient?.isAlive()) {
      return {
        status: "unavailable",
        source,
        checkedAt,
        detail: "Codex app-server is not alive",
      };
    }
    if (!runtimeState.threadId) {
      return {
        status: "unavailable",
        source,
        checkedAt,
        detail: "No Codex thread id is available",
      };
    }

    try {
      const response = await activeClient.request<CodexThreadReadResponse>(
        "thread/read",
        {
          threadId: runtimeState.threadId,
          includeTurns: false,
        } satisfies ThreadReadParams,
      );
      const status = response.thread?.status;
      const statusType = status?.type;
      const activeFlags = Array.isArray(status?.activeFlags)
        ? status.activeFlags.filter(
            (flag): flag is string => typeof flag === "string",
          )
        : [];
      const mappedStatus = this.mapCodexThreadStatusToLiveness(
        statusType,
        activeFlags,
      );

      if (mappedStatus === "idle" && runtimeState.activeTurnId) {
        activeClient.injectNotification({
          method: "turn/completed",
          params: {
            threadId: runtimeState.threadId,
            turn: {
              id: runtimeState.activeTurnId,
              items: [],
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          },
        });
      }

      return {
        status: mappedStatus,
        source,
        checkedAt,
        detail: this.formatCodexThreadStatusProbeDetail(
          statusType,
          activeFlags,
        ),
      };
    } catch (error) {
      return {
        status: "error",
        source,
        checkedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private mapCodexThreadStatusToLiveness(
    statusType: string | undefined,
    activeFlags: string[],
  ): ProviderLivenessProbeResult["status"] {
    switch (statusType) {
      case "active":
        return activeFlags.includes("waitingOnApproval") ||
          activeFlags.includes("waitingOnUserInput")
          ? "waiting-input"
          : "active";
      case "idle":
        return "idle";
      case "notLoaded":
        return "not-loaded";
      case "systemError":
        return "system-error";
      default:
        return "error";
    }
  }

  private formatCodexThreadStatusProbeDetail(
    statusType: string | undefined,
    activeFlags: string[],
  ): string {
    if (!statusType) {
      return "thread.status:missing";
    }
    return activeFlags.length > 0
      ? `thread.status:${statusType} flags:${activeFlags.join(",")}`
      : `thread.status:${statusType}`;
  }

  /**
   * Main session loop using codex app-server.
   */
  private async *runSession(
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
    runtimeState: CodexTurnRuntimeState,
    setActiveClient: (client: CodexAppServerClient) => void,
  ): AsyncIterableIterator<SDKMessage> {
    const codexCommand = await this.resolveCodexCommand();
    const agentctlSessionEnvBridge = createAgentctlSessionEnvBridge(
      options.resumeSessionId,
    );
    const appServer = new CodexAppServerClient(
      codexCommand,
      options.cwd,
      agentctlSessionEnvBridge.extendEnv(this.getCodexEnv()),
      (notification) =>
        this.shouldSuppressLiveDeltaNotification(notification, options),
    );
    setActiveClient(appServer);

    let sessionId = options.resumeSessionId ?? "";
    const usageByTurnId = new Map<string, TokenUsageSnapshot>();
    const failureTrace: CodexFailureTrace = {
      sessionId: sessionId || undefined,
      activeTurnId: null,
      recentNotifications: [],
    };
    const logRawNotification = (notification: JsonRpcNotification): void => {
      this.logRawCodexNotification(sessionId || "unknown", notification);
    };

    appServer.setServerRequestHandler(async (request) => {
      return await this.handleServerRequestApproval(request, options, signal);
    });

    try {
      await appServer.connect();

      const experimentalApiEnabled = await this.initializeAppServer(
        appServer,
        options.clientName,
      );
      appServer.notify("initialized");

      const policy = this.mapPermissionModeToThreadPolicy(
        options.permissionMode,
      );

      const threadResumeParams = this.createThreadResumeParams(
        options,
        sessionId,
        policy,
        experimentalApiEnabled,
      );
      const threadStartParams = this.createThreadStartParams(options, policy);
      const threadResult = await this.startOrResumeThread(
        appServer,
        options,
        threadStartParams,
        threadResumeParams,
      );

      sessionId = threadResult.thread.id;
      agentctlSessionEnvBridge.publishSessionId(sessionId);
      runtimeState.threadId = sessionId;
      failureTrace.sessionId = sessionId;
      log.info(
        {
          sessionId,
          permissionMode: options.permissionMode ?? "default",
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          policyOverrides: {
            approvalPolicy: CODEX_POLICY_OVERRIDES.approvalPolicy,
            sandbox: CODEX_POLICY_OVERRIDES.sandbox,
          },
          model: options.model ?? null,
        },
        "Started Codex app-server session thread",
      );

      // Emit init immediately with the real session ID.
      yield withCodexTimestamp({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
      } as SDKMessage);

      const requestedReasoningEffort = this.mapEffortToReasoningEffort(
        options.effort,
        options.thinking,
      );
      const sessionConfigAck = this.createSessionConfigAckMessage(
        sessionId,
        threadResult.model,
        options.model,
        threadResult.reasoningEffort,
        requestedReasoningEffort,
      );
      if (sessionConfigAck) {
        yield withCodexTimestamp(sessionConfigAck);
      }

      const messageGen = queue;
      const liveEventState = this.createLiveEventState();
      let isFirstMessage = !options.resumeSessionId;

      for await (const message of messageGen) {
        if (signal.aborted) {
          break;
        }

        let userPrompt = this.extractTextFromMessage(message);
        if (!userPrompt) {
          continue;
        }

        // Prepend global instructions to the first message of new sessions
        if (isFirstMessage && options.globalInstructions) {
          userPrompt = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userPrompt}`;
          isFirstMessage = false;
        } else {
          isFirstMessage = false;
        }

        // Emit user message with UUID from queue to enable deduplication.
        const userMessage = withCodexTimestamp({
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userPrompt,
          },
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, userMessage, {
          eventKind: "user_message",
          phase: "submitted",
          sourceEvent: "queued_input",
        });
        failureTrace.lastUserMessage = {
          uuid: message.uuid,
          chars: userPrompt.length,
        };
        yield userMessage;

        const messagePermissionMode =
          this.getPermissionModeFromMessage(message);
        const turnPolicy = messagePermissionMode
          ? this.mapPermissionModeToThreadPolicy(messagePermissionMode)
          : null;
        const turnStartParams = this.createTurnStartParams(
          sessionId,
          userPrompt,
          options,
          turnPolicy,
        );
        const turnResult = await appServer.request<TurnStartResponse>(
          "turn/start",
          turnStartParams,
        );

        const activeTurnId = turnResult.turn.id;
        runtimeState.activeTurnId = activeTurnId;
        runtimeState.activeToolCallIds.clear();
        runtimeState.backgroundToolCallIds.clear();
        failureTrace.activeTurnId = activeTurnId;
        log.info(
          {
            sessionId,
            turnId: activeTurnId,
            turnStatus: turnResult.turn.status,
          },
          "Started Codex app-server turn",
        );
        let turnComplete = turnResult.turn.status !== "inProgress";
        let emittedTurnError = false;

        while (!turnComplete && !signal.aborted) {
          const notification = await appServer.nextNotification(signal);
          if (this.shouldSuppressLiveDeltaNotification(notification, options)) {
            continue;
          }
          logRawNotification(notification);
          const currentActiveTurnId = runtimeState.activeTurnId ?? activeTurnId;
          failureTrace.activeTurnId = currentActiveTurnId;

          if (notification.method === "thread/tokenUsage/updated") {
            const usage = this.extractTurnUsage(notification.params);
            if (usage) {
              usageByTurnId.set(usage.turnId, usage.snapshot);
            }
          }
          this.updateBackgroundProcessTracking(notification, runtimeState);

          this.recordCodexFailureTraceEvent(
            failureTrace,
            this.describeNotificationForFailureTrace(notification),
          );

          const messages = this.convertNotificationToSDKMessages(
            notification,
            sessionId,
            usageByTurnId,
            liveEventState,
          );
          for (const rawMsg of messages) {
            const msg =
              rawMsg.type === "error"
                ? ({
                    ...rawMsg,
                    codexFailureTrace:
                      this.snapshotCodexFailureTrace(failureTrace),
                    codexFailureSummary:
                      this.formatCodexFailureTrace(failureTrace),
                  } as SDKMessage)
                : rawMsg;
            failureTrace.lastEmittedMessage =
              this.describeSDKMessageForFailureTrace(msg);
            yield msg;
          }

          if (
            this.isTurnTerminalNotification(notification, currentActiveTurnId)
          ) {
            if (notification.method === "error") {
              emittedTurnError = true;
            }
            turnComplete = true;
          }
        }
        runtimeState.activeTurnId = null;
        failureTrace.activeTurnId = null;

        // If turn failed without an emitted error notification, surface start response error.
        if (
          !emittedTurnError &&
          turnResult.turn.status === "failed" &&
          turnResult.turn.error?.message
        ) {
          yield {
            type: "error",
            session_id: sessionId,
            error: turnResult.turn.error.message,
            codexErrorInfo: turnResult.turn.error.codexErrorInfo ?? null,
            codexAdditionalDetails:
              turnResult.turn.error.additionalDetails ?? null,
            codexFailureTrace: this.snapshotCodexFailureTrace(failureTrace),
            codexFailureSummary: this.formatCodexFailureTrace(failureTrace),
            codexRequestId: this.extractOpenAIRequestId(
              turnResult.turn.error,
              turnResult.turn.error.additionalDetails,
              turnResult.turn.error.message,
            ),
          } as SDKMessage;
        }

        yield {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
      }
    } catch (error) {
      const codexFailureTrace = this.snapshotCodexFailureTrace(failureTrace);
      log.error(
        { error, codexFailureTrace },
        "Error in codex app-server session",
      );
      if (!signal.aborted) {
        yield {
          type: "error",
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
          codexFailureTrace,
          codexFailureSummary: this.formatCodexFailureTrace(codexFailureTrace),
        } as SDKMessage;
      }
    } finally {
      runtimeState.activeTurnId = null;
      appServer.close();
      agentctlSessionEnvBridge.cleanup();
    }

    yield {
      type: "result",
      session_id: sessionId,
    } as SDKMessage;
  }

  private logRawCodexNotification(
    sessionId: string,
    notification: JsonRpcNotification,
  ): void {
    logSDKMessage(
      sessionId || "unknown",
      {
        _rawSource: "codex_app_server_notification",
        ...notification,
      },
      { provider: "codex" },
    );
  }

  private shouldSuppressLiveDeltaNotification(
    notification: JsonRpcNotification,
    options: StartSessionOptions,
  ): boolean {
    if (!isCodexLiveDeltaNotificationMethod(notification.method)) {
      return false;
    }
    if (isCodexLiveDeltaSuppressionEnabled()) {
      return true;
    }
    return options.shouldEmitLiveDeltas?.() === false;
  }

  private isTurnTerminalNotification(
    notification: JsonRpcNotification,
    turnId: string,
  ): boolean {
    if (notification.method === "turn/completed") {
      const params = this.asTurnCompletedNotification(notification.params);
      return params?.turn.id === turnId;
    }

    if (notification.method === "error") {
      const params = this.asErrorNotification(notification.params);
      return params?.turnId === turnId && !params.willRetry;
    }

    return false;
  }

  private updateBackgroundProcessTracking(
    notification: JsonRpcNotification,
    runtimeState: CodexTurnRuntimeState,
  ): void {
    if (notification.method === "rawResponseItem/completed") {
      const params = this.asRawResponseItemCompletedNotification(
        notification.params,
      );
      const item =
        params?.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : null;
      const itemType = this.getOptionalString(item?.type);
      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const callId = this.getOptionalString(item?.call_id);
        if (callId) {
          runtimeState.activeToolCallIds.add(callId);
        }
        return;
      }
      if (
        itemType === "function_call_output" ||
        itemType === "custom_tool_call_output"
      ) {
        const callId = this.getOptionalString(item?.call_id);
        if (!callId) return;
        if (isCodexBackgroundProcessOutput(item?.output)) {
          runtimeState.backgroundToolCallIds.add(callId);
        } else {
          runtimeState.activeToolCallIds.delete(callId);
          runtimeState.backgroundToolCallIds.delete(callId);
        }
      }
      return;
    }

    if (notification.method === "item/completed") {
      const params = this.asItemCompletedNotification(notification.params);
      if (!params) return;
      const normalized = this.normalizeThreadItem(params.item);
      if (normalized?.type === "command_execution") {
        runtimeState.activeToolCallIds.delete(normalized.id);
        runtimeState.backgroundToolCallIds.delete(normalized.id);
      }
      return;
    }

    if (notification.method === "item/started") {
      const params = this.asItemStartedNotification(notification.params);
      if (!params) return;
      const normalized = this.normalizeThreadItem(params.item);
      if (normalized && this.isResultBackedThreadItem(normalized)) {
        runtimeState.activeToolCallIds.add(normalized.id);
      }
    }
  }

  private createInitializeParams(
    experimentalApiEnabled: boolean,
    clientName?: string,
  ): {
    clientInfo: { name: string; title: null; version: string };
    capabilities: { experimentalApi: boolean } | null;
  } {
    return {
      clientInfo: {
        name: this.getCodexClientName(clientName),
        title: null,
        version: "dev",
      },
      capabilities: experimentalApiEnabled ? { experimentalApi: true } : null,
    };
  }

  private async initializeAppServer(
    appServer: CodexAppServerClient,
    clientName?: string,
  ): Promise<boolean> {
    try {
      await appServer.request<{ userAgent: string }>(
        "initialize",
        this.createInitializeParams(true, clientName),
      );
      return true;
    } catch (error) {
      log.warn(
        { error },
        "Codex initialize with experimentalApi failed; retrying without capabilities",
      );
      await appServer.request<{ userAgent: string }>(
        "initialize",
        this.createInitializeParams(false, clientName),
      );
      return false;
    }
  }

  private async startOrResumeThread(
    appServer: CodexAppServerClient,
    options: StartSessionOptions,
    threadStartParams: ThreadStartParams,
    threadResumeParams: CodexThreadResumeParamsForRequest,
  ): Promise<ThreadStartResponse | ThreadResumeResponse> {
    return options.resumeSessionId
      ? await appServer.request<ThreadResumeResponse>(
          "thread/resume",
          threadResumeParams,
        )
      : await appServer.request<ThreadStartResponse>(
          "thread/start",
          threadStartParams,
        );
  }

  private createThreadStartParams(
    options: StartSessionOptions,
    policy: CodexThreadPolicy,
  ): ThreadStartParams {
    return {
      model: options.model ?? null,
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      cwd: options.cwd,
      ...this.buildThreadPermissionParams(policy),
      config: this.buildThreadConfigOverrides(options),
      experimentalRawEvents: false,
    };
  }

  private createThreadResumeParams(
    options: StartSessionOptions,
    sessionId: string,
    policy: CodexThreadPolicy,
    experimentalApiEnabled = false,
  ): CodexThreadResumeParamsForRequest {
    const params: CodexThreadResumeParamsForRequest = {
      threadId: options.resumeSessionId ?? sessionId,
      model: options.model ?? null,
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      cwd: options.cwd,
      ...this.buildThreadPermissionParams(policy),
      config: this.buildThreadConfigOverrides(options),
    };
    if (experimentalApiEnabled) {
      params.excludeTurns = true;
    }
    return params;
  }

  private buildThreadPermissionParams(
    policy: CodexThreadPolicy,
  ): Pick<ThreadStartParams, "approvalPolicy" | "sandbox"> {
    return {
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    };
  }

  private buildThreadConfigOverrides(
    options: StartSessionOptions,
  ): Record<string, string> | null {
    const reasoningEffort = this.mapEffortToReasoningEffort(
      options.effort,
      options.thinking,
      options.model,
    );
    if (!reasoningEffort) {
      return null;
    }
    return { model_reasoning_effort: reasoningEffort };
  }

  private createTurnStartParams(
    threadId: string,
    userPrompt: string,
    options: StartSessionOptions,
    turnPolicy: CodexThreadPolicy | null = null,
  ): TurnStartParams {
    return {
      threadId,
      model: options.model ?? null,
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      input: [{ type: "text", text: userPrompt, text_elements: [] }],
      effort: this.mapEffortToReasoningEffort(
        options.effort,
        options.thinking,
        options.model,
      ),
      summary: "auto",
      ...this.buildTurnPermissionParams(turnPolicy),
    };
  }

  private buildTurnPermissionParams(
    policy: CodexThreadPolicy | null,
  ): Partial<Pick<TurnStartParams, "approvalPolicy">> {
    if (!policy) return {};
    return { approvalPolicy: policy.approvalPolicy };
  }

  /**
   * Synthesize a short on-return recap through a separate ephemeral Codex
   * thread. This is intentionally separate from prompt suggestions: Codex does
   * not natively emit prompt_suggestion messages, but it can still run the YA
   * simulated recap helper without mutating the parent session transcript.
   */
  async generateRecap(
    recentAssistantText: string[],
    options?: { model?: string },
  ): Promise<string> {
    const userPrompt = this.createRecapPrompt(recentAssistantText);
    const model = await this.resolveRecapHelperModel(options?.model);
    const codexCommand = await this.resolveCodexCommand();
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, CODEX_RECAP_TIMEOUT_MS);
    timeout.unref?.();

    const appServer = new CodexAppServerClient(
      codexCommand,
      homedir(),
      this.getCodexEnv(),
    );
    appServer.setServerRequestHandler(async (request) =>
      this.handleRecapServerRequest(request),
    );

    try {
      await appServer.connect();
      await this.initializeAppServer(appServer);
      appServer.notify("initialized");

      const threadResult = await appServer.request<ThreadStartResponse>(
        "thread/start",
        {
          model,
          cwd: homedir(),
          approvalPolicy: "untrusted",
          sandbox: "read-only",
          ephemeral: true,
          experimentalRawEvents: false,
          developerInstructions:
            "You are a recap helper. Reply with the recap text only, no preamble. Do not call tools.",
        } satisfies ThreadStartParams,
      );

      const turnResult = await appServer.request<TurnStartResponse>(
        "turn/start",
        {
          threadId: threadResult.thread.id,
          model,
          input: [{ type: "text", text: userPrompt, text_elements: [] }],
          effort: "low",
          summary: "auto",
        } satisfies TurnStartParams,
      );

      const textByItemId = new Map<string, string>();
      this.captureRecapTextFromTurnItems(turnResult.turn.items, textByItemId);

      if (turnResult.turn.status === "failed") {
        throw new Error(
          turnResult.turn.error?.message ?? "Codex recap generation failed",
        );
      }

      let turnComplete = turnResult.turn.status !== "inProgress";
      while (!turnComplete && !abortController.signal.aborted) {
        const notification = await appServer.nextNotification(
          abortController.signal,
        );
        this.captureRecapTextFromNotification(notification, textByItemId);

        if (notification.method !== "turn/completed") {
          continue;
        }
        const completed = this.asTurnCompletedNotification(notification.params);
        if (completed?.turn.status === "failed") {
          throw new Error(
            completed.turn.error?.message ?? "Codex recap generation failed",
          );
        }
        turnComplete = true;
      }
      if (abortController.signal.aborted) {
        throw new Error("Timed out generating Codex recap");
      }

      const cleaned = [...textByItemId.values()]
        .join("\n")
        .replace(/\s*\(disable recaps in \/config\)\s*$/u, "")
        .trim();
      if (!cleaned) {
        throw new Error("Recap generation returned empty text");
      }
      return cleaned;
    } catch (error) {
      if (timedOut) {
        throw new Error("Timed out generating Codex recap");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      appServer.close();
    }
  }

  private createRecapPrompt(recentAssistantText: string[]): string {
    const trimmed = recentAssistantText
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
    if (trimmed.length === 0) {
      throw new Error("No recent assistant text to summarize");
    }

    let total = 0;
    const tail: string[] = [];
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const entry = trimmed[i] ?? "";
      if (total + entry.length > CODEX_RECAP_MAX_TOTAL_CHARS) {
        break;
      }
      tail.unshift(entry);
      total += entry.length;
    }
    if (tail.length === 0) {
      const last = trimmed[trimmed.length - 1] ?? "";
      tail.push(last.slice(-CODEX_RECAP_MAX_TOTAL_CHARS));
    }

    const transcript = tail
      .map((text, index) => `--- Assistant turn ${index + 1} ---\n${text}`)
      .join("\n\n");
    return [
      "The user stepped away and is coming back. Recap in under 40 words,",
      "1-2 plain sentences, no markdown. Lead with the overall thrust of what",
      "the assistant did or is doing; mention any pending next action.",
      "Do not greet, do not ask a question, do not add a sign-off.",
      "",
      "Recent assistant output:",
      transcript,
    ].join("\n");
  }

  private async resolveRecapHelperModel(
    requestedModel: string | undefined,
  ): Promise<string | null> {
    if (!requestedModel || requestedModel !== HELPER_SIDE_MODEL_CHEAPEST) {
      return requestedModel ?? null;
    }

    const models = await this.getAvailableModels();
    for (const preferred of CODEX_RECAP_CHEAPEST_MODEL_PREFERENCES) {
      if (models.some((model) => model.id === preferred)) {
        return preferred;
      }
    }
    return (
      models.find((model) => model.id.toLowerCase().includes("mini"))?.id ??
      null
    );
  }

  private handleRecapServerRequest(
    request: JsonRpcServerRequest,
  ): Promise<unknown> {
    log.warn(
      { method: request.method, requestId: request.id },
      "Declining Codex recap helper server request",
    );

    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return Promise.resolve({ decision: "decline" });
      case "item/permissions/requestApproval":
        return Promise.resolve(this.createDeclinedPermissionResponse());
      case "item/tool/requestUserInput": {
        const requestInput = this.asToolRequestUserInputParams(request.params);
        const answers: ToolRequestUserInputResponse["answers"] = {};
        for (const question of requestInput?.questions ?? []) {
          answers[question.id] = { answers: [] };
        }
        return Promise.resolve({
          answers,
        } satisfies ToolRequestUserInputResponse);
      }
      default:
        return Promise.resolve({});
    }
  }

  private captureRecapTextFromTurnItems(
    items: CodexThreadItem[],
    textByItemId: Map<string, string>,
  ): void {
    for (const item of items) {
      const normalized = this.normalizeThreadItem(item);
      if (normalized?.type === "agent_message" && normalized.text.trim()) {
        textByItemId.set(normalized.id, normalized.text);
      }
    }
  }

  private captureRecapTextFromNotification(
    notification: JsonRpcNotification,
    textByItemId: Map<string, string>,
  ): void {
    if (notification.method === "item/agentMessage/delta") {
      const params = this.asAgentMessageDeltaNotification(notification.params);
      if (!params?.delta) return;
      textByItemId.set(
        params.itemId,
        `${textByItemId.get(params.itemId) ?? ""}${params.delta}`,
      );
      return;
    }

    if (notification.method === "item/completed") {
      const params = this.asItemCompletedNotification(notification.params);
      if (!params || textByItemId.has(params.item.id)) return;
      const normalized = this.normalizeThreadItem(params.item);
      if (normalized?.type === "agent_message" && normalized.text.trim()) {
        textByItemId.set(normalized.id, normalized.text);
      }
      return;
    }

    if (notification.method !== "rawResponseItem/completed") {
      return;
    }
    const params = this.asRawResponseItemCompletedNotification(
      notification.params,
    );
    const text = this.extractRawResponseMessageText(params?.item);
    if (params && text) {
      textByItemId.set(`raw-${params.turnId}-${textByItemId.size}`, text);
    }
  }

  private extractRawResponseMessageText(item: unknown): string | null {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (record.type !== "message" || record.role !== "assistant") {
      return null;
    }
    if (!Array.isArray(record.content)) {
      return null;
    }
    const parts = record.content
      .map((contentItem) => {
        if (!contentItem || typeof contentItem !== "object") return "";
        const contentRecord = contentItem as Record<string, unknown>;
        return contentRecord.type === "output_text"
          ? (this.getOptionalString(contentRecord.text) ?? "")
          : "";
      })
      .filter((text) => text.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }

  private createSessionConfigAckMessage(
    sessionId: string,
    model?: string | null,
    requestedModel?: string | null,
    reasoningEffort?: string | null,
    requestedReasoningEffort?:
      | "none"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | undefined,
  ): SDKMessage | null {
    const parts: string[] = [];
    const normalizedModel = typeof model === "string" ? model.trim() : "";
    const normalizedRequestedModel =
      typeof requestedModel === "string" ? requestedModel.trim() : "";
    if (normalizedModel) {
      parts.push(normalizedModel);
    }
    const effortLabel =
      this.describeAcknowledgedSessionReasoningEffort(reasoningEffort);
    const configMismatch =
      (normalizedRequestedModel.length > 0 &&
        normalizedRequestedModel !== normalizedModel) ||
      (requestedReasoningEffort !== undefined &&
        requestedReasoningEffort !== reasoningEffort);
    if (effortLabel) {
      parts.push(effortLabel);
    }
    if (parts.length === 0) {
      return null;
    }
    return {
      type: "system",
      subtype: "config_ack",
      session_id: sessionId,
      content: `Codex acknowledged config: ${parts.join(" · ")}`,
      isSynthetic: true,
      configScope: "session",
      configMismatch,
      ...(normalizedModel ? { configModel: normalizedModel } : {}),
      ...(effortLabel ? { configThinking: effortLabel } : {}),
    } as SDKMessage;
  }

  private describeAcknowledgedSessionReasoningEffort(
    effort: string | null | undefined,
  ): string | null {
    return effort ? `effort ${effort}` : null;
  }

  private createLiveEventState(): CodexLiveEventState {
    return {
      streamingTextByItemKey: new Map(),
      streamingReasoningSummaryByItemKey: new Map(),
      streamingToolOutputByItemKey: new Map(),
      toolCallContexts: new Map(),
      resultBackedToolItemsByTurnId: new Map(),
    };
  }

  private recordCodexFailureTraceEvent(
    trace: CodexFailureTrace,
    event: CodexFailureTraceEvent,
  ): void {
    trace.lastNotification = event;
    trace.recentNotifications.push(event);
    if (trace.recentNotifications.length > CODEX_FAILURE_TRACE_LIMIT) {
      trace.recentNotifications.splice(
        0,
        trace.recentNotifications.length - CODEX_FAILURE_TRACE_LIMIT,
      );
    }
  }

  private snapshotCodexFailureTrace(
    trace: CodexFailureTrace,
  ): CodexFailureTrace {
    return {
      sessionId: trace.sessionId,
      activeTurnId: trace.activeTurnId,
      lastUserMessage: trace.lastUserMessage
        ? { ...trace.lastUserMessage }
        : undefined,
      lastNotification: trace.lastNotification
        ? { ...trace.lastNotification }
        : undefined,
      lastEmittedMessage: trace.lastEmittedMessage
        ? { ...trace.lastEmittedMessage }
        : undefined,
      recentNotifications: trace.recentNotifications.map((event) => ({
        ...event,
      })),
    };
  }

  private formatCodexFailureTrace(trace: CodexFailureTrace): string {
    const lastNotification = trace.lastNotification
      ? this.formatCodexTraceEvent(trace.lastNotification)
      : "none";
    const lastEmitted = trace.lastEmittedMessage
      ? this.formatCodexTraceEvent(trace.lastEmittedMessage)
      : "none";
    return `last notification: ${lastNotification}; last emitted SDK message: ${lastEmitted}`;
  }

  private formatCodexTraceEvent(event: CodexFailureTraceEvent): string {
    const details = [
      event.sourceEvent,
      event.itemType,
      event.toolName,
      event.status,
      event.phase,
      event.command ? `command=${event.command}` : undefined,
      event.errorMessage ? `error=${event.errorMessage}` : undefined,
      event.openaiRequestId ? `requestId=${event.openaiRequestId}` : undefined,
    ].filter(Boolean);
    return details.join(" ");
  }

  private describeNotificationForFailureTrace(
    notification: JsonRpcNotification,
  ): CodexFailureTraceEvent {
    const base = (event: Omit<CodexFailureTraceEvent, "at">) => ({
      at: new Date().toISOString(),
      ...event,
    });

    switch (notification.method) {
      case "item/started":
      case "item/completed": {
        const params =
          notification.method === "item/started"
            ? this.asItemStartedNotification(notification.params)
            : this.asItemCompletedNotification(notification.params);
        const item =
          params?.item && typeof params.item === "object"
            ? (params.item as Record<string, unknown>)
            : null;
        return base({
          sourceEvent: notification.method,
          turnId: params?.turnId,
          itemId:
            this.getOptionalString(item?.id) ??
            this.getOptionalString((item as { call_id?: unknown })?.call_id) ??
            undefined,
          itemType: this.normalizeCodexItemType(
            this.getOptionalString(item?.type),
          ),
          status: this.normalizeStatus(item?.status),
          phase:
            notification.method === "item/completed" ? "completed" : "started",
          toolName: this.getTraceToolName(item) ?? undefined,
          command: this.previewTraceString(
            this.getOptionalString(item?.command) ??
              this.getOptionalString(item?.aggregated_output) ??
              this.getOptionalString(item?.aggregatedOutput),
          ),
        });
      }

      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const params =
          notification.params && typeof notification.params === "object"
            ? (notification.params as Record<string, unknown>)
            : null;
        const delta = this.getOptionalString(params?.delta);
        return base({
          sourceEvent: notification.method,
          turnId: this.getOptionalString(params?.turnId) ?? undefined,
          itemId: this.getOptionalString(params?.itemId) ?? undefined,
          itemType: this.inferTraceItemTypeFromDeltaEvent(notification.method),
          phase: "delta",
          deltaChars: delta?.length,
          outputChars: delta?.length,
        });
      }

      case "rawResponseItem/completed": {
        const params = this.asRawResponseItemCompletedNotification(
          notification.params,
        );
        const item =
          params?.item && typeof params.item === "object"
            ? (params.item as Record<string, unknown>)
            : null;
        return base({
          sourceEvent: notification.method,
          turnId: params?.turnId,
          itemId:
            this.getOptionalString(item?.id) ??
            this.getOptionalString(item?.call_id) ??
            undefined,
          itemType: this.normalizeCodexItemType(
            this.getOptionalString(item?.type),
          ),
          phase: "completed",
          toolName: this.getTraceToolName(item) ?? undefined,
        });
      }

      case "thread/tokenUsage/updated": {
        const params =
          notification.params && typeof notification.params === "object"
            ? (notification.params as Record<string, unknown>)
            : null;
        return base({
          sourceEvent: notification.method,
          turnId: this.getOptionalString(params?.turnId) ?? undefined,
          phase: "usage",
        });
      }

      case "turn/completed": {
        const params = this.asTurnCompletedNotification(notification.params);
        return base({
          sourceEvent: notification.method,
          turnId: params?.turn.id,
          status: params?.turn.status,
          phase: "completed",
          errorMessage: params?.turn.error?.message,
          codexErrorInfo: params?.turn.error?.codexErrorInfo ?? undefined,
          additionalDetails: params?.turn.error?.additionalDetails ?? undefined,
          openaiRequestId: this.extractOpenAIRequestId(
            params?.turn.error,
            params?.turn.error?.additionalDetails,
            params?.turn.error?.message,
          ),
        });
      }

      case "error": {
        const params = this.asErrorNotification(notification.params);
        const fallbackError = this.extractErrorRecord(notification.params);
        const errorMessage =
          params?.error.message ??
          this.getOptionalString(fallbackError?.message) ??
          "Codex turn failed";
        return base({
          sourceEvent: notification.method,
          turnId: params?.turnId,
          phase: params?.willRetry ? "retrying" : "terminal",
          errorMessage,
          codexErrorInfo:
            params?.error.codexErrorInfo ??
            fallbackError?.codexErrorInfo ??
            undefined,
          additionalDetails:
            params?.error.additionalDetails ??
            this.getOptionalString(fallbackError?.additionalDetails) ??
            undefined,
          openaiRequestId: this.extractOpenAIRequestId(
            notification.params,
            fallbackError,
            errorMessage,
          ),
        });
      }

      default:
        return base({ sourceEvent: notification.method });
    }
  }

  private describeSDKMessageForFailureTrace(
    message: SDKMessage,
  ): CodexFailureTraceEvent {
    const event: CodexFailureTraceEvent = {
      at: new Date().toISOString(),
      sourceEvent: `sdk:${message.type}`,
      phase: typeof message.subtype === "string" ? message.subtype : undefined,
    };

    if (message.error !== undefined) {
      event.errorMessage = this.previewTraceString(
        typeof message.error === "string"
          ? message.error
          : stringifyTraceValue(message.error),
      );
      event.openaiRequestId = this.extractOpenAIRequestId(message.error);
    }

    const content = message.message?.content;
    if (typeof content === "string") {
      event.outputChars = content.length;
      return event;
    }
    if (!Array.isArray(content)) {
      return event;
    }

    const interestingBlock = content.find(
      (block) =>
        block.type === "tool_use" ||
        block.type === "tool_result" ||
        block.type === "thinking",
    );
    if (!interestingBlock) {
      return event;
    }

    event.itemType = interestingBlock.type;
    if (interestingBlock.type === "tool_use") {
      event.itemId = interestingBlock.id;
      event.toolName = interestingBlock.name;
      event.command = this.previewTraceString(
        this.getTraceCommandFromInput(interestingBlock.input),
      );
    } else if (interestingBlock.type === "tool_result") {
      event.itemId = interestingBlock.tool_use_id;
      event.outputChars = interestingBlock.content?.length;
    } else if (interestingBlock.type === "thinking") {
      event.outputChars = interestingBlock.thinking?.length;
    }

    return event;
  }

  private inferTraceItemTypeFromDeltaEvent(method: string): string | undefined {
    if (method.includes("commandExecution")) return "command_execution";
    if (method.includes("fileChange")) return "file_change";
    if (method.includes("reasoning")) return "reasoning";
    if (method.includes("plan")) return "plan";
    if (method.includes("agentMessage")) return "agent_message";
    return undefined;
  }

  private normalizeCodexItemType(type: string | null): string | undefined {
    return type?.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  }

  private getTraceToolName(
    item: Record<string, unknown> | null,
  ): string | null {
    if (!item) return null;
    const type = this.normalizeCodexItemType(this.getOptionalString(item.type));
    if (type === "command_execution") return "Bash";
    if (type === "file_change") return "Edit";
    if (type === "web_search") return "WebSearch";
    if (type === "mcp_tool_call") {
      const server = this.getOptionalString(item.server);
      const tool = this.getOptionalString(item.tool);
      return server && tool ? `${server}:${tool}` : (tool ?? null);
    }
    if (type === "dynamic_tool_call") {
      const namespace = this.getOptionalString(item.namespace);
      const tool = this.getOptionalString(item.tool);
      return namespace && tool ? `${namespace}:${tool}` : (tool ?? null);
    }
    return this.getOptionalString(item.name);
  }

  private getTraceCommandFromInput(input: unknown): string | null {
    if (!input || typeof input !== "object") return null;
    const record = input as Record<string, unknown>;
    return (
      this.getOptionalString(record.command) ??
      this.getOptionalString(record.cmd) ??
      null
    );
  }

  private extractErrorRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
      return record.error as Record<string, unknown>;
    }
    return record;
  }

  private extractOpenAIRequestId(...values: unknown[]): string | undefined {
    for (const value of values) {
      const direct = this.findRequestIdInValue(value, 0);
      if (direct) return direct;
      const text =
        typeof value === "string" ? value : stringifyTraceValue(value);
      const match =
        /request\s*id[:\s]+([0-9a-f]{8}-[0-9a-f-]{20,})/i.exec(text) ??
        /request[_-]?id["'\s:=]+([0-9a-f]{8}-[0-9a-f-]{20,})/i.exec(text);
      if (match?.[1]) {
        return match[1];
      }
    }
    return undefined;
  }

  private findRequestIdInValue(value: unknown, depth: number): string | null {
    if (!value || typeof value !== "object" || depth > 3) return null;
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (
        /^(request[_-]?id|x-request-id)$/i.test(key) &&
        typeof entry === "string" &&
        entry.trim()
      ) {
        return entry.trim();
      }
      const nested = this.findRequestIdInValue(entry, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  private previewTraceString(
    value: string | null | undefined,
  ): string | undefined {
    if (!value) return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length <= CODEX_FAILURE_PREVIEW_CHARS) {
      return trimmed;
    }
    return `${trimmed.slice(0, CODEX_FAILURE_PREVIEW_CHARS)}...`;
  }

  private extractTurnUsage(params: unknown): {
    turnId: string;
    snapshot: TokenUsageSnapshot;
  } | null {
    const notification = this.asThreadTokenUsageUpdatedNotification(params);
    if (!notification) return null;

    return {
      turnId: notification.turnId,
      snapshot: {
        inputTokens: notification.tokenUsage.last.inputTokens,
        outputTokens: notification.tokenUsage.last.outputTokens,
        cachedInputTokens: notification.tokenUsage.last.cachedInputTokens,
        contextWindow:
          typeof notification.tokenUsage.modelContextWindow === "number"
            ? notification.tokenUsage.modelContextWindow
            : undefined,
      },
    };
  }

  private async handleServerRequestApproval(
    request: JsonRpcServerRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<unknown> {
    log.info(
      {
        method: request.method,
        requestId: request.id,
        permissionMode: options.permissionMode ?? "default",
      },
      "Codex app-server sent server request",
    );

    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};

    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const commandParams = this.asCommandExecutionRequestApprovalParams(
          request.params,
        );
        if (!commandParams) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex command approval params invalid; declining",
          );
          return { decision: "decline" as CommandExecutionApprovalDecision };
        }
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: commandParams.threadId,
            turnId: commandParams.turnId,
            itemId: commandParams.itemId,
            command: commandParams.command,
            cwd: commandParams.cwd,
          },
          "Handling Codex command approval request",
        );
        const toolInput = {
          command: commandParams.command,
          cwd: commandParams.cwd,
          reason: commandParams.reason,
          commandActions: commandParams.commandActions ?? [],
          proposedExecpolicyAmendment:
            commandParams.proposedExecpolicyAmendment ?? null,
          threadId: commandParams.threadId,
          turnId: commandParams.turnId,
          itemId: commandParams.itemId,
        };
        const decision: CommandExecutionApprovalDecision =
          await this.resolveApprovalDecision(
            options,
            "Bash",
            toolInput,
            signal,
            "accept",
            "decline",
          );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: commandParams.threadId,
            turnId: commandParams.turnId,
            itemId: commandParams.itemId,
            decision,
          },
          "Resolved Codex command approval request",
        );
        return { decision };
      }

      case "item/fileChange/requestApproval": {
        const fileParams = this.asFileChangeRequestApprovalParams(
          request.params,
        );
        if (!fileParams) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex file-change approval params invalid; declining",
          );
          return { decision: "decline" as FileChangeApprovalDecision };
        }
        const grantRoot = fileParams.grantRoot ?? null;
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: fileParams.threadId,
            turnId: fileParams.turnId,
            itemId: fileParams.itemId,
            grantRoot,
          },
          "Handling Codex file-change approval request",
        );
        const toolInput = {
          file_path: grantRoot ?? undefined,
          reason: fileParams.reason ?? null,
          grantRoot,
          threadId: fileParams.threadId,
          turnId: fileParams.turnId,
          itemId: fileParams.itemId,
        };
        const decision: FileChangeApprovalDecision =
          await this.resolveApprovalDecision(
            options,
            "Edit",
            toolInput,
            signal,
            "accept",
            "decline",
          );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: fileParams.threadId,
            turnId: fileParams.turnId,
            itemId: fileParams.itemId,
            decision,
          },
          "Resolved Codex file-change approval request",
        );
        return { decision };
      }

      // Backward-compatible protocol variants.
      case "execCommandApproval": {
        const commandParts = Array.isArray(params.command)
          ? params.command.filter(
              (part): part is string => typeof part === "string",
            )
          : [];
        const toolInput = {
          command: commandParts.join(" "),
          cwd: this.getOptionalString(params.cwd),
          reason: this.getOptionalString(params.reason),
          parsedCmd: Array.isArray(params.parsedCmd) ? params.parsedCmd : [],
          callId: this.getOptionalString(params.callId),
        };
        const decision = await this.resolveApprovalDecision(
          options,
          "Bash",
          toolInput,
          signal,
          "approved",
          "denied",
        );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            decision,
            command: toolInput.command,
            cwd: toolInput.cwd,
          },
          "Resolved legacy Codex command approval request",
        );
        return { decision };
      }

      case "applyPatchApproval": {
        const fileChanges =
          params.fileChanges && typeof params.fileChanges === "object"
            ? (params.fileChanges as Record<string, unknown>)
            : {};
        const paths = Object.keys(fileChanges);
        const toolInput = {
          changes: paths.map((path) => ({ path, kind: "update" })),
          reason: this.getOptionalString(params.reason),
          grantRoot: this.getOptionalString(params.grantRoot),
          callId: this.getOptionalString(params.callId),
        };
        const decision = await this.resolveApprovalDecision(
          options,
          "Edit",
          toolInput,
          signal,
          "approved",
          "denied",
        );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            decision,
            changedPathCount: paths.length,
            grantRoot: toolInput.grantRoot,
          },
          "Resolved legacy Codex apply-patch approval request",
        );
        return { decision };
      }

      case "item/permissions/requestApproval": {
        const permissionParams = this.asPermissionsRequestApprovalParams(
          request.params,
        );
        if (!permissionParams) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex permission approval params invalid; declining",
          );
          return this.createDeclinedPermissionResponse();
        }

        return await this.resolvePermissionRequestApproval(
          options,
          permissionParams,
          signal,
        );
      }

      case "item/tool/requestUserInput": {
        const requestInput = this.asToolRequestUserInputParams(request.params);
        const questions = requestInput?.questions ?? [];

        // MVP: return empty answers so request can complete without blocking.
        const answers: ToolRequestUserInputResponse["answers"] = {};
        for (const question of questions) {
          answers[question.id] = { answers: [] };
        }
        log.warn(
          {
            method: request.method,
            requestId: request.id,
            questionCount: questions.length,
            threadId: requestInput?.threadId ?? null,
            turnId: requestInput?.turnId ?? null,
            itemId: requestInput?.itemId ?? null,
          },
          "Codex requested tool user input; returning empty answers in MVP",
        );
        const response: ToolRequestUserInputResponse = { answers };
        return response;
      }

      default: {
        log.warn(
          { method: request.method, requestId: request.id },
          "Unhandled codex server request",
        );
        return {};
      }
    }
  }

  private async resolveApprovalDecision<TDecision extends string>(
    options: StartSessionOptions,
    toolName: string,
    toolInput: unknown,
    signal: AbortSignal,
    allowDecision: TDecision,
    denyDecision: TDecision,
  ): Promise<TDecision> {
    if (!options.onToolApproval) {
      log.warn(
        { toolName },
        "No onToolApproval handler available; denying Codex approval request",
      );
      return denyDecision;
    }

    let result: ToolApprovalResult;
    try {
      result = await options.onToolApproval(toolName, toolInput, { signal });
    } catch (error) {
      log.warn(
        { toolName, error },
        "onToolApproval threw; denying Codex approval request",
      );
      return denyDecision;
    }

    log.info(
      { toolName, behavior: result.behavior },
      "Resolved tool approval callback result",
    );

    return result.behavior === "allow" ? allowDecision : denyDecision;
  }

  private async resolvePermissionRequestApproval(
    options: StartSessionOptions,
    params: PermissionsRequestApprovalParams,
    signal: AbortSignal,
  ): Promise<PermissionsRequestApprovalResponse> {
    if (options.permissionMode === "bypassPermissions") {
      return this.createGrantedPermissionResponse(params, "session");
    }

    const toolInput = {
      cwd: params.cwd,
      reason: params.reason,
      permissions: params.permissions,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
    };
    const decision = await this.resolveApprovalDecision(
      options,
      "Permissions",
      toolInput,
      signal,
      "accept",
      "decline",
    );
    return decision === "accept"
      ? this.createGrantedPermissionResponse(params, "session")
      : this.createDeclinedPermissionResponse();
  }

  private createGrantedPermissionResponse(
    params: PermissionsRequestApprovalParams,
    scope: PermissionsRequestApprovalResponse["scope"],
  ): PermissionsRequestApprovalResponse {
    const permissions: PermissionsRequestApprovalResponse["permissions"] = {};
    if (params.permissions.network) {
      permissions.network = params.permissions.network;
    }
    if (params.permissions.fileSystem) {
      permissions.fileSystem = params.permissions.fileSystem;
    }
    return { permissions, scope };
  }

  private createDeclinedPermissionResponse(): PermissionsRequestApprovalResponse {
    return { permissions: {}, scope: "turn" };
  }

  private convertNotificationToSDKMessages(
    notification: JsonRpcNotification,
    sessionId: string,
    usageByTurnId: Map<string, TokenUsageSnapshot>,
    liveEventState: CodexLiveEventState,
  ): SDKMessage[] {
    switch (notification.method) {
      case "thread/tokenUsage/updated": {
        const usage = this.extractTurnUsage(notification.params);
        if (!usage) {
          return [];
        }

        const message = withCodexTimestamp({
          type: "system",
          subtype: "token_usage",
          session_id: sessionId,
          turnId: usage.turnId,
          isSynthetic: true,
          usage: {
            input_tokens: usage.snapshot.inputTokens,
            output_tokens: usage.snapshot.outputTokens,
            cached_input_tokens: usage.snapshot.cachedInputTokens,
          },
          ...(usage.snapshot.contextWindow && usage.snapshot.contextWindow > 0
            ? { model_context_window: usage.snapshot.contextWindow }
            : {}),
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "token_usage",
          turnId: usage.turnId,
          phase: "usage_updated",
          sourceEvent: notification.method,
        });
        return [message];
      }

      case "turn/completed": {
        const params = this.asTurnCompletedNotification(notification.params);
        const turnId = params?.turn.id ?? null;
        const turnStatus = params?.turn.status;
        const usage = turnId ? usageByTurnId.get(turnId) : undefined;
        const usagePayload = usage
          ? {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cached_input_tokens: usage.cachedInputTokens,
            }
          : undefined;
        const messages: SDKMessage[] = [];
        const orphanedToolUseIds = turnId
          ? this.consumeLiveResultBackedToolItems(liveEventState, turnId)
          : [];
        if (turnId && orphanedToolUseIds.length > 0) {
          const orphanMarker = withCodexTimestamp({
            type: "system",
            subtype: "codex_tool_orphans",
            session_id: sessionId,
            uuid: `codex-tool-orphans-${turnId}`,
            isSynthetic: true,
            orphanedToolUseIds,
          } as SDKMessage);
          logSdkCorrelationDebug(sessionId, orphanMarker, {
            eventKind: "tool_orphans",
            turnId,
            phase: "completed",
            sourceEvent: notification.method,
          });
          messages.push(orphanMarker);
        }

        if (params?.turn.status === "interrupted") {
          const completedAt =
            typeof params.turn.completedAt === "number" &&
            Number.isFinite(params.turn.completedAt)
              ? new Date(params.turn.completedAt * 1000).toISOString()
              : undefined;
          const message = withCodexTimestamp(
            {
              type: "system",
              subtype: "turn_aborted",
              session_id: sessionId,
              uuid: `codex-turn-interrupted-${params.turn.id}`,
              content: "Conversation interrupted",
              reason: "interrupted",
              isSynthetic: true,
              sourceEvent: notification.method,
              codexThreadId: params.threadId,
              codexTurnId: turnId,
              codexTurnStatus: params.turn.status,
              usage: usagePayload,
            } as SDKMessage,
            completedAt,
          );
          logSdkCorrelationDebug(sessionId, message, {
            eventKind: "turn_interrupted",
            ...(turnId ? { turnId } : {}),
            status: turnStatus,
            phase: "completed",
            sourceEvent: notification.method,
          });
          messages.push(message);
          return messages;
        }

        const message = withCodexTimestamp({
          type: "system",
          subtype: "turn_complete",
          session_id: sessionId,
          usage: usagePayload,
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "turn_complete",
          ...(turnId ? { turnId } : {}),
          phase: "completed",
          sourceEvent: notification.method,
        });
        messages.push(message);
        return messages;
      }

      case "error": {
        const params = this.asErrorNotification(notification.params);
        const errorMessage = params?.error.message;
        const message =
          (typeof errorMessage === "string" && errorMessage) ||
          (typeof (notification.params as { message?: unknown })?.message ===
          "string"
            ? (notification.params as { message: string }).message
            : "Codex turn failed");

        const errorEvent = {
          type: "error",
          session_id: sessionId,
          error: message,
          codexErrorInfo: params?.error.codexErrorInfo ?? null,
          codexAdditionalDetails: params?.error.additionalDetails ?? null,
          codexWillRetry: params?.willRetry ?? false,
          codexThreadId: params?.threadId,
          codexTurnId: params?.turnId,
          codexRequestId: this.extractOpenAIRequestId(
            notification.params,
            params?.error,
            message,
          ),
        } as SDKMessage;
        logSdkCorrelationDebug(sessionId, errorEvent, {
          eventKind: "error",
          phase: "emitted",
          sourceEvent: notification.method,
        });
        return [errorEvent];
      }

      case "item/started":
      case "item/completed": {
        const params =
          notification.method === "item/started"
            ? this.asItemStartedNotification(notification.params)
            : this.asItemCompletedNotification(notification.params);
        if (!params) return [];

        const normalized = this.normalizeThreadItem(params.item);
        if (!normalized) {
          return [];
        }

        const turnId = params.turnId;
        if (
          notification.method === "item/started" &&
          this.isResultBackedThreadItem(normalized)
        ) {
          this.recordLiveResultBackedToolItem(
            liveEventState,
            turnId,
            normalized.id,
          );
        }
        const messages = this.convertItemToSDKMessages(
          normalized,
          sessionId,
          turnId,
          notification.method,
        );
        if (notification.method === "item/completed") {
          this.clearLiveResultBackedToolItem(
            liveEventState,
            turnId,
            normalized.id,
          );
          this.clearLiveEventStateForItem(
            liveEventState,
            turnId,
            normalized.id,
          );
        }
        return messages;
      }

      case "item/agentMessage/delta": {
        const params = this.asAgentMessageDeltaNotification(
          notification.params,
        );
        if (!params?.delta) return [];
        return [
          this.buildStreamingAssistantMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.delta,
            "agent_message_delta",
            liveEventState,
          ),
        ];
      }

      case "item/plan/delta": {
        const params = this.asPlanDeltaNotification(notification.params);
        if (!params?.delta) return [];
        return [
          this.buildStreamingAssistantMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.delta,
            "plan_delta",
            liveEventState,
          ),
        ];
      }

      case "item/reasoning/summaryTextDelta": {
        const params = this.asReasoningSummaryTextDeltaNotification(
          notification.params,
        );
        if (!params?.delta) return [];
        return [
          this.buildStreamingReasoningSummaryMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.summaryIndex,
            params.delta,
            liveEventState,
          ),
        ];
      }

      case "item/commandExecution/outputDelta": {
        const params = this.asCommandExecutionOutputDeltaNotification(
          notification.params,
        );
        if (!params?.delta) return [];
        return [
          this.buildStreamingToolResultMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.delta,
            "command_output_delta",
            liveEventState,
          ),
        ];
      }

      case "item/fileChange/outputDelta": {
        const params = this.asFileChangeOutputDeltaNotification(
          notification.params,
        );
        if (!params?.delta) return [];
        return [
          this.buildStreamingToolResultMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.delta,
            "file_change_output_delta",
            liveEventState,
          ),
        ];
      }

      case "rawResponseItem/completed": {
        const params = this.asRawResponseItemCompletedNotification(
          notification.params,
        );
        if (!params) return [];
        return this.convertRawResponseItemToSDKMessages(
          params,
          sessionId,
          liveEventState,
        );
      }

      case "account/rateLimits/updated": {
        // account/rateLimits/updated is telemetry, not a terminal turn error.
        // Real usage-limit/quota failures arrive via the `error` notification.
        return [];
      }

      default:
        return [];
    }
  }

  private normalizeThreadItem(
    item: CodexThreadItem | Record<string, unknown>,
  ): NormalizedThreadItem | null {
    const itemRecord = item as Record<string, unknown>;
    const id = this.getOptionalString(itemRecord.id);
    const type = this.getOptionalString(itemRecord.type);
    if (!id || !type) {
      return null;
    }

    const normalizedType = type.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

    switch (normalizedType) {
      case "reasoning": {
        const text = this.getReasoningText(itemRecord);
        if (!text) return null;
        return { id, type: "reasoning", text };
      }

      case "agent_message":
      case "plan": {
        const text = this.getOptionalString(itemRecord.text) ?? "";
        return { id, type: "agent_message", text };
      }

      case "command_execution": {
        return {
          id,
          type: "command_execution",
          command: this.getOptionalString(itemRecord.command) ?? "",
          aggregated_output:
            this.getOptionalString(itemRecord.aggregated_output) ??
            this.getOptionalString(itemRecord.aggregatedOutput) ??
            "",
          exit_code:
            this.getOptionalNumber(itemRecord.exit_code) ??
            this.getOptionalNumber(itemRecord.exitCode) ??
            undefined,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "file_change": {
        const changesRaw = Array.isArray(itemRecord.changes)
          ? itemRecord.changes
          : [];
        const changes: NormalizedFileChange[] = [];
        for (const change of changesRaw) {
          if (!change || typeof change !== "object") continue;
          const record = change as Record<string, unknown>;
          const path = this.getOptionalString(record.path);
          if (!path) continue;

          let kind: "add" | "delete" | "update" = "update";
          const rawKind = record.kind;
          if (typeof rawKind === "string") {
            if (
              rawKind === "add" ||
              rawKind === "delete" ||
              rawKind === "update"
            ) {
              kind = rawKind;
            }
          } else if (rawKind && typeof rawKind === "object") {
            const rawType = this.getOptionalString(
              (rawKind as Record<string, unknown>).type,
            );
            if (
              rawType === "add" ||
              rawType === "delete" ||
              rawType === "update"
            ) {
              kind = rawType;
            }
          }

          const diff = this.getOptionalString(record.diff) ?? undefined;
          changes.push({
            path,
            kind,
            ...(diff ? { diff } : {}),
          });
        }

        return {
          id,
          type: "file_change",
          changes,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "mcp_tool_call": {
        const errorObj =
          itemRecord.error && typeof itemRecord.error === "object"
            ? (itemRecord.error as Record<string, unknown>)
            : null;

        return {
          id,
          type: "mcp_tool_call",
          server: this.getOptionalString(itemRecord.server) ?? "unknown",
          tool: this.getOptionalString(itemRecord.tool) ?? "unknown",
          arguments: itemRecord.arguments,
          mcpAppResourceUri:
            this.getOptionalString(itemRecord.mcpAppResourceUri) ?? undefined,
          result: itemRecord.result,
          error:
            this.getOptionalString(errorObj?.message) !== null
              ? { message: this.getOptionalString(errorObj?.message) ?? "" }
              : undefined,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "dynamic_tool_call": {
        return {
          id,
          type: "dynamic_tool_call",
          namespace: this.getOptionalString(itemRecord.namespace),
          tool: this.getOptionalString(itemRecord.tool) ?? "unknown",
          arguments: itemRecord.arguments,
          status: this.normalizeStatus(itemRecord.status),
          content_items: Array.isArray(itemRecord.contentItems)
            ? itemRecord.contentItems
            : null,
          success:
            typeof itemRecord.success === "boolean" ? itemRecord.success : null,
        };
      }

      case "web_search": {
        return {
          id,
          type: "web_search",
          query: this.getOptionalString(itemRecord.query) ?? "",
        };
      }

      case "todo_list": {
        const items = Array.isArray(itemRecord.items)
          ? itemRecord.items
              .map((entry: unknown) => {
                if (!entry || typeof entry !== "object") return null;
                const record = entry as Record<string, unknown>;
                const text = this.getOptionalString(record.text);
                if (!text) return null;
                return {
                  text,
                  completed: record.completed === true,
                };
              })
              .filter(
                (
                  entry: unknown,
                ): entry is { text: string; completed: boolean } =>
                  entry !== null,
              )
          : [];
        return {
          id,
          type: "todo_list",
          items,
        };
      }

      case "context_compaction":
        return { id, type: "context_compaction" };

      case "image_view": {
        const imagePath = this.getOptionalString(itemRecord.path) ?? "";
        if (!imagePath) return null;
        return { id, type: "image_view", path: imagePath };
      }

      case "error": {
        const message =
          this.getOptionalString(itemRecord.message) ?? "Codex error";
        return {
          id,
          type: "error",
          message,
        };
      }

      default:
        return null;
    }
  }

  private getReasoningText(item: Record<string, unknown>): string {
    const text = this.getOptionalString(item.text);
    if (text) return text;

    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string")
      : [];
    if (summary.length > 0) {
      return summary.join("\n");
    }

    const content = Array.isArray(item.content)
      ? item.content.filter((part): part is string => typeof part === "string")
      : [];
    if (content.length > 0) {
      return content.join("\n");
    }

    return "";
  }

  private normalizeStatus(status: unknown): string {
    if (typeof status !== "string") return "unknown";
    return status.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  }

  private asTurnCompletedNotification(
    params: unknown,
  ): TurnCompletedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      !record.turn ||
      typeof record.turn !== "object" ||
      typeof (record.turn as { id?: unknown }).id !== "string"
    ) {
      return null;
    }
    return params as TurnCompletedNotification;
  }

  private asErrorNotification(params: unknown): CodexErrorNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.willRetry !== "boolean" ||
      !record.error ||
      typeof record.error !== "object" ||
      typeof (record.error as { message?: unknown }).message !== "string"
    ) {
      return null;
    }
    return params as CodexErrorNotification;
  }

  private asThreadTokenUsageUpdatedNotification(
    params: unknown,
  ): ThreadTokenUsageUpdatedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    const tokenUsage =
      record.tokenUsage && typeof record.tokenUsage === "object"
        ? (record.tokenUsage as Record<string, unknown>)
        : null;
    const last =
      tokenUsage?.last && typeof tokenUsage.last === "object"
        ? (tokenUsage.last as Record<string, unknown>)
        : null;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !last ||
      typeof last.inputTokens !== "number" ||
      typeof last.outputTokens !== "number" ||
      typeof last.cachedInputTokens !== "number"
    ) {
      return null;
    }
    return params as ThreadTokenUsageUpdatedNotification;
  }

  private asCommandExecutionRequestApprovalParams(
    params: unknown,
  ): CommandExecutionRequestApprovalParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string"
    ) {
      return null;
    }
    return params as CommandExecutionRequestApprovalParams;
  }

  private asFileChangeRequestApprovalParams(
    params: unknown,
  ): FileChangeRequestApprovalParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string"
    ) {
      return null;
    }
    return params as FileChangeRequestApprovalParams;
  }

  private asPermissionsRequestApprovalParams(
    params: unknown,
  ): PermissionsRequestApprovalParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      typeof record.cwd !== "string" ||
      !record.permissions ||
      typeof record.permissions !== "object"
    ) {
      return null;
    }
    return params as PermissionsRequestApprovalParams;
  }

  private asToolRequestUserInputParams(
    params: unknown,
  ): ToolRequestUserInputParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      !Array.isArray(record.questions)
    ) {
      return null;
    }
    return params as ToolRequestUserInputParams;
  }

  private asItemStartedNotification(
    params: unknown,
  ): CodexItemStartedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !record.item ||
      typeof record.item !== "object"
    ) {
      return null;
    }
    return params as CodexItemStartedNotification;
  }

  private asItemCompletedNotification(
    params: unknown,
  ): CodexItemCompletedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !record.item ||
      typeof record.item !== "object"
    ) {
      return null;
    }
    return params as CodexItemCompletedNotification;
  }

  private asAgentMessageDeltaNotification(
    params: unknown,
  ): AgentMessageDeltaNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      typeof record.delta !== "string"
    ) {
      return null;
    }
    return params as AgentMessageDeltaNotification;
  }

  private asPlanDeltaNotification(
    params: unknown,
  ): PlanDeltaNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      typeof record.delta !== "string"
    ) {
      return null;
    }
    return params as PlanDeltaNotification;
  }

  private asReasoningSummaryTextDeltaNotification(
    params: unknown,
  ): ReasoningSummaryTextDeltaNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      typeof record.delta !== "string" ||
      typeof record.summaryIndex !== "number"
    ) {
      return null;
    }
    return params as ReasoningSummaryTextDeltaNotification;
  }

  private asCommandExecutionOutputDeltaNotification(
    params: unknown,
  ): CommandExecutionOutputDeltaNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      typeof record.delta !== "string"
    ) {
      return null;
    }
    return params as CommandExecutionOutputDeltaNotification;
  }

  private asFileChangeOutputDeltaNotification(
    params: unknown,
  ): FileChangeOutputDeltaNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      typeof record.delta !== "string"
    ) {
      return null;
    }
    return params as FileChangeOutputDeltaNotification;
  }

  private asRawResponseItemCompletedNotification(
    params: unknown,
  ): RawResponseItemCompletedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !record.item ||
      typeof record.item !== "object" ||
      typeof (record.item as { type?: unknown }).type !== "string"
    ) {
      return null;
    }
    return params as RawResponseItemCompletedNotification;
  }

  private buildItemEventKey(turnId: string, itemId: string): string {
    return `${turnId}:${itemId}`;
  }

  private buildItemMessageUuid(turnId: string, itemId: string): string {
    return `${itemId}-${turnId}`;
  }

  private buildItemResultUuid(turnId: string, itemId: string): string {
    return `${this.buildItemMessageUuid(turnId, itemId)}-result`;
  }

  private isResultBackedThreadItem(item: NormalizedThreadItem): boolean {
    return (
      item.type === "command_execution" ||
      item.type === "file_change" ||
      item.type === "mcp_tool_call" ||
      item.type === "dynamic_tool_call" ||
      item.type === "image_view"
    );
  }

  private recordLiveResultBackedToolItem(
    liveEventState: CodexLiveEventState,
    turnId: string,
    itemId: string,
  ): void {
    const items =
      liveEventState.resultBackedToolItemsByTurnId.get(turnId) ?? new Set();
    items.add(itemId);
    liveEventState.resultBackedToolItemsByTurnId.set(turnId, items);
  }

  private clearLiveResultBackedToolItem(
    liveEventState: CodexLiveEventState,
    turnId: string,
    itemId: string,
  ): void {
    const items = liveEventState.resultBackedToolItemsByTurnId.get(turnId);
    if (!items) return;
    items.delete(itemId);
    if (items.size === 0) {
      liveEventState.resultBackedToolItemsByTurnId.delete(turnId);
    }
  }

  private consumeLiveResultBackedToolItems(
    liveEventState: CodexLiveEventState,
    turnId: string,
  ): string[] {
    const items = liveEventState.resultBackedToolItemsByTurnId.get(turnId);
    if (!items) return [];
    liveEventState.resultBackedToolItemsByTurnId.delete(turnId);
    return [...items];
  }

  private buildStreamingAssistantMessage(
    sessionId: string,
    turnId: string,
    itemId: string,
    delta: string,
    sourceEvent: string,
    liveEventState: CodexLiveEventState,
  ): SDKMessage {
    const key = this.buildItemEventKey(turnId, itemId);
    const text = `${liveEventState.streamingTextByItemKey.get(key) ?? ""}${delta}`;
    liveEventState.streamingTextByItemKey.set(key, text);

    const message = withCodexTimestamp({
      type: "assistant",
      session_id: sessionId,
      uuid: this.buildItemMessageUuid(turnId, itemId),
      _isStreaming: true,
      message: {
        role: "assistant",
        content: text,
      },
    } as SDKMessage);
    logSdkCorrelationDebug(sessionId, message, {
      eventKind: sourceEvent,
      turnId,
      itemId,
      phase: "delta",
      sourceEvent,
    });
    return message;
  }

  private buildStreamingReasoningSummaryMessage(
    sessionId: string,
    turnId: string,
    itemId: string,
    summaryIndex: number,
    delta: string,
    liveEventState: CodexLiveEventState,
  ): SDKMessage {
    const key = this.buildItemEventKey(turnId, itemId);
    const parts =
      liveEventState.streamingReasoningSummaryByItemKey.get(key) ?? [];
    parts[summaryIndex] = `${parts[summaryIndex] ?? ""}${delta}`;
    liveEventState.streamingReasoningSummaryByItemKey.set(key, parts);

    const thinking = parts.filter(Boolean).join("\n");
    const message = withCodexTimestamp({
      type: "assistant",
      session_id: sessionId,
      uuid: this.buildItemMessageUuid(turnId, itemId),
      _isStreaming: true,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking }],
      },
    } as SDKMessage);
    logSdkCorrelationDebug(sessionId, message, {
      eventKind: "reasoning_summary_delta",
      turnId,
      itemId,
      phase: "delta",
      sourceEvent: "item/reasoning/summaryTextDelta",
    });
    return message;
  }

  private buildStreamingToolResultMessage(
    sessionId: string,
    turnId: string,
    itemId: string,
    delta: string,
    sourceEvent: string,
    liveEventState: CodexLiveEventState,
  ): SDKMessage {
    const key = this.buildItemEventKey(turnId, itemId);
    const content = `${liveEventState.streamingToolOutputByItemKey.get(key) ?? ""}${delta}`;
    liveEventState.streamingToolOutputByItemKey.set(key, content);

    const message = withCodexTimestamp({
      type: "user",
      session_id: sessionId,
      uuid: this.buildItemResultUuid(turnId, itemId),
      _isStreaming: true,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: itemId,
            content,
          },
        ],
      },
    } as SDKMessage);
    logSdkCorrelationDebug(sessionId, message, {
      eventKind: "tool_result",
      turnId,
      itemId,
      callId: itemId,
      phase: "delta",
      sourceEvent,
    });
    return message;
  }

  private clearLiveEventStateForItem(
    liveEventState: CodexLiveEventState,
    turnId: string,
    itemId: string,
  ): void {
    const key = this.buildItemEventKey(turnId, itemId);
    liveEventState.streamingTextByItemKey.delete(key);
    liveEventState.streamingReasoningSummaryByItemKey.delete(key);
    liveEventState.streamingToolOutputByItemKey.delete(key);
  }

  private convertRawResponseItemToSDKMessages(
    params: RawResponseItemCompletedNotification,
    sessionId: string,
    liveEventState: CodexLiveEventState,
  ): SDKMessage[] {
    const item = params.item as Record<string, unknown>;
    const itemType = this.getOptionalString(item.type);
    if (!itemType) return [];

    const observedAt = new Date().toISOString();

    switch (itemType) {
      case "function_call": {
        const callId = this.getOptionalString(item.call_id);
        const rawToolName = this.getOptionalString(item.name);
        const argumentsText = this.getOptionalString(item.arguments);
        if (!callId || !rawToolName) return [];

        const normalizedInvocation = normalizeCodexToolInvocation(
          canonicalizeCodexToolName(rawToolName),
          parseCodexToolArguments(argumentsText ?? undefined),
        );
        liveEventState.toolCallContexts.set(callId, {
          toolName: normalizedInvocation.toolName,
          input: normalizedInvocation.input,
          readShellInfo: normalizedInvocation.readShellInfo,
          writeShellInfo: normalizedInvocation.writeShellInfo,
        });
        this.recordLiveResultBackedToolItem(
          liveEventState,
          params.turnId,
          callId,
        );

        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid: this.buildItemMessageUuid(params.turnId, callId),
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: callId,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "function_call",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      case "function_call_output": {
        const callId = this.getOptionalString(item.call_id);
        if (!callId) return [];
        const normalized = normalizeCodexToolOutputWithContext(
          item.output,
          liveEventState.toolCallContexts.get(callId),
        );
        if (
          !isCodexBackgroundProcessOutput(item.output) &&
          !isCodexInterruptedToolOutput(item.output)
        ) {
          liveEventState.toolCallContexts.delete(callId);
          this.clearLiveResultBackedToolItem(
            liveEventState,
            params.turnId,
            callId,
          );
        }

        const toolResult: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        } = {
          type: "tool_result",
          tool_use_id: callId,
          content: normalized.content,
        };
        if (normalized.isError) {
          toolResult.is_error = true;
        }

        const message = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: this.buildItemResultUuid(params.turnId, callId),
            message: {
              role: "user",
              content: [toolResult],
            },
            ...(normalized.structured !== undefined
              ? { toolUseResult: normalized.structured }
              : {}),
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "tool_result",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      case "custom_tool_call": {
        const callId = this.getOptionalString(item.call_id);
        const rawToolName = this.getOptionalString(item.name);
        const input = this.getOptionalString(item.input);
        if (!callId || !rawToolName) return [];

        const normalizedInvocation = normalizeCodexToolInvocation(
          canonicalizeCodexToolName(rawToolName),
          parseCodexToolArguments(input ?? undefined),
        );
        liveEventState.toolCallContexts.set(callId, {
          toolName: normalizedInvocation.toolName,
          input: normalizedInvocation.input,
          readShellInfo: normalizedInvocation.readShellInfo,
          writeShellInfo: normalizedInvocation.writeShellInfo,
        });
        this.recordLiveResultBackedToolItem(
          liveEventState,
          params.turnId,
          callId,
        );

        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid: this.buildItemMessageUuid(params.turnId, callId),
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: callId,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "custom_tool_call",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      case "custom_tool_call_output": {
        const callId = this.getOptionalString(item.call_id);
        if (!callId) return [];
        const normalized = normalizeCodexToolOutputWithContext(
          item.output,
          liveEventState.toolCallContexts.get(callId),
        );
        if (
          !isCodexBackgroundProcessOutput(item.output) &&
          !isCodexInterruptedToolOutput(item.output)
        ) {
          liveEventState.toolCallContexts.delete(callId);
          this.clearLiveResultBackedToolItem(
            liveEventState,
            params.turnId,
            callId,
          );
        }

        const toolResult: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        } = {
          type: "tool_result",
          tool_use_id: callId,
          content: normalized.content,
        };
        if (normalized.isError) {
          toolResult.is_error = true;
        }

        const message = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: this.buildItemResultUuid(params.turnId, callId),
            message: {
              role: "user",
              content: [toolResult],
            },
            ...(normalized.structured !== undefined
              ? { toolUseResult: normalized.structured }
              : {}),
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "tool_result",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      case "compaction": {
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: "compact_boundary",
            session_id: sessionId,
            uuid: `codex-compaction-${params.turnId}`,
            content: "Context compacted",
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "context_compaction",
          turnId: params.turnId,
          itemId: `codex-compaction-${params.turnId}`,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      default:
        return [];
    }
  }

  /**
   * Convert a normalized thread item to SDKMessage(s).
   */
  private convertItemToSDKMessages(
    item: NormalizedThreadItem,
    sessionId: string,
    turnId: string,
    sourceEvent: "item/started" | "item/completed",
  ): SDKMessage[] {
    const isComplete = sourceEvent === "item/completed";
    const observedAt = new Date().toISOString();
    // Create unique UUID by combining item.id with turn ID.
    const uuid = `${item.id}-${turnId}`;

    switch (item.type) {
      case "reasoning": {
        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: item.text,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "reasoning",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "agent_message": {
        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: item.text,
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "agent_message",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "command_execution": {
        const messages: SDKMessage[] = [];
        const normalizedInvocation = normalizeCodexToolInvocation("Bash", {
          command: item.command,
        });
        const toolContext: CodexToolCallContext = {
          toolName: normalizedInvocation.toolName,
          input: normalizedInvocation.input,
          readShellInfo: normalizedInvocation.readShellInfo,
          writeShellInfo: normalizedInvocation.writeShellInfo,
        };

        // Emit tool_use for the command
        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "command_execution",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolUseMessage);

        // If completed, emit tool_result
        if (isComplete && item.status !== "in_progress") {
          const normalizedResult = normalizeCodexCommandExecutionOutput(
            {
              aggregatedOutput: item.aggregated_output,
              exitCode: item.exit_code,
              status: item.status,
            },
            toolContext,
          );
          const toolResultBlock: {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          } = {
            type: "tool_result",
            tool_use_id: item.id,
            content: normalizedResult.content,
          };
          if (normalizedResult.isError) {
            toolResultBlock.is_error = true;
          }

          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [toolResultBlock],
              },
              ...(normalizedResult.structured !== undefined
                ? { toolUseResult: normalizedResult.structured }
                : {}),
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "file_change": {
        const changesSummary = item.changes
          .map((c) => `${c.kind}: ${c.path}`)
          .join("\n");
        const editInput: Record<string, unknown> = {
          changes: item.changes,
        };
        const singlePath = item.changes[0]?.path;
        if (singlePath && item.changes.length === 1) {
          editInput.file_path = singlePath;
        }

        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "Edit",
                  input: editInput,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "file_change",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });

        const messages = [toolUseMessage];

        if (isComplete) {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content:
                      item.status === "completed"
                        ? `File changes applied:\n${changesSummary}`
                        : item.status === "declined"
                          ? `File changes declined:\n${changesSummary}`
                          : `File changes failed:\n${changesSummary}`,
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "mcp_tool_call": {
        const messages: SDKMessage[] = [];
        const input = item.mcpAppResourceUri
          ? {
              arguments: item.arguments,
              mcpAppResourceUri: item.mcpAppResourceUri,
            }
          : item.arguments;

        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: `${item.server}:${item.tool}`,
                  input,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "mcp_tool_call",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolUseMessage);

        if (isComplete && item.status !== "in_progress") {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content:
                      item.status === "completed"
                        ? JSON.stringify(item.result)
                        : item.error?.message || "MCP tool call failed",
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "dynamic_tool_call": {
        const messages: SDKMessage[] = [];
        const toolName = item.namespace
          ? `${item.namespace}:${item.tool}`
          : canonicalizeCodexToolName(item.tool);

        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: toolName,
                  input: item.arguments,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "dynamic_tool_call",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolUseMessage);

        if (isComplete && item.status !== "in_progress") {
          const isError = item.success === false || item.status === "failed";
          const toolResultBlock: {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          } = {
            type: "tool_result",
            tool_use_id: item.id,
            content: this.formatDynamicToolContent(item.content_items),
          };
          if (isError) {
            toolResultBlock.is_error = true;
          }

          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [toolResultBlock],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "web_search": {
        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "WebSearch",
                  input: { query: item.query },
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "web_search",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "todo_list": {
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: "todo_list",
            session_id: sessionId,
            uuid,
            items: item.items,
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "todo_list",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "context_compaction": {
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: isComplete ? "compact_boundary" : "status",
            session_id: sessionId,
            uuid,
            ...(isComplete
              ? { content: "Context compacted" }
              : { status: "compacting", content: "Compacting context..." }),
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "context_compaction",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "image_view": {
        // Represent as a ViewImage tool_use + tool_result pair
        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "ViewImage",
                  input: { path: item.path },
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "image_view",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        const messages: SDKMessage[] = [toolUseMessage];

        if (isComplete) {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content: `Viewed image: ${item.path}`,
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "error": {
        const message = withCodexTimestamp(
          {
            type: "error",
            session_id: sessionId,
            uuid,
            error: item.message,
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "error",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      default:
        return [];
    }
  }

  private formatDynamicToolContent(contentItems: unknown[] | null | undefined) {
    if (!Array.isArray(contentItems) || contentItems.length === 0) {
      return "(no output)";
    }

    const parts = contentItems
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        const type = this.getOptionalString(record.type);
        if (type === "inputText") {
          return this.getOptionalString(record.text) ?? "";
        }
        if (type === "inputImage") {
          const imageUrl = this.getOptionalString(record.imageUrl);
          return imageUrl ? `[image: ${imageUrl}]` : "[image]";
        }
        return "";
      })
      .filter(Boolean);

    return parts.length > 0 ? parts.join("\n") : JSON.stringify(contentItems);
  }

  private getPermissionModeFromMessage(
    message: unknown,
  ): StartSessionOptions["permissionMode"] | undefined {
    if (!message || typeof message !== "object") return undefined;
    const mode = (message as { mode?: unknown }).mode;
    switch (mode) {
      case "default":
      case "acceptEdits":
      case "plan":
      case "bypassPermissions":
        return mode;
      default:
        return undefined;
    }
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    // Handle UserMessage format
    const userMsg = message as UserMessage;
    if (typeof userMsg.text === "string") {
      return userMsg.text;
    }

    // Handle SDK message format
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

  private getOptionalString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private getOptionalNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
}

/**
 * Default Codex provider instance.
 */
export const codexProvider = new CodexProvider();
