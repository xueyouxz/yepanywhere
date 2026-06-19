import type {
  ModelInfo,
  ProviderName,
  SessionLivenessSnapshot,
  ShowThinking,
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
import { useBrowserXaiSttApiKey } from "../hooks/useBrowserXaiSttApiKey";
import { useProviders } from "../hooks/useProviders";
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
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../lib/effortLevels";
import {
  formatAbsoluteTimestamp,
  formatCompactRelativeAge,
  isStaleTimestamp,
  parseTimestampMs,
} from "../lib/messageAge";
import { normalizeProviderKey } from "../lib/modelIndicatorText";
import { getPermissionModeOptions } from "../lib/permissionModes";
import {
  SESSION_ISEARCH_GUIDE_EVENT,
  type SessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import {
  DEFAULT_SPEECH_METHOD,
  canSpeechMethodStream,
  getSpeechMethodCapabilities,
  getSpeechMethods,
  isSpeechMethodId,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../lib/speechProviders/methods";
import type {
  SpeechSmartTurnSettings,
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
  SpeechTranscriptionSettlement,
} from "../lib/speechProviders/SpeechProvider";
import type { ContextUsage, PermissionMode } from "../types";
import { ContextThresholdQuickEdit } from "./ContextThresholdQuickEdit";
import type { FilterOption } from "./FilterDropdown";
import { MessageAge } from "./MessageAge";
import { ModeSelector } from "./ModeSelector";
import { SlashCommandButton } from "./SlashCommandButton";
import { SpeechControlMenu } from "./SpeechControlMenu";
import { SpeechWaveform } from "./SpeechWaveform";
import { ThinkingControlsPanel, ThinkingIcon } from "./ThinkingControls";
import { RenderModeGlyph } from "./ui/RenderModeGlyph";
import {
  VoiceInputButton,
  type SpeechPendingKind,
  type VoiceInputButtonRef,
} from "./VoiceInputButton";

type ToolbarTranslate = ReturnType<typeof useI18n>["t"];

type ComposerOverflowTier = "none" | "early" | "medium" | "late";
const COMPOSER_OVERFLOW_TIERS: ComposerOverflowTier[] = [
  "none",
  "early",
  "medium",
  "late",
];

function getFlexGapPx(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return Number.parseFloat(style.columnGap || style.gap) || 0;
}

function getVisibleControlWidth(element: HTMLElement): number {
  if (element.dataset.composerElastic === "true") {
    return 0;
  }
  const style = getComputedStyle(element);
  if (style.display === "none" || style.position === "absolute") {
    return 0;
  }
  return element.getBoundingClientRect().width;
}

function getControlListWidth(element: HTMLElement): number {
  const childWidths = Array.from(element.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .map(getVisibleControlWidth)
    .filter((width) => width > 0);
  if (childWidths.length === 0) {
    return 0;
  }
  const gap = getFlexGapPx(element);
  return (
    childWidths.reduce((total, width) => total + width, 0) +
    gap * (childWidths.length - 1)
  );
}

function getIsearchPreviousKeys(scope: SessionIsearchScope): string[] {
  if (scope === "full") {
    return ["Ctrl", "Alt", "S"];
  }
  if (scope === "all") {
    return ["Ctrl", "S"];
  }
  return ["Ctrl", "R"];
}

function getIsearchAlternateRows(
  scope: SessionIsearchScope,
  t: ToolbarTranslate,
): Array<{
  scope: SessionIsearchScope;
  keys: string[];
  label: string;
}> {
  return [
    ...(scope === "user"
      ? []
      : [
          {
            scope: "user" as const,
            keys: ["Ctrl", "R"],
            label: t("toolbarShortcutUserTurns"),
          },
        ]),
    ...(scope === "all"
      ? []
      : [
          {
            scope: "all" as const,
            keys: ["Ctrl", "S"],
            label: t("toolbarShortcutAllTurns"),
          },
        ]),
    ...(scope === "full"
      ? []
      : [
          {
            scope: "full" as const,
            keys: ["Ctrl", "Alt", "S"],
            label: t("toolbarShortcutFullSession"),
          },
        ]),
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
  onListeningStop?: () => void;
  onPendingSpeechChange?: (kind: SpeechPendingKind | null) => void;
  onTranscriptionSettled?: (settlement: SpeechTranscriptionSettlement) => void;
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
  /**
   * YA model id (launch alias) used to key the context quick-edit's per-model
   * compaction threshold. Distinct from `thinkingModel` (the reported model);
   * falls back to it when absent. See topics/provider-abstraction.md.
   */
  contextRequestedModel?: string;

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
  /** Whether the provider exposes a soft-immediate steer lane. */
  showSteerNowMode?: boolean;
  /** Whether steering uses the soft-immediate lane for future sends. */
  steerNowEnabled?: boolean;
  /** Toggle soft-immediate steering for future steer sends. */
  onToggleSteerNow?: () => void;
  /** The action currently bound to Enter in dual-action steering sessions. */
  enterActionKind?: "steer" | "queue";
  /** Whether Enter and Ctrl+Enter may be swapped. */
  canSwapEnterAction?: boolean;
  /** Swap Enter and Ctrl+Enter in dual-action steering sessions. */
  onSwapEnterAction?: () => void;

  // Actions
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onSend?: () => void;
  /** Queue a deferred message. Only provided when agent is running. */
  onQueue?: () => void;
  /** Steer the current turn. Used as the alternate action when Enter queues. */
  onSteer?: () => void;
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
  t: ToolbarTranslate,
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
        prefix: t("toolbarLivenessVerifiedProgress"),
        timestampMs: progressMs ?? checkedMs,
        tone: "ok",
        title,
      };
    case "recently-active-unverified":
      return {
        prefix: t("toolbarLivenessUnverifiedTurn"),
        timestampMs: stateMs ?? checkedMs,
        tone: "warn",
        title,
      };
    case "long-silent-unverified":
      return {
        prefix: t("toolbarLivenessLongSilent"),
        timestampMs: progressMs ?? stateMs ?? checkedMs,
        tone: "danger",
        title,
      };
    case "verified-waiting-provider":
      return {
        prefix: t("toolbarLivenessWaitingOnProvider"),
        timestampMs: progressMs ?? stateMs ?? checkedMs,
        tone: "warn",
        title,
      };
    case "verified-idle":
      return {
        prefix: t("toolbarLivenessVerifiedIdle"),
        timestampMs: idleMs ?? stateMs ?? checkedMs,
        tone: "muted",
        title,
      };
    case "needs-attention":
      return {
        prefix:
          snapshot.activeWorkKind === "waiting-input"
            ? t("toolbarLivenessNeedsInput")
            : t("toolbarLivenessNeedsAttention"),
        timestampMs: stateMs ?? checkedMs,
        tone: "danger",
        title,
      };
  }

  const unhandledStatus: never = snapshot.derivedStatus;
  return {
    prefix: t("toolbarLivenessUnknownState"),
    timestampMs: checkedMs,
    tone: "warn",
    title: `${title}\nunknown status: ${String(unhandledStatus)}`,
  };
}

function formatLivenessAge(
  t: ToolbarTranslate,
  timestampMs: number,
  nowMs: number,
): string {
  const label = formatCompactRelativeAge(timestampMs, nowMs);
  return label === "now"
    ? t("toolbarRelativeAgeNow")
    : t("toolbarRelativeAgePast", { age: label });
}

function describeLivenessSummary(
  t: ToolbarTranslate,
  display: LivenessDisplay,
  nowMs: number,
): string {
  if (display.timestampMs === null) {
    return display.prefix;
  }
  return t("toolbarLivenessSummary", {
    state: display.prefix,
    age: formatLivenessAge(t, display.timestampMs, nowMs),
  });
}

function getBtwTitle(mode: BtwToolbarMode, t: ToolbarTranslate): string {
  switch (mode) {
    case "child-session":
      return t("toolbarBtwChildSessionTitle");
    case "focused-footer":
      return t("toolbarBtwFocusedFooterTitle");
    case "focused-pane":
      return t("toolbarBtwFocusedPaneTitle");
    case "focus-existing":
      return t("toolbarBtwFocusExistingTitle");
    case "start":
      return t("toolbarBtwStartTitle");
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
  modes?: readonly PermissionMode[];
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
  modeOptions?: readonly ThinkingMode[];
  level: EffortLevel;
  effortOptions: EffortLevelOption[];
  onSetMode: (mode: ThinkingMode) => void;
  onSetEffort: (level: EffortLevel) => void;
  onToggleEnabled: () => void;
  /** "Show thinking" preference (default/on/off); all providers. */
  showThinking: ShowThinking;
  onSetShowThinking: (value: ShowThinking) => void;
  /** Provider for resolving the inherited "default" show-thinking cue. */
  provider?: string | null;
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
      onListeningStop?: () => void;
      onPendingSpeechChange?: (kind: SpeechPendingKind | null) => void;
      onTranscriptionSettled?: (
        settlement: SpeechTranscriptionSettlement,
      ) => void;
      showWaveform?: boolean;
      disabled?: boolean;
      speechMethod: SpeechMethodId;
      getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
      smartTurn?: SpeechSmartTurnSettings;
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
  lastActivityIsPast: boolean;
}

interface ToolbarShortcutsControl {
  open: boolean;
  isearchScope: SessionIsearchScope | null;
  setOpen: Dispatch<SetStateAction<boolean>>;
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  hasDualActions: boolean;
  enterActionKind: "send" | "steer" | "queue";
  canSwapEnterAction: boolean;
  onSwapEnterAction?: () => void;
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
  onSteer?: () => void;
  hasDualActions: boolean;
  queueTooltip: string;
}

interface ToolbarSendControl {
  onSend?: () => void;
  onSteer?: () => void;
  canSend?: boolean;
  primaryActionKind: "send" | "steer" | "queue";
  primaryActionLabel: string;
  tooltip: string;
  icon: string;
  showSteerNowMode?: boolean;
  steerNowEnabled?: boolean;
  onToggleSteerNow?: () => void;
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
  /** Session model id, for the long-press compact-threshold quick-edit. */
  contextModel?: string;
  /** Model context window, for the quick-edit token preview. */
  contextWindow?: number;
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
  speechWaveformActive?: boolean;
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

function getToolbarThinkingLabel(
  t: ToolbarTranslate,
  control: ToolbarThinkingControl,
): string {
  if (control.mode === "off") return t("modelSettingsThinkingOffLabel");
  if (control.mode === "auto") return t("modelSettingsThinkingAutoLabel");
  if (control.level === "xhigh") return t("effortLevelExtraHighShortLabel");
  return (
    control.effortOptions.find((option) => option.value === control.level)
      ?.label ?? getEffortLevelLabel(control.level, undefined, t)
  );
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
              )?.label ?? getEffortLevelLabel(control.level, undefined, t),
          });
  return t("toolbarThinkingTitle", { current });
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
        <ThinkingIcon mode={control.mode} />
        <span className="thinking-toggle-label">
          {getToolbarThinkingLabel(t, control)}
        </span>
      </button>
      {open && (
        <div className="thinking-toolbar-menu" role="menu">
          <ThinkingControlsPanel
            mode={control.mode}
            modeOptions={control.modeOptions}
            onSetMode={control.onSetMode}
            level={control.level}
            effortOptions={control.effortOptions}
            onSetEffort={control.onSetEffort}
            showThinking={control.showThinking}
            onSetShowThinking={control.onSetShowThinking}
            provider={control.provider}
            t={t}
            onSelect={close}
            optionRole="menuitemradio"
          />
          <div className="thinking-toolbar-menu-hint">
            {t("toolbarThinkingAppliesNextTurn")}
          </div>
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
  speechWaveformActive = false,
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
  const canToggleSteerNow = !!(
    visibility.steerNow &&
    actionsControl.send?.showSteerNowMode &&
    actionsControl.send.onToggleSteerNow
  );
  const hasBottomOverflowControls = !!(
    (visibility.modeSelector && modeControl) ||
    visibility.attachments ||
    (visibility.slashMenu && slashControl) ||
    (visibility.thinkingToggle && thinkingControl) ||
    (visibility.renderMode && renderModeControl) ||
    (visibility.nudge && nudgeControl) ||
    visibility.shortcutsHelp
  );
  const [bottomOverflowOpen, setBottomOverflowOpen] = useState(false);
  const [bottomOverflowTier, setBottomOverflowTier] =
    useState<ComposerOverflowTier>(() =>
      typeof ResizeObserver === "undefined" ? "late" : "none",
    );
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lastToolbarWidthRef = useRef(0);
  const shortcutsLongPressTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const setToolbarRef = useCallback(
    (node: HTMLDivElement | null) => {
      toolbarRef.current = node;
      if (refs?.toolbar) {
        refs.toolbar.current = node;
      }
    },
    [refs?.toolbar],
  );

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !hasBottomOverflowControls) {
      if (bottomOverflowTier !== "none") {
        setBottomOverflowTier("none");
      }
      return;
    }

    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const left =
        refs?.left?.current ?? toolbar.querySelector(".message-input-left");
      const actions =
        refs?.actions?.current ??
        toolbar.querySelector(".message-input-actions");
      if (!(left instanceof HTMLElement) || !(actions instanceof HTMLElement)) {
        return;
      }
      const leftRect = left.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      if (leftRect.width === 0 && actionsRect.width === 0) {
        setBottomOverflowTier("late");
        return;
      }
      const leftWidth = getControlListWidth(left);
      const actionsWidth = getControlListWidth(actions);
      const overflow = toolbar.querySelector(".composer-bottom-overflow");
      const overflowWidth =
        overflow instanceof HTMLElement ? getVisibleControlWidth(overflow) : 0;
      const visibleSectionCount = [
        leftWidth,
        overflowWidth,
        actionsWidth,
      ].filter((width) => width > 0).length;
      const totalWidth =
        leftWidth +
        overflowWidth +
        actionsWidth +
        getFlexGapPx(toolbar) * Math.max(0, visibleSectionCount - 1);
      const availableWidth = toolbar.getBoundingClientRect().width;
      if (totalWidth <= availableWidth + 0.5) {
        return;
      }
      setBottomOverflowTier((tier) => {
        const tierIndex = COMPOSER_OVERFLOW_TIERS.indexOf(tier);
        return (
          COMPOSER_OVERFLOW_TIERS[
            Math.min(tierIndex + 1, COMPOSER_OVERFLOW_TIERS.length - 1)
          ] ?? "late"
        );
      });
    };
    const scheduleMeasure = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(measure);
    };
    const handleResize: ResizeObserverCallback = (entries) => {
      const toolbarEntry = entries.find((entry) => entry.target === toolbar);
      if (toolbarEntry) {
        const nextWidth = toolbarEntry.contentRect.width;
        if (nextWidth > lastToolbarWidthRef.current + 1) {
          setBottomOverflowTier("none");
        }
        lastToolbarWidthRef.current = nextWidth;
      }
      scheduleMeasure();
    };

    scheduleMeasure();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(toolbar);
      if (refs?.left?.current) {
        resizeObserver.observe(refs.left.current);
      }
      if (refs?.actions?.current) {
        resizeObserver.observe(refs.actions.current);
      }
    }
    return () => {
      resizeObserver?.disconnect();
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    bottomOverflowTier,
    hasBottomOverflowControls,
    refs?.actions,
    refs?.left,
  ]);

  const openShortcutSettings = () => {
    shortcutsControl.setOpen(true);
    shortcutsControl.setSettingsOpen(true);
  };
  const clearShortcutsLongPress = () => {
    if (shortcutsLongPressTimerRef.current) {
      clearTimeout(shortcutsLongPressTimerRef.current);
      shortcutsLongPressTimerRef.current = null;
    }
  };
  const startShortcutsLongPress = () => {
    clearShortcutsLongPress();
    shortcutsLongPressTimerRef.current = setTimeout(() => {
      shortcutsLongPressTimerRef.current = null;
      openShortcutSettings();
    }, 520);
  };

  return (
    <div
      ref={setToolbarRef}
      className={`message-input-toolbar${isCompactStatusMode ? " status-floats" : ""} overflow-tier-${bottomOverflowTier}`}
    >
      <div ref={refs?.left} className="message-input-left">
        {visibility.modeSelector && modeControl && (
          <span className="composer-bottom-overflow-inline composer-bottom-overflow-early">
            <ModeSelector
              mode={modeControl.mode}
              onModeChange={modeControl.onModeChange}
              modes={modeControl.modes}
              changesApplyNextTurn={modeControl.changesApplyNextTurn}
            />
          </span>
        )}
        {visibility.attachments && (
          <button
            type="button"
            className="attach-button composer-bottom-overflow-inline composer-bottom-overflow-early"
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
          <span className="composer-bottom-overflow-inline composer-bottom-overflow-medium">
            <SlashCommandButton
              commands={slashControl.commands}
              onSelectCommand={slashControl.onSelectCommand}
              disabled={slashControl.disabled}
            />
          </span>
        )}
        {visibility.thinkingToggle && thinkingControl && (
          <span className="composer-bottom-overflow-inline composer-bottom-overflow-medium">
            <ThinkingToolbarControl control={thinkingControl} t={t} />
          </span>
        )}
        {visibility.renderMode && renderModeControl && (
          <button
            type="button"
            className={`render-mode-toolbar-button composer-bottom-overflow-inline composer-bottom-overflow-late ${
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
            className={`heartbeat-toolbar-button composer-bottom-overflow-inline composer-bottom-overflow-late ${nudgeControl.enabled ? "active" : ""}`}
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
              onBeforeOpen={() => {
                if (speechControl.voiceButton?.kind !== "live") return;
                speechControl.voiceButton.onListeningStop?.();
                speechControl.voiceButton.ref?.current?.stopAndFinalize();
                speechControl.voiceButton.onInterimTranscript("");
              }}
              onBeforeCaptureChange={() => {
                if (speechControl.voiceButton?.kind !== "live") return;
                speechControl.voiceButton.onListeningStop?.();
                speechControl.voiceButton.ref?.current?.stopAndFinalize();
                speechControl.voiceButton.onInterimTranscript("");
              }}
              onPointerNearTrigger={() =>
                speechControl.voiceButton?.kind === "live"
                  ? speechControl.voiceButton.ref?.current?.prewarm?.()
                  : undefined
              }
              trigger={
                <VoiceInputButton
                  ref={speechControl.voiceButton.ref}
                  onTranscript={speechControl.voiceButton.onTranscript}
                  onInterimTranscript={
                    speechControl.voiceButton.onInterimTranscript
                  }
                  onListeningStart={speechControl.voiceButton.onListeningStart}
                  onListeningStop={speechControl.voiceButton.onListeningStop}
                  onPendingSpeechChange={
                    speechControl.voiceButton.onPendingSpeechChange
                  }
                  onTranscriptionSettled={
                    speechControl.voiceButton.onTranscriptionSettled
                  }
                  disabled={speechControl.voiceButton.disabled}
                  speechMethod={speechControl.voiceButton.speechMethod}
                  getTranscriptionContext={
                    speechControl.voiceButton.getTranscriptionContext
                  }
                  smartTurn={speechControl.voiceButton.smartTurn}
                  showWaveform={speechControl.voiceButton.showWaveform}
                />
              }
            />
          )}
        {speechWaveformActive && <SpeechWaveform />}
      </div>
      {showToolbarStatus && statusControl && (
        <div ref={refs?.status} className="composer-status-ages">
          {showLivenessChip && livenessDisplay && (
            <div
              className={`composer-status-chip composer-liveness-status is-${livenessDisplay.tone}`}
              role="status"
              aria-label={t("toolbarLivenessAria", {
                summary: statusControl.livenessSummary ?? "",
              })}
              title={livenessDisplay.title}
            >
              {livenessDisplay.timestampMs !== null ? (
                <time
                  className="composer-liveness-time"
                  dateTime={new Date(livenessDisplay.timestampMs).toISOString()}
                  title={`${formatAbsoluteTimestamp(livenessDisplay.timestampMs)}\n${livenessDisplay.title}`}
                >
                  {formatLivenessAge(
                    t,
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
              aria-label={t("toolbarLastActivityAria")}
            >
              <MessageAge
                timestampMs={statusControl.lastActivityMs}
                nowMs={statusControl.nowMs}
                className="composer-activity-age-time"
                formatLabel={(label) => {
                  const localizedLabel =
                    label === "now" ? t("toolbarRelativeAgeNow") : label;
                  if (statusControl.showLastActivityPrefix) {
                    return t("toolbarLastActivityAge", {
                      age: localizedLabel,
                    });
                  }
                  return statusControl.lastActivityIsPast
                    ? t("toolbarRelativeAgePast", { age: localizedLabel })
                    : localizedLabel;
                }}
              />
            </div>
          )}
        </div>
      )}
      {hasBottomOverflowControls && bottomOverflowTier !== "none" && (
        <div
          className={`composer-bottom-overflow ${
            bottomOverflowOpen ? "is-open" : ""
          }`}
        >
          <button
            type="button"
            className="composer-bottom-overflow-button"
            aria-label={t("toolbarOverflowMenu")}
            aria-expanded={bottomOverflowOpen}
            onClick={() => setBottomOverflowOpen((open) => !open)}
          >
            ...
          </button>
          {bottomOverflowOpen && (
            <div className="composer-bottom-overflow-menu" role="menu">
              <div className="composer-bottom-overflow-menu-group composer-bottom-overflow-menu-left">
                {visibility.modeSelector && modeControl && (
                  <ModeSelector
                    mode={modeControl.mode}
                    onModeChange={modeControl.onModeChange}
                    modes={modeControl.modes}
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
                    role="menuitem"
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
              </div>
              <div className="composer-bottom-overflow-menu-group composer-bottom-overflow-menu-right">
                {visibility.slashMenu && slashControl && (
                  <span className="composer-bottom-overflow-medium">
                    <SlashCommandButton
                      commands={slashControl.commands}
                      onSelectCommand={slashControl.onSelectCommand}
                      disabled={slashControl.disabled}
                    />
                  </span>
                )}
                {visibility.thinkingToggle && thinkingControl && (
                  <span className="composer-bottom-overflow-medium">
                    <ThinkingToolbarControl control={thinkingControl} t={t} />
                  </span>
                )}
                {visibility.renderMode && renderModeControl && (
                  <button
                    type="button"
                    className={`render-mode-toolbar-button composer-bottom-overflow-late ${
                      renderModeControl.state === "rendered"
                        ? "is-rendered"
                        : renderModeControl.state === "mixed"
                          ? "is-mixed"
                          : ""
                    }`}
                    onClick={renderModeControl.onToggle}
                    title={renderModeControl.title}
                    aria-label={renderModeControl.title}
                    role="menuitemcheckbox"
                    aria-checked={
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
                    className={`heartbeat-toolbar-button composer-bottom-overflow-late ${nudgeControl.enabled ? "active" : ""}`}
                    onClick={nudgeControl.onClick}
                    onContextMenu={nudgeControl.onContextMenu}
                    onTouchStart={nudgeControl.onTouchStart}
                    onTouchEnd={nudgeControl.onTouchEnd}
                    onTouchCancel={nudgeControl.onClearTouch}
                    onTouchMove={nudgeControl.onClearTouch}
                    title={nudgeControl.title}
                    aria-label={nudgeControl.title}
                    role="menuitemcheckbox"
                    aria-checked={nudgeControl.enabled}
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
                {visibility.shortcutsHelp && (
                  <button
                    type="button"
                    className="session-shortcuts-help-button composer-bottom-overflow-late"
                    aria-label={t("toolbarKeyboardShortcutsAria")}
                    aria-expanded={shortcutsPopoverOpen}
                    onClick={() => shortcutsControl.setOpen((open) => !open)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openShortcutSettings();
                    }}
                    onTouchStart={startShortcutsLongPress}
                    onTouchEnd={clearShortcutsLongPress}
                    onTouchCancel={clearShortcutsLongPress}
                    onTouchMove={clearShortcutsLongPress}
                    role="menuitem"
                  >
                    ?
                  </button>
                )}
              </div>
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
            className="session-shortcuts-help composer-bottom-overflow-inline composer-bottom-overflow-late"
            onMouseLeave={() => {
              shortcutsControl.setOpen(false);
              shortcutsControl.setSettingsOpen(false);
            }}
          >
            <button
              type="button"
              className="session-shortcuts-help-button"
              aria-label={t("toolbarKeyboardShortcutsAria")}
              aria-expanded={shortcutsPopoverOpen}
              onClick={() => shortcutsControl.setOpen((open) => !open)}
              onContextMenu={(event) => {
                event.preventDefault();
                openShortcutSettings();
              }}
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
              onTouchStart={startShortcutsLongPress}
              onTouchEnd={clearShortcutsLongPress}
              onTouchCancel={clearShortcutsLongPress}
              onTouchMove={clearShortcutsLongPress}
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
                            <span>{t("commonOr")}</span>
                            <kbd>Ctrl</kbd>
                            <kbd>Alt</kbd>
                            <kbd>R</kbd>
                          </>
                        )}
                      </span>
                      <span>{t("toolbarShortcutPreviousMatch")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Enter</kbd>
                      </span>
                      <span>{t("toolbarShortcutJump")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>↑</kbd>
                        <kbd>↓</kbd>
                      </span>
                      <span>{t("toolbarShortcutPreviousNextMatch")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        {t("toolbarShortcutClick")}
                      </span>
                      <span>{t("toolbarShortcutPreviewRailJumps")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Esc</kbd>
                      </span>
                      <span>{t("toolbarShortcutCancelRestoreFocus")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>End</kbd>
                      </span>
                      <span>{t("toolbarShortcutScrollToCurrent")}</span>
                    </div>
                    {getIsearchAlternateRows(
                      shortcutsControl.isearchScope,
                      t,
                    ).map((row) => (
                      <div key={row.label} className="session-shortcuts-row">
                        <span className="session-shortcuts-keys">
                          {row.keys.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                          {row.scope === "user" && (
                            <>
                              <span>{t("commonOr")}</span>
                              <kbd>Ctrl</kbd>
                              <kbd>Alt</kbd>
                              <kbd>R</kbd>
                            </>
                          )}
                        </span>
                        <span>{row.label}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>R</kbd>
                        <span>{t("commonOr")}</span>
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>R</kbd>
                      </span>
                      <span>{t("toolbarShortcutUserTurnReverseSearch")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>S</kbd>
                      </span>
                      <span>{t("toolbarShortcutAllTurnReverseSearch")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>S</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutFullSessionReverseSearch")}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Enter</kbd>
                      </span>
                      <span>
                        {shortcutsControl.hasDualActions
                          ? t("toolbarShortcutSteerCurrentTurn")
                          : t("toolbarShortcutSend")}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Shift</kbd>
                        <kbd>Enter</kbd>
                      </span>
                      <span>{t("toolbarShortcutNewLine")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Enter</kbd>
                      </span>
                      <span>{shortcutsControl.queueShortcutLabel}</span>
                    </div>
                    <div className="session-shortcuts-row session-shortcuts-row-muted">
                      <span className="session-shortcuts-keys">
                        {t("toolbarShortcutRightClickLongPress")}
                      </span>
                      <span>{t("toolbarShortcutChangeKeys")}</span>
                    </div>
                    {shortcutsControl.settingsOpen &&
                      shortcutsControl.canSwapEnterAction &&
                      shortcutsControl.onSwapEnterAction && (
                        <div className="session-shortcuts-settings">
                          <div className="session-shortcuts-row">
                            <span className="session-shortcuts-keys">
                              <kbd>Enter</kbd>
                            </span>
                            <span>
                              {shortcutsControl.enterActionKind === "queue"
                                ? t("toolbarShortcutQueueCurrentTurn")
                                : t("toolbarShortcutSteerCurrentTurn")}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="session-shortcuts-action"
                            onClick={shortcutsControl.onSwapEnterAction}
                          >
                            {t("toolbarShortcutSwapEnterCtrlEnter")}
                          </button>
                        </div>
                      )}
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>B</kbd>
                      </span>
                      <span>{t("toolbarShortcutStartBtwAside")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Esc</kbd>
                      </span>
                      <span>{t("toolbarShortcutStopAgentCancelOverlay")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>P</kbd>
                      </span>
                      <span>{t("toolbarShortcutRecallLastSentText")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>K</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutCancelLatestQueuedMessage")}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>O</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutToggleThinkingTranscript")}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>End</kbd>
                      </span>
                      <span>{t("toolbarShortcutScrollToCurrent")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>G</kbd>
                      </span>
                      <span>{t("toolbarShortcutClearComposer")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Shift</kbd>
                        <kbd>M</kbd>
                      </span>
                      <span>{t("toolbarShortcutRenderedSourceMode")}</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {visibility.contextUsage && (
          <ContextThresholdQuickEdit
            usage={actionsControl.contextUsage}
            model={actionsControl.contextModel}
            contextWindow={actionsControl.contextWindow}
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
            {canToggleSteerNow && actionsControl.send && (
              <label
                className="steer-now-toggle"
                title={t("toolbarSteerNowTooltip")}
              >
                <input
                  type="checkbox"
                  checked={!!actionsControl.send.steerNowEnabled}
                  onChange={actionsControl.send.onToggleSteerNow}
                  disabled={actionsControl.disabled}
                  aria-label={t("toolbarSteerNowLabel")}
                />
                <span>{t("toolbarSteerNowShortLabel")}</span>
              </label>
            )}
            {queueControl?.hasDualActions &&
              actionsControl.send.primaryActionKind !== "queue" &&
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
                  <span className="send-icon queue-icon">→</span>
                </button>
              )}
            {queueControl?.hasDualActions &&
              actionsControl.send.primaryActionKind === "queue" &&
              queueControl.onSteer && (
                <button
                  type="button"
                  onClick={queueControl.onSteer}
                  disabled={
                    actionsControl.disabled || !actionsControl.send.canSend
                  }
                  className="send-button steer-button"
                  aria-label={t("toolbarSteerTooltip")}
                  title={t("toolbarSteerTooltip")}
                >
                  <span className="send-icon">↗</span>
                </button>
              )}
            <button
              type="button"
              onClick={actionsControl.send?.onSend}
              disabled={actionsControl.disabled || !actionsControl.send.canSend}
              className={`send-button send-button-with-help ${
                actionsControl.send.primaryActionKind === "queue"
                  ? "queue-mode"
                  : ""
              }`}
              aria-label={actionsControl.send.primaryActionLabel}
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
  onListeningStop,
  onPendingSpeechChange,
  onTranscriptionSettled,
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
  contextRequestedModel,
  heartbeatEnabled = false,
  onToggleHeartbeat,
  onConfigureHeartbeat,
  contextUsage,
  lastActivityAt,
  sessionLiveness,
  showSteerNowMode = false,
  steerNowEnabled = false,
  onToggleSteerNow,
  enterActionKind,
  canSwapEnterAction = false,
  onSwapEnterAction,
  isRunning,
  isThinking,
  onStop,
  onSend,
  onQueue,
  onSteer,
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
    showThinking = "default",
    setShowThinking,
    voiceInputEnabled = true,
    speechMethod = "browser-native",
    hasStoredSpeechMethod = false,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
  } = useModelSettings();
  const { version: versionInfo } = useVersion();
  const { providers } = useProviders();
  const { visibility: toolbarVisibility } = useSessionToolbarVisibility();
  const renderMode = useOptionalRenderModeContext();
  const nowMs = useRelativeNow();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = useState(false);
  const [isearchScope, setIsearchScope] = useState<SessionIsearchScope | null>(
    null,
  );
  const [speechCaptureActive, setSpeechCaptureActive] = useState(false);
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
  const thinkingProviderInfo = useMemo(
    () =>
      providers.find(
        (provider) => provider.name === normalizedThinkingProvider,
      ) ?? null,
    [normalizedThinkingProvider, providers],
  );
  const thinkingModelInfo = useMemo<ModelInfo | null>(
    () =>
      thinkingProviderInfo?.models?.find(
        (model) => model.id === thinkingModel,
      ) ?? null,
    [thinkingModel, thinkingProviderInfo],
  );
  const thinkingEffortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider:
          thinkingProviderInfo ?? (normalizedThinkingProvider as ProviderName),
        model: thinkingModelInfo ?? thinkingModel,
        translate: t,
      }),
    [
      thinkingModel,
      thinkingModelInfo,
      thinkingProviderInfo,
      normalizedThinkingProvider,
      t,
    ],
  );
  const effectiveThinkingLevel = useMemo(
    () => resolveSupportedEffortLevel(thinkingLevel, thinkingEffortOptions),
    [thinkingEffortOptions, thinkingLevel],
  );
  const thinkingModeOptions = useMemo(
    () =>
      getThinkingModeOptions({
        provider:
          thinkingProviderInfo ?? (normalizedThinkingProvider as ProviderName),
        model: thinkingModelInfo ?? thinkingModel,
        effortOptions: thinkingEffortOptions,
      }),
    [
      thinkingEffortOptions,
      thinkingModel,
      thinkingModelInfo,
      thinkingProviderInfo,
      normalizedThinkingProvider,
    ],
  );
  const effectiveThinkingMode = useMemo(
    () => resolveSupportedThinkingMode(thinkingMode, thinkingModeOptions),
    [thinkingMode, thinkingModeOptions],
  );
  const permissionModeOptions = useMemo(
    () =>
      getPermissionModeOptions({
        model: thinkingModelInfo,
        currentMode: mode,
      }),
    [mode, thinkingModelInfo],
  );
  const hasThinkingModeOptions = thinkingModeOptions.some(
    (option) => option !== "off",
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
  const lastActivityIsPast =
    showLastActivityAge &&
    !showLastActivityPrefix &&
    lastActivityMs !== null &&
    formatCompactRelativeAge(lastActivityMs, nowMs) !== "now";
  const livenessDisplay = sessionLiveness
    ? describeSessionLiveness(sessionLiveness, t)
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
    ? describeLivenessSummary(t, livenessDisplay, nowMs)
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
  const hasPotentialDualActions = !!(onSend && onQueue && onSteer);
  const effectivePrimaryActionKind =
    primaryActionKind ?? (hasPotentialDualActions ? "steer" : "send");
  const hasDualActions =
    hasPotentialDualActions &&
    (effectivePrimaryActionKind === "steer" ||
      effectivePrimaryActionKind === "queue");
  const queueActionTooltip = t("toolbarQueueTooltip");
  const sendTooltip =
    effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? queueActionTooltip
        : t("toolbarSendTooltip");
  const queueTooltip = queueActionTooltip;
  const queueShortcutLabel =
    canSwapEnterAction && effectivePrimaryActionKind === "queue"
      ? t("toolbarShortcutSteerCurrentTurn")
      : t("toolbarShortcutQueueCurrentTurn");
  const effectiveBtwToolbarMode =
    btwToolbarMode ??
    (btwActive ? "focused-footer" : btwHasAsides ? "focus-existing" : "start");
  const btwTitle = getBtwTitle(effectiveBtwToolbarMode, t);
  const btwPressed = isBtwPressed(effectiveBtwToolbarMode);
  const primaryActionIcon =
    effectivePrimaryActionKind === "steer"
      ? "↗"
      : effectivePrimaryActionKind === "queue"
        ? "→"
        : "↑";
  const primaryActionLabel =
    effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? hasDualActions
          ? t("toolbarQueuePrimaryActionLabel")
          : t("toolbarQueueLabel")
        : t("toolbarSend");
  const stopTitle = `${t("toolbarStop")} (Esc)`;
  const showStopButton = !!(isRunning && onStop && isThinking && !canSend);
  const showSendButton = !!(onSend && (!showStopButton || canSend));
  const serverVoiceEnabled =
    versionInfo?.capabilities?.includes("voiceInput") ?? true;
  const { hasBrowserXaiSttApiKey } = useBrowserXaiSttApiKey();
  const speechMethodOptions = useMemo((): FilterOption<SpeechMethodId>[] => {
    const serverBackends = versionInfo?.voiceBackends ?? [];
    return getSpeechMethods(serverBackends, undefined, {
      directXaiAvailable: hasBrowserXaiSttApiKey,
    }).map((method) => ({
      value: method.id,
      label: method.label,
      description: method.description,
    }));
  }, [versionInfo?.voiceBackends, hasBrowserXaiSttApiKey]);
  const selectedSpeechMethod = useMemo(
    () =>
      resolveSpeechMethod(
        speechMethod,
        versionInfo?.voiceBackends,
        hasStoredSpeechMethod,
        { directXaiAvailable: hasBrowserXaiSttApiKey },
      ),
    [
      speechMethod,
      versionInfo?.voiceBackends,
      hasStoredSpeechMethod,
      hasBrowserXaiSttApiKey,
    ],
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
  const selectedSpeechMethodCapabilities = getSpeechMethodCapabilities(
    selectedSpeechMethod,
    versionInfo?.voiceBackendCapabilities,
  );
  const selectedSpeechCanStream = canSpeechMethodStream({
    methodId: selectedSpeechMethod,
    serverCapabilities: versionInfo?.voiceBackendCapabilities,
  });
  const supportsSelectedSpeechSmartTurn =
    selectedSpeechCanStream &&
    selectedSpeechMethodCapabilities.smartTurn === true;
  const activeSpeechSmartTurnSettings: SpeechSmartTurnSettings | undefined =
    supportsSelectedSpeechSmartTurn ? speechSmartTurnSettings : undefined;
  const showLastActivityChip =
    toolbarVisibility.sessionStatus && showLastActivityAge;
  const showToolbarStatus = showLivenessChip || showLastActivityChip;

  useEffect(() => {
    if (effectiveThinkingMode !== "off") {
      lastNonOffThinkingModeRef.current = effectiveThinkingMode;
    }
  }, [effectiveThinkingMode]);

  const toggleThinkingEnabled = useCallback(() => {
    const nextEnabledMode = thinkingModeOptions.includes(
      lastNonOffThinkingModeRef.current,
    )
      ? lastNonOffThinkingModeRef.current
      : (thinkingModeOptions.find((option) => option !== "off") ?? "auto");
    setThinkingMode(effectiveThinkingMode === "off" ? nextEnabledMode : "off");
  }, [effectiveThinkingMode, setThinkingMode, thinkingModeOptions]);

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
  const handleToolbarPendingSpeechChange = useCallback(
    (kind: SpeechPendingKind | null) => {
      setSpeechCaptureActive(kind === "listening");
      onPendingSpeechChange?.(kind);
    },
    [onPendingSpeechChange],
  );

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
              modes: permissionModeOptions,
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
        supportsThinkingToggle && hasThinkingModeOptions
          ? {
              mode: effectiveThinkingMode,
              modeOptions: thinkingModeOptions,
              level: effectiveThinkingLevel,
              effortOptions: thinkingEffortOptions,
              onSetMode: setThinkingMode,
              onSetEffort: setEffortLevel,
              onToggleEnabled: toggleThinkingEnabled,
              showThinking,
              onSetShowThinking: setShowThinking ?? (() => {}),
              provider: normalizedThinkingProvider,
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
                onListeningStop,
                onPendingSpeechChange: handleToolbarPendingSpeechChange,
                onTranscriptionSettled,
                showWaveform: toolbarVisibility.waveform,
                disabled: voiceDisabled,
                speechMethod: selectedSpeechMethod,
                getTranscriptionContext,
                smartTurn: activeSpeechSmartTurnSettings,
              }
            : undefined,
      }}
      speechWaveformActive={
        toolbarVisibility.waveform &&
        speechCaptureActive &&
        selectedSpeechMethod !== DEFAULT_SPEECH_METHOD
      }
      statusControl={{
        showToolbarStatus,
        showLivenessChip,
        livenessDisplay,
        livenessSummary,
        nowMs,
        showLastActivityChip,
        showLastActivityPrefix,
        lastActivityMs,
        lastActivityIsPast,
      }}
      pendingApproval={pendingApproval}
      shortcutsControl={{
        open: shortcutsOpen,
        isearchScope,
        setOpen: setShortcutsOpen,
        settingsOpen: shortcutSettingsOpen,
        setSettingsOpen: setShortcutSettingsOpen,
        hasDualActions,
        enterActionKind: enterActionKind ?? effectivePrimaryActionKind,
        canSwapEnterAction,
        onSwapEnterAction,
        queueShortcutLabel,
      }}
      actionsControl={{
        disabled,
        voiceDisabled,
        contextUsage,
        contextModel: contextRequestedModel ?? thinkingModel,
        contextWindow: thinkingModelInfo?.contextWindow,
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
              onSteer,
              canSend,
              primaryActionKind: effectivePrimaryActionKind,
              primaryActionLabel,
              tooltip: sendTooltip,
              icon: primaryActionIcon,
              showSteerNowMode,
              steerNowEnabled,
              onToggleSteerNow,
              queue: {
                onQueue,
                onSteer,
                hasDualActions,
                queueTooltip,
              },
            }
          : null,
      }}
    />
  );
}
