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
const INITIAL_TITLE_CASE_WORD = /^(\s*[(["'`]*)([A-Z])(?=[a-z])/;
const LOWERCASE_CONTEXT_WORD = /^[^A-Za-z]*[a-z]/;
const SENTENCE_INITIAL_CONTEXT = /(?:^|[.!?][)"'\]]*)$/;
export const SPEECH_SELECTION_FINAL_GRACE_MS = 300;

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

export interface SpeechOwnedChunk {
  start: number;
  end: number;
}

export interface SpeechInsertionRange {
  start: number;
  end: number;
  replaceEnd?: number;
  replaceSelectedAtMs?: number;
  chunks: SpeechOwnedChunk[];
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

export interface SpeechMirrorTagPosition {
  /** Insertion point in the base text (where this pending result will land). */
  position: number;
  /** End of any selected span this tag replaces (>= position), else equals it. */
  replaceEnd: number;
}

export type SpeechMirrorSegment<T extends SpeechMirrorTagPosition> =
  | { type: "text"; text: string; key: string }
  | { type: "tag"; tag: T };

/**
 * Split `base` into text runs interleaved with pending-speech tags, each placed
 * at its own insertion point, sorted left to right (ties keep arrival order).
 * Lets the composer mirror render one tag per pending request at its own
 * position — e.g. two overlapping batch transcriptions — instead of a single
 * tag standing in for all of them. A tag that replaces a selected span consumes
 * `[position, replaceEnd]` of the base.
 */
export function getSpeechMirrorSegments<T extends SpeechMirrorTagPosition>(
  base: string,
  tags: readonly T[],
): SpeechMirrorSegment<T>[] {
  const sorted = [...tags].sort((a, b) => a.position - b.position);
  const segments: SpeechMirrorSegment<T>[] = [];
  let cursor = 0;
  for (const tag of sorted) {
    const at = Math.max(cursor, Math.min(tag.position, base.length));
    if (at > cursor) {
      segments.push({
        type: "text",
        text: base.slice(cursor, at),
        key: `t${cursor}`,
      });
    }
    segments.push({ type: "tag", tag });
    cursor = Math.max(at, Math.min(tag.replaceEnd, base.length));
  }
  if (cursor < base.length) {
    segments.push({
      type: "text",
      text: base.slice(cursor),
      key: `t${cursor}`,
    });
  }
  return segments;
}

function lowercaseInitialTitleCaseWord(transcript: string): string {
  return transcript.replace(
    INITIAL_TITLE_CASE_WORD,
    (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toLowerCase()}`,
  );
}

function isSentenceInitialReplacementContext(
  base: string,
  replacementStart: number,
): boolean {
  return SENTENCE_INITIAL_CONTEXT.test(
    base.slice(0, replacementStart).trimEnd(),
  );
}

function normalizeSpeechTranscriptForReplacementContext(
  base: string,
  transcript: string,
  replacementStart: number,
  replacementEnd: number,
): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript || replacementEnd <= replacementStart) {
    return trimmedTranscript;
  }
  const selectedText = base.slice(replacementStart, replacementEnd);
  if (!LOWERCASE_CONTEXT_WORD.test(selectedText)) return trimmedTranscript;
  if (isSentenceInitialReplacementContext(base, replacementStart)) {
    return trimmedTranscript;
  }
  return lowercaseInitialTitleCaseWord(trimmedTranscript);
}

export function getSpeechTranscriptReplacementParts(
  base: string,
  transcript: string,
  replacementStart: number,
  replacementEnd: number,
): SpeechTranscriptInsertionParts {
  const clampedReplacementStart = Math.max(
    0,
    Math.min(replacementStart, base.length),
  );
  const clampedReplacementEnd = Math.max(
    clampedReplacementStart,
    Math.min(replacementEnd, base.length),
  );
  const normalizedTranscript = normalizeSpeechTranscriptForReplacementContext(
    base,
    transcript,
    clampedReplacementStart,
    clampedReplacementEnd,
  );
  const baseWithoutReplacement = `${base.slice(0, clampedReplacementStart)}${base.slice(clampedReplacementEnd)}`;
  return getSpeechTranscriptInsertionParts(
    baseWithoutReplacement,
    normalizedTranscript,
    clampedReplacementStart,
  );
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
      insertion.text.length -
      (base.length - (replacementEnd - replacementStart)),
  };
}

export interface SpeechRangeReplacement extends SpeechTranscriptReplacement {
  range: SpeechInsertionRange;
}

export function createSpeechInsertionRange(
  selectionStart: number,
  selectionEnd: number,
): SpeechInsertionRange {
  return {
    start: selectionStart,
    end: selectionStart,
    replaceEnd: selectionEnd > selectionStart ? selectionEnd : undefined,
    chunks: [],
  };
}

export function retargetSpeechInsertionRangeReplacement(
  range: SpeechInsertionRange,
  selectionStart: number,
  selectionEnd: number,
  selectedAtMs = Date.now(),
): SpeechInsertionRange {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.max(start, Math.max(selectionStart, selectionEnd));
  if (end <= start) return range;
  return {
    ...range,
    end: start,
    replaceEnd: end,
    replaceSelectedAtMs: selectedAtMs,
  };
}

export function clearSpeechInsertionRangeReplacement(
  range: SpeechInsertionRange,
): SpeechInsertionRange {
  if (range.replaceEnd === undefined && range.replaceSelectedAtMs === undefined)
    return range;
  return {
    ...range,
    replaceEnd: undefined,
    replaceSelectedAtMs: undefined,
  };
}

export function getSpeechSelectionFinalDelayMs(
  range: SpeechInsertionRange | null,
  nowMs = Date.now(),
): number {
  if (
    !range ||
    range.replaceEnd === undefined ||
    range.replaceEnd <= range.end ||
    range.replaceSelectedAtMs === undefined
  ) {
    return 0;
  }

  const elapsedMs = nowMs - range.replaceSelectedAtMs;
  if (elapsedMs < 0) return SPEECH_SELECTION_FINAL_GRACE_MS;
  return Math.max(0, SPEECH_SELECTION_FINAL_GRACE_MS - elapsedMs);
}

export function mapSpeechInsertionRangeThroughEdit(
  previousText: string,
  nextText: string,
  range: SpeechInsertionRange,
): SpeechInsertionRange {
  return {
    start: mapTextIndexThroughEdit(previousText, nextText, range.start),
    end: mapTextIndexThroughEdit(previousText, nextText, range.end),
    replaceEnd:
      range.replaceEnd === undefined
        ? undefined
        : mapTextIndexThroughEdit(previousText, nextText, range.replaceEnd),
    replaceSelectedAtMs: range.replaceSelectedAtMs,
    chunks: range.chunks.map((chunk) => ({
      start: mapTextIndexThroughEdit(previousText, nextText, chunk.start),
      end: mapTextIndexThroughEdit(previousText, nextText, chunk.end),
    })),
  };
}

function mapTextIndexThroughReplacement(
  index: number,
  replacementStart: number,
  replacementEnd: number,
  insertedLength: number,
): number {
  const start = Math.max(0, replacementStart);
  const end = Math.max(start, replacementEnd);
  const delta = insertedLength - (end - start);
  if (index < start) return index;
  if (start === end) return index + insertedLength;
  if (index > end) return index + delta;
  return start + insertedLength;
}

function speechReplacementIntersectsRangeReplacement(
  range: SpeechInsertionRange,
  replacementStart: number,
  replacementEnd: number,
): boolean {
  if (range.replaceEnd === undefined || range.replaceEnd <= range.end) {
    return false;
  }
  return replacementStart < range.replaceEnd && replacementEnd > range.end;
}

export function mapSpeechInsertionRangeThroughReplacement(
  range: SpeechInsertionRange,
  replacementStart: number,
  replacementEnd: number,
  insertedLength: number,
): SpeechInsertionRange {
  const mapIndex = (index: number): number =>
    mapTextIndexThroughReplacement(
      index,
      replacementStart,
      replacementEnd,
      insertedLength,
    );
  const mapped = {
    start: mapIndex(range.start),
    end: mapIndex(range.end),
    replaceEnd:
      range.replaceEnd === undefined ? undefined : mapIndex(range.replaceEnd),
    replaceSelectedAtMs: range.replaceSelectedAtMs,
    chunks: range.chunks.map((chunk) => ({
      start: mapIndex(chunk.start),
      end: mapIndex(chunk.end),
    })),
  };
  return speechReplacementIntersectsRangeReplacement(
    range,
    replacementStart,
    replacementEnd,
  )
    ? clearSpeechInsertionRangeReplacement(mapped)
    : mapped;
}

function mapChunkAfterReplacement(
  chunk: SpeechOwnedChunk,
  replacementStart: number,
  replacementEnd: number,
  delta: number,
): SpeechOwnedChunk | null {
  if (chunk.end <= replacementStart) return chunk;
  if (chunk.start >= replacementEnd) {
    return { start: chunk.start + delta, end: chunk.end + delta };
  }
  return null;
}

export function replaceSpeechTranscriptInRange(
  base: string,
  transcript: string,
  range: SpeechInsertionRange,
  previousChars: number,
): SpeechRangeReplacement {
  const replacementEnd = Math.max(range.end, range.replaceEnd ?? range.end);
  const replacingExplicitRange =
    range.replaceEnd !== undefined && range.replaceEnd > range.end;
  const replacementStart = Math.max(
    0,
    replacingExplicitRange
      ? Math.min(range.end, base.length)
      : Math.min(range.end, base.length) - Math.max(0, previousChars),
  );
  const clampedReplacementEnd = Math.max(
    replacementStart,
    Math.min(replacementEnd, base.length),
  );
  const insertion = replacingExplicitRange
    ? getSpeechTranscriptReplacementParts(
        base,
        transcript,
        replacementStart,
        clampedReplacementEnd,
      )
    : getSpeechTranscriptInsertionParts(
        `${base.slice(0, replacementStart)}${base.slice(clampedReplacementEnd)}`,
        transcript,
        replacementStart,
      );
  const insertionStart = insertion.before.length;
  const insertedLength = insertion.cursor - replacementStart;
  const delta = insertion.text.length - base.length;
  const nextChunks = range.chunks
    .map((chunk) =>
      mapChunkAfterReplacement(
        chunk,
        replacementStart,
        clampedReplacementEnd,
        delta,
      ),
    )
    .filter((chunk): chunk is SpeechOwnedChunk => chunk !== null);
  if (insertedLength > 0) {
    nextChunks.push({
      start: insertionStart,
      end: insertion.cursor,
    });
    nextChunks.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  return {
    ...insertion,
    replacementStart,
    replacementEnd: clampedReplacementEnd,
    insertedLength,
    range: {
      start: range.start,
      end: insertion.cursor,
      chunks: nextChunks,
    },
  };
}

export function removeLatestSpeechChunkFromRange(
  base: string,
  range: SpeechInsertionRange,
): SpeechRangeReplacement | null {
  const latest = range.chunks.at(-1);
  if (!latest) return null;

  const replacement = removeTextRange(base, latest.start, latest.end);
  const nextChunks = range.chunks.slice(0, -1);
  const nextEnd = nextChunks.at(-1)?.end ?? latest.start;
  return {
    text: replacement.text,
    cursor: replacement.cursor,
    replacementStart: latest.start,
    replacementEnd: latest.end,
    insertedLength: 0,
    range: {
      start: range.start,
      end: nextEnd,
      replaceEnd: range.replaceEnd,
      replaceSelectedAtMs: range.replaceSelectedAtMs,
      chunks: nextChunks,
    },
  };
}

export function appendSpeechTranscript(
  base: string,
  transcript: string,
): string {
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
