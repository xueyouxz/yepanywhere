import { useCallback, useSyncExternalStore } from "react";
import { UI_KEYS } from "../lib/storageKeys";

type StreamingEnabledListener = () => void;

const listeners = new Set<StreamingEnabledListener>();

function loadStreamingEnabled(): boolean {
  const stored = localStorage.getItem(UI_KEYS.streamingEnabled);
  // Default to enabled
  if (stored === null) return true;
  return stored === "true";
}

function saveStreamingEnabled(enabled: boolean) {
  localStorage.setItem(UI_KEYS.streamingEnabled, String(enabled));
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeStreamingEnabled(
  listener: StreamingEnabledListener,
): () => void {
  listeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === UI_KEYS.streamingEnabled || event.key === null) {
      listener();
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

/**
 * Hook to manage streaming preference.
 * When enabled, assistant responses stream in token-by-token.
 * When disabled, responses appear all at once when complete.
 */
export function useStreamingEnabled() {
  const streamingEnabled = useSyncExternalStore(
    subscribeStreamingEnabled,
    getStreamingEnabled,
    () => true,
  );

  const setStreamingEnabled = useCallback((enabled: boolean) => {
    saveStreamingEnabled(enabled);
  }, []);

  return { streamingEnabled, setStreamingEnabled };
}

/**
 * Get streaming preference without React state (for non-component code).
 */
export function getStreamingEnabled(): boolean {
  return loadStreamingEnabled();
}
