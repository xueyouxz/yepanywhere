import {
  resolveModel,
  type ModelInfo,
  type ProviderInfo,
  type ProviderName,
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
  const selectedProvider =
    getPreferredProvider(providers, settings?.newSessionDefaults?.provider) ??
    null;
  const selectedModels = selectedProvider?.models ?? [];
  const selectedModel =
    selectedProvider === null
      ? null
      : getPreferredProviderModel(
          selectedProvider.name,
          selectedModels,
          settings?.newSessionDefaults,
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

  const handleProviderChange = async (providerName: ProviderName) => {
    const provider = availableProviders.find((p) => p.name === providerName);
    if (!provider) return;

    try {
      await updateSetting("newSessionDefaults", {
        ...settings?.newSessionDefaults,
        provider: provider.name,
        model:
          getPreferredProviderModel(
            provider.name,
            provider.models ?? [],
            settings?.newSessionDefaults,
          ) ?? undefined,
      });
      showToast(t("newSessionDefaultsSaved"), "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("newSessionDefaultsSaveError"),
        "error",
      );
    }
  };

  const handleDefaultModelChange = async (modelId: string) => {
    if (!selectedProvider) return;

    try {
      await updateSetting("newSessionDefaults", {
        ...settings?.newSessionDefaults,
        provider: selectedProvider.name,
        model: modelId,
      });
      showToast(t("newSessionDefaultsSaved"), "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("newSessionDefaultsSaveError"),
        "error",
      );
    }
  };

  return (
    <section className="settings-section">
      <h2>{t("modelSettingsTitle")}</h2>

      <div className="settings-group">
        <div className="model-settings-subsection">
          <h3>{t("modelSettingsSessionDefaultsTitle")}</h3>
          <p>{t("modelSettingsSessionDefaultsDescription")}</p>
        </div>

        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsDefaultProviderTitle")}</strong>
            <p>{t("modelSettingsDefaultProviderDescription")}</p>
          </div>
          <div className="font-size-selector model-settings-chip-group">
            {availableProviders.map((provider) => (
              <button
                key={provider.name}
                type="button"
                className={`font-size-option ${
                  selectedProvider?.name === provider.name ? "active" : ""
                }`}
                onClick={() => void handleProviderChange(provider.name)}
                disabled={providersLoading || settingsLoading}
              >
                {provider.displayName}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsDefaultModelTitle")}</strong>
            <p>{t("modelSettingsDefaultModelDescription")}</p>
          </div>
          <div className="font-size-selector model-settings-chip-group">
            {selectedModels.length > 0 ? (
              selectedModels.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`font-size-option ${
                    selectedModel === option.id ? "active" : ""
                  }`}
                  onClick={() => void handleDefaultModelChange(option.id)}
                  disabled={providersLoading || settingsLoading}
                  title={option.description}
                >
                  {option.name}
                </button>
              ))
            ) : (
              <span className="model-settings-empty">
                {t("modelSwitchEmpty")}
              </span>
            )}
          </div>
        </div>

        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsThinkingTitle")}</strong>
            <p>{t("modelSettingsThinkingDescription")}</p>
          </div>
          <div className="font-size-selector model-settings-chip-group">
            {thinkingOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`font-size-option ${thinkingMode === opt.value ? "active" : ""}`}
                onClick={() => setThinkingMode(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsEffortTitle")}</strong>
            <p>{t("modelSettingsEffortDescription")}</p>
          </div>
          <div className="font-size-selector model-settings-chip-group">
            {effortOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`font-size-option ${
                  effectiveEffortLevel === opt.value ? "active" : ""
                }`}
                onClick={() => setEffortLevel(opt.value)}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
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
