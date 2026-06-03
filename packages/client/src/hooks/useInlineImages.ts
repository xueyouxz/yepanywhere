import { useCallback, useSyncExternalStore } from "react";
import { UI_KEYS } from "../lib/storageKeys";

const DEFAULT_INLINE_IMAGES_EXPANDED_BY_DEFAULT = false;

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

function loadInlineImagesExpandedByDefault(): boolean {
  const stored = getStorage()?.getItem(UI_KEYS.inlineImagesExpandedByDefault);
  if (stored === null || stored === undefined) {
    return DEFAULT_INLINE_IMAGES_EXPANDED_BY_DEFAULT;
  }
  return stored === "true";
}

function saveInlineImagesExpandedByDefault(expanded: boolean): void {
  const storage = getStorage();
  if (!storage || typeof storage.setItem !== "function") return;
  storage.setItem(UI_KEYS.inlineImagesExpandedByDefault, String(expanded));
}

let currentInlineImagesExpandedByDefault = loadInlineImagesExpandedByDefault();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentInlineImagesExpandedByDefault;
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function setInlineImagesExpandedPreference(expanded: boolean): void {
  currentInlineImagesExpandedByDefault = expanded;
  saveInlineImagesExpandedByDefault(expanded);
  emitChange();
}

export function useInlineImages() {
  const inlineImagesExpandedByDefault = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_INLINE_IMAGES_EXPANDED_BY_DEFAULT,
  );

  const setInlineImagesExpandedByDefault = useCallback(
    setInlineImagesExpandedPreference,
    [],
  );

  return {
    inlineImagesExpandedByDefault,
    setInlineImagesExpandedByDefault,
  };
}

export function getInlineImagesExpandedByDefault(): boolean {
  return currentInlineImagesExpandedByDefault;
}
