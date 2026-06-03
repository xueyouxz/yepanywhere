import { useCallback, useSyncExternalStore } from "react";
import { UI_KEYS } from "../lib/storageKeys";

const DEFAULT_INLINE_IMAGES_ENABLED = false;

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

function loadInlineImagesEnabled(): boolean {
  const stored = getStorage()?.getItem(UI_KEYS.inlineImagesEnabled);
  if (stored === null || stored === undefined) {
    return DEFAULT_INLINE_IMAGES_ENABLED;
  }
  return stored === "true";
}

function saveInlineImagesEnabled(enabled: boolean): void {
  const storage = getStorage();
  if (!storage || typeof storage.setItem !== "function") return;
  storage.setItem(UI_KEYS.inlineImagesEnabled, String(enabled));
}

let currentInlineImagesEnabled = loadInlineImagesEnabled();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentInlineImagesEnabled;
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function setInlineImagesPreference(enabled: boolean): void {
  currentInlineImagesEnabled = enabled;
  saveInlineImagesEnabled(enabled);
  emitChange();
}

export function useInlineImages() {
  const inlineImagesEnabled = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_INLINE_IMAGES_ENABLED,
  );

  const setInlineImagesEnabled = useCallback(setInlineImagesPreference, []);

  return {
    inlineImagesEnabled,
    setInlineImagesEnabled,
  };
}

export function getInlineImagesEnabled(): boolean {
  return currentInlineImagesEnabled;
}
