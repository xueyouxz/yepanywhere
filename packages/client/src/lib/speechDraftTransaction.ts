import type { SpeechTranscriptionResultMetadata } from "./speechProviders/SpeechProvider";
import {
  type SpeechInsertionRange,
  mapSpeechInsertionRangeThroughReplacement,
  removeLatestSpeechChunkFromRange,
  replaceSpeechTranscriptBefore,
  replaceSpeechTranscriptInRange,
} from "./speechRecognition";
import {
  captureTextareaAppendSelection,
  restoreTextareaReplacementSelection,
} from "./textareaSelection";

/** A draft value plus how to restore the textarea selection once it lands. */
export interface PendingTextareaSelectionRestore {
  value: string;
  restore: (textarea: HTMLTextAreaElement) => void;
}

/**
 * Everything a composer surface lends the shared speech-commit algorithm: its
 * textarea, draft get/set, the speech-transaction refs it owns, and optional
 * surface-specific seams (edit noting, transcription-id capture, smart-turn
 * send). Refs stay owned by the component so this is a pure operation over
 * them, not a state container.
 */
export interface SpeechCommitContext {
  textareaRef: { current: HTMLTextAreaElement | null };
  getDraft: () => string;
  setDraft: (next: string) => void;
  setInterimTranscript: (next: string) => void;
  speechInsertionRangeRef: { current: SpeechInsertionRange | null };
  activeSpeechTargetIdRef: { current: string | null };
  speechInsertionRangesRef: { current: Map<string, SpeechInsertionRange> };
  pendingTextareaSelectionRef: { current: PendingTextareaSelectionRestore | null };
  /** Record a programmatic draft edit (composition timing); no-op if absent. */
  onEdit?: (next: string) => void;
  /** Capture a transcription id for submission metadata; no-op if absent. */
  onTranscriptionId?: (id: string) => void;
  /** Submit the composer when a batch/streaming `send` command commits. */
  onSmartTurnSend?: (text: string) => void;
}

/**
 * Integrate one finalized speech chunk (or a spoken `cancel`/`send` command)
 * into the draft at the transaction's insertion target, mapping any other
 * pending speech ranges through the same edit. This is the single shared
 * implementation behind every composer's `commitVoiceTranscript`; see
 * topics/mic-button-speech-ui.md.
 */
export function commitSpeechTranscript(
  ctx: SpeechCommitContext,
  transcript: string,
  metadata?: SpeechTranscriptionResultMetadata,
): void {
  const {
    textareaRef,
    getDraft,
    setDraft,
    setInterimTranscript,
    speechInsertionRangeRef,
    activeSpeechTargetIdRef,
    speechInsertionRangesRef,
    pendingTextareaSelectionRef,
    onEdit,
    onTranscriptionId,
    onSmartTurnSend,
  } = ctx;
  const targetId = metadata?.speechTargetId;
  const getSpeechRange = () =>
    targetId
      ? (speechInsertionRangesRef.current.get(targetId) ?? null)
      : speechInsertionRangeRef.current;
  const updateSpeechRange = (range: SpeechInsertionRange | null) => {
    if (targetId) {
      if (range) {
        speechInsertionRangesRef.current.set(targetId, range);
      } else {
        speechInsertionRangesRef.current.delete(targetId);
      }
      if (activeSpeechTargetIdRef.current === targetId) {
        speechInsertionRangeRef.current = range;
      }
      return;
    }
    speechInsertionRangeRef.current = range;
    if (activeSpeechTargetIdRef.current) {
      if (range) {
        speechInsertionRangesRef.current.set(
          activeSpeechTargetIdRef.current,
          range,
        );
      } else {
        speechInsertionRangesRef.current.delete(activeSpeechTargetIdRef.current);
      }
    }
  };
  const mapOtherSpeechRangesThroughReplacement = (
    replacementStart: number,
    replacementEnd: number,
    insertedLength: number,
    committedRange: SpeechInsertionRange | null,
  ) => {
    if (speechInsertionRangesRef.current.size === 0) return;
    const committedTargetId = targetId ?? activeSpeechTargetIdRef.current;
    const nextRanges = new Map<string, SpeechInsertionRange>();
    for (const [rangeTargetId, range] of speechInsertionRangesRef.current) {
      if (rangeTargetId === committedTargetId) {
        if (committedRange) nextRanges.set(rangeTargetId, committedRange);
        continue;
      }
      nextRanges.set(
        rangeTargetId,
        mapSpeechInsertionRangeThroughReplacement(
          range,
          replacementStart,
          replacementEnd,
          insertedLength,
        ),
      );
    }
    speechInsertionRangesRef.current = nextRanges;
    speechInsertionRangeRef.current =
      activeSpeechTargetIdRef.current !== null
        ? (nextRanges.get(activeSpeechTargetIdRef.current) ?? null)
        : null;
  };
  // Trim the transcript since mobile speech APIs include leading/trailing space.
  const trimmedTranscript = transcript.trim();
  if (metadata?.transcriptionId) {
    onTranscriptionId?.(metadata.transcriptionId);
  }
  if (metadata?.smartTurnCommand === "cancel") {
    const currentText = getDraft();
    const range = getSpeechRange();
    const removal = range
      ? removeLatestSpeechChunkFromRange(currentText, range)
      : null;
    if (removal) {
      if (removal.text !== currentText) {
        const selection = captureTextareaAppendSelection(
          textareaRef.current,
          currentText,
        );
        pendingTextareaSelectionRef.current = {
          value: removal.text,
          restore: (textarea) => {
            restoreTextareaReplacementSelection(
              textarea,
              selection,
              removal.text,
              removal.replacementStart,
              removal.replacementEnd,
              0,
            );
          },
        };
        onEdit?.(removal.text);
        setDraft(removal.text);
        mapOtherSpeechRangesThroughReplacement(
          removal.replacementStart,
          removal.replacementEnd,
          removal.insertedLength,
          removal.range,
        );
        updateSpeechRange(removal.range);
      } else {
        pendingTextareaSelectionRef.current = null;
      }
    } else {
      pendingTextareaSelectionRef.current = null;
      if (targetId) updateSpeechRange(null);
    }
    setInterimTranscript("");
    return;
  }

  const currentText = getDraft();
  const speechRange = getSpeechRange();
  let nextSpeechRange: SpeechInsertionRange | null = null;
  const replacement = speechRange
    ? (() => {
        const rangeReplacement = replaceSpeechTranscriptInRange(
          currentText,
          trimmedTranscript,
          speechRange,
          metadata?.replacePreviousTranscriptChars ?? 0,
        );
        nextSpeechRange = rangeReplacement.range;
        return rangeReplacement;
      })()
    : replaceSpeechTranscriptBefore(
        currentText,
        trimmedTranscript,
        currentText.length,
        0,
      );
  const nextText =
    trimmedTranscript || metadata?.replacePreviousTranscriptChars
      ? replacement.text
      : currentText;
  const shouldRestoreSelection = metadata?.smartTurnCommand !== "send";
  if (nextText !== currentText) {
    const selection = shouldRestoreSelection
      ? captureTextareaAppendSelection(textareaRef.current, currentText)
      : null;
    pendingTextareaSelectionRef.current = shouldRestoreSelection
      ? {
          value: nextText,
          restore: (textarea) => {
            restoreTextareaReplacementSelection(
              textarea,
              selection,
              nextText,
              replacement.replacementStart,
              replacement.replacementEnd,
              replacement.insertedLength,
            );
          },
        }
      : null;
    onEdit?.(nextText);
    setDraft(nextText);
    mapOtherSpeechRangesThroughReplacement(
      replacement.replacementStart,
      replacement.replacementEnd,
      replacement.insertedLength,
      nextSpeechRange,
    );
    if (nextSpeechRange) {
      updateSpeechRange(nextSpeechRange);
    }
  }
  setInterimTranscript("");
  if (metadata?.smartTurnCommand) {
    updateSpeechRange(null);
  }
  if (metadata?.smartTurnCommand === "send") {
    onSmartTurnSend?.(nextText);
  }
}
