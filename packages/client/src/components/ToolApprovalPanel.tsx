import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToolApprovalFeedbackDraft } from "../hooks/useDrafts";
import { useI18n } from "../i18n";
import {
  makeSecurityVisibleText,
  makeSecurityVisibleValue,
} from "../lib/securityVisibleText";
import type { InputRequest } from "../types";
import { toolRegistry } from "./renderers/tools";
import type { RenderContext } from "./renderers/types";
import { getToolSummary } from "./tools/summaries";
import { Modal } from "./ui/Modal";

// Tools that can be auto-approved with "accept edits" mode
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

// Check if this is an ExitPlanMode approval (needs custom UI)
const isExitPlanMode = (toolName: string | undefined) =>
  toolName === "ExitPlanMode";

interface Props {
  request: InputRequest;
  sessionId: string;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
  onApproveAcceptEdits?: () => Promise<void>;
  onDenyWithFeedback?: (feedback: string) => Promise<void>;
  /** Whether the panel is collapsed (controlled externally) */
  collapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
}

// Delay before buttons become clickable to prevent accidental clicks
const CLICK_PROTECTION_MS = 150;

export function ToolApprovalPanel({
  request,
  sessionId,
  onApprove,
  onDeny,
  onApproveAcceptEdits,
  onDenyWithFeedback,
  collapsed = false,
  onCollapsedChange,
}: Props) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  // Prevent accidental clicks by disabling buttons briefly when panel appears
  const [armed, setArmed] = useState(false);
  // Show feedback panel if there's already draft text from localStorage
  const [feedback, setFeedback, clearFeedback] =
    useToolApprovalFeedbackDraft(sessionId);
  const [showFeedback, setShowFeedback] = useState(() => feedback.length > 0);
  const feedbackInputRef = useRef<HTMLInputElement>(null);

  // Reset armed state when request changes (new approval appears)
  // biome-ignore lint/correctness/useExhaustiveDependencies: request.id triggers reset on new request
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), CLICK_PROTECTION_MS);
    return () => clearTimeout(timer);
  }, [request.id]);

  const isEditTool = request.toolName && EDIT_TOOLS.includes(request.toolName);

  const handleApprove = useCallback(async () => {
    setSubmitting(true);
    try {
      await onApprove();
    } finally {
      setSubmitting(false);
    }
  }, [onApprove]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (!onApproveAcceptEdits) return;
    setSubmitting(true);
    try {
      await onApproveAcceptEdits();
    } finally {
      setSubmitting(false);
    }
  }, [onApproveAcceptEdits]);

  const handleDeny = useCallback(async () => {
    setSubmitting(true);
    try {
      await onDeny();
    } finally {
      setSubmitting(false);
    }
  }, [onDeny]);

  const handleDenyWithFeedback = useCallback(async () => {
    if (!onDenyWithFeedback || !feedback.trim()) return;
    setSubmitting(true);
    try {
      await onDenyWithFeedback(feedback.trim());
      // Clear feedback draft from localStorage on successful submit
      clearFeedback();
      setShowFeedback(false);
    } finally {
      setSubmitting(false);
    }
  }, [onDenyWithFeedback, feedback, clearFeedback]);

  // Focus feedback input when shown
  useEffect(() => {
    if (showFeedback && feedbackInputRef.current) {
      feedbackInputRef.current.focus();
    }
  }, [showFeedback]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (submitting || !armed) return;

      // Don't handle shortcuts when typing in feedback
      if (showFeedback) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowFeedback(false);
          clearFeedback();
        } else if (e.key === "Enter" && feedback.trim()) {
          e.preventDefault();
          handleDenyWithFeedback();
        }
        return;
      }

      const isPlanMode = isExitPlanMode(request.toolName);

      if (isPlanMode) {
        // ExitPlanMode: 1=auto-accept, 2=manual, 3=deny
        if (e.key === "1" && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (e.key === "2") {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "3") {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        }
      } else {
        // Standard tool approval: 1=yes, 2=yes+auto (edit tools), 2/3=no
        if (e.key === "1") {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "2" && isEditTool && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (
          e.key === "3" ||
          (e.key === "2" && (!isEditTool || !onApproveAcceptEdits))
        ) {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleApprove,
    handleApproveAcceptEdits,
    handleDeny,
    handleDenyWithFeedback,
    submitting,
    armed,
    showFeedback,
    feedback,
    clearFeedback,
    isEditTool,
    onApproveAcceptEdits,
    request.toolName,
  ]);

  const displayToolInput = useMemo(
    () => makeSecurityVisibleValue(request.toolInput),
    [request.toolInput],
  );
  const displayToolName = request.toolName
    ? makeSecurityVisibleText(request.toolName)
    : undefined;
  const summary = request.toolName
    ? getToolSummary(request.toolName, displayToolInput, undefined, "pending")
    : request.prompt;
  const displaySummary = summary ? makeSecurityVisibleText(summary) : summary;

  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Only show "View details" when the approval summary text itself is too
  // long to display inline. The full tool details (diffs, etc.) are already
  // visible in the session stream above.
  const summaryText = `Allow ${displayToolName ?? ""} ${displaySummary ?? ""}?`;
  const showViewDetails = summaryText.length > 120;

  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: true,
      theme: "dark",
      toolUseId: request.id,
    }),
    [request.id],
  );

  return (
    <div className="tool-approval-wrapper">
      {/* Floating toggle button */}
      <button
        type="button"
        className={`tool-approval-toggle ${collapsed ? "has-pending" : ""}`}
        onClick={() => onCollapsedChange?.(!collapsed)}
        aria-label={
          collapsed ? t("toolApprovalExpand") : t("toolApprovalCollapse")
        }
        aria-expanded={!collapsed}
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
          className={collapsed ? "chevron-up" : "chevron-down"}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {!collapsed && (
        <div className="tool-approval-panel">
          <div className="tool-approval-header">
            {isExitPlanMode(request.toolName) ? (
              <>
                <span className="tool-approval-title">
                  {t("toolApprovalPlanTitle")}
                </span>
                <span className="tool-approval-subtitle">
                  {t("toolApprovalPlanSubtitle")}
                </span>
              </>
            ) : (
              <>
                <div className="tool-approval-question-row">
                  <span className="tool-approval-question">
                    {t("toolApprovalAllow", {
                      tool: displayToolName ?? "",
                      summary: displaySummary ?? "",
                    })}
                  </span>
                  {showViewDetails && (
                    <button
                      type="button"
                      className="tool-approval-view-details"
                      onClick={() => setShowPreviewModal(true)}
                    >
                      {t("toolApprovalViewDetails")}
                    </button>
                  )}
                </div>
                {showPreviewModal && request.toolName && (
                  <Modal
                    title={t("toolApprovalDetailsTitle", {
                      tool: displayToolName ?? request.toolName,
                    })}
                    onClose={() => setShowPreviewModal(false)}
                  >
                    <div className="tool-use-expanded">
                      {toolRegistry.renderToolUse(
                        request.toolName,
                        displayToolInput,
                        renderContext,
                      )}
                    </div>
                  </Modal>
                )}
              </>
            )}
          </div>

          <div className="tool-approval-options">
            {isExitPlanMode(request.toolName) ? (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApproveAcceptEdits}
                  disabled={!armed || submitting || !onApproveAcceptEdits}
                >
                  <kbd>1</kbd>
                  <span>{t("toolApprovalYesAuto")}</span>
                </button>
                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd>2</kbd>
                  <span>{t("toolApprovalYesManual")}</span>
                </button>
                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd>3</kbd>
                  <span>{t("toolApprovalNoKeepPlanning")}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd>1</kbd>
                  <span>{t("toolApprovalYes")}</span>
                </button>

                {isEditTool && onApproveAcceptEdits && (
                  <button
                    type="button"
                    className="tool-approval-option"
                    onClick={handleApproveAcceptEdits}
                    disabled={!armed || submitting}
                  >
                    <kbd>2</kbd>
                    <span>{t("toolApprovalYesDontAsk")}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd>{isEditTool && onApproveAcceptEdits ? "3" : "2"}</kbd>
                  <span>{t("toolApprovalNo")}</span>
                </button>
              </>
            )}

            {onDenyWithFeedback && !showFeedback && (
              <button
                type="button"
                className="tool-approval-option feedback-toggle"
                onClick={() => setShowFeedback(true)}
                disabled={!armed || submitting}
              >
                <span>{t("toolApprovalTellInstead")}</span>
              </button>
            )}

            {onDenyWithFeedback && showFeedback && (
              <div className="tool-approval-feedback">
                <input
                  ref={feedbackInputRef}
                  type="text"
                  placeholder={t("toolApprovalFeedbackPlaceholder")}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  disabled={!armed || submitting}
                  className="tool-approval-feedback-input"
                />
                <button
                  type="button"
                  className="tool-approval-feedback-submit"
                  onClick={handleDenyWithFeedback}
                  disabled={!armed || submitting || !feedback.trim()}
                >
                  {t("toolApprovalSend")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
