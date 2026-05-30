import { useCallback, useEffect, useState } from "react";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const MAX_LENGTH = 10000;
const DEFAULT_HEARTBEAT_TEXT = "heartbeat";
const DEFAULT_HEARTBEAT_AFTER_MINUTES = 15;

export function AgentContextSettings() {
  const { t } = useI18n();
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const [instructions, setInstructions] = useState("");
  const [heartbeatTurnsAfterMinutes, setHeartbeatTurnsAfterMinutes] =
    useState(String(DEFAULT_HEARTBEAT_AFTER_MINUTES));
  const [heartbeatTurnText, setHeartbeatTurnText] = useState(
    DEFAULT_HEARTBEAT_TEXT,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setInstructions(settings.globalInstructions ?? "");
      setHeartbeatTurnsAfterMinutes(
        String(
          settings.heartbeatTurnsAfterMinutes ?? DEFAULT_HEARTBEAT_AFTER_MINUTES,
        ),
      );
      setHeartbeatTurnText(
        settings.heartbeatTurnText ?? DEFAULT_HEARTBEAT_TEXT,
      );
    }
  }, [settings]);

  const serverInstructions = settings?.globalInstructions ?? "";
  const serverHeartbeatTurnsAfterMinutes =
    settings?.heartbeatTurnsAfterMinutes ?? DEFAULT_HEARTBEAT_AFTER_MINUTES;
  const serverHeartbeatTurnText =
    settings?.heartbeatTurnText ?? DEFAULT_HEARTBEAT_TEXT;

  const recomputeHasChanges = useCallback(
    (next: {
      instructions?: string;
      heartbeatTurnsAfterMinutes?: string;
      heartbeatTurnText?: string;
    }) => {
      const nextInstructions = next.instructions ?? instructions;
      const nextHeartbeatTurnsAfterMinutes =
        next.heartbeatTurnsAfterMinutes ?? heartbeatTurnsAfterMinutes;
      const nextHeartbeatTurnText =
        next.heartbeatTurnText ?? heartbeatTurnText;
      setHasChanges(
        nextInstructions !== serverInstructions ||
          nextHeartbeatTurnsAfterMinutes !==
            String(serverHeartbeatTurnsAfterMinutes) ||
          nextHeartbeatTurnText !== serverHeartbeatTurnText,
      );
    },
    [
      heartbeatTurnText,
      heartbeatTurnsAfterMinutes,
      instructions,
      serverHeartbeatTurnText,
      serverHeartbeatTurnsAfterMinutes,
      serverInstructions,
    ],
  );

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const parsedHeartbeatTurnsAfterMinutes = Number.parseInt(
        heartbeatTurnsAfterMinutes,
        10,
      );
      await updateSettings({
        globalInstructions: instructions.trim() || undefined,
        heartbeatTurnsAfterMinutes:
          Number.isFinite(parsedHeartbeatTurnsAfterMinutes) &&
          parsedHeartbeatTurnsAfterMinutes >= 1
            ? Math.min(parsedHeartbeatTurnsAfterMinutes, 1440)
            : DEFAULT_HEARTBEAT_AFTER_MINUTES,
        heartbeatTurnText: heartbeatTurnText.trim() || DEFAULT_HEARTBEAT_TEXT,
      });
      setHasChanges(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("agentContextSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    heartbeatTurnText,
    heartbeatTurnsAfterMinutes,
    instructions,
    t,
    updateSettings,
  ]);

  if (isLoading) {
    return (
      <section className="settings-section">
        <h2>{t("agentContextTitle")}</h2>
        <p className="settings-section-description">
          {t("agentContextLoading")}
        </p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>{t("agentContextTitle")}</h2>
      <p className="settings-section-description">
        {t("agentContextDescription")}
      </p>

      <div className="settings-group">
        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{t("agentContextGlobalInstructions")}</strong>
            <p>{t("agentContextGlobalInstructionsDescription")}</p>
          </div>
          <textarea
            className="settings-textarea"
            value={instructions}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_LENGTH);
              setInstructions(value);
              recomputeHasChanges({ instructions: value });
              setSaveError(null);
            }}
            placeholder={t("agentContextPlaceholder")}
            rows={10}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "var(--space-2)",
            }}
          >
            <span className="settings-hint">
              {t("agentContextCharacters", {
                current: instructions.length.toLocaleString(),
                max: MAX_LENGTH.toLocaleString(),
              })}
            </span>
            <button
              type="button"
              className="settings-button"
              disabled={!hasChanges || isSaving}
              onClick={handleSave}
            >
              {isSaving ? t("providersSaving") : t("providersSave")}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("agentContextHeartbeatAfterTitle")}</strong>
            <p>{t("agentContextHeartbeatAfterDescription")}</p>
          </div>
          <input
            type="number"
            className="settings-input-small"
            min={1}
            max={1440}
            value={heartbeatTurnsAfterMinutes}
            onChange={(e) => {
              setHeartbeatTurnsAfterMinutes(e.target.value);
              recomputeHasChanges({
                heartbeatTurnsAfterMinutes: e.target.value,
              });
              setSaveError(null);
            }}
          />
        </div>

        <div
          className="settings-item"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="settings-item-info">
            <strong>{t("agentContextHeartbeatTextTitle")}</strong>
            <p>{t("agentContextHeartbeatTextDescription")}</p>
          </div>
          <input
            type="text"
            className="settings-input"
            value={heartbeatTurnText}
            onChange={(e) => {
              setHeartbeatTurnText(e.target.value.slice(0, 200));
              recomputeHasChanges({
                heartbeatTurnText: e.target.value.slice(0, 200),
              });
              setSaveError(null);
            }}
            placeholder={DEFAULT_HEARTBEAT_TEXT}
          />
        </div>
      </div>

      {(saveError || error) && (
        <p className="settings-warning">{saveError || error}</p>
      )}
    </section>
  );
}
