import type { SpeechTurnCommand, SpeechWordTimestamp } from "./SpeechProvider";

const SPEECH_TURN_COMMANDS = new Set<SpeechTurnCommand>([
  "send",
  "cancel",
  "wait",
]);

const BATCH_SPEECH_COMMANDS = new Set<SpeechTurnCommand>(["send", "cancel"]);

export interface SpeechCommandDecision {
  command: SpeechTurnCommand;
  transcript: string;
  recognizedCommand: boolean;
}

export function getWordText(word: SpeechWordTimestamp | undefined): string {
  if (!word) return "";
  return word.punctuated_word ?? word.word ?? word.text ?? "";
}

export function normalizeSpeechCommandWord(
  word: string,
): SpeechTurnCommand | null {
  const normalized = word
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return SPEECH_TURN_COMMANDS.has(normalized as SpeechTurnCommand)
    ? (normalized as SpeechTurnCommand)
    : null;
}

export function getTrailingTranscriptCommand(
  transcript: string,
): SpeechTurnCommand | null {
  const match = transcript.match(/[a-z0-9]+[^a-z0-9]*$/i);
  return normalizeSpeechCommandWord(match?.[0] ?? "");
}

export function stripTrailingCommandWord(
  transcript: string,
  command: SpeechTurnCommand,
): string {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return transcript
    .replace(
      new RegExp(`(?:^|\\s)[^a-z0-9]*${escaped}[^a-z0-9]*\\s*$`, "i"),
      "",
    )
    .trim();
}

export function decideBatchSpeechCommand(
  transcript: string,
): SpeechCommandDecision {
  const trimmed = transcript.trim();
  const command = getTrailingTranscriptCommand(trimmed);
  if (command && BATCH_SPEECH_COMMANDS.has(command)) {
    return {
      command,
      recognizedCommand: true,
      transcript:
        command === "cancel" ? "" : stripTrailingCommandWord(trimmed, command),
    };
  }
  return { command: "wait", transcript: trimmed, recognizedCommand: false };
}
