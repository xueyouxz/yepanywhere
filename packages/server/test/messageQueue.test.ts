import { describe, expect, it } from "vitest";
import { concatUserMessages } from "../src/sdk/messageQueue.js";
import type { UserMessage } from "../src/sdk/types.js";

const msg = (text: string, tempId?: string): UserMessage => ({
  text,
  ...(tempId ? { tempId } : {}),
});

describe("concatUserMessages", () => {
  it("records every chunk's tempId so the echo can clear chips by identity", () => {
    const combined = concatUserMessages([
      msg("first", "temp-1"),
      msg("second", "temp-2"),
      msg("third", "temp-3"),
    ]);

    expect(combined.tempIds).toEqual(["temp-1", "temp-2", "temp-3"]);
    // first.tempId is still the single-id field for backward compatibility.
    expect(combined.tempId).toBe("temp-1");
    expect(combined.text).toBe("first\n\n--------\n\nsecond\n\n--------\n\nthird");
  });

  it("omits tempIds entirely when no chunk carried one", () => {
    const combined = concatUserMessages([msg("a"), msg("b")]);
    expect(combined.tempIds).toBeUndefined();
  });

  it("keeps only the ids that were present", () => {
    const combined = concatUserMessages([
      msg("first", "temp-1"),
      msg("second"),
      msg("third", "temp-3"),
    ]);
    expect(combined.tempIds).toEqual(["temp-1", "temp-3"]);
  });
});
