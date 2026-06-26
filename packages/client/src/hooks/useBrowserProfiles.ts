import type { BrowserProfileInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useBackgroundRevalidation } from "./useBackgroundRevalidation";

interface BrowserProfilesState {
  profiles: BrowserProfileInfo[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook for managing browser profiles with their connection origins.
 * Allows viewing device connection history and forgetting devices.
 */
export function useBrowserProfiles() {
  const [state, setState] = useState<BrowserProfilesState>({
    profiles: [],
    isLoading: true,
    error: null,
  });

  const fetchProfiles = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      const { profiles } = await api.getBrowserProfiles();
      setState({
        profiles,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      console.error("[useBrowserProfiles] Failed to fetch:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load profiles",
      }));
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  // Quietly refresh profiles when the connection re-establishes.
  useBackgroundRevalidation({
    fetcher: () => api.getBrowserProfiles().then((r) => r.profiles),
    current: state.profiles,
    apply: (profiles) => setState((s) => ({ ...s, profiles, error: null })),
  });

  const deleteProfile = useCallback(
    async (browserProfileId: string) => {
      setState((s) => ({ ...s, isLoading: true, error: null }));

      try {
        await api.deleteBrowserProfile(browserProfileId);
        // Refresh the list
        await fetchProfiles();
      } catch (err) {
        console.error("[useBrowserProfiles] Failed to delete:", err);
        setState((s) => ({
          ...s,
          isLoading: false,
          error:
            err instanceof Error ? err.message : "Failed to delete profile",
        }));
      }
    },
    [fetchProfiles],
  );

  return {
    ...state,
    deleteProfile,
    refetch: fetchProfiles,
  };
}
