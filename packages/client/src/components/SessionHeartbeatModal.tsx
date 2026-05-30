import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "../api/client";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

const DEFAULT_HEARTBEAT_TEXT = "heartbeat";
const DEFAULT_HEARTBEAT_AFTER_MINUTES = 15;
const HEARTBEAT_AFTER_PRESETS = [5, 15, 30, 60] as const;
const HEARTBEAT_FORCE_PRESETS = [1, 5, 15] as const;

interface SessionHeartbeatModalProps {
  sessionId: string;
  enabled: boolean;
  heartbeatTurnsAfterMinutes?: number;
  heartbeatTurnText?: string;
  heartbeatForceAfterMinutes?: number;
  onClose: () => void;
  onSaved: (settings: {
    enabled: boolean;
    heartbeatTurnsAfterMinutes?: number;
    heartbeatTurnText?: string;
    heartbeatForceAfterMinutes?: number;
  }) => void;
}

const AFTER_PRESET_VALUES = new Set<number>(HEARTBEAT_AFTER_PRESETS);
const FORCE_PRESET_VALUES = new Set<number>(HEARTBEAT_FORCE_PRESETS);

export function SessionHeartbeatModal({
  sessionId,
  enabled,
  heartbeatTurnsAfterMinutes,
  heartbeatTurnText,
  heartbeatForceAfterMinutes,
  onClose,
  onSaved,
}: SessionHeartbeatModalProps) {
  const { t } = useI18n();
  const { settings } = useServerSettings();
  const [isEnabled, setIsEnabled] = useState(enabled);
  const [afterMinutes, setAfterMinutes] = useState(
    heartbeatTurnsAfterMinutes ? String(heartbeatTurnsAfterMinutes) : "",
  );
  const [forceAfterMinutes, setForceAfterMinutes] = useState(
    heartbeatForceAfterMinutes ? String(heartbeatForceAfterMinutes) : "",
  );
  const defaultAfterMinutes =
    settings?.heartbeatTurnsAfterMinutes ?? DEFAULT_HEARTBEAT_AFTER_MINUTES;
  const defaultText = settings?.heartbeatTurnText ?? DEFAULT_HEARTBEAT_TEXT;
  const textOverride =
    heartbeatTurnText && heartbeatTurnText !== defaultText
      ? heartbeatTurnText
      : "";
  const [text, setText] = useState(textOverride);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsEnabled(enabled);
    setAfterMinutes(
      heartbeatTurnsAfterMinutes ? String(heartbeatTurnsAfterMinutes) : "",
    );
    setForceAfterMinutes(
      heartbeatForceAfterMinutes ? String(heartbeatForceAfterMinutes) : "",
    );
    setText(
      heartbeatTurnText && heartbeatTurnText !== defaultText
        ? heartbeatTurnText
        : "",
    );
  }, [
    enabled,
    heartbeatTurnText,
    heartbeatTurnsAfterMinutes,
    heartbeatForceAfterMinutes,
    defaultText,
  ]);

  const afterMinutesParsed = Number.parseInt(afterMinutes, 10);
  const forceAfterMinutesNumber = Number.parseInt(forceAfterMinutes, 10);

  const hasAfterMinutesOverride = afterMinutes.trim().length > 0;
  const hasForceMinutesOverride = forceAfterMinutes.trim().length > 0;

  const normalizedAfterMinutes = hasAfterMinutesOverride
    ? Number.isFinite(afterMinutesParsed)
      ? afterMinutesParsed
      : null
    : null;
  const normalizedForceMinutes = Number.isFinite(forceAfterMinutesNumber)
    ? forceAfterMinutesNumber
    : null;

  const effectiveAfterMinutes = isEnabled
    ? hasAfterMinutesOverride
      ? normalizedAfterMinutes
      : defaultAfterMinutes
    : null;

  const isAfterPresetSelected =
    isEnabled &&
    (hasAfterMinutesOverride
      ? Number.isFinite(normalizedAfterMinutes ?? NaN)
      : true) &&
    AFTER_PRESET_VALUES.has(
      (hasAfterMinutesOverride
        ? (normalizedAfterMinutes as number)
        : defaultAfterMinutes) as number,
    );

  const isAfterCustomSelected =
    isEnabled &&
    hasAfterMinutesOverride &&
    Number.isFinite(afterMinutesParsed) &&
    !AFTER_PRESET_VALUES.has(afterMinutesParsed);

  const isAfterOffSelected = !isEnabled;

  const isForceOffSelected =
    forceAfterMinutes.trim().length === 0 ||
    (normalizedForceMinutes ?? 0) <= 0;

  const isForcePresetSelected =
    !isForceOffSelected &&
    normalizedForceMinutes !== null &&
    FORCE_PRESET_VALUES.has(normalizedForceMinutes);

  const isForceCustomSelected =
    hasForceMinutesOverride &&
    !isForceOffSelected &&
    !isForcePresetSelected &&
    Number.isFinite(forceAfterMinutesNumber);

  const afterStatusMinutes = useMemo(() => {
    if (!isEnabled) return defaultAfterMinutes;
    return Number.isFinite(effectiveAfterMinutes ?? NaN)
      ? (effectiveAfterMinutes as number)
      : defaultAfterMinutes;
  }, [defaultAfterMinutes, effectiveAfterMinutes, isEnabled]);

  const forceStatusMinutes = useMemo(() => {
    if (forceAfterMinutes.trim().length === 0) return 0;
    return Number.isFinite(forceAfterMinutesNumber) ? forceAfterMinutesNumber : 0;
  }, [forceAfterMinutes, forceAfterMinutesNumber]);

  const isForceSectionHighlighted = isAfterOffSelected;

  const forceSectionClassName = isForceSectionHighlighted
    ? "settings-item session-heartbeat-item session-heartbeat-force-section session-heartbeat-force-section--active"
    : "settings-item session-heartbeat-item session-heartbeat-force-section";

  const forceButtonConnectionClassName = isAfterOffSelected
    ? "session-heartbeat-preset-button session-heartbeat-after-off-button session-heartbeat-after-off-button--connected"
    : "session-heartbeat-preset-button session-heartbeat-after-off-button";
  const enableAfterForForce = useCallback(
    (nextForceValue: string) => {
      const parsedForce = Number.parseInt(nextForceValue, 10);
      if (
        Number.isFinite(parsedForce) &&
        parsedForce > 0 &&
        !isEnabled
      ) {
        setAfterMinutes(String(defaultAfterMinutes));
        setIsEnabled(true);
      }
    },
    [defaultAfterMinutes, isEnabled],
  );

  const saveSettings = useCallback(async (
    next: {
      isEnabled?: boolean;
      afterMinutes?: string;
      forceAfterMinutes?: string;
      text?: string;
    } = {},
  ) => {
    const nextIsEnabled = next.isEnabled ?? isEnabled;
    const nextAfterMinutes = next.afterMinutes ?? afterMinutes;
    const nextForceAfterMinutes = next.forceAfterMinutes ?? forceAfterMinutes;
    const nextText = next.text ?? text;

    setIsSaving(true);
    setError(null);
    try {
      const parsedAfterMinutes = Number.parseInt(nextAfterMinutes, 10);
      const heartbeatTurnsAfterMinutesUpdate = nextIsEnabled
        ? nextAfterMinutes.trim().length === 0
          ? null
          : Number.isFinite(parsedAfterMinutes) && parsedAfterMinutes >= 1
            ? Math.min(parsedAfterMinutes, 1440)
            : Number.NaN
        : null;

      if (Number.isNaN(heartbeatTurnsAfterMinutesUpdate)) {
        throw new Error(t("sessionHeartbeatSaveFailed"));
      }

      const parsedForceAfterMinutes = Number.parseInt(nextForceAfterMinutes, 10);
      const heartbeatForceAfterMinutesUpdate =
        nextForceAfterMinutes.trim().length === 0 || parsedForceAfterMinutes <= 0
          ? null
          : Number.isFinite(parsedForceAfterMinutes) &&
              parsedForceAfterMinutes >= 1
            ? Math.min(parsedForceAfterMinutes, 1440)
            : Number.NaN;

      if (Number.isNaN(heartbeatForceAfterMinutesUpdate)) {
        throw new Error(t("sessionHeartbeatSaveFailed"));
      }

      const effectiveText = nextText.trim();
      const shouldPersistText =
        effectiveText.length > 0 && effectiveText !== defaultText;

      await api.updateSessionMetadata(sessionId, {
        heartbeatTurnsEnabled: nextIsEnabled,
        heartbeatTurnsAfterMinutes: heartbeatTurnsAfterMinutesUpdate,
        heartbeatTurnText: shouldPersistText ? effectiveText : null,
        heartbeatForceAfterMinutes: heartbeatForceAfterMinutesUpdate,
      });

      onSaved({
        enabled: nextIsEnabled,
        heartbeatTurnsAfterMinutes:
          heartbeatTurnsAfterMinutesUpdate === null
            ? undefined
            : heartbeatTurnsAfterMinutesUpdate,
        heartbeatTurnText: shouldPersistText ? effectiveText : undefined,
        heartbeatForceAfterMinutes:
          heartbeatForceAfterMinutesUpdate === null
            ? undefined
            : heartbeatForceAfterMinutesUpdate,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("sessionHeartbeatSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    afterMinutes,
    defaultText,
    forceAfterMinutes,
    isEnabled,
    onClose,
    onSaved,
    sessionId,
    text,
    t,
  ]);

  const handleTextSave = useCallback(() => {
    void saveSettings();
  }, [saveSettings]);

  const handleTextKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      void saveSettings();
    },
    [saveSettings],
  );

  const handleAfterInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const nextAfterMinutes = afterMinutes.trim();
      void saveSettings({
        isEnabled: true,
        afterMinutes: nextAfterMinutes,
      });
    },
    [afterMinutes, saveSettings],
  );

  const handleForceInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const nextForceAfterMinutes = forceAfterMinutes.trim();
      const parsedForce = Number.parseInt(nextForceAfterMinutes, 10);
      void saveSettings({
        isEnabled:
          Number.isFinite(parsedForce) && parsedForce > 0 ? true : isEnabled,
        afterMinutes:
          Number.isFinite(parsedForce) && parsedForce > 0 && !isEnabled
            ? String(defaultAfterMinutes)
            : afterMinutes,
        forceAfterMinutes: nextForceAfterMinutes,
      });
    },
    [
      afterMinutes,
      defaultAfterMinutes,
      forceAfterMinutes,
      isEnabled,
      saveSettings,
    ],
  );

  return (
    <Modal title={t("sessionHeartbeatTitle")} onClose={onClose}>
      <div
        className="settings-group session-heartbeat-modal"
      >
        <div className="settings-item session-heartbeat-item">
          <div className="settings-item-info">
            <p className="session-heartbeat-item-title">
              {t("sessionHeartbeatEnabledTitle")}
            </p>
            <p className="session-heartbeat-item-description">
              {t("sessionHeartbeatEnabledDescription")}
            </p>
          </div>
          <div className="session-heartbeat-presets-row">
            <div
              className="session-heartbeat-preset-group"
              role="group"
              aria-label={t("sessionHeartbeatAfterTitle")}
            >
              <button
                type="button"
                className={`${forceButtonConnectionClassName} ${
                  isAfterOffSelected ? "active" : ""
                }`}
                onClick={() => {
                  setIsEnabled(false);
                  setAfterMinutes("");
                  setError(null);
                  void saveSettings({ isEnabled: false, afterMinutes: "" });
                }}
                disabled={isSaving}
              >
                Off
              </button>
              {HEARTBEAT_AFTER_PRESETS.map((value) => (
                <button
                  type="button"
                  key={`after-${value}`}
                  className={`session-heartbeat-preset-button ${
                    isAfterPresetSelected && effectiveAfterMinutes === value
                      ? "active"
                      : ""
                  }`}
                  onClick={() => {
                    setAfterMinutes(String(value));
                    setIsEnabled(true);
                    setError(null);
                    void saveSettings({
                      isEnabled: true,
                      afterMinutes: String(value),
                    });
                  }}
                  disabled={isSaving}
                >
                  {value}m
                </button>
              ))}
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={afterMinutes}
              onChange={(e) => {
                setAfterMinutes(e.target.value);
                setIsEnabled(true);
                setError(null);
              }}
              onKeyDown={handleAfterInputKeyDown}
              className={`session-heartbeat-input session-heartbeat-input-small session-heartbeat-preset-input ${
                isAfterCustomSelected ? "active" : ""
              }`}
              placeholder={String(defaultAfterMinutes)}
            />
          </div>
          <p className="settings-hint session-heartbeat-hint">
            {isEnabled
              ? t("sessionHeartbeatAfterStatusActive", {
                  value: afterStatusMinutes,
                })
              : t("sessionHeartbeatAfterStatusOff")}
          </p>
          <p className="session-heartbeat-item-description">
            {t("sessionHeartbeatAfterDescription", { value: defaultAfterMinutes })}
          </p>
          <div className="settings-item-info">
            <p className="session-heartbeat-item-title">
              {t("sessionHeartbeatTextTitle")}
            </p>
            <p className="session-heartbeat-item-description">
              {t("sessionHeartbeatTextDescription")}
            </p>
          </div>
          <div className="session-heartbeat-text-row">
            <input
              type="text"
              value={text}
              inputMode="text"
              onChange={(e) => {
                setText(e.target.value.slice(0, 200));
                setError(null);
              }}
              onKeyDown={handleTextKeyDown}
              className="session-heartbeat-input"
              placeholder={defaultText}
            />
            <button
              type="button"
              className="settings-button session-heartbeat-text-save"
              onClick={handleTextSave}
              disabled={isSaving}
            >
              OK
            </button>
          </div>
        </div>

        <div
          className={forceSectionClassName}
        >
          <div className="settings-item-info">
            <p className="session-heartbeat-item-title">
              {t("sessionHeartbeatForceTitle")}
            </p>
          </div>
          <div className="session-heartbeat-presets-row">
            <div
              className="session-heartbeat-preset-group"
              role="group"
              aria-label={t("sessionHeartbeatForceTitle")}
            >
              <button
                type="button"
                className={`session-heartbeat-preset-button ${
                  isForceOffSelected ? "active" : ""
                }`}
                onClick={() => {
                  setForceAfterMinutes("");
                  setError(null);
                  void saveSettings({ forceAfterMinutes: "" });
                }}
                disabled={isSaving}
              >
                Off
              </button>
              {HEARTBEAT_FORCE_PRESETS.map((value) => (
                <button
                  type="button"
                  key={`force-${value}`}
                  className={`session-heartbeat-preset-button ${
                    isForcePresetSelected && forceAfterMinutesNumber === value
                      ? "active"
                      : ""
                  }`}
                  onClick={() => {
                    enableAfterForForce(String(value));
                    setForceAfterMinutes(String(value));
                    setError(null);
                    void saveSettings({
                      isEnabled: true,
                      afterMinutes: isEnabled
                        ? afterMinutes
                        : String(defaultAfterMinutes),
                      forceAfterMinutes: String(value),
                    });
                  }}
                  disabled={isSaving}
                >
                  {value}m
                </button>
              ))}
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={forceAfterMinutes}
              onChange={(e) => {
                const nextValue = e.target.value;
                enableAfterForForce(nextValue);
                setForceAfterMinutes(nextValue);
                setError(null);
              }}
              onKeyDown={handleForceInputKeyDown}
              className={`session-heartbeat-input session-heartbeat-input-small session-heartbeat-preset-input ${
                isForceCustomSelected ? "active" : ""
              }`}
              placeholder={t("sessionHeartbeatForceHint")}
            />
          </div>
          <p className="settings-hint session-heartbeat-hint">
            {forceStatusMinutes > 0
              ? t("sessionHeartbeatForceStatusActive", {
                  value: forceStatusMinutes,
                })
              : t("sessionHeartbeatForceStatusOff")}
          </p>
          <p className="session-heartbeat-item-description">
            {t("sessionHeartbeatForceDescription")}
          </p>
        </div>

        {error && <p className="settings-warning">{error}</p>}
      </div>
    </Modal>
  );
}
