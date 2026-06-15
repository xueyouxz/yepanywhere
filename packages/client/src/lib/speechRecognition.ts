/**
 * Pure utility functions for speech recognition processing.
 * Extracted for testability - the main hook uses these internally.
 */

export interface SpeechResult {
  isFinal: boolean;
  transcript: string;
}

export interface ProcessedSpeechResults {
  /** The latest (highest index) final transcript */
  latestFinal: string;
  /** Combined interim text from all non-final results */
  interimText: string;
}

/**
 * Process an array of speech recognition results.
 * On mobile, each result is a complete cumulative transcript.
 * On desktop, results are separate utterances.
 * We take the LAST final result since on mobile that's the most complete.
 */
export function processSpeechResults(
  results: SpeechResult[],
): ProcessedSpeechResults {
  let latestFinal = "";
  let interimText = "";

  for (const result of results) {
    if (result.isFinal) {
      latestFinal = result.transcript;
    } else {
      interimText += result.transcript;
    }
  }

  return { latestFinal, interimText };
}

/**
 * Compute the delta (new text) between the latest final transcript
 * and the previous one.
 *
 * On mobile Chrome, each "final" result is cumulative (e.g., "hello" -> "hello world").
 * We extract just the new part (" world") to avoid duplicating text.
 *
 * On desktop, separate utterances are independent, so we return the whole thing.
 */
export function computeSpeechDelta(
  latestFinal: string,
  previousFinal: string,
): string {
  if (!latestFinal || latestFinal === previousFinal) {
    return "";
  }

  // If latest starts with previous, extract just the new part (mobile behavior)
  if (latestFinal.startsWith(previousFinal)) {
    return latestFinal.slice(previousFinal.length);
  }

  // New utterance - return the whole thing (desktop behavior after pause)
  return latestFinal;
}

const NO_SPACE_BEFORE_TRANSCRIPT = /^[,.;:!?%)]/;

export function getSpeechTranscriptSeparator(
  base: string,
  transcript: string,
): "" | " " {
  if (!base.trimEnd() || !transcript.trim()) return "";
  return NO_SPACE_BEFORE_TRANSCRIPT.test(transcript.trim()) ? "" : " ";
}

export interface SpeechTranscriptInsertion {
  text: string;
  cursor: number;
}

export interface SpeechTranscriptReplacement extends SpeechTranscriptInsertion {
  replacementStart: number;
  replacementEnd: number;
  insertedLength: number;
}

export interface SpeechTranscriptInsertionParts {
  before: string;
  separatorBefore: "" | " ";
  transcript: string;
  separatorAfter: "" | " ";
  after: string;
  text: string;
  cursor: number;
}

export function getSpeechTranscriptInsertionParts(
  base: string,
  transcript: string,
  index: number,
): SpeechTranscriptInsertionParts {
  const trimmedTranscript = transcript.trim();
  const clampedIndex = Math.max(0, Math.min(index, base.length));
  const before = base.slice(0, clampedIndex).trimEnd();
  const after = base.slice(clampedIndex).trimStart();
  if (!trimmedTranscript) {
    return {
      before,
      separatorBefore: "",
      transcript: "",
      separatorAfter: "",
      after,
      text: base,
      cursor: clampedIndex,
    };
  }

  const separatorBefore = getSpeechTranscriptSeparator(
    before,
    trimmedTranscript,
  );
  const separatorAfter = getSpeechTranscriptSeparator(trimmedTranscript, after);
  const insertedText = `${separatorBefore}${trimmedTranscript}`;

  return {
    before,
    separatorBefore,
    transcript: trimmedTranscript,
    separatorAfter,
    after,
    text: `${before}${insertedText}${separatorAfter}${after}`,
    cursor: before.length + insertedText.length,
  };
}

export function insertSpeechTranscriptAt(
  base: string,
  transcript: string,
  index: number,
): SpeechTranscriptInsertion {
  const insertion = getSpeechTranscriptInsertionParts(base, transcript, index);
  return {
    text: insertion.text,
    cursor: insertion.cursor,
  };
}

export function replaceSpeechTranscriptBefore(
  base: string,
  transcript: string,
  index: number,
  previousChars: number,
): SpeechTranscriptReplacement {
  const replacementEnd = Math.max(0, Math.min(index, base.length));
  const replacementStart = Math.max(
    0,
    replacementEnd - Math.max(0, previousChars),
  );
  const baseWithoutReplacement = `${base.slice(0, replacementStart)}${base.slice(replacementEnd)}`;
  const insertion = getSpeechTranscriptInsertionParts(
    baseWithoutReplacement,
    transcript,
    replacementStart,
  );
  return {
    ...insertion,
    replacementStart,
    replacementEnd,
    insertedLength:
      insertion.text.length - (base.length - (replacementEnd - replacementStart)),
  };
}

export function appendSpeechTranscript(base: string, transcript: string): string {
  return insertSpeechTranscriptAt(base, transcript, base.length).text;
}

export function mapTextIndexThroughEdit(
  previousText: string,
  nextText: string,
  index: number,
): number {
  const clampedIndex = Math.max(0, Math.min(index, previousText.length));
  let prefixLength = 0;
  const commonLimit = Math.min(previousText.length, nextText.length);
  while (
    prefixLength < commonLimit &&
    previousText[prefixLength] === nextText[prefixLength]
  ) {
    prefixLength += 1;
  }

  if (clampedIndex <= prefixLength) return clampedIndex;

  let suffixLength = 0;
  while (
    suffixLength < previousText.length - prefixLength &&
    suffixLength < nextText.length - prefixLength &&
    previousText[previousText.length - 1 - suffixLength] ===
      nextText[nextText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const previousEditEnd = previousText.length - suffixLength;
  const nextEditEnd = nextText.length - suffixLength;
  if (clampedIndex >= previousEditEnd) {
    return clampedIndex + (nextText.length - previousText.length);
  }
  return nextEditEnd;
}

export function removeTextRange(
  text: string,
  start: number,
  end: number,
): SpeechTranscriptInsertion {
  const clampedStart = Math.max(0, Math.min(start, text.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, text.length));
  return {
    text: `${text.slice(0, clampedStart)}${text.slice(clampedEnd)}`,
    cursor: clampedStart,
  };
}
