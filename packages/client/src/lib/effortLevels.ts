import type {
  EffortLevel,
  ModelInfo,
  ProviderInfo,
  ProviderName,
} from "@yep-anywhere/shared";

export interface EffortLevelOption {
  value: EffortLevel;
  label: string;
  description: string;
}

export const EFFORT_LEVEL_ORDER: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const GENERIC_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

const CODEX_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh"];

const EFFORT_LEVEL_SET = new Set<string>(EFFORT_LEVEL_ORDER);

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVEL_SET.has(value);
}

function getProviderName(
  provider?: ProviderInfo | ProviderName | null,
): ProviderName | undefined {
  if (!provider) return undefined;
  return typeof provider === "string" ? provider : provider.name;
}

function getModelInfo(
  provider?: ProviderInfo | ProviderName | null,
  model?: ModelInfo | string | null,
): ModelInfo | undefined {
  if (!model) return undefined;
  if (typeof model !== "string") return model;
  if (!provider || typeof provider === "string") return undefined;
  return provider.models?.find((candidate) => candidate.id === model);
}

function sortEffortLevels(levels: EffortLevel[]): EffortLevel[] {
  const seen = new Set<EffortLevel>();
  for (const level of levels) {
    seen.add(level);
  }
  return EFFORT_LEVEL_ORDER.filter((level) => seen.has(level));
}

function getModelSupportedEfforts(model?: ModelInfo): EffortLevel[] | null {
  const directLevels =
    model?.supportedEffortLevels?.filter(isEffortLevel) ?? [];
  if (directLevels.length > 0) {
    return sortEffortLevels(directLevels);
  }

  const reasoningLevels =
    model?.supportedReasoningEfforts
      ?.map((effort) => effort.reasoningEffort)
      .filter(isEffortLevel) ?? [];
  if (reasoningLevels.length > 0) {
    return sortEffortLevels(reasoningLevels);
  }

  return null;
}

function getFallbackEffortLevels(providerName?: ProviderName): EffortLevel[] {
  switch (providerName) {
    case "claude":
    case "claude-ollama":
      return EFFORT_LEVEL_ORDER;
    case "codex":
      return CODEX_EFFORT_LEVELS;
    default:
      return GENERIC_EFFORT_LEVELS;
  }
}

export function getEffortLevelLabel(
  level: EffortLevel,
  provider?: ProviderInfo | ProviderName | null,
): string {
  const providerName = getProviderName(provider);
  switch (level) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return providerName === "claude" || providerName === "claude-ollama"
        ? "Extra"
        : "Extra High";
    case "max":
      return "Max";
  }
}

function getFallbackDescription(
  level: EffortLevel,
  provider?: ProviderInfo | ProviderName | null,
): string {
  const providerName = getProviderName(provider);
  switch (level) {
    case "low":
      return "Fastest responses";
    case "medium":
      return "Moderate reasoning";
    case "high":
      return "Deep reasoning";
    case "xhigh":
      return providerName === "claude" || providerName === "claude-ollama"
        ? "For your hardest tasks"
        : "Extra-high reasoning";
    case "max":
      return "Maximum effort";
  }
}

function getModelDescription(
  model: ModelInfo | undefined,
  level: EffortLevel,
): string | undefined {
  return model?.supportedReasoningEfforts?.find(
    (effort) => effort.reasoningEffort === level,
  )?.description;
}

export function getEffortLevelOptions(params: {
  provider?: ProviderInfo | ProviderName | null;
  model?: ModelInfo | string | null;
}): EffortLevelOption[] {
  const model = getModelInfo(params.provider, params.model);
  const levels =
    getModelSupportedEfforts(model) ??
    getFallbackEffortLevels(getProviderName(params.provider));

  return levels.map((level) => ({
    value: level,
    label: getEffortLevelLabel(level, params.provider),
    description:
      getModelDescription(model, level) ??
      getFallbackDescription(level, params.provider),
  }));
}

export const EFFORT_LEVEL_OPTIONS = getEffortLevelOptions({});

export function getFallbackEffortLevel(
  options: EffortLevelOption[],
): EffortLevel {
  return options.at(-1)?.value ?? "high";
}

export function resolveSupportedEffortLevel(
  effort: EffortLevel,
  options: EffortLevelOption[],
): EffortLevel {
  return options.some((option) => option.value === effort)
    ? effort
    : getFallbackEffortLevel(options);
}

export function normalizeEffortLevelForProvider(
  effort: string | undefined,
  provider?: ProviderInfo | ProviderName | null,
): EffortLevel {
  const providerName = getProviderName(provider);
  if (effort === "max" && providerName === "codex") {
    return "xhigh";
  }
  return isEffortLevel(effort) ? effort : "high";
}
