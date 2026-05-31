import type { SessionLivenessSnapshot } from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent, RefObject, TouchEvent } from "react";
import { useOptionalRenderModeContext } from "../contexts/RenderModeContext";
import { useModelSettings } from "../hooks/useModelSettings";
import { useRelativeNow } from "../hooks/useRelativeNow";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import {
  formatAbsoluteTimestamp,
  formatCompactRelativeAge,
  isStaleTimestamp,
  parseTimestampMs,
} from "../lib/messageAge";
import type { ModelIndicatorTone } from "../lib/modelConfigIndicator";
import {
  getModelIndicatorTextVariants,
  getModelIndicatorTooltip,
  modelIndicatorFitsWithMode,
  normalizeProviderKey,
  type ModelToolbarDensity,
} from "../lib/modelIndicatorText";
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
  SpeechSmartTurnSettings,
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
} from "../lib/speechProviders/SpeechProvider";
import type { BtwToolbarMode } from "../lib/btwAsideRouting";
import type { ContextUsage, PermissionMode } from "../types";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { MessageAge } from "./MessageAge";
import { RenderModeGlyph } from "./ui/RenderModeGlyph";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ModeSelector } from "./ModeSelector";
import { SpeechSmartTurnControls } from "./SpeechSmartTurnControls";
import { SlashCommandButton } from "./SlashCommandButton";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

export interface MessageInputToolbarProps {
  // Mode selector
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;
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
  modelIndicatorProvider?: string;
  modelIndicatorModel?: string;
  modelIndicatorTone?: ModelIndicatorTone;
  modelIndicatorTitle?: string;

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
  /** Show the patient-vs-ASAP queued-message mode toggle. */
  showPatientQueueMode?: boolean;
  /** Queue mode used when queueing through the deferred queue path. */
  patientQueueMode?: boolean;
  /** Toggle patient queued-message mode. */
  onPatientQueueModeChange?: (enabled: boolean) => void;

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

type LivenessTone = "ok" | "warn" | "danger" | "muted";

interface LivenessDisplay {
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
    case "verified-held":
      return {
        prefix: "Held",
        timestampMs: stateMs ?? checkedMs,
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

const MODEL_DENSITY_ORDER: readonly ModelToolbarDensity[] = [
  "full",
  "compact",
  "glyph",
  "hidden",
];

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

export function MessageInputToolbar({
  mode = "default",
  onModeChange,
  isHeld,
  onHoldChange,
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
  modelIndicatorProvider,
  modelIndicatorModel,
  modelIndicatorTone,
  modelIndicatorTitle,
  heartbeatEnabled = false,
  onToggleHeartbeat,
  onConfigureHeartbeat,
  contextUsage,
  lastActivityAt,
  sessionLiveness,
  showPatientQueueMode = false,
  patientQueueMode = false,
  onPatientQueueModeChange,
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
    cycleThinkingMode,
    thinkingLevel,
    voiceInputEnabled = true,
    speechMethod = "browser-native",
    hasStoredSpeechMethod = false,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
  } = useModelSettings();
  const { version: versionInfo } = useVersion();
  const renderMode = useOptionalRenderModeContext();
  const nowMs = useRelativeNow();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [isearchScope, setIsearchScope] = useState<SessionIsearchScope | null>(
    null,
  );
  const modelToolbarButtonRef = useRef<HTMLButtonElement | null>(null);
  const modelToolbarMeasureCtxRef = useRef<CanvasRenderingContext2D | null>(
    null,
  );
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarLeftRef = useRef<HTMLDivElement | null>(null);
  const toolbarStatusRef = useRef<HTMLDivElement | null>(null);
  const toolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const [modelToolbarDensity, setModelToolbarDensity] =
    useState<ModelToolbarDensity>("full");
  const [isCompactStatusMode, setIsCompactStatusMode] = useState(() =>
    typeof window === "undefined"
      ? false
      : (getCompactStatusMatchMedia()?.matches ?? false),
  );
  const hasModelIndicator =
    slashCommands.includes("model") && !!onSelectSlashCommand;
  const normalizedModelIndicatorProvider = useMemo(
    () => normalizeProviderKey(modelIndicatorProvider),
    [modelIndicatorProvider],
  );
  const modelToolbarVariants = useMemo(
    () =>
      getModelIndicatorTextVariants(
        normalizedModelIndicatorProvider,
        modelIndicatorModel ?? "",
        modelIndicatorTitle,
      ),
    [
      modelIndicatorModel,
      modelIndicatorTitle,
      normalizedModelIndicatorProvider,
    ],
  );
  const modelToolbarLabel = useMemo(() => {
    return modelToolbarDensity === "full"
      ? modelToolbarVariants.full
      : modelToolbarDensity === "compact"
        ? modelToolbarVariants.compact
        : modelToolbarDensity === "glyph"
          ? modelToolbarVariants.glyph
          : modelToolbarVariants.full;
  }, [modelToolbarDensity, modelToolbarVariants]);
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
        ? patientQueueMode
          ? 'Queue when done; queued text starts with "when done,"'
          : "Queue ASAP"
        : t("toolbarSendTooltip");
  const queueModeLabel = patientQueueMode ? "Queue when done" : "Queue ASAP";
  const queueTooltip = showPatientQueueMode
    ? patientQueueMode
      ? 'Queue when done; queued text starts with "when done,"'
      : "Queue ASAP"
    : t("toolbarQueueTooltip");
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
  const shortcutsPopoverOpen = shortcutsOpen || isearchScope !== null;
  const modelIndicatorTooltip = getModelIndicatorTooltip(
    modelIndicatorProvider,
    modelIndicatorModel,
    modelIndicatorTitle,
  );
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
    voiceInputEnabled && serverVoiceEnabled && speechMethodOptions.length > 1;
  const supportsSelectedSpeechSmartTurn =
    selectedSpeechMethod !== "browser-native" &&
    versionInfo?.voiceBackendCapabilities?.[selectedSpeechMethod]?.smartTurn ===
      true;
  const activeSpeechSmartTurnSettings: SpeechSmartTurnSettings | undefined =
    supportsSelectedSpeechSmartTurn ? speechSmartTurnSettings : undefined;

  useLayoutEffect(() => {
    if (typeof window === "undefined" || !hasModelIndicator) {
      setModelToolbarDensity("hidden");
      return;
    }

    const button = modelToolbarButtonRef.current;
    if (!button) {
      setModelToolbarDensity("full");
      return;
    }

    const candidateByDensity: Record<ModelToolbarDensity, string> = {
      full: modelToolbarVariants.full,
      compact: modelToolbarVariants.compact,
      glyph: modelToolbarVariants.glyph,
      hidden: "",
    };

    const pxOrZero = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const getMeasureContext = () => {
      if (modelToolbarMeasureCtxRef.current) {
        return modelToolbarMeasureCtxRef.current;
      }
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      modelToolbarMeasureCtxRef.current = context;
      return context;
    };

    let raf = 0;
    const updateDensity = () => {
      const currentButton = modelToolbarButtonRef.current;
      if (!currentButton) return;

      const context = getMeasureContext();
      if (!context) return;

      const styles = getComputedStyle(currentButton);
      const widthBudget =
        currentButton.clientWidth -
        pxOrZero(styles.paddingLeft) -
        pxOrZero(styles.paddingRight);
      if (widthBudget <= 0) {
        setModelToolbarDensity((currentDensity) =>
          currentDensity === "hidden" ? currentDensity : "hidden",
        );
        return;
      }

      const nextDensity =
        MODEL_DENSITY_ORDER.find((density) =>
          density === "hidden"
            ? false
            : modelIndicatorFitsWithMode(
                context,
                candidateByDensity[density],
                currentButton,
                widthBudget,
              ),
        ) ?? "hidden";
      setModelToolbarDensity((currentDensity) =>
        currentDensity === nextDensity ? currentDensity : nextDensity,
      );
    };

    const scheduleDensityUpdate = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(updateDensity);
    };

    const resizeObserver = new ResizeObserver(() => {
      scheduleDensityUpdate();
    });
    resizeObserver.observe(button);

    const onWindowResize = () => {
      scheduleDensityUpdate();
    };
    window.addEventListener("resize", onWindowResize);
    scheduleDensityUpdate();

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      modelToolbarMeasureCtxRef.current = null;
    };
  }, [
    hasModelIndicator,
    modelToolbarVariants.full,
    modelToolbarVariants.compact,
    modelToolbarVariants.glyph,
  ]);

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
    showLivenessChip,
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
    <div
      ref={toolbarRef}
      className={`message-input-toolbar${isCompactStatusMode ? " status-floats" : ""}`}
    >
      <div ref={toolbarLeftRef} className="message-input-left">
        {onModeChange && supportsPermissionMode && (
          <ModeSelector
            mode={mode}
            onModeChange={onModeChange}
            changesApplyNextTurn={modeChangesApplyNextTurn}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
          />
        )}
        <button
          type="button"
          className="attach-button"
          onClick={onAttachClick}
          disabled={!canAttach}
          title={
            canAttach ? t("toolbarAttachFiles") : t("toolbarAttachDisabled")
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
          {attachmentCount > 0 && (
            <span className="attach-count">{attachmentCount}</span>
          )}
        </button>
        {onSelectSlashCommand && (
          <SlashCommandButton
            commands={slashCommands}
            onSelectCommand={onSelectSlashCommand}
            disabled={voiceDisabled}
          />
        )}
        {supportsThinkingToggle && (
          <button
            type="button"
            className={`thinking-toggle-button ${thinkingMode !== "off" ? `active ${thinkingMode}` : ""}`}
            onClick={cycleThinkingMode}
            title={
              thinkingMode === "off"
                ? t("newSessionThinkingOff")
                : thinkingMode === "auto"
                  ? t("newSessionThinkingAuto")
                  : t("newSessionThinkingOn", { level: thinkingLevel })
            }
            aria-label={t("newSessionThinkingMode", { mode: thinkingMode })}
          >
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
              {thinkingMode === "auto" && (
                <g>
                  <circle
                    cx="19"
                    cy="5"
                    r="5.5"
                    fill="currentColor"
                    stroke="none"
                  />
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
          </button>
        )}
        {renderMode && (
          <button
            type="button"
            className={`render-mode-toolbar-button ${
              renderMode.state === "rendered"
                ? "is-rendered"
                : renderMode.state === "mixed"
                  ? "is-mixed"
                  : ""
            }`}
            onClick={renderMode.toggleGlobalMode}
            title={renderModeTitle}
            aria-label={renderModeTitle}
            aria-pressed={
              renderMode.state === "mixed"
                ? "mixed"
                : renderMode.state === "rendered"
            }
          >
            <RenderModeGlyph />
          </button>
        )}
        {onToggleHeartbeat && (
          <button
            type="button"
            className={`heartbeat-toolbar-button ${heartbeatEnabled ? "active" : ""}`}
            onClick={handleHeartbeatClick}
            onContextMenu={handleHeartbeatContextMenu}
            onTouchStart={handleHeartbeatTouchStart}
            onTouchEnd={handleHeartbeatTouchEnd}
            onTouchCancel={clearHeartbeatLongPress}
            onTouchMove={clearHeartbeatLongPress}
            title={heartbeatTitle}
            aria-label={heartbeatTitle}
            aria-pressed={heartbeatEnabled}
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
        {showSpeechMethodSelector && (
          <FilterDropdown
            label={t("newSessionSpeechTitle")}
            options={speechMethodOptions}
            selected={[selectedSpeechMethod]}
            onChange={handleSpeechMethodSelect}
            multiSelect={false}
            placeholder={t("newSessionSpeechPlaceholder")}
            className="filter-dropdown--speech-toolbar"
          />
        )}
        {supportsSelectedSpeechSmartTurn &&
          speechSmartTurnSettings &&
          setSpeechSmartTurnSettings && (
            <SpeechSmartTurnControls
              compact
              settings={speechSmartTurnSettings}
              onChange={setSpeechSmartTurnSettings}
              disabled={voiceDisabled}
            />
          )}
        {voiceButtonRef && onVoiceTranscript && onInterimTranscript && (
          <VoiceInputButton
            ref={voiceButtonRef}
            onTranscript={onVoiceTranscript}
            onInterimTranscript={onInterimTranscript}
            onListeningStart={onListeningStart}
            disabled={voiceDisabled}
            speechMethod={selectedSpeechMethod}
            getTranscriptionContext={getTranscriptionContext}
            smartTurn={activeSpeechSmartTurnSettings}
          />
        )}
        {hasModelIndicator && modelToolbarDensity !== "hidden" && (
          <button
            type="button"
            ref={modelToolbarButtonRef}
            className={`model-toolbar-button${modelIndicatorTone ? ` tone-${modelIndicatorTone}` : ""}`}
            onClick={() => onSelectSlashCommand("/model")}
            disabled={disabled || voiceDisabled}
            title={modelIndicatorTooltip}
            aria-label="Switch model"
          >
            <span className="model-toolbar-label">{modelToolbarLabel}</span>
          </button>
        )}
      </div>
      {(showLivenessChip || showLastActivityAge) && (
        <div ref={toolbarStatusRef} className="composer-status-ages">
          {showLivenessChip && (
            <div
              className={`composer-status-chip composer-liveness-status is-${livenessDisplay.tone}`}
              role="status"
              aria-label={`Session verified liveness: ${livenessSummary}`}
              title={livenessDisplay.title}
            >
              {livenessDisplay.timestampMs !== null ? (
                <time
                  className="composer-liveness-time"
                  dateTime={new Date(livenessDisplay.timestampMs).toISOString()}
                  title={`${formatAbsoluteTimestamp(livenessDisplay.timestampMs)}\n${livenessDisplay.title}`}
                >
                  {formatLivenessAge(livenessDisplay.timestampMs, nowMs)}
                </time>
              ) : (
                <span className="composer-liveness-time">
                  {livenessDisplay.prefix}
                </span>
              )}
            </div>
          )}
          {showLastActivityAge && (
            <div
              className={`composer-status-chip composer-activity-age${
                showLastActivityPrefix ? "" : " composer-activity-age--compact"
              }`}
              role="status"
              aria-label="Session last activity"
            >
              <MessageAge
                timestampMs={lastActivityMs}
                nowMs={nowMs}
                className="composer-activity-age-time"
                prefix={showLastActivityPrefix ? "Last activity" : undefined}
                suffix={lastActivitySuffix}
              />
            </div>
          )}
        </div>
      )}
      <div ref={toolbarActionsRef} className="message-input-actions">
        {/* Pending approval indicator */}
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
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer leave only hides the adjacent shortcuts popover */}
        <div
          className="session-shortcuts-help"
          onMouseLeave={() => {
            if (isearchScope === null) {
              setShortcutsOpen(false);
            }
          }}
        >
          <button
            type="button"
            className="session-shortcuts-help-button"
            aria-label="Session keyboard shortcuts"
            aria-expanded={shortcutsPopoverOpen}
            onClick={() => setShortcutsOpen((open) => !open)}
            onFocus={() => setShortcutsOpen(true)}
            onBlur={(event) => {
              if (
                isearchScope === null &&
                !event.currentTarget.parentElement?.contains(
                  event.relatedTarget as Node | null,
                )
              ) {
                setShortcutsOpen(false);
              }
            }}
            onMouseEnter={() => setShortcutsOpen(true)}
          >
            ?
          </button>
          {shortcutsPopoverOpen && (
            <div
              className={`session-shortcuts-popover ${
                isearchScope !== null ? "is-isearch-guide" : ""
              }`}
              role="tooltip"
            >
              {isearchScope !== null ? (
                <>
                  <div className="session-shortcuts-row">
                    <span className="session-shortcuts-keys">
                      <kbd>Ctrl</kbd>
                      <kbd>{isearchScope === "all" ? "S" : "R"}</kbd>
                      {isearchScope === "user" && (
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
                  <div className="session-shortcuts-row">
                    <span className="session-shortcuts-keys">
                      <kbd>Ctrl</kbd>
                      <kbd>{isearchScope === "all" ? "R" : "S"}</kbd>
                      {isearchScope === "all" && (
                        <>
                          <span>or</span>
                          <kbd>Ctrl</kbd>
                          <kbd>Alt</kbd>
                          <kbd>R</kbd>
                        </>
                      )}
                    </span>
                    <span>
                      {isearchScope === "all" ? "User turns" : "All turns"}
                    </span>
                  </div>
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
                      <kbd>Enter</kbd>
                    </span>
                    <span>
                      {hasDualActions ? "Steer current turn" : "Send"}
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
                    <span>
                      {showPatientQueueMode
                        ? `${queueModeLabel} while agent runs`
                        : "Queue while agent runs"}
                    </span>
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
        <ContextUsageIndicator usage={contextUsage} size={16} />
        {onBtwClick && (
          <button
            type="button"
            className={`btw-toolbar-button ${btwPressed ? "active" : ""} ${
              effectiveBtwToolbarMode === "focus-existing" ? "has-asides" : ""
            }`}
            onClick={onBtwClick}
            disabled={disabled || voiceDisabled}
            aria-label={btwTitle}
            aria-pressed={btwPressed}
            title={btwTitle}
          >
            /btw
          </button>
        )}
        {showStopButton && (
          <button
            type="button"
            onClick={onStop}
            className="stop-button"
            aria-label={t("toolbarStop")}
            title={stopTitle}
          >
            <span className="stop-icon" />
          </button>
        )}
        {showSendButton ? (
          <>
            {showPatientQueueMode && onQueue && (
              <button
                type="button"
                onClick={() => onPatientQueueModeChange?.(!patientQueueMode)}
                disabled={disabled}
                className={`queue-mode-toggle ${
                  patientQueueMode ? "patient" : "asap"
                }`}
                aria-label={queueModeLabel}
                aria-pressed={patientQueueMode}
                title={queueTooltip}
              >
                <span className="queue-mode-label queue-mode-label-long">
                  {patientQueueMode ? "when done" : "ASAP"}
                </span>
                <span className="queue-mode-label queue-mode-label-short">
                  {patientQueueMode ? "done" : "ASAP"}
                </span>
              </button>
            )}
            {hasDualActions && onQueue && (
              <button
                type="button"
                onClick={onQueue}
                disabled={disabled || !canSend}
                className="send-button queue-button"
                aria-label={t("toolbarQueueLabel")}
                title={queueTooltip}
              >
                <span className="send-icon queue-icon">⏱</span>
              </button>
            )}
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || !canSend}
              className={`send-button send-button-with-help ${
                effectivePrimaryActionKind === "queue" ? "queue-mode" : ""
              }`}
              aria-label={primaryActionLabel}
              title={sendTooltip}
              data-tooltip={sendTooltip}
            >
              <span className="send-icon">{primaryActionIcon}</span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
