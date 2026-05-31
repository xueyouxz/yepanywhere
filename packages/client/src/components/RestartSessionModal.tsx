import type {
  EffortLevel,
  ModelInfo,
  NewSessionDefaults,
  PromptSuggestionMode,
  ProviderInfo,
  ProviderName,
  RecapMode,
  ThinkingOption,
} from "@yep-anywhere/shared";
import {
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  resolveModel,
} from "@yep-anywhere/shared";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { getModelSetting } from "../hooks/useModelSettings";
import {
  getAvailableProviders,
  getDefaultProvider,
} from "../hooks/useProviders";
import { useServerSettings } from "../hooks/useServerSettings";
import { helperTargetsToModelOptions } from "../lib/helperTargets";
import type { PermissionMode } from "../types";
import { useI18n } from "../i18n";
import {
  getEffortLevelLabel,
  getEffortLevelOptions,
  isEffortLevel,
  resolveSupportedEffortLevel,
} from "../lib/effortLevels";
import { Modal } from "./ui/Modal";

type ThinkingMode = "off" | "auto" | "on";

const RECAP_MODE_ORDER: RecapMode[] = ["off", "native", "side-session"];
const PROMPT_SUGGESTION_MODE_ORDER: PromptSuggestionMode[] = ["off", "native"];

function parseThinkingOption(option: ThinkingOption | undefined): {
  mode: ThinkingMode;
  effort: EffortLevel;
} {
  if (!option || option === "off") {
    return { mode: "off", effort: "high" };
  }
  if (option === "auto") {
    return { mode: "auto", effort: "high" };
  }
  if (option.startsWith("on:")) {
    const effort = option.slice(3);
    return {
      mode: "on",
      effort: isEffortLevel(effort) ? effort : "high",
    };
  }
  return {
    mode: "on",
    effort: isEffortLevel(option) ? option : "high",
  };
}

function toThinkingOption(
  mode: ThinkingMode,
  effort: EffortLevel,
): ThinkingOption {
  if (mode === "off") return "off";
  if (mode === "auto") return "auto";
  return `on:${effort}`;
}

function getPreferredModelId(
  models: ModelInfo[],
  preferredModelId?: string | null,
): string | null {
  if (preferredModelId) {
    const matchingPreferredModel = models.find(
      (m) => m.id === preferredModelId,
    );
    if (matchingPreferredModel) return matchingPreferredModel.id;
  }

  return models[0]?.id ?? null;
}

function getRestartDefaultModel(params: {
  provider: ProviderName;
  models: ModelInfo[];
  currentModel?: string;
  defaults?: NewSessionDefaults | null;
}): string {
  const sessionDefaultModel =
    params.defaults?.provider === params.provider
      ? params.defaults.model
      : undefined;
  const legacyClaudeFallbackModel =
    params.provider === "claude" ? resolveModel(getModelSetting()) : undefined;

  return (
    getPreferredModelId(
      params.models,
      sessionDefaultModel ?? legacyClaudeFallbackModel ?? params.currentModel,
    ) ??
    params.currentModel ??
    "default"
  );
}

function getRestartDefaultProvider(params: {
  sourceProvider: ProviderName;
  providers: ProviderInfo[];
  defaults?: NewSessionDefaults | null;
}): ProviderName {
  const availableProviders = getAvailableProviders(params.providers);
  const availableProviderNames = new Set(availableProviders.map((p) => p.name));

  // Prefer the session's own provider for handoff; saved defaults are a fallback
  if (availableProviderNames.has(params.sourceProvider)) {
    return params.sourceProvider;
  }

  if (
    params.defaults?.provider &&
    availableProviderNames.has(params.defaults.provider)
  ) {
    return params.defaults.provider;
  }

  return getDefaultProvider(params.providers)?.name ?? params.sourceProvider;
}

function getProviderModels(
  providerName: ProviderName,
  providers: ProviderInfo[],
  sourceProvider: ProviderName,
  sourceModels: ModelInfo[],
): ModelInfo[] {
  return (
    providers.find((p) => p.name === providerName)?.models ??
    (providerName === sourceProvider ? sourceModels : [])
  );
}

function providerSupportsRecapMode(
  provider:
    | Pick<ProviderInfo, "supportsRecaps" | "supportsNativeRecaps">
    | null
    | undefined,
  mode: RecapMode,
): boolean {
  if (mode === "off") return true;
  if (mode === "native") return provider?.supportsNativeRecaps === true;
  return provider?.supportsRecaps === true;
}

function getRestartDefaultRecapMode(params: {
  provider: ProviderInfo | null | undefined;
  defaults?: NewSessionDefaults | null;
}): RecapMode {
  if (
    params.defaults?.recapMode &&
    providerSupportsRecapMode(params.provider, params.defaults.recapMode)
  ) {
    return params.defaults.recapMode;
  }
  return params.provider?.supportsNativeRecaps ? "native" : "off";
}

function providerSupportsPromptSuggestionMode(
  provider:
    | Pick<ProviderInfo, "supportsNativePromptSuggestions">
    | null
    | undefined,
  mode: PromptSuggestionMode,
): boolean {
  if (mode === "off") return true;
  return provider?.supportsNativePromptSuggestions === true;
}

function getRestartDefaultPromptSuggestionMode(params: {
  provider: ProviderInfo | null | undefined;
  currentMode?: PromptSuggestionMode;
  defaults?: NewSessionDefaults | null;
}): PromptSuggestionMode {
  if (
    params.currentMode &&
    providerSupportsPromptSuggestionMode(params.provider, params.currentMode)
  ) {
    return params.currentMode;
  }
  if (
    params.defaults?.promptSuggestionMode &&
    providerSupportsPromptSuggestionMode(
      params.provider,
      params.defaults.promptSuggestionMode,
    )
  ) {
    return params.defaults.promptSuggestionMode;
  }
  return params.provider?.supportsNativePromptSuggestions ? "native" : "off";
}

function getRestartDefaultHelperSideModel(params: {
  models: ModelInfo[];
  defaults?: NewSessionDefaults | null;
}): string {
  const defaultModel = params.defaults?.helperSideModel;
  if (
    defaultModel &&
    (defaultModel === HELPER_SIDE_MODEL_CHEAPEST ||
      defaultModel === HELPER_SIDE_MODEL_SAME_AS_MAIN ||
      params.models.some((model) => model.id === defaultModel))
  ) {
    return defaultModel;
  }
  return HELPER_SIDE_MODEL_CHEAPEST;
}

interface RestartSessionModalProps {
  projectId: string;
  sessionId: string;
  provider: ProviderName;
  providerDisplayName?: string;
  providers?: ProviderInfo[];
  models?: ModelInfo[];
  currentModel?: string;
  mode?: PermissionMode;
  thinking?: ThinkingOption;
  promptSuggestionMode?: PromptSuggestionMode;
  executor?: string;
  onRestarted: (
    result: {
      sessionId: string;
      processId: string;
      provider?: ProviderName;
      model?: string;
      title?: string;
      oldProcessAborted: boolean;
    },
    options?: {
      openInNewWindow?: boolean;
      targetWindow?: Window | null;
    },
  ) => void;
  onClose: () => void;
}

export function RestartSessionModal({
  projectId,
  sessionId,
  provider,
  providerDisplayName,
  providers = [],
  models = [],
  currentModel,
  mode,
  thinking,
  promptSuggestionMode,
  executor,
  onRestarted,
  onClose,
}: RestartSessionModalProps) {
  const { t } = useI18n();
  const { settings, isLoading: settingsLoading } = useServerSettings();
  const providerOptions = useMemo<ProviderInfo[]>(() => {
    if (providers.length > 0) return providers;
    return [
      {
        name: provider,
        displayName: providerDisplayName ?? provider,
        installed: true,
        authenticated: true,
        enabled: true,
        models,
      },
    ];
  }, [models, provider, providerDisplayName, providers]);
  const availableProviders = useMemo(
    () => getAvailableProviders(providerOptions),
    [providerOptions],
  );
  const [selectedProvider, setSelectedProvider] = useState<ProviderName>(() =>
    getRestartDefaultProvider({
      sourceProvider: provider,
      providers: providerOptions,
      defaults: settings?.newSessionDefaults,
    }),
  );
  const hasUserSelectedProviderRef = useRef(false);
  const selectedProviderModels = useMemo(
    () =>
      getProviderModels(selectedProvider, providerOptions, provider, models),
    [models, provider, providerOptions, selectedProvider],
  );
  const modelOptions = useMemo<ModelInfo[]>(() => {
    if (selectedProviderModels.length > 0) return selectedProviderModels;
    return [{ id: "default", name: "Default" }];
  }, [selectedProviderModels]);
  const helperTargetModelOptions = useMemo(
    () => helperTargetsToModelOptions(settings?.helperTargets),
    [settings?.helperTargets],
  );
  const helperSelectableModels = useMemo(
    () => [...helperTargetModelOptions, ...modelOptions],
    [helperTargetModelOptions, modelOptions],
  );
  const [selectedModel, setSelectedModel] = useState<string>(
    getRestartDefaultModel({
      provider: selectedProvider,
      models: modelOptions,
      currentModel: selectedProvider === provider ? currentModel : undefined,
      defaults: settings?.newSessionDefaults,
    }),
  );
  const hasUserSelectedModelRef = useRef(false);
  const selectedProviderInfo = providerOptions.find(
    (p) => p.name === selectedProvider,
  );
  const selectedModelInfo =
    modelOptions.find((model) => model.id === selectedModel) ?? null;
  const effortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider: selectedProviderInfo,
        model: selectedModelInfo,
      }),
    [selectedModelInfo, selectedProviderInfo],
  );
  const [selectedRecapMode, setSelectedRecapMode] = useState<RecapMode>(() =>
    getRestartDefaultRecapMode({
      provider: selectedProviderInfo,
      defaults: settings?.newSessionDefaults,
    }),
  );
  const [selectedPromptSuggestionMode, setSelectedPromptSuggestionMode] =
    useState<PromptSuggestionMode>(() =>
      getRestartDefaultPromptSuggestionMode({
        provider: selectedProviderInfo,
        currentMode: promptSuggestionMode,
        defaults: settings?.newSessionDefaults,
      }),
    );
  const [helperSideModel, setHelperSideModel] = useState<string>(() =>
    getRestartDefaultHelperSideModel({
      models: helperSelectableModels,
      defaults: settings?.newSessionDefaults,
    }),
  );
  const hasUserSelectedHelperConfigRef = useRef(false);
  const initialThinking = useMemo(
    () => parseThinkingOption(thinking),
    [thinking],
  );
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(
    initialThinking.mode,
  );
  const [effortLevel, setEffortLevel] = useState<EffortLevel>(
    initialThinking.effort,
  );
  const effectiveEffortLevel = resolveSupportedEffortLevel(
    effortLevel,
    effortOptions,
  );
  const [openInNewWindow, setOpenInNewWindow] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProviderDisplayName =
    selectedProviderInfo?.displayName ??
    (selectedProvider === provider ? providerDisplayName : undefined) ??
    selectedProvider;
  const supportsThinkingToggle =
    selectedProviderInfo?.supportsThinkingToggle ?? true;

  useEffect(() => {
    if (settingsLoading || hasUserSelectedProviderRef.current) {
      return;
    }
    setSelectedProvider(
      getRestartDefaultProvider({
        sourceProvider: provider,
        providers: providerOptions,
        defaults: settings?.newSessionDefaults,
      }),
    );
  }, [provider, providerOptions, settings, settingsLoading]);

  useEffect(() => {
    if (settingsLoading || hasUserSelectedModelRef.current) {
      return;
    }
    setSelectedModel(
      getRestartDefaultModel({
        provider: selectedProvider,
        models: modelOptions,
        currentModel: selectedProvider === provider ? currentModel : undefined,
        defaults: settings?.newSessionDefaults,
      }),
    );
  }, [
    currentModel,
    modelOptions,
    provider,
    selectedProvider,
    settings,
    settingsLoading,
  ]);

  useEffect(() => {
    if (settingsLoading || hasUserSelectedHelperConfigRef.current) {
      return;
    }
    setSelectedRecapMode(
      getRestartDefaultRecapMode({
        provider: selectedProviderInfo,
        defaults: settings?.newSessionDefaults,
      }),
    );
    setSelectedPromptSuggestionMode(
      getRestartDefaultPromptSuggestionMode({
        provider: selectedProviderInfo,
        currentMode: promptSuggestionMode,
        defaults: settings?.newSessionDefaults,
      }),
    );
    setHelperSideModel(
      getRestartDefaultHelperSideModel({
        models: helperSelectableModels,
        defaults: settings?.newSessionDefaults,
      }),
    );
  }, [
    helperSelectableModels,
    promptSuggestionMode,
    selectedProviderInfo,
    settings,
    settingsLoading,
  ]);

  useEffect(() => {
    setThinkingMode(initialThinking.mode);
    setEffortLevel(initialThinking.effort);
  }, [initialThinking]);

  const renderThinkingLabel = (mode: ThinkingMode, effort: EffortLevel) => {
    if (mode === "off") return t("newSessionThinkingOff");
    if (mode === "auto") return t("newSessionThinkingAuto");
    return t("newSessionThinkingOn", {
      level: getEffortLevelLabel(effort, selectedProviderInfo),
    });
  };

  const restart = async (targetNewWindow = false) => {
    if (restarting) return;
    const shouldOpenInNewWindow = targetNewWindow || openInNewWindow;
    const targetWindow = shouldOpenInNewWindow
      ? window.open("about:blank", "_blank")
      : null;
    if (targetWindow) {
      targetWindow.opener = null;
    }
    setRestarting(true);
    setError(null);
    try {
      const result = await api.restartSession(projectId, sessionId, {
        mode,
        model: selectedModel,
        thinking: supportsThinkingToggle
          ? toThinkingOption(thinkingMode, effectiveEffortLevel)
          : undefined,
        provider: selectedProvider,
        executor,
        recapMode: selectedRecapMode,
        promptSuggestionMode: selectedPromptSuggestionMode,
        helperSideModel,
        reason: "Manual restart from Yep Anywhere",
      });
      onRestarted(result, {
        openInNewWindow: shouldOpenInNewWindow,
        targetWindow,
      });
    } catch (err) {
      targetWindow?.close();
      setError(err instanceof Error ? err.message : t("sessionRestartFailed"));
      setRestarting(false);
    }
  };

  const handleProviderSelect = (providerName: ProviderName) => {
    hasUserSelectedProviderRef.current = true;
    hasUserSelectedModelRef.current = false;
    hasUserSelectedHelperConfigRef.current = false;
    setSelectedProvider(providerName);
    const providerModels = getProviderModels(
      providerName,
      providerOptions,
      provider,
      models,
    );
    const nextModelOptions =
      providerModels.length > 0
        ? providerModels
        : [{ id: "default", name: "Default" }];
    setSelectedModel(
      getRestartDefaultModel({
        provider: providerName,
        models: nextModelOptions,
        currentModel: providerName === provider ? currentModel : undefined,
        defaults: settings?.newSessionDefaults,
      }),
    );
    setSelectedRecapMode(
      getRestartDefaultRecapMode({
        provider: providerOptions.find((p) => p.name === providerName),
        defaults: settings?.newSessionDefaults,
      }),
    );
    setSelectedPromptSuggestionMode(
      getRestartDefaultPromptSuggestionMode({
        provider: providerOptions.find((p) => p.name === providerName),
        currentMode: selectedPromptSuggestionMode,
        defaults: settings?.newSessionDefaults,
      }),
    );
    setHelperSideModel(
      getRestartDefaultHelperSideModel({
        models: [...helperTargetModelOptions, ...nextModelOptions],
        defaults: settings?.newSessionDefaults,
      }),
    );
  };

  const handleStartClick = (event: MouseEvent<HTMLButtonElement>) => {
    void restart(event.metaKey || event.ctrlKey || event.shiftKey);
  };

  const handleStartAuxClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    void restart(true);
  };

  const recapModeLabels: Record<RecapMode, string> = {
    off: t("recapModeOff"),
    native: t("recapModeNative"),
    "side-session": t("recapModeSideSession"),
  };
  const promptSuggestionModeLabels: Record<PromptSuggestionMode, string> = {
    off: t("promptSuggestionModeOff"),
    native: t("promptSuggestionModeNative"),
  };
  const helperSideModelOptions = [
    { id: HELPER_SIDE_MODEL_CHEAPEST, name: t("helperSideModelCheapest") },
    {
      id: HELPER_SIDE_MODEL_SAME_AS_MAIN,
      name: t("helperSideModelSameAsMain"),
      description: selectedModel,
    },
    ...helperSelectableModels,
  ];

  return (
    <Modal
      title={t("sessionRestartTitle")}
      onClose={restarting ? () => {} : onClose}
    >
      <div className="model-switch-content">
        <div className="model-switch-status">
          <div className="model-switch-status-row">
            <span className="model-switch-status-marker">
              {t("modelSwitchCurrent")}
            </span>
            <span className="model-switch-status-main">
              {currentModel ?? "Default"}
            </span>
            <span className="model-switch-status-detail">
              {providerDisplayName ?? provider}
            </span>
          </div>
          <div className="model-switch-status-row pending">
            <span className="model-switch-status-marker" aria-hidden="true">
              →
            </span>
            <span className="model-switch-status-main">
              {selectedModel ?? "Default"}
            </span>
            <span className="model-switch-status-detail">
              {supportsThinkingToggle
                ? `${selectedProviderDisplayName} · ${renderThinkingLabel(
                    thinkingMode,
                    effectiveEffortLevel,
                  )}`
                : selectedProviderDisplayName}
            </span>
          </div>
        </div>

        {error && <div className="model-switch-error">{error}</div>}

        {availableProviders.length > 1 && (
          <section className="model-switch-section">
            <div className="model-switch-section-header">
              <strong>{t("newSessionProviderTitle")}</strong>
            </div>
            <div className="provider-options">
              {providerOptions.map((p) => {
                const isAvailable =
                  p.installed && (p.authenticated || p.enabled);
                const isSelected = selectedProvider === p.name;
                return (
                  <button
                    key={p.name}
                    type="button"
                    className={`provider-option ${isSelected ? "selected" : ""} ${!isAvailable ? "disabled" : ""}`}
                    onClick={() => isAvailable && handleProviderSelect(p.name)}
                    disabled={restarting || !isAvailable}
                    title={
                      !isAvailable
                        ? t("newSessionProviderUnavailable", {
                            provider: p.displayName,
                            reason: !p.installed
                              ? t("newSessionProviderNotInstalled")
                              : t("newSessionProviderNotAuthenticated"),
                          })
                        : p.displayName
                    }
                  >
                    <span
                      className={`provider-option-dot provider-${p.name}`}
                    />
                    <div className="provider-option-content">
                      <span className="provider-option-label">
                        {p.displayName}
                      </span>
                      {!isAvailable && (
                        <span className="provider-option-status">
                          {!p.installed
                            ? t("newSessionProviderStatusNotInstalled")
                            : t("newSessionProviderStatusNotAuthenticated")}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="model-switch-section">
          <div className="model-switch-section-header">
            <strong>{t("newSessionModelTitle")}</strong>
          </div>
          <div className="model-switch-list">
            {modelOptions.map((model) => {
              const isCurrent = currentModel === model.id;
              const isSelected = selectedModel === model.id;
              return (
                <div key={model.id} className="model-switch-item-row">
                  <button
                    type="button"
                    className={`model-switch-item ${isCurrent ? "current" : ""} ${isSelected ? "active" : ""}`}
                    onClick={() => {
                      hasUserSelectedModelRef.current = true;
                      setSelectedModel(model.id);
                    }}
                    disabled={restarting}
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
                </div>
              );
            })}
          </div>
        </section>

        {supportsThinkingToggle && (
          <>
            <section className="model-switch-section">
              <div className="model-switch-section-header">
                <strong>{t("newSessionThinkingMode")}</strong>
              </div>
              <div className="model-switch-chip-group">
                {(["off", "auto", "on"] as ThinkingMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`model-switch-chip ${thinkingMode === mode ? "active" : ""}`}
                    onClick={() => setThinkingMode(mode)}
                    disabled={restarting}
                  >
                    <span
                      className={`model-switch-indicator-dot tone-${
                        mode === "off"
                          ? "off"
                          : mode === "auto"
                            ? "auto"
                            : getEffortLevelLabel(
                                effectiveEffortLevel,
                                selectedProviderInfo,
                              )
                      }`}
                      aria-hidden="true"
                    />
                    <span>
                      {mode === "off"
                        ? t("newSessionThinkingOff")
                        : mode === "auto"
                          ? t("newSessionThinkingAuto")
                          : t("newSessionThinkingOn", {
                              level: getEffortLevelLabel(
                                effectiveEffortLevel,
                                selectedProviderInfo,
                              ),
                            })}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="model-switch-section">
              <div className="model-switch-section-header">
                <strong>{t("modelSettingsEffortTitle")}</strong>
              </div>
              <div className="model-switch-chip-group">
                {effortOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`model-switch-chip ${
                      thinkingMode === "on" &&
                      effectiveEffortLevel === option.value
                        ? "active"
                        : ""
                    }`}
                    onClick={() => {
                      setThinkingMode("on");
                      setEffortLevel(option.value);
                    }}
                    disabled={restarting}
                    title={option.description}
                  >
                    <span
                      className={`model-switch-indicator-dot tone-${option.value}`}
                      aria-hidden="true"
                    />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}

        <section className="model-switch-section">
          <div className="model-switch-section-header">
            <strong>{t("newSessionRecapTitle")}</strong>
          </div>
          <div className="model-switch-chip-group">
            {RECAP_MODE_ORDER.map((recapMode) => {
              const isAvailable = providerSupportsRecapMode(
                selectedProviderInfo,
                recapMode,
              );
              return (
                <button
                  key={recapMode}
                  type="button"
                  className={`model-switch-chip ${
                    selectedRecapMode === recapMode ? "active" : ""
                  }`}
                  onClick={() => {
                    hasUserSelectedHelperConfigRef.current = true;
                    setSelectedRecapMode(recapMode);
                  }}
                  disabled={restarting || !isAvailable}
                >
                  <span>{recapModeLabels[recapMode]}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="model-switch-section">
          <div className="model-switch-section-header">
            <strong>{t("newSessionPromptSuggestionsTitle")}</strong>
          </div>
          <div className="model-switch-chip-group">
            {PROMPT_SUGGESTION_MODE_ORDER.map((modeValue) => {
              const isAvailable = providerSupportsPromptSuggestionMode(
                selectedProviderInfo,
                modeValue,
              );
              return (
                <button
                  key={modeValue}
                  type="button"
                  className={`model-switch-chip ${
                    selectedPromptSuggestionMode === modeValue ? "active" : ""
                  }`}
                  onClick={() => {
                    hasUserSelectedHelperConfigRef.current = true;
                    setSelectedPromptSuggestionMode(modeValue);
                  }}
                  disabled={restarting || !isAvailable}
                >
                  <span>{promptSuggestionModeLabels[modeValue]}</span>
                </button>
              );
            })}
          </div>
        </section>

        {selectedRecapMode === "side-session" && (
          <section className="model-switch-section">
            <div className="model-switch-section-header">
              <strong>{t("helperSideModelTitle")}</strong>
            </div>
            <div className="model-switch-list">
              {helperSideModelOptions.map((model) => {
                const isSelected = helperSideModel === model.id;
                return (
                  <div key={model.id} className="model-switch-item-row">
                    <button
                      type="button"
                      className={`model-switch-item ${isSelected ? "active" : ""}`}
                      onClick={() => {
                        hasUserSelectedHelperConfigRef.current = true;
                        setHelperSideModel(model.id);
                      }}
                      disabled={restarting}
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
                        <span
                          className={`model-switch-radio ${isSelected ? "selected" : ""}`}
                          aria-hidden="true"
                        >
                          {isSelected ? "●" : "○"}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <label className="model-switch-chip">
          <input
            type="checkbox"
            checked={openInNewWindow}
            onChange={(event) =>
              setOpenInNewWindow(event.currentTarget.checked)
            }
            disabled={restarting}
          />
          <span>{t("sessionRestartOpenNewWindow")}</span>
        </label>

        <div className="model-switch-actions">
          <button
            type="button"
            className="settings-button settings-button-secondary"
            onClick={onClose}
            disabled={restarting}
          >
            {t("modalCancel")}
          </button>
          <button
            type="button"
            className="settings-button"
            onClick={handleStartClick}
            onAuxClick={handleStartAuxClick}
            disabled={restarting || !selectedModel}
          >
            {restarting ? t("sessionRestarting") : t("sessionRestartStart")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
