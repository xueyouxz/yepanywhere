import type {
  ClientDefaults,
  EffortLevel,
  ModelOption,
  ShowThinking,
  ThinkingMode,
  ThinkingOption,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import {
  CLIENT_STORAGE_DEFAULT,
  type DefaultedValue,
  isClientStorageDefault,
  resolveDefaultedValue,
} from "../lib/defaultedStorage";
import { EFFORT_LEVEL_OPTIONS, isEffortLevel } from "../lib/effortLevels";
import {
  DEFAULT_SPEECH_METHOD,
  isSpeechMethodId,
  type SpeechMethodId,
} from "../lib/speechProviders/methods";
import {
  DEFAULT_GROK_SPEECH_AUDIO_SETTINGS,
  DEFAULT_SPEECH_SMART_TURN_SETTINGS,
  type GrokSpeechAudioSettings,
  type SpeechSmartTurnSettings,
} from "../lib/speechProviders/SpeechProvider";
import {
  getServerScoped,
  LEGACY_KEYS,
  setServerScoped,
} from "../lib/storageKeys";
import { useVersion } from "./useVersion";

/**
 * Re-export shared types for convenience.
 */
export type { EffortLevel, ModelOption, ThinkingMode, ThinkingOption };

export const MODEL_OPTIONS: { value: ModelOption; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "best", label: "Best" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet 1M" },
  { value: "opus", label: "Opus" },
  { value: "opus[1m]", label: "Opus 1M" },
  { value: "haiku", label: "Haiku" },
  { value: "opusplan", label: "Opus Plan" },
];

export { EFFORT_LEVEL_OPTIONS };

function loadModel(): ModelOption {
  const stored = getServerScoped("model", LEGACY_KEYS.model);
  if (stored && MODEL_OPTIONS.some((option) => option.value === stored)) {
    return stored as ModelOption;
  }
  return "default";
}

function saveModel(model: ModelOption) {
  setServerScoped("model", model, LEGACY_KEYS.model);
}

/** Migration map from old thinking levels to effort levels */
const LEGACY_LEVEL_MAP: Record<string, EffortLevel> = {
  light: "low",
  medium: "medium",
  thorough: "max",
};

function loadEffortLevel(): EffortLevel {
  const stored = getServerScoped("thinkingLevel", LEGACY_KEYS.thinkingLevel);
  if (stored) {
    // Check for new effort level values
    if (isEffortLevel(stored)) {
      return stored;
    }
    // Migrate old thinking level values
    const migrated = LEGACY_LEVEL_MAP[stored];
    if (migrated) {
      saveEffortLevel(migrated);
      return migrated;
    }
  }
  return "high"; // SDK default
}

function saveEffortLevel(level: EffortLevel) {
  setServerScoped("thinkingLevel", level, LEGACY_KEYS.thinkingLevel);
}

const THINKING_MODES: ThinkingMode[] = ["off", "auto", "on"];

function loadThinkingMode(): ThinkingMode {
  // Try new key first
  const stored = getServerScoped("thinkingMode", LEGACY_KEYS.thinkingMode);
  if (stored && THINKING_MODES.includes(stored as ThinkingMode)) {
    return stored as ThinkingMode;
  }
  // Migrate from old boolean thinkingEnabled
  const legacy = getServerScoped(
    "thinkingEnabled",
    LEGACY_KEYS.thinkingEnabled,
  );
  if (legacy === "true") {
    // Old "on" was adaptive, so migrate to "auto"
    saveThinkingMode("auto");
    return "auto";
  }
  return "off";
}

function saveThinkingMode(mode: ThinkingMode) {
  setServerScoped("thinkingMode", mode, LEGACY_KEYS.thinkingMode);
}

const SHOW_THINKING_VALUES: ShowThinking[] = ["default", "on", "off"];

/**
 * "Show thinking" preference (default/on/off). Provider-agnostic: drives the
 * client render gate (default show/hide of thought blocks) and the request
 * side (summaries) where supported. Defaults to "default" (provider-native).
 */
function loadShowThinking(): ShowThinking {
  const stored = getServerScoped("showThinking");
  return stored && SHOW_THINKING_VALUES.includes(stored as ShowThinking)
    ? (stored as ShowThinking)
    : "default";
}

function saveShowThinking(value: ShowThinking) {
  setServerScoped("showThinking", value);
}

function loadVoiceInputEnabled(): boolean {
  return resolveDefaultedValue(
    loadVoiceInputEnabledSetting(),
    getBuiltInSpeechClientDefaults().voiceInputEnabled,
  );
}

function loadVoiceInputEnabledSetting(): DefaultedValue<boolean> {
  const stored = getServerScoped(
    "voiceInputEnabled",
    LEGACY_KEYS.voiceInputEnabled,
  );
  if (stored === "true") return true;
  if (stored === "false") return false;
  return CLIENT_STORAGE_DEFAULT;
}

function saveVoiceInputEnabled(enabled: boolean) {
  setServerScoped(
    "voiceInputEnabled",
    enabled ? "true" : "false",
    LEGACY_KEYS.voiceInputEnabled,
  );
}

function loadStoredSpeechMethod(): SpeechMethodId | null {
  const stored = loadSpeechMethodSetting();
  return isClientStorageDefault(stored) ? null : stored;
}

function loadSpeechMethodSetting(): DefaultedValue<SpeechMethodId> {
  const stored = getServerScoped("speechMethod", LEGACY_KEYS.speechMethod);
  if (stored && isSpeechMethodId(stored)) {
    return stored;
  }
  return CLIENT_STORAGE_DEFAULT;
}

function loadSpeechMethod(): SpeechMethodId {
  return resolveDefaultedValue(
    loadSpeechMethodSetting(),
    getBuiltInSpeechClientDefaults().speechMethod,
  );
}

function saveSpeechMethod(method: SpeechMethodId) {
  setServerScoped("speechMethod", method, LEGACY_KEYS.speechMethod);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanSpeechSmartTurnSettings(
  settings: Partial<SpeechSmartTurnSettings>,
): SpeechSmartTurnSettings {
  return {
    enabled: settings.enabled === true,
    threshold:
      typeof settings.threshold === "number" &&
      Number.isFinite(settings.threshold)
        ? clampNumber(settings.threshold, 0, 1)
        : DEFAULT_SPEECH_SMART_TURN_SETTINGS.threshold,
    timeoutMs:
      typeof settings.timeoutMs === "number" &&
      Number.isFinite(settings.timeoutMs)
        ? Math.round(clampNumber(settings.timeoutMs, 0, 5000))
        : DEFAULT_SPEECH_SMART_TURN_SETTINGS.timeoutMs,
  };
}

function loadSpeechSmartTurnSettings(): SpeechSmartTurnSettings {
  return resolveDefaultedValue(
    loadSpeechSmartTurnSettingsSetting(),
    getBuiltInSpeechClientDefaults().speechSmartTurnSettings,
  );
}

function loadSpeechSmartTurnSettingsSetting(): DefaultedValue<SpeechSmartTurnSettings> {
  const stored = getServerScoped(
    "speechSmartTurn",
    LEGACY_KEYS.speechSmartTurn,
  );
  if (!stored || stored === CLIENT_STORAGE_DEFAULT)
    return CLIENT_STORAGE_DEFAULT;
  try {
    return cleanSpeechSmartTurnSettings(
      JSON.parse(stored) as unknown as Partial<SpeechSmartTurnSettings>,
    );
  } catch {
    return CLIENT_STORAGE_DEFAULT;
  }
}

function saveSpeechSmartTurnSettings(settings: SpeechSmartTurnSettings) {
  setServerScoped(
    "speechSmartTurn",
    JSON.stringify(cleanSpeechSmartTurnSettings(settings)),
    LEGACY_KEYS.speechSmartTurn,
  );
}

function cleanGrokSpeechAudioSettings(
  settings: Partial<GrokSpeechAudioSettings>,
): GrokSpeechAudioSettings {
  return {
    uplinkMode:
      settings.uplinkMode === "browser-compressed"
        ? "browser-compressed"
        : DEFAULT_GROK_SPEECH_AUDIO_SETTINGS.uplinkMode,
  };
}

function loadGrokSpeechAudioSettings(): GrokSpeechAudioSettings {
  return resolveDefaultedValue(
    loadGrokSpeechAudioSettingsSetting(),
    getBuiltInSpeechClientDefaults().grokSpeechAudioSettings,
  );
}

function loadGrokSpeechAudioSettingsSetting(): DefaultedValue<GrokSpeechAudioSettings> {
  const stored = getServerScoped(
    "grokSpeechAudio",
    LEGACY_KEYS.grokSpeechAudio,
  );
  if (!stored || stored === CLIENT_STORAGE_DEFAULT)
    return CLIENT_STORAGE_DEFAULT;
  try {
    return cleanGrokSpeechAudioSettings(
      JSON.parse(stored) as unknown as Partial<GrokSpeechAudioSettings>,
    );
  } catch {
    return CLIENT_STORAGE_DEFAULT;
  }
}

function saveGrokSpeechAudioSettings(settings: GrokSpeechAudioSettings) {
  setServerScoped(
    "grokSpeechAudio",
    JSON.stringify(cleanGrokSpeechAudioSettings(settings)),
    LEGACY_KEYS.grokSpeechAudio,
  );
}

function getBuiltInSpeechClientDefaults(): Required<
  NonNullable<ClientDefaults["speech"]>
> {
  return {
    voiceInputEnabled: true,
    speechMethod: DEFAULT_SPEECH_METHOD,
    speechSmartTurnSettings: { ...DEFAULT_SPEECH_SMART_TURN_SETTINGS },
    grokSpeechAudioSettings: { ...DEFAULT_GROK_SPEECH_AUDIO_SETTINGS },
  };
}

function getSpeechClientDefaults(
  clientDefaults: ClientDefaults | undefined,
): Required<NonNullable<ClientDefaults["speech"]>> {
  const builtInDefaults = getBuiltInSpeechClientDefaults();
  return {
    ...builtInDefaults,
    ...clientDefaults?.speech,
    speechSmartTurnSettings: {
      ...builtInDefaults.speechSmartTurnSettings,
      ...clientDefaults?.speech?.speechSmartTurnSettings,
    },
    grokSpeechAudioSettings: {
      ...builtInDefaults.grokSpeechAudioSettings,
      ...clientDefaults?.speech?.grokSpeechAudioSettings,
    },
  };
}

function saveSpeechClientDefaults(
  speech: NonNullable<ClientDefaults["speech"]>,
): void {
  void api.updateServerSettings({ clientDefaults: { speech } }).catch((err) => {
    console.warn(
      "[useModelSettings] Failed to save server client defaults:",
      err instanceof Error ? err.message : String(err),
    );
  });
}

/**
 * Hook to manage model and thinking preferences.
 */
export function useModelSettings() {
  const { version } = useVersion();
  const speechDefaults = useMemo(
    () => getSpeechClientDefaults(version?.clientDefaults),
    [version?.clientDefaults],
  );
  const hasServerSpeechMethodDefault = Boolean(
    version?.clientDefaults?.speech?.speechMethod,
  );
  const [model, setModelState] = useState<ModelOption>(loadModel);
  const [effortLevel, setEffortLevelState] =
    useState<EffortLevel>(loadEffortLevel);
  const [thinkingMode, setThinkingModeState] =
    useState<ThinkingMode>(loadThinkingMode);
  const [showThinking, setShowThinkingState] =
    useState<ShowThinking>(loadShowThinking);
  const [voiceInputEnabled, setVoiceInputEnabledState] = useState<boolean>(() =>
    resolveDefaultedValue(
      loadVoiceInputEnabledSetting(),
      speechDefaults.voiceInputEnabled,
    ),
  );
  const [speechMethod, setSpeechMethodState] = useState<SpeechMethodId>(() =>
    resolveDefaultedValue(
      loadSpeechMethodSetting(),
      speechDefaults.speechMethod,
    ),
  );
  const [hasStoredSpeechMethod, setHasStoredSpeechMethod] = useState<boolean>(
    () => !isClientStorageDefault(loadSpeechMethodSetting()),
  );
  const [speechSmartTurnSettings, setSpeechSmartTurnSettingsState] =
    useState<SpeechSmartTurnSettings>(() =>
      resolveDefaultedValue(
        loadSpeechSmartTurnSettingsSetting(),
        speechDefaults.speechSmartTurnSettings,
      ),
    );
  const [grokSpeechAudioSettings, setGrokSpeechAudioSettingsState] =
    useState<GrokSpeechAudioSettings>(() =>
      resolveDefaultedValue(
        loadGrokSpeechAudioSettingsSetting(),
        speechDefaults.grokSpeechAudioSettings,
      ),
    );

  useEffect(() => {
    if (isClientStorageDefault(loadVoiceInputEnabledSetting())) {
      setVoiceInputEnabledState(speechDefaults.voiceInputEnabled);
    }
    if (isClientStorageDefault(loadSpeechMethodSetting())) {
      setSpeechMethodState(speechDefaults.speechMethod);
      setHasStoredSpeechMethod(hasServerSpeechMethodDefault);
    }
    if (isClientStorageDefault(loadSpeechSmartTurnSettingsSetting())) {
      setSpeechSmartTurnSettingsState(speechDefaults.speechSmartTurnSettings);
    }
    if (isClientStorageDefault(loadGrokSpeechAudioSettingsSetting())) {
      setGrokSpeechAudioSettingsState(speechDefaults.grokSpeechAudioSettings);
    }
  }, [
    speechDefaults.voiceInputEnabled,
    speechDefaults.speechMethod,
    speechDefaults.speechSmartTurnSettings,
    speechDefaults.grokSpeechAudioSettings,
    hasServerSpeechMethodDefault,
  ]);

  const setModel = useCallback((m: ModelOption) => {
    setModelState(m);
    saveModel(m);
  }, []);

  const setEffortLevel = useCallback((level: EffortLevel) => {
    setEffortLevelState(level);
    saveEffortLevel(level);
  }, []);

  const setThinkingMode = useCallback((mode: ThinkingMode) => {
    setThinkingModeState(mode);
    saveThinkingMode(mode);
  }, []);

  const setShowThinking = useCallback((value: ShowThinking) => {
    setShowThinkingState(value);
    saveShowThinking(value);
  }, []);

  const cycleThinkingMode = useCallback(() => {
    const idx = THINKING_MODES.indexOf(thinkingMode);
    const next = THINKING_MODES[(idx + 1) % THINKING_MODES.length] ?? "off";
    setThinkingModeState(next);
    saveThinkingMode(next);
  }, [thinkingMode]);

  const setVoiceInputEnabled = useCallback((enabled: boolean) => {
    setVoiceInputEnabledState(enabled);
    saveVoiceInputEnabled(enabled);
    saveSpeechClientDefaults({ voiceInputEnabled: enabled });
  }, []);

  const toggleVoiceInput = useCallback(() => {
    const newEnabled = !voiceInputEnabled;
    setVoiceInputEnabledState(newEnabled);
    saveVoiceInputEnabled(newEnabled);
    saveSpeechClientDefaults({ voiceInputEnabled: newEnabled });
  }, [voiceInputEnabled]);

  const setSpeechMethod = useCallback((method: SpeechMethodId) => {
    setSpeechMethodState(method);
    setHasStoredSpeechMethod(true);
    saveSpeechMethod(method);
    saveSpeechClientDefaults({ speechMethod: method });
  }, []);

  const setSpeechSmartTurnSettings = useCallback(
    (settings: SpeechSmartTurnSettings) => {
      const clean = cleanSpeechSmartTurnSettings(settings);
      setSpeechSmartTurnSettingsState(clean);
      saveSpeechSmartTurnSettings(clean);
      saveSpeechClientDefaults({ speechSmartTurnSettings: clean });
    },
    [],
  );

  const setGrokSpeechAudioSettings = useCallback(
    (settings: GrokSpeechAudioSettings) => {
      const clean = cleanGrokSpeechAudioSettings(settings);
      setGrokSpeechAudioSettingsState(clean);
      saveGrokSpeechAudioSettings(clean);
      saveSpeechClientDefaults({ grokSpeechAudioSettings: clean });
    },
    [],
  );

  return {
    model,
    setModel,
    effortLevel,
    setEffortLevel,
    // Keep thinkingLevel as alias for backward compat with components
    thinkingLevel: effortLevel,
    setThinkingLevel: setEffortLevel,
    thinkingMode,
    setThinkingMode,
    cycleThinkingMode,
    showThinking,
    setShowThinking,
    voiceInputEnabled,
    setVoiceInputEnabled,
    toggleVoiceInput,
    speechMethod,
    hasStoredSpeechMethod,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
    grokSpeechAudioSettings,
    setGrokSpeechAudioSettings,
  };
}

/**
 * Get model setting without React state (for non-component code).
 */
export function getModelSetting(): ModelOption {
  return loadModel();
}

/**
 * Get thinking setting as ThinkingOption (for API compatibility).
 * - "off" when thinking is disabled
 * - "auto" for adaptive (model decides when to think)
 * - "on:level" for forced-on thinking at that effort level
 */
export function getThinkingSetting(
  effortOverride?: EffortLevel,
): ThinkingOption {
  const mode = loadThinkingMode();
  if (mode === "off") return "off";
  if (mode === "auto") return "auto";
  return `on:${effortOverride ?? loadEffortLevel()}`;
}

/**
 * Get thinking mode without React state.
 */
export function getThinkingMode(): ThinkingMode {
  return loadThinkingMode();
}

/**
 * Get the "Show thinking" preference (default/on/off) without React state.
 */
export function getShowThinkingSetting(): ShowThinking {
  return loadShowThinking();
}

/**
 * Get voice input enabled state without React state.
 */
export function getVoiceInputEnabled(): boolean {
  return loadVoiceInputEnabled();
}

/**
 * Get the persisted speech method without React state.
 */
export function getSpeechMethod(): SpeechMethodId {
  return loadSpeechMethod();
}

export function hasStoredSpeechMethodSetting(): boolean {
  return loadStoredSpeechMethod() !== null;
}

export function getSpeechSmartTurnSettings(): SpeechSmartTurnSettings {
  return loadSpeechSmartTurnSettings();
}

export function getGrokSpeechAudioSettings(): GrokSpeechAudioSettings {
  return loadGrokSpeechAudioSettings();
}
