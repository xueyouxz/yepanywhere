import { useCallback, useEffect, useMemo, useState } from "react";
import { useSchemaValidationContext } from "../../contexts/SchemaValidationContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useSchemaValidation } from "../../hooks/useSchemaValidation";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

export function DevelopmentSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("developmentSectionTitle"));
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    unsafeToRestart,
    interruptibleSessionCount,
  } = useReloadNotifications();
  const { settings: validationSettings, setEnabled: setValidationEnabled } =
    useSchemaValidation();
  const { remoteLogCollectionEnabled, setRemoteLogCollectionEnabled } =
    useDeveloperMode();
  const { ignoredTools, clearIgnoredTools } = useSchemaValidationContext();
  const { settings: serverSettings, updateSetting: updateServerSetting } =
    useServerSettings();

  const undoState = useMemo(
    () =>
      serverSettings
        ? {
            validationEnabled: validationSettings.enabled,
            remoteLogCollectionEnabled,
            serviceWorkerEnabled: serverSettings.serviceWorkerEnabled ?? true,
          }
        : null,
    [validationSettings.enabled, remoteLogCollectionEnabled, serverSettings],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setValidationEnabled(snapshot.validationEnabled);
      setRemoteLogCollectionEnabled(snapshot.remoteLogCollectionEnabled);
      void updateServerSetting(
        "serviceWorkerEnabled",
        snapshot.serviceWorkerEnabled,
      );
    },
    [setValidationEnabled, setRemoteLogCollectionEnabled, updateServerSetting],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const [restarting, setRestarting] = useState(false);
  // When SSE reconnects after restart, re-enable the button
  useEffect(() => {
    if (restarting && connected) {
      setRestarting(false);
    }
  }, [restarting, connected]);

  const handleRestartServer = async () => {
    setRestarting(true);
    await reloadBackend();
  };

  // Only render in manual reload mode (dev mode)
  if (!isManualReloadMode) {
    return null;
  }

  return (
    <section className="settings-section">
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("developmentSchemaTitle")}</strong>
            <p>{t("developmentSchemaDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={validationSettings.enabled}
              onChange={(e) => setValidationEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        {ignoredTools.length > 0 && (
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("developmentIgnoredToolsTitle")}</strong>
              <p>{t("developmentIgnoredToolsDescription")}</p>
              <div className="ignored-tools-list">
                {ignoredTools.map((tool) => (
                  <span key={tool} className="ignored-tool-badge">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="settings-button settings-button-secondary"
              onClick={clearIgnoredTools}
            >
              {t("developmentClearIgnored")}
            </button>
          </div>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("developmentDiagnosticsTitle")}</strong>
            <p>{t("developmentDiagnosticsDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={remoteLogCollectionEnabled}
              onChange={(e) => setRemoteLogCollectionEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("developmentServiceWorkerTitle")}</strong>
            <p>{t("developmentServiceWorkerDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={serverSettings?.serviceWorkerEnabled ?? true}
              onChange={(e) =>
                updateServerSetting("serviceWorkerEnabled", e.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("developmentRestartTitle")}</strong>
            <p>
              {t("developmentRestartDescription")}
              {pendingReloads.backend && (
                <span className="settings-pending">
                  {" "}
                  {t("developmentChangesPending")}
                </span>
              )}
            </p>
            {unsafeToRestart && (
              <p className="settings-warning">
                {t("developmentInterruptedWarning", {
                  count: interruptibleSessionCount,
                  suffix: interruptibleSessionCount !== 1 ? "s " : " ",
                })}
              </p>
            )}
          </div>
          <button
            type="button"
            className={`settings-button ${unsafeToRestart ? "settings-button-danger" : ""}`}
            onClick={handleRestartServer}
            disabled={restarting}
          >
            {restarting
              ? t("developmentRestarting")
              : unsafeToRestart
                ? t("developmentRestartAnyway")
                : t("developmentRestart")}
          </button>
        </div>
      </div>
    </section>
  );
}
