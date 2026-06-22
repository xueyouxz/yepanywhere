import type { Message } from "../types";
import { getMessageContent, mergeMessage } from "./mergeMessages";

// A human does not send two semantically identical turns within this window,
// so it is safe to treat same-fingerprint messages this close in time as the
// same message (a stream copy and its durable copy). Deliberately tight to
// minimize false merges; deterministic id matching (where available) carries
// the real load, this is only the backstop.
const DEFAULT_TIMESTAMP_WINDOW_MS = 2000;
const REPLAY_TIMESTAMP_WINDOW_MS = 2000;
const MAX_SCAN_MESSAGES = 400;

const semanticFingerprintCache = new WeakMap<Message, string | null>();

function getMessageRole(message: Message): string {
  const nestedRole = (message.message as { role?: unknown } | undefined)?.role;
  if (nestedRole === "user" || nestedRole === "assistant") {
    return nestedRole;
  }
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "system"
  ) {
    return message.role;
  }
  return "unknown";
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${k}:${stableStringify(v)}`).join(",")}}`;
  }
  return String(value);
}

function normalizeContentBlock(block: unknown): string {
  if (typeof block === "string") {
    return `text:${block}`;
  }

  if (!block || typeof block !== "object") {
    return "";
  }

  const typedBlock = block as Record<string, unknown>;
  const type =
    typeof typedBlock.type === "string" ? typedBlock.type : "unknown";

  switch (type) {
    case "text":
    case "output_text":
      return `text:${typeof typedBlock.text === "string" ? typedBlock.text : ""}`;

    case "thinking":
      return `thinking:${typeof typedBlock.thinking === "string" ? typedBlock.thinking : ""}`;

    case "tool_use":
      return `tool_use:${typeof typedBlock.id === "string" ? typedBlock.id : ""}:${typeof typedBlock.name === "string" ? typedBlock.name : ""}:${stableStringify(typedBlock.input)}`;

    case "tool_result":
      return `tool_result:${typeof typedBlock.tool_use_id === "string" ? typedBlock.tool_use_id : ""}:${typedBlock.is_error === true ? "1" : "0"}:${typeof typedBlock.content === "string" ? typedBlock.content : stableStringify(typedBlock.content)}`;

    default:
      return `${type}:${stableStringify(typedBlock)}`;
  }
}

function isReplayMessage(message: Message): boolean {
  return message.isReplay === true;
}

function getAllowedTimestampDeltaMs(a: Message, b: Message): number {
  return isReplayMessage(a) || isReplayMessage(b)
    ? REPLAY_TIMESTAMP_WINDOW_MS
    : DEFAULT_TIMESTAMP_WINDOW_MS;
}

function getSemanticFingerprint(message: Message): string | null {
  const cached = semanticFingerprintCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  const content = getMessageContent(message);

  let normalizedContent: string;
  if (typeof content === "string") {
    normalizedContent = `text:${content}`;
  } else if (Array.isArray(content)) {
    normalizedContent = content.map(normalizeContentBlock).join("|");
  } else {
    semanticFingerprintCache.set(message, null);
    return null;
  }

  if (!normalizedContent.trim()) {
    semanticFingerprintCache.set(message, null);
    return null;
  }

  const type = typeof message.type === "string" ? message.type : "unknown";
  const role = getMessageRole(message);
  const fingerprint = `${type}|${role}|${normalizedContent}`;
  semanticFingerprintCache.set(message, fingerprint);
  return fingerprint;
}

export function getMessageTimestampMs(message: Message): number | null {
  if (typeof message.timestamp !== "string") {
    return null;
  }
  const ms = Date.parse(message.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

export function hasEquivalentJsonlMessage(
  existing: Message[],
  incoming: Message,
  options?: { windowMs?: number; replayWindowMs?: number },
): boolean {
  const incomingFingerprint = getSemanticFingerprint(incoming);
  const incomingTimestampMs = getMessageTimestampMs(incoming);
  if (!incomingFingerprint || incomingTimestampMs === null) {
    return false;
  }

  const windowMs = options?.windowMs ?? DEFAULT_TIMESTAMP_WINDOW_MS;
  const replayWindowMs = options?.replayWindowMs ?? REPLAY_TIMESTAMP_WINDOW_MS;
  const maxScan = MAX_SCAN_MESSAGES;
  const startIndex = Math.max(0, existing.length - maxScan);

  for (let i = existing.length - 1; i >= startIndex; i -= 1) {
    const candidate = existing[i];
    if (candidate?._source !== "jsonl") {
      continue;
    }
    if (getSemanticFingerprint(candidate) !== incomingFingerprint) {
      continue;
    }
    const candidateTimestampMs = getMessageTimestampMs(candidate);
    if (candidateTimestampMs === null) {
      continue;
    }
    const allowedDeltaMs = isReplayMessage(incoming)
      ? replayWindowMs
      : windowMs;
    if (
      Math.abs(candidateTimestampMs - incomingTimestampMs) <= allowedDeltaMs
    ) {
      return true;
    }
  }

  return false;
}

interface IndexedMessage {
  message: Message;
  originalIndex: number;
  timestampMs: number | null;
  fingerprint: string | null;
}

export function reconcileLinearMessages(
  messages: Message[],
  options?: { windowMs?: number; replayWindowMs?: number },
): Message[] {
  const windowMs = options?.windowMs ?? DEFAULT_TIMESTAMP_WINDOW_MS;
  const replayWindowMs = options?.replayWindowMs ?? REPLAY_TIMESTAMP_WINDOW_MS;
  const maxCandidateWindowMs = Math.max(windowMs, replayWindowMs);

  const sorted = messages
    .map(
      (message, originalIndex): IndexedMessage => ({
        message,
        originalIndex,
        timestampMs: getMessageTimestampMs(message),
        fingerprint: getSemanticFingerprint(message),
      }),
    )
    .sort((a, b) => {
      if (a.timestampMs === null && b.timestampMs === null) {
        return a.originalIndex - b.originalIndex;
      }
      if (a.timestampMs === null) return 1;
      if (b.timestampMs === null) return -1;
      if (a.timestampMs !== b.timestampMs) {
        return a.timestampMs - b.timestampMs;
      }
      return a.originalIndex - b.originalIndex;
    });

  const kept: IndexedMessage[] = [];

  for (const entry of sorted) {
    let merged = false;

    if (entry.fingerprint && entry.timestampMs !== null) {
      for (let i = kept.length - 1; i >= 0; i -= 1) {
        const candidate = kept[i];
        if (!candidate) {
          continue;
        }
        if (candidate.timestampMs === null) {
          continue;
        }
        if (entry.timestampMs - candidate.timestampMs > maxCandidateWindowMs) {
          break;
        }
        if (candidate.fingerprint !== entry.fingerprint) {
          continue;
        }
        const candidateSource = candidate.message._source;
        const entrySource = entry.message._source;
        const sameSource = candidateSource === entrySource;
        const canMergeDifferentSources =
          candidateSource !== undefined &&
          entrySource !== undefined &&
          !sameSource;
        const canMergeSameSource =
          sameSource &&
          candidateSource !== undefined &&
          candidate.timestampMs === entry.timestampMs;
        if (!canMergeDifferentSources && !canMergeSameSource) {
          continue;
        }
        const mergeSource = entrySource ?? candidateSource;
        if (!mergeSource) {
          continue;
        }
        const allowedDeltaMs =
          getAllowedTimestampDeltaMs(candidate.message, entry.message) ??
          windowMs;
        if (entry.timestampMs - candidate.timestampMs > allowedDeltaMs) {
          continue;
        }

        candidate.message = mergeMessage(
          candidate.message,
          entry.message,
          mergeSource,
        );
        candidate.timestampMs =
          getMessageTimestampMs(candidate.message) ?? candidate.timestampMs;
        candidate.fingerprint = getSemanticFingerprint(candidate.message);
        merged = true;
        break;
      }
    }

    if (!merged) {
      kept.push(entry);
    }
  }

  return kept.map((entry) => entry.message);
}
