import {
  buildYaClientPublicShareBaseUrl,
  DEFAULT_YA_CLIENT_BASE_URL,
} from "@yep-anywhere/shared";
import { useNavigate } from "react-router-dom";
import type { PublicShareStatusResponse } from "../../api/client";
import { RemoteAccessSetup } from "../../components/RemoteAccessSetup";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { usePublicShareStatus } from "../../hooks/usePublicShareStatus";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { getHostById } from "../../lib/hostStorage";

const DEFAULT_PUBLIC_SHARE_VIEWER_BASE_URL = buildYaClientPublicShareBaseUrl(
  DEFAULT_YA_CLIENT_BASE_URL,
);

export function RemoteAccessSettings() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const remoteConnection = useOptionalRemoteConnection();
  const { settings, isLoading, error, updateSetting } = useServerSettings();
  const publicSharesEnabled = settings?.publicSharesEnabled ?? false;
  const { status: publicShareStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });

  // Handle switching hosts - disconnect and go to host picker
  const handleSwitchHost = () => {
    remoteConnection?.disconnect();
    navigate("/login");
  };

  const defaultYaClientBaseUrl =
    publicShareStatus?.defaultYaClientBaseUrl ?? DEFAULT_YA_CLIENT_BASE_URL;
  const effectiveYaClientBaseUrl =
    settings?.yaClientBaseUrl ??
    publicShareStatus?.yaClientBaseUrl ??
    defaultYaClientBaseUrl;
  const defaultViewerBaseUrl =
    publicShareStatus?.defaultViewerBaseUrl ??
    DEFAULT_PUBLIC_SHARE_VIEWER_BASE_URL;
  const effectiveViewerBaseUrl =
    publicShareStatus?.viewerBaseUrl ?? defaultViewerBaseUrl;

  const getShareReadinessMessage = (
    status: PublicShareStatusResponse | null,
  ): { className: string; text: string } | null => {
    if (!status) return null;
    if (!status.configured) {
      return {
        className: "settings-warning",
        text: t("advancedPublicShareRelayMissing"),
      };
    }
    if (!status.remoteAccessEnabled) {
      return {
        className: "settings-warning",
        text: t("advancedPublicShareRemoteAccessDisabled"),
      };
    }
    if (status.relayStatus !== "waiting") {
      return {
        className: "settings-warning",
        text: t("advancedPublicShareRelayTemporarilyUnavailable", {
          status: status.relayStatus ?? "unknown",
        }),
      };
    }
    return {
      className: "settings-hint",
      text: t("advancedPublicShareReady"),
    };
  };

  const shareReadinessMessage = getShareReadinessMessage(publicShareStatus);

  // Public read-only share only works once Remote Access (relay) is configured,
  // so its controls live at the top of this tab.
  const publicShareConfig = (
    <div className="settings-group">
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("advancedPublicShareTitle")}</strong>
          <p>{t("advancedPublicShareDescription")}</p>
          <p>{t("advancedPublicSharePrivacyWarning")}</p>
          <p>{t("advancedPublicShareExistingManagement")}</p>
          {shareReadinessMessage && (
            <p className={shareReadinessMessage.className}>
              {shareReadinessMessage.text}
            </p>
          )}
          {publicShareStatus?.relayUrl && (
            <p className="settings-hint" style={{ wordBreak: "break-all" }}>
              {t("advancedPublicShareRelayEffective", {
                username: publicShareStatus.relayUsername ?? "",
                url: publicShareStatus.relayUrl,
              })}
            </p>
          )}
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={publicSharesEnabled}
            disabled={isLoading}
            onChange={(e) =>
              void updateSetting("publicSharesEnabled", e.target.checked)
            }
          />
          <span className="toggle-slider" />
        </label>
      </div>

      <div
        className="settings-item"
        style={{ flexDirection: "column", alignItems: "stretch" }}
      >
        <div className="settings-item-info">
          <strong>{t("advancedYaClientTitle")}</strong>
          <p>{t("advancedYaClientDescription")}</p>
          <p className="settings-hint" style={{ wordBreak: "break-all" }}>
            {t("advancedYaClientEffective", {
              url: effectiveYaClientBaseUrl,
            })}
          </p>
          <p className="settings-hint" style={{ wordBreak: "break-all" }}>
            {t("advancedPublicShareViewerEffective", {
              url: effectiveViewerBaseUrl,
            })}
          </p>
          {publicShareStatus?.yaClientBaseUrlError && (
            <p className="settings-warning">
              {publicShareStatus.yaClientBaseUrlError}
            </p>
          )}
        </div>
      </div>
    </div>
  );

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
        {publicShareConfig}
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
      {publicShareConfig}
      <RemoteAccessSetup
        title={t("remoteAccessConnectedTitle")}
        description={t("remoteAccessSetupDescription")}
      />
      {persistSessionsToggle}
    </section>
  );
}
