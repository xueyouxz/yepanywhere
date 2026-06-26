import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useBackgroundRevalidation } from "./useBackgroundRevalidation";

export interface NotificationSettings {
  toolApproval: boolean;
  userQuestion: boolean;
  sessionHalted: boolean;
}

interface NotificationSettingsState {
  settings: NotificationSettings | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook for managing server-side notification settings.
 * Controls what types of notifications the server sends to all devices.
 */
export function useNotificationSettings() {
  const [state, setState] = useState<NotificationSettingsState>({
    settings: null,
    isLoading: true,
    error: null,
  });

  // Fetch settings on mount
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const { settings } = await api.getNotificationSettings();
        setState({ settings, isLoading: false, error: null });
      } catch (err) {
        console.error("[useNotificationSettings] Failed to fetch:", err);
        setState((s) => ({
          ...s,
          isLoading: false,
          error: err instanceof Error ? err.message : "Failed to load settings",
        }));
      }
    };

    fetchSettings();
  }, []);

  // Quietly refresh settings when the connection re-establishes, without
  // flashing a loading state over the current values.
  useBackgroundRevalidation({
    fetcher: () => api.getNotificationSettings().then((r) => r.settings),
    current: state.settings,
    apply: (settings) =>
      setState((s) => ({ ...s, settings, error: null })),
  });

  const updateSetting = useCallback(
    async (key: keyof NotificationSettings, value: boolean) => {
      setState((s) => ({ ...s, isLoading: true, error: null }));

      try {
        const { settings } = await api.updateNotificationSettings({
          [key]: value,
        });
        setState({ settings, isLoading: false, error: null });
      } catch (err) {
        console.error("[useNotificationSettings] Failed to update:", err);
        setState((s) => ({
          ...s,
          isLoading: false,
          error: err instanceof Error ? err.message : "Failed to update",
        }));
      }
    },
    [],
  );

  return {
    ...state,
    updateSetting,
  };
}
