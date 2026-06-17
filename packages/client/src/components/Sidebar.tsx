import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import { useInboxContext } from "../contexts/InboxContext";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useDrafts, useNewSessionDraft } from "../hooks/useDrafts";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../hooks/useSidebarWidth";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import { isNearScrollEnd } from "../lib/predictiveScroll";
import { UI_KEYS } from "../lib/storageKeys";
import { getSessionDisplayTitle } from "../utils";
import { AgentsNavItem } from "./AgentsNavItem";
import { SessionListItem } from "./SessionListItem";
import {
  SidebarIcons,
  SidebarNavButton,
  SidebarNavItem,
  SidebarNavSection,
} from "./SidebarNavItem";
import { YepAnywhereLogo } from "./YepAnywhereLogo";

const SWIPE_THRESHOLD = 50; // Minimum distance to trigger close
const SWIPE_ENGAGE_THRESHOLD = 15; // Minimum horizontal distance before swipe engages
const SIDEBAR_SESSION_PAGE_SIZE = 50;

const DEFAULT_SECTION_EXPANSION = {
  starred: true,
  recentDay: true,
  older: true,
};

/**
 * A session is "active" while its agent is mid-turn or waiting on input. Active
 * sessions are pinned above idle rows and are deliberately never sorted or
 * deduped: their updatedAt churns every few seconds during a turn, so any
 * recency sort would reshuffle them constantly. They instead ride the stable
 * order that useGlobalSessions already preserves across refetches.
 */
function isActiveSession(session: GlobalSessionItem): boolean {
  return (
    session.activity === "in-turn" || session.activity === "waiting-input"
  );
}

type SidebarSectionKey = keyof typeof DEFAULT_SECTION_EXPANSION;
type SidebarSectionExpansion = Record<SidebarSectionKey, boolean>;

function getLocalStorage(): Storage | null {
  return typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : null;
}

function loadSidebarSectionExpansion(): SidebarSectionExpansion {
  const storage = getLocalStorage();
  if (!storage) {
    return DEFAULT_SECTION_EXPANSION;
  }

  try {
    const raw = storage.getItem(UI_KEYS.sidebarSectionExpansion);
    if (!raw) {
      return DEFAULT_SECTION_EXPANSION;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_SECTION_EXPANSION;
    }
    const value = parsed as Partial<Record<SidebarSectionKey, unknown>>;
    return {
      starred:
        typeof value.starred === "boolean"
          ? value.starred
          : DEFAULT_SECTION_EXPANSION.starred,
      recentDay:
        typeof value.recentDay === "boolean"
          ? value.recentDay
          : DEFAULT_SECTION_EXPANSION.recentDay,
      older:
        typeof value.older === "boolean"
          ? value.older
          : DEFAULT_SECTION_EXPANSION.older,
    };
  } catch {
    return DEFAULT_SECTION_EXPANSION;
  }
}

function saveSidebarSectionExpansion(expansion: SidebarSectionExpansion): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(UI_KEYS.sidebarSectionExpansion, JSON.stringify(expansion));
  } catch {
    // localStorage is a UI convenience; in-memory state still applies.
  }
}

interface SidebarSectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
  expandLabel: string;
  collapseLabel: string;
}

function SidebarSectionHeader({
  title,
  expanded,
  onToggle,
  controlsId,
  expandLabel,
  collapseLabel,
}: SidebarSectionHeaderProps) {
  const actionLabel = expanded ? collapseLabel : expandLabel;

  return (
    <div className="sidebar-section-header">
      <h3 className="sidebar-section-title">{title}</h3>
      <button
        type="button"
        className="sidebar-section-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={controlsId}
        aria-label={`${actionLabel}: ${title}`}
        title={`${actionLabel}: ${title}`}
      >
        {expanded ? "-" : "+"}
      </button>
    </div>
  );
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: () => void;

  /** Current session ID (for highlighting in sidebar) */
  currentSessionId?: string;

  /** Desktop mode: sidebar is always visible, no overlay */
  isDesktop?: boolean;
  /** Desktop mode: sidebar is collapsed (icons only) */
  isCollapsed?: boolean;
  /** Desktop mode: callback to toggle expanded/collapsed state */
  onToggleExpanded?: () => void;
  /** Desktop mode: current sidebar width in pixels */
  sidebarWidth?: number;
  /** Desktop mode: called when resize starts */
  onResizeStart?: () => void;
  /** Desktop mode: called during resize with new width */
  onResize?: (width: number) => void;
  /** Desktop mode: called when resize ends */
  onResizeEnd?: () => void;
}

export function Sidebar({
  isOpen,
  onClose,
  onNavigate,
  currentSessionId,
  // Desktop mode props
  isDesktop = false,
  isCollapsed = false,
  onToggleExpanded,
  sidebarWidth,
  onResizeStart,
  onResize,
  onResizeEnd,
}: SidebarProps) {
  const { t } = useI18n();
  // Get base path for relay mode (e.g., "/remote/my-server")
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  const remoteConnection = useOptionalRemoteConnection();
  const { settings: serverSettings } = useServerSettings();
  const publicSharesEnabled = serverSettings?.publicSharesEnabled ?? false;
  const { status: publicShareStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });
  const publicShareControlsVisible = publicShareStatus?.canCreate ?? false;

  // Fetch global sessions for sidebar (non-starred only for recent/older sections)
  const {
    sessions: globalSessions,
    loading: globalLoading,
    hasMore: hasMoreGlobalSessions,
    loadMore: loadMoreGlobalSessions,
  } = useGlobalSessions({
    limit: SIDEBAR_SESSION_PAGE_SIZE,
    includeStats: false,
  });

  // Fetch starred sessions separately to ensure we get ALL starred sessions
  const {
    sessions: starredSessions,
    loading: starredLoading,
    hasMore: hasMoreStarredSessions,
    loadMore: loadMoreStarredSessions,
  } = useGlobalSessions({
    starred: true,
    limit: SIDEBAR_SESSION_PAGE_SIZE,
    includeStats: false,
  });

  const sessionsLoading = globalLoading || starredLoading;
  const hasNewSessionDraft = useNewSessionDraft();

  // Server capabilities for feature gating
  const { version: versionInfo } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];

  // Global inbox count. Title badge updates are owned by the app shell.
  const { totalNeedsAttention: inboxCount } = useInboxContext();
  const newSessionPath = "/new-session";
  const newSessionHref = `${basePath}${newSessionPath}`;
  const expandedSidebarNewSessionHref = toBrowserAppHref(
    `${newSessionHref}${newSessionHref.includes("?") ? "&" : "?"}sidebar=expanded`,
  );

  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarSessionsRef = useRef<HTMLDivElement | null>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swipeEngaged = useRef<boolean>(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef<number | null>(null);
  const resizeStartWidth = useRef<number | null>(null);
  const [sectionExpansion, setSectionExpansion] = useState(
    loadSidebarSectionExpansion,
  );
  const starredExpanded = sectionExpansion.starred;
  const recentDayExpanded = sectionExpansion.recentDay;
  const olderExpanded = sectionExpansion.older;
  const loadingMoreGlobalSessionsRef = useRef(false);
  const loadingMoreStarredSessionsRef = useRef(false);

  const setSidebarSectionExpanded = useCallback(
    (
      section: SidebarSectionKey,
      update: boolean | ((current: boolean) => boolean),
    ) => {
      setSectionExpansion((current) => {
        const nextValue =
          typeof update === "function" ? update(current[section]) : update;
        const next = { ...current, [section]: nextValue };
        saveSidebarSectionExpansion(next);
        return next;
      });
    },
    [],
  );

  const maybeLoadMoreGlobalSessions = useCallback(async () => {
    if (!hasMoreGlobalSessions || loadingMoreGlobalSessionsRef.current) {
      return;
    }
    loadingMoreGlobalSessionsRef.current = true;
    try {
      await loadMoreGlobalSessions();
    } finally {
      loadingMoreGlobalSessionsRef.current = false;
    }
  }, [hasMoreGlobalSessions, loadMoreGlobalSessions]);

  const maybeLoadMoreStarredSessions = useCallback(async () => {
    if (!hasMoreStarredSessions || loadingMoreStarredSessionsRef.current) {
      return;
    }
    loadingMoreStarredSessionsRef.current = true;
    try {
      await loadMoreStarredSessions();
    } finally {
      loadingMoreStarredSessionsRef.current = false;
    }
  }, [hasMoreStarredSessions, loadMoreStarredSessions]);

  const maybeLoadMoreSidebarSessions = useCallback(() => {
    const element = sidebarSessionsRef.current;
    if (!element || !isNearScrollEnd(element)) {
      return;
    }
    void maybeLoadMoreGlobalSessions();
    void maybeLoadMoreStarredSessions();
  }, [maybeLoadMoreGlobalSessions, maybeLoadMoreStarredSessions]);

  useEffect(() => {
    maybeLoadMoreSidebarSessions();
  }, [
    maybeLoadMoreSidebarSessions,
    starredSessions.length,
    globalSessions.length,
    starredExpanded,
    recentDayExpanded,
    olderExpanded,
  ]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchStartY.current = e.touches[0]?.clientY ?? null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const currentX = e.touches[0]?.clientX;
    const currentY = e.touches[0]?.clientY;
    if (currentX === undefined || currentY === undefined) return;

    const diffX = currentX - touchStartX.current;
    const diffY = currentY - touchStartY.current;

    // If not yet engaged, check if we should engage the swipe
    if (!swipeEngaged.current) {
      const absDiffX = Math.abs(diffX);
      const absDiffY = Math.abs(diffY);

      // Engage swipe only if:
      // 1. Horizontal movement exceeds threshold
      // 2. Horizontal movement is greater than vertical (user is swiping, not scrolling)
      // 3. Movement is to the left (closing gesture)
      if (
        absDiffX > SWIPE_ENGAGE_THRESHOLD &&
        absDiffX > absDiffY &&
        diffX < 0
      ) {
        swipeEngaged.current = true;
      } else {
        return; // Not engaged yet, don't track offset
      }
    }

    // Only allow swiping left (negative offset)
    if (diffX < 0) {
      setSwipeOffset(diffX);
    }
  };

  const handleTouchEnd = () => {
    if (swipeEngaged.current && swipeOffset < -SWIPE_THRESHOLD) {
      onClose();
    }
    touchStartX.current = null;
    touchStartY.current = null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  // Desktop sidebar resize handlers
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    if (!isDesktop || isCollapsed || !sidebarWidth) return;
    e.preventDefault();
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
    setIsResizing(true);
    onResizeStart?.();
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (resizeStartX.current === null || resizeStartWidth.current === null)
        return;
      const diff = e.clientX - resizeStartX.current;
      const newWidth = resizeStartWidth.current + diff;
      onResize?.(newWidth);
    };

    const handleMouseUp = () => {
      resizeStartX.current = null;
      resizeStartWidth.current = null;
      setIsResizing(false);
      onResizeEnd?.();
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onResize, onResizeEnd]);

  // Handle switching hosts - disconnect and go to host picker
  const handleSwitchHost = () => {
    remoteConnection?.disconnect();
    navigate("/login");
    onNavigate();
  };

  const handleCollapsedToggleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        window.open(expandedSidebarNewSessionHref, "_blank", "noopener");
        return;
      }

      onToggleExpanded?.();
    },
    [expandedSidebarNewSessionHref, onToggleExpanded],
  );

  const handleCollapsedToggleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    },
    [],
  );

  const handleCollapsedToggleAuxClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(expandedSidebarNewSessionHref, "_blank", "noopener");
    },
    [expandedSidebarNewSessionHref],
  );

  // Starred sessions come from dedicated fetch (filtered by server)
  // Filter out archived just in case
  const filteredStarredSessions = useMemo(() => {
    return starredSessions.filter((s) => !s.isArchived);
  }, [starredSessions]);

  // Sessions updated in the last 24 hours (non-starred, non-archived)
  const recentDaySessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isWithinLastDay = (date: Date) => date.getTime() >= oneDayAgo;

    return globalSessions.filter(
      (s) =>
        !s.isStarred && !s.isArchived && isWithinLastDay(new Date(s.updatedAt)),
    );
  }, [globalSessions]);

  // Older sessions (non-starred, non-archived, NOT in last 24 hours)
  const olderSessions = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isOlderThanOneDay = (date: Date) => date.getTime() < oneDayAgo;

    return globalSessions.filter(
      (s) =>
        !s.isStarred &&
        !s.isArchived &&
        isOlderThanOneDay(new Date(s.updatedAt)),
    );
  }, [globalSessions]);

  // Client-side heuristic for "obvious duplicate title" sessions (general, no hardcoded strings).
  // Within each section we group by (provider, project, normalized title).
  // In a dup cluster, we keep the *best* one visible (prefer higher messageCount, then more recent activity)
  // and hide the rest behind a "(N hidden)" expander. This avoids hiding the substantive version of a
  // repeated title while still decluttering obvious resume/handoff/research dups of the same name.
  const [showHiddenRecent, setShowHiddenRecent] = useState(false);
  const [showHiddenOlder, setShowHiddenOlder] = useState(false);

  const groupDuplicateSessions = useCallback(
    (sessions: GlobalSessionItem[]) => {
      const groups = new Map<string, GlobalSessionItem[]>();
      for (const s of sessions) {
        const normTitle = (s.title || s.fullTitle || s.initialPrompt || "")
          .trim()
          .toLowerCase()
          .slice(0, 120);
        const key = `${s.provider || "unknown"}|${s.projectId}|${normTitle}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)?.push(s);
      }

      const visible: GlobalSessionItem[] = [];
      const hidden: GlobalSessionItem[] = [];
      for (const arr of groups.values()) {
        if (arr.length === 1) {
          const only = arr[0];
          if (only) visible.push(only);
        } else {
          // Keep the best: highest messageCount wins (do not hide the one with more work).
          // On tie (or no counts), prefer the one with more recent activity.
          arr.sort((a, b) => {
            const mcA = a.messageCount || 0;
            const mcB = b.messageCount || 0;
            if (mcB !== mcA) return mcB - mcA;
            return (
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
            );
          });
          const selected = arr[0];
          if (!selected) continue;
          visible.push(selected);
          hidden.push(...arr.slice(1));
        }
      }

      visible.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      hidden.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      return { visible, hidden };
    },
    [],
  );

  // Active sessions are pinned above idle rows and never deduped or sorted —
  // see isActiveSession. filter() preserves the hook's stable order, so a
  // session that is already active stays put; only a brand-new session (which
  // the hook prepends) can appear at the top.
  const recentActive = useMemo(
    () => recentDaySessions.filter(isActiveSession),
    [recentDaySessions],
  );

  const { visibleRecent, hiddenRecent } = useMemo(() => {
    const idle = recentDaySessions.filter((s) => !isActiveSession(s));
    const { visible, hidden } = groupDuplicateSessions(idle);
    return { visibleRecent: visible, hiddenRecent: hidden };
  }, [groupDuplicateSessions, recentDaySessions]);

  const { visibleOlder, hiddenOlder } = useMemo(() => {
    const { visible, hidden } = groupDuplicateSessions(olderSessions);
    return { visibleOlder: visible, hiddenOlder: hidden };
  }, [groupDuplicateSessions, olderSessions]);

  // Track which sessions have unsent drafts in localStorage
  const drafts = useDrafts();

  // In desktop mode, always render. In mobile mode, only render when open.
  if (!isDesktop && !isOpen) return null;

  // Sidebar toggle icon for desktop mode
  const SidebarToggleIcon = () => (
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
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );

  return (
    <>
      {/* Only show overlay in non-desktop mode */}
      {!isDesktop && (
        <div
          className="sidebar-overlay"
          onClick={onClose}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          role="button"
          tabIndex={0}
          aria-label={t("actionCloseSidebar")}
        />
      )}
      <aside
        ref={sidebarRef}
        className="sidebar"
        onTouchStart={!isDesktop ? handleTouchStart : undefined}
        onTouchMove={!isDesktop ? handleTouchMove : undefined}
        onTouchEnd={!isDesktop ? handleTouchEnd : undefined}
        style={
          !isDesktop && swipeOffset < 0
            ? { transform: `translateX(${swipeOffset}px)`, transition: "none" }
            : undefined
        }
      >
        <div className="sidebar-header">
          {isDesktop && isCollapsed ? (
            /* Desktop collapsed mode: show toggle button to expand */
            <button
              type="button"
              className="sidebar-toggle"
              onClick={handleCollapsedToggleClick}
              onMouseDown={handleCollapsedToggleMouseDown}
              onAuxClick={handleCollapsedToggleAuxClick}
              title={t("actionExpandSidebar")}
              aria-label={t("actionExpandSidebar")}
            >
              <SidebarToggleIcon />
            </button>
          ) : isDesktop ? (
            /* Desktop expanded mode: show brand (toggle is in toolbar) */
            <Link
              to={newSessionHref}
              className="sidebar-brand sidebar-brand-link"
              title={t("sidebarNewSession")}
            >
              <YepAnywhereLogo />
            </Link>
          ) : (
            /* Mobile mode: brand text + close button */
            <>
              <Link
                to={newSessionHref}
                className="sidebar-brand sidebar-brand-link"
                title={t("sidebarNewSession")}
                onClick={onNavigate}
              >
                <YepAnywhereLogo />
              </Link>
              <button
                type="button"
                className="sidebar-close"
                onClick={onClose}
                aria-label={t("actionCloseSidebar")}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </>
          )}
        </div>

        <div className="sidebar-actions">
          {/* New Session: link to most recent project's new session page */}
          <SidebarNavItem
            to={newSessionPath}
            icon={SidebarIcons.newSession}
            label={t("sidebarNewSession")}
            onClick={onNavigate}
            basePath={basePath}
            hasDraft={hasNewSessionDraft && !isCollapsed}
          />
        </div>

        <div
          ref={sidebarSessionsRef}
          className="sidebar-sessions"
          onScroll={maybeLoadMoreSidebarSessions}
        >
          {/* Navigation items that scroll with content */}
          <SidebarNavSection>
            <SidebarNavItem
              to="/inbox"
              icon={SidebarIcons.inbox}
              label={t("sidebarInbox")}
              badge={inboxCount}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/sessions"
              icon={SidebarIcons.allSessions}
              label={t("sidebarAllSessions")}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/projects"
              icon={SidebarIcons.projects}
              label={t("sidebarProjects")}
              onClick={onNavigate}
              basePath={basePath}
            />
            {capabilities.includes("git-status") && (
              <SidebarNavItem
                to="/git-status"
                icon={SidebarIcons.sourceControl}
                label={t("sidebarSourceControl")}
                onClick={onNavigate}
                basePath={basePath}
              />
            )}
            {(capabilities.includes("deviceBridge") ||
              capabilities.includes("deviceBridge-download")) && (
              <SidebarNavItem
                to="/devices"
                icon={SidebarIcons.emulator}
                label={t("sidebarDevices")}
                onClick={onNavigate}
                basePath={basePath}
              />
            )}
            <AgentsNavItem onClick={onNavigate} basePath={basePath} />
            <SidebarNavItem
              to="/settings"
              icon={SidebarIcons.settings}
              label={t("sidebarSettings")}
              onClick={onNavigate}
              basePath={basePath}
            />
            {/* Relay-connected Switch Host uses nav-item markup so the mini rail stays icon-only. */}
            {remoteConnection && (
              <SidebarNavButton
                className="sidebar-switch-host"
                onClick={handleSwitchHost}
                label={t("sidebarSwitchHost")}
                icon={
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
                    <polyline points="17 1 21 5 17 9" />
                    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                    <polyline points="7 23 3 19 7 15" />
                    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                }
              />
            )}
          </SidebarNavSection>

          {/* Global sessions list */}
          {filteredStarredSessions.length > 0 && (
            <div className="sidebar-section">
              <SidebarSectionHeader
                title={t("sidebarSectionStarred")}
                expanded={starredExpanded}
                onToggle={() =>
                  setSidebarSectionExpanded("starred", (prev) => !prev)
                }
                controlsId="sidebar-starred-list"
                expandLabel={t("sidebarSectionExpand")}
                collapseLabel={t("sidebarSectionCollapse")}
              />
              {starredExpanded && (
                <ul id="sidebar-starred-list" className="sidebar-session-list">
                  {filteredStarredSessions.map((session) => (
                    <SessionListItem
                      key={session.id}
                      sessionId={session.id}
                      projectId={session.projectId}
                      title={getSessionDisplayTitle(session)}
                      fullTitle={
                        session.fullTitle ?? getSessionDisplayTitle(session)
                      }
                      initialPrompt={session.initialPrompt}
                      provider={session.provider}
                      parentSessionId={session.parentSessionId}
                      status={session.ownership}
                      pendingInputType={session.pendingInputType}
                      hasUnread={session.hasUnread}
                      isStarred={session.isStarred}
                      isArchived={session.isArchived}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      activity={session.activity}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      hasDraft={drafts.has(session.id)}
                      publicShareControlsVisible={publicShareControlsVisible}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}

          {(recentActive.length > 0 || visibleRecent.length > 0) && (
            <div className="sidebar-section">
              <SidebarSectionHeader
                title={t("sidebarSectionLast24Hours")}
                expanded={recentDayExpanded}
                onToggle={() =>
                  setSidebarSectionExpanded("recentDay", (prev) => !prev)
                }
                controlsId="sidebar-last-24-hours-list"
                expandLabel={t("sidebarSectionExpand")}
                collapseLabel={t("sidebarSectionCollapse")}
              />
              {recentDayExpanded && (
                <ul
                  id="sidebar-last-24-hours-list"
                  className="sidebar-session-list"
                >
                  {recentActive.map((session) => (
                    <SessionListItem
                      key={session.id}
                      sessionId={session.id}
                      projectId={session.projectId}
                      title={getSessionDisplayTitle(session)}
                      fullTitle={
                        session.fullTitle ?? getSessionDisplayTitle(session)
                      }
                      initialPrompt={session.initialPrompt}
                      provider={session.provider}
                      parentSessionId={session.parentSessionId}
                      status={session.ownership}
                      pendingInputType={session.pendingInputType}
                      hasUnread={session.hasUnread}
                      isStarred={session.isStarred}
                      isArchived={session.isArchived}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      activity={session.activity}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      hasDraft={drafts.has(session.id)}
                      publicShareControlsVisible={publicShareControlsVisible}
                    />
                  ))}
                  {visibleRecent.map((session) => (
                    <SessionListItem
                      key={session.id}
                      sessionId={session.id}
                      projectId={session.projectId}
                      title={getSessionDisplayTitle(session)}
                      fullTitle={
                        session.fullTitle ?? getSessionDisplayTitle(session)
                      }
                      initialPrompt={session.initialPrompt}
                      provider={session.provider}
                      parentSessionId={session.parentSessionId}
                      status={session.ownership}
                      pendingInputType={session.pendingInputType}
                      hasUnread={session.hasUnread}
                      isStarred={session.isStarred}
                      isArchived={session.isArchived}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      activity={session.activity}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      hasDraft={drafts.has(session.id)}
                      publicShareControlsVisible={publicShareControlsVisible}
                    />
                  ))}
                  {hiddenRecent.length > 0 && (
                    <li className="sidebar-hidden-dups">
                      <button
                        type="button"
                        className="sidebar-hidden-dups-toggle"
                        onClick={() => setShowHiddenRecent((v) => !v)}
                        aria-expanded={showHiddenRecent}
                      >
                        {showHiddenRecent ? "−" : "+"} {hiddenRecent.length}{" "}
                        hidden (duplicate titles)
                      </button>
                      {showHiddenRecent && (
                        <ul className="sidebar-session-list sidebar-hidden-sublist">
                          {hiddenRecent.map((session) => (
                            <SessionListItem
                              key={session.id}
                              sessionId={session.id}
                              projectId={session.projectId}
                              title={getSessionDisplayTitle(session)}
                              fullTitle={
                                session.fullTitle ??
                                getSessionDisplayTitle(session)
                              }
                              initialPrompt={session.initialPrompt}
                              provider={session.provider}
                              parentSessionId={session.parentSessionId}
                              status={session.ownership}
                              pendingInputType={session.pendingInputType}
                              hasUnread={session.hasUnread}
                              publicShareControlsVisible={
                                publicShareControlsVisible
                              }
                              isStarred={session.isStarred}
                              isArchived={session.isArchived}
                              mode="compact"
                              isCurrent={session.id === currentSessionId}
                              activity={session.activity}
                              onNavigate={onNavigate}
                              showProjectName
                              projectName={session.projectName}
                              basePath={basePath}
                              messageCount={session.messageCount}
                              hasDraft={drafts.has(session.id)}
                            />
                          ))}
                        </ul>
                      )}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {visibleOlder.length > 0 && (
            <div className="sidebar-section">
              <SidebarSectionHeader
                title={t("sidebarSectionOlder")}
                expanded={olderExpanded}
                onToggle={() =>
                  setSidebarSectionExpanded("older", (prev) => !prev)
                }
                controlsId="sidebar-older-list"
                expandLabel={t("sidebarSectionExpand")}
                collapseLabel={t("sidebarSectionCollapse")}
              />
              {olderExpanded && (
                <ul id="sidebar-older-list" className="sidebar-session-list">
                  {visibleOlder.map((session) => (
                    <SessionListItem
                      key={session.id}
                      sessionId={session.id}
                      projectId={session.projectId}
                      title={getSessionDisplayTitle(session)}
                      fullTitle={
                        session.fullTitle ?? getSessionDisplayTitle(session)
                      }
                      initialPrompt={session.initialPrompt}
                      provider={session.provider}
                      parentSessionId={session.parentSessionId}
                      status={session.ownership}
                      pendingInputType={session.pendingInputType}
                      hasUnread={session.hasUnread}
                      isStarred={session.isStarred}
                      isArchived={session.isArchived}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      activity={session.activity}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      hasDraft={drafts.has(session.id)}
                      publicShareControlsVisible={publicShareControlsVisible}
                    />
                  ))}
                  {hiddenOlder.length > 0 && (
                    <li className="sidebar-hidden-dups">
                      <button
                        type="button"
                        className="sidebar-hidden-dups-toggle"
                        onClick={() => setShowHiddenOlder((v) => !v)}
                        aria-expanded={showHiddenOlder}
                      >
                        {showHiddenOlder ? "−" : "+"} {hiddenOlder.length}{" "}
                        hidden (duplicate titles)
                      </button>
                      {showHiddenOlder && (
                        <ul className="sidebar-session-list sidebar-hidden-sublist">
                          {hiddenOlder.map((session) => (
                            <SessionListItem
                              key={session.id}
                              sessionId={session.id}
                              projectId={session.projectId}
                              title={getSessionDisplayTitle(session)}
                              fullTitle={
                                session.fullTitle ??
                                getSessionDisplayTitle(session)
                              }
                              initialPrompt={session.initialPrompt}
                              provider={session.provider}
                              parentSessionId={session.parentSessionId}
                              status={session.ownership}
                              pendingInputType={session.pendingInputType}
                              hasUnread={session.hasUnread}
                              isStarred={session.isStarred}
                              isArchived={session.isArchived}
                              mode="compact"
                              isCurrent={session.id === currentSessionId}
                              activity={session.activity}
                              onNavigate={onNavigate}
                              showProjectName
                              projectName={session.projectName}
                              basePath={basePath}
                              messageCount={session.messageCount}
                              hasDraft={drafts.has(session.id)}
                              publicShareControlsVisible={
                                publicShareControlsVisible
                              }
                            />
                          ))}
                        </ul>
                      )}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {filteredStarredSessions.length === 0 &&
            recentActive.length === 0 &&
            visibleRecent.length === 0 &&
            visibleOlder.length === 0 && (
              <p className="sidebar-empty">
                {sessionsLoading
                  ? t("sidebarLoadingSessions")
                  : t("sidebarNoSessions")}
              </p>
            )}
        </div>

        {/* Resize handle - desktop only, when expanded */}
        {isDesktop && !isCollapsed && (
          <div
            className={`sidebar-resize-handle ${isResizing ? "active" : ""}`}
            onMouseDown={handleResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("actionResizeSidebar")}
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            aria-valuenow={sidebarWidth ?? SIDEBAR_MIN_WIDTH}
            tabIndex={0}
          />
        )}
      </aside>
    </>
  );
}
