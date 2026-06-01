import { useCallback, useSyncExternalStore } from "react";
import { UI_KEYS } from "../lib/storageKeys";

const DEFAULT_STABLE_TOOL_PREVIEW_RENDERING = true;

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

function loadStableToolPreviewRendering(): boolean {
  const stored = getStorage()?.getItem(UI_KEYS.stableToolPreviewRendering);
  if (stored === null || stored === undefined) {
    return DEFAULT_STABLE_TOOL_PREVIEW_RENDERING;
  }
  return stored === "true";
}

function saveStableToolPreviewRendering(enabled: boolean): void {
  const storage = getStorage();
  if (!storage || typeof storage.setItem !== "function") return;
  storage.setItem(UI_KEYS.stableToolPreviewRendering, String(enabled));
}

let currentStableToolPreviewRendering = loadStableToolPreviewRendering();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentStableToolPreviewRendering;
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function setStableToolPreviewRenderingPreference(
  enabled: boolean,
): void {
  currentStableToolPreviewRendering = enabled;
  saveStableToolPreviewRendering(enabled);
  emitChange();
}

export function useStableToolPreviewRendering() {
  const stableToolPreviewRendering = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_STABLE_TOOL_PREVIEW_RENDERING,
  );

  const setStableToolPreviewRendering = useCallback(
    setStableToolPreviewRenderingPreference,
    [],
  );

  return {
    stableToolPreviewRendering,
    setStableToolPreviewRendering,
  };
}

export function getStableToolPreviewRendering(): boolean {
  return currentStableToolPreviewRendering;
}
