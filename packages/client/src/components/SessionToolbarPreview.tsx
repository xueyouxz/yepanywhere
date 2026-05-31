import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionToolbarVisibility } from "../hooks/useSessionToolbarVisibility";
import { useI18n } from "../i18n";
import {
  getModelIndicatorTextVariants,
  getModelIndicatorTooltip,
} from "../lib/modelIndicatorText";
import type { SpeechMethodId } from "../lib/speechProviders/methods";
import type { ContextUsage } from "../types";
import type { FilterOption } from "./FilterDropdown";
import {
  type LivenessDisplay,
  MessageInputToolbarView,
} from "./MessageInputToolbar";

const PREVIEW_CONTEXT_USAGE: ContextUsage = {
  inputTokens: 168_000,
  percentage: 84,
  contextWindow: 200_000,
};

const PREVIEW_SPEECH_METHODS: FilterOption<SpeechMethodId>[] = [
  {
    value: "ya-deepgram",
    label: "YA Deepgram",
    description: "Server-routed transcription through YA.",
  },
  {
    value: "browser-native",
    label: "Browser",
    description: "Runs in the browser.",
  },
];

const noop = () => {};

export function SessionToolbarPreview() {
  const { t } = useI18n();
  const { visibility } = useSessionToolbarVisibility();
  const inertRef = useRef<HTMLDivElement | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const previewNowMs = useMemo(() => Date.now(), []);
  const modelLabel = useMemo(
    () =>
      getModelIndicatorTextVariants(
        "codex",
        "gpt-5.5-codex",
        "Codex 5.5 · Effort max",
      ).compact,
    [],
  );
  const modelTooltip = useMemo(
    () =>
      getModelIndicatorTooltip(
        "codex",
        "gpt-5.5-codex",
        "Codex 5.5 · Effort max",
      ),
    [],
  );
  const livenessDisplay = useMemo<LivenessDisplay>(
    () => ({
      prefix: "Verified idle",
      timestampMs: previewNowMs - 4 * 60 * 1000,
      tone: "muted",
      title: "Preview session status",
    }),
    [previewNowMs],
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
    <div ref={inertRef} className="session-toolbar-preview" aria-hidden="true">
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
          onCycle: noop,
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
          showMethodSelector: true,
          methodOptions: PREVIEW_SPEECH_METHODS,
          selectedMethod: "ya-deepgram",
          onMethodChange: noop,
          voiceButton: {
            kind: "preview",
          },
        }}
        modelControl={{
          density: "compact",
          label: modelLabel,
          tone: "max",
          tooltip: modelTooltip,
          onClick: noop,
        }}
        statusControl={{
          showToolbarStatus: visibility.sessionStatus,
          showLivenessChip: visibility.sessionStatus,
          livenessDisplay,
          livenessSummary: "Verified idle 4m ago",
          nowMs: previewNowMs,
          showLastActivityChip: false,
          showLastActivityPrefix: false,
          lastActivityMs: null,
        }}
        shortcutsControl={{
          open: shortcutsOpen,
          isearchScope: null,
          setOpen: setShortcutsOpen,
          hasDualActions: true,
          showPatientQueueMode: true,
          queueModeLabel: "Queue ASAP",
        }}
        actionsControl={{
          contextUsage: PREVIEW_CONTEXT_USAGE,
          btw: {
            onClick: noop,
            pressed: false,
            mode: "start",
            title: "Start /btw aside (Ctrl+B)",
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
              showPatientQueueMode: true,
              patientQueueMode: false,
              onPatientQueueModeChange: noop,
              hasDualActions: true,
              queueModeLabel: "Queue ASAP",
              queueTooltip: "Queue ASAP",
            },
          },
        }}
      />
    </div>
  );
}
