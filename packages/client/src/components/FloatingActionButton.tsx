import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useFabVisibility } from "../hooks/useFabVisibility";
import { setRecentProjectId } from "../hooks/useRecentProject";
import { setNewSessionPrefill } from "../lib/newSessionPrefill";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { VoiceInputButton } from "./VoiceInputButton";

const FAB_DRAFT_KEY = "fab-draft";

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
  const [isExpanded, setIsExpanded] = useState(false);
  const [message, setMessage, draftControls] =
    useDraftPersistence(FAB_DRAFT_KEY);
  const [interimTranscript, setInterimTranscript] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const handleSubmit = useCallback(() => {
    const trimmed = message.trim();
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
  }, [message, projectIdFromUrl, navigate, draftControls, basePath]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.key === "Enter" && e.nativeEvent.isComposing) return;

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        setIsExpanded(false);
      }
      // Shift+Enter naturally adds newline (default behavior)
    },
    [handleSubmit],
  );

  const handleButtonClick = useCallback(() => {
    setIsExpanded(true);
  }, []);

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      const trimmed = message.trimEnd();
      if (trimmed) {
        setMessage(`${trimmed} ${transcript}`);
      } else {
        setMessage(transcript);
      }
      setInterimTranscript("");
    },
    [message, setMessage],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? message + (message.trimEnd() ? " " : "") + interimTranscript
    : message;

  // Hide (but don't unmount) when not visible, on new-session page, or while
  // supervising an active session. On session pages it duplicates the sidebar
  // new-session affordance and competes with the real composer.
  // This preserves expanded state and draft across navigation
  const isSessionPage = /\/sessions\/[^/]+/.test(location.pathname);
  const isHidden =
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
          <textarea
            ref={textareaRef}
            value={displayText}
            onChange={(e) => {
              setInterimTranscript("");
              setMessage(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t("fabPlaceholder")}
            className="fab-textarea"
            rows={3}
          />
          <div className="fab-input-toolbar">
            <VoiceInputButton
              onTranscript={handleVoiceTranscript}
              onInterimTranscript={handleInterimTranscript}
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
