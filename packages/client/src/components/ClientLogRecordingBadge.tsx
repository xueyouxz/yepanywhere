import { useEffect } from "react";
import {
  disableClientLogCollectionForTab,
  useClientLogCollectionStatus,
} from "../lib/diagnostics";

const RECORDING_FAVICON_ID = "ya-client-log-recording-favicon";
const RECORDING_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#b91c1c"/><text x="32" y="44" text-anchor="middle" font-family="Georgia,serif" font-size="42" font-weight="700" fill="#fff">Y</text></svg>`,
  );

function getTooltip(status: ReturnType<typeof useClientLogCollectionStatus>) {
  if (status.reason === "client+server") {
    return "Browser-tab diagnostics are recording because this browser and the server requested log collection. Click to stop collection for this tab.";
  }
  if (status.reason === "server") {
    return "Browser-tab diagnostics are recording because the connected server requested telemetry and log collection. Click to stop collection for this tab.";
  }
  return "Browser-tab diagnostics are recording because Remote Log Collection is enabled in Developer Mode. Click to stop collection for this tab.";
}

function useRecordingFavicon(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;

    let link = document.getElementById(
      RECORDING_FAVICON_ID,
    ) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = RECORDING_FAVICON_ID;
      link.rel = "icon";
      link.type = "image/svg+xml";
      document.head.appendChild(link);
    }
    link.href = RECORDING_FAVICON;

    return () => {
      document.getElementById(RECORDING_FAVICON_ID)?.remove();
    };
  }, [active]);
}

interface ClientLogRecordingBadgeProps {
  inline?: boolean;
}

export function ClientLogRecordingBadge({
  inline = false,
}: ClientLogRecordingBadgeProps) {
  const status = useClientLogCollectionStatus();
  useRecordingFavicon(status.active);

  if (!status.active) {
    return null;
  }

  const tooltip = getTooltip(status);

  return (
    <button
      type="button"
      className={`client-log-recording-badge${inline ? " client-log-recording-badge--inline" : ""}`}
      title={tooltip}
      aria-label={tooltip}
      onClick={disableClientLogCollectionForTab}
    >
      <span className="client-log-recording-badge-dot" aria-hidden="true" />
      <span>REC</span>
    </button>
  );
}
