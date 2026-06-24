import { ALL_PROVIDERS, type ProviderName } from "@yep-anywhere/shared";
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { BulkActionBar } from "../components/BulkActionBar";
import {
  FilterDropdown,
  type FilterDropdownOption,
  type FilterOption,
} from "../components/FilterDropdown";
import { PageHeader } from "../components/PageHeader";
import { SessionListItem } from "../components/SessionListItem";
import { useDrafts } from "../hooks/useDrafts";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { setNewSessionPrefill } from "../lib/newSessionPrefill";
import { getSessionDisplayTitle } from "../utils";

// Long-press threshold for entering selection mode on mobile
const LONG_PRESS_MS = 500;

const STATUS_FILTER_VALUES = ["unread", "starred", "archived"] as const;
type StatusFilter = (typeof STATUS_FILTER_VALUES)[number];

// Age filter options (days)
type AgeFilter = "3" | "7" | "14" | "30";

// Provider colors for filter dropdown (matching ProviderBadge)
const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: "var(--app-yep-green)",
  "claude-ollama": "var(--app-yep-green)", // Same as Claude
  codex: "#10a37f",
  "codex-oss": "#f97316",
  gemini: "#4285f4",
  "gemini-acp": "#4285f4", // Same as gemini
  grok: "#111827",
  opencode: "#9333ea", // Purple for OpenCode
  pi: "#0d9488", // Teal for pi
};

function isStatusFilter(value: string): value is StatusFilter {
  return (STATUS_FILTER_VALUES as readonly string[]).includes(value);
}

function StatusFilterIcon({ status }: { status: StatusFilter }) {
  const className = `status-filter-icon status-filter-icon--${status}`;
  switch (status) {
    case "unread":
      return (
        <svg
          className={className}
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </svg>
      );
    case "starred":
      return (
        <svg
          className={className}
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    case "archived":
      return (
        <svg
          className={className}
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
          <path d="M10 12h4" />
        </svg>
      );
  }
}

/**
 * Global sessions page showing all sessions across all projects.
 * Supports filtering by project, status, provider, and search query.
 * Includes multi-select mode with bulk actions.
 */
export function GlobalSessionsPage() {
  const { t } = useI18n();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { settings: serverSettings } = useServerSettings();
  const publicSharesEnabled = serverSettings?.publicSharesEnabled ?? false;
  const { status: publicShareStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });
  const publicShareControlsVisible = publicShareStatus?.canCreate ?? false;

  // Get filter params from URL
  const searchQuery = searchParams.get("q") || "";
  const projectFilter = searchParams.get("project") || undefined;

  // Local state for search input (instant feedback)
  const [searchInput, setSearchInput] = useState(searchQuery);

  // Status and provider filters from URL
  const statusFilters = useMemo(() => {
    const param = searchParams.get("status");
    if (!param) return [];
    return param.split(",").filter(isStatusFilter);
  }, [searchParams]);

  const providerFilters = useMemo(() => {
    const param = searchParams.get("provider");
    if (!param) return [];
    const knownProviders = Object.keys(PROVIDER_COLORS);
    return param
      .split(",")
      .filter((p): p is ProviderName => knownProviders.includes(p));
  }, [searchParams]);

  const executorFilters = useMemo(() => {
    const param = searchParams.get("executor");
    if (!param) return [];
    return param.split(",").filter(Boolean);
  }, [searchParams]);

  const ageFilter = useMemo(() => {
    const param = searchParams.get("age");
    if (param && ["3", "7", "14", "30"].includes(param))
      return param as AgeFilter;
    return undefined;
  }, [searchParams]);

  const setStatusFilters = useCallback(
    (filters: StatusFilter[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("status", filters.join(","));
        } else {
          next.delete("status");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setProviderFilters = useCallback(
    (filters: ProviderName[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("provider", filters.join(","));
        } else {
          next.delete("provider");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setExecutorFilters = useCallback(
    (filters: string[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("executor", filters.join(","));
        } else {
          next.delete("executor");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setAgeFilter = useCallback(
    (selected: AgeFilter[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (selected.length > 0 && selected[0]) {
          next.set("age", selected[0]);
        } else {
          next.delete("age");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  // Include archived sessions when archived filter is selected
  const includeArchived = statusFilters.includes("archived");

  const { sessions, stats, projects, loading, error, hasMore, loadMore } =
    useGlobalSessions({
      projectId: projectFilter,
      searchQuery,
      includeArchived,
      includeStats: !projectFilter,
    });

  // Filter sessions based on status and provider filters (client-side)
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      // Status filtering (empty = show all non-archived)
      if (statusFilters.length === 0) {
        // Default: show non-archived
        if (session.isArchived) return false;
      } else {
        // Check if session matches any selected status filter
        let matchesStatus = false;
        for (const status of statusFilters) {
          switch (status) {
            case "unread":
              if (session.hasUnread && !session.isArchived)
                matchesStatus = true;
              break;
            case "starred":
              if (session.isStarred) matchesStatus = true;
              break;
            case "archived":
              if (session.isArchived) matchesStatus = true;
              break;
          }
        }
        if (!matchesStatus) return false;
      }

      // Provider filtering (empty = show all providers)
      if (providerFilters.length > 0) {
        if (!session.provider || !providerFilters.includes(session.provider)) {
          return false;
        }
      }

      // Executor filtering (empty = show all executors)
      if (executorFilters.length > 0) {
        const sessionExecutor = session.executor ?? "local";
        if (!executorFilters.includes(sessionExecutor)) {
          return false;
        }
      }

      // Age filtering (only show sessions older than N days)
      if (ageFilter) {
        const days = Number(ageFilter);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        if (new Date(session.updatedAt).getTime() > cutoff) {
          return false;
        }
      }

      return true;
    });
  }, [sessions, statusFilters, providerFilters, executorFilters, ageFilter]);

  // Track which sessions have unsent drafts
  const drafts = useDrafts();

  // Build status filter options with global counts from server
  // When filtering by project, we don't have global stats, so omit counts
  const statusOptions = useMemo((): FilterDropdownOption<StatusFilter>[] => {
    // Only show counts when not filtering by project (global view)
    const showCounts = !projectFilter;

    return [
      {
        value: "unread",
        label: t("globalSessionsStatusUnread"),
        icon: <StatusFilterIcon status="unread" />,
        count: showCounts ? stats.unreadCount : undefined,
      },
      {
        value: "starred",
        label: t("globalSessionsStatusStarred"),
        icon: <StatusFilterIcon status="starred" />,
        count: showCounts ? stats.starredCount : undefined,
      },
      {
        value: "archived",
        label: t("globalSessionsStatusArchived"),
        icon: <StatusFilterIcon status="archived" />,
        count: showCounts ? stats.archivedCount : undefined,
      },
      {
        value: "all",
        label: t("globalSessionsStatusAll"),
        clearSelection: true,
        dividerBefore: true,
        count: showCounts ? stats.totalCount : undefined,
      },
    ];
  }, [stats, projectFilter, t]);

  const statusPlaceholder = (
    <span className="status-filter-placeholder" aria-hidden="true">
      {STATUS_FILTER_VALUES.map((status) => (
        <StatusFilterIcon key={status} status={status} />
      ))}
    </span>
  );

  // Build provider filter options with global counts from server
  // When filtering by project, we don't have global stats, so omit counts
  const providerOptions = useMemo((): FilterDropdownOption<ProviderName>[] => {
    const showCounts = !projectFilter;
    const providerCounts = stats.providerCounts;

    // Only show providers that have sessions
    const options: FilterDropdownOption<ProviderName>[] = [];
    for (const provider of ALL_PROVIDERS) {
      const count = providerCounts[provider];
      if (count && count > 0) {
        options.push({
          value: provider,
          label: provider.charAt(0).toUpperCase() + provider.slice(1),
          count: showCounts ? count : undefined,
          color: PROVIDER_COLORS[provider],
        });
      }
    }
    options.push({
      value: "all-providers",
      label: t("globalSessionsProviderAll"),
      clearSelection: true,
      dividerBefore: true,
      count: showCounts ? stats.totalCount : undefined,
    });
    return options;
  }, [stats.providerCounts, stats.totalCount, projectFilter, t]);

  // Age filter options
  const ageOptions = useMemo((): FilterOption<AgeFilter>[] => {
    return [
      { value: "3", label: "Older than 3 days" },
      { value: "3", label: t("globalSessionsAge3Days") },
      { value: "7", label: t("globalSessionsAge7Days") },
      { value: "14", label: t("globalSessionsAge14Days") },
      { value: "30", label: t("globalSessionsAge30Days") },
    ];
  }, [t]);

  // Build executor filter options with global counts from server
  const executorOptions = useMemo((): FilterOption<string>[] => {
    const showCounts = !projectFilter;
    const executorCounts = stats.executorCounts;

    // Only show executors that have sessions, sorted with "local" first
    const entries = Object.entries(executorCounts).filter(
      ([_, count]) => count > 0,
    );
    entries.sort((a, b) => {
      // "local" always comes first
      if (a[0] === "local") return -1;
      if (b[0] === "local") return 1;
      return a[0].localeCompare(b[0]);
    });

    return entries.map(([executor, count]) => ({
      value: executor,
      label: executor === "local" ? t("globalSessionsExecutorLocal") : executor,
      count: showCounts ? count : undefined,
    }));
  }, [stats.executorCounts, projectFilter, t]);

  // Selection state for multi-select mode
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isBulkActionPending, setIsBulkActionPending] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressSessionRef = useRef<string | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);

  // Dup-title hiding for the heavier (card) list in GlobalSessionsPage (all sessions + per-project views).
  // Cheap O(n) client-side grouping on the already-fetched + filtered page. Re-uses the same
  // "prefer higher messageCount + recent activity" rule so we don't hide the substantive version of a dup title.
  // Hidden dups are still reachable via the expander (and fully included for bulk selection).
  const [showHiddenDups, setShowHiddenDups] = useState(false);

  const { visibleSessions, hiddenDupSessions } = useMemo(() => {
    if (isSelectionMode) {
      // During multi-select, show everything so user can act on dups if desired.
      return {
        visibleSessions: filteredSessions,
        hiddenDupSessions: [] as typeof filteredSessions,
      };
    }

    const groups = new Map<string, typeof filteredSessions>();
    for (const s of filteredSessions) {
      const norm = (s.title || s.fullTitle || s.initialPrompt || "")
        .trim()
        .toLowerCase()
        .slice(0, 120);
      const key = `${s.provider || "unknown"}|${s.projectId}|${norm}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }

    const visible: typeof filteredSessions = [];
    const hidden: typeof filteredSessions = [];
    for (const arr of groups.values()) {
      if (arr.length <= 1) {
        visible.push(...arr);
      } else {
        // Prefer the one with most messages or most recent activity — do not hide the "real" one.
        arr.sort((a, b) => {
          const mc = (b.messageCount || 0) - (a.messageCount || 0);
          if (mc !== 0) return mc;
          return (
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
        });
        visible.push(arr[0]!); // arr is guaranteed non-empty in this branch (length >= 2)
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
    return { visibleSessions: visible, hiddenDupSessions: hidden };
  }, [filteredSessions, isSelectionMode]);

  // Selection handlers
  const handleSelect = useCallback((sessionId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      // Exit selection mode when nothing is selected
      if (next.size === 0) {
        setIsSelectionMode(false);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(filteredSessions.map((s) => s.id)));
    setIsSelectionMode(true);
  }, [filteredSessions]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setIsSelectionMode(false);
  }, []);

  // Long-press handlers for mobile selection mode
  const handleLongPressStart = useCallback(
    (sessionId: string, e: React.TouchEvent | React.MouseEvent) => {
      // Already in selection mode or on desktop - don't start long-press
      if (isSelectionMode || isWideScreen) return;

      // Record starting position to detect movement (scrolling)
      if ("touches" in e) {
        const touch = e.touches[0];
        if (touch) {
          touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
        }
      } else if ("clientX" in e) {
        touchStartPosRef.current = { x: e.clientX, y: e.clientY };
      }

      longPressSessionRef.current = sessionId;
      longPressTimerRef.current = setTimeout(() => {
        // Enter selection mode and select this session
        setIsSelectionMode(true);
        setSelectedIds(new Set([sessionId]));
        longPressSessionRef.current = null;
        touchStartPosRef.current = null;
      }, LONG_PRESS_MS);
    },
    [isSelectionMode, isWideScreen],
  );

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressSessionRef.current = null;
    touchStartPosRef.current = null;
  }, []);

  // Cancel long press if user moves finger (scrolling)
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartPosRef.current || !longPressTimerRef.current) return;

    const touch = e.touches[0];
    if (!touch) return;

    const dx = touch.clientX - touchStartPosRef.current.x;
    const dy = touch.clientY - touchStartPosRef.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Cancel if moved more than 10px (scrolling threshold)
    if (distance > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressSessionRef.current = null;
      touchStartPosRef.current = null;
    }
  }, []);

  // Prevent native context menu during long press
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Suppress context menu if long press is active or in selection mode
      if (longPressTimerRef.current || isSelectionMode) {
        e.preventDefault();
      }
    },
    [isSelectionMode],
  );

  // Bulk action handlers
  const handleBulkArchive = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { archived: true }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkUnarchive = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { archived: false }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkStar = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { starred: true }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkUnstar = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          api.updateSessionMetadata(id, { starred: false }),
        ),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkMarkRead = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.markSessionSeen(id)),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  const handleBulkMarkUnread = useCallback(async () => {
    if (isBulkActionPending) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.markSessionUnread(id)),
      );
      handleClearSelection();
    } finally {
      setIsBulkActionPending(false);
    }
  }, [selectedIds, isBulkActionPending, handleClearSelection]);

  // "Archive all" for filtered results (no manual selection needed)
  const handleArchiveAllFiltered = useCallback(async () => {
    if (isBulkActionPending) return;
    const archivable = filteredSessions.filter((s) => !s.isArchived);
    if (archivable.length === 0) return;
    setIsBulkActionPending(true);
    try {
      await Promise.all(
        archivable.map((s) =>
          api.updateSessionMetadata(s.id, { archived: true }),
        ),
      );
    } finally {
      setIsBulkActionPending(false);
    }
  }, [filteredSessions, isBulkActionPending]);

  // Count of archivable sessions in filtered results
  const archivableFilteredCount = useMemo(
    () => filteredSessions.filter((s) => !s.isArchived).length,
    [filteredSessions],
  );

  // Compute which bulk actions are applicable based on selection
  const bulkActionState = useMemo(() => {
    const selectedSessions = sessions.filter((s) => selectedIds.has(s.id));
    return {
      canArchive: selectedSessions.some((s) => !s.isArchived),
      canUnarchive: selectedSessions.some((s) => s.isArchived),
      canStar: selectedSessions.some((s) => !s.isStarred),
      canUnstar: selectedSessions.some((s) => s.isStarred),
      canMarkRead: selectedSessions.some((s) => s.hasUnread),
      canMarkUnread: selectedSessions.some((s) => !s.hasUnread),
    };
  }, [sessions, selectedIds]);

  // Handle search form submit
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const newParams = new URLSearchParams(searchParams);
    if (searchInput.trim()) {
      newParams.set("q", searchInput.trim());
    } else {
      newParams.delete("q");
    }
    setSearchParams(newParams);
  };

  // Handle project filter change
  const handleProjectFilter = useCallback(
    (selected: string[]) => {
      const newParams = new URLSearchParams(searchParams);
      if (selected.length > 0 && selected[0]) {
        newParams.set("project", selected[0]);
      } else {
        newParams.delete("project");
      }
      setSearchParams(newParams);
    },
    [searchParams, setSearchParams],
  );

  // Build project filter options
  const projectOptions = useMemo((): FilterOption<string>[] => {
    return projects.map((project) => ({
      value: project.id,
      label: project.name,
    }));
  }, [projects]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === projectFilter) ?? null,
    [projectFilter, projects],
  );

  const projectScopedSearchText = searchQuery.trim();
  const showProjectNewSessionCta = Boolean(projectFilter && activeProject);

  const handleStartProjectSession = useCallback(() => {
    if (!projectFilter) return;
    if (projectScopedSearchText) {
      setNewSessionPrefill(projectScopedSearchText);
    }
    navigate(
      `${basePath}/new-session?projectId=${encodeURIComponent(projectFilter)}`,
    );
  }, [basePath, navigate, projectFilter, projectScopedSearchText]);

  // Clear all filters
  const clearFilters = () => {
    setSearchInput("");
    setSearchParams(new URLSearchParams());
  };

  const isEmpty = filteredSessions.length === 0;
  const hasFilters =
    searchQuery ||
    projectFilter ||
    statusFilters.length > 0 ||
    providerFilters.length > 0 ||
    executorFilters.length > 0 ||
    ageFilter;

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader
        title={t("globalSessionsTitle")}
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
      />

      <main className="page-scroll-container">
        <div className="page-content-inner">
          {/* Filter bar */}
          <div className="filter-bar">
            <form onSubmit={handleSearch} className="filter-search-form">
              <input
                type="text"
                className="filter-search"
                placeholder={t("globalSessionsSearchPlaceholder")}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <button type="submit" className="filter-search-button">
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
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
            </form>
            <div className="filter-dropdowns">
              {projectOptions.length > 0 && (
                <FilterDropdown
                  label={t("inboxFilterProject")}
                  options={projectOptions}
                  selected={projectFilter ? [projectFilter] : []}
                  onChange={handleProjectFilter}
                  multiSelect={false}
                  placeholder={t("globalSessionsFilterProjectPlaceholder")}
                />
              )}
              <FilterDropdown
                label={t("globalSessionsFilterStatus")}
                options={statusOptions}
                selected={statusFilters}
                onChange={setStatusFilters}
                placeholder={t("globalSessionsStatusAll")}
                placeholderContent={statusPlaceholder}
                className="filter-dropdown--status"
              />
              {providerOptions.length > 1 && (
                <FilterDropdown
                  label={t("globalSessionsFilterProvider")}
                  options={providerOptions}
                  selected={providerFilters}
                  onChange={setProviderFilters}
                  placeholder={t("globalSessionsProviderAll")}
                  className="filter-dropdown--provider"
                />
              )}
              {executorOptions.length > 1 && (
                <FilterDropdown
                  label={t("globalSessionsFilterExecutor")}
                  options={executorOptions}
                  selected={executorFilters}
                  onChange={setExecutorFilters}
                  placeholder={t("globalSessionsFilterMachinePlaceholder")}
                />
              )}
              <FilterDropdown
                label={t("globalSessionsFilterAge")}
                options={ageOptions}
                selected={ageFilter ? [ageFilter] : []}
                onChange={setAgeFilter}
                multiSelect={false}
                placeholder={t("globalSessionsFilterAgePlaceholder")}
              />
            </div>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="filter-clear-button"
              >
                {t("globalSessionsClearFilters")}
              </button>
            )}
          </div>

          {showProjectNewSessionCta && activeProject && (
            <div className="global-sessions-project-cta">
              <div className="global-sessions-project-cta__copy">
                <strong>
                  {t("sidebarNewSession")}{" "}
                  <code className="global-sessions-project-cta__token">
                    {activeProject.name}
                  </code>
                </strong>
                {projectScopedSearchText && (
                  <span>
                    {t("globalSessionsProjectCtaPromptLabel")}{" "}
                    <code className="global-sessions-project-cta__token">
                      {projectScopedSearchText}
                    </code>
                  </span>
                )}
                {!projectScopedSearchText && (
                  <span>
                    {t("globalSessionsProjectCtaHint")}{" "}
                    <code className="global-sessions-project-cta__token">
                      {activeProject.name}
                    </code>
                  </span>
                )}
              </div>
              <button
                type="button"
                className="inbox-refresh-button global-sessions-project-cta__button"
                onClick={handleStartProjectSession}
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
                  aria-hidden="true"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {t("sidebarNewSession")}
              </button>
            </div>
          )}

          {loading && sessions.length === 0 && (
            <p className="loading">{t("sidebarLoadingSessions")}</p>
          )}

          {error && (
            <p className="error">
              {t("projectsErrorPrefix")} {error.message}
            </p>
          )}

          {!loading && !error && isEmpty && (
            <div className="inbox-empty">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <h3>{t("globalSessionsNoResultsTitle")}</h3>
              <p>
                {hasFilters
                  ? t("globalSessionsNoResultsFiltered")
                  : t("globalSessionsNoResultsEmpty")}
              </p>
            </div>
          )}

          {!error && !isEmpty && (
            <>
              {/* Select all header (desktop or when in selection mode) */}
              {(isWideScreen || isSelectionMode) &&
                filteredSessions.length > 0 && (
                  <div className="session-list-header">
                    <label className="session-list-header__select-all">
                      <input
                        type="checkbox"
                        checked={
                          selectedIds.size === filteredSessions.length &&
                          filteredSessions.length > 0
                        }
                        onChange={(e) =>
                          e.target.checked
                            ? handleSelectAll()
                            : handleClearSelection()
                        }
                      />
                      <span>
                        {selectedIds.size > 0
                          ? t("bulkSelectedCount", {
                              count: selectedIds.size,
                            })
                          : t("globalSessionsSelectAll")}
                      </span>
                    </label>
                  </div>
                )}

              <ul
                className={`session-list ${isSelectionMode ? "session-list--selection-mode" : ""}`}
              >
                {visibleSessions.map((session) => (
                  // biome-ignore lint/a11y/noStaticElementInteractions: wrapper handles mobile long-press selection while the nested link remains the accessible control
                  <div
                    key={session.id}
                    onTouchStart={(e) => handleLongPressStart(session.id, e)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleLongPressEnd}
                    onTouchCancel={handleLongPressEnd}
                    onMouseDown={(e) =>
                      !isWideScreen && handleLongPressStart(session.id, e)
                    }
                    onMouseUp={handleLongPressEnd}
                    onMouseLeave={handleLongPressEnd}
                    onContextMenu={handleContextMenu}
                  >
                    <SessionListItem
                      sessionId={session.id}
                      projectId={session.projectId}
                      title={getSessionDisplayTitle(session)}
                      fullTitle={
                        session.fullTitle ?? getSessionDisplayTitle(session)
                      }
                      initialPrompt={session.initialPrompt}
                      hasCustomTitle={!!session.customTitle}
                      lastAgentText={session.lastAgentText}
                      updatedAt={session.updatedAt}
                      createdAt={session.createdAt}
                      hasUnread={session.hasUnread}
                      activity={session.activity}
                      pendingInputType={session.pendingInputType}
                      status={session.ownership}
                      provider={session.provider}
                      model={session.model}
                      parentSessionId={session.parentSessionId}
                      executor={session.executor}
                      isStarred={session.isStarred}
                      isArchived={session.isArchived}
                      mode="card"
                      showContextUsage={false}
                      isSelected={selectedIds.has(session.id)}
                      isSelectionMode={isSelectionMode && !isWideScreen}
                      onNavigate={() => {
                        // In selection mode on mobile, tap toggles selection
                        if (isSelectionMode && !isWideScreen) {
                          handleSelect(
                            session.id,
                            !selectedIds.has(session.id),
                          );
                        }
                      }}
                      onSelect={
                        isWideScreen || isSelectionMode
                          ? handleSelect
                          : undefined
                      }
                      showProjectName={!projectFilter}
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      // userTurnCount / systemTurnCount will be populated when
                      // the index summaries cache them (see SessionIndexService)
                      hasDraft={drafts.has(session.id)}
                      publicShareControlsVisible={publicShareControlsVisible}
                    />
                  </div>
                ))}
              </ul>

              {/* Dup hidden expander for the heavier/thicker card list (all sessions or per-project).
                    Cheap (runs on already-fetched filtered page). Matches the sidebar "(X hidden)" pattern
                    but with thicker card items when expanded. */}
              {hiddenDupSessions.length > 0 && (
                <div className="global-sessions-hidden-dups">
                  <button
                    type="button"
                    className="global-sessions-hidden-dups-toggle"
                    onClick={() => setShowHiddenDups((v) => !v)}
                    aria-expanded={showHiddenDups}
                  >
                    {showHiddenDups ? "−" : "+"}{" "}
                    {t("globalSessionsHiddenDuplicates", {
                      count: hiddenDupSessions.length,
                    })}
                  </button>
                  {showHiddenDups && (
                    <ul className="session-list global-sessions-hidden-sublist">
                      {hiddenDupSessions.map((session) => (
                        <div
                          key={session.id}
                          className="global-sessions-hidden-item"
                        >
                          <SessionListItem
                            sessionId={session.id}
                            projectId={session.projectId}
                            title={getSessionDisplayTitle(session)}
                            fullTitle={
                              session.fullTitle ??
                              getSessionDisplayTitle(session)
                            }
                            initialPrompt={session.initialPrompt}
                            hasCustomTitle={!!session.customTitle}
                            lastAgentText={session.lastAgentText}
                            updatedAt={session.updatedAt}
                            createdAt={session.createdAt}
                            hasUnread={session.hasUnread}
                            publicShareControlsVisible={
                              publicShareControlsVisible
                            }
                            activity={session.activity}
                            pendingInputType={session.pendingInputType}
                            status={session.ownership}
                            provider={session.provider}
                            model={session.model}
                            parentSessionId={session.parentSessionId}
                            executor={session.executor}
                            isStarred={session.isStarred}
                            isArchived={session.isArchived}
                            mode="card"
                            showContextUsage={false}
                            isSelected={selectedIds.has(session.id)}
                            isSelectionMode={isSelectionMode && !isWideScreen}
                            onNavigate={() => {
                              if (isSelectionMode && !isWideScreen) {
                                handleSelect(
                                  session.id,
                                  !selectedIds.has(session.id),
                                );
                              }
                            }}
                            onSelect={
                              isWideScreen || isSelectionMode
                                ? handleSelect
                                : undefined
                            }
                            showProjectName={!projectFilter}
                            projectName={session.projectName}
                            basePath={basePath}
                            messageCount={session.messageCount}
                            hasDraft={drafts.has(session.id)}
                          />
                        </div>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {hasMore && (
                <div className="global-sessions-load-more">
                  <button
                    type="button"
                    onClick={loadMore}
                    className="global-sessions-load-more-button"
                    disabled={loading}
                  >
                    {loading
                      ? t("gitStatusLoading")
                      : t("globalSessionsLoadMore")}
                  </button>
                </div>
              )}
            </>
          )}

          {/* Bulk action bar */}
          <BulkActionBar
            selectedCount={selectedIds.size}
            onArchive={handleBulkArchive}
            onUnarchive={handleBulkUnarchive}
            onStar={handleBulkStar}
            onUnstar={handleBulkUnstar}
            onMarkRead={handleBulkMarkRead}
            onMarkUnread={handleBulkMarkUnread}
            onClearSelection={handleClearSelection}
            isPending={isBulkActionPending}
            canArchive={bulkActionState.canArchive}
            canUnarchive={bulkActionState.canUnarchive}
            canStar={bulkActionState.canStar}
            canUnstar={bulkActionState.canUnstar}
            canMarkRead={bulkActionState.canMarkRead}
            canMarkUnread={bulkActionState.canMarkUnread}
            onArchiveAllFiltered={
              hasFilters ? handleArchiveAllFiltered : undefined
            }
            archivableFilteredCount={archivableFilteredCount}
          />
        </div>
      </main>
    </MainContent>
  );
}
