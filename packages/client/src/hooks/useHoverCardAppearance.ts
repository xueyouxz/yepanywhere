import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

// Delay before a hovered session row reveals its preview card; 0 = instant.
export const HOVERCARD_SHOW_DELAY_MIN_MS = 0;
export const HOVERCARD_SHOW_DELAY_MAX_MS = 1000;
export const HOVERCARD_SHOW_DELAY_STEP_MS = 25;
export const DEFAULT_HOVERCARD_SHOW_DELAY_MS = 150;

// Max height of the preview card; taller shows more of the opening request.
export const HOVERCARD_MAX_HEIGHT_MIN_PX = 80;
export const HOVERCARD_MAX_HEIGHT_MAX_PX = 600;
export const HOVERCARD_MAX_HEIGHT_STEP_PX = 10;
export const DEFAULT_HOVERCARD_MAX_HEIGHT_PX = 150;

export const HOVERCARD_APPEARANCE_CHANGE_EVENT =
  "yep-hovercard-appearance-change";

export interface HoverCardAppearance {
  showDelayMs: number;
  maxHeightPx: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function normalizeShowDelay(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HOVERCARD_SHOW_DELAY_MS;
  return clamp(
    roundToStep(value, HOVERCARD_SHOW_DELAY_STEP_MS),
    HOVERCARD_SHOW_DELAY_MIN_MS,
    HOVERCARD_SHOW_DELAY_MAX_MS,
  );
}

function normalizeMaxHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HOVERCARD_MAX_HEIGHT_PX;
  return clamp(
    roundToStep(value, HOVERCARD_MAX_HEIGHT_STEP_PX),
    HOVERCARD_MAX_HEIGHT_MIN_PX,
    HOVERCARD_MAX_HEIGHT_MAX_PX,
  );
}

function readStoredNumber(key: string, fallback: number): number {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : Number(stored);
}

function loadHoverCardAppearance(): HoverCardAppearance {
  return {
    showDelayMs: normalizeShowDelay(
      readStoredNumber(
        UI_KEYS.sessionHoverCardShowDelayMs,
        DEFAULT_HOVERCARD_SHOW_DELAY_MS,
      ),
    ),
    maxHeightPx: normalizeMaxHeight(
      readStoredNumber(
        UI_KEYS.sessionHoverCardMaxHeightPx,
        DEFAULT_HOVERCARD_MAX_HEIGHT_PX,
      ),
    ),
  };
}

/**
 * Read-only hover-card settings, kept in sync across every list row via the
 * change event so a settings edit updates open lists without a remount.
 */
export function useHoverCardSettings(): HoverCardAppearance {
  const [appearance, setAppearance] = useState<HoverCardAppearance>(
    loadHoverCardAppearance,
  );

  useEffect(() => {
    const update = () => setAppearance(loadHoverCardAppearance());
    window.addEventListener(HOVERCARD_APPEARANCE_CHANGE_EVENT, update);
    return () =>
      window.removeEventListener(HOVERCARD_APPEARANCE_CHANGE_EVENT, update);
  }, []);

  return appearance;
}

/** Read + write hover-card settings, for the settings pane. */
export function useHoverCardAppearance() {
  const { showDelayMs, maxHeightPx } = useHoverCardSettings();

  const setHoverCardShowDelayMs = useCallback((value: number) => {
    localStorage.setItem(
      UI_KEYS.sessionHoverCardShowDelayMs,
      String(normalizeShowDelay(value)),
    );
    window.dispatchEvent(new Event(HOVERCARD_APPEARANCE_CHANGE_EVENT));
  }, []);

  const setHoverCardMaxHeightPx = useCallback((value: number) => {
    localStorage.setItem(
      UI_KEYS.sessionHoverCardMaxHeightPx,
      String(normalizeMaxHeight(value)),
    );
    window.dispatchEvent(new Event(HOVERCARD_APPEARANCE_CHANGE_EVENT));
  }, []);

  const resetHoverCardAppearance = useCallback(() => {
    localStorage.removeItem(UI_KEYS.sessionHoverCardShowDelayMs);
    localStorage.removeItem(UI_KEYS.sessionHoverCardMaxHeightPx);
    window.dispatchEvent(new Event(HOVERCARD_APPEARANCE_CHANGE_EVENT));
  }, []);

  return {
    hoverCardShowDelayMs: showDelayMs,
    hoverCardMaxHeightPx: maxHeightPx,
    setHoverCardShowDelayMs,
    setHoverCardMaxHeightPx,
    resetHoverCardAppearance,
  };
}
