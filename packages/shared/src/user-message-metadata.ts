export type UserMessageDeliveryIntent =
  | "direct"
  | "steer"
  | "deferred"
  | "patient";

/**
 * Default quiet period a patient queued message waits for after the session
 * reaches verified idle, when the item carries no explicit patienceSeconds.
 */
export const DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS = 30;

export const MAX_PATIENT_QUEUE_PATIENCE_SECONDS = 24 * 60 * 60;

/**
 * Normalize a user-supplied patience value to whole seconds in
 * [0, MAX_PATIENT_QUEUE_PATIENCE_SECONDS], or undefined when not a finite
 * number.
 */
export function clampPatientPatienceSeconds(
  value: unknown,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(
    MAX_PATIENT_QUEUE_PATIENCE_SECONDS,
    Math.max(0, Math.round(value)),
  );
}

export const PATIENT_QUEUE_PREFIX = "when done, ";

export const PATIENT_QUEUE_PREFIXES = [
  PATIENT_QUEUE_PREFIX,
  "when you are at a natural wrap-up point, ",
  "as soon as previous requested requests are satisfied, ",
  "as soon as prev. requested requests are satisfied, ",
  "zzz:",
  "zzz: ",
] as const;

export function hasPatientQueuePrefix(message: string): boolean {
  const normalized = message.trimStart().toLocaleLowerCase();
  // Any message already opening with "when done" carries the deferred
  // semantics, so adding the prefix would read as "when done, when done ...".
  if (normalized.startsWith("when done")) return true;
  return PATIENT_QUEUE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix.toLocaleLowerCase()),
  );
}

export function applyPatientQueuePrefix(
  message: string,
  enabled: boolean,
): string {
  if (!enabled || !message || hasPatientQueuePrefix(message)) return message;
  return `${PATIENT_QUEUE_PREFIX}${message}`;
}

export function stripPatientQueuePrefix(message: string): string {
  const leading = message.match(/^\s*/)?.[0] ?? "";
  const body = message.slice(leading.length);
  const lowerBody = body.toLocaleLowerCase();

  if (lowerBody.startsWith("when done")) {
    const stripped = body.slice("when done".length).replace(/^\s*,?\s*/, "");
    return stripped.trim() ? `${leading}${stripped}` : message;
  }

  const prefix = PATIENT_QUEUE_PREFIXES.find((candidate) =>
    lowerBody.startsWith(candidate.toLocaleLowerCase()),
  );
  if (!prefix) return message;

  const stripped = body.slice(prefix.length);
  return stripped.trim() ? `${leading}${stripped}` : message;
}

export interface UserMessageCompositionMetadata {
  typingStartedAt?: string;
  typingEndedAt?: string;
  lastEditedAt?: string;
  submittedAt?: string;
}

export interface UserMessageSpeechMetadata {
  /** Client-generated id shared by speech transcriptions in one composer turn. */
  clientTurnId?: string;
  /** Server transcription ids returned by /api/speech/transcribe. */
  transcriptionIds?: string[];
}

export interface UserMessageMetadata {
  deliveryIntent?: UserMessageDeliveryIntent;
  /**
   * Quiet seconds after verified idle that a patient queued item waits for
   * before delivery. Stamped at queue time; later setting changes do not
   * mutate already queued items.
   */
  patienceSeconds?: number;
  /**
   * Steer with the provider's most-urgent lane (Claude `priority: "now"`:
   * abort in-flight sampling, auto-background running tools). Only
   * meaningful with deliveryIntent "steer" on providers reporting
   * supportsSteerNow.
   */
  steerNow?: boolean;
  composition?: UserMessageCompositionMetadata;
  speech?: UserMessageSpeechMetadata;
  /** Browser-side request timestamp in server-clock epoch ms, when supplied. */
  clientTimestamp?: number;
  /** Server receive time for the REST request that accepted this user turn. */
  serverReceivedAt?: string;
}
