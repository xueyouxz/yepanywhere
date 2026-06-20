import { randomUUID } from "node:crypto";
import type {
  EffortLevel,
  ModelInfo,
  PermissionRules,
  PromptSuggestionMode,
  ProviderName,
  RecapMode,
  SessionLivenessSnapshot,
  SessionWakeReason,
  SessionWakeReasonSnapshot,
  SlashCommand,
  ThinkingConfig,
  UserQuestionAnswers,
  UrlProjectId,
} from "@yep-anywhere/shared";
import {
  DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  clampPatientPatienceSeconds,
} from "@yep-anywhere/shared";
import { DEFAULT_IDLE_TIMEOUT_MS } from "../defaults.js";
import { getLogger } from "../logging/logger.js";
import { getProjectName } from "../projects/paths.js";
import { concatUserMessages, INTERRUPT_PREAMBLE } from "../sdk/messageQueue.js";
import type { MessageQueue } from "../sdk/messageQueue.js";
import { composeTimeAnchors } from "./composeTimeAnchor.js";
import {
  type DeferredDeliverySettings,
  resolveDeferredDeliverySettings,
} from "./deferredDeliverySettings.js";
import type {
  AgentProvider,
  PromptCacheRefreshResult,
} from "../sdk/providers/types.js";
import {
  expandSlashCommandEmulation,
  isSlashCommandSubmission,
} from "../sdk/slashCommandEmulation.js";
import type {
  PermissionMode,
  ProviderActivitySnapshot,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  ProviderRetentionSnapshot,
  SDKMessage,
  TimestampedSDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../sdk/types.js";
import {
  buildSessionLivenessSnapshot,
  type LivenessProbeResult,
  type LivenessProcessState,
} from "./liveness.js";
import type {
  AgentActivity,
  InputRequest,
  ProcessEvent,
  ProcessInfo,
  ProcessOptions,
  ProcessState,
} from "./types.js";

type Listener = (event: ProcessEvent) => void | Promise<void>;
type ClaudeSessionState = "idle" | "running" | "requires_action";

type DeferredQueueEntry = { message: UserMessage; timestamp: string };
type RecentAssistantRecapEntry = {
  completedAtMs: number;
  text: string;
};
type PendingRecapRequest = {
  provider: AgentProvider;
  sinceMs: number | null;
};
type PromptCacheKeepaliveLease = {
  getInactivityMs: () => number | null;
};

/**
 * Whether a queued entry should ride the verified-idle "patient" path instead
 * of the plain turn-end deferred path. Patient delivery only differs from
 * deferred on Claude — the only provider that reports background-work retention
 * (session crons, background/live tasks), which is what lets YA wait for
 * genuine completion. On other providers it would add nothing but a brief
 * sleep, so a "patient"-tagged entry is treated as an ordinary deferred one: it
 * promotes at turn end and never engages the patient machinery.
 */
function isPatientDeferredEntry(
  entry: DeferredQueueEntry,
  provider: ProviderName,
): boolean {
  return (
    entry.message.metadata?.deliveryIntent === "patient" &&
    isClaudeSdkProvider(provider)
  );
}

/** Quiet milliseconds this patient entry waits for after verified idle. */
function patientPatienceMsForEntry(entry: DeferredQueueEntry): number {
  const patienceSeconds =
    clampPatientPatienceSeconds(entry.message.metadata?.patienceSeconds) ??
    DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS;
  return patienceSeconds * 1000;
}

const CODEX_NATIVE_SLASH_COMMAND_NAMES = new Set(["compact", "goal"]);
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const PROMPT_CACHE_KEEPALIVE_RECHECK_MS = 30_000;
const PROMPT_CACHE_KEEPALIVE_MIN_DELAY_MS = 1_000;

function isAskUserQuestionTool(toolName: string): boolean {
  return toolName === ASK_USER_QUESTION_TOOL_NAME;
}

function buildAskUserQuestionPrompt(input: unknown): string {
  const questions =
    input && typeof input === "object"
      ? (input as { questions?: unknown }).questions
      : undefined;
  if (!Array.isArray(questions) || questions.length === 0) {
    return "Answer Claude's question";
  }

  const firstQuestion = questions[0];
  const firstQuestionText =
    firstQuestion && typeof firstQuestion === "object"
      ? (firstQuestion as { question?: unknown }).question
      : undefined;
  if (typeof firstQuestionText !== "string" || !firstQuestionText.trim()) {
    return questions.length === 1
      ? "Answer Claude's question"
      : `Answer Claude's ${questions.length} questions`;
  }

  const trimmed = firstQuestionText.trim();
  return questions.length === 1
    ? trimmed
    : `${trimmed} (+${questions.length - 1} more)`;
}

function getCodexSkillCommandPrefix(
  provider: ProviderName,
): string | undefined {
  return provider === "codex" || provider === "codex-oss" ? "@" : undefined;
}

function getKnownNativeSlashCommands(
  provider: ProviderName,
): ReadonlySet<string> | undefined {
  return provider === "codex" ? CODEX_NATIVE_SLASH_COMMAND_NAMES : undefined;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * IMPORTANT: Never filter out messages by type before emitting to SSE!
 *
 * Tool results are user-type messages containing tool_result content blocks.
 * If you filter out user messages, tool calls will appear stuck in "pending"
 * state until the page is refreshed (when JSONL is fetched from disk).
 *
 * The client-side mergeMessages handles deduplication by UUID, so duplicate
 * emissions are safe and expected (queueMessage emits user messages, and
 * the iterator also yields them).
 *
 * @returns true - always emit the message
 */
export function shouldEmitMessage(_message: SDKMessage): boolean {
  // Always emit. DO NOT add filtering here!
  // See docstring above for why this is critical.
  return true;
}

/**
 * Single decision point for whether a queued user message is hidden from the
 * transcript UI. Currently true only for YA-injected control commands — the
 * `/compact` YA queues for compaction, which native auto-compaction shows no
 * user turn for. This is deliberately NOT folded into `shouldEmitMessage`
 * (which must stay an unconditional `return true` for provider-stream
 * messages); it gates only the optimistic user echo at queue time. Routing
 * every hide through this one predicate lets a future "show hidden" UI render
 * these consistently (e.g. hyper-collapsed) instead of each call site
 * suppressing ad hoc. See topics/injected-message-visibility.md.
 */
export function isHiddenInjectedMessage(message: UserMessage): boolean {
  return message.metadata?.hidden === true;
}

function isClaudeSdkProvider(provider: ProviderName): boolean {
  return provider === "claude" || provider === "claude-ollama";
}

function isClaudeSdkApiErrorMessage(
  provider: ProviderName,
  message: SDKMessage,
): boolean {
  return (
    isClaudeSdkProvider(provider) &&
    message.type === "assistant" &&
    message.isApiErrorMessage === true
  );
}

function getClaudeSessionStateChange(
  message: SDKMessage,
): ClaudeSessionState | null {
  if (
    message.type !== "system" ||
    message.subtype !== "session_state_changed"
  ) {
    return null;
  }
  const state = message.state;
  return state === "idle" || state === "running" || state === "requires_action"
    ? state
    : null;
}

function getSdkMessageSubtype(message: SDKMessage): string | undefined {
  return typeof message.subtype === "string" ? message.subtype : undefined;
}

// Top-level SDK message types that represent real turn content. Each one is part
// of a model/tool turn that is guaranteed to eventually reach a `result`, so
// waking on them can never pin the process `in-turn` forever.
const WAKE_WORK_MESSAGE_TYPES = new Set<string>([
  "assistant",
  "user",
  "stream_event",
]);

// `system` message subtypes that represent live Claude-owned background work
// which can wake the session later. Mirrors the task lifecycle tracked for
// reap-retention in ClaudeProviderRetentionTracker.observeMessage.
const WAKE_WORK_SYSTEM_SUBTYPES = new Set<string>([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
]);

/**
 * Decide whether a post-idle provider message should promote a coarse-idle owned
 * process back to `in-turn` (see promoteIdleForProviderWork and doc
 * tactical/015-claude-background-task-idle-reap.md).
 *
 * This is an allowlist (default-deny) on purpose. The original blacklist ("wake
 * on everything except result / session_state_changed / init") woke the process
 * on any message the SDK introduced that we did not model. That included
 * `prompt_suggestion` — a post-turn, predicted-next-prompt message that is never
 * followed by a `result` — so finished sessions got pinned as "thinking" forever
 * and were never idle-reaped. To add a wake trigger, name it here.
 *
 * Reap-safety is owned separately by ClaudeProviderRetentionTracker; this
 * predicate only governs the cosmetic `in-turn` activity flip. So an unmodeled
 * future message type degrades safely to "no wake" rather than "stuck", and a
 * genuine background task still shows as live via the retention overlay
 * (verified-waiting-provider) regardless of this flip.
 */
function isProviderWorkWakeMessage(message: SDKMessage): boolean {
  // session_state_changed drives the state machine directly; it is not a wake.
  if (getClaudeSessionStateChange(message) !== null) {
    return false;
  }
  if (message.type === "system") {
    const subtype = getSdkMessageSubtype(message);
    return subtype !== undefined && WAKE_WORK_SYSTEM_SUBTYPES.has(subtype);
  }
  return WAKE_WORK_MESSAGE_TYPES.has(message.type);
}

function extractMessageText(message: SDKMessage): string | undefined {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) => (block.type === "text" ? block.text : undefined))
    .filter((part): part is string => !!part)
    .join("\n")
    .trim();
  return text || undefined;
}

function describeClaudeSdkApiError(message: SDKMessage): string {
  const status = message.apiErrorStatus;
  const statusText =
    typeof status === "number" || typeof status === "string"
      ? `status ${status}`
      : "unknown status";
  const detail = extractMessageText(message);
  return detail
    ? `Claude SDK API error (${statusText}): ${detail}`
    : `Claude SDK API error (${statusText})`;
}

/**
 * Pending tool approval request.
 * The SDK's canUseTool callback creates this and waits for respondToInput.
 */
interface PendingToolApproval {
  request: InputRequest;
  resolve: (result: ToolApprovalResult) => void;
}

/**
 * Deferred (queued-while-busy) delivery behavior overrides (tests). Unset
 * fields resolve from server settings then env config — both default off, so
 * vanilla delivery promotes one verbatim deferred turn per delivery boundary
 * (see topics/vanilla-defaults.md and supervisor/deferredDeliverySettings.ts).
 */
export interface DeferredDeliveryOptions {
  /**
   * Max seconds between consecutive compose times for deferred turns to join
   * into one provider turn with `--------` separators. 0 = never join.
   */
  joinWindowSeconds?: number;
  /** Prepend `(Ns ago)` / `(Ms later)` compose-time staleness anchors. */
  composeAnchors?: boolean;
}

export interface ProcessConstructorOptions extends ProcessOptions {
  /** MessageQueue for real SDK, undefined for mock SDK */
  queue?: MessageQueue;
  /** Abort function from real SDK */
  abortFn?: () => void;
  /** Check if underlying CLI process is still alive (for stale detection) */
  isProcessAlive?: () => boolean;
  /** Return true when an idle process should stay owned for an explicit feature. */
  shouldRetainIdleProcess?: (sessionId: string) => boolean;
  /** Actively query provider/session status when passive evidence is stale. */
  probeLivenessFn?: () => Promise<ProviderLivenessProbeResult>;
  /** Passive raw provider/app-server event cadence, when available. */
  getProviderActivityFn?: () => ProviderActivitySnapshot;
  /** Provider-owned work that should retain an otherwise idle process. */
  getProviderRetentionFn?: () => ProviderRetentionSnapshot;
  /** Provider no-context-pollution prompt-cache refresh action. */
  refreshPromptCacheFn?: (options: {
    sessionId: string;
  }) => Promise<PromptCacheRefreshResult>;
  /** Function to change max thinking tokens at runtime (SDK 0.2.7+) */
  setMaxThinkingTokensFn?: (tokens: number | null) => Promise<void>;
  /** Function to interrupt current turn gracefully (SDK 0.2.7+) */
  interruptFn?: () => Promise<undefined | boolean>;
  /**
   * Function to steer an active turn with additional user input.
   * Returns false when steering is unavailable and caller should enqueue.
   */
  steerFn?: (message: UserMessage) => Promise<boolean>;
  /** Function to get supported models (SDK 0.2.7+) */
  supportedModelsFn?: () => Promise<ModelInfo[]>;
  /** Function to get supported slash commands (SDK 0.2.7+) */
  supportedCommandsFn?: () => Promise<SlashCommand[]>;
  /** Function to change model mid-session (SDK 0.2.7+) */
  setModelFn?: (model?: string) => Promise<void>;
  /**
   * Dispatch a provider-native slash command out-of-band (e.g. Codex
   * `/compact` → `thread/compact/start`). Returns `{ handled: false }` when the
   * command should fall back to normal turn delivery.
   */
  runProviderCommandFn?: (
    command: string,
    argument?: string,
  ) => Promise<ProviderCommandResult>;
  /**
   * Publish the provider's real session id to environment bridges that affect
   * future tool shells spawned by the provider child process.
   */
  publishAgentctlSessionIdFn?: (sessionId: string) => void | Promise<void>;
  /** Deprecated compatibility flag; prefer recapMode. */
  recapsEnabled?: boolean;
  /** How this process should answer away-recap requests. */
  recapMode?: RecapMode;
  /** How this process should request native prompt suggestions. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Override deferred-delivery toggles (tests); defaults from server config. */
  deferredDelivery?: DeferredDeliveryOptions;
}

export class Process {
  readonly id: string;
  private _sessionId: string;
  readonly projectPath: string;
  readonly projectId: UrlProjectId;
  readonly startedAt: Date;
  readonly provider: ProviderName;
  readonly model: string | undefined;
  readonly serviceTier: string | undefined;
  /** SSH host for remote execution (undefined = local) */
  readonly executor: string | undefined;

  private legacyQueue: UserMessage[] = [];
  private messageQueue: MessageQueue | null;
  private deferredDeliveryOverrides: DeferredDeliveryOptions | undefined;
  private abortFn: (() => void) | null;
  private _state: ProcessState = { type: "in-turn" };
  private listeners: Set<Listener> = new Set();
  private liveDeltaSubscriberCount = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private iteratorDone = false;

  /** Set synchronously when transport/spawn fails to prevent race with queueMessage */
  private transportFailed = false;

  /**
   * Two-bucket message buffer for SSE replay to late-joining clients.
   * Buckets swap every 15 seconds, giving 15-30s of history.
   * This bounds memory while covering the JSONL persistence gap.
   */
  private currentBucket: SDKMessage[] = [];
  private previousBucket: SDKMessage[] = [];
  private bucketSwapTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BUCKET_SWAP_INTERVAL_MS = 15_000;

  /** Accumulated streaming text for catch-up when clients connect mid-stream */
  private _streamingText = "";
  /** Message ID for current streaming response */
  private _streamingMessageId: string | null = null;

  /**
   * Rolling buffer of recent assistant text turns used as context for
   * server-synthesized recaps. See topics/recaps.md. We capture text here
   * rather than reading the JSONL because the recap path is hot and the
   * buffer is bounded; older entries are dropped as new ones arrive.
   */
  private recentAssistantRecapEntries: RecentAssistantRecapEntry[] = [];
  private static readonly RECENT_TEXT_MAX_ENTRIES = 15;
  private static readonly RECENT_TEXT_MAX_CHARS_PER_ENTRY = 1500;
  /**
   * Guard against overlapping recap requests for the same process; the
   * route handler short-circuits when a generation is already in flight.
   */
  private recapInFlight = false;
  private pendingRecapRequest: PendingRecapRequest | null = null;
  private _recapMode: RecapMode;
  private _promptSuggestionMode: PromptSuggestionMode;
  private _helperSideModel: string;

  /** Pending tool approval requests (from canUseTool callback) - supports concurrent approvals */
  private pendingToolApprovals: Map<string, PendingToolApproval> = new Map();
  /** Order of pending approval request IDs for FIFO processing */
  private pendingToolApprovalQueue: string[] = [];

  /** Current permission mode for tool approvals */
  private _permissionMode: PermissionMode = "default";

  /** Permission rules for tool filtering (deny/allow patterns from API caller) */
  private _permissions: PermissionRules | undefined;

  /** Version counter for permission mode changes (for multi-tab sync) */
  private _modeVersion = 0;

  /** Thinking configuration (undefined = thinking disabled) */
  private _thinking: ThinkingConfig | undefined;
  /** Effort level for response quality */
  private _effort: EffortLevel | undefined;

  /** Function to change max thinking tokens at runtime (SDK 0.2.7+) */
  private setMaxThinkingTokensFn:
    | ((tokens: number | null) => Promise<void>)
    | null;

  /** Function to interrupt current turn gracefully (SDK 0.2.7+) */
  private interruptFn: (() => Promise<undefined | boolean>) | null;
  /** Function to steer an active turn (provider-specific, currently Codex app-server) */
  private steerFn: ((message: UserMessage) => Promise<boolean>) | null;

  /** Function to get supported models (SDK 0.2.7+) */
  private supportedModelsFn: (() => Promise<ModelInfo[]>) | null;

  /** Function to get supported slash commands (SDK 0.2.7+) */
  private supportedCommandsFn: (() => Promise<SlashCommand[]>) | null;
  private supportedCommandsCache: SlashCommand[] | null = null;
  private supportedCommandsRefreshInFlight: Promise<
    SlashCommand[] | null
  > | null = null;

  /** Function to change model mid-session (SDK 0.2.7+) */
  private setModelFn: ((model?: string) => Promise<void>) | null;
  /** Function to dispatch a provider-native slash command out-of-band. */
  private runProviderCommandFn:
    | ((command: string, argument?: string) => Promise<ProviderCommandResult>)
    | null;
  private publishAgentctlSessionIdFn:
    | ((sessionId: string) => void | Promise<void>)
    | null;

  /** Resolvers waiting for the real session ID */
  private sessionIdResolvers: Array<(id: string) => void> = [];
  private sessionIdResolved = false;

  /** Timestamp of last SDK message received (for staleness detection) */
  private _lastMessageTime: Date;
  /** Timestamp of last real provider/SDK message; null until one arrives. */
  private _lastProviderMessageTime: Date | null;
  /** Timestamp of last Process state transition. */
  private _lastStateChangeTime: Date;

  /** Check if underlying CLI process is still alive (undefined = not available). */
  private _isProcessAlive: (() => boolean) | null;
  private shouldRetainIdleProcess: ((sessionId: string) => boolean) | null;
  /** Provider-specific active liveness probe, when available. */
  private probeLivenessFn: (() => Promise<ProviderLivenessProbeResult>) | null;
  private getProviderActivityFn: (() => ProviderActivitySnapshot) | null;
  private getProviderRetentionFn: (() => ProviderRetentionSnapshot) | null =
    null;
  private refreshPromptCacheFn:
    | ((options: { sessionId: string }) => Promise<PromptCacheRefreshResult>)
    | null = null;
  private promptCacheKeepaliveLeases = new Map<
    string,
    PromptCacheKeepaliveLease
  >();
  private promptCacheKeepaliveTimer: ReturnType<typeof setTimeout> | null =
    null;
  private promptCacheKeepaliveInFlight = false;
  private lastPromptCacheKeepaliveAt: Date | null = null;
  private lastWakeReason: SessionWakeReasonSnapshot | null = null;
  private _lastLivenessProbe: LivenessProbeResult | null = null;
  private _livenessProbeInFlight: Promise<LivenessProbeResult | null> | null =
    null;

  /** OS PID of the spawned agent child process (supports deferred resolution) */
  private _pidResolver: number | (() => number | undefined) | undefined;

  /** Resolved model name from the first assistant message (e.g., "claude-sonnet-4-5-20250929") */
  private _resolvedModel: string | undefined;
  /**
   * Current requested YA model id (launch alias, e.g. "opus"). Starts at the
   * launch `model` and follows mid-session model switches (which leave the
   * readonly `model` at its original value). Keys per-model settings.
   */
  private _requestedModel: string | undefined;
  /** Context window size reported by SDK in result messages' modelUsage */
  private _contextWindow: number | undefined;

  /** Deferred message queue — messages queued while agent is in-turn, auto-sent when turn ends */
  private deferredQueue: DeferredQueueEntry[] = [];

  /** Promise that resolves when the process fully terminates (CLI exits) */
  private _exitPromise: Promise<void>;
  private _exitResolve: (() => void) | null = null;
  /** True while idle timeout intentionally tears down the provider process. */
  private idleReapInProgress = false;

  constructor(
    private sdkIterator: AsyncIterator<SDKMessage>,
    options: ProcessConstructorOptions,
  ) {
    this.id = randomUUID();
    this._sessionId = options.sessionId;
    this.projectPath = options.projectPath;
    this.projectId = options.projectId;
    this.startedAt = new Date();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    // Real SDK provides these, mock SDK doesn't
    this.messageQueue = options.queue ?? null;
    this.deferredDeliveryOverrides = options.deferredDelivery;
    this.abortFn = options.abortFn ?? null;
    this._permissionMode = options.permissionMode ?? "default";
    this._permissions = options.permissions;
    this.provider = options.provider;
    this.model = options.model;
    this._requestedModel = options.model;
    this.serviceTier = options.serviceTier;
    this.executor = options.executor;
    this._thinking = options.thinking;
    this._effort = options.effort;
    this.setMaxThinkingTokensFn = options.setMaxThinkingTokensFn ?? null;
    this.interruptFn = options.interruptFn ?? null;
    this.steerFn = options.steerFn ?? null;
    this.supportedModelsFn = options.supportedModelsFn ?? null;
    this.supportedCommandsFn = options.supportedCommandsFn ?? null;
    this._pidResolver = options.pid;
    this.setModelFn = options.setModelFn ?? null;
    this.runProviderCommandFn = options.runProviderCommandFn ?? null;
    this.publishAgentctlSessionIdFn =
      options.publishAgentctlSessionIdFn ?? null;
    this._isProcessAlive = options.isProcessAlive ?? null;
    this.shouldRetainIdleProcess = options.shouldRetainIdleProcess ?? null;
    this.probeLivenessFn = options.probeLivenessFn ?? null;
    this.getProviderActivityFn = options.getProviderActivityFn ?? null;
    this.getProviderRetentionFn = options.getProviderRetentionFn ?? null;
    this.refreshPromptCacheFn = options.refreshPromptCacheFn ?? null;
    this._recapMode =
      options.recapMode ?? (options.recapsEnabled ? "side-session" : "off");
    this._promptSuggestionMode = options.promptSuggestionMode ?? "off";
    this._helperSideModel =
      options.helperSideModel ?? HELPER_SIDE_MODEL_CHEAPEST;
    this._lastMessageTime = new Date();
    this._lastProviderMessageTime = null;
    this._lastStateChangeTime = new Date();

    // Exit promise resolves when the CLI process fully terminates
    this._exitPromise = new Promise((resolve) => {
      this._exitResolve = resolve;
    });

    // Start bucket swap timer for bounded message history
    this.startBucketSwapTimer();

    // Start processing messages from the SDK
    this.processMessages();
  }

  /**
   * Start the timer that swaps message buckets.
   * This bounds memory by discarding messages older than ~30 seconds.
   */
  private startBucketSwapTimer(): void {
    this.bucketSwapTimer = setInterval(() => {
      this.previousBucket = this.currentBucket;
      this.currentBucket = [];
    }, Process.BUCKET_SWAP_INTERVAL_MS);
  }

  /**
   * Stop the bucket swap timer.
   */
  private stopBucketSwapTimer(): void {
    if (this.bucketSwapTimer) {
      clearInterval(this.bucketSwapTimer);
      this.bucketSwapTimer = null;
    }
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * The actual model used by the API, extracted from the first assistant message.
   * Falls back to the requested model if no assistant message has been received yet.
   */
  get resolvedModel(): string | undefined {
    return this._resolvedModel ?? this.model;
  }

  /**
   * Current requested YA model id (launch alias, following model switches),
   * the key for per-model settings. Distinct from `resolvedModel` (reported).
   */
  get requestedModel(): string | undefined {
    return this._requestedModel ?? this.model;
  }

  /** Context window size reported by SDK (from result message modelUsage) */
  get contextWindow(): number | undefined {
    return this._contextWindow;
  }

  get state(): ProcessState {
    return this._state;
  }

  /** When the last SDK message was received (for staleness detection) */
  get lastMessageTime(): Date {
    return this._lastMessageTime;
  }

  /**
   * Check if the underlying CLI process is still alive.
   * Returns true if alive, false if dead, undefined if liveness check is unavailable.
   */
  get isProcessAlive(): boolean | undefined {
    return this._isProcessAlive?.();
  }

  get canProbeLiveness(): boolean {
    return this.probeLivenessFn !== null;
  }

  get canSteer(): boolean {
    return this.steerFn !== null;
  }

  get lastLivenessProbe(): LivenessProbeResult | null {
    return this._lastLivenessProbe;
  }

  get liveness(): SessionLivenessSnapshot {
    return this.getLivenessSnapshot();
  }

  get recapMode(): RecapMode {
    return this._recapMode;
  }

  get helperSideModel(): string {
    return this._helperSideModel;
  }

  get promptSuggestionMode(): PromptSuggestionMode {
    return this._promptSuggestionMode;
  }

  setRecapConfig(config: {
    recapMode?: RecapMode;
    helperSideModel?: string;
  }): void {
    if (config.recapMode !== undefined) {
      this._recapMode = config.recapMode;
    }
    if (config.helperSideModel !== undefined) {
      this._helperSideModel =
        config.helperSideModel || HELPER_SIDE_MODEL_CHEAPEST;
    }
  }

  /** OS PID of the spawned agent child process */
  get pid(): number | undefined {
    if (typeof this._pidResolver === "function") {
      return this._pidResolver();
    }
    return this._pidResolver;
  }

  get queueDepth(): number {
    if (this.messageQueue) {
      return this.messageQueue.depth;
    }
    return this.legacyQueue.length;
  }

  private get deferredQueueDepth(): number {
    return this.deferredQueue.length;
  }

  hasPatientDeferredMessages(): boolean {
    return this.deferredQueue.some((entry) =>
      isPatientDeferredEntry(entry, this.provider),
    );
  }

  getLivenessSnapshot(now = new Date()): SessionLivenessSnapshot {
    const providerActivity = this.getProviderActivityFn?.();
    const providerRetention = this.getProviderRetentionSnapshot();
    return buildSessionLivenessSnapshot({
      provider: this.provider,
      state: this.toLivenessState(),
      startedAt: this.startedAt,
      lastStateChangeAt: this._lastStateChangeTime,
      lastProviderMessageAt: this._lastProviderMessageTime,
      lastRawProviderEventAt: providerActivity?.lastRawProviderEventAt ?? null,
      lastRawProviderEventSource:
        providerActivity?.lastRawProviderEventSource ?? null,
      lastLivenessProbe: this._lastLivenessProbe,
      processAlive: this.isProcessAlive,
      providerRetention,
      lastWakeReason: this.lastWakeReason,
      queueDepth: this.queueDepth,
      deferredQueueDepth: this.deferredQueueDepth,
      now,
    });
  }

  private getProviderRetentionSnapshot(): ProviderRetentionSnapshot {
    return (
      this.getProviderRetentionFn?.() ?? {
        retained: false,
        reasons: [],
      }
    );
  }

  handleProviderRetentionChanged(): void {
    this.emit({ type: "liveness-update" });
    if (this._state.type === "idle") {
      this.rescheduleIdleTimerForCurrentIdlePeriod();
    }
  }

  supportsPromptCacheKeepalive(): boolean {
    return this.refreshPromptCacheFn !== null;
  }

  registerPromptCacheKeepaliveLease(
    lease: PromptCacheKeepaliveLease,
  ): () => void {
    if (!this.refreshPromptCacheFn) {
      return () => {};
    }
    const leaseId = randomUUID();
    this.promptCacheKeepaliveLeases.set(leaseId, lease);
    this.schedulePromptCacheKeepalive();
    return () => {
      this.promptCacheKeepaliveLeases.delete(leaseId);
      if (this.promptCacheKeepaliveLeases.size === 0) {
        this.clearPromptCacheKeepaliveTimer();
      } else {
        this.schedulePromptCacheKeepalive();
      }
    };
  }

  private hasPromptCacheKeepaliveLease(): boolean {
    return this.promptCacheKeepaliveLeases.size > 0;
  }

  private resolvePromptCacheKeepaliveInactivityMs(): number | null {
    let resolved: number | null = null;
    for (const lease of this.promptCacheKeepaliveLeases.values()) {
      const value = lease.getInactivityMs();
      if (value === null || !Number.isFinite(value) || value <= 0) {
        continue;
      }
      resolved = resolved === null ? value : Math.min(resolved, value);
    }
    return resolved;
  }

  private schedulePromptCacheKeepalive(): void {
    this.clearPromptCacheKeepaliveTimer();
    if (
      !this.refreshPromptCacheFn ||
      this.promptCacheKeepaliveLeases.size === 0 ||
      this._state.type === "terminated"
    ) {
      return;
    }

    const inactivityMs = this.resolvePromptCacheKeepaliveInactivityMs();
    if (inactivityMs === null) {
      return;
    }

    const now = Date.now();
    const dueInMs = this.getPromptCacheKeepaliveDueInMs(now, inactivityMs);
    const timer = setTimeout(
      () => {
        this.promptCacheKeepaliveTimer = null;
        void this.runPromptCacheKeepalive();
      },
      Math.max(PROMPT_CACHE_KEEPALIVE_MIN_DELAY_MS, dueInMs),
    );
    timer.unref?.();
    this.promptCacheKeepaliveTimer = timer;
  }

  private getPromptCacheKeepaliveDueInMs(
    now: number,
    inactivityMs: number,
  ): number {
    if (this._state.type !== "idle" || this.queueDepth > 0) {
      return PROMPT_CACHE_KEEPALIVE_RECHECK_MS;
    }
    if (this.isProcessAlive === false) {
      return PROMPT_CACHE_KEEPALIVE_RECHECK_MS;
    }

    const liveness = this.getLivenessSnapshot(new Date(now));
    if (liveness.derivedStatus !== "verified-idle") {
      return PROMPT_CACHE_KEEPALIVE_RECHECK_MS;
    }

    const candidates = [
      this._state.since.getTime(),
      this.lastPromptCacheKeepaliveAt?.getTime() ?? null,
      parseIsoMs(liveness.lastProviderMessageAt),
      parseIsoMs(liveness.lastRawProviderEventAt),
    ].filter((value): value is number => value !== null);
    const anchorMs =
      candidates.length > 0
        ? Math.max(...candidates)
        : this.startedAt.getTime();
    return Math.max(0, anchorMs + inactivityMs - now);
  }

  private async runPromptCacheKeepalive(): Promise<void> {
    if (this.promptCacheKeepaliveInFlight) {
      this.schedulePromptCacheKeepalive();
      return;
    }
    const inactivityMs = this.resolvePromptCacheKeepaliveInactivityMs();
    if (
      !this.refreshPromptCacheFn ||
      inactivityMs === null ||
      this.promptCacheKeepaliveLeases.size === 0
    ) {
      return;
    }

    const now = Date.now();
    if (this.getPromptCacheKeepaliveDueInMs(now, inactivityMs) > 0) {
      this.schedulePromptCacheKeepalive();
      return;
    }

    const log = getLogger();
    this.promptCacheKeepaliveInFlight = true;
    try {
      const result = await this.refreshPromptCacheFn({
        sessionId: this._sessionId,
      });
      if (result.refreshed) {
        this.lastPromptCacheKeepaliveAt = new Date();
        log.info(
          {
            event: "prompt_cache_keepalive_refreshed",
            sessionId: this._sessionId,
            processId: this.id,
            projectId: this.projectId,
            provider: this.provider,
            mode: result.mode,
            inactivityMinutes: Math.round(inactivityMs / 60_000),
            usage: result.usage,
          },
          `Prompt-cache keepalive refreshed: ${this._sessionId}`,
        );
      } else {
        log.warn(
          {
            event: "prompt_cache_keepalive_noop",
            sessionId: this._sessionId,
            processId: this.id,
            projectId: this.projectId,
            provider: this.provider,
            mode: result.mode,
            detail: result.detail,
          },
          `Prompt-cache keepalive did not refresh: ${this._sessionId}`,
        );
      }
    } catch (error) {
      log.warn(
        {
          event: "prompt_cache_keepalive_failed",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          provider: this.provider,
          error: error instanceof Error ? error.message : String(error),
        },
        `Prompt-cache keepalive failed: ${this._sessionId}`,
      );
    } finally {
      this.promptCacheKeepaliveInFlight = false;
      this.schedulePromptCacheKeepalive();
    }
  }

  private recordWakeReason(
    reason: SessionWakeReason,
    message?: SDKMessage,
    at = new Date(),
  ): void {
    this.lastWakeReason = {
      at: at.toISOString(),
      fromState: this._state.type,
      reason,
      ...(message ? { messageType: message.type } : {}),
      ...(message && getSdkMessageSubtype(message)
        ? { messageSubtype: getSdkMessageSubtype(message) }
        : {}),
    };
  }

  private transitionToInTurnForWake(
    reason: SessionWakeReason,
    message?: SDKMessage,
    at?: Date,
  ): void {
    if (this._state.type === "in-turn") {
      return;
    }
    this.recordWakeReason(reason, message, at);
    this.clearIdleTimer();
    this.setState({ type: "in-turn" });
  }

  private promoteIdleForProviderWork(
    message: SDKMessage,
    receivedAt: Date,
  ): void {
    if (this._state.type !== "idle" || !isProviderWorkWakeMessage(message)) {
      return;
    }
    this.transitionToInTurnForWake(
      "provider-message-after-idle",
      message,
      receivedAt,
    );
  }

  private toLivenessState(): LivenessProcessState {
    switch (this._state.type) {
      case "waiting-input":
        return { type: "waiting-input" };
      case "terminated":
        return { type: "terminated", reason: this._state.reason };
      default:
        return this._state;
    }
  }

  async probeLiveness(): Promise<LivenessProbeResult | null> {
    if (!this.probeLivenessFn) {
      return null;
    }
    if (this._livenessProbeInFlight) {
      return await this._livenessProbeInFlight;
    }

    this._livenessProbeInFlight = this.runLivenessProbe();
    try {
      return await this._livenessProbeInFlight;
    } finally {
      this._livenessProbeInFlight = null;
    }
  }

  private async runLivenessProbe(): Promise<LivenessProbeResult> {
    const checkedAt = new Date();
    let result: ProviderLivenessProbeResult;
    try {
      if (!this.probeLivenessFn) {
        result = {
          status: "unavailable",
          source: "process",
          detail: "No provider liveness probe is available",
          checkedAt,
        };
      } else {
        result = await this.probeLivenessFn();
      }
    } catch (error) {
      result = {
        status: "error",
        source: `${this.provider}:probe`,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }

    const record: LivenessProbeResult = {
      checkedAt: result.checkedAt ?? checkedAt,
      status: result.status,
      source: result.source,
      ...(result.detail ? { detail: result.detail } : {}),
    };
    this._lastLivenessProbe = record;
    this.emit({ type: "liveness-update" });
    return record;
  }

  get permissionMode(): PermissionMode {
    return this._permissionMode;
  }

  get permissions(): PermissionRules | undefined {
    return this._permissions;
  }

  get modeVersion(): number {
    return this._modeVersion;
  }

  /**
   * Thinking configuration for this process.
   * undefined means thinking is disabled.
   */
  get thinking(): ThinkingConfig | undefined {
    return this._thinking;
  }

  /**
   * Effort level for this process.
   */
  get effort(): EffortLevel | undefined {
    return this._effort;
  }

  /**
   * Update thinking config and effort after a dynamic change.
   */
  updateThinkingConfig(thinking?: ThinkingConfig, effort?: EffortLevel): void {
    this._thinking = thinking;
    this._effort = effort;
  }

  /**
   * Whether this process supports dynamic thinking mode changes.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsThinkingModeChange(): boolean {
    return this.setMaxThinkingTokensFn !== null;
  }

  /**
   * Whether this process supports graceful interrupt.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsInterrupt(): boolean {
    return this.interruptFn !== null;
  }

  /**
   * Interrupt the current turn gracefully without killing the process.
   * The query will stop processing the current turn and return control.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns true if the interrupt was triggered, false if not supported
   */
  async interrupt(options?: {
    extraMessages?: UserMessage[];
    preamble?: string;
  }): Promise<boolean> {
    if (!this.interruptFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "process_interrupt",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        currentState: this._state.type,
      },
      `Interrupting process: ${this._sessionId}`,
    );

    const interrupted = await this.interruptFn();

    // After interrupt, drain all queued messages (direct + deferred) and deliver
    // as a single concatenated batch with the interrupt preamble so the agent
    // knows to treat prior work as resumable.
    if (interrupted !== false && this.messageQueue) {
      const directDrained = this.messageQueue.drain();
      const deferredDrained = this.deferredQueue.map((e) => e.message);
      this.deferredQueue = [];
      this.emitDeferredQueueChange("promoted");

      const all = [
        ...directDrained,
        ...deferredDrained,
        ...(options?.extraMessages ?? []),
      ];
      if (all.length > 0) {
        const combined = this.concatMessages(all, {
          interrupted: true,
          preamble: options?.preamble,
        });
        this.queueMessage(combined, { allowSteer: false });
      }
    }

    return interrupted !== false;
  }

  /**
   * Change thinking mode at runtime via the deprecated setMaxThinkingTokens API.
   * On Opus 4.6+, 0 = disabled, any non-zero = adaptive.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @param tokens - Non-zero to enable adaptive thinking, undefined/0 to disable
   * @returns true if the change was applied, false if not supported
   */
  async setMaxThinkingTokens(tokens: number | undefined): Promise<boolean> {
    if (!this.setMaxThinkingTokensFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "thinking_mode_change",
        sessionId: this._sessionId,
        processId: this.id,
        oldThinking: this._thinking?.type,
        newThinking: tokens ? "adaptive" : "disabled",
      },
      `Changing thinking mode: ${this._thinking?.type ?? "disabled"} → ${tokens ? "adaptive" : "disabled"}`,
    );

    // SDK uses null to disable, we use undefined for consistency with our types
    await this.setMaxThinkingTokensFn(tokens ?? null);
    return true;
  }

  /**
   * Whether this process supports dynamic model listing.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsDynamicModels(): boolean {
    return this.supportedModelsFn !== null;
  }

  /**
   * Whether this process supports dynamic command listing.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsDynamicCommands(): boolean {
    return this.supportedCommandsFn !== null;
  }

  /**
   * Dispatch a provider-native slash command out-of-band (e.g. Codex `/compact`
   * → `thread/compact/start`) instead of delivering it as a user turn. Returns
   * `{ handled: false }` when the provider does not own the command — including
   * every provider that does not implement native dispatch (Claude, etc.) — so
   * the caller can fall back to normal message delivery.
   */
  async runProviderCommand(
    command: string,
    argument?: string,
  ): Promise<ProviderCommandResult> {
    if (!this.runProviderCommandFn) {
      return { handled: false };
    }
    return this.runProviderCommandFn(command, argument);
  }

  /**
   * Whether this process supports model switching mid-session.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsSetModel(): boolean {
    return this.setModelFn !== null;
  }

  /**
   * Get the list of available models from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns Array of available models, or null if not supported
   */
  async supportedModels(): Promise<ModelInfo[] | null> {
    if (!this.supportedModelsFn) {
      return null;
    }
    return this.supportedModelsFn();
  }

  /**
   * Get the list of available slash commands from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns Array of available commands, or null if not supported
   */
  async supportedCommands(): Promise<SlashCommand[] | null> {
    if (!this.supportedCommandsFn) {
      return null;
    }
    return this.primeSupportedCommands();
  }

  async primeSupportedCommands(): Promise<SlashCommand[] | null> {
    if (!this.supportedCommandsFn) {
      return null;
    }
    if (this.supportedCommandsRefreshInFlight) {
      return this.supportedCommandsRefreshInFlight;
    }

    const refresh = this.supportedCommandsFn()
      .then((commands) => {
        this.supportedCommandsCache = commands;
        return commands;
      })
      .finally(() => {
        if (this.supportedCommandsRefreshInFlight === refresh) {
          this.supportedCommandsRefreshInFlight = null;
        }
      });
    this.supportedCommandsRefreshInFlight = refresh;
    return refresh;
  }

  async primeSupportedCommandsForMessage(message: UserMessage): Promise<void> {
    if (!isSlashCommandSubmission(message.text)) {
      return;
    }
    await this.primeSupportedCommands();
  }

  /**
   * Change the model mid-session without restarting.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @param model - New model to use, or undefined to use default
   * @returns true if the change was applied, false if not supported
   */
  async setModel(model?: string): Promise<boolean> {
    if (!this.setModelFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "model_change",
        sessionId: this._sessionId,
        processId: this.id,
        oldModel: this.model,
        newModel: model,
      },
      `Changing model: ${this.model} → ${model}`,
    );

    await this.setModelFn(model);
    // Update resolved model so subsequent API responses reflect the switch
    if (model) {
      this._resolvedModel = model;
      // Follow the switch for per-model-settings keying (readonly `model` stays
      // at the original launch alias). See topics/provider-abstraction.md.
      this._requestedModel = model;
    }
    return true;
  }

  /**
   * Whether the process has been terminated (either manually or due to error).
   * A terminated process cannot accept new messages.
   */
  get isTerminated(): boolean {
    return this._state.type === "terminated";
  }

  /**
   * Get the termination reason if the process was terminated.
   */
  get terminationReason(): string | null {
    if (this._state.type === "terminated") {
      return this._state.reason;
    }
    return null;
  }

  /**
   * Update the permission mode for this process.
   * Increments modeVersion and emits a mode-change event for multi-tab sync.
   */
  setPermissionMode(mode: PermissionMode): void {
    this._permissionMode = mode;
    this._modeVersion++;
    this.emit({ type: "mode-change", mode, version: this._modeVersion });
  }

  /**
   * Mark the process as terminated due to an error or external termination.
   * Emits a terminated event and cleans up resources.
   */
  private markTerminated(reason: string, error?: Error): void {
    if (this._state.type === "terminated") {
      return; // Already terminated
    }

    const log = getLogger();
    const durationMs = Date.now() - this.startedAt.getTime();
    const pendingApprovalCount = this.pendingToolApprovals.size;

    log.warn(
      {
        event: "process_terminated",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        reason,
        errorMessage: error?.message,
        errorStack: error?.stack,
        durationMs,
        pendingApprovalCount,
        previousState: this._state.type,
      },
      `Process terminated: ${this._sessionId} - ${reason}`,
    );

    this.clearIdleTimer();
    this.clearPromptCacheKeepaliveTimer();
    this.stopBucketSwapTimer();
    this.iteratorDone = true;

    // Resolve all pending tool approvals with denial
    for (const pending of this.pendingToolApprovals.values()) {
      pending.resolve({
        behavior: "deny",
        message: `Process terminated: ${reason}`,
        interrupt: true,
      });
    }
    this.pendingToolApprovals.clear();
    this.pendingToolApprovalQueue = [];

    this.setState({ type: "terminated", reason, error });
    this.emit({ type: "terminated", reason, error });
    this.emit({ type: "complete" });

    // Resolve exit promise so abort() callers can wait for full termination
    if (this._exitResolve) {
      this._exitResolve();
      this._exitResolve = null;
    }
  }

  /**
   * Wait for the real session ID from the SDK's init message.
   * Returns immediately if already received, or waits with a timeout.
   */
  waitForSessionId(timeoutMs = 5000): Promise<string> {
    if (this.sessionIdResolved) {
      return Promise.resolve(this._sessionId);
    }

    return new Promise((resolve) => {
      this.sessionIdResolvers.push(resolve);

      // Timeout fallback - resolve with current ID even if not updated
      setTimeout(() => {
        const index = this.sessionIdResolvers.indexOf(resolve);
        if (index >= 0) {
          this.sessionIdResolvers.splice(index, 1);
          resolve(this._sessionId);
        }
      }, timeoutMs);
    });
  }

  getInfo(): ProcessInfo {
    let activity: AgentActivity;
    if (this._state.type === "terminated") {
      activity = "terminated";
    } else if (this._state.type === "waiting-input") {
      activity = "waiting-input";
    } else if (this._state.type === "idle") {
      activity = "idle";
    } else {
      activity = "in-turn";
    }

    const info: ProcessInfo = {
      id: this.id,
      sessionId: this._sessionId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      projectName: getProjectName(this.projectPath),
      sessionTitle: null, // Will be populated by Supervisor with session data
      state: activity,
      startedAt: this.startedAt.toISOString(),
      queueDepth: this.queueDepth,
      provider: this.provider,
      model: this._resolvedModel ?? this.model,
      // The requested YA launch alias (e.g. "opus"), distinct from the reported
      // model above. Keys per-model settings; the route enrichment fills the
      // persisted/helper fallback when this is absent (non-YA-started sessions).
      requestedModel: this.requestedModel,
      serviceTier: this.serviceTier,
      thinking: this._thinking,
      effort: this._effort,
      executor: this.executor,
      pid: this.pid,
      liveness: this.getLivenessSnapshot(),
      recapMode: this._recapMode,
      promptSuggestionMode: this._promptSuggestionMode,
      helperSideModel: this._helperSideModel,
    };

    // Add idleSince if idle
    if (this._state.type === "idle") {
      info.idleSince = this._state.since.toISOString();
    }

    return info;
  }

  /**
   * Get recent message history (15-30 seconds) for SSE replay.
   * Returns messages from both buckets for late-joining clients.
   */
  getMessageHistory(): SDKMessage[] {
    return [...this.previousBucket, ...this.currentBucket];
  }

  /**
   * Get accumulated streaming text for catch-up when clients connect mid-stream.
   * Returns the message ID and accumulated text, or null if not streaming.
   */
  getStreamingContent(): { messageId: string; text: string } | null {
    if (!this._streamingMessageId || !this._streamingText) {
      return null;
    }
    return {
      messageId: this._streamingMessageId,
      text: this._streamingText,
    };
  }

  /**
   * Accumulate streaming text from a delta.
   * Called by stream routes when processing stream_event messages.
   */
  accumulateStreamingText(messageId: string, text: string): void {
    if (this._streamingMessageId !== messageId) {
      // New streaming message, reset accumulator
      this._streamingMessageId = messageId;
      this._streamingText = text;
    } else {
      this._streamingText += text;
    }
  }

  /**
   * Clear streaming text accumulator (called when stream ends).
   */
  clearStreamingText(): void {
    this._streamingText = "";
    this._streamingMessageId = null;
  }

  /**
   * Push the text of a completed assistant turn into the recap buffer.
   * Per-entry length is capped so a long single turn does not dominate the
   * buffer; total entries are bounded by RECENT_TEXT_MAX_ENTRIES. See
   * topics/recaps.md.
   */
  private pushRecentAssistantText(text: string, completedAtMs: number): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const capped =
      trimmed.length > Process.RECENT_TEXT_MAX_CHARS_PER_ENTRY
        ? `${trimmed.slice(0, Process.RECENT_TEXT_MAX_CHARS_PER_ENTRY)} …[truncated]`
        : trimmed;
    this.recentAssistantRecapEntries.push({ completedAtMs, text: capped });
    while (
      this.recentAssistantRecapEntries.length > Process.RECENT_TEXT_MAX_ENTRIES
    ) {
      this.recentAssistantRecapEntries.shift();
    }
  }

  /**
   * Snapshot of recent assistant text used as context for a recap.
   */
  getRecentAssistantText(sinceMs?: number | null): string[] {
    return this.recentAssistantRecapEntries
      .filter(
        (entry) =>
          sinceMs === null ||
          sinceMs === undefined ||
          entry.completedAtMs > sinceMs,
      )
      .map((entry) => entry.text);
  }

  /**
   * Emit a synthetic system message (no provider involvement) into the
   * session's broadcast stream. Used for YA-side recaps so they reach SSE
   * subscribers via the same path as provider-emitted messages, without
   * touching the underlying JSONL transcript.
   */
  emitSyntheticSystemMessage(subtype: string, content: string): void {
    const synthetic = this.withTimestamp({
      type: "system",
      subtype,
      content,
      session_id: this._sessionId,
      uuid: randomUUID(),
      isMeta: false,
    } as unknown as SDKMessage);
    this.currentBucket.push(synthetic);
    this.emit({ type: "message", message: synthetic });
  }

  /**
   * Run a server-side recap of recent assistant activity and emit the
   * result as a synthetic `away_summary` system message. The provider is
   * looked up by the caller (Supervisor) and passed in to keep Process
   * free of provider-registry imports. See topics/recaps.md.
   *
   * Returns shape:
   *  - `supported: false` — provider does not implement recaps.
   *  - `supported: true, emitted: false` — supported but suppressed
   *    (no recent activity, already in-flight, etc.).
   *  - `supported: true, emitted: true` — recap was generated and emitted.
   */
  async requestRecap(
    provider: AgentProvider,
    options?: { sinceMs?: number | null },
  ): Promise<{ supported: boolean; emitted: boolean; reason?: string }> {
    if (this._recapMode === "off") {
      return {
        supported: true,
        emitted: false,
        reason: "recaps disabled for this session",
      };
    }
    if (this._recapMode === "native") {
      if (!provider.supportsNativeRecaps) {
        return {
          supported: false,
          emitted: false,
          reason: "provider does not support native recaps",
        };
      }
      return {
        supported: true,
        emitted: false,
        reason: "native recaps are provider-owned",
      };
    }
    if (!provider.supportsRecaps || !provider.generateRecap) {
      return {
        supported: false,
        emitted: false,
        reason: "provider does not support recaps",
      };
    }
    if (this.recapInFlight) {
      return {
        supported: true,
        emitted: false,
        reason: "recap already in flight",
      };
    }
    const sinceMs = options?.sinceMs ?? null;
    if (this._state.type === "in-turn") {
      this.pendingRecapRequest = { provider, sinceMs };
      return {
        supported: true,
        emitted: false,
        reason: "recap deferred until turn completes",
      };
    }

    return this.generateAndEmitRecap(provider, sinceMs);
  }

  private async generateAndEmitRecap(
    provider: AgentProvider,
    sinceMs: number | null,
  ): Promise<{ supported: boolean; emitted: boolean; reason?: string }> {
    if (!provider.supportsRecaps || !provider.generateRecap) {
      return {
        supported: false,
        emitted: false,
        reason: "provider does not support recaps",
      };
    }

    const recent = this.getRecentAssistantText(sinceMs);
    if (recent.length === 0) {
      return {
        supported: true,
        emitted: false,
        reason: "no recent assistant activity to summarize",
      };
    }

    this.recapInFlight = true;
    try {
      const text = (
        await provider.generateRecap(recent, {
          model: this.resolveHelperSideModel(),
        })
      ).trim();
      if (!text) {
        return {
          supported: true,
          emitted: false,
          reason: "provider returned empty recap",
        };
      }
      this.emitSyntheticSystemMessage("away_summary", text);
      return { supported: true, emitted: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const log = getLogger();
      log.warn(
        {
          event: "session_recap_failed",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          error: reason,
        },
        `Recap generation failed: ${reason}`,
      );
      return { supported: true, emitted: false, reason };
    } finally {
      this.recapInFlight = false;
    }
  }

  private resolveHelperSideModel(): string | undefined {
    if (this._helperSideModel === HELPER_SIDE_MODEL_CHEAPEST) {
      return HELPER_SIDE_MODEL_CHEAPEST;
    }
    if (this._helperSideModel === HELPER_SIDE_MODEL_SAME_AS_MAIN) {
      return this._resolvedModel ?? this.model;
    }
    return this._helperSideModel || undefined;
  }

  /**
   * Ensure every emitted/replayed message has a timestamp.
   * Some providers (notably Codex stream messages) omit this field.
   */
  private withTimestamp<T extends SDKMessage>(
    message: T,
  ): TimestampedSDKMessage<T> {
    if (
      typeof message.timestamp === "string" &&
      message.timestamp.trim().length > 0
    ) {
      return message as TimestampedSDKMessage<T>;
    }
    return {
      ...message,
      timestamp: new Date().toISOString(),
    } as TimestampedSDKMessage<T>;
  }

  /**
   * Add initial user message to history without queuing to SDK.
   * Used for real SDK sessions where the initial message is passed directly
   * to the SDK but needs to be in history for SSE replay to late-joining clients.
   *
   * @param message - The user message, including attachments for replay
   * @param uuid - The UUID to use (should match what was passed to SDK)
   * @param tempId - Optional client temp ID for optimistic UI tracking
   */
  addInitialUserMessage(
    message: UserMessage,
    uuid: string,
    tempId?: string,
  ): void {
    const sdkMessage = this.withTimestamp({
      type: "user",
      uuid,
      tempId,
      messageMetadata: message.metadata,
      message: { role: "user", content: this.buildUserMessageContent(message) },
    } as SDKMessage);

    this.currentBucket.push(sdkMessage);
    this.emit({ type: "message", message: sdkMessage });
  }

  /**
   * Format file size for display.
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}\u202fb`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
    if (bytes < 1024 * 1024 * 1024)
      return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
    return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
  }

  private formatUploadedFileReference(file: {
    originalName: string;
    size: number;
    mimeType: string;
    path: string;
    width?: number;
    height?: number;
  }): string {
    const dimensions =
      file.width && file.height ? `, ${file.width}x${file.height}` : "";
    return `- [${file.originalName.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${file.path}>) (${this.formatSize(file.size)}, ${file.mimeType}${dimensions})`;
  }

  /**
   * Build user message content that matches what MessageQueue sends to the SDK.
   * This ensures SSE/history messages can be deduplicated against JSONL.
   */
  private buildUserMessageContent(message: UserMessage): string {
    let text = message.text;

    // Append attachment paths (same format as MessageQueue.toSDKMessage)
    if (message.attachments?.length) {
      const lines = message.attachments.map((file) =>
        this.formatUploadedFileReference(file),
      );
      text += `\n\nUser uploaded files in .attachments:\n${lines.join("\n")}`;
    }

    return text;
  }

  /**
   * Concatenate multiple UserMessages into one, joined by `--------` separators.
   * Used by interrupt to deliver all queued messages as a single batch.
   */
  private concatMessages(
    messages: UserMessage[],
    options?: { interrupted?: boolean; preamble?: string },
  ): UserMessage {
    return concatUserMessages(
      messages,
      options?.preamble ??
        (options?.interrupted ? INTERRUPT_PREAMBLE : undefined),
    );
  }

  private expandEmulatedSlashCommand(message: UserMessage): UserMessage {
    return expandSlashCommandEmulation(message, this.supportedCommandsCache, {
      unknownCommandPrefix: getCodexSkillCommandPrefix(this.provider),
      nativeCommandNames: getKnownNativeSlashCommands(this.provider),
    });
  }

  /**
   * Prefix a delivered message with a compose-time context anchor (e.g.
   * `(45s ago)`). Applied after slash-command expansion so a queued `/command`
   * is still detected; the anchor rides ahead of the expanded provider text and
   * the matching echo. No-op when `anchor` is absent — including always, by
   * default, since anchors are opt-in (YEP_COMPOSE_ANCHORS=1).
   */
  private applyComposeAnchor(
    message: UserMessage,
    anchor?: string | null,
  ): UserMessage {
    if (!anchor) return message;
    return { ...message, text: `${anchor}\n\n${message.text}` };
  }

  private prepareProviderMessage(
    message: UserMessage,
    composeAnchor?: string | null,
  ): UserMessage {
    return this.withProviderDeliveryPriority(
      this.applyComposeAnchor(
        this.expandEmulatedSlashCommand(message),
        composeAnchor,
      ),
    );
  }

  private withProviderDeliveryPriority(message: UserMessage): UserMessage {
    if (this.provider !== "claude" && this.provider !== "claude-ollama") {
      return message;
    }

    const deliveryIntent = message.metadata?.deliveryIntent;
    if (deliveryIntent === "steer") {
      return {
        ...message,
        priority: message.metadata?.steerNow ? "now" : "next",
      };
    }
    if (deliveryIntent === "deferred" || deliveryIntent === "patient") {
      return { ...message, priority: "later" };
    }
    return message;
  }

  /**
   * Queue already-expanded provider text. The emitted user echo and the SDK
   * queue entry must be the same logical turn so live SSE and later transcript
   * catch-up deduplicate cleanly.
   */
  private queuePreparedMessage(
    providerMessage: UserMessage,
    options?: { allowSteer?: boolean },
  ): {
    success: boolean;
    position?: number;
    error?: string;
  } {
    // Check if process is terminated or transport failed
    if (this._state.type === "terminated") {
      return {
        success: false,
        error: `Process terminated: ${this._state.reason}`,
      };
    }

    // Check if transport failed (spawn error, etc.) - this flag is set synchronously
    // to prevent race conditions where queueMessage is called before markTerminated completes
    if (this.transportFailed) {
      return {
        success: false,
        error: "Process transport failed",
      };
    }

    // Create user message with UUID - this UUID will be used by both SSE and SDK
    const uuid = providerMessage.uuid ?? randomUUID();
    const messageWithUuid: UserMessage = { ...providerMessage, uuid };

    // Build content that matches what the SDK will write to JSONL.
    // This ensures SSE/history messages can be deduplicated against JSONL.
    const content = this.buildUserMessageContent(providerMessage);

    const sdkMessage = this.withTimestamp({
      type: "user",
      uuid,
      tempId: providerMessage.tempId,
      // Carry every bundled chunk id so the client clears all delivered queued
      // chips by identity (a merged turn keeps only first.tempId otherwise).
      ...(providerMessage.tempIds?.length
        ? { tempIds: providerMessage.tempIds }
        : {}),
      messageMetadata: providerMessage.metadata,
      message: { role: "user", content },
    } as SDKMessage);

    // YA-injected control messages (e.g. the `/compact` we queue for
    // compaction) carry no user echo — native auto-compaction shows none.
    const hidden = isHiddenInjectedMessage(providerMessage);

    // Add to history for SSE replay to late-joining clients.
    // The client-side deduplication (mergeSSEMessage, mergeJSONLMessages) handles
    // any duplicates when JSONL is later fetched. This is especially important
    // for the two-phase flow (createSession + queueMessage) where the client
    // may connect before the JSONL is written.
    if (!hidden && shouldEmitMessage(sdkMessage)) {
      // Check for duplicates in both buckets before adding
      // This prevents duplicates if the provider echoes the message back with the same UUID
      const isDuplicate =
        this.currentBucket.some((m) => m.uuid && m.uuid === sdkMessage.uuid) ||
        this.previousBucket.some((m) => m.uuid && m.uuid === sdkMessage.uuid);
      if (!isDuplicate) {
        this.currentBucket.push(sdkMessage);
      }
    }

    // Emit to current SSE subscribers so other clients see it immediately
    // Include the session ID so client can associate it correctly
    // The provider will echo this message back, but if we ensure UUIDs match,
    // the client will merge them.
    if (!hidden && shouldEmitMessage(sdkMessage)) {
      this.emit({
        type: "message",
        message: { ...sdkMessage, session_id: this._sessionId },
      });
    }

    if (this.messageQueue) {
      // If provider supports in-turn steering, prefer that over queue-after-turn behavior.
      if (
        this._state.type === "in-turn" &&
        this.steerFn &&
        options?.allowSteer !== false
      ) {
        const steerMessage: UserMessage = {
          ...messageWithUuid,
          // Mirror MessageQueue's attachment expansion for steer payloads.
          text: content,
          attachments: undefined,
        };
        void this.steerFn(steerMessage)
          .then((steered) => {
            if (!steered) {
              this.messageQueue?.push(messageWithUuid);
            }
          })
          .catch((error) => {
            const log = getLogger();
            log.warn(
              {
                event: "process_steer_failed",
                sessionId: this._sessionId,
                processId: this.id,
                provider: this.provider,
                error: error instanceof Error ? error.message : String(error),
              },
              "Steer failed; falling back to queued message",
            );
            this.messageQueue?.push(messageWithUuid);
          });
        return { success: true, position: 0 };
      }

      // Transition to running if we were idle
      if (this._state.type === "idle") {
        this.transitionToInTurnForWake("user-message");
      }
      // Pass message with UUID so SDK uses the same UUID we emitted via SSE
      const position = this.messageQueue.push(messageWithUuid);
      return { success: true, position };
    }

    // Legacy behavior for mock SDK
    this.legacyQueue.push(providerMessage);
    if (this._state.type === "idle") {
      this.processNextInQueue();
    }
    return { success: true, position: this.legacyQueue.length };
  }

  /**
   * Queue a message to be sent to the SDK.
   * For real SDK, pushes to MessageQueue.
   * For mock SDK, uses legacy queue behavior.
   *
   * @returns Object with success status and queue position or error
   */
  queueMessage(
    message: UserMessage,
    options?: { allowSteer?: boolean; composeAnchor?: string | null },
  ): {
    success: boolean;
    position?: number;
    error?: string;
  } {
    return this.queuePreparedMessage(
      this.prepareProviderMessage(message, options?.composeAnchor),
      { allowSteer: options?.allowSteer },
    );
  }

  /**
   * Add a message to the deferred queue.
   * Deferred messages are held server-side and auto-sent when the agent reaches
   * a safe delivery boundary. Idle processes can accept the message
   * immediately; active turns keep the message editable until a later boundary
   * such as a completed tool call or turn completion.
   */
  deferMessage(
    message: UserMessage,
    options?: {
      promoteIfReady?: boolean;
    },
  ): {
    success: boolean;
    deferred: boolean;
    promoted?: boolean;
    position?: number;
    error?: string;
  } {
    const canPromoteIfReady = !!(
      options?.promoteIfReady &&
      this.messageQueue &&
      // Only a "real" patient entry (Claude) waits for the verified-idle path;
      // elsewhere a patient-tagged message is an ordinary deferred one and
      // promotes immediately like any other deferred turn.
      !isPatientDeferredEntry(
        { message, timestamp: new Date().toISOString() },
        this.provider,
      ) &&
      this._state.type === "idle"
    );
    if (canPromoteIfReady) {
      const result = this.queueMessage(message);
      if (!result.success) {
        return {
          deferred: false,
          success: false,
          error: result.error ?? "Failed to queue message",
        };
      }
      this.emitDeferredQueueChange("promoted", message.tempId);
      return {
        success: true,
        deferred: false,
        promoted: true,
        position: result.position,
      };
    }

    this.deferredQueue.push({
      message,
      timestamp: new Date().toISOString(),
    });
    this.emitDeferredQueueChange("queued", message.tempId);
    return { success: true, deferred: true };
  }

  /**
   * Cancel a deferred message by its tempId.
   */
  cancelDeferredMessage(tempId: string): boolean {
    const index = this.deferredQueue.findIndex(
      (entry) => entry.message.tempId === tempId,
    );
    if (index === -1) return false;
    this.deferredQueue.splice(index, 1);
    this.emitDeferredQueueChange("cancelled", tempId);
    return true;
  }

  /**
   * Get a summary of the deferred queue for SSE events and client sync.
   */
  getDeferredQueueSummary(): {
    tempId?: string;
    content: string;
    timestamp: string;
    attachments?: UserMessage["attachments"];
    attachmentCount?: number;
    metadata?: UserMessage["metadata"];
  }[] {
    return this.deferredQueue.map((entry) => {
      const attachmentCount =
        (entry.message.attachments?.length ?? 0) +
        (entry.message.images?.length ?? 0) +
        (entry.message.documents?.length ?? 0);

      return {
        tempId: entry.message.tempId,
        content: entry.message.text,
        timestamp: entry.timestamp,
        ...(entry.message.metadata ? { metadata: entry.message.metadata } : {}),
        ...(entry.message.attachments?.length
          ? { attachments: entry.message.attachments }
          : {}),
        ...(attachmentCount > 0 ? { attachmentCount } : {}),
      };
    });
  }

  /**
   * Remove all deferred messages so they can be handed to a replacement
   * process after this process is hard-aborted.
   */
  drainDeferredMessages(
    reason: "cancelled" | "promoted" = "promoted",
  ): UserMessage[] {
    if (this.deferredQueue.length === 0) {
      return [];
    }

    const drained = this.deferredQueue.map((entry) => entry.message);
    const firstTempId = drained[0]?.tempId;
    this.deferredQueue = [];
    this.emitDeferredQueueChange(reason, firstTempId);
    return drained;
  }

  /**
   * Remove user messages that YA accepted but the provider has not processed.
   * This includes messages in the direct provider queue as well as editable
   * deferred messages.
   */
  drainPendingUserMessages(
    reason: "cancelled" | "promoted" = "promoted",
  ): UserMessage[] {
    const queuedMessages = this.messageQueue?.drain() ?? [];
    return [...queuedMessages, ...this.drainDeferredMessages(reason)];
  }

  /**
   * Emit a deferred-queue event with the current queue state.
   */
  private emitDeferredQueueChange(
    reason?: "queued" | "cancelled" | "promoted",
    tempId?: string,
  ): void {
    this.emit({
      type: "deferred-queue",
      messages: this.getDeferredQueueSummary(),
      reason,
      tempId,
    });
  }

  /**
   * Convert a simple glob pattern (with * wildcards) to a RegExp.
   * Only supports * as wildcard (matches any characters).
   */
  private static globToRegex(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`);
  }

  /**
   * Check if a tool invocation matches a permission pattern like "Bash(curl *)".
   * Returns true if the pattern matches the tool name and input.
   */
  private static matchesPermissionPattern(
    pattern: string,
    toolName: string,
    input: unknown,
  ): boolean {
    // Parse "ToolName(glob)" pattern
    const match = pattern.match(/^(\w+)\((.+)\)$/);
    if (!match) return false;
    const patternTool = match[1];
    const glob = match[2];
    if (!patternTool || !glob || patternTool !== toolName) return false;

    // Extract the string to match against from the tool input
    let commandStr = "";
    if (toolName === "Bash") {
      commandStr = (input as { command?: string })?.command ?? "";
    } else {
      // For non-Bash tools, match against JSON-stringified input
      commandStr = typeof input === "string" ? input : JSON.stringify(input);
    }

    return Process.globToRegex(glob).test(commandStr);
  }

  /**
   * Check permission rules (deny/allow patterns) against a tool invocation.
   * Returns a ToolApprovalResult if a rule matches, or undefined to fall through.
   * Evaluation order: deny first, then allow.
   */
  private checkPermissionRules(
    toolName: string,
    input: unknown,
  ): ToolApprovalResult | undefined {
    if (!this._permissions) return undefined;

    // Check deny rules first
    if (this._permissions.deny) {
      for (const pattern of this._permissions.deny) {
        if (Process.matchesPermissionPattern(pattern, toolName, input)) {
          const command =
            toolName === "Bash"
              ? ((input as { command?: string })?.command ?? "")
              : "";
          getLogger().warn(
            `[permissions] Denied ${toolName}: "${command}" matched deny pattern "${pattern}"`,
          );
          return {
            behavior: "deny",
            message: `Blocked by permission rule: ${pattern}`,
          };
        }
      }
    }

    // Check allow rules
    if (this._permissions.allow) {
      for (const pattern of this._permissions.allow) {
        if (Process.matchesPermissionPattern(pattern, toolName, input)) {
          return { behavior: "allow" };
        }
      }
    }

    return undefined;
  }

  /**
   * Handle tool approval request from SDK's canUseTool callback.
   * This is called by the Supervisor when creating the session.
   * Behavior depends on current permission mode:
   * - default: Ask user for approval
   * - acceptEdits: Auto-approve Edit/Write tools, ask for others
   * - plan: Auto-approve read-only tools (Read, Glob, Grep, etc.), prompt for others
   * - bypassPermissions: Auto-approve all tools except AskUserQuestion and ExitPlanMode
   */
  async handleToolApproval(
    toolName: string,
    input: unknown,
    options: { signal: AbortSignal },
  ): Promise<ToolApprovalResult> {
    console.log(
      `[handleToolApproval] toolName=${toolName}, permissionMode=${this._permissionMode}`,
    );

    // Check if aborted
    if (options.signal.aborted) {
      return {
        behavior: "deny",
        message: "Operation aborted",
        interrupt: true,
      };
    }

    const isUserQuestion = isAskUserQuestionTool(toolName);

    // Provider-native interviews are user questions, not permission decisions.
    // Always surface them so allow/deny rules cannot silently answer them.
    if (!isUserQuestion) {
      // Check permission rules (deny/allow patterns) before mode-based logic
      const permissionResult = this.checkPermissionRules(toolName, input);
      if (permissionResult) {
        return permissionResult;
      }
    }

    // Handle based on permission mode
    switch (this._permissionMode) {
      case "bypassPermissions": {
        // Always prompt for user questions and plan approval, even in bypass mode
        // These are inherently interactive and shouldn't be auto-answered
        if (toolName === "ExitPlanMode" || isUserQuestion) {
          break; // Fall through to ask user
        }
        // Auto-approve all other tools
        return { behavior: "allow" };
      }

      case "plan": {
        // Read-only tools are auto-allowed - essential for creating good plans
        const readOnlyTools = [
          "Read",
          "Glob",
          "Grep",
          "LSP",
          "WebFetch",
          "WebSearch",
          "Task", // Subagent exploration (legacy)
          "Agent", // Subagent exploration (SDK 0.2.76+)
          "TaskOutput", // Reading subagent results
        ];
        if (readOnlyTools.includes(toolName)) {
          return { behavior: "allow" };
        }

        // Allow Write to .claude/plans/ directory for saving plans
        if (toolName === "Write") {
          const filePath = (input as { file_path?: string })?.file_path ?? "";
          if (filePath.includes(".claude/plans/")) {
            return { behavior: "allow" };
          }
        }

        // ExitPlanMode and AskUserQuestion should prompt the user
        // ExitPlanMode: user must approve the plan before exiting plan mode
        // AskUserQuestion: clarifying questions are valid during planning
        if (toolName === "ExitPlanMode" || isUserQuestion) {
          break; // Fall through to ask user for approval
        }

        // Other tools (Bash, Edit, Write to non-plan files, etc.) - prompt user
        // Agent typically won't use these in plan mode, but if they have a good
        // reason (e.g., checking git log, verifying dependencies), let them ask
        break; // Fall through to ask user for approval
      }

      case "acceptEdits": {
        // Auto-approve file editing tools AND read-only tools
        // acceptEdits should be strictly more permissive than default mode
        const editTools = ["Edit", "Write", "NotebookEdit"];
        if (editTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Read-only tools are also auto-allowed (same as default mode)
        const readOnlyTools = [
          "Read",
          "Glob",
          "Grep",
          "LSP",
          "WebFetch",
          "WebSearch",
          "Task", // Subagent exploration (legacy)
          "Agent", // Subagent exploration (SDK 0.2.76+)
          "TaskOutput", // Reading subagent results
        ];
        if (readOnlyTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Fall through to ask user for other tools (Bash, etc.)
        break;
      }

      default: {
        // Read-only tools are auto-allowed - no need to prompt for reads
        // "Ask before edits" means ask before WRITES, not reads
        const readOnlyTools = [
          "Read",
          "Glob",
          "Grep",
          "LSP",
          "WebFetch",
          "WebSearch",
          "Task", // Subagent exploration (legacy)
          "Agent", // Subagent exploration (SDK 0.2.76+)
          "TaskOutput", // Reading subagent results
        ];
        if (readOnlyTools.includes(toolName)) {
          return { behavior: "allow" };
        }
        // Fall through to ask user for mutating tools
        break;
      }
    }

    // Default behavior: ask user for approval or an interview answer.
    const request: InputRequest = {
      id: randomUUID(),
      sessionId: this._sessionId,
      type: isUserQuestion ? "question" : "tool-approval",
      prompt: isUserQuestion
        ? buildAskUserQuestionPrompt(input)
        : `Allow ${toolName}?`,
      toolName,
      toolInput: input,
      timestamp: new Date().toISOString(),
    };

    // Add to the pending approvals map and queue
    // The first pending approval is shown to the user, others wait in queue
    const isFirstPending = this.pendingToolApprovals.size === 0;

    // Create a promise that will be resolved by respondToInput
    return new Promise<ToolApprovalResult>((resolve) => {
      this.pendingToolApprovals.set(request.id, { request, resolve });
      this.pendingToolApprovalQueue.push(request.id);

      // Handle abort signal
      const onAbort = () => {
        if (this.pendingToolApprovals.has(request.id)) {
          this.pendingToolApprovals.delete(request.id);
          this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
            (id) => id !== request.id,
          );
          // If this was the current request being shown, emit the next one
          if (isFirstPending) {
            this.emitNextPendingApproval();
          }
          resolve({
            behavior: "deny",
            message: "Operation aborted",
            interrupt: true,
          });
        }
      };

      options.signal.addEventListener("abort", onAbort, { once: true });

      // Only emit state change for the first pending approval
      // Subsequent approvals wait in queue until the first is resolved
      if (isFirstPending) {
        this.setState({ type: "waiting-input", request });
      }
    });
  }

  /**
   * Emit the next pending approval to the client, or transition to running if none left.
   */
  private emitNextPendingApproval(): void {
    const nextId = this.pendingToolApprovalQueue[0];
    if (nextId !== undefined) {
      const next = this.pendingToolApprovals.get(nextId);
      if (next) {
        this.setState({ type: "waiting-input", request: next.request });
        return;
      }
    }
    // No more pending approvals
    this.transitionToInTurnForWake("tool-approval-resolved");
  }

  /**
   * Respond to a pending input request (tool approval).
   * Called from the API when user approves/denies a tool.
   * For AskUserQuestion, answers can be passed to update the tool input.
   * For deny with feedback, the feedback message is passed to the SDK.
   * Works for both real SDK (canUseTool callback) and mock SDK (input_request message).
   */
  respondToInput(
    requestId: string,
    response: "approve" | "deny",
    answers?: UserQuestionAnswers,
    feedback?: string,
  ): boolean {
    const pending = this.pendingToolApprovals.get(requestId);

    // For mock SDK: check if requestId matches the state's request
    if (!pending) {
      if (
        this._state.type === "waiting-input" &&
        this._state.request.id === requestId
      ) {
        // Mock SDK case - just transition back to idle/running
        this.transitionToInTurnForWake("tool-approval-resolved");
        return true;
      }
      return false;
    }

    // Build the result with optional updated input for AskUserQuestion.
    // If deny has feedback, use that as the message.
    const trimmedFeedback = feedback?.trim();
    const denyMessage = trimmedFeedback || "User denied permission";
    // If user just clicked "No" without feedback, set interrupt: true to stop retrying.
    // If user provided feedback, set interrupt: false so Claude can incorporate the guidance.
    const shouldInterrupt = response === "deny" && !trimmedFeedback;
    const result: ToolApprovalResult = {
      behavior: response === "approve" ? "allow" : "deny",
      message: response === "deny" ? denyMessage : undefined,
      interrupt: response === "deny" ? shouldInterrupt : undefined,
    };

    // If answers provided (AskUserQuestion), pass them as updatedInput
    if (answers && response === "approve") {
      const originalInput = pending.request.toolInput as {
        questions?: unknown[];
      };
      result.updatedInput = {
        ...originalInput,
        answers,
      };
    }

    // If EnterPlanMode is approved, switch to plan mode
    if (
      response === "approve" &&
      pending.request.toolName === "EnterPlanMode"
    ) {
      this.setPermissionMode("plan");
    }

    // If ExitPlanMode is approved, switch back to default mode
    if (response === "approve" && pending.request.toolName === "ExitPlanMode") {
      this.setPermissionMode("default");
    }

    // Resolve the promise and remove from tracking
    pending.resolve(result);
    this.pendingToolApprovals.delete(requestId);
    this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
      (id) => id !== requestId,
    );

    // Codex app-server decline decisions do not currently include a rejection
    // reason in-protocol. Queue the feedback as a follow-up user message.
    if (response === "deny" && trimmedFeedback && this.provider === "codex") {
      const queued = this.queueMessage({
        text: `I denied that request. Instead: ${trimmedFeedback}`,
      });
      if (!queued.success) {
        getLogger().warn(
          {
            sessionId: this._sessionId,
            processId: this.id,
            error: queued.error,
          },
          "Failed to queue Codex deny feedback follow-up message",
        );
      }
    }

    // Emit the next pending approval, or transition to running if none left
    this.emitNextPendingApproval();

    return true;
  }

  /**
   * Get the current pending input request (first in queue), if any.
   * Works for both real SDK (canUseTool callback) and mock SDK (input_request message).
   */
  getPendingInputRequest(): InputRequest | null {
    // Check real SDK pending approvals queue first
    const firstId = this.pendingToolApprovalQueue[0];
    if (firstId !== undefined) {
      return this.pendingToolApprovals.get(firstId)?.request ?? null;
    }
    // For mock SDK, check state directly
    if (this._state.type === "waiting-input") {
      return this._state.request;
    }
    return null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hasLiveDeltaSubscribers(): boolean {
    return this.liveDeltaSubscriberCount > 0;
  }

  registerLiveDeltaSubscriber(): () => void {
    this.liveDeltaSubscriberCount += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.liveDeltaSubscriberCount = Math.max(
        0,
        this.liveDeltaSubscriberCount - 1,
      );
    };
  }

  /**
   * Terminate the process with a reason (e.g., staleness detection).
   * Unlike abort(), this records the reason for logging/debugging.
   * Also calls abortFn to kill the underlying CLI process, preventing
   * orphaned processes that continue running after Yep stops tracking them.
   */
  terminate(reason: string): void {
    // Kill the underlying CLI process first (if available), so it doesn't
    // continue running as an orphan after we unregister from the Supervisor.
    if (this.abortFn) {
      this.abortFn();
    }
    this.markTerminated(reason);
  }

  async abort(): Promise<void> {
    this.clearIdleTimer();
    this.clearPromptCacheKeepaliveTimer();
    this.stopBucketSwapTimer();

    // Call the SDK's abort function if available
    if (this.abortFn) {
      this.abortFn();
    }

    // Wait for CLI process to fully exit (with timeout to avoid hanging)
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([this._exitPromise, timeout]);

    // Signal completion to subscribers (skip if already terminated —
    // markTerminated() already emitted "complete")
    if (this._state.type !== "terminated") {
      this.emit({ type: "complete" });
    }
    this.listeners.clear();
  }

  private async processMessages(): Promise<void> {
    try {
      while (!this.iteratorDone) {
        const result = await this.sdkIterator.next();

        if (result.done) {
          this.iteratorDone = true;
          // Don't transition to idle if we're waiting for input
          if (this._state.type !== "waiting-input") {
            this.transitionToIdle();
          }
          break;
        }

        const message = this.withTimestamp(result.value);
        const receivedAt = new Date();
        this._lastMessageTime = receivedAt;
        this._lastProviderMessageTime = receivedAt;

        // Store message in history for replay to late-joining clients.
        // Exclude stream_event messages - they're transient streaming deltas that
        // are redundant once the final assistant message arrives. Replaying them
        // causes flickering as the last message appears to stream in again.
        if (shouldEmitMessage(message) && message.type !== "stream_event") {
          // Check for duplicates before adding to history
          // This handles the case where queueMessage added the optimistic message
          // and now the provider is echoing it back with the same UUID
          const isDuplicate =
            message.type === "user" &&
            message.uuid &&
            (this.currentBucket.some((m) => m.uuid === message.uuid) ||
              this.previousBucket.some((m) => m.uuid === message.uuid));

          if (!isDuplicate) {
            this.currentBucket.push(message);
          }
        }

        // Capture assistant text for the recap buffer (topics/recaps.md).
        // Stream_event partials are skipped — we only want completed assistant
        // turns so the recap input is coherent.
        if (message.type === "assistant") {
          const text = extractMessageText(message);
          if (text) {
            this.pushRecentAssistantText(text, receivedAt.getTime());
          }
        }

        // Extract session ID from init message
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.session_id
        ) {
          const log = getLogger();
          const oldSessionId = this._sessionId;
          this._sessionId = message.session_id;
          this.sessionIdResolved = true;

          log.info(
            {
              event: "session_id_received",
              sessionId: this._sessionId,
              previousTempId: oldSessionId,
              processId: this.id,
              projectId: this.projectId,
            },
            `Session ID received from SDK: ${this._sessionId}`,
          );

          this.publishAgentctlSessionId(this._sessionId);

          // Emit session-id-changed event so Supervisor can update its mapping
          // This is critical for ExternalSessionTracker to correctly identify owned sessions
          if (oldSessionId !== this._sessionId) {
            this.emit({
              type: "session-id-changed",
              oldSessionId,
              newSessionId: this._sessionId,
            });
          }

          // Resolve any waiters
          for (const resolve of this.sessionIdResolvers) {
            resolve(this._sessionId);
          }
          this.sessionIdResolvers = [];
        }

        // Capture resolved model from first assistant message
        if (
          !this._resolvedModel &&
          message.type === "assistant" &&
          message.message?.model &&
          message.message.model !== "<synthetic>"
        ) {
          this._resolvedModel = message.message.model;
        }

        this.promoteIdleForProviderWork(message, receivedAt);

        // Emit to SSE subscribers
        // See shouldEmitMessage() for why we never filter messages
        if (shouldEmitMessage(message)) {
          this.emit({ type: "message", message });
        }

        if (isClaudeSdkApiErrorMessage(this.provider, message)) {
          this.abortFn?.();
          this.markTerminated(
            "Claude SDK API error; restart required",
            new Error(describeClaudeSdkApiError(message)),
          );
          return;
        }

        // Handle special message types
        const claudeSessionState = getClaudeSessionStateChange(message);
        if (claudeSessionState) {
          this.handleClaudeSessionStateChanged(claudeSessionState);
        } else if (
          message.type === "system" &&
          message.subtype === "input_request"
        ) {
          // Legacy mock SDK behavior - handle input_request message
          this.handleInputRequest(message);
        } else if (message.type === "result") {
          // Capture context window from modelUsage in result messages. This is
          // the authoritative observation point (the only place the real,
          // account-resolved window exists); we emit a per-model observation
          // for each entry so it can be durably recorded regardless of whether
          // any client fetches this session's detail, and keep the max across
          // entries as this process's live-override window. The model id is
          // recorded exactly as the SDK reports it in modelUsage (no munging) —
          // observations should reflect what was actually observed.
          if (message.modelUsage) {
            const mu = message.modelUsage as Record<
              string,
              { contextWindow?: number }
            >;
            for (const [model, entry] of Object.entries(mu)) {
              if (entry.contextWindow && entry.contextWindow > 0) {
                this._contextWindow = Math.max(
                  this._contextWindow ?? 0,
                  entry.contextWindow,
                );
                this.emit({
                  type: "context-window-observed",
                  model,
                  contextWindow: entry.contextWindow,
                  provider: this.provider,
                });
              }
            }
          }
          this.transitionToIdle();
        }
        // Note: deferred messages are intentionally NOT promoted at completed
        // tool-result boundaries. A queued (`deferred`) item delivers at the
        // end of the whole turn (transitionToIdle), matching native Codex app
        // queue semantics; injecting into the live turn is the explicit
        // `steer` action only. See
        // topics/message-control-steer-queue-btw-later-interrupt.md.
      }
    } catch (error) {
      const err = error as Error;

      if (this.idleReapInProgress && this.isProcessTerminationError(err)) {
        return;
      }

      const log = getLogger();

      log.error(
        {
          event: "process_error",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          errorMessage: err.message,
          errorStack: err.stack,
          currentState: this._state.type,
        },
        `Process error: ${this._sessionId} - ${err.message}`,
      );

      this.emit({ type: "error", error: err });

      // Detect process termination errors - set flag synchronously BEFORE markTerminated
      // to prevent race where queueMessage is called before state changes to terminated
      if (this.isProcessTerminationError(err)) {
        this.transportFailed = true;
        this.markTerminated("underlying process terminated", err);
        return;
      }

      // Don't transition to idle if we're waiting for input
      if (this._state.type !== "waiting-input") {
        this.transitionToIdle();
      }
    } finally {
      // Resolve exit promise on both normal completion and non-terminating errors
      // so abort() doesn't hang waiting for it. (markTerminated already resolves
      // it for termination errors, and guards against double-resolve.)
      if (this._exitResolve) {
        this._exitResolve();
        this._exitResolve = null;
      }
    }
  }

  /**
   * Check if an error indicates the underlying Claude process was terminated.
   */
  private isProcessTerminationError(error: Error): boolean {
    const message = error.message || "";
    return (
      message.includes("ProcessTransport is not ready") ||
      message.includes("not ready for writing") ||
      message.includes("process exited") ||
      message.includes("SIGTERM") ||
      message.includes("SIGKILL") ||
      // SDK wraps spawn errors as "Failed to spawn Claude Code process: spawn <cmd> ENOENT"
      // where <cmd> varies (e.g., "node", "claude"), so check for ENOENT broadly
      message.includes("ENOENT")
    );
  }

  /**
   * Handle input_request message from mock SDK.
   * Real SDK uses canUseTool callback instead.
   */
  private handleInputRequest(message: SDKMessage): void {
    if (!message.input_request) return;

    const request: InputRequest = {
      id: message.input_request.id,
      sessionId: this._sessionId,
      type: message.input_request.type as InputRequest["type"],
      prompt: message.input_request.prompt,
      options: message.input_request.options,
      timestamp: new Date().toISOString(),
    };

    this.setState({ type: "waiting-input", request });
  }

  private handleClaudeSessionStateChanged(state: ClaudeSessionState): void {
    switch (state) {
      case "idle":
        if (this._state.type !== "waiting-input") {
          this.transitionToIdle();
        }
        break;

      case "running":
        if (
          this._state.type === "waiting-input" &&
          this.pendingToolApprovals.size > 0
        ) {
          this.clearIdleTimer();
          return;
        }
        if (this._state.type !== "in-turn") {
          this.transitionToInTurnForWake("session-state-running");
        } else {
          this.clearIdleTimer();
        }
        break;

      case "requires_action":
        if (this._state.type === "idle") {
          this.transitionToInTurnForWake("session-state-requires-action");
        } else {
          this.clearIdleTimer();
        }
        break;
    }
  }

  private transitionToIdle(): void {
    this.clearIdleTimer();

    // Promote deferred messages as the same stitched user turn the provider
    // receives, so the live echo and later transcript catch-up agree.
    if (this.promoteEligibleDeferredAfterTurn()) {
      this.setState({ type: "in-turn" });
      return;
    }

    this.setState({ type: "idle", since: new Date() });
    this.startIdleTimer();
    this.flushPendingRecapRequest();
    this.processNextInQueue();
  }

  private flushPendingRecapRequest(): void {
    const pending = this.pendingRecapRequest;
    if (!pending || this.recapInFlight || this._state.type !== "idle") {
      return;
    }
    this.pendingRecapRequest = null;
    void this.generateAndEmitRecap(pending.provider, pending.sinceMs);
  }

  /**
   * Deferred-delivery knobs, resolved per call (so live settings changes
   * apply) from constructor overrides, then published server settings, then
   * env config. Both default off: vanilla delivery is one verbatim deferred
   * turn per delivery boundary (topics/vanilla-defaults.md).
   */
  private resolveDeferredDelivery(): DeferredDeliverySettings {
    const overrides = this.deferredDeliveryOverrides;
    if (
      overrides?.joinWindowSeconds !== undefined &&
      overrides?.composeAnchors !== undefined
    ) {
      return {
        joinWindowSeconds: overrides.joinWindowSeconds,
        composeAnchors: overrides.composeAnchors,
      };
    }
    const resolved = resolveDeferredDeliverySettings();
    return {
      joinWindowSeconds:
        overrides?.joinWindowSeconds ?? resolved.joinWindowSeconds,
      composeAnchors: overrides?.composeAnchors ?? resolved.composeAnchors,
    };
  }

  /**
   * Leading run of entries whose consecutive compose times are within the
   * join window. With the default window of 0 the group is always a single
   * entry, so queued turns deliver one per boundary; a large window
   * approximates "always join".
   */
  private leadingJoinGroup(
    entries: DeferredQueueEntry[],
    joinWindowSeconds: number,
  ): DeferredQueueEntry[] {
    const group = [entries[0]!];
    const windowMs = joinWindowSeconds * 1000;
    // 0 means never join, even for sends composed in the same millisecond.
    if (windowMs <= 0) return group;
    for (let i = 1; i < entries.length; i++) {
      const gapMs =
        this.composedAtMsForEntry(entries[i]!) -
        this.composedAtMsForEntry(entries[i - 1]!);
      // NaN gaps (unparseable timestamps) compare false and end the group.
      if (!(gapMs <= windowMs)) break;
      group.push(entries[i]!);
    }
    return group;
  }

  /**
   * Server-clock epoch ms a deferred message was composed/queued. Prefers the
   * route-stamped `serverReceivedAt` and falls back to the queue-entry
   * timestamp — both server clock, so the delta against delivery time (now) has
   * no skew.
   */
  private composedAtMsForEntry(entry: DeferredQueueEntry): number {
    const serverReceivedAt = entry.message.metadata?.serverReceivedAt;
    const fromMetadata = serverReceivedAt ? Date.parse(serverReceivedAt) : NaN;
    if (Number.isFinite(fromMetadata)) return fromMetadata;
    return Date.parse(entry.timestamp);
  }

  /**
   * Compose-time anchor string per deferred entry, computed at delivery (now).
   * Parallel to `entries`; each element is the `(Ns ago)` / `(Ms later)` prefix
   * or null when below threshold — or always null when anchors are off
   * (the default; YEP_COMPOSE_ANCHORS=1 opts in). See
   * topics/compose-time-context-anchors.md.
   */
  private deferredComposeAnchors(
    entries: DeferredQueueEntry[],
  ): (string | null)[] {
    if (!this.resolveDeferredDelivery().composeAnchors) {
      return entries.map(() => null);
    }
    return composeTimeAnchors(
      entries.map((entry) => this.composedAtMsForEntry(entry)),
      Date.now(),
    );
  }

  /**
   * Promote deferred messages that may run after the completed turn.
   * Returns true when at least one message was accepted by the direct queue.
   *
   * One join group is promoted per delivery boundary. With the default join
   * window of 0 that is exactly one verbatim deferred turn — N queued
   * "proceed"-style messages get N work slices. A non-zero window joins
   * consecutively-composed turns into one `--------`-separated provider turn.
   */
  private promoteEligibleDeferredAfterTurn(): boolean {
    if (this.deferredQueue.length === 0 || !this.messageQueue) {
      return false;
    }

    const eligible = this.deferredQueue.filter(
      (entry) => !isPatientDeferredEntry(entry, this.provider),
    );
    if (eligible.length === 0) {
      return false;
    }

    const { joinWindowSeconds } = this.resolveDeferredDelivery();
    const group = this.leadingJoinGroup(eligible, joinWindowSeconds);
    const anchors = this.deferredComposeAnchors(group);
    const providerMessages = group.map((entry, index) =>
      this.prepareProviderMessage(entry.message, anchors[index]),
    );
    const providerTurn =
      providerMessages.length === 1
        ? providerMessages[0]!
        : this.concatMessages(providerMessages);

    const result = this.queuePreparedMessage(providerTurn, {
      allowSteer: false,
    });
    if (!result.success) {
      this.emitDeferredQueueChange("queued", group[0]?.message.tempId);
      return false;
    }

    const promotedEntries = new Set(group);
    this.deferredQueue = this.deferredQueue.filter(
      (entry) => !promotedEntries.has(entry),
    );
    this.emitDeferredQueueChange(
      "promoted",
      group.length === 1 ? group[0]!.message.tempId : undefined,
    );
    return true;
  }

  /**
   * Promote patient deferred entries whose own patience window has elapsed
   * since the session became verifiably quiet. Entries still waiting report
   * the shortest remaining wait so the caller can schedule a precise
   * re-check instead of polling.
   */
  promoteEligiblePatientDeferredMessages(options: {
    /** Server-clock ms when the current verified-quiet period began. */
    quietSinceMs: number;
    now?: number;
  }): { promoted: boolean; nextPatienceMsRemaining: number | null } {
    if (
      this.deferredQueue.length === 0 ||
      !this.messageQueue ||
      this._state.type !== "idle"
    ) {
      return { promoted: false, nextPatienceMsRemaining: null };
    }

    const patientEntries = this.deferredQueue.filter((entry) =>
      isPatientDeferredEntry(entry, this.provider),
    );
    if (patientEntries.length === 0) {
      return { promoted: false, nextPatienceMsRemaining: null };
    }

    const now = options.now ?? Date.now();
    const quietMs = Math.max(0, now - options.quietSinceMs);
    const eligible = patientEntries.filter(
      (entry) => patientPatienceMsForEntry(entry) <= quietMs,
    );
    const nextPatienceMsRemaining = patientEntries.reduce<number | null>(
      (min, entry) => {
        const remaining = patientPatienceMsForEntry(entry) - quietMs;
        if (remaining <= 0) return min;
        return min === null ? remaining : Math.min(min, remaining);
      },
      null,
    );

    if (eligible.length === 0) {
      return { promoted: false, nextPatienceMsRemaining };
    }

    // Partition the eligible entries into join groups (compose-time gaps
    // within the window). With the default window of 0 every entry is its own
    // verbatim provider message. All groups are queued in this same pass —
    // unlike the after-turn path — so quiet-window scheduling is unchanged.
    const { joinWindowSeconds } = this.resolveDeferredDelivery();
    const promotedEntries = new Set<DeferredQueueEntry>();
    let rest = eligible;
    while (rest.length > 0) {
      const group = this.leadingJoinGroup(rest, joinWindowSeconds);
      rest = rest.slice(group.length);
      const anchors = this.deferredComposeAnchors(group);
      const providerMessages = group.map((entry, index) =>
        this.prepareProviderMessage(entry.message, anchors[index]),
      );
      const providerTurn =
        providerMessages.length === 1
          ? providerMessages[0]!
          : this.concatMessages(providerMessages);
      const result = this.queuePreparedMessage(providerTurn, {
        allowSteer: false,
      });
      if (!result.success) break;
      for (const entry of group) {
        promotedEntries.add(entry);
      }
    }

    if (promotedEntries.size === 0) {
      this.emitDeferredQueueChange("queued", eligible[0]?.message.tempId);
      return { promoted: false, nextPatienceMsRemaining };
    }

    this.deferredQueue = this.deferredQueue.filter(
      (entry) => !promotedEntries.has(entry),
    );
    this.emitDeferredQueueChange("promoted");
    return { promoted: true, nextPatienceMsRemaining };
  }

  /**
   * Process next message in legacy queue (for mock SDK).
   */
  private processNextInQueue(): void {
    if (this.legacyQueue.length === 0) return;

    const nextMessage = this.legacyQueue.shift();
    if (nextMessage) {
      // In real implementation with MessageQueue, this happens automatically
      // For mock SDK, we just transition back to running
      this.transitionToInTurnForWake("user-message");
    }
  }

  private publishAgentctlSessionId(sessionId: string): void {
    if (!this.publishAgentctlSessionIdFn) return;

    try {
      const result = this.publishAgentctlSessionIdFn(sessionId);
      if (result && typeof result.then === "function") {
        result.catch((error) => {
          this.logAgentctlSessionIdPublishError(sessionId, error);
        });
      }
    } catch (error) {
      this.logAgentctlSessionIdPublishError(sessionId, error);
    }
  }

  private logAgentctlSessionIdPublishError(
    sessionId: string,
    error: unknown,
  ): void {
    getLogger().warn(
      {
        event: "agentctl_session_id_publish_error",
        sessionId,
        processId: this.id,
        projectId: this.projectId,
        provider: this.provider,
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "Provider failed to publish AGENTCTL_SESSION_ID",
    );
  }

  private startIdleTimer(delayMs = this.idleTimeoutMs): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = null;

        // State may have changed while the timer was pending.
        if (this._state.type !== "idle") {
          return;
        }

        const retainedByFeature =
          this.shouldRetainIdleProcess?.(this._sessionId) ?? false;
        const retainedByPromptCacheKeepalive =
          this.hasPromptCacheKeepaliveLease();
        const providerRetention = this.getProviderRetentionSnapshot();
        if (
          this.hasLiveDeltaSubscribers() ||
          retainedByFeature ||
          retainedByPromptCacheKeepalive ||
          providerRetention.retained
        ) {
          getLogger().debug(
            {
              event: "idle_cleanup_deferred",
              sessionId: this._sessionId,
              processId: this.id,
              projectId: this.projectId,
              idleTimeoutMs: this.idleTimeoutMs,
              liveDeltaSubscriberCount: this.liveDeltaSubscriberCount,
              retainedByFeature,
              retainedByPromptCacheKeepalive,
              retainedByProvider: providerRetention.retained,
              providerRetentionReasons: providerRetention.reasons,
              providerBackgroundTaskCount:
                providerRetention.backgroundTaskCount,
              providerSessionCronCount: providerRetention.sessionCronCount,
              providerLiveTaskCount: providerRetention.liveTaskCount,
            },
            `Idle cleanup deferred: ${this._sessionId} is explicitly retained`,
          );
          this.startIdleTimer();
          return;
        }

        this.reapIdleProcess();
      },
      Math.max(0, delayMs),
    );
    this.idleTimer.unref?.();
  }

  private rescheduleIdleTimerForCurrentIdlePeriod(): void {
    if (this._state.type !== "idle") {
      return;
    }
    const elapsedMs = Date.now() - this._state.since.getTime();
    this.startIdleTimer(Math.max(0, this.idleTimeoutMs - elapsedMs));
  }

  private reapIdleProcess(): void {
    this.idleReapInProgress = true;
    this.clearPromptCacheKeepaliveTimer();
    this.stopBucketSwapTimer();
    this.iteratorDone = true;

    this.emit({ type: "idle-reap" });

    if (this.abortFn) {
      this.abortFn();
    }

    this.emit({ type: "complete" });
    this.listeners.clear();

    if (this._exitResolve) {
      this._exitResolve();
      this._exitResolve = null;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearPromptCacheKeepaliveTimer(): void {
    if (this.promptCacheKeepaliveTimer) {
      clearTimeout(this.promptCacheKeepaliveTimer);
      this.promptCacheKeepaliveTimer = null;
    }
  }

  private setState(state: ProcessState): void {
    this._state = state;
    this._lastStateChangeTime = new Date();
    this.emit({ type: "state-change", state });
    this.schedulePromptCacheKeepalive();
  }

  private emit(event: ProcessEvent): void {
    if (event.type === "state-change") {
      getLogger().debug(
        {
          component: "process",
          sessionId: this._sessionId,
          eventType: "state-change",
          listenerCount: this.listeners.size,
          newState: event.state.type,
        },
        `Emitting state-change to ${this.listeners.size} listeners`,
      );
    }
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(event)).catch((error: unknown) => {
          this.logListenerError(event, error);
        });
      } catch (error) {
        this.logListenerError(event, error);
      }
    }
  }

  private logListenerError(event: ProcessEvent, error: unknown): void {
    getLogger().warn(
      {
        event: "process_listener_error",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        provider: this.provider,
        emittedEventType: event.type,
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "Process listener failed",
    );
  }
}
