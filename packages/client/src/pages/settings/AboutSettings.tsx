import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fetchJSON, type VersionInfo } from "../../api/client";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useRemoteCompatibilityNoticeDismissals } from "../../hooks/useRemoteCompatibilityNoticeDismissals";
import { useOnboarding } from "../../hooks/useOnboarding";
import { usePwaInstall } from "../../hooks/usePwaInstall";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { activityBus } from "../../lib/activityBus";
import { getRemoteCompatibilityNotices } from "../../lib/remoteCompatibilityNotices";

export function AboutSettings() {
  const { t } = useI18n();
  const { canInstall, isInstalled, install } = usePwaInstall();
  const {
    version: versionInfo,
    loading: versionLoading,
    error: versionError,
    refetchFresh: refetchVersionFresh,
  } = useVersion({ freshOnMount: true });
  const remoteConnection = useOptionalRemoteConnection();
  const { resetOnboarding } = useOnboarding();
  const currentRelayUsername = remoteConnection?.currentRelayUsername ?? null;
  const getNoticesForVersion = useCallback(
    (candidate: VersionInfo | null) =>
      getRemoteCompatibilityNotices({
        currentVersion: candidate?.current ?? null,
        latestVersion: candidate?.latest ?? null,
        updateAvailable: candidate?.updateAvailable ?? false,
        installSource: candidate?.installSource,
        resumeProtocolVersion: candidate?.resumeProtocolVersion,
        capabilities: candidate?.capabilities,
        relayUsername: currentRelayUsername,
      }),
    [currentRelayUsername],
  );
  const remoteCompatibilityNotices = useMemo(
    () => getNoticesForVersion(versionInfo),
    [getNoticesForVersion, versionInfo],
  );
  const remoteCompatibilityNotice = remoteCompatibilityNotices[0];
  const {
    dismissedNotices: dismissedRemoteCompatibilityNotices,
    restoreNotices: restoreRemoteCompatibilityNotices,
  } = useRemoteCompatibilityNoticeDismissals(remoteCompatibilityNotices);
  const hasDismissedRemoteCompatibilityNotice =
    dismissedRemoteCompatibilityNotices.length > 0;

  // Server restart state
  const [restarting, setRestarting] = useState(false);
  const [activeWorkers, setActiveWorkers] = useState(0);

  // Fetch worker activity on mount
  useEffect(() => {
    fetchJSON<{ activeWorkers: number; hasActiveWork: boolean }>(
      "/status/workers",
    )
      .then((data) => setActiveWorkers(data.activeWorkers))
      .catch(() => {});
  }, []);

  // When activity bus reconnects after restart, clear restarting state
  useEffect(() => {
    if (!restarting) return;
    return activityBus.on("reconnect", () => {
      setRestarting(false);
    });
  }, [restarting]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await api.restartServer();
    } catch {
      // Expected - server drops connection during restart
    }
  }, []);

  const handleShowRemoteCompatibilityBanner = useCallback(() => {
    restoreRemoteCompatibilityNotices(remoteCompatibilityNotices);
  }, [remoteCompatibilityNotices, restoreRemoteCompatibilityNotices]);

  const handleCheckUpdates = useCallback(async () => {
    const freshVersion = await refetchVersionFresh();
    restoreRemoteCompatibilityNotices(
      getNoticesForVersion(freshVersion ?? versionInfo),
    );
  }, [
    getNoticesForVersion,
    refetchVersionFresh,
    restoreRemoteCompatibilityNotices,
    versionInfo,
  ]);

  return (
    <section className="settings-section">
      <h2>{t("aboutTitle")}</h2>
      <div className="settings-group">
        {/* Only show Install option if install is possible or already installed */}
        {(canInstall || isInstalled) && (
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("aboutInstallTitle")}</strong>
              <p>
                {isInstalled
                  ? t("aboutInstalledDescription")
                  : t("aboutInstallDescription")}
              </p>
            </div>
            {isInstalled ? (
              <span className="settings-status-badge">
                {t("aboutInstalled")}
              </span>
            ) : (
              <button
                type="button"
                className="settings-button"
                onClick={install}
              >
                {t("aboutInstall")}
              </button>
            )}
          </div>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutVersionTitle")}</strong>
            <p>
              {t("aboutServerVersion")}{" "}
              {versionInfo ? (
                <>
                  v{versionInfo.current}
                  {versionInfo.updateAvailable && versionInfo.latest ? (
                    <span className="settings-update-available">
                      {" "}
                      {t("aboutVersionAvailable", {
                        version: versionInfo.latest,
                      })}
                    </span>
                  ) : versionInfo.latest ? (
                    <span className="settings-up-to-date">
                      {" "}
                      {t("aboutUpToDate")}
                    </span>
                  ) : null}
                </>
              ) : (
                t("loginLoading")
              )}
            </p>
            <p>
              {t("aboutClientVersion")} v{__APP_VERSION__}
            </p>
            {versionError && (
              <p className="settings-warning">{t("aboutUnableRefresh")}</p>
            )}
            {remoteCompatibilityNotice && (
              <div
                className={`settings-warning-box settings-remote-compatibility-notice settings-remote-compatibility-notice--${remoteCompatibilityNotice.severity}`}
              >
                <strong>{remoteCompatibilityNotice.title}</strong>
                {remoteCompatibilityNotice.versionSummary && (
                  <p className="settings-remote-compatibility-notice__meta">
                    {remoteCompatibilityNotice.versionSummary}
                  </p>
                )}
                <p>{remoteCompatibilityNotice.body}</p>
                {remoteCompatibilityNotice.guidance && (
                  <p>{remoteCompatibilityNotice.guidance}</p>
                )}
                {remoteCompatibilityNotice.action?.commandPreview && (
                  <p>
                    <code className="settings-remote-compatibility-notice__command">
                      {remoteCompatibilityNotice.action.commandPreview}
                    </code>
                  </p>
                )}
                {remoteCompatibilityNotices.length > 1 && (
                  <p className="settings-remote-compatibility-notice__meta">
                    {remoteCompatibilityNotices.length} compatibility notices
                    apply. The banner shows them by priority.
                  </p>
                )}
              </div>
            )}
            {versionInfo?.updateAvailable && !remoteCompatibilityNotice && (
              <p className="settings-update-hint">{t("aboutUpdateHint")}</p>
            )}
          </div>
          <div className="settings-item-actions">
            {remoteCompatibilityNotice && (
              <button
                type="button"
                className="settings-button"
                onClick={handleShowRemoteCompatibilityBanner}
                disabled={!hasDismissedRemoteCompatibilityNotice}
              >
                {hasDismissedRemoteCompatibilityNotice
                  ? "Show banner"
                  : "Banner visible"}
              </button>
            )}
            <button
              type="button"
              className="settings-button"
              onClick={() => void handleCheckUpdates()}
              disabled={versionLoading}
            >
              {versionLoading ? t("aboutChecking") : t("aboutCheckUpdates")}
            </button>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("developmentRestartTitle")}</strong>
            <p>{t("developmentRestartDescription")}</p>
            {activeWorkers > 0 && !restarting && (
              <p className="settings-warning">
                {t("developmentInterruptedWarning", {
                  count: activeWorkers,
                  suffix: activeWorkers !== 1 ? "s " : " ",
                })}
              </p>
            )}
          </div>
          <button
            type="button"
            className={`settings-button ${activeWorkers > 0 ? "settings-button-danger" : ""}`}
            onClick={handleRestart}
            disabled={restarting}
          >
            {restarting
              ? t("developmentRestarting")
              : activeWorkers > 0
                ? t("developmentRestartAnyway")
                : t("developmentRestart")}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutReportBugTitle")}</strong>
            <p>{t("aboutReportBugDescription")}</p>
          </div>
          <a
            href="https://github.com/kzahel/yepanywhere/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-button"
          >
            {t("aboutReportBug")}
          </a>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutSetupWizardTitle")}</strong>
            <p>{t("aboutSetupWizardDescription")}</p>
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={resetOnboarding}
          >
            {t("aboutLaunchWizard")}
          </button>
        </div>
      </div>
    </section>
  );
}
