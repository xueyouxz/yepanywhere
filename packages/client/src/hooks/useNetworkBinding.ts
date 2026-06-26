import { useCallback, useEffect, useRef, useState } from "react";
import {
  type NetworkBindingState,
  type UpdateBindingRequest,
  api,
} from "../api/client";
import { useBackgroundRevalidation } from "./useBackgroundRevalidation";

/**
 * Hook to manage network binding configuration.
 *
 * Returns:
 * - binding: Current binding state (localhost and network sockets)
 * - loading: Whether the initial fetch is in progress
 * - error: Any error that occurred during fetch/update
 * - applying: Whether an update is in progress
 * - updateBinding: Function to update binding configuration
 * - disableNetwork: Function to disable network socket
 * - refetch: Function to manually refresh
 */
export function useNetworkBinding() {
  const [binding, setBinding] = useState<NetworkBindingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [applying, setApplying] = useState(false);
  const hasFetchedRef = useRef(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getNetworkBinding();
      setBinding(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch - only once (avoid StrictMode double-fetch)
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    fetch();
  }, [fetch]);

  // Quietly refresh binding state when the connection re-establishes, but not
  // while an update is being applied (avoid clobbering an in-progress change).
  useBackgroundRevalidation({
    fetcher: () => api.getNetworkBinding(),
    current: binding,
    apply: (next) => {
      setBinding(next);
      setError(null);
    },
    enabled: !applying,
  });

  const updateBinding = useCallback(
    async (
      request: UpdateBindingRequest,
    ): Promise<{ redirectUrl?: string }> => {
      setApplying(true);
      setError(null);
      try {
        const result = await api.setNetworkBinding(request);
        if (!result.success) {
          throw new Error(result.error ?? "Failed to update binding");
        }
        // Refetch to get updated state
        await fetch();
        return { redirectUrl: result.redirectUrl };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setApplying(false);
      }
    },
    [fetch],
  );

  const disableNetwork = useCallback(async (): Promise<void> => {
    setApplying(true);
    setError(null);
    try {
      const result = await api.disableNetworkBinding();
      if (!result.success) {
        throw new Error(result.error ?? "Failed to disable network socket");
      }
      // Refetch to get updated state
      await fetch();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      throw error;
    } finally {
      setApplying(false);
    }
  }, [fetch]);

  return {
    binding,
    loading,
    error,
    applying,
    updateBinding,
    disableNetwork,
    refetch: fetch,
  };
}
