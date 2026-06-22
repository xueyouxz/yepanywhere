const DEFAULT_PROVIDER_GLYPH = "◌";

const providerGlyphMap: Record<string, string> = {
  claude: "Cl",
  "claude-ollama": "Cl↓",
  codex: "Cd",
  "codex-oss": "Cd↓",
  gemini: "✦",
  "gemini-acp": "✦",
  grok: "Gk",
  opencode: "OC",
  pi: "pi",
};

type ModelGlyphMatch = {
  glyph: string;
  suffix: string;
};

type ModelGlyphRule = {
  patterns: string[];
  glyph: string;
  fixedSuffix?: string;
  match?: "contains" | "exact";
};

const modelGlyphRulesByProvider: Readonly<
  Record<string, ReadonlyArray<ModelGlyphRule>>
> = {
  claude: [
    {
      patterns: ["opus[1m]", "opus-1m"],
      glyph: "◐",
      fixedSuffix: "1m",
      match: "exact",
    },
    {
      patterns: ["opusplan"],
      glyph: "◐",
      fixedSuffix: "Plan",
      match: "exact",
    },
    { patterns: ["opus"], glyph: "◐", fixedSuffix: "", match: "exact" },
    { patterns: ["fable"], glyph: "Fb", fixedSuffix: "", match: "exact" },
    {
      patterns: ["sonnet[1m]", "sonnet-1m"],
      glyph: "♪",
      fixedSuffix: "1m",
    },
    { patterns: ["fable"], glyph: "Fb" },
    { patterns: ["opus"], glyph: "◐" },
    { patterns: ["sonnet"], glyph: "♪" },
    { patterns: ["haiku"], glyph: "✎" },
  ],
  codex: [
    {
      patterns: [
        "gpt-5.4-codex-spark",
        "gpt-5.4-spark",
        "gpt-5.3-codex-spark",
        "gpt-5.3-spark",
      ],
      glyph: "⚡",
      fixedSuffix: "",
    },
    { patterns: ["gpt-5.5"], glyph: "◆" },
    { patterns: ["gpt-5.4-mini"], glyph: "◇" },
    { patterns: ["gpt-5.4-nano"], glyph: "◇" },
    { patterns: ["gpt-5.4"], glyph: "◇" },
    { patterns: ["gpt-5.3"], glyph: "◆" },
    { patterns: ["gpt-5"], glyph: "◆" },
    { patterns: ["gpt-4"], glyph: "⧉" },
  ],
  "codex-oss": [
    {
      patterns: [
        "gpt-5.4-codex-spark",
        "gpt-5.4-spark",
        "gpt-5.3-codex-spark",
        "gpt-5.3-spark",
      ],
      glyph: "⚡",
      fixedSuffix: "",
    },
    { patterns: ["gpt-5.5"], glyph: "◆" },
    { patterns: ["gpt-5.4-mini"], glyph: "◇" },
    { patterns: ["gpt-5.4-nano"], glyph: "◇" },
    { patterns: ["gpt-5.4"], glyph: "◇" },
    { patterns: ["gpt-5.3"], glyph: "◆" },
    { patterns: ["gpt-5"], glyph: "◆" },
    { patterns: ["gpt-4"], glyph: "⧉" },
  ],
  gemini: [
    { patterns: ["2.5-pro"], glyph: "✹" },
    { patterns: ["2.5-flash"], glyph: "⚡" },
    { patterns: ["1.5-pro"], glyph: "✹" },
    { patterns: ["gemini"], glyph: "◗" },
  ],
  grok: [{ patterns: ["grok-build"], glyph: "Gk" }],
  opencode: [
    { patterns: ["gpt-5"], glyph: "◆" },
    { patterns: ["gpt-4"], glyph: "⧉" },
    { patterns: ["qwen"], glyph: "◌" },
    { patterns: ["llama"], glyph: "◥" },
    { patterns: ["mistral"], glyph: "◰" },
  ],
};

const anyProviderModelRules: ReadonlyArray<ModelGlyphRule> = [
  { patterns: ["thinking"], glyph: "∴" },
];

export function normalizeProviderKey(provider?: string): string {
  return provider?.trim().toLowerCase() ?? "unknown";
}

export function normalizeForModelGlyphMatching(value: string): string {
  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/^openai\//u, "");
  normalized = normalized.replace(/^opencode\//u, "");
  normalized = normalized.replace(/^gemini-/u, "");
  return normalized;
}

function normalizeForCodexModelAliasMatching(
  normalizedModel: string,
  providerKey: string,
): string {
  if (!["codex", "codex-oss"].includes(providerKey)) {
    return normalizedModel;
  }

  // Some Codex model identifiers now include `-codex-` as a transport/alias
  // marker; remove it so stable rendering rules can still map to the same icon
  // buckets.
  return normalizedModel.replace(/-codex(?=-|$)/gu, "");
}

function normalizeModelSuffixTail(raw: string): string {
  const suffix = raw.replace(/^[-._\s]+/u, "");
  if (!suffix) {
    return "";
  }

  const versionWithExtendedContext = suffix.match(
    /^(\d+(?:-\d+)+(?:\.\d+)?)(\[1m\])?$/u,
  );
  if (versionWithExtendedContext) {
    const version = versionWithExtendedContext[1]?.replace(/-/gu, ".");
    return `${version}${versionWithExtendedContext[2] ? " 1m" : ""}`;
  }

  return suffix;
}

function deriveModelGlyphMatch(
  providerKey: string,
  normalizedModel: string,
): ModelGlyphMatch | null {
  const baseProviderKey = providerKey.replace(/-(?:ollama|oss|acp)$/u, "");
  const providerRules =
    modelGlyphRulesByProvider[providerKey] ??
    modelGlyphRulesByProvider[baseProviderKey] ??
    [];
  const findMatch = (ruleList: ReadonlyArray<ModelGlyphRule>) => {
    for (const rule of ruleList) {
      const patterns = [...rule.patterns].sort((a, b) => b.length - a.length);
      for (const pattern of patterns) {
        const matchStart =
          rule.match === "exact"
            ? normalizedModel === pattern
              ? 0
              : -1
            : normalizedModel.indexOf(pattern);
        if (matchStart === -1) {
          continue;
        }

        const suffix = normalizeModelSuffixTail(
          normalizedModel.slice(matchStart + pattern.length),
        );

        if (rule.fixedSuffix !== undefined) {
          return { glyph: rule.glyph, suffix: rule.fixedSuffix };
        }

        if (pattern.startsWith("gpt-")) {
          const base = pattern.slice(4);
          return {
            glyph: rule.glyph,
            suffix: suffix ? `${base}-${suffix}` : base,
          };
        }

        if (suffix) {
          return { glyph: rule.glyph, suffix };
        }

        return { glyph: rule.glyph, suffix: "" };
      }
    }

    return null;
  };

  return findMatch(providerRules) ?? findMatch(anyProviderModelRules);
}

const subProviderAbbrevMap: Record<string, string> = {
  "github-copilot": "copilot",
  "github-models": "copilot",
};

/**
 * Brief, provider-style abbreviation for a namespaced model's leading path
 * segment (the sub-provider / router), e.g. "github-copilot" -> "copilot".
 */
function getSubProviderAbbrev(pathPart: string): string {
  const key = pathPart.trim().toLowerCase();
  const mapped = subProviderAbbrevMap[key];
  if (mapped) {
    return mapped;
  }
  const cleaned = key.replace(/^github-/u, "");
  return cleaned.length > 12 ? cleaned.slice(0, 12) : cleaned;
}

/**
 * Guess the model family (the provider whose glyph rules apply) from a bare
 * model name, so a sub-provider-routed model such as "claude-opus-4.8" renders
 * with its native glyph regardless of which provider is doing the routing.
 */
function inferModelFamilyProviderKey(modelPart: string): string | null {
  const m = modelPart.toLowerCase();
  if (/(?:claude|opus|sonnet|haiku|fable)/u.test(m)) return "claude";
  if (/(?:gpt|codex|davinci|\bo[1-9])/u.test(m)) return "codex";
  if (/gemini/u.test(m)) return "gemini";
  if (/grok/u.test(m)) return "grok";
  if (/(?:qwen|llama|mistral|deepseek|gemma|phi)/u.test(m)) return "opencode";
  return null;
}

/** Model glyph + suffix only (no provider abbrev prefix). */
function formatModelGlyphOnly(familyKey: string, modelPart: string): string {
  const normalized = normalizeForModelGlyphMatching(modelPart);
  const normalizedForMatching = normalizeForCodexModelAliasMatching(
    normalized,
    familyKey,
  );
  const match = deriveModelGlyphMatch(familyKey, normalizedForMatching);
  if (!match) {
    return normalizedForMatching;
  }
  return match.suffix ? `${match.glyph} ${match.suffix}` : match.glyph;
}

export interface ModelIndicatorParts {
  /** Provider abbrev for the running provider, e.g. "OC". */
  providerGlyph: string;
  /** Sub-provider/router abbrev for a namespaced model, e.g. "copilot". */
  subProvider?: string;
  /** Model glyph + version, e.g. "◐ 4.8" (may be a bare name on no match). */
  modelLabel: string;
  /**
   * Provider key whose color cues the model — the sub-badge the model implies
   * (e.g. "claude" for a copilot-routed claude-opus). Lets renderers color the
   * model glyph/version by its real family rather than the routing provider.
   */
  modelFamilyKey: string;
}

export function getModelIndicatorModelParts(
  provider?: string,
  model?: string,
): ModelIndicatorParts | null {
  const trimmedModel = model?.trim();
  if (!trimmedModel) {
    return null;
  }

  const providerKey = normalizeProviderKey(provider);
  const providerGlyph = providerGlyphMap[providerKey] ?? DEFAULT_PROVIDER_GLYPH;
  const normalizedModel = normalizeForModelGlyphMatching(trimmedModel);

  // Sub-provider namespaced model (e.g. "github-copilot/claude-opus-4.8"):
  // three parts — provider abbrev (OC), sub-provider abbrev (copilot), and the
  // inner model through its own family's glyph rules (◐ 4.8). The family key
  // lets the badge color the model by the sub-badge it implies (claude).
  const slashIndex = normalizedModel.indexOf("/");
  if (slashIndex > 0) {
    const pathPart = normalizedModel.slice(0, slashIndex);
    const modelPart = normalizedModel.slice(slashIndex + 1);
    const subProvider = getSubProviderAbbrev(pathPart);
    const familyKey = inferModelFamilyProviderKey(modelPart) ?? providerKey;
    return {
      providerGlyph,
      subProvider,
      modelLabel: formatModelGlyphOnly(familyKey, modelPart),
      modelFamilyKey: familyKey,
    };
  }

  const normalizedForMatching = normalizeForCodexModelAliasMatching(
    normalizedModel,
    providerKey,
  );
  const match = deriveModelGlyphMatch(providerKey, normalizedForMatching);

  if (!match) {
    return {
      providerGlyph,
      modelLabel: normalizedForMatching,
      modelFamilyKey: providerKey,
    };
  }

  return {
    providerGlyph,
    modelLabel: match.suffix ? `${match.glyph} ${match.suffix}` : match.glyph,
    modelFamilyKey: providerKey,
  };
}

export function getModelIndicatorModelLabel(
  provider?: string,
  model?: string,
): string {
  const parts = getModelIndicatorModelParts(provider, model);
  if (!parts) {
    return "";
  }
  return [parts.providerGlyph, parts.subProvider, parts.modelLabel]
    .filter((part): part is string => !!part && part.length > 0)
    .join(" ");
}
