import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface DraftControls {
  /** Return the current in-memory draft value */
  getDraft: () => string;
  /** Replace input state and localStorage immediately */
  setDraft: (value: string) => void;
  /** Flush any pending draft write immediately */
  flushDraft: () => void;
  /** Clear input state only, keeping localStorage for failure recovery */
  clearInput: () => void;
  /** Clear both input state and localStorage (call on confirmed success) */
  clearDraft: () => void;
  /** Restore from localStorage (call on failure) */
  restoreFromStorage: () => void;
}

export interface UseDraftPersistenceOptions {
  /** Keep the current in-memory draft when switching to a new storage key that has no draft yet. */
  preserveValueOnKeyChange?: boolean;
}

/** Save a value to localStorage immediately */
function saveToStorage(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage might be full or unavailable
  }
}

/**
 * Hook for persisting draft text to localStorage.
 * Supports failure recovery by keeping localStorage until explicitly cleared.
 *
 * @param key - localStorage key for this draft (e.g., "draft-message-{sessionId}")
 * @returns [value, setValue, controls] - state-like tuple with control functions
 */
export function useDraftPersistence(
  key: string,
  options?: UseDraftPersistenceOptions,
): [string, (value: string) => void, DraftControls] {
  const [value, setValueInternal] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(key);
  // Track pending value so we can flush on unmount/beforeunload
  const pendingValueRef = useRef<string | null>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Update keyRef when key changes
  useEffect(() => {
    const previousKey = keyRef.current;
    const previousValue = pendingValueRef.current ?? valueRef.current;
    const keyChanged = previousKey !== key;

    if (keyChanged && pendingValueRef.current !== null) {
      saveToStorage(previousKey, pendingValueRef.current);
      pendingValueRef.current = null;
    }

    keyRef.current = key;

    try {
      const stored = localStorage.getItem(key);
      if (
        keyChanged &&
        options?.preserveValueOnKeyChange &&
        previousValue &&
        !stored
      ) {
        saveToStorage(key, previousValue);
        valueRef.current = previousValue;
        setValueInternal(previousValue);
        return;
      }
      valueRef.current = stored ?? "";
      setValueInternal(stored ?? "");
    } catch {
      valueRef.current = "";
      setValueInternal("");
    }
  }, [key, options?.preserveValueOnKeyChange]);

  // Flush pending value to localStorage
  const flushPending = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (pendingValueRef.current !== null) {
      saveToStorage(keyRef.current, pendingValueRef.current);
      pendingValueRef.current = null;
    }
  }, []);

  // Handle lifecycle boundaries to save drafts before the page can be frozen,
  // discarded, or refreshed. `pagehide` covers mobile/browser cache paths where
  // `beforeunload` is skipped.
  useEffect(() => {
    const handlePageExit = () => {
      flushPending();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushPending();
      }
    };
    window.addEventListener("beforeunload", handlePageExit);
    window.addEventListener("pagehide", handlePageExit);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handlePageExit);
      window.removeEventListener("pagehide", handlePageExit);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushPending]);

  // Save each edit immediately. A debounce window can lose the newest typed
  // text during HMR/reload paths that do not reliably fire page lifecycle
  // events before React remounts and restores the previous storage value.
  const setValue = useCallback((newValue: string) => {
    valueRef.current = newValue;
    setValueInternal(newValue);
    pendingValueRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    saveToStorage(keyRef.current, newValue);
  }, []);

  // Read the current in-memory value for UI actions that append to the draft.
  const getDraft = useCallback(() => valueRef.current, []);

  // Replace the draft immediately. This is used when another UI action, such
  // as editing a queued message, needs to take over the composer.
  const setDraft = useCallback((newValue: string) => {
    valueRef.current = newValue;
    setValueInternal(newValue);
    pendingValueRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    saveToStorage(keyRef.current, newValue);
  }, []);

  // Clear input state only (for optimistic UI on submit)
  const clearInput = useCallback(() => {
    if (pendingValueRef.current !== null) {
      saveToStorage(keyRef.current, pendingValueRef.current);
    }
    valueRef.current = "";
    setValueInternal("");
    pendingValueRef.current = null;
    // Cancel pending write so we don't overwrite the recovery draft with ""
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Clear both state and localStorage (for confirmed successful send)
  const clearDraft = useCallback(() => {
    valueRef.current = "";
    setValueInternal("");
    pendingValueRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    try {
      localStorage.removeItem(keyRef.current);
    } catch {
      // Ignore errors
    }
  }, []);

  // Restore from localStorage (for failure recovery)
  const restoreFromStorage = useCallback(() => {
    try {
      const stored = localStorage.getItem(keyRef.current);
      if (stored) {
        valueRef.current = stored;
        setValueInternal(stored);
      } else {
        valueRef.current = "";
        setValueInternal("");
      }
    } catch {
      // Ignore errors
    }
  }, []);

  // Flush pending and cleanup on unmount
  useEffect(() => {
    return () => {
      // Flush any pending value before unmount (handles HMR and navigation)
      if (pendingValueRef.current !== null) {
        saveToStorage(keyRef.current, pendingValueRef.current);
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const controls = useMemo(
    () => ({
      getDraft,
      setDraft,
      flushDraft: flushPending,
      clearInput,
      clearDraft,
      restoreFromStorage,
    }),
    [
      getDraft,
      setDraft,
      flushPending,
      clearInput,
      clearDraft,
      restoreFromStorage,
    ],
  );

  return [value, setValue, controls];
}
