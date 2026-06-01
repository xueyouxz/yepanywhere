import {
  type ContextUsage,
  type PermissionRules,
  PROMPT_SUGGESTION_MODES,
  type PromptSuggestionMode,
  type ProviderName,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  RECAP_MODES,
  type ClaudeSessionEntry,
  type RecapMode,
  type SessionMetadataResponse,
  type SessionOwnership,
  type ThinkingOption,
  type UploadedFile,
  type UserMessageDeliveryIntent,
  type UserMessageMetadata,
  type UrlProjectId,
  getModelContextWindow,
  isUrlProjectId,
  thinkingOptionToConfig,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { augmentTextBlocks } from "../augments/markdown-augments.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import { DETACHED_PROJECT_PATH, encodeProjectId } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { ensureRemoteDirectory } from "../sdk/remote-spawn.js";
import { getProjectDirFromCwd, syncSessions } from "../sdk/session-sync.js";
import type { PermissionMode, SDKMessage, UserMessage } from "../sdk/types.js";
import { appendApprovalAuditLog } from "../security/approvalAuditLog.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { cloneClaudeSession, cloneCodexSession } from "../sessions/fork.js";
import { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { buildDag } from "../sessions/dag.js";
import { GrokSessionReader } from "../sessions/grok-reader.js";
import { normalizeSession } from "../sessions/normalization.js";
import {
  type PaginationInfo,
  sliceAfterMessageIdWithMatch,
  sliceAtCompactBoundaries,
  sliceAtUserTurnBoundary,
} from "../sessions/pagination.js";
import { augmentPersistedSessionMessages } from "../sessions/persisted-augments.js";
import { findSessionSummaryAcrossProviders } from "../sessions/provider-resolution.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type {
  DeferredMessagePlacement,
  Process,
} from "../supervisor/Process.js";
import type {
  QueueFullResponse,
  Supervisor,
} from "../supervisor/Supervisor.js";
import type { QueuedResponse } from "../supervisor/WorkerQueue.js";
import type { ContentBlock, Message, Project, Session } from "../supervisor/types.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";
import type { EventBus } from "../watcher/index.js";

const SESSION_DETAIL_SLOW_LOG_MS = 250;
const CLAUDE_RESUME_API_ERROR_RECOVERY = "handoff-required";
const CLAUDE_RESUME_API_ERROR_MESSAGE =
  "Claude session cannot be safely resumed because the Claude SDK recorded an API-error response as the latest assistant message. Start a handoff session instead.";

function roundedMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function isClaudeSdkProviderName(
  provider: ProviderName | undefined,
): provider is "claude" | "claude-ollama" {
  return provider === "claude" || provider === "claude-ollama";
}

/**
 * Type guard to check if a result is a QueuedResponse
 */
function isQueuedResponse(
  result: Process | QueuedResponse | QueueFullResponse,
): result is QueuedResponse {
  return "queued" in result && result.queued === true;
}

/**
 * Type guard to check if a result is a QueueFullResponse
 */
function isQueueFullResponse(
  result: Process | QueuedResponse | QueueFullResponse,
): result is QueueFullResponse {
  return "error" in result && result.error === "queue_full";
}

interface ClaudeResumeApiErrorBlocker {
  error: string;
  recovery: typeof CLAUDE_RESUME_API_ERROR_RECOVERY;
  messageId?: string;
  apiErrorStatus?: unknown;
}

function getClaudeResumeApiErrorBlocker(
  messages: ClaudeSessionEntry[],
): ClaudeResumeApiErrorBlocker | null {
  const { activeBranch } = buildDag(messages);

  for (let i = activeBranch.length - 1; i >= 0; i--) {
    const raw = activeBranch[i]?.raw;
    if (raw?.type !== "assistant") {
      continue;
    }

    if (raw.isApiErrorMessage !== true) {
      return null;
    }

    const apiError = raw as ClaudeSessionEntry & {
      apiErrorStatus?: unknown;
    };
    return {
      error: CLAUDE_RESUME_API_ERROR_MESSAGE,
      recovery: CLAUDE_RESUME_API_ERROR_RECOVERY,
      messageId: raw.message.id,
      apiErrorStatus: apiError.apiErrorStatus,
    };
  }

  return null;
}

async function getClaudeResumeBlockerFromReader(
  reader: ISessionReader,
  sessionId: string,
  projectId: UrlProjectId,
): Promise<ClaudeResumeApiErrorBlocker | null> {
  const session = await reader.getSession(sessionId, projectId);
  if (!session) {
    return null;
  }
  if (
    session.data.provider !== "claude" &&
    session.data.provider !== "claude-ollama"
  ) {
    return null;
  }
  return getClaudeResumeApiErrorBlocker(session.data.session.messages);
}

function parseOptionalExecutor(rawExecutor: unknown): {
  executor: string | undefined;
  error?: string;
} {
  if (rawExecutor === undefined || rawExecutor === null) {
    return { executor: undefined };
  }
  if (typeof rawExecutor !== "string") {
    return { executor: undefined, error: "executor must be a string" };
  }

  const executor = normalizeSshHostAlias(rawExecutor);
  if (!executor) {
    return { executor: undefined };
  }
  if (!isValidSshHostAlias(executor)) {
    return {
      executor: undefined,
      error: "executor must be a valid SSH host alias",
    };
  }

  return { executor };
}

function normalizeOptionalServiceTier(
  rawServiceTier: unknown,
): string | undefined {
  if (typeof rawServiceTier !== "string") {
    return undefined;
  }
  const serviceTier = rawServiceTier.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(serviceTier)
    ? serviceTier
    : undefined;
}

function parseOptionalRecapMode(rawMode: unknown): {
  recapMode: RecapMode | undefined;
  error?: string;
} {
  if (rawMode === undefined || rawMode === null || rawMode === "") {
    return { recapMode: undefined };
  }
  if (
    typeof rawMode !== "string" ||
    !RECAP_MODES.includes(rawMode as RecapMode)
  ) {
    return {
      recapMode: undefined,
      error: "recapMode must be one of: off, native, side-session",
    };
  }
  return { recapMode: rawMode as RecapMode };
}

function parseOptionalPromptSuggestionMode(rawMode: unknown): {
  promptSuggestionMode: PromptSuggestionMode | undefined;
  error?: string;
} {
  if (rawMode === undefined || rawMode === null || rawMode === "") {
    return { promptSuggestionMode: undefined };
  }
  if (
    typeof rawMode !== "string" ||
    !PROMPT_SUGGESTION_MODES.includes(rawMode as PromptSuggestionMode)
  ) {
    return {
      promptSuggestionMode: undefined,
      error: "promptSuggestionMode must be one of: off, native",
    };
  }
  return { promptSuggestionMode: rawMode as PromptSuggestionMode };
}

function parseOptionalHelperSideModel(rawModel: unknown): {
  helperSideModel: string | undefined;
  error?: string;
} {
  if (rawModel === undefined || rawModel === null || rawModel === "") {
    return { helperSideModel: undefined };
  }
  if (typeof rawModel !== "string") {
    return { helperSideModel: undefined, error: "helperSideModel must be a string" };
  }
  const trimmed = rawModel.trim();
  if (!trimmed) {
    return { helperSideModel: undefined };
  }
  return {
    helperSideModel:
      trimmed === HELPER_SIDE_MODEL_SAME_AS_MAIN
        ? HELPER_SIDE_MODEL_SAME_AS_MAIN
        : trimmed === HELPER_SIDE_MODEL_CHEAPEST
          ? HELPER_SIDE_MODEL_CHEAPEST
          : trimmed.slice(0, 200),
  };
}

function parseHelperSettings(body: {
  recapMode?: unknown;
  promptSuggestionMode?: unknown;
  helperSideModel?: unknown;
}): {
  recapMode: RecapMode | undefined;
  promptSuggestionMode: PromptSuggestionMode | undefined;
  helperSideModel: string | undefined;
  error?: string;
} {
  const recap = parseOptionalRecapMode(body.recapMode);
  if (recap.error) {
    return {
      recapMode: undefined,
      promptSuggestionMode: undefined,
      helperSideModel: undefined,
      error: recap.error,
    };
  }
  const promptSuggestion = parseOptionalPromptSuggestionMode(
    body.promptSuggestionMode,
  );
  if (promptSuggestion.error) {
    return {
      recapMode: undefined,
      promptSuggestionMode: undefined,
      helperSideModel: undefined,
      error: promptSuggestion.error,
    };
  }
  const helperModel = parseOptionalHelperSideModel(body.helperSideModel);
  if (helperModel.error) {
    return {
      recapMode: undefined,
      promptSuggestionMode: undefined,
      helperSideModel: undefined,
      error: helperModel.error,
    };
  }
  return {
    recapMode: recap.recapMode,
    promptSuggestionMode: promptSuggestion.promptSuggestionMode,
    helperSideModel: helperModel.helperSideModel,
  };
}

function isCodexProviderName(
  provider: ProviderName | string | undefined,
): provider is "codex" | "codex-oss" {
  return provider === "codex" || provider === "codex-oss";
}

function parseDeferredPlacement(body: {
  insertBeforeTempId?: unknown;
  insertAfterTempId?: unknown;
  replaceDeferredTempId?: unknown;
}): DeferredMessagePlacement | undefined {
  const beforeTempId =
    typeof body.insertBeforeTempId === "string" &&
    body.insertBeforeTempId.trim()
      ? body.insertBeforeTempId.trim()
      : undefined;
  const afterTempId =
    typeof body.insertAfterTempId === "string" && body.insertAfterTempId.trim()
      ? body.insertAfterTempId.trim()
      : undefined;
  const replaceTempId =
    typeof body.replaceDeferredTempId === "string" &&
    body.replaceDeferredTempId.trim()
      ? body.replaceDeferredTempId.trim()
      : undefined;
  if (!beforeTempId && !afterTempId && !replaceTempId) {
    return undefined;
  }
  return {
    ...(afterTempId ? { afterTempId } : {}),
    ...(beforeTempId ? { beforeTempId } : {}),
    ...(replaceTempId ? { replaceTempId } : {}),
  };
}

const USER_MESSAGE_DELIVERY_INTENTS: ReadonlySet<UserMessageDeliveryIntent> =
  new Set(["direct", "steer", "deferred", "patient"]);

const AUTO_COMPACT_CONTEXT_PERCENT_THRESHOLD = 85;
const AUTO_COMPACT_MODEL_PREFIXES = ["gpt-5.3-codex-spark"] as const;
const AUTO_COMPACT_TARGET_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  "codex",
  "codex-oss",
]);

type AutoCompactQueueResult =
  | { queued: false; reason: string; command?: undefined }
  | { queued: true; command: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function parseDeliveryIntent(
  value: unknown,
): UserMessageDeliveryIntent | undefined {
  return typeof value === "string" &&
    USER_MESSAGE_DELIVERY_INTENTS.has(value as UserMessageDeliveryIntent)
    ? (value as UserMessageDeliveryIntent)
    : undefined;
}

function parseShortString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function parseStringList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return undefined;
  const parsed = value
    .map((entry) => parseShortString(entry, maxLength))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, maxItems);
  return parsed.length > 0 ? parsed : undefined;
}

function buildUserMessageMetadata(
  body: StartSessionBody,
  serverTimestamp: number,
  fallbackIntent: UserMessageDeliveryIntent,
): UserMessageMetadata {
  const rawMetadata = isRecord(body.messageMetadata) ? body.messageMetadata : {};
  const rawComposition = isRecord(rawMetadata.composition)
    ? rawMetadata.composition
    : {};
  const composition = {
    typingStartedAt: parseIsoTimestamp(rawComposition.typingStartedAt),
    typingEndedAt: parseIsoTimestamp(rawComposition.typingEndedAt),
    lastEditedAt: parseIsoTimestamp(rawComposition.lastEditedAt),
    submittedAt: parseIsoTimestamp(rawComposition.submittedAt),
  };
  const cleanComposition = Object.fromEntries(
    Object.entries(composition).filter(([, value]) => value !== undefined),
  ) as NonNullable<UserMessageMetadata["composition"]>;
  const clientTimestamp =
    typeof body.clientTimestamp === "number" && Number.isFinite(body.clientTimestamp)
      ? body.clientTimestamp
      : undefined;
  const rawSpeech = isRecord(rawMetadata.speech) ? rawMetadata.speech : {};
  const speechClientTurnId = parseShortString(rawSpeech.clientTurnId, 120);
  const speechTranscriptionIds = parseStringList(
    rawSpeech.transcriptionIds,
    20,
    120,
  );
  const speech =
    speechClientTurnId || speechTranscriptionIds
      ? {
          ...(speechClientTurnId
            ? { clientTurnId: speechClientTurnId }
            : {}),
          ...(speechTranscriptionIds
            ? { transcriptionIds: speechTranscriptionIds }
            : {}),
        }
      : undefined;

  return {
    deliveryIntent:
      parseDeliveryIntent(rawMetadata.deliveryIntent) ?? fallbackIntent,
    ...(Object.keys(cleanComposition).length > 0
      ? { composition: cleanComposition }
      : {}),
    ...(speech ? { speech } : {}),
    ...(clientTimestamp !== undefined ? { clientTimestamp } : {}),
    serverReceivedAt: new Date(serverTimestamp).toISOString(),
  };
}

export interface SessionsDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  eventBus?: EventBus;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  /** Grok sessions directory (defaults to ~/.grok/sessions) */
  grokSessionsDir?: string;
  /** Optional shared Grok reader factory for cross-provider session lookups */
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  /** ServerSettingsService for reading global instructions */
  serverSettingsService?: ServerSettingsService;
  /** ModelInfoService for context window lookups */
  modelInfoService?: ModelInfoService;
  /** Data directory for local security/audit logs */
  dataDir?: string;
}

interface StartSessionBody {
  message: string;
  images?: string[];
  documents?: string[];
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingOption;
  provider?: ProviderName;
  /** Browser-side timestamp for request latency tracking (epoch ms) */
  clientTimestamp?: number;
  /** YA-internal submission timing and delivery-intent metadata. */
  messageMetadata?: UserMessageMetadata;
  /** Client-generated temp ID for optimistic UI tracking */
  tempId?: string;
  /** Deferred queue reinsertion anchor for edited queued messages */
  insertBeforeTempId?: string;
  /** Deferred queue reinsertion anchor for edited queued messages */
  insertAfterTempId?: string;
  /** Queued temp ID currently held behind an edit barrier */
  replaceDeferredTempId?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** Session recap behavior for future away-return triggers. */
  recapMode?: RecapMode;
  /** Prompt suggestion behavior for this session. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
}

interface CreateSessionBody {
  mode?: PermissionMode;
  model?: string;
  serviceTier?: string;
  thinking?: ThinkingOption;
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** Session recap behavior for future away-return triggers. */
  recapMode?: RecapMode;
  /** Prompt suggestion behavior for this session. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
}

interface InputResponseBody {
  requestId: string;
  response: "approve" | "approve_accept_edits" | "deny" | string;
  answers?: Record<string, string>;
  feedback?: string;
}

interface RestartSessionBody extends CreateSessionBody {
  reason?: string;
}

const RESTART_HANDOFF_MAX_CHARS = 40_000;
const RESTART_HANDOFF_JSON_MAX_CHARS = 2_000;
const RESTART_HANDOFF_COMPACT_MAX_CHARS = 10_000;
const RESTART_HANDOFF_USER_TURNS_MAX_CHARS = 28_000;
const RESTART_HANDOFF_ACTIVITY_MAX_CHARS = 14_000;
const RESTART_HANDOFF_USER_TURN_MAX_CHARS = 4_000;
const RESTART_HANDOFF_ACTIVITY_ITEM_MAX_CHARS = 900;
const RESTART_HANDOFF_QUEUED_MAX_CHARS = 4_000;
const RESTART_HANDOFF_RECENT_USER_TURNS = 10;
const RESTART_HANDOFF_RECENT_ACTIVITY_ITEMS = 24;
const RESTART_COMPACT_WAIT_MS = 12_000;

function truncateForRestart(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars).trimEnd()}\n[truncated ${omitted} chars]`;
}

function formatRestartBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  if (bytes < 1024 * 1024 * 1024)
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
}

function stringifyForRestart(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    return truncateForRestart(value, maxChars);
  }
  try {
    return truncateForRestart(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return "[unserializable content]";
  }
}

function renderRestartContent(content: unknown): string {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return stringifyForRestart(content, RESTART_HANDOFF_JSON_MAX_CHARS);
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!block || typeof block !== "object") {
        return "";
      }

      const typed = block as ContentBlock;
      switch (typed.type) {
        case "text":
          return typed.text ?? "";
        case "thinking":
          return typed.thinking ? `[thinking]\n${typed.thinking}` : "[thinking]";
        case "tool_use":
          return `[tool_use ${typed.name ?? "unknown"}]\n${stringifyForRestart(
            typed.input,
            RESTART_HANDOFF_JSON_MAX_CHARS,
          )}`;
        case "tool_result":
          return `[tool_result${typed.is_error ? " error" : ""} ${
            typed.tool_use_id ?? ""
          }]\n${renderRestartContent(typed.content)}`;
        case "image":
        case "input_image":
          return "[image]";
        case "document":
          return "[document]";
        default:
          return `[${typed.type}]\n${stringifyForRestart(
            typed,
            RESTART_HANDOFF_JSON_MAX_CHARS,
          )}`;
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function compactRestartLine(text: string, maxChars: number): string {
  return truncateForRestart(text.replace(/\s+/g, " ").trim(), maxChars);
}

function messageRole(message: Message): string {
  const nested = message.message as { role?: unknown } | undefined;
  return (
    (typeof nested?.role === "string" && nested.role) ||
    (typeof message.role === "string" && message.role) ||
    message.type ||
    "message"
  );
}

function messageTimestampSuffix(message: Message): string {
  return typeof message.timestamp === "string" && message.timestamp.trim()
    ? ` ${message.timestamp}`
    : "";
}

function messageContent(message: Message): unknown {
  const nested = message.message as { content?: unknown } | undefined;
  return nested?.content ?? (message as { content?: unknown }).content;
}

function messageHasToolResult(message: Message): boolean {
  if (message.toolUseResult !== undefined) {
    return true;
  }
  const content = messageContent(message);
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (block as ContentBlock).type === "tool_result",
    )
  );
}

function isRestartInternalCompactCommand(message: Message): boolean {
  if (messageRole(message) !== "user" || messageHasToolResult(message)) {
    return false;
  }
  const content = renderRestartContent(messageContent(message)).trim();
  return /^\/(?:compact|compress)\b/i.test(content);
}

function isAutoCompactModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.toLowerCase().trim();
  return AUTO_COMPACT_MODEL_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

function isAutoCompactEligibleMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }

  // Avoid surprise when user explicitly invokes slash commands.
  if (trimmed.startsWith("/")) {
    return false;
  }

  return true;
}

async function tryQueueTargetedAutoCompact(params: {
  process: Process;
  model: string | undefined;
  message: string;
  resolveContextWindow: (model: string | undefined, provider?: ProviderName) => number;
}): Promise<AutoCompactQueueResult> {
  if (params.process.state.type !== "idle") {
    return { queued: false, reason: "process-not-idle" };
  }

  if (!AUTO_COMPACT_TARGET_PROVIDERS.has(params.process.provider)) {
    return { queued: false, reason: "provider-not-targeted" };
  }

  if (!isAutoCompactModel(params.model)) {
    return { queued: false, reason: "model-not-targeted" };
  }

  if (!isAutoCompactEligibleMessage(params.message)) {
    return { queued: false, reason: "non-user-turn" };
  }

  if (!params.process.supportsDynamicCommands) {
    return {
      queued: false,
      reason: "compact-command-advertising-unavailable",
    };
  }

  const contextUsage = extractContextUsageFromSDKMessages(
    params.process.getMessageHistory(),
    params.model,
    params.process.provider,
    params.resolveContextWindow,
  );
  if (!contextUsage?.contextWindow || contextUsage.contextWindow <= 0) {
    return { queued: false, reason: "context-window-unavailable" };
  }
  if (contextUsage.percentage < AUTO_COMPACT_CONTEXT_PERCENT_THRESHOLD) {
    return { queued: false, reason: "below-threshold" };
  }

  const commands = await params.process.supportedCommands();
  if (!commands) {
    return { queued: false, reason: "compact-command-list-unavailable" };
  }

  const command = commands.find((candidate) => candidate.name === "compact")?.name ??
    commands.find((candidate) => candidate.name === "compress")?.name;
  if (!command) {
    return { queued: false, reason: "compact-command-unavailable" };
  }

  const queued = params.process.queueMessage({ text: `/${command}` });
  if (!queued.success) {
    return {
      queued: false,
      reason: queued.error ?? "compact-not-queued",
    };
  }

  return { queued: true, command };
}

function toolInputSummary(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return compactRestartLine(stringifyForRestart(input, 400), 400);
  }

  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    "file_path",
    "path",
    "command",
    "query",
    "pattern",
    "old_string",
    "new_string",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${compactRestartLine(value, 180)}`);
    }
  }

  return parts.length > 0
    ? parts.join("; ")
    : compactRestartLine(stringifyForRestart(input, 400), 400);
}

function summarizeToolUse(name: string | undefined, input: unknown): string {
  const toolName = name ?? "unknown";
  const summary = toolInputSummary(input);
  const lowerName = toolName.toLowerCase();
  const behavior = /read|grep|glob|search|ls|list/.test(lowerName)
    ? "read/search details omitted; rerun if needed"
    : /edit|write|patch|notebook/.test(lowerName)
      ? "edit/write details omitted; inspect the current repo diff"
      : "tool input summarized";
  return `[tool_use ${toolName}] ${summary} (${behavior})`;
}

function summarizeToolResult(content: unknown): string {
  const rendered = renderRestartContent(content);
  const charCount = rendered.length;
  return `[tool_result] output omitted (${charCount} chars; inspect live files or rerun reads if needed)`;
}

function renderRestartActivityContent(message: Message): string {
  if (message.toolUse) {
    return summarizeToolUse(message.toolUse.name, message.toolUse.input);
  }
  if (message.toolUseResult !== undefined) {
    return summarizeToolResult(message.toolUseResult);
  }

  const content = messageContent(message);
  if (!Array.isArray(content)) {
    return renderRestartContent(content);
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!block || typeof block !== "object") {
        return "";
      }

      const typed = block as ContentBlock;
      switch (typed.type) {
        case "tool_use":
          return summarizeToolUse(typed.name, typed.input);
        case "tool_result":
          return summarizeToolResult(typed.content);
        case "thinking":
          return typed.thinking ? "[thinking summary omitted]" : "[thinking]";
        default:
          return renderRestartContent([typed]);
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function formatRestartMessage(message: Message): string | null {
  if (isRestartInternalCompactCommand(message)) {
    return null;
  }

  const role = messageRole(message);
  const timestamp = messageTimestampSuffix(message);
  const content =
    isHumanUserMessage(message)
      ? renderRestartContent(messageContent(message))
      : renderRestartActivityContent(message);
  const subtype =
    typeof message.subtype === "string" ? `:${message.subtype}` : "";
  const trimmed = content.trim();

  if (!trimmed && !subtype) {
    return null;
  }

  return `### ${role}${subtype}${timestamp}\n\n${truncateForRestart(
    trimmed || "[no textual content]",
    isHumanUserMessage(message)
      ? RESTART_HANDOFF_USER_TURN_MAX_CHARS
      : RESTART_HANDOFF_ACTIVITY_ITEM_MAX_CHARS,
  )}`;
}

function formatRestartQueuedMessage(
  message: {
    tempId?: string;
    content: string;
    timestamp: string;
    attachments?: UploadedFile[];
    attachmentCount?: number;
  },
  index: number,
): string {
  const attachmentLines =
    message.attachments?.length && message.attachments.length > 0
      ? `\n\nUser uploaded files in .attachments:\n${message.attachments
          .map(
            (file) =>
              `- [${file.originalName.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${file.path}>) (${formatRestartBytes(file.size)}, ${file.mimeType}${file.width && file.height ? `, ${file.width}x${file.height}` : ""})`,
          )
          .join("\n")}`
      : message.attachmentCount && message.attachmentCount > 0
        ? `\nAttachments queued: ${message.attachmentCount}`
        : "";
  const tempIdLine = message.tempId ? `\nTemp ID: ${message.tempId}` : "";
  return `### queued user ${index + 1} ${message.timestamp}\n\n${truncateForRestart(
    message.content.trim() || "[empty queued turn]",
    RESTART_HANDOFF_QUEUED_MAX_CHARS,
  )}${attachmentLines}${tempIdLine}`;
}

type RestartQueuedMessage = {
  tempId?: string;
  content: string;
  timestamp: string;
  attachments?: UploadedFile[];
  attachmentCount?: number;
};

function getRestartQueuedMessages(
  process: Process | undefined,
): RestartQueuedMessage[] {
  return process?.getDeferredQueueSummary?.() ?? [];
}

type RestartCompactAttempt =
  | { status: "unavailable"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "completed"; command: string }
  | { status: "timed-out"; command: string }
  | { status: "failed"; command?: string; reason: string };

function isCompactBoundaryMessage(message: SDKMessage | Message): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

function describeRestartCompactAttempt(
  attempt: RestartCompactAttempt,
): string {
  switch (attempt.status) {
    case "completed":
      return `completed with /${attempt.command}`;
    case "timed-out":
      return `tried /${attempt.command}; no compact boundary arrived before YA fallback`;
    case "failed":
      return attempt.command
        ? `tried /${attempt.command}; failed: ${attempt.reason}`
        : `failed: ${attempt.reason}`;
    case "skipped":
    case "unavailable":
      return `${attempt.status}: ${attempt.reason}`;
  }
}

async function waitForRestartCompactBoundary(
  process: Process,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (completed: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(completed);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);

    unsubscribe = process.subscribe((event) => {
      if (event.type === "message" && isCompactBoundaryMessage(event.message)) {
        finish(true);
        return;
      }
      if (event.type === "terminated" || event.type === "error") {
        finish(false);
      }
    });
  });
}

async function tryRestartCompact(
  process: Process | undefined,
): Promise<RestartCompactAttempt> {
  if (!process) {
    return { status: "unavailable", reason: "no active source process" };
  }
  if (process.state.type !== "idle") {
    return {
      status: "skipped",
      reason: `source process was ${process.state.type}`,
    };
  }
  if (!process.supportsDynamicCommands) {
    return {
      status: "unavailable",
      reason: "source process does not advertise slash commands",
    };
  }

  let command: string | undefined;
  try {
    const commands = await process.supportedCommands();
    command =
      commands?.find((candidate) => candidate.name === "compact")?.name ??
      commands?.find((candidate) => candidate.name === "compress")?.name;
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!command) {
    return {
      status: "unavailable",
      reason: "no compact/compress slash command advertised",
    };
  }

  const waitForCompact = waitForRestartCompactBoundary(
    process,
    RESTART_COMPACT_WAIT_MS,
  );
  const queued = process.queueMessage({ text: `/${command}` });
  if (!queued.success) {
    return {
      status: "failed",
      command,
      reason: queued.error ?? "compact command was not accepted",
    };
  }

  return (await waitForCompact)
    ? { status: "completed", command }
    : { status: "timed-out", command };
}

function latestCompactSummary(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.type !== "system" ||
      (message as { subtype?: unknown }).subtype !== "compact_boundary"
    ) {
      continue;
    }

    const summary = renderRestartContent(messageContent(message)).trim();
    if (summary && !/^context compacted\.?$/i.test(summary)) {
      return truncateForRestart(summary, RESTART_HANDOFF_COMPACT_MAX_CHARS);
    }
  }
  return null;
}

function selectRestartMessages(params: {
  messages: Message[];
  maxItems: number;
  maxChars: number;
  predicate: (message: Message) => boolean;
  selectedIndexes: Set<number>;
}): string[] {
  const selected: string[] = [];
  let used = 0;

  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (!message || !params.predicate(message)) {
      continue;
    }
    const formatted = formatRestartMessage(message);
    if (!formatted) {
      continue;
    }
    const nextSize = formatted.length + 2;
    if (
      selected.length >= params.maxItems ||
      (selected.length > 0 && used + nextSize > params.maxChars)
    ) {
      break;
    }
    selected.push(formatted);
    params.selectedIndexes.add(index);
    used += nextSize;
  }

  return selected.reverse();
}

function buildRestartTranscript(messages: Message[]): {
  transcript: string;
  omittedCount: number;
} {
  const selectedIndexes = new Set<number>();
  const compactSummary = latestCompactSummary(messages);
  const userTurns = selectRestartMessages({
    messages,
    maxItems: RESTART_HANDOFF_RECENT_USER_TURNS,
    maxChars: RESTART_HANDOFF_USER_TURNS_MAX_CHARS,
    predicate: isHumanUserMessage,
    selectedIndexes,
  });
  const activity = selectRestartMessages({
    messages,
    maxItems: RESTART_HANDOFF_RECENT_ACTIVITY_ITEMS,
    maxChars: RESTART_HANDOFF_ACTIVITY_MAX_CHARS,
    predicate: (message) =>
      !isHumanUserMessage(message) &&
      !(
        message.type === "system" &&
        (message as { subtype?: unknown }).subtype === "compact_boundary" &&
        compactSummary
      ),
    selectedIndexes,
  });

  const sections = [
    compactSummary
      ? `## Provider-Native Compact Summary\n\n${compactSummary}`
      : undefined,
    userTurns.length > 0
      ? `## Recent User Turns\n\n${userTurns.join("\n\n")}`
      : undefined,
    activity.length > 0
      ? `## Recent Agent and Tool Activity\n\n${activity.join("\n\n")}`
      : undefined,
  ].filter((section): section is string => Boolean(section));

  return {
    transcript: truncateForRestart(
      sections.join("\n\n"),
      RESTART_HANDOFF_MAX_CHARS,
    ),
    omittedCount: Math.max(0, messages.length - selectedIndexes.size),
  };
}

function compactRestartTitleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMarkdownHeading(text: string): string {
  return text.replace(/^#+\s*/, "");
}

function isGeneratedRestartHandoffTitle(text: string): boolean {
  const title = stripMarkdownHeading(compactRestartTitleText(text));
  return (
    /^Restart Handoff\b/i.test(title) ||
    /^Handoff:\s*Restart Handoff\b/i.test(title) ||
    /^Handoff:\s*Yep Anywhere is starting this as a fresh agent session\b/i.test(
      title,
    ) ||
    /^Yep Anywhere is starting this as a fresh agent session\b/i.test(title)
  );
}

function normalizeRestartTitleCandidate(
  title: string | null | undefined,
): string | undefined {
  if (!title) {
    return undefined;
  }
  const candidate = stripMarkdownHeading(compactRestartTitleText(title));
  if (!candidate || isGeneratedRestartHandoffTitle(candidate)) {
    return undefined;
  }
  return candidate;
}

function isHumanUserMessage(message: Message): boolean {
  const nested = message.message as { role?: unknown } | undefined;
  const role =
    (typeof nested?.role === "string" && nested.role) ||
    (typeof message.role === "string" && message.role) ||
    message.type;
  return role === "user" && !messageHasToolResult(message);
}

function messageTitleCandidate(message: Message): string | undefined {
  if (!isHumanUserMessage(message) || isRestartInternalCompactCommand(message)) {
    return undefined;
  }

  const nested = message.message as { content?: unknown } | undefined;
  const content =
    renderRestartContent(nested?.content) ||
    renderRestartContent((message as { content?: unknown }).content);
  const candidate = normalizeRestartTitleCandidate(content);

  if (
    !candidate ||
    /^\[(tool_result|tool_use|thinking|image|document)\]/i.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function latestUserTitleCandidate(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const candidate = messageTitleCandidate(message);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function truncateRestartTitle(title: string): string {
  return truncateSessionTitle(title);
}

function deriveRestartTitle(params: {
  preferredTitle?: string | null;
  sourceSession: Session;
}): string {
  const candidates = [
    params.preferredTitle,
    params.sourceSession.customTitle,
    params.sourceSession.title,
    latestUserTitleCandidate(params.sourceSession.messages),
  ];
  const base =
    candidates.map(normalizeRestartTitleCandidate).find(Boolean) ??
    "restarted session";
  const title = /^Handoff:/i.test(base) ? base : `Handoff: ${base}`;
  return truncateRestartTitle(title);
}

function buildRestartHandoff(params: {
  handoffTitle: string;
  sourceSession: Session;
  sourceProvider?: ProviderName;
  sourceModel?: string;
  sourceProcess?: Process;
  compactAttempt?: RestartCompactAttempt;
  projectPath: string;
  reason?: string;
  omittedCount: number;
  transcript: string;
}): string {
  const {
    handoffTitle,
    sourceSession,
    sourceProvider,
    sourceModel,
    sourceProcess,
    compactAttempt,
    projectPath,
    reason,
    omittedCount,
    transcript,
  } = params;
  const oldProcessLine = sourceProcess
    ? `- Previous YA process: ${sourceProcess.id} (${sourceProcess.state.type})`
    : "- Previous YA process: none active";
  const omittedLine =
    omittedCount > 0
      ? `\n${omittedCount} older rendered messages were omitted to keep this restart handoff bounded.`
      : "";
  const queuedMessages = getRestartQueuedMessages(sourceProcess);
  const queuedSection =
    queuedMessages.length > 0
      ? [
          "## Queued User Turns (Not Yet Processed)",
          "",
          "These user turns were accepted by YA's deferred queue after the source transcript. No agent response in the source session has processed them yet.",
          "",
          queuedMessages.map(formatRestartQueuedMessage).join("\n\n"),
        ].join("\n")
      : undefined;

  return [
    `# ${handoffTitle}`,
    "",
    "Yep Anywhere is starting this as a fresh agent session because the previous process became unhealthy or was manually restarted.",
    "Treat the transcript below as context, not as a new request to repeat. Prefer any provider-native compact summary when present, then use the recent user turns and summarized activity to continue the user's latest unresolved work after checking the live repository state.",
    "",
    "## Source Session",
    "",
    `- Session ID: ${sourceSession.id}`,
    `- Project path: ${projectPath}`,
    `- Provider: ${sourceProvider ?? sourceSession.provider}`,
    `- Model: ${sourceModel ?? sourceSession.model ?? "unknown"}`,
    oldProcessLine,
    compactAttempt
      ? `- Provider-native compact: ${describeRestartCompactAttempt(compactAttempt)}`
      : undefined,
    reason ? `- Restart reason: ${reason}` : undefined,
    "",
    "## Recent Transcript",
    omittedLine,
    transcript || "[No textual transcript was available.]",
    queuedSection,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function isRestartReplacementActivity(message: SDKMessage): boolean {
  return message.type === "assistant";
}

/**
 * Convert SDK messages to client Message format.
 * Used for mock SDK sessions where messages aren't persisted to disk.
 */
function sdkMessagesToClientMessages(sdkMessages: SDKMessage[]): Message[] {
  const messages: Message[] = [];
  for (const msg of sdkMessages) {
    if (isCompactBoundaryMessage(msg)) {
      const content =
        (typeof msg.message?.content === "string"
          ? msg.message.content
          : undefined) ??
        (typeof msg.content === "string" ? msg.content : "Context compacted");
      messages.push({
        id: msg.uuid ?? `msg-${Date.now()}-${messages.length}`,
        type: "system",
        role: "system",
        subtype: "compact_boundary",
        content,
        message: { role: "system", content },
        timestamp:
          typeof msg.timestamp === "string" && msg.timestamp.trim().length > 0
            ? msg.timestamp
            : new Date().toISOString(),
      });
      continue;
    }

    // Only include user and assistant messages with content
    if (
      (msg.type === "user" || msg.type === "assistant") &&
      msg.message?.content
    ) {
      const rawContent = msg.message.content;
      // Both user and assistant messages can have string or array content.
      // User messages with tool_result blocks have array content that must be preserved.
      // Assistant messages need ContentBlock[] format for preprocessMessages to render.
      let content: string | ContentBlock[];
      if (typeof rawContent === "string") {
        // String content: keep as-is for user messages, wrap in text block for assistant
        content =
          msg.type === "user"
            ? rawContent
            : [{ type: "text" as const, text: rawContent }];
      } else if (Array.isArray(rawContent)) {
        // Array content: pass through as ContentBlock[] for both user and assistant
        content = rawContent as ContentBlock[];
      } else {
        // Unknown content type - skip this message
        continue;
      }

      messages.push({
        id: msg.uuid ?? `msg-${Date.now()}-${messages.length}`,
        type: msg.type,
        role: msg.type as "user" | "assistant",
        content,
        timestamp:
          typeof msg.timestamp === "string" && msg.timestamp.trim().length > 0
            ? msg.timestamp
            : new Date().toISOString(),
      });
    }
  }
  return messages;
}

/**
 * Compute compaction overhead from SDK messages.
 * Same logic as computeCompactionOverhead in reader.ts but for SDKMessage type.
 */
function computeSDKCompactionOverhead(sdkMessages: SDKMessage[]): number {
  // Find the last compact_boundary with compactMetadata
  let lastCompactIdx = -1;
  let preTokens = 0;

  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg?.type === "system" && msg.subtype === "compact_boundary") {
      const metadata = (msg as { compactMetadata?: { preTokens?: number } })
        .compactMetadata;
      if (metadata?.preTokens) {
        lastCompactIdx = i;
        preTokens = metadata.preTokens;
        break;
      }
    }
  }

  if (lastCompactIdx === -1) return 0;

  // Find last assistant message before compaction with non-zero usage
  for (let i = lastCompactIdx - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg?.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      const total =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (total > 0) {
        const overhead = preTokens - total;
        return overhead > 0 ? overhead : 0;
      }
    }
  }

  return 0;
}

/**
 * Extract context usage from SDK messages.
 * Finds the last assistant message with usage data.
 *
 * @param sdkMessages - SDK messages to search
 * @param model - Model ID for determining context window size
 * @param provider - Provider for model-less context-window fallback
 */
function extractContextUsageFromSDKMessages(
  sdkMessages: SDKMessage[],
  model: string | undefined,
  provider?: ProviderName,
  resolveContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number,
): ContextUsage | undefined {
  const contextWindowSize = resolveContextWindow
    ? resolveContextWindow(model, provider)
    : getModelContextWindow(model, provider);

  const isCodexProvider = provider === "codex" || provider === "codex-oss";

  // Compute compaction overhead for Claude sessions
  const overhead = isCodexProvider
    ? 0
    : computeSDKCompactionOverhead(sdkMessages);

  // Find the last assistant message with usage data (iterate backwards)
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg && msg.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      // Codex context meter is based on fresh input tokens from the latest turn.
      // Claude/OpenCode/Gemini paths continue to include cached+creation tokens.
      const rawInputTokens = isCodexProvider
        ? (usage.input_tokens ?? 0)
        : (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);

      // Skip messages with zero input tokens (incomplete streaming messages)
      if (rawInputTokens === 0) {
        continue;
      }

      // Apply compaction overhead correction
      const inputTokens = rawInputTokens + overhead;

      const percentage = Math.round((inputTokens / contextWindowSize) * 100);

      const result: ContextUsage = {
        inputTokens,
        percentage,
        contextWindow: contextWindowSize,
      };

      // Add optional fields if available
      if (usage.output_tokens !== undefined && usage.output_tokens > 0) {
        result.outputTokens = usage.output_tokens;
      }
      if (isCodexProvider) {
        if (
          usage.cached_input_tokens !== undefined &&
          usage.cached_input_tokens > 0
        ) {
          result.cacheReadTokens = usage.cached_input_tokens;
        }
      } else if (
        usage.cache_read_input_tokens !== undefined &&
        usage.cache_read_input_tokens > 0
      ) {
        result.cacheReadTokens = usage.cache_read_input_tokens;
      }
      if (
        usage.cache_creation_input_tokens !== undefined &&
        usage.cache_creation_input_tokens > 0
      ) {
        result.cacheCreationTokens = usage.cache_creation_input_tokens;
      }

      return result;
    }
  }
  return undefined;
}

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const routes = new Hono();
  const getCodexReader = (projectPath: string): CodexSessionReader | null =>
    deps.codexReaderFactory?.(projectPath) ??
    (deps.codexSessionsDir
      ? new CodexSessionReader({
          sessionsDir: deps.codexSessionsDir,
          projectPath,
        })
      : null);

  const getGrokReader = (projectPath: string): GrokSessionReader | null =>
    deps.grokReaderFactory?.(projectPath) ??
    (deps.grokSessionsDir
      ? new GrokSessionReader({
          sessionsDir: deps.grokSessionsDir,
          projectPath,
        })
      : null);

  let unscopedGrokReader: GrokSessionReader | null | undefined;
  const getUnscopedGrokReader = (): GrokSessionReader | null => {
    if (unscopedGrokReader !== undefined) {
      return unscopedGrokReader;
    }
    unscopedGrokReader = deps.grokSessionsDir
      ? new GrokSessionReader({ sessionsDir: deps.grokSessionsDir })
      : null;
    return unscopedGrokReader;
  };

  const getGrokNativeProjectId = async (
    sessionId: string,
    currentProjectId: UrlProjectId,
  ): Promise<UrlProjectId | null> => {
    const reader = getUnscopedGrokReader();
    if (!reader) {
      return null;
    }
    const projectPath = await reader.getSessionProjectPath(sessionId);
    if (!projectPath) {
      return null;
    }
    const canonicalProjectId = encodeProjectId(projectPath);
    return canonicalProjectId === currentProjectId ? null : canonicalProjectId;
  };

  const buildGrokNativeRedirectPath = (
    canonicalProjectId: UrlProjectId,
    sessionId: string,
    suffix: "" | "/metadata",
    requestUrl: string,
  ): string => {
    const search = new URL(requestUrl).search;
    return `/api/projects/${canonicalProjectId}/sessions/${encodeURIComponent(
      sessionId,
    )}${suffix}${search}`;
  };

  const getGlobalInstructions = (): string | undefined =>
    deps.serverSettingsService?.getSetting("globalInstructions") || undefined;

  const persistLaunchMetadata = async (
    sessionId: string,
    provider: ProviderName | undefined,
    executor: string | undefined,
    initialPrompt?: string,
  ): Promise<void> => {
    if (!deps.sessionMetadataService) {
      return;
    }
    if (provider) {
      await deps.sessionMetadataService.setProvider(sessionId, provider);
    }
    if (executor) {
      await deps.sessionMetadataService.setExecutor(sessionId, executor);
    }
    if (initialPrompt?.trim()) {
      await deps.sessionMetadataService.setInitialPrompt(
        sessionId,
        initialPrompt,
      );
    }
  };

  const loadRestartSourceSession = async (
    project: Project,
    sessionId: string,
    projectId: UrlProjectId,
    preferredProvider?: ProviderName,
    process?: Process,
  ): Promise<Session | null> => {
    const resolved = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      projectId,
      {
        readerFactory: deps.readerFactory,
        codexSessionsDir: deps.codexSessionsDir,
        codexReaderFactory: deps.codexReaderFactory,
        geminiSessionsDir: deps.geminiSessionsDir,
        geminiReaderFactory: deps.geminiReaderFactory,
        geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
        grokSessionsDir: deps.grokSessionsDir,
        grokReaderFactory: deps.grokReaderFactory,
      },
      preferredProvider,
    );

    if (resolved) {
      const loaded = await resolved.source.reader.getSession(
        sessionId,
        projectId,
        undefined,
        { includeOrphans: false },
      );
      if (loaded) {
        return normalizeSession(loaded);
      }
    }

    if (process) {
      const messages = sdkMessagesToClientMessages(process.getMessageHistory());
      return {
        id: sessionId,
        projectId,
        title: null,
        fullTitle: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: messages.length,
        ownership: {
          owner: "self",
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        },
        provider: process.provider,
        model: process.resolvedModel ?? process.model,
        messages,
      };
    }

    return null;
  };

  const interruptOldProcessForHandoff = async (
    oldProcess: Process | undefined,
  ): Promise<boolean> => {
    if (!oldProcess) {
      return false;
    }
    try {
      const result = await deps.supervisor.interruptProcess(oldProcess.id);
      return result.success;
    } catch (error) {
      console.warn(
        `[restart] Failed to interrupt old process ${oldProcess.id}:`,
        error,
      );
      return false;
    }
  };

  const abortOldProcessAfterReplacementActivity = (
    oldProcess: Process | undefined,
    replacement: Process,
  ): boolean => {
    if (!oldProcess || oldProcess.id === replacement.id) {
      return false;
    }

    let unsubscribe: (() => void) | null = null;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      unsubscribe = null;
    };

    unsubscribe = replacement.subscribe((event) => {
      if (event.type === "message" && isRestartReplacementActivity(event.message)) {
        cleanup();
        void deps.supervisor.abortProcess(oldProcess.id).catch((error) => {
          console.warn(
            `[restart] Failed to abort old process ${oldProcess.id}:`,
            error,
          );
        });
        return;
      }

      if (
        event.type === "terminated" ||
        event.type === "complete" ||
        event.type === "error"
      ) {
        cleanup();
      }
    });

    return true;
  };

  const ensureDetachedProjectPath = async (
    executor?: string,
  ): Promise<string> => {
    await mkdir(DETACHED_PROJECT_PATH, { recursive: true });
    if (executor) {
      await ensureRemoteDirectory(executor, DETACHED_PROJECT_PATH);
    }
    return DETACHED_PROJECT_PATH;
  };

  // GET /api/projects/:projectId/sessions/:sessionId/agents - Get agent mappings
  // Used to find agent sessions for pending Tasks on page reload
  routes.get("/projects/:projectId/sessions/:sessionId/agents", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const reader = deps.readerFactory(project);
    const mappings = await reader.getAgentMappings();

    return c.json({ mappings });
  });

  // GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId - Get agent session content
  // Used for lazy-loading completed Tasks
  routes.get(
    "/projects/:projectId/sessions/:sessionId/agents/:agentId",
    async (c) => {
      const projectId = c.req.param("projectId");
      const agentId = c.req.param("agentId");

      // Validate projectId format at API boundary
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json({ error: "Project not found" }, 404);
      }

      const reader = deps.readerFactory(project);
      const agentSession = await reader.getAgentSession(agentId);

      if (!agentSession) {
        return c.json({ error: "Agent session not found" }, 404);
      }

      // Add server-rendered HTML to text blocks for markdown display
      await augmentTextBlocks(agentSession.messages);

      return c.json(agentSession);
    },
  );

  // GET /api/projects/:projectId/sessions/:sessionId/metadata - Get session metadata only (no messages)
  // Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages
  routes.get("/projects/:projectId/sessions/:sessionId/metadata", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Determine the session ownership
    const ownership: SessionOwnership = process
      ? {
          owner: "self" as const,
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        }
      : isExternal
        ? { owner: "external" as const }
        : { owner: "none" as const };

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;

    // Get pending input request from active process
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;

    // Get available slash commands from active process
    const slashCommands = process?.supportsDynamicCommands
      ? await process.supportedCommands()
      : null;

    // Read minimal session info from disk (just for title/timestamps, no messages)
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const sessionSummaryResult = await findSessionSummaryAcrossProviders(
      project,
      sessionId,
      projectId as UrlProjectId,
      {
        readerFactory: deps.readerFactory,
        codexSessionsDir: deps.codexSessionsDir,
        codexReaderFactory: deps.codexReaderFactory,
        geminiSessionsDir: deps.geminiSessionsDir,
        geminiReaderFactory: deps.geminiReaderFactory,
        geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
        grokSessionsDir: deps.grokSessionsDir,
        grokReaderFactory: deps.grokReaderFactory,
      },
      metadataProvider ?? process?.provider,
    );
    const sessionSummary = sessionSummaryResult?.summary ?? null;

    if (!sessionSummary && !process) {
      const canonicalProjectId = await getGrokNativeProjectId(
        sessionId,
        projectId as UrlProjectId,
      );
      if (canonicalProjectId) {
        return c.redirect(
          buildGrokNativeRedirectPath(
            canonicalProjectId,
            sessionId,
            "/metadata",
            c.req.url,
          ),
          307,
        );
      }
      return c.json({ error: "Session not found" }, 404);
    }

    // Calculate hasUnread if we have session summary
    const hasUnread =
      deps.notificationService && sessionSummary
        ? deps.notificationService.hasUnread(
            sessionId,
            sessionSummary.updatedAt,
          )
        : undefined;

    const response = {
      session: {
        id: sessionId,
        projectId: projectId as UrlProjectId,
        title: sessionSummary?.title ?? null,
        fullTitle: sessionSummary?.fullTitle ?? null,
        createdAt: sessionSummary?.createdAt ?? new Date().toISOString(),
        updatedAt: sessionSummary?.updatedAt ?? new Date().toISOString(),
        messageCount: sessionSummary?.messageCount ?? 0,
        provider:
          sessionSummary?.provider ??
          metadataProvider ??
          process?.provider ??
          project.provider,
        model: sessionSummary?.model,
        originator: sessionSummary?.originator,
        cliVersion: sessionSummary?.cliVersion,
        source: sessionSummary?.source,
        approvalPolicy: sessionSummary?.approvalPolicy,
        sandboxPolicy: sessionSummary?.sandboxPolicy,
        contextUsage: sessionSummary?.contextUsage,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        parentSessionId:
          metadata?.parentSessionId ?? sessionSummary?.parentSessionId,
        initialPrompt:
          metadata?.initialPrompt ?? sessionSummary?.fullTitle ?? undefined,
        heartbeatTurnsEnabled: metadata?.heartbeatTurnsEnabled,
        heartbeatTurnsAfterMinutes: metadata?.heartbeatTurnsAfterMinutes,
        heartbeatTurnText: metadata?.heartbeatTurnText,
        heartbeatForceAfterMinutes:
          metadata?.heartbeatForceAfterMinutes ?? undefined,
        lastSeenAt,
        hasUnread,
      },
      ownership,
      processState: process?.state.type ?? null,
      pendingInputRequest,
      slashCommands,
    } satisfies SessionMetadataResponse;

    return c.json(response);
  });

  // GET /api/projects/:projectId/sessions/:sessionId - Get session detail
  // Optional query params:
  //   ?afterMessageId=<id> - incremental forward-fetch (append new messages)
  //   ?tailCompactions=<n> - return only last N compact boundaries worth of messages
  //   ?beforeMessageId=<id> - cursor for loading older chunks (used with tailCompactions)
  //   ?tailTurns=<n> - aggressive opt-in client memory cap by recent user turns
  //   ?tailFrom=<id> - aggressive opt-in client memory cap from a user message id
  routes.get("/projects/:projectId/sessions/:sessionId", async (c) => {
    const requestStartMs = performance.now();
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");
    const afterMessageId = c.req.query("afterMessageId");
    const publicShare = c.req.query("publicShare") === "1";
    const tailCompactionsParam = c.req.query("tailCompactions");
    const beforeMessageId = c.req.query("beforeMessageId");
    const tailTurnsParam = c.req.query("tailTurns");
    const tailFrom = c.req.query("tailFrom");
    const tailCompactions =
      tailCompactionsParam !== undefined
        ? Number.parseInt(tailCompactionsParam, 10)
        : undefined;
    const tailTurns =
      tailTurnsParam !== undefined
        ? Number.parseInt(tailTurnsParam, 10)
        : undefined;

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to support Codex projects that may not be in the scan cache yet
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const projectResolvedMs = performance.now();

    // Check if session is actively owned by a process
    const process = deps.supervisor.getProcessForSession(sessionId);

    // Check if session is being controlled by an external program
    const isExternal = deps.externalTracker?.isExternal(sessionId) ?? false;

    // Check if we've ever owned this session (for orphan detection)
    // Only mark tools as "aborted" if we owned the session and know it terminated
    const wasEverOwned = deps.supervisor.wasEverOwned(sessionId);

    // Always try to read from disk first (even for owned sessions)
    const reader = deps.readerFactory(project);
    let loadedSession = await reader.getSession(
      sessionId,
      project.id,
      afterMessageId,
      {
        // Only include orphaned tool info if:
        // 1. We previously owned this session (not external)
        // 2. No active process (tools aren't potentially in progress)
        // When we own the session, tools without results might be pending approval
        includeOrphans: wasEverOwned && !process,
      },
    );

    // For Claude projects, also check for Codex sessions if primary reader didn't find it
    // This handles mixed projects that have sessions from multiple providers
    if (
      !loadedSession &&
      project.provider === "claude" &&
      (deps.codexReaderFactory || deps.codexSessionsDir)
    ) {
      const codexReader =
        deps.codexReaderFactory?.(project.path) ??
        (deps.codexSessionsDir
          ? new CodexSessionReader({
              sessionsDir: deps.codexSessionsDir,
              projectPath: project.path,
            })
          : null);
      if (codexReader) {
        loadedSession = await codexReader.getSession(
          sessionId,
          project.id,
          afterMessageId,
          { includeOrphans: wasEverOwned && !process },
        );
      }
    }

    // For Claude/Codex projects, also check for Gemini sessions if still not found
    // This handles mixed projects that have sessions from multiple providers
    if (
      !loadedSession &&
      (project.provider === "claude" || project.provider === "codex") &&
      (deps.geminiReaderFactory || deps.geminiSessionsDir)
    ) {
      const geminiReader =
        deps.geminiReaderFactory?.(project.path) ??
        (deps.geminiSessionsDir
          ? new GeminiSessionReader({
              sessionsDir: deps.geminiSessionsDir,
              projectPath: project.path,
              hashToCwd: deps.geminiScanner?.getHashToCwd(),
            })
          : null);
      if (geminiReader) {
        loadedSession = await geminiReader.getSession(
          sessionId,
          project.id,
          afterMessageId,
          { includeOrphans: wasEverOwned && !process },
        );
      }
    }

    if (!loadedSession) {
      const grokReader = getGrokReader(project.path);
      if (grokReader) {
        loadedSession = await grokReader.getSession(
          sessionId,
          project.id,
          afterMessageId,
          { includeOrphans: wasEverOwned && !process },
        );
      }
    }

    const readEndMs = performance.now();

    let session = loadedSession ? normalizeSession(loadedSession) : null;
    const normalizedMessageCount = session?.messages.length ?? 0;
    const normalizeEndMs = performance.now();
    let incrementalAnchorFound = false;
    if (session && afterMessageId) {
      const sliced = sliceAfterMessageIdWithMatch(
        session.messages,
        afterMessageId,
      );
      session = {
        ...session,
        messages: sliced.messages,
      };
      incrementalAnchorFound = sliced.found;
    }

    // Determine the session ownership
    const ownership = process
      ? {
          owner: "self" as const,
          processId: process.id,
          permissionMode: process.permissionMode,
          modeVersion: process.modeVersion,
        }
      : isExternal
        ? { owner: "external" as const }
        : (session?.ownership ?? { owner: "none" as const });

    // Get pending input request from active process (for tool approval prompts)
    // This ensures clients get pending requests immediately without waiting for SSE
    const pendingInputRequest =
      process?.state.type === "waiting-input" ? process.state.request : null;

    // Get available slash commands from active process (for "/" button in toolbar)
    // The init message that normally carries these gets discarded from the SSE buffer
    // after ~30s, so we attach them to the REST response for reliable delivery.
    const slashCommands = process?.supportsDynamicCommands
      ? await process.supportedCommands()
      : null;

    if (!session) {
      // Session file doesn't exist yet - only valid if we own the process
      if (process) {
        // Get raw messages from process memory
        const sdkMessages = process.getMessageHistory();
        // Convert to client format
        const processMessages = sdkMessagesToClientMessages(sdkMessages);
        // Extract context usage from raw SDK messages (has usage field)
        // Use process.contextWindow (captured from result messages) as primary source
        const mis = deps.modelInfoService;
        const sdkContextWindow = process.contextWindow;
        const contextUsage = extractContextUsageFromSDKMessages(
          sdkMessages,
          process.resolvedModel,
          process.provider,
          sdkContextWindow
            ? () => sdkContextWindow
            : mis
              ? (m, p) => mis.getContextWindow(m, p)
              : undefined,
        );
        // Cache SDK-reported context window for future JSONL reads
        if (mis && sdkContextWindow && process.resolvedModel) {
          mis.recordContextWindow(
            process.resolvedModel,
            sdkContextWindow,
            process.provider,
          );
        }
        // Get metadata even for new sessions (in case it was set before file was written)
        const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
        // Get notification data for new sessions too
        const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
        const newSessionUpdatedAt = new Date().toISOString();
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(sessionId, newSessionUpdatedAt)
          : undefined;
        return c.json({
          session: {
            id: sessionId,
            projectId,
            title: null,
            createdAt: new Date().toISOString(),
            updatedAt: newSessionUpdatedAt,
            messageCount: processMessages.length,
            ownership,
            customTitle: metadata?.customTitle,
            isArchived: metadata?.isArchived,
            isStarred: metadata?.isStarred,
            parentSessionId: metadata?.parentSessionId,
            initialPrompt: metadata?.initialPrompt,
            heartbeatTurnsEnabled: metadata?.heartbeatTurnsEnabled,
            heartbeatTurnsAfterMinutes: metadata?.heartbeatTurnsAfterMinutes,
            heartbeatTurnText: metadata?.heartbeatTurnText,
            heartbeatForceAfterMinutes: metadata?.heartbeatForceAfterMinutes,
            lastSeenAt: lastSeenEntry?.timestamp,
            hasUnread,
            provider: process.provider,
            model: process.resolvedModel,
            contextUsage,
          },
          messages: processMessages,
          ownership,
          pendingInputRequest,
          slashCommands,
        });
      }
      const canonicalProjectId = await getGrokNativeProjectId(
        sessionId,
        projectId as UrlProjectId,
      );
      if (canonicalProjectId) {
        return c.redirect(
          buildGrokNativeRedirectPath(
            canonicalProjectId,
            sessionId,
            "",
            c.req.url,
          ),
          307,
        );
      }
      return c.json({ error: "Session not found" }, 404);
    }

    // Get session metadata (custom title, archived, starred)
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);

    // Get notification data (lastSeenAt, hasUnread)
    const lastSeenEntry = deps.notificationService?.getLastSeen(sessionId);
    const lastSeenAt = lastSeenEntry?.timestamp;
    const hasUnread = deps.notificationService
      ? deps.notificationService.hasUnread(sessionId, session.updatedAt)
      : undefined;

    // Apply pagination if requested (BEFORE expensive augmentation). tailTurns
    // is an opt-in stronger client memory cap, so it wins over compact tails.
    // Skip both when afterMessageId is present since that's an incremental
    // forward-fetch use case.
    let paginationInfo: PaginationInfo | undefined;
    if (
      !afterMessageId &&
      (tailFrom ||
        (tailTurns !== undefined && !Number.isNaN(tailTurns) && tailTurns > 0))
    ) {
      const sliced = sliceAtUserTurnBoundary(
        session.messages,
        tailTurns !== undefined && !Number.isNaN(tailTurns) && tailTurns > 0
          ? tailTurns
          : 20,
        tailFrom,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    } else if (
      tailCompactions !== undefined &&
      !Number.isNaN(tailCompactions) &&
      tailCompactions > 0 &&
      !afterMessageId
    ) {
      const sliced = sliceAtCompactBoundaries(
        session.messages,
        tailCompactions,
        beforeMessageId,
      );
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    }
    const sliceEndMs = performance.now();

    // Codex normalized IDs can drift between stream and JSONL. If an
    // incremental request misses its anchor, never return the full historical
    // session into a compact-tail client; bound the fallback to the same tail
    // window used for initial loads.
    if (afterMessageId && !incrementalAnchorFound) {
      const sliced = sliceAtCompactBoundaries(session.messages, 2);
      session = { ...session, messages: sliced.messages };
      paginationInfo = sliced.pagination;
    }

    // Keep persisted rendering in lockstep with stream augmentation behavior.
    if (!publicShare) {
      await augmentPersistedSessionMessages(session.messages);
    }
    const augmentEndMs = performance.now();

    // Override context usage with SDK-reported context window from live process
    // The reader uses hardcoded defaults; the process captures the real value at runtime
    let { contextUsage } = session;
    if (process?.contextWindow && contextUsage) {
      const cw = process.contextWindow;
      contextUsage = {
        ...contextUsage,
        percentage: Math.round((contextUsage.inputTokens / cw) * 100),
        contextWindow: cw,
      };
      // Cache for future reads without a live process
      deps.modelInfoService?.recordContextWindow(
        process.resolvedModel ?? session.model ?? "",
        cw,
        process.provider,
      );
    }

    const { messages: _messages, ...sessionMetadata } = session;
    const totalMs = performance.now() - requestStartMs;
    if (totalMs >= SESSION_DETAIL_SLOW_LOG_MS) {
      getLogger().warn(
        {
          afterMessageId: afterMessageId ?? null,
          beforeMessageId: beforeMessageId ?? null,
          event: "session_detail_slow",
          incrementalAnchorFound: afterMessageId
            ? incrementalAnchorFound
            : null,
          normalizedMessageCount,
          owned: Boolean(process),
          processState: process?.state.type ?? null,
          projectId,
          provider: session.provider,
          publicShare,
          returnedMessageCount: session.messages.length,
          sessionId,
          tailCompactions: tailCompactions ?? null,
          tailTurns: tailTurns ?? null,
          timings: {
            augmentMs: roundedMs(augmentEndMs - sliceEndMs),
            normalizeMs: roundedMs(normalizeEndMs - readEndMs),
            projectMs: roundedMs(projectResolvedMs - requestStartMs),
            readMs: roundedMs(readEndMs - projectResolvedMs),
            routeMs: roundedMs(sliceEndMs - normalizeEndMs),
            totalMs: roundedMs(totalMs),
          },
          totalMessageCount: session.messageCount,
        },
        "SESSION_DETAIL: slow request",
      );
    }

    return c.json({
      session: {
        ...sessionMetadata,
        ownership,
        contextUsage,
        customTitle: metadata?.customTitle,
        isArchived: metadata?.isArchived,
        isStarred: metadata?.isStarred,
        parentSessionId: metadata?.parentSessionId ?? session.parentSessionId,
        initialPrompt: metadata?.initialPrompt ?? session.fullTitle,
        heartbeatTurnsEnabled: metadata?.heartbeatTurnsEnabled,
        heartbeatTurnsAfterMinutes: metadata?.heartbeatTurnsAfterMinutes,
        heartbeatTurnText: metadata?.heartbeatTurnText,
        heartbeatForceAfterMinutes: metadata?.heartbeatForceAfterMinutes,
        // Model comes from the session reader (extracted from JSONL)
        model: session.model,
        lastSeenAt,
        hasUnread,
      },
      messages: session.messages,
      ownership,
      pendingInputRequest,
      slashCommands,
      ...(paginationInfo && { pagination: paginationInfo }),
    });
  });

  // POST /api/projects/:projectId/sessions - Start new session
  routes.post("/projects/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow starting sessions in new directories
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(body, serverTimestamp, "direct"),
    };

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    // Debug: log what we received
    console.log("[startSession] Request body:", {
      provider: body.provider,
      executor,
      model: body.model,
      serviceTier,
    });

    const result = await deps.supervisor.startSession(
      project.path,
      userMessage,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
    );

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(
        { ...result, serverTimestamp },
        202,
      ); // 202 Accepted - queued for processing
    }

    await persistLaunchMetadata(
      result.sessionId,
      body.provider,
      executor,
      body.message,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      serverTimestamp,
    });
  });

  // POST /api/projects/:projectId/sessions/create - Create session without starting agent
  // Used for two-phase flow: create session first, upload files, then send first message
  routes.post("/projects/:projectId/sessions/create", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow starting sessions in new directories
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: CreateSessionBody = {};
    try {
      body = await c.req.json<CreateSessionBody>();
    } catch {
      // Body is optional for this endpoint
    }

    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const result = await deps.supervisor.createSession(
      project.path,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
    );

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(
        { ...result, serverTimestamp: Date.now() },
        202,
      ); // 202 Accepted - queued for processing
    }

    await persistLaunchMetadata(result.sessionId, body.provider, executor);

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      serverTimestamp: Date.now(),
    });
  });

  // POST /api/sessions - Start a detached new session under the hidden No Project workspace
  routes.post("/sessions", async (c) => {
    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    const projectPath = await ensureDetachedProjectPath(executor);
    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(body, serverTimestamp, "direct"),
    };

    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const result = await deps.supervisor.startSession(
      projectPath,
      userMessage,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
    );

    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    if (isQueuedResponse(result)) {
      return c.json(
        { ...result, serverTimestamp: Date.now() },
        202,
      );
    }

    await persistLaunchMetadata(
      result.sessionId,
      body.provider,
      executor,
      body.message,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      serverTimestamp,
    });
  });

  // POST /api/sessions/create - Create a detached session without sending an initial message
  routes.post("/sessions/create", async (c) => {
    let body: CreateSessionBody = {};
    try {
      body = await c.req.json<CreateSessionBody>();
    } catch {
      // Body is optional for this endpoint
    }

    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    const projectPath = await ensureDetachedProjectPath(executor);
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const result = await deps.supervisor.createSession(
      projectPath,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: body.provider,
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
    );

    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    if (isQueuedResponse(result)) {
      return c.json(
        { ...result, serverTimestamp: Date.now() },
        202,
      );
    }

    await persistLaunchMetadata(result.sessionId, body.provider, executor);

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      serverTimestamp: Date.now(),
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/resume - Resume session
  routes.post("/projects/:projectId/sessions/:sessionId/resume", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to allow resuming in directories that may have been moved
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: StartSessionBody;
    try {
      body = await c.req.json<StartSessionBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }
    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(body, serverTimestamp, "direct"),
    };

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    // Convert model option (undefined or "default" means use CLI default)
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    // Use client-provided executor, falling back to saved executor from metadata.
    let executor = parsedBodyExecutor.executor;
    if (!executor) {
      const parsedSavedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService?.getExecutor(sessionId),
      );
      if (parsedSavedExecutor.error) {
        return c.json({ error: parsedSavedExecutor.error }, 400);
      }
      executor = parsedSavedExecutor.executor;
    }

    // For remote sessions, sync local files TO remote before resuming
    // This ensures the remote has the latest session state
    if (executor) {
      const projectDir = getProjectDirFromCwd(project.path);
      const syncResult = await syncSessions({
        host: executor,
        projectDir,
        direction: "to-remote",
      });
      if (!syncResult.success) {
        console.warn(
          `[resume] Failed to pre-sync session to ${executor}: ${syncResult.error}`,
        );
        // Continue anyway - remote may have the files from before
      }

      // Save executor to metadata if not already saved (e.g. client provided it)
      if (deps.sessionMetadataService) {
        await deps.sessionMetadataService.setExecutor(sessionId, executor);
      }
    }

    const globalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;

    // Look up the session's original provider so we resume with the correct one
    // (e.g., claude-ollama sessions need the Ollama provider, not default Claude).
    // Check metadata first (explicitly saved on creation), then fall back to reader.
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;

    let providerName = metadataProvider ?? body.provider;
    if (!providerName) {
      const sessionSummaryResult = await findSessionSummaryAcrossProviders(
        project,
        sessionId,
        projectId as UrlProjectId,
        {
          readerFactory: deps.readerFactory,
          codexSessionsDir: deps.codexSessionsDir,
          codexReaderFactory: deps.codexReaderFactory,
          geminiSessionsDir: deps.geminiSessionsDir,
          geminiReaderFactory: deps.geminiReaderFactory,
          geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
          grokSessionsDir: deps.grokSessionsDir,
          grokReaderFactory: deps.grokReaderFactory,
        },
        metadataProvider ?? body.provider,
      );
      const sessionSummary = sessionSummaryResult?.summary ?? null;
      providerName =
        sessionSummary?.provider ??
        metadataProvider ??
        body.provider ??
        project.provider;
    }

    if (isClaudeSdkProviderName(providerName)) {
      let blocker: ClaudeResumeApiErrorBlocker | null = null;
      try {
        blocker = await getClaudeResumeBlockerFromReader(
          deps.readerFactory(project),
          sessionId,
          projectId,
        );
      } catch (error) {
        getLogger().warn(
          {
            event: "claude_resume_api_error_check_failed",
            sessionId,
            projectId,
            providerName,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to check Claude session for resume-blocking API error",
        );
      }

      if (blocker) {
        getLogger().warn(
          {
            event: "claude_resume_blocked_after_api_error",
            sessionId,
            projectId,
            providerName,
            messageId: blocker.messageId,
            apiErrorStatus: blocker.apiErrorStatus,
          },
          "Blocked Claude provider resume after SDK API-error message",
        );
        return c.json(
          {
            error: blocker.error,
            recovery: blocker.recovery,
          },
          409,
        );
      }
    }

    const result = await deps.supervisor.resumeSession(
      sessionId,
      project.path,
      userMessage,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName,
        executor,
        globalInstructions,
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
    );

    // Check if queue is full
    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    // Check if request was queued
    if (isQueuedResponse(result)) {
      return c.json(
        { ...result, serverTimestamp: Date.now() },
        202,
      ); // 202 Accepted - queued for processing
    }

    return c.json({
      processId: result.id,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      serverTimestamp,
    });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/restart
  // Start a fresh session from a bounded handoff, then terminate the old YA-owned process.
  routes.post("/projects/:projectId/sessions/:sessionId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found or path does not exist" }, 404);
    }

    let body: RestartSessionBody = {};
    try {
      body = await c.req.json<RestartSessionBody>();
    } catch {
      // Body is optional for this endpoint.
    }

    const parsedBodyExecutor = parseOptionalExecutor(body.executor);
    if (parsedBodyExecutor.error) {
      return c.json({ error: parsedBodyExecutor.error }, 400);
    }
    const helperSettings = parseHelperSettings(body);
    if (helperSettings.error) {
      return c.json({ error: helperSettings.error }, 400);
    }

    let executor = parsedBodyExecutor.executor;
    if (!executor) {
      const parsedSavedExecutor = parseOptionalExecutor(
        deps.sessionMetadataService?.getExecutor(sessionId),
      );
      if (parsedSavedExecutor.error) {
        return c.json({ error: parsedSavedExecutor.error }, 400);
      }
      executor = parsedSavedExecutor.executor;
    }

    const oldProcess = deps.supervisor.getProcessForSession(sessionId);
    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const preferredSourceProvider =
      metadataProvider ?? oldProcess?.provider ?? project.provider;
    const compactAttempt = await tryRestartCompact(oldProcess);
    const oldProcessInterrupted =
      await interruptOldProcessForHandoff(oldProcess);
    const sourceSession = await loadRestartSourceSession(
      project,
      sessionId,
      projectId,
      preferredSourceProvider,
      oldProcess,
    );

    if (!sourceSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    const sourceProvider = sourceSession.provider ?? preferredSourceProvider;
    const providerName = body.provider ?? sourceProvider;
    const originalMetadata = deps.sessionMetadataService?.getMetadata(sessionId);
    const handoffTitle = deriveRestartTitle({
      preferredTitle: originalMetadata?.customTitle,
      sourceSession,
    });
    const { transcript, omittedCount } = buildRestartTranscript(
      sourceSession.messages,
    );
    const handoff = buildRestartHandoff({
      handoffTitle,
      sourceSession,
      sourceProvider,
      sourceModel: oldProcess?.resolvedModel ?? sourceSession.model,
      sourceProcess: oldProcess,
      compactAttempt,
      projectPath: project.path,
      reason: body.reason,
      omittedCount,
      transcript,
    });

    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };
    const model =
      body.model && body.model !== "default" ? body.model : undefined;
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    const result = await deps.supervisor.startSession(
      project.path,
      {
        text: handoff,
        mode: body.mode,
      },
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName,
        clientName: "yep-anywhere",
        executor,
        globalInstructions: getGlobalInstructions(),
        permissions: body.permissions,
        recapMode: helperSettings.recapMode,
        promptSuggestionMode: helperSettings.promptSuggestionMode,
        helperSideModel: helperSettings.helperSideModel,
      },
    );

    if (isQueueFullResponse(result)) {
      return c.json(
        { error: "Queue is full", maxQueueSize: result.maxQueueSize },
        503,
      );
    }

    if (isQueuedResponse(result)) {
      deps.supervisor.cancelQueuedRequest(result.queueId);
      return c.json(
        {
          error:
            "Restart could not start immediately; old process was left running",
        },
        503,
      );
    }

    await persistLaunchMetadata(result.sessionId, providerName, executor);
    if (deps.sessionMetadataService) {
      await deps.sessionMetadataService.updateMetadata(result.sessionId, {
        title: handoffTitle,
      });
      deps.eventBus?.emit({
        type: "session-metadata-changed",
        sessionId: result.sessionId,
        title: handoffTitle,
        timestamp: new Date().toISOString(),
      });
    }

    const oldProcessAbortDeferred = abortOldProcessAfterReplacementActivity(
      oldProcess,
      result,
    );

    return c.json({
      sessionId: result.sessionId,
      processId: result.id,
      projectId: result.projectId,
      provider: result.provider,
      model: result.resolvedModel ?? result.model,
      title: handoffTitle,
      permissionMode: result.permissionMode,
      modeVersion: result.modeVersion,
      restartedFrom: sessionId,
      oldProcessId: oldProcess?.id,
      oldProcessInterrupted,
      oldProcessAbortDeferred,
      oldProcessAborted: false,
    });
  });

  // POST /api/sessions/:sessionId/messages - Queue message
  routes.post("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    let body: StartSessionBody & { deferred?: boolean };
    try {
      body = await c.req.json<StartSessionBody & { deferred?: boolean }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }

    const serverTimestamp = Date.now();
    const userMessage: UserMessage = {
      text: body.message,
      images: body.images,
      documents: body.documents,
      attachments: body.attachments,
      mode: body.mode,
      tempId: body.tempId,
      metadata: buildUserMessageMetadata(
        body,
        serverTimestamp,
        body.deferred ? "deferred" : "direct",
      ),
    };

    // Check if process is terminated
    if (process.isTerminated) {
      return c.json(
        {
          error: "Process terminated",
          reason: process.terminationReason,
        },
        410,
      ); // 410 Gone
    }

    const resolvedModel = body.model && body.model !== "default"
      ? body.model
      : process.resolvedModel ?? process.model;
    const modelInfoService = deps.modelInfoService;
    const resolveContextWindow = modelInfoService
      ? (model: string | undefined, provider?: ProviderName) =>
          modelInfoService.getContextWindow(model, provider)
      : getModelContextWindow;

    let compactQueued = false;
    if (!body.deferred && !body.thinking && body.model === undefined) {
      const compactAttempt = await tryQueueTargetedAutoCompact({
        process,
        model: resolvedModel,
        message: body.message,
        resolveContextWindow,
      });
      compactQueued = compactAttempt.queued;
    }

    // Deferred messages stay server-side until Process reaches a safe delivery
    // boundary. If the process is already idle, Process can accept them now.
    if (body.deferred) {
      if (body.mode) {
        process.setPermissionMode(body.mode);
      }
      await process.primeSupportedCommandsForMessage(userMessage);
      const deferredResult = process.deferMessage(userMessage, {
        promoteIfReady: true,
        placement: parseDeferredPlacement(body),
      });
      if (!deferredResult.success) {
        return c.json(
          {
            error: "Failed to queue message",
            reason: deferredResult.error,
          },
          410,
        );
      }
      return c.json({
        queued: true,
        deferred: deferredResult.deferred,
        promoted: deferredResult.promoted,
        position: deferredResult.position,
        deferredMessages: process.getDeferredQueueSummary(),
        serverTimestamp,
      });
    }

    // Convert thinking option to SDK config
    const { thinking, effort } = body.thinking
      ? thinkingOptionToConfig(body.thinking)
      : { thinking: undefined, effort: undefined };

    const metadataProvider = deps.sessionMetadataService?.getProvider(
      sessionId,
    ) as ProviderName | undefined;
    const metadataExecutor = parseOptionalExecutor(
      deps.sessionMetadataService?.getExecutor(sessionId),
    );
    if (metadataExecutor.error) {
      return c.json({ error: metadataExecutor.error }, 400);
    }
    const { executor, error: executorError } = parseOptionalExecutor(
      body.executor,
    );
    if (executorError) {
      return c.json({ error: executorError }, 400);
    }

    const model =
      body.model && body.model !== "default"
        ? body.model
        : (process.resolvedModel ?? process.model);
    const serviceTier = normalizeOptionalServiceTier(body.serviceTier);

    // Use queueMessageToSession which handles thinking mode changes
    // If thinking mode changed, it will restart the process automatically
    const queueGlobalInstructions =
      deps.serverSettingsService?.getSetting("globalInstructions") || undefined;
    const result = await deps.supervisor.queueMessageToSession(
      sessionId,
      process.projectPath,
      userMessage,
      body.mode,
      {
        model,
        serviceTier,
        thinking,
        effort,
        providerName: metadataProvider ?? body.provider ?? process.provider,
        executor:
          executor ??
          metadataExecutor.executor ??
          process.executor ??
          undefined,
        globalInstructions: queueGlobalInstructions,
        permissions: body.permissions,
      },
    );

    if (!result.success) {
      return c.json(
        {
          error: "Failed to queue message",
          reason: result.error,
        },
        410,
      ); // 410 Gone - process is no longer available
    }

    return c.json({
      queued: true,
      compactQueued,
      restarted: result.restarted,
      processId: result.process.id,
      serverTimestamp,
    });
  });

  // DELETE /api/sessions/:sessionId/deferred/:tempId - Cancel a deferred message
  routes.delete("/sessions/:sessionId/deferred/:tempId", (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const cancelled = process.cancelDeferredMessage(tempId);
    if (!cancelled) {
      return c.json({ error: "Deferred message not found" }, 404);
    }

    return c.json({ cancelled: true });
  });

  // POST /api/sessions/:sessionId/deferred/:tempId/edit - Take a deferred message for editing
  routes.post("/sessions/:sessionId/deferred/:tempId/edit", (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const taken = process.takeDeferredMessage(tempId);
    if (!taken) {
      return c.json({ error: "Deferred message not found" }, 404);
    }

    return c.json({
      message: taken.message.text,
      tempId: taken.message.tempId,
      mode: taken.message.mode,
      attachments: taken.message.attachments,
      placement: taken.placement,
    });
  });

  // POST /api/sessions/:sessionId/deferred/:tempId/edit/release - Release a queued edit barrier
  routes.post("/sessions/:sessionId/deferred/:tempId/edit/release", (c) => {
    const sessionId = c.req.param("sessionId");
    const tempId = c.req.param("tempId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    const released = process.releaseDeferredEditBarrier(tempId);
    return c.json({
      released,
      deferredMessages: process.getDeferredQueueSummary(),
    });
  });

  // PUT /api/sessions/:sessionId/mode - Update permission mode without sending a message
  routes.put("/sessions/:sessionId/mode", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ mode: PermissionMode }>();

    if (!body.mode) {
      return c.json({ error: "mode is required" }, 400);
    }

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    process.setPermissionMode(body.mode);

    return c.json({
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
    });
  });

  // GET /api/sessions/:sessionId/pending-input - Get pending input request
  routes.get("/sessions/:sessionId/pending-input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ request: null });
    }

    // Use getPendingInputRequest which works for both mock and real SDK
    const request = process.getPendingInputRequest();
    return c.json({ request });
  });

  // GET /api/sessions/:sessionId/process - Get process info for a session
  routes.get("/sessions/:sessionId/process", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ process: null });
    }

    return c.json({ process: process.getInfo() });
  });

  // POST /api/sessions/:sessionId/input - Respond to input request
  routes.post("/sessions/:sessionId/input", async (c) => {
    const sessionId = c.req.param("sessionId");

    const process = deps.supervisor.getProcessForSession(sessionId);
    if (!process) {
      return c.json({ error: "No active process for session" }, 404);
    }

    let body: InputResponseBody;
    try {
      body = await c.req.json<InputResponseBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.requestId || !body.response) {
      return c.json({ error: "requestId and response are required" }, 400);
    }

    // Handle approve_accept_edits: approve and switch permission mode
    const isApproveAcceptEdits = body.response === "approve_accept_edits";

    // Normalize response to approve/deny
    const normalizedResponse =
      body.response === "approve" ||
      body.response === "allow" ||
      body.response === "approve_accept_edits"
        ? "approve"
        : "deny";

    const requestBefore = process.getPendingInputRequest();
    const permissionModeBefore = process.permissionMode;

    if (process.state.type !== "waiting-input") {
      try {
        await appendApprovalAuditLog(deps.dataDir, {
          timestamp: new Date().toISOString(),
          sessionId,
          processId: process.id,
          provider: process.provider,
          requestId: body.requestId,
          request: requestBefore,
          response: body.response,
          normalizedResponse,
          answers: body.answers,
          feedback: body.feedback,
          accepted: false,
          failure: "No pending input request",
          permissionModeBefore,
          permissionModeAfter: process.permissionMode,
        });
      } catch (error) {
        console.warn("[approval-audit] Failed to append audit log:", error);
      }
      return c.json({ error: "No pending input request" }, 400);
    }

    // Call respondToInput which resolves the SDK's canUseTool promise
    const accepted = process.respondToInput(
      body.requestId,
      normalizedResponse,
      body.answers,
      body.feedback,
    );

    if (!accepted) {
      try {
        await appendApprovalAuditLog(deps.dataDir, {
          timestamp: new Date().toISOString(),
          sessionId,
          processId: process.id,
          provider: process.provider,
          requestId: body.requestId,
          request: requestBefore,
          response: body.response,
          normalizedResponse,
          answers: body.answers,
          feedback: body.feedback,
          accepted: false,
          failure: "Invalid request ID or no pending request",
          permissionModeBefore,
          permissionModeAfter: process.permissionMode,
        });
      } catch (error) {
        console.warn("[approval-audit] Failed to append audit log:", error);
      }
      return c.json({ error: "Invalid request ID or no pending request" }, 400);
    }

    // If approve_accept_edits, switch the permission mode
    if (isApproveAcceptEdits) {
      process.setPermissionMode("acceptEdits");
    }

    const pendingInputRequest = process.getPendingInputRequest();
    try {
      await appendApprovalAuditLog(deps.dataDir, {
        timestamp: new Date().toISOString(),
        sessionId,
        processId: process.id,
        provider: process.provider,
        requestId: body.requestId,
        request: requestBefore,
        response: body.response,
        normalizedResponse,
        answers: body.answers,
        feedback: body.feedback,
        accepted: true,
        permissionModeBefore,
        permissionModeAfter: process.permissionMode,
      });
    } catch (error) {
      console.warn("[approval-audit] Failed to append audit log:", error);
    }

    return c.json({ accepted: true, pendingInputRequest });
  });

  // POST /api/sessions/:sessionId/mark-seen - Mark session as seen (read)
  routes.post("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    let body: { timestamp?: string; messageId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    await deps.notificationService.markSeen(
      sessionId,
      body.timestamp,
      body.messageId,
    );

    return c.json({ marked: true });
  });

  // DELETE /api/sessions/:sessionId/mark-seen - Mark session as unread
  routes.delete("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    await deps.notificationService.clearSession(sessionId);

    // Emit event so other tabs/clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-seen",
        sessionId,
        timestamp: "", // Empty timestamp signals "unread"
      });
    }

    return c.json({ marked: false });
  });

  // GET /api/notifications/last-seen - Get all last seen entries
  routes.get("/notifications/last-seen", async (c) => {
    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    return c.json({ lastSeen: deps.notificationService.getAllLastSeen() });
  });

  // GET /api/debug/metadata - Debug endpoint to inspect metadata service state
  routes.get("/debug/metadata", (c) => {
    if (!deps.sessionMetadataService) {
      return c.json(
        { error: "Session metadata service not available", available: false },
        503,
      );
    }

    const allMetadata = deps.sessionMetadataService.getAllMetadata();
    const sessionCount = Object.keys(allMetadata).length;
    const starredCount = Object.values(allMetadata).filter(
      (m) => m.isStarred,
    ).length;
    const archivedCount = Object.values(allMetadata).filter(
      (m) => m.isArchived,
    ).length;
    const filePath = deps.sessionMetadataService.getFilePath();

    return c.json({
      available: true,
      filePath,
      sessionCount,
      starredCount,
      archivedCount,
    });
  });

  // PUT /api/sessions/:sessionId/metadata - Update session metadata
  routes.put("/sessions/:sessionId/metadata", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service not available" }, 503);
    }

    let body: {
      title?: string;
      archived?: boolean;
      starred?: boolean;
      parentSessionId?: string | null;
      heartbeatTurnsEnabled?: boolean;
      heartbeatTurnsAfterMinutes?: number | null;
      heartbeatTurnText?: string | null;
      heartbeatForceAfterMinutes?: number | null;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // At least one field must be provided
    if (
      body.title === undefined &&
      body.archived === undefined &&
      body.starred === undefined &&
      body.parentSessionId === undefined &&
      body.heartbeatTurnsEnabled === undefined &&
      body.heartbeatTurnsAfterMinutes === undefined &&
      body.heartbeatTurnText === undefined &&
      body.heartbeatForceAfterMinutes === undefined
    ) {
      return c.json(
        {
          error:
            "At least one session metadata field must be provided",
        },
        400,
      );
    }

    let heartbeatForceAfterMinutes: number | null | undefined;
    if (body.heartbeatForceAfterMinutes !== undefined) {
      if (
        body.heartbeatForceAfterMinutes === null ||
        body.heartbeatForceAfterMinutes === 0
      ) {
        heartbeatForceAfterMinutes = null;
      } else if (
        typeof body.heartbeatForceAfterMinutes === "number" &&
        Number.isInteger(body.heartbeatForceAfterMinutes) &&
        body.heartbeatForceAfterMinutes >= 1 &&
        body.heartbeatForceAfterMinutes <= 1440
      ) {
        heartbeatForceAfterMinutes = body.heartbeatForceAfterMinutes;
      } else {
        return c.json(
          {
            error:
              "heartbeatForceAfterMinutes must be null or an integer between 1 and 1440",
          },
          400,
        );
      }
    }

    let heartbeatTurnsAfterMinutes: number | null | undefined;
    if (body.heartbeatTurnsAfterMinutes !== undefined) {
      if (
        body.heartbeatTurnsAfterMinutes === null ||
        body.heartbeatTurnsAfterMinutes === 0
      ) {
        heartbeatTurnsAfterMinutes = null;
      } else if (
        typeof body.heartbeatTurnsAfterMinutes === "number" &&
        Number.isInteger(body.heartbeatTurnsAfterMinutes) &&
        body.heartbeatTurnsAfterMinutes >= 1 &&
        body.heartbeatTurnsAfterMinutes <= 1440
      ) {
        heartbeatTurnsAfterMinutes = body.heartbeatTurnsAfterMinutes;
      } else {
        return c.json(
          {
            error:
              "heartbeatTurnsAfterMinutes must be null or an integer between 1 and 1440",
          },
          400,
        );
      }
    }

    const heartbeatTurnText =
      body.heartbeatTurnText === undefined
        ? undefined
        : body.heartbeatTurnText === null || body.heartbeatTurnText === ""
          ? null
          : typeof body.heartbeatTurnText === "string"
            ? body.heartbeatTurnText.slice(0, 200)
            : null;

    if (
      body.heartbeatTurnText !== undefined &&
      body.heartbeatTurnText !== null &&
      body.heartbeatTurnText !== "" &&
      typeof body.heartbeatTurnText !== "string"
    ) {
      return c.json({ error: "heartbeatTurnText must be a string or null" }, 400);
    }

    if (
      body.parentSessionId !== undefined &&
      body.parentSessionId !== null &&
      typeof body.parentSessionId !== "string"
    ) {
      return c.json({ error: "parentSessionId must be a string or null" }, 400);
    }

    const parentSessionId =
      body.parentSessionId === undefined
        ? undefined
        : typeof body.parentSessionId === "string"
          ? body.parentSessionId.trim() || null
          : null;

    await deps.sessionMetadataService.updateMetadata(sessionId, {
      title: body.title,
      archived: body.archived,
      starred: body.starred,
      parentSessionId,
      heartbeatTurnsEnabled: body.heartbeatTurnsEnabled,
      heartbeatTurnsAfterMinutes,
      heartbeatTurnText,
      heartbeatForceAfterMinutes,
    });

    // Emit SSE event so sidebar and other clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-metadata-changed",
        sessionId,
        title: body.title,
        archived: body.archived,
        starred: body.starred,
        parentSessionId,
        heartbeatTurnsEnabled: body.heartbeatTurnsEnabled,
        heartbeatTurnsAfterMinutes,
        heartbeatTurnText,
        heartbeatForceAfterMinutes,
        timestamp: new Date().toISOString(),
      });
    }

    return c.json({ updated: true });
  });

  // POST /api/projects/:projectId/sessions/:sessionId/clone - Clone a session
  routes.post("/projects/:projectId/sessions/:sessionId/clone", async (c) => {
    const projectId = c.req.param("projectId");
    const sessionId = c.req.param("sessionId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Check provider supports cloning
    const supportedProviders = ["claude", "codex", "codex-oss"];
    if (!supportedProviders.includes(project.provider)) {
      return c.json(
        { error: `Clone is not supported for ${project.provider} sessions` },
        400,
      );
    }

    let body: {
      title?: string;
      provider?: ProviderName;
      parentSessionId?: string | null;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    if (
      body.parentSessionId !== undefined &&
      body.parentSessionId !== null &&
      typeof body.parentSessionId !== "string"
    ) {
      return c.json({ error: "parentSessionId must be a string or null" }, 400);
    }
    const parentSessionId =
      typeof body.parentSessionId === "string"
        ? body.parentSessionId.trim() || undefined
        : undefined;

    try {
      // Get session directory from project
      const sessionDir = project.sessionDir;
      if (!sessionDir) {
        return c.json({ error: "Session directory not found" }, 500);
      }

      // Get original session to extract title for the clone
      const reader = deps.readerFactory(project);
      let originalSession = await reader.getSessionSummary(
        sessionId,
        projectId,
      );
      let cloneProvider: ProviderName = project.provider;

      let result: { newSessionId: string; entries: number };

      const shouldCloneFromCodex =
        isCodexProviderName(body.provider) ||
        isCodexProviderName(project.provider) ||
        (!originalSession && project.provider === "claude");

      if (shouldCloneFromCodex) {
        const codexReader = getCodexReader(project.path);
        if (!codexReader) {
          return c.json({ error: "Codex session reader not available" }, 500);
        }
        const filePath = await codexReader.getSessionFilePath(sessionId);
        if (!filePath) {
          return c.json({ error: "Session file not found" }, 404);
        }

        originalSession =
          originalSession ??
          (await codexReader.getSessionSummary(sessionId, projectId)) ??
          null;
        cloneProvider =
          originalSession?.provider ??
          body.provider ??
          (isCodexProviderName(project.provider) ? project.provider : "codex");
        result = await cloneCodexSession(filePath);
        codexReader.invalidateCache();
        deps.codexScanner?.invalidateCache();
      } else {
        result = await cloneClaudeSession(sessionDir, sessionId);
      }

      // Build clone title: use provided title, or derive from original
      let cloneTitle = body.title;
      if (!cloneTitle && deps.sessionMetadataService) {
        // Check for custom title first, then fall back to auto-generated title
        const originalMetadata =
          deps.sessionMetadataService.getMetadata(sessionId);
        const originalTitle =
          originalMetadata?.customTitle ?? originalSession?.title;
        if (originalTitle) {
          cloneTitle = `${originalTitle} [cloned]`;
        }
      }

      // Set clone metadata. /btw asides pass parentSessionId so the child
      // can jump back into the parent viewport.
      if ((cloneTitle || parentSessionId) && deps.sessionMetadataService) {
        await deps.sessionMetadataService.updateMetadata(result.newSessionId, {
          title: cloneTitle,
          parentSessionId,
        });
      }

      return c.json({
        sessionId: result.newSessionId,
        messageCount: result.entries,
        clonedFrom: sessionId,
        provider: cloneProvider,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clone session";
      return c.json({ error: message }, 500);
    }
  });

  // ============ Worker Queue Endpoints ============

  // GET /api/status/workers - Get worker activity for safe restart indicator
  routes.get("/status/workers", (c) => {
    const activity = deps.supervisor.getWorkerActivity();
    return c.json(activity);
  });

  // GET /api/queue - Get all queued requests
  routes.get("/queue", (c) => {
    const queue = deps.supervisor.getQueueInfo();
    const poolStatus = deps.supervisor.getWorkerPoolStatus();
    return c.json({ queue, ...poolStatus });
  });

  // GET /api/queue/:queueId - Get specific queue entry position
  routes.get("/queue/:queueId", (c) => {
    const queueId = c.req.param("queueId");
    const position = deps.supervisor.getQueuePosition(queueId);

    if (position === undefined) {
      return c.json({ error: "Queue entry not found" }, 404);
    }

    return c.json({ queueId, position });
  });

  // DELETE /api/queue/:queueId - Cancel a queued request
  routes.delete("/queue/:queueId", (c) => {
    const queueId = c.req.param("queueId");

    const cancelled = deps.supervisor.cancelQueuedRequest(queueId);
    if (!cancelled) {
      return c.json(
        { error: "Queue entry not found or already processed" },
        404,
      );
    }

    return c.json({ cancelled: true });
  });

  return routes;
}
