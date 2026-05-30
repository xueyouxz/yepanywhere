import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
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
  private projectPath: string;
  private openCodeProjectIdCache: string | null | undefined = undefined;

  constructor(options: OpenCodeSessionReaderOptions) {
    this.storageDir = options.storageDir ?? OPENCODE_STORAGE_DIR;
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
        const summary = await this.getSessionSummary(sessionId, projectId);
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

  async getSessionSummary(
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

            // Get model from first assistant message
            if (!model && msg.role === "assistant" && msg.modelID) {
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

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const messages = await this.loadSessionMessages(sessionId, afterMessageId);

    return {
      summary,
      data: {
        provider: "opencode",
        session: {
          messages,
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
      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
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
