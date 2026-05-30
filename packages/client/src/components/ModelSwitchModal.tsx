import { Fragment, useEffect, useState } from "react";
import { api } from "../api/client";
import { useModelSettings } from "../hooks/useModelSettings";
import { useI18n } from "../i18n";
import {
  getIndicatorToneFromProcess,
  getIndicatorToneFromSelection,
  getThinkingModeFromProcess,
  normalizeEffortLevel,
} from "../lib/modelConfigIndicator";
import { Modal } from "./ui/Modal";

interface ModelSwitchModalProps {
  processId: string;
  sessionId: string;
  currentModel?: string;
  onModelChanged: (next: {
    processId: string;
    model?: string;
    thinking?: { type: string };
    effort?: string;
  }) => void;
  onClose: () => void;
}

interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

type ThinkingMode = "off" | "auto" | "on";
type EffortLevel = "low" | "medium" | "high" | "max";
type DirtySection = "thinking" | "effort" | "model" | null;

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

function toThinkingOption(
  mode: ThinkingMode,
  effort: EffortLevel,
): "off" | "auto" | `on:${EffortLevel}` {
  if (mode === "off") return "off";
  if (mode === "auto") return "auto";
  return `on:${effort}`;
}

function sameSelection(
  modelA: string | undefined,
  modeA: ThinkingMode,
  effortA: EffortLevel,
  modelB: string | undefined,
  modeB: ThinkingMode,
  effortB: EffortLevel,
): boolean {
  if (modelA !== modelB || modeA !== modeB) {
    return false;
  }
  if (modeA !== "on") {
    return true;
  }
  return effortA === effortB;
}

export function ModelSwitchModal({
  processId,
  sessionId,
  currentModel,
  onModelChanged,
  onClose,
}: ModelSwitchModalProps) {
  const { t } = useI18n();
  const { setThinkingMode, setEffortLevel } = useModelSettings();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [currentThinkingMode, setCurrentThinkingMode] =
    useState<ThinkingMode>("off");
  const [currentEffortLevel, setCurrentEffortLevel] =
    useState<EffortLevel>("high");
  const [currentModelId, setCurrentModelId] = useState<string | undefined>(
    currentModel,
  );
  const [thinkingMode, setThinkingModeState] = useState<ThinkingMode>("off");
  const [effortLevel, setEffortLevelState] = useState<EffortLevel>("high");
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    currentModel,
  );
  const [lastTouchedSection, setLastTouchedSection] =
    useState<DirtySection>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([api.getProcessModels(processId), api.getProcessInfo(sessionId)])
      .then(([modelsRes, processRes]) => {
        if (cancelled) return;

        const process = processRes.process;
        const resolvedModel =
          process?.model ?? currentModel ?? modelsRes.models[0]?.id;
        const resolvedEffort = normalizeEffortLevel(process?.effort);
        const resolvedThinkingMode = getThinkingModeFromProcess(
          process?.thinking,
          process?.effort,
        );

        setModels(modelsRes.models);
        setCurrentModelId(resolvedModel);
        setSelectedModel(resolvedModel);
        setCurrentThinkingMode(resolvedThinkingMode);
        setThinkingModeState(resolvedThinkingMode);
        setCurrentEffortLevel(resolvedEffort);
        setEffortLevelState(resolvedEffort);
        setLastTouchedSection(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("modelSwitchLoadFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentModel, processId, sessionId, t]);

  const dirty =
    !loading &&
    !sameSelection(
      currentModelId,
      currentThinkingMode,
      currentEffortLevel,
      selectedModel,
      thinkingMode,
      effortLevel,
    );

  const applyConfig = async () => {
    if (switching || !selectedModel) return;
    setSwitching(true);
    setError(null);
    try {
      const thinking = toThinkingOption(thinkingMode, effortLevel);
      const result = await api.setProcessConfig(processId, {
        model: selectedModel,
        thinking,
      });
      setThinkingMode(thinkingMode);
      setEffortLevel(effortLevel);
      onModelChanged(result);
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : t("modelSwitchChangeFailed"),
      );
      setSwitching(false);
    }
  };

  const handleDismiss = () => {
    if (switching) return;
    if (dirty) {
      void applyConfig();
      return;
    }
    onClose();
  };

  const currentIndicatorTone = getIndicatorToneFromProcess(
    { type: currentThinkingMode === "off" ? "disabled" : "adaptive" },
    currentThinkingMode === "on" ? currentEffortLevel : undefined,
  );
  const pendingIndicatorTone = getIndicatorToneFromSelection(
    thinkingMode,
    effortLevel,
  );
  const renderThinkingLabel = (mode: ThinkingMode, effort: EffortLevel) => {
    if (mode === "off") return t("newSessionThinkingOff");
    if (mode === "auto") return t("newSessionThinkingAuto");
    return t("newSessionThinkingOn", { level: effort });
  };
  const renderConfigBadge = (
    modelId: string | undefined,
    mode: ThinkingMode,
    effort: EffortLevel,
    tone: string,
  ) => (
    <span className="model-switch-action-badge">
      <span
        className={`model-switch-indicator-dot tone-${tone}`}
        aria-hidden="true"
      />
      <span className="model-switch-action-badge-main">
        {modelId ?? "Default"}
      </span>
      <span className="model-switch-action-badge-detail">
        {renderThinkingLabel(mode, effort)}
      </span>
    </span>
  );
  const renderInlineSave = () => (
    <button
      type="button"
      className="settings-button model-switch-inline-save"
      onClick={() => void applyConfig()}
      disabled={switching || !selectedModel}
    >
      {t("modelSwitchSaveAll")}
    </button>
  );

  return (
    <Modal title={t("modelSwitchTitle")} onClose={handleDismiss}>
      <div className="model-switch-content">
        {loading && (
          <div className="model-switch-loading">{t("modelSwitchLoading")}</div>
        )}

        {!loading && (
          <>
            <div className="model-switch-status">
              <div className="model-switch-status-row">
                <span className="model-switch-status-marker">
                  {t("modelSwitchCurrent")}
                </span>
                <span
                  className={`model-switch-indicator-dot tone-${currentIndicatorTone}`}
                  aria-hidden="true"
                />
                <span className="model-switch-status-main">
                  {currentModelId ?? currentModel ?? "Default"}
                </span>
                <span className="model-switch-status-detail">
                  {renderThinkingLabel(currentThinkingMode, currentEffortLevel)}
                </span>
              </div>
              {dirty && (
                <div className="model-switch-status-row pending">
                  <span className="model-switch-status-marker" aria-hidden="true">
                    →
                  </span>
                  <span
                    className={`model-switch-indicator-dot tone-${pendingIndicatorTone}`}
                    aria-hidden="true"
                  />
                  <span className="model-switch-status-main">
                    {selectedModel ?? currentModelId ?? "Default"}
                  </span>
                  <span className="model-switch-status-detail">
                    {renderThinkingLabel(thinkingMode, effortLevel)}
                  </span>
                </div>
              )}
            </div>

            {error && <div className="model-switch-error">{error}</div>}

            <section className="model-switch-section">
              <div className="model-switch-section-header">
                <strong>{t("newSessionThinkingMode")}</strong>
              </div>
              <div className="model-switch-chip-group">
                {(["off", "auto", "on"] as ThinkingMode[]).map((mode) => {
                  const isCurrent = currentThinkingMode === mode;
                  const isSelected = thinkingMode === mode;
                  const showInlineSave =
                    dirty && lastTouchedSection === "thinking" && isSelected;
                  return (
                    <Fragment key={mode}>
                      <button
                        type="button"
                        className={`model-switch-chip ${isCurrent ? "current" : ""} ${isSelected ? "active" : ""}`}
                        onClick={() => {
                          if (thinkingMode !== mode) {
                            setLastTouchedSection("thinking");
                          }
                          setThinkingModeState(mode);
                        }}
                        disabled={switching}
                      >
                        <span
                          className={`model-switch-indicator-dot tone-${
                            mode === "off"
                              ? "off"
                              : mode === "auto"
                                ? "auto"
                                : effortLevel
                          }`}
                          aria-hidden="true"
                        />
                        <span>
                          {mode === "off"
                            ? "Off"
                            : mode === "auto"
                              ? "Auto"
                              : "On"}
                        </span>
                      </button>
                      {showInlineSave && renderInlineSave()}
                    </Fragment>
                  );
                })}
              </div>
            </section>

            <section className="model-switch-section">
              <div className="model-switch-section-header">
                <strong>{t("modelSettingsEffortTitle")}</strong>
              </div>
              <div className="model-switch-chip-group">
                {EFFORT_LEVELS.map((level) => {
                  const isCurrent =
                    currentThinkingMode === "on" && currentEffortLevel === level;
                  const isSelected =
                    thinkingMode === "on" && effortLevel === level;
                  const showInlineSave =
                    dirty && lastTouchedSection === "effort" && isSelected;
                  return (
                    <Fragment key={level}>
                      <button
                        type="button"
                        className={`model-switch-chip ${isCurrent ? "current" : ""} ${isSelected ? "active" : ""}`}
                        onClick={() => {
                          if (thinkingMode !== "on" || effortLevel !== level) {
                            setLastTouchedSection("effort");
                          }
                          setEffortLevelState(level);
                          setThinkingModeState("on");
                        }}
                        disabled={switching}
                      >
                        <span
                          className={`model-switch-indicator-dot tone-${level}`}
                          aria-hidden="true"
                        />
                        <span>{level}</span>
                      </button>
                      {showInlineSave && renderInlineSave()}
                    </Fragment>
                  );
                })}
              </div>
            </section>

            {!error && models.length === 0 && (
              <div className="model-switch-loading">{t("modelSwitchEmpty")}</div>
            )}

            {models.length > 0 && (
              <section className="model-switch-section">
                <div className="model-switch-section-header">
                  <strong>{t("newSessionModelTitle")}</strong>
                </div>
                <div className="model-switch-list">
                  {models.map((model) => {
                    const isCurrent = currentModelId === model.id;
                    const isSelected = selectedModel === model.id;
                    const showInlineSave =
                      dirty && lastTouchedSection === "model" && isSelected;
                    return (
                      <div key={model.id} className="model-switch-item-row">
                        <button
                          type="button"
                          className={`model-switch-item ${isCurrent ? "current" : ""} ${isSelected ? "active" : ""}`}
                          onClick={() => {
                            if (selectedModel !== model.id) {
                              setLastTouchedSection("model");
                            }
                            setSelectedModel(model.id);
                          }}
                          disabled={switching}
                        >
                          <span className="model-switch-item-main">
                            <span className="model-switch-name">{model.name}</span>
                            {model.description && (
                              <span className="model-switch-description">
                                {model.description}
                              </span>
                            )}
                          </span>
                          <span className="model-switch-item-meta">
                            {isCurrent && (
                              <span className="model-switch-tag">
                                {t("modelSwitchCurrent")}
                              </span>
                            )}
                            <span
                              className={`model-switch-radio ${isSelected ? "selected" : ""}`}
                              aria-hidden="true"
                            >
                              {isSelected ? "●" : "○"}
                            </span>
                          </span>
                        </button>
                        {showInlineSave && renderInlineSave()}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {dirty && (
              <div className="model-switch-actions">
                <button
                  type="button"
                  className="settings-button settings-button-secondary model-switch-action-button"
                  onClick={onClose}
                  disabled={switching}
                >
                  <span className="model-switch-action-label">
                    {t("modalCancel")}
                  </span>
                  {renderConfigBadge(
                    currentModelId ?? currentModel,
                    currentThinkingMode,
                    currentEffortLevel,
                    currentIndicatorTone,
                  )}
                </button>
                <button
                  type="button"
                  className="settings-button model-switch-action-button"
                  onClick={() => void applyConfig()}
                  disabled={switching || !selectedModel}
                >
                  <span className="model-switch-action-label">
                    {t("modelSwitchSaveAll")}
                  </span>
                  {renderConfigBadge(
                    selectedModel ?? currentModelId ?? currentModel,
                    thinkingMode,
                    effortLevel,
                    pendingIndicatorTone,
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
