import {
  DEFAULT_YA_CLIENT_BASE_URL,
  buildYaClientPublicShareBaseUrl,
} from "@yep-anywhere/shared";
import type { PublicShareStatusResponse } from "../../api/client";
import type { ExperimentalFeatureId } from "../../hooks/useDeveloperMode";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { usePublicShareStatus } from "../../hooks/usePublicShareStatus";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const DEFAULT_PUBLIC_SHARE_VIEWER_BASE_URL =
  buildYaClientPublicShareBaseUrl(DEFAULT_YA_CLIENT_BASE_URL);

interface ExperimentalFeatureOption {
  id: ExperimentalFeatureId;
  titleKey: string;
  descriptionKey: string;
  topicHref: string;
}

const EXPERIMENTAL_FEATURE_OPTIONS: ExperimentalFeatureOption[] = [
  {
    id: "patientQueueMode",
    titleKey: "advancedExperimentalPatientQueueTitle",
    descriptionKey: "advancedExperimentalPatientQueueDescription",
    topicHref:
      "https://github.com/kzahel/yepanywhere/blob/main/topics/message-control-steer-queue-btw-later-interrupt.md",
  },
];

export function AdvancedSettings() {
  const { t } = useI18n();
  const {
    experimentalFeaturesEnabled,
    experimentalFeatures,
    setExperimentalFeaturesEnabled,
    setExperimentalFeatureEnabled,
  } = useDeveloperMode();
  const { settings, isLoading, error, updateSetting } = useServerSettings();
  const publicSharesEnabled = settings?.publicSharesEnabled ?? false;
  const { status: publicShareStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });

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
    publicShareStatus?.viewerBaseUrl ??
    defaultViewerBaseUrl;

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

  return (
    <section className="settings-section">
      <h2>{t("advancedSectionTitle")}</h2>
      <p className="settings-section-description">
        {t("advancedSectionDescription")}
      </p>

      <div className="settings-group">
        <div className="settings-item experimental-features-settings">
          <div className="settings-item-header">
            <div className="settings-item-info">
              <strong>{t("advancedExperimentalFeaturesTitle")}</strong>
              <p>{t("advancedExperimentalFeaturesDescription")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label={t("advancedExperimentalFeaturesTitle")}
                checked={experimentalFeaturesEnabled}
                onChange={(e) =>
                  setExperimentalFeaturesEnabled(e.target.checked)
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
          {experimentalFeaturesEnabled && (
            <div
              className="experimental-feature-list"
              aria-label={t("advancedExperimentalFeatureListLabel")}
            >
              {EXPERIMENTAL_FEATURE_OPTIONS.map((feature) => (
                <div className="experimental-feature-option" key={feature.id}>
                  <div className="settings-item-info">
                    <strong>{t(feature.titleKey as never)}</strong>
                    <p>{t(feature.descriptionKey as never)}</p>
                    <p className="settings-hint">
                      <a
                        href={feature.topicHref}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("advancedExperimentalFeatureTopicLink")}
                      </a>
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      aria-label={t(feature.titleKey as never)}
                      checked={experimentalFeatures[feature.id]}
                      onChange={(e) =>
                        setExperimentalFeatureEnabled(
                          feature.id,
                          e.target.checked,
                        )
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>

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

      {error && <p className="settings-warning">{error}</p>}
    </section>
  );
}
