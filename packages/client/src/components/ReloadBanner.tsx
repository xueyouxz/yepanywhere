import { useI18n } from "../i18n";

interface Props {
  target: "backend" | "frontend";
  onReload: () => void;
  onDismiss: () => void;
  unsafeToRestart?: boolean;
  interruptibleSessionCount?: number;
}

export function ReloadBanner({
  target,
  onReload,
  onDismiss,
  unsafeToRestart,
  interruptibleSessionCount = 0,
}: Props) {
  const { t } = useI18n();
  const label = target === "backend" ? "Server" : "Frontend";
  const showWarning = unsafeToRestart && target === "backend";

  return (
    <div
      className={`reload-banner ${showWarning ? "reload-banner-warning" : ""}`}
    >
      <span className="reload-banner-message">
        {t("reloadBannerCodeChanged", { target: label })}
      </span>
      {showWarning && (
        <span className="reload-banner-warning-text">
          {t("developmentInterruptedWarning", {
            count: interruptibleSessionCount,
            suffix: interruptibleSessionCount !== 1 ? "s " : " ",
          })}
        </span>
      )}
      <button
        type="button"
        className={`reload-banner-button reload-banner-button-primary ${
          showWarning ? "reload-banner-button-danger" : ""
        }`}
        onClick={onReload}
      >
        {showWarning ? "Reload Anyway" : `Reload ${label}`}
      </button>
      <button
        type="button"
        className="reload-banner-button"
        onClick={onDismiss}
      >
        Dismiss
      </button>
      <span className="reload-banner-shortcut">Ctrl+Shift+R</span>
    </div>
  );
}
