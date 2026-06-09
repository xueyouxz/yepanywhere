import { DEFAULT_PROVIDER, type ProviderInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

const PROVIDER_CACHE_TTL_MS = 5 * 60_000;

interface ProviderCacheEntry {
  providers: ProviderInfo[];
  expiresAt: number;
}

let providerCache: ProviderCacheEntry | null = null;
let providerFetchPromise: Promise<ProviderInfo[]> | null = null;

async function loadProviders(forceRefresh: boolean): Promise<ProviderInfo[]> {
  const now = Date.now();
  if (!forceRefresh && providerCache && providerCache.expiresAt > now) {
    return providerCache.providers;
  }
  if (!forceRefresh && providerFetchPromise) {
    return providerFetchPromise;
  }

  const request = api.getProviders({ refresh: forceRefresh }).then((data) => {
    providerCache = {
      providers: data.providers,
      expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
    };
    return data.providers;
  });
  providerFetchPromise = request;

  try {
    return await request;
  } finally {
    if (providerFetchPromise === request) {
      providerFetchPromise = null;
    }
  }
}

/**
 * Hook to fetch and cache available AI providers with their auth status.
 *
 * Returns:
 * - providers: Array of provider info objects
 * - loading: Whether the initial fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh provider status
 */
export function useProviders() {
  const [providers, setProviders] = useState<ProviderInfo[]>(
    () => providerCache?.providers ?? [],
  );
  const [loading, setLoading] = useState(() => !providerCache);
  const [error, setError] = useState<Error | null>(null);
  const hasFetchedRef = useRef(false);

  const fetch = useCallback(async (forceRefresh = false) => {
    if (forceRefresh || !providerCache) {
      setLoading(true);
    }
    setError(null);
    try {
      const nextProviders = await loadProviders(forceRefresh);
      setProviders(nextProviders);
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

  const refetch = useCallback(() => fetch(true), [fetch]);

  return { providers, loading, error, refetch };
}

/**
 * Get the list of providers that are available (installed + authenticated/enabled).
 */
export function getAvailableProviders(
  providers: ProviderInfo[],
): ProviderInfo[] {
  return providers.filter((p) => p.installed && (p.authenticated || p.enabled));
}

/**
 * Get the default provider from available providers.
 * Prefers Claude if available, otherwise the first available provider.
 */
export function getDefaultProvider(
  providers: ProviderInfo[],
): ProviderInfo | null {
  const available = getAvailableProviders(providers);
  if (available.length === 0) return null;

  // Prefer default provider (Claude)
  const defaultProv = available.find((p) => p.name === DEFAULT_PROVIDER);
  if (defaultProv) return defaultProv;

  // available[0] is guaranteed to exist since we checked length > 0
  return available[0] ?? null;
}
