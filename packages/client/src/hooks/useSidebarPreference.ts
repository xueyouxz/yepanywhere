import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

/**
 * Hook to manage sidebar expanded/collapsed preference.
 * Persists to localStorage.
 */
export function useSidebarPreference(forceExpanded = false): {
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
} {
  const [isExpanded, setIsExpandedState] = useState(() => {
    if (forceExpanded) {
      return true;
    }
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(UI_KEYS.sidebarExpanded);
      // Default to expanded if no preference saved
      return stored === null ? true : stored === "true";
    }
    return true;
  });

  const setIsExpanded = useCallback((expanded: boolean) => {
    setIsExpandedState(expanded);
    localStorage.setItem(UI_KEYS.sidebarExpanded, String(expanded));
  }, []);

  const toggleExpanded = useCallback(() => {
    // Use functional update to avoid stale closure issues
    setIsExpandedState((prev) => {
      const next = !prev;
      localStorage.setItem(UI_KEYS.sidebarExpanded, String(next));
      return next;
    });
  }, []);

  return { isExpanded, setIsExpanded, toggleExpanded };
}
