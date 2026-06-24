import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ThinkingText } from "../../components/ThinkingText";
import { renderFixedFontMath } from "../../components/ui/FixedFontMathToggle";
import {
  DEFAULT_CONTENT_MAX_WIDTH_PX,
  MAX_CONTENT_MAX_WIDTH_PX,
  MIN_CONTENT_MAX_WIDTH_PX,
  useContentMaxWidth,
} from "../../hooks/useContentMaxWidth";
import {
  DEFAULT_HOVERCARD_MAX_HEIGHT_PX,
  DEFAULT_HOVERCARD_SHOW_DELAY_MS,
  HOVERCARD_MAX_HEIGHT_MAX_PX,
  HOVERCARD_MAX_HEIGHT_MIN_PX,
  HOVERCARD_MAX_HEIGHT_STEP_PX,
  HOVERCARD_SHOW_DELAY_MAX_MS,
  HOVERCARD_SHOW_DELAY_MIN_MS,
  HOVERCARD_SHOW_DELAY_STEP_MS,
  useHoverCardAppearance,
} from "../../hooks/useHoverCardAppearance";
import { estimateHoverCardPromptLines } from "../../components/sessionHoverCardLines";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useAlwaysShowQuoteCircles } from "../../hooks/useAlwaysShowQuoteCircles";
import { useFloatingActionButtonEnabled } from "../../hooks/useFloatingActionButtonEnabled";
import { FONT_SIZES, useFontSize } from "../../hooks/useFontSize";
import { useFunPhrases } from "../../hooks/useFunPhrases";
import { useInlineMedia } from "../../hooks/useInlineMedia";
import {
  DEFAULT_OUTPUT_FIXED_FONT_SIZE_OFFSET_PX,
  DEFAULT_OUTPUT_FONT_SIZE_PX,
  DEFAULT_OUTPUT_LINE_SPACING_PERCENT,
  DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX,
  DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX,
  DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT,
  DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT,
  OUTPUT_FIXED_FONT_SIZE_OFFSET_MAX_PX,
  OUTPUT_FIXED_FONT_SIZE_OFFSET_MIN_PX,
  OUTPUT_FIXED_FONT_SIZE_OFFSET_STEP_PX,
  OUTPUT_FIXED_FONTS,
  OUTPUT_FONT_SIZE_MAX_PX,
  OUTPUT_FONT_SIZE_MIN_PX,
  OUTPUT_FONT_SIZE_PRESETS,
  OUTPUT_FONT_SIZE_STEP_PX,
  OUTPUT_LINE_SPACING_MAX_PERCENT,
  OUTPUT_LINE_SPACING_MIN_PERCENT,
  OUTPUT_LINE_SPACING_STEP_PERCENT,
  OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX,
  OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX,
  OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX,
  OUTPUT_PROSE_FONTS,
  OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX,
  OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX,
  OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX,
  OUTPUT_TOOL_PREVIEW_LINE_COUNT_MAX,
  OUTPUT_TOOL_PREVIEW_LINE_COUNT_MIN,
  OUTPUT_TOOL_PREVIEW_LINE_COUNT_STEP,
  OUTPUT_VERTICAL_SPACING_MAX_PERCENT,
  OUTPUT_VERTICAL_SPACING_MIN_PERCENT,
  OUTPUT_VERTICAL_SPACING_STEP_PERCENT,
  useOutputAppearance,
} from "../../hooks/useOutputAppearance";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import {
  SETTINGS_ICON_STYLES,
  type SettingsIconStyle,
  useSettingsIconStyle,
} from "../../hooks/useSettingsIconStyle";
import { useStableToolPreviewRendering } from "../../hooks/useStableToolPreviewRendering";
import { useStreamingEnabled } from "../../hooks/useStreamingEnabled";
import { TAB_SIZES, useTabSize } from "../../hooks/useTabSize";
import { useTabTitleActivityPreference } from "../../hooks/useTabTitleActivityPreference";
import { THEMES, useTheme } from "../../hooks/useTheme";
import { SUPPORTED_LOCALES, useI18n } from "../../i18n";
import {
  getFontSizeLabel,
  getLocaleLabel,
  getOutputFixedFontLabel,
  getOutputProseFontLabel,
  getTabSizeLabel,
  getThemeLabel,
} from "../../i18n-settings";
import {
  settingsCategoryEmojiIcons,
  settingsCategoryIcons,
} from "./SettingsCategoryIcons";

const OUTPUT_INLINE_MATH_SAMPLE = "$E=mc^2$";

function formatNumberSetting(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function getSettingsIconStyleLabel(
  value: SettingsIconStyle,
  translate: (key: string) => string,
): string {
  switch (value) {
    case "flat":
      return translate("appearanceSettingsIconStyleFlat");
    case "flat-white":
      return translate("appearanceSettingsIconStyleFlatWhite");
    case "emoji":
      return translate("appearanceSettingsIconStyleEmoji");
  }
}

export function AppearanceSettings() {
  const { locale, setLocale, t } = useI18n();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { fontSize, setFontSize } = useFontSize();
  const {
    outputFont,
    outputFontSizePx,
    outputFixedFont,
    outputFixedFontSizeOffsetPx,
    outputThinkingFontSizeOffsetPx,
    outputMathFontSizeOffsetPx,
    outputLineSpacingPercent,
    outputVerticalSpacingPercent,
    outputToolPreviewLineCount,
    setOutputFont,
    setOutputFontSizePx,
    setOutputFixedFont,
    setOutputFixedFontSizeOffsetPx,
    setOutputThinkingFontSizeOffsetPx,
    setOutputMathFontSizeOffsetPx,
    setOutputLineSpacingPercent,
    setOutputVerticalSpacingPercent,
    setOutputToolPreviewLineCount,
    resetOutputAppearance,
  } = useOutputAppearance();
  const { tabSize, setTabSize } = useTabSize();
  const { contentMaxWidth, setContentMaxWidth } = useContentMaxWidth();
  const {
    hoverCardShowDelayMs,
    hoverCardMaxHeightPx,
    setHoverCardShowDelayMs,
    setHoverCardMaxHeightPx,
  } = useHoverCardAppearance();
  // Estimated visible request lines at the chosen height. Uses the with-reply
  // case — the conservative estimate shown when a recent reply is also present.
  const hoverCardHeightLines = estimateHoverCardPromptLines(
    hoverCardMaxHeightPx,
    true,
  );
  const [contentMaxWidthDraft, setContentMaxWidthDraft] = useState(() =>
    String(contentMaxWidth),
  );
  const [hoverCardDelayDraft, setHoverCardDelayDraft] = useState(() =>
    String(hoverCardShowDelayMs),
  );
  const [hoverCardHeightDraft, setHoverCardHeightDraft] = useState(() =>
    String(hoverCardMaxHeightPx),
  );
  const [outputFontSizeDraft, setOutputFontSizeDraft] = useState(() =>
    formatNumberSetting(outputFontSizePx),
  );
  const [outputFixedFontSizeOffsetDraft, setOutputFixedFontSizeOffsetDraft] =
    useState(() => formatNumberSetting(outputFixedFontSizeOffsetPx));
  const [
    outputThinkingFontSizeOffsetDraft,
    setOutputThinkingFontSizeOffsetDraft,
  ] = useState(() => formatNumberSetting(outputThinkingFontSizeOffsetPx));
  const [outputMathFontSizeOffsetDraft, setOutputMathFontSizeOffsetDraft] =
    useState(() => formatNumberSetting(outputMathFontSizeOffsetPx));
  const [outputLineSpacingDraft, setOutputLineSpacingDraft] = useState(() =>
    formatNumberSetting(outputLineSpacingPercent),
  );
  const [outputVerticalSpacingDraft, setOutputVerticalSpacingDraft] = useState(
    () => formatNumberSetting(outputVerticalSpacingPercent),
  );
  const [outputToolPreviewLineCountDraft, setOutputToolPreviewLineCountDraft] =
    useState(() => formatNumberSetting(outputToolPreviewLineCount));
  const { theme, setTheme } = useTheme();
  const { settingsIconStyle, setSettingsIconStyle } = useSettingsIconStyle();
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const { stableToolPreviewRendering, setStableToolPreviewRendering } =
    useStableToolPreviewRendering();
  const { inlineMediaExpandedByDefault, setInlineMediaExpandedByDefault } =
    useInlineMedia();
  const { alwaysShowQuoteCircles, setAlwaysShowQuoteCircles } =
    useAlwaysShowQuoteCircles();
  const { funPhrasesEnabled, setFunPhrasesEnabled } = useFunPhrases();
  const { floatingActionButtonEnabled, setFloatingActionButtonEnabled } =
    useFloatingActionButtonEnabled();
  const { tabTitleActivityEnabled, setTabTitleActivityEnabled } =
    useTabTitleActivityPreference();
  const { showConnectionBars, setShowConnectionBars } = useDeveloperMode();
  const outputInlineMathHtml = useMemo(
    () => renderFixedFontMath(OUTPUT_INLINE_MATH_SAMPLE).html,
    [],
  );
  // Header undo: snapshot every appearance value at pane open; restore sets
  // each preference and re-syncs the numeric draft fields.
  const undoState = useMemo(
    () => ({
      locale,
      fontSize,
      outputFont,
      outputFontSizePx,
      outputFixedFont,
      outputFixedFontSizeOffsetPx,
      outputThinkingFontSizeOffsetPx,
      outputMathFontSizeOffsetPx,
      outputLineSpacingPercent,
      outputVerticalSpacingPercent,
      outputToolPreviewLineCount,
      tabSize,
      contentMaxWidth,
      hoverCardShowDelayMs,
      hoverCardMaxHeightPx,
      theme,
      settingsIconStyle,
      streamingEnabled,
      stableToolPreviewRendering,
      inlineMediaExpandedByDefault,
      alwaysShowQuoteCircles,
      funPhrasesEnabled,
      floatingActionButtonEnabled,
      tabTitleActivityEnabled,
      showConnectionBars,
    }),
    [
      locale,
      fontSize,
      outputFont,
      outputFontSizePx,
      outputFixedFont,
      outputFixedFontSizeOffsetPx,
      outputThinkingFontSizeOffsetPx,
      outputMathFontSizeOffsetPx,
      outputLineSpacingPercent,
      outputVerticalSpacingPercent,
      outputToolPreviewLineCount,
      tabSize,
      contentMaxWidth,
      hoverCardShowDelayMs,
      hoverCardMaxHeightPx,
      theme,
      settingsIconStyle,
      streamingEnabled,
      stableToolPreviewRendering,
      inlineMediaExpandedByDefault,
      alwaysShowQuoteCircles,
      funPhrasesEnabled,
      floatingActionButtonEnabled,
      tabTitleActivityEnabled,
      showConnectionBars,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      setLocale(snapshot.locale);
      setFontSize(snapshot.fontSize);
      setOutputFont(snapshot.outputFont);
      setOutputFontSizePx(snapshot.outputFontSizePx);
      setOutputFixedFont(snapshot.outputFixedFont);
      setOutputFixedFontSizeOffsetPx(snapshot.outputFixedFontSizeOffsetPx);
      setOutputThinkingFontSizeOffsetPx(
        snapshot.outputThinkingFontSizeOffsetPx,
      );
      setOutputMathFontSizeOffsetPx(snapshot.outputMathFontSizeOffsetPx);
      setOutputLineSpacingPercent(snapshot.outputLineSpacingPercent);
      setOutputVerticalSpacingPercent(snapshot.outputVerticalSpacingPercent);
      setOutputToolPreviewLineCount(snapshot.outputToolPreviewLineCount);
      setTabSize(snapshot.tabSize);
      setContentMaxWidth(snapshot.contentMaxWidth);
      setHoverCardShowDelayMs(snapshot.hoverCardShowDelayMs);
      setHoverCardMaxHeightPx(snapshot.hoverCardMaxHeightPx);
      setTheme(snapshot.theme);
      setSettingsIconStyle(snapshot.settingsIconStyle);
      setStreamingEnabled(snapshot.streamingEnabled);
      setStableToolPreviewRendering(snapshot.stableToolPreviewRendering);
      setInlineMediaExpandedByDefault(snapshot.inlineMediaExpandedByDefault);
      setAlwaysShowQuoteCircles(snapshot.alwaysShowQuoteCircles);
      setFunPhrasesEnabled(snapshot.funPhrasesEnabled);
      setFloatingActionButtonEnabled(snapshot.floatingActionButtonEnabled);
      setTabTitleActivityEnabled(snapshot.tabTitleActivityEnabled);
      setShowConnectionBars(snapshot.showConnectionBars);
      setContentMaxWidthDraft(String(snapshot.contentMaxWidth));
      setHoverCardDelayDraft(String(snapshot.hoverCardShowDelayMs));
      setHoverCardHeightDraft(String(snapshot.hoverCardMaxHeightPx));
      setOutputFontSizeDraft(formatNumberSetting(snapshot.outputFontSizePx));
      setOutputFixedFontSizeOffsetDraft(
        formatNumberSetting(snapshot.outputFixedFontSizeOffsetPx),
      );
      setOutputThinkingFontSizeOffsetDraft(
        formatNumberSetting(snapshot.outputThinkingFontSizeOffsetPx),
      );
      setOutputMathFontSizeOffsetDraft(
        formatNumberSetting(snapshot.outputMathFontSizeOffsetPx),
      );
      setOutputLineSpacingDraft(
        formatNumberSetting(snapshot.outputLineSpacingPercent),
      );
      setOutputVerticalSpacingDraft(
        formatNumberSetting(snapshot.outputVerticalSpacingPercent),
      );
      setOutputToolPreviewLineCountDraft(
        formatNumberSetting(snapshot.outputToolPreviewLineCount),
      );
    },
    [
      setLocale,
      setFontSize,
      setOutputFont,
      setOutputFontSizePx,
      setOutputFixedFont,
      setOutputFixedFontSizeOffsetPx,
      setOutputThinkingFontSizeOffsetPx,
      setOutputMathFontSizeOffsetPx,
      setOutputLineSpacingPercent,
      setOutputVerticalSpacingPercent,
      setOutputToolPreviewLineCount,
      setTabSize,
      setContentMaxWidth,
      setHoverCardShowDelayMs,
      setHoverCardMaxHeightPx,
      setTheme,
      setSettingsIconStyle,
      setStreamingEnabled,
      setStableToolPreviewRendering,
      setInlineMediaExpandedByDefault,
      setAlwaysShowQuoteCircles,
      setFunPhrasesEnabled,
      setFloatingActionButtonEnabled,
      setTabTitleActivityEnabled,
      setShowConnectionBars,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const translate = (key: string) => t(key as never);

  useEffect(() => {
    setContentMaxWidthDraft(String(contentMaxWidth));
  }, [contentMaxWidth]);

  useEffect(() => {
    setHoverCardDelayDraft(String(hoverCardShowDelayMs));
  }, [hoverCardShowDelayMs]);

  useEffect(() => {
    setHoverCardHeightDraft(String(hoverCardMaxHeightPx));
  }, [hoverCardMaxHeightPx]);

  useEffect(() => {
    setOutputFontSizeDraft(formatNumberSetting(outputFontSizePx));
  }, [outputFontSizePx]);

  useEffect(() => {
    setOutputFixedFontSizeOffsetDraft(
      formatNumberSetting(outputFixedFontSizeOffsetPx),
    );
  }, [outputFixedFontSizeOffsetPx]);

  useEffect(() => {
    setOutputThinkingFontSizeOffsetDraft(
      formatNumberSetting(outputThinkingFontSizeOffsetPx),
    );
  }, [outputThinkingFontSizeOffsetPx]);

  useEffect(() => {
    setOutputMathFontSizeOffsetDraft(
      formatNumberSetting(outputMathFontSizeOffsetPx),
    );
  }, [outputMathFontSizeOffsetPx]);

  useEffect(() => {
    setOutputLineSpacingDraft(formatNumberSetting(outputLineSpacingPercent));
  }, [outputLineSpacingPercent]);

  useEffect(() => {
    setOutputVerticalSpacingDraft(
      formatNumberSetting(outputVerticalSpacingPercent),
    );
  }, [outputVerticalSpacingPercent]);

  useEffect(() => {
    setOutputToolPreviewLineCountDraft(
      formatNumberSetting(outputToolPreviewLineCount),
    );
  }, [outputToolPreviewLineCount]);

  const commitContentMaxWidth = () => {
    const parsed = Number.parseInt(contentMaxWidthDraft, 10);
    setContentMaxWidth(
      Number.isFinite(parsed) ? parsed : DEFAULT_CONTENT_MAX_WIDTH_PX,
    );
  };

  const commitHoverCardDelay = () => {
    const parsed = Number(hoverCardDelayDraft);
    setHoverCardShowDelayMs(
      Number.isFinite(parsed) ? parsed : DEFAULT_HOVERCARD_SHOW_DELAY_MS,
    );
  };

  const commitHoverCardHeight = () => {
    const parsed = Number(hoverCardHeightDraft);
    setHoverCardMaxHeightPx(
      Number.isFinite(parsed) ? parsed : DEFAULT_HOVERCARD_MAX_HEIGHT_PX,
    );
  };

  const commitOutputFontSize = () => {
    const parsed = Number(outputFontSizeDraft);
    setOutputFontSizePx(
      Number.isFinite(parsed) ? parsed : DEFAULT_OUTPUT_FONT_SIZE_PX,
    );
  };

  const commitOutputFixedFontSizeOffset = () => {
    const parsed = Number(outputFixedFontSizeOffsetDraft);
    setOutputFixedFontSizeOffsetPx(
      Number.isFinite(parsed)
        ? parsed
        : DEFAULT_OUTPUT_FIXED_FONT_SIZE_OFFSET_PX,
    );
  };

  const commitOutputThinkingFontSizeOffset = () => {
    const parsed = Number(outputThinkingFontSizeOffsetDraft);
    setOutputThinkingFontSizeOffsetPx(
      Number.isFinite(parsed)
        ? parsed
        : DEFAULT_OUTPUT_THINKING_FONT_SIZE_OFFSET_PX,
    );
  };

  const commitOutputMathFontSizeOffset = () => {
    const parsed = Number(outputMathFontSizeOffsetDraft);
    setOutputMathFontSizeOffsetPx(
      Number.isFinite(parsed)
        ? parsed
        : DEFAULT_OUTPUT_MATH_FONT_SIZE_OFFSET_PX,
    );
  };

  const commitOutputLineSpacing = () => {
    const parsed = Number(outputLineSpacingDraft);
    setOutputLineSpacingPercent(
      Number.isFinite(parsed) ? parsed : DEFAULT_OUTPUT_LINE_SPACING_PERCENT,
    );
  };

  const commitOutputVerticalSpacing = () => {
    const parsed = Number(outputVerticalSpacingDraft);
    setOutputVerticalSpacingPercent(
      Number.isFinite(parsed)
        ? parsed
        : DEFAULT_OUTPUT_VERTICAL_SPACING_PERCENT,
    );
  };

  const commitOutputToolPreviewLineCount = () => {
    const parsed = Number(outputToolPreviewLineCountDraft);
    setOutputToolPreviewLineCount(
      Number.isFinite(parsed) ? parsed : DEFAULT_OUTPUT_TOOL_PREVIEW_LINE_COUNT,
    );
  };

  return (
    <section className="settings-section">
      <h2>{t("appearanceSectionTitle")}</h2>
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceLanguageTitle")}</strong>
            <p>{t("appearanceLanguageDescription")}</p>
          </div>
          <select
            className="settings-select"
            value={locale}
            onChange={(e) =>
              setLocale(e.target.value as (typeof SUPPORTED_LOCALES)[number])
            }
            aria-label={t("appearanceLanguageTitle")}
          >
            {SUPPORTED_LOCALES.map((value) => (
              <option key={value} value={value}>
                {getLocaleLabel(value, translate)}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceThemeTitle")}</strong>
          </div>
          <div className="font-size-selector">
            {THEMES.map((themeValue) => (
              <button
                key={themeValue}
                type="button"
                className={`font-size-option ${theme === themeValue ? "active" : ""}`}
                onClick={() => setTheme(themeValue)}
              >
                {getThemeLabel(themeValue, translate)}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceFontSizeTitle")}</strong>
          </div>
          <div className="font-size-selector">
            {FONT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={`font-size-option ${fontSize === size ? "active" : ""}`}
                onClick={() => setFontSize(size)}
              >
                {getFontSizeLabel(size, translate)}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceSettingsIconStyleTitle")}</strong>
            <p>{t("appearanceSettingsIconStyleDescription")}</p>
          </div>
          <div
            className="font-size-selector settings-icon-style-selector"
            role="group"
            aria-label={t("appearanceSettingsIconStyleTitle")}
          >
            {SETTINGS_ICON_STYLES.map((style) => {
              const selected = settingsIconStyle === style;
              const preview =
                style === "emoji"
                  ? settingsCategoryEmojiIcons["local-access"]
                  : settingsCategoryIcons["local-access"];
              return (
                <button
                  key={style}
                  type="button"
                  className={`font-size-option settings-icon-style-option ${selected ? "active" : ""}`}
                  onClick={() => setSettingsIconStyle(style)}
                  aria-pressed={selected}
                >
                  <span
                    className={`settings-category-icon settings-category-icon-local-access settings-category-icon-${style} settings-icon-style-preview`}
                    aria-hidden="true"
                  >
                    {preview}
                  </span>
                  <span>{getSettingsIconStyleLabel(style, translate)}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceToolbarSettingsShortcutTitle")}</strong>
            <p>{t("appearanceToolbarSettingsShortcutDescription")}</p>
          </div>
          <div className="settings-item-actions">
            <button
              type="button"
              className="settings-button"
              onClick={() => navigate(`${basePath}/settings/toolbar`)}
            >
              {t("appearanceToolbarSettingsShortcutAction")}
            </button>
          </div>
        </div>
        <div className="settings-item output-appearance-settings">
          <div className="output-appearance-panel">
            <div className="output-appearance-controls">
              <div className="output-appearance-title settings-item-info">
                <strong>{t("appearanceOutputTypographyTitle")}</strong>
              </div>
              <div className="output-appearance-control">
                <span className="output-appearance-label">
                  {t("appearanceOutputFontLabel")}
                </span>
                <div className="font-size-selector output-font-selector">
                  {OUTPUT_PROSE_FONTS.map((font) => (
                    <button
                      key={font}
                      type="button"
                      className={`font-size-option output-font-option output-font-option-${font} ${outputFont === font ? "active" : ""}`}
                      onClick={() => setOutputFont(font)}
                    >
                      {getOutputProseFontLabel(font, translate)}
                    </button>
                  ))}
                </div>
              </div>

              <label
                className="output-appearance-control"
                htmlFor="output-font-size"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputFontSizeLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <input
                    id="output-font-size"
                    type="range"
                    min={OUTPUT_FONT_SIZE_MIN_PX}
                    max={OUTPUT_FONT_SIZE_MAX_PX}
                    step={OUTPUT_FONT_SIZE_STEP_PX}
                    value={outputFontSizePx}
                    list="output-font-size-presets"
                    onChange={(e) =>
                      setOutputFontSizePx(Number(e.target.value))
                    }
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_FONT_SIZE_MIN_PX}
                      max={OUTPUT_FONT_SIZE_MAX_PX}
                      step={OUTPUT_FONT_SIZE_STEP_PX}
                      value={outputFontSizeDraft}
                      onChange={(e) => setOutputFontSizeDraft(e.target.value)}
                      onBlur={commitOutputFontSize}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputFontSize();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputFontSizeLabel")}
                    />
                    <span className="output-appearance-unit">px</span>
                  </span>
                </span>
              </label>
              <datalist id="output-font-size-presets">
                {OUTPUT_FONT_SIZE_PRESETS.map((preset) => (
                  <option
                    key={preset.value}
                    value={preset.value}
                    label={preset.label}
                  />
                ))}
              </datalist>

              <label
                className="output-appearance-control"
                htmlFor="output-thinking-size-offset"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputThinkingSizeOffsetLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <input
                    id="output-thinking-size-offset"
                    type="range"
                    min={OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX}
                    max={OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX}
                    step={OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX}
                    value={outputThinkingFontSizeOffsetPx}
                    onChange={(e) =>
                      setOutputThinkingFontSizeOffsetPx(Number(e.target.value))
                    }
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_THINKING_FONT_SIZE_OFFSET_MIN_PX}
                      max={OUTPUT_THINKING_FONT_SIZE_OFFSET_MAX_PX}
                      step={OUTPUT_THINKING_FONT_SIZE_OFFSET_STEP_PX}
                      value={outputThinkingFontSizeOffsetDraft}
                      onChange={(e) =>
                        setOutputThinkingFontSizeOffsetDraft(e.target.value)
                      }
                      onBlur={commitOutputThinkingFontSizeOffset}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputThinkingFontSizeOffset();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputThinkingSizeOffsetLabel")}
                    />
                    <span className="output-appearance-unit">px</span>
                  </span>
                </span>
              </label>

              <div className="output-appearance-control">
                <span className="output-appearance-label">
                  {t("appearanceOutputFixedFontLabel")}
                </span>
                <div className="font-size-selector output-font-selector">
                  {OUTPUT_FIXED_FONTS.map((font) => (
                    <button
                      key={font}
                      type="button"
                      className={`font-size-option output-font-option output-fixed-font-option-${font} ${outputFixedFont === font ? "active" : ""}`}
                      onClick={() => setOutputFixedFont(font)}
                    >
                      {getOutputFixedFontLabel(font, translate)}
                    </button>
                  ))}
                </div>
              </div>

              <label
                className="output-appearance-control"
                htmlFor="output-fixed-size-offset"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputFixedSizeOffsetLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <input
                    id="output-fixed-size-offset"
                    type="range"
                    min={OUTPUT_FIXED_FONT_SIZE_OFFSET_MIN_PX}
                    max={OUTPUT_FIXED_FONT_SIZE_OFFSET_MAX_PX}
                    step={OUTPUT_FIXED_FONT_SIZE_OFFSET_STEP_PX}
                    value={outputFixedFontSizeOffsetPx}
                    onChange={(e) =>
                      setOutputFixedFontSizeOffsetPx(Number(e.target.value))
                    }
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_FIXED_FONT_SIZE_OFFSET_MIN_PX}
                      max={OUTPUT_FIXED_FONT_SIZE_OFFSET_MAX_PX}
                      step={OUTPUT_FIXED_FONT_SIZE_OFFSET_STEP_PX}
                      value={outputFixedFontSizeOffsetDraft}
                      onChange={(e) =>
                        setOutputFixedFontSizeOffsetDraft(e.target.value)
                      }
                      onBlur={commitOutputFixedFontSizeOffset}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputFixedFontSizeOffset();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputFixedSizeOffsetLabel")}
                    />
                    <span className="output-appearance-unit">px</span>
                  </span>
                </span>
              </label>

              <label
                className="output-appearance-control"
                htmlFor="output-math-size-offset"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputMathSizeOffsetLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <input
                    id="output-math-size-offset"
                    type="range"
                    min={OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX}
                    max={OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX}
                    step={OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX}
                    value={outputMathFontSizeOffsetPx}
                    onChange={(e) =>
                      setOutputMathFontSizeOffsetPx(Number(e.target.value))
                    }
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_MATH_FONT_SIZE_OFFSET_MIN_PX}
                      max={OUTPUT_MATH_FONT_SIZE_OFFSET_MAX_PX}
                      step={OUTPUT_MATH_FONT_SIZE_OFFSET_STEP_PX}
                      value={outputMathFontSizeOffsetDraft}
                      onChange={(e) =>
                        setOutputMathFontSizeOffsetDraft(e.target.value)
                      }
                      onBlur={commitOutputMathFontSizeOffset}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputMathFontSizeOffset();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputMathSizeOffsetLabel")}
                    />
                    <span className="output-appearance-unit">px</span>
                  </span>
                </span>
              </label>

              <label
                className="output-appearance-control"
                htmlFor="output-line-spacing"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputLineSpacingLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <input
                    id="output-line-spacing"
                    type="range"
                    min={OUTPUT_LINE_SPACING_MIN_PERCENT}
                    max={OUTPUT_LINE_SPACING_MAX_PERCENT}
                    step={OUTPUT_LINE_SPACING_STEP_PERCENT}
                    value={outputLineSpacingPercent}
                    onChange={(e) =>
                      setOutputLineSpacingPercent(Number(e.target.value))
                    }
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_LINE_SPACING_MIN_PERCENT}
                      max={OUTPUT_LINE_SPACING_MAX_PERCENT}
                      step={OUTPUT_LINE_SPACING_STEP_PERCENT}
                      value={outputLineSpacingDraft}
                      onChange={(e) =>
                        setOutputLineSpacingDraft(e.target.value)
                      }
                      onBlur={commitOutputLineSpacing}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputLineSpacing();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputLineSpacingLabel")}
                    />
                    <span className="output-appearance-unit">%</span>
                  </span>
                </span>
              </label>

              <label
                className="output-appearance-control"
                htmlFor="output-vertical-spacing"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputVerticalSpacingLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <input
                    id="output-vertical-spacing"
                    type="range"
                    min={OUTPUT_VERTICAL_SPACING_MIN_PERCENT}
                    max={OUTPUT_VERTICAL_SPACING_MAX_PERCENT}
                    step={OUTPUT_VERTICAL_SPACING_STEP_PERCENT}
                    value={outputVerticalSpacingPercent}
                    onChange={(e) =>
                      setOutputVerticalSpacingPercent(Number(e.target.value))
                    }
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_VERTICAL_SPACING_MIN_PERCENT}
                      max={OUTPUT_VERTICAL_SPACING_MAX_PERCENT}
                      step={OUTPUT_VERTICAL_SPACING_STEP_PERCENT}
                      value={outputVerticalSpacingDraft}
                      onChange={(e) =>
                        setOutputVerticalSpacingDraft(e.target.value)
                      }
                      onBlur={commitOutputVerticalSpacing}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputVerticalSpacing();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputVerticalSpacingLabel")}
                    />
                    <span className="output-appearance-unit">%</span>
                  </span>
                </span>
              </label>

              <label
                className="output-appearance-control"
                htmlFor="output-tool-preview-lines"
              >
                <span className="output-appearance-label">
                  {t("appearanceOutputToolPreviewLinesLabel")}
                </span>
                <span className="output-appearance-slider-row">
                  <input
                    id="output-tool-preview-lines"
                    type="range"
                    min={OUTPUT_TOOL_PREVIEW_LINE_COUNT_MIN}
                    max={OUTPUT_TOOL_PREVIEW_LINE_COUNT_MAX}
                    step={OUTPUT_TOOL_PREVIEW_LINE_COUNT_STEP}
                    value={outputToolPreviewLineCount}
                    onChange={(e) =>
                      setOutputToolPreviewLineCount(Number(e.target.value))
                    }
                  />
                  <span className="output-appearance-number-wrap">
                    <input
                      type="number"
                      className="settings-input-small output-appearance-number"
                      min={OUTPUT_TOOL_PREVIEW_LINE_COUNT_MIN}
                      max={OUTPUT_TOOL_PREVIEW_LINE_COUNT_MAX}
                      step={OUTPUT_TOOL_PREVIEW_LINE_COUNT_STEP}
                      value={outputToolPreviewLineCountDraft}
                      onChange={(e) =>
                        setOutputToolPreviewLineCountDraft(e.target.value)
                      }
                      onBlur={commitOutputToolPreviewLineCount}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitOutputToolPreviewLineCount();
                          e.currentTarget.blur();
                        }
                      }}
                      aria-label={t("appearanceOutputToolPreviewLinesLabel")}
                    />
                    <span className="output-appearance-unit">
                      {t("appearanceOutputToolPreviewLinesUnit")}
                    </span>
                  </span>
                </span>
              </label>
            </div>

            <div className="output-appearance-specimen">
              <div className="output-appearance-specimen-header">
                <span className="output-appearance-specimen-label">
                  {t("appearanceOutputSpecimenLabel")}
                </span>
                <button
                  type="button"
                  className="settings-button settings-button-secondary"
                  onClick={resetOutputAppearance}
                >
                  {t("appearanceOutputTypographyReset")}
                </button>
              </div>
              <div
                className="output-appearance-preview"
                role="region"
                aria-label={t("appearanceOutputPreviewLabel")}
              >
                <div className="output-preview-system">
                  <span className="output-preview-system-icon">ok</span>
                  <span>System note: applied after reconnect.</span>
                </div>
                <div className="output-preview-prose">
                  <p>
                    Inline code like <code>codex update</code> stays fixed
                    width; prose wraps at phone width.
                  </p>
                  <pre className="output-preview-fixed">
                    <code>
                      {'> grep -n "needle" src\n+ ASCII stays aligned'}
                    </code>
                  </pre>
                  <p>
                    Inline math:{" "}
                    <span
                      className="output-preview-math"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is generated from a static settings preview sample
                      dangerouslySetInnerHTML={{ __html: outputInlineMathHtml }}
                    />
                  </p>
                  <ul>
                    <li>
                      Tokens: <code>fixed width</code>
                    </li>
                    <li>Math uses a TeX-like face.</li>
                  </ul>
                </div>
                <div className="output-preview-thinking thinking-content">
                  <ThinkingText text="**Spacing** — thinking text stays quieter and smaller." />
                </div>
                <div className="output-preview-diff" aria-hidden="true">
                  <div>
                    <span className="output-preview-diff-gutter">+</span>
                    <span>Diff prose follows the output font.</span>
                  </div>
                  <div>
                    <span className="output-preview-diff-gutter">-</span>
                    <span>Paragraph space can be dialed down.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceTabSizeTitle")}</strong>
            <p>{t("appearanceTabSizeDescription")}</p>
          </div>
          <div className="font-size-selector">
            {TAB_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={`font-size-option ${tabSize === size ? "active" : ""}`}
                onClick={() => setTabSize(size)}
              >
                {getTabSizeLabel(size)}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceContentWidthTitle")}</strong>
            <p>{t("appearanceContentWidthDescription")}</p>
          </div>
          <div className="settings-item-actions">
            <input
              type="range"
              min={MIN_CONTENT_MAX_WIDTH_PX}
              max={MAX_CONTENT_MAX_WIDTH_PX}
              step={10}
              value={contentMaxWidth}
              onChange={(e) => setContentMaxWidth(Number(e.target.value))}
              aria-label={t("appearanceContentWidthTitle")}
            />
            <span className="settings-input-unit">
              <input
                type="number"
                className="settings-input-small"
                min={MIN_CONTENT_MAX_WIDTH_PX}
                max={MAX_CONTENT_MAX_WIDTH_PX}
                step={10}
                value={contentMaxWidthDraft}
                onChange={(e) => setContentMaxWidthDraft(e.target.value)}
                onBlur={commitContentMaxWidth}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitContentMaxWidth();
                    e.currentTarget.blur();
                  }
                }}
                aria-label={t("appearanceContentWidthTitle")}
              />
              {t("appearanceContentWidthUnit")}
            </span>
            <button
              type="button"
              className="settings-inline-x"
              onClick={() => {
                setContentMaxWidth(DEFAULT_CONTENT_MAX_WIDTH_PX);
                setContentMaxWidthDraft(String(DEFAULT_CONTENT_MAX_WIDTH_PX));
              }}
              aria-label={t("appearanceContentWidthReset")}
              title={t("appearanceContentWidthReset")}
            >
              ×
            </button>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceHoverCardDelayTitle")}</strong>
            <p>{t("appearanceHoverCardDelayDescription")}</p>
          </div>
          <div className="settings-item-actions">
            <input
              type="range"
              min={HOVERCARD_SHOW_DELAY_MIN_MS}
              max={HOVERCARD_SHOW_DELAY_MAX_MS}
              step={HOVERCARD_SHOW_DELAY_STEP_MS}
              value={hoverCardShowDelayMs}
              onChange={(e) => setHoverCardShowDelayMs(Number(e.target.value))}
              aria-label={t("appearanceHoverCardDelayTitle")}
            />
            <span className="settings-input-unit">
              <input
                type="number"
                className="settings-input-small"
                min={HOVERCARD_SHOW_DELAY_MIN_MS}
                max={HOVERCARD_SHOW_DELAY_MAX_MS}
                step={HOVERCARD_SHOW_DELAY_STEP_MS}
                value={hoverCardDelayDraft}
                onChange={(e) => setHoverCardDelayDraft(e.target.value)}
                onBlur={commitHoverCardDelay}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitHoverCardDelay();
                    e.currentTarget.blur();
                  }
                }}
                aria-label={t("appearanceHoverCardDelayTitle")}
              />
              {t("appearanceHoverCardDelayUnit")}
            </span>
            <button
              type="button"
              className="settings-inline-x"
              onClick={() => {
                setHoverCardShowDelayMs(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
                setHoverCardDelayDraft(String(DEFAULT_HOVERCARD_SHOW_DELAY_MS));
              }}
              aria-label={t("appearanceHoverCardReset")}
              title={t("appearanceHoverCardReset")}
            >
              ×
            </button>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceHoverCardHeightTitle")}</strong>
            <p>{t("appearanceHoverCardHeightDescription")}</p>
          </div>
          <div className="settings-item-actions">
            <input
              type="range"
              min={HOVERCARD_MAX_HEIGHT_MIN_PX}
              max={HOVERCARD_MAX_HEIGHT_MAX_PX}
              step={HOVERCARD_MAX_HEIGHT_STEP_PX}
              value={hoverCardMaxHeightPx}
              onChange={(e) => setHoverCardMaxHeightPx(Number(e.target.value))}
              aria-label={t("appearanceHoverCardHeightTitle")}
            />
            <span className="settings-input-unit">
              <input
                type="number"
                className="settings-input-small"
                min={HOVERCARD_MAX_HEIGHT_MIN_PX}
                max={HOVERCARD_MAX_HEIGHT_MAX_PX}
                step={HOVERCARD_MAX_HEIGHT_STEP_PX}
                value={hoverCardHeightDraft}
                onChange={(e) => setHoverCardHeightDraft(e.target.value)}
                onBlur={commitHoverCardHeight}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitHoverCardHeight();
                    e.currentTarget.blur();
                  }
                }}
                aria-label={t("appearanceHoverCardHeightTitle")}
              />
              {t("appearanceHoverCardHeightUnit")}
            </span>
            <span className="settings-hovercard-lines">
              ({hoverCardHeightLines}{" "}
              {hoverCardHeightLines === 1
                ? t("appearanceHoverCardLineUnit")
                : t("appearanceHoverCardLinesUnit")}
              )
            </span>
            <button
              type="button"
              className="settings-inline-x"
              onClick={() => {
                setHoverCardMaxHeightPx(DEFAULT_HOVERCARD_MAX_HEIGHT_PX);
                setHoverCardHeightDraft(
                  String(DEFAULT_HOVERCARD_MAX_HEIGHT_PX),
                );
              }}
              aria-label={t("appearanceHoverCardReset")}
              title={t("appearanceHoverCardReset")}
            >
              ×
            </button>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceStreamingTitle")}</strong>
            <p>{t("appearanceStreamingDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={streamingEnabled}
              onChange={(e) => setStreamingEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceStableToolPreviewTitle")}</strong>
            <p>{t("appearanceStableToolPreviewDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={stableToolPreviewRendering}
              onChange={(e) => setStableToolPreviewRendering(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceInlineImagesTitle")}</strong>
            <p>{t("appearanceInlineImagesDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={inlineMediaExpandedByDefault}
              onChange={(e) =>
                setInlineMediaExpandedByDefault(e.target.checked)
              }
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceAlwaysShowQuoteCirclesTitle")}</strong>
            <p>{t("appearanceAlwaysShowQuoteCirclesDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={alwaysShowQuoteCircles}
              onChange={(e) => setAlwaysShowQuoteCircles(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceFunPhrasesTitle")}</strong>
            <p>{t("appearanceFunPhrasesDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={funPhrasesEnabled}
              onChange={(e) => setFunPhrasesEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceFloatingActionButtonTitle")}</strong>
            <p>{t("appearanceFloatingActionButtonDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={floatingActionButtonEnabled}
              onChange={(e) => setFloatingActionButtonEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceTabTitleActivityTitle")}</strong>
            <p>{t("appearanceTabTitleActivityDescription")}</p>
          </div>
          <div className="settings-item-actions">
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={tabTitleActivityEnabled}
                onChange={(e) => setTabTitleActivityEnabled(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceConnectionBarsTitle")}</strong>
            <p>{t("appearanceConnectionBarsDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={showConnectionBars}
              onChange={(e) => setShowConnectionBars(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </section>
  );
}
