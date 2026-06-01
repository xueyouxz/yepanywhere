import {
  FilterDropdown,
  type FilterOption,
} from "../../components/FilterDropdown";
import { SpeechGrokAudioControls } from "../../components/SpeechGrokAudioControls";
import { SpeechSmartTurnControls } from "../../components/SpeechSmartTurnControls";
import { useModelSettings } from "../../hooks/useModelSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  getSpeechMethods,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../../lib/speechProviders/methods";

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
    grokSpeechAudioSettings,
    setGrokSpeechAudioSettings,
  } = useModelSettings();
  const { version: versionInfo, loading: versionLoading } = useVersion();
  const serverVoiceEnabled =
    versionInfo?.capabilities?.includes("voiceInput") ?? true;
  const serverBackends = versionInfo?.voiceBackends ?? [];
  const backendOptions: FilterOption<SpeechMethodId>[] = getSpeechMethods(
    serverBackends,
  ).map((method) => ({
    value: method.id,
    label: method.label,
    description: method.description,
  }));
  const selectedBackend = resolveSpeechMethod(
    speechMethod,
    serverBackends,
    hasStoredSpeechMethod,
  );
  const selectedBackendLabel =
    backendOptions.find((option) => option.value === selectedBackend)?.label ??
    selectedBackend;
  const supportsSelectedSmartTurn =
    selectedBackend !== "browser-native" &&
    (selectedBackend !== "ya-grok" ||
      grokSpeechAudioSettings.uplinkMode === "pcm16") &&
    versionInfo?.voiceBackendCapabilities?.[selectedBackend]?.smartTurn === true;
  const showGrokAudioSettings = selectedBackend === "ya-grok";
  const smartTurnRequiresPcm =
    selectedBackend === "ya-grok" &&
    grokSpeechAudioSettings.uplinkMode !== "pcm16" &&
    versionInfo?.voiceBackendCapabilities?.[selectedBackend]?.smartTurn === true;

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

        {showGrokAudioSettings && (
          <div className="settings-item model-settings-item">
            <div className="settings-item-info">
              <strong>{t("speechSettingsGrokAudioTitle")}</strong>
              <p>{t("speechSettingsGrokAudioDescription")}</p>
            </div>
            <SpeechGrokAudioControls
              settings={grokSpeechAudioSettings}
              onChange={setGrokSpeechAudioSettings}
            />
          </div>
        )}

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
            <p className="settings-hint">
              {smartTurnRequiresPcm
                ? t("speechSettingsSmartTurnRequiresPcm")
                : t("speechSettingsSmartTurnUnavailable", {
                    backend: selectedBackendLabel,
                  })}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
