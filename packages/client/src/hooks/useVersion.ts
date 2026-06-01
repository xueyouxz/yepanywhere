import { useCallback, useEffect, useRef, useState } from "react";
import { type VersionInfo, api } from "../api/client";

interface UseVersionOptions {
  /** Request a fresh update check on initial mount. */
  freshOnMount?: boolean;
}

/**
 * Hook to fetch and cache server version info.
 *
 * Returns:
 * - version: Version info (current, latest, updateAvailable, optional capabilities)
 * - loading: Whether the fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh version info
 */
export function useVersion(options?: UseVersionOptions) {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchVersion = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getVersion({ fresh });
      setVersion(data);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch - only once (avoid StrictMode double-fetch)
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    void fetchVersion(options?.freshOnMount ?? false);
  }, [fetchVersion, options?.freshOnMount]);

  return {
    version,
    loading,
    error,
    refetch: () => fetchVersion(false),
    refetchFresh: () => fetchVersion(true),
  };
}
