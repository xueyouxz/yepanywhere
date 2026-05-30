// Core types for Claude SDK abstraction

// Re-export PermissionMode from shared
export type { PermissionMode } from "@yep-anywhere/shared";
import type {
  PermissionMode,
  SlashCommand,
  SessionLivenessProbeStatus,
  UploadedFile,
  UserMessageMetadata,
} from "@yep-anywhere/shared";

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "thinking";
  text?: string;
  /** For thinking blocks */
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** For tool_result blocks - references the tool_use id */
  tool_use_id?: string;
  /** For tool_result blocks - the result content */
  content?: string;
  /** For tool_result blocks - true when the tool failed */
  is_error?: boolean;
}

/**
 * SDK Message - loosely typed to preserve all fields from the SDK.
 *
 * We intentionally use a loose type here to:
 * 1. Pass through all SDK fields without stripping
 * 2. Allow frontend to inspect any field for debugging
 * 3. Avoid breaking when SDK adds new fields
 *
 * Known fields are documented but not enforced.
 */
export interface SDKMessage {
  type: string;
  uuid?: string;
  subtype?: string;
  session_id?: string;
  timestamp?: string;
  message?: {
    content: string | ContentBlock[];
    role?: string;
    /** Resolved model name from API response (e.g., "claude-sonnet-4-5-20250929") */
    model?: string;
  };
  // DAG structure
  parentUuid?: string | null;
  parent_tool_use_id?: string;
  // Message origin flags
  isSynthetic?: boolean;
  isReplay?: boolean;
  userType?: string;
  // Tool use related
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  toolUseResult?: unknown;
  // Input requests (tool approval, questions, etc.)
  input_request?: {
    id: string;
    type: "tool-approval" | "question" | "choice";
    prompt: string;
    options?: string[];
  };
  // Result metadata
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: unknown;
  modelUsage?: unknown;
  num_turns?: number;
  // Error info
  error?: unknown;
  // Allow any additional fields from SDK
  [key: string]: unknown;
}

export type TimestampedSDKMessage<T extends SDKMessage = SDKMessage> = T & {
  timestamp: string;
};

export interface UserMessage {
  text: string;
  images?: string[]; // base64 or file paths
  documents?: string[];
  /** File attachments with paths for agent to access via Read tool */
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  /** UUID to use for this message. If not provided, SDK will generate one. */
  uuid?: string;
  /** Client-generated temp ID for optimistic UI tracking. Echoed back in SSE. */
  tempId?: string;
  /** YA-internal submission timing and delivery-intent metadata. */
  metadata?: UserMessageMetadata;
}

export interface SDKSessionOptions {
  cwd: string;
  resume?: string; // session ID to resume
}

// Legacy interface for mock SDK compatibility
export interface ClaudeSDK {
  startSession(options: SDKSessionOptions): AsyncIterableIterator<SDKMessage>;
}

// New interface for real SDK with full features
import type { MessageQueue } from "./messageQueue.js";

export interface ToolApprovalResult {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
  /**
   * If true, interrupt execution and do not continue.
   * Set to true when user denies without guidance (just clicks "No").
   * Leave false/unset when user provides feedback for Claude to incorporate.
   */
  interrupt?: boolean;
}

export type CanUseTool = (
  toolName: string,
  input: unknown,
  options: { signal: AbortSignal },
) => Promise<ToolApprovalResult>;

export interface ProviderLivenessProbeResult {
  status: SessionLivenessProbeStatus;
  source: string;
  detail?: string;
  checkedAt?: Date;
}

export interface ProviderActivitySnapshot {
  lastRawProviderEventAt?: Date | null;
  lastRawProviderEventSource?: string | null;
}

export interface StartSessionOptions {
  cwd: string;
  initialMessage?: UserMessage;
  resumeSessionId?: string;
  /**
   * Optional provider-visible client identity, used by providers that expose
   * launcher identity in session metadata (currently Codex).
   */
  clientName?: string;
  permissionMode?: PermissionMode;
  /** Model to use (e.g., "sonnet", "opus", "haiku"). undefined = use CLI default */
  model?: string;
  /** Thinking configuration (undefined = thinking disabled) */
  thinking?: import("@yep-anywhere/shared").ThinkingConfig;
  /** Effort level for response quality (undefined = SDK default) */
  effort?: import("@yep-anywhere/shared").EffortLevel;
  onToolApproval?: CanUseTool;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** Environment variables to set on remote (for testing: CLAUDE_SESSIONS_DIR) */
  remoteEnv?: Record<string, string>;
  /** Global instructions to append to system prompt (from server settings) */
  globalInstructions?: string;
  /** Native prompt-suggestion protocol opt-in for providers that support it. */
  promptSuggestions?: boolean;
}

export interface StartSessionResult {
  iterator: AsyncIterableIterator<SDKMessage>;
  queue: MessageQueue;
  abort: () => void;
  /** Check if the underlying CLI process is still alive (undefined = not available) */
  isProcessAlive?: () => boolean;
  /** OS PID of the spawned agent child process (undefined if not available) */
  pid?: number | (() => number | undefined);
  /** Actively query provider/session status when passive progress evidence is stale. */
  probeLiveness?: () => Promise<ProviderLivenessProbeResult>;
  /** Passive raw provider/app-server event cadence, when available. */
  getProviderActivity?: () => ProviderActivitySnapshot;
  /**
   * Change max thinking tokens without restarting the session.
   * Pass null to disable thinking mode.
   * Only supported by Claude SDK 0.2.7+.
   */
  setMaxThinkingTokens?: (tokens: number | null) => Promise<void>;
  /**
   * Interrupt the current turn gracefully without killing the process.
   * Only supported by Claude SDK 0.2.7+.
   */
  interrupt?: () => Promise<void | boolean>;
  /**
   * Get the list of available models from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   */
  supportedModels?: () => Promise<
    Array<{ id: string; name: string; description?: string }>
  >;
  /**
   * Get the list of available slash commands from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   */
  supportedCommands?: () => Promise<SlashCommand[]>;
  /**
   * Change the model mid-session without restarting.
   * Only supported by Claude SDK 0.2.7+.
   */
  setModel?: (model?: string) => Promise<void>;
}

export interface RealClaudeSDKInterface {
  startSession(options: StartSessionOptions): Promise<StartSessionResult>;
}
