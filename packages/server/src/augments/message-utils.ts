/**
 * Message parsing utilities for augmentation processing.
 * Extracts text deltas, message IDs, and other data from SDK messages.
 */

/**
 * Extract text delta from stream_event messages.
 * Returns the text if this is a text_delta event, otherwise null.
 */
export function extractTextDelta(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== "stream_event") return null;

  const event = message.event as Record<string, unknown> | undefined;
  if (!event) return null;

  // Check for content_block_delta with text_delta
  if (event.type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
  }

  return null;
}

/**
 * Extract message ID from message_start stream events.
 * Returns the message ID if this is a message_start event, otherwise null.
 */
export function extractMessageIdFromStart(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== "stream_event") return null;

  const event = message.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "message_start") return null;

  const msg = event.message as Record<string, unknown> | undefined;
  if (msg && typeof msg.id === "string") {
    return msg.id;
  }

  return null;
}

/**
 * Extract text from assistant messages (Gemini/non-delta).
 * Returns the text content if this is an assistant message with string content.
 */
export function extractTextFromAssistant(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== "assistant") return null;

  const innerMessage = message.message as Record<string, unknown> | undefined;
  const content = innerMessage?.content ?? message.content;

  if (typeof content === "string") {
    return content;
  }
  return null;
}

/**
 * Extract UUID from assistant messages (Gemini/non-delta).
 * Returns the UUID if present on an assistant message.
 */
export function extractIdFromAssistant(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== "assistant") return null;
  if (typeof message.uuid === "string") {
    return message.uuid;
  }
  return null;
}

/**
 * Check if a message is a message_stop event (end of response).
 */
export function isMessageStop(message: Record<string, unknown>): boolean {
  if (message.type !== "stream_event") return false;
  const event = message.event as Record<string, unknown> | undefined;
  return event?.type === "message_stop";
}

/**
 * Check if a message is a result event (Gemini end of response).
 */
export function isResultMessage(message: Record<string, unknown>): boolean {
  return message.type === "result";
}

/**
 * Check if a message signals end of streaming (Claude message_stop or Gemini result).
 */
export function isStreamingComplete(message: Record<string, unknown>): boolean {
  return isMessageStop(message) || isResultMessage(message);
}

/**
 * Mark subagent messages with isSubagent and parentToolUseId fields.
 *
 * Legacy SDK: messages have parent_tool_use_id (pointing to Task tool_use id).
 * SDK 0.2.76+: messages have agentId and isSidechain=true instead.
 */
export function markSubagent<
  T extends {
    parent_tool_use_id?: string | null;
    agentId?: string | null;
    isSidechain?: boolean;
  },
>(message: T): T & { isSubagent?: boolean; parentToolUseId?: string } {
  // Legacy: parent_tool_use_id identifies subagent messages
  if (message.parent_tool_use_id) {
    return {
      ...message,
      isSubagent: true,
      parentToolUseId: message.parent_tool_use_id,
    };
  }
  // SDK 0.2.76+: agentId + isSidechain identifies subagent messages
  if (message.agentId && message.isSidechain) {
    return {
      ...message,
      isSubagent: true,
    };
  }
  return message;
}

/**
 * Extract the text content from a final assistant message for markdown rendering.
 * Returns the text content to render, or null if not applicable.
 */
export function extractTextForFinalRender(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== "assistant") return null;

  const innerMessage = message.message as { content?: unknown } | undefined;
  const content = innerMessage?.content ?? message.content;

  if (typeof content === "string") {
    return content.trim() ? content : null;
  }

  if (Array.isArray(content)) {
    const textBlock = content.find(
      (b): b is { type: "text"; text: string } =>
        b?.type === "text" &&
        typeof b.text === "string" &&
        b.text.trim() !== "",
    );
    return textBlock?.text ?? null;
  }

  return null;
}

/**
 * Get the content array from a message, handling nested SDK message structure.
 * Returns null if content is not an array.
 */
export function getMessageContent(
  message: Record<string, unknown>,
): unknown[] | null {
  const innerMessage = message.message as Record<string, unknown> | undefined;
  const content = innerMessage?.content ?? message.content;
  return Array.isArray(content) ? content : null;
}
