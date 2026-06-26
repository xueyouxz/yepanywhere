import type { TranscriptDisplayObject } from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";

/**
 * RenderItem types for the preprocessed message rendering system.
 *
 * Instead of rendering Message[] directly, we preprocess into RenderItem[]
 * that pairs tool_use with tool_result for unified display.
 */

export type RenderItem =
  | TextItem
  | ThinkingItem
  | ToolCallItem
  | UserPromptItem
  | SessionSetupItem
  | TranscriptDisplayObjectItem
  | SystemItem
  | TaskNotificationItem;

/** Base fields shared by all render items */
interface RenderItemBase {
  /** Source JSONL messages that contributed to this item (for debugging) */
  sourceMessages: Message[];
  /** True if this item is from a Task subagent */
  isSubagent?: boolean;
}

export interface TextItem extends RenderItemBase {
  type: "text";
  id: string;
  text: string;
  /** True if this text is still being streamed */
  isStreaming?: boolean;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
}

export interface ThinkingItem extends RenderItemBase {
  type: "thinking";
  id: string;
  thinking: string;
  signature?: string;
  status: "streaming" | "complete";
}

export interface ToolCallItem extends RenderItemBase {
  type: "tool_call";
  id: string; // tool_use.id
  toolName: string; // tool_use.name
  toolInput: unknown; // tool_use.input
  toolResult?: ToolResultData; // undefined while pending
  /** "incomplete" means the turn ended without YA observing a result. */
  status: "pending" | "complete" | "error" | "aborted" | "incomplete";
}

export interface ToolResultData {
  content: string;
  isError: boolean;
  /** Structured result from JSONL toolUseResult field */
  structured?: unknown;
}

export interface UserPromptItem extends RenderItemBase {
  type: "user_prompt";
  id: string;
  content: string | ContentBlock[];
}

/**
 * A Claude Code `<task-notification>` entry: the SDK injects these (as user-role
 * entries) when a backgrounded task changes state. Rendered as a system/event
 * chip, not a user bubble. Detected via `origin.kind` (see parseTaskNotification).
 */
export interface TaskNotificationItem extends RenderItemBase {
  type: "task_notification";
  id: string;
  /** Raw XML body, retained for copy/debug and as a fallback when unparsed. */
  raw: string;
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  status?: string;
  summary?: string;
  /** Streaming progress body (Monitor `<event>` log dump), when present. */
  event?: string;
}

export interface SessionSetupItem extends RenderItemBase {
  type: "session_setup";
  id: string;
  title: string;
  prompts: Array<string | ContentBlock[]>;
}

export interface TranscriptDisplayObjectItem extends RenderItemBase {
  type: "transcript_display_object";
  id: string;
  object: TranscriptDisplayObject;
}

export interface SystemItem extends RenderItemBase {
  type: "system";
  id: string;
  subtype: "compact_boundary" | "status" | "init" | string;
  content: string;
  details?: Array<string | ContentBlock[]>;
  /** For status subtype: the current status (e.g., "compacting") */
  status?: "compacting" | null;
  /** For config_ack subtype: whether it differs from the previous config ack */
  configChanged?: boolean;
}
