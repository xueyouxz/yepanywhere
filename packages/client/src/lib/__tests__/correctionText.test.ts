import { describe, expect, it } from "vitest";
import { buildCorrectionText } from "../correctionText";

describe("buildCorrectionText", () => {
  it("generates compact insertions with a unique nearby anchor", () => {
    expect(
      buildCorrectionText(
        "The queued UI should show the image.",
        "The queued UI should show the image or thumbnail.",
      ),
    ).toBe(
      'Correction to previous message:\nThe queued UI should show the image or thumbnail.\n\nChange: insert " or thumbnail" after "image".',
    );
  });

  it("generates compact replacements", () => {
    expect(buildCorrectionText("show the image", "show the thumbnail")).toBe(
      'Correction to previous message:\nshow the thumbnail\n\nChange: replace "image" with "thumbnail".',
    );
  });

  it("generates compact deletions", () => {
    expect(buildCorrectionText("do not show it", "do show it")).toBe(
      'Correction to previous message:\ndo show it\n\nChange: delete "not ".',
    );
  });

  it("expands replacements to word boundaries instead of splitting words", () => {
    expect(buildCorrectionText("(testing)", "(test correction)")).toBe(
      'Correction to previous message:\n(test correction)\n\nChange: replace "testing" with "test correction".',
    );
  });

  it("preserves significant inserted whitespace in compact changes", () => {
    expect(buildCorrectionText("key:value", "key: value")).toBe(
      'Correction to previous message:\nkey: value\n\nChange: insert " " after "key:".',
    );
  });

  it("falls back when the edit cannot be described unambiguously", () => {
    expect(
      buildCorrectionText(
        "do not show it and do not hide it",
        "do show it and do not hide it",
      ),
    ).toBe("Correction to previous message:\ndo show it and do not hide it");
  });

  it("returns null for empty or unchanged corrections", () => {
    expect(buildCorrectionText("same", "same")).toBeNull();
    expect(buildCorrectionText("same", " ")).toBeNull();
  });
});
