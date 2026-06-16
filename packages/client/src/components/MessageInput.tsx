import {
  DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS,
  clampPatientPatienceSeconds,
  type SessionLivenessSnapshot,
  type UploadedFile,
  type UserMessageCompositionMetadata,
  type UserMessageDeliveryIntent,
  type UserMessageSpeechMetadata,
} from "@yep-anywhere/shared";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import type { BtwToolbarMode } from "../lib/btwAsideRouting";
import { hasCoarsePointer } from "../lib/deviceDetection";
import { generateUUID } from "../lib/uuid";
import type {
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
} from "../lib/speechProviders/SpeechProvider";
import {
  clearSpeechInsertionRangeReplacement,
  createSpeechInsertionRange,
  getSpeechSelectionFinalDelayMs,
  getSpeechTranscriptInsertionParts,
  getSpeechTranscriptReplacementParts,
  mapSpeechInsertionRangeThroughEdit,
  mapSpeechInsertionRangeThroughReplacement,
  removeLatestSpeechChunkFromRange,
  retargetSpeechInsertionRangeReplacement,
  replaceSpeechTranscriptBefore,
  replaceSpeechTranscriptInRange,
  type SpeechInsertionRange,
} from "../lib/speechRecognition";
import { getSlashCommandMenuParts } from "../lib/slashCommands";
import {
  captureTextareaAppendSelection,
  restoreTextareaReplacementSelection,
} from "../lib/textareaSelection";
import { isVoiceInputShortcut } from "../lib/voiceInputShortcut";
import type { ContextUsage, PermissionMode } from "../types";
import { AttachmentChip } from "./AttachmentChip";
import { MessageInputToolbar } from "./MessageInputToolbar";
import type { VoiceInputButtonRef } from "./VoiceInputButton";

/** Progress info for an in-flight upload */
export interface UploadProgress {
  fileId: string;
  fileName: string;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

export interface MessageSubmissionMetadata {
  deliveryIntent: UserMessageDeliveryIntent;
  patienceSeconds?: number;
  steerNow?: boolean;
  composition: UserMessageCompositionMetadata;
  speech?: UserMessageSpeechMetadata;
}

interface PendingTextareaSelectionRestore {
  value: string;
  restore: (textarea: HTMLTextAreaElement) => void;
}

interface PendingSpeechFinal {
  timer: ReturnType<typeof setTimeout>;
  transcript: string;
  metadata?: SpeechTranscriptionResultMetadata;
}

/** Format file size in human-readable form */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  if (bytes < 1024 * 1024 * 1024)
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
}

function clearTextareaContentsUndoably(textarea: HTMLTextAreaElement): void {
  const previousLength = textarea.value.length;
  if (previousLength === 0) return;

  textarea.focus();
  textarea.setSelectionRange(0, previousLength);

  // React state-only clears bypass native undo; this legacy edit command still
  // participates in the browser textarea undo stack.
  try {
    if (document.execCommand?.("delete")) {
      return;
    }
  } catch {
    // Fall back to a direct textarea edit below.
  }

  textarea.setRangeText("", 0, previousLength, "start");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function createClientSpeechTurnId(): string {
  return generateUUID();
}

function createSpeechTargetId(): string {
  return `speech-target-${generateUUID()}`;
}

function getLeadingSlashQuery(text: string): string | null {
  const match = text.match(/^\/([^\s/]*)$/);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

interface Props {
  onSend: (text: string, metadata?: MessageSubmissionMetadata) => void;
  /** Queue a deferred message (sent when agent's turn ends). Only provided when agent is running. */
  onQueue?: (text: string, metadata?: MessageSubmissionMetadata) => void;
  disabled?: boolean;
  placeholder?: string;
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  /** Permission mode changes are visibly staged for the next user turn. */
  modeChangesApplyNextTurn?: boolean;
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  draftKey: string; // localStorage key for draft persistence
  /** Collapse to single-line but keep visible and focusable (for when approval panel is showing) */
  collapsed?: boolean;
  /** Callback to receive draft controls for success/failure handling */
  onDraftControlsReady?: (controls: DraftControls) => void;
  /** Context usage for displaying usage indicator */
  contextUsage?: ContextUsage;
  /** Last session activity timestamp for stale composer liveness display. */
  lastActivityAt?: string | null;
  /** Server-derived provider/session liveness evidence. */
  sessionLiveness?: SessionLivenessSnapshot | null;
  /** Project ID for uploads (required to enable attach button) */
  projectId?: string;
  /** Session ID for uploads (required to enable attach button) */
  sessionId?: string;
  /** Completed file attachments */
  attachments?: UploadedFile[];
  /** Callback when user selects files to attach */
  onAttach?: (files: File[]) => void;
  /** Callback when user removes an attachment */
  onRemoveAttachment?: (id: string) => void;
  /** Progress info for in-flight uploads */
  uploadProgress?: UploadProgress[];
  /** Whether the provider supports permission modes (default: true) */
  supportsPermissionMode?: boolean;
  /** Whether the provider supports thinking toggle (default: true) */
  supportsThinkingToggle?: boolean;
  /** Whether the provider supports active turn steering (default: false) */
  supportsSteering?: boolean;
  /** Whether provider steering supports soft-immediate in-flight generation abort. */
  supportsSteerNow?: boolean;
  /** Current behavior of the primary composer action. */
  primaryActionKind?: "send" | "steer" | "queue";
  /** Available slash commands (without "/" prefix) */
  slashCommands?: string[];
  /** Callback for custom client-side commands (e.g., "model"). Return true if handled. */
  onCustomCommand?: (command: string) => boolean;
  /** Start a /btw aside. When text is present, the caller may send it immediately. */
  onBtwShortcut?: (text: string) => boolean;
  /** Whether this composer is currently routing sends to a focused /btw aside. */
  btwActive?: boolean;
  /** Whether this session has an active /btw aside available to focus. */
  btwHasAsides?: boolean;
  /** Explicit /btw toolbar display state when focus and footer routing differ. */
  btwToolbarMode?: BtwToolbarMode;
  /** Provider/model context used by the thinking effort chooser. */
  thinkingProvider?: string;
  thinkingModel?: string;
  /** YA model id for the context quick-edit's per-model threshold keying. */
  contextRequestedModel?: string;
  /** Whether heartbeat turns are currently enabled for this session */
  heartbeatEnabled?: boolean;
  /** Current quiet-period timeout used by patient queue mode. */
  patientQueuePatienceSeconds?: number | null;
  /** Quick-toggle session heartbeat */
  onToggleHeartbeat?: () => void;
  /** Open heartbeat session settings */
  onConfigureHeartbeat?: () => void;
  /** Whether the current draft will be sent as a correction to the latest user turn */
  correctionActive?: boolean;
  /** Cancel correction mode and clear the restored draft */
  onCancelCorrection?: () => void;
  /** Restore the last sent/queued text when the composer is blank */
  onRecallLastSubmission?: () => boolean;
  /** Cancel the newest cancellable queued message. */
  onCancelLatestDeferred?: () => boolean;
  /** Predicted next user prompt from the SDK; shown as a ghost/chip below the composer. */
  promptSuggestion?: string;
  /** Dismiss the current prompt suggestion without acting on it. */
  onDismissPromptSuggestion?: () => void;
}

export function MessageInput({
  onSend,
  onQueue,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
  modeChangesApplyNextTurn,
  isRunning,
  isThinking,
  onStop,
  draftKey,
  collapsed: externalCollapsed,
  onDraftControlsReady,
  contextUsage,
  lastActivityAt,
  sessionLiveness,
  projectId,
  sessionId,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  uploadProgress = [],
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
  supportsSteering = false,
  supportsSteerNow = false,
  primaryActionKind,
  slashCommands = [],
  onCustomCommand,
  onBtwShortcut,
  btwActive = false,
  btwHasAsides = false,
  btwToolbarMode,
  thinkingProvider,
  thinkingModel,
  contextRequestedModel,
  heartbeatEnabled = false,
  patientQueuePatienceSeconds,
  onToggleHeartbeat,
  onConfigureHeartbeat,
  correctionActive = false,
  onCancelCorrection,
  onRecallLastSubmission,
  onCancelLatestDeferred,
  promptSuggestion,
  onDismissPromptSuggestion,
}: Props) {
  const { t } = useI18n();
  const [text, setText, controls] = useDraftPersistence(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const typingStartedAtRef = useRef<string | null>(null);
  const lastEditedAtRef = useRef<string | null>(null);
  const speechTurnIdRef = useRef<string | null>(null);
  const speechTranscriptionIdsRef = useRef<string[]>([]);
  const speechInsertionRangeRef = useRef<SpeechInsertionRange | null>(null);
  const activeSpeechTargetIdRef = useRef<string | null>(null);
  const speechInsertionRangesRef = useRef<Map<string, SpeechInsertionRange>>(
    new Map(),
  );
  const pendingSpeechFinalRef = useRef<PendingSpeechFinal | null>(null);
  const pendingTextareaSelectionRef =
    useRef<PendingTextareaSelectionRestore | null>(null);
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechProcessing, setSpeechProcessing] = useState(false);
  const [, setSpeechPreviewRevision] = useState(0);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(
    null,
  );
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);

  // Panel is collapsed if user collapsed it OR if externally collapsed (approval panel showing)
  const collapsed = userCollapsed || externalCollapsed;
  const slashQuery = getLeadingSlashQuery(text);
  const matchingSlashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return slashCommands.filter((command) =>
      command.toLowerCase().startsWith(slashQuery),
    );
  }, [slashCommands, slashQuery]);
  const showSlashSuggestions =
    !collapsed &&
    !disabled &&
    slashQuery !== null &&
    dismissedSlashQuery !== slashQuery &&
    matchingSlashCommands.length > 0;
  const canSubmit = !!(text.trim() || attachments.length > 0);
  const interimDisplayTranscript = interimTranscript.trim();
  const speechInlineTranscript =
    interimDisplayTranscript ||
    (speechProcessing ? t("speechTranscribingPlaceholder" as never) : "");
  const speechInsertionRange = speechInsertionRangeRef.current;
  const interimInsertion = speechInsertionRange
    ? getSpeechTranscriptReplacementParts(
        text,
        speechInlineTranscript,
        speechInsertionRange.end,
        speechInsertionRange.replaceEnd ?? speechInsertionRange.end,
      )
    : getSpeechTranscriptInsertionParts(
        text,
        speechInlineTranscript,
        text.length,
      );

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [slashQuery, matchingSlashCommands.length]);

  const basePrimaryActionKind =
    primaryActionKind ??
    (supportsSteering && onQueue ? "steer" : onQueue ? "queue" : "send");
  const hasActiveDualActions =
    supportsSteering && !!onQueue && basePrimaryActionKind === "steer";
  const patientQueueStorageKey = `${draftKey}:patient-queue-enabled`;
  const enterActionStorageKey = `${draftKey}:enter-action-kind`;
  const [patientQueueEnabled, setPatientQueueEnabled] = useState(() => {
    try {
      return localStorage.getItem(patientQueueStorageKey) === "true";
    } catch {
      return false;
    }
  });
  const [enterActionKind, setEnterActionKind] = useState<"steer" | "queue">(
    () => {
      try {
        return localStorage.getItem(enterActionStorageKey) === "queue"
          ? "queue"
          : "steer";
      } catch {
        return "steer";
      }
    },
  );
  // Per-turn "now" steering toggle. The server-learned client default sets
  // its initial state (Message Delivery settings); the toggle stays per-turn
  // and a user click overrides the default for this composer.
  const { version } = useVersion();
  const steerNowDefault = version?.clientDefaults?.steerNowDefault ?? false;
  const [steerNowOverride, setSteerNowOverride] = useState<boolean | null>(
    null,
  );
  const steerNowEnabled = steerNowOverride ?? steerNowDefault;
  const effectivePrimaryActionKind = hasActiveDualActions
    ? enterActionKind
    : basePrimaryActionKind;
  const effectivePatientQueuePatienceSeconds =
    clampPatientPatienceSeconds(patientQueuePatienceSeconds) ??
    DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS;
  const showPatientQueueMode = !!(
    supportsSteering ||
    onQueue ||
    basePrimaryActionKind === "queue"
  );
  const primaryActionLabel =
    effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? t("toolbarQueueLabel")
        : t("toolbarSend");

  const canAttach = !!(projectId && sessionId && onAttach);

  useEffect(() => {
    try {
      setPatientQueueEnabled(
        localStorage.getItem(patientQueueStorageKey) === "true",
      );
    } catch {
      setPatientQueueEnabled(false);
    }
  }, [patientQueueStorageKey]);

  useEffect(() => {
    try {
      setEnterActionKind(
        localStorage.getItem(enterActionStorageKey) === "queue"
          ? "queue"
          : "steer",
      );
    } catch {
      setEnterActionKind("steer");
    }
  }, [enterActionStorageKey]);

  const togglePatientQueueEnabled = useCallback(() => {
    setPatientQueueEnabled((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(patientQueueStorageKey, next ? "true" : "false");
      } catch {
        // Patient queue mode is a local convenience; in-memory state still works.
      }
      return next;
    });
  }, [patientQueueStorageKey]);

  const toggleEnterActionKind = useCallback(() => {
    setEnterActionKind((previous) => {
      const next = previous === "steer" ? "queue" : "steer";
      try {
        localStorage.setItem(enterActionStorageKey, next);
      } catch {
        // Keyboard preference is local-only; in-memory state still works.
      }
      return next;
    });
  }, [enterActionStorageKey]);

  const noteComposerEdit = useCallback((nextText: string) => {
    if (!nextText.trim()) {
      typingStartedAtRef.current = null;
      lastEditedAtRef.current = null;
      return;
    }

    const now = new Date().toISOString();
    if (!typingStartedAtRef.current) {
      typingStartedAtRef.current = now;
    }
    lastEditedAtRef.current = now;
  }, []);

  const resetCompositionMetadata = useCallback(() => {
    typingStartedAtRef.current = null;
    lastEditedAtRef.current = null;
    speechTurnIdRef.current = null;
    speechTranscriptionIdsRef.current = [];
  }, []);

  const ensureSpeechTurnId = useCallback(() => {
    if (!speechTurnIdRef.current) {
      speechTurnIdRef.current = createClientSpeechTurnId();
    }
    return speechTurnIdRef.current;
  }, []);

  const getTranscriptionContext =
    useCallback((): SpeechTranscriptionContext => {
      return {
        projectId,
        sessionId,
        draftKey,
        clientTurnId: ensureSpeechTurnId(),
        speechTargetId: activeSpeechTargetIdRef.current ?? undefined,
      };
    }, [draftKey, ensureSpeechTurnId, projectId, sessionId]);

  const buildSubmissionMetadata = useCallback(
    (deliveryIntent: UserMessageDeliveryIntent): MessageSubmissionMetadata => {
      const submittedAt = new Date().toISOString();
      const typingStartedAt = typingStartedAtRef.current ?? submittedAt;
      const lastEditedAt = lastEditedAtRef.current ?? typingStartedAt;
      const speech: UserMessageSpeechMetadata | undefined =
        speechTurnIdRef.current || speechTranscriptionIdsRef.current.length > 0
          ? {
              clientTurnId: speechTurnIdRef.current ?? undefined,
              transcriptionIds:
                speechTranscriptionIdsRef.current.length > 0
                  ? [...speechTranscriptionIdsRef.current]
                  : undefined,
            }
          : undefined;
      return {
        deliveryIntent,
        ...(deliveryIntent === "patient"
          ? { patienceSeconds: effectivePatientQueuePatienceSeconds }
          : {}),
        ...(deliveryIntent === "steer" && supportsSteerNow && steerNowEnabled
          ? { steerNow: true }
          : {}),
        composition: {
          typingStartedAt,
          typingEndedAt: submittedAt,
          lastEditedAt,
          submittedAt,
        },
        ...(speech ? { speech } : {}),
      };
    },
    [effectivePatientQueuePatienceSeconds, steerNowEnabled, supportsSteerNow],
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length && onAttach) {
      onAttach(Array.from(files));
      e.target.value = ""; // Reset for re-selection
    }
  };

  // Provide controls to parent via callback
  useEffect(() => {
    onDraftControlsReady?.(controls);
  }, [controls, onDraftControlsReady]);

  useLayoutEffect(() => {
    const pending = pendingTextareaSelectionRef.current;
    const textarea = textareaRef.current;
    if (!pending || !textarea || textarea.value !== pending.value) return;
    pendingTextareaSelectionRef.current = null;
    pending.restore(textarea);
  }, [text]);

  const handleSubmit = useCallback(
    (
      messageOverride?: unknown,
      actionOverride?: "send" | "steer" | "queue",
    ) => {
      const override =
        typeof messageOverride === "string" ? messageOverride : undefined;
      // Stop voice recording and get any pending interim text
      const pendingVoice =
        override === undefined
          ? (voiceButtonRef.current?.stopAndFinalize() ?? "")
          : "";

      // Combine committed text with any pending voice text
      let finalText = (override ?? controls.getDraft()).trimEnd();
      if (pendingVoice) {
        finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
      }

      const hasContent = finalText.trim() || attachments.length > 0;
      if (hasContent && !disabled) {
        const message = finalText.trim();
        const actionKind = actionOverride ?? effectivePrimaryActionKind;
        const deliveryIntent =
          actionKind === "steer"
            ? "steer"
            : actionKind === "queue"
              ? "deferred"
              : "direct";
        const metadata = buildSubmissionMetadata(deliveryIntent);
        // Clear input state but keep localStorage for failure recovery
        controls.clearInput();
        resetCompositionMetadata();
        setInterimTranscript("");
        onSend(message, metadata);
        // Refocus the textarea so user can continue typing
        textareaRef.current?.focus();
      }
    },
    [
      disabled,
      controls,
      onSend,
      attachments.length,
      effectivePrimaryActionKind,
      buildSubmissionMetadata,
      resetCompositionMetadata,
    ],
  );

  const handleSteer = useCallback(() => {
    handleSubmit(undefined, "steer");
  }, [handleSubmit]);

  const handleQueue = useCallback(() => {
    const queueHandler =
      onQueue ?? (effectivePrimaryActionKind === "queue" ? onSend : undefined);

    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    let finalText = controls.getDraft().trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }

    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled && queueHandler) {
      const metadata = buildSubmissionMetadata(
        patientQueueEnabled ? "patient" : "deferred",
      );
      controls.clearInput();
      resetCompositionMetadata();
      setInterimTranscript("");
      queueHandler(finalText.trim(), metadata);
      textareaRef.current?.focus();
    }
  }, [
    disabled,
    controls,
    onQueue,
    onSend,
    effectivePrimaryActionKind,
    patientQueueEnabled,
    attachments.length,
    buildSubmissionMetadata,
    resetCompositionMetadata,
  ]);

  const handleBtwClick = useCallback(() => {
    if (disabled || !onBtwShortcut) return;
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";
    let finalText = controls.getDraft().trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }
    const message = finalText.trim();
    if (onBtwShortcut(message) && message) {
      controls.clearInput();
      resetCompositionMetadata();
      setInterimTranscript("");
    }
    textareaRef.current?.focus();
  }, [controls, disabled, onBtwShortcut, resetCompositionMetadata]);

  const submitPrimaryAction =
    effectivePrimaryActionKind === "queue" ? handleQueue : handleSubmit;

  const recallLastSubmission = useCallback(
    (allowExistingText = false) => {
      if (
        disabled ||
        (!allowExistingText && text.trim()) ||
        attachments.length > 0 ||
        uploadProgress.length > 0
      ) {
        return false;
      }
      const recalled = onRecallLastSubmission?.() ?? false;
      if (recalled) {
        setInterimTranscript("");
        textareaRef.current?.focus();
      }
      return recalled;
    },
    [
      attachments.length,
      disabled,
      onRecallLastSubmission,
      text,
      uploadProgress.length,
    ],
  );

  // Handle slash command selection - run active client commands or insert text.
  const handleSlashCommand = useCallback(
    (command: string) => {
      if (!command) return;
      const normalizedCommand = command.startsWith("/")
        ? command
        : `/${command}`;
      const bare = normalizedCommand.slice(1);
      if (onCustomCommand?.(bare)) {
        return;
      }

      const slashDraft = getLeadingSlashQuery(text) !== null;
      const trimmed = text.trimEnd();
      const nextText = slashDraft
        ? `${normalizedCommand} `
        : trimmed
          ? `${trimmed} ${normalizedCommand} `
          : `${normalizedCommand} `;
      noteComposerEdit(nextText);
      setText(nextText);
      setDismissedSlashQuery(null);
      textareaRef.current?.focus();
    },
    [text, setText, onCustomCommand, noteComposerEdit],
  );

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showSlashSuggestions) {
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedSlashQuery(slashQuery);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSlashIndex((current) => {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          return (
            (current + delta + matchingSlashCommands.length) %
            matchingSlashCommands.length
          );
        });
        return;
      }
      if (
        e.key === "Tab" ||
        (e.key === "Enter" &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.altKey)
      ) {
        e.preventDefault();
        handleSlashCommand(matchingSlashCommands[selectedSlashIndex] ?? "");
        return;
      }
    }

    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      voiceButtonRef.current?.isListening
    ) {
      e.preventDefault();
      e.stopPropagation();
      handleListeningStop();
      voiceButtonRef.current.stopAndFinalize();
      return;
    }

    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      isRunning &&
      isThinking &&
      onStop
    ) {
      e.preventDefault();
      e.stopPropagation();
      onStop();
      return;
    }

    if (
      e.key === "ArrowUp" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      if (recallLastSubmission()) {
        e.preventDefault();
      }
      return;
    }

    if (
      e.key.toLowerCase() === "p" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      recallLastSubmission(true);
      return;
    }

    if (
      e.key.toLowerCase() === "k" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      if (onCancelLatestDeferred?.()) {
        e.preventDefault();
        return;
      }
    }

    if (
      e.key.toLowerCase() === "b" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      handleBtwClick();
      return;
    }

    if (e.key.toLowerCase() === "g" && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (!disabled) {
        voiceButtonRef.current?.stopAndFinalize();
        if (textareaRef.current) {
          clearTextareaContentsUndoably(textareaRef.current);
        }
        setInterimTranscript("");
        setText("");
        resetCompositionMetadata();
        controls.flushDraft();
        for (const attachment of attachments) {
          onRemoveAttachment?.(attachment.id);
        }
        onCancelCorrection?.();
        textareaRef.current?.focus();
      }
      return;
    }

    // Tab when composer is empty accepts the prompt suggestion into the draft
    if (
      e.key === "Tab" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      promptSuggestion &&
      !text.trim()
    ) {
      e.preventDefault();
      noteComposerEdit(promptSuggestion);
      setText(promptSuggestion);
      onDismissPromptSuggestion?.();
      return;
    }

    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // Ctrl+Enter is the alternate regular send action while busy. Patient
      // mode is controlled by the stopwatch toggle, not by this shortcut.
      if (
        (onQueue || effectivePrimaryActionKind === "queue") &&
        e.ctrlKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        if (hasActiveDualActions && effectivePrimaryActionKind === "queue") {
          handleSubmit(undefined, "steer");
        } else {
          handleQueue();
        }
        return;
      }

      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = hasCoarsePointer();

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        submitPrimaryAction();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        // Allow default behavior (newline)
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        // Desktop: Enter sends, Ctrl+Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          // Allow default behavior (newline)
          return;
        }
        e.preventDefault();
        submitPrimaryAction();
      } else {
        // Ctrl+Enter sends, Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          submitPrimaryAction();
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (!canAttach || !onAttach) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      // Prevent default only if we have files to handle
      // This allows text paste to still work normally
      e.preventDefault();
      onAttach(files);
    }
  };

  // Voice input handlers
  const handleListeningStart = useCallback(() => {
    const textarea = textareaRef.current;
    const currentText = controls.getDraft();
    const selectionStart = Math.max(
      0,
      Math.min(
        textarea?.selectionStart ?? currentText.length,
        currentText.length,
      ),
    );
    const selectionEnd = Math.max(
      selectionStart,
      Math.min(textarea?.selectionEnd ?? selectionStart, currentText.length),
    );
    const targetId = createSpeechTargetId();
    const range = createSpeechInsertionRange(selectionStart, selectionEnd);
    activeSpeechTargetIdRef.current = targetId;
    speechInsertionRangeRef.current = range;
    speechInsertionRangesRef.current.set(targetId, range);
    pendingTextareaSelectionRef.current = null;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd);
    }
    setInterimTranscript("");
  }, [controls]);

  const clearPendingSpeechFinal = useCallback(() => {
    const pending = pendingSpeechFinalRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pendingSpeechFinalRef.current = null;
  }, []);

  useEffect(() => clearPendingSpeechFinal, [clearPendingSpeechFinal]);

  const handleSpeechSelectionTarget = useCallback(() => {
    const textarea = textareaRef.current;
    const range = speechInsertionRangeRef.current;
    if (!textarea || !range) return;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    if (selectionStart === selectionEnd) {
      clearPendingSpeechFinal();
      const nextRange = clearSpeechInsertionRangeReplacement(range);
      speechInsertionRangeRef.current = nextRange;
      if (activeSpeechTargetIdRef.current) {
        speechInsertionRangesRef.current.set(
          activeSpeechTargetIdRef.current,
          nextRange,
        );
      }
      setSpeechPreviewRevision((revision) => revision + 1);
      return;
    }
    if (
      range.replaceSelectedAtMs === undefined &&
      range.end === selectionStart &&
      range.replaceEnd === selectionEnd
    ) {
      return;
    }
    const nextRange = retargetSpeechInsertionRangeReplacement(
      range,
      selectionStart,
      selectionEnd,
    );
    speechInsertionRangeRef.current = nextRange;
    if (activeSpeechTargetIdRef.current) {
      speechInsertionRangesRef.current.set(
        activeSpeechTargetIdRef.current,
        nextRange,
      );
    }
    setSpeechPreviewRevision((revision) => revision + 1);
  }, [clearPendingSpeechFinal]);

  const clearSpeechSelectionTarget = useCallback(() => {
    clearPendingSpeechFinal();
    if (!speechInsertionRangeRef.current) return;
    const nextRange = clearSpeechInsertionRangeReplacement(
      speechInsertionRangeRef.current,
    );
    speechInsertionRangeRef.current = nextRange;
    if (activeSpeechTargetIdRef.current) {
      speechInsertionRangesRef.current.set(
        activeSpeechTargetIdRef.current,
        nextRange,
      );
    }
    setSpeechPreviewRevision((revision) => revision + 1);
  }, [clearPendingSpeechFinal]);

  const commitVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      const targetId = metadata?.speechTargetId;
      const getSpeechRange = () =>
        targetId
          ? (speechInsertionRangesRef.current.get(targetId) ?? null)
          : speechInsertionRangeRef.current;
      const updateSpeechRange = (range: SpeechInsertionRange | null) => {
        if (targetId) {
          if (range) {
            speechInsertionRangesRef.current.set(targetId, range);
          } else {
            speechInsertionRangesRef.current.delete(targetId);
          }
          if (activeSpeechTargetIdRef.current === targetId) {
            speechInsertionRangeRef.current = range;
          }
          return;
        }
        speechInsertionRangeRef.current = range;
        if (activeSpeechTargetIdRef.current) {
          if (range) {
            speechInsertionRangesRef.current.set(
              activeSpeechTargetIdRef.current,
              range,
            );
          } else {
            speechInsertionRangesRef.current.delete(
              activeSpeechTargetIdRef.current,
            );
          }
        }
      };
      const mapOtherSpeechRangesThroughReplacement = (
        replacementStart: number,
        replacementEnd: number,
        insertedLength: number,
        committedRange: SpeechInsertionRange | null,
      ) => {
        if (speechInsertionRangesRef.current.size === 0) return;
        const committedTargetId = targetId ?? activeSpeechTargetIdRef.current;
        const nextRanges = new Map<string, SpeechInsertionRange>();
        for (const [rangeTargetId, range] of speechInsertionRangesRef.current) {
          if (rangeTargetId === committedTargetId) {
            if (committedRange) nextRanges.set(rangeTargetId, committedRange);
            continue;
          }
          nextRanges.set(
            rangeTargetId,
            mapSpeechInsertionRangeThroughReplacement(
              range,
              replacementStart,
              replacementEnd,
              insertedLength,
            ),
          );
        }
        speechInsertionRangesRef.current = nextRanges;
        speechInsertionRangeRef.current =
          activeSpeechTargetIdRef.current !== null
            ? (nextRanges.get(activeSpeechTargetIdRef.current) ?? null)
            : null;
      };
      // Append transcript to existing text with space separator
      // Trim the transcript since mobile speech API includes leading/trailing spaces
      const trimmedTranscript = transcript.trim();
      if (metadata?.transcriptionId) {
        speechTranscriptionIdsRef.current = [
          ...speechTranscriptionIdsRef.current,
          metadata.transcriptionId,
        ];
      }
      if (metadata?.smartTurnCommand === "cancel") {
        const currentText = controls.getDraft();
        const range = getSpeechRange();
        const removal = range
          ? removeLatestSpeechChunkFromRange(currentText, range)
          : null;
        if (removal) {
          if (removal.text !== currentText) {
            const selection = captureTextareaAppendSelection(
              textareaRef.current,
              currentText,
            );
            pendingTextareaSelectionRef.current = {
              value: removal.text,
              restore: (textarea) => {
                restoreTextareaReplacementSelection(
                  textarea,
                  selection,
                  removal.text,
                  removal.replacementStart,
                  removal.replacementEnd,
                  0,
                );
              },
            };
            noteComposerEdit(removal.text);
            controls.setDraft(removal.text);
            mapOtherSpeechRangesThroughReplacement(
              removal.replacementStart,
              removal.replacementEnd,
              removal.insertedLength,
              removal.range,
            );
            updateSpeechRange(removal.range);
          } else {
            pendingTextareaSelectionRef.current = null;
          }
        } else {
          pendingTextareaSelectionRef.current = null;
          if (targetId) updateSpeechRange(null);
        }
        setInterimTranscript("");
        return;
      }

      const currentText = controls.getDraft();
      const speechRange = getSpeechRange();
      let nextSpeechRange: SpeechInsertionRange | null = null;
      const replacement = speechRange
        ? (() => {
            const rangeReplacement = replaceSpeechTranscriptInRange(
              currentText,
              trimmedTranscript,
              speechRange,
              metadata?.replacePreviousTranscriptChars ?? 0,
            );
            nextSpeechRange = rangeReplacement.range;
            return rangeReplacement;
          })()
        : replaceSpeechTranscriptBefore(
            currentText,
            trimmedTranscript,
            currentText.length,
            0,
          );
      const nextText =
        trimmedTranscript || metadata?.replacePreviousTranscriptChars
          ? replacement.text
          : currentText;
      const shouldRestoreSelection = metadata?.smartTurnCommand !== "send";
      if (nextText !== currentText) {
        const selection = shouldRestoreSelection
          ? captureTextareaAppendSelection(textareaRef.current, currentText)
          : null;
        pendingTextareaSelectionRef.current = shouldRestoreSelection
          ? {
              value: nextText,
              restore: (textarea) => {
                restoreTextareaReplacementSelection(
                  textarea,
                  selection,
                  nextText,
                  replacement.replacementStart,
                  replacement.replacementEnd,
                  replacement.insertedLength,
                );
              },
            }
          : null;
        noteComposerEdit(nextText);
        controls.setDraft(nextText);
        mapOtherSpeechRangesThroughReplacement(
          replacement.replacementStart,
          replacement.replacementEnd,
          replacement.insertedLength,
          nextSpeechRange,
        );
        if (nextSpeechRange) {
          updateSpeechRange(nextSpeechRange);
        }
      }
      setInterimTranscript("");
      if (metadata?.smartTurnCommand) {
        updateSpeechRange(null);
      }
      if (metadata?.smartTurnCommand === "send") {
        handleSubmit(nextText);
      }
    },
    [controls, handleSubmit, noteComposerEdit],
  );

  const handleVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      const speechRange = metadata?.speechTargetId
        ? (speechInsertionRangesRef.current.get(metadata.speechTargetId) ??
          null)
        : speechInsertionRangeRef.current;
      const delayMs = metadata?.smartTurnCommand
        ? 0
        : getSpeechSelectionFinalDelayMs(speechRange);
      if (delayMs > 0) {
        clearPendingSpeechFinal();
        const timer = setTimeout(() => {
          const pending = pendingSpeechFinalRef.current;
          if (!pending || pending.timer !== timer) return;
          pendingSpeechFinalRef.current = null;
          commitVoiceTranscript(pending.transcript, pending.metadata);
        }, delayMs);
        pendingSpeechFinalRef.current = { timer, transcript, metadata };
        return;
      }

      clearPendingSpeechFinal();
      commitVoiceTranscript(transcript, metadata);
    },
    [clearPendingSpeechFinal, commitVoiceTranscript],
  );

  const flushPendingSpeechFinal = useCallback(() => {
    const pending = pendingSpeechFinalRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pendingSpeechFinalRef.current = null;
    commitVoiceTranscript(pending.transcript, pending.metadata);
  }, [commitVoiceTranscript]);

  const handleListeningStop = useCallback(() => {
    flushPendingSpeechFinal();
    setInterimTranscript("");
  }, [flushPendingSpeechFinal]);

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  const handleSpeechProcessingChange = useCallback((processing: boolean) => {
    setSpeechProcessing(processing);
  }, []);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!isVoiceInputShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const voice = voiceButtonRef.current;
      if (!voice?.isAvailable) return;
      const wasActive = voice.isListening;
      if (wasActive) {
        handleListeningStop();
        voice.toggle();
        return;
      }
      handleListeningStart();
      voice.toggle();
    },
    [handleListeningStart, handleListeningStop],
  );

  return (
    <div
      className="message-input-wrapper"
      onKeyDownCapture={handleComposerKeyDown}
    >
      {/* Floating toggle button - only show when user can control collapse (not externally collapsed) */}
      {!externalCollapsed && (
        <button
          type="button"
          className="message-input-toggle"
          onClick={() => setUserCollapsed(!userCollapsed)}
          aria-label={
            userCollapsed ? t("messageInputExpand") : t("messageInputCollapse")
          }
          aria-expanded={!userCollapsed}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={userCollapsed ? "chevron-up" : "chevron-down"}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
      <div
        className={`message-input ${collapsed ? "message-input-collapsed" : ""} ${interimTranscript ? "voice-recording" : ""}`}
      >
        <div
          className={`speech-draft-field ${speechInlineTranscript ? "has-interim" : ""}`}
        >
          <div className="speech-draft-inline">
            {speechInlineTranscript && (
              <div className="speech-draft-mirror" aria-hidden="true">
                <span>{interimInsertion.before}</span>
                {interimInsertion.separatorBefore}
                <span
                  className={
                    interimDisplayTranscript
                      ? "speech-interim-inline"
                      : "speech-processing-inline"
                  }
                >
                  {interimInsertion.transcript}
                </span>
                {interimInsertion.separatorAfter}
                <span>{interimInsertion.after}</span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                const nextText = e.target.value;
                clearPendingSpeechFinal();
                if (speechInsertionRangesRef.current.size > 0) {
                  const nextRanges = new Map<string, SpeechInsertionRange>();
                  for (const [
                    targetId,
                    range,
                  ] of speechInsertionRangesRef.current) {
                    nextRanges.set(
                      targetId,
                      clearSpeechInsertionRangeReplacement(
                        mapSpeechInsertionRangeThroughEdit(
                          text,
                          nextText,
                          range,
                        ),
                      ),
                    );
                  }
                  speechInsertionRangesRef.current = nextRanges;
                  speechInsertionRangeRef.current =
                    activeSpeechTargetIdRef.current !== null
                      ? (nextRanges.get(activeSpeechTargetIdRef.current) ??
                        null)
                      : null;
                }
                noteComposerEdit(nextText);
                setText(nextText);
                const nextSlashQuery = getLeadingSlashQuery(nextText);
                if (nextSlashQuery !== dismissedSlashQuery) {
                  setDismissedSlashQuery(null);
                }
              }}
              onBlur={controls.flushDraft}
              onKeyDown={handleKeyDown}
              onSelect={handleSpeechSelectionTarget}
              onPointerUp={handleSpeechSelectionTarget}
              onKeyUp={handleSpeechSelectionTarget}
              onCut={clearSpeechSelectionTarget}
              onCopy={clearSpeechSelectionTarget}
              onPaste={(event) => {
                clearSpeechSelectionTarget();
                handlePaste(event);
              }}
              enterKeyHint="send"
              placeholder={
                externalCollapsed ? t("messageInputContinueAbove") : placeholder
              }
              disabled={disabled}
              rows={collapsed ? 1 : 3}
            />
          </div>
          {interimTranscript && (
            <div
              className="speech-interim-status"
              role="status"
              aria-live="polite"
              aria-label="Tentative speech transcript"
            >
              {interimTranscript}
            </div>
          )}
        </div>

        {showSlashSuggestions && (
          <div
            className="slash-command-menu composer-slash-command-menu"
            role="menu"
          >
            {matchingSlashCommands.map((command, index) => {
              const parts = getSlashCommandMenuParts(command);
              return (
                <button
                  key={command}
                  type="button"
                  className={`slash-command-item${index === selectedSlashIndex ? " active" : ""}`}
                  onMouseEnter={() => setSelectedSlashIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSlashCommand(command)}
                  role="menuitem"
                  aria-label={parts.label}
                >
                  {parts.shortcut && (
                    <strong className="slash-command-shortcut">
                      {parts.shortcut}
                    </strong>
                  )}
                  <span>{parts.rest}</span>
                </button>
              );
            })}
          </div>
        )}

        {collapsed && (
          <div className="message-input-collapsed-actions">
            <button
              type="button"
              onClick={submitPrimaryAction}
              disabled={disabled || !canSubmit}
              className={`send-button message-input-collapsed-send`}
              aria-label={primaryActionLabel}
              title={primaryActionLabel}
            >
              <span className="send-icon">
                {effectivePrimaryActionKind === "steer"
                  ? "↗"
                  : effectivePrimaryActionKind === "queue"
                    ? "→"
                    : "↑"}
              </span>
            </button>
          </div>
        )}

        {!collapsed && correctionActive && (
          <div className="correction-draft">
            <span className="correction-draft-label">
              {t("sessionCorrectionActive")}
            </span>
            <button
              type="button"
              className="correction-draft-cancel"
              onClick={onCancelCorrection}
              aria-label={t("sessionCorrectionCancel")}
              title={t("sessionCorrectionCancel")}
            >
              ×
            </button>
          </div>
        )}

        {/* Attachment chips - show below textarea when not collapsed */}
        {!collapsed &&
          (attachments.length > 0 || uploadProgress.length > 0) && (
            <div className="attachment-list">
              {attachments.map((file) => (
                <AttachmentChip
                  key={file.id}
                  attachmentId={file.id}
                  originalName={file.originalName}
                  path={file.path}
                  mimeType={file.mimeType}
                  sizeLabel={formatSize(file.size)}
                  imageWidth={file.width}
                  imageHeight={file.height}
                  onRemove={
                    onRemoveAttachment
                      ? () => onRemoveAttachment(file.id)
                      : undefined
                  }
                />
              ))}
              {uploadProgress.map((progress) => (
                <div
                  key={progress.fileId}
                  className="attachment-chip uploading"
                >
                  <span className="attachment-name">{progress.fileName}</span>
                  <span className="attachment-progress">
                    {progress.percent}%
                  </span>
                </div>
              ))}
            </div>
          )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />

        {!collapsed && promptSuggestion && (
          <div className="prompt-suggestion">
            <button
              type="button"
              className="prompt-suggestion-text"
              onClick={() => {
                const metadata = buildSubmissionMetadata("direct");
                onDismissPromptSuggestion?.();
                onSend(promptSuggestion, metadata);
                textareaRef.current?.focus();
              }}
              title="Send this suggestion"
            >
              {promptSuggestion}
            </button>
            <button
              type="button"
              className="prompt-suggestion-dismiss"
              onClick={onDismissPromptSuggestion}
              aria-label="Dismiss suggestion"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {!collapsed && (
          <MessageInputToolbar
            mode={mode}
            onModeChange={onModeChange}
            modeChangesApplyNextTurn={modeChangesApplyNextTurn}
            supportsPermissionMode={supportsPermissionMode}
            supportsThinkingToggle={supportsThinkingToggle}
            canAttach={canAttach}
            attachmentCount={attachments.length}
            onAttachClick={() => fileInputRef.current?.click()}
            voiceButtonRef={voiceButtonRef}
            onVoiceTranscript={handleVoiceTranscript}
            onInterimTranscript={handleInterimTranscript}
            onListeningStart={handleListeningStart}
            onListeningStop={handleListeningStop}
            onSpeechProcessingChange={handleSpeechProcessingChange}
            voiceDisabled={disabled}
            getTranscriptionContext={getTranscriptionContext}
            slashCommands={slashCommands}
            onSelectSlashCommand={handleSlashCommand}
            onBtwClick={onBtwShortcut ? handleBtwClick : undefined}
            btwActive={btwActive}
            btwHasAsides={btwHasAsides}
            btwToolbarMode={btwToolbarMode}
            thinkingProvider={thinkingProvider}
            thinkingModel={thinkingModel}
            contextRequestedModel={contextRequestedModel}
            heartbeatEnabled={heartbeatEnabled}
            patientQueuePatienceSeconds={effectivePatientQueuePatienceSeconds}
            onToggleHeartbeat={onToggleHeartbeat}
            onConfigureHeartbeat={onConfigureHeartbeat}
            contextUsage={contextUsage}
            lastActivityAt={lastActivityAt}
            sessionLiveness={sessionLiveness}
            showPatientQueueMode={showPatientQueueMode}
            patientQueueEnabled={patientQueueEnabled}
            onTogglePatientQueue={togglePatientQueueEnabled}
            showSteerNowMode={supportsSteerNow && hasActiveDualActions}
            steerNowEnabled={steerNowEnabled}
            onToggleSteerNow={() => setSteerNowOverride(!steerNowEnabled)}
            enterActionKind={
              effectivePrimaryActionKind === "steer" ||
              effectivePrimaryActionKind === "queue"
                ? effectivePrimaryActionKind
                : undefined
            }
            canSwapEnterAction={hasActiveDualActions}
            onSwapEnterAction={toggleEnterActionKind}
            isRunning={isRunning}
            isThinking={isThinking}
            onStop={onStop}
            onSend={
              effectivePrimaryActionKind === "queue"
                ? handleQueue
                : handleSubmit
            }
            onQueue={onQueue ? handleQueue : undefined}
            onSteer={hasActiveDualActions ? handleSteer : undefined}
            primaryActionKind={effectivePrimaryActionKind}
            canSend={canSubmit}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}
