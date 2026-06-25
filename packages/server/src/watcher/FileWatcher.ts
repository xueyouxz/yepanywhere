import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "../logging/logger.js";
import { isCodexRolloutFileName } from "../utils/codexRolloutFiles.js";
import type {
  EventBus,
  FileChangeEvent,
  FileChangeType,
  WatchProvider,
} from "./EventBus.js";

export interface FileWatcherOptions {
  /** Directory to watch (e.g., ~/.claude) */
  watchDir: string;
  /** Provider that owns this directory */
  provider: WatchProvider;
  /** EventBus to emit events to */
  eventBus: EventBus;
  /** Debounce delay in ms (default: 200) */
  debounceMs?: number;
  /**
   * Optional periodic full-tree rescan interval (ms).
   * Useful on platforms where fs.watch may miss deep file writes.
   */
  periodicRescanMs?: number;
  /** Slow rescan log threshold in ms (default: 250). */
  rescanSlowLogThresholdMs?: number;
}

export type FileWatcherRescanReason = "fallback" | "periodic";

export interface FileWatcherRescanMetrics {
  provider: WatchProvider;
  watchDir: string;
  reason: FileWatcherRescanReason;
  periodicRescanMs: number;
  durationMs: number;
  directoriesVisited: number;
  filesScanned: number;
  directoryReadErrors: number;
  statFailures: number;
  knownFilesBefore: number;
  currentFiles: number;
  knownFilesAfter: number;
  createEvents: number;
  modifyEvents: number;
  deleteEvents: number;
  emittedEvents: number;
  sessionEvents: number;
  agentSessionEvents: number;
  otherEvents: number;
  overlapSkipsSinceLast: number;
  overlapSkipsTotal: number;
}

const DEFAULT_RESCAN_SLOW_LOG_THRESHOLD_MS = 250;

export class FileWatcher {
  private watchDir: string;
  private provider: WatchProvider;
  private eventBus: EventBus;
  private debounceMs: number;
  private periodicRescanMs: number;
  private rescanSlowLogThresholdMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private rescanTimer: NodeJS.Timeout | null = null;
  private rescanInProgress = false;
  private periodicRescanTimer: NodeJS.Timeout | null = null;
  private knownFileMtimes: Map<string, number> = new Map();
  private lastRescanMetrics: FileWatcherRescanMetrics | null = null;
  private rescanOverlapSkipsSinceLast = 0;
  private rescanOverlapSkipsTotal = 0;

  constructor(options: FileWatcherOptions) {
    this.watchDir = options.watchDir;
    this.provider = options.provider;
    this.eventBus = options.eventBus;
    this.debounceMs = options.debounceMs ?? 200;
    this.periodicRescanMs = options.periodicRescanMs ?? 0;
    this.rescanSlowLogThresholdMs = Math.max(
      0,
      options.rescanSlowLogThresholdMs ??
        DEFAULT_RESCAN_SLOW_LOG_THRESHOLD_MS,
    );
  }

  /**
   * Start watching for file changes.
   */
  start(): void {
    if (this.watcher) {
      return; // Already watching
    }

    // Build initial file list for detecting create vs modify
    this.scanExistingFiles();

    try {
      this.watcher = fs.watch(
        this.watchDir,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) {
            getLogger().debug(
              `[FileWatcher] Raw event provider=${this.provider} type=${eventType} file=<null> path=${this.watchDir}`,
            );
            this.scheduleRescan();
            return;
          }
          this.handleFileEvent(eventType, filename);
        },
      );

      this.watcher.on("error", (error) => {
        console.error("[FileWatcher] Error:", error);
      });

      getLogger().info(`[FileWatcher] Watching ${this.watchDir}`);

      if (this.periodicRescanMs > 0) {
        this.periodicRescanTimer = setInterval(() => {
          this.rescanAndEmit("periodic");
        }, this.periodicRescanMs);
        getLogger().info(
          `[FileWatcher] Periodic rescan enabled (${this.periodicRescanMs}ms) for ${this.watchDir}`,
        );
      }
    } catch (error) {
      console.error("[FileWatcher] Failed to start:", error);
    }
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.periodicRescanTimer) {
      clearInterval(this.periodicRescanTimer);
      this.periodicRescanTimer = null;
    }
    this.knownFileMtimes.clear();

    getLogger().info("[FileWatcher] Stopped");
  }

  /**
   * Check if watcher is active.
   */
  get isWatching(): boolean {
    return this.watcher !== null;
  }

  getLastRescanMetrics(): FileWatcherRescanMetrics | null {
    return this.lastRescanMetrics
      ? { ...this.lastRescanMetrics }
      : null;
  }

  private scanExistingFiles(): void {
    this.knownFileMtimes.clear();
    this.scanDir(this.watchDir, this.knownFileMtimes);
  }

  private scanDir(
    dir: string,
    index: Map<string, number>,
    metrics?: FileWatcherRescanMetrics,
  ): void {
    try {
      if (metrics) metrics.directoriesVisited += 1;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.scanDir(fullPath, index, metrics);
        } else {
          if (metrics) metrics.filesScanned += 1;
          try {
            const stats = fs.statSync(fullPath);
            index.set(fullPath, stats.mtimeMs);
          } catch {
            if (metrics) metrics.statFailures += 1;
            // File may have disappeared between readdir/stat
          }
        }
      }
    } catch {
      if (metrics) metrics.directoryReadErrors += 1;
      // Ignore errors (e.g., permission denied)
    }
  }

  private handleFileEvent(eventType: string, filename: string): void {
    const fullPath = path.join(this.watchDir, filename);

    getLogger().debug(
      `[FileWatcher] Raw event provider=${this.provider} type=${eventType} file=${filename} path=${fullPath}`,
    );

    // Debounce per-file
    const existingTimer = this.debounceTimers.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullPath);
      this.emitEvent(fullPath, eventType);
    }, this.debounceMs);

    this.debounceTimers.set(fullPath, timer);
  }

  private emitEvent(fullPath: string, _eventType: string): void {
    // Determine change type
    let changeType: FileChangeType;
    const fileExists = fs.existsSync(fullPath);

    if (!fileExists) {
      if (this.knownFileMtimes.has(fullPath)) {
        changeType = "delete";
        this.knownFileMtimes.delete(fullPath);
      } else {
        // File never existed from our POV, skip
        return;
      }
    } else {
      let mtimeMs = Date.now();
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {
        // File disappeared between existsSync and statSync
        return;
      }

      if (this.knownFileMtimes.has(fullPath)) {
        const previousMtime = this.knownFileMtimes.get(fullPath);
        if (previousMtime === mtimeMs) {
          // No meaningful change; skip duplicate callback.
          return;
        }
        changeType = "modify";
      } else {
        changeType = "create";
      }
      this.knownFileMtimes.set(fullPath, mtimeMs);
    }

    this.emitFileChangeEvent(fullPath, changeType);
  }

  private emitFileChangeEvent(
    fullPath: string,
    changeType: FileChangeType,
    metrics?: FileWatcherRescanMetrics,
  ): void {
    const relativePath = path.relative(this.watchDir, fullPath);

    const event: FileChangeEvent = {
      type: "file-change",
      provider: this.provider,
      path: fullPath,
      relativePath,
      changeType,
      timestamp: new Date().toISOString(),
      fileType: this.parseFileType(relativePath),
    };

    if (metrics) {
      metrics.emittedEvents += 1;
      if (changeType === "create") metrics.createEvents += 1;
      if (changeType === "modify") metrics.modifyEvents += 1;
      if (changeType === "delete") metrics.deleteEvents += 1;
      if (event.fileType === "session") {
        metrics.sessionEvents += 1;
      } else if (event.fileType === "agent-session") {
        metrics.agentSessionEvents += 1;
      } else {
        metrics.otherEvents += 1;
      }
    }

    getLogger().debug(
      `[FileWatcher] Emitting file-change provider=${event.provider} changeType=${event.changeType} fileType=${event.fileType} relativePath=${event.relativePath}`,
    );

    this.eventBus.emit(event);
  }

  /**
   * When fs.watch provides no filename (common on macOS under load),
   * rescan the tree and synthesize events from mtime/delete deltas.
   */
  private scheduleRescan(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
    }

    getLogger().debug(
      `[FileWatcher] Scheduling fallback rescan provider=${this.provider}`,
    );

    this.rescanTimer = setTimeout(
      () => {
        this.rescanTimer = null;
        this.rescanAndEmit("fallback");
      },
      Math.max(this.debounceMs * 2, 400),
    );
  }

  private rescanAndEmit(reason: FileWatcherRescanReason): void {
    if (this.rescanInProgress) {
      this.rescanOverlapSkipsSinceLast += 1;
      this.rescanOverlapSkipsTotal += 1;
      getLogger().debug(
        {
          event: "file_watcher_rescan_skipped",
          provider: this.provider,
          watchDir: this.watchDir,
          reason,
          overlapSkipsSinceLast: this.rescanOverlapSkipsSinceLast,
          overlapSkipsTotal: this.rescanOverlapSkipsTotal,
        },
        "FILE_WATCHER: rescan skipped; already in progress",
      );
      return;
    }
    this.rescanInProgress = true;
    const metrics = this.createRescanMetrics(reason);
    const startedAt = Date.now();

    try {
      getLogger().debug(
        `[FileWatcher] Running ${reason} rescan provider=${this.provider}`,
      );
      const current = new Map<string, number>();
      metrics.knownFilesBefore = this.knownFileMtimes.size;
      this.scanDir(this.watchDir, current, metrics);
      metrics.currentFiles = current.size;

      // Create/modify events
      for (const [fullPath, mtimeMs] of current.entries()) {
        const prevMtime = this.knownFileMtimes.get(fullPath);
        if (prevMtime === undefined || prevMtime !== mtimeMs) {
          this.emitFileChangeEvent(
            fullPath,
            prevMtime === undefined ? "create" : "modify",
            metrics,
          );
        }
      }

      // Delete events
      for (const fullPath of this.knownFileMtimes.keys()) {
        if (!current.has(fullPath)) {
          this.emitFileChangeEvent(fullPath, "delete", metrics);
        }
      }

      this.knownFileMtimes = current;
      metrics.knownFilesAfter = this.knownFileMtimes.size;
    } finally {
      metrics.durationMs = Date.now() - startedAt;
      this.lastRescanMetrics = { ...metrics };
      this.logRescanMetrics(metrics);
      this.rescanOverlapSkipsSinceLast = 0;
      this.rescanInProgress = false;
    }
  }

  private createRescanMetrics(
    reason: FileWatcherRescanReason,
  ): FileWatcherRescanMetrics {
    return {
      provider: this.provider,
      watchDir: this.watchDir,
      reason,
      periodicRescanMs: this.periodicRescanMs,
      durationMs: 0,
      directoriesVisited: 0,
      filesScanned: 0,
      directoryReadErrors: 0,
      statFailures: 0,
      knownFilesBefore: this.knownFileMtimes.size,
      currentFiles: 0,
      knownFilesAfter: this.knownFileMtimes.size,
      createEvents: 0,
      modifyEvents: 0,
      deleteEvents: 0,
      emittedEvents: 0,
      sessionEvents: 0,
      agentSessionEvents: 0,
      otherEvents: 0,
      overlapSkipsSinceLast: this.rescanOverlapSkipsSinceLast,
      overlapSkipsTotal: this.rescanOverlapSkipsTotal,
    };
  }

  private logRescanMetrics(metrics: FileWatcherRescanMetrics): void {
    const payload = {
      event: "file_watcher_rescan",
      ...metrics,
    };
    if (metrics.durationMs >= this.rescanSlowLogThresholdMs) {
      getLogger().warn(payload, "FILE_WATCHER: slow rescan");
      return;
    }
    getLogger().debug(payload, "FILE_WATCHER: rescan complete");
  }

  private parseFileType(relativePath: string): FileChangeEvent["fileType"] {
    switch (this.provider) {
      case "claude":
        return this.parseClaudeFileType(relativePath);
      case "gemini":
        return this.parseGeminiFileType(relativePath);
      case "codex":
        return this.parseCodexFileType(relativePath);
      case "pi":
        return this.parsePiFileType(relativePath);
    }
  }

  private parseClaudeFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.claude/projects - relativePath is {hash}/{session}.jsonl
    if (relativePath.endsWith(".jsonl")) {
      if (path.basename(relativePath).startsWith("agent-")) {
        return "agent-session";
      }
      return "session";
    }
    return "other";
  }

  private parseGeminiFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.gemini/tmp - relativePath is {hash}/chats/session-*.json
    // On Windows, path.relative() returns backslashes
    if (
      (relativePath.includes("/chats/") ||
        relativePath.includes("\\chats\\")) &&
      relativePath.endsWith(".json")
    ) {
      return "session";
    }
    return "other";
  }

  private parseCodexFileType(
    relativePath: string,
  ): FileChangeEvent["fileType"] {
    // Watching ~/.codex/sessions - relativePath is {year}/{month}/{day}/rollout-*.jsonl[.zst]
    if (isCodexRolloutFileName(path.basename(relativePath))) {
      return "session";
    }
    return "other";
  }

  private parsePiFileType(relativePath: string): FileChangeEvent["fileType"] {
    // Watching ~/.pi/agent/sessions - relativePath is {encoded-cwd}/{ts}_{uuid}.jsonl.
    if (relativePath.endsWith(".jsonl")) {
      return "session";
    }
    return "other";
  }
}
