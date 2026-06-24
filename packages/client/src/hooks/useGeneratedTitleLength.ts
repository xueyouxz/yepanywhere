import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export const GENERATED_TITLE_LENGTH_MIN = 50;
export const GENERATED_TITLE_LENGTH_MAX = 132;
export const GENERATED_TITLE_LENGTH_STEP = 1;
export const DEFAULT_GENERATED_TITLE_LENGTH = 80;

export const GENERATED_TITLE_LENGTH_CHANGE_EVENT =
  "yep-generated-title-length-change";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeGeneratedTitleLength(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GENERATED_TITLE_LENGTH;
  return clamp(
    Math.round(value / GENERATED_TITLE_LENGTH_STEP) *
      GENERATED_TITLE_LENGTH_STEP,
    GENERATED_TITLE_LENGTH_MIN,
    GENERATED_TITLE_LENGTH_MAX,
  );
}

function readStoredNumber(key: string, fallback: number): number {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : Number(stored);
}

export function getGeneratedTitleLength(): number {
  return normalizeGeneratedTitleLength(
    readStoredNumber(
      UI_KEYS.sessionGeneratedTitleLength,
      DEFAULT_GENERATED_TITLE_LENGTH,
    ),
  );
}

export function useGeneratedTitleLength() {
  const [generatedTitleLength, setGeneratedTitleLengthState] = useState(
    getGeneratedTitleLength,
  );

  useEffect(() => {
    const update = () =>
      setGeneratedTitleLengthState(getGeneratedTitleLength());
    window.addEventListener(GENERATED_TITLE_LENGTH_CHANGE_EVENT, update);
    return () =>
      window.removeEventListener(GENERATED_TITLE_LENGTH_CHANGE_EVENT, update);
  }, []);

  const setGeneratedTitleLength = useCallback((value: number) => {
    const normalized = normalizeGeneratedTitleLength(value);
    localStorage.setItem(
      UI_KEYS.sessionGeneratedTitleLength,
      String(normalized),
    );
    setGeneratedTitleLengthState(normalized);
    window.dispatchEvent(new Event(GENERATED_TITLE_LENGTH_CHANGE_EVENT));
  }, []);

  const resetGeneratedTitleLength = useCallback(() => {
    localStorage.removeItem(UI_KEYS.sessionGeneratedTitleLength);
    setGeneratedTitleLengthState(DEFAULT_GENERATED_TITLE_LENGTH);
    window.dispatchEvent(new Event(GENERATED_TITLE_LENGTH_CHANGE_EVENT));
  }, []);

  return {
    generatedTitleLength,
    setGeneratedTitleLength,
    resetGeneratedTitleLength,
  };
}
