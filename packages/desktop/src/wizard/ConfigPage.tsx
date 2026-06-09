import type { StartupView } from "../tauri";

interface Props {
  startupView: StartupView;
  onStartupViewChange: (v: StartupView) => void;
  runInBackground: boolean;
  onRunInBackgroundChange: (v: boolean) => void;
  autostart: boolean;
  onAutostartChange: (v: boolean) => void;
  onNext: () => void;
}

export function ConfigPage({
  startupView,
  onStartupViewChange,
  runInBackground,
  onRunInBackgroundChange,
  autostart,
  onAutostartChange,
  onNext,
}: Props) {
  return (
    <div style={{ width: "100%", maxWidth: 400 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Settings
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 14,
          marginBottom: 24,
        }}
      >
        Configure how Yep Anywhere runs. You can change these later.
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          marginBottom: 32,
        }}
      >
        <label className="toggle">
          <span>Start when I log in</span>
          <input
            type="checkbox"
            checked={autostart}
            onChange={(e) => onAutostartChange(e.target.checked)}
          />
        </label>

        <label className="toggle">
          <span>Run in background when window closes</span>
          <input
            type="checkbox"
            checked={runInBackground}
            onChange={(e) => onRunInBackgroundChange(e.target.checked)}
          />
        </label>

        <div style={{ padding: "12px 0" }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>Startup view</div>
          <div className="startup-view-options">
            <button
              type="button"
              className={startupView === "dashboard" ? "selected" : ""}
              onClick={() => onStartupViewChange("dashboard")}
            >
              <strong>Dashboard</strong>
              <span>Open the local app UI.</span>
            </button>
            <button
              type="button"
              className={startupView === "server_output" ? "selected" : ""}
              onClick={() => onStartupViewChange("server_output")}
            >
              <strong>Server Output</strong>
              <span>Open the server console.</span>
            </button>
            <button
              type="button"
              className={startupView === "tray_only" ? "selected" : ""}
              disabled={!runInBackground}
              onClick={() => onStartupViewChange("tray_only")}
            >
              <strong>Tray Only</strong>
              <span>Start without a window.</span>
            </button>
          </div>
        </div>
      </div>

      <button className="btn-primary" onClick={onNext} style={{ width: "100%" }}>
        Continue
      </button>
    </div>
  );
}
