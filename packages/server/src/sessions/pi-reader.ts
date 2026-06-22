/**
 * PiSessionReader — durable transcript reader for pi sessions.
 *
 * pi persists each session as append-only JSONL at
 *   ~/.pi/agent/sessions/--<cwd with / → ->--/<ISO-ts>_<uuid>.jsonl
 * a v3 tree where every node carries `id` + `parentId` (/tree, /fork, /clone).
 * The live PiProvider streams turns via the Supervisor; this reader backs
 * reload / list / attach once that process is gone, so a YA server restart no
 * longer loses pi sessions. See topics/pi-provider.md § "Durable transcripts"
 * and tasks/033-pi-session-reader.md.
 *
 * The durable view is the active leaf's path to root (the last appended node
 * walked up via `parentId`), matching pi's /tree semantics rather than every
 * branch. Node → YA message mapping mirrors PiProvider.mapEvent: assistant
 * thinking/text/toolCall blocks, and `toolResult` nodes become a YA `user`
 * message carrying a `tool_result` block.
 *
 * pi sessions are keyed on disk by cwd, so — like Grok/OpenCode — this reader's
 * `projectPath` filter is the real project-membership test (see
 * provider-resolution.ts), and no native summary file exists: summaries are
 * derived from the parsed transcript.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import {
  PI_SESSIONS_DIR,
  canonicalizeProjectPath,
  readCwdFromSessionFile,
} from "../projects/paths.js";
import type {
  ContentBlock,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";

export interface PiSessionReaderOptions {
  /** Override for testing (defaults to ~/.pi/agent/sessions) */
  sessionsDir?: string;
  /** Filter to sessions belonging to this exact cwd */
  projectPath?: string;
}

/** One JSONL node, kept loose and discriminated by `type`. */
interface PiRawNode {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  cwd?: string;
  version?: number;
  modelId?: string;
  provider?: string;
  message?: PiRawMessage;
}

interface PiRawMessage {
  role?: string;
  content?: unknown;
  timestamp?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  model?: string;
  provider?: string;
}

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiSessionInfo {
  /** Canonical durable id: the uuid in the filename (= session header id). */
  id: string;
  filePath: string;
  cwd: string;
  mtime: number;
  size: number;
}

interface PiParsedSession {
  /** Active leaf → root path, chronological, message nodes only. */
  messageNodes: PiRawNode[];
  /** Header `cwd`. */
  cwd: string;
  /** Header timestamp (session creation), if present. */
  createdAt?: string;
  /** Latest model on the active path, as `provider/modelId` when known. */
  model: string | null;
}

export class PiSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;

  private sessionCache: Map<string, PiSessionInfo> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000;

  /** Parsed-transcript cache keyed by `${filePath}:${mtime}` (avoids re-parse). */
  private parseCache: Map<string, PiParsedSession> = new Map();

  constructor(options: PiSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? PI_SESSIONS_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
  }

  private sessionIdFromFilename(filename: string): string | null {
    // <ISO-ts>_<uuid>.jsonl — the uuid (after the last "_") is the durable id.
    const match = filename.match(/_([^_/\\]+)\.jsonl$/);
    if (match?.[1]) return match[1];
    // Fall back to a bare <uuid>.jsonl if pi ever drops the ts prefix.
    const bare = filename.match(/([^_/\\]+)\.jsonl$/);
    return bare?.[1] ?? null;
  }

  private async scanSessions(): Promise<PiSessionInfo[]> {
    const now = Date.now();
    if (
      now - this.cacheTimestamp < this.CACHE_TTL_MS &&
      this.sessionCache.size > 0
    ) {
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
      const cwdDir = join(this.sessionsDir, encoded);
      let files: string[];
      try {
        files = await readdir(cwdDir);
      } catch {
        continue; // not a directory (stray file at the root)
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const id = this.sessionIdFromFilename(file);
        if (!id) continue;

        const filePath = join(cwdDir, file);
        // cwd comes from the session header, the authoritative source — the
        // encoded directory name is lossy and not reliably reversible.
        const cwd = await readCwdFromSessionFile(filePath);
        if (!cwd) continue;

        const normalized = canonicalizeProjectPath(cwd);
        if (targetCwd && normalized !== targetCwd) continue;

        try {
          const st = await stat(filePath);
          this.sessionCache.set(id, {
            id,
            filePath,
            cwd,
            mtime: st.mtimeMs,
            size: st.size,
          });
        } catch {
          // file vanished between readdir and stat — skip
        }
      }
    }

    this.cacheTimestamp = now;
    return Array.from(this.sessionCache.values());
  }

  private findSessionInfo(
    sessions: PiSessionInfo[],
    sessionId: string,
  ): PiSessionInfo | undefined {
    return sessions.find((s) => s.id === sessionId);
  }

  /** Parse a session file into its active-leaf→root message path. Cached by mtime. */
  private async parseSession(
    info: PiSessionInfo,
  ): Promise<PiParsedSession | null> {
    const cacheKey = `${info.filePath}:${info.mtime}`;
    const cached = this.parseCache.get(cacheKey);
    if (cached) return cached;

    let raw: string;
    try {
      raw = await readFile(info.filePath, "utf-8");
    } catch {
      return null;
    }

    const nodes: PiRawNode[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        nodes.push(JSON.parse(line) as PiRawNode);
      } catch {
        // skip malformed line
      }
    }
    if (nodes.length === 0) return null;

    const header = nodes.find((n) => n.type === "session");
    const cwd = header?.cwd ?? info.cwd;
    const createdAt = header?.timestamp;

    // Active leaf = last appended node; walk parentId to the root, then reverse
    // to chronological order. For a linear (unbranched) session this is every
    // node; forks/branches collapse to the saved active branch.
    const byId = new Map<string, PiRawNode>();
    for (const n of nodes) {
      if (n.id) byId.set(n.id, n);
    }
    const path: PiRawNode[] = [];
    const seen = new Set<string>();
    let cur: PiRawNode | undefined = nodes[nodes.length - 1];
    while (cur?.id && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    path.reverse();

    const messageNodes = path.filter((n) => n.type === "message");
    const model = this.modelFromPath(path);

    const parsed: PiParsedSession = { messageNodes, cwd, createdAt, model };
    this.parseCache.set(cacheKey, parsed);
    return parsed;
  }

  private modelFromPath(path: PiRawNode[]): string | null {
    // Prefer the last model_change on the active path; fall back to the last
    // assistant message's own provider/model.
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const n = path[i];
      if (n?.type === "model_change" && n.modelId) {
        return n.provider ? `${n.provider}/${n.modelId}` : n.modelId;
      }
    }
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const m = path[i]?.message;
      if (m?.role === "assistant" && m.model) {
        return m.provider ? `${m.provider}/${m.model}` : m.model;
      }
    }
    return null;
  }

  private contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => {
          const block = b as PiContentBlock;
          return block?.type === "text" && typeof block.text === "string"
            ? block.text
            : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  private mapNode(node: PiRawNode, index: number): Message | null {
    const m = node.message;
    if (!m) return null;
    const uuid = node.id ?? `pi-${index}`;
    const timestamp = m.timestamp ?? node.timestamp;

    if (m.role === "user") {
      return {
        type: "user",
        uuid,
        timestamp,
        role: "user",
        message: { role: "user", content: this.contentText(m.content) },
      };
    }

    if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      let firstTool: { id: string; name: string; input: unknown } | undefined;
      if (Array.isArray(m.content)) {
        for (const b of m.content as PiContentBlock[]) {
          if (b?.type === "thinking" && typeof b.thinking === "string") {
            blocks.push({ type: "thinking", thinking: b.thinking });
          } else if (b?.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", text: b.text });
          } else if (b?.type === "toolCall") {
            const id = String(b.id ?? "");
            const name = String(b.name ?? "tool");
            const input = b.arguments ?? {};
            blocks.push({ type: "tool_use", id, name, input });
            if (!firstTool) firstTool = { id, name, input };
          }
        }
      }
      const message: Message = {
        type: "assistant",
        uuid,
        timestamp,
        role: "assistant",
        message: { role: "assistant", content: blocks },
      };
      if (firstTool) message.toolUse = firstTool;
      return message;
    }

    if (m.role === "toolResult") {
      return {
        type: "user",
        uuid,
        timestamp,
        role: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: String(m.toolCallId ?? ""),
              is_error: m.isError === true,
              content: this.contentText(m.content),
            },
          ],
        },
      };
    }

    return null;
  }

  private buildMessages(parsed: PiParsedSession): Message[] {
    const messages: Message[] = [];
    parsed.messageNodes.forEach((node, index) => {
      const mapped = this.mapNode(node, index);
      if (mapped) messages.push(mapped);
    });
    return messages;
  }

  private deriveTitle(parsed: PiParsedSession): string | null {
    const firstUser = parsed.messageNodes.find(
      (n) => n.message?.role === "user",
    );
    if (!firstUser) return null;
    const text = this.contentText(firstUser.message?.content).trim();
    if (!text) return null;
    const firstLine = (text.split("\n")[0] ?? "").trim();
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  }

  private summaryFrom(
    info: PiSessionInfo,
    parsed: PiParsedSession,
    projectId: UrlProjectId,
  ): SessionSummary {
    const title = this.deriveTitle(parsed);
    const updatedAt = new Date(info.mtime).toISOString();
    return {
      id: info.id,
      projectId,
      ownership: { owner: "none" as const },
      createdAt: parsed.createdAt ?? updatedAt,
      updatedAt,
      title,
      fullTitle: title,
      messageCount: parsed.messageNodes.length,
      provider: "pi",
      model: parsed.model ?? "default",
    };
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const sessions = await this.scanSessions();
    const out: SessionSummary[] = [];
    for (const info of sessions) {
      const parsed = await this.parseSession(info);
      if (!parsed) continue;
      out.push(this.summaryFrom(info, parsed, projectId));
    }
    return out;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const sessions = await this.scanSessions();
    const info = this.findSessionInfo(sessions, sessionId);
    if (!info) return null;
    const parsed = await this.parseSession(info);
    if (!parsed) return null;
    return this.summaryFrom(info, parsed, projectId);
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    _cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessions = await this.scanSessions();
    const info = this.findSessionInfo(sessions, sessionId);
    if (!info) return null;
    if (info.mtime <= cachedMtime) return null;
    const parsed = await this.parseSession(info);
    if (!parsed) return null;
    return {
      summary: this.summaryFrom(info, parsed, projectId),
      mtime: info.mtime,
      size: info.size,
    };
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const sessions = await this.scanSessions();
    const info = this.findSessionInfo(sessions, sessionId);
    if (!info) return null;
    const parsed = await this.parseSession(info);
    if (!parsed) return null;

    const messages = this.buildMessages(parsed);
    const filtered = afterMessageId
      ? this.messagesAfter(messages, afterMessageId)
      : messages;

    return {
      summary: this.summaryFrom(info, parsed, projectId),
      data: {
        provider: "pi",
        session: { messages: filtered },
      },
    };
  }

  private messagesAfter(
    messages: Message[],
    afterMessageId: string,
  ): Message[] {
    const idx = messages.findIndex(
      (message) =>
        message.uuid === afterMessageId || message.id === afterMessageId,
    );
    return idx === -1 ? messages : messages.slice(idx + 1);
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
    return this.findSessionInfo(sessions, sessionId)?.filePath ?? null;
  }

  async listSessionFiles(
    _sessionDir: string,
    _options?: { activeAfterMs?: number },
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const sessions = await this.scanSessions();
    return sessions.map((s) => ({ sessionId: s.id, filePath: s.filePath }));
  }

  async getSessionProjectPath(sessionId: string): Promise<string | null> {
    const sessions = await this.scanSessions();
    const info = this.findSessionInfo(sessions, sessionId);
    return info ? canonicalizeProjectPath(info.cwd) : null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `pi::${sessionDir}::${this.projectPath ?? "*"}`;
  }
}
