import { useState } from "react";
import {
  disable as disableAutostart,
  enable as enableAutostart,
} from "@tauri-apps/plugin-autostart";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getServerStatus,
  openDashboardWindow,
  openServerOutputWindow,
  saveConfig,
  startServer,
  type AppConfig,
  type StartupView,
} from "../tauri";

interface Props {
  agents: string[];
  startupView: StartupView;
  runInBackground: boolean;
  autostart: boolean;
  onComplete: (config: AppConfig) => void;
}

export function ReadyPage({
  agents,
  startupView,
  runInBackground,
  autostart,
  onComplete,
}: Props) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    setLaunching(true);
    setError(null);

    const config: AppConfig = {
      setup_complete: true,
      agents,
      start_minimized: startupView === "tray_only",
      startup_view: startupView,
      run_in_background: runInBackground,
    };

    try {
      await saveConfig(config);
      if (autostart) {
        await enableAutostart();
      } else {
        await disableAutostart();
      }

      const status = await getServerStatus();
      if (status !== "running") {
        await startServer();
      }

      if (startupView === "dashboard") {
        await openDashboardWindow();
      } else if (startupView === "server_output") {
        await openServerOutputWindow();
      }

      onComplete(config);
      await getCurrentWindow().hide();
    } catch (e) {
      setError(String(e));
      setLaunching(false);
    }
  };

  return (
    <div style={{ textAlign: "center", maxWidth: 400 }}>
      <h2 style={{ fontSize: 28, fontWeight: 600, marginBottom: 12 }}>
        You're all set!
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 15,
          lineHeight: 1.6,
          marginBottom: 32,
        }}
      >
        Yep Anywhere is ready to go. Click below to start the server and open
        your dashboard.
      </p>

      {error && (
        <div
          style={{
            padding: 12,
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid var(--error)",
            borderRadius: 8,
            fontSize: 13,
            color: "var(--error)",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <button
        className="btn-primary"
        onClick={launch}
        disabled={launching}
        style={{ fontSize: 16, padding: "12px 32px" }}
      >
        {launching ? "Starting..." : "Launch Yep Anywhere"}
      </button>
    </div>
  );
}
