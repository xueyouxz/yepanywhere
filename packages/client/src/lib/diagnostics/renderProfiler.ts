import { getRemoteLogCollectionEnabled } from "../../hooks/useDeveloperMode";
import { logSessionUiTrace } from "./uiTrace";

type RenderProfileDetails = Record<string, unknown>;
type RenderProfileDetailsInput =
  | RenderProfileDetails
  | (() => RenderProfileDetails);

const DEFAULT_RENDER_PROFILE_THRESHOLD_MS = 8;

declare global {
  interface Window {
    __RENDER_PROFILE__?: boolean | { thresholdMs?: number };
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function getRenderProfileThresholdMs(): number {
  if (typeof window === "undefined") {
    return DEFAULT_RENDER_PROFILE_THRESHOLD_MS;
  }
  const config = window.__RENDER_PROFILE__;
  if (config && typeof config === "object") {
    const thresholdMs = config.thresholdMs;
    if (typeof thresholdMs === "number" && Number.isFinite(thresholdMs)) {
      return Math.max(0, thresholdMs);
    }
  }
  return DEFAULT_RENDER_PROFILE_THRESHOLD_MS;
}

function isRenderProfilingEnabled(): boolean {
  return (
    getRemoteLogCollectionEnabled() ||
    (typeof window !== "undefined" && window.__RENDER_PROFILE__ !== undefined)
  );
}

export function profileRenderWork<T>(
  name: string,
  details: RenderProfileDetailsInput,
  run: () => T,
): T {
  if (!isRenderProfilingEnabled()) {
    return run();
  }

  const startMs = nowMs();
  try {
    return run();
  } finally {
    const durationMs = nowMs() - startMs;
    if (durationMs >= getRenderProfileThresholdMs()) {
      const resolvedDetails =
        typeof details === "function" ? details() : details;
      const event = {
        name,
        durationMs: Math.round(durationMs * 10) / 10,
        ...resolvedDetails,
      };
      logSessionUiTrace("render-profile", event);
      if (
        typeof window !== "undefined" &&
        window.__RENDER_PROFILE__ !== undefined &&
        !getRemoteLogCollectionEnabled()
      ) {
        console.log("[RenderProfile]", event);
      }
    }
  }
}
