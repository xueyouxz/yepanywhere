import type {
  BusyComposerDefaultAction,
  CollapsedComposerButtonPreference,
} from "@yep-anywhere/shared";
import { useCallback, useMemo } from "react";
import { SessionToolbarPreview } from "../../components/SessionToolbarPreview";
import {
  type SessionToolbarVisibilityKey,
  useSessionToolbarVisibility,
} from "../../hooks/useSessionToolbarVisibility";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const BUSY_COMPOSER_DEFAULT_ACTIONS: BusyComposerDefaultAction[] = [
  "steer",
  "queue",
];

const COLLAPSED_COMPOSER_BUTTON_OPTIONS: CollapsedComposerButtonPreference[] = [
  "primary",
  "alternate",
  "microphone",
];

export function ToolbarSettings() {
  const { t } = useI18n();
  const {
    visibility: toolbarVisibility,
    setControlVisible,
    resetVisibility,
  } = useSessionToolbarVisibility();
  const { settings, error, updateSettings } = useServerSettings();

  const busyComposerDefaultAction =
    settings?.clientDefaults?.busyComposerDefaultAction ?? "steer";
  const collapsedComposerButton =
    settings?.clientDefaults?.collapsedComposerButton ?? "primary";

  // Header undo: snapshot the visibility map at pane open.
  const undoState = useMemo(
    () =>
      settings
        ? {
            toolbarVisibility,
            busyComposerDefaultAction,
            collapsedComposerButton,
          }
        : null,
    [
      busyComposerDefaultAction,
      collapsedComposerButton,
      settings,
      toolbarVisibility,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      if (!snapshot) return;
      for (const [key, visible] of Object.entries(snapshot.toolbarVisibility)) {
        setControlVisible(key as SessionToolbarVisibilityKey, visible);
      }
      void updateSettings({
        clientDefaults: {
          busyComposerDefaultAction: snapshot.busyComposerDefaultAction,
          collapsedComposerButton: snapshot.collapsedComposerButton,
        },
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [setControlVisible, updateSettings],
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
      key: "waveform",
      title: t("appearanceToolbarWaveformTitle"),
      description: t("appearanceToolbarWaveformDescription"),
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
      key: "steerNow",
      title: t("appearanceToolbarSteerNowTitle"),
      description: t("appearanceToolbarSteerNowDescription"),
    },
  ];

  return (
    <section className="settings-section">
      <h2>{t("appearanceSessionToolbarTitle")}</h2>
      <p className="settings-section-description">
        {t("appearanceSessionToolbarDescription")}
      </p>

      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceToolbarDefaultActionTitle")}</strong>
            <p>{t("appearanceToolbarDefaultActionDescription")}</p>
          </div>
          <select
            className="settings-select"
            value={busyComposerDefaultAction}
            onChange={(event) => {
              const next = event.target.value as BusyComposerDefaultAction;
              if (!BUSY_COMPOSER_DEFAULT_ACTIONS.includes(next)) return;
              void updateSettings({
                clientDefaults: { busyComposerDefaultAction: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("appearanceToolbarDefaultActionTitle")}
          >
            <option value="steer">
              {t("appearanceToolbarDefaultActionSteer")}
            </option>
            <option value="queue">
              {t("appearanceToolbarDefaultActionQueue")}
            </option>
          </select>
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("appearanceToolbarCollapsedButtonTitle")}</strong>
            <p>{t("appearanceToolbarCollapsedButtonDescription")}</p>
          </div>
          <select
            className="settings-select"
            value={collapsedComposerButton}
            onChange={(event) => {
              const next = event.target
                .value as CollapsedComposerButtonPreference;
              if (!COLLAPSED_COMPOSER_BUTTON_OPTIONS.includes(next)) return;
              void updateSettings({
                clientDefaults: { collapsedComposerButton: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("appearanceToolbarCollapsedButtonTitle")}
          >
            <option value="primary">
              {t("appearanceToolbarCollapsedButtonPrimary")}
            </option>
            <option value="alternate">
              {t("appearanceToolbarCollapsedButtonAlternate")}
            </option>
            <option value="microphone">
              {t("appearanceToolbarCollapsedButtonMicrophone")}
            </option>
          </select>
        </div>

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
        {error && <p className="settings-warning">{error}</p>}
      </div>
    </section>
  );
}
