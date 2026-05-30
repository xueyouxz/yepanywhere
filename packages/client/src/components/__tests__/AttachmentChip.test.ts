import { describe, expect, it } from "vitest";
import { formatAttachmentName } from "../AttachmentChip";

describe("formatAttachmentName", () => {
  it("keeps the last separator when the next word would overshoot the window", () => {
    expect(formatAttachmentName("disconnect-pull-plate-condition.jpg")).toBe(
      "disconnect-pull-plate...",
    );
  });

  it("allows a partial word only when there are no separators to cut on", () => {
    expect(formatAttachmentName("averylongfilenamewithnospacesorbreaks.txt")).toBe(
      "averylongfilenamewithno...",
    );
  });
});
