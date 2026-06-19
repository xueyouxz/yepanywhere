import {
  Fragment,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useFabVisibility } from "../hooks/useFabVisibility";
import { useFloatingActionButtonEnabled } from "../hooks/useFloatingActionButtonEnabled";
import { setRecentProjectId } from "../hooks/useRecentProject";
import { setNewSessionPrefill } from "../lib/newSessionPrefill";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { generateUUID } from "../lib/uuid";
import {
  clearSpeechInsertionRangeReplacement,
  createSpeechInsertionRange,
  getSpeechSelectionFinalDelayMs,
  getSpeechMirrorSegments,
  getSpeechTranscriptInsertionParts,
  getSpeechTranscriptReplacementParts,
  mapSpeechInsertionRangeThroughEdit,
  retargetSpeechInsertionRangeReplacement,
  type SpeechInsertionRange,
} from "../lib/speechRecognition";
import {
  commitSpeechTranscript,
  hasNonWhitespaceEdit,
  type PendingTextareaSelectionRestore,
} from "../lib/speechDraftTransaction";
import type {
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
} from "../lib/speechProviders/SpeechProvider";
import {
  VoiceInputButton,
  type SpeechPendingKind,
  type VoiceInputButtonRef,
} from "./VoiceInputButton";

const FAB_DRAFT_KEY = "fab-draft";

function createSpeechTargetId(): string {
  return `speech-target-${generateUUID()}`;
}

interface PendingSpeechFinal {
  timer: ReturnType<typeof setTimeout>;
  transcript: string;
  metadata?: SpeechTranscriptionResultMetadata;
}

/**
 * Floating Action Button for quick session creation.
 * Desktop-only feature that appears in the right margin when there's room.
 */
export function FloatingActionButton() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = useRemoteBasePath();
  const fabVisibility = useFabVisibility();
  const { floatingActionButtonEnabled } = useFloatingActionButtonEnabled();
  const [isExpanded, setIsExpanded] = useState(false);
  const [message, setMessage, draftControls] =
    useDraftPersistence(FAB_DRAFT_KEY);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechPending, setSpeechPending] = useState<SpeechPendingKind | null>(
    null,
  );
  const [, setSpeechPreviewRevision] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const speechInsertionRangeRef = useRef<SpeechInsertionRange | null>(null);
  const activeSpeechTargetIdRef = useRef<string | null>(null);
  const speechInsertionRangesRef = useRef<Map<string, SpeechInsertionRange>>(
    new Map(),
  );
  const pendingSpeechFinalRef = useRef<PendingSpeechFinal | null>(null);
  // True once the user manually edits (non-whitespace) during the active mic
  // transaction; holds an automatic Smart Turn endpoint send. Speech-inserted
  // finals go through setDraft (not onChange) and never set this.
  const composerEditedDuringSpeechRef = useRef(false);
  const pendingTextareaSelectionRef =
    useRef<PendingTextareaSelectionRestore | null>(null);
  const interimDisplayTranscript = interimTranscript.trim();
  // The inline mirror previews speech in place at the insertion point: streaming
  // interim text, otherwise the pending-state label (Listening…/Transcribing…/
  // Finalizing…), unified with the streaming preview rather than a sibling chip.
  // See topics/mic-button-speech-ui.md.
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
        message,
        speechInlineTranscript,
        speechInsertionRange.end,
        speechInsertionRange.replaceEnd ?? speechInsertionRange.end,
      )
    : getSpeechTranscriptInsertionParts(
        message,
        speechInlineTranscript,
        message.length,
      );

  // One tag per pending speech target at its own insertion point (arrival
  // order, "(N)" on the Nth>1); see MessageInput / topics/mic-button-speech-ui.md.
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
  const speechPendingTags =
    speechRangeTags.length === 0 && !interimDisplayTranscript && speechPending
      ? [
          {
            targetId: "pending",
            position: message.length,
            replaceEnd: message.length,
            active: true,
            ordinal: 1,
            label: pendingTagLabel(speechPending),
          },
        ]
      : speechRangeTags;
  const speechMirrorSegments = getSpeechMirrorSegments(
    message,
    speechPendingTags,
  );

  // Extract projectId from current URL if we're in a project context
  const projectIdFromUrl = extractProjectIdFromPath(location.pathname);

  // Update recent project when navigating to a project page
  useEffect(() => {
    if (projectIdFromUrl) {
      setRecentProjectId(projectIdFromUrl);
    }
  }, [projectIdFromUrl]);

  // Focus textarea when expanded
  useEffect(() => {
    if (isExpanded) {
      textareaRef.current?.focus();
    }
  }, [isExpanded]);

  useLayoutEffect(() => {
    const pending = pendingTextareaSelectionRef.current;
    const textarea = textareaRef.current;
    if (!pending || !textarea || textarea.value !== pending.value) return;
    pendingTextareaSelectionRef.current = null;
    pending.restore(textarea);
  }, [message]);

  // Close on click outside
  useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  const handleSubmit = useCallback(
    (messageOverride?: unknown) => {
      const trimmed = (
        typeof messageOverride === "string" ? messageOverride : message
      ).trim();
      if (!trimmed) return;

      // Store the message for NewSessionForm to pick up
      setNewSessionPrefill(trimmed);
      draftControls.clearDraft();
      setIsExpanded(false);

      // Navigate to new session page
      if (projectIdFromUrl) {
        navigate(
          `${basePath}/new-session?projectId=${encodeURIComponent(projectIdFromUrl)}`,
        );
        return;
      }

      navigate(`${basePath}/new-session`);
    },
    [message, projectIdFromUrl, navigate, draftControls, basePath],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
    if (e.key === "Enter" && e.nativeEvent.isComposing) return;

    // Escape cancels a pending post-capture wait (its label is inline at the
    // cursor; no chip ✕). Active listening still finalizes on Escape below.
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

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      setIsExpanded(false);
    }
    // Shift+Enter naturally adds newline (default behavior)
  };

  const handleButtonClick = useCallback(() => {
    setIsExpanded(true);
  }, []);

  // Voice input handlers
  const handleListeningStart = useCallback(() => {
    const textarea = textareaRef.current;
    const current = draftControls.getDraft();
    const selectionStart = Math.max(
      0,
      Math.min(textarea?.selectionStart ?? current.length, current.length),
    );
    const selectionEnd = Math.max(
      selectionStart,
      Math.min(textarea?.selectionEnd ?? selectionStart, current.length),
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
  }, [draftControls]);

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
      commitSpeechTranscript(
        {
          textareaRef,
          getDraft: draftControls.getDraft,
          setDraft: draftControls.setDraft,
          setInterimTranscript,
          speechInsertionRangeRef,
          activeSpeechTargetIdRef,
          speechInsertionRangesRef,
          pendingTextareaSelectionRef,
          onSmartTurnSend: handleSubmit,
          composerEditedDuringSpeech: () =>
            composerEditedDuringSpeechRef.current,
        },
        transcript,
        metadata,
      );
      // A completed overlapping (non-active) target's result has landed; forget
      // its range so its tag clears (active target is forgotten on pending->null).
      const committedTargetId = metadata?.speechTargetId;
      if (
        committedTargetId &&
        committedTargetId !== activeSpeechTargetIdRef.current &&
        speechInsertionRangesRef.current.delete(committedTargetId)
      ) {
        setSpeechPreviewRevision((revision) => revision + 1);
      }
    },
    [draftControls, handleSubmit],
  );

  const handleVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      const speechRange = metadata?.speechTargetId
        ? (speechInsertionRangesRef.current.get(metadata.speechTargetId) ?? null)
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
        // Active recording finished: forget its target so the inline tag clears
        // and completed targets don't accumulate (see MessageInput).
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

  // Cancel a pending transcription/finalization from the chip's ✕. The provider
  // discards the in-flight result (keeping committed text); here we drop the
  // pending speech target. Cancel is explicit-click-only so backspace can never
  // trigger it.
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

  const getTranscriptionContext =
    useCallback((): SpeechTranscriptionContext => {
      return {
        draftKey: FAB_DRAFT_KEY,
        speechTargetId: activeSpeechTargetIdRef.current ?? undefined,
      };
    }, []);

  // Hide (but don't unmount) when not visible, on new-session page, or while
  // supervising an active session. On session pages it duplicates the sidebar
  // new-session affordance and competes with the real composer.
  // This preserves expanded state and draft across navigation
  const isSessionPage = /\/sessions\/[^/]+/.test(location.pathname);
  const isHidden =
    !floatingActionButtonEnabled ||
    !fabVisibility ||
    location.pathname.endsWith("/new-session") ||
    isSessionPage;

  const { right, bottom, maxWidth } = fabVisibility ?? {
    right: 24,
    bottom: 80,
    maxWidth: 200,
  };

  return (
    <div
      ref={containerRef}
      className={`fab-container ${isExpanded ? "fab-expanded" : "fab-collapsed"}`}
      style={{
        right: `${right}px`,
        bottom: `${bottom}px`,
        width: `${maxWidth}px`, // Always use maxWidth so button stays centered
        display: isHidden ? "none" : undefined,
      }}
    >
      {/* Input panel appears above the button */}
      {isExpanded && (
        <div className="fab-input-panel">
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
                value={message}
                onChange={(e) => {
                  const nextMessage = e.target.value;
                  clearPendingSpeechFinal();
                  if (speechInsertionRangesRef.current.size > 0) {
                    const nextRanges = new Map<string, SpeechInsertionRange>();
                    for (const [targetId, range] of speechInsertionRangesRef
                      .current) {
                      nextRanges.set(
                        targetId,
                        clearSpeechInsertionRangeReplacement(
                          mapSpeechInsertionRangeThroughEdit(
                            message,
                            nextMessage,
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
                    hasNonWhitespaceEdit(message, nextMessage)
                  ) {
                    composerEditedDuringSpeechRef.current = true;
                  }
                  setMessage(nextMessage);
                }}
                onKeyDown={handleKeyDown}
                onSelect={handleSpeechSelectionTarget}
                onPointerUp={handleSpeechSelectionTarget}
                onKeyUp={handleSpeechSelectionTarget}
                onCut={clearSpeechSelectionTarget}
                onCopy={clearSpeechSelectionTarget}
                onPaste={clearSpeechSelectionTarget}
                placeholder={t("fabPlaceholder")}
                className="fab-textarea"
                rows={3}
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
          <div className="fab-input-toolbar">
            <VoiceInputButton
              ref={voiceButtonRef}
              onTranscript={handleVoiceTranscript}
              onInterimTranscript={handleInterimTranscript}
              onListeningStart={handleListeningStart}
              onListeningStop={handleListeningStop}
              onPendingSpeechChange={handlePendingSpeechChange}
              getTranscriptionContext={getTranscriptionContext}
              className="toolbar-button"
            />
            <button
              type="button"
              className="fab-submit"
              onClick={handleSubmit}
              disabled={!message.trim()}
              aria-label={t("fabGoToNewSession")}
            >
              ↵
            </button>
          </div>
        </div>
      )}
      {/* FAB button always at the bottom */}
      <button
        type="button"
        className={`fab-button ${isExpanded ? "fab-button-active" : ""}`}
        onClick={isExpanded ? () => setIsExpanded(false) : handleButtonClick}
        aria-label={isExpanded ? t("fabClose") : t("fabNewSession")}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={isExpanded ? "fab-icon-rotated" : ""}
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Extract projectId from URL path.
 * Matches: /projects/:projectId, /projects/:projectId/sessions/:sessionId,
 * and relay mode paths like /remote/:username/projects/:projectId
 */
function extractProjectIdFromPath(pathname: string): string | null {
  // Match both direct paths and relay mode paths
  const match = pathname.match(/\/projects\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
