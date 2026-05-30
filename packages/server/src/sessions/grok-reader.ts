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

type GrokToolState = {
  input: Record<string, unknown>;
  message: Message;
  name: string;
  resultEmitted: boolean;
};

type GrokTextBuffer = {
  content: string;
  kind: "text" | "thinking";
  role: "assistant" | "user";
  timestamp?: string;
};

type GrokToolLocation = {
  path?: unknown;
  line?: unknown;
  [key: string]: unknown;
};

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
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const sessions = await this.scanSessions();
    const info = this.findSessionInfo(sessions, sessionId);
    if (!info) return null;

    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const messages = await this.loadUpdatesMessages(info);
    const filteredMessages = afterMessageId
      ? this.messagesAfter(messages, afterMessageId)
      : messages;

    return {
      summary: {
        ...summary,
        messageCount: messages.length || summary.messageCount,
      },
      data: {
        provider: "grok",
        session: { messages: filteredMessages },
      },
    };
  }

  private findSessionInfo(
    sessions: GrokSessionInfo[],
    sessionId: string,
  ): GrokSessionInfo | undefined {
    return (
      sessions.find((s) => s.id === sessionId) ??
      sessions.find((s) => s.dirBasename === sessionId)
    );
  }

  private async loadUpdatesMessages(info: GrokSessionInfo): Promise<Message[]> {
    let raw: string;
    try {
      raw = await readFile(join(info.dirPath, "updates.jsonl"), "utf-8");
    } catch {
      return [];
    }

    const messages: Message[] = [];
    const tools = new Map<string, GrokToolState>();
    let textBuffer: GrokTextBuffer | null = null;

    const flushText = () => {
      textBuffer = this.flushTextBuffer(messages, textBuffer);
    };

    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const record = this.asRecord(parsed);
      const update = this.asRecord(this.asRecord(record?.params)?.update);
      const updateType = this.stringField(update, "sessionUpdate");
      if (!record || !update || !updateType) continue;

      const timestamp = this.timestampFromRecord(record);
      if (updateType === "user_message_chunk") {
        const text = this.textFromUpdate(update);
        if (!text) continue;
        textBuffer = this.appendTextChunk(
          messages,
          textBuffer,
          "user",
          "text",
          text,
          timestamp,
        );
        continue;
      }

      if (updateType === "agent_message_chunk") {
        const text = this.textFromUpdate(update);
        if (!text) continue;
        textBuffer = this.appendTextChunk(
          messages,
          textBuffer,
          "assistant",
          "text",
          text,
          timestamp,
        );
        continue;
      }

      if (updateType === "agent_thought_chunk") {
        const text = this.textFromUpdate(update);
        if (!text) continue;
        textBuffer = this.appendTextChunk(
          messages,
          textBuffer,
          "assistant",
          "thinking",
          text,
          timestamp,
        );
        continue;
      }

      flushText();

      if (updateType === "tool_call") {
        this.upsertToolUseMessage(update, messages, tools, timestamp);
        continue;
      }

      if (updateType === "tool_call_update") {
        const toolState = this.hasToolUseMetadata(update)
          ? this.upsertToolUseMessage(update, messages, tools, timestamp)
          : this.findToolState(update, tools);
        if (this.isTerminalToolUpdate(update)) {
          this.appendToolResultMessage(update, messages, toolState, timestamp);
        }
        continue;
      }

      if (updateType === "plan") {
        const entries = this.planEntries(update);
        if (entries.length > 0) {
          messages.push({
            type: "assistant",
            uuid: `grok-plan-${index}`,
            timestamp,
            role: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: entries
                    .map((entry) => `${entry.status}: ${entry.content}`)
                    .join("\n"),
                  grokPlan: { entries },
                },
              ],
            },
          });
        }
      }
    }

    flushText();
    return messages;
  }

  private messagesAfter(messages: Message[], afterMessageId: string): Message[] {
    const afterIndex = messages.findIndex((message) => {
      const nestedId = this.stringField(this.asRecord(message.message), "id");
      return (
        message.uuid === afterMessageId ||
        message.id === afterMessageId ||
        nestedId === afterMessageId
      );
    });
    return afterIndex === -1 ? messages : messages.slice(afterIndex + 1);
  }

  private appendTextChunk(
    messages: Message[],
    buffer: GrokTextBuffer | null,
    role: "assistant" | "user",
    kind: "text" | "thinking",
    text: string,
    timestamp?: string,
  ): GrokTextBuffer {
    const sameBuffer = buffer?.role === role && buffer.kind === kind;
    if (!sameBuffer) {
      this.flushTextBuffer(messages, buffer);
    }
    return {
      content: (sameBuffer ? buffer.content : "") + text,
      kind,
      role,
      timestamp: (sameBuffer ? buffer.timestamp : undefined) ?? timestamp,
    };
  }

  private flushTextBuffer(
    messages: Message[],
    buffer: GrokTextBuffer | null,
  ): null {
    if (!buffer?.content.trim()) return null;

    const uuid = `grok-${messages.length}-${buffer.role}-${buffer.kind}`;
    const content =
      buffer.kind === "thinking"
        ? [{ type: "thinking", thinking: buffer.content }]
        : buffer.content;
    messages.push({
      type: buffer.role,
      uuid,
      timestamp: buffer.timestamp,
      role: buffer.role,
      message: {
        role: buffer.role,
        content,
      },
    });
    return null;
  }

  private upsertToolUseMessage(
    update: Record<string, unknown>,
    messages: Message[],
    tools: Map<string, GrokToolState>,
    timestamp?: string,
  ): GrokToolState | undefined {
    const toolCallId = this.stringField(update, "toolCallId");
    if (!toolCallId) return undefined;

    const previous = tools.get(toolCallId);
    const name = this.mapToolUpdateToToolName(update, previous);
    const input = this.buildToolInput(update, previous?.input);
    if (previous) {
      previous.name = name;
      previous.input = input;
      previous.message.toolUse = { id: toolCallId, name, input };
      const content = previous.message.message?.content;
      const block = Array.isArray(content) ? this.asRecord(content[0]) : undefined;
      if (block) {
        block.name = name;
        block.input = input;
      }
      return previous;
    }

    const message: Message = {
      type: "assistant",
      uuid: toolCallId,
      timestamp,
      role: "assistant",
      toolUse: { id: toolCallId, name, input },
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name,
            input,
          },
        ],
      },
    };
    const state: GrokToolState = {
      input,
      message,
      name,
      resultEmitted: false,
    };
    tools.set(toolCallId, state);
    messages.push(message);
    return state;
  }

  private findToolState(
    update: Record<string, unknown>,
    tools: Map<string, GrokToolState>,
  ): GrokToolState | undefined {
    const toolCallId = this.stringField(update, "toolCallId");
    return toolCallId ? tools.get(toolCallId) : undefined;
  }

  private appendToolResultMessage(
    update: Record<string, unknown>,
    messages: Message[],
    state: GrokToolState | undefined,
    timestamp?: string,
  ): void {
    const toolCallId = this.stringField(update, "toolCallId");
    if (!toolCallId || state?.resultEmitted) return;

    const isError = this.stringField(update, "status") === "failed" ||
      this.stringField(update, "error") !== undefined;
    messages.push({
      type: "user",
      uuid: `${toolCallId}:result`,
      timestamp,
      role: "user",
      toolUseResult: this.buildStructuredToolResult(update, state?.input),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            is_error: isError,
            content: this.formatToolResultContent(update, state?.input),
          },
        ],
      },
    });
    if (state) state.resultEmitted = true;
  }

  private mapToolUpdateToToolName(
    update: Record<string, unknown>,
    previous?: GrokToolState,
  ): string {
    const kind = this.stringField(update, "kind");
    const title = this.stringField(update, "title");
    if (this.isReadTool(kind, title)) return "Read";
    if (this.isExecuteTool(kind, title)) return "Bash";
    if (title === "grep") return "Grep";
    if (title === "search_replace") return "Edit";
    if (title === "todo_write") return "TodoWrite";
    if (title === "write_file") return "Write";

    switch (kind) {
      case "edit":
        return "Edit";
      case "delete":
        return "Delete";
      case "move":
        return "Move";
      case "search":
        return "Search";
      case "fetch":
        return "WebFetch";
      case "think":
        return "Think";
      default:
        return title ?? previous?.name ?? "GrokTool";
    }
  }

  private buildToolInput(
    update: Record<string, unknown>,
    previousInput?: Record<string, unknown>,
  ): Record<string, unknown> {
    const input: Record<string, unknown> = { ...previousInput };
    const kind = this.stringField(update, "kind");
    const title = this.stringField(update, "title");
    const rawInput = this.asRecord(update.rawInput);
    const locations = this.locationsFromUpdate(update);
    const firstPath = this.firstLocationPath(locations);

    if (this.isReadTool(kind, title)) {
      const filePath = this.stringField(rawInput, "target_file") ?? firstPath;
      if (filePath) input.file_path = filePath;
      const offset = this.numberField(rawInput, "offset");
      const limit = this.numberField(rawInput, "limit");
      if (offset !== undefined) input.offset = offset;
      if (limit !== undefined) input.limit = limit;
    } else if (this.isExecuteTool(kind, title)) {
      const command = this.stringField(rawInput, "command");
      const description = this.stringField(rawInput, "description");
      const timeout = this.numberField(rawInput, "timeout");
      if (command) input.command = command;
      if (description) input.description = description;
      if (timeout !== undefined) input.timeout = timeout;
    } else if (title === "grep") {
      this.copyStringField(rawInput, input, "pattern");
      this.copyStringField(rawInput, input, "path");
      this.copyStringField(rawInput, input, "glob");
      this.copyStringField(rawInput, input, "output_mode");
      const headLimit = this.numberField(rawInput, "head_limit");
      if (headLimit !== undefined) input.head_limit = headLimit;
    } else if (title === "search_replace") {
      this.copyStringField(rawInput, input, "file_path");
      this.copyStringField(rawInput, input, "old_string");
      this.copyStringField(rawInput, input, "new_string");
      if (typeof rawInput?.replace_all === "boolean") {
        input.replace_all = rawInput.replace_all;
      }
    } else if (title === "todo_write") {
      const todos = this.todoList(rawInput?.todos);
      if (todos.length > 0) input.todos = todos;
    } else if (title === "write_file") {
      this.copyStringField(rawInput, input, "file_path");
      this.copyStringField(rawInput, input, "content");
    } else if (title === "list_dir") {
      this.copyStringField(rawInput, input, "target_directory");
    }

    if (kind) input.kind = kind;
    if (title) input.title = title;
    const status = this.stringField(update, "status");
    if (status) input.status = status;
    if (locations) input.locations = locations;
    if (update.rawInput !== undefined) input.rawInput = update.rawInput;
    if (update.content !== undefined) input.content = update.content;
    return input;
  }

  private buildStructuredToolResult(
    update: Record<string, unknown>,
    toolInput?: Record<string, unknown>,
  ): unknown {
    const error = this.stringField(update, "error");
    if (error) return error;

    const rawOutput = this.asRecord(update.rawOutput);
    if (!rawOutput) {
      return update.content ?? this.stringField(update, "status") ?? "completed";
    }

    switch (rawOutput.type) {
      case "Bash":
        return {
          stdout:
            this.decodeByteArray(rawOutput.output) ??
            this.stringField(rawOutput, "output_for_prompt") ??
            "",
          stderr: this.decodeByteArray(rawOutput.stderr) ?? "",
          interrupted: false,
          isImage: false,
        };
      case "ReadFile":
        return this.buildReadResult(rawOutput, update, toolInput);
      case "GrepSearch":
        return this.buildGrepResult(rawOutput, toolInput);
      case "Todo":
        return this.buildTodoResult(rawOutput);
      case "SearchReplace":
        return this.buildEditResult(rawOutput, update, toolInput);
      default:
        return update.rawOutput;
    }
  }

  private buildReadResult(
    rawOutput: Record<string, unknown>,
    update: Record<string, unknown>,
    toolInput?: Record<string, unknown>,
  ): Record<string, unknown> {
    const fileContent = this.asRecord(rawOutput.FileContent);
    const content = this.stringField(fileContent, "content") ?? "";
    const totalLines =
      this.numberField(fileContent, "total_lines") ??
      (content ? content.split("\n").length : 0);
    const filePath =
      this.stringField(fileContent, "absolute_path") ??
      this.firstLocationPath(this.locationsFromUpdate(update)) ??
      this.stringField(this.asRecord(update.rawInput), "target_file") ??
      this.stringField(toolInput, "file_path") ??
      "";
    return {
      type: "text",
      file: {
        filePath,
        content,
        numLines: totalLines,
        startLine: 1,
        totalLines,
      },
    };
  }

  private buildGrepResult(
    rawOutput: Record<string, unknown>,
    toolInput?: Record<string, unknown>,
  ): Record<string, unknown> {
    const stdout =
      this.decodeByteArray(rawOutput.stdout) ??
      this.stringField(rawOutput, "stdout") ??
      "";
    const mode = this.grepMode(this.stringField(toolInput, "output_mode"));
    const filenames = this.grepFilenames(rawOutput, stdout);
    const numFiles = this.numberField(rawOutput, "match_count") ?? filenames.length;
    const result: Record<string, unknown> = {
      mode,
      filenames,
      numFiles,
    };
    if (mode === "content") {
      result.content = this.stripWorkspaceResultEnvelope(stdout);
      result.numLines = String(result.content).split("\n").filter(Boolean).length;
    }
    const appliedLimit = this.numberField(toolInput, "head_limit");
    if (appliedLimit !== undefined) result.appliedLimit = appliedLimit;
    return result;
  }

  private buildTodoResult(rawOutput: Record<string, unknown>): Record<string, unknown> {
    const todosUpdated = this.asRecord(rawOutput.TodosUpdated);
    return {
      oldTodos: [],
      newTodos: this.todoList(todosUpdated?.todos),
    };
  }

  private buildEditResult(
    rawOutput: Record<string, unknown>,
    update: Record<string, unknown>,
    toolInput?: Record<string, unknown>,
  ): Record<string, unknown> {
    const applied = this.asRecord(rawOutput.EditsApplied);
    const filePath =
      this.stringField(applied, "absolute_path") ??
      this.stringField(toolInput, "file_path") ??
      this.firstLocationPath(this.locationsFromUpdate(update)) ??
      "";
    const oldString =
      this.stringField(applied, "old_string") ??
      this.stringField(toolInput, "old_string") ??
      "";
    const newString =
      this.stringField(applied, "new_string") ??
      this.stringField(toolInput, "new_string") ??
      "";
    return {
      filePath,
      oldString,
      newString,
      originalFile: "",
      replaceAll: toolInput?.replace_all === true,
      userModified: false,
      structuredPatch: this.structuredPatchFromUpdate(update, filePath, oldString, newString),
    };
  }

  private formatToolResultContent(
    update: Record<string, unknown>,
    toolInput?: Record<string, unknown>,
  ): string {
    const error = this.stringField(update, "error");
    if (error) return error;

    const rawOutput = this.asRecord(update.rawOutput);
    if (rawOutput?.type === "ReadFile") {
      const filePath = this.stringField(toolInput, "file_path") ??
        this.stringField(this.asRecord(rawOutput.FileContent), "absolute_path") ??
        "file";
      return `Read ${filePath}`;
    }
    if (rawOutput?.type === "SearchReplace") {
      return this.stringField(this.asRecord(rawOutput.EditsApplied), "tool_output_for_prompt_concise") ??
        this.stringField(this.asRecord(rawOutput.EditsApplied), "tool_output_for_prompt") ??
        "File updated";
    }
    if (rawOutput?.type === "Todo") {
      return this.stringField(this.asRecord(rawOutput.TodosUpdated), "summary_for_prompt") ??
        "Todos updated";
    }
    if (rawOutput?.type === "GrepSearch") {
      return this.decodeByteArray(rawOutput.stdout) ?? "Search completed";
    }
    if (rawOutput?.type === "Bash") {
      return this.decodeByteArray(rawOutput.output) ??
        this.stringField(rawOutput, "output_for_prompt") ??
        "Command completed";
    }
    if (rawOutput?.type === "ListDir") {
      return this.stringField(this.asRecord(rawOutput.Content), "content") ??
        "Directory listed";
    }

    const content = this.resultContentText(update);
    if (content) return content;
    if (typeof update.rawOutput === "string") return update.rawOutput;
    return this.stringField(update, "status") ?? "completed";
  }

  private isTerminalToolUpdate(update: Record<string, unknown>): boolean {
    const status = this.stringField(update, "status");
    return status === "completed" || status === "failed" || !!this.stringField(update, "error");
  }

  private hasToolUseMetadata(update: Record<string, unknown>): boolean {
    return (
      this.stringField(update, "kind") !== undefined ||
      this.stringField(update, "title") !== undefined ||
      this.stringField(update, "status") !== undefined ||
      this.locationsFromUpdate(update) !== undefined ||
      update.rawInput !== undefined ||
      update.content !== undefined
    );
  }

  private timestampFromRecord(record: Record<string, unknown>): string | undefined {
    const timestamp = record.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      return new Date(timestamp * 1000).toISOString();
    }
    if (typeof timestamp === "string") {
      const parsed = new Date(timestamp);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }
    return undefined;
  }

  private textFromUpdate(update: Record<string, unknown>): string | undefined {
    const content = this.asRecord(update.content);
    if (content?.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    if (typeof update.content === "string") return update.content;
    return this.stringField(update, "text");
  }

  private resultContentText(update: Record<string, unknown>): string | undefined {
    const content = update.content;
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const item of content) {
      const record = this.asRecord(item);
      const nested = this.asRecord(record?.content);
      if (nested?.type === "text" && typeof nested.text === "string") {
        parts.push(nested.text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  private planEntries(update: Record<string, unknown>): Array<Record<string, string>> {
    const entries = update.entries;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      const record = this.asRecord(entry);
      const content = this.stringField(record, "content");
      const status = this.stringField(record, "status") ?? "unknown";
      return content ? [{ content, status }] : [];
    });
  }

  private isReadTool(kind?: string, title?: string): boolean {
    return kind === "read" || title === "read_file";
  }

  private isExecuteTool(kind?: string, title?: string): boolean {
    return kind === "execute" || title === "run_terminal_command";
  }

  private copyStringField(
    from: Record<string, unknown> | undefined,
    to: Record<string, unknown>,
    field: string,
  ): void {
    const value = this.stringField(from, field);
    if (value !== undefined) to[field] = value;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringField(
    record: Record<string, unknown> | undefined,
    field: string,
  ): string | undefined {
    const value = record?.[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private numberField(
    record: Record<string, unknown> | undefined,
    field: string,
  ): number | undefined {
    const value = record?.[field];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private locationsFromUpdate(update: Record<string, unknown>): GrokToolLocation[] | undefined {
    return Array.isArray(update.locations)
      ? (update.locations as GrokToolLocation[])
      : undefined;
  }

  private firstLocationPath(locations: GrokToolLocation[] | undefined): string | undefined {
    const first = locations?.[0];
    return typeof first?.path === "string" ? first.path : undefined;
  }

  private decodeByteArray(value: unknown): string | undefined {
    if (
      !Array.isArray(value) ||
      !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      return undefined;
    }
    return new TextDecoder().decode(Uint8Array.from(value as number[]));
  }

  private grepMode(value: string | undefined): "files_with_matches" | "content" | "count" {
    return value === "content" || value === "count" ? value : "files_with_matches";
  }

  private grepFilenames(rawOutput: Record<string, unknown>, stdout: string): string[] {
    const fileMatches = rawOutput.file_matches;
    if (
      Array.isArray(fileMatches) &&
      fileMatches.length > 0 &&
      fileMatches.every((item) => typeof item === "string")
    ) {
      return fileMatches as string[];
    }
    return this.stripWorkspaceResultEnvelope(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/") || line.startsWith("."));
  }

  private stripWorkspaceResultEnvelope(value: string): string {
    return value
      .replace(/^<workspace_result[^>]*>\n?/, "")
      .replace(/\n?<\/workspace_result>$/, "")
      .replace(/^Found \d+ files\n?/, "");
  }

  private todoList(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) return [];
    return value.flatMap((todo) => {
      const record = this.asRecord(todo);
      const content = this.stringField(record, "content");
      const status = this.stringField(record, "status");
      if (!content || !status) return [];
      return [{ ...record, activeForm: this.stringField(record, "activeForm") ?? content }];
    });
  }

  private structuredPatchFromUpdate(
    update: Record<string, unknown>,
    filePath: string,
    oldString: string,
    newString: string,
  ): Array<Record<string, unknown>> {
    const content = update.content;
    if (Array.isArray(content)) {
      const hunks = content.flatMap((item) => {
        const diff = this.asRecord(item);
        if (diff?.type !== "diff") return [];
        const details = this.firstDiffDetail(diff);
        return [
          this.makePatchHunk(
            this.stringField(diff, "oldText") ?? oldString,
            this.stringField(diff, "newText") ?? newString,
            this.numberField(details, "old_line") ?? 1,
            this.numberField(details, "new_line") ?? 1,
          ),
        ];
      });
      if (hunks.length > 0) return hunks;
    }
    if (!oldString && !newString) return [];
    return [this.makePatchHunk(oldString, newString, 1, 1)];
  }

  private firstDiffDetail(diff: Record<string, unknown>): Record<string, unknown> | undefined {
    const meta = this.asRecord(diff._meta);
    const details = meta?.details;
    if (!Array.isArray(details)) return undefined;
    return this.asRecord(details[0]);
  }

  private makePatchHunk(
    oldText: string,
    newText: string,
    oldStart: number,
    newStart: number,
  ): Record<string, unknown> {
    const oldLines = oldText ? oldText.split("\n") : [];
    const newLines = newText ? newText.split("\n") : [];
    return {
      oldStart,
      oldLines: oldLines.length,
      newStart,
      newLines: newLines.length,
      lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
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

  async getSessionProjectPath(sessionId: string): Promise<string | null> {
    const sessions = await this.scanSessions();
    let info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      info = sessions.find((s) => s.dirBasename === sessionId);
    }
    return info ? canonicalizeProjectPath(info.cwd) : null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `grok::${sessionDir}::${this.projectPath ?? "*"}`;
  }
}
