import { useCallback, useMemo } from "react";
import { SessionToolbarPreview } from "../../components/SessionToolbarPreview";
import {
  type SessionToolbarVisibilityKey,
  useSessionToolbarVisibility,
} from "../../hooks/useSessionToolbarVisibility";
import { useI18n } from "../../i18n";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

export function ToolbarSettings() {
  const { t } = useI18n();
  const {
    visibility: toolbarVisibility,
    setControlVisible,
    resetVisibility,
  } = useSessionToolbarVisibility();

  // Header undo: snapshot the visibility map at pane open.
  const undoState = useMemo(() => ({ toolbarVisibility }), [toolbarVisibility]);
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      for (const [key, visible] of Object.entries(snapshot.toolbarVisibility)) {
        setControlVisible(key as SessionToolbarVisibilityKey, visible);
      }
    },
    [setControlVisible],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

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
      key: "steerNow",
      title: t("appearanceToolbarSteerNowTitle"),
      description: t("appearanceToolbarSteerNowDescription"),
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

  return (
    <section className="settings-section">
      <h2>{t("appearanceSessionToolbarTitle")}</h2>
      <p className="settings-section-description">
        {t("appearanceSessionToolbarDescription")}
      </p>

      <div className="settings-group">
        <div className="settings-item session-toolbar-settings">
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
