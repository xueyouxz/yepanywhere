import { useNavigate } from "react-router-dom";
import { RemoteAccessSetup } from "../../components/RemoteAccessSetup";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { getHostById } from "../../lib/hostStorage";

export function RemoteAccessSettings() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const remoteConnection = useOptionalRemoteConnection();
  const { settings, isLoading, error, updateSetting } = useServerSettings();

  // Handle switching hosts - disconnect and go to host picker
  const handleSwitchHost = () => {
    remoteConnection?.disconnect();
    navigate("/login");
  };

  const persistSessionsToggle = (
    <>
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("developmentPersistRemoteTitle")}</strong>
            <p>
              {t("developmentPersistRemoteDescriptionPrefix")}{" "}
              <code>remote-sessions.json</code>{" "}
              {t("developmentPersistRemoteDescriptionSuffix")}
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={settings?.persistRemoteSessionsToDisk ?? false}
              disabled={isLoading}
              onChange={(e) =>
                void updateSetting(
                  "persistRemoteSessionsToDisk",
                  e.target.checked,
                )
              }
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {error && <p className="settings-warning">{error}</p>}
    </>
  );

  // When connected via relay, show connection info and logout
  if (remoteConnection) {
    // Get current host display name from hostStorage
    const currentHost = remoteConnection.currentHostId
      ? getHostById(remoteConnection.currentHostId)
      : null;
    const displayName =
      currentHost?.displayName ||
      remoteConnection.storedUsername ||
      t("remoteAccessDefaultHost");

    return (
      <section className="settings-section">
        <h2>{t("remoteAccessConnectedTitle")}</h2>
        <p className="settings-section-description">
          {t("remoteAccessConnectedDescription")}
        </p>
        <div className="settings-group">
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("remoteAccessCurrentHostTitle")}</strong>
              <p>{displayName}</p>
            </div>
            <button
              type="button"
              className="settings-button"
              onClick={handleSwitchHost}
            >
              {t("sidebarSwitchHost")}
            </button>
          </div>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("remoteAccessLogoutTitle")}</strong>
              <p>{t("remoteAccessLogoutDescription")}</p>
            </div>
            <button
              type="button"
              className="settings-button settings-button-danger"
              onClick={() => remoteConnection.disconnect()}
            >
              {t("remoteAccessLogout")}
            </button>
          </div>
        </div>
        {persistSessionsToggle}
      </section>
    );
  }

  // Server-side: show relay configuration
  return (
    <section className="settings-section">
      <RemoteAccessSetup
        title={t("remoteAccessConnectedTitle")}
        description={t("remoteAccessSetupDescription")}
      />
      {persistSessionsToggle}
    </section>
  );
}
