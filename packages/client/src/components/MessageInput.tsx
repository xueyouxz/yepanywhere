import type {
  SessionLivenessSnapshot,
  UploadedFile,
  UserMessageCompositionMetadata,
  UserMessageDeliveryIntent,
} from "@yep-anywhere/shared";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import { useI18n } from "../i18n";
import type { BtwToolbarMode } from "../lib/btwAsideRouting";
import type { ModelIndicatorTone } from "../lib/modelConfigIndicator";
import { hasCoarsePointer } from "../lib/deviceDetection";
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
  composition: UserMessageCompositionMetadata;
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

const PATIENT_QUEUE_PREFIX = "when done, ";
const PATIENT_QUEUE_STORAGE_SUFFIX = ":patient-queue-mode";
const PATIENT_QUEUE_PREFIXES = [
  PATIENT_QUEUE_PREFIX,
  "when you are at a natural wrap-up point, ",
  "as soon as previous requested requests are satisfied, ",
  "as soon as prev. requested requests are satisfied, ",
  "zzz:",
  "zzz: ",
];

function patientQueueStorageKey(draftKey: string): string {
  return `${draftKey}${PATIENT_QUEUE_STORAGE_SUFFIX}`;
}

function readPatientQueueMode(
  draftKey: string,
  defaultEnabled: boolean,
): boolean {
  if (!defaultEnabled) return false;

  try {
    const stored = globalThis.localStorage?.getItem(
      patientQueueStorageKey(draftKey),
    );
    if (stored === "patient") return true;
    if (stored === "asap") return false;
  } catch {
    // Local storage is a convenience, not part of queue delivery.
  }

  return defaultEnabled;
}

function writePatientQueueMode(draftKey: string, enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(
      patientQueueStorageKey(draftKey),
      enabled ? "patient" : "asap",
    );
  } catch {
    // Local storage is a convenience, not part of queue delivery.
  }
}

function hasPatientQueuePrefix(message: string): boolean {
  const normalized = message.trimStart().toLocaleLowerCase();
  return PATIENT_QUEUE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix.toLocaleLowerCase()),
  );
}

function applyPatientQueuePrefix(message: string, enabled: boolean): string {
  if (!enabled || !message || hasPatientQueuePrefix(message)) return message;
  return `${PATIENT_QUEUE_PREFIX}${message}`;
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
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;
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
  /** Live model/effort indicator shown on the slash button */
  modelIndicatorTone?: ModelIndicatorTone;
  modelIndicatorProvider?: string;
  modelIndicatorModel?: string;
  modelIndicatorTitle?: string;
  /** Whether heartbeat turns are currently enabled for this session */
  heartbeatEnabled?: boolean;
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
}

export function MessageInput({
  onSend,
  onQueue,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
  modeChangesApplyNextTurn,
  isHeld,
  onHoldChange,
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
  primaryActionKind,
  slashCommands = [],
  onCustomCommand,
  onBtwShortcut,
  btwActive = false,
  btwHasAsides = false,
  btwToolbarMode,
  modelIndicatorTone,
  modelIndicatorProvider,
  modelIndicatorModel,
  modelIndicatorTitle,
  heartbeatEnabled = false,
  onToggleHeartbeat,
  onConfigureHeartbeat,
  correctionActive = false,
  onCancelCorrection,
  onRecallLastSubmission,
  onCancelLatestDeferred,
}: Props) {
  const { t } = useI18n();
  const [text, setText, controls] = useDraftPersistence(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const typingStartedAtRef = useRef<string | null>(null);
  const lastEditedAtRef = useRef<string | null>(null);
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? text + (text.trimEnd() ? " " : "") + interimTranscript
    : text;

  // Auto-scroll textarea when voice input updates (interim transcript changes)
  // Browser handles scrolling for normal typing, but programmatic updates need explicit scroll
  useEffect(() => {
    if (interimTranscript) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    }
  }, [interimTranscript]);

  // Panel is collapsed if user collapsed it OR if externally collapsed (approval panel showing)
  const collapsed = userCollapsed || externalCollapsed;
  const canSubmit = !!(text.trim() || attachments.length > 0);
  const effectivePrimaryActionKind =
    primaryActionKind ?? (supportsSteering && onQueue
      ? "steer"
      : onQueue
        ? "queue"
        : "send");
  const showPatientQueueMode = supportsSteering && !!onQueue;
  const [patientQueueMode, setPatientQueueMode] = useState(() =>
    readPatientQueueMode(draftKey, showPatientQueueMode),
  );
  const patientQueueEnabled = showPatientQueueMode && patientQueueMode;
  const primaryActionLabel = effectivePrimaryActionKind === "steer"
    ? t("toolbarSteerTooltip")
    : effectivePrimaryActionKind === "queue"
      ? t("toolbarQueueLabel")
      : t("toolbarSend");

  const canAttach = !!(projectId && sessionId && onAttach);

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
  }, []);

  const buildSubmissionMetadata = useCallback(
    (deliveryIntent: UserMessageDeliveryIntent): MessageSubmissionMetadata => {
      const submittedAt = new Date().toISOString();
      const typingStartedAt = typingStartedAtRef.current ?? submittedAt;
      const lastEditedAt = lastEditedAtRef.current ?? typingStartedAt;
      return {
        deliveryIntent,
        composition: {
          typingStartedAt,
          typingEndedAt: submittedAt,
          lastEditedAt,
          submittedAt,
        },
      };
    },
    [],
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

  useEffect(() => {
    setPatientQueueMode(readPatientQueueMode(draftKey, showPatientQueueMode));
  }, [draftKey, showPatientQueueMode]);

  const handlePatientQueueModeChange = useCallback(
    (enabled: boolean) => {
      setPatientQueueMode(enabled);
      writePatientQueueMode(draftKey, enabled);
    },
    [draftKey],
  );

  const handleSubmit = useCallback(() => {
    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    // Combine committed text with any pending voice text
    let finalText = text.trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }

    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled) {
      const message = finalText.trim();
      const deliveryIntent =
        effectivePrimaryActionKind === "steer"
          ? "steer"
          : effectivePrimaryActionKind === "queue"
            ? patientQueueEnabled
              ? "patient"
              : "deferred"
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
  }, [
    text,
    disabled,
    controls,
    onSend,
    attachments.length,
    effectivePrimaryActionKind,
    patientQueueEnabled,
    buildSubmissionMetadata,
    resetCompositionMetadata,
  ]);

  const handleQueue = useCallback(() => {
    const queueHandler =
      onQueue ?? (effectivePrimaryActionKind === "queue" ? onSend : undefined);

    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    let finalText = text.trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }

    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled && queueHandler) {
      const message = applyPatientQueuePrefix(
        finalText.trim(),
        patientQueueEnabled,
      );
      const metadata = buildSubmissionMetadata(
        patientQueueEnabled ? "patient" : "deferred",
      );
      controls.clearInput();
      resetCompositionMetadata();
      setInterimTranscript("");
      queueHandler(message, metadata);
      textareaRef.current?.focus();
    }
  }, [
    text,
    disabled,
    controls,
    onQueue,
    onSend,
    effectivePrimaryActionKind,
    attachments.length,
    patientQueueEnabled,
    buildSubmissionMetadata,
    resetCompositionMetadata,
  ]);

  const handleBtwClick = useCallback(() => {
    if (disabled || !onBtwShortcut) return;
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";
    let finalText = text.trimEnd();
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
  }, [controls, disabled, onBtwShortcut, resetCompositionMetadata, text]);

  const submitPrimaryAction =
    effectivePrimaryActionKind === "queue" ? handleQueue : handleSubmit;

  const recallLastSubmission = useCallback((allowExistingText = false) => {
    if (
      disabled ||
      (!allowExistingText && displayText.trim()) ||
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
  }, [
    attachments.length,
    disabled,
    displayText,
    onRecallLastSubmission,
    uploadProgress.length,
  ]);

  const handleKeyDown = (e: KeyboardEvent) => {
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

    // Ctrl+Space toggles voice input
    if (e.key === " " && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (voiceButtonRef.current?.isAvailable) {
        voiceButtonRef.current.toggle();
      }
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
      e.key.toLowerCase() === "g" &&
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
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

    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // Ctrl+Enter queues a deferred message when agent is running
      if (onQueue && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        handleQueue();
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
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      // Append transcript to existing text with space separator
      // Trim the transcript since mobile speech API includes leading/trailing spaces
      const trimmedTranscript = transcript.trim();
      if (!trimmedTranscript) return;

      const trimmedText = text.trimEnd();
      if (trimmedText) {
        const nextText = `${trimmedText} ${trimmedTranscript}`;
        noteComposerEdit(nextText);
        setText(nextText);
      } else {
        noteComposerEdit(trimmedTranscript);
        setText(trimmedTranscript);
      }
      setInterimTranscript("");
      // Scroll to bottom after committing voice transcript
      // Use setTimeout to ensure state update has rendered
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.scrollTop = textarea.scrollHeight;
        }
      }, 0);
    },
    [noteComposerEdit, text, setText],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  // Handle slash command selection - insert command into text
  const handleSlashCommand = useCallback(
    (command: string) => {
      // Check if this is a custom client-side command (strip leading "/")
      const bare = command.startsWith("/") ? command.slice(1) : command;
      if (onCustomCommand?.(bare)) {
        return; // Custom command handled, don't insert text
      }
      // If text is empty or ends with whitespace, just append the command
      // Otherwise, add a space before it
      const trimmed = text.trimEnd();
      if (trimmed) {
        const nextText = `${trimmed} ${command} `;
        noteComposerEdit(nextText);
        setText(nextText);
      } else {
        const nextText = `${command} `;
        noteComposerEdit(nextText);
        setText(nextText);
      }
      // Focus the textarea so user can continue typing
      textareaRef.current?.focus();
    },
    [text, setText, onCustomCommand, noteComposerEdit],
  );

  return (
    <div className="message-input-wrapper">
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
        <textarea
          ref={textareaRef}
          value={displayText}
          onChange={(e) => {
            // If user edits while recording, only update committed text
            // This clears interim since they're now typing
            setInterimTranscript("");
            noteComposerEdit(e.target.value);
            setText(e.target.value);
          }}
          onBlur={controls.flushDraft}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          enterKeyHint="send"
          placeholder={
            externalCollapsed ? t("messageInputContinueAbove") : placeholder
          }
          disabled={disabled}
          rows={collapsed ? 1 : 3}
        />

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
                    ? "⏱"
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

        {!collapsed && (
          <MessageInputToolbar
            mode={mode}
            onModeChange={onModeChange}
            modeChangesApplyNextTurn={modeChangesApplyNextTurn}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
            supportsPermissionMode={supportsPermissionMode}
            supportsThinkingToggle={supportsThinkingToggle}
            canAttach={canAttach}
            attachmentCount={attachments.length}
            onAttachClick={() => fileInputRef.current?.click()}
            voiceButtonRef={voiceButtonRef}
            onVoiceTranscript={handleVoiceTranscript}
            onInterimTranscript={handleInterimTranscript}
            onListeningStart={() => textareaRef.current?.focus()}
            voiceDisabled={disabled}
            slashCommands={slashCommands}
            onSelectSlashCommand={handleSlashCommand}
            onBtwClick={onBtwShortcut ? handleBtwClick : undefined}
            btwActive={btwActive}
            btwHasAsides={btwHasAsides}
            btwToolbarMode={btwToolbarMode}
            modelIndicatorTone={modelIndicatorTone}
            modelIndicatorProvider={modelIndicatorProvider}
            modelIndicatorModel={modelIndicatorModel}
            modelIndicatorTitle={modelIndicatorTitle}
            heartbeatEnabled={heartbeatEnabled}
            onToggleHeartbeat={onToggleHeartbeat}
            onConfigureHeartbeat={onConfigureHeartbeat}
            contextUsage={contextUsage}
            lastActivityAt={lastActivityAt}
            sessionLiveness={sessionLiveness}
            showPatientQueueMode={showPatientQueueMode}
            patientQueueMode={patientQueueEnabled}
            onPatientQueueModeChange={handlePatientQueueModeChange}
            isRunning={isRunning}
            isThinking={isThinking}
            onStop={onStop}
            onSend={
              effectivePrimaryActionKind === "queue"
                ? handleQueue
                : handleSubmit
            }
            onQueue={onQueue ? handleQueue : undefined}
            primaryActionKind={effectivePrimaryActionKind}
            canSend={canSubmit}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}
