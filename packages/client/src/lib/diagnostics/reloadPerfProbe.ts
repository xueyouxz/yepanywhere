export interface ReloadPerfMark {
  name: string;
  at: number;
  detail?: Record<string, unknown>;
}

interface ReloadPerfProbe {
  mark?: (name: string, detail?: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    __YA_RELOAD_PERF_PROBE__?: ReloadPerfProbe;
  }
}

export function markReloadPerfPhase(
  name: string,
  detail?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  window.__YA_RELOAD_PERF_PROBE__?.mark?.(name, detail);
}
