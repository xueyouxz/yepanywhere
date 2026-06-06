export type UserMessageDeliveryIntent =
  | "direct"
  | "steer"
  | "deferred"
  | "patient";

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
  composition?: UserMessageCompositionMetadata;
  speech?: UserMessageSpeechMetadata;
  /** Browser-side request timestamp in server-clock epoch ms, when supplied. */
  clientTimestamp?: number;
  /** Server receive time for the REST request that accepted this user turn. */
  serverReceivedAt?: string;
}
