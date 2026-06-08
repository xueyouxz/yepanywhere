import type {
  EffortLevel,
  ShowThinking,
  ThinkingMode,
} from "@yep-anywhere/shared";
import type { CSSProperties, ReactNode } from "react";
import type { useI18n } from "../i18n";
import type { EffortLevelOption } from "../lib/effortLevels";

export function ThinkingIcon({ mode }: { mode: ThinkingMode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
      {mode === "auto" && (
        <g>
          <circle cx="19" cy="5" r="5.5" fill="currentColor" stroke="none" />
          <text
            x="19"
            y="5"
            textAnchor="middle"
            dominantBaseline="central"
            fill="var(--bg-primary, #1a1a2e)"
            fontSize="8"
            fontWeight="700"
            fontFamily="system-ui, sans-serif"
            stroke="none"
          >
            A
          </text>
        </g>
      )}
    </svg>
  );
}

interface ThinkingEffortSelectorProps {
  options: readonly EffortLevelOption[];
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  ariaLabel: string;
  disabled?: boolean;
  variant?: "toolbar" | "settings";
  className?: string;
}

export function ThinkingEffortSelector({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  variant = "toolbar",
  className,
}: ThinkingEffortSelectorProps) {
  const optionCount = Math.max(1, options.length);
  const style = {
    "--thinking-effort-option-count": optionCount,
  } as CSSProperties;
  const classes = [
    "thinking-effort-selector",
    `thinking-effort-selector--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role="group" aria-label={ariaLabel} style={style}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`thinking-effort-option ${
            value === option.value ? "active" : ""
          }`}
          onClick={() => onChange(option.value)}
          disabled={disabled}
          title={option.description}
          aria-label={`${ariaLabel}: ${option.label}`}
          aria-pressed={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const THINKING_MODE_ORDER: ThinkingMode[] = ["off", "auto", "on"];
const SHOW_THINKING_ORDER: ShowThinking[] = ["default", "on", "off"];

interface ThinkingControlsPanelProps {
  mode: ThinkingMode;
  onSetMode: (mode: ThinkingMode) => void;
  level: EffortLevel;
  effortOptions: EffortLevelOption[];
  onSetEffort: (level: EffortLevel) => void;
  showThinking: ShowThinking;
  onSetShowThinking: (value: ShowThinking) => void;
  t: ReturnType<typeof useI18n>["t"];
  /** Called after any selection — popover mounts use this to close. */
  onSelect?: () => void;
  optionRole?: "radio" | "menuitemradio";
  className?: string;
}

interface ThinkingChoiceButtonProps {
  optionRole: "radio" | "menuitemradio";
  checked: boolean;
  className: string;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}

function ThinkingChoiceButton({
  optionRole,
  checked,
  className,
  title,
  onClick,
  children,
}: ThinkingChoiceButtonProps) {
  if (optionRole === "menuitemradio") {
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        className={className}
        title={title}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }

  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={className}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * Shared thinking-controls layout: mode, effort, and "Show thinking".
 * Rendered inline-expanded in the new-session form (where the user is
 * configuring defaults and must see every option at once) and inside the
 * message-toolbar popover mid-session. One layout, two mounts.
 */
export function ThinkingControlsPanel({
  mode,
  onSetMode,
  level,
  effortOptions,
  onSetEffort,
  showThinking,
  onSetShowThinking,
  t,
  onSelect,
  optionRole = "radio",
  className,
}: ThinkingControlsPanelProps) {
  const modeLabel = (m: ThinkingMode) =>
    m === "off"
      ? t("modelSettingsThinkingOffLabel")
      : m === "auto"
        ? t("modelSettingsThinkingAutoLabel")
        : t("modelSettingsThinkingOnLabel");
  const showThinkingLabel = (v: ShowThinking) =>
    v === "default"
      ? t("showThinkingDefault")
      : v === "on"
        ? t("showThinkingOn")
        : t("showThinkingOff");

  const after = () => onSelect?.();

  return (
    <div className={`thinking-controls-panel ${className ?? ""}`.trim()}>
      <div className="thinking-toolbar-menu-section">
        <div className="thinking-toolbar-menu-label">
          {t("modelSettingsThinkingTitle")}
        </div>
        <div className="thinking-toolbar-menu-options" role="group">
          {THINKING_MODE_ORDER.map((m) => (
            <ThinkingChoiceButton
              key={m}
              optionRole={optionRole}
              checked={mode === m}
              className={`thinking-toolbar-option ${mode === m ? "active" : ""}`}
              onClick={() => {
                onSetMode(m);
                after();
              }}
            >
              <span className={`mode-option-dot thinking-${m}`} />
              <span>{modeLabel(m)}</span>
            </ThinkingChoiceButton>
          ))}
        </div>
      </div>
      <div className="thinking-toolbar-menu-section">
        <div className="thinking-toolbar-menu-label">
          {t("modelSettingsEffortTitle")}
        </div>
        <div
          className="thinking-toolbar-menu-options effort-options"
          role="group"
        >
          {effortOptions.map((option) => (
            <ThinkingChoiceButton
              key={option.value}
              optionRole={optionRole}
              checked={mode === "on" && level === option.value}
              className={`thinking-toolbar-option ${
                mode === "on" && level === option.value ? "active" : ""
              }`}
              title={option.description}
              onClick={() => {
                onSetEffort(option.value);
                onSetMode("on");
                after();
              }}
            >
              <span
                className={`model-switch-indicator-dot tone-${option.value}`}
                aria-hidden="true"
              />
              <span>{option.label}</span>
            </ThinkingChoiceButton>
          ))}
        </div>
      </div>
      <div className="thinking-toolbar-menu-section">
        <div
          className="thinking-toolbar-menu-label"
          title={t("showThinkingHint")}
        >
          {t("showThinkingTitle")}
        </div>
        <div className="thinking-toolbar-menu-options" role="group">
          {SHOW_THINKING_ORDER.map((v) => (
            <ThinkingChoiceButton
              key={v}
              optionRole={optionRole}
              checked={showThinking === v}
              className={`thinking-toolbar-option ${
                showThinking === v ? "active" : ""
              }`}
              onClick={() => {
                onSetShowThinking(v);
                after();
              }}
            >
              {showThinkingLabel(v)}
            </ThinkingChoiceButton>
          ))}
        </div>
      </div>
    </div>
  );
}
