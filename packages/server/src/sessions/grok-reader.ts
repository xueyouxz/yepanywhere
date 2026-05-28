/**
 * GrokSessionReader - Reads Grok Build sessions from ~/.grok/sessions.
 *
 * Grok stores sessions at:
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/
 *     - summary.json
 *     - chat_history.jsonl
 *     - events.jsonl
 *     - updates.jsonl
 *     - ...
 *
 * YA is deliberately agnostic about the exact string used as a session ID in
 * URLs and internal references. Per guidance: for Grok we use whatever
 * identifier is most easily locatable directly in Grok Build's own records.
 *
 * The most locatable identifier is the subdirectory name under
 * ~/.grok/sessions/<encoded-cwd>/. This is the value that appears on disk
 * and is also present as `info.id` inside summary.json (and is the sessionId
 * returned by the ACP `newSession` / `resumeSession` calls).
 *
 * We therefore treat the directory basename (and `summary.info.id` when
 * present) as the canonical durable ID for Grok sessions. No synthetic
 * YA-level UUID is layered on top.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import type {
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";
import {
  GROK_SESSIONS_DIR,
  canonicalizeProjectPath,
} from "../projects/paths.js";

export interface GrokSessionReaderOptions {
  /** Override for testing (defaults to ~/.grok/sessions) */
  sessionsDir?: string;
  /** Filter to sessions belonging to this exact cwd */
  projectPath?: string;
}

interface GrokSessionInfo {
  /**
   * The canonical durable ID for this Grok session.
   *
   * This is the identifier most easily locatable in Grok's own records:
   * the basename of the session directory under ~/.grok/sessions/<encoded-cwd>/.
   * It matches `summary.json:info.id` and the sessionId returned by the
   * ACP protocol from `grok agent stdio`.
   */
  id: string;

  /** The actual directory name on disk (the most direct locatable key). */
  dirBasename: string;

  dirPath: string;
  cwd: string;
  summaryPath: string;
  mtime: number;
  size: number;
}

export class GrokSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;

  private sessionCache: Map<string, GrokSessionInfo> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(options: GrokSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? GROK_SESSIONS_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
  }

  private async scanSessions(): Promise<GrokSessionInfo[]> {
    const now = Date.now();
    if (now - this.cacheTimestamp < this.CACHE_TTL_MS && this.sessionCache.size > 0) {
      return Array.from(this.sessionCache.values());
    }

    this.sessionCache.clear();

    let cwdDirs: string[];
    try {
      cwdDirs = await readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const targetCwd = this.projectPath;

    for (const encoded of cwdDirs) {
      if (encoded === "session_search.sqlite") continue;

      let decodedCwd: string;
      try {
        decodedCwd = decodeURIComponent(encoded);
      } catch {
        continue;
      }

      const normalized = canonicalizeProjectPath(decodedCwd);
      if (targetCwd && normalized !== targetCwd) {
        continue;
      }

      const cwdDir = join(this.sessionsDir, encoded);
      let uuids: string[];
      try {
        uuids = await readdir(cwdDir);
      } catch {
        continue;
      }

      for (const uuid of uuids) {
        const sessionDir = join(cwdDir, uuid);
        const summaryPath = join(sessionDir, "summary.json");

        try {
          const st = await stat(summaryPath);
          const raw = await readFile(summaryPath, "utf-8");
          const summary = JSON.parse(raw);

          // Prefer the on-disk directory name as the primary locatable ID.
          // Fall back to (or cross-check against) the ID inside summary.json.
          const nativeId = summary.info?.id ?? uuid;

          const info: GrokSessionInfo = {
            id: nativeId,
            dirBasename: uuid,
            dirPath: sessionDir,
            cwd: summary.info?.cwd ?? decodedCwd,
            summaryPath,
            mtime: st.mtimeMs,
            size: st.size,
          };
          this.sessionCache.set(info.id, info);
        } catch {
          // Not a valid Grok session dir (missing or bad summary.json)
        }
      }
    }

    this.cacheTimestamp = now;
    return Array.from(this.sessionCache.values());
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const sessions = await this.scanSessions();
    const out: SessionSummary[] = [];

    for (const s of sessions) {
      try {
        const raw = await readFile(s.summaryPath, "utf-8");
        const data = JSON.parse(raw);

        const summary: SessionSummary = {
          id: data.info?.id ?? s.id,
          projectId,
          ownership: { owner: "none" as const },
          createdAt: data.created_at ?? new Date(s.mtime).toISOString(),
          updatedAt: data.updated_at ?? data.last_active_at ?? new Date(s.mtime).toISOString(),
          title: data.generated_title ?? data.session_summary ?? null,
          fullTitle: data.session_summary ?? data.generated_title ?? null,
          messageCount: data.num_messages ?? data.num_chat_messages ?? 0,
          provider: "grok",
          model: data.current_model_id ?? "grok-build",
        };
        out.push(summary);
      } catch {
        // skip bad summary
      }
    }

    return out;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const sessions = await this.scanSessions();
    // Look up by the canonical ID first (the one from info.id / ACP protocol).
    // Fall back to the raw directory basename on disk — this is the identifier
    // that is most easily locatable directly in Grok Build's own records.
    let info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      info = sessions.find((s) => s.dirBasename === sessionId);
    }
    if (!info) return null;

    try {
      const raw = await readFile(info.summaryPath, "utf-8");
      const data = JSON.parse(raw);

      return {
        id: data.info?.id ?? sessionId,
        projectId,
        ownership: { owner: "none" as const },
        createdAt: data.created_at ?? new Date(info.mtime).toISOString(),
        updatedAt: data.updated_at ?? data.last_active_at ?? new Date(info.mtime).toISOString(),
        title: data.generated_title ?? data.session_summary ?? null,
        fullTitle: data.session_summary ?? data.generated_title ?? null,
        messageCount: data.num_messages ?? data.num_chat_messages ?? 0,
        provider: "grok",
        model: data.current_model_id ?? "grok-build",
      };
    } catch {
      return null;
    }
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    _projectId: UrlProjectId,
    cachedMtime: number,
    _cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessions = await this.scanSessions();
    let info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      info = sessions.find((s) => s.dirBasename === sessionId);
    }
    if (!info) return null;

    if (info.mtime <= cachedMtime) {
      return null;
    }

    const summary = await this.getSessionSummary(sessionId, "" as UrlProjectId);
    if (!summary) return null;

    return {
      summary,
      mtime: info.mtime,
      size: info.size,
    };
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    _afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    // Full message replay from chat_history.jsonl + events is possible but complex.
    // For restart-survival quality (listing + summary + re-attach), the summary path
    // is sufficient. Full history can be added later without changing the contract.
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    // Return a minimal LoadedSession so the session is considered valid.
    // Real message content will come from the live provider on reconnect or from
    // the ACP stream when the user continues the session.
    return {
      summary,
      data: {
        provider: "grok",
        session: { messages: [] },
      },
    };
  }

  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const sessions = await this.scanSessions();
    let info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      info = sessions.find((s) => s.dirBasename === sessionId);
    }
    return info ? info.summaryPath : null;
  }

  async listSessionFiles(
    _sessionDir: string,
    _options?: { activeAfterMs?: number },
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const sessions = await this.scanSessions();
    return sessions.map((s) => ({
      sessionId: s.id,
      filePath: s.summaryPath,
    }));
  }

  getIndexScopeKey(sessionDir: string): string {
    return `grok::${sessionDir}::${this.projectPath ?? "*"}`;
  }
}
