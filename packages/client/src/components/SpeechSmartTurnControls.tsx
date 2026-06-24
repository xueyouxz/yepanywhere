import { useId } from "react";
import { useI18n } from "../i18n";
import {
  DEFAULT_SPEECH_SMART_TURN_SETTINGS,
  type SpeechSmartTurnSettings,
} from "../lib/speechProviders/SpeechProvider";
import { CommittedRangeInput } from "./ui/CommittedRangeInput";

const MAX_SMART_TURN_TIMEOUT_MS = 10000;

interface SpeechSmartTurnControlsProps {
  settings: SpeechSmartTurnSettings;
  onChange: (settings: SpeechSmartTurnSettings) => void;
  compact?: boolean;
  disabled?: boolean;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanSettings(
  settings: Partial<SpeechSmartTurnSettings>,
): SpeechSmartTurnSettings {
  return {
    enabled: settings.enabled === true,
    threshold:
      typeof settings.threshold === "number" &&
      Number.isFinite(settings.threshold)
        ? clampNumber(settings.threshold, 0, 1)
        : DEFAULT_SPEECH_SMART_TURN_SETTINGS.threshold,
    timeoutMs:
      typeof settings.timeoutMs === "number" &&
      Number.isFinite(settings.timeoutMs)
        ? Math.round(
            clampNumber(settings.timeoutMs, 0, MAX_SMART_TURN_TIMEOUT_MS),
          )
        : DEFAULT_SPEECH_SMART_TURN_SETTINGS.timeoutMs,
  };
}

export function SpeechSmartTurnControls({
  settings,
  onChange,
  compact = false,
  disabled = false,
}: SpeechSmartTurnControlsProps) {
  const { t } = useI18n();
  const id = useId();
  const thresholdId = `${id}-threshold`;
  const thresholdHintId = `${id}-threshold-hint`;
  const timeoutId = `${id}-timeout`;
  const clean = cleanSettings(settings);
  const update = (patch: Partial<SpeechSmartTurnSettings>) => {
    onChange(cleanSettings({ ...clean, ...patch }));
  };
  const activate = () => {
    if (!disabled && !clean.enabled) {
      update({ enabled: true });
    }
  };
  const commitThreshold = (threshold: number) => {
    update({ enabled: true, threshold });
  };
  const commitTimeout = (timeoutMs: number) => {
    update({ enabled: true, timeoutMs });
  };
  const body = (
    <div className="speech-smart-turn-body">
      <label className="speech-smart-turn-toggle">
        <input
          type="checkbox"
          checked={clean.enabled}
          disabled={disabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <span>Smart Turn</span>
      </label>
      <div className="speech-smart-turn-row">
        <label htmlFor={thresholdId}>Threshold</label>
        <CommittedRangeInput
          id={thresholdId}
          min="0"
          max="1"
          step="0.01"
          value={clean.threshold}
          disabled={disabled}
          onFocus={activate}
          onPointerDown={activate}
          onCommit={commitThreshold}
        />
        <input
          type="number"
          min="0"
          max="1"
          step="0.01"
          value={clean.threshold}
          disabled={disabled}
          onFocus={activate}
          onPointerDown={activate}
          onChange={(event) => commitThreshold(Number(event.target.value))}
          aria-describedby={thresholdHintId}
          aria-label="Smart Turn threshold"
        />
        <span id={thresholdHintId} className="speech-smart-turn-hint">
          {t("speechSmartTurnThresholdHint")}
        </span>
      </div>
      <div className="speech-smart-turn-row">
        <label htmlFor={timeoutId}>Timeout</label>
        <CommittedRangeInput
          id={timeoutId}
          min="0"
          max="10000"
          step="100"
          value={clean.timeoutMs}
          disabled={disabled}
          onFocus={activate}
          onPointerDown={activate}
          onCommit={commitTimeout}
        />
        <input
          type="number"
          min="0"
          max="10000"
          step="100"
          value={clean.timeoutMs}
          disabled={disabled}
          onFocus={activate}
          onPointerDown={activate}
          onChange={(event) => commitTimeout(Number(event.target.value))}
          aria-label="Smart Turn timeout milliseconds"
        />
      </div>
      {clean.enabled && (
        <p className="speech-smart-turn-caption">
          {t("speechSmartTurnCaption")}
        </p>
      )}
    </div>
  );

  if (compact) {
    return (
      <details className="speech-smart-turn speech-smart-turn--compact">
        <summary title="Grok STT Smart Turn controls">Turn</summary>
        <div className="speech-smart-turn-popover">{body}</div>
      </details>
    );
  }

  return <div className="speech-smart-turn">{body}</div>;
}
