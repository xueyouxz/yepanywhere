import type {
  EffortLevel,
  ProviderInfo,
  ProviderName,
  ThinkingConfig,
  ThinkingMode,
} from "@yep-anywhere/shared";
import { normalizeEffortLevelForProvider } from "./effortLevels";

export type ModelIndicatorTone =
  | "off"
  | "auto"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export function normalizeEffortLevel(
  effort?: string,
  provider?: ProviderInfo | ProviderName | null,
): EffortLevel {
  return normalizeEffortLevelForProvider(effort, provider);
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
  provider?: ProviderInfo | ProviderName | null,
): ModelIndicatorTone {
  const mode = getThinkingModeFromProcess(thinking, effort);
  return getIndicatorToneFromSelection(
    mode,
    normalizeEffortLevel(effort, provider),
  );
}

export function getIndicatorToneFromSelection(
  thinkingMode: ThinkingMode,
  effortLevel: EffortLevel,
): ModelIndicatorTone {
  if (thinkingMode === "off") return "off";
  if (thinkingMode === "auto") return "auto";
  return effortLevel;
}
