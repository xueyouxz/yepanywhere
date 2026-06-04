import { useEffect, useState } from "react";
import { SessionToolbarPreview } from "../../components/SessionToolbarPreview";
import { ThinkingText } from "../../components/ThinkingText";
import {
  DEFAULT_CONTENT_MAX_WIDTH_PX,
  MAX_CONTENT_MAX_WIDTH_PX,
  MIN_CONTENT_MAX_WIDTH_PX,
  useContentMaxWidth,
} from "../../hooks/useContentMaxWidth";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
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
import {
  type SessionToolbarVisibilityKey,
  useSessionToolbarVisibility,
} from "../../hooks/useSessionToolbarVisibility";
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

function formatNumberSetting(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

export function AppearanceSettings() {
  const { locale, setLocale, t } = useI18n();
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
  } = useOutputAppearance();
  const { tabSize, setTabSize } = useTabSize();
  const { contentMaxWidth, setContentMaxWidth } = useContentMaxWidth();
  const [contentMaxWidthDraft, setContentMaxWidthDraft] = useState(() =>
    String(contentMaxWidth),
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
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const { stableToolPreviewRendering, setStableToolPreviewRendering } =
    useStableToolPreviewRendering();
  const { inlineMediaExpandedByDefault, setInlineMediaExpandedByDefault } =
    useInlineMedia();
  const { funPhrasesEnabled, setFunPhrasesEnabled } = useFunPhrases();
  const { floatingActionButtonEnabled, setFloatingActionButtonEnabled } =
    useFloatingActionButtonEnabled();
  const { tabTitleActivityEnabled, setTabTitleActivityEnabled } =
    useTabTitleActivityPreference();
  const { showConnectionBars, setShowConnectionBars } = useDeveloperMode();
  const {
    visibility: toolbarVisibility,
    setControlVisible,
    resetVisibility,
  } = useSessionToolbarVisibility();
  const translate = (key: string) => t(key as never);
  const toolbarControls: Array<{
    key: SessionToolbarVisibilityKey;
    title: string;
    description: string;
  }> = [
    {
      key: "modeSelector",
      title: t("appearanceToolbarModeTitle"),
      description: t("appearanceToolbarModeDescription"),
    },
    {
      key: "attachments",
      title: t("appearanceToolbarAttachmentsTitle"),
      description: t("appearanceToolbarAttachmentsDescription"),
    },
    {
      key: "slashMenu",
      title: t("appearanceToolbarSlashTitle"),
      description: t("appearanceToolbarSlashDescription"),
    },
    {
      key: "thinkingToggle",
      title: t("appearanceToolbarThinkingTitle"),
      description: t("appearanceToolbarThinkingDescription"),
    },
    {
      key: "renderMode",
      title: t("appearanceToolbarRenderModeTitle"),
      description: t("appearanceToolbarRenderModeDescription"),
    },
    {
      key: "nudge",
      title: t("appearanceToolbarNudgeTitle"),
      description: t("appearanceToolbarNudgeDescription"),
    },
    {
      key: "microphone",
      title: t("appearanceToolbarMicrophoneTitle"),
      description: t("appearanceToolbarMicrophoneDescription"),
    },
    {
      key: "sessionStatus",
      title: t("appearanceToolbarStatusTitle"),
      description: t("appearanceToolbarStatusDescription"),
    },
    {
      key: "shortcutsHelp",
      title: t("appearanceToolbarShortcutsTitle"),
      description: t("appearanceToolbarShortcutsDescription"),
    },
    {
      key: "contextUsage",
      title: t("appearanceToolbarContextTitle"),
      description: t("appearanceToolbarContextDescription"),
    },
    {
      key: "btw",
      title: t("appearanceToolbarBtwTitle"),
      description: t("appearanceToolbarBtwDescription"),
    },
    {
      key: "queueControls",
      title: t("appearanceToolbarQueueTitle"),
      description: t("appearanceToolbarQueueDescription"),
    },
  ];

  useEffect(() => {
    setContentMaxWidthDraft(String(contentMaxWidth));
  }, [contentMaxWidth]);

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
            <p>{t("appearanceThemeDescription")}</p>
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
            <p>{t("appearanceFontSizeDescription")}</p>
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
        <div className="settings-item output-appearance-settings">
          <div className="settings-item-info">
            <strong>{t("appearanceOutputTypographyTitle")}</strong>
            <p>{t("appearanceOutputTypographyDescription")}</p>
          </div>

          <div className="output-appearance-panel">
            <div className="output-appearance-controls">
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
              <div className="output-appearance-specimen-label">
                {t("appearanceOutputSpecimenLabel")}
              </div>
              <div
                className="output-appearance-preview"
                role="region"
                aria-label={t("appearanceOutputPreviewLabel")}
              >
                <div className="output-preview-system">
                  <span className="output-preview-system-icon">ok</span>
                  <span>
                    System note: provider configuration was applied after the
                    session reconnected.
                  </span>
                </div>
                <div className="output-preview-prose">
                  <p>
                    Inline code such as <code>codex update</code> stays fixed
                    width. The specimen is deliberately phone-width so font,
                    spacing, and Markdown rendering can be judged after a
                    natural line wrap.
                  </p>
                  <pre className="output-preview-fixed">
                    <code>
                      {
                        '> grep -n "needle" packages/client/src\n+ fixed-width ASCII stays aligned'
                      }
                    </code>
                  </pre>
                  <p>
                    Inline math:{" "}
                    <span className="output-preview-math">f(x) = 100%</span>
                  </p>
                  <p>Specimen rows:</p>
                  <ul>
                    <li>
                      Source-like tokens: <code>fixed width</code>
                    </li>
                    <li>Math uses a TeX-like face with its own offset.</li>
                  </ul>
                </div>
                <div className="output-preview-thinking thinking-content">
                  <ThinkingText
                    text={[
                      "**Considering spacing adjustments**",
                      "",
                      "Thinking text stays quieter, narrower, and [configured offset] smaller.",
                    ].join("\n")}
                  />
                </div>
                <div className="output-preview-diff" aria-hidden="true">
                  <div>
                    <span className="output-preview-diff-gutter">+</span>
                    <span>Rendered diff prose follows the output font.</span>
                  </div>
                  <div>
                    <span className="output-preview-diff-gutter">-</span>
                    <span>Extra paragraph space can be dialed down.</span>
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
            <button
              type="button"
              className="settings-button settings-button-secondary"
              onClick={() => {
                setContentMaxWidth(DEFAULT_CONTENT_MAX_WIDTH_PX);
                setContentMaxWidthDraft(String(DEFAULT_CONTENT_MAX_WIDTH_PX));
              }}
            >
              {t("appearanceContentWidthReset")}
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
        <div className="settings-item session-toolbar-settings">
          <div className="settings-item-info">
            <strong>{t("appearanceSessionToolbarTitle")}</strong>
            <p>{t("appearanceSessionToolbarDescription")}</p>
          </div>

          <SessionToolbarPreview />

          <div className="session-toolbar-control-list">
            {toolbarControls.map((control) => (
              <label className="session-toolbar-control" key={control.key}>
                <span className="session-toolbar-control-copy">
                  <strong>{control.title}</strong>
                  <span>{control.description}</span>
                </span>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={toolbarVisibility[control.key]}
                    onChange={(e) =>
                      setControlVisible(control.key, e.target.checked)
                    }
                  />
                  <span className="toggle-slider" />
                </span>
              </label>
            ))}
          </div>

          <div className="settings-item-actions">
            <button
              type="button"
              className="settings-button settings-button-secondary"
              onClick={resetVisibility}
            >
              {t("appearanceSessionToolbarReset")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
