/**
 * Compact-boundary pagination for session messages.
 *
 * Slices a normalized message array at compact_boundary positions to reduce
 * payload size for initial loads. This runs AFTER normalization but BEFORE
 * expensive augmentation (markdown, diffs, syntax highlighting).
 */

import type { Message } from "../supervisor/types.js";

/** Pagination metadata returned alongside sliced messages */
export interface PaginationInfo {
  /** Whether there are older messages not included in this response */
  hasOlderMessages: boolean;
  /** Total message count in the full session */
  totalMessageCount: number;
  /** Number of messages returned in this response */
  returnedMessageCount: number;
  /** UUID of the first returned message (pass as beforeMessageId to load previous chunk) */
  truncatedBeforeMessageId?: string;
  /** Total number of compact_boundary entries in the session */
  totalCompactions: number;
  /** Total number of user turns in the full session, when turn slicing was used */
  totalUserTurns?: number;
  /** Whether this response came from the aggressive user-turn truncation path */
  truncatedBy?: "compact_boundary" | "user_turn";
}

/** Result of slicing messages at compact boundaries */
export interface SliceResult {
  messages: Message[];
  pagination: PaginationInfo;
}

export interface SliceAfterResult {
  messages: Message[];
  found: boolean;
}

function getMessageId(m: Message): string | undefined {
  return m.uuid ?? (typeof m.id === "string" ? m.id : undefined);
}

/**
 * Return only messages after the requested message id.
 *
 * Some provider readers can apply afterMessageId while reading, but others only
 * expose a full normalized message list. Applying this after normalization keeps
 * incremental refresh responses small when the anchor is present, while leaving
 * already-filtered reader results unchanged when the anchor is absent.
 */
export function sliceAfterMessageId(
  messages: Message[],
  afterMessageId?: string,
): Message[] {
  return sliceAfterMessageIdWithMatch(messages, afterMessageId).messages;
}

export function sliceAfterMessageIdWithMatch(
  messages: Message[],
  afterMessageId?: string,
): SliceAfterResult {
  if (!afterMessageId) {
    return { messages, found: false };
  }

  const index = messages.findIndex((message) => {
    return getMessageId(message) === afterMessageId;
  });
  if (index === -1) {
    return { messages, found: false };
  }

  return { messages: messages.slice(index + 1), found: true };
}

function isCompactBoundary(m: Message): boolean {
  return m.type === "system" && m.subtype === "compact_boundary";
}

function isUserTurn(m: Message): boolean {
  const record = m as Message & {
    role?: unknown;
    message?: { role?: unknown };
  };
  const role =
    typeof record.role === "string"
      ? record.role
      : typeof record.message?.role === "string"
        ? record.message.role
        : undefined;
  return m.type === "user" || role === "user";
}

/**
 * Slice messages to return only the tail portion starting from the Nth-from-last
 * compact_boundary. The boundary message itself is included so the client sees
 * the "Context compacted" divider.
 *
 * @param messages - Normalized message array (active branch, in conversation order)
 * @param tailCompactions - Number of compact boundaries to include from the end
 * @param beforeMessageId - Optional cursor: only consider messages before this ID
 *                          (used for loading progressively older chunks)
 */
export function sliceAtCompactBoundaries(
  messages: Message[],
  tailCompactions: number,
  beforeMessageId?: string,
): SliceResult {
  const totalMessageCount = messages.length;

  // For "load older" requests: work with messages before the cursor
  let workingMessages = messages;
  if (beforeMessageId) {
    const idx = messages.findIndex((m) => getMessageId(m) === beforeMessageId);
    // A stale or missing older-page cursor must not fall back to the current
    // tail/full history: the client prepends this response, so overlap can
    // duplicate large chunks in memory. Missing and first-message cursors both
    // mean "there is no known older page to return."
    workingMessages = idx > 0 ? messages.slice(0, idx) : [];
  }

  // Find all compact_boundary indices in the working set
  const compactIndices: number[] = [];
  for (let i = 0; i < workingMessages.length; i++) {
    const m = workingMessages[i];
    if (m && isCompactBoundary(m)) {
      compactIndices.push(i);
    }
  }

  const totalCompactions = compactIndices.length;

  // If fewer or equal compactions than requested, return everything
  if (compactIndices.length <= tailCompactions) {
    return {
      messages: workingMessages,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount,
        returnedMessageCount: workingMessages.length,
        truncatedBeforeMessageId: undefined,
        totalCompactions,
      },
    };
  }

  // Slice starting from the Nth-from-last compact boundary (inclusive)
  const sliceFromIdx =
    compactIndices[compactIndices.length - tailCompactions] ?? 0;
  const slicedMessages = workingMessages.slice(sliceFromIdx);
  const firstId = slicedMessages[0]
    ? getMessageId(slicedMessages[0])
    : undefined;

  return {
    messages: slicedMessages,
    pagination: {
      hasOlderMessages: true,
      totalMessageCount,
      returnedMessageCount: slicedMessages.length,
      truncatedBeforeMessageId: firstId,
      totalCompactions,
    },
  };
}

/**
 * Slice messages to a recent user-turn window, or to a caller-chosen user turn.
 *
 * This is intentionally more aggressive than compact-boundary pagination: it is
 * an opt-in browser memory workaround for very long transcripts where the user
 * wants the client to avoid receiving older history at all.
 */
export function sliceAtUserTurnBoundary(
  messages: Message[],
  tailTurns: number,
  fromMessageId?: string,
): SliceResult {
  const totalMessageCount = messages.length;
  const userTurnIndices: number[] = [];
  let totalCompactions = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (isUserTurn(message)) {
      userTurnIndices.push(index);
    }
    if (isCompactBoundary(message)) {
      totalCompactions += 1;
    }
  }

  const totalUserTurns = userTurnIndices.length;
  let sliceFromIdx = 0;

  if (fromMessageId) {
    sliceFromIdx = messages.findIndex((m) => getMessageId(m) === fromMessageId);
    if (sliceFromIdx < 0) {
      return {
        messages: [],
        pagination: {
          hasOlderMessages: false,
          totalMessageCount,
          returnedMessageCount: 0,
          truncatedBeforeMessageId: undefined,
          totalCompactions,
          totalUserTurns,
          truncatedBy: "user_turn",
        },
      };
    }
  } else if (totalUserTurns > tailTurns) {
    sliceFromIdx = userTurnIndices[totalUserTurns - tailTurns] ?? 0;
  }

  const slicedMessages = messages.slice(sliceFromIdx);
  const firstId = slicedMessages[0] ? getMessageId(slicedMessages[0]) : undefined;

  return {
    messages: slicedMessages,
    pagination: {
      hasOlderMessages: sliceFromIdx > 0,
      totalMessageCount,
      returnedMessageCount: slicedMessages.length,
      truncatedBeforeMessageId: sliceFromIdx > 0 ? firstId : undefined,
      totalCompactions,
      totalUserTurns,
      truncatedBy: "user_turn",
    },
  };
}
