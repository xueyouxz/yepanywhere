import { describe, expect, it } from "vitest";
import {
  type SpeechResult,
  appendSpeechTranscript,
  computeSpeechDelta,
  createSpeechInsertionRange,
  getSpeechSelectionFinalDelayMs,
  getSpeechTranscriptInsertionParts,
  getSpeechTranscriptReplacementParts,
  getSpeechTranscriptSeparator,
  insertSpeechTranscriptAt,
  mapSpeechInsertionRangeThroughReplacement,
  mapTextIndexThroughEdit,
  processSpeechResults,
  retargetSpeechInsertionRangeReplacement,
  removeLatestSpeechChunkFromRange,
  replaceSpeechTranscriptBefore,
  replaceSpeechTranscriptInRange,
  removeTextRange,
} from "../speechRecognition";

describe("processSpeechResults", () => {
  it("returns empty for no results", () => {
    const result = processSpeechResults([]);
    expect(result).toEqual({ latestFinal: "", interimText: "" });
  });

  it("extracts the latest final result (mobile behavior)", () => {
    // On mobile, multiple final results accumulate - we want the last one
    const results: SpeechResult[] = [
      { isFinal: true, transcript: "the" },
      { isFinal: true, transcript: "the quick" },
      { isFinal: true, transcript: "the quick brown" },
    ];
    const result = processSpeechResults(results);
    expect(result.latestFinal).toBe("the quick brown");
    expect(result.interimText).toBe("");
  });

  it("collects interim text from non-final results", () => {
    const results: SpeechResult[] = [
      { isFinal: true, transcript: "hello" },
      { isFinal: false, transcript: " world" },
      { isFinal: false, transcript: " foo" },
    ];
    const result = processSpeechResults(results);
    expect(result.latestFinal).toBe("hello");
    expect(result.interimText).toBe(" world foo");
  });

  it("handles only interim results", () => {
    const results: SpeechResult[] = [
      { isFinal: false, transcript: "typing" },
      { isFinal: false, transcript: " in progress" },
    ];
    const result = processSpeechResults(results);
    expect(result.latestFinal).toBe("");
    expect(result.interimText).toBe("typing in progress");
  });
});

describe("computeSpeechDelta", () => {
  describe("mobile behavior (cumulative finals)", () => {
    it("returns empty for no change", () => {
      expect(computeSpeechDelta("hello", "hello")).toBe("");
    });

    it("returns empty for empty latest", () => {
      expect(computeSpeechDelta("", "hello")).toBe("");
    });

    it("extracts delta when latest starts with previous", () => {
      expect(computeSpeechDelta("the quick", "the")).toBe(" quick");
      expect(computeSpeechDelta("the quick brown", "the quick")).toBe(" brown");
    });

    it("handles first utterance (empty previous)", () => {
      expect(computeSpeechDelta("hello", "")).toBe("hello");
    });

    it("extracts multi-word delta", () => {
      expect(computeSpeechDelta("the quick brown fox", "the")).toBe(
        " quick brown fox",
      );
    });
  });

  describe("desktop behavior (separate utterances)", () => {
    it("returns full transcript for new utterance after pause", () => {
      // When user pauses and starts new utterance, it won't start with previous
      expect(computeSpeechDelta("goodbye", "hello world")).toBe("goodbye");
    });

    it("handles completely different utterances", () => {
      expect(computeSpeechDelta("new sentence", "old sentence")).toBe(
        "new sentence",
      );
    });
  });

  describe("edge cases", () => {
    it("handles whitespace-only delta", () => {
      expect(computeSpeechDelta("hello ", "hello")).toBe(" ");
    });

    it("handles punctuation", () => {
      expect(computeSpeechDelta("hello, world", "hello")).toBe(", world");
    });

    it("is case sensitive", () => {
      // "Hello" doesn't start with "hello" so treated as new utterance
      expect(computeSpeechDelta("Hello world", "hello")).toBe("Hello world");
    });
  });
});

describe("appendSpeechTranscript", () => {
  it("separates ordinary transcript chunks with one space", () => {
    expect(appendSpeechTranscript("hello", "world")).toBe("hello world");
  });

  it("does not insert a space before punctuation chunks", () => {
    expect(appendSpeechTranscript("hello", ", world")).toBe("hello, world");
    expect(appendSpeechTranscript("hello", ".")).toBe("hello.");
  });

  it("uses the same separator helper as speech draft mirrors", () => {
    expect(getSpeechTranscriptSeparator("hello", "world")).toBe(" ");
    expect(getSpeechTranscriptSeparator("hello", ", world")).toBe("");
  });
});

describe("speech transcript text edits", () => {
  it("inserts transcript at a selected replacement point", () => {
    expect(insertSpeechTranscriptAt("Fix this please", "exactly", 4)).toEqual({
      text: "Fix exactly this please",
      cursor: "Fix exactly".length,
    });
  });

  it("returns inline mirror parts for a speech-owned insertion point", () => {
    expect(
      getSpeechTranscriptInsertionParts("hello world", "there", 5),
    ).toEqual({
      before: "hello",
      separatorBefore: " ",
      transcript: "there",
      separatorAfter: " ",
      after: "world",
      text: "hello there world",
      cursor: "hello there".length,
    });
  });

  it("returns inline mirror parts for a selected replacement span", () => {
    expect(
      getSpeechTranscriptReplacementParts("replace this text", "spoken", 8, 12),
    ).toEqual({
      before: "replace",
      separatorBefore: " ",
      transcript: "spoken",
      separatorAfter: " ",
      after: "text",
      text: "replace spoken text",
      cursor: "replace spoken".length,
    });
  });

  it("decapitalizes selected mid-sentence replacements to match context", () => {
    expect(
      replaceSpeechTranscriptInRange(
        "Ok, look again.",
        "Focus",
        createSpeechInsertionRange(4, 8),
        0,
      ).text,
    ).toBe("Ok, focus again.");

    expect(
      replaceSpeechTranscriptInRange(
        "look again.",
        "Focus",
        createSpeechInsertionRange(0, 4),
        0,
      ).text,
    ).toBe("Focus again.");
  });

  it("replaces a provider-owned finalized suffix without text matching", () => {
    expect(
      replaceSpeechTranscriptBefore(
        "prefix Testing.",
        "Testing. again.",
        "prefix Testing.".length,
        "Testing.".length,
      ),
    ).toMatchObject({
      text: "prefix Testing. again.",
      cursor: "prefix Testing. again.".length,
      replacementStart: "prefix ".length,
      replacementEnd: "prefix Testing.".length,
      insertedLength: "Testing. again.".length,
    });
  });

  it("removes a speech-owned range for cancel", () => {
    expect(removeTextRange("alpha speech beta", 6, 12)).toEqual({
      text: "alpha  beta",
      cursor: 6,
    });
  });

  it("defers selected text replacement until speech commits", () => {
    const range = createSpeechInsertionRange(8, 12);

    expect(range).toMatchObject({
      start: 8,
      end: 8,
      replaceEnd: 12,
      chunks: [],
    });

    expect(
      replaceSpeechTranscriptInRange("replace this text", "spoken", range, 0),
    ).toMatchObject({
      text: "replace spoken text",
      cursor: "replace spoken".length,
      replacementStart: 8,
      replacementEnd: 12,
    });
  });

  it("arms a hot-mic selection target with a final-chunk grace window", () => {
    const range = createSpeechInsertionRange(4, 4);
    const retargeted = retargetSpeechInsertionRangeReplacement(
      range,
      8,
      12,
      1000,
    );

    expect(retargeted).toMatchObject({
      start: 4,
      end: 8,
      replaceEnd: 12,
      replaceSelectedAtMs: 1000,
    });
    expect(getSpeechSelectionFinalDelayMs(retargeted, 1125)).toBe(175);
    expect(getSpeechSelectionFinalDelayMs(retargeted, 1300)).toBe(0);
  });

  it("does not delay final chunks without a hot non-empty selection", () => {
    expect(
      getSpeechSelectionFinalDelayMs(createSpeechInsertionRange(4, 4)),
    ).toBe(0);
    expect(
      getSpeechSelectionFinalDelayMs(createSpeechInsertionRange(4, 8)),
    ).toBe(0);
  });

  it("does not retarget speech replacement for a collapsed selection", () => {
    const range = createSpeechInsertionRange(4, 4);

    expect(retargetSpeechInsertionRangeReplacement(range, 8, 8, 1000)).toBe(
      range,
    );
  });

  it("removes only the latest committed speech chunk", () => {
    const first = replaceSpeechTranscriptInRange(
      "prefix suffix",
      "first.",
      createSpeechInsertionRange(6, 6),
      0,
    );
    const second = replaceSpeechTranscriptInRange(
      first.text,
      "second.",
      first.range,
      0,
    );

    expect(second.text).toBe("prefix first. second. suffix");

    const removal = removeLatestSpeechChunkFromRange(second.text, second.range);

    expect(removal).toMatchObject({
      text: "prefix first. suffix",
      replacementStart: "prefix first.".length,
      replacementEnd: "prefix first. second.".length,
    });
  });

  it("maps a speech-owned range across user edits before it", () => {
    expect(mapTextIndexThroughEdit("alpha beta", "alpha edited beta", 10)).toBe(
      17,
    );
  });

  it("moves queued speech insertion points after speech inserted at the same index", () => {
    const mapped = mapSpeechInsertionRangeThroughReplacement(
      createSpeechInsertionRange(6, 6),
      6,
      6,
      " first.".length,
    );

    expect(mapped.start).toBe("prefix first.".length);
    expect(mapped.end).toBe("prefix first.".length);
  });

  it("preserves unrelated selected speech replacement targets", () => {
    const mapped = mapSpeechInsertionRangeThroughReplacement(
      createSpeechInsertionRange(12, 18),
      6,
      6,
      " first.".length,
    );

    expect(mapped.start).toBe(19);
    expect(mapped.end).toBe(19);
    expect(mapped.replaceEnd).toBe(25);
  });

  it("clears a selected speech replacement target consumed by another speech edit", () => {
    const mapped = mapSpeechInsertionRangeThroughReplacement(
      createSpeechInsertionRange(6, 12),
      6,
      12,
      " first.".length,
    );

    expect(mapped.start).toBe("prefix first.".length);
    expect(mapped.end).toBe("prefix first.".length);
    expect(mapped.replaceEnd).toBeUndefined();
  });
});
