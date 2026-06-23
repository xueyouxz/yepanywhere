import { useCallback, useSyncExternalStore } from "react";
import { UI_KEYS } from "../lib/storageKeys";

const DEFAULT_COLORFUL_SETTINGS_ICONS = true;

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

function loadColorfulSettingsIcons(): boolean {
  const stored = getStorage()?.getItem(UI_KEYS.colorfulSettingsIcons);
  if (stored === null || stored === undefined) {
    return DEFAULT_COLORFUL_SETTINGS_ICONS;
  }
  return stored === "true";
}

function saveColorfulSettingsIcons(enabled: boolean): void {
  const storage = getStorage();
  if (!storage || typeof storage.setItem !== "function") return;
  storage.setItem(UI_KEYS.colorfulSettingsIcons, String(enabled));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return loadColorfulSettingsIcons();
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function setColorfulSettingsIconsPreference(enabled: boolean): void {
  saveColorfulSettingsIcons(enabled);
  emitChange();
}

export function useColorfulSettingsIcons() {
  const colorfulSettingsIcons = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_COLORFUL_SETTINGS_ICONS,
  );

  const setColorfulSettingsIcons = useCallback(
    setColorfulSettingsIconsPreference,
    [],
  );

  return {
    colorfulSettingsIcons,
    setColorfulSettingsIcons,
  };
}

export function getColorfulSettingsIcons(): boolean {
  return loadColorfulSettingsIcons();
}
