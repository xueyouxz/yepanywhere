import { describe, expect, it } from "vitest";
import { estimateHoverCardPromptLines } from "../sessionHoverCardLines";

describe("estimateHoverCardPromptLines", () => {
  it("shows more request lines as height grows when a reply is present", () => {
    // The with-reply case is the one that varies with the slider (1 -> 3).
    expect(estimateHoverCardPromptLines(112, true)).toBe(1);
    expect(estimateHoverCardPromptLines(150, true)).toBe(3);
  });

  it("caps at 3 lines regardless of height or reply", () => {
    expect(estimateHoverCardPromptLines(400, true)).toBe(3);
    expect(estimateHoverCardPromptLines(400, false)).toBe(3);
  });

  it("never returns fewer than 1 line", () => {
    expect(estimateHoverCardPromptLines(80, true)).toBe(1);
  });

  it("reserves less without a reply, so more request lines fit", () => {
    expect(estimateHoverCardPromptLines(112, false)).toBe(3);
  });
});
