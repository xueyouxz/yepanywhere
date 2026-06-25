import {
  DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS,
  type BusyComposerDefaultAction,
  clampPatientPatienceSeconds,
  type CollapsedComposerButtonPreference,
  type SessionLivenessSnapshot,
  type UploadedFile,
  type UserMessageCompositionMetadata,
  type UserMessageDeliveryIntent,
  type UserMessageSpeechMetadata,
} from "@yep-anywhere/shared";
import {
  type ClipboardEvent,
  Fragment,
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
import {
  getDraftTextChangeMetadata,
  type DraftTextChangeMetadata,
  type DraftTextEdit,
} from "../lib/commentAnchors";
import { hasCoarsePointer } from "../lib/deviceDetection";
import { generateUUID } from "../lib/uuid";
import type {
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
  SpeechTranscriptionSettlement,
} from "../lib/speechProviders/SpeechProvider";
import {
  clearSpeechInsertionRangeReplacement,
  createSpeechInsertionRange,
  getSpeechSelectionFinalDelayMs,
  getSpeechMirrorSegments,
  getSpeechTranscriptInsertionParts,
  getSpeechTranscriptReplacementParts,
  mapSpeechInsertionRangeThroughEdit,
  mapSpeechInsertionRangeThroughReplacement,
  retargetSpeechInsertionRangeReplacement,
  type SpeechInsertionRange,
} from "../lib/speechRecognition";
import {
  commitSpeechTranscript,
  hasNonWhitespaceEdit,
  type PendingTextareaSelectionRestore,
} from "../lib/speechDraftTransaction";
import { getSlashCommandMenuParts } from "../lib/slashCommands";
import { isVoiceInputShortcut } from "../lib/voiceInputShortcut";
import type { ContextUsage, PermissionMode } from "../types";
import { AttachmentChip } from "./AttachmentChip";
import { MessageInputToolbar } from "./MessageInputToolbar";
import {
  VoiceInputButton,
  type SpeechPendingKind,
  type VoiceInputButtonRef,
} from "./VoiceInputButton";

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

interface PendingSpeechFinal {
  timer: ReturnType<typeof setTimeout>;
  transcript: string;
  metadata?: SpeechTranscriptionResultMetadata;
}

interface PendingDraftInputEdit {
  start: number;
  end: number;
  inputType?: string;
}

const EXPANDED_COMPOSER_MAX_VIEWPORT_RATIO = 0.5;
const FALLBACK_TEXTAREA_LINE_HEIGHT_PX = 20;

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

function replaceTextareaRangeUndoably(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
): void {
  textarea.focus();
  textarea.setSelectionRange(start, end);

  // React state-only replacements bypass native undo; edit the textarea first
  // so browsers that still wire execCommand into the undo stack can preserve it.
  try {
    const command = replacement ? "insertText" : "delete";
    if (document.execCommand?.(command, false, replacement)) {
      return;
    }
  } catch {
    // Fall back to a direct textarea edit below.
  }

  textarea.setRangeText(replacement, start, end, "end");
}

function getInsertedTextForEdit(
  previousText: string,
  nextText: string,
  start: number,
  end: number,
): string {
  const replacementLength = Math.max(0, end - start);
  const insertedLength =
    nextText.length - previousText.length + replacementLength;
  if (insertedLength <= 0) {
    return "";
  }
  return nextText.slice(start, start + insertedLength);
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

function normalizeSlashCommandForMatch(command: string): string {
  return command.replace(/^\/+/, "").toLowerCase();
}

function readPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTextareaMinimumHeight(textarea: HTMLTextAreaElement): number {
  const computed = window.getComputedStyle(textarea);
  const fontSize =
    readPixelValue(computed.fontSize) || FALLBACK_TEXTAREA_LINE_HEIGHT_PX;
  const lineHeight = readPixelValue(computed.lineHeight) || fontSize * 1.35;
  const verticalPadding =
    readPixelValue(computed.paddingTop) +
    readPixelValue(computed.paddingBottom);
  const verticalBorder =
    readPixelValue(computed.borderTopWidth) +
    readPixelValue(computed.borderBottomWidth);
  return lineHeight * textarea.rows + verticalPadding + verticalBorder;
}

function getComposerChromeHeight(textarea: HTMLTextAreaElement): number {
  const composer = textarea.closest(".message-input");
  if (!(composer instanceof HTMLElement)) return 0;
  return Math.max(
    0,
    composer.getBoundingClientRect().height -
      textarea.getBoundingClientRect().height,
  );
}

function getExpandedComposerMaxTextareaHeight(
  textarea: HTMLTextAreaElement,
  minimumHeight: number,
): number {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const chromeHeight = getComposerChromeHeight(textarea);
  return Math.max(
    minimumHeight,
    Math.floor(
      viewportHeight * EXPANDED_COMPOSER_MAX_VIEWPORT_RATIO - chromeHeight,
    ),
  );
}

function resizeComposerTextarea(
  textarea: HTMLTextAreaElement,
  collapsed: boolean | undefined,
): void {
  if (collapsed) {
    textarea.style.height = "";
    textarea.style.overflowY = "";
    return;
  }

  const minimumHeight = getTextareaMinimumHeight(textarea);
  textarea.style.height = "auto";
  const contentHeight = Math.max(textarea.scrollHeight, minimumHeight);
  const maxHeight = getExpandedComposerMaxTextareaHeight(
    textarea,
    minimumHeight,
  );
  const nextHeight = Math.min(contentHeight, maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = contentHeight > nextHeight + 1 ? "auto" : "hidden";
}

function countDraftLines(text: string): number {
  return text.length === 0 ? 1 : text.split(/\r\n|\r|\n/).length;
}

function getTextareaLineHeightPx(textarea: HTMLTextAreaElement): number {
  const computed = window.getComputedStyle(textarea);
  const fontSize =
    readPixelValue(computed.fontSize) || FALLBACK_TEXTAREA_LINE_HEIGHT_PX;
  return readPixelValue(computed.lineHeight) || fontSize * 1.35;
}

function scrollCollapsedTextareaToCursor(textarea: HTMLTextAreaElement): void {
  const value = textarea.value;
  const caret = Math.max(
    0,
    Math.min(textarea.selectionStart ?? value.length, value.length),
  );
  const lineHeight = getTextareaLineHeightPx(textarea);
  const maxScrollTop = Math.max(
    0,
    textarea.scrollHeight - textarea.clientHeight,
  );
  if (caret >= value.length) {
    textarea.scrollTop = maxScrollTop;
    return;
  }

  const hardLineIndex = countDraftLines(value.slice(0, caret)) - 1;
  textarea.scrollTop = Math.min(
    maxScrollTop,
    Math.max(0, hardLineIndex * lineHeight),
  );
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
  /** Notify parent of draft edits for UI linked to the composer text. */
  onDraftTextChange?: (text: string, metadata: DraftTextChangeMetadata) => void;
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
  /** Temporary mode for entering fork-after-summary instructions. */
  forkSummaryMode?: {
    title: string;
    description: string;
    placeholder: string;
    submitLabel: string;
    tooltip: string;
    icon: string;
    noSummarySubmitLabel?: string;
    noSummaryTooltip?: string;
    noSummaryIcon?: string;
    submitting?: boolean;
    onCancel: () => void;
    onSubmit: (instructions: string) => void;
    onSubmitWithoutSummary?: (text: string) => void;
  };
  /** Composer shortcut for fork-after-summary using current draft as instructions. */
  onForkSummaryShortcut?: (instructions: string) => boolean | undefined;
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
  onDraftTextChange,
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
  forkSummaryMode,
  onForkSummaryShortcut,
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
  const pendingDraftInputRef = useRef<PendingDraftInputEdit | null>(null);
  const draftTextChangeMetadataRef = useRef<DraftTextChangeMetadata | null>(
    null,
  );
  // True once the user manually edits (non-whitespace) during the active mic
  // transaction; holds an automatic Smart Turn endpoint send. Speech-inserted
  // finals go through setDraft (not onChange) and never set this.
  const composerEditedDuringSpeechRef = useRef(false);
  const pendingTextareaSelectionRef =
    useRef<PendingTextareaSelectionRestore | null>(null);
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechPending, setSpeechPending] = useState<SpeechPendingKind | null>(
    null,
  );
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
      normalizeSlashCommandForMatch(command).startsWith(slashQuery),
    );
  }, [slashCommands, slashQuery]);
  const hasExactSlashCommand =
    slashQuery !== null &&
    matchingSlashCommands.some(
      (command) => normalizeSlashCommandForMatch(command) === slashQuery,
    );
  const showSlashSuggestions =
    !collapsed &&
    !disabled &&
    slashQuery !== null &&
    !hasExactSlashCommand &&
    dismissedSlashQuery !== slashQuery &&
    matchingSlashCommands.length > 0;
  const canSubmit = forkSummaryMode
    ? !forkSummaryMode.submitting &&
      attachments.length === 0 &&
      uploadProgress.length === 0
    : !!(text.trim() || attachments.length > 0);
  const interimDisplayTranscript = interimTranscript.trim();
  // The inline mirror previews speech in place at the insertion point (replacing
  // any selected span): streaming interim text while words arrive, otherwise the
  // pending-state label (Listening…/Transcribing…/Finalizing…) so the wait shows
  // where the result will land — unified with the streaming preview rather than a
  // separate chip below the composer. See topics/mic-button-speech-ui.md.
  const speechPendingLabel = speechPending
    ? speechPending === "finalizing"
      ? t("speechFinalizingPlaceholder" as never)
      : speechPending === "listening"
        ? t("speechListeningPlaceholder" as never)
        : t("speechTranscribingPlaceholder" as never)
    : "";
  const speechInlineTranscript = interimDisplayTranscript || speechPendingLabel;
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

  // Pending tags for the no-interim (batch/pending) mirror: one per active
  // speech target at its own insertion point, in arrival order, so overlapping
  // batch transcriptions each show where they will land. The active target's
  // label follows speechPending; the rest are still transcribing. Streaming
  // interim keeps the single interimInsertion path above. Range-map changes are
  // accompanied by state updates (setText/setInterimTranscript/setSpeechPending
  // or setSpeechPreviewRevision), so this recomputes on re-render.
  const pendingTagLabel = (kind: SpeechPendingKind | null): string =>
    kind === "finalizing"
      ? t("speechFinalizingPlaceholder" as never)
      : kind === "listening"
        ? t("speechListeningPlaceholder" as never)
        : t("speechTranscribingPlaceholder" as never);
  const speechRangeTags = interimDisplayTranscript
    ? []
    : [...speechInsertionRangesRef.current.entries()].map(
        ([targetId, range], index) => {
          const active = targetId === activeSpeechTargetIdRef.current;
          return {
            targetId,
            position: range.end,
            replaceEnd: range.replaceEnd ?? range.end,
            active,
            ordinal: index + 1,
            label: pendingTagLabel(active ? speechPending : "transcribing"),
          };
        },
      );
  // Pending but no tracked range yet: show a single tag at the cursor end so
  // the label still appears inline.
  const speechPendingTags =
    speechRangeTags.length === 0 && !interimDisplayTranscript && speechPending
      ? [
          {
            targetId: "pending",
            position: text.length,
            replaceEnd: text.length,
            active: true,
            ordinal: 1,
            label: pendingTagLabel(speechPending),
          },
        ]
      : speechRangeTags;
  const speechMirrorSegments = getSpeechMirrorSegments(text, speechPendingTags);

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [slashQuery, matchingSlashCommands.length]);

  const basePrimaryActionKind =
    primaryActionKind ??
    (supportsSteering && onQueue ? "steer" : onQueue ? "queue" : "send");
  const hasActiveDualActions =
    supportsSteering && !!onQueue && basePrimaryActionKind === "steer";
  const { version } = useVersion();
  const busyComposerDefaultAction: BusyComposerDefaultAction =
    version?.clientDefaults?.busyComposerDefaultAction ?? "steer";
  const collapsedComposerButton: CollapsedComposerButtonPreference =
    version?.clientDefaults?.collapsedComposerButton ?? "primary";
  const enterActionStorageKey = `${draftKey}:enter-action-kind`;
  const [enterActionOverride, setEnterActionOverride] =
    useState<BusyComposerDefaultAction | null>(() => {
      try {
        const stored = localStorage.getItem(enterActionStorageKey);
        return stored === "queue" || stored === "steer" ? stored : null;
      } catch {
        return null;
      }
    });
  // Per-turn "now" steering toggle. The server-learned client default sets
  // its initial state (Message Delivery settings); the toggle stays per-turn
  // and a user click overrides the default for this composer.
  const steerNowDefault = version?.clientDefaults?.steerNowDefault ?? false;
  // Patient queue intent is a global preference (Message Delivery settings):
  // when on, a queued message waits for verified-idle before delivery instead
  // of promoting at the next end of turn.
  const patientQueueEnabled =
    version?.clientDefaults?.patientQueueDefault ?? false;
  const [steerNowOverride, setSteerNowOverride] = useState<boolean | null>(
    null,
  );
  const steerNowEnabled = steerNowOverride ?? steerNowDefault;
  const effectivePrimaryActionKind = hasActiveDualActions
    ? (enterActionOverride ?? busyComposerDefaultAction)
    : basePrimaryActionKind;
  const effectivePatientQueuePatienceSeconds =
    clampPatientPatienceSeconds(patientQueuePatienceSeconds) ??
    DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS;
  const primaryActionLabel = forkSummaryMode
    ? forkSummaryMode.submitLabel
    : effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? t("toolbarQueueLabel")
        : t("toolbarSend");

  const canAttach = !!(projectId && sessionId && onAttach);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(enterActionStorageKey);
      setEnterActionOverride(
        stored === "queue" || stored === "steer" ? stored : null,
      );
    } catch {
      setEnterActionOverride(null);
    }
  }, [enterActionStorageKey]);

  const toggleEnterActionKind = useCallback(() => {
    setEnterActionOverride((previous) => {
      const current = previous ?? busyComposerDefaultAction;
      const next = current === "steer" ? "queue" : "steer";
      try {
        localStorage.setItem(enterActionStorageKey, next);
      } catch {
        // Keyboard preference is local-only; in-memory state still works.
      }
      return next;
    });
  }, [busyComposerDefaultAction, enterActionStorageKey]);

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

  const noteDraftTextChange = useCallback(
    (
      previousText: string,
      nextText: string,
      edit?: Omit<DraftTextEdit, "insertedText"> & { insertedText?: string },
    ) => {
      const insertedText =
        edit?.insertedText ??
        (edit
          ? getInsertedTextForEdit(previousText, nextText, edit.start, edit.end)
          : "");
      draftTextChangeMetadataRef.current = getDraftTextChangeMetadata(
        previousText,
        nextText,
        edit ? { ...edit, insertedText } : undefined,
      );
    },
    [],
  );

  const replaceDraftRangeUndoably = useCallback(
    (start: number, end: number, replacement: string): string | null => {
      const textarea = textareaRef.current;
      if (!textarea) return null;

      const previousText = controls.getDraft();
      const replacementStart = Math.max(
        0,
        Math.min(start, previousText.length),
      );
      const replacementEnd = Math.max(
        replacementStart,
        Math.min(end, previousText.length),
      );
      const nextText = `${previousText.slice(0, replacementStart)}${replacement}${previousText.slice(replacementEnd)}`;
      if (nextText === previousText) return nextText;

      noteDraftTextChange(previousText, nextText, {
        start: replacementStart,
        end: replacementEnd,
        insertedText: replacement,
        inputType: replacement ? "insertText" : "deleteContent",
      });
      replaceTextareaRangeUndoably(
        textarea,
        replacementStart,
        replacementEnd,
        replacement,
      );
      if (textarea.value !== nextText) {
        textarea.value = nextText;
      }

      const pendingFinal = pendingSpeechFinalRef.current;
      if (pendingFinal) {
        clearTimeout(pendingFinal.timer);
        pendingSpeechFinalRef.current = null;
      }
      if (speechInsertionRangesRef.current.size > 0) {
        const nextRanges = new Map<string, SpeechInsertionRange>();
        for (const [targetId, range] of speechInsertionRangesRef.current) {
          nextRanges.set(
            targetId,
            clearSpeechInsertionRangeReplacement(
              mapSpeechInsertionRangeThroughReplacement(
                range,
                replacementStart,
                replacementEnd,
                replacement.length,
              ),
            ),
          );
        }
        speechInsertionRangesRef.current = nextRanges;
        speechInsertionRangeRef.current =
          activeSpeechTargetIdRef.current !== null
            ? (nextRanges.get(activeSpeechTargetIdRef.current) ?? null)
            : null;
      }
      if (
        activeSpeechTargetIdRef.current !== null &&
        hasNonWhitespaceEdit(previousText, nextText)
      ) {
        composerEditedDuringSpeechRef.current = true;
      }
      noteComposerEdit(nextText);
      setText(nextText);
      const nextSlashQuery = getLeadingSlashQuery(nextText);
      if (nextSlashQuery !== dismissedSlashQuery) {
        setDismissedSlashQuery(null);
      }
      return nextText;
    },
    [
      controls,
      dismissedSlashQuery,
      noteComposerEdit,
      noteDraftTextChange,
      setText,
    ],
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length && onAttach) {
      onAttach(Array.from(files));
      e.target.value = ""; // Reset for re-selection
    }
  };

  const draftControls = useMemo<DraftControls>(
    () => ({
      ...controls,
      focus: () => textareaRef.current?.focus(),
      setSelectionRange: (start, end) =>
        textareaRef.current?.setSelectionRange(start, end),
      replaceDraftRangeUndoably,
    }),
    [controls, replaceDraftRangeUndoably],
  );

  // Provide controls to parent via callback
  useEffect(() => {
    onDraftControlsReady?.(draftControls);
  }, [draftControls, onDraftControlsReady]);

  useEffect(() => {
    const metadata = draftTextChangeMetadataRef.current ?? {
      mayAffectQuoteAnchors: true,
    };
    draftTextChangeMetadataRef.current = null;
    onDraftTextChange?.(text, metadata);
  }, [onDraftTextChange, text]);

  useLayoutEffect(() => {
    const pending = pendingTextareaSelectionRef.current;
    const textarea = textareaRef.current;
    if (!pending || !textarea || textarea.value !== pending.value) return;
    pendingTextareaSelectionRef.current = null;
    pending.restore(textarea);
  }, [text]);

  const revealCollapsedTextareaCursor = useCallback(() => {
    if (!collapsed) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const schedule =
      window.requestAnimationFrame ??
      ((fn: FrameRequestCallback) => window.setTimeout(fn, 0));
    schedule(() => {
      if (textareaRef.current === textarea) {
        scrollCollapsedTextareaToCursor(textarea);
      }
    });
  }, [collapsed]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    resizeComposerTextarea(textarea, collapsed);

    if (collapsed) {
      revealCollapsedTextareaCursor();
      return;
    }

    const handleViewportResize = () => {
      resizeComposerTextarea(textarea, false);
    };
    window.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("resize", handleViewportResize);
    return () => {
      window.removeEventListener("resize", handleViewportResize);
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportResize,
      );
    };
  }, [collapsed, revealCollapsedTextareaCursor, text]);

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

      if (forkSummaryMode) {
        if (
          !disabled &&
          attachments.length === 0 &&
          uploadProgress.length === 0
        ) {
          controls.clearInput();
          resetCompositionMetadata();
          setInterimTranscript("");
          forkSummaryMode.onSubmit(finalText.trim());
          textareaRef.current?.focus();
        }
        return;
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
      uploadProgress.length,
      effectivePrimaryActionKind,
      buildSubmissionMetadata,
      resetCompositionMetadata,
      forkSummaryMode,
    ],
  );

  const handleSteer = useCallback(() => {
    handleSubmit(undefined, "steer");
  }, [handleSubmit]);

  const handleForkWithoutSummary = useCallback(() => {
    if (
      !forkSummaryMode?.onSubmitWithoutSummary ||
      disabled ||
      attachments.length > 0 ||
      uploadProgress.length > 0
    ) {
      return;
    }
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";
    let finalText = controls.getDraft();
    if (pendingVoice) {
      const textBeforeVoice = finalText.trimEnd();
      finalText = textBeforeVoice
        ? `${textBeforeVoice} ${pendingVoice}`
        : pendingVoice;
    }
    controls.clearInput();
    resetCompositionMetadata();
    setInterimTranscript("");
    forkSummaryMode.onSubmitWithoutSummary(finalText);
    textareaRef.current?.focus();
  }, [
    attachments.length,
    controls,
    disabled,
    forkSummaryMode,
    resetCompositionMetadata,
    uploadProgress.length,
  ]);

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

  const submitPrimaryAction = forkSummaryMode
    ? handleSubmit
    : effectivePrimaryActionKind === "queue"
      ? handleQueue
      : handleSubmit;
  const collapsedActionKind =
    collapsedComposerButton === "alternate" && hasActiveDualActions
      ? effectivePrimaryActionKind === "queue"
        ? "steer"
        : "queue"
      : effectivePrimaryActionKind;
  const collapsedSubmitAction =
    forkSummaryMode || collapsedActionKind === effectivePrimaryActionKind
      ? submitPrimaryAction
      : collapsedActionKind === "queue"
        ? handleQueue
        : collapsedActionKind === "steer"
          ? handleSteer
          : handleSubmit;
  const collapsedActionLabel = forkSummaryMode
    ? primaryActionLabel
    : collapsedActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : collapsedActionKind === "queue"
        ? t("toolbarQueueLabel")
        : t("toolbarSend");
  const collapsedActionIcon = forkSummaryMode
    ? forkSummaryMode.icon
    : collapsedActionKind === "steer"
      ? "↗"
      : collapsedActionKind === "queue"
        ? "→"
        : "↑";
  const collapsedLineCount = countDraftLines(text);
  const showCollapsedLineCount = collapsedLineCount > 1;
  const hasYaServerSpeechBackend = (version?.voiceBackends?.length ?? 0) > 0;
  const showCollapsedMicrophone =
    collapsed && !forkSummaryMode && collapsedComposerButton === "microphone";
  const showCollapsedDesktopMicrophone =
    collapsed &&
    !forkSummaryMode &&
    collapsedComposerButton !== "microphone" &&
    hasYaServerSpeechBackend;
  const showCollapsedSendAction =
    collapsed &&
    (forkSummaryMode ||
      collapsedComposerButton !== "microphone" ||
      !hasYaServerSpeechBackend);

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
      noteDraftTextChange(text, nextText, {
        start: slashDraft ? 0 : trimmed.length,
        end: text.length,
        inputType: "insertText",
      });
      noteComposerEdit(nextText);
      setText(nextText);
      setDismissedSlashQuery(null);
      textareaRef.current?.focus();
    },
    [text, setText, onCustomCommand, noteComposerEdit, noteDraftTextChange],
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

    // The pending post-capture wait now shows its label inline at the cursor
    // (no chip ✕). Escape cancels it — drops the uncommitted result, keeps any
    // already-committed text. (Active listening still finalizes on Escape below.)
    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      (speechPending === "transcribing" || speechPending === "finalizing")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handleCancelTranscription();
      return;
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

    if (
      e.key === "Enter" &&
      e.ctrlKey &&
      e.altKey &&
      !e.metaKey &&
      !e.shiftKey &&
      onForkSummaryShortcut
    ) {
      e.preventDefault();
      const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";
      let finalText = controls.getDraft().trimEnd();
      if (pendingVoice) {
        finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
      }
      const accepted = onForkSummaryShortcut(finalText.trim());
      if (accepted !== false && finalText.trim()) {
        controls.clearInput();
        resetCompositionMetadata();
        setInterimTranscript("");
      }
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
        noteDraftTextChange(text, "", {
          start: 0,
          end: text.length,
          insertedText: "",
          inputType: "deleteContent",
        });
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
      noteDraftTextChange(text, promptSuggestion, {
        start: 0,
        end: text.length,
        insertedText: promptSuggestion,
        inputType: "insertText",
      });
      noteComposerEdit(promptSuggestion);
      setText(promptSuggestion);
      onDismissPromptSuggestion?.();
      return;
    }

    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      if (
        forkSummaryMode?.onSubmitWithoutSummary &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        handleForkWithoutSummary();
        return;
      }

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
    composerEditedDuringSpeechRef.current = false;
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

  const handleTextareaSelectionTarget = useCallback(() => {
    handleSpeechSelectionTarget();
    revealCollapsedTextareaCursor();
  }, [handleSpeechSelectionTarget, revealCollapsedTextareaCursor]);

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
      commitSpeechTranscript(
        {
          textareaRef,
          getDraft: controls.getDraft,
          setDraft: controls.setDraft,
          setInterimTranscript,
          speechInsertionRangeRef,
          activeSpeechTargetIdRef,
          speechInsertionRangesRef,
          pendingTextareaSelectionRef,
          onEdit: noteComposerEdit,
          onTranscriptionId: (id) => {
            speechTranscriptionIdsRef.current = [
              ...speechTranscriptionIdsRef.current,
              id,
            ];
          },
          onSmartTurnSend: handleSubmit,
          composerEditedDuringSpeech: () =>
            composerEditedDuringSpeechRef.current,
        },
        transcript,
        metadata,
      );
      // An overlapping (non-active) target's batch result has now landed; forget
      // its range so its tag clears. The active target is forgotten on the
      // pending->null transition instead (it may still get more streaming
      // finals).
      const committedTargetId = metadata?.speechTargetId;
      if (
        committedTargetId &&
        committedTargetId !== activeSpeechTargetIdRef.current &&
        speechInsertionRangesRef.current.delete(committedTargetId)
      ) {
        setSpeechPreviewRevision((revision) => revision + 1);
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

  const handlePendingSpeechChange = useCallback(
    (kind: SpeechPendingKind | null) => {
      if (kind === null) {
        // The active recording finished (its result has already committed);
        // forget its insertion target so the inline tag clears and the range
        // map does not accumulate completed targets (which would revive as
        // stale "Transcribing…" tags on the next mic activation).
        const targetId = activeSpeechTargetIdRef.current;
        if (targetId) {
          speechInsertionRangesRef.current.delete(targetId);
        }
        speechInsertionRangeRef.current = null;
        activeSpeechTargetIdRef.current = null;
      }
      setSpeechPending(kind);
    },
    [],
  );

  const handleTranscriptionSettled = useCallback(
    (settlement: SpeechTranscriptionSettlement) => {
      const targetId = settlement.speechTargetId;
      if (!targetId || settlement.status === "completed") return;

      const removed = speechInsertionRangesRef.current.delete(targetId);
      if (targetId === activeSpeechTargetIdRef.current) {
        clearPendingSpeechFinal();
        speechInsertionRangeRef.current = null;
        activeSpeechTargetIdRef.current = null;
        setSpeechPending(null);
        setInterimTranscript("");
      }
      if (removed) {
        setSpeechPreviewRevision((revision) => revision + 1);
      }
    },
    [clearPendingSpeechFinal],
  );

  // Cancel a pending transcription/finalization from the chip's ✕. The provider
  // discards the in-flight result (keeping any committed text); here we drop the
  // pending speech target so the composer forgets the reserved insertion point.
  // Backspace never reaches this — cancel is intentionally explicit-click-only.
  const handleCancelTranscription = useCallback(() => {
    voiceButtonRef.current?.cancelProcessing();
    clearPendingSpeechFinal();
    const targetId = activeSpeechTargetIdRef.current;
    if (targetId) {
      speechInsertionRangesRef.current.delete(targetId);
    }
    speechInsertionRangeRef.current = null;
    activeSpeechTargetIdRef.current = null;
    setSpeechPending(null);
    setInterimTranscript("");
  }, [clearPendingSpeechFinal]);

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
        className={`message-input ${collapsed ? "message-input-collapsed" : ""} ${
          collapsed &&
          (showCollapsedLineCount || showCollapsedDesktopMicrophone)
            ? "has-collapsed-side-actions"
            : ""
        } ${interimTranscript ? "voice-recording" : ""}`}
      >
        <div
          className={`speech-draft-field ${speechInlineTranscript ? "has-interim" : ""}${
            speechInlineTranscript && !interimDisplayTranscript
              ? " has-pending-tag"
              : ""
          }`}
        >
          <div className="speech-draft-inline">
            {speechInlineTranscript && (
              <div className="speech-draft-mirror" aria-hidden="true">
                {interimDisplayTranscript ? (
                  <>
                    <span>{interimInsertion.before}</span>
                    {interimInsertion.separatorBefore}
                    <span className="speech-interim-inline">
                      {interimInsertion.transcript}
                    </span>
                    {interimInsertion.separatorAfter}
                    <span>{interimInsertion.after}</span>
                  </>
                ) : (
                  // One tag per pending speech target at its own insertion point,
                  // in arrival order; the Nth (N>1) carries a "(N)" ordinal. The
                  // active tag gets the ✕ and the faked caret. The real caret
                  // can't sit after a zero-width-in-value tag — see
                  // composer-rich-input.md.
                  speechMirrorSegments.map((seg) =>
                    seg.type === "text" ? (
                      <span key={seg.key}>{seg.text}</span>
                    ) : (
                      <Fragment key={seg.tag.targetId}>
                        <span className="speech-processing-inline">
                          {seg.tag.label}
                          {seg.tag.ordinal > 1 && (
                            <span className="speech-tag-ordinal">
                              {` (${seg.tag.ordinal})`}
                            </span>
                          )}
                          {seg.tag.active && (
                            <button
                              type="button"
                              className="speech-tag-cancel"
                              tabIndex={-1}
                              aria-hidden="true"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={handleCancelTranscription}
                              title={t("speechTranscribingCancel" as never)}
                            >
                              ×
                            </button>
                          )}
                        </span>
                        {seg.tag.active && (
                          <span className="speech-tag-caret" />
                        )}
                      </Fragment>
                    ),
                  )
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onBeforeInput={(event) => {
                const nativeEvent = event.nativeEvent as InputEvent;
                pendingDraftInputRef.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                  inputType: nativeEvent.inputType,
                };
              }}
              onChange={(e) => {
                const nextText = e.target.value;
                const pendingInput = pendingDraftInputRef.current;
                pendingDraftInputRef.current = null;
                noteDraftTextChange(
                  text,
                  nextText,
                  pendingInput
                    ? {
                        ...pendingInput,
                        insertedText: getInsertedTextForEdit(
                          text,
                          nextText,
                          pendingInput.start,
                          pendingInput.end,
                        ),
                      }
                    : undefined,
                );
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
                if (
                  activeSpeechTargetIdRef.current !== null &&
                  hasNonWhitespaceEdit(text, nextText)
                ) {
                  composerEditedDuringSpeechRef.current = true;
                }
                noteComposerEdit(nextText);
                setText(nextText);
                const nextSlashQuery = getLeadingSlashQuery(nextText);
                if (nextSlashQuery !== dismissedSlashQuery) {
                  setDismissedSlashQuery(null);
                }
              }}
              onBlur={controls.flushDraft}
              onFocus={revealCollapsedTextareaCursor}
              onKeyDown={handleKeyDown}
              onSelect={handleTextareaSelectionTarget}
              onPointerUp={handleTextareaSelectionTarget}
              onKeyUp={handleTextareaSelectionTarget}
              onCut={clearSpeechSelectionTarget}
              onCopy={clearSpeechSelectionTarget}
              onPaste={(event) => {
                clearSpeechSelectionTarget();
                handlePaste(event);
              }}
              enterKeyHint="send"
              placeholder={
                externalCollapsed
                  ? t("messageInputContinueAbove")
                  : forkSummaryMode
                    ? forkSummaryMode.placeholder
                    : placeholder
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

        {collapsed &&
          (showCollapsedLineCount || showCollapsedDesktopMicrophone) && (
            <div className="message-input-collapsed-side-actions">
              {showCollapsedLineCount && (
                <span
                  className="message-input-collapsed-line-count"
                  title={t("messageInputCollapsedLineCount", {
                    count: String(collapsedLineCount),
                  })}
                >
                  {t("messageInputCollapsedLineCount", {
                    count: String(collapsedLineCount),
                  })}
                </span>
              )}
              {showCollapsedDesktopMicrophone && (
                <VoiceInputButton
                  ref={voiceButtonRef}
                  onTranscript={handleVoiceTranscript}
                  onInterimTranscript={handleInterimTranscript}
                  onListeningStart={handleListeningStart}
                  onListeningStop={handleListeningStop}
                  onPendingSpeechChange={handlePendingSpeechChange}
                  onTranscriptionSettled={handleTranscriptionSettled}
                  disabled={disabled}
                  getTranscriptionContext={getTranscriptionContext}
                  className="message-input-collapsed-mic"
                />
              )}
            </div>
          )}

        {collapsed && (
          <div className="message-input-collapsed-actions">
            {showCollapsedMicrophone && (
              <VoiceInputButton
                ref={voiceButtonRef}
                onTranscript={handleVoiceTranscript}
                onInterimTranscript={handleInterimTranscript}
                onListeningStart={handleListeningStart}
                onListeningStop={handleListeningStop}
                onPendingSpeechChange={handlePendingSpeechChange}
                onTranscriptionSettled={handleTranscriptionSettled}
                disabled={disabled}
                getTranscriptionContext={getTranscriptionContext}
                className="message-input-collapsed-mic"
              />
            )}
            {showCollapsedSendAction && (
              <button
                type="button"
                onClick={collapsedSubmitAction}
                disabled={disabled || !canSubmit}
                className={`send-button message-input-collapsed-send`}
                aria-label={collapsedActionLabel}
                title={collapsedActionLabel}
              >
                <span className="send-icon">{collapsedActionIcon}</span>
              </button>
            )}
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

        {!collapsed && forkSummaryMode && (
          <div className="fork-summary-draft">
            <div className="fork-summary-draft-copy">
              <span className="fork-summary-draft-label">
                {forkSummaryMode.title}
              </span>
              <span className="fork-summary-draft-description">
                {forkSummaryMode.description}
              </span>
            </div>
            <button
              type="button"
              className="fork-summary-draft-cancel"
              onClick={forkSummaryMode.onCancel}
              aria-label={t("forkSummaryCancel")}
              title={t("forkSummaryCancel")}
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
            onPendingSpeechChange={handlePendingSpeechChange}
            onTranscriptionSettled={handleTranscriptionSettled}
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
            onToggleHeartbeat={onToggleHeartbeat}
            onConfigureHeartbeat={onConfigureHeartbeat}
            contextUsage={contextUsage}
            lastActivityAt={lastActivityAt}
            sessionLiveness={sessionLiveness}
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
              forkSummaryMode
                ? handleSubmit
                : effectivePrimaryActionKind === "queue"
                  ? handleQueue
                  : handleSubmit
            }
            onQueue={onQueue ? handleQueue : undefined}
            onSteer={hasActiveDualActions ? handleSteer : undefined}
            primaryActionKind={effectivePrimaryActionKind}
            sendOverride={
              forkSummaryMode
                ? {
                    label: forkSummaryMode.submitLabel,
                    tooltip: forkSummaryMode.tooltip,
                    icon: forkSummaryMode.icon,
                  }
                : undefined
            }
            sendAlternate={
              forkSummaryMode?.onSubmitWithoutSummary
                ? {
                    label:
                      forkSummaryMode.noSummarySubmitLabel ??
                      t("forkSummaryNoSummarySubmit"),
                    tooltip:
                      forkSummaryMode.noSummaryTooltip ??
                      t("forkSummaryNoSummaryTooltip"),
                    icon: forkSummaryMode.noSummaryIcon ?? "↱",
                    onClick: handleForkWithoutSummary,
                  }
                : undefined
            }
            canForkAfterSummary={!!onForkSummaryShortcut}
            canSend={canSubmit}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}
