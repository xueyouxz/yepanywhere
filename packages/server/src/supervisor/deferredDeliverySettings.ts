/**
 * Live deferred-delivery settings bridge.
 *
 * ServerSettingsService publishes the operator's UI-configurable values here
 * so Process can consult them at each delivery boundary without plumbing the
 * service through Supervisor. Unset fields fall back to env config
 * (`YEP_DEFERRED_JOIN_WINDOW_S`, `YEP_COMPOSE_ANCHORS`); both default off —
 * vanilla delivery is one verbatim queued turn per delivery boundary
 * (topics/vanilla-defaults.md, topics/compose-time-context-anchors.md).
 */
import { loadConfig } from "../config.js";

export interface DeferredDeliverySettings {
  /**
   * Max seconds between consecutive compose times for queued turns to join
   * into one `--------`-joined provider turn at a delivery boundary.
   * 0 = never join.
   */
  joinWindowSeconds: number;
  /** Prepend `(Ns ago)` / `(Ms later)` compose-time staleness anchors. */
  composeAnchors: boolean;
}

let published: Partial<DeferredDeliverySettings> = {};

/** A non-negative finite seconds value, else undefined (treated as unset). */
export function sanitizeJoinWindowSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Publish the server-settings values (undefined fields fall back to env).
 * Called by ServerSettingsService on load and on every settings update.
 */
export function publishDeferredDeliverySettings(settings: {
  deferredJoinWindowSeconds?: number;
  composeAnchorsEnabled?: boolean;
}): void {
  published = {
    joinWindowSeconds: sanitizeJoinWindowSeconds(
      settings.deferredJoinWindowSeconds,
    ),
    composeAnchors:
      typeof settings.composeAnchorsEnabled === "boolean"
        ? settings.composeAnchorsEnabled
        : undefined,
  };
}

/** Effective settings: published server settings, then env config. */
export function resolveDeferredDeliverySettings(): DeferredDeliverySettings {
  const config = loadConfig();
  return {
    joinWindowSeconds:
      published.joinWindowSeconds ?? config.deferredJoinWindowSeconds,
    composeAnchors: published.composeAnchors ?? config.composeAnchors,
  };
}
