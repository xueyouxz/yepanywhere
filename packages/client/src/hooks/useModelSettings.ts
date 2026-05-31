import type {
  EffortLevel,
  ModelOption,
  ThinkingMode,
  ThinkingOption,
} from "@yep-anywhere/shared";
import { useCallback, useState } from "react";
import {
  DEFAULT_SPEECH_METHOD,
  type SpeechMethodId,
  isSpeechMethodId,
} from "../lib/speechProviders/methods";
import {
  DEFAULT_SPEECH_SMART_TURN_SETTINGS,
  type SpeechSmartTurnSettings,
} from "../lib/speechProviders/SpeechProvider";
import {
  LEGACY_KEYS,
  getServerScoped,
  setServerScoped,
} from "../lib/storageKeys";

/**
 * Re-export shared types for convenience.
 */
export type { EffortLevel, ModelOption, ThinkingMode, ThinkingOption };

export const MODEL_OPTIONS: { value: ModelOption; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "best", label: "Best" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet 1M" },
  { value: "opus", label: "Opus 4.8" },
  { value: "opus[1m]", label: "Opus 4.8 1M" },
  { value: "haiku", label: "Haiku" },
  { value: "opusplan", label: "Opus 4.8 Plan" },
];

export const EFFORT_LEVEL_OPTIONS: {
  value: EffortLevel;
  label: string;
  description: string;
}[] = [
  { value: "low", label: "Low", description: "Fastest responses" },
  { value: "medium", label: "Medium", description: "Moderate thinking" },
  { value: "high", label: "High", description: "Deep reasoning" },
  { value: "max", label: "Max", description: "Maximum effort" },
];

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
    if (["low", "medium", "high", "max"].includes(stored)) {
      return stored as EffortLevel;
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

function loadVoiceInputEnabled(): boolean {
  const stored = getServerScoped(
    "voiceInputEnabled",
    LEGACY_KEYS.voiceInputEnabled,
  );
  // Default to true (enabled) if not set
  return stored !== "false";
}

function saveVoiceInputEnabled(enabled: boolean) {
  setServerScoped(
    "voiceInputEnabled",
    enabled ? "true" : "false",
    LEGACY_KEYS.voiceInputEnabled,
  );
}

function loadStoredSpeechMethod(): SpeechMethodId | null {
  const stored = getServerScoped("speechMethod", LEGACY_KEYS.speechMethod);
  if (stored && isSpeechMethodId(stored)) {
    return stored;
  }
  return null;
}

function loadSpeechMethod(): SpeechMethodId {
  return loadStoredSpeechMethod() ?? DEFAULT_SPEECH_METHOD;
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
      typeof settings.threshold === "number" && Number.isFinite(settings.threshold)
        ? clampNumber(settings.threshold, 0, 1)
        : DEFAULT_SPEECH_SMART_TURN_SETTINGS.threshold,
    timeoutMs:
      typeof settings.timeoutMs === "number" && Number.isFinite(settings.timeoutMs)
        ? Math.round(clampNumber(settings.timeoutMs, 0, 5000))
        : DEFAULT_SPEECH_SMART_TURN_SETTINGS.timeoutMs,
  };
}

function loadSpeechSmartTurnSettings(): SpeechSmartTurnSettings {
  const stored = getServerScoped(
    "speechSmartTurn",
    LEGACY_KEYS.speechSmartTurn,
  );
  if (!stored) return { ...DEFAULT_SPEECH_SMART_TURN_SETTINGS };
  try {
    return cleanSpeechSmartTurnSettings(JSON.parse(stored) as unknown as Partial<SpeechSmartTurnSettings>);
  } catch {
    return { ...DEFAULT_SPEECH_SMART_TURN_SETTINGS };
  }
}

function saveSpeechSmartTurnSettings(settings: SpeechSmartTurnSettings) {
  setServerScoped(
    "speechSmartTurn",
    JSON.stringify(cleanSpeechSmartTurnSettings(settings)),
    LEGACY_KEYS.speechSmartTurn,
  );
}

/**
 * Hook to manage model and thinking preferences.
 */
export function useModelSettings() {
  const [model, setModelState] = useState<ModelOption>(loadModel);
  const [effortLevel, setEffortLevelState] =
    useState<EffortLevel>(loadEffortLevel);
  const [thinkingMode, setThinkingModeState] =
    useState<ThinkingMode>(loadThinkingMode);
  const [voiceInputEnabled, setVoiceInputEnabledState] = useState<boolean>(
    loadVoiceInputEnabled,
  );
  const [speechMethod, setSpeechMethodState] =
    useState<SpeechMethodId>(loadSpeechMethod);
  const [hasStoredSpeechMethod, setHasStoredSpeechMethod] = useState<boolean>(
    () => loadStoredSpeechMethod() !== null,
  );
  const [speechSmartTurnSettings, setSpeechSmartTurnSettingsState] =
    useState<SpeechSmartTurnSettings>(loadSpeechSmartTurnSettings);

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

  const cycleThinkingMode = useCallback(() => {
    const idx = THINKING_MODES.indexOf(thinkingMode);
    const next = THINKING_MODES[(idx + 1) % THINKING_MODES.length] ?? "off";
    setThinkingModeState(next);
    saveThinkingMode(next);
  }, [thinkingMode]);

  const setVoiceInputEnabled = useCallback((enabled: boolean) => {
    setVoiceInputEnabledState(enabled);
    saveVoiceInputEnabled(enabled);
  }, []);

  const toggleVoiceInput = useCallback(() => {
    const newEnabled = !voiceInputEnabled;
    setVoiceInputEnabledState(newEnabled);
    saveVoiceInputEnabled(newEnabled);
  }, [voiceInputEnabled]);

  const setSpeechMethod = useCallback((method: SpeechMethodId) => {
    setSpeechMethodState(method);
    setHasStoredSpeechMethod(true);
    saveSpeechMethod(method);
  }, []);

  const setSpeechSmartTurnSettings = useCallback(
    (settings: SpeechSmartTurnSettings) => {
      const clean = cleanSpeechSmartTurnSettings(settings);
      setSpeechSmartTurnSettingsState(clean);
      saveSpeechSmartTurnSettings(clean);
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
    voiceInputEnabled,
    setVoiceInputEnabled,
    toggleVoiceInput,
    speechMethod,
    hasStoredSpeechMethod,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
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
export function getThinkingSetting(): ThinkingOption {
  const mode = loadThinkingMode();
  if (mode === "off") return "off";
  if (mode === "auto") return "auto";
  return `on:${loadEffortLevel()}`;
}

/**
 * Get thinking mode without React state.
 */
export function getThinkingMode(): ThinkingMode {
  return loadThinkingMode();
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
