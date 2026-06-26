import { useEffect, useRef } from "react";
import { activityBus } from "../lib/activityBus";

/**
 * Default debounce window. Skip background revalidation if the data was
 * (re)loaded within this window. Settings rarely change, so this mainly
 * suppresses churn on brief disconnects (screen off for a moment, quick network
 * blip).
 */
const DEFAULT_MIN_INTERVAL_MS = 10_000;

function defaultIsEqual<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export interface BackgroundRevalidationParams<T> {
  /** Quiet fetch of the latest data. */
  fetcher: () => Promise<T>;
  /** Current data, so an unchanged result can skip the update entirely. */
  current: T | null;
  /**
   * Apply newly-fetched data. Only invoked when the data actually changed, so
   * this should set the data (and clear any stale error) WITHOUT touching a
   * loading state — that is what keeps revalidation invisible.
   */
  apply: (next: T) => void;
  /** Wire up revalidation. Default true. */
  enabled?: boolean;
  /** Equality used to decide whether to apply. Defaults to JSON deep-equality. */
  isEqual?: (a: T, b: T) => boolean;
  /** Debounce window in ms. Default 10s. */
  minIntervalMs?: number;
}

/**
 * Opt-in, background-only revalidation for read hooks.
 *
 * When the relay connection re-establishes (`reconnect`) or the tab is
 * refocused (`refresh`), quietly re-fetch and apply the result *only if it
 * changed*. It never shows a loading state and never overwrites good data with
 * an error, so already-rendered UI does not flash skeletons or block
 * interaction. Brief disconnects are debounced away.
 *
 * Deliberately narrow — intended for low-churn settings data, not lists or
 * dashboards (those heal via activity events / the lifecycle store). See
 * docs/tactical/021-client-connection-readiness-vs-state-consistency.md.
 */
export function useBackgroundRevalidation<T>({
  fetcher,
  current,
  apply,
  enabled = true,
  isEqual = defaultIsEqual,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
}: BackgroundRevalidationParams<T>): void {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const currentRef = useRef(current);
  currentRef.current = current;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;

  // Treat mount as a fresh load so an immediate reconnect doesn't refetch.
  const lastRunRef = useRef(Date.now());
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const trigger = async () => {
      if (inFlightRef.current) return;
      if (Date.now() - lastRunRef.current < minIntervalMs) return;
      inFlightRef.current = true;
      try {
        const next = await fetcherRef.current();
        lastRunRef.current = Date.now();
        const prev = currentRef.current;
        if (prev === null || !isEqualRef.current(prev, next)) {
          applyRef.current(next);
        }
      } catch {
        // Quiet: keep showing existing data, don't surface an error over it.
      } finally {
        inFlightRef.current = false;
      }
    };

    const unsubReconnect = activityBus.on("reconnect", () => {
      void trigger();
    });
    const unsubRefresh = activityBus.on("refresh", () => {
      void trigger();
    });
    return () => {
      unsubReconnect();
      unsubRefresh();
    };
  }, [enabled, minIntervalMs]);
}
