import { useEffect, useState } from "react";
import { SessionToolbarPreview } from "../../components/SessionToolbarPreview";
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
import { useInlineImages } from "../../hooks/useInlineImages";
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
  getTabSizeLabel,
  getThemeLabel,
} from "../../i18n-settings";

export function AppearanceSettings() {
  const { locale, setLocale, t } = useI18n();
  const { fontSize, setFontSize } = useFontSize();
  const { tabSize, setTabSize } = useTabSize();
  const { contentMaxWidth, setContentMaxWidth } = useContentMaxWidth();
  const [contentMaxWidthDraft, setContentMaxWidthDraft] = useState(() =>
    String(contentMaxWidth),
  );
  const { theme, setTheme } = useTheme();
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const { stableToolPreviewRendering, setStableToolPreviewRendering } =
    useStableToolPreviewRendering();
  const { inlineImagesExpandedByDefault, setInlineImagesExpandedByDefault } =
    useInlineImages();
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
      key: "modelIndicator",
      title: t("appearanceToolbarModelTitle"),
      description: t("appearanceToolbarModelDescription"),
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

  const commitContentMaxWidth = () => {
    const parsed = Number.parseInt(contentMaxWidthDraft, 10);
    setContentMaxWidth(
      Number.isFinite(parsed) ? parsed : DEFAULT_CONTENT_MAX_WIDTH_PX,
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
              checked={inlineImagesExpandedByDefault}
              onChange={(e) =>
                setInlineImagesExpandedByDefault(e.target.checked)
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
