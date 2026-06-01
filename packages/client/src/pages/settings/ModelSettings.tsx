import {
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  PROMPT_SUGGESTION_MODES,
  type NewSessionDefaults,
  resolveModel,
  type ModelInfo,
  type PermissionMode,
  type PromptSuggestionMode,
  type ProviderInfo,
  type ProviderName,
  type RecapMode,
} from "@yep-anywhere/shared";
import {
  MODEL_OPTIONS,
  getModelSetting,
  useModelSettings,
} from "../../hooks/useModelSettings";
import {
  getEffortLevelOptions,
  resolveSupportedEffortLevel,
} from "../../lib/effortLevels";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { useToastContext } from "../../contexts/ToastContext";
import { helperTargetsToModelOptions } from "../../lib/helperTargets";
import {
  FilterDropdown,
  type FilterOption,
} from "../../components/FilterDropdown";

const MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];
const RECAP_MODE_ORDER: RecapMode[] = ["off", "native", "side-session"];
const PROMPT_SUGGESTION_MODE_ORDER: PromptSuggestionMode[] = [
  ...PROMPT_SUGGESTION_MODES,
];

function getPreferredProvider(
  providers: ProviderInfo[],
  preferredProvider?: ProviderName,
): ProviderInfo | null {
  const availableProviders = getAvailableProviders(providers);
  if (preferredProvider) {
    const matching = availableProviders.find(
      (p) => p.name === preferredProvider,
    );
    if (matching) return matching;
  }
  return getDefaultProvider(providers);
}

function getPreferredModel(
  models: ModelInfo[],
  preferredModel?: string,
): string | null {
  if (preferredModel) {
    const matchingModel = models.find((m) => m.id === preferredModel);
    if (matchingModel) return matchingModel.id;
  }
  return models.find((m) => m.id === "default")?.id ?? models[0]?.id ?? null;
}

function getPreferredProviderModel(
  providerName: ProviderName,
  models: ModelInfo[],
  defaults?: {
    provider?: ProviderName;
    model?: string;
  } | null,
): string | null {
  const sessionDefaultModel =
    defaults?.provider === providerName ? defaults.model : undefined;
  const legacyClaudeFallbackModel =
    providerName === "claude" ? resolveModel(getModelSetting()) : undefined;

  return getPreferredModel(
    models,
    sessionDefaultModel ?? legacyClaudeFallbackModel,
  );
}

function providerSupportsRecapMode(
  provider:
    | {
        supportsRecaps?: boolean;
        supportsNativeRecaps?: boolean;
      }
    | null
    | undefined,
  mode: RecapMode,
): boolean {
  if (mode === "off") return true;
  if (mode === "native") return provider?.supportsNativeRecaps === true;
  return provider?.supportsRecaps === true;
}

function getDefaultRecapMode(
  provider:
    | {
        supportsRecaps?: boolean;
        supportsNativeRecaps?: boolean;
      }
    | null
    | undefined,
  defaults?: { recapMode?: RecapMode } | null,
): RecapMode {
  if (
    defaults?.recapMode &&
    providerSupportsRecapMode(provider, defaults.recapMode)
  ) {
    return defaults.recapMode;
  }
  return provider?.supportsNativeRecaps ? "native" : "off";
}

function providerSupportsPromptSuggestionMode(
  provider: { supportsNativePromptSuggestions?: boolean } | null | undefined,
  mode: PromptSuggestionMode,
): boolean {
  if (mode === "off") return true;
  return provider?.supportsNativePromptSuggestions === true;
}

function getDefaultPromptSuggestionMode(
  provider: { supportsNativePromptSuggestions?: boolean } | null | undefined,
  defaults?: { promptSuggestionMode?: PromptSuggestionMode } | null,
): PromptSuggestionMode {
  if (
    defaults?.promptSuggestionMode &&
    providerSupportsPromptSuggestionMode(
      provider,
      defaults.promptSuggestionMode,
    )
  ) {
    return defaults.promptSuggestionMode;
  }
  return provider?.supportsNativePromptSuggestions ? "native" : "off";
}

function getDefaultHelperSideModel(
  models: ModelInfo[],
  defaults?: { helperSideModel?: string } | null,
): string {
  const defaultModel = defaults?.helperSideModel;
  if (
    defaultModel &&
    (defaultModel === HELPER_SIDE_MODEL_CHEAPEST ||
      defaultModel === HELPER_SIDE_MODEL_SAME_AS_MAIN ||
      models.some((model) => model.id === defaultModel))
  ) {
    return defaultModel;
  }
  return HELPER_SIDE_MODEL_CHEAPEST;
}

export function ModelSettings() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const {
    model,
    setModel,
    effortLevel,
    setEffortLevel,
    thinkingMode,
    setThinkingMode,
  } = useModelSettings();
  const { providers, loading: providersLoading } = useProviders();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting,
  } = useServerSettings();

  const availableProviders = getAvailableProviders(providers);
  const savedDefaults = settings?.newSessionDefaults;
  const selectedProvider =
    getPreferredProvider(providers, savedDefaults?.provider) ?? null;
  const selectedModels = selectedProvider?.models ?? [];
  const selectedModel =
    selectedProvider === null
      ? null
      : getPreferredProviderModel(
          selectedProvider.name,
          selectedModels,
          savedDefaults,
        );
  const helperTargetModelOptions = helperTargetsToModelOptions(
    settings?.helperTargets,
  );
  const helperSelectableModels = [
    ...helperTargetModelOptions,
    ...selectedModels,
  ];
  const selectedRecapMode = getDefaultRecapMode(
    selectedProvider,
    savedDefaults,
  );
  const selectedPromptSuggestionMode = getDefaultPromptSuggestionMode(
    selectedProvider,
    savedDefaults,
  );
  const selectedHelperSideModel = getDefaultHelperSideModel(
    helperSelectableModels,
    savedDefaults,
  );
  const selectedModelInfo =
    selectedModels.find((modelInfo) => modelInfo.id === selectedModel) ?? null;
  const effortOptions = getEffortLevelOptions({
    provider: selectedProvider,
    model: selectedModelInfo,
  });
  const effectiveEffortLevel = resolveSupportedEffortLevel(
    effortLevel,
    effortOptions,
  );
  const claudeProvider = availableProviders.find((p) => p.name === "claude");
  const thinkingOptions: Array<{
    value: "off" | "auto" | "on";
    label: string;
  }> = [
    { value: "off", label: t("modelSettingsThinkingOffLabel") },
    { value: "auto", label: t("modelSettingsThinkingAutoLabel") },
    { value: "on", label: t("modelSettingsThinkingOnLabel") },
  ];
  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
  };
  const modeDescriptions: Record<PermissionMode, string> = {
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
  };
  const recapModeLabels: Record<RecapMode, string> = {
    off: t("recapModeOff"),
    native: t("recapModeNative"),
    "side-session": t("recapModeSideSession"),
  };
  const recapModeDescriptions: Record<RecapMode, string> = {
    off: t("recapModeOffDescription"),
    native: t("recapModeNativeDescription"),
    "side-session": t("recapModeSideSessionDescription"),
  };
  const promptSuggestionModeLabels: Record<PromptSuggestionMode, string> = {
    off: t("promptSuggestionModeOff"),
    native: t("promptSuggestionModeNative"),
  };
  const promptSuggestionModeDescriptions: Record<PromptSuggestionMode, string> =
    {
      off: t("promptSuggestionModeOffDescription"),
      native: t("promptSuggestionModeNativeDescription"),
    };
  const supportsPermissionMode =
    selectedProvider?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    selectedProvider?.supportsThinkingToggle ?? true;
  const availableRecapModes = RECAP_MODE_ORDER.filter((modeValue) =>
    providerSupportsRecapMode(selectedProvider, modeValue),
  );
  const availablePromptSuggestionModes = PROMPT_SUGGESTION_MODE_ORDER.filter(
    (modeValue) =>
      providerSupportsPromptSuggestionMode(selectedProvider, modeValue),
  );
  const modelOptions: FilterOption<string>[] = selectedModels.map((option) => {
    const label = option.size
      ? `${option.name} (${(option.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
      : option.name;
    const descriptionParts: string[] = [];
    if (option.parameterSize) descriptionParts.push(option.parameterSize);
    if (option.contextWindow) {
      descriptionParts.push(`${Math.round(option.contextWindow / 1024)}K ctx`);
    }
    if (option.parentModel) descriptionParts.push(option.parentModel);
    if (option.quantizationLevel) {
      descriptionParts.push(option.quantizationLevel);
    }
    return {
      value: option.id,
      label,
      description: option.description ?? descriptionParts.join(" · "),
    };
  });
  const helperSideModelOptions: FilterOption<string>[] = [
    {
      value: HELPER_SIDE_MODEL_CHEAPEST,
      label: t("helperSideModelCheapest"),
    },
    {
      value: HELPER_SIDE_MODEL_SAME_AS_MAIN,
      label: t("helperSideModelSameAsMain"),
      description: selectedModel ?? undefined,
    },
    ...helperSelectableModels.map((option) => ({
      value: option.id,
      label: option.name,
      description: option.description,
    })),
  ];

  const updateNewSessionDefaults = async (
    updates: NewSessionDefaults,
  ): Promise<void> => {
    try {
      await updateSetting("newSessionDefaults", {
        ...savedDefaults,
        ...updates,
      });
      showToast(t("newSessionDefaultsSaved"), "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("newSessionDefaultsSaveError"),
        "error",
      );
    }
  };

  const handleProviderChange = async (providerName: ProviderName) => {
    const provider = availableProviders.find((p) => p.name === providerName);
    if (!provider) return;
    const providerModels = provider.models ?? [];
    const nextModel =
      getPreferredProviderModel(provider.name, providerModels, savedDefaults) ??
      undefined;
    await updateNewSessionDefaults({
      provider: provider.name,
      model: nextModel,
      recapMode: getDefaultRecapMode(provider, savedDefaults),
      promptSuggestionMode: getDefaultPromptSuggestionMode(
        provider,
        savedDefaults,
      ),
      helperSideModel: getDefaultHelperSideModel(
        [...helperTargetModelOptions, ...providerModels],
        savedDefaults,
      ),
    });
  };

  const handleDefaultModelChange = async (modelId: string) => {
    if (!selectedProvider) return;

    await updateNewSessionDefaults({
      provider: selectedProvider.name,
      model: modelId,
    });
  };

  return (
    <section className="settings-section">
      <h2>{t("modelSettingsTitle")}</h2>

      <div className="settings-group">
        <div className="model-settings-subsection">
          <h3>{t("modelSettingsSessionDefaultsTitle")}</h3>
          <p>{t("modelSettingsSessionDefaultsDescription")}</p>
        </div>

        <div className="settings-session-defaults-panel">
          <div className="new-session-provider-section session-default-provider-section">
            <h3>{t("newSessionProviderTitle")}</h3>
            <p className="session-default-section-description">
              {t("modelSettingsDefaultProviderDescription")}
            </p>
            <div className="provider-options">
              {availableProviders.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  className={`provider-option ${
                    selectedProvider?.name === provider.name ? "selected" : ""
                  }`}
                  onClick={() => void handleProviderChange(provider.name)}
                  disabled={providersLoading || settingsLoading}
                >
                  <span
                    className={`provider-option-dot provider-${provider.name}`}
                  />
                  <div className="provider-option-content">
                    <span className="provider-option-label">
                      {provider.displayName}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="new-session-model-section session-default-model-section">
            <div className="new-session-model-field">
              <h3>{t("newSessionModelTitle")}</h3>
              <p className="session-default-section-description">
                {t("modelSettingsDefaultModelDescription")}
              </p>
              {selectedModels.length > 0 ? (
                <FilterDropdown
                  label={t("newSessionModelTitle")}
                  options={modelOptions}
                  selected={selectedModel ? [selectedModel] : []}
                  onChange={(selected) => {
                    const nextModel = selected[0];
                    if (nextModel) void handleDefaultModelChange(nextModel);
                  }}
                  multiSelect={false}
                  placeholder={t("newSessionModelPlaceholder")}
                />
              ) : (
                <span className="model-settings-empty">
                  {t("modelSwitchEmpty")}
                </span>
              )}
            </div>
          </div>

          {supportsThinkingToggle && (
            <div className="new-session-helper-section session-default-thinking-section">
              <h3>{t("modelSettingsThinkingTitle")}</h3>
              <p className="session-default-section-description">
                {t("modelSettingsThinkingDescription")}
              </p>
              <div className="new-session-helper-options">
                {thinkingOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`new-session-helper-option ${
                      thinkingMode === opt.value ? "selected" : ""
                    }`}
                    onClick={() => setThinkingMode(opt.value)}
                  >
                    <span className={`mode-option-dot thinking-${opt.value}`} />
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
              {thinkingMode === "on" && (
                <div
                  className="new-session-effort-selector session-default-effort-selector"
                  role="group"
                  aria-label={t("modelSettingsEffortTitle")}
                >
                  {effortOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`new-session-effort-option ${
                        effectiveEffortLevel === opt.value ? "active" : ""
                      }`}
                      onClick={() => setEffortLevel(opt.value)}
                      title={opt.description}
                      aria-label={`${t("modelSettingsEffortTitle")}: ${opt.label}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {supportsPermissionMode && (
            <div className="new-session-mode-section session-default-mode-section">
              <h3>{t("newSessionModeTitle")}</h3>
              <div className="mode-options">
                {MODE_ORDER.map((modeValue) => (
                  <button
                    key={modeValue}
                    type="button"
                    className={`mode-option ${
                      (savedDefaults?.permissionMode ?? "default") === modeValue
                        ? "selected"
                        : ""
                    }`}
                    onClick={() =>
                      void updateNewSessionDefaults({
                        permissionMode: modeValue,
                      })
                    }
                    disabled={settingsLoading}
                  >
                    <span className={`mode-option-dot mode-${modeValue}`} />
                    <div className="mode-option-content">
                      <span className="mode-option-label">
                        {modeLabels[modeValue]}
                      </span>
                      <span className="mode-option-desc">
                        {modeDescriptions[modeValue]}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="new-session-helper-section session-default-recap-section">
            <h3>{t("newSessionRecapTitle")}</h3>
            <div className="new-session-helper-options">
              {availableRecapModes.map((modeValue) => (
                <button
                  key={modeValue}
                  type="button"
                  className={`new-session-helper-option ${
                    selectedRecapMode === modeValue ? "selected" : ""
                  }`}
                  onClick={() =>
                    void updateNewSessionDefaults({ recapMode: modeValue })
                  }
                  disabled={settingsLoading}
                  title={recapModeDescriptions[modeValue]}
                >
                  <span className={`mode-option-dot recap-${modeValue}`} />
                  <span>{recapModeLabels[modeValue]}</span>
                </button>
              ))}
            </div>
            {selectedRecapMode === "side-session" && (
              <div className="new-session-helper-model">
                <h3>{t("helperSideModelTitle")}</h3>
                <FilterDropdown
                  label={t("helperSideModelTitle")}
                  options={helperSideModelOptions}
                  selected={[selectedHelperSideModel]}
                  onChange={(selected) => {
                    const helperSideModel =
                      selected[0] ?? HELPER_SIDE_MODEL_CHEAPEST;
                    void updateNewSessionDefaults({ helperSideModel });
                  }}
                  multiSelect={false}
                  placeholder={t("helperSideModelCheapest")}
                />
              </div>
            )}
          </div>

          <div className="new-session-helper-section session-default-suggestions-section">
            <h3>{t("newSessionPromptSuggestionsTitle")}</h3>
            <div className="new-session-helper-options">
              {availablePromptSuggestionModes.map((modeValue) => (
                <button
                  key={modeValue}
                  type="button"
                  className={`new-session-helper-option ${
                    selectedPromptSuggestionMode === modeValue ? "selected" : ""
                  }`}
                  onClick={() =>
                    void updateNewSessionDefaults({
                      promptSuggestionMode: modeValue,
                    })
                  }
                  disabled={settingsLoading}
                  title={promptSuggestionModeDescriptions[modeValue]}
                >
                  <span className={`mode-option-dot suggestion-${modeValue}`} />
                  <span>{promptSuggestionModeLabels[modeValue]}</span>
                </button>
              ))}
            </div>
            {availablePromptSuggestionModes.length === 1 &&
              availablePromptSuggestionModes[0] === "off" &&
              selectedProvider && (
                <p className="new-session-helper-note">
                  {t("promptSuggestionNativeUnsupported", {
                    provider: selectedProvider.displayName,
                  })}
                </p>
              )}
          </div>
        </div>
      </div>

      {claudeProvider && (
        <div className="settings-group">
          <div className="model-settings-subsection">
            <h3>{t("modelSettingsClaudeSectionTitle")}</h3>
            <p>{t("modelSettingsClaudeSectionDescription")}</p>
          </div>

          <div className="settings-item model-settings-item">
            <div className="settings-item-info">
              <strong>{t("modelSettingsModelTitle")}</strong>
              <p>{t("modelSettingsModelDescription")}</p>
            </div>
            <div className="font-size-selector model-settings-chip-group">
              {MODEL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`font-size-option ${model === opt.value ? "active" : ""}`}
                  onClick={() => setModel(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
