/**
 * App-specific types that extend SDK types with runtime/computed fields.
 *
 * These types are used by the client and server to work with messages
 * that may have additional metadata added during processing.
 *
 * Key principle: SDK types (UserEntry, AssistantEntry) represent what's in JSONL files.
 * App types extend these with runtime fields that are computed or added during processing.
 */

import type {
  AssistantEntry,
  SessionEntry,
  SummaryEntry,
  SystemEntry,
  UserEntry,
} from "./claude-sdk-schema/types.js";
import type { UrlProjectId } from "./projectId.js";
import type {
  PermissionMode,
  PromptSuggestionMode,
  ProviderName,
  SlashCommand,
} from "./types.js";

// =============================================================================
// App Message Extensions
// =============================================================================

/**
 * Content block type for app messages.
 * Loosely typed to preserve all fields from JSONL without stripping.
 */
export interface AppContentBlock {
  type: string;
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block
  tool_use_id?: string;
  content?: string | AppContentBlock[];
  is_error?: boolean;
  // Allow any additional fields
  [key: string]: unknown;
}

/**
 * Runtime fields added to messages by our application.
 * These are computed or added during processing, not stored in JSONL.
 *
 * Includes convenience fields added by SessionReader.convertMessage():
 * - id: copied from uuid (or fallback to index-based)
 * - content: copied to top level from message.content
 * - role: added based on message type
 */
export interface AppMessageExtensions {
  /**
   * Message identifier - copied from uuid by SessionReader.
   * Fallback: "msg-{index}" when uuid is not available.
   */
  id?: string;

  /**
   * Message content copied to top level for convenience.
   * Original is in message.content for user/assistant entries.
   */
  content?: string | AppContentBlock[];

  /**
   * Role derived from message type (user/assistant).
   * Added by SessionReader for convenience.
   */
  role?: "user" | "assistant" | "system";

  /**
   * IDs of tool_use blocks that don't have a matching tool_result in the message history.
   * Computed by SessionReader via DAG analysis.
   *
   * NOTE: This is a misnomer. These aren't necessarily "orphaned" (abandoned) - they may be
   * actively pending (awaiting approval or currently executing). The client should check
   * process state to determine if tools are truly orphaned vs just pending.
   *
   * TODO: Consider renaming to `toolUsesWithoutResults` for clarity.
   */
  orphanedToolUseIds?: string[];

  /**
   * Source of this message data.
   * - "sdk": Message came from real-time SDK streaming
   * - "jsonl": Message was read from disk (authoritative)
   */
  _source?: "sdk" | "jsonl";

  /**
   * True if this message is still being streamed (incomplete).
   * Only set during active streaming; cleared when message is complete.
   */
  _isStreaming?: boolean;

  /**
   * True if this message is from a Task subagent.
   * Used for UI grouping and lazy-loading of subagent content.
   */
  isSubagent?: boolean;

  /**
   * Allow any additional fields from JSONL.
   * This makes the type compatible with pass-through of unknown fields.
   */
  [key: string]: unknown;
}

// =============================================================================
// App Message Types
// =============================================================================

/**
 * User message with app extensions.
 */
export type AppUserMessage = UserEntry & AppMessageExtensions;

/**
 * Assistant message with app extensions.
 */
export type AppAssistantMessage = AssistantEntry & AppMessageExtensions;

/**
 * System message with app extensions.
 */
export type AppSystemMessage = SystemEntry & AppMessageExtensions;

/**
 * Summary message with app extensions.
 */
export type AppSummaryMessage = SummaryEntry & AppMessageExtensions;

/**
 * Any JSONL entry type with app extensions.
 * This is the main message type used throughout the app.
 */
export type AppMessage = (SessionEntry | SummaryEntry) & AppMessageExtensions;

/**
 * Conversation messages only (user/assistant/system).
 * Excludes file_history_snapshot and queue_operation entries.
 */
export type AppConversationMessage =
  | AppUserMessage
  | AppAssistantMessage
  | AppSystemMessage
  | AppSummaryMessage;

// =============================================================================
// Session Types
// =============================================================================

/** Type of pending input request for notification badges */
export type PendingInputType = "tool-approval" | "user-question";

/** Agent activity - what the agent is doing */
export type AgentActivity = "in-turn" | "idle" | "waiting-input" | "terminated";

/** Context usage information extracted from the last assistant message */
export interface ContextUsage {
  /** Input tokens used for context-window meter (provider-specific semantics) */
  inputTokens: number;
  /** Percentage of context window used (based on model's context limit) */
  percentage: number;
  /** Context window size used to compute percentage */
  contextWindow?: number;
  /** Output tokens generated in the last response (optional - may not be available) */
  outputTokens?: number;
  /** Cache read tokens (tokens served from cache) */
  cacheReadTokens?: number;
  /** Cache creation tokens (new tokens added to cache) */
  cacheCreationTokens?: number;
}

// =============================================================================
// Model Context Window Mapping
// =============================================================================

/** Default context window size (200K tokens) */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Default context window size for Codex cloud sessions when metadata is missing */
export const CODEX_DEFAULT_CONTEXT_WINDOW = 258_000;
export const CLAUDE_EXTENDED_CONTEXT_WINDOW = 1_000_000;

/**
 * Known context window sizes for different models.
 *
 * Claude models:
 * - Fable standard alias: 1M
 * - Opus / Sonnet / Haiku standard aliases: 200K
 * - Explicit "[1m]" Claude variants: 1M
 * - Sonnet 3.5: 200K
 *
 * Gemini models:
 * - Gemini 2.0/1.5: 1M
 *
 * GPT models:
 * - GPT-4: 128K (varies by variant)
 * - GPT-4o: 128K
 * - GPT-5 / Codex 5.x: ~258K
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude models - 1M context
  fable: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  // Claude models - 200K context
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  // Gemini models - 1M context
  gemini: 1_000_000,
  // GPT-5 / Codex models - ~258K context
  "gpt-5": CODEX_DEFAULT_CONTEXT_WINDOW,
  codex: CODEX_DEFAULT_CONTEXT_WINDOW,
  // GPT-4 models - 128K context
  "gpt-4": 128_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
};

/**
 * Get the context window size for a given model.
 *
 * Parses model IDs like:
 * - "claude-opus-4-5-20251101" → opus → 200K
 * - "claude-opus-4-8[1m]" → opus → 1M
 * - "claude-fable-5" → fable → 1M
 * - "claude-sonnet-4-20250514" → sonnet → 200K
 * - "sonnet[1m]" → sonnet → 1M
 * - "claude-3-5-sonnet-20241022" → sonnet → 200K
 * - "gemini-2.0-flash-exp" → gemini → 1M
 * - "gpt-4o-2024-08-06" → gpt-4o → 128K
 *
 * @param model - Model ID string (e.g., "claude-opus-4-5-20251101")
 * @param provider - Provider name for fallback defaults when model is missing
 * @returns Context window size in tokens
 */
export function getModelContextWindow(
  model: string | undefined,
  provider?: ProviderName,
): number {
  if (!model) {
    return provider === "codex"
      ? CODEX_DEFAULT_CONTEXT_WINDOW
      : DEFAULT_CONTEXT_WINDOW;
  }

  const lowerModel = model.toLowerCase();

  if (lowerModel.includes("[1m]")) {
    return CLAUDE_EXTENDED_CONTEXT_WINDOW;
  }

  // Handle model IDs that may include provider namespace or other prefixes.
  if (lowerModel.includes("gpt-5") || lowerModel.includes("codex")) {
    return CODEX_DEFAULT_CONTEXT_WINDOW;
  }

  // Check for exact prefix matches first (for GPT models)
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lowerModel.startsWith(prefix)) {
      return size;
    }
  }

  // Parse Claude model IDs: claude-{family}-{version} or claude-{version}-{family}
  // Examples: claude-opus-4-5-*, claude-sonnet-4-*, claude-3-5-sonnet-*
  const claudeMatch = lowerModel.match(/claude-(?:(\w+)-\d|(\d+-\d+-)?(\w+))/);
  if (claudeMatch) {
    const family = claudeMatch[1] || claudeMatch[3];
    if (family && MODEL_CONTEXT_WINDOWS[family]) {
      return MODEL_CONTEXT_WINDOWS[family];
    }
  }

  // Check for Gemini models
  if (lowerModel.includes("gemini")) {
    return MODEL_CONTEXT_WINDOWS.gemini ?? DEFAULT_CONTEXT_WINDOW;
  }

  // Provider-level fallback when we don't recognize the model string.
  if (provider === "codex") {
    return CODEX_DEFAULT_CONTEXT_WINDOW;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Session ownership - who controls the session.
 */
export type SessionOwnership =
  | { owner: "none" } // no active process
  | {
      owner: "self";
      processId: string;
      permissionMode?: PermissionMode;
      modeVersion?: number;
    } // we control it
  | { owner: "external" }; // another process owns it

/**
 * Session sandbox policy from Codex turn_context.
 */
export interface SessionSandboxPolicy {
  type: string;
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

/**
 * Recent session entry with enriched data from the server.
 * Session data is looked up server-side to avoid N+1 client requests.
 */
export interface EnrichedRecentEntry {
  sessionId: string;
  projectId: string;
  visitedAt: string;
  // Enriched fields from session/project data
  title: string | null;
  projectName: string;
  provider: ProviderName;
}

/**
 * Session summary for list views.
 * Contains metadata without full message content.
 */
export interface AppSessionSummary {
  id: string;
  projectId: UrlProjectId;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  ownership: SessionOwnership;
  // Provider field - which AI provider is running this session
  provider: ProviderName;
  // Model used for this session (resolved, not "default")
  model?: string;
  // Notification fields
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  lastSeenAt?: string;
  hasUnread?: boolean;
  // Metadata fields
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** Parent session when this session is a YA-owned fork/aside. */
  parentSessionId?: string;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  contextUsage?: ContextUsage;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Launcher identifier from session metadata (e.g. "Codex Desktop", "yep-anywhere") */
  originator?: string;
  /** CLI version from session metadata (e.g. "0.101.0") */
  cliVersion?: string;
  /** Session source from session metadata (e.g. "vscode", "exec") */
  source?: string;
  /** Approval policy from turn_context (e.g. "never", "on-request") */
  approvalPolicy?: string;
  /** Sandbox policy from turn_context */
  sandboxPolicy?: SessionSandboxPolicy;
}

/**
 * Full session with messages.
 */
export interface AppSession extends AppSessionSummary {
  messages: AppMessage[];
}

export interface SessionMetadataPayload
  extends Omit<AppSessionSummary, "ownership"> {
  /** Whether this session is opted in to heartbeat turns */
  heartbeatTurnsEnabled?: boolean;
  /** Optional per-session idle threshold override in minutes */
  heartbeatTurnsAfterMinutes?: number;
  /** Optional per-session heartbeat text override */
  heartbeatTurnText?: string;
  /** Optional hard cap before forcing a heartbeat turn */
  heartbeatForceAfterMinutes?: number;
  /** Per-session prompt-suggestion preference (off | native) */
  promptSuggestionMode?: PromptSuggestionMode;
}

/**
 * Lightweight session metadata response used for title/status refreshes.
 */
export interface SessionMetadataResponse {
  session: SessionMetadataPayload;
  ownership: SessionOwnership;
  processState: AgentActivity | null;
  pendingInputRequest?: InputRequest | null;
  slashCommands?: SlashCommand[] | null;
}

// =============================================================================
// Agent Session Types (for Task subagents)
// =============================================================================

/** Status of an agent session, inferred from its messages */
export type AgentStatus = "pending" | "running" | "completed" | "failed";

/**
 * Agent session content returned by getAgentSession API.
 * Used for lazy-loading completed Task subagent content.
 */
export interface AgentSession {
  messages: AppMessage[];
  status: AgentStatus;
}

// =============================================================================
// Input Request Types
// =============================================================================

/**
 * Input request for tool approval or user questions.
 */
export type UserQuestionAnswer = string | string[];
export type UserQuestionAnswers = Record<string, UserQuestionAnswer>;

export interface InputRequest {
  id: string;
  sessionId: string;
  type: "tool-approval" | "question" | "choice";
  prompt: string;
  options?: string[];
  toolName?: string;
  toolInput?: unknown;
  timestamp: string;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a message is a user entry.
 */
export function isUserMessage(msg: AppMessage): msg is AppUserMessage {
  return msg.type === "user";
}

/**
 * Check if a message is an assistant entry.
 */
export function isAssistantMessage(
  msg: AppMessage,
): msg is AppAssistantMessage {
  return msg.type === "assistant";
}

/**
 * Check if a message is a system entry.
 */
export function isSystemMessage(msg: AppMessage): msg is AppSystemMessage {
  return msg.type === "system";
}

/**
 * Check if a message is a summary entry.
 */
export function isSummaryMessage(msg: AppMessage): msg is AppSummaryMessage {
  return msg.type === "summary";
}

/**
 * Check if a message is a conversation message (user/assistant/system/summary).
 */
export function isConversationMessage(
  msg: AppMessage,
): msg is AppConversationMessage {
  return (
    msg.type === "user" ||
    msg.type === "assistant" ||
    msg.type === "system" ||
    msg.type === "summary"
  );
}

// =============================================================================
// Connected Browser Types
// =============================================================================

/**
 * Information about a connected browser profile.
 */
export interface ConnectionInfo {
  /** Unique identifier for the browser profile */
  browserProfileId: string;
  /** Number of active tabs/connections from this browser profile */
  connectionCount: number;
  /** ISO timestamp of the first connection from this browser profile */
  connectedAt: string;
  /** Optional friendly name for the device (from push subscription) */
  deviceName?: string;
}

/**
 * Response from GET /api/connections endpoint.
 */
export interface ConnectionsResponse {
  connections: ConnectionInfo[];
}

// =============================================================================
// Browser Profile Origin Tracking
// =============================================================================

/**
 * Origin information for a browser profile connection.
 * Tracks where a browser profile has connected from.
 */
export interface BrowserProfileOrigin {
  /** Full origin string (e.g., "https://localhost:3400") */
  origin: string;
  /** URL scheme (e.g., "https", "http") */
  scheme: string;
  /** Hostname without port (e.g., "localhost", "phone.tailnet") */
  hostname: string;
  /** Port number, or null if default port */
  port: number | null;
  /** User agent string for browser identification */
  userAgent: string;
  /** ISO timestamp of first connection from this origin */
  firstSeen: string;
  /** ISO timestamp of most recent connection from this origin */
  lastSeen: string;
}

/**
 * Browser profile information with origin tracking.
 * Persisted server-side to track device connections.
 */
export interface BrowserProfileInfo {
  /** Unique browser profile identifier */
  browserProfileId: string;
  /** All origins this profile has connected from */
  origins: BrowserProfileOrigin[];
  /** ISO timestamp when this profile was first seen */
  createdAt: string;
  /** ISO timestamp of most recent activity */
  lastActiveAt: string;
  /** Optional friendly name (from push subscription) */
  deviceName?: string;
}

/**
 * Response from GET /api/browser-profiles endpoint.
 */
export interface BrowserProfilesResponse {
  profiles: BrowserProfileInfo[];
}
