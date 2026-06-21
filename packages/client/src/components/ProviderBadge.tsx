import type { ProviderName } from "@yep-anywhere/shared";
import { getIndicatorToneFromProcess } from "../lib/modelConfigIndicator";
import { getModelIndicatorModelLabel } from "../lib/modelIndicatorText";
import {
  getEffortLevelLabel,
  normalizeEffortLevelForProvider,
} from "../lib/effortLevels";
import { useI18n } from "../i18n";

const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: "var(--provider-claude)", // Claude orange
  "claude-ollama": "var(--provider-claude)", // Same as Claude (uses Claude SDK)
  codex: "var(--provider-codex)", // OpenAI green
  "codex-oss": "var(--provider-codex)", // OpenAI green (same as codex)
  gemini: "var(--provider-gemini)", // Google blue
  "gemini-acp": "var(--provider-gemini)", // Google blue (same as gemini)
  grok: "var(--provider-grok)", // xAI Grok
  opencode: "var(--provider-opencode)", // OpenCode purple
  pi: "var(--provider-pi)", // pi teal
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: "Claude",
  "claude-ollama": "Ollama",
  codex: "Codex",
  "codex-oss": "CodexOSS",
  gemini: "Gemini",
  "gemini-acp": "Gemini ACP",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "pi",
};

interface ProviderBadgeProps {
  provider: ProviderName;
  /** Show as small dot only (for sidebar) vs full badge (for header) */
  compact?: boolean;
  /** Model name to display alongside provider (e.g., "opus", "sonnet") */
  model?: string;
  /** Current thinking mode for live process config */
  thinking?: { type: string };
  /** Current effort level for live process config */
  effort?: string;
  /** Whether the session is actively thinking/processing */
  isThinking?: boolean;
  className?: string;
}

/**
 * Badge showing which AI provider is running a session.
 * Use compact mode for sidebar lists, full mode for session headers.
 */
export function ProviderBadge({
  provider,
  compact = false,
  model,
  thinking,
  effort,
  isThinking = false,
  className = "",
}: ProviderBadgeProps) {
  const { t } = useI18n();
  const color = PROVIDER_COLORS[provider];
  const label = PROVIDER_LABELS[provider];

  const isGptModel =
    provider === "codex" &&
    typeof model === "string" &&
    model.toLowerCase().startsWith("gpt-");

  const effortTone = isGptModel
    ? getIndicatorToneFromProcess(thinking, effort, provider)
    : null;

  const effortLabel = (() => {
    if (!isGptModel) return null;
    if (!thinking && !effort) return null;
    if (!thinking || thinking.type === "disabled") {
      return t("modelSettingsThinkingOffLabel");
    }
    if (!effort) return t("modelSettingsThinkingAutoLabel");
    const level = normalizeEffortLevelForProvider(effort, provider);
    const label = getEffortLevelLabel(level, provider, t);
    if (level === "medium") return t("effortLevelMediumShortLabel");
    if (level === "xhigh") return t("effortLevelExtraHighShortLabel");
    return label;
  })();

  // Compact glyph label for the badge body (full text preserved in title)
  const effectiveModel = !model || model === "default" ? undefined : model;
  const glyphLabel =
    getModelIndicatorModelLabel(provider, effectiveModel) || label;

  const fullTitle = effectiveModel ?? label;

  if (compact) {
    return (
      <span
        className={`provider-badge-stripe ${className}`}
        style={{ backgroundColor: color }}
        title={fullTitle}
        role="img"
        aria-label={fullTitle}
      />
    );
  }

  const dotClass = isThinking
    ? "provider-badge-dot-inline thinking"
    : "provider-badge-dot-inline";
  const dotStyle = isThinking
    ? { backgroundColor: "var(--thinking-color)" }
    : { backgroundColor: color };

  return (
    <span
      className={`provider-badge ${className}`}
      style={{ borderColor: color, color }}
      title={fullTitle}
      role="img"
      aria-label={fullTitle}
    >
      <span className={dotClass} style={dotStyle} />
      <span className="provider-badge-label">{glyphLabel}</span>
      {effortLabel && effortTone && (
        <span
          className="provider-badge-effort"
          title={`Effort: ${effortLabel}`}
        >
          <span
            className={`provider-badge-effort-dot tone-${effortTone}`}
            aria-hidden="true"
          />
          <span className="provider-badge-effort-label">{effortLabel}</span>
        </span>
      )}
    </span>
  );
}
