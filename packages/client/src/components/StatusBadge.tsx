import type { AgentActivity } from "../hooks/useFileActivity";
import type { SessionStatus } from "../types";
import { ThinkingIndicator } from "./ThinkingIndicator";

type BadgeVariant = "self" | "external" | "none";
type NotificationVariant = "needs-input" | "unread";
type PendingInputType = "tool-approval" | "user-question";

interface SessionStatusBadgeProps {
  /** Session ownership object */
  status: SessionStatus;
  /** Type of pending input if session needs user action */
  pendingInputType?: PendingInputType;
  /** Whether session has unread content */
  hasUnread?: boolean;
  /** Current agent activity (in-turn/waiting-input) for activity indicators */
  activity?: AgentActivity;
}

interface CountBadgeProps {
  /** Badge variant */
  variant: BadgeVariant;
  /** Count to display (e.g., "2 Active") */
  count: number;
}

interface NotificationBadgeProps {
  /** Type of notification badge */
  variant: NotificationVariant;
  /** Optional label override */
  label?: string;
}

function getCountBadgeStatusClass(
  variant: BadgeVariant,
): "idle" | "owned" | "external" {
  if (variant === "self") return "owned";
  if (variant === "external") return "external";
  return "idle";
}

/**
 * Notification badge indicating action needed or unread content.
 * - "needs-input" (blue): Tool approval or user question pending
 * - "unread" (orange): New content since last viewed
 */
export function NotificationBadge({ variant, label }: NotificationBadgeProps) {
  const defaultLabel = variant === "needs-input" ? "Input Needed" : "New";

  return (
    <span className={`status-badge notification-${variant}`}>
      {label ?? defaultLabel}
    </span>
  );
}

/**
 * Status badge for a single session in a list.
 * Priority: needs-input (blue) > in-turn (pulsing) > unread (orange) > active (outline) > idle (nothing)
 * External sessions always show "External" badge regardless of other state.
 */
export function SessionStatusBadge({
  status,
  pendingInputType,
  activity,
}: SessionStatusBadgeProps) {
  // External sessions always show the external badge
  // We can't track fine-grained state (in-turn, needs input) for external sessions
  if (status.owner === "external") {
    return <span className="status-badge status-external">External</span>;
  }

  // Priority 1: Needs input (tool approval or user question)
  if (pendingInputType) {
    const label =
      pendingInputType === "tool-approval" ? "Approval Needed" : "Question";
    return <NotificationBadge variant="needs-input" label={label} />;
  }

  // Priority 2: In-turn (agent is thinking) - show pulsing indicator
  if (activity === "in-turn") {
    return <ThinkingIndicator variant="pill" />;
  }

  // Unread content is now handled via CSS class on session list item
  // (bold/bright text like Gmail instead of a badge)

  // Active sessions (self-owned) don't need a separate indicator - "Thinking" badge
  // already shows when the process is actively in-turn
  return null;
}

/**
 * Status badge showing a count of active sessions.
 * Used on the projects list page.
 */
export function ActiveCountBadge({ variant, count }: CountBadgeProps) {
  if (count === 0) return null;

  const label =
    variant === "self"
      ? `${count} Active`
      : variant === "external"
        ? `${count} External`
        : null;

  if (!label) return null;

  return (
    <span className={`status-badge status-${getCountBadgeStatusClass(variant)}`}>
      {label}
    </span>
  );
}
