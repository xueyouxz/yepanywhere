import { randomUUID } from "node:crypto";
import {
  type EffortLevel,
  type PermissionRules,
  type PromptSuggestionMode,
  type ProviderName,
  type RecapMode,
  type SessionLivenessProbeStatus,
  type SessionLivenessSnapshot,
  type ThinkingConfig,
  type UrlProjectId,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import type { AgentActivity, PendingInputType } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { getProvider } from "../sdk/providers/index.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import { normalizeSlashCommandName } from "../sdk/slashCommandEmulation.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
  SDKMessage,
  UserMessage,
} from "../sdk/types.js";
import type {
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
  SessionAbortedEvent,
  SessionCreatedEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
  WorkerActivityEvent,
} from "../watcher/EventBus.js";
import { Process, type ProcessConstructorOptions } from "./Process.js";
import {
  type QueuedRequestInfo,
  type QueuedResponse,
  WorkerQueue,
  isQueueFullError,
} from "./WorkerQueue.js";
import {
  DEFAULT_IDLE_PREEMPT_THRESHOLD_MS,
  type ProcessInfo,
  type ProcessEvent,
  type ProcessOptions,
  type SessionOwnership,
  type SessionSummary,
  encodeProjectId,
} from "./types.js";

/** Maximum number of terminated processes to retain */
const MAX_TERMINATED_PROCESSES = 50;

/** How long to retain terminated process info (10 minutes) */
const TERMINATED_RETENTION_MS = 10 * 60 * 1000;

/** How often to check for stale processes (60 seconds) */
const STALE_CHECK_INTERVAL_MS = 60 * 1000;

/** Default in-turn stale threshold for providers with frequent heartbeat/tool events. */
const DEFAULT_STALE_IN_TURN_THRESHOLD_MS = 5 * 60 * 1000;
/** Codex sessions can be silent for long periods during backend retries/reconnects. */
const CODEX_STALE_IN_TURN_THRESHOLD_MS = 60 * 60 * 1000;
const HEARTBEAT_TURN_CHECK_INTERVAL_MS = 30 * 1000;
const LIVENESS_PROBE_CHECK_INTERVAL_MS = 30 * 1000;
const LIVENESS_PROBE_REFRESH_MS = 60 * 1000;
const DEFAULT_HEARTBEAT_TURN_TEXT = "continue";
const DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES = 5;

function thinkingConfigsEqual(
  current?: ThinkingConfig,
  next?: ThinkingConfig,
): boolean {
  if (current?.type !== next?.type) return false;
  if (!current || !next) return true;
  if (current.type === "adaptive" && next.type === "adaptive") {
    return current.display === next.display;
  }
  if (current.type === "enabled" && next.type === "enabled") {
    return (
      current.budgetTokens === next.budgetTokens &&
      current.display === next.display
    );
  }
  return true;
}

function isDynamicThinkingModeConfig(thinking?: ThinkingConfig): boolean {
  return (
    !thinking ||
    thinking.type === "disabled" ||
    (thinking.type === "adaptive" && thinking.display === undefined)
  );
}

function canApplyThinkingConfigDynamically(
  current?: ThinkingConfig,
  next?: ThinkingConfig,
): boolean {
  if (!isDynamicThinkingModeConfig(current)) return false;
  if (!isDynamicThinkingModeConfig(next)) return false;
  return current?.type !== next?.type;
}
const DEFAULT_INTERRUPT_TIMEOUT_MS = 2000;
const FORCED_HEARTBEAT_INTERRUPT_PREAMBLE =
  "interrupted for heartbeat; resume interrupted command after responding:";
const HEARTBEAT_RESET_PROBE_STATUSES: ReadonlySet<SessionLivenessProbeStatus> =
  new Set(["active", "idle", "waiting-input"]);
const ACTIVE_HEARTBEAT_DOUBT_STATUSES = new Set([
  "verified-progressing",
  "recently-active-unverified",
  "long-silent-unverified",
]);
const RESUME_COMPACT_WAIT_MS = 3 * 60 * 1000;

export type ResumeMode = "full" | "compact-first";

export type ResumeCompactionAttempt =
  | { status: "completed"; command: string }
  | { status: "timed-out"; command: string; timeoutMs: number }
  | { status: "failed"; command?: string; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "skipped"; reason: string };

export class ResumeCompactionError extends Error {
  readonly sessionId: string;
  readonly provider: ProviderName;
  readonly attempt: ResumeCompactionAttempt;
  readonly recovery = "full-resume" as const;

  constructor(params: {
    sessionId: string;
    provider: ProviderName;
    attempt: ResumeCompactionAttempt;
  }) {
    super(describeResumeCompactionAttempt(params.attempt));
    this.name = "ResumeCompactionError";
    this.sessionId = params.sessionId;
    this.provider = params.provider;
    this.attempt = params.attempt;
  }
}

function describeResumeCompactionAttempt(
  attempt: ResumeCompactionAttempt,
): string {
  switch (attempt.status) {
    case "completed":
      return `Compact-first resume completed with /${attempt.command}`;
    case "timed-out":
      return `Compact-first resume timed out after ${attempt.timeoutMs}ms waiting for /${attempt.command}`;
    case "failed":
      return attempt.command
        ? `Compact-first resume failed after /${attempt.command}: ${attempt.reason}`
        : `Compact-first resume failed: ${attempt.reason}`;
    case "unavailable":
      return `Compact-first resume unavailable: ${attempt.reason}`;
    case "skipped":
      return `Compact-first resume skipped: ${attempt.reason}`;
  }
}

function isCompactBoundaryMessage(message: SDKMessage): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

function compactFailureReason(message: SDKMessage): string | null {
  if (
    message.type !== "system" ||
    message.subtype !== "status" ||
    message.compact_result !== "failed"
  ) {
    return null;
  }
  return typeof message.compact_error === "string" && message.compact_error
    ? message.compact_error
    : "provider reported compaction failure";
}

function isCompactSuccessStatus(message: SDKMessage): boolean {
  return (
    message.type === "system" &&
    message.subtype === "status" &&
    message.compact_result === "success"
  );
}

function getStaleInTurnThresholdMs(provider: ProviderName): number {
  return provider === "codex" || provider === "codex-oss"
    ? CODEX_STALE_IN_TURN_THRESHOLD_MS
    : DEFAULT_STALE_IN_TURN_THRESHOLD_MS;
}

function parseFiniteIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function getHeartbeatResetAtMs(
  liveness: SessionLivenessSnapshot,
  fallbackMs: number,
): number {
  const candidateTimes = [
    parseFiniteIsoMs(liveness.lastVerifiedIdleAt),
    parseFiniteIsoMs(liveness.lastVerifiedProgressAt),
    parseFiniteIsoMs(liveness.lastProviderMessageAt),
    parseFiniteIsoMs(liveness.lastRawProviderEventAt),
    liveness.lastLivenessProbeStatus &&
    HEARTBEAT_RESET_PROBE_STATUSES.has(liveness.lastLivenessProbeStatus)
      ? parseFiniteIsoMs(liveness.lastLivenessProbeAt)
      : null,
  ].filter((ms): ms is number => ms !== null);

  return candidateTimes.length > 0
    ? Math.max(...candidateTimes, fallbackMs)
    : fallbackMs;
}

function parseCandidateUpdatedAtMs(value: string | Date): number | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeHeartbeatForceAfterMinutes(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(value, 1440));
}

type HeartbeatAction =
  | { type: "wait" }
  | { type: "queue" }
  | { type: "interrupt"; forceAfterMinutes: number; forceIdleMs: number };

function getActiveHeartbeatAction(params: {
  isVerifiedIdle: boolean;
  isActiveDoubt: boolean;
  process: Process;
  settings: HeartbeatTurnSettings;
  heartbeatResetAtMs: number;
  idleMs: number;
  now: number;
}): HeartbeatAction {
  const { isVerifiedIdle, process, settings, idleMs } = params;

  if (isVerifiedIdle) {
    return { type: "queue" };
  }

  // isActiveDoubt: in-turn session that may be hung
  const afterMinutes = Number.isFinite(settings.afterMinutes)
    ? Math.max(1, Math.min(settings.afterMinutes, 1440))
    : DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES;
  const forceAfterMinutes = normalizeHeartbeatForceAfterMinutes(
    settings.forceAfterMinutes,
  );

  if (forceAfterMinutes !== null) {
    const forceThresholdMs = (afterMinutes + forceAfterMinutes) * 60 * 1000;
    if (idleMs >= forceThresholdMs) {
      return {
        type: "interrupt",
        forceAfterMinutes,
        forceIdleMs: idleMs - afterMinutes * 60 * 1000,
      };
    }
  }

  // Only queue a steering message if the session supports steering;
  // for non-steerable sessions we have no useful action until force threshold.
  if (!process.canSteer) {
    return { type: "wait" };
  }
  return { type: "queue" };
}

/**
 * Model and thinking settings for a session.
 */
export interface ModelSettings {
  /** Model to use (e.g., "sonnet", "opus", "haiku"). undefined = use CLI default */
  model?: string;
  /** Provider-visible service tier. undefined means provider/default behavior. */
  serviceTier?: string;
  /** Thinking configuration. undefined = thinking disabled */
  thinking?: ThinkingConfig;
  /** Effort level for response quality. undefined = SDK default */
  effort?: EffortLevel;
  /**
   * Optional provider-visible client identity, used by providers that expose
   * launcher identity in session metadata (currently Codex).
   */
  clientName?: string;
  /** Provider to use for this session. undefined = use default (Claude) */
  providerName?: ProviderName;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** Environment variables to set on remote (for testing: CLAUDE_SESSIONS_DIR) */
  remoteEnv?: Record<string, string>;
  /** Global instructions to append to system prompt (from server settings) */
  globalInstructions?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** How this session should answer away-recap requests. */
  recapMode?: RecapMode;
  /** How this session should request native prompt suggestions. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Resume strategy. undefined and "full" preserve existing behavior. */
  resumeMode?: ResumeMode;
  /**
   * Resume only up to and including this transcript message UUID, dropping
   * the tail (e.g. a trailing Claude SDK API-error message). Forwarded to
   * providers that support prefix resume; ignored elsewhere.
   */
  resumeSessionAt?: string;
}

/** Error response when queue is full */
export interface QueueFullResponse {
  error: "queue_full";
  maxQueueSize: number;
}

export interface HeartbeatTurnSettings {
  enabled: boolean;
  afterMinutes: number;
  text: string;
  forceAfterMinutes?: number | null;
}

export interface HeartbeatTurnCandidate {
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  provider: ProviderName;
  model?: string;
  executor?: string;
  updatedAt: string | Date;
  hasPendingToolCall: boolean;
}

/** Optional callback to persist executor when session ID is received */
export type OnSessionExecutorCallback = (
  sessionId: string,
  executor: string | undefined,
) => Promise<void>;

/** Optional callback to fetch authoritative session summary for reconciliation */
export type OnSessionSummaryCallback = (
  sessionId: string,
  projectId: UrlProjectId,
) => Promise<SessionSummary | null>;

/** Delays for initial title/messageCount reconciliation after session creation */
const INITIAL_RECONCILE_DELAYS_MS = [1000, 3000] as const;

export interface SupervisorOptions {
  /** Agent provider interface (preferred for new code) */
  provider?: AgentProvider;
  /** Legacy SDK interface for mock SDK */
  sdk?: ClaudeSDK;
  /** Real SDK interface with full features */
  realSdk?: RealClaudeSDKInterface;
  idleTimeoutMs?: number;
  /** Default permission mode for new sessions */
  defaultPermissionMode?: PermissionMode;
  /** EventBus for emitting session status changes */
  eventBus?: EventBus;
  /** Maximum concurrent workers. 0 = unlimited (default for backward compat) */
  maxWorkers?: number;
  /** Idle threshold in milliseconds for preemption. Workers idle longer than this can be preempted. */
  idlePreemptThresholdMs?: number;
  /** Maximum queue size. 0 = unlimited (default) */
  maxQueueSize?: number;
  /** Callback to persist executor when session ID is received (for remote execution resume) */
  onSessionExecutor?: OnSessionExecutorCallback;
  /** Callback to fetch session summary for initial metadata reconciliation */
  onSessionSummary?: OnSessionSummaryCallback;
  /** Callback to read the current heartbeat-turn settings for a session */
  getHeartbeatTurnSettings?: (
    sessionId: string,
  ) => HeartbeatTurnSettings | undefined;
  /** Callback to find heartbeat-enabled sessions with no owned process. */
  getHeartbeatTurnCandidates?: () =>
    | Promise<HeartbeatTurnCandidate[]>
    | HeartbeatTurnCandidate[];
  /** Maximum time to wait for a graceful provider interrupt before hard abort. */
  interruptTimeoutMs?: number;
}

export class Supervisor {
  private processes: Map<string, Process> = new Map();
  private sessionToProcess: Map<string, string> = new Map(); // sessionId -> processId
  private observedProcessIds: Set<string> = new Set();
  private everOwnedSessions: Set<string> = new Set(); // Sessions we've ever owned (for orphan detection)
  private terminatedProcesses: ProcessInfo[] = []; // Recently terminated processes
  private provider: AgentProvider | null;
  private sdk: ClaudeSDK | null;
  private realSdk: RealClaudeSDKInterface | null;
  private idleTimeoutMs?: number;
  private defaultPermissionMode: PermissionMode;
  private eventBus?: EventBus;
  private maxWorkers: number;
  private idlePreemptThresholdMs: number;
  private workerQueue: WorkerQueue;
  private onSessionExecutor?: OnSessionExecutorCallback;
  private onSessionSummary?: OnSessionSummaryCallback;
  private staleCheckTimer: ReturnType<typeof setInterval>;
  private getHeartbeatTurnSettings?: (
    sessionId: string,
  ) => HeartbeatTurnSettings | undefined;
  private getHeartbeatTurnCandidates?: () =>
    | Promise<HeartbeatTurnCandidate[]>
    | HeartbeatTurnCandidate[];
  private heartbeatTurnInFlight = false;
  private heartbeatTurnTimer: ReturnType<typeof setInterval>;
  private livenessProbeTimer: ReturnType<typeof setInterval>;
  /**
   * One-shot patient-queue re-checks keyed by process id. Bounded: armed only
   * while a process holds patient deferred entries; cleared on unregister.
   */
  private patientCheckTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private interruptTimeoutMs: number;

  constructor(options: SupervisorOptions) {
    this.provider = options.provider ?? null;
    this.sdk = options.sdk ?? null;
    this.realSdk = options.realSdk ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.defaultPermissionMode = options.defaultPermissionMode ?? "default";
    this.eventBus = options.eventBus;
    this.maxWorkers = options.maxWorkers ?? 0; // 0 = unlimited
    this.idlePreemptThresholdMs =
      options.idlePreemptThresholdMs ?? DEFAULT_IDLE_PREEMPT_THRESHOLD_MS;
    this.workerQueue = new WorkerQueue({
      eventBus: options.eventBus,
      maxQueueSize: options.maxQueueSize,
    });
    this.onSessionExecutor = options.onSessionExecutor;
    this.onSessionSummary = options.onSessionSummary;
    this.getHeartbeatTurnSettings = options.getHeartbeatTurnSettings;
    this.getHeartbeatTurnCandidates = options.getHeartbeatTurnCandidates;
    this.interruptTimeoutMs =
      options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.staleCheckTimer = setInterval(
      () => this.terminateStaleProcesses(),
      STALE_CHECK_INTERVAL_MS,
    );
    this.staleCheckTimer.unref(); // Don't keep process alive for cleanup
    this.heartbeatTurnTimer = setInterval(() => {
      void this.queueHeartbeatTurns();
    }, HEARTBEAT_TURN_CHECK_INTERVAL_MS);
    this.heartbeatTurnTimer.unref();
    this.livenessProbeTimer = setInterval(
      () => this.probeLongSilentProcesses(),
      LIVENESS_PROBE_CHECK_INTERVAL_MS,
    );
    this.livenessProbeTimer.unref();

    if (!this.provider && !this.sdk && !this.realSdk) {
      throw new Error("Either provider, sdk, or realSdk must be provided");
    }
  }

  private resolveProvider(modelSettings?: ModelSettings): AgentProvider | null {
    const providerName = modelSettings?.providerName
      ? modelSettings.providerName
      : modelSettings?.executor
        ? "claude"
        : undefined;

    if (!providerName) {
      return this.provider;
    }
    if (this.provider?.name === providerName) {
      return this.provider;
    }
    return getProvider(providerName);
  }

  private resolvePromptSuggestionMode(
    requestedMode: PromptSuggestionMode | undefined,
    provider: Pick<AgentProvider, "supportsNativePromptSuggestions">,
  ): PromptSuggestionMode {
    if (requestedMode === "off") {
      return "off";
    }
    if (provider.supportsNativePromptSuggestions === true) {
      return "native";
    }
    return "off";
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to start session normally
      } else {
        // Queue the request
        const result = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          message,
          permissionMode,
          modelSettings,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    const provider = this.resolveProvider(modelSettings);

    // Use provider if available (preferred)
    if (provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
        modelSettings,
        provider,
      );
    }

    // Use real SDK if available
    if (this.realSdk) {
      return this.startRealSession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
        modelSettings,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      undefined,
      permissionMode,
    );
  }

  /**
   * Create a session without sending an initial message.
   * Used for two-phase flow: create session first, upload files, then send message.
   * The agent will wait for a message to be pushed to the queue.
   */
  async createSession(
    projectPath: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to create session normally
      } else {
        // Queue the request - use empty message placeholder
        const result = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          message: { text: "" }, // Placeholder, will be replaced when first message sent
          permissionMode,
          modelSettings,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    const provider = this.resolveProvider(modelSettings);

    // Use provider if available (preferred)
    if (provider) {
      return this.createProviderSession(
        projectPath,
        projectId,
        permissionMode,
        modelSettings,
        provider,
      );
    }

    // Use real SDK if available
    if (this.realSdk) {
      return this.createRealSession(
        projectPath,
        projectId,
        permissionMode,
        modelSettings,
      );
    }

    // Fall back to legacy mock SDK - not supported for create-only
    throw new Error(
      "createSession requires provider or real SDK - legacy mock SDK not supported",
    );
  }

  /**
   * Create a session using the real SDK without an initial message.
   * The session is created and waits for a message to be queued.
   */
  private async createRealSession(
    projectPath: string,
    projectId: UrlProjectId,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    resumeSessionId?: string,
  ): Promise<Process> {
    if (!this.realSdk) {
      throw new Error("realSdk is not available");
    }

    const processHolder: { process: Process | null } = { process: null };
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const promptSuggestionMode = this.resolvePromptSuggestionMode(
      modelSettings?.promptSuggestionMode,
      { supportsNativePromptSuggestions: true },
    );

    // Start session WITHOUT an initial message - agent will wait
    const result = await this.realSdk.startSession({
      cwd: projectPath,
      // No initialMessage - queue will block until one is pushed
      resumeSessionId,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      clientName: modelSettings?.clientName,
      globalInstructions: modelSettings?.globalInstructions,
      promptSuggestions: promptSuggestionMode === "native",
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      probeLiveness,
      getProviderActivity,
      setMaxThinkingTokens,
      interrupt,
      supportedModels,
      supportedCommands,
      setModel,
      publishAgentctlSessionId,
    } = result;

    const tempSessionId = resumeSessionId ?? randomUUID();
    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      shouldRetainIdleProcess: (sessionId) =>
        this.shouldRetainIdleProcess(sessionId),
      probeLivenessFn: probeLiveness,
      getProviderActivityFn: getProviderActivity,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      publishAgentctlSessionIdFn: publishAgentctlSessionId,
      permissionMode: effectiveMode,
      provider: "claude", // Real SDK is always Claude
      model: modelSettings?.model,
      serviceTier: modelSettings?.serviceTier,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
      recapMode: modelSettings?.recapMode,
      promptSuggestionMode,
      helperSideModel: modelSettings?.helperSideModel,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;
    this.observeProcessEvents(process);

    // Wait for the real session ID from the SDK
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }

    // Recreated processes for an existing session should not emit session-created again.
    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  private async queueProcessMessage(
    process: Process,
    message: UserMessage,
    options?: { allowSteer?: boolean },
  ): Promise<ReturnType<Process["queueMessage"]>> {
    await process.primeSupportedCommandsForMessage(message);
    return process.queueMessage(message, options);
  }

  private watchResumeCompaction(
    process: Process,
    command: string,
    timeoutMs = RESUME_COMPACT_WAIT_MS,
  ): {
    promise: Promise<ResumeCompactionAttempt>;
    cancel: () => void;
  } {
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = (attempt: ResumeCompactionAttempt) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      unsubscribe?.();
      resolve(attempt);
    };

    let resolve!: (attempt: ResumeCompactionAttempt) => void;
    const promise = new Promise<ResumeCompactionAttempt>((innerResolve) => {
      resolve = innerResolve;
    });

    timeout = setTimeout(
      () => finish({ status: "timed-out", command, timeoutMs }),
      timeoutMs,
    );
    timeout.unref?.();

    unsubscribe = process.subscribe((event: ProcessEvent) => {
      if (event.type === "message") {
        const failedReason = compactFailureReason(event.message);
        if (failedReason) {
          finish({ status: "failed", command, reason: failedReason });
          return;
        }
        if (
          isCompactBoundaryMessage(event.message) ||
          isCompactSuccessStatus(event.message)
        ) {
          finish({ status: "completed", command });
        }
        return;
      }
      if (event.type === "error") {
        finish({
          status: "failed",
          command,
          reason: event.error.message,
        });
        return;
      }
      if (event.type === "terminated") {
        finish({
          status: "failed",
          command,
          reason: event.reason,
        });
      }
    });

    return {
      promise,
      cancel: () =>
        finish({
          status: "failed",
          command,
          reason: "compact command was not queued",
        }),
    };
  }

  private async findResumeCompactCommand(
    process: Process,
  ): Promise<
    | { ok: true; command: string }
    | { ok: false; attempt: ResumeCompactionAttempt }
  > {
    if (!process.supportsDynamicCommands) {
      return {
        ok: false,
        attempt: {
          status: "unavailable",
          reason: "provider process does not advertise slash commands",
        },
      };
    }

    let commands: Awaited<ReturnType<Process["supportedCommands"]>>;
    try {
      commands = await process.supportedCommands();
    } catch (error) {
      return {
        ok: false,
        attempt: {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const command = commands
      ?.map((candidate) => normalizeSlashCommandName(candidate.name))
      .find((name) => name === "compact" || name === "compress");

    if (!command) {
      return {
        ok: false,
        attempt: {
          status: "unavailable",
          reason: "no compact/compress slash command advertised",
        },
      };
    }

    return { ok: true, command };
  }

  private async tryResumeCompaction(
    process: Process,
    options?: { allowNonIdleStart?: boolean },
  ): Promise<ResumeCompactionAttempt> {
    if (process.provider !== "claude" && process.provider !== "claude-ollama") {
      return {
        status: "unavailable",
        reason: `${process.provider} does not support compact-first resume`,
      };
    }

    if (!options?.allowNonIdleStart && process.state.type !== "idle") {
      return {
        status: "skipped",
        reason: `process was ${process.state.type}`,
      };
    }

    const command = await this.findResumeCompactCommand(process);
    if (!command.ok) {
      return command.attempt;
    }

    const watcher = this.watchResumeCompaction(process, command.command);
    const queued = process.queueMessage(
      { text: `/${command.command}` },
      { allowSteer: false },
    );
    if (!queued.success) {
      watcher.cancel();
      return {
        status: "failed",
        command: command.command,
        reason: queued.error ?? "compact command was not accepted",
      };
    }

    return watcher.promise;
  }

  private async queueAfterResumeCompaction(params: {
    process: Process;
    sessionId: string;
    message: UserMessage;
    allowNonIdleStart?: boolean;
  }): Promise<void> {
    const attempt = await this.tryResumeCompaction(params.process, {
      allowNonIdleStart: params.allowNonIdleStart,
    });
    if (attempt.status !== "completed") {
      throw new ResumeCompactionError({
        sessionId: params.sessionId,
        provider: params.process.provider,
        attempt,
      });
    }

    const queued = await this.queueProcessMessage(params.process, params.message, {
      allowSteer: false,
    });
    if (!queued.success) {
      throw new Error(queued.error ?? "Failed to queue message after compact");
    }
  }

  private async startCompactFirstProviderResume(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId: string,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings | undefined,
    provider: AgentProvider,
  ): Promise<Process> {
    const process = await this.createProviderSession(
      projectPath,
      projectId,
      permissionMode,
      modelSettings,
      provider,
      resumeSessionId,
    );

    try {
      await this.queueAfterResumeCompaction({
        process,
        sessionId: resumeSessionId,
        message,
        allowNonIdleStart: true,
      });
      return process;
    } catch (error) {
      await process.abort();
      this.unregisterProcess(process);
      throw error;
    }
  }

  private async startCompactFirstRealResume(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId: string,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings | undefined,
  ): Promise<Process> {
    const process = await this.createRealSession(
      projectPath,
      projectId,
      permissionMode,
      modelSettings,
      resumeSessionId,
    );

    try {
      await this.queueAfterResumeCompaction({
        process,
        sessionId: resumeSessionId,
        message,
        allowNonIdleStart: true,
      });
      return process;
    } catch (error) {
      await process.abort();
      this.unregisterProcess(process);
      throw error;
    }
  }

  /**
   * Start a session using the real SDK with full features.
   */
  private async startRealSession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process> {
    const tempSessionId = resumeSessionId ?? randomUUID();

    // realSdk is guaranteed to exist here (checked in startSession)
    if (!this.realSdk) {
      throw new Error("realSdk is not available");
    }

    // We need to reference process in the callback before it's assigned
    // Using a holder object allows us to set the reference later
    const processHolder: { process: Process | null } = { process: null };

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const promptSuggestionMode = this.resolvePromptSuggestionMode(
      modelSettings?.promptSuggestionMode,
      { supportsNativePromptSuggestions: true },
    );

    const result = await this.realSdk.startSession({
      cwd: projectPath,
      resumeSessionId,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      clientName: modelSettings?.clientName,
      executor: modelSettings?.executor,
      remoteEnv: modelSettings?.remoteEnv,
      globalInstructions: modelSettings?.globalInstructions,
      promptSuggestions: promptSuggestionMode === "native",
      onToolApproval: async (toolName, input, opts) => {
        // Delegate to the process's handleToolApproval
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      probeLiveness,
      getProviderActivity,
      setMaxThinkingTokens,
      interrupt,
      supportedModels,
      supportedCommands,
      setModel,
      publishAgentctlSessionId,
    } = result;

    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      shouldRetainIdleProcess: (sessionId) =>
        this.shouldRetainIdleProcess(sessionId),
      probeLivenessFn: probeLiveness,
      getProviderActivityFn: getProviderActivity,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      publishAgentctlSessionIdFn: publishAgentctlSessionId,
      permissionMode: effectiveMode,
      provider: "claude", // Real SDK is always Claude
      model: modelSettings?.model,
      serviceTier: modelSettings?.serviceTier,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
      recapMode: modelSettings?.recapMode,
      promptSuggestionMode,
      helperSideModel: modelSettings?.helperSideModel,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;
    this.observeProcessEvents(process);

    // Wait for the real session ID from the SDK before registering
    // This ensures the client gets the correct ID to use for persistence
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }

    const queued = await this.queueProcessMessage(process, message, {
      allowSteer: false,
    });
    if (!queued.success) {
      await process.abort();
      throw new Error(queued.error ?? "Failed to queue initial message");
    }

    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  /**
   * Create a session using the provider interface without an initial message.
   * The session is created and waits for a message to be queued.
   */
  private async createProviderSession(
    projectPath: string,
    projectId: UrlProjectId,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    provider?: AgentProvider,
    resumeSessionId?: string,
  ): Promise<Process> {
    const activeProvider = provider ?? this.provider;
    if (!activeProvider) {
      throw new Error("provider is not available");
    }

    const processHolder: { process: Process | null } = { process: null };
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const promptSuggestionMode = this.resolvePromptSuggestionMode(
      modelSettings?.promptSuggestionMode,
      activeProvider,
    );

    // Start session WITHOUT an initial message - agent will wait
    const result = await activeProvider.startSession({
      cwd: projectPath,
      // No initialMessage - queue will block until one is pushed
      resumeSessionId,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      serviceTier: modelSettings?.serviceTier,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      clientName: modelSettings?.clientName,
      executor: modelSettings?.executor,
      remoteEnv: modelSettings?.remoteEnv,
      globalInstructions: modelSettings?.globalInstructions,
      promptSuggestions: promptSuggestionMode === "native",
      shouldEmitLiveDeltas: () =>
        processHolder.process?.hasLiveDeltaSubscribers() ?? false,
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      probeLiveness,
      getProviderActivity,
      setMaxThinkingTokens,
      interrupt,
      steer,
      supportedModels,
      supportedCommands,
      setModel,
      publishAgentctlSessionId,
    } = result;

    const tempSessionId = resumeSessionId ?? randomUUID();
    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      shouldRetainIdleProcess: (sessionId) =>
        this.shouldRetainIdleProcess(sessionId),
      probeLivenessFn: probeLiveness,
      getProviderActivityFn: getProviderActivity,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      steerFn: steer,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      publishAgentctlSessionIdFn: publishAgentctlSessionId,
      permissionMode: effectiveMode,
      provider: activeProvider.name,
      model: modelSettings?.model,
      serviceTier: modelSettings?.serviceTier,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
      recapMode: modelSettings?.recapMode,
      promptSuggestionMode,
      helperSideModel: modelSettings?.helperSideModel,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;
    this.observeProcessEvents(process);

    // Wait for the real session ID from the provider
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }

    // Recreated processes for an existing session should not emit session-created again.
    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  /**
   * Start a session using the provider interface with full features.
   */
  private async startProviderSession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    provider?: AgentProvider,
  ): Promise<Process> {
    const activeProvider = provider ?? this.provider;
    if (!activeProvider) {
      throw new Error("provider is not available");
    }

    // We need to reference process in the callback before it's assigned
    const processHolder: { process: Process | null } = { process: null };

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const promptSuggestionMode = this.resolvePromptSuggestionMode(
      modelSettings?.promptSuggestionMode,
      activeProvider,
    );

    const result = await activeProvider.startSession({
      cwd: projectPath,
      resumeSessionId,
      resumeSessionAt: resumeSessionId
        ? modelSettings?.resumeSessionAt
        : undefined,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      serviceTier: modelSettings?.serviceTier,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      remoteEnv: modelSettings?.remoteEnv,
      globalInstructions: modelSettings?.globalInstructions,
      promptSuggestions: promptSuggestionMode === "native",
      shouldEmitLiveDeltas: () =>
        processHolder.process?.hasLiveDeltaSubscribers() ?? false,
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      isProcessAlive,
      probeLiveness,
      getProviderActivity,
      setMaxThinkingTokens,
      interrupt,
      steer,
      supportedModels,
      supportedCommands,
      setModel,
      publishAgentctlSessionId,
    } = result;

    const tempSessionId = resumeSessionId ?? randomUUID();
    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      queue,
      abortFn: abort,
      isProcessAlive,
      shouldRetainIdleProcess: (sessionId) =>
        this.shouldRetainIdleProcess(sessionId),
      probeLivenessFn: probeLiveness,
      getProviderActivityFn: getProviderActivity,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      interruptFn: interrupt,
      steerFn: steer,
      supportedModelsFn: supportedModels,
      supportedCommandsFn: supportedCommands,
      setModelFn: setModel,
      publishAgentctlSessionIdFn: publishAgentctlSessionId,
      permissionMode: effectiveMode,
      provider: activeProvider.name,
      model: modelSettings?.model,
      serviceTier: modelSettings?.serviceTier,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
      recapMode: modelSettings?.recapMode,
      promptSuggestionMode,
      helperSideModel: modelSettings?.helperSideModel,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;
    this.observeProcessEvents(process);

    // Wait for the real session ID from the provider before registering
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }

    const queued = await this.queueProcessMessage(process, message, {
      allowSteer: false,
    });
    if (!queued.success) {
      await process.abort();
      throw new Error(queued.error ?? "Failed to queue initial message");
    }

    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  /**
   * Start a session using the legacy mock SDK.
   */
  private startLegacySession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
  ): Process {
    // sdk is guaranteed to exist here (checked in startSession)
    if (!this.sdk) {
      throw new Error("sdk is not available");
    }
    const iterator = this.sdk.startSession({
      cwd: projectPath,
      resume: resumeSessionId,
    });

    const sessionId = resumeSessionId ?? randomUUID();

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    const options: ProcessOptions = {
      projectPath,
      projectId,
      sessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      permissionMode: effectiveMode,
      provider: "claude", // Legacy mock SDK simulates Claude
    };

    const process = new Process(iterator, options);

    this.registerProcess(process, !resumeSessionId);

    // Queue the initial message
    process.queueMessage(message);

    return process;
  }

  async resumeSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    // Check if already have a process for this session
    const existingProcessId = this.sessionToProcess.get(sessionId);
    if (existingProcessId) {
      const existingProcess = this.processes.get(existingProcessId);
      if (existingProcess) {
        // Check if process is terminated - if so, start a fresh one
        if (existingProcess.isTerminated) {
          this.unregisterProcess(existingProcess);
        } else {
          let restartExistingProcess = false;
          // Check if thinking/effort settings changed
          const thinkingChanged = !thinkingConfigsEqual(
            existingProcess.thinking,
            modelSettings?.thinking,
          );
          const effortChanged =
            existingProcess.effort !== modelSettings?.effort;

          if (thinkingChanged || effortChanged) {
            if (
              thinkingChanged &&
              !effortChanged &&
              canApplyThinkingConfigDynamically(
                existingProcess.thinking,
                modelSettings?.thinking,
              ) &&
              existingProcess.supportsThinkingModeChange
            ) {
              // Toggle adaptive/disabled dynamically via deprecated API
              const tokens =
                modelSettings?.thinking?.type === "disabled" ? 0 : 1;
              const changed = await existingProcess.setMaxThinkingTokens(
                tokens === 0 ? undefined : tokens,
              );
              if (changed) {
                existingProcess.updateThinkingConfig(
                  modelSettings?.thinking,
                  modelSettings?.effort,
                );
              } else {
                const log = getLogger();
                log.warn(
                  {
                    event: "thinking_mode_change_failed",
                    sessionId,
                    processId: existingProcess.id,
                  },
                  "Failed to change thinking mode dynamically",
                );
              }
            } else {
              // Effort changed or no dynamic support: restart process
              const log = getLogger();
              log.info(
                {
                  event: "thinking_mode_changed_restart",
                  sessionId,
                  processId: existingProcess.id,
                  oldThinking: existingProcess.thinking?.type,
                  oldThinkingDisplay:
                    existingProcess.thinking?.type === "adaptive" ||
                    existingProcess.thinking?.type === "enabled"
                      ? existingProcess.thinking.display
                      : undefined,
                  oldEffort: existingProcess.effort,
                  newThinking: modelSettings?.thinking?.type,
                  newThinkingDisplay:
                    modelSettings?.thinking?.type === "adaptive" ||
                    modelSettings?.thinking?.type === "enabled"
                      ? modelSettings.thinking.display
                      : undefined,
                  newEffort: modelSettings?.effort,
                },
                "Thinking/effort changed, restarting process",
              );
              await existingProcess.abort();
              this.unregisterProcess(existingProcess);
              restartExistingProcess = true;
              // Fall through to start a new session with the updated settings
            }
          }
          // Update permission mode if specified
          if (!restartExistingProcess && permissionMode) {
            existingProcess.setPermissionMode(permissionMode);
          }
          // Queue message to existing process (if we didn't fall through to restart)
          if (!restartExistingProcess && !existingProcess.isTerminated) {
            if (modelSettings?.resumeMode === "compact-first") {
              await this.queueAfterResumeCompaction({
                process: existingProcess,
                sessionId,
                message,
              });
              return existingProcess;
            }

            const result = await this.queueProcessMessage(
              existingProcess,
              message,
            );
            if (result.success) {
              return existingProcess;
            }
            // Failed to queue - process likely terminated, clean up and start fresh
            this.unregisterProcess(existingProcess);
          }
        }
      }
    }

    // Check if there's already a queued request for this session
    const existingQueued = this.workerQueue.findBySessionId(sessionId);
    if (existingQueued) {
      // Already queued - return current position
      const position = this.workerQueue.getPosition(existingQueued.id);
      return {
        queued: true,
        queueId: existingQueued.id,
        position: position ?? 1,
      };
    }

    const projectId = encodeProjectId(projectPath);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to start session normally
      } else {
        // Queue the request
        const result = this.workerQueue.enqueue({
          type: "resume-session",
          projectPath,
          projectId,
          sessionId,
          message,
          permissionMode,
          modelSettings,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    const provider = this.resolveProvider(modelSettings);
    const resumeMode = modelSettings?.resumeMode ?? "full";

    // Use provider if available (preferred)
    if (provider) {
      if (resumeMode === "compact-first") {
        return this.startCompactFirstProviderResume(
          projectPath,
          projectId,
          message,
          sessionId,
          permissionMode,
          modelSettings,
          provider,
        );
      }

      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        sessionId,
        permissionMode,
        modelSettings,
        provider,
      );
    }

    // Use real SDK if available
    if (this.realSdk) {
      if (resumeMode === "compact-first") {
        return this.startCompactFirstRealResume(
          projectPath,
          projectId,
          message,
          sessionId,
          permissionMode,
          modelSettings,
        );
      }

      return this.startRealSession(
        projectPath,
        projectId,
        message,
        sessionId,
        permissionMode,
        modelSettings,
      );
    }

    // Fall back to legacy mock SDK
    if (resumeMode === "compact-first") {
      throw new ResumeCompactionError({
        sessionId,
        provider: "claude",
        attempt: {
          status: "unavailable",
          reason: "legacy mock SDK does not support compact-first resume",
        },
      });
    }

    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      sessionId,
      permissionMode,
    );
  }

  /** Whether the resolved provider has a real transcript-fork primitive. */
  supportsForkSession(providerName?: ProviderName): boolean {
    const provider = this.resolveProvider(
      providerName ? { providerName } : undefined,
    );
    return typeof provider?.forkSession === "function";
  }

  /**
   * Fork a session's transcript into a new resumable session, optionally
   * sliced at a message UUID. Throws when the provider has no fork
   * primitive — fork must not be emulated (see
   * topics/session-context-actions.md).
   */
  async forkSession(options: {
    sessionId: string;
    projectPath: string;
    providerName?: ProviderName;
    upToMessageId?: string;
    title?: string;
  }): Promise<{ sessionId: string }> {
    const provider = this.resolveProvider(
      options.providerName ? { providerName: options.providerName } : undefined,
    );
    if (!provider) {
      throw new Error("provider is not available");
    }
    if (typeof provider.forkSession !== "function") {
      throw new Error(`${provider.name} does not support transcript fork`);
    }
    return provider.forkSession({
      sessionId: options.sessionId,
      cwd: options.projectPath,
      upToMessageId: options.upToMessageId,
      title: options.title,
    });
  }

  getProcess(processId: string): Process | undefined {
    return this.processes.get(processId);
  }

  async reconfigureProcess(
    processId: string,
    updates: ModelSettings,
  ): Promise<Process | null> {
    const process = this.getProcess(processId);
    if (!process || process.isTerminated) {
      return null;
    }

    const hasModelUpdate = Object.hasOwn(updates, "model");
    const hasServiceTierUpdate = Object.hasOwn(updates, "serviceTier");
    const hasThinkingUpdate = Object.hasOwn(updates, "thinking");
    const hasEffortUpdate = Object.hasOwn(updates, "effort");

    const nextModel = hasModelUpdate ? updates.model : process.resolvedModel;
    const nextServiceTier = hasServiceTierUpdate
      ? updates.serviceTier
      : process.serviceTier;
    const nextThinking = hasThinkingUpdate
      ? updates.thinking
      : process.thinking;
    const nextEffort = hasEffortUpdate ? updates.effort : process.effort;

    const modelChanged = nextModel !== process.resolvedModel;
    const serviceTierChanged = nextServiceTier !== process.serviceTier;
    const thinkingChanged = !thinkingConfigsEqual(
      process.thinking,
      nextThinking,
    );
    const effortChanged = nextEffort !== process.effort;

    if (
      !modelChanged &&
      !serviceTierChanged &&
      !thinkingChanged &&
      !effortChanged
    ) {
      return process;
    }

    if (
      !serviceTierChanged &&
      !thinkingChanged &&
      !effortChanged &&
      process.supportsSetModel
    ) {
      const changed = await process.setModel(nextModel);
      return changed ? process : null;
    }

    const effectiveProvider = this.resolveProvider({
      providerName: process.provider,
    });
    if (!effectiveProvider) {
      return null;
    }

    const mergedSettings: ModelSettings = {
      model: nextModel,
      serviceTier: nextServiceTier,
      thinking: nextThinking,
      effort: nextEffort,
      providerName: process.provider,
      executor: process.executor,
      recapMode: process.recapMode,
      promptSuggestionMode: process.promptSuggestionMode,
      helperSideModel: process.helperSideModel,
    };

    await process.abort();
    this.unregisterProcess(process);

    return await this.createProviderSession(
      process.projectPath,
      process.projectId,
      process.permissionMode,
      mergedSettings,
      effectiveProvider,
      process.sessionId,
    );
  }

  configureProcessRecaps(
    processId: string,
    config: { recapMode?: RecapMode; helperSideModel?: string },
  ): Process | null {
    const process = this.getProcess(processId);
    if (!process || process.isTerminated) {
      return null;
    }
    process.setRecapConfig(config);
    return process;
  }

  getProcessForSession(sessionId: string): Process | undefined {
    const processId = this.sessionToProcess.get(sessionId);
    if (!processId) return undefined;
    return this.processes.get(processId);
  }

  /**
   * Queue a message to an existing session, handling thinking mode changes.
   * If the thinking mode differs from the process's current setting, this will:
   * 1. Abort the existing process
   * 2. Start a new process with the new thinking settings
   * 3. Queue the message to the new process
   *
   * @returns The process (possibly new), or an error object
   */
  async queueMessageToSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<
    | { success: true; process: Process; restarted: boolean }
    | { success: false; error: string }
  > {
    const process = this.getProcessForSession(sessionId);
    if (!process) {
      return { success: false, error: "No active process for session" };
    }

    if (process.isTerminated) {
      return { success: false, error: "Process terminated" };
    }

    const isActiveSteeringMessage =
      message.metadata?.deliveryIntent === "steer" &&
      process.state.type === "in-turn";
    const requestedThinking = isActiveSteeringMessage
      ? process.thinking
      : modelSettings?.thinking;
    const requestedEffort = isActiveSteeringMessage
      ? process.effort
      : modelSettings?.effort;
    const requestedServiceTier = isActiveSteeringMessage
      ? process.serviceTier
      : (modelSettings?.serviceTier ?? process.serviceTier);

    // Check if service tier/thinking/effort settings changed.
    // Service tier is cost-affecting, so changes require an explicit restart
    // rather than being inferred from a normal prompt.
    const serviceTierChanged = process.serviceTier !== requestedServiceTier;
    const thinkingChanged = !thinkingConfigsEqual(
      process.thinking,
      requestedThinking,
    );
    const effortChanged = process.effort !== requestedEffort;

    if (serviceTierChanged || thinkingChanged || effortChanged) {
      if (
        !serviceTierChanged &&
        thinkingChanged &&
        !effortChanged &&
        canApplyThinkingConfigDynamically(process.thinking, requestedThinking) &&
        process.supportsThinkingModeChange
      ) {
        // Toggle thinking dynamically via deprecated API (works for auto↔off)
        const tokens = requestedThinking?.type === "disabled" ? 0 : 1;
        const changed = await process.setMaxThinkingTokens(
          tokens === 0 ? undefined : tokens,
        );
        if (changed) {
          process.updateThinkingConfig(requestedThinking, requestedEffort);
        } else {
          const log = getLogger();
          log.warn(
            {
              event: "thinking_mode_change_failed_queue",
              sessionId,
              processId: process.id,
            },
            "Failed to change thinking mode dynamically on queue",
          );
        }
      } else {
        // Effort changed or no dynamic support: restart process
        const log = getLogger();
        log.info(
          {
            event: "thinking_mode_changed_queue_restart",
            sessionId,
            processId: process.id,
            oldThinking: process.thinking?.type,
            oldEffort: process.effort,
            oldServiceTier: process.serviceTier,
            newThinking: requestedThinking?.type,
            newEffort: requestedEffort,
            newServiceTier: requestedServiceTier,
          },
          "Service tier/thinking/effort changed on queue, restarting process",
        );

        await process.abort();
        this.unregisterProcess(process);

        const restartModelSettings: ModelSettings = {
          ...modelSettings,
          serviceTier: requestedServiceTier,
          recapMode: modelSettings?.recapMode ?? process.recapMode,
          promptSuggestionMode:
            modelSettings?.promptSuggestionMode ?? process.promptSuggestionMode,
          helperSideModel:
            modelSettings?.helperSideModel ?? process.helperSideModel,
        };

        const result = await this.resumeSession(
          sessionId,
          projectPath,
          message,
          permissionMode,
          restartModelSettings,
        );

        if ("id" in result) {
          return { success: true, process: result, restarted: true };
        }
        return { success: false, error: "Request was queued or failed" };
      }
    }

    // Queue to existing process (dynamic thinking change already applied if needed)
    if (permissionMode) {
      process.setPermissionMode(permissionMode);
    }

    const result = await this.queueProcessMessage(process, message);
    if (result.success) {
      return { success: true, process, restarted: false };
    }

    return { success: false, error: result.error ?? "Failed to queue message" };
  }

  getAllProcesses(): Process[] {
    return Array.from(this.processes.values());
  }

  private async queueHeartbeatTurns(): Promise<void> {
    if (this.heartbeatTurnInFlight) {
      return;
    }
    this.heartbeatTurnInFlight = true;
    const now = Date.now();
    const log = getLogger();

    try {
      for (const process of this.processes.values()) {
        if (this.queuePatientDeferredMessagesForProcess(process, now, log)) {
          continue;
        }
        await this.queueHeartbeatTurnForProcess(process, now, log);
      }

      if (!this.getHeartbeatTurnCandidates) {
        return;
      }
      const candidates = await this.getHeartbeatTurnCandidates();
      for (const candidate of candidates) {
        await this.queueHeartbeatTurnForCandidate(candidate, now, log);
      }
    } finally {
      this.heartbeatTurnInFlight = false;
    }
  }

  private shouldRetainIdleProcess(sessionId: string): boolean {
    const process = this.getProcessForSession(sessionId);
    return (
      process?.hasPatientDeferredMessages() === true ||
      this.getHeartbeatTurnSettings?.(sessionId)?.enabled === true
    );
  }

  private queuePatientDeferredMessagesForProcess(
    process: Process,
    now: number,
    log: ReturnType<typeof getLogger>,
  ): boolean {
    if (
      !process.hasPatientDeferredMessages() ||
      process.isTerminated ||
      process.state.type !== "idle" ||
      process.queueDepth > 0 ||
      process.isProcessAlive === false
    ) {
      return false;
    }

    const liveness = process.getLivenessSnapshot(new Date(now));
    if (liveness.derivedStatus !== "verified-idle") {
      return false;
    }

    const fallbackMs = process.state.since.getTime();
    const quietSinceMs = getHeartbeatResetAtMs(liveness, fallbackMs);
    if (!Number.isFinite(quietSinceMs)) {
      return false;
    }

    // Each patient entry carries its own patience window (seconds of
    // verified quiet); promote the elapsed ones and schedule a precise
    // re-check for the shortest remaining wait.
    const { promoted, nextPatienceMsRemaining } =
      process.promoteEligiblePatientDeferredMessages({ quietSinceMs, now });

    if (nextPatienceMsRemaining !== null) {
      this.schedulePatientDeferredCheck(process, nextPatienceMsRemaining);
    }

    if (!promoted) {
      return false;
    }

    log.info(
      {
        event: "patient_deferred_messages_promoted",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        quietMs: Math.max(0, now - quietSinceMs),
        quietSince: new Date(quietSinceMs).toISOString(),
        livenessStatus: liveness.derivedStatus,
      },
      `Promoted patient deferred messages for session: ${process.sessionId}`,
    );
    return true;
  }

  /**
   * Arm (or re-arm) the one-shot patient-queue re-check for a process. The
   * check itself re-derives eligibility and re-arms only while patient
   * entries remain, so the timer cannot become a standing poll.
   */
  private schedulePatientDeferredCheck(
    process: Process,
    delayMs: number,
  ): void {
    const existing = this.patientCheckTimers.get(process.id);
    if (existing) {
      clearTimeout(existing);
    }
    const delay = Math.max(250, Math.min(delayMs, 60 * 60 * 1000));
    const timer = setTimeout(() => {
      this.patientCheckTimers.delete(process.id);
      if (!this.processes.has(process.id)) {
        return;
      }
      this.queuePatientDeferredMessagesForProcess(
        process,
        Date.now(),
        getLogger(),
      );
    }, delay);
    timer.unref();
    this.patientCheckTimers.set(process.id, timer);
  }

  private async queueHeartbeatTurnForProcess(
    process: Process,
    now: number,
    log: ReturnType<typeof getLogger>,
  ): Promise<void> {
    const settings = this.getHeartbeatTurnSettings?.(process.sessionId);
    if (!settings?.enabled) {
      return;
    }
    if (process.isTerminated) {
      return;
    }
    if (process.queueDepth > 0 || process.isProcessAlive === false) {
      return;
    }

    const liveness = process.getLivenessSnapshot(new Date(now));
    const isVerifiedIdle =
      process.state.type === "idle" &&
      liveness.derivedStatus === "verified-idle";
    const isActiveDoubt =
      process.state.type === "in-turn" &&
      ACTIVE_HEARTBEAT_DOUBT_STATUSES.has(liveness.derivedStatus);
    if (!isVerifiedIdle && !isActiveDoubt) {
      return;
    }

    const afterMinutes = Number.isFinite(settings.afterMinutes)
      ? Math.max(1, Math.min(settings.afterMinutes, 1440))
      : DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES;
    const idleThresholdMs = afterMinutes * 60 * 1000;
    const text = settings.text.trim() || DEFAULT_HEARTBEAT_TURN_TEXT;

    const fallbackMs =
      process.state.type === "idle"
        ? process.state.since.getTime()
        : (parseFiniteIsoMs(liveness.lastStateChangeAt) ?? now);
    const heartbeatResetAtMs = getHeartbeatResetAtMs(liveness, fallbackMs);
    if (!Number.isFinite(heartbeatResetAtMs)) {
      return;
    }
    const idleMs = Math.max(0, now - heartbeatResetAtMs);
    if (idleMs < idleThresholdMs) {
      return;
    }
    const heartbeatResetAt = new Date(heartbeatResetAtMs).toISOString();
    const action = getActiveHeartbeatAction({
      isVerifiedIdle,
      isActiveDoubt,
      process,
      settings,
      heartbeatResetAtMs,
      idleMs,
      now,
    });
    if (action.type === "wait") {
      return;
    }

    if (action.type === "interrupt") {
      void this.interruptHeartbeatTurnForProcess(process, {
        now,
        log,
        text,
        idleMs,
        heartbeatResetAt,
        afterMinutes,
        forceAfterMinutes: action.forceAfterMinutes,
        forceIdleMs: action.forceIdleMs,
        livenessStatus: liveness.derivedStatus,
      });
      return;
    }

    const result = await this.queueProcessMessage(process, { text });
    if (result.success) {
      log.info(
        {
          event: "heartbeat_turn_queued",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          idleMs,
          heartbeatResetAt,
          afterMinutes,
          text,
          heartbeatReason: isVerifiedIdle ? "verified-idle" : "active-doubt",
          livenessStatus: liveness.derivedStatus,
        },
        `Queued heartbeat turn for session: ${process.sessionId}`,
      );
    } else {
      log.warn(
        {
          event: "heartbeat_turn_failed",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          idleMs,
          heartbeatResetAt,
          afterMinutes,
          error: result.error,
          heartbeatReason: isVerifiedIdle ? "verified-idle" : "active-doubt",
          livenessStatus: liveness.derivedStatus,
        },
        `Failed to queue heartbeat turn for session: ${process.sessionId}`,
      );
    }
  }

  private async interruptHeartbeatTurnForProcess(
    process: Process,
    details: {
      now: number;
      log: ReturnType<typeof getLogger>;
      text: string;
      idleMs: number;
      heartbeatResetAt: string;
      afterMinutes: number;
      forceAfterMinutes: number;
      forceIdleMs: number;
      livenessStatus: SessionLivenessSnapshot["derivedStatus"];
    },
  ): Promise<void> {
    const { log } = details;
    const { interrupted, timedOut } = await this.interruptProcessWithTimeout(
      process,
      {
        extraMessages: [{ text: details.text }],
        preamble: FORCED_HEARTBEAT_INTERRUPT_PREAMBLE,
      },
    );

    if (interrupted) {
      log.warn(
        {
          event: "heartbeat_turn_interrupted",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          idleMs: details.idleMs,
          heartbeatResetAt: details.heartbeatResetAt,
          afterMinutes: details.afterMinutes,
          forceAfterMinutes: details.forceAfterMinutes,
          forceIdleMs: details.forceIdleMs,
          text: details.text,
          heartbeatReason: "force-after-active-doubt",
          livenessStatus: details.livenessStatus,
        },
        `Interrupted active turn for heartbeat: ${process.sessionId}`,
      );
      return;
    }

    if (timedOut) {
      log.warn(
        {
          event: "heartbeat_interrupt_timeout",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          timeoutMs: this.interruptTimeoutMs,
          forceAfterMinutes: details.forceAfterMinutes,
          forceIdleMs: details.forceIdleMs,
          livenessStatus: details.livenessStatus,
        },
        `Heartbeat interrupt timed out: ${process.sessionId}`,
      );
    }

    const result = await this.queueProcessMessage(process, {
      text: `${FORCED_HEARTBEAT_INTERRUPT_PREAMBLE}\n\n${details.text}`,
    });
    log.warn(
      {
        event: result.success
          ? "heartbeat_interrupt_fallback_queued"
          : "heartbeat_interrupt_fallback_failed",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        idleMs: details.idleMs,
        heartbeatResetAt: details.heartbeatResetAt,
        afterMinutes: details.afterMinutes,
        forceAfterMinutes: details.forceAfterMinutes,
        forceIdleMs: details.forceIdleMs,
        error: result.error,
        heartbeatReason: "force-after-active-doubt",
        livenessStatus: details.livenessStatus,
      },
      result.success
        ? `Queued heartbeat after failed interrupt: ${process.sessionId}`
        : `Failed heartbeat interrupt fallback: ${process.sessionId}`,
    );
  }

  private async queueHeartbeatTurnForCandidate(
    candidate: HeartbeatTurnCandidate,
    now: number,
    log: ReturnType<typeof getLogger>,
  ): Promise<void> {
    if (this.getProcessForSession(candidate.sessionId)) {
      return;
    }
    if (!candidate.hasPendingToolCall) {
      return;
    }
    const provider = this.resolveProvider({ providerName: candidate.provider });
    if (!provider?.supportsSteering) {
      return;
    }
    const settings = this.getHeartbeatTurnSettings?.(candidate.sessionId);
    if (!settings?.enabled) {
      return;
    }

    const heartbeatResetAtMs = parseCandidateUpdatedAtMs(candidate.updatedAt);
    if (heartbeatResetAtMs === null) {
      return;
    }
    const afterMinutes = Number.isFinite(settings.afterMinutes)
      ? Math.max(1, Math.min(settings.afterMinutes, 1440))
      : DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES;
    const idleThresholdMs = afterMinutes * 60 * 1000;
    const idleMs = Math.max(0, now - heartbeatResetAtMs);
    if (idleMs < idleThresholdMs) {
      return;
    }

    const text = settings.text.trim() || DEFAULT_HEARTBEAT_TURN_TEXT;
    const heartbeatResetAt = new Date(heartbeatResetAtMs).toISOString();
    const result = await this.resumeSession(
      candidate.sessionId,
      candidate.projectPath,
      { text },
      undefined,
      {
        providerName: candidate.provider,
        model: candidate.model,
        executor: candidate.executor,
      },
    );

    if ("error" in result) {
      log.warn(
        {
          event: "heartbeat_turn_failed",
          sessionId: candidate.sessionId,
          projectId: candidate.projectId,
          idleMs,
          heartbeatResetAt,
          afterMinutes,
          error: result.error,
          heartbeatReason: "unowned-pending-tool",
          livenessStatus: "pending-tool-unowned",
        },
        `Failed to resume heartbeat turn for session: ${candidate.sessionId}`,
      );
      return;
    }

    log.info(
      {
        event: "heartbeat_turn_queued",
        sessionId: candidate.sessionId,
        projectId: candidate.projectId,
        idleMs,
        heartbeatResetAt,
        afterMinutes,
        text,
        heartbeatReason: "unowned-pending-tool",
        livenessStatus: "pending-tool-unowned",
        queued: "queued" in result ? result.queued : false,
        processId: "id" in result ? result.id : undefined,
      },
      `Resumed heartbeat turn for session: ${candidate.sessionId}`,
    );
  }

  private probeLongSilentProcesses(): void {
    const now = new Date();
    const log = getLogger();

    for (const process of this.processes.values()) {
      if (process.state.type !== "in-turn") {
        continue;
      }
      if (process.isTerminated || !process.canProbeLiveness) {
        continue;
      }

      const liveness = process.getLivenessSnapshot(now);
      if (
        liveness.derivedStatus !== "long-silent-unverified" &&
        liveness.derivedStatus !== "verified-waiting-provider"
      ) {
        continue;
      }

      const lastProbeAt = liveness.lastLivenessProbeAt
        ? Date.parse(liveness.lastLivenessProbeAt)
        : null;
      if (
        lastProbeAt !== null &&
        Number.isFinite(lastProbeAt) &&
        now.getTime() - lastProbeAt < LIVENESS_PROBE_REFRESH_MS
      ) {
        continue;
      }

      void process
        .probeLiveness()
        .then((probe) => {
          if (!probe) {
            return;
          }
          const event =
            process.state.type === "in-turn" && probe.status !== "active"
              ? "liveness_probe_attention"
              : "liveness_probe_completed";
          log.info(
            {
              event,
              sessionId: process.sessionId,
              processId: process.id,
              projectId: process.projectId,
              provider: process.provider,
              status: probe.status,
              source: probe.source,
              detail: probe.detail,
              checkedAt: probe.checkedAt.toISOString(),
            },
            "Completed active session liveness probe",
          );
        })
        .catch((error) => {
          log.warn(
            {
              event: "liveness_probe_failed",
              sessionId: process.sessionId,
              processId: process.id,
              projectId: process.projectId,
              provider: process.provider,
              error: error instanceof Error ? error.message : String(error),
            },
            "Active session liveness probe failed",
          );
        });
    }
  }

  getProcessInfoList(): ProcessInfo[] {
    return this.getAllProcesses().map((p) => p.getInfo());
  }

  /**
   * Check if a session was ever owned by this server instance.
   * Used to determine if orphaned tool detection should be trusted.
   * For sessions we never owned (external), we can't know if tools were interrupted.
   */
  wasEverOwned(sessionId: string): boolean {
    return this.everOwnedSessions.has(sessionId);
  }

  async abortProcess(processId: string): Promise<boolean> {
    const process = this.processes.get(processId);
    if (!process) return false;

    const log = getLogger();
    log.info(
      {
        event: "session_abort_requested",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session abort requested: ${process.sessionId}`,
    );

    // Emit session-aborted event BEFORE aborting, so ExternalSessionTracker
    // can set up the grace period before any file changes arrive
    this.emitSessionAborted(process.sessionId, process.projectId);

    await process.abort();
    this.unregisterProcess(process);
    return true;
  }

  /**
   * Interrupt the current turn of a running process gracefully.
   * Unlike abort, this stops the current turn but keeps the process alive.
   *
   * @returns Object with success status and whether interrupt is supported
   */
  async interruptProcess(
    processId: string,
  ): Promise<{ success: boolean; supported: boolean; hardAborted?: boolean }> {
    const process = this.processes.get(processId);
    if (!process) return { success: false, supported: false };

    // Check if the process supports interrupt
    if (!process.supportsInterrupt) {
      return { success: false, supported: false };
    }

    const log = getLogger();
    log.info(
      {
        event: "session_interrupt_requested",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session interrupt requested: ${process.sessionId}`,
    );

    const { interrupted, timedOut } =
      await this.interruptProcessWithTimeout(process);
    if (interrupted) {
      return { success: true, supported: true };
    }

    if (timedOut) {
      log.warn(
        {
          event: "session_interrupt_timeout",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          currentState: process.state.type,
          timeoutMs: this.interruptTimeoutMs,
        },
        `Session interrupt timed out; hard-aborting process: ${process.sessionId}`,
      );
    }

    log.warn(
      {
        event: "session_interrupt_incomplete",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session interrupt incomplete; hard-aborting process: ${process.sessionId}`,
    );

    const deferredMessages = process.drainPendingUserMessages("promoted");
    this.emitSessionAborted(process.sessionId, process.projectId);
    process.terminate("interrupt fallback abort");
    this.unregisterProcess(process);
    this.recoverDeferredMessagesAfterHardAbort(process, deferredMessages);
    return { success: false, supported: true, hardAborted: true };
  }

  async requestRecap(
    processId: string,
    options?: { sinceMs?: number | null },
  ): Promise<{ supported: boolean; emitted: boolean; reason?: string }> {
    const process = this.processes.get(processId);
    if (!process) {
      return {
        supported: false,
        emitted: false,
        reason: "process not found",
      };
    }

    const provider = getProvider(process.provider);
    if (!provider) {
      return {
        supported: false,
        emitted: false,
        reason: "provider not found",
      };
    }

    return process.requestRecap(provider, options);
  }

  private async interruptProcessWithTimeout(
    process: Process,
    options?: { extraMessages?: UserMessage[]; preamble?: string },
  ): Promise<{ interrupted: boolean; timedOut: boolean }> {
    const log = getLogger();
    const interruptPromise = process
      .interrupt(options)
      .then((interrupted) => ({ interrupted, timedOut: false }))
      .catch((error) => {
        log.warn(
          {
            event: "session_interrupt_failed",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            error: error instanceof Error ? error.message : String(error),
          },
          `Session interrupt failed: ${process.sessionId}`,
        );
        return { interrupted: false, timedOut: false };
      });

    if (
      !Number.isFinite(this.interruptTimeoutMs) ||
      this.interruptTimeoutMs <= 0
    ) {
      return interruptPromise;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{
      interrupted: boolean;
      timedOut: boolean;
    }>((resolve) => {
      timeout = setTimeout(() => {
        resolve({ interrupted: false, timedOut: true });
      }, this.interruptTimeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([interruptPromise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private recoverDeferredMessagesAfterHardAbort(
    sourceProcess: Process,
    deferredMessages: UserMessage[],
  ): void {
    if (deferredMessages.length === 0) {
      return;
    }

    void this.resumeDeferredMessagesAfterHardAbort(
      sourceProcess,
      deferredMessages,
    ).catch((error) => {
      const log = getLogger();
      log.warn(
        {
          event: "deferred_recovery_failed",
          sessionId: sourceProcess.sessionId,
          processId: sourceProcess.id,
          projectId: sourceProcess.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to recover deferred messages after hard abort",
      );
    });
  }

  private async resumeDeferredMessagesAfterHardAbort(
    sourceProcess: Process,
    deferredMessages: UserMessage[],
  ): Promise<void> {
    const [firstMessage, ...remainingMessages] = deferredMessages;
    if (!firstMessage) {
      return;
    }

    const providerName =
      sourceProcess.provider === "claude" && this.realSdk && !this.provider
        ? undefined
        : sourceProcess.provider;

    const result = await this.resumeSession(
      sourceProcess.sessionId,
      sourceProcess.projectPath,
      firstMessage,
      firstMessage.mode ?? sourceProcess.permissionMode,
      {
        model: sourceProcess.resolvedModel ?? sourceProcess.model,
        thinking: sourceProcess.thinking,
        effort: sourceProcess.effort,
        providerName,
        executor: sourceProcess.executor,
        permissions: sourceProcess.permissions,
      },
    );

    const log = getLogger();
    if (!("id" in result)) {
      log.warn(
        {
          event: "deferred_recovery_not_started",
          sessionId: sourceProcess.sessionId,
          processId: sourceProcess.id,
          projectId: sourceProcess.projectId,
          recoveredCount: deferredMessages.length,
        },
        "Deferred recovery was queued or rejected after hard abort",
      );
      return;
    }

    for (const message of remainingMessages) {
      if (message.mode) {
        result.setPermissionMode(message.mode);
      }
      await result.primeSupportedCommandsForMessage(message);
      const queued = result.deferMessage(message, { promoteIfReady: false });
      if (!queued.success) {
        log.warn(
          {
            event: "deferred_recovery_enqueue_failed",
            sessionId: sourceProcess.sessionId,
            processId: result.id,
            projectId: sourceProcess.projectId,
            tempId: message.tempId,
            error: queued.error,
          },
          "Failed to recover deferred message on replacement process",
        );
      }
    }
  }

  private emitSessionAborted(sessionId: string, projectId: UrlProjectId): void {
    if (!this.eventBus) return;

    const event: SessionAbortedEvent = {
      type: "session-aborted",
      sessionId,
      projectId,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private observeProcessEvents(process: Process): void {
    if (this.observedProcessIds.has(process.id)) {
      return;
    }
    this.observedProcessIds.add(process.id);
    process.subscribe((event) => {
      if (event.type === "idle-reap") {
        this.emitSessionAborted(process.sessionId, process.projectId);
      } else if (event.type === "complete") {
        this.unregisterProcess(process);
      } else if (event.type === "session-id-changed") {
        // Update session→process mapping when temp ID is replaced by real ID from SDK
        // This is critical for ExternalSessionTracker to correctly identify owned sessions
        const log = getLogger();
        log.info(
          {
            event: "session_id_mapping_updated",
            oldSessionId: event.oldSessionId,
            newSessionId: event.newSessionId,
            processId: process.id,
            projectId: process.projectId,
            executor: process.executor,
          },
          `Session ID mapping updated: ${event.oldSessionId} → ${event.newSessionId}`,
        );

        // Keep both temp and real session ID mappings to support lookups by either ID
        // Clients might still be using the temp ID when the real ID arrives
        // The old temp ID mapping is retained (no delete)
        this.sessionToProcess.set(event.newSessionId, process.id);
        this.everOwnedSessions.add(event.newSessionId);

        // Persist executor for remote execution resume support
        // This saves which SSH host was used so resume can reconnect to the same remote
        if (this.onSessionExecutor && process.executor) {
          this.onSessionExecutor(event.newSessionId, process.executor).catch(
            (error) => {
              log.warn(
                {
                  event: "executor_save_failed",
                  sessionId: event.newSessionId,
                  executor: process.executor,
                  error: error instanceof Error ? error.message : String(error),
                },
                `Failed to save executor for session: ${event.newSessionId}`,
              );
            },
          );
        }

        // Emit ownership change for new session ID so clients can update
        const ownership: SessionOwnership = {
          owner: "self",
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        };
        this.emitOwnershipChange(
          event.newSessionId,
          process.projectId,
          ownership,
        );

        // Retry early metadata reconciliation with authoritative session ID.
        this.scheduleInitialSessionReconciliation(
          event.newSessionId,
          process.projectId,
        );
      } else if (event.type === "state-change") {
        // Emit agent activity change for all states that clients need to track
        // This includes in-turn/waiting-input (active) and idle (inactive)
        if (
          event.state.type === "in-turn" ||
          event.state.type === "waiting-input" ||
          event.state.type === "idle"
        ) {
          // Convert InputRequest.type to PendingInputType when waiting for input
          // "tool-approval" stays as-is, "question" or "choice" becomes "user-question"
          let pendingInputType: PendingInputType | undefined;
          if (event.state.type === "waiting-input") {
            const requestType = event.state.request.type;
            pendingInputType =
              requestType === "tool-approval"
                ? "tool-approval"
                : "user-question";
          }
          this.emitAgentActivityChange(
            process.sessionId,
            process.projectId,
            event.state.type,
            pendingInputType,
          );
        }
        // Emit worker activity on any state change (affects hasActiveWork)
        this.emitWorkerActivity();
        // A fresh idle boundary starts the patient-queue quiet clock; arm a
        // prompt re-check so seconds-scale patience does not wait for the
        // 30s heartbeat tick.
        if (
          event.state.type === "idle" &&
          process.hasPatientDeferredMessages()
        ) {
          this.schedulePatientDeferredCheck(process, 250);
        }
      } else if (event.type === "deferred-queue") {
        if (
          event.reason === "queued" &&
          process.state.type === "idle" &&
          process.hasPatientDeferredMessages()
        ) {
          this.schedulePatientDeferredCheck(process, 250);
        }
      } else if (event.type === "terminated") {
        this.emitProcessTerminated(
          process.sessionId,
          process.projectId,
          process.id,
          process.provider,
          event.reason,
        );
      }
    });
  }

  private registerProcess(process: Process, isNewSession: boolean): void {
    this.observeProcessEvents(process);

    const log = getLogger();
    log.info(
      {
        event: "session_registered",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        projectPath: process.projectPath,
        isNewSession,
        permissionMode: process.permissionMode,
      },
      `Session registered: ${process.sessionId} (process: ${process.id})`,
    );

    this.processes.set(process.id, process);
    this.sessionToProcess.set(process.sessionId, process.id);
    this.everOwnedSessions.add(process.sessionId);

    const ownership: SessionOwnership = {
      owner: "self",
      processId: process.id,
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    };

    // Emit session created event for new sessions
    if (isNewSession) {
      this.emitSessionCreated(process, ownership);
      this.scheduleInitialSessionReconciliation(
        process.sessionId,
        process.projectId,
      );
    }

    // Emit ownership change event
    this.emitOwnershipChange(process.sessionId, process.projectId, ownership);

    // Emit initial agent activity (process starts in in-turn state)
    const initialState = process.state;
    if (
      initialState.type === "in-turn" ||
      initialState.type === "waiting-input"
    ) {
      // Convert InputRequest.type to PendingInputType if waiting for input at start
      let pendingInputType: PendingInputType | undefined;
      if (initialState.type === "waiting-input") {
        const requestType = initialState.request.type;
        pendingInputType =
          requestType === "tool-approval" ? "tool-approval" : "user-question";
      }
      this.emitAgentActivityChange(
        process.sessionId,
        process.projectId,
        initialState.type,
        pendingInputType,
      );
    }

    // Emit worker activity after registering (new worker added)
    this.emitWorkerActivity();
  }

  private unregisterProcess(process: Process): void {
    this.observedProcessIds.delete(process.id);
    const patientTimer = this.patientCheckTimers.get(process.id);
    if (patientTimer) {
      clearTimeout(patientTimer);
      this.patientCheckTimers.delete(process.id);
    }
    if (!this.processes.has(process.id)) {
      return;
    }

    const log = getLogger();
    const durationMs = Date.now() - process.startedAt.getTime();
    log.info(
      {
        event: "session_unregistered",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        durationMs,
        finalState: process.state.type,
        terminationReason: process.terminationReason,
      },
      `Session unregistered: ${process.sessionId} after ${durationMs}ms (reason: ${process.terminationReason ?? process.state.type})`,
    );

    // Capture process info for terminated list before deleting
    const terminatedInfo = process.getInfo();
    terminatedInfo.state = "terminated"; // Override state since process may have been forcefully aborted
    terminatedInfo.terminatedAt = new Date().toISOString();
    if (process.terminationReason) {
      terminatedInfo.terminationReason = process.terminationReason;
    }
    this.addTerminatedProcess(terminatedInfo);

    this.processes.delete(process.id);

    // Delete all session ID mappings that point to this process
    // This handles both temp and real session IDs
    for (const [sessionId, processId] of this.sessionToProcess.entries()) {
      if (processId === process.id) {
        this.sessionToProcess.delete(sessionId);
      }
    }

    // Emit ownership change event (back to none)
    this.emitOwnershipChange(process.sessionId, process.projectId, {
      owner: "none",
    });

    // Emit agent activity change to notify clients that this session is no longer running
    // This is needed for real-time updates (e.g., AgentsNavItem indicator)
    this.emitAgentActivityChange(process.sessionId, process.projectId, "idle");

    // Emit worker activity after unregistering (worker removed)
    this.emitWorkerActivity();

    // Process queue when a worker becomes available
    void this.processQueue();
  }

  /**
   * Add a terminated process to the tracking list.
   * Prunes old entries and caps at MAX_TERMINATED_PROCESSES.
   */
  private addTerminatedProcess(info: ProcessInfo): void {
    this.terminatedProcesses.push(info);

    // Cap at max entries
    if (this.terminatedProcesses.length > MAX_TERMINATED_PROCESSES) {
      this.terminatedProcesses = this.terminatedProcesses.slice(
        -MAX_TERMINATED_PROCESSES,
      );
    }
  }

  /**
   * Get recently terminated processes (within retention window).
   * Prunes expired entries before returning.
   */
  getRecentlyTerminatedProcesses(): ProcessInfo[] {
    const now = Date.now();
    const cutoff = now - TERMINATED_RETENTION_MS;

    // Prune old entries
    this.terminatedProcesses = this.terminatedProcesses.filter((p) => {
      if (!p.terminatedAt) return false;
      return new Date(p.terminatedAt).getTime() > cutoff;
    });

    return [...this.terminatedProcesses];
  }

  private emitOwnershipChange(
    sessionId: string,
    projectId: UrlProjectId,
    ownership: SessionOwnership,
  ): void {
    if (!this.eventBus) return;

    const event: SessionStatusEvent = {
      type: "session-status-changed",
      sessionId,
      projectId,
      ownership,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitSessionCreated(
    process: Process,
    ownership: SessionOwnership,
  ): void {
    if (!this.eventBus) return;

    const now = new Date().toISOString();
    const optimistic = this.buildOptimisticSessionSeed(process);
    const session: SessionSummary = {
      id: process.sessionId,
      projectId: process.projectId,
      title: optimistic.title,
      fullTitle: optimistic.fullTitle,
      createdAt: now,
      updatedAt: now,
      messageCount: optimistic.messageCount,
      ownership,
      provider: process.provider,
      initialPrompt: optimistic.fullTitle ?? undefined,
    };

    const event: SessionCreatedEvent = {
      type: "session-created",
      session,
      timestamp: now,
    };
    this.eventBus.emit(event);
  }

  private buildOptimisticSessionSeed(process: Process): {
    title: string | null;
    fullTitle: string | null;
    messageCount: number;
  } {
    const history = process.getMessageHistory();
    const firstUser = history.find(
      (msg) => msg.type === "user" && typeof msg.message?.content === "string",
    );
    const firstContent = firstUser?.message?.content;
    const fullTitle =
      typeof firstContent === "string" ? firstContent.trim() : "";
    if (!fullTitle) {
      return { title: null, fullTitle: null, messageCount: 0 };
    }

    const title = truncateSessionTitle(fullTitle) || null;

    return { title, fullTitle, messageCount: 1 };
  }

  private scheduleInitialSessionReconciliation(
    sessionId: string,
    projectId: UrlProjectId,
  ): void {
    if (!this.eventBus || !this.onSessionSummary) return;

    for (const delayMs of INITIAL_RECONCILE_DELAYS_MS) {
      const timer = setTimeout(() => {
        void this.emitReconciledSessionUpdate(sessionId, projectId);
      }, delayMs);
      timer.unref();
    }
  }

  private async emitReconciledSessionUpdate(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<void> {
    if (!this.eventBus || !this.onSessionSummary) return;

    const summary = await this.onSessionSummary(sessionId, projectId);
    if (!summary) return;

    const event: SessionUpdatedEvent = {
      type: "session-updated",
      sessionId,
      projectId,
      title: summary.title,
      messageCount: summary.messageCount,
      updatedAt: summary.updatedAt,
      contextUsage: summary.contextUsage,
      model: summary.model,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitAgentActivityChange(
    sessionId: string,
    projectId: UrlProjectId,
    activity: AgentActivity,
    pendingInputType?: PendingInputType,
  ): void {
    if (!this.eventBus) return;

    const event: ProcessStateEvent = {
      type: "process-state-changed",
      sessionId,
      projectId,
      activity,
      pendingInputType,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitProcessTerminated(
    sessionId: string,
    projectId: UrlProjectId,
    processId: string,
    provider: ProviderName,
    reason: string,
  ): void {
    if (!this.eventBus) return;

    const event: ProcessTerminatedEvent = {
      type: "process-terminated",
      sessionId,
      projectId,
      processId,
      provider,
      reason,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  /**
   * Emit worker activity event for safe restart indicator.
   * Called when workers are added, removed, or change state.
   */
  private emitWorkerActivity(): void {
    if (!this.eventBus) return;

    const hasActiveWork = Array.from(this.processes.values()).some(
      (p) => p.state.type === "in-turn" || p.state.type === "waiting-input",
    );

    const event: WorkerActivityEvent = {
      type: "worker-activity-changed",
      activeWorkers: this.processes.size,
      queueLength: this.workerQueue.length,
      hasActiveWork,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  // ============ Staleness Detection ============

  /**
   * Terminate processes stuck in "in-turn" with no SDK messages for too long.
   * This catches phantom processes where the underlying Claude process died
   * without the SDK iterator returning done or throwing.
   *
   * When process liveness checking is available (via spawn wrapper), use it to
   * distinguish "process died silently" from "process is busy with a long tool
   * call". Silence alone is not a termination signal; a turn may legitimately
   * run for hours.
   */
  private terminateStaleProcesses(): void {
    const now = Date.now();

    for (const process of this.processes.values()) {
      if (process.state.type !== "in-turn") continue;

      const staleThresholdMs = getStaleInTurnThresholdMs(process.provider);
      const silentMs = now - process.lastMessageTime.getTime();
      if (silentMs < staleThresholdMs) continue;

      // If we can check process liveness, only terminate actually-dead processes.
      // A long-running tool call (e.g., CI wait) will be silent but the process
      // is still alive — don't kill it.
      const alive = process.isProcessAlive;
      if (alive === true) {
        // Process is alive but silent — likely executing a long tool call. Skip.
        continue;
      }

      const log = getLogger();

      if (alive === undefined) {
        log.warn(
          {
            event: "stale_process_liveness_unknown",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            provider: process.provider,
            silentMs,
            staleThresholdMs,
            startedAt: process.startedAt.toISOString(),
            lastMessageTime: process.lastMessageTime.toISOString(),
            livenessAvailable: false,
          },
          `Leaving long-silent process running without liveness check: ${process.sessionId} (no messages for ${Math.round(silentMs / 1000)}s)`,
        );
        continue;
      }

      // alive === false — process is confirmed dead
      log.warn(
        {
          event: "stale_process_dead",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          provider: process.provider,
          silentMs,
          staleThresholdMs,
          startedAt: process.startedAt.toISOString(),
          lastMessageTime: process.lastMessageTime.toISOString(),
        },
        `Terminating dead process: ${process.sessionId} (exited, silent for ${Math.round(silentMs / 1000)}s)`,
      );

      process.terminate(
        `stale: no SDK messages for ${Math.round(silentMs / 1000)}s`,
      );
    }
  }

  // ============ Worker Pool Methods ============

  /**
   * Check if we're at worker capacity.
   */
  private isAtCapacity(): boolean {
    if (this.maxWorkers <= 0) return false; // 0 = unlimited
    return this.processes.size >= this.maxWorkers;
  }

  /**
   * Find a preemptable worker (idle longer than threshold).
   * Returns the worker that has been idle longest.
   * Does not preempt workers waiting for input.
   */
  private findPreemptableWorker(): Process | undefined {
    let oldest: Process | undefined;
    let oldestIdleTime = 0;
    const now = Date.now();

    for (const process of this.processes.values()) {
      // Only preempt idle processes, not waiting-input
      if (process.state.type !== "idle") continue;

      const idleMs = now - process.state.since.getTime();
      if (idleMs >= this.idlePreemptThresholdMs && idleMs > oldestIdleTime) {
        oldest = process;
        oldestIdleTime = idleMs;
      }
    }

    return oldest;
  }

  /**
   * Preempt an idle worker to make room for a new request.
   */
  private async preemptWorker(process: Process): Promise<void> {
    await process.abort();
    this.unregisterProcess(process);
  }

  /**
   * Process the queue - called when a worker becomes available.
   */
  private async processQueue(): Promise<void> {
    while (!this.workerQueue.isEmpty && !this.isAtCapacity()) {
      const request = this.workerQueue.dequeue();
      if (!request) break;

      try {
        let process: Process;

        if (request.type === "new-session") {
          const result = await this.startSessionInternal(
            request.projectPath,
            request.projectId,
            request.message,
            undefined,
            request.permissionMode,
            request.modelSettings,
          );
          process = result;
        } else {
          const result = await this.startSessionInternal(
            request.projectPath,
            request.projectId,
            request.message,
            request.sessionId,
            request.permissionMode,
            request.modelSettings,
          );
          process = result;
        }

        // Emit queue removed event
        this.eventBus?.emit({
          type: "queue-request-removed",
          queueId: request.id,
          sessionId: request.sessionId,
          reason: "started",
          timestamp: new Date().toISOString(),
        });

        request.resolve({ status: "started", processId: process.id });
      } catch (error) {
        // On error, resolve with cancelled status
        request.resolve({
          status: "cancelled",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Internal session start that always starts immediately.
   * Used by queue processing.
   */
  private async startSessionInternal(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process> {
    const provider = this.resolveProvider(modelSettings);

    // Use provider if available (preferred)
    if (provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        resumeSessionId,
        permissionMode,
        modelSettings,
        provider,
      );
    }

    // Use real SDK if available
    if (this.realSdk) {
      return this.startRealSession(
        projectPath,
        projectId,
        message,
        resumeSessionId,
        permissionMode,
        modelSettings,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      resumeSessionId,
      permissionMode,
    );
  }

  // ============ Public Queue Methods ============

  /**
   * Cancel a queued request.
   * @returns true if cancelled, false if not found
   */
  cancelQueuedRequest(queueId: string): boolean {
    return this.workerQueue.cancel(queueId);
  }

  /**
   * Get info about all queued requests.
   */
  getQueueInfo(): QueuedRequestInfo[] {
    return this.workerQueue.getQueueInfo();
  }

  /**
   * Get position for a specific queue entry.
   */
  getQueuePosition(queueId: string): number | undefined {
    return this.workerQueue.getPosition(queueId);
  }

  /**
   * Get current worker count and capacity info.
   */
  getWorkerPoolStatus(): {
    activeWorkers: number;
    maxWorkers: number;
    queueLength: number;
  } {
    return {
      activeWorkers: this.processes.size,
      maxWorkers: this.maxWorkers,
      queueLength: this.workerQueue.length,
    };
  }

  /**
   * Get worker activity status for safe restart indicator.
   * Returns whether any workers are actively processing or waiting for input.
   */
  getWorkerActivity(): {
    activeWorkers: number;
    queueLength: number;
    hasActiveWork: boolean;
  } {
    const hasActiveWork = Array.from(this.processes.values()).some(
      (p) => p.state.type === "in-turn" || p.state.type === "waiting-input",
    );
    return {
      activeWorkers: this.processes.size,
      queueLength: this.workerQueue.length,
      hasActiveWork,
    };
  }
}
