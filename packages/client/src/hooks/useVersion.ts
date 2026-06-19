import { useCallback, useEffect, useRef, useState } from "react";
import { type VersionInfo, api } from "../api/client";
import { activityBus } from "../lib/activityBus";

interface UseVersionOptions {
  /** Request a fresh update check on initial mount. */
  freshOnMount?: boolean;
}

let sharedVersionRequest: Promise<VersionInfo> | null = null;

function requestVersion(fresh: boolean): Promise<VersionInfo> {
  if (fresh) return api.getVersion({ fresh: true });
  if (sharedVersionRequest) return sharedVersionRequest;
  const request = api.getVersion({ fresh: false }).finally(() => {
    if (sharedVersionRequest === request) sharedVersionRequest = null;
  });
  sharedVersionRequest = request;
  return request;
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
      const data = await requestVersion(fresh);
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

  // A restarted server can expose configured speech backends before their
  // lightweight validation finishes. Refresh until they settle, and once after
  // reconnect so a reyep does not leave this browser on the previous catalog.
  useEffect(() => {
    const hasPendingSpeechBackend = version?.voiceBackendStatuses?.some(
      (backend) => backend.validationStatus === "pending",
    );
    if (!hasPendingSpeechBackend) return;
    const timer = window.setTimeout(() => void fetchVersion(false), 1000);
    return () => window.clearTimeout(timer);
  }, [fetchVersion, version?.voiceBackendStatuses]);

  useEffect(
    () => activityBus.on("reconnect", () => void fetchVersion(false)),
    [fetchVersion],
  );

  return {
    version,
    loading,
    error,
    refetch: () => fetchVersion(false),
    refetchFresh: () => fetchVersion(true),
  };
}
