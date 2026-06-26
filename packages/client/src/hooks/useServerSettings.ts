import { useCallback, useEffect, useState } from "react";
import { type ServerSettings, api } from "../api/client";
import { useBackgroundRevalidation } from "./useBackgroundRevalidation";

interface UseServerSettingsResult {
  settings: ServerSettings | null;
  isLoading: boolean;
  error: string | null;
  updateSettings: (updates: Partial<ServerSettings>) => Promise<void>;
  updateSetting: <K extends keyof ServerSettings>(
    key: K,
    value: ServerSettings[K],
  ) => Promise<void>;
  refetch: () => Promise<void>;
}

/**
 * Hook for managing server-wide settings.
 * Fetches settings on mount and provides update functionality.
 */
export function useServerSettings(): UseServerSettingsResult {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await api.getServerSettings();
      setSettings(response.settings);
    } catch (err) {
      console.error("[useServerSettings] Failed to fetch settings:", err);
      setError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Quietly refresh settings when the connection re-establishes.
  useBackgroundRevalidation({
    fetcher: () => api.getServerSettings().then((r) => r.settings),
    current: settings,
    apply: (next) => {
      setSettings(next);
      setError(null);
    },
  });

  const updateSettings = useCallback(
    async (updates: Partial<ServerSettings>): Promise<void> => {
      try {
        setError(null);
        const response = await api.updateServerSettings(updates);
        setSettings(response.settings);
      } catch (err) {
        console.error("[useServerSettings] Failed to update settings:", err);
        setError(
          err instanceof Error ? err.message : "Failed to update settings",
        );
        throw err;
      }
    },
    [],
  );

  const updateSetting = useCallback(
    async <K extends keyof ServerSettings>(
      key: K,
      value: ServerSettings[K],
    ): Promise<void> => {
      await updateSettings({ [key]: value });
    },
    [updateSettings],
  );

  return {
    settings,
    isLoading,
    error,
    updateSettings,
    updateSetting,
    refetch: fetchSettings,
  };
}
