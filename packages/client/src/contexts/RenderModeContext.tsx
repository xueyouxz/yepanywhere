import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

export type RenderMode = "rendered" | "source";
export type RenderModeState = RenderMode | "mixed";

interface RenderModeContextValue {
  globalMode: RenderMode;
  state: RenderModeState;
  resetVersion: number;
  toggleGlobalMode: () => void;
  setOverrideActive: (id: string, active: boolean) => void;
}

interface UseRenderModeToggleOptions {
  renderWhenDisabled?: boolean;
  resetDependencies?: readonly unknown[];
}

const RenderModeContext = createContext<RenderModeContextValue | null>(null);

export function RenderModeProvider({ children }: { children: ReactNode }) {
  const [globalMode, setGlobalMode] = useState<RenderMode>("rendered");
  const [overrideIds, setOverrideIds] = useState<Set<string>>(() => new Set());
  const [resetVersion, setResetVersion] = useState(0);

  const setOverrideActive = useCallback((id: string, active: boolean) => {
    setOverrideIds((current) => {
      const hasId = current.has(id);
      if (active === hasId) {
        return current;
      }
      const next = new Set(current);
      if (active) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleGlobalMode = useCallback(() => {
    setGlobalMode((current) => (current === "rendered" ? "source" : "rendered"));
    setOverrideIds(() => new Set());
    setResetVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "m"
      ) {
        event.preventDefault();
        toggleGlobalMode();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [toggleGlobalMode]);

  const value = useMemo<RenderModeContextValue>(
    () => ({
      globalMode,
      state: overrideIds.size > 0 ? "mixed" : globalMode,
      resetVersion,
      toggleGlobalMode,
      setOverrideActive,
    }),
    [globalMode, overrideIds.size, resetVersion, setOverrideActive, toggleGlobalMode],
  );

  return <RenderModeContext.Provider value={value}>{children}</RenderModeContext.Provider>;
}

export function useOptionalRenderModeContext() {
  return useContext(RenderModeContext);
}

export function useRenderModeToggle(
  canToggle: boolean,
  options: UseRenderModeToggleOptions = {},
) {
  const context = useOptionalRenderModeContext();
  const globalMode = context?.globalMode ?? "rendered";
  const resetVersion = context?.resetVersion ?? 0;
  const renderWhenDisabled = options.renderWhenDisabled ?? true;
  const resetDependencies = options.resetDependencies ?? [];
  const registrationId = useId();
  const [overrideMode, setOverrideMode] = useState<RenderMode | null>(null);

  useEffect(() => {
    setOverrideMode(null);
  }, [canToggle, resetVersion, ...resetDependencies]);

  useEffect(() => {
    if (!context) {
      return;
    }

    const active = canToggle && overrideMode !== null;
    context.setOverrideActive(registrationId, active);

    return () => {
      context.setOverrideActive(registrationId, false);
    };
  }, [canToggle, context, overrideMode, registrationId]);

  const showRendered = canToggle
    ? (overrideMode ?? globalMode) === "rendered"
    : renderWhenDisabled;

  const toggleLocalMode = useCallback(() => {
    if (!canToggle) {
      return;
    }

    setOverrideMode((current) => {
      const effectiveMode = current ?? globalMode;
      const nextMode: RenderMode = effectiveMode === "rendered" ? "source" : "rendered";
      return nextMode === globalMode ? null : nextMode;
    });
  }, [canToggle, globalMode]);

  return {
    showRendered,
    toggleLocalMode,
  };
}
