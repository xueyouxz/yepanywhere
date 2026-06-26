import type { MarkdownAugment } from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";
import type {
  RenderItem,
  SessionSetupItem,
  SystemItem,
  ToolCallItem,
  ToolResultData,
  UserPromptItem,
} from "../types/renderItems";
import {
  formatCommandTurn,
  isCompactionLocalCommandOutput,
  isLocalCommandCaveatOnly,
  parseCommandTurn,
  parseLocalCommandStdout,
} from "./commandTurn";
import { getMessageId } from "./mergeMessages";
import {
  isTaskNotificationMessage,
  parseTaskNotification,
} from "./parseTaskNotification";

const AWAY_SUMMARY_HINT_SUFFIX_RE = /\s*\(disable recaps in \/config\)\s*$/u;

export function stripAwaySummaryHintSuffix(content: string): string {
  return content.replace(AWAY_SUMMARY_HINT_SUFFIX_RE, "");
}

/**
 * When true, indicates the session has active tool work or approval.
 * Orphaned tools in the current trailing user turn are treated as pending.
 *
 * This handles the case where multiple tools are queued for approval while
 * still allowing older orphaned tools from prior turns to render interrupted.
 */
export type ActiveToolApproval = boolean;

/**
 * Augments to embed into RenderItems during preprocessing.
 * These are pre-computed on the server for completed messages.
 */
export interface PreprocessAugments {
  /** Pre-rendered markdown HTML keyed by message ID */
  markdown?: Record<string, MarkdownAugment>;
  /** Active tool approval request - if present, matching tool_use won't be marked aborted */
  activeToolApproval?: ActiveToolApproval;
}

/**
 * Preprocess messages into render items, pairing tool_use with tool_result.
 *
 * This is a pure function - given the same messages, returns the same items.
 * Safe to call on every render (use useMemo).
 */
export function preprocessMessages(
  messages: Message[],
  augments?: PreprocessAugments,
): RenderItem[] {
  const items: RenderItem[] = [];
  const toolCallIndices = new Map<string, number>(); // tool_use_id → index in items
  const pendingToolCalls = new Map<string, number>(); // tool_use_id → index in items
  const configAckState = { lastSignature: null as string | null };

  const orphanedToolIds = collectOrphanedToolIds(
    messages,
    augments?.activeToolApproval === true,
  );

  for (const msg of messages) {
    processMessage(
      msg,
      items,
      toolCallIndices,
      pendingToolCalls,
      orphanedToolIds,
      configAckState,
      augments,
    );
  }

  const compactCoalescedItems = coalesceCompactBoundaryItems(items);
  const enrichedItems = enrichWriteStdinWithCommand(compactCoalescedItems);
  return collapseSessionSetupRuns(enrichedItems);
}

function collectOrphanedToolIds(
  messages: Message[],
  suppressCurrentTurnOrphans: boolean,
): Set<string> {
  const orphanedToolIds = new Set<string>();
  const suppressFromIndex = suppressCurrentTurnOrphans
    ? findLastUserPromptMessageIndex(messages)
    : messages.length;

  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    if (!msg?.orphanedToolUseIds) {
      continue;
    }

    if (suppressCurrentTurnOrphans && index >= suppressFromIndex) {
      continue;
    }

    for (const id of msg.orphanedToolUseIds) {
      orphanedToolIds.add(id);
    }
  }

  return orphanedToolIds;
}

function findLastUserPromptMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index];
    if (msg && isUserPromptMessage(msg)) {
      return index;
    }
  }
  return 0;
}

const SESSION_SETUP_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
];

const INTERNAL_REASONING_PLACEHOLDER = "Reasoning [internal]";

function getPromptText(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter(
      (block): block is ContentBlock & { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function getPreprocessMessageContent(
  msg: Message,
): string | ContentBlock[] | undefined {
  return (
    (msg.message as { content?: string | ContentBlock[] } | undefined)
      ?.content ?? msg.content
  );
}

function isCompactSummaryMessage(msg: Message): boolean {
  return msg.isCompactSummary === true;
}

function isCompactCommand(command: string): boolean {
  const normalized = command.trim().replace(/^\/+/, "").toLowerCase();
  return normalized === "compact" || normalized === "compress";
}

function compactMetadataDetail(msg: Message): string | null {
  const metadata = (msg as { compactMetadata?: unknown }).compactMetadata;
  if (!isRecord(metadata)) {
    return null;
  }
  return `compactMetadata:\n${JSON.stringify(metadata, null, 2)}`;
}

function compactBoundaryDetails(msg: Message): Array<string | ContentBlock[]> {
  const details: Array<string | ContentBlock[]> = [];
  const metadata = compactMetadataDetail(msg);
  if (metadata) {
    details.push(metadata);
  }
  return details;
}

function compactSummaryDetails(
  content: string | ContentBlock[] | undefined,
): Array<string | ContentBlock[]> {
  return content === undefined ? [] : [content];
}

function isCompactBoundaryItem(
  item: RenderItem,
): item is SystemItem & { subtype: "compact_boundary" } {
  return item.type === "system" && item.subtype === "compact_boundary";
}

function hasSystemCompactBoundarySource(item: SystemItem): boolean {
  return item.sourceMessages.some(
    (source) =>
      source.type === "system" &&
      (source as { subtype?: string }).subtype === "compact_boundary",
  );
}

function mergeCompactBoundaryRun(
  run: Array<SystemItem & { subtype: "compact_boundary" }>,
): SystemItem {
  const first = run[0];
  if (!first) {
    throw new Error("Cannot merge an empty compact boundary run");
  }
  const preferred = run.find(hasSystemCompactBoundarySource) ?? first;
  const sourceMessages = run.flatMap((item) => item.sourceMessages);
  const details = run.flatMap((item) => item.details ?? []);
  return {
    type: "system",
    id: preferred.id,
    subtype: "compact_boundary",
    content: preferred.content,
    status: preferred.status,
    configChanged: preferred.configChanged,
    isSubagent: preferred.isSubagent,
    sourceMessages,
    details: details.length > 0 ? details : undefined,
  };
}

function coalesceCompactBoundaryItems(items: RenderItem[]): RenderItem[] {
  const coalesced: RenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (!item || !isCompactBoundaryItem(item)) {
      if (item) {
        coalesced.push(item);
      }
      index += 1;
      continue;
    }

    const run: Array<SystemItem & { subtype: "compact_boundary" }> = [item];
    let runIndex = index + 1;
    while (runIndex < items.length) {
      const runItem = items[runIndex];
      if (!runItem || !isCompactBoundaryItem(runItem)) {
        break;
      }
      run.push(runItem);
      runIndex += 1;
    }
    coalesced.push(mergeCompactBoundaryRun(run));
    index = runIndex;
  }

  return coalesced;
}

function isUserPromptMessage(msg: Message): boolean {
  const content = getPreprocessMessageContent(msg);
  const role =
    (msg.message as { role?: "user" | "assistant" } | undefined)?.role ??
    msg.role;
  const isUserMessage = msg.type === "user" || role === "user";
  if (!isUserMessage) {
    return false;
  }
  // Task notifications arrive as user-role entries but are SDK-injected, not
  // user-authored — they must not anchor the "last user prompt" affordances.
  if (isTaskNotificationMessage(msg)) {
    return false;
  }
  if (isCompactSummaryMessage(msg)) {
    return false;
  }
  if (Array.isArray(content)) {
    return !content.every((block) => block.type === "tool_result");
  }
  if (typeof content !== "string") {
    return false;
  }
  if (msg.isMeta === true && isLocalCommandCaveatOnly(content)) {
    return false;
  }
  if (parseLocalCommandStdout(content) !== null) {
    return false;
  }
  return !parseCommandTurn(content);
}

function isDisplayableThinking(
  thinking: string | undefined,
): thinking is string {
  const trimmed = thinking?.trim();
  return !!trimmed && trimmed !== INTERNAL_REASONING_PLACEHOLDER;
}

function isSessionSetupPrompt(item: UserPromptItem): boolean {
  const text = getPromptText(item.content).trimStart();
  return SESSION_SETUP_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function collapseSessionSetupRuns(items: RenderItem[]): RenderItem[] {
  const result: RenderItem[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (item?.type !== "user_prompt" || !isSessionSetupPrompt(item)) {
      result.push(item as RenderItem);
      index += 1;
      continue;
    }

    const setupItems: UserPromptItem[] = [];
    let runIndex = index;
    while (runIndex < items.length) {
      const runItem = items[runIndex];
      if (runItem?.type !== "user_prompt" || !isSessionSetupPrompt(runItem)) {
        break;
      }
      setupItems.push(runItem);
      runIndex += 1;
    }

    // Preserve likely user-authored single setup-like messages mid-session.
    // Collapse any run at session start and any multi-item run (typical resume preamble).
    if (setupItems.length > 1 || index === 0) {
      const firstSetupItem = setupItems[0];
      if (!firstSetupItem) {
        index = runIndex;
        continue;
      }

      const collapsedItem: SessionSetupItem = {
        type: "session_setup",
        id: `session-setup-${firstSetupItem.id}`,
        title: "Session setup",
        prompts: setupItems.map((setupItem) => setupItem.content),
        sourceMessages: setupItems.flatMap(
          (setupItem) => setupItem.sourceMessages,
        ),
      };
      result.push(collapsedItem);
    } else {
      const singleSetupItem = setupItems[0];
      if (singleSetupItem) {
        result.push(singleSetupItem);
      }
    }

    index = runIndex;
  }

  return result;
}

function processMessage(
  msg: Message,
  items: RenderItem[],
  toolCallIndices: Map<string, number>,
  pendingToolCalls: Map<string, number>,
  orphanedToolIds: Set<string>,
  configAckState: { lastSignature: string | null },
  augments?: PreprocessAugments,
): void {
  const msgId = getMessageId(msg);

  // Handle provider/runtime error entries as visible system messages.
  if (msg.type === "error") {
    const errorText =
      (typeof msg.error === "string" && msg.error) ||
      (typeof msg.content === "string" && msg.content) ||
      "Agent error";
    const systemItem: SystemItem = {
      type: "system",
      id: msgId || `error-${msg.timestamp ?? Date.now()}`,
      subtype: "error",
      content: errorText,
      sourceMessages: [msg],
    };
    items.push(systemItem);
    return;
  }

  // Handle system entries (compact_boundary, status, etc.)
  if (msg.type === "system") {
    const subtype = (msg as { subtype?: string }).subtype ?? "unknown";
    // Render compact_boundary as a visible system message
    if (
      subtype === "compact_boundary" ||
      subtype === "turn_aborted" ||
      subtype === "config_ack" ||
      subtype === "away_summary" ||
      subtype === "subagent_activity"
    ) {
      const configSignature =
        subtype === "config_ack" ? getConfigAckSignature(msg) : null;
      const content =
        typeof msg.content === "string"
          ? msg.content
          : subtype === "turn_aborted"
            ? "Turn aborted"
            : subtype === "config_ack"
              ? "Configuration updated"
              : subtype === "away_summary"
                ? "Recap unavailable"
                : subtype === "subagent_activity"
                  ? "Subagent updated"
                  : "Context compacted";
      const systemItem: SystemItem = {
        type: "system",
        id: msgId,
        subtype,
        content:
          subtype === "away_summary"
            ? stripAwaySummaryHintSuffix(content)
            : content,
        sourceMessages: [msg],
        ...(subtype === "compact_boundary"
          ? {
              details: compactBoundaryDetails(msg),
            }
          : {}),
        ...(subtype === "config_ack"
          ? {
              configChanged:
                msg.configMismatch === true &&
                configSignature !== null &&
                configSignature !== configAckState.lastSignature,
            }
          : {}),
      };
      items.push(systemItem);
      if (subtype === "config_ack" && configSignature !== null) {
        configAckState.lastSignature = configSignature;
      }
    }
    // Status messages (compacting indicator) are transient - handled separately via isCompacting state
    // Skip other system entries (init, status, etc.) - they're internal
    return;
  }

  // Debug logging for streaming transition issues
  if (
    typeof window !== "undefined" &&
    window.__STREAMING_DEBUG__ &&
    msg.type === "assistant"
  ) {
    console.log("[preprocessMessages] Processing assistant message:", {
      msgId,
      uuid: msg.uuid,
      id: msg.id,
      _isStreaming: msg._isStreaming,
    });
  }

  // Get content from nested message object (SDK structure) first, fall back to top-level
  // Phase 4c: prefer message.content over top-level content
  const content =
    (msg.message as { content?: string | ContentBlock[] } | undefined)
      ?.content ?? msg.content;

  // Use type for discrimination (SDK field), fall back to role for legacy data
  // Phase 4c: prefer type over role, but maintain backward compatibility
  const role =
    (msg.message as { role?: "user" | "assistant" } | undefined)?.role ??
    msg.role;
  const isUserMessage = msg.type === "user" || role === "user";

  // String content = user prompt (only if type is user)
  if (typeof content === "string") {
    if (isUserMessage) {
      if (isCompactSummaryMessage(msg)) {
        items.push({
          type: "system",
          id: msgId,
          subtype: "compact_boundary",
          content: "Context compacted",
          details: compactSummaryDetails(content),
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
        return;
      }
      if (msg.isMeta === true && isLocalCommandCaveatOnly(content)) {
        return;
      }
      const commandTurn = parseCommandTurn(content);
      if (commandTurn) {
        if (isCompactCommand(commandTurn.command)) {
          return;
        }
        items.push({
          type: "system",
          id: msgId,
          subtype: "local_command",
          content: formatCommandTurn(commandTurn),
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
        return;
      }
      const localCommandStdout = parseLocalCommandStdout(content);
      if (localCommandStdout !== null) {
        if (!localCommandStdout) {
          return;
        }
        if (isCompactionLocalCommandOutput(localCommandStdout)) {
          return;
        }
        items.push({
          type: "system",
          id: msgId,
          subtype: "local_command",
          content: localCommandStdout,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
        return;
      }
      // SDK-injected task notifications render as a system/event chip, not a
      // user bubble. Gated on origin.kind (non-heuristic), then the XML body is
      // parsed for the chip's structured fields.
      if (isTaskNotificationMessage(msg)) {
        const parsed = parseTaskNotification(content);
        items.push({
          type: "task_notification",
          id: msgId,
          raw: content,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
          ...parsed,
        });
        return;
      }
      items.push({
        type: "user_prompt",
        id: msgId,
        content,
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
      });
      return;
    }
    // Assistant message with string content - convert to text block
    if (content.trim()) {
      const messageHtml = (msg as { _html?: string })._html;
      items.push({
        type: "text",
        id: msgId,
        text: content,
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
        augmentHtml: messageHtml ?? augments?.markdown?.[msgId]?.html,
      });
    }
    return;
  }

  // Not an array - shouldn't happen but handle gracefully
  if (!Array.isArray(content)) {
    return;
  }

  // Check if this is a user message with only tool_result blocks
  const isToolResultMessage =
    isUserMessage && content.every((b) => b.type === "tool_result");

  if (isToolResultMessage) {
    // Attach results to pending tool calls
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        attachToolResult(block, msg, items, pendingToolCalls);
      }
    }
    return;
  }

  // Check if this is a real user prompt (not tool results)
  if (isUserMessage) {
    items.push({
      type: "user_prompt",
      id: msgId,
      content,
      sourceMessages: [msg],
      isSubagent: msg.isSubagent,
    });
    return;
  }

  // Assistant message - process each block
  // First pass: find the last text block index (for streaming cursor placement)
  let lastTextBlockIndex = -1;
  if (msg._isStreaming) {
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block?.type === "text" && block.text?.trim()) {
        lastTextBlockIndex = i;
        break;
      }
    }
  }

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block) continue;

    const blockId = `${msgId}-${i}`;

    if (block.type === "text") {
      if (block.text?.trim()) {
        // Get _html from server-injected augment, fall back to markdownAugments (for SSE path)
        const blockHtml = (block as { _html?: string })._html;
        items.push({
          type: "text",
          id: blockId,
          text: block.text,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
          // Only show streaming cursor on the last text block
          isStreaming: msg._isStreaming && i === lastTextBlockIndex,
          // Prefer inline _html from server, fall back to markdownAugments (SSE path)
          augmentHtml: blockHtml ?? augments?.markdown?.[msgId]?.html,
        });
      }
    } else if (block.type === "thinking") {
      const thinking = block.thinking;
      if (isDisplayableThinking(thinking)) {
        items.push({
          type: "thinking",
          id: blockId,
          thinking,
          signature: undefined,
          status: msg._isStreaming ? "streaming" : "complete",
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
      }
    } else if (block.type === "tool_use") {
      if (block.id && block.name) {
        // Stream reconnects/resume can replay the same tool_use id from a
        // different assistant message snapshot. Keep one render item per tool id.
        const existingIndex = toolCallIndices.get(block.id);
        if (existingIndex !== undefined) {
          const existingItem = items[existingIndex];
          if (existingItem?.type === "tool_call") {
            items[existingIndex] = updateToolCallSnapshot(
              existingItem,
              msg,
              block.input,
            );
            if (existingItem.status === "pending") {
              pendingToolCalls.set(block.id, existingIndex);
            }
          }
          continue;
        }

        // Check if this tool call is missing a result after the turn boundary.
        // That is not the same as an explicit interruption: Codex/YA may have
        // missed the result event even though a side effect, such as an edit,
        // landed in the filesystem.
        const isOrphaned = orphanedToolIds.has(block.id);
        const toolCall: ToolCallItem = {
          type: "tool_call",
          id: block.id,
          toolName: block.name,
          toolInput: block.input,
          toolResult: undefined,
          status: isOrphaned ? "incomplete" : "pending",
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        };
        const itemIndex = items.length;
        toolCallIndices.set(block.id, itemIndex);
        pendingToolCalls.set(block.id, itemIndex);
        items.push(toolCall);
      }
    }
  }
}

function getConfigAckSignature(msg: Message): string | null {
  const configModel =
    typeof msg.configModel === "string" ? msg.configModel.trim() : "";
  const configThinking =
    typeof msg.configThinking === "string" ? msg.configThinking.trim() : "";
  if (configModel || configThinking) {
    return `${configModel}::${configThinking}`;
  }
  return typeof msg.content === "string" ? msg.content.trim() : null;
}

function appendSourceMessage(
  item: ToolCallItem,
  message: Message,
): ToolCallItem {
  const messageId = getMessageId(message);
  if (
    item.sourceMessages.some((source) => getMessageId(source) === messageId)
  ) {
    return item;
  }
  return {
    ...item,
    sourceMessages: [...item.sourceMessages, message],
  };
}

function updateToolCallSnapshot(
  item: ToolCallItem,
  message: Message,
  toolInput: unknown,
): ToolCallItem {
  const withSource = appendSourceMessage(item, message);
  return {
    ...withSource,
    toolInput,
  };
}

/**
 * Parse Agent tool result from text content blocks (SDK 0.2.76+).
 *
 * New SDK embeds agentId and usage stats in text rather than a structured
 * tool_use_result. Example text block:
 *   "agentId: abc123 (for resuming...)\n<usage>total_tokens: 1234\ntool_uses: 5\nduration_ms: 6789</usage>"
 *
 * Returns a TaskResult-shaped object for the renderer, or undefined if not parseable.
 */
export function parseAgentResultFromText(
  block: ContentBlock,
): Record<string, unknown> | undefined {
  // Content may be a string or array of content blocks
  const texts: string[] = [];
  if (typeof block.content === "string") {
    texts.push(block.content);
  } else if (Array.isArray(block.content)) {
    for (const cb of block.content as Array<{ type?: string; text?: string }>) {
      if (cb.type === "text" && cb.text) texts.push(cb.text);
    }
  }

  const fullText = texts.join("\n");
  if (!fullText) return undefined;

  const displayContent = extractAgentDisplayContent(block);

  // Extract agentId
  const agentIdMatch = fullText.match(/^agentId:\s*(\S+)/m);
  if (!agentIdMatch) return undefined;

  const result: Record<string, unknown> = {
    agentId: agentIdMatch[1],
    status: "completed",
  };
  if (displayContent && displayContent.length > 0) {
    result.content = displayContent;
  }

  // Extract usage stats from <usage> block
  const usageMatch = fullText.match(/<usage>([\s\S]*?)<\/usage>/);
  if (usageMatch?.[1]) {
    const usage = usageMatch[1];
    const tokens = usage.match(/total_tokens:\s*(\d+)/);
    const tools = usage.match(/tool_uses:\s*(\d+)/);
    const duration = usage.match(/duration_ms:\s*(\d+)/);
    if (tokens?.[1]) result.totalTokens = Number(tokens[1]);
    if (tools?.[1]) result.totalToolUseCount = Number(tools[1]);
    if (duration?.[1]) result.totalDurationMs = Number(duration[1]);
  }

  return result;
}

function stripAgentMetadata(text: string): string {
  return text
    .replace(/^agentId:\s*\S+.*$/gm, "")
    .replace(/<usage>[\s\S]*?<\/usage>/g, "")
    .trim();
}

function extractAgentDisplayContent(
  block: ContentBlock,
): ContentBlock[] | undefined {
  if (typeof block.content === "string") {
    const text = stripAgentMetadata(block.content);
    return text ? [{ type: "text", text }] : undefined;
  }

  if (!Array.isArray(block.content)) {
    return undefined;
  }

  const displayBlocks: ContentBlock[] = [];
  for (const contentBlock of block.content) {
    if (!contentBlock || typeof contentBlock !== "object") {
      continue;
    }

    if (contentBlock.type === "text" && typeof contentBlock.text === "string") {
      const text = stripAgentMetadata(contentBlock.text);
      if (!text) {
        continue;
      }
      displayBlocks.push({ ...contentBlock, text });
      continue;
    }

    displayBlocks.push(contentBlock as ContentBlock);
  }

  return displayBlocks.length > 0 ? displayBlocks : undefined;
}

function attachToolResult(
  block: ContentBlock,
  resultMessage: Message,
  items: RenderItem[],
  pendingToolCalls: Map<string, number>,
): void {
  const toolUseId = block.tool_use_id;
  if (!toolUseId) return;

  const index = pendingToolCalls.get(toolUseId);
  if (index === undefined) {
    // Orphan result - shouldn't happen normally
    console.warn(`Tool result for unknown tool_use: ${toolUseId}`);
    return;
  }

  const item = items[index];
  if (item?.type !== "tool_call") return;

  // Attach result to existing tool call
  // Handle both camelCase (toolUseResult) and snake_case (tool_use_result) from SDK
  let structured =
    resultMessage.toolUseResult ??
    (resultMessage as Record<string, unknown>).tool_use_result;

  // SDK 0.2.76+: Agent tool has no structured tool_use_result.
  // Parse agentId and usage stats from the text content blocks instead.
  if (!structured && (item.toolName === "Agent" || item.toolName === "Task")) {
    structured = parseAgentResultFromText(block);
  }

  const resultData: ToolResultData = {
    content: typeof block.content === "string" ? block.content : "",
    isError: block.is_error || false,
    structured,
  };
  const isBackgroundProcessResult = isBackgroundProcessToolResult(
    block,
    item.toolName,
  );
  const isInterruptedProcessResult = isInterruptedToolResult(
    block,
    resultData,
    item.toolName,
  );

  // Create a new ToolCallItem to ensure React sees the change
  let status: ToolCallItem["status"] = "complete";
  if (isInterruptedProcessResult || item.status === "aborted") {
    status = "aborted";
  } else if (isBackgroundProcessResult) {
    status = item.status === "incomplete" ? "incomplete" : "pending";
  } else if (block.is_error) {
    status = "error";
  }
  const updatedItem: ToolCallItem = {
    type: "tool_call",
    id: item.id,
    toolName: item.toolName,
    toolInput: item.toolInput,
    toolResult: resultData,
    status,
    sourceMessages: appendSourceMessage(item, resultMessage).sourceMessages,
    isSubagent: item.isSubagent,
  };

  items[index] = updatedItem;
  if (!isBackgroundProcessResult && !isInterruptedProcessResult) {
    pendingToolCalls.delete(toolUseId);
  }
}

function isBackgroundProcessToolResult(
  block: ContentBlock,
  toolName: string,
): boolean {
  if (toolName !== "Bash") {
    return false;
  }
  const content = typeof block.content === "string" ? block.content : "";
  if (!content) {
    return false;
  }
  return (
    /(?:^|\n)\s*(?:Process\s+running\s+with\s+session\s+ID|session(?:\s+id)?)\s*:?\s*\d+\b/i.test(
      content,
    ) &&
    !/(?:^|\n)\s*(?:Exit code:|Process exited with code)\s*-?\d+\b/i.test(
      content,
    )
  );
}

function isInterruptedToolResult(
  block: ContentBlock,
  result: ToolResultData,
  toolName: string,
): boolean {
  if (toolName !== "Bash") {
    return false;
  }
  if (
    result.structured &&
    typeof result.structured === "object" &&
    (result.structured as { interrupted?: unknown }).interrupted === true
  ) {
    return true;
  }
  const content = typeof block.content === "string" ? block.content : "";
  return /(?:^|\n)\s*(?:aborted by user|interrupted by user)(?:\s|$)/i.test(
    content,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractCommandFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (typeof input.command === "string" && input.command.trim().length > 0) {
    return input.command;
  }
  if (typeof input.cmd === "string" && input.cmd.trim().length > 0) {
    return input.cmd;
  }
  return undefined;
}

function coerceSessionId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function extractSessionIdFromWriteStdinInput(
  input: unknown,
): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return coerceSessionId(input.session_id ?? input.sessionId);
}

function extractSessionIdFromToolResult(
  item: ToolCallItem,
): string | undefined {
  const structured = item.toolResult?.structured;
  if (isRecord(structured)) {
    const fromStructured = coerceSessionId(
      structured.session_id ?? structured.sessionId,
    );
    if (fromStructured) {
      return fromStructured;
    }
  }

  const raw = item.toolResult?.content ?? "";
  const text = typeof raw === "string" ? raw : "";
  const match = text.match(
    /(?:^|\n)\s*(?:Process\s+running\s+with\s+session\s+ID|session(?:\s+id)?)\s*:?\s*(\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return match[1];
}

function withLinkedCommand(input: unknown, command: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (typeof input.linked_command === "string" && input.linked_command.trim()) {
    return input;
  }
  return { ...input, linked_command: command };
}

function withLinkedFilePath(input: unknown, filePath: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (
    typeof input.linked_file_path === "string" &&
    input.linked_file_path.trim()
  ) {
    return input;
  }
  return { ...input, linked_file_path: filePath };
}

function withLinkedToolName(input: unknown, toolName: string): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (
    typeof input.linked_tool_name === "string" &&
    input.linked_tool_name.trim()
  ) {
    return input;
  }
  return { ...input, linked_tool_name: toolName };
}

function isCommandSessionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "exec_command" ||
    normalized === "shell_command"
  );
}

function isFileSessionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" || normalized === "write" || normalized === "edit"
  );
}

function extractFilePathFromToolInput(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.file_path !== "string") {
    return undefined;
  }
  const filePath = input.file_path.trim();
  return filePath.length > 0 ? filePath : undefined;
}

function enrichWriteStdinWithCommand(items: RenderItem[]): RenderItem[] {
  const sessionToMetadata = new Map<
    string,
    { command?: string; filePath?: string; toolName?: string }
  >();

  return items.map((item) => {
    if (item.type !== "tool_call") {
      return item;
    }

    if (
      isCommandSessionToolName(item.toolName) ||
      isFileSessionToolName(item.toolName)
    ) {
      const sessionId = extractSessionIdFromToolResult(item);
      if (!sessionId) {
        return item;
      }

      const existing = sessionToMetadata.get(sessionId) ?? {};
      const command = isCommandSessionToolName(item.toolName)
        ? extractCommandFromInput(item.toolInput)
        : undefined;
      const filePath = isFileSessionToolName(item.toolName)
        ? extractFilePathFromToolInput(item.toolInput)
        : undefined;

      sessionToMetadata.set(sessionId, {
        command: command ?? existing.command,
        filePath: filePath ?? existing.filePath,
        toolName: item.toolName ?? existing.toolName,
      });
      return item;
    }

    const toolName = item.toolName.toLowerCase();
    if (toolName !== "writestdin" && toolName !== "write_stdin") {
      return item;
    }

    const sessionId = extractSessionIdFromWriteStdinInput(item.toolInput);
    if (!sessionId) {
      return item;
    }

    const metadata = sessionToMetadata.get(sessionId);
    if (!metadata) {
      return item;
    }

    let toolInput = item.toolInput;
    if (metadata.command) {
      toolInput = withLinkedCommand(toolInput, metadata.command);
    }
    if (metadata.filePath) {
      toolInput = withLinkedFilePath(toolInput, metadata.filePath);
    }
    if (metadata.toolName) {
      toolInput = withLinkedToolName(toolInput, metadata.toolName);
    }

    if (toolInput === item.toolInput) {
      return item;
    }

    return {
      ...item,
      toolInput,
    };
  });
}
