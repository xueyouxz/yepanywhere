/**
 * CodexSessionReader - Reads Codex sessions from disk.
 *
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * with a different format than Claude:
 * - session_meta: Session initialization (id, cwd, timestamp)
 * - response_item: Messages, reasoning, function calls
 * - event_msg: User/agent messages, token counts
 * - turn_context: Per-turn configuration
 *
 * Unlike Claude's DAG structure, Codex sessions are linear.
 */

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodexSessionEntry,
  type CodexSessionMetaEntry,
  type CodexTurnContextEntry,
  type UrlProjectId,
  getModelContextWindow,
  parseCodexSessionEntry,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import type { SessionDiscoveryIndex } from "../indexes/SessionDiscoveryIndex.js";
import { getLogger } from "../logging/logger.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import {
  codexRolloutRepresentation,
  isCodexRolloutFileName,
  preferPlainCodexRollouts,
} from "../utils/codexRolloutFiles.js";
import { readJsonlLines } from "../utils/jsonl.js";
import {
  type CodexRolloutDiscoveryStats,
  createCodexSessionDiscoveryIndex,
  createCodexRolloutDiscoveryStats,
  readCodexRolloutMetadata,
} from "./codex-discovery.js";
import { normalizeSession } from "./normalization.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";

export interface CodexSessionReaderOptions {
  /**
   * Base directory for Codex sessions (~/.codex/sessions).
   * Sessions are stored in YYYY/MM/DD/rollout-*.jsonl structure.
   */
  sessionsDir: string;
  /**
   * The project path (cwd) to filter sessions by.
   * Only sessions with this cwd will be listed.
   */
  projectPath?: string;
  dataDir?: string;
  discoveryIndex?: SessionDiscoveryIndex;
  slowLogThresholdMs?: number;
}

interface CodexSessionFile {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  mtime: number;
  size: number;
  isSubagent: boolean;
}

const CODEX_SCAN_CACHE_TTL_MS = 5000;
const DEFAULT_SLOW_LOG_THRESHOLD_MS = 250;

function isCompressedCodexSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl.zst");
}

interface CodexScanOptions {
  activeAfterMs?: number;
}

interface CodexSharedScanCacheEntry {
  timestamp: number;
  sessions: CodexSessionFile[];
  inFlight?: Promise<CodexSessionFile[]>;
}

const codexSharedScanCache = new Map<string, CodexSharedScanCacheEntry>();

export type CodexSessionReaderScanCacheStatus = "hit" | "in-flight" | "miss";

export interface CodexSessionReaderScanMetrics {
  sessionsDir: string;
  projectPath?: string;
  activeAfterMs?: number;
  cacheKey: string;
  sharedCacheStatus: CodexSessionReaderScanCacheStatus;
  durationMs: number;
  sessionsDirExists: boolean;
  directoriesVisited: number;
  directoryReadErrors: number;
  rolloutFilesFound: number;
  rolloutFilesAfterPrecedence: number;
  plainRolloutFiles: number;
  compressedRolloutFiles: number;
  precedenceSkippedCompressed: number;
  sessionsParsed: number;
  failedFiles: number;
  subagentSessionsSkipped: number;
  sessionsReturned: number;
  discovery: CodexRolloutDiscoveryStats;
}

interface CodexEntryCache {
  filePath: string;
  mtimeMs: number;
  size: number;
  entries: CodexSessionEntry[];
  partialLine: string;
}

function parseCodexJsonlChunk(
  chunk: string,
  mayEndWithPartialLine: boolean,
): { entries: CodexSessionEntry[]; partialLine: string } {
  const lines = chunk.split("\n");
  const partialLine = mayEndWithPartialLine ? (lines.pop() ?? "") : "";
  const entries: CodexSessionEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const entry = parseCodexSessionEntry(trimmed);
    if (entry) {
      entries.push(entry);
    }
  }

  return { entries, partialLine };
}

function getCodexMessagePayloadText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .map((block) => (typeof block.text === "string" ? block.text : block.type))
    .join("\n");
}

function getCodexEntryDedupeKey(entry: CodexSessionEntry): string | null {
  if (entry.type === "response_item") {
    const { payload } = entry;
    if (payload.type === "message") {
      return [
        entry.type,
        entry.timestamp,
        payload.type,
        payload.role,
        getCodexMessagePayloadText(payload.content),
      ].join("\n");
    }
    return null;
  }

  if (entry.type === "event_msg") {
    const { payload } = entry;
    if (payload.type === "user_message" || payload.type === "agent_message") {
      return [entry.type, entry.timestamp, payload.type, payload.message].join(
        "\n",
      );
    }
  }

  return null;
}

function dedupeCodexEntries(entries: CodexSessionEntry[]): CodexSessionEntry[] {
  const seen = new Set<string>();
  let deduped: CodexSessionEntry[] | null = null;

  entries.forEach((entry, index) => {
    const key = getCodexEntryDedupeKey(entry);
    if (!key) {
      deduped?.push(entry);
      return;
    }
    if (seen.has(key)) {
      if (!deduped) {
        deduped = entries.slice(0, index);
      }
      return;
    }

    seen.add(key);
    deduped?.push(entry);
  });

  return deduped ?? entries;
}

/**
 * Codex-specific session reader for Codex CLI JSONL files.
 *
 * Handles Codex's linear conversation structure with session_meta,
 * response_item, event_msg, and turn_context entries.
 */
export class CodexSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;
  private discoveryIndex?: SessionDiscoveryIndex;
  private slowLogThresholdMs: number;
  private lastScanMetrics: CodexSessionReaderScanMetrics | null = null;

  // Cache of session ID -> file path for quick lookups
  private sessionFileCache: Map<string, CodexSessionFile> = new Map();
  private entryCache: Map<string, CodexEntryCache> = new Map();

  constructor(options: CodexSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.discoveryIndex =
      options.discoveryIndex ??
      createCodexSessionDiscoveryIndex(options.dataDir, this.sessionsDir);
    this.slowLogThresholdMs = Math.max(
      0,
      options.slowLogThresholdMs ?? DEFAULT_SLOW_LOG_THRESHOLD_MS,
    );
  }

  invalidateCache(): void {
    this.sessionFileCache.clear();
    this.entryCache.clear();
    for (const cacheKey of codexSharedScanCache.keys()) {
      if (cacheKey.startsWith(`${this.sessionsDir}::`)) {
        codexSharedScanCache.delete(cacheKey);
      }
    }
  }

  getLastScanMetrics(): CodexSessionReaderScanMetrics | null {
    return this.lastScanMetrics
      ? cloneCodexSessionReaderScanMetrics(this.lastScanMetrics)
      : null;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = await this.scanSessions();

    for (const session of sessions) {
      // Filter by project path if set
      if (
        this.projectPath &&
        canonicalizeProjectPath(session.cwd) !== this.projectPath
      ) {
        continue;
      }

      const summary = await this.getSessionSummary(session.id, projectId);
      if (summary) {
        summaries.push(summary);
      }
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const entries = await this.readEntries(sessionId, sessionFile.filePath);

      if (entries.length === 0) return null;

      // Extract session metadata from first entry
      const metaEntry = entries.find((e) => e.type === "session_meta") as
        | CodexSessionMetaEntry
        | undefined;
      if (!metaEntry) return null;

      const stats = await stat(sessionFile.filePath);
      const { title, fullTitle } = this.extractTitle(entries);
      const messageCount = this.countMessages(entries);
      const model = this.extractModel(entries);
      const provider = this.determineProvider(metaEntry, model);
      const turnContext = this.extractTurnContext(entries);
      const contextUsage = this.extractContextUsage(entries, model, provider);
      const parentSessionId =
        typeof metaEntry.payload.forked_from_id === "string"
          ? metaEntry.payload.forked_from_id
          : undefined;

      // Skip sessions with no actual conversation messages
      if (messageCount === 0) return null;

      return {
        id: sessionId,
        projectId,
        title,
        fullTitle,
        createdAt: metaEntry.payload.timestamp,
        updatedAt: stats.mtime.toISOString(),
        messageCount,
        ownership: { owner: "none" },
        contextUsage,
        provider,
        model,
        parentSessionId,
        originator: metaEntry.payload.originator,
        cliVersion: metaEntry.payload.cli_version,
        source: codexSessionSourceLabel(metaEntry.payload.source),
        approvalPolicy: turnContext?.payload.approval_policy,
        sandboxPolicy: turnContext?.payload.sandbox_policy
          ? {
              type: turnContext.payload.sandbox_policy.type,
              networkAccess: turnContext.payload.sandbox_policy.network_access,
              excludeTmpdirEnvVar:
                turnContext.payload.sandbox_policy.exclude_tmpdir_env_var,
              excludeSlashTmp:
                turnContext.payload.sandbox_policy.exclude_slash_tmp,
            }
          : undefined,
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    const entries = await this.readEntries(sessionId, sessionFile.filePath);

    // Filter entries if needed (for incremental fetching)
    // Note: Codex entries are not 1:1 with messages, so standard ID filtering is tricky
    // with raw format. We return all entries for now.
    // Ideally the client handles diffing/appending.
    const finalEntries = entries;
    if (afterMessageId) {
      // Logic to filter entries would go here if strict incremental loading is needed
    }

    return {
      summary,
      data: {
        provider: this.determineProviderFromEntries(entries),
        session: {
          entries: finalEntries,
        },
      },
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const stats = await stat(sessionFile.filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    const sessions = await this.scanSessions();
    const mappings: { toolUseId: string; agentId: string }[] = [];
    const seenToolUseIds = new Set<string>();

    for (const session of sessions) {
      if (
        this.projectPath &&
        canonicalizeProjectPath(session.cwd) !== this.projectPath
      ) {
        continue;
      }

      const entries = await this.readEntries(session.id, session.filePath);
      const spawnAgentCallIds = new Set<string>();

      for (const entry of entries) {
        if (entry.type !== "response_item") {
          continue;
        }

        const payload = entry.payload;
        if (
          payload.type === "function_call" &&
          payload.name === "spawn_agent"
        ) {
          spawnAgentCallIds.add(payload.call_id);
          continue;
        }

        if (
          payload.type !== "function_call_output" ||
          !spawnAgentCallIds.has(payload.call_id) ||
          seenToolUseIds.has(payload.call_id)
        ) {
          continue;
        }

        const agentId = parseCodexSpawnAgentOutput(payload.output);
        if (!agentId) {
          continue;
        }

        mappings.push({ toolUseId: payload.call_id, agentId });
        seenToolUseIds.add(payload.call_id);
      }
    }

    return mappings;
  }

  async getAgentSession(
    agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    const sessionFile = await this.findSessionFile(agentId);
    if (!sessionFile) return null;

    const entries = await this.readEntries(agentId, sessionFile.filePath);
    if (entries.length === 0) return null;

    const metaEntry = entries.find((e) => e.type === "session_meta") as
      | CodexSessionMetaEntry
      | undefined;
    if (!metaEntry) return null;

    const { title, fullTitle } = this.extractTitle(entries);
    const provider = this.determineProviderFromEntries(entries);
    const summary: SessionSummary = {
      id: agentId,
      projectId: "codex-subagent" as UrlProjectId,
      title,
      fullTitle,
      createdAt: metaEntry.payload.timestamp,
      updatedAt: sessionFile.timestamp,
      messageCount: this.countMessages(entries),
      ownership: { owner: "none" },
      provider,
    };
    const loaded: LoadedSession = {
      summary,
      data: {
        provider,
        session: { entries },
      },
    };
    const session = normalizeSession(loaded);

    return {
      messages: session.messages.map((message) => ({
        ...message,
        isSubagent: true,
      })),
      status: inferCodexAgentStatus(entries),
    };
  }

  /**
   * Scan the sessions directory and find all session files.
   */
  private async scanSessions(
    options?: CodexScanOptions,
  ): Promise<CodexSessionFile[]> {
    const cacheKey = this.getSharedScanCacheKey(options);
    const cached = codexSharedScanCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < CODEX_SCAN_CACHE_TTL_MS) {
      const metrics = createCodexSessionReaderScanMetrics({
        sessionsDir: this.sessionsDir,
        projectPath: this.projectPath,
        activeAfterMs: options?.activeAfterMs,
        cacheKey,
        sharedCacheStatus: cached.inFlight ? "in-flight" : "hit",
      });
      const startedAt = Date.now();
      if (cached.inFlight) {
        const sessions = await cached.inFlight;
        this.hydrateSessionFileCache(sessions);
        const visibleSessions = this.filterVisibleSessionsForScanMetrics(
          sessions,
          metrics,
        );
        metrics.durationMs = Date.now() - startedAt;
        this.recordScanMetrics(metrics);
        return visibleSessions;
      }
      this.hydrateSessionFileCache(cached.sessions);
      const visibleSessions = this.filterVisibleSessionsForScanMetrics(
        cached.sessions,
        metrics,
      );
      metrics.durationMs = Date.now() - startedAt;
      this.recordScanMetrics(metrics);
      return visibleSessions;
    }

    const metrics = createCodexSessionReaderScanMetrics({
      sessionsDir: this.sessionsDir,
      projectPath: this.projectPath,
      activeAfterMs: options?.activeAfterMs,
      cacheKey,
      sharedCacheStatus: "miss",
    });
    const startedAt = Date.now();
    const inFlight = this.scanSessionsUncached(options, metrics);
    codexSharedScanCache.set(cacheKey, {
      timestamp: now,
      sessions: [],
      inFlight,
    });

    try {
      const sessions = await inFlight;
      codexSharedScanCache.set(cacheKey, {
        timestamp: Date.now(),
        sessions,
      });
      this.hydrateSessionFileCache(sessions);
      const visibleSessions = this.filterVisibleSessionsForScanMetrics(
        sessions,
        metrics,
      );
      metrics.durationMs = Date.now() - startedAt;
      this.recordScanMetrics(metrics);
      return visibleSessions;
    } catch (error) {
      metrics.durationMs = Date.now() - startedAt;
      this.recordScanMetrics(metrics);
      const entry = codexSharedScanCache.get(cacheKey);
      if (entry?.inFlight === inFlight) {
        codexSharedScanCache.delete(cacheKey);
      }
      throw error;
    }
  }

  private getSharedScanCacheKey(options?: CodexScanOptions): string {
    return `${this.sessionsDir}::activeAfter=${options?.activeAfterMs ?? "all"}`;
  }

  private hydrateSessionFileCache(sessions: CodexSessionFile[]): void {
    for (const session of sessions) {
      this.sessionFileCache.set(session.id, session);
    }
  }

  private filterVisibleSessionsForScanMetrics(
    sessions: CodexSessionFile[],
    metrics: CodexSessionReaderScanMetrics,
  ): CodexSessionFile[] {
    const visibleSessions = sessions.filter((session) => {
      if (session.isSubagent) {
        metrics.subagentSessionsSkipped += 1;
        return false;
      }
      return true;
    });
    metrics.sessionsReturned = visibleSessions.length;
    return visibleSessions;
  }

  private recordScanMetrics(metrics: CodexSessionReaderScanMetrics): void {
    this.lastScanMetrics = cloneCodexSessionReaderScanMetrics(metrics);
    const payload = {
      event: "codex_reader_scan",
      ...metrics,
    };
    if (metrics.durationMs >= this.slowLogThresholdMs) {
      getLogger().warn(payload, "CODEX_READER: slow scan");
      return;
    }
    getLogger().debug(payload, "CODEX_READER: scan complete");
  }

  private async scanSessionsUncached(
    options?: CodexScanOptions,
    metrics?: CodexSessionReaderScanMetrics,
  ): Promise<CodexSessionFile[]> {
    const sessions: CodexSessionFile[] = [];
    try {
      await stat(this.sessionsDir);
      if (metrics) metrics.sessionsDirExists = true;
    } catch {
      return sessions;
    }

    const files = await this.findJsonlFiles(this.sessionsDir, metrics);

    for (const filePath of files) {
      const activeWindowSkipsBefore = metrics?.discovery.activeWindowSkips ?? 0;
      const session = await this.readSessionMeta(filePath, options, metrics);
      if (session) {
        sessions.push(session);
      } else if (
        metrics &&
        metrics.discovery.activeWindowSkips === activeWindowSkipsBefore
      ) {
        metrics.failedFiles += 1;
      }
    }
    await this.discoveryIndex?.flush();
    if (metrics) {
      metrics.sessionsParsed = sessions.length;
    }

    return sessions;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    return sessionFile?.filePath ?? null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `codex::${sessionDir}::${this.projectPath ?? "*"}`;
  }

  async listSessionFiles(
    _sessionDir: string,
    options?: CodexScanOptions,
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const sessions = await this.scanSessions(options);

    return sessions
      .filter(
        (session) =>
          (!this.projectPath ||
            canonicalizeProjectPath(session.cwd) === this.projectPath) &&
          (!options?.activeAfterMs || session.mtime >= options.activeAfterMs),
      )
      .map((session) => ({
        sessionId: session.id,
        filePath: session.filePath,
      }));
  }

  /**
   * Find a session file by ID.
   */
  private async findSessionFile(
    sessionId: string,
  ): Promise<CodexSessionFile | null> {
    // Check cache first
    const cached = this.sessionFileCache.get(sessionId);
    if (cached) return cached;

    // Scan if cache miss
    await this.scanSessions();
    return this.sessionFileCache.get(sessionId) ?? null;
  }

  private async readEntries(
    sessionId: string,
    filePath: string,
  ): Promise<CodexSessionEntry[]> {
    const stats = await stat(filePath);
    const cached = this.entryCache.get(sessionId);

    if (
      cached &&
      cached.filePath === filePath &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs
    ) {
      cached.entries = dedupeCodexEntries(cached.entries);
      return cached.entries.slice();
    }

    if (
      cached &&
      cached.filePath === filePath &&
      !isCompressedCodexSessionFile(filePath) &&
      cached.size < stats.size
    ) {
      const appended = await this.readFileRange(
        filePath,
        cached.size,
        stats.size - cached.size,
      );
      const { entries, partialLine } = parseCodexJsonlChunk(
        cached.partialLine + appended,
        stats.size > cached.size,
      );
      cached.entries.push(...entries);
      cached.entries = dedupeCodexEntries(cached.entries);
      cached.partialLine = partialLine;
      cached.size = stats.size;
      cached.mtimeMs = stats.mtimeMs;
      return cached.entries.slice();
    }

    const lines = await readJsonlLines(filePath);
    const entries: CodexSessionEntry[] = [];
    for (const line of lines) {
      const entry = parseCodexSessionEntry(line);
      if (entry) {
        entries.push(entry);
      }
    }
    const dedupedEntries = dedupeCodexEntries(entries);
    this.entryCache.set(sessionId, {
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      entries: dedupedEntries,
      partialLine: "",
    });
    return dedupedEntries.slice();
  }

  private async readFileRange(
    filePath: string,
    start: number,
    length: number,
  ): Promise<string> {
    if (length <= 0) {
      return "";
    }

    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.toString("utf-8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /**
   * Recursively find all Codex rollout files in a directory.
   */
  private async findJsonlFiles(
    dir: string,
    metrics?: CodexSessionReaderScanMetrics,
  ): Promise<string[]> {
    const files: string[] = [];
    await this.collectJsonlFiles(dir, files, metrics);
    const preferredFiles = preferPlainCodexRollouts(files);
    if (metrics) {
      metrics.rolloutFilesAfterPrecedence = preferredFiles.length;
      metrics.precedenceSkippedCompressed =
        files.length - preferredFiles.length;
    }
    return preferredFiles;
  }

  private async collectJsonlFiles(
    dir: string,
    files: string[],
    metrics?: CodexSessionReaderScanMetrics,
  ): Promise<void> {
    try {
      if (metrics) metrics.directoriesVisited += 1;
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.collectJsonlFiles(fullPath, files, metrics);
        } else if (entry.isFile() && isCodexRolloutFileName(entry.name)) {
          files.push(fullPath);
          if (metrics) {
            metrics.rolloutFilesFound += 1;
            if (codexRolloutRepresentation(fullPath) === "zstd") {
              metrics.compressedRolloutFiles += 1;
            } else {
              metrics.plainRolloutFiles += 1;
            }
          }
        }
      }
    } catch {
      if (metrics) metrics.directoryReadErrors += 1;
      // Ignore errors (permission denied, etc.)
    }
  }

  /**
   * Read session metadata from the first line of a file.
   */
  private async readSessionMeta(
    filePath: string,
    options?: CodexScanOptions,
    metrics?: CodexSessionReaderScanMetrics,
  ): Promise<CodexSessionFile | null> {
    try {
      const session = await readCodexRolloutMetadata({
        sessionsDir: this.sessionsDir,
        filePath,
        ...(this.discoveryIndex ? { discoveryIndex: this.discoveryIndex } : {}),
        ...(options?.activeAfterMs !== undefined
          ? { activeAfterMs: options.activeAfterMs }
          : {}),
        ...(metrics ? { metrics: metrics.discovery } : {}),
      });
      if (!session) return null;
      return {
        id: session.id,
        filePath,
        cwd: session.cwd,
        timestamp: session.timestamp,
        mtime: session.mtime,
        size: session.size,
        isSubagent: session.isSubagent,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract title from entries (first user message).
   */
  private extractTitle(entries: CodexSessionEntry[]): {
    title: string | null;
    fullTitle: string | null;
  } {
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);
    const skipLeadingSystemPrompts = true;

    // Find first user message
    for (const entry of entries) {
      if (
        !hasResponseItemUser &&
        entry.type === "event_msg" &&
        entry.payload.type === "user_message"
      ) {
        const fullTitle = entry.payload.message.trim();
        if (
          skipLeadingSystemPrompts &&
          this.isSystemPromptUserMessage(fullTitle)
        ) {
          continue;
        }
        const title = truncateSessionTitle(fullTitle) || null;
        return { title, fullTitle };
      }

      if (entry.type === "response_item") {
        const payload = entry.payload;
        if (payload.type === "message" && payload.role === "user") {
          const text = payload.content
            .map((c) => ("text" in c ? c.text : ""))
            .join("\n")
            .trim();
          if (
            text &&
            !(skipLeadingSystemPrompts && this.isSystemPromptUserMessage(text))
          ) {
            const title = truncateSessionTitle(text) || null;
            return { title, fullTitle: text };
          }
        }
      }
    }

    return { title: null, fullTitle: null };
  }

  private isSystemPromptUserMessage(text: string): boolean {
    const trimmed = text.trimStart();
    return (
      trimmed.startsWith("# AGENTS.md instructions") ||
      trimmed.startsWith("<environment_context>")
    );
  }

  /**
   * Count user/assistant messages in entries.
   *
   * Matches the logic in convertEntriesToMessages - we count user_message
   * events and response_item messages, but not agent_message events since
   * those are streaming duplicates.
   */
  private countMessages(entries: CodexSessionEntry[]): number {
    let count = 0;
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);

    for (const entry of entries) {
      if (entry.type === "event_msg") {
        // Only count user_message events (not agent_message streaming tokens)
        if (entry.payload.type === "user_message" && !hasResponseItemUser) {
          count++;
        }
      } else if (entry.type === "response_item") {
        if (entry.payload.type === "message") {
          if (
            entry.payload.role === "user" ||
            entry.payload.role === "assistant"
          ) {
            count++;
          }
        }
      }
    }

    return count;
  }

  /**
   * Extract context usage from token_count events.
   *
   * @param entries - Codex session entries
   * @param model - Model ID for determining context window size (fallback)
   * @param provider - Provider for model-less context-window fallback
   */
  private extractContextUsage(
    entries: CodexSessionEntry[],
    model: string | undefined,
    provider: "codex" | "codex-oss",
  ): ContextUsage | undefined {
    // Find last token_count event
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry &&
        entry.type === "event_msg" &&
        entry.payload.type === "token_count"
      ) {
        const info = entry.payload.info;
        if (info?.last_token_usage || info?.total_token_usage) {
          // Codex context meter is based on the latest turn's input_tokens,
          // not cumulative totals and not cached-input totals.
          const usage = info.last_token_usage ?? info.total_token_usage;
          if (!usage) continue;
          const inputTokens = usage.input_tokens;

          if (inputTokens === 0) continue;

          // Prefer model_context_window from Codex if available, fall back to model-based lookup
          const contextWindow =
            info.model_context_window && info.model_context_window > 0
              ? info.model_context_window
              : getModelContextWindow(model, provider);
          const percentage = Math.min(
            100,
            Math.round((inputTokens / contextWindow) * 100),
          );

          return { inputTokens, percentage, contextWindow };
        }
      }
    }

    return undefined;
  }

  /**
   * Extract the model from turn_context entries.
   */
  private extractModel(entries: CodexSessionEntry[]): string | undefined {
    // Last turn_context with a model: per-turn context tracks the model the
    // session is currently using, which can change mid-transcript.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type === "turn_context" && entry.payload.model) {
        return entry.payload.model;
      }
    }
    return undefined;
  }

  /**
   * Extract the first turn_context entry, which captures session launch policy.
   */
  private extractTurnContext(
    entries: CodexSessionEntry[],
  ): CodexTurnContextEntry | undefined {
    for (const entry of entries) {
      if (entry.type === "turn_context") {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Determine provider based on session metadata or model.
   */
  private determineProvider(
    metaEntry: CodexSessionMetaEntry,
    model?: string,
  ): "codex" | "codex-oss" {
    // Check explicit provider field if available
    if (metaEntry.payload.model_provider) {
      const provider = metaEntry.payload.model_provider.toLowerCase();
      if (
        provider === "ollama" ||
        provider === "lmstudio" ||
        provider === "local"
      ) {
        return "codex-oss";
      }
      if (provider === "openai" || provider === "azure") {
        return "codex";
      }
    }

    // fallback: check model name for known local models if provider not set
    if (model) {
      const lowerModel = model.toLowerCase();
      // Heuristic: models starting with "gpt-" or "o1-" are usually OpenAI
      if (lowerModel.startsWith("gpt-") || lowerModel.startsWith("o1-")) {
        return "codex";
      }
      // Heuristic: other models often implying local usage (llama, mistral, qwen, etc)
      // or if we just default to everything else being oss?
      // For safety, let's just stick to specific local keywords for now to avoid false positives.
      if (
        lowerModel.includes("llama") ||
        lowerModel.includes("mistral") ||
        lowerModel.includes("qwen") ||
        lowerModel.includes("gemma") ||
        lowerModel.includes("deepseek") ||
        lowerModel.includes("phi")
      ) {
        return "codex-oss";
      }
    }

    // Default to codex if we can't be sure
    return "codex";
  }

  /**
   * Helper to determine provider from a list of entries.
   */
  private determineProviderFromEntries(
    entries: CodexSessionEntry[],
  ): "codex" | "codex-oss" {
    const metaEntry = entries.find((e) => e.type === "session_meta") as
      | CodexSessionMetaEntry
      | undefined;

    if (!metaEntry) return "codex";

    const model = this.extractModel(entries);
    return this.determineProvider(metaEntry, model);
  }

  private hasResponseItemUserMessages(entries: CodexSessionEntry[]): boolean {
    return entries.some(
      (entry) =>
        entry.type === "response_item" &&
        entry.payload.type === "message" &&
        entry.payload.role === "user",
    );
  }
}

function createCodexSessionReaderScanMetrics(options: {
  sessionsDir: string;
  projectPath?: string;
  activeAfterMs?: number;
  cacheKey: string;
  sharedCacheStatus: CodexSessionReaderScanCacheStatus;
}): CodexSessionReaderScanMetrics {
  return {
    sessionsDir: options.sessionsDir,
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    ...(options.activeAfterMs !== undefined
      ? { activeAfterMs: options.activeAfterMs }
      : {}),
    cacheKey: options.cacheKey,
    sharedCacheStatus: options.sharedCacheStatus,
    durationMs: 0,
    sessionsDirExists: false,
    directoriesVisited: 0,
    directoryReadErrors: 0,
    rolloutFilesFound: 0,
    rolloutFilesAfterPrecedence: 0,
    plainRolloutFiles: 0,
    compressedRolloutFiles: 0,
    precedenceSkippedCompressed: 0,
    sessionsParsed: 0,
    failedFiles: 0,
    subagentSessionsSkipped: 0,
    sessionsReturned: 0,
    discovery: createCodexRolloutDiscoveryStats(),
  };
}

function codexSessionSourceLabel(source: unknown): string | undefined {
  if (typeof source === "string") {
    const trimmed = source.trim();
    return trimmed || undefined;
  }

  if (isRecord(source) && isRecord(source.subagent)) {
    return "subagent";
  }

  return undefined;
}

function parseCodexSpawnAgentOutput(output: unknown): string | null {
  const text = codexToolOutputText(output);
  if (!text) {
    return null;
  }

  const parsed = parseJsonRecord(text);
  const agentId =
    stringField(parsed, "agent_id") ?? stringField(parsed, "agentId");
  if (agentId) {
    return agentId;
  }

  return (
    text.match(/"agent_id"\s*:\s*"([^"]+)"/)?.[1] ??
    text.match(/"agentId"\s*:\s*"([^"]+)"/)?.[1] ??
    null
  );
}

function codexToolOutputText(output: unknown): string {
  if (typeof output === "string") {
    return output.trim();
  }

  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .map((item) =>
      isRecord(item) && typeof item.text === "string" ? item.text : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferCodexAgentStatus(
  entries: CodexSessionEntry[],
): "pending" | "running" | "completed" | "failed" {
  let sawTaskStarted = false;
  let sawTaskComplete = false;
  let sawTurnAborted = false;
  let sawAssistantMessage = false;

  for (const entry of entries) {
    if (entry.type === "event_msg") {
      if (entry.payload.type === "task_started") {
        sawTaskStarted = true;
        sawTaskComplete = false;
      } else if (entry.payload.type === "task_complete") {
        sawTaskComplete = true;
      } else if (entry.payload.type === "turn_aborted") {
        sawTurnAborted = true;
      }
      continue;
    }

    if (
      entry.type === "response_item" &&
      entry.payload.type === "message" &&
      entry.payload.role === "assistant"
    ) {
      sawAssistantMessage = true;
    }
  }

  if (sawTurnAborted) {
    return "failed";
  }
  if (sawTaskStarted && !sawTaskComplete) {
    return "running";
  }
  if (sawTaskComplete || sawAssistantMessage) {
    return "completed";
  }
  return "pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneCodexSessionReaderScanMetrics(
  metrics: CodexSessionReaderScanMetrics,
): CodexSessionReaderScanMetrics {
  return {
    ...metrics,
    discovery: { ...metrics.discovery },
  };
}
