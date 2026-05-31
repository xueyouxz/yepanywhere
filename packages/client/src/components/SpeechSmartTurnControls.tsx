import { type ChangeEvent, useId } from "react";
import {
  DEFAULT_SPEECH_SMART_TURN_SETTINGS,
  type SpeechSmartTurnSettings,
} from "../lib/speechProviders/SpeechProvider";

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
      typeof settings.threshold === "number" && Number.isFinite(settings.threshold)
        ? clampNumber(settings.threshold, 0, 1)
        : DEFAULT_SPEECH_SMART_TURN_SETTINGS.threshold,
    timeoutMs:
      typeof settings.timeoutMs === "number" && Number.isFinite(settings.timeoutMs)
        ? Math.round(clampNumber(settings.timeoutMs, 0, 5000))
        : DEFAULT_SPEECH_SMART_TURN_SETTINGS.timeoutMs,
  };
}

export function SpeechSmartTurnControls({
  settings,
  onChange,
  compact = false,
  disabled = false,
}: SpeechSmartTurnControlsProps) {
  const id = useId();
  const thresholdId = `${id}-threshold`;
  const timeoutId = `${id}-timeout`;
  const clean = cleanSettings(settings);
  const update = (patch: Partial<SpeechSmartTurnSettings>) => {
    onChange(cleanSettings({ ...clean, ...patch }));
  };
  const handleThresholdChange = (event: ChangeEvent<HTMLInputElement>) => {
    update({ threshold: Number(event.target.value) });
  };
  const handleTimeoutChange = (event: ChangeEvent<HTMLInputElement>) => {
    update({ timeoutMs: Number(event.target.value) });
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
        <input
          id={thresholdId}
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={clean.threshold}
          disabled={disabled || !clean.enabled}
          onChange={handleThresholdChange}
        />
        <input
          type="number"
          min="0"
          max="1"
          step="0.01"
          value={clean.threshold}
          disabled={disabled || !clean.enabled}
          onChange={handleThresholdChange}
          aria-label="Smart Turn threshold"
        />
      </div>
      <div className="speech-smart-turn-row">
        <label htmlFor={timeoutId}>Timeout</label>
        <input
          id={timeoutId}
          type="range"
          min="0"
          max="5000"
          step="100"
          value={clean.timeoutMs}
          disabled={disabled || !clean.enabled}
          onChange={handleTimeoutChange}
        />
        <input
          type="number"
          min="0"
          max="5000"
          step="100"
          value={clean.timeoutMs}
          disabled={disabled || !clean.enabled}
          onChange={handleTimeoutChange}
          aria-label="Smart Turn timeout milliseconds"
        />
      </div>
      {clean.enabled && (
        <p className="speech-smart-turn-caption">
          After a pause: send, cancel, or wait. No command sends.
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
