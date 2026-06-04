import type {
  ProviderName,
  SessionLivenessSnapshot,
} from "@yep-anywhere/shared";
import type { MouseEvent, RefObject, TouchEvent } from "react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOptionalRenderModeContext } from "../contexts/RenderModeContext";
import {
  type EffortLevel,
  type ThinkingMode,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useRelativeNow } from "../hooks/useRelativeNow";
import {
  type SessionToolbarVisibility,
  useSessionToolbarVisibility,
} from "../hooks/useSessionToolbarVisibility";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import type { BtwToolbarMode } from "../lib/btwAsideRouting";
import {
  type EffortLevelOption,
  getEffortLevelLabel,
  getEffortLevelOptions,
  resolveSupportedEffortLevel,
} from "../lib/effortLevels";
import {
  formatAbsoluteTimestamp,
  formatCompactRelativeAge,
  isStaleTimestamp,
  parseTimestampMs,
} from "../lib/messageAge";
import { normalizeProviderKey } from "../lib/modelIndicatorText";
import {
  SESSION_ISEARCH_GUIDE_EVENT,
  type SessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import {
  getSpeechMethods,
  isSpeechMethodId,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../lib/speechProviders/methods";
import type {
  GrokSpeechAudioSettings,
  SpeechSmartTurnSettings,
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
} from "../lib/speechProviders/SpeechProvider";
import type { ContextUsage, PermissionMode } from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import type { FilterOption } from "./FilterDropdown";
import { MessageAge } from "./MessageAge";
import { ModeSelector } from "./ModeSelector";
import { SlashCommandButton } from "./SlashCommandButton";
import { SpeechControlMenu } from "./SpeechControlMenu";
import { RenderModeGlyph } from "./ui/RenderModeGlyph";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

function getIsearchPreviousKeys(scope: SessionIsearchScope): string[] {
  if (scope === "full") {
    return ["Ctrl", "Alt", "S"];
  }
  if (scope === "all") {
    return ["Ctrl", "S"];
  }
  return ["Ctrl", "R"];
}

function getIsearchAlternateRows(scope: SessionIsearchScope): Array<{
  keys: string[];
  label: string;
}> {
  return [
    ...(scope === "user" ? [] : [{ keys: ["Ctrl", "R"], label: "User turns" }]),
    ...(scope === "all" ? [] : [{ keys: ["Ctrl", "S"], label: "All turns" }]),
    ...(scope === "full"
      ? []
      : [{ keys: ["Ctrl", "Alt", "S"], label: "Full session" }]),
  ];
}

export interface MessageInputToolbarProps {
  // Mode selector
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  modeChangesApplyNextTurn?: boolean;

  // Provider capability flags (default to true for backwards compatibility)
  supportsPermissionMode?: boolean;
  supportsThinkingToggle?: boolean;

  // Attachments
  canAttach?: boolean;
  attachmentCount?: number;
  onAttachClick?: () => void;

  // Voice input
  voiceButtonRef?: RefObject<VoiceInputButtonRef | null>;
  onVoiceTranscript?: (
    transcript: string,
    metadata?: SpeechTranscriptionResultMetadata,
  ) => void;
  onInterimTranscript?: (transcript: string) => void;
  onListeningStart?: () => void;
  voiceDisabled?: boolean;
  getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;

  // Slash commands
  slashCommands?: string[];
  onSelectSlashCommand?: (command: string) => void;
  onBtwClick?: () => void;
  btwActive?: boolean;
  btwHasAsides?: boolean;
  btwToolbarMode?: BtwToolbarMode;
  /** Provider/model context used by the thinking effort chooser. */
  thinkingProvider?: string;
  thinkingModel?: string;

  // Session heartbeat
  heartbeatEnabled?: boolean;
  onToggleHeartbeat?: () => void;
  onConfigureHeartbeat?: () => void;

  // Context usage
  contextUsage?: ContextUsage;
  /** Last session activity timestamp for stale composer liveness display. */
  lastActivityAt?: string | null;
  /** Server-derived provider/session liveness evidence. */
  sessionLiveness?: SessionLivenessSnapshot | null;
  /** Ctrl+Enter queue prepends "when done, " (deferred/patient) and is available. */
  showPatientQueueMode?: boolean;

  // Actions
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onSend?: () => void;
  /** Queue a deferred message. Only provided when agent is running. */
  onQueue?: () => void;
  primaryActionKind?: "send" | "steer" | "queue";
  canSend?: boolean;
  disabled?: boolean;

  // Pending approval indicator
  pendingApproval?: {
    type: "tool-approval" | "user-question";
    onExpand: () => void;
  };
}

export type LivenessTone = "ok" | "warn" | "danger" | "muted";

export interface LivenessDisplay {
  prefix: string;
  timestampMs: number | null;
  tone: LivenessTone;
  title: string;
}

function describeSessionLiveness(
  snapshot: SessionLivenessSnapshot,
): LivenessDisplay {
  const checkedMs = parseTimestampMs(snapshot.checkedAt);
  const stateMs = parseTimestampMs(snapshot.lastStateChangeAt);
  const progressMs = parseTimestampMs(
    snapshot.lastVerifiedProgressAt ?? snapshot.lastProviderMessageAt,
  );
  const idleMs = parseTimestampMs(snapshot.lastVerifiedIdleAt);
  const title = [
    `status: ${snapshot.derivedStatus}`,
    `work: ${snapshot.activeWorkKind}`,
    snapshot.lastRawProviderEventAt
      ? `raw provider: ${snapshot.lastRawProviderEventSource ?? "unknown"} at ${snapshot.lastRawProviderEventAt}`
      : null,
    `evidence: ${snapshot.evidence.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  switch (snapshot.derivedStatus) {
    case "verified-progressing":
      return {
        prefix: "Verified progress",
        timestampMs: progressMs ?? checkedMs,
        tone: "ok",
        title,
      };
    case "recently-active-unverified":
      return {
        prefix: "Unverified turn",
        timestampMs: stateMs ?? checkedMs,
        tone: "warn",
        title,
      };
    case "long-silent-unverified":
      return {
        prefix: "Long silent",
        timestampMs: progressMs ?? stateMs ?? checkedMs,
        tone: "danger",
        title,
      };
    case "verified-waiting-provider":
      return {
        prefix: "Waiting on provider",
        timestampMs: progressMs ?? stateMs ?? checkedMs,
        tone: "warn",
        title,
      };
    case "verified-idle":
      return {
        prefix: "Verified idle",
        timestampMs: idleMs ?? stateMs ?? checkedMs,
        tone: "muted",
        title,
      };
    case "needs-attention":
      return {
        prefix:
          snapshot.activeWorkKind === "waiting-input"
            ? "Needs input"
            : "Needs attention",
        timestampMs: stateMs ?? checkedMs,
        tone: "danger",
        title,
      };
  }

  const unhandledStatus: never = snapshot.derivedStatus;
  return {
    prefix: "Unknown state",
    timestampMs: checkedMs,
    tone: "warn",
    title: `${title}\nunknown status: ${String(unhandledStatus)}`,
  };
}

function formatLivenessAge(timestampMs: number, nowMs: number): string {
  const label = formatCompactRelativeAge(timestampMs, nowMs);
  return label === "now" ? label : `${label} ago`;
}

function describeLivenessSummary(
  display: LivenessDisplay,
  nowMs: number,
): string {
  if (display.timestampMs === null) {
    return display.prefix;
  }
  return `${display.prefix} ${formatLivenessAge(display.timestampMs, nowMs)}`;
}

function getBtwTitle(mode: BtwToolbarMode): string {
  switch (mode) {
    case "child-session":
      return "Viewing a /btw child session; click to return to Mother (Ctrl+B)";
    case "focused-footer":
      return "Composer is focused on a /btw aside; click to return to Mother (Ctrl+B)";
    case "focused-pane":
      return "A /btw pane is focused; click to focus its composer (Ctrl+B)";
    case "focus-existing":
      return "Focus existing /btw aside (Ctrl+B)";
    case "start":
      return "Start /btw aside (Ctrl+B)";
  }
}

function isBtwPressed(mode: BtwToolbarMode): boolean {
  return (
    mode === "child-session" ||
    mode === "focused-footer" ||
    mode === "focused-pane"
  );
}

const LAST_ACTIVITY_TEXT_PREFIX_THRESHOLD_MS = 30 * 60 * 1000;
const COMPACT_STATUS_QUERY = "(max-width: 600px)";

function getCompactStatusMatchMedia() {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(COMPACT_STATUS_QUERY);
}

type ToolbarTranslate = ReturnType<typeof useI18n>["t"];
type ToolbarRenderModeState = "rendered" | "source" | "mixed";

interface ToolbarRefs {
  toolbar?: RefObject<HTMLDivElement | null>;
  left?: RefObject<HTMLDivElement | null>;
  status?: RefObject<HTMLDivElement | null>;
  actions?: RefObject<HTMLDivElement | null>;
}

interface ToolbarModeControl {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  changesApplyNextTurn?: boolean;
}

interface ToolbarAttachmentControl {
  canAttach?: boolean;
  attachmentCount: number;
  onAttachClick?: () => void;
}

interface ToolbarSlashControl {
  commands: string[];
  onSelectCommand: (command: string) => void;
  disabled?: boolean;
}

interface ToolbarThinkingControl {
  mode: ThinkingMode;
  level: EffortLevel;
  effortOptions: EffortLevelOption[];
  onSetMode: (mode: ThinkingMode) => void;
  onSetEffort: (level: EffortLevel) => void;
  onToggleEnabled: () => void;
}

interface ToolbarRenderModeControl {
  state: ToolbarRenderModeState;
  title: string;
  onToggle: () => void;
}

interface ToolbarNudgeControl {
  enabled: boolean;
  title: string;
  onClick: () => void;
  onContextMenu: (e: MouseEvent<HTMLButtonElement>) => void;
  onTouchStart: () => void;
  onTouchEnd: (e: TouchEvent<HTMLButtonElement>) => void;
  onClearTouch: () => void;
}

type ToolbarVoiceButtonControl =
  | {
      kind: "live";
      ref?: RefObject<VoiceInputButtonRef | null>;
      onTranscript: (
        transcript: string,
        metadata?: SpeechTranscriptionResultMetadata,
      ) => void;
      onInterimTranscript: (transcript: string) => void;
      onListeningStart?: () => void;
      disabled?: boolean;
      speechMethod: SpeechMethodId;
      getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
      smartTurn?: SpeechSmartTurnSettings;
      grokSpeechAudioSettings?: GrokSpeechAudioSettings;
    }
  | {
      kind: "preview";
      disabled?: boolean;
    };

interface ToolbarSpeechControl {
  showMethodSelector: boolean;
  methodOptions: FilterOption<SpeechMethodId>[];
  selectedMethod: SpeechMethodId;
  onMethodChange: (selected: string[]) => void;
  smartTurnSettings?: SpeechSmartTurnSettings;
  onSmartTurnSettingsChange?: (settings: SpeechSmartTurnSettings) => void;
  smartTurnDisabled?: boolean;
  grokAudioSettings?: GrokSpeechAudioSettings;
  onGrokAudioSettingsChange?: (settings: GrokSpeechAudioSettings) => void;
  voiceButton?: ToolbarVoiceButtonControl;
}

interface ToolbarStatusControl {
  showToolbarStatus: boolean;
  showLivenessChip: boolean;
  livenessDisplay: LivenessDisplay | null;
  livenessSummary: string | null;
  nowMs: number;
  showLastActivityChip: boolean;
  showLastActivityPrefix: boolean;
  lastActivityMs: number | null;
  lastActivitySuffix?: string;
}

interface ToolbarShortcutsControl {
  open: boolean;
  isearchScope: SessionIsearchScope | null;
  setOpen: Dispatch<SetStateAction<boolean>>;
  hasDualActions: boolean;
  queueShortcutLabel: string;
}

interface ToolbarBtwControl {
  onClick: () => void;
  pressed: boolean;
  mode: BtwToolbarMode;
  title: string;
}

interface ToolbarQueueControl {
  onQueue?: () => void;
  hasDualActions: boolean;
  queueTooltip: string;
  showPatientQueueMode: boolean;
}

interface ToolbarSendControl {
  onSend?: () => void;
  canSend?: boolean;
  primaryActionKind: "send" | "steer" | "queue";
  primaryActionLabel: string;
  tooltip: string;
  icon: string;
  queue?: ToolbarQueueControl;
}

interface ToolbarStopControl {
  onStop: () => void;
  title: string;
}

interface ToolbarActionsControl {
  disabled?: boolean;
  voiceDisabled?: boolean;
  contextUsage?: ContextUsage;
  btw?: ToolbarBtwControl | null;
  stop?: ToolbarStopControl | null;
  send?: ToolbarSendControl | null;
}

export interface MessageInputToolbarViewProps {
  t: ToolbarTranslate;
  refs?: ToolbarRefs;
  visibility: SessionToolbarVisibility;
  isCompactStatusMode?: boolean;
  modeControl?: ToolbarModeControl | null;
  attachmentControl: ToolbarAttachmentControl;
  slashControl?: ToolbarSlashControl | null;
  thinkingControl?: ToolbarThinkingControl | null;
  renderModeControl?: ToolbarRenderModeControl | null;
  nudgeControl?: ToolbarNudgeControl | null;
  speechControl?: ToolbarSpeechControl | null;
  statusControl?: ToolbarStatusControl | null;
  pendingApproval?: MessageInputToolbarProps["pendingApproval"];
  shortcutsControl: ToolbarShortcutsControl;
  actionsControl: ToolbarActionsControl;
}

function ToolbarMicrophoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function ThinkingToolbarIcon({ mode }: { mode: ThinkingMode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
      {mode === "auto" && (
        <g>
          <circle cx="19" cy="5" r="5.5" fill="currentColor" stroke="none" />
          <text
            x="19"
            y="5"
            textAnchor="middle"
            dominantBaseline="central"
            fill="var(--bg-primary, #1a1a2e)"
            fontSize="8"
            fontWeight="700"
            fontFamily="system-ui, sans-serif"
            stroke="none"
          >
            A
          </text>
        </g>
      )}
    </svg>
  );
}

function getToolbarThinkingLabel(control: ToolbarThinkingControl): string {
  if (control.mode === "off") return "Off";
  if (control.mode === "auto") return "Auto";
  if (control.level === "xhigh") return "XHigh";
  return getEffortLevelLabel(control.level);
}

function getToolbarThinkingTitle(
  t: ToolbarTranslate,
  control: ToolbarThinkingControl,
): string {
  const current =
    control.mode === "off"
      ? t("newSessionThinkingOff")
      : control.mode === "auto"
        ? t("newSessionThinkingAuto")
        : t("newSessionThinkingOn", {
            level:
              control.effortOptions.find(
                (option) => option.value === control.level,
              )?.label ?? getEffortLevelLabel(control.level),
          });
  return `${current}. Click to choose; right-click or long-press to toggle off/on. Applies next turn.`;
}

function ThinkingToolbarControl({
  control,
  t,
}: {
  control: ToolbarThinkingControl;
  t: ToolbarTranslate;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressTouchClickRef = useRef(false);
  const title = getToolbarThinkingTitle(t, control);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [close, open]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const toggleEnabled = useCallback(() => {
    control.onToggleEnabled();
    setOpen(false);
  }, [control]);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      toggleEnabled();
    },
    [toggleEnabled],
  );

  const handleTouchStart = useCallback(() => {
    clearLongPress();
    suppressTouchClickRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      suppressTouchClickRef.current = true;
      longPressTimerRef.current = null;
      toggleEnabled();
    }, 450);
  }, [clearLongPress, toggleEnabled]);

  const handleTouchEnd = useCallback(
    (event: TouchEvent<HTMLButtonElement>) => {
      if (suppressTouchClickRef.current) {
        event.preventDefault();
      }
      clearLongPress();
    },
    [clearLongPress],
  );

  const selectMode = (mode: ThinkingMode) => {
    control.onSetMode(mode);
    setOpen(false);
  };

  const selectEffort = (level: EffortLevel) => {
    control.onSetEffort(level);
    control.onSetMode("on");
    setOpen(false);
  };

  return (
    <div className="thinking-toolbar-control" ref={rootRef}>
      <button
        type="button"
        className={`thinking-toggle-button ${control.mode !== "off" ? `active ${control.mode}` : ""}`}
        onClick={(event) => {
          if (suppressTouchClickRef.current) {
            suppressTouchClickRef.current = false;
            return;
          }
          event.currentTarget.blur();
          setOpen((current) => !current);
        }}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={clearLongPress}
        onTouchMove={clearLongPress}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ThinkingToolbarIcon mode={control.mode} />
        <span className="thinking-toggle-label">
          {getToolbarThinkingLabel(control)}
        </span>
      </button>
      {open && (
        <div className="thinking-toolbar-menu" role="menu">
          <div className="thinking-toolbar-menu-section">
            <div className="thinking-toolbar-menu-label">
              {t("modelSettingsThinkingTitle")}
            </div>
            <div className="thinking-toolbar-menu-options">
              {(["off", "auto", "on"] as ThinkingMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={control.mode === mode}
                  className={`thinking-toolbar-option ${control.mode === mode ? "active" : ""}`}
                  onClick={() => selectMode(mode)}
                >
                  <span className={`mode-option-dot thinking-${mode}`} />
                  <span>
                    {mode === "off"
                      ? t("modelSettingsThinkingOffLabel")
                      : mode === "auto"
                        ? t("modelSettingsThinkingAutoLabel")
                        : t("modelSettingsThinkingOnLabel")}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="thinking-toolbar-menu-section">
            <div className="thinking-toolbar-menu-label">
              {t("modelSettingsEffortTitle")}
            </div>
            <div className="thinking-toolbar-menu-options effort-options">
              {control.effortOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={
                    control.mode === "on" && control.level === option.value
                  }
                  className={`thinking-toolbar-option ${
                    control.mode === "on" && control.level === option.value
                      ? "active"
                      : ""
                  }`}
                  title={option.description}
                  onClick={() => selectEffort(option.value)}
                >
                  <span
                    className={`model-switch-indicator-dot tone-${option.value}`}
                    aria-hidden="true"
                  />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="thinking-toolbar-menu-hint">Applies next turn</div>
        </div>
      )}
    </div>
  );
}

export function MessageInputToolbarView({
  t,
  refs,
  visibility,
  isCompactStatusMode = false,
  modeControl,
  attachmentControl,
  slashControl,
  thinkingControl,
  renderModeControl,
  nudgeControl,
  speechControl,
  statusControl,
  pendingApproval,
  shortcutsControl,
  actionsControl,
}: MessageInputToolbarViewProps) {
  const shortcutsPopoverOpen = shortcutsControl.open;
  const showToolbarStatus =
    visibility.sessionStatus && (statusControl?.showToolbarStatus ?? false);
  const showLivenessChip = statusControl?.showLivenessChip ?? false;
  const livenessDisplay = statusControl?.livenessDisplay ?? null;
  const showLastActivityChip = statusControl?.showLastActivityChip ?? false;
  const showSendButton = !!actionsControl.send?.onSend;
  const showStopButton = !!actionsControl.stop;
  const selectedSpeechMethod = speechControl?.selectedMethod;
  const queueControl = actionsControl.send?.queue;

  return (
    <div
      ref={refs?.toolbar}
      className={`message-input-toolbar${isCompactStatusMode ? " status-floats" : ""}`}
    >
      <div ref={refs?.left} className="message-input-left">
        {visibility.modeSelector && modeControl && (
          <ModeSelector
            mode={modeControl.mode}
            onModeChange={modeControl.onModeChange}
            changesApplyNextTurn={modeControl.changesApplyNextTurn}
          />
        )}
        {visibility.attachments && (
          <button
            type="button"
            className="attach-button"
            onClick={attachmentControl.onAttachClick}
            disabled={!attachmentControl.canAttach}
            title={
              attachmentControl.canAttach
                ? t("toolbarAttachFiles")
                : t("toolbarAttachDisabled")
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            {attachmentControl.attachmentCount > 0 && (
              <span className="attach-count">
                {attachmentControl.attachmentCount}
              </span>
            )}
          </button>
        )}
        {visibility.slashMenu && slashControl && (
          <SlashCommandButton
            commands={slashControl.commands}
            onSelectCommand={slashControl.onSelectCommand}
            disabled={slashControl.disabled}
          />
        )}
        {visibility.thinkingToggle && thinkingControl && (
          <ThinkingToolbarControl control={thinkingControl} t={t} />
        )}
        {visibility.renderMode && renderModeControl && (
          <button
            type="button"
            className={`render-mode-toolbar-button ${
              renderModeControl.state === "rendered"
                ? "is-rendered"
                : renderModeControl.state === "mixed"
                  ? "is-mixed"
                  : ""
            }`}
            onClick={renderModeControl.onToggle}
            title={renderModeControl.title}
            aria-label={renderModeControl.title}
            aria-pressed={
              renderModeControl.state === "mixed"
                ? "mixed"
                : renderModeControl.state === "rendered"
            }
          >
            <RenderModeGlyph />
          </button>
        )}
        {visibility.nudge && nudgeControl && (
          <button
            type="button"
            className={`heartbeat-toolbar-button ${nudgeControl.enabled ? "active" : ""}`}
            onClick={nudgeControl.onClick}
            onContextMenu={nudgeControl.onContextMenu}
            onTouchStart={nudgeControl.onTouchStart}
            onTouchEnd={nudgeControl.onTouchEnd}
            onTouchCancel={nudgeControl.onClearTouch}
            onTouchMove={nudgeControl.onClearTouch}
            title={nudgeControl.title}
            aria-label={nudgeControl.title}
            aria-pressed={nudgeControl.enabled}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="miter"
              aria-hidden="true"
            >
              <path className="heartbeat-baseline" d="M0.75 15H7" />
              <path
                className="heartbeat-excursion"
                d="M7 15l2-5 2 9 4-16 3 12"
              />
              <path className="heartbeat-baseline" d="M18 15h5.25" />
            </svg>
          </button>
        )}
        {visibility.microphone &&
          selectedSpeechMethod &&
          speechControl?.voiceButton?.kind === "preview" && (
            <SpeechControlMenu
              showMethodSelector={speechControl.showMethodSelector}
              methodOptions={speechControl.methodOptions}
              selectedMethod={selectedSpeechMethod}
              onMethodChange={speechControl.onMethodChange}
              smartTurnSettings={speechControl.smartTurnSettings}
              onSmartTurnSettingsChange={
                speechControl.onSmartTurnSettingsChange
              }
              smartTurnDisabled={speechControl.smartTurnDisabled}
              grokAudioSettings={speechControl.grokAudioSettings}
              onGrokAudioSettingsChange={
                speechControl.onGrokAudioSettingsChange
              }
              trigger={
                <button
                  type="button"
                  className="voice-input-button"
                  disabled={speechControl.voiceButton.disabled}
                  title={t("voiceInputStart" as never)}
                  aria-label={t("voiceInputStartLabel" as never)}
                >
                  <ToolbarMicrophoneIcon />
                </button>
              }
            />
          )}
        {visibility.microphone &&
          selectedSpeechMethod &&
          speechControl?.voiceButton?.kind === "live" &&
          speechControl.voiceButton.ref && (
            <SpeechControlMenu
              showMethodSelector={speechControl.showMethodSelector}
              methodOptions={speechControl.methodOptions}
              selectedMethod={selectedSpeechMethod}
              onMethodChange={speechControl.onMethodChange}
              smartTurnSettings={speechControl.smartTurnSettings}
              onSmartTurnSettingsChange={
                speechControl.onSmartTurnSettingsChange
              }
              smartTurnDisabled={speechControl.smartTurnDisabled}
              grokAudioSettings={speechControl.grokAudioSettings}
              onGrokAudioSettingsChange={
                speechControl.onGrokAudioSettingsChange
              }
              trigger={
                <VoiceInputButton
                  ref={speechControl.voiceButton.ref}
                  onTranscript={speechControl.voiceButton.onTranscript}
                  onInterimTranscript={
                    speechControl.voiceButton.onInterimTranscript
                  }
                  onListeningStart={speechControl.voiceButton.onListeningStart}
                  disabled={speechControl.voiceButton.disabled}
                  speechMethod={speechControl.voiceButton.speechMethod}
                  getTranscriptionContext={
                    speechControl.voiceButton.getTranscriptionContext
                  }
                  smartTurn={speechControl.voiceButton.smartTurn}
                  grokSpeechAudioSettings={
                    speechControl.voiceButton.grokSpeechAudioSettings
                  }
                />
              }
            />
          )}
      </div>
      {showToolbarStatus && statusControl && (
        <div ref={refs?.status} className="composer-status-ages">
          {showLivenessChip && livenessDisplay && (
            <div
              className={`composer-status-chip composer-liveness-status is-${livenessDisplay.tone}`}
              role="status"
              aria-label={`Session verified liveness: ${statusControl.livenessSummary}`}
              title={livenessDisplay.title}
            >
              {livenessDisplay.timestampMs !== null ? (
                <time
                  className="composer-liveness-time"
                  dateTime={new Date(livenessDisplay.timestampMs).toISOString()}
                  title={`${formatAbsoluteTimestamp(livenessDisplay.timestampMs)}\n${livenessDisplay.title}`}
                >
                  {formatLivenessAge(
                    livenessDisplay.timestampMs,
                    statusControl.nowMs,
                  )}
                </time>
              ) : (
                <span className="composer-liveness-time">
                  {livenessDisplay.prefix}
                </span>
              )}
            </div>
          )}
          {showLastActivityChip && (
            <div
              className={`composer-status-chip composer-activity-age${
                statusControl.showLastActivityPrefix
                  ? ""
                  : " composer-activity-age--compact"
              }`}
              role="status"
              aria-label="Session last activity"
            >
              <MessageAge
                timestampMs={statusControl.lastActivityMs}
                nowMs={statusControl.nowMs}
                className="composer-activity-age-time"
                prefix={
                  statusControl.showLastActivityPrefix
                    ? "Last activity"
                    : undefined
                }
                suffix={statusControl.lastActivitySuffix}
              />
            </div>
          )}
        </div>
      )}
      <div ref={refs?.actions} className="message-input-actions">
        {pendingApproval && (
          <button
            type="button"
            className={`pending-approval-indicator ${pendingApproval.type}`}
            onClick={pendingApproval.onExpand}
            title={
              pendingApproval.type === "tool-approval"
                ? t("toolbarPendingApprovalExpand")
                : t("toolbarPendingQuestionExpand")
            }
          >
            <span className="pending-approval-dot" />
            <span className="pending-approval-text">
              {pendingApproval.type === "tool-approval"
                ? t("toolbarApproval")
                : t("toolbarQuestion")}
            </span>
          </button>
        )}
        {visibility.shortcutsHelp && (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer leave only hides the adjacent shortcuts popover
          <div
            className="session-shortcuts-help"
            onMouseLeave={() => {
              shortcutsControl.setOpen(false);
            }}
          >
            <button
              type="button"
              className="session-shortcuts-help-button"
              aria-label="Session keyboard shortcuts"
              aria-expanded={shortcutsPopoverOpen}
              onClick={() => shortcutsControl.setOpen((open) => !open)}
              onFocus={() => shortcutsControl.setOpen(true)}
              onBlur={(event) => {
                if (
                  !event.currentTarget.parentElement?.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  shortcutsControl.setOpen(false);
                }
              }}
              onMouseEnter={() => shortcutsControl.setOpen(true)}
            >
              ?
            </button>
            {shortcutsPopoverOpen && (
              <div
                className={`session-shortcuts-popover ${
                  shortcutsControl.isearchScope !== null
                    ? "is-isearch-guide"
                    : ""
                }`}
                role="tooltip"
              >
                {shortcutsControl.isearchScope !== null ? (
                  <>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        {getIsearchPreviousKeys(
                          shortcutsControl.isearchScope,
                        ).map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                        {shortcutsControl.isearchScope === "user" && (
                          <>
                            <span>or</span>
                            <kbd>Ctrl</kbd>
                            <kbd>Alt</kbd>
                            <kbd>R</kbd>
                          </>
                        )}
                      </span>
                      <span>Previous match</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Enter</kbd>
                      </span>
                      <span>Jump</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>↑</kbd>
                        <kbd>↓</kbd>
                      </span>
                      <span>Previous / next match</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">Click</span>
                      <span>Match preview / rail mark jumps</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Esc</kbd>
                      </span>
                      <span>Cancel / restore focus</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>End</kbd>
                      </span>
                      <span>Scroll to current</span>
                    </div>
                    {getIsearchAlternateRows(shortcutsControl.isearchScope).map(
                      (row) => (
                        <div key={row.label} className="session-shortcuts-row">
                          <span className="session-shortcuts-keys">
                            {row.keys.map((key) => (
                              <kbd key={key}>{key}</kbd>
                            ))}
                            {row.label === "User turns" && (
                              <>
                                <span>or</span>
                                <kbd>Ctrl</kbd>
                                <kbd>Alt</kbd>
                                <kbd>R</kbd>
                              </>
                            )}
                          </span>
                          <span>{row.label}</span>
                        </div>
                      ),
                    )}
                  </>
                ) : (
                  <>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>R</kbd>
                        <span>or</span>
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>R</kbd>
                      </span>
                      <span>User-turn reverse search</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>S</kbd>
                      </span>
                      <span>All-turn reverse search</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>S</kbd>
                      </span>
                      <span>Full-session reverse search</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Enter</kbd>
                      </span>
                      <span>
                        {shortcutsControl.hasDualActions
                          ? "Steer current turn"
                          : "Send"}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Shift</kbd>
                        <kbd>Enter</kbd>
                      </span>
                      <span>New line</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Enter</kbd>
                      </span>
                      <span>{shortcutsControl.queueShortcutLabel}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>B</kbd>
                      </span>
                      <span>Start /btw aside</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Esc</kbd>
                      </span>
                      <span>Stop agent / cancel overlay</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>P</kbd>
                      </span>
                      <span>Recall last sent text</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>K</kbd>
                      </span>
                      <span>Cancel latest queued message</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>End</kbd>
                      </span>
                      <span>Scroll to current</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>G</kbd>
                      </span>
                      <span>Clear composer</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Shift</kbd>
                        <kbd>M</kbd>
                      </span>
                      <span>Rendered/source mode</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {visibility.contextUsage && (
          <ContextUsageIndicator
            usage={actionsControl.contextUsage}
            size={16}
          />
        )}
        {visibility.btw && actionsControl.btw && (
          <button
            type="button"
            className={`btw-toolbar-button ${actionsControl.btw.pressed ? "active" : ""} ${
              actionsControl.btw.mode === "focus-existing" ? "has-asides" : ""
            }`}
            onClick={actionsControl.btw.onClick}
            disabled={actionsControl.disabled || actionsControl.voiceDisabled}
            aria-label={actionsControl.btw.title}
            aria-pressed={actionsControl.btw.pressed}
            title={actionsControl.btw.title}
          >
            /btw
          </button>
        )}
        {showStopButton && actionsControl.stop && (
          <button
            type="button"
            onClick={actionsControl.stop.onStop}
            className="stop-button"
            aria-label={t("toolbarStop")}
            title={actionsControl.stop.title}
          >
            <span className="stop-icon" />
          </button>
        )}
        {showSendButton && actionsControl.send ? (
          <>
            {visibility.queueControls &&
              queueControl?.hasDualActions &&
              queueControl.onQueue && (
                <button
                  type="button"
                  onClick={queueControl.onQueue}
                  disabled={
                    actionsControl.disabled || !actionsControl.send.canSend
                  }
                  className="send-button queue-button"
                  aria-label={t("toolbarQueueLabel")}
                  title={queueControl.queueTooltip}
                >
                  <span className="send-icon queue-icon">⏱</span>
                </button>
              )}
            <button
              type="button"
              onClick={actionsControl.send.onSend}
              disabled={actionsControl.disabled || !actionsControl.send.canSend}
              className={`send-button send-button-with-help ${
                actionsControl.send.primaryActionKind === "queue"
                  ? "queue-mode"
                  : ""
              }`}
              aria-label={actionsControl.send.primaryActionLabel}
              title={actionsControl.send.tooltip}
              data-tooltip={actionsControl.send.tooltip}
            >
              <span className="send-icon">{actionsControl.send.icon}</span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function MessageInputToolbar({
  mode = "default",
  onModeChange,
  modeChangesApplyNextTurn,
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
  canAttach,
  attachmentCount = 0,
  onAttachClick,
  voiceButtonRef,
  onVoiceTranscript,
  onInterimTranscript,
  onListeningStart,
  voiceDisabled,
  getTranscriptionContext,
  slashCommands = [],
  onSelectSlashCommand,
  onBtwClick,
  btwActive = false,
  btwHasAsides = false,
  btwToolbarMode,
  thinkingProvider,
  thinkingModel,
  heartbeatEnabled = false,
  onToggleHeartbeat,
  onConfigureHeartbeat,
  contextUsage,
  lastActivityAt,
  sessionLiveness,
  showPatientQueueMode = false,
  isRunning,
  isThinking,
  onStop,
  onSend,
  onQueue,
  primaryActionKind,
  canSend,
  disabled,
  pendingApproval,
}: MessageInputToolbarProps) {
  const { t } = useI18n();
  const {
    thinkingMode,
    thinkingLevel,
    setThinkingMode,
    setEffortLevel,
    voiceInputEnabled = true,
    speechMethod = "browser-native",
    hasStoredSpeechMethod = false,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
    grokSpeechAudioSettings,
    setGrokSpeechAudioSettings,
  } = useModelSettings();
  const { version: versionInfo } = useVersion();
  const { visibility: toolbarVisibility } = useSessionToolbarVisibility();
  const renderMode = useOptionalRenderModeContext();
  const nowMs = useRelativeNow();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [isearchScope, setIsearchScope] = useState<SessionIsearchScope | null>(
    null,
  );
  const lastNonOffThinkingModeRef =
    useRef<Exclude<ThinkingMode, "off">>("auto");
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarLeftRef = useRef<HTMLDivElement | null>(null);
  const toolbarStatusRef = useRef<HTMLDivElement | null>(null);
  const toolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const [isCompactStatusMode, setIsCompactStatusMode] = useState(() =>
    typeof window === "undefined"
      ? false
      : (getCompactStatusMatchMedia()?.matches ?? false),
  );
  const normalizedThinkingProvider = useMemo(
    () => normalizeProviderKey(thinkingProvider),
    [thinkingProvider],
  );
  const thinkingEffortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider: normalizedThinkingProvider as ProviderName,
        model: thinkingModel,
      }),
    [thinkingModel, normalizedThinkingProvider],
  );
  const effectiveThinkingLevel = useMemo(
    () => resolveSupportedEffortLevel(thinkingLevel, thinkingEffortOptions),
    [thinkingEffortOptions, thinkingLevel],
  );
  const lastActivityMs = parseTimestampMs(lastActivityAt);
  const showLastActivityAge = isStaleTimestamp(lastActivityMs, nowMs);
  const lastActivityAgeMs =
    lastActivityMs === null ? null : nowMs - lastActivityMs;
  const showLastActivityPrefix =
    showLastActivityAge &&
    !isCompactStatusMode &&
    lastActivityAgeMs !== null &&
    lastActivityAgeMs >= LAST_ACTIVITY_TEXT_PREFIX_THRESHOLD_MS;
  const lastActivitySuffix =
    showLastActivityAge &&
    !showLastActivityPrefix &&
    lastActivityMs !== null &&
    formatCompactRelativeAge(lastActivityMs, nowMs) !== "now"
      ? "ago"
      : undefined;
  const livenessDisplay = sessionLiveness
    ? describeSessionLiveness(sessionLiveness)
    : null;
  const showLivenessChip =
    toolbarVisibility.sessionStatus &&
    !!livenessDisplay &&
    !(
      showLastActivityAge &&
      (isCompactStatusMode ||
        livenessDisplay.tone === "ok" ||
        livenessDisplay.tone === "muted")
    );
  const livenessSummary = livenessDisplay
    ? describeLivenessSummary(livenessDisplay, nowMs)
    : null;
  const heartbeatLongPressTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const suppressHeartbeatClickRef = useRef(false);
  const renderModeTitle =
    renderMode?.state === "rendered"
      ? t("toolbarRenderModeRendered")
      : renderMode?.state === "source"
        ? t("toolbarRenderModeSource")
        : t("toolbarRenderModeMixed");
  const hasDualActions = !!(onSend && onQueue);
  const effectivePrimaryActionKind =
    primaryActionKind ?? (hasDualActions ? "steer" : "send");
  const sendTooltip =
    effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? showPatientQueueMode
          ? 'Queue (sent when the turn ends). Ctrl+Enter prepends "when done,"'
          : t("toolbarQueueTooltip")
        : t("toolbarSendTooltip");
  const queueTooltip = showPatientQueueMode
    ? 'Queue (sent when the turn ends). Ctrl+Enter prepends "when done,"'
    : t("toolbarQueueTooltip");
  const queueShortcutLabel = "Queue while agent runs";
  const effectiveBtwToolbarMode =
    btwToolbarMode ??
    (btwActive ? "focused-footer" : btwHasAsides ? "focus-existing" : "start");
  const btwTitle = getBtwTitle(effectiveBtwToolbarMode);
  const btwPressed = isBtwPressed(effectiveBtwToolbarMode);
  const primaryActionIcon =
    effectivePrimaryActionKind === "steer"
      ? "↗"
      : effectivePrimaryActionKind === "queue"
        ? "⏱"
        : "↑";
  const primaryActionLabel =
    effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? hasDualActions
          ? "Queue from primary action"
          : t("toolbarQueueLabel")
        : t("toolbarSend");
  const stopTitle = `${t("toolbarStop")} (Esc)`;
  const showStopButton = !!(isRunning && onStop && isThinking);
  const showSendButton = !!(onSend && (!showStopButton || canSend));
  const serverVoiceEnabled =
    versionInfo?.capabilities?.includes("voiceInput") ?? true;
  const speechMethodOptions = useMemo((): FilterOption<SpeechMethodId>[] => {
    const serverBackends = versionInfo?.voiceBackends ?? [];
    return getSpeechMethods(serverBackends).map((method) => ({
      value: method.id,
      label: method.label,
      description: method.description,
    }));
  }, [versionInfo?.voiceBackends]);
  const selectedSpeechMethod = useMemo(
    () =>
      resolveSpeechMethod(
        speechMethod,
        versionInfo?.voiceBackends,
        hasStoredSpeechMethod,
      ),
    [speechMethod, versionInfo?.voiceBackends, hasStoredSpeechMethod],
  );
  const handleSpeechMethodSelect = useCallback(
    (selected: string[]) => {
      const next = selected[0];
      if (next && isSpeechMethodId(next)) {
        setSpeechMethod?.(next);
      }
    },
    [setSpeechMethod],
  );
  const showSpeechMethodSelector =
    toolbarVisibility.microphone &&
    voiceInputEnabled &&
    serverVoiceEnabled &&
    speechMethodOptions.length > 1;
  const supportsSelectedSpeechSmartTurn =
    selectedSpeechMethod !== "browser-native" &&
    (selectedSpeechMethod !== "ya-grok" ||
      grokSpeechAudioSettings.uplinkMode === "pcm16") &&
    versionInfo?.voiceBackendCapabilities?.[selectedSpeechMethod]?.smartTurn ===
      true;
  const activeSpeechSmartTurnSettings: SpeechSmartTurnSettings | undefined =
    supportsSelectedSpeechSmartTurn ? speechSmartTurnSettings : undefined;
  const showLastActivityChip =
    toolbarVisibility.sessionStatus && showLastActivityAge;
  const showToolbarStatus = showLivenessChip || showLastActivityChip;

  useEffect(() => {
    if (thinkingMode !== "off") {
      lastNonOffThinkingModeRef.current = thinkingMode;
    }
  }, [thinkingMode]);

  const toggleThinkingEnabled = useCallback(() => {
    setThinkingMode(
      thinkingMode === "off" ? lastNonOffThinkingModeRef.current : "off",
    );
  }, [setThinkingMode, thinkingMode]);

  useLayoutEffect(() => {
    const compactStatusQuery = getCompactStatusMatchMedia();
    const toolbar = toolbarRef.current;
    const left = toolbarLeftRef.current;
    const actions = toolbarActionsRef.current;

    if (!toolbar || !left || !actions || typeof window === "undefined") {
      setIsCompactStatusMode(compactStatusQuery?.matches ?? false);
      return;
    }

    let raf = 0;

    const pxOrZero = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const updateCompactStatusMode = () => {
      const status = toolbarStatusRef.current;
      const viewportCompact = compactStatusQuery?.matches ?? false;

      if (!status) {
        setIsCompactStatusMode(viewportCompact);
        return;
      }

      const toolbarStyles = getComputedStyle(toolbar);
      const gap = pxOrZero(toolbarStyles.columnGap || toolbarStyles.gap);
      const requiredWidth =
        left.scrollWidth + status.scrollWidth + actions.scrollWidth + gap * 2;
      const nextCompact =
        viewportCompact || requiredWidth > toolbar.clientWidth + 1;

      setIsCompactStatusMode((current) =>
        current === nextCompact ? current : nextCompact,
      );
    };

    const scheduleCompactStatusUpdate = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(updateCompactStatusMode);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleCompactStatusUpdate);
    resizeObserver?.observe(toolbar);
    resizeObserver?.observe(left);
    resizeObserver?.observe(actions);
    if (toolbarStatusRef.current) {
      resizeObserver?.observe(toolbarStatusRef.current);
    }

    window.addEventListener("resize", scheduleCompactStatusUpdate);
    compactStatusQuery?.addEventListener("change", scheduleCompactStatusUpdate);
    scheduleCompactStatusUpdate();

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleCompactStatusUpdate);
      compactStatusQuery?.removeEventListener(
        "change",
        scheduleCompactStatusUpdate,
      );
    };
  }, [
    livenessDisplay?.prefix,
    livenessDisplay?.timestampMs,
    livenessDisplay?.tone,
    nowMs,
    showLastActivityAge,
    showLastActivityChip,
    showLivenessChip,
    showToolbarStatus,
    showStopButton,
    showSendButton,
  ]);

  useEffect(() => {
    const handleIsearchGuide = (event: Event) => {
      const detail = (event as CustomEvent<SessionIsearchGuideState>).detail;
      if (detail?.active) {
        setIsearchScope(detail.scope);
        return;
      }
      setIsearchScope(null);
      setShortcutsOpen(false);
    };

    window.addEventListener(SESSION_ISEARCH_GUIDE_EVENT, handleIsearchGuide);
    return () =>
      window.removeEventListener(
        SESSION_ISEARCH_GUIDE_EVENT,
        handleIsearchGuide,
      );
  }, []);

  const clearHeartbeatLongPress = () => {
    if (heartbeatLongPressTimerRef.current) {
      clearTimeout(heartbeatLongPressTimerRef.current);
      heartbeatLongPressTimerRef.current = null;
    }
  };

  const handleHeartbeatClick = () => {
    if (suppressHeartbeatClickRef.current) {
      suppressHeartbeatClickRef.current = false;
      return;
    }
    onToggleHeartbeat?.();
  };

  const handleHeartbeatContextMenu = (e: MouseEvent<HTMLButtonElement>) => {
    if (!onConfigureHeartbeat) return;
    e.preventDefault();
    clearHeartbeatLongPress();
    suppressHeartbeatClickRef.current = false;
    onConfigureHeartbeat();
  };

  const handleHeartbeatTouchStart = () => {
    if (!onConfigureHeartbeat) return;
    clearHeartbeatLongPress();
    suppressHeartbeatClickRef.current = false;
    heartbeatLongPressTimerRef.current = setTimeout(() => {
      suppressHeartbeatClickRef.current = true;
      heartbeatLongPressTimerRef.current = null;
      onConfigureHeartbeat();
    }, 450);
  };

  const handleHeartbeatTouchEnd = (e: TouchEvent<HTMLButtonElement>) => {
    if (suppressHeartbeatClickRef.current) {
      e.preventDefault();
    }
    clearHeartbeatLongPress();
  };

  const heartbeatTitle = t("sessionHeartbeatTitle");

  return (
    <MessageInputToolbarView
      t={t}
      refs={{
        toolbar: toolbarRef,
        left: toolbarLeftRef,
        status: toolbarStatusRef,
        actions: toolbarActionsRef,
      }}
      visibility={toolbarVisibility}
      isCompactStatusMode={isCompactStatusMode}
      modeControl={
        onModeChange && supportsPermissionMode
          ? {
              mode,
              onModeChange,
              changesApplyNextTurn: modeChangesApplyNextTurn,
            }
          : null
      }
      attachmentControl={{
        canAttach,
        attachmentCount,
        onAttachClick,
      }}
      slashControl={
        onSelectSlashCommand
          ? {
              commands: slashCommands,
              onSelectCommand: onSelectSlashCommand,
              disabled: voiceDisabled,
            }
          : null
      }
      thinkingControl={
        supportsThinkingToggle
          ? {
              mode: thinkingMode,
              level: effectiveThinkingLevel,
              effortOptions: thinkingEffortOptions,
              onSetMode: setThinkingMode,
              onSetEffort: setEffortLevel,
              onToggleEnabled: toggleThinkingEnabled,
            }
          : null
      }
      renderModeControl={
        renderMode
          ? {
              state: renderMode.state,
              title: renderModeTitle,
              onToggle: renderMode.toggleGlobalMode,
            }
          : null
      }
      nudgeControl={
        onToggleHeartbeat
          ? {
              enabled: heartbeatEnabled,
              title: heartbeatTitle,
              onClick: handleHeartbeatClick,
              onContextMenu: handleHeartbeatContextMenu,
              onTouchStart: handleHeartbeatTouchStart,
              onTouchEnd: handleHeartbeatTouchEnd,
              onClearTouch: clearHeartbeatLongPress,
            }
          : null
      }
      speechControl={{
        showMethodSelector: showSpeechMethodSelector,
        methodOptions: speechMethodOptions,
        selectedMethod: selectedSpeechMethod,
        onMethodChange: handleSpeechMethodSelect,
        smartTurnSettings: activeSpeechSmartTurnSettings,
        onSmartTurnSettingsChange: supportsSelectedSpeechSmartTurn
          ? setSpeechSmartTurnSettings
          : undefined,
        smartTurnDisabled: voiceDisabled,
        grokAudioSettings:
          selectedSpeechMethod === "ya-grok"
            ? grokSpeechAudioSettings
            : undefined,
        onGrokAudioSettingsChange:
          selectedSpeechMethod === "ya-grok"
            ? setGrokSpeechAudioSettings
            : undefined,
        voiceButton:
          toolbarVisibility.microphone &&
          voiceButtonRef &&
          onVoiceTranscript &&
          onInterimTranscript
            ? {
                kind: "live",
                ref: voiceButtonRef,
                onTranscript: onVoiceTranscript,
                onInterimTranscript,
                onListeningStart,
                disabled: voiceDisabled,
                speechMethod: selectedSpeechMethod,
                getTranscriptionContext,
                smartTurn: activeSpeechSmartTurnSettings,
                grokSpeechAudioSettings,
              }
            : undefined,
      }}
      statusControl={{
        showToolbarStatus,
        showLivenessChip,
        livenessDisplay,
        livenessSummary,
        nowMs,
        showLastActivityChip,
        showLastActivityPrefix,
        lastActivityMs,
        lastActivitySuffix,
      }}
      pendingApproval={pendingApproval}
      shortcutsControl={{
        open: shortcutsOpen,
        isearchScope,
        setOpen: setShortcutsOpen,
        hasDualActions,
        queueShortcutLabel,
      }}
      actionsControl={{
        disabled,
        voiceDisabled,
        contextUsage,
        btw: onBtwClick
          ? {
              onClick: onBtwClick,
              pressed: btwPressed,
              mode: effectiveBtwToolbarMode,
              title: btwTitle,
            }
          : null,
        stop: showStopButton
          ? {
              onStop: onStop!,
              title: stopTitle,
            }
          : null,
        send: showSendButton
          ? {
              onSend,
              canSend,
              primaryActionKind: effectivePrimaryActionKind,
              primaryActionLabel,
              tooltip: sendTooltip,
              icon: primaryActionIcon,
              queue: {
                onQueue,
                hasDualActions,
                queueTooltip,
                showPatientQueueMode,
              },
            }
          : null,
      }}
    />
  );
}
