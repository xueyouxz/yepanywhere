/**
 * Global sessions route - returns all sessions across all projects.
 *
 * Unlike the inbox route which categorizes sessions into tiers,
 * this returns a flat list suitable for navigation/sidebar use.
 */

import type { ProviderName } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionIndexListOptions } from "../indexes/types.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import { isDetachedProjectPath } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionOwnership,
  SessionSummary,
} from "../supervisor/types.js";
import type { BusEvent, EventBus } from "../watcher/index.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";
import {
  getActiveSessionIndexOptions,
  isSessionAutoArchived,
} from "./session-list-options.js";

export interface GlobalSessionsDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  /** Codex scanner for checking if a project has Codex sessions */
  codexScanner?: CodexSessionScanner;
  /** Codex sessions directory (defaults to ~/.codex/sessions) */
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  /** Gemini scanner for checking if a project has Gemini sessions */
  geminiScanner?: GeminiSessionScanner;
  /** Gemini sessions directory (defaults to ~/.gemini/tmp) */
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  /** Grok sessions directory (defaults to ~/.grok/sessions) */
  grokSessionsDir?: string;
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  /** pi sessions directory (defaults to ~/.pi/agent/sessions) */
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  /** Event bus for cache invalidation */
  eventBus?: EventBus;
  /** Sessions older than this many days are hidden from default scans. 0 disables. */
  sessionAutoArchiveDays?: number;
}

export interface GlobalSessionItem {
  // From cache (cheap)
  id: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: ProviderName;
  /** Last active model for this session (from JSONL), for list/badge display. */
  model?: string;
  // Project context
  projectId: string;
  projectName: string;
  // Enrichment (all in-memory, cheap)
  ownership: SessionOwnership;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** Parent session when this item is a YA-owned /btw aside. */
  parentSessionId?: string;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Capped excerpt of the most recent regular agent turn (hover card). */
  lastAgentText?: string;
}

/** Stats about all sessions (computed during full scan) */
export interface GlobalSessionStats {
  totalCount: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  /** Counts per provider (non-archived only) */
  providerCounts: Partial<Record<ProviderName, number>>;
  /** Counts per executor host (non-archived only, "local" key for sessions without executor) */
  executorCounts: Record<string, number>;
}

/** Minimal project info for filter dropdowns */
export interface ProjectOption {
  id: string;
  name: string;
}

export interface GlobalSessionsResponse {
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
}

/** Default limit for sessions per page */
const DEFAULT_LIMIT = 100;

/** Maximum allowed limit */
const MAX_LIMIT = 500;
/** Stats cache TTL in milliseconds */
const STATS_CACHE_TTL_MS = 5000;

function createEmptyStats(): GlobalSessionStats {
  return {
    totalCount: 0,
    unreadCount: 0,
    starredCount: 0,
    archivedCount: 0,
    providerCounts: {},
    executorCounts: {},
  };
}

export function createGlobalSessionsRoutes(deps: GlobalSessionsDeps): Hono {
  const routes = new Hono();
  let cachedStats: { value: GlobalSessionStats; timestamp: number } | null =
    null;
  let statsDirty = true;
  let inFlightStats: Promise<GlobalSessionStats> | null = null;

  const shouldInvalidateStats = (event: BusEvent): boolean => {
    switch (event.type) {
      case "file-change":
      case "session-created":
      case "session-updated":
      case "session-seen":
      case "session-metadata-changed":
        return true;
      default:
        return false;
    }
  };

  const invalidateStats = (): void => {
    statsDirty = true;
  };

  if (deps.eventBus) {
    deps.eventBus.subscribe((event) => {
      if (shouldInvalidateStats(event)) {
        invalidateStats();
      }
    });
  }

  const getDefaultListOptions = (): SessionIndexListOptions | undefined =>
    getActiveSessionIndexOptions(deps.sessionAutoArchiveDays);

  const listSessionsForProject = async (
    project: Project,
    providerCatalog: Awaited<ReturnType<typeof buildProviderProjectCatalog>>,
    options?: SessionIndexListOptions,
  ): Promise<SessionSummary[]> => {
    return listSessionsAcrossProviders(
      project,
      {
        readerFactory: deps.readerFactory,
        sessionIndexService: deps.sessionIndexService,
        codexSessionsDir: deps.codexSessionsDir,
        codexReaderFactory: deps.codexReaderFactory,
        geminiSessionsDir: deps.geminiSessionsDir,
        geminiReaderFactory: deps.geminiReaderFactory,
        geminiHashToCwd: providerCatalog.geminiHashToCwd,
        grokSessionsDir: deps.grokSessionsDir,
        grokReaderFactory: deps.grokReaderFactory,
        piSessionsDir: deps.piSessionsDir,
        piReaderFactory: deps.piReaderFactory,
      },
      providerCatalog,
      options,
    );
  };

  const computeGlobalStats = async (): Promise<GlobalSessionStats> => {
    const projects = await deps.scanner.listProjects();
    const stats: GlobalSessionStats = createEmptyStats();
    const providerCatalog = await buildProviderProjectCatalog({
      projects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });

    const statsListOptions = getDefaultListOptions();
    const statsAutoArchiveAfterMs = statsListOptions?.activeAfterMs;

    for (const project of projects) {
      const sessions = await listSessionsForProject(
        project,
        providerCatalog,
        statsListOptions,
      );
      for (const session of sessions) {
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived =
          metadata?.isArchived ??
          session.isArchived ??
          isSessionAutoArchived(session, statsAutoArchiveAfterMs);
        const isStarred = metadata?.isStarred ?? session.isStarred ?? false;
        const executor = metadata?.executor;

        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(session.id, session.updatedAt)
          : false;

        if (isArchived) {
          stats.archivedCount++;
        } else {
          stats.totalCount++;
          if (hasUnread) stats.unreadCount++;
          if (session.provider) {
            stats.providerCounts[session.provider] =
              (stats.providerCounts[session.provider] ?? 0) + 1;
          }
          const executorKey = executor ?? "local";
          stats.executorCounts[executorKey] =
            (stats.executorCounts[executorKey] ?? 0) + 1;
        }
        if (isStarred) stats.starredCount++;
      }
    }

    return stats;
  };

  const getCachedGlobalStats = async (): Promise<GlobalSessionStats> => {
    const now = Date.now();
    const isFresh =
      cachedStats &&
      !statsDirty &&
      now - cachedStats.timestamp < STATS_CACHE_TTL_MS;
    if (isFresh && cachedStats) {
      return cachedStats.value;
    }

    if (inFlightStats) {
      return inFlightStats;
    }

    const statsPromise = computeGlobalStats()
      .then((stats) => {
        cachedStats = { value: stats, timestamp: Date.now() };
        statsDirty = false;
        return stats;
      })
      .finally(() => {
        if (inFlightStats === statsPromise) {
          inFlightStats = null;
        }
      });

    inFlightStats = statsPromise;
    return statsPromise;
  };

  // GET /api/sessions/stats - Get cached global session stats
  routes.get("/stats", async (c) => {
    const filterProjectId = c.req.query("project");
    if (filterProjectId) {
      return c.json({ stats: createEmptyStats() });
    }

    const stats = await getCachedGlobalStats();
    return c.json({ stats });
  });

  // GET /api/sessions - Get all sessions with pagination
  routes.get("/", async (c) => {
    // Parse query params
    const filterProjectId = c.req.query("project");
    const searchQuery = c.req.query("q")?.toLowerCase();
    const afterCursor = c.req.query("after");
    const includeArchived = c.req.query("includeArchived") === "true";
    const starredOnly = c.req.query("starred") === "true";
    const includeStats = c.req.query("includeStats") === "true";
    const limitParam = c.req.query("limit");
    const limit = Math.min(
      Math.max(1, Number.parseInt(limitParam || "", 10) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    // Get all projects
    const allProjects = await deps.scanner.listProjects();

    // Filter to single project if projectId query param provided
    const projects = filterProjectId
      ? allProjects.filter((p) => p.id === filterProjectId)
      : allProjects;

    // Build project options for filter dropdown (from all projects, sorted by name)
    const projectOptions: ProjectOption[] = allProjects
      .filter((project) => !isDetachedProjectPath(project.path))
      .map((p) => ({ id: p.id, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Collect all sessions with enriched data
    const allSessions: GlobalSessionItem[] = [];
    const providerCatalog = await buildProviderProjectCatalog({
      projects: allProjects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });

    const defaultListOptions = getDefaultListOptions();
    const listOptions = includeArchived ? undefined : defaultListOptions;
    const autoArchiveAfterMs = defaultListOptions?.activeAfterMs;

    for (const project of projects) {
      const sessions = await listSessionsForProject(
        project,
        providerCatalog,
        listOptions,
      );

      // Enrich each session
      for (const session of sessions) {
        // Get session metadata
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived =
          metadata?.isArchived ??
          session.isArchived ??
          isSessionAutoArchived(session, autoArchiveAfterMs);
        const isStarred = metadata?.isStarred ?? session.isStarred ?? false;
        const customTitle = metadata?.customTitle ?? session.customTitle;
        const parentSessionId =
          metadata?.parentSessionId ?? session.parentSessionId;
        const initialPrompt = metadata?.initialPrompt ?? session.fullTitle;
        const executor = metadata?.executor;

        // Get unread status
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(session.id, session.updatedAt)
          : undefined;

        // Skip archived sessions unless explicitly requested
        if (isArchived && !includeArchived) continue;

        // Skip non-starred sessions if starred filter is active
        if (starredOnly && !isStarred) continue;

        // Compute status
        const process = deps.supervisor?.getProcessForSession(session.id);
        const isExternal =
          deps.externalTracker?.isExternal(session.id) ?? false;

        const ownership: SessionOwnership = process
          ? {
              owner: "self",
              processId: process.id,
              permissionMode: process.permissionMode,
              modeVersion: process.modeVersion,
            }
          : isExternal
            ? { owner: "external" }
            : (session.ownership ?? { owner: "none" });

        // Get agent activity
        let pendingInputType: PendingInputType | undefined;
        let activity: AgentActivity | undefined;
        if (process) {
          const pendingRequest = process.getPendingInputRequest();
          if (pendingRequest) {
            pendingInputType =
              pendingRequest.type === "tool-approval"
                ? "tool-approval"
                : "user-question";
          }
          const state = process.state.type;
          if (state === "in-turn" || state === "waiting-input") {
            activity = state;
          }
        }

        // Apply search filter
        if (searchQuery) {
          const titleMatch = session.title?.toLowerCase().includes(searchQuery);
          const customTitleMatch = customTitle
            ?.toLowerCase()
            .includes(searchQuery);
          const projectNameMatch = project.name
            .toLowerCase()
            .includes(searchQuery);
          const initialPromptMatch = initialPrompt
            ?.toLowerCase()
            .includes(searchQuery);

          if (
            !titleMatch &&
            !customTitleMatch &&
            !projectNameMatch &&
            !initialPromptMatch
          ) {
            continue;
          }
        }

        allSessions.push({
          id: session.id,
          title: session.title,
          fullTitle: session.fullTitle,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
          provider: session.provider,
          model: session.model,
          projectId: session.projectId,
          projectName: project.name,
          ownership,
          pendingInputType,
          activity,
          hasUnread,
          customTitle,
          isArchived,
          isStarred,
          parentSessionId,
          initialPrompt: initialPrompt ?? undefined,
          executor,
          lastAgentText: session.lastAgentText,
        });
      }
    }

    // Sort by updatedAt descending (most recent first)
    allSessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    // Apply cursor pagination
    let filteredSessions = allSessions;
    if (afterCursor) {
      const afterTime = new Date(afterCursor).getTime();
      filteredSessions = allSessions.filter(
        (s) => new Date(s.updatedAt).getTime() < afterTime,
      );
    }

    // Get one extra to determine hasMore
    const sessionsWithExtra = filteredSessions.slice(0, limit + 1);
    const hasMore = sessionsWithExtra.length > limit;
    const sessions = sessionsWithExtra.slice(0, limit);
    const stats =
      includeStats && !filterProjectId
        ? await getCachedGlobalStats()
        : createEmptyStats();

    const response: GlobalSessionsResponse = {
      sessions,
      hasMore,
      stats,
      projects: projectOptions,
    };

    return c.json(response);
  });

  return routes;
}
