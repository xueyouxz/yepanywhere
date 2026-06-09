import { useEffect, useState } from "react";
import { isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { type AppConfig, type StartupView } from "../tauri";
import { WelcomePage } from "./WelcomePage";
import { AgentSelectPage } from "./AgentSelectPage";
import { InstallPage } from "./InstallPage";
import { AuthPage } from "./AuthPage";
import { ConfigPage } from "./ConfigPage";
import { ReadyPage } from "./ReadyPage";

const STEPS = ["Welcome", "Agents", "Install", "Sign In", "Settings", "Ready"];

interface Props {
  initialConfig?: AppConfig | null;
  onComplete: (config: AppConfig) => void;
}

export function WizardLayout({ initialConfig, onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [agents, setAgents] = useState<string[]>(
    initialConfig?.agents?.length ? initialConfig.agents : ["claude"],
  );

  const [startupView, setStartupView] = useState<StartupView>(
    initialConfig?.startup_view ??
      (initialConfig?.start_minimized ? "tray_only" : "dashboard"),
  );
  const [runInBackground, setRunInBackground] = useState(
    initialConfig?.run_in_background ?? true,
  );
  const [autostart, setAutostart] = useState(true);

  useEffect(() => {
    if (!initialConfig?.setup_complete) return;
    isAutostartEnabled()
      .then(setAutostart)
      .catch(() => {});
  }, [initialConfig?.setup_complete]);

  useEffect(() => {
    if (!runInBackground && startupView === "tray_only") {
      setStartupView("dashboard");
    }
  }, [runInBackground, startupView]);

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  const renderStep = () => {
    switch (step) {
      case 0:
        return <WelcomePage onNext={next} />;
      case 1:
        return (
          <AgentSelectPage
            agents={agents}
            onAgentsChange={setAgents}
            onNext={next}
          />
        );
      case 2:
        return <InstallPage agents={agents} onNext={next} />;
      case 3:
        return <AuthPage agents={agents} onNext={next} />;
      case 4:
        return (
          <ConfigPage
            startupView={startupView}
            onStartupViewChange={setStartupView}
            runInBackground={runInBackground}
            onRunInBackgroundChange={setRunInBackground}
            autostart={autostart}
            onAutostartChange={setAutostart}
            onNext={next}
          />
        );
      case 5:
        return (
          <ReadyPage
            agents={agents}
            startupView={startupView}
            runInBackground={runInBackground}
            autostart={autostart}
            onComplete={onComplete}
          />
        );
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Title bar drag region */}
      <div
        data-tauri-drag-region
        style={{
          height: 32,
          flexShrink: 0,
        }}
      />

      {/* Progress dots */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 8,
          padding: "0 0 24px",
        }}
      >
        {STEPS.map((_, i) => (
          <div
            key={i}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: i <= step ? "var(--accent)" : "var(--border)",
              transition: "background 0.2s",
            }}
          />
        ))}
      </div>

      {/* Step content */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 48px 48px",
          overflow: "auto",
        }}
      >
        {renderStep()}
      </div>
    </div>
  );
}
