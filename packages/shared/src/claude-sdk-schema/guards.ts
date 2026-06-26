import type { AssistantEntry } from "./entry/AssistantEntrySchema.js";
import type { SystemEntry } from "./entry/SystemEntrySchema.js";
import type { UserEntry } from "./entry/UserEntrySchema.js";
import type { ClaudeSessionEntry } from "./index.js";

function getObjectField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function getStringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!value) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function getLastStringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!value) return undefined;
  const field = value[key];
  if (!Array.isArray(field)) return undefined;

  for (let index = field.length - 1; index >= 0; index -= 1) {
    const item = field[index];
    if (typeof item === "string") {
      return item;
    }
  }

  return undefined;
}

/** Check if entry is a compact_boundary system entry */
export function isCompactBoundary(
  entry: ClaudeSessionEntry,
): entry is SystemEntry & { subtype: "compact_boundary" } {
  return (
    entry.type === "system" &&
    "subtype" in entry &&
    entry.subtype === "compact_boundary"
  );
}

/** Get logicalParentUuid if compact_boundary, otherwise undefined */
export function getLogicalParentUuid(
  entry: ClaudeSessionEntry,
): string | undefined {
  if (isCompactBoundary(entry)) {
    const logicalParentUuid = (entry as { logicalParentUuid?: string })
      .logicalParentUuid;
    if (logicalParentUuid) {
      return logicalParentUuid;
    }

    const compactMetadata = (entry as { compactMetadata?: unknown })
      .compactMetadata;
    if (!compactMetadata || typeof compactMetadata !== "object") {
      return undefined;
    }

    const metadata = compactMetadata as Record<string, unknown>;
    const preservedSegment = getObjectField(metadata, "preservedSegment");
    const segmentTailUuid = getStringField(preservedSegment, "tailUuid");
    if (segmentTailUuid) {
      return segmentTailUuid;
    }

    const preservedMessages = getObjectField(metadata, "preservedMessages");
    return (
      getLastStringField(preservedMessages, "uuids") ??
      getLastStringField(preservedMessages, "allUuids")
    );
  }
  return undefined;
}

/** Check if entry is a conversation entry (has message field) */
export function isConversationEntry(
  entry: ClaudeSessionEntry,
): entry is UserEntry | AssistantEntry {
  return entry.type === "user" || entry.type === "assistant";
}

/** Get message content from user/assistant entry */
export function getMessageContent(entry: ClaudeSessionEntry) {
  if (isConversationEntry(entry)) {
    // Use optional chaining for defensive access (handles incomplete mock data in tests)
    return (entry as { message?: { content?: unknown } }).message?.content;
  }
  return undefined;
}
