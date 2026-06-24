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
import { canonicalizeProjectPath } from "../projects/paths.js";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import { readFirstLine, readJsonlLines } from "../utils/jsonl.js";
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

const CODEX_META_READ_MAX_BYTES = 1024 * 1024;
const CODEX_SCAN_CACHE_TTL_MS = 5000;

interface CodexScanOptions {
  activeAfterMs?: number;
}

interface CodexSharedScanCacheEntry {
  timestamp: number;
  sessions: CodexSessionFile[];
  inFlight?: Promise<CodexSessionFile[]>;
}

const codexSharedScanCache = new Map<string, CodexSharedScanCacheEntry>();

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

  // Cache of session ID -> file path for quick lookups
  private sessionFileCache: Map<string, CodexSessionFile> = new Map();
  private entryCache: Map<string, CodexEntryCache> = new Map();

  constructor(options: CodexSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
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
        source: metaEntry.payload.source,
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

  /**
   * Codex doesn't have subagent sessions like Claude.
   * Returns empty array for compatibility.
   */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /**
   * Codex doesn't have subagent sessions like Claude.
   * Returns null for compatibility.
   */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
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
      if (cached.inFlight) {
        const sessions = await cached.inFlight;
        this.hydrateSessionFileCache(sessions);
        return sessions.filter((session) => !session.isSubagent);
      }
      this.hydrateSessionFileCache(cached.sessions);
      return cached.sessions.filter((session) => !session.isSubagent);
    }

    const inFlight = this.scanSessionsUncached(options);
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
      return sessions.filter((session) => !session.isSubagent);
    } catch (error) {
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

  private async scanSessionsUncached(
    options?: CodexScanOptions,
  ): Promise<CodexSessionFile[]> {
    const sessions: CodexSessionFile[] = [];
    const files = await this.findJsonlFiles(this.sessionsDir);

    for (const filePath of files) {
      const session = await this.readSessionMeta(filePath, options);
      if (session) {
        sessions.push(session);
      }
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

    if (cached && cached.filePath === filePath && cached.size < stats.size) {
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
   * Recursively find all .jsonl files in a directory.
   */
  private async findJsonlFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const subFiles = await this.findJsonlFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore errors (permission denied, etc.)
    }

    return files;
  }

  /**
   * Read session metadata from the first line of a file.
   */
  private async readSessionMeta(
    filePath: string,
    options?: CodexScanOptions,
  ): Promise<CodexSessionFile | null> {
    try {
      const stats = await stat(filePath);
      if (options?.activeAfterMs && stats.mtimeMs < options.activeAfterMs) {
        return null;
      }

      const firstLine = await readFirstLine(
        filePath,
        CODEX_META_READ_MAX_BYTES,
      );

      if (!firstLine) return null;

      const entry = parseCodexSessionEntry(firstLine);
      if (entry?.type !== "session_meta") return null;

      const meta = entry.payload;

      return {
        id: meta.id,
        filePath,
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        mtime: stats.mtimeMs,
        size: stats.size,
        isSubagent: this.isSubagentSessionMeta(meta),
      };
    } catch {
      return null;
    }
  }

  private isSubagentSessionMeta(
    meta: CodexSessionMetaEntry["payload"],
  ): boolean {
    if (
      !("forked_from_id" in meta) ||
      typeof meta.forked_from_id !== "string"
    ) {
      return false;
    }

    const source = meta.source;
    if (!source || typeof source !== "object") return false;

    const subagentSource = source as {
      subagent?: { thread_spawn?: { parent_thread_id?: string } };
    };

    return (
      typeof subagentSource.subagent?.thread_spawn?.parent_thread_id ===
      "string"
    );
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
