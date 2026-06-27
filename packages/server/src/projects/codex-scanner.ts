/**
 * CodexSessionScanner - Scans Codex sessions and groups them by project (cwd).
 *
 * Unlike Claude which organizes sessions by project directory, Codex stores
 * sessions by date: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Each session file has session_meta as the first line containing the cwd.
 * We scan all sessions and group them by cwd to create virtual "projects".
 *
 * Scan results are cached with a short TTL to avoid redundant filesystem work
 * when multiple callers need session data in the same request cycle.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionDiscoveryIndex } from "../indexes/SessionDiscoveryIndex.js";
import { getLogger } from "../logging/logger.js";
import {
  type CodexRolloutDiscoveryStats,
  createCodexSessionDiscoveryIndex,
  createCodexRolloutDiscoveryStats,
  readCodexRolloutMetadata,
} from "../sessions/codex-discovery.js";
import type { Project } from "../supervisor/types.js";
import {
  codexRolloutRepresentation,
  isCodexRolloutFileName,
  preferPlainCodexRollouts,
} from "../utils/codexRolloutFiles.js";
import { canonicalizeProjectPath, encodeProjectId } from "./paths.js";

export const CODEX_SESSIONS_DIR =
  process.env.CODEX_SESSIONS_DIR ?? getDefaultCodexSessionsDir();
export const CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), ".codex");

export function getDefaultCodexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function getDefaultCodexSessionsDir(): string {
  return join(getDefaultCodexHomeDir(), "sessions");
}

interface CodexSessionInfo {
  id: string;
  cwd: string;
  filePath: string;
  timestamp: string;
  mtime: number;
  isSubagent: boolean;
}

export interface CodexScannerOptions {
  sessionsDir?: string; // override for testing
  dataDir?: string;
  discoveryIndex?: SessionDiscoveryIndex;
  slowLogThresholdMs?: number;
}

/** How long to cache scan results (ms) */
const SCAN_CACHE_TTL = 5_000;
const DEFAULT_SLOW_LOG_THRESHOLD_MS = 250;

export interface CodexScannerMetrics {
  sessionsDir: string;
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
  discovery: CodexRolloutDiscoveryStats;
}

export class CodexSessionScanner {
  private sessionsDir: string;
  private discoveryIndex?: SessionDiscoveryIndex;
  private slowLogThresholdMs: number;
  private cachedScan: { result: CodexSessionInfo[]; timestamp: number } | null =
    null;
  private lastScanMetrics: CodexScannerMetrics | null = null;

  constructor(options: CodexScannerOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? CODEX_SESSIONS_DIR;
    this.discoveryIndex =
      options.discoveryIndex ??
      createCodexSessionDiscoveryIndex(options.dataDir, this.sessionsDir);
    this.slowLogThresholdMs = Math.max(
      0,
      options.slowLogThresholdMs ?? DEFAULT_SLOW_LOG_THRESHOLD_MS,
    );
  }

  invalidateCache(): void {
    this.cachedScan = null;
  }

  getLastScanMetrics(): CodexScannerMetrics | null {
    return this.lastScanMetrics
      ? cloneCodexScannerMetrics(this.lastScanMetrics)
      : null;
  }

  /**
   * Scan all Codex sessions and group them by project (cwd).
   * Returns projects sorted by last activity (most recent first).
   */
  async listProjects(): Promise<Project[]> {
    const sessions = await this.scanAllSessions();

    // Group sessions by cwd
    const projectMap = new Map<
      string,
      { sessions: CodexSessionInfo[]; lastActivity: number }
    >();

    for (const session of sessions) {
      if (session.isSubagent) {
        continue;
      }

      const projectPath = canonicalizeProjectPath(session.cwd);
      const existing = projectMap.get(projectPath);
      if (existing) {
        existing.sessions.push(session);
        if (session.mtime > existing.lastActivity) {
          existing.lastActivity = session.mtime;
        }
      } else {
        projectMap.set(projectPath, {
          sessions: [session],
          lastActivity: session.mtime,
        });
      }
    }

    // Convert to Project[]
    const projects: Project[] = [];
    for (const [cwd, data] of projectMap) {
      projects.push({
        id: encodeProjectId(cwd),
        path: cwd,
        name: basename(cwd),
        sessionCount: data.sessions.length,
        sessionCountsByProvider: { codex: data.sessions.length },
        sessionDir: this.sessionsDir, // All sessions are in the same tree
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: new Date(data.lastActivity).toISOString(),
        provider: "codex",
      });
    }

    // Sort by last activity descending
    projects.sort((a, b) => {
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });

    return projects;
  }

  /**
   * Get sessions for a specific project (cwd).
   */
  async getSessionsForProject(
    projectPath: string,
  ): Promise<CodexSessionInfo[]> {
    const sessions = await this.scanAllSessions();
    const canonicalProjectPath = canonicalizeProjectPath(projectPath);
    return sessions
      .filter(
        (s) =>
          !s.isSubagent &&
          canonicalizeProjectPath(s.cwd) === canonicalProjectPath,
      )
      .sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * Scan all session files and extract metadata from the first line.
   * Results are cached for SCAN_CACHE_TTL to avoid redundant filesystem work.
   */
  private async scanAllSessions(): Promise<CodexSessionInfo[]> {
    if (
      this.cachedScan &&
      Date.now() - this.cachedScan.timestamp < SCAN_CACHE_TTL
    ) {
      return this.cachedScan.result;
    }

    const metrics = createCodexScannerMetrics(this.sessionsDir);
    const scanStartedAt = Date.now();
    const sessions: CodexSessionInfo[] = [];

    try {
      await stat(this.sessionsDir);
      metrics.sessionsDirExists = true;
    } catch {
      // Sessions directory doesn't exist
      this.cachedScan = { result: [], timestamp: Date.now() };
      metrics.durationMs = Date.now() - scanStartedAt;
      this.lastScanMetrics = cloneCodexScannerMetrics(metrics);
      this.logScanMetrics(metrics);
      return [];
    }

    // Recursively find all Codex rollout files. Codex may compress cold
    // rollouts from rollout-*.jsonl to rollout-*.jsonl.zst.
    const files = await this.findJsonlFiles(this.sessionsDir, metrics);

    getLogger().debug(
      `[CodexScanner] Found ${files.length} .jsonl files in ${this.sessionsDir}`,
    );

    // Read first line of each file in parallel (with concurrency limit)
    const BATCH_SIZE = 50;
    let failCount = 0;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((f) => this.readSessionMeta(f, metrics)),
      );
      for (const result of results) {
        if (result) {
          sessions.push(result);
        } else {
          failCount++;
        }
      }
    }
    await this.discoveryIndex?.flush();

    if (files.length > 0 && sessions.length === 0) {
      getLogger().warn(
        `[CodexScanner] Found ${files.length} .jsonl files but parsed 0 sessions (${failCount} failed). Session files may use an unsupported format. First file: ${files[0]}`,
      );
    } else if (failCount > 0) {
      getLogger().debug(
        `[CodexScanner] Parsed ${sessions.length} sessions, ${failCount} files skipped`,
      );
    }

    this.cachedScan = { result: sessions, timestamp: Date.now() };
    metrics.sessionsParsed = sessions.length;
    metrics.failedFiles = failCount;
    metrics.durationMs = Date.now() - scanStartedAt;
    this.lastScanMetrics = cloneCodexScannerMetrics(metrics);
    this.logScanMetrics(metrics);
    return sessions;
  }

  /**
   * Recursively find all Codex rollout files in a directory.
   */
  private async findJsonlFiles(
    dir: string,
    metrics: CodexScannerMetrics,
  ): Promise<string[]> {
    const files: string[] = [];
    await this.collectJsonlFiles(dir, files, metrics);
    const preferredFiles = preferPlainCodexRollouts(files);
    metrics.rolloutFilesAfterPrecedence = preferredFiles.length;
    metrics.precedenceSkippedCompressed = files.length - preferredFiles.length;
    return preferredFiles;
  }

  private async collectJsonlFiles(
    dir: string,
    files: string[],
    metrics: CodexScannerMetrics,
  ): Promise<void> {
    try {
      metrics.directoriesVisited += 1;
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.collectJsonlFiles(fullPath, files, metrics);
        } else if (entry.isFile() && isCodexRolloutFileName(entry.name)) {
          files.push(fullPath);
          metrics.rolloutFilesFound += 1;
          if (codexRolloutRepresentation(fullPath) === "zstd") {
            metrics.compressedRolloutFiles += 1;
          } else {
            metrics.plainRolloutFiles += 1;
          }
        }
      }
    } catch (error) {
      metrics.directoryReadErrors += 1;
      getLogger().debug(
        `[CodexScanner] Error scanning directory ${dir}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Read just the first line of a session file to extract metadata.
   * Reads only the first 4KB to avoid loading large session files.
   */
  private async readSessionMeta(
    filePath: string,
    metrics: CodexScannerMetrics,
  ): Promise<CodexSessionInfo | null> {
    try {
      const session = await readCodexRolloutMetadata({
        sessionsDir: this.sessionsDir,
        filePath,
        ...(this.discoveryIndex ? { discoveryIndex: this.discoveryIndex } : {}),
        metrics: metrics.discovery,
      });
      if (!session) return null;
      return {
        id: session.id,
        cwd: session.cwd,
        filePath,
        timestamp: session.timestamp,
        mtime: session.mtime,
        isSubagent: session.isSubagent,
      };
    } catch (error) {
      getLogger().debug(
        `[CodexScanner] Error reading ${filePath}: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private logScanMetrics(metrics: CodexScannerMetrics): void {
    const payload = {
      event: "codex_scanner_scan",
      ...metrics,
    };
    if (metrics.durationMs >= this.slowLogThresholdMs) {
      getLogger().warn(payload, "CODEX_SCANNER: slow scan");
      return;
    }
    getLogger().debug(payload, "CODEX_SCANNER: scan complete");
  }
}

// Singleton for convenience
export const codexSessionScanner = new CodexSessionScanner();

function createCodexScannerMetrics(sessionsDir: string): CodexScannerMetrics {
  return {
    sessionsDir,
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
    discovery: createCodexRolloutDiscoveryStats(),
  };
}

function cloneCodexScannerMetrics(
  metrics: CodexScannerMetrics,
): CodexScannerMetrics {
  return {
    ...metrics,
    discovery: { ...metrics.discovery },
  };
}
