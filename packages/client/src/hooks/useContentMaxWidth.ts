import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export const DEFAULT_CONTENT_MAX_WIDTH_PX = 4000;
export const MIN_CONTENT_MAX_WIDTH_PX = 480;
export const MAX_CONTENT_MAX_WIDTH_PX = 4000;

function normalizeContentMaxWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONTENT_MAX_WIDTH_PX;
  }
  return Math.min(
    MAX_CONTENT_MAX_WIDTH_PX,
    Math.max(MIN_CONTENT_MAX_WIDTH_PX, Math.round(value)),
  );
}

function applyContentMaxWidth(widthPx: number) {
  document.documentElement.style.setProperty(
    "--content-max-width",
    `${normalizeContentMaxWidth(widthPx)}px`,
  );
}

function loadContentMaxWidth(): number {
  const stored = localStorage.getItem(UI_KEYS.contentMaxWidth);
  if (!stored) {
    return DEFAULT_CONTENT_MAX_WIDTH_PX;
  }
  const parsed = Number.parseInt(stored, 10);
  return normalizeContentMaxWidth(parsed);
}

function saveContentMaxWidth(widthPx: number) {
  localStorage.setItem(
    UI_KEYS.contentMaxWidth,
    String(normalizeContentMaxWidth(widthPx)),
  );
}

export function useContentMaxWidth() {
  const [contentMaxWidth, setContentMaxWidthState] = useState<number>(
    loadContentMaxWidth,
  );

  useEffect(() => {
    applyContentMaxWidth(contentMaxWidth);
  }, [contentMaxWidth]);

  const setContentMaxWidth = useCallback((widthPx: number) => {
    const normalized = normalizeContentMaxWidth(widthPx);
    setContentMaxWidthState(normalized);
    saveContentMaxWidth(normalized);
  }, []);

  return { contentMaxWidth, setContentMaxWidth };
}

export function initializeContentMaxWidth() {
  applyContentMaxWidth(loadContentMaxWidth());
}
