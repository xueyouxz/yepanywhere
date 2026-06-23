// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { toolRegistry } from "../index";

describe("toolRegistry.getDisplayName tense", () => {
  it("reads present tense while pending and past tense once finished", () => {
    expect(toolRegistry.getDisplayName("Bash", "pending")).toBe("Run");
    expect(toolRegistry.getDisplayName("Bash", "complete")).toBe("Ran");
    // No status argument keeps the past-tense default (e.g. non-header uses).
    expect(toolRegistry.getDisplayName("Bash")).toBe("Ran");

    expect(toolRegistry.getDisplayName("AskUserQuestion", "pending")).toBe(
      "Asking",
    );
    expect(toolRegistry.getDisplayName("AskUserQuestion", "complete")).toBe(
      "Asked",
    );
  });

  it("falls back to the raw tool name when no display name is registered", () => {
    expect(toolRegistry.getDisplayName("TotallyUnknownTool", "pending")).toBe(
      "TotallyUnknownTool",
    );
  });
});
