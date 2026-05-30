import type {
  EffortLevel,
  ThinkingConfig,
  ThinkingMode,
} from "@yep-anywhere/shared";

export type ModelIndicatorTone =
  | "off"
  | "auto"
  | "low"
  | "medium"
  | "high"
  | "max";

export function normalizeEffortLevel(effort?: string): EffortLevel {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return effort;
    case "max":
    case "xhigh":
      return "max";
    default:
      return "high";
  }
}

export function getThinkingModeFromProcess(
  thinking?: ThinkingConfig | { type: string },
  effort?: string,
): ThinkingMode {
  if (!thinking || thinking.type === "disabled") {
    return "off";
  }
  return effort ? "on" : "auto";
}

export function getIndicatorToneFromProcess(
  thinking?: ThinkingConfig | { type: string },
  effort?: string,
): ModelIndicatorTone {
  const mode = getThinkingModeFromProcess(thinking, effort);
  return getIndicatorToneFromSelection(mode, normalizeEffortLevel(effort));
}

export function getIndicatorToneFromSelection(
  thinkingMode: ThinkingMode,
  effortLevel: EffortLevel,
): ModelIndicatorTone {
  if (thinkingMode === "off") return "off";
  if (thinkingMode === "auto") return "auto";
  return effortLevel;
}
