import { useEffect, useState } from "react";
import { getConfig, type AppConfig } from "./tauri";
import { WizardLayout } from "./wizard/WizardLayout";
import { MainLayout } from "./main/MainLayout";
import { ServerOutputView } from "./main/ServerOutputView";
import { LauncherView } from "./main/LauncherView";

function getRequestedView() {
  return new URLSearchParams(window.location.search).get("view");
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const requestedView = getRequestedView();

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ color: "var(--text-secondary)" }}>Loading...</div>
      </div>
    );
  }

  if (requestedView === "server-output") {
    return <ServerOutputView />;
  }

  if (requestedView === "dashboard") {
    return <MainLayout />;
  }

  if (requestedView === "setup" || !config?.setup_complete) {
    return (
      <WizardLayout
        initialConfig={config}
        onComplete={(newConfig) => {
          setConfig(newConfig);
        }}
      />
    );
  }

  return <LauncherView />;
}
