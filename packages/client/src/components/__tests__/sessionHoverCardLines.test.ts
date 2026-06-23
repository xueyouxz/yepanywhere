import { describe, expect, it } from "vitest";
import { estimateHoverCardPromptLines } from "../sessionHoverCardLines";

describe("estimateHoverCardPromptLines", () => {
  it("shows more request lines as height grows when a reply is present", () => {
    // The with-reply case is the one that varies with the slider (1 -> 3).
    expect(estimateHoverCardPromptLines(112, true)).toBe(1);
    expect(estimateHoverCardPromptLines(150, true)).toBe(3);
  });

  it("is bounded only by height, with no fixed line cap", () => {
    expect(estimateHoverCardPromptLines(400, true)).toBe(16);
    expect(estimateHoverCardPromptLines(600, true)).toBe(26);
  });

  it("never returns fewer than 1 line", () => {
    expect(estimateHoverCardPromptLines(80, true)).toBe(1);
  });

  it("reserves less without a reply, so more request lines fit", () => {
    expect(estimateHoverCardPromptLines(112, false)).toBe(3);
  });
});
