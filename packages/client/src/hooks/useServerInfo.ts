import { useCallback, useEffect, useRef, useState } from "react";
import { type ServerInfo, api } from "../api/client";
import { useBackgroundRevalidation } from "./useBackgroundRevalidation";

/**
 * Hook to fetch server binding info (host/port).
 *
 * Returns:
 * - serverInfo: Server binding info
 * - loading: Whether the fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh
 */
export function useServerInfo() {
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const hasFetchedRef = useRef(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getServerInfo();
      setServerInfo(data);
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

  // Quietly refresh binding info when the connection re-establishes.
  useBackgroundRevalidation({
    fetcher: () => api.getServerInfo(),
    current: serverInfo,
    apply: (next) => {
      setServerInfo(next);
      setError(null);
    },
  });

  return { serverInfo, loading, error, refetch: fetch };
}
