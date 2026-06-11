import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionToolbarVisibility } from "../hooks/useSessionToolbarVisibility";
import { useI18n } from "../i18n";
import { getEffortLevelOptions } from "../lib/effortLevels";
import type { ContextUsage } from "../types";
import {
  type LivenessDisplay,
  MessageInputToolbarView,
  type MessageInputToolbarViewProps,
} from "./MessageInputToolbar";

const PREVIEW_CONTEXT_USAGE: ContextUsage = {
  inputTokens: 168_000,
  percentage: 84,
  contextWindow: 200_000,
};

const noop = () => {};

export function SessionToolbarPreview() {
  const { t } = useI18n();
  const { visibility } = useSessionToolbarVisibility();
  const inertRef = useRef<HTMLDivElement | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const previewNowMs = useMemo(() => Date.now(), []);
  const livenessDisplay = useMemo<LivenessDisplay>(
    () => ({
      prefix: t("toolbarLivenessVerifiedIdle"),
      timestampMs: previewNowMs - 4 * 60 * 1000,
      tone: "muted",
      title: t("toolbarPreviewSessionStatus"),
    }),
    [previewNowMs, t],
  );
  const effortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider: "codex",
        model: "gpt-5.5-codex",
        translate: t,
      }),
    [t],
  );

  useEffect(() => {
    const element = inertRef.current as
      | (HTMLDivElement & { inert?: boolean })
      | null;
    if (!element) return;
    element.inert = true;
    return () => {
      element.inert = false;
    };
  }, []);

  return (
    <div className="session-toolbar-preview" aria-hidden="true">
      <div ref={inertRef} className="session-toolbar-preview-content">
        <MessageInputToolbarView
          t={t}
          visibility={visibility}
          modeControl={{
            mode: "bypassPermissions",
            onModeChange: noop,
          }}
          attachmentControl={{
            canAttach: true,
            attachmentCount: 1,
            onAttachClick: noop,
          }}
          slashControl={{
            commands: ["model", "btw", "compact", "done"],
            onSelectCommand: noop,
          }}
          thinkingControl={{
            mode: "auto",
            level: "max",
            effortOptions,
            onSetMode: noop,
            onSetEffort: noop,
            onToggleEnabled: noop,
            showThinking: "default",
            onSetShowThinking: noop,
          }}
          renderModeControl={{
            state: "mixed",
            title: t("toolbarRenderModeMixed"),
            onToggle: noop,
          }}
          nudgeControl={{
            enabled: true,
            title: t("sessionHeartbeatTitle"),
            onClick: noop,
            onContextMenu: (event) => event.preventDefault(),
            onTouchStart: noop,
            onTouchEnd: (event) => event.preventDefault(),
            onClearTouch: noop,
          }}
          speechControl={{
            showMethodSelector: false,
            methodOptions: [],
            selectedMethod: "browser-native",
            onMethodChange: noop,
            voiceButton: {
              kind: "preview",
            },
          }}
          statusControl={{
            showToolbarStatus: visibility.sessionStatus,
            showLivenessChip: visibility.sessionStatus,
            livenessDisplay,
            livenessSummary: t("toolbarLivenessSummary", {
              state: t("toolbarLivenessVerifiedIdle"),
              age: t("toolbarRelativeAgePast", { age: "4m" }),
            }),
            nowMs: previewNowMs,
            showLastActivityChip: false,
            showLastActivityPrefix: false,
            lastActivityMs: null,
            lastActivityIsPast: false,
          }}
          shortcutsControl={{
            open: shortcutsOpen,
            isearchScope: null,
            setOpen: setShortcutsOpen,
            settingsOpen: false,
            setSettingsOpen:
              noop as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
            hasDualActions: true,
            enterActionKind: "steer",
            canSwapEnterAction: false,
            queueShortcutLabel: t("toolbarShortcutQueueCurrentTurn"),
          }}
          actionsControl={{
            contextUsage: PREVIEW_CONTEXT_USAGE,
            btw: {
              onClick: noop,
              pressed: false,
              mode: "start",
              title: t("toolbarBtwStartTitle"),
            },
            send: {
              onSend: noop,
              canSend: true,
              primaryActionKind: "steer",
              primaryActionLabel: t("toolbarSteerTooltip"),
              tooltip: t("toolbarSteerTooltip"),
              icon: "↗",
              queue: {
                onQueue: noop,
                hasDualActions: true,
                queueTooltip: `${t("toolbarPatientQueueTooltip", {
                  timeout: "30s",
                })}\n${t("toolbarPatientQueueToggleShortcut")}`,
                showPatientQueueMode: true,
                patientQueueEnabled: true,
                patientQueueTimeoutLabel: "30s",
                patientQueueTooltip: t("toolbarPatientQueueTooltip", {
                  timeout: "30s",
                }),
                onTogglePatientQueue: noop,
              },
            },
          }}
        />
      </div>
    </div>
  );
}
