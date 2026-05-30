/**
 * SessionMetadataService manages custom session metadata (titles, archive status).
 * This enables renaming sessions and archiving them to hide from default view.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ProviderName, sanitizeSessionTitle } from "@yep-anywhere/shared";

export interface SessionMetadata {
  /** Custom title that overrides auto-generated title */
  customTitle?: string;
  /** Whether the session is archived (hidden from default list) */
  isArchived?: boolean;
  /** Whether the session is starred/favorited */
  isStarred?: boolean;
  /** Parent session when this session is a YA-owned fork/aside. */
  parentSessionId?: string;
  /** Model used for this session (resolved, not "default") */
  model?: string;
  /** Provider used for this session (for backward compatibility with sessions that don't have provider in JSONL) */
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** Whether this session is opted in to heartbeat turns */
  heartbeatTurnsEnabled?: boolean;
  /** Optional per-session idle threshold override in minutes */
  heartbeatTurnsAfterMinutes?: number;
  /** Optional per-session heartbeat text override */
  heartbeatTurnText?: string;
  /** Per-session grace minutes before forcing output; null = off */
  heartbeatForceAfterMinutes?: number | null;
}

export interface SessionMetadataState {
  /** Map of sessionId -> metadata */
  sessions: Record<string, SessionMetadata>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 1;

export interface SessionMetadataServiceOptions {
  /** Directory to store metadata state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
}

export class SessionMetadataService {
  private state: SessionMetadataState;
  private dataDir: string;
  private filePath: string;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: SessionMetadataServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "session-metadata.json");
    this.state = { sessions: {}, version: CURRENT_VERSION };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    console.log(`[SessionMetadataService] Initializing from: ${this.filePath}`);
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as SessionMetadataState;
      console.log(
        `[SessionMetadataService] Loaded ${Object.keys(parsed.sessions).length} sessions from disk`,
      );

      // Validate and migrate if needed
      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else {
        // Future: handle migrations here
        this.state = {
          sessions: parsed.sessions ?? {},
          version: CURRENT_VERSION,
        };
        await this.save();
      }
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[SessionMetadataService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = { sessions: {}, version: CURRENT_VERSION };
    }
  }

  /**
   * Get metadata for a session.
   */
  getMetadata(sessionId: string): SessionMetadata | undefined {
    return this.state.sessions[sessionId];
  }

  /**
   * Get all session metadata.
   */
  getAllMetadata(): Record<string, SessionMetadata> {
    return { ...this.state.sessions };
  }

  /**
   * Set the custom title for a session.
   * Pass undefined or empty string to clear the custom title.
   */
  async setTitle(sessionId: string, title: string | undefined): Promise<void> {
    const trimmedTitle =
      title === undefined ? undefined : sanitizeSessionTitle(title);
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      customTitle: trimmedTitle || undefined,
    }));
    await this.save();
  }

  /**
   * Set the archived status for a session.
   */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      isArchived: archived || undefined,
    }));
    await this.save();
  }

  /**
   * Set the starred status for a session.
   */
  async setStarred(sessionId: string, starred: boolean): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      isStarred: starred || undefined,
    }));
    await this.save();
  }

  /**
   * Set the provider for a session.
   * This stores the provider name for backward compatibility with sessions
   * that don't have provider information in their JSONL files.
   */
  async setProvider(
    sessionId: string,
    provider: ProviderName | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      provider: provider || undefined,
    }));
    await this.save();
  }

  /**
   * Set the executor (SSH host) for a session.
   * Used to track which remote executor ran a session for resume.
   */
  async setExecutor(
    sessionId: string,
    executor: string | undefined,
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      executor: executor || undefined,
    }));
    await this.save();
  }

  /**
   * Get the provider for a session.
   * Returns undefined if the provider was never explicitly saved.
   */
  getProvider(sessionId: string): string | undefined {
    return this.state.sessions[sessionId]?.provider;
  }

  /**
   * Get the executor for a session.
   * Returns undefined if the session ran locally or executor is unknown.
   */
  getExecutor(sessionId: string): string | undefined {
    return this.state.sessions[sessionId]?.executor;
  }

  /**
   * Set the initial prompt accepted for a new session.
   * Used as a durable recovery source if provider startup fails before JSONL
   * persistence writes the user message.
   */
  async setInitialPrompt(
    sessionId: string,
    initialPrompt: string | undefined,
  ): Promise<void> {
    const prompt = initialPrompt?.trim() || undefined;
    this.updateSessionMetadata(sessionId, (metadata) => ({
      ...metadata,
      initialPrompt: prompt,
    }));
    await this.save();
  }

  /**
   * Update metadata for a session (title, archived, starred).
   */
  async updateMetadata(
    sessionId: string,
    updates: {
      title?: string;
      archived?: boolean;
      starred?: boolean;
      parentSessionId?: string | null;
      heartbeatTurnsEnabled?: boolean;
      heartbeatTurnsAfterMinutes?: number | null;
      heartbeatTurnText?: string | null;
      heartbeatForceAfterMinutes?: number | null;
    },
  ): Promise<void> {
    this.updateSessionMetadata(sessionId, (metadata) => {
      const result = { ...metadata };

      // Handle title
      if (updates.title !== undefined) {
        const trimmedTitle = sanitizeSessionTitle(updates.title);
        result.customTitle = trimmedTitle || undefined;
      }

      // Handle archived
      if (updates.archived !== undefined) {
        result.isArchived = updates.archived || undefined;
      }

      // Handle starred
      if (updates.starred !== undefined) {
        result.isStarred = updates.starred || undefined;
      }

      if (updates.parentSessionId !== undefined) {
        result.parentSessionId =
          updates.parentSessionId?.trim() || undefined;
      }

      if (updates.heartbeatTurnsEnabled !== undefined) {
        result.heartbeatTurnsEnabled = updates.heartbeatTurnsEnabled || undefined;
      }

      if (updates.heartbeatTurnsAfterMinutes !== undefined) {
        result.heartbeatTurnsAfterMinutes =
          updates.heartbeatTurnsAfterMinutes ?? undefined;
      }

      if (updates.heartbeatTurnText !== undefined) {
        result.heartbeatTurnText = updates.heartbeatTurnText?.trim() || undefined;
      }

      if (updates.heartbeatForceAfterMinutes !== undefined) {
        result.heartbeatForceAfterMinutes = updates.heartbeatForceAfterMinutes;
      }

      return result;
    });
    await this.save();
  }

  /**
   * Helper to update session metadata and clean up empty entries.
   */
  private updateSessionMetadata(
    sessionId: string,
    updater: (current: SessionMetadata) => SessionMetadata,
  ): void {
    const existing = this.state.sessions[sessionId] ?? {};
    const updated = updater(existing);

    // Remove undefined values and check if entry should be deleted
    const cleaned: SessionMetadata = {};
    if (updated.customTitle) cleaned.customTitle = updated.customTitle;
    if (updated.isArchived) cleaned.isArchived = updated.isArchived;
    if (updated.isStarred) cleaned.isStarred = updated.isStarred;
    if (updated.parentSessionId) cleaned.parentSessionId = updated.parentSessionId;
    if (updated.model) cleaned.model = updated.model;
    if (updated.provider) cleaned.provider = updated.provider;
    if (updated.executor) cleaned.executor = updated.executor;
    if (updated.initialPrompt) cleaned.initialPrompt = updated.initialPrompt;
    if (updated.heartbeatTurnsEnabled) {
      cleaned.heartbeatTurnsEnabled = updated.heartbeatTurnsEnabled;
    }
    if (updated.heartbeatTurnsAfterMinutes !== undefined) {
      cleaned.heartbeatTurnsAfterMinutes = updated.heartbeatTurnsAfterMinutes;
    }
    if (updated.heartbeatTurnText) {
      cleaned.heartbeatTurnText = updated.heartbeatTurnText;
    }
    if (updated.heartbeatForceAfterMinutes !== undefined) {
      cleaned.heartbeatForceAfterMinutes = updated.heartbeatForceAfterMinutes;
    }

    if (Object.keys(cleaned).length === 0) {
      // Remove the entry entirely if empty
      const { [sessionId]: _, ...rest } = this.state.sessions;
      this.state.sessions = rest;
    } else {
      this.state.sessions[sessionId] = cleaned;
    }
  }

  /**
   * Clear all metadata for a session.
   * Useful when a session is deleted.
   */
  async clearSession(sessionId: string): Promise<void> {
    if (this.state.sessions[sessionId]) {
      const { [sessionId]: _, ...rest } = this.state.sessions;
      this.state.sessions = rest;
      await this.save();
    }
  }

  /**
   * Save state to disk with debouncing to prevent excessive writes.
   */
  private async save(): Promise<void> {
    // If a save is in progress, mark that we need another save
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    // If another save was requested while we were saving, do it now
    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[SessionMetadataService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }
}
