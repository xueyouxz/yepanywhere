import { useCallback, useId, useMemo } from "react";
import {
  FilterDropdown,
  type FilterOption,
} from "../../components/FilterDropdown";
import { SpeechSmartTurnControls } from "../../components/SpeechSmartTurnControls";
import { useModelSettings } from "../../hooks/useModelSettings";
import { useBrowserXaiSttApiKey } from "../../hooks/useBrowserXaiSttApiKey";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useSpeechCaptureSettings } from "../../hooks/useSpeechCaptureSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  canSpeechMethodStream,
  getSpeechMethodCapabilities,
  getSpeechMethods,
  isServerRoutedSpeechMethod,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../../lib/speechProviders/methods";
import {
  getParakeetSpeechPresetValue,
  PARAKEET_SPEECH_MODEL_PRESETS,
} from "../../lib/speechProviders/parakeetModels";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

export function SpeechSettings() {
  const { t } = useI18n();
  const {
    voiceInputEnabled,
    setVoiceInputEnabled,
    speechMethod,
    hasStoredSpeechMethod,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
    parakeetSpeechModel,
    setParakeetSpeechModel,
  } = useModelSettings();
  const parakeetModelPresetId = useId();
  const parakeetModelInputId = useId();
  const { keepMicWarm, setKeepMicWarm } = useSpeechCaptureSettings();
  const {
    browserXaiSttApiKey,
    hasBrowserXaiSttApiKey,
    setBrowserXaiSttApiKey,
  } = useBrowserXaiSttApiKey();
  const relayTransport = useRemoteBasePath() !== "";
  const { version: versionInfo, loading: versionLoading } = useVersion();
  const undoState = useMemo(
    () => ({
      voiceInputEnabled,
      speechMethod,
      speechSmartTurnSettings,
      keepMicWarm,
      parakeetSpeechModel,
    }),
    [
      voiceInputEnabled,
      speechMethod,
      speechSmartTurnSettings,
      keepMicWarm,
      parakeetSpeechModel,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      setVoiceInputEnabled(snapshot.voiceInputEnabled);
      setSpeechMethod(snapshot.speechMethod);
      setSpeechSmartTurnSettings(snapshot.speechSmartTurnSettings);
      setKeepMicWarm(snapshot.keepMicWarm);
      setParakeetSpeechModel(snapshot.parakeetSpeechModel);
    },
    [
      setVoiceInputEnabled,
      setSpeechMethod,
      setSpeechSmartTurnSettings,
      setKeepMicWarm,
      setParakeetSpeechModel,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);
  const serverVoiceEnabled =
    versionInfo?.capabilities?.includes("voiceInput") ?? true;
  const serverBackends = versionInfo?.voiceBackends ?? [];
  const backendOptions: FilterOption<SpeechMethodId>[] = getSpeechMethods(
    serverBackends,
    undefined,
    { directXaiAvailable: hasBrowserXaiSttApiKey },
  ).map((method) => ({
    value: method.id,
    label: method.label,
    description: method.description,
  }));
  const selectedBackend = resolveSpeechMethod(
    speechMethod,
    serverBackends,
    hasStoredSpeechMethod,
    { directXaiAvailable: hasBrowserXaiSttApiKey },
  );
  const selectedBackendLabel =
    backendOptions.find((option) => option.value === selectedBackend)?.label ??
    selectedBackend;
  const selectedBackendCapabilities = getSpeechMethodCapabilities(
    selectedBackend,
    versionInfo?.voiceBackendCapabilities,
  );
  const selectedBackendServerRouted =
    isServerRoutedSpeechMethod(selectedBackend);
  const showParakeetModelControls = selectedBackend === "ya-parakeet";
  const selectedParakeetPreset =
    getParakeetSpeechPresetValue(parakeetSpeechModel);
  const selectedBackendCanStream = canSpeechMethodStream({
    methodId: selectedBackend,
    serverCapabilities: versionInfo?.voiceBackendCapabilities,
    relayTransport,
    relayedServerSpeechAvailable: !selectedBackendServerRouted,
  });
  const supportsSelectedSmartTurn =
    selectedBackendCanStream &&
    selectedBackendCapabilities.smartTurn === true;
  const smartTurnUnavailableHint =
    relayTransport && selectedBackend !== "browser-native"
      ? t("speechSettingsStreamingRelayUnavailable")
      : t("speechSettingsSmartTurnUnavailable", {
          backend: selectedBackendLabel,
        });

  return (
    <section className="settings-section">
      <h2>{t("speechSettingsTitle")}</h2>
      <p className="settings-section-description">
        {t("speechSettingsDescription")}
      </p>

      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("speechSettingsVoiceInputTitle")}</strong>
            <p>{t("speechSettingsVoiceInputDescription")}</p>
            {!serverVoiceEnabled && (
              <p className="settings-hint">
                {t("speechSettingsServerDisabled")}
              </p>
            )}
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={voiceInputEnabled && serverVoiceEnabled}
              disabled={versionLoading || !serverVoiceEnabled}
              onChange={(event) => setVoiceInputEnabled(event.target.checked)}
              aria-label={t("speechSettingsVoiceInputTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("speechSettingsBackendTitle")}</strong>
            <p>{t("speechSettingsBackendDescription")}</p>
          </div>
          <div className="speech-backend-settings-field">
            <FilterDropdown
              label={t("speechSettingsBackendTitle")}
              options={backendOptions}
              selected={[selectedBackend]}
              onChange={(selected) => {
                const nextBackend = selected[0];
                if (nextBackend) setSpeechMethod(nextBackend);
              }}
              multiSelect={false}
              placeholder={t("speechSettingsBackendPlaceholder")}
            />
            {serverBackends.length === 0 && (
              <p className="settings-hint">
                {t("speechSettingsNoServerBackends")}
              </p>
            )}
          </div>
        </div>

        {relayTransport && selectedBackend === "ya-grok" && (
          <p className="settings-hint">
            {t("speechSettingsStreamingRelayUnavailable")}
          </p>
        )}

        {showParakeetModelControls && (
          <div className="settings-item model-settings-item">
            <div className="settings-item-info">
              <strong>{t("speechSettingsParakeetModelTitle")}</strong>
              <p>{t("speechSettingsParakeetModelDescription")}</p>
            </div>
            <div className="speech-backend-settings-field">
              <select
                id={parakeetModelPresetId}
                className="settings-select speech-parakeet-model-select"
                value={selectedParakeetPreset}
                onChange={(event) => {
                  const preset = event.currentTarget.value;
                  if (preset) setParakeetSpeechModel(preset);
                }}
                aria-label={t("speechSettingsParakeetModelPresetLabel")}
              >
                <option value="">
                  {t("speechSettingsParakeetCustomModel")}
                </option>
                {PARAKEET_SPEECH_MODEL_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <input
                id={parakeetModelInputId}
                className="settings-input"
                value={parakeetSpeechModel}
                placeholder={t("speechSettingsParakeetModelPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setParakeetSpeechModel(event.currentTarget.value)
                }
                aria-label={t("speechSettingsParakeetModelInputLabel")}
              />
              <p className="settings-hint">
                {t("speechSettingsParakeetModelHint")}
              </p>
            </div>
          </div>
        )}

        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("speechSettingsXaiKeyTitle")}</strong>
            <p>{t("speechSettingsXaiKeyDescription")}</p>
          </div>
          <input
            type="password"
            className="settings-input"
            value={browserXaiSttApiKey}
            placeholder={t("speechSettingsXaiKeyPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setBrowserXaiSttApiKey(event.currentTarget.value);
            }}
            aria-label={t("speechSettingsXaiKeyTitle")}
          />
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("speechSettingsKeepMicWarmTitle")}</strong>
            <p>{t("speechSettingsKeepMicWarmDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={keepMicWarm}
              onChange={(event) => setKeepMicWarm(event.target.checked)}
              aria-label={t("speechSettingsKeepMicWarmTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("speechSettingsSmartTurnTitle")}</strong>
            <p>
              {t("speechSettingsSmartTurnDescription", {
                backend: selectedBackendLabel,
              })}
            </p>
          </div>
          {supportsSelectedSmartTurn ? (
            <SpeechSmartTurnControls
              settings={speechSmartTurnSettings}
              onChange={setSpeechSmartTurnSettings}
            />
          ) : (
            <p className="settings-hint">{smartTurnUnavailableHint}</p>
          )}
        </div>
      </div>
    </section>
  );
}
