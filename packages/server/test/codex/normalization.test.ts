import { describe, expect, it } from "vitest";
import { normalizeCodexToolOutputWithContext } from "../../src/codex/normalization.js";

describe("normalizeCodexToolOutputWithContext", () => {
  it("omits inline image data from structured tool output", () => {
    const output = [
      {
        type: "input_image",
        image_url: `data:image/jpeg;base64,${"A".repeat(4096)}`,
      },
    ];

    const normalized = normalizeCodexToolOutputWithContext(output);

    expect(normalized.content).not.toContain("data:image");
    expect(JSON.stringify(normalized.structured)).not.toContain("data:image");
    expect(normalized.content).toContain("inline image/jpeg data omitted");
  });

  it("omits inline image data from JSON string tool output", () => {
    const output = JSON.stringify([
      {
        type: "input_image",
        image_url: `data:image/png;base64,${"A".repeat(4096)}`,
      },
    ]);

    const normalized = normalizeCodexToolOutputWithContext(output);

    expect(normalized.content).not.toContain("data:image");
    expect(JSON.stringify(normalized.structured)).not.toContain("data:image");
    expect(normalized.content).toContain("inline image/png data omitted");
  });
});
