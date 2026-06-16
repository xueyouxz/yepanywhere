import { useEffect, useRef } from "react";
import { api } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { LEGACY_KEYS, getServerScoped } from "../lib/storageKeys";

/**
 * One-time seed of the per-model "compact context early" threshold (task 029).
 *
 * Before always-1M (commit 25e81e05), a user on bare `opus`/`sonnet` ran a 200K
 * window and the agent auto-compacted around there. Always-1M widened that to
 * 1M, which pushes auto-compaction out to ~800K. To preserve the old effective
 * window for those users, seed `compactAtContextPercent[model] = 20` (20% of
 * 1M ≈ 200K) exactly once. Users who had chosen the explicit 1M variant
 * (`opus[1m]`/`sonnet[1m]`), `default`, or any other model get nothing.
 *
 * The raw stored model is read pre-remap: `remapLegacyModelChoice` does not
 * persist, so the original `opus[1m]` vs bare `opus` distinction survives in
 * localStorage. The install-id scoping provider is not mounted, so the value
 * lives at the unscoped legacy key — `getServerScoped` falls back to it.
 *
 * The marker is per-browser but the write is server-global-per-model; for a
 * single user that's acceptable (first device to load wins). The marker is set
 * before any network call so a slow or failed request cannot double-seed.
 */
const SEED_MARKER_KEY = "yep-anywhere-compact-threshold-seeded";
const SEED_PERCENT = 20;
const SEEDABLE_MODELS = new Set(["opus", "sonnet"]);

export function useSeedCompactThreshold(): void {
  const { isAuthenticated } = useAuth();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    // isAuthenticated is true whenever the app is usable (logged in, auth
    // disabled, or localhost-open), and false only on the login page — so this
    // also keeps the seed from touching /api/settings before login.
    if (!isAuthenticated) return;
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(SEED_MARKER_KEY)) {
      ranRef.current = true;
      return;
    }
    ranRef.current = true;

    const rawModel = getServerScoped("model", LEGACY_KEYS.model);
    // Mark before any network so a slow/failed request can't double-seed.
    localStorage.setItem(SEED_MARKER_KEY, "1");
    if (!rawModel || !SEEDABLE_MODELS.has(rawModel)) return;

    void (async () => {
      try {
        const { settings } = await api.getServerSettings();
        const current = settings.clientDefaults?.compactAtContextPercent ?? {};
        // Respect a per-model choice the user already made.
        if (current[rawModel] != null) return;
        await api.updateServerSettings({
          clientDefaults: {
            compactAtContextPercent: { ...current, [rawModel]: SEED_PERCENT },
          },
        });
      } catch {
        // Best-effort one-time seed; a failure just leaves the model "off",
        // which the user can set explicitly via the slider.
      }
    })();
  }, [isAuthenticated]);
}
