import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { AgentActivity } from "../hooks/useFileActivity";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import { formatBriefAge } from "../lib/sessionAge";
import {
  buildBtwAsideParentHref,
  getBtwAsideSessionDisplayTitle,
  isBtwAsideSessionTitle,
} from "../lib/btwAsideSessions";
import type {
  ContextUsage,
  PendingInputType,
  ProviderName,
  SessionStatus,
} from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ProviderBadge } from "./ProviderBadge";
import { SessionHoverCard } from "./SessionHoverCard";
import { SessionMenu } from "./SessionMenu";
import { SessionShareModal } from "./SessionShareModal";
import { SessionStatusBadge } from "./StatusBadge";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface SessionListItemProps {
  // Core (required)
  sessionId: string;
  projectId: string;
  title: string | null;

  // Optional display data
  fullTitle?: string | null;
  initialPrompt?: string | null;
  /** Capped excerpt of the most recent regular agent turn, for the hover card. */
  lastAgentText?: string | null;
  projectName?: string;
  updatedAt?: string;
  hasUnread?: boolean;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  contextUsage?: ContextUsage;
  status?: SessionStatus;
  provider?: ProviderName;
  /** Last active model, shown as a provider+model badge (card mode / hover). */
  model?: string;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** Parent session when this item is a YA-owned /btw aside. */
  parentSessionId?: string;

  // Feature toggles
  mode: "card" | "compact";
  showProjectName?: boolean;
  showTimestamp?: boolean;
  showContextUsage?: boolean;
  showStatusBadge?: boolean;

  // Custom badge (for Inbox)
  customBadge?: { label: string; className: string } | null;

  // Actions (menu hidden when all undefined)
  isStarred?: boolean;
  isArchived?: boolean;
  onToggleStar?: () => void;
  onToggleArchive?: () => void;
  onToggleRead?: () => void;
  onRename?: () => void;

  // Selection (for All Sessions page)
  isCurrent?: boolean;
  isSelected?: boolean;
  isSelectionMode?: boolean;
  onSelect?: (sessionId: string, selected: boolean) => void;
  onNavigate?: () => void;

  // For sidebar compact mode
  hasDraft?: boolean;

  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;

  /** Number of messages in session (0 indicates brand new session) */
  messageCount?: number;

  /** Creation time for age display in detailed lists (brief d/h/m) */
  createdAt?: string;

  /** Cached user vs system/assistant turn counts (for heavier list views) */
  userTurnCount?: number;
  systemTurnCount?: number;
  /** Whether public share creation controls should be exposed from list menus */
  publicShareControlsVisible?: boolean;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

/**
 * Shared session list item component used by Sidebar (compact), SessionsPage (card),
 * RecentsPage, and InboxContent.
 *
 * Features:
 * - Star indicator, title, draft badge
 * - SessionMenu (star, archive, rename actions) - hidden when no action handlers
 * - Inline rename editing with optimistic updates
 * - Card mode: context usage indicator, full status badge, time display
 * - Compact mode: abbreviated badges (Appr/Q/Running)
 * - Optional checkbox for selection mode
 * - Custom badge support (for Inbox)
 */
export function SessionListItem({
  // Core
  sessionId,
  projectId,
  title,
  // Optional display data
  fullTitle,
  initialPrompt,
  lastAgentText,
  projectName,
  updatedAt,
  hasUnread: hasUnreadProp,
  activity,
  pendingInputType,
  contextUsage,
  status,
  provider,
  model,
  executor,
  parentSessionId,
  // Feature toggles
  mode,
  showProjectName = false,
  showTimestamp = true,
  showContextUsage = true,
  showStatusBadge = true,
  // Custom badge
  customBadge,
  // Actions
  isStarred: isStarredProp,
  isArchived: isArchivedProp,
  onToggleStar,
  onToggleArchive,
  onToggleRead,
  onRename,
  // Selection
  isCurrent = false,
  isSelected = false,
  isSelectionMode = false,
  onSelect,
  onNavigate,
  // Sidebar
  hasDraft = false,
  // Relay mode
  basePath = "",
  // New session detection
  messageCount,
  createdAt,
  userTurnCount,
  systemTurnCount,
  publicShareControlsVisible = false,
}: SessionListItemProps) {
  const { t } = useI18n();
  const navigate = useNavigate();

  // Local state for optimistic updates (only used when action handlers are provided)
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [localTitle, setLocalTitle] = useState<string | undefined>(undefined);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);

  // Replacement tooltip for every list surface (sidebar compact + all-sessions
  // / search cards): a rich hover panel (full first user turn, status line, and
  // the most recent agent turn). The panel (SessionHoverCard) self-positions
  // from this row geometry + cursor x — below the row and right of the cursor,
  // flipping above when it would not fit below.
  const liRef = useRef<HTMLLIElement>(null);
  const [previewPos, setPreviewPos] = useState<{
    rowTop: number;
    rowBottom: number;
    cursorX: number;
  } | null>(null);
  // Idle (non-running) sessions get no live session-updated events, so their
  // recent-activity preview can be stale. On hover we recompute it once on the
  // server (debounced), which pushes a session-updated that refreshes the row
  // in place — no flicker. Owned/external sessions already update live.
  const previewRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const previewRefreshInFlight = useRef(false);

  // Computed values with optimistic fallback
  const isStarred = localIsStarred ?? isStarredProp;
  const isArchived = localIsArchived ?? isArchivedProp;
  // Detect brand new sessions that haven't received a title yet
  // Use messageCount === 0, or if messageCount is unknown but session is actively running
  const isNewSession =
    !localTitle &&
    !title &&
    (messageCount === 0 || (messageCount == null && activity === "in-turn"));
  const displayTitle =
    localTitle ?? title ?? (isNewSession ? "New session" : "Untitled session");
  const isBtwAsideSession =
    !!parentSessionId ||
    isBtwAsideSessionTitle(displayTitle) ||
    isBtwAsideSessionTitle(fullTitle);
  const visibleTitle = isBtwAsideSession
    ? getBtwAsideSessionDisplayTitle(displayTitle)
    : displayTitle;
  const copyPromptText = (initialPrompt ?? fullTitle ?? "").trim();

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    }
  }, [isEditing]);

  // Local state for optimistic unread toggle
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>(
    undefined,
  );
  const hasUnread = localHasUnread ?? hasUnreadProp;

  // Handlers for menu actions
  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    setLocalIsStarred(newStarred);
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      onToggleStar?.();
    } catch (err) {
      console.error("Failed to update star status:", err);
      setLocalIsStarred(undefined); // Revert on error
    }
  };

  const handleToggleArchive = async () => {
    const newArchived = !isArchived;
    setLocalIsArchived(newArchived);
    try {
      await api.updateSessionMetadata(sessionId, { archived: newArchived });
      onToggleArchive?.();
    } catch (err) {
      console.error("Failed to update archive status:", err);
      setLocalIsArchived(undefined); // Revert on error
    }
  };

  const handleToggleRead = async () => {
    const newHasUnread = !hasUnread;
    setLocalHasUnread(newHasUnread);
    try {
      if (newHasUnread) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      onToggleRead?.();
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined); // Revert on error
    }
  };

  const handleCopyPrompt = useCallback(() => {
    if (!copyPromptText) return;
    void copyTextToClipboard(copyPromptText).catch((err) => {
      console.error("Failed to copy initial prompt:", err);
    });
  }, [copyPromptText]);

  const handleCancelEditing = () => {
    if (isSavingRef.current) return;
    setIsEditing(false);
    setRenameValue("");
  };

  const handleSaveRename = async () => {
    if (!renameValue.trim() || isSaving) return;
    if (renameValue.trim() === displayTitle) {
      handleCancelEditing();
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      await api.updateSessionMetadata(sessionId, {
        title: renameValue.trim(),
      });
      setLocalTitle(renameValue.trim());
      setIsEditing(false);
      onRename?.();
    } catch (err) {
      console.error("Failed to rename session:", err);
    } finally {
      setIsSaving(false);
      isSavingRef.current = false;
    }
  };

  const handleRenameBlur = () => {
    if (isSavingRef.current) return;
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditing();
      return;
    }
    handleSaveRename();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEditing();
    }
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onSelect?.(sessionId, e.target.checked);
  };

  // Activity indicator for compact mode
  const getCompactActivityIndicator = () => {
    // External sessions always show external badge
    if (status?.owner === "external") {
      return <span className="session-badge session-badge-external">Ext</span>;
    }

    // Priority 1: Needs input
    if (pendingInputType) {
      const label = pendingInputType === "tool-approval" ? "Appr" : "Q";
      return (
        <span className="session-badge session-badge-needs-input">{label}</span>
      );
    }

    // Priority 2: In-turn (thinking)
    if (activity === "in-turn") {
      return <ThinkingIndicator />;
    }

    return null;
  };

  // Format relative time for card mode
  const formatRelativeTime = (timestamp: string): string => {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  // Brief age since creation for detailed (card) lists and the compact hover
  // card. `formatBriefAge` returns null for unknown/default (epoch) timestamps,
  // so a missing creation time renders nothing rather than "Created 20625d ago".
  const briefAge = formatBriefAge(createdAt);

  // Hover tooltip age shows both: time since last activity (primary) with the
  // creation time as an "established" aside — "5m ago (est. 2d)". Either half
  // drops out when its timestamp is unknown/default.
  const hoverActivityAge = formatBriefAge(updatedAt);
  const hoverAgeLabel = hoverActivityAge
    ? `${hoverActivityAge} ago${briefAge ? ` (est. ${briefAge})` : ""}`
    : briefAge
      ? `est. ${briefAge}`
      : null;

  // Hover card fires on every list surface (sidebar compact + all-sessions /
  // search cards); it only needs a provider to badge.
  const showHoverCard = !!provider;

  // The full first user turn (body) and the most recent agent turn (reply)
  // shown in the replacement tooltip.
  const hoverPrompt = (initialPrompt || fullTitle || displayTitle || "").trim();
  const hoverLastAgent = lastAgentText?.trim() || undefined;

  // Recompute an idle session's stale preview once on the server; the result
  // arrives via the session-updated activity event (not this call), updating
  // the row in place. Owned/external sessions are tracked live, so skip them.
  const refreshIdlePreview = useCallback(() => {
    if (status?.owner === "self" || status?.owner === "external") return;
    // Already have the excerpt — nothing to refresh. (Crucially this re-fires
    // after a list refetch clears it, unlike a sticky once-per-session guard,
    // which left re-hover blocked while only click repopulated.)
    if (hoverLastAgent) return;
    if (previewRefreshInFlight.current) return; // dedup concurrent hovers
    previewRefreshInFlight.current = true;
    void api.refreshSessionPreview(projectId, sessionId).finally(() => {
      previewRefreshInFlight.current = false;
    });
  }, [status?.owner, projectId, sessionId, hoverLastAgent]);

  const handlePreviewEnter = useCallback(
    (e: React.MouseEvent) => {
      if (!showHoverCard) return;
      const rect = liRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPreviewPos({
        rowTop: rect.top,
        rowBottom: rect.bottom,
        cursorX: e.clientX,
      });
      // Debounced so a quick sweep across rows does not fire a refresh per row.
      if (previewRefreshTimer.current) clearTimeout(previewRefreshTimer.current);
      previewRefreshTimer.current = setTimeout(refreshIdlePreview, 200);
    },
    [showHoverCard, refreshIdlePreview],
  );

  const handlePreviewLeave = useCallback(() => {
    setPreviewPos(null);
    if (previewRefreshTimer.current) {
      clearTimeout(previewRefreshTimer.current);
      previewRefreshTimer.current = null;
    }
  }, []);

  // Clear the debounce timer if the row unmounts mid-hover.
  useEffect(() => {
    return () => {
      if (previewRefreshTimer.current) {
        clearTimeout(previewRefreshTimer.current);
      }
    };
  }, []);

  // A fixed card would drift if the sidebar scrolls under it; clear on any
  // scroll/resize while shown rather than tracking the moving anchor.
  useEffect(() => {
    if (!previewPos) return;
    const clear = () => setPreviewPos(null);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [previewPos]);

  // Build CSS classes
  const liClasses = [
    "session-list-item",
    mode === "card" ? "session-list-item--card" : "session-list-item--compact",
    isCurrent && "current",
    hasUnread && "unread",
    isBtwAsideSession && "btw-aside-session",
    isSelected && "selected",
    isArchived && "archived",
  ]
    .filter(Boolean)
    .join(" ");

  const sessionHref = `${basePath}/projects/${projectId}/sessions/${sessionId}`;
  const parentHref =
    parentSessionId && isBtwAsideSession
      ? buildBtwAsideParentHref(basePath, projectId, parentSessionId, sessionId)
      : null;

  const handleBtwBadgeClick = useCallback(
    (e: React.MouseEvent<HTMLSpanElement>) => {
      if (!parentHref) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        window.open(toBrowserAppHref(parentHref), "_blank", "noopener");
        return;
      }
      navigate(parentHref);
      onNavigate?.();
    },
    [navigate, onNavigate, parentHref],
  );

  const handleBtwBadgeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLSpanElement>) => {
      if (!parentHref || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopPropagation();
      navigate(parentHref);
      onNavigate?.();
    },
    [navigate, onNavigate, parentHref],
  );

  const handleSessionClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (isSelectionMode) {
        e.preventDefault();
        onNavigate?.();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        window.open(toBrowserAppHref(sessionHref), "_blank", "noopener");
        return;
      }

      if (e.altKey) {
        return;
      }

      onNavigate?.();
    },
    [isSelectionMode, onNavigate, sessionHref],
  );

  const handleSessionMouseDown = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    },
    [],
  );

  const handleSessionAuxClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(toBrowserAppHref(sessionHref), "_blank", "noopener");
    },
    [sessionHref],
  );

  // Star icon SVG
  const StarIcon = ({
    filled,
    size = 10,
  }: {
    filled: boolean;
    size?: number;
  }) => (
    <svg
      className="session-star-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );

  return (
    <li
      ref={liRef}
      className={liClasses}
      onMouseEnter={showHoverCard ? handlePreviewEnter : undefined}
      onMouseLeave={showHoverCard ? handlePreviewLeave : undefined}
    >
      {/* Checkbox for multi-select (only shown when onSelect is provided) */}
      {onSelect && (
        <input
          type="checkbox"
          className="session-list-item__checkbox"
          checked={isSelected}
          onChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${displayTitle}`}
        />
      )}

      {isEditing ? (
        <input
          ref={renameInputRef}
          type="text"
          className="session-rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameBlur}
          onKeyDown={handleRenameKeyDown}
          disabled={isSaving}
        />
      ) : (
        <Link
          to={sessionHref}
          onClick={handleSessionClick}
          onMouseDown={handleSessionMouseDown}
          onAuxClick={handleSessionAuxClick}
          title={
            showHoverCard ? undefined : fullTitle || displayTitle
          }
          className="session-list-item__link"
        >
          {mode === "card" ? (
            // Card mode: title on one line, meta on second line
            <>
              <strong className="session-list-item__title">
                {isStarred && <StarIcon filled size={12} />}
                {isNewSession && <ThinkingIndicator />}
                {isBtwAsideSession && (
                  // biome-ignore lint/a11y/noStaticElementInteractions: clickable variant has link role and keyboard handling; inert variant only shows the badge
                  <span
                    className="session-badge session-badge-btw"
                    title={
                      parentHref
                        ? "Open parent session with this /btw aside visible"
                        : "/btw aside session"
                    }
                    role={parentHref ? "link" : undefined}
                    tabIndex={parentHref ? 0 : undefined}
                    onClick={handleBtwBadgeClick}
                    onKeyDown={handleBtwBadgeKeyDown}
                  >
                    /btw
                  </span>
                )}
                {visibleTitle}
                {hasDraft && <span className="session-draft-badge">Draft</span>}
                {isArchived && (
                  <span className="session-archived-badge">Archived</span>
                )}
              </strong>
              <span className="session-list-item__meta">
                {provider && (
                  <ProviderBadge
                    provider={provider}
                    model={model}
                    className="session-list-item__provider-badge"
                  />
                )}
                {showProjectName && projectName && (
                  <span className="session-list-item__project">
                    {projectName}
                  </span>
                )}
                {showTimestamp && updatedAt && formatRelativeTime(updatedAt)}
                {briefAge && (
                  <span
                    className="session-list-item__age"
                    title={t("sessionListAgeTitle")}
                  >
                    Created {briefAge} ago
                  </span>
                )}
                {(userTurnCount != null || systemTurnCount != null) && (
                  <span
                    className="session-list-item__turns"
                    title="User / system (assistant) turns (cached)"
                  >
                    U:{userTurnCount ?? 0} S:{systemTurnCount ?? 0}
                  </span>
                )}
                {executor && (
                  <span
                    className="session-badge session-badge-executor"
                    title={`Running on ${executor}`}
                  >
                    {executor}
                  </span>
                )}
                {showContextUsage && (
                  <ContextUsageIndicator usage={contextUsage} size={14} />
                )}
                {customBadge && (
                  <span className={`inbox-item-badge ${customBadge.className}`}>
                    {customBadge.label}
                  </span>
                )}
                {showStatusBadge && status && (
                  <SessionStatusBadge
                    status={status}
                    pendingInputType={pendingInputType}
                    hasUnread={hasUnread}
                    activity={activity}
                  />
                )}
              </span>
            </>
          ) : (
            // Compact mode: single line with badges
            <>
              <span className="session-list-item__title-row">
                {isStarred && <StarIcon filled />}
                <span className="session-list-item__title-text">
                  {isNewSession && <ThinkingIndicator />}
                  {isBtwAsideSession && (
                    // biome-ignore lint/a11y/noStaticElementInteractions: clickable variant has link role and keyboard handling; inert variant only shows the badge
                    <span
                      className="session-badge session-badge-btw"
                      title={
                        parentHref
                          ? "Open parent session with this /btw aside visible"
                          : "/btw aside session"
                      }
                      role={parentHref ? "link" : undefined}
                      tabIndex={parentHref ? 0 : undefined}
                      onClick={handleBtwBadgeClick}
                      onKeyDown={handleBtwBadgeKeyDown}
                    >
                      /btw
                    </span>
                  )}
                  {visibleTitle}
                </span>
                {hasDraft && <span className="session-draft-badge">Draft</span>}
              </span>
              {showProjectName && projectName && (
                <span className="session-list-item__project-compact">
                  {projectName}
                </span>
              )}
              {getCompactActivityIndicator()}
            </>
          )}
        </Link>
      )}

      {/* Only show menu when provider is available (required for clone) */}
      {provider && (
        <SessionMenu
          sessionId={sessionId}
          projectId={projectId}
          isStarred={isStarred ?? false}
          isArchived={isArchived ?? false}
          hasUnread={hasUnread ?? false}
          provider={provider}
          onToggleStar={handleToggleStar}
          onToggleArchive={handleToggleArchive}
          onToggleRead={handleToggleRead}
          onRename={() => {
            setRenameValue(displayTitle);
            setIsEditing(true);
          }}
          onCopyPrompt={copyPromptText ? handleCopyPrompt : undefined}
          onShare={
            publicShareControlsVisible
              ? () => setShowShareModal(true)
              : undefined
          }
          useEllipsisIcon
          useFixedPositioning
          className="session-list-item__menu"
        />
      )}

      {showShareModal && (
        <SessionShareModal
          projectId={projectId}
          sessionId={sessionId}
          title={displayTitle}
          canCreateShares={publicShareControlsVisible}
          onClose={() => setShowShareModal(false)}
        />
      )}

      {showHoverCard && provider && previewPos && (
        <SessionHoverCard
          anchor={previewPos}
          prompt={hoverPrompt}
          lastAgentText={hoverLastAgent}
          provider={provider}
          model={model}
          projectName={projectName}
          ageLabel={hoverAgeLabel}
          status={status}
          pendingInputType={pendingInputType}
          hasUnread={hasUnread}
          activity={activity}
        />
      )}
    </li>
  );
}
