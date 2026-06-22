import type {
  EffortLevel,
  ModelInfo,
  ProviderName,
} from "@yep-anywhere/shared";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import {
  getShowThinkingSetting,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useI18n } from "../i18n";
import {
  getEffortLevelLabel,
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../lib/effortLevels";
import {
  getIndicatorToneFromProcess,
  getIndicatorToneFromSelection,
  getThinkingModeFromProcess,
  normalizeEffortLevel,
} from "../lib/modelConfigIndicator";
import { ProviderBadge } from "./ProviderBadge";
import { Modal } from "./ui/Modal";

interface ModelSwitchModalProps {
  /** Live owned process id; absent when the session isn't an owned live process. */
  processId?: string;
  sessionId: string;
  currentModel?: string;
  onModelChanged: (next: {
    processId: string;
    model?: string;
    thinking?: { type: string };
    effort?: string;
  }) => void;
  /** When provided, renders an "Info" tab whose pane is this node. */
  infoPane?: ReactNode;
  /** Which tab is focused on open (default "model"). */
  initialTab?: "model" | "info";
  /**
   * Spawn a live process for a reaped session without sending a turn
   * (message-less reactivate). When provided, the Model tab's "No active
   * process" note becomes an Activate button; on success the parent flips
   * ownership so `processId` arrives and the full options load.
   */
  onActivate?: () => Promise<void>;
  onClose: () => void;
}

type ThinkingMode = "off" | "auto" | "on";
type DirtySection = "thinking" | "effort" | "model" | null;

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
  infoPane,
  initialTab,
  onActivate,
  onClose,
}: ModelSwitchModalProps) {
  const { t } = useI18n();
  const { setThinkingMode, setEffortLevel } = useModelSettings();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [provider, setProvider] = useState<ProviderName | null>(null);
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
  const [activeTab, setActiveTab] = useState<"model" | "info">(
    initialTab ?? "model",
  );
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  useEffect(() => {
    if (!processId) {
      setLoading(false);
      return;
    }
    // processId may have just appeared (e.g. after Activate) - show the spinner
    // while models load rather than flashing the empty state.
    setLoading(true);
    let cancelled = false;

    Promise.all([
      api.getProcessModels(processId),
      api.getProcessInfo(sessionId),
    ])
      .then(([modelsRes, processRes]) => {
        if (cancelled) return;

        const process = processRes.process;
        const resolvedModel =
          process?.model ?? currentModel ?? modelsRes.models[0]?.id;
        const processProvider = process?.provider ?? null;
        const resolvedEffort = normalizeEffortLevel(
          process?.effort,
          processProvider,
        );
        const resolvedThinkingMode = getThinkingModeFromProcess(
          process?.thinking,
          process?.effort,
        );

        setModels(modelsRes.models);
        setProvider(processProvider);
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

  const selectedModelInfo = useMemo(
    () => models.find((model) => model.id === selectedModel) ?? null,
    [models, selectedModel],
  );
  const effortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider,
        model: selectedModelInfo,
        translate: t,
      }),
    [provider, selectedModelInfo, t],
  );
  const effectiveEffortLevel = resolveSupportedEffortLevel(
    effortLevel,
    effortOptions,
  );
  const thinkingModeOptions = useMemo(
    () =>
      getThinkingModeOptions({
        provider,
        model: selectedModelInfo,
        effortOptions,
      }),
    [effortOptions, provider, selectedModelInfo],
  );
  const effectiveThinkingMode = resolveSupportedThinkingMode(
    thinkingMode,
    thinkingModeOptions,
  );
  const showEffortOptions = thinkingModeOptions.includes("on");

  const dirty =
    !loading &&
    !sameSelection(
      currentModelId,
      currentThinkingMode,
      currentEffortLevel,
      selectedModel,
      effectiveThinkingMode,
      effectiveEffortLevel,
    );

  const applyConfig = async (afterApply?: () => void) => {
    if (switching || !selectedModel || !processId) return;
    setSwitching(true);
    setError(null);
    try {
      const thinking = toThinkingOption(
        effectiveThinkingMode,
        effectiveEffortLevel,
      );
      const result = await api.setProcessConfig(processId, {
        model: selectedModel,
        thinking,
        showThinking: getShowThinkingSetting(),
      });
      setThinkingMode(effectiveThinkingMode);
      setEffortLevel(effectiveEffortLevel);
      onModelChanged(result);
      onClose();
      afterApply?.();
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

  const handleActivate = async () => {
    if (!onActivate || activating) return;
    setActivating(true);
    setActivateError(null);
    try {
      await onActivate();
      // On success the parent flips ownership; `processId` arrives as a prop,
      // the model-load effect fires, and the full options replace this note.
    } catch (err) {
      setActivateError(
        err instanceof Error ? err.message : t("modelSwitchActivateFailed"),
      );
    } finally {
      setActivating(false);
    }
  };

  const currentIndicatorTone = getIndicatorToneFromProcess(
    { type: currentThinkingMode === "off" ? "disabled" : "adaptive" },
    currentThinkingMode === "on" ? currentEffortLevel : undefined,
    provider,
  );
  const pendingIndicatorTone = getIndicatorToneFromSelection(
    effectiveThinkingMode,
    effectiveEffortLevel,
  );
  const renderThinkingLabel = (mode: ThinkingMode, effort: EffortLevel) => {
    if (mode === "off") return t("newSessionThinkingOff");
    if (mode === "auto") return t("newSessionThinkingAuto");
    return t("newSessionThinkingOn", {
      level: getEffortLevelLabel(effort, provider, t),
    });
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
        {modelId ?? t("processInfoDefaultModel")}
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
        {infoPane && (
          <div className="model-switch-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "model"}
              className={`model-switch-tab ${activeTab === "model" ? "active" : ""}`}
              onClick={() => setActiveTab("model")}
            >
              {t("newSessionModelTitle")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "info"}
              className={`model-switch-tab ${activeTab === "info" ? "active" : ""}`}
              onClick={() => setActiveTab("info")}
            >
              {t("processInfoTitle")}
            </button>
          </div>
        )}
        {infoPane && activeTab === "info" && (
          <div className="model-switch-info-pane">{infoPane}</div>
        )}
        {(!infoPane || activeTab === "model") && loading && (
          <div className="model-switch-loading">{t("modelSwitchLoading")}</div>
        )}

        {(!infoPane || activeTab === "model") && !loading && (
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
                  {currentModelId ??
                    currentModel ??
                    t("processInfoDefaultModel")}
                </span>
                <span className="model-switch-status-detail">
                  {renderThinkingLabel(currentThinkingMode, currentEffortLevel)}
                </span>
              </div>
              {dirty && (
                <div className="model-switch-status-row pending">
                  <span
                    className="model-switch-status-marker"
                    aria-hidden="true"
                  >
                    →
                  </span>
                  <span
                    className={`model-switch-indicator-dot tone-${pendingIndicatorTone}`}
                    aria-hidden="true"
                  />
                  <span className="model-switch-status-main">
                    {selectedModel ??
                      currentModelId ??
                      t("processInfoDefaultModel")}
                  </span>
                  <span className="model-switch-status-detail">
                    {renderThinkingLabel(
                      effectiveThinkingMode,
                      effectiveEffortLevel,
                    )}
                  </span>
                </div>
              )}
            </div>
            {!processId && (
              <div className="model-switch-activate">
                <span className="model-switch-activate-note">
                  {t("processInfoNoActiveProcess")}
                </span>
                {onActivate && (
                  <button
                    type="button"
                    className="settings-button model-switch-inline-save"
                    onClick={handleActivate}
                    disabled={activating}
                  >
                    {activating
                      ? t("modelSwitchActivating")
                      : t("modelSwitchActivate")}
                  </button>
                )}
                {activateError && (
                  <div className="model-switch-error">{activateError}</div>
                )}
              </div>
            )}
            {error && <div className="model-switch-error">{error}</div>}

            {processId && (
              <section className="model-switch-section">
                <div className="model-switch-section-header">
                  <strong>{t("newSessionThinkingMode")}</strong>
                </div>
                <div className="model-switch-chip-group">
                  {thinkingModeOptions.map((mode) => {
                    const isCurrent = currentThinkingMode === mode;
                    const isSelected = effectiveThinkingMode === mode;
                    const showInlineSave =
                      dirty && lastTouchedSection === "thinking" && isSelected;
                    return (
                      <Fragment key={mode}>
                        <button
                          type="button"
                          className={`model-switch-chip ${isCurrent ? "current" : ""} ${isSelected ? "active" : ""}`}
                          onClick={() => {
                            if (effectiveThinkingMode !== mode) {
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
                                  : effectiveEffortLevel
                            }`}
                            aria-hidden="true"
                          />
                          <span>
                            {mode === "off"
                              ? t("modelSettingsThinkingOffLabel")
                              : mode === "auto"
                                ? t("modelSettingsThinkingAutoLabel")
                                : t("modelSettingsThinkingOnLabel")}
                          </span>
                        </button>
                        {showInlineSave && renderInlineSave()}
                      </Fragment>
                    );
                  })}
                </div>
              </section>
            )}

            {processId && showEffortOptions && (
              <section className="model-switch-section">
                <div className="model-switch-section-header">
                  <strong>{t("modelSettingsEffortTitle")}</strong>
                </div>
                <div className="model-switch-chip-group">
                  {effortOptions.map((option) => {
                    const isCurrent =
                      currentThinkingMode === "on" &&
                      currentEffortLevel === option.value;
                    const isSelected =
                      effectiveThinkingMode === "on" &&
                      effectiveEffortLevel === option.value;
                    const showInlineSave =
                      dirty && lastTouchedSection === "effort" && isSelected;
                    return (
                      <Fragment key={option.value}>
                        <button
                          type="button"
                          className={`model-switch-chip ${isCurrent ? "current" : ""} ${isSelected ? "active" : ""}`}
                          onClick={() => {
                            if (
                              effectiveThinkingMode !== "on" ||
                              effortLevel !== option.value
                            ) {
                              setLastTouchedSection("effort");
                            }
                            setEffortLevelState(option.value);
                            setThinkingModeState("on");
                          }}
                          disabled={switching}
                          title={option.description}
                        >
                          <span
                            className={`model-switch-indicator-dot tone-${option.value}`}
                            aria-hidden="true"
                          />
                          <span>{option.label}</span>
                        </button>
                        {showInlineSave && renderInlineSave()}
                      </Fragment>
                    );
                  })}
                </div>
              </section>
            )}

            {processId && !error && models.length === 0 && (
              <div className="model-switch-loading">
                {t("modelSwitchEmpty")}
              </div>
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
                            <span className="model-switch-name-row">
                              <span className="model-switch-name">
                                {model.name}
                              </span>
                              {provider && (
                                <ProviderBadge
                                  provider={provider}
                                  model={model.id}
                                />
                              )}
                            </span>
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
                    effectiveThinkingMode,
                    effectiveEffortLevel,
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
