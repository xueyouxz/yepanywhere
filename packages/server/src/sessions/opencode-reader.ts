import { spawn } from "node:child_process";
import {
  type FileHandle,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpenCodeMessage,
  type OpenCodeSessionEntry,
  type OpenCodeStoredPart,
  type UrlProjectId,
  getModelContextWindow,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";

/** Default OpenCode storage directory */
export const OPENCODE_STORAGE_DIR = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "storage",
);

const OPENCODE_DATA_DIR =
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
export const OPENCODE_DB_PATH = join(
  OPENCODE_DATA_DIR,
  "opencode",
  "opencode.db",
);
const OPENCODE_CLI_TIMEOUT_MS = 10_000;
const OPENCODE_CLI_MAX_SESSIONS = 200;

/**
 * OpenCode storage directory structure:
 * ~/.local/share/opencode/storage/
 *   project/{projectId}.json        - Project metadata
 *   session/{projectId}/{sessionId}.json  - Session metadata
 *   message/{sessionId}/{messageId}.json  - Message metadata
 *   part/{messageId}/{partId}.json        - Message parts (text, tool-use, tool-result)
 */

export interface OpenCodeSessionReaderOptions {
  /** Base storage directory (e.g., ~/.local/share/opencode/storage) */
  storageDir?: string;
  /** OpenCode SQLite database path, used only as an index stat anchor. */
  databasePath?: string;
  /** OpenCode executable used for 1.15+ CLI export/list fallbacks. */
  opencodePath?: string;
  /** Project path (used to look up the OpenCode project ID) */
  projectPath: string;
}

/**
 * OpenCode JSON file schemas (simplified for reading)
 */
interface OpenCodeProjectJson {
  id: string;
  worktree: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

interface OpenCodeSessionJson {
  id: string;
  version?: string;
  projectID: string;
  directory?: string;
  title?: string;
  parentID?: string;
  time?: {
    created?: number;
    updated?: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

interface OpenCodeCliListSession {
  id?: unknown;
  title?: unknown;
  directory?: unknown;
  created?: unknown;
  updated?: unknown;
  projectId?: unknown;
  projectID?: unknown;
}

interface OpenCodeExportSessionInfo {
  id?: unknown;
  directory?: unknown;
  title?: unknown;
  projectID?: unknown;
  model?: unknown;
  time?: {
    created?: unknown;
    updated?: unknown;
  };
}

interface OpenCodeExportMessage {
  info?: unknown;
  parts?: unknown;
}

interface OpenCodeExport {
  info?: OpenCodeExportSessionInfo;
  messages?: OpenCodeExportMessage[];
}

// Use OpenCodeMessage and OpenCodeStoredPart types from shared

/**
 * Find the OpenCode project ID for a given project path by scanning project files.
 *
 * OpenCode uses an opaque hash as project ID. This function reads all project
 * JSON files and returns the ID whose worktree matches the given path.
 *
 * @param projectPath - The absolute path to the project directory
 * @param storageDir - The OpenCode storage directory (default: ~/.local/share/opencode/storage)
 * @returns The OpenCode project ID, or null if not found
 */
export async function findOpenCodeProjectId(
  projectPath: string,
  storageDir: string = OPENCODE_STORAGE_DIR,
): Promise<string | null> {
  const projectDir = join(storageDir, "project");

  try {
    const files = await readdir(projectDir);
    const jsonFiles = files.filter(
      (f) => f.endsWith(".json") && f !== "global.json",
    );

    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(projectDir, file), "utf-8");
        const project = JSON.parse(content) as OpenCodeProjectJson;
        if (project.worktree === projectPath) {
          return project.id;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return null;
}

/**
 * OpenCode-specific session reader for OpenCode's file-based storage.
 *
 * OpenCode stores sessions in a directory structure rather than JSONL files:
 * - Project info in project/{id}.json
 * - Sessions in session/{projectId}/{sessionId}.json
 * - Messages in message/{sessionId}/{messageId}.json
 * - Parts (content) in part/{messageId}/{partId}.json
 */
export class OpenCodeSessionReader implements ISessionReader {
  private storageDir: string;
  private databasePath: string;
  private opencodePath: string;
  private projectPath: string;
  private openCodeProjectIdCache: string | null | undefined = undefined;

  constructor(options: OpenCodeSessionReaderOptions) {
    this.storageDir = options.storageDir ?? OPENCODE_STORAGE_DIR;
    this.databasePath = options.databasePath ?? OPENCODE_DB_PATH;
    this.opencodePath = options.opencodePath ?? "opencode";
    this.projectPath = options.projectPath;
  }

  /**
   * Get the OpenCode project ID, looking it up lazily from storage.
   * Returns null if no OpenCode project exists for this path.
   */
  private async getOpenCodeProjectId(): Promise<string | null> {
    if (this.openCodeProjectIdCache !== undefined) {
      return this.openCodeProjectIdCache;
    }
    this.openCodeProjectIdCache = await findOpenCodeProjectId(
      this.projectPath,
      this.storageDir,
    );
    return this.openCodeProjectIdCache;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const seen = new Set<string>();

    for (const summary of await this.listFileSessions(projectId)) {
      summaries.push(summary);
      seen.add(summary.id);
    }

    for (const summary of await this.listCliSessions(projectId)) {
      if (seen.has(summary.id)) continue;
      summaries.push(summary);
      seen.add(summary.id);
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
    return (
      (await this.getFileSessionSummary(sessionId, projectId)) ??
      (await this.getCliSessionSummary(sessionId, projectId))
    );
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const fileSummary = await this.getFileSessionSummary(sessionId, projectId);
    if (fileSummary) {
      const messages = await this.loadSessionMessages(sessionId, afterMessageId);
      return {
        summary: fileSummary,
        data: {
          provider: "opencode",
          session: {
            messages,
          },
        },
      };
    }

    const exported = await this.loadCliExport(sessionId);
    if (!exported || !this.exportBelongsToProject(exported)) return null;
    const entries = this.exportMessagesToEntries(exported, afterMessageId);
    if (entries.length === 0) return null;
    const summary = this.summaryFromExport(exported, entries, projectId);
    if (!summary) return null;

    return {
      summary,
      data: {
        provider: "opencode",
        session: {
          messages: entries,
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
    const fileChanged = await this.getFileSessionSummaryIfChanged(
      sessionId,
      projectId,
      cachedMtime,
      cachedSize,
    );
    if (fileChanged) {
      return fileChanged;
    }

    const summary = await this.getCliSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const mtime = Date.parse(summary.updatedAt);
    const size = summary.messageCount;
    if (mtime === cachedMtime && size === cachedSize) {
      return null;
    }

    return { summary, mtime, size };
  }

  async getSessionFilePath(_sessionId: string): Promise<string | null> {
    return this.databasePath;
  }

  async listSessionFiles(
    _sessionDir: string,
    options?: { activeAfterMs?: number },
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const out: { sessionId: string; filePath: string }[] = [];
    const seen = new Set<string>();

    // File-storage sessions: storage/session/{openCodeProjectId}/*.json.
    // These are the bulk of OpenCode sessions. The session index enumerates via
    // this method (not listSessions), so omitting file sessions here meant they
    // never appeared in project listings even though listSessions returns them.
    // Use the session json path as filePath so the index gets per-session mtime.
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (openCodeProjectId) {
      const sessionDir = join(this.storageDir, "session", openCodeProjectId);
      try {
        for (const file of await readdir(sessionDir)) {
          if (!file.endsWith(".json")) continue;
          const sessionId = file.replace(".json", "");
          out.push({ sessionId, filePath: join(sessionDir, file) });
          seen.add(sessionId);
        }
      } catch {
        // Session dir missing/unreadable — fall through to CLI sessions.
      }
    }

    // CLI-listed sessions (e.g. other stores), deduped against file sessions.
    const cliSessions = await this.loadCliSessionList();
    for (const session of cliSessions) {
      if (!this.cliListSessionBelongsToProject(session)) continue;
      const sessionId = String(session.id);
      if (seen.has(sessionId)) continue;
      if (options?.activeAfterMs !== undefined) {
        const updatedAt = this.numberField(session.updated);
        if (updatedAt !== undefined && updatedAt < options.activeAfterMs) {
          continue;
        }
      }
      out.push({ sessionId, filePath: this.databasePath });
      seen.add(sessionId);
    }

    return out;
  }

  getIndexScopeKey(_sessionDir: string): string {
    return `opencode::${this.projectPath}`;
  }

  private async listFileSessions(
    projectId: UrlProjectId,
  ): Promise<SessionSummary[]> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return [];
    }

    const summaries: SessionSummary[] = [];
    const sessionDir = join(this.storageDir, "session", openCodeProjectId);

    try {
      const files = await readdir(sessionDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        const sessionId = file.replace(".json", "");
        const summary = await this.getFileSessionSummary(sessionId, projectId);
        if (summary) {
          summaries.push(summary);
        }
      }
    } catch {
      // Directory doesn't exist or not readable
      return [];
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  private async getFileSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return null;
    }

    const sessionPath = join(
      this.storageDir,
      "session",
      openCodeProjectId,
      `${sessionId}.json`,
    );

    try {
      const content = await readFile(sessionPath, "utf-8");
      const session = JSON.parse(content) as OpenCodeSessionJson;

      // Get message count and first user message for title
      const messageDir = join(this.storageDir, "message", sessionId);
      let messageCount = 0;
      let firstUserMessageText: string | null = null;
      let model: string | undefined;

      try {
        const messageFiles = await readdir(messageDir);
        const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));
        messageCount = jsonFiles.length;

        // Sort by filename (which contains timestamp) to get chronological order
        jsonFiles.sort();

        // Find first user message and model
        for (const file of jsonFiles) {
          const msgPath = join(messageDir, file);
          try {
            const msgContent = await readFile(msgPath, "utf-8");
            const msg = JSON.parse(msgContent) as OpenCodeMessage;

            // Track the latest assistant model (a session's model can
            // change mid-transcript); files iterate in chronological order.
            if (msg.role === "assistant" && msg.modelID) {
              model = msg.modelID;
            }

            // Get first user message text
            if (!firstUserMessageText && msg.role === "user") {
              const text = await this.getMessageText(msg.id);
              if (text) {
                firstUserMessageText = text;
              }
            }

            // Stop if we have both
            if (model && firstUserMessageText) break;
          } catch {
            // Skip unreadable messages
          }
        }
      } catch {
        // No messages yet
      }

      // Skip sessions with no messages
      if (messageCount === 0) {
        return null;
      }

      const stats = await stat(sessionPath);
      const contextUsage = await this.extractContextUsage(sessionId, model);

      // Use session title if available, otherwise first user message
      const fullTitle = session.title || firstUserMessageText?.trim() || null;

      return {
        id: sessionId,
        projectId,
        title: this.truncateTitle(fullTitle),
        fullTitle,
        createdAt: session.time?.created
          ? new Date(session.time.created).toISOString()
          : stats.birthtime.toISOString(),
        updatedAt: session.time?.updated
          ? new Date(session.time.updated).toISOString()
          : stats.mtime.toISOString(),
        messageCount,
        ownership: { owner: "none" }, // Will be updated by Supervisor
        contextUsage,
        provider: "opencode",
        model,
      };
    } catch {
      return null;
    }
  }

  private async getFileSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const openCodeProjectId = await this.getOpenCodeProjectId();
    if (!openCodeProjectId) {
      return null;
    }

    const sessionPath = join(
      this.storageDir,
      "session",
      openCodeProjectId,
      `${sessionId}.json`,
    );

    try {
      const stats = await stat(sessionPath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      // Otherwise parse the file and return { summary, mtime, size }
      const summary = await this.getFileSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  private async listCliSessions(
    projectId: UrlProjectId,
  ): Promise<SessionSummary[]> {
    const sessions = await this.loadCliSessionList();
    const summaries: SessionSummary[] = [];

    for (const session of sessions) {
      if (!this.cliListSessionBelongsToProject(session)) continue;
      const summary = this.summaryFromCliListSession(session, projectId);
      if (summary) summaries.push(summary);
    }

    return summaries;
  }

  private async getCliSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const exported = await this.loadCliExport(sessionId);
    if (!exported || !this.exportBelongsToProject(exported)) return null;

    const entries = this.exportMessagesToEntries(exported);
    if (entries.length === 0) return null;

    return this.summaryFromExport(exported, entries, projectId);
  }

  private async loadCliSessionList(): Promise<OpenCodeCliListSession[]> {
    const output = await this.runOpenCodeCli([
      "session",
      "list",
      "--format",
      "json",
      "--max-count",
      String(OPENCODE_CLI_MAX_SESSIONS),
    ]);
    if (!output) return [];

    const parsed = this.parseJsonOutput(output);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((value): value is OpenCodeCliListSession => {
      if (!value || typeof value !== "object") return false;
      return Boolean(this.stringField((value as OpenCodeCliListSession).id));
    });
  }

  private async loadCliExport(sessionId: string): Promise<OpenCodeExport | null> {
    const output = await this.runOpenCodeCli(["export", sessionId]);
    if (!output) return null;

    const parsed = this.parseJsonOutput(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as OpenCodeExport;
  }

  private async runOpenCodeCli(args: string[]): Promise<string | null> {
    // Capture stdout into a real file fd, not a pipe. `opencode` is a Bun
    // binary that drops buffered piped stdout on process.exit() once it
    // exceeds the kernel pipe buffer, so large `export` JSON was truncated
    // mid-string (execFile) and failed to parse — blanking session reload.
    // A regular file fd is lossless. See topics/opencode-backend.md
    // "Durable Storage Format".
    const tmpFile = join(
      tmpdir(),
      `ya-opencode-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.json`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(tmpFile, "w");
    } catch {
      return null;
    }

    try {
      const fd = handle.fd;
      const exitedOk = await new Promise<boolean>((resolve) => {
        const child = spawn(this.opencodePath, args, {
          cwd: this.projectPath,
          stdio: ["ignore", fd, "ignore"],
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(false);
        }, OPENCODE_CLI_TIMEOUT_MS);
        child.on("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      });

      await handle.close();
      handle = undefined;

      if (!exitedOk) return null;
      return await readFile(tmpFile, "utf8");
    } catch {
      return null;
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
      await unlink(tmpFile).catch(() => {});
    }
  }

  private parseJsonOutput(output: string): unknown {
    const trimmed = output.trim();
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    if (starts.length === 0) return null;
    const jsonStart = Math.min(...starts);

    try {
      return JSON.parse(trimmed.slice(jsonStart));
    } catch {
      return null;
    }
  }

  private cliListSessionBelongsToProject(
    session: OpenCodeCliListSession,
  ): boolean {
    const directory = this.stringField(session.directory);
    return !directory || directory === this.projectPath;
  }

  private exportBelongsToProject(exported: OpenCodeExport): boolean {
    const directory = this.stringField(exported.info?.directory);
    return !directory || directory === this.projectPath;
  }

  private exportMessagesToEntries(
    exported: OpenCodeExport,
    afterMessageId?: string,
  ): OpenCodeSessionEntry[] {
    const messages = Array.isArray(exported.messages)
      ? exported.messages
      : [];
    const entries: OpenCodeSessionEntry[] = [];
    let foundAfterMessage = !afterMessageId;

    for (const exportedMessage of messages) {
      const message = this.asOpenCodeMessage(exportedMessage.info);
      if (!message) continue;

      if (!foundAfterMessage) {
        if (message.id === afterMessageId) {
          foundAfterMessage = true;
        }
        continue;
      }

      const parts = Array.isArray(exportedMessage.parts)
        ? exportedMessage.parts
            .map((part) => this.asOpenCodeStoredPart(part))
            .filter((part): part is OpenCodeStoredPart => Boolean(part))
        : [];
      entries.push({ message, parts });
    }

    return entries;
  }

  private asOpenCodeMessage(value: unknown): OpenCodeMessage | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const id = this.stringField(raw.id);
    const role = this.stringField(raw.role);
    if (!id || (role !== "user" && role !== "assistant")) {
      return null;
    }
    const sessionID =
      this.stringField(raw.sessionID) ??
      this.stringField(raw.sessionId) ??
      this.stringField(raw.session_id) ??
      "";

    return {
      ...raw,
      id,
      sessionID,
      role,
    } as OpenCodeMessage;
  }

  private asOpenCodeStoredPart(value: unknown): OpenCodeStoredPart | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const type = this.stringField(raw.type);
    if (!type) return null;
    return raw as OpenCodeStoredPart;
  }

  private summaryFromCliListSession(
    session: OpenCodeCliListSession,
    projectId: UrlProjectId,
  ): SessionSummary | null {
    const id = this.stringField(session.id);
    if (!id) return null;

    const title = this.stringField(session.title)?.trim() || null;
    const updatedAt = this.dateFromMillis(
      this.numberField(session.updated) ?? this.numberField(session.created),
    );
    const createdAt = this.dateFromMillis(
      this.numberField(session.created) ?? this.numberField(session.updated),
    );

    return {
      id,
      projectId,
      title: this.truncateTitle(title),
      fullTitle: title,
      createdAt,
      updatedAt,
      messageCount: 1,
      ownership: { owner: "none" },
      provider: "opencode",
    };
  }

  private summaryFromExport(
    exported: OpenCodeExport,
    entries: OpenCodeSessionEntry[],
    projectId: UrlProjectId,
  ): SessionSummary | null {
    const id =
      this.stringField(exported.info?.id) ??
      entries.find((entry) => entry.message.sessionID)?.message.sessionID;
    if (!id) return null;

    const exportTitle = this.stringField(exported.info?.title)?.trim() || null;
    const firstUserText = this.firstUserText(entries);
    const fullTitle =
      exportTitle && exportTitle !== "Yep Anywhere Session"
        ? exportTitle
        : (firstUserText ?? exportTitle);
    const model = this.modelFromExport(exported, entries);
    const createdAt = this.dateFromMillis(
      this.numberField(exported.info?.time?.created) ??
        entries[0]?.message.time?.created,
    );
    const lastMessage = entries[entries.length - 1]?.message;
    const updatedAt = this.dateFromMillis(
      this.numberField(exported.info?.time?.updated) ??
        lastMessage?.time?.completed ??
        lastMessage?.time?.created,
    );

    return {
      id,
      projectId,
      title: this.truncateTitle(fullTitle),
      fullTitle,
      createdAt,
      updatedAt,
      messageCount: entries.length,
      ownership: { owner: "none" },
      contextUsage: this.extractContextUsageFromEntries(entries, model),
      provider: "opencode",
      model,
    };
  }

  private firstUserText(entries: OpenCodeSessionEntry[]): string | null {
    for (const entry of entries) {
      if (entry.message.role !== "user") continue;
      for (const part of entry.parts) {
        if (part.type === "text" && part.text?.trim()) {
          return part.text.trim();
        }
      }
    }
    return null;
  }

  private modelFromExport(
    exported: OpenCodeExport,
    entries: OpenCodeSessionEntry[],
  ): string | undefined {
    const model = exported.info?.model;
    if (typeof model === "string" && model.trim()) {
      return model.trim();
    }
    if (model && typeof model === "object" && !Array.isArray(model)) {
      const raw = model as Record<string, unknown>;
      const id = this.stringField(raw.id) ?? this.stringField(raw.modelID);
      if (id) return id;
    }

    for (const entry of entries) {
      if (entry.message.role !== "assistant") continue;
      const modelId =
        entry.message.modelID ??
        (entry.message.model &&
        typeof entry.message.model === "object" &&
        !Array.isArray(entry.message.model)
          ? this.stringField(
              (entry.message.model as Record<string, unknown>).modelID,
            )
          : undefined);
      if (modelId) return modelId;
    }

    return undefined;
  }

  private extractContextUsageFromEntries(
    entries: OpenCodeSessionEntry[],
    model: string | undefined,
  ): ContextUsage | undefined {
    const contextWindowSize = getModelContextWindow(model);

    for (const entry of [...entries].reverse()) {
      const msg = entry.message;
      if (msg.role !== "assistant" || !msg.tokens) continue;
      const inputTokens =
        (msg.tokens.input ?? 0) + (msg.tokens.cache?.read ?? 0);
      if (inputTokens === 0) continue;

      const result: ContextUsage = {
        inputTokens,
        percentage: Math.round((inputTokens / contextWindowSize) * 100),
        contextWindow: contextWindowSize,
      };
      if (msg.tokens.output !== undefined && msg.tokens.output > 0) {
        result.outputTokens = msg.tokens.output;
      }
      if (msg.tokens.cache?.read !== undefined && msg.tokens.cache.read > 0) {
        result.cacheReadTokens = msg.tokens.cache.read;
      }
      return result;
    }

    return undefined;
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private numberField(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  private dateFromMillis(value: number | undefined): string {
    if (value !== undefined) {
      const date = new Date(value);
      if (Number.isFinite(date.getTime())) {
        return date.toISOString();
      }
    }
    return new Date(0).toISOString();
  }

  /**
   * OpenCode doesn't have agent sessions like Claude's Task tool.
   * Return empty array.
   */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /**
   * OpenCode doesn't have agent sessions like Claude's Task tool.
   * Return null.
   */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  /**
   * Load all messages for a session, optionally after a specific message ID.
   */
  private async loadSessionMessages(
    sessionId: string,
    afterMessageId?: string,
  ): Promise<OpenCodeSessionEntry[]> {
    const messageDir = join(this.storageDir, "message", sessionId);
    const messages: OpenCodeSessionEntry[] = [];

    try {
      const messageFiles = await readdir(messageDir);
      const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));

      // Sort by filename to get chronological order
      jsonFiles.sort();

      let foundAfterMessage = !afterMessageId;

      for (const file of jsonFiles) {
        const messageId = file.replace(".json", "");

        // Skip messages until we find afterMessageId
        if (!foundAfterMessage) {
          if (messageId === afterMessageId) {
            foundAfterMessage = true;
          }
          continue;
        }

        const entry = await this.loadMessageEntry(messageDir, file);
        if (entry) {
          messages.push(entry);
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }

    return messages;
  }

  /**
   * Load a single message with its parts as an OpenCodeSessionEntry.
   */
  private async loadMessageEntry(
    messageDir: string,
    file: string,
  ): Promise<OpenCodeSessionEntry | null> {
    try {
      const msgPath = join(messageDir, file);
      const content = await readFile(msgPath, "utf-8");
      const message = JSON.parse(content) as OpenCodeMessage;

      // Load parts for this message
      const parts = await this.loadMessageParts(message.id);

      return { message, parts };
    } catch {
      return null;
    }
  }

  /**
   * Load all parts for a message.
   */
  private async loadMessageParts(
    messageId: string,
  ): Promise<OpenCodeStoredPart[]> {
    const partDir = join(this.storageDir, "part", messageId);
    const parts: OpenCodeStoredPart[] = [];

    try {
      const partFiles = await readdir(partDir);
      const jsonFiles = partFiles.filter((f) => f.endsWith(".json"));

      // Sort by filename to get chronological order
      jsonFiles.sort();

      for (const file of jsonFiles) {
        try {
          const partPath = join(partDir, file);
          const content = await readFile(partPath, "utf-8");
          const part = JSON.parse(content) as OpenCodeStoredPart;
          parts.push(part);
        } catch {
          // Skip unreadable parts
        }
      }
    } catch {
      // No parts directory
    }

    return parts;
  }

  /**
   * Get the text content of a message by loading its parts.
   */
  private async getMessageText(messageId: string): Promise<string | null> {
    const parts = await this.loadMessageParts(messageId);

    for (const part of parts) {
      if (part.type === "text" && part.text) {
        return part.text;
      }
    }

    return null;
  }

  /**
   * Extract context usage from the last assistant message's tokens.
   *
   * @param sessionId - Session ID to extract usage from
   * @param model - Model ID for determining context window size
   */
  private async extractContextUsage(
    sessionId: string,
    model: string | undefined,
  ): Promise<ContextUsage | undefined> {
    const contextWindowSize = getModelContextWindow(model);
    const messageDir = join(this.storageDir, "message", sessionId);

    try {
      const messageFiles = await readdir(messageDir);
      const jsonFiles = messageFiles.filter((f) => f.endsWith(".json"));

      // Sort and reverse to get most recent first
      jsonFiles.sort().reverse();

      for (const file of jsonFiles) {
        try {
          const msgPath = join(messageDir, file);
          const content = await readFile(msgPath, "utf-8");
          const msg = JSON.parse(content) as OpenCodeMessage;

          if (msg.role === "assistant" && msg.tokens) {
            const inputTokens =
              (msg.tokens.input ?? 0) + (msg.tokens.cache?.read ?? 0);

            if (inputTokens === 0) continue;

            const percentage = Math.round(
              (inputTokens / contextWindowSize) * 100,
            );

            const result: ContextUsage = {
              inputTokens,
              percentage,
              contextWindow: contextWindowSize,
            };

            if (msg.tokens.output !== undefined && msg.tokens.output > 0) {
              result.outputTokens = msg.tokens.output;
            }
            if (
              msg.tokens.cache?.read !== undefined &&
              msg.tokens.cache.read > 0
            ) {
              result.cacheReadTokens = msg.tokens.cache.read;
            }

            return result;
          }
        } catch {
          // Skip unreadable messages
        }
      }
    } catch {
      // No messages
    }

    return undefined;
  }

  /**
   * Truncate title to max length.
   */
  private truncateTitle(title: string | null): string | null {
    if (!title) return null;
    return truncateSessionTitle(title) || null;
  }
}
