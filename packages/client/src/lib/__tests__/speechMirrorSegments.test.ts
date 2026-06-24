import { describe, expect, it } from "vitest";
import {
  getSpeechMirrorSegments,
  type SpeechMirrorTagPosition,
} from "../speechRecognition";

interface Tag extends SpeechMirrorTagPosition {
  id: string;
}

function tag(id: string, position: number, replaceEnd = position): Tag {
  return { id, position, replaceEnd };
}

describe("getSpeechMirrorSegments", () => {
  it("returns one text run when there are no tags", () => {
    expect(getSpeechMirrorSegments("hello", [])).toEqual([
      { type: "text", text: "hello", key: "t0" },
    ]);
  });

  it("interleaves tags at their insertion points, left to right", () => {
    const segs = getSpeechMirrorSegments("abcdef", [tag("y", 4), tag("x", 2)]);
    expect(segs).toEqual([
      { type: "text", text: "ab", key: "t0" },
      { type: "tag", tag: tag("x", 2) },
      { type: "text", text: "cd", key: "t2" },
      { type: "tag", tag: tag("y", 4) },
      { type: "text", text: "ef", key: "t4" },
    ]);
  });

  it("keeps arrival order for tags at the same position (stable)", () => {
    const segs = getSpeechMirrorSegments("abcd", [
      tag("first", 2),
      tag("second", 2),
    ]);
    expect(segs).toEqual([
      { type: "text", text: "ab", key: "t0" },
      { type: "tag", tag: tag("first", 2) },
      { type: "tag", tag: tag("second", 2) },
      { type: "text", text: "cd", key: "t2" },
    ]);
  });

  it("consumes a replaced span [position, replaceEnd]", () => {
    const segs = getSpeechMirrorSegments("abXXef", [tag("r", 2, 4)]);
    expect(segs).toEqual([
      { type: "text", text: "ab", key: "t0" },
      { type: "tag", tag: tag("r", 2, 4) },
      { type: "text", text: "ef", key: "t4" },
    ]);
  });

  it("places a tag at the end with no trailing text run", () => {
    const segs = getSpeechMirrorSegments("ab", [tag("end", 2)]);
    expect(segs).toEqual([
      { type: "text", text: "ab", key: "t0" },
      { type: "tag", tag: tag("end", 2) },
    ]);
  });
});
