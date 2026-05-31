import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  getEffortLevelLabel,
  getEffortLevelOptions,
  normalizeEffortLevelForProvider,
  resolveSupportedEffortLevel,
} from "../effortLevels";

const claudeProvider: ProviderInfo = {
  name: "claude",
  displayName: "Claude",
  installed: true,
  authenticated: true,
  enabled: true,
};

const codexProvider: ProviderInfo = {
  name: "codex",
  displayName: "Codex",
  installed: true,
  authenticated: true,
  enabled: true,
};

describe("effort level options", () => {
  it("defaults Claude to all five SDK effort levels", () => {
    expect(getEffortLevelOptions({ provider: claudeProvider })).toEqual([
      expect.objectContaining({ value: "low", label: "Low" }),
      expect.objectContaining({ value: "medium", label: "Medium" }),
      expect.objectContaining({ value: "high", label: "High" }),
      expect.objectContaining({ value: "xhigh", label: "Extra" }),
      expect.objectContaining({ value: "max", label: "Max" }),
    ]);
  });

  it("uses provider/model reported levels when present", () => {
    expect(
      getEffortLevelOptions({
        provider: claudeProvider,
        model: {
          id: "sonnet",
          name: "Sonnet",
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
        },
      }).map((option) => option.value),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("uses Codex reasoning metadata and does not invent max", () => {
    const options = getEffortLevelOptions({
      provider: codexProvider,
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
          { reasoningEffort: "xhigh" },
        ],
      },
    });

    expect(options.map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getEffortLevelLabel("xhigh", codexProvider)).toBe("Extra High");
  });

  it("normalizes legacy Codex max to xhigh for display and selection", () => {
    const options = getEffortLevelOptions({ provider: codexProvider });

    expect(normalizeEffortLevelForProvider("max", codexProvider)).toBe("xhigh");
    expect(resolveSupportedEffortLevel("max", options)).toBe("xhigh");
  });
});
