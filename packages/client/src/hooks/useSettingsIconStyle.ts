import { useCallback, useSyncExternalStore } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export const SETTINGS_ICON_STYLES = ["flat", "flat-white", "emoji"] as const;
export type SettingsIconStyle = (typeof SETTINGS_ICON_STYLES)[number];

const DEFAULT_SETTINGS_ICON_STYLE: SettingsIconStyle = "flat";

const listeners = new Set<() => void>();

function getStorage(): Storage | null {
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    return null;
  }
  return globalThis.localStorage;
}

function isSettingsIconStyle(value: string | null): value is SettingsIconStyle {
  return value === "flat" || value === "flat-white" || value === "emoji";
}

function loadSettingsIconStyle(): SettingsIconStyle {
  const storage = getStorage();
  const stored = storage?.getItem(UI_KEYS.settingsIconStyle) ?? null;
  if (isSettingsIconStyle(stored)) {
    return stored;
  }

  const legacyFlat = storage?.getItem(UI_KEYS.flatSettingsIcons);
  if (legacyFlat === "true") return "flat";
  if (legacyFlat === "false") return "emoji";
  return DEFAULT_SETTINGS_ICON_STYLE;
}

function saveSettingsIconStyle(style: SettingsIconStyle): void {
  const storage = getStorage();
  if (!storage || typeof storage.setItem !== "function") return;
  storage.setItem(UI_KEYS.settingsIconStyle, style);
  storage.removeItem?.(UI_KEYS.flatSettingsIcons);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return loadSettingsIconStyle();
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function setSettingsIconStylePreference(style: SettingsIconStyle): void {
  saveSettingsIconStyle(style);
  emitChange();
}

export function useSettingsIconStyle() {
  const settingsIconStyle = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_SETTINGS_ICON_STYLE,
  );

  const setSettingsIconStyle = useCallback(setSettingsIconStylePreference, []);

  return {
    settingsIconStyle,
    setSettingsIconStyle,
  };
}

export function getSettingsIconStyle(): SettingsIconStyle {
  return loadSettingsIconStyle();
}
