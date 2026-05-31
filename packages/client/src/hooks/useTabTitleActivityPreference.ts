import { useCallback, useSyncExternalStore } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export interface TabTitleActivityPreference {
  enabled: boolean;
}

export const DEFAULT_TAB_TITLE_ACTIVITY_PREFERENCE: TabTitleActivityPreference =
  {
    enabled: false,
  };

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

function loadTabTitleActivityPreference(): TabTitleActivityPreference {
  const storage = getStorage();
  if (!storage) {
    return DEFAULT_TAB_TITLE_ACTIVITY_PREFERENCE;
  }

  const enabled = storage.getItem(UI_KEYS.tabTitleActivityEnabled) === "true";
  return { enabled };
}

function saveTabTitleActivityPreference(
  preference: TabTitleActivityPreference,
): void {
  const storage = getStorage();
  if (!storage || typeof storage.setItem !== "function") {
    return;
  }
  storage.setItem(UI_KEYS.tabTitleActivityEnabled, String(preference.enabled));
}

function encodePreference(preference: TabTitleActivityPreference): string {
  return preference.enabled ? "1" : "0";
}

function decodePreferenceSnapshot(
  snapshot: string,
): TabTitleActivityPreference {
  return {
    enabled: snapshot === "1",
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return encodePreference(loadTabTitleActivityPreference());
}

function getServerSnapshot() {
  return encodePreference(DEFAULT_TAB_TITLE_ACTIVITY_PREFERENCE);
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function updatePreference(preference: TabTitleActivityPreference): void {
  saveTabTitleActivityPreference(preference);
  emitChange();
}

export function getTabTitleActivityPreference(): TabTitleActivityPreference {
  return loadTabTitleActivityPreference();
}

export function useTabTitleActivityPreference() {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const preference = decodePreferenceSnapshot(snapshot);

  const setTabTitleActivityEnabled = useCallback((enabled: boolean) => {
    updatePreference({
      ...loadTabTitleActivityPreference(),
      enabled,
    });
  }, []);

  return {
    tabTitleActivityEnabled: preference.enabled,
    setTabTitleActivityEnabled,
  };
}
