import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type OutputProseFont = "system" | "source-serif-4";

export const OUTPUT_APPEARANCE_CHANGE_EVENT = "yep-output-appearance-change";

export const OUTPUT_PROSE_FONTS: OutputProseFont[] = [
  "system",
  "source-serif-4",
];

export const OUTPUT_FONT_SIZE_MIN_PX = 11;
export const OUTPUT_FONT_SIZE_MAX_PX = 20;
export const OUTPUT_FONT_SIZE_STEP_PX = 0.5;
export const DEFAULT_OUTPUT_FONT_SIZE_PX = 15;

export const OUTPUT_FONT_SIZE_PRESETS = [
  { value: 11, label: "S" },
  { value: 13, label: "D" },
  { value: 15, label: "L" },
  { value: 17, label: "XL" },
] as const;

export const OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX = -3;
export const OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX = 2;
export const OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX = 0.5;
export const DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX = -1;
const OUTPUT_THINKING_FONT_SIZE_MIN_PX = 10;

export const OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX = -2;
export const OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX = 4;
export const OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX = 0.5;
export const DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX = 1;

export const OUTPUT_LINE_SPACING_MIN_PERCENT = -30;
export const OUTPUT_LINE_SPACING_MAX_PERCENT = 50;
export const OUTPUT_LINE_SPACING_STEP_PERCENT = 1;
export const DEFAULT_OUTPUT_LINE_SPACING_PERCENT = 0;

export const OUTPUT_VERTICAL_SPACING_MIN_PERCENT = -40;
export const OUTPUT_VERTICAL_SPACING_MAX_PERCENT = 70;
export const OUTPUT_VERTICAL_SPACING_STEP_PERCENT = 1;
export const DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT = 0;
const SOURCE_SERIF_4_OUTPUT_OPSZ_MIN = 8;
const SOURCE_SERIF_4_OUTPUT_OPSZ_MAX = 20;

interface OutputAppearance {
  font: OutputProseFont;
  fontSizePx: number;
  thinkingFontSizeOffsetPx: number;
  mathFontSizeOffsetPx: number;
  lineSpacingPercent: number;
  verticalSpacingPercent: number;
}

const outputFontStacks: Record<OutputProseFont, string> = {
  system: "var(--font-sans)",
  "source-serif-4": "var(--font-output-serif)",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  return Number((Math.round(value / step) * step).toFixed(2));
}

function normalizeOutputFont(value: string | null): OutputProseFont {
  return value && OUTPUT_PROSE_FONTS.includes(value as OutputProseFont)
    ? (value as OutputProseFont)
    : "system";
}

function normalizeFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_FONT_SIZE_PX;
  return clamp(
    roundToStep(value, OUTPUT_FONT_SIZE_STEP_PX),
    OUTPUT_FONT_SIZE_MIN_PX,
    OUTPUT_FONT_SIZE_MAX_PX,
  );
}

function normalizeThinkingFontSizeOffset(value: number): number {
  if (!Number.isFinite(value))
    return DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX;
  return clamp(
    roundToStep(value, OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX),
    OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX,
    OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX,
  );
}

function normalizeMathFontSizeOffset(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX;
  return clamp(
    roundToStep(value, OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX),
    OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX,
    OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX,
  );
}

function normalizeVerticalSpacingPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT;
  return clamp(
    roundToStep(value, OUTPUT_VERTICAL_SPACING_STEP_PERCENT),
    OUTPUT_VERTICAL_SPACING_MIN_PERCENT,
    OUTPUT_VERTICAL_SPACING_MAX_PERCENT,
  );
}

function normalizeLineSpacingPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_LINE_SPACING_PERCENT;
  return clamp(
    roundToStep(value, OUTPUT_LINE_SPACING_STEP_PERCENT),
    OUTPUT_LINE_SPACING_MIN_PERCENT,
    OUTPUT_LINE_SPACING_MAX_PERCENT,
  );
}

function deriveFontRelativePx(fontSizePx: number, percent: number): number {
  return Number(((fontSizePx * percent) / 100).toFixed(2));
}

function deriveOffsetFontSizePx(
  fontSizePx: number,
  offsetPx: number,
  minPx: number,
): number {
  return Number(Math.max(minPx, fontSizePx + offsetPx).toFixed(2));
}

function deriveThinkingFontSizePx(
  fontSizePx: number,
  thinkingFontSizeOffsetPx: number,
): number {
  return deriveOffsetFontSizePx(
    fontSizePx,
    thinkingFontSizeOffsetPx,
    OUTPUT_THINKING_FONT_SIZE_MIN_PX,
  );
}

function deriveSourceSerifOpticalSize(fontSizePx: number): number {
  return Number(
    clamp(
      fontSizePx,
      SOURCE_SERIF_4_OUTPUT_OPSZ_MIN,
      SOURCE_SERIF_4_OUTPUT_OPSZ_MAX,
    ).toFixed(2),
  );
}

function getFontVariationSettings(
  appearance: OutputAppearance,
  fontSizePx: number,
): string {
  if (appearance.font !== "source-serif-4") return "normal";
  return `"opsz" ${deriveSourceSerifOpticalSize(fontSizePx)}`;
}

function readStoredNumber(key: string, fallback: number): number {
  const stored = localStorage.getItem(key);
  return stored === null ? fallback : Number(stored);
}

function readStoredVerticalSpacingPercent(fontSizePx: number): number {
  const storedPercent = localStorage.getItem(
    UI_KEYS.outputProseVerticalSpacingPercent,
  );
  if (storedPercent !== null) {
    return normalizeVerticalSpacingPercent(Number(storedPercent));
  }

  const legacyPx = localStorage.getItem(UI_KEYS.outputProseVerticalSpacing);
  if (legacyPx !== null) {
    return normalizeVerticalSpacingPercent(
      (Number(legacyPx) / fontSizePx) * 100,
    );
  }

  return DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT;
}

function loadOutputAppearance(): OutputAppearance {
  const fontSizePx = normalizeFontSize(
    readStoredNumber(UI_KEYS.outputProseFontSize, DEFAULT_OUTPUT_FONT_SIZE_PX),
  );

  return {
    font: normalizeOutputFont(localStorage.getItem(UI_KEYS.outputProseFont)),
    fontSizePx,
    thinkingFontSizeOffsetPx: normalizeThinkingFontSizeOffset(
      readStoredNumber(
        UI_KEYS.outputProseThinkingFontSizeOffset,
        DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX,
      ),
    ),
    mathFontSizeOffsetPx: normalizeMathFontSizeOffset(
      readStoredNumber(
        UI_KEYS.outputProseMathFontSizeOffset,
        DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX,
      ),
    ),
    lineSpacingPercent: normalizeLineSpacingPercent(
      readStoredNumber(
        UI_KEYS.outputProseLineSpacingPercent,
        DEFAULT_OUTPUT_LINE_SPACING_PERCENT,
      ),
    ),
    verticalSpacingPercent: readStoredVerticalSpacingPercent(fontSizePx),
  };
}

function applyOutputAppearance(appearance: OutputAppearance) {
  const root = document.documentElement;
  const verticalSpacingPx = deriveFontRelativePx(
    appearance.fontSizePx,
    appearance.verticalSpacingPercent,
  );
  const thinkingFontSizePx = deriveThinkingFontSizePx(
    appearance.fontSizePx,
    appearance.thinkingFontSizeOffsetPx,
  );
  root.style.setProperty(
    "--output-prose-font-family",
    outputFontStacks[appearance.font],
  );
  root.style.setProperty(
    "--output-prose-font-size",
    `${appearance.fontSizePx}px`,
  );
  root.style.setProperty(
    "--output-prose-vspace-offset",
    `${verticalSpacingPx}px`,
  );
  root.style.setProperty(
    "--output-prose-line-height-offset",
    `${deriveFontRelativePx(appearance.fontSizePx, appearance.lineSpacingPercent)}px`,
  );
  root.style.setProperty(
    "--output-prose-font-optical-sizing",
    appearance.font === "source-serif-4" ? "none" : "auto",
  );
  root.style.setProperty(
    "--output-prose-font-variation-settings",
    getFontVariationSettings(appearance, appearance.fontSizePx),
  );
  root.style.setProperty(
    "--thinking-prose-font-size",
    `${thinkingFontSizePx}px`,
  );
  root.style.setProperty(
    "--output-math-font-size-offset",
    `${appearance.mathFontSizeOffsetPx}px`,
  );
  root.style.setProperty(
    "--thinking-prose-line-height-offset",
    `${deriveFontRelativePx(thinkingFontSizePx, appearance.lineSpacingPercent)}px`,
  );
  root.style.setProperty(
    "--thinking-prose-font-variation-settings",
    getFontVariationSettings(appearance, thinkingFontSizePx),
  );
  window.dispatchEvent(new Event(OUTPUT_APPEARANCE_CHANGE_EVENT));
}

export function useOutputAppearance() {
  const [appearance, setAppearance] =
    useState<OutputAppearance>(loadOutputAppearance);

  useEffect(() => {
    applyOutputAppearance(appearance);
  }, [appearance]);

  const setOutputFont = useCallback((font: OutputProseFont) => {
    const normalized = normalizeOutputFont(font);
    localStorage.setItem(UI_KEYS.outputProseFont, normalized);
    setAppearance((current) => ({ ...current, font: normalized }));
  }, []);

  const setOutputFontSizePx = useCallback((fontSizePx: number) => {
    const normalized = normalizeFontSize(fontSizePx);
    localStorage.setItem(UI_KEYS.outputProseFontSize, String(normalized));
    setAppearance((current) => ({ ...current, fontSizePx: normalized }));
  }, []);

  const setOutputThinkingFontSizeOffsetPx = useCallback((offsetPx: number) => {
    const normalized = normalizeThinkingFontSizeOffset(offsetPx);
    localStorage.setItem(
      UI_KEYS.outputProseThinkingFontSizeOffset,
      String(normalized),
    );
    setAppearance((current) => ({
      ...current,
      thinkingFontSizeOffsetPx: normalized,
    }));
  }, []);

  const setOutputMathFontSizeOffsetPx = useCallback((offsetPx: number) => {
    const normalized = normalizeMathFontSizeOffset(offsetPx);
    localStorage.setItem(
      UI_KEYS.outputProseMathFontSizeOffset,
      String(normalized),
    );
    setAppearance((current) => ({
      ...current,
      mathFontSizeOffsetPx: normalized,
    }));
  }, []);

  const setOutputLineSpacingPercent = useCallback(
    (lineSpacingPercent: number) => {
      const normalized = normalizeLineSpacingPercent(lineSpacingPercent);
      localStorage.setItem(
        UI_KEYS.outputProseLineSpacingPercent,
        String(normalized),
      );
      setAppearance((current) => ({
        ...current,
        lineSpacingPercent: normalized,
      }));
    },
    [],
  );

  const setOutputVerticalSpacingPercent = useCallback(
    (verticalSpacingPercent: number) => {
      const normalized = normalizeVerticalSpacingPercent(
        verticalSpacingPercent,
      );
      localStorage.setItem(
        UI_KEYS.outputProseVerticalSpacingPercent,
        String(normalized),
      );
      setAppearance((current) => ({
        ...current,
        verticalSpacingPercent: normalized,
      }));
    },
    [],
  );

  return {
    outputFont: appearance.font,
    outputFontSizePx: appearance.fontSizePx,
    outputThinkingFontSizeOffsetPx: appearance.thinkingFontSizeOffsetPx,
    outputMathFontSizeOffsetPx: appearance.mathFontSizeOffsetPx,
    outputLineSpacingPercent: appearance.lineSpacingPercent,
    outputVerticalSpacingPercent: appearance.verticalSpacingPercent,
    setOutputFont,
    setOutputFontSizePx,
    setOutputThinkingFontSizeOffsetPx,
    setOutputMathFontSizeOffsetPx,
    setOutputLineSpacingPercent,
    setOutputVerticalSpacingPercent,
  };
}

export function initializeOutputAppearance() {
  applyOutputAppearance(loadOutputAppearance());
}
