import type { ClientDefaults } from "@yep-anywhere/shared";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client";
import {
  type DefaultedBooleanRecord,
  normalizeDefaultedBooleanRecord,
  resolveDefaultedBooleanRecord,
  setDefaultedBooleanRecordValue,
} from "../lib/defaultedStorage";
import { UI_KEYS } from "../lib/storageKeys";
import { useVersion } from "./useVersion";

export interface SessionToolbarVisibility {
  modeSelector: boolean;
  attachments: boolean;
  slashMenu: boolean;
  thinkingToggle: boolean;
  renderMode: boolean;
  microphone: boolean;
  shortcutsHelp: boolean;
  contextUsage: boolean;
  btw: boolean;
  nudge: boolean;
  queueControls: boolean;
  sessionStatus: boolean;
}

export type SessionToolbarVisibilityKey = keyof SessionToolbarVisibility;
type StoredSessionToolbarVisibility =
  DefaultedBooleanRecord<SessionToolbarVisibilityKey>;
type SessionToolbarVisibilityDefaults = Partial<SessionToolbarVisibility>;

export const DEFAULT_SESSION_TOOLBAR_VISIBILITY: SessionToolbarVisibility = {
  modeSelector: true,
  attachments: true,
  slashMenu: true,
  thinkingToggle: true,
  renderMode: false,
  microphone: true,
  shortcutsHelp: true,
  contextUsage: true,
  btw: false,
  nudge: false,
  queueControls: false,
  sessionStatus: true,
};

const MOBILE_SESSION_TOOLBAR_VISIBILITY_DEFAULTS: Partial<SessionToolbarVisibility> =
  {
    shortcutsHelp: false,
    sessionStatus: false,
  };

const SESSION_TOOLBAR_MOBILE_QUERY = "(max-width: 600px)";

function isMobileToolbarLayout(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SESSION_TOOLBAR_MOBILE_QUERY).matches
  );
}

function getDefaultSessionToolbarVisibility(): SessionToolbarVisibility {
  const layoutDefaults = isMobileToolbarLayout()
    ? {
        ...DEFAULT_SESSION_TOOLBAR_VISIBILITY,
        ...MOBILE_SESSION_TOOLBAR_VISIBILITY_DEFAULTS,
      }
    : DEFAULT_SESSION_TOOLBAR_VISIBILITY;
  return {
    ...layoutDefaults,
    ...currentClientDefaultVisibility,
  };
}

const SESSION_TOOLBAR_VISIBILITY_KEYS = Object.keys(
  DEFAULT_SESSION_TOOLBAR_VISIBILITY,
) as SessionToolbarVisibilityKey[];

function normalizeClientDefaultVisibility(
  value: ClientDefaults["sessionToolbarVisibility"] | undefined,
): SessionToolbarVisibilityDefaults {
  if (!value || typeof value !== "object") {
    return {};
  }
  const normalized: SessionToolbarVisibilityDefaults = {};
  for (const key of SESSION_TOOLBAR_VISIBILITY_KEYS) {
    if (typeof value[key] === "boolean") {
      normalized[key] = value[key];
    }
  }
  return normalized;
}

function hasLocalStorage(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    typeof localStorage.getItem === "function" &&
    typeof localStorage.setItem === "function"
  );
}

function resolveVisibility(
  stored: StoredSessionToolbarVisibility,
): SessionToolbarVisibility {
  return resolveDefaultedBooleanRecord(
    stored,
    getDefaultSessionToolbarVisibility(),
    SESSION_TOOLBAR_VISIBILITY_KEYS,
  );
}

function normalizeStoredVisibility(
  value: unknown,
): StoredSessionToolbarVisibility {
  return normalizeDefaultedBooleanRecord(
    value,
    SESSION_TOOLBAR_VISIBILITY_KEYS,
  );
}

function loadStoredVisibility(): StoredSessionToolbarVisibility {
  if (!hasLocalStorage()) {
    return {};
  }
  const stored = localStorage.getItem(UI_KEYS.sessionToolbarVisibility);
  if (!stored) {
    return {};
  }
  try {
    return normalizeStoredVisibility(JSON.parse(stored));
  } catch {
    return {};
  }
}

function saveStoredVisibility(
  visibility: StoredSessionToolbarVisibility,
): void {
  if (!hasLocalStorage()) {
    return;
  }
  if (Object.keys(visibility).length === 0) {
    localStorage.removeItem(UI_KEYS.sessionToolbarVisibility);
    return;
  }
  localStorage.setItem(
    UI_KEYS.sessionToolbarVisibility,
    JSON.stringify(visibility),
  );
}

let currentStoredVisibility = loadStoredVisibility();
let currentClientDefaultVisibility: SessionToolbarVisibilityDefaults = {};
let currentVisibility = resolveVisibility(currentStoredVisibility);
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentVisibility;
}

function updateStoredVisibility(next: StoredSessionToolbarVisibility): void {
  currentStoredVisibility = normalizeStoredVisibility(next);
  currentVisibility = resolveVisibility(currentStoredVisibility);
  saveStoredVisibility(currentStoredVisibility);
  for (const listener of listeners) {
    listener();
  }
}

function updateClientDefaultVisibility(
  next: ClientDefaults["sessionToolbarVisibility"] | undefined,
): void {
  currentClientDefaultVisibility = normalizeClientDefaultVisibility(next);
  currentVisibility = resolveVisibility(currentStoredVisibility);
  for (const listener of listeners) {
    listener();
  }
}

function saveClientDefaultVisibility(
  key: SessionToolbarVisibilityKey,
  visible: boolean,
): void {
  void api
    .updateServerSettings({
      clientDefaults: {
        sessionToolbarVisibility: { [key]: visible },
      },
    })
    .catch((err) => {
      console.warn(
        "[useSessionToolbarVisibility] Failed to save server client default:",
        err instanceof Error ? err.message : String(err),
      );
    });
}

export function useSessionToolbarVisibility() {
  const { version } = useVersion();
  const visibility = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!version) return;
    updateClientDefaultVisibility(
      version?.clientDefaults?.sessionToolbarVisibility,
    );
  }, [version]);

  const setControlVisible = useCallback(
    (key: SessionToolbarVisibilityKey, visible: boolean) => {
      updateStoredVisibility(
        setDefaultedBooleanRecordValue(currentStoredVisibility, key, visible),
      );
      saveClientDefaultVisibility(key, visible);
    },
    [],
  );

  const resetVisibility = useCallback(() => {
    updateStoredVisibility({});
  }, []);

  return {
    visibility,
    setControlVisible,
    resetVisibility,
  };
}
