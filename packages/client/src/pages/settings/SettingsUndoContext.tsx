import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Shared per-pane undo for settings pages.
 *
 * A settings pane registers its undo state (whether anything changed since
 * the pane was opened, and how to revert it) via useSettingsUndo; the
 * SettingsLayout renders the single Undo button top-right on the header row
 * (never inside scrollable pane content). One implementation, one location.
 */
export interface SettingsUndoRegistration {
  /** True when the pane's values differ from its open-time snapshot. */
  canUndo: boolean;
  /** Revert the pane to its open-time snapshot. */
  undo: () => void | Promise<void>;
}

const SettingsUndoContext = createContext<
  ((registration: SettingsUndoRegistration | null) => void) | null
>(null);

export const SettingsUndoProvider = SettingsUndoContext.Provider;

/**
 * Register this pane's undo state with the settings header. Pass a stable
 * `undo` (useCallback); registration updates whenever `canUndo` flips.
 */
export function useSettingsUndo(
  canUndo: boolean,
  undo: () => void | Promise<void>,
): void {
  const register = useContext(SettingsUndoContext);
  const registration = useMemo<SettingsUndoRegistration | null>(
    () => (canUndo ? { canUndo, undo } : null),
    [canUndo, undo],
  );
  useEffect(() => {
    if (!register) return;
    register(registration);
    return () => register(null);
  }, [register, registration]);
}

/** Layout-side state holder for the active pane's registration. */
export function useSettingsUndoRegistration(): {
  registration: SettingsUndoRegistration | null;
  setRegistration: (registration: SettingsUndoRegistration | null) => void;
} {
  const [registration, setRegistration] =
    useState<SettingsUndoRegistration | null>(null);
  return { registration, setRegistration };
}

function jsonEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Baseline-snapshot undo for a settings pane: captures the first non-null
 * `current` as the pane-open snapshot, registers header Undo while `current`
 * differs from it, and calls `restore(snapshot)` on Undo.
 *
 * Build `current` the same way every render (stable key order) — comparison
 * is JSON-based unless `isEqual` is supplied. `restore` must be stable
 * (useCallback) and should both persist the snapshot and reset any local
 * form/draft state.
 */
export function useSettingsUndoBaseline<T>(
  current: T | null | undefined,
  restore: (snapshot: T) => void | Promise<void>,
  isEqual: (a: T, b: T) => boolean = jsonEqual,
): void {
  const baselineRef = useRef<T | null>(null);
  if (baselineRef.current === null && current != null) {
    baselineRef.current = current;
  }
  const baseline = baselineRef.current;
  const canUndo =
    baseline != null && current != null && !isEqual(current, baseline);
  const undo = useCallback(() => {
    const snapshot = baselineRef.current;
    if (snapshot != null) return restore(snapshot);
  }, [restore]);
  useSettingsUndo(canUndo, undo);
}
