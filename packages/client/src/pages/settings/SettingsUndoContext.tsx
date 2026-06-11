import { createContext, useContext, useEffect, useMemo, useState } from "react";

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
