import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_PROVIDER,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { ProjectMetadataService } from "../metadata/index.js";
import type { Project } from "../supervisor/types.js";
import type { EventBus, FileChangeEvent } from "../watcher/index.js";
import { CODEX_SESSIONS_DIR, CodexSessionScanner } from "./codex-scanner.js";
import { GEMINI_TMP_DIR, GeminiSessionScanner } from "./gemini-scanner.js";
import {
  CLAUDE_PROJECTS_DIR,
  canonicalizeProjectPath,
  decodeProjectId,
  encodeProjectId,
  getProjectName,
  isAbsolutePath,
  normalizeProjectPathForDedup,
  readCwdFromSessionFile,
} from "./paths.js";

export interface ScannerOptions {
  projectsDir?: string; // override for testing
  codexSessionsDir?: string; // override for testing
  geminiSessionsDir?: string; // override for testing
  projectScanCachePath?: string; // optional persistent cache path
  codexScanner?: CodexSessionScanner | null; // shared provider scanner
  geminiScanner?: GeminiSessionScanner | null; // shared provider scanner
  enableCodex?: boolean; // whether to include Codex projects (default: true)
  enableGemini?: boolean; // whether to include Gemini projects (default: true)
  projectMetadataService?: ProjectMetadataService; // for persisting added projects
  /** Optional EventBus for watcher-driven cache invalidation */
  eventBus?: EventBus;
  /** Project snapshot TTL in milliseconds (default: 5000) */
  cacheTtlMs?: number;
}

const CLAUDE_PROJECT_SCAN_BATCH_SIZE = 16;
const CWD_SCAN_BATCH_SIZE = 8;
const PROJECT_SCAN_CACHE_VERSION = 1;

interface ProjectScanSourceState {
  projectsDir: string;
  projectsDirMtimeMs: number | null;
  projectsDirExists: boolean;
  projectsDirEntries: string[];
  codexSessionsDir: string;
  codexSessionsDirMtimeMs: number | null;
  codexSessionsDirExists: boolean;
  geminiSessionsDir: string;
  geminiSessionsDirMtimeMs: number | null;
  geminiSessionsDirExists: boolean;
  projectMetadataFilePath: string | null;
  projectMetadataFileMtimeMs: number | null;
  projectMetadataFileExists: boolean;
  enableCodex: boolean;
  enableGemini: boolean;
}

interface CachedProjectSnapshotData {
  cacheVersion: number;
  generatedAt: number;
  sourceState: ProjectScanSourceState;
  projects: Project[];
}

interface ProjectSnapshot {
  projects: Project[];
  byId: Map<string, Project>;
  bySessionDirSuffix: Map<string, Project>;
  timestamp: number;
}

export class ProjectScanner {
  private projectsDir: string;
  private codexSessionsDir: string;
  private geminiSessionsDir: string;
  private codexScanner: CodexSessionScanner | null;
  private geminiScanner: GeminiSessionScanner | null;
  private enableCodex: boolean;
  private enableGemini: boolean;
  private projectMetadataService: ProjectMetadataService | null;
  private projectMetadataFilePath: string | null;
  private projectScanCachePath: string | null;
  private cacheTtlMs: number;
  private cacheDirty = false;
  private snapshot: ProjectSnapshot | null = null;
  private inFlightScan: Promise<ProjectSnapshot> | null = null;
  private unsubscribeEventBus: (() => void) | null = null;

  constructor(options: ScannerOptions = {}) {
    this.projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
    this.codexSessionsDir = options.codexSessionsDir ?? CODEX_SESSIONS_DIR;
    this.geminiSessionsDir = options.geminiSessionsDir ?? GEMINI_TMP_DIR;
    this.enableCodex = options.enableCodex ?? true;
    this.enableGemini = options.enableGemini ?? true;
    this.codexScanner = this.enableCodex
      ? (options.codexScanner ??
        new CodexSessionScanner({
          sessionsDir: this.codexSessionsDir,
        }))
      : null;
    this.geminiScanner = this.enableGemini
      ? (options.geminiScanner ??
        new GeminiSessionScanner({
          sessionsDir: this.geminiSessionsDir,
        }))
      : null;
    this.projectMetadataService = options.projectMetadataService ?? null;
    this.projectMetadataFilePath =
      this.projectMetadataService?.getFilePath?.() ?? null;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 5000);
    this.projectScanCachePath = options.projectScanCachePath ?? null;

    if (options.eventBus) {
      this.unsubscribeEventBus = options.eventBus.subscribe((event) => {
        if (event.type !== "file-change") return;
        this.handleFileChange(event);
      });
    }
  }

  /**
   * Set the project metadata service (for late initialization).
   */
  setProjectMetadataService(service: ProjectMetadataService): void {
    this.projectMetadataService = service;
    this.projectMetadataFilePath = service.getFilePath?.() ?? null;
    this.invalidateCache();
  }

  async listProjects(): Promise<Project[]> {
    const snapshot = await this.getSnapshot();
    return snapshot.projects.map((project) => this.cloneProject(project));
  }

  /**
   * Mark the project snapshot stale so next read triggers a rescan.
   */
  invalidateCache(): void {
    this.cacheDirty = true;
  }

  private async getSnapshot(forceRefresh = false): Promise<ProjectSnapshot> {
    const now = Date.now();
    const isFresh =
      this.snapshot &&
      !this.cacheDirty &&
      now - this.snapshot.timestamp < this.cacheTtlMs;

    if (!forceRefresh && isFresh && this.snapshot) {
      return this.snapshot;
    }

    if (this.inFlightScan) {
      return this.inFlightScan;
    }

    const scanPromise = this.scanFromCacheOrFilesystem(now, forceRefresh)
      .then((snapshot) => {
        this.snapshot = snapshot;
        this.cacheDirty = false;
        return snapshot;
      })
      .finally(() => {
        if (this.inFlightScan === scanPromise) {
          this.inFlightScan = null;
        }
      });

    this.inFlightScan = scanPromise;
    return scanPromise;
  }

  private async scanFromCacheOrFilesystem(
    now: number,
    forceRefresh: boolean,
  ): Promise<ProjectSnapshot> {
    if (!forceRefresh && !this.cacheDirty) {
      const cached = await this.loadSnapshotFromDisk(now);
      if (cached) {
        return cached;
      }
    }

    const projects = await this.scanProjects();
    const snapshot = this.buildSnapshot(projects);
    void this.saveSnapshotToDisk(snapshot).catch((error) => {
      console.warn(
        "[ProjectScanner] failed to persist project scan cache:",
        error,
      );
    });
    return snapshot;
  }

  private buildSnapshot(projects: Project[], timestamp = Date.now()): ProjectSnapshot {
    const byId = new Map<string, Project>();
    const bySessionDirSuffix = new Map<string, Project>();

    for (const project of projects) {
      byId.set(project.id, project);

      const primarySuffix = this.normalizeDirSuffix(
        this.sessionDirToSuffix(project.sessionDir),
      );
      if (primarySuffix) {
        bySessionDirSuffix.set(primarySuffix, project);
      }

      for (const mergedDir of project.mergedSessionDirs ?? []) {
        const mergedSuffix = this.normalizeDirSuffix(
          this.sessionDirToSuffix(mergedDir),
        );
        if (mergedSuffix) {
          bySessionDirSuffix.set(mergedSuffix, project);
        }
      }
    }

    return {
      projects,
      byId,
      bySessionDirSuffix,
      timestamp,
    };
  }

  private async loadSnapshotFromDisk(
    now: number,
  ): Promise<ProjectSnapshot | null> {
    if (!this.projectScanCachePath) return null;

    try {
      const content = await readFile(this.projectScanCachePath, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      if (!this.isValidCachedSnapshot(parsed)) {
        return null;
      }

      if (now - parsed.generatedAt > this.cacheTtlMs) {
        return null;
      }

      const currentSourceState = await this.getSourceState();
      if (!this.areSourceStatesCompatible(currentSourceState, parsed.sourceState)) {
        return null;
      }

      if (parsed.projects.length === 0) {
        return null;
      }

      const projects: Project[] = [];
      for (const project of parsed.projects) {
        if (!this.isValidCachedProject(project)) {
          return null;
        }
        projects.push({
          ...project,
          mergedSessionDirs: project.mergedSessionDirs
            ? [...project.mergedSessionDirs]
            : undefined,
        });
      }

      return this.buildSnapshot(projects, parsed.generatedAt);
    } catch {
      return null;
    }
  }

  private async saveSnapshotToDisk(snapshot: ProjectSnapshot): Promise<void> {
    if (!this.projectScanCachePath) return;

    const sourceState = await this.getSourceState();
    const data: CachedProjectSnapshotData = {
      cacheVersion: PROJECT_SCAN_CACHE_VERSION,
      generatedAt: snapshot.timestamp,
      sourceState,
      projects: snapshot.projects,
    };

    await mkdir(dirname(this.projectScanCachePath), { recursive: true });
    await writeFile(
      this.projectScanCachePath,
      JSON.stringify(data),
      "utf-8",
    );
  }

  private async getSourceState(): Promise<ProjectScanSourceState> {
    const [
      projectsDirEntries,
      projectsDirState,
      codexSessionsState,
      geminiSessionsState,
      metadataState,
    ] = await Promise.all([
      this.getDirectoryEntries(this.projectsDir),
      this.getPathState(this.projectsDir),
      this.getPathState(this.codexSessionsDir),
      this.getPathState(this.geminiSessionsDir),
      this.projectMetadataFilePath
        ? this.getPathState(this.projectMetadataFilePath)
        : Promise.resolve({ exists: false, mtimeMs: null }),
    ]);

    return {
      projectsDir: this.projectsDir,
      projectsDirMtimeMs: projectsDirState.mtimeMs,
      projectsDirExists: projectsDirState.exists,
      projectsDirEntries,
      codexSessionsDir: this.codexSessionsDir,
      codexSessionsDirMtimeMs: codexSessionsState.mtimeMs,
      codexSessionsDirExists: codexSessionsState.exists,
      geminiSessionsDir: this.geminiSessionsDir,
      geminiSessionsDirMtimeMs: geminiSessionsState.mtimeMs,
      geminiSessionsDirExists: geminiSessionsState.exists,
      projectMetadataFilePath: this.projectMetadataFilePath,
      projectMetadataFileMtimeMs: metadataState.mtimeMs,
      projectMetadataFileExists: metadataState.exists,
      enableCodex: this.enableCodex,
      enableGemini: this.enableGemini,
    };
  }

  private async getDirectoryEntries(
    targetPath: string,
  ): Promise<string[]> {
    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async getPathState(
    targetPath: string,
  ): Promise<{ exists: boolean; mtimeMs: number | null }> {
    try {
      const stats = await stat(targetPath);
      return { exists: true, mtimeMs: stats.mtimeMs };
    } catch {
      return { exists: false, mtimeMs: null };
    }
  }

  private areSourceStatesCompatible(
    current: ProjectScanSourceState,
    cached: ProjectScanSourceState,
  ): boolean {
    return (
      current.projectsDir === cached.projectsDir &&
      current.projectsDirExists === cached.projectsDirExists &&
      current.projectsDirMtimeMs === cached.projectsDirMtimeMs &&
      current.projectsDirEntries.length === cached.projectsDirEntries.length &&
      current.projectsDirEntries.every(
        (entry, index) => entry === cached.projectsDirEntries[index],
      ) &&
      current.codexSessionsDir === cached.codexSessionsDir &&
      current.codexSessionsDirExists === cached.codexSessionsDirExists &&
      current.codexSessionsDirMtimeMs === cached.codexSessionsDirMtimeMs &&
      current.geminiSessionsDir === cached.geminiSessionsDir &&
      current.geminiSessionsDirExists === cached.geminiSessionsDirExists &&
      current.geminiSessionsDirMtimeMs === cached.geminiSessionsDirMtimeMs &&
      current.projectMetadataFilePath === cached.projectMetadataFilePath &&
      current.projectMetadataFileExists === cached.projectMetadataFileExists &&
      current.projectMetadataFileMtimeMs === cached.projectMetadataFileMtimeMs &&
      current.enableCodex === cached.enableCodex &&
      current.enableGemini === cached.enableGemini
    );
  }

  private isValidCachedSnapshot(
    value: unknown,
  ): value is CachedProjectSnapshotData {
    if (typeof value !== "object" || value === null) return false;

    const snapshot = value as Partial<CachedProjectSnapshotData>;
    if (snapshot.cacheVersion !== PROJECT_SCAN_CACHE_VERSION) return false;
    if (typeof snapshot.generatedAt !== "number") return false;
    if (!Array.isArray(snapshot.projects)) return false;
    if (!this.isValidSourceState(snapshot.sourceState)) return false;

    return true;
  }

  private isValidSourceState(value: unknown): value is ProjectScanSourceState {
    if (typeof value !== "object" || value === null) return false;
    const state = value as Partial<ProjectScanSourceState>;

    return (
      typeof state.projectsDir === "string" &&
      (state.projectsDirMtimeMs === null ||
        typeof state.projectsDirMtimeMs === "number") &&
      typeof state.projectsDirExists === "boolean" &&
      Array.isArray(state.projectsDirEntries) &&
      state.projectsDirEntries.every((entry) => typeof entry === "string") &&
      typeof state.codexSessionsDir === "string" &&
      (state.codexSessionsDirMtimeMs === null ||
        typeof state.codexSessionsDirMtimeMs === "number") &&
      typeof state.codexSessionsDirExists === "boolean" &&
      typeof state.geminiSessionsDir === "string" &&
      (state.geminiSessionsDirMtimeMs === null ||
        typeof state.geminiSessionsDirMtimeMs === "number") &&
      typeof state.geminiSessionsDirExists === "boolean" &&
      (state.projectMetadataFilePath === null ||
        typeof state.projectMetadataFilePath === "string") &&
      (state.projectMetadataFileMtimeMs === null ||
        typeof state.projectMetadataFileMtimeMs === "number") &&
      typeof state.projectMetadataFileExists === "boolean" &&
      typeof state.enableCodex === "boolean" &&
      typeof state.enableGemini === "boolean"
    );
  }

  private isValidCachedProject(value: unknown): value is Project {
    if (typeof value !== "object" || value === null) return false;
    const project = value as Partial<Project>;

    return (
      typeof project.id === "string" &&
      typeof project.path === "string" &&
      typeof project.name === "string" &&
      typeof project.sessionDir === "string" &&
      typeof project.sessionCount === "number" &&
      typeof project.activeOwnedCount === "number" &&
      typeof project.activeExternalCount === "number" &&
      (project.lastActivity === null || typeof project.lastActivity === "string") &&
      typeof project.provider === "string" &&
      (project.mergedSessionDirs === undefined ||
        (Array.isArray(project.mergedSessionDirs) &&
          project.mergedSessionDirs.every((item) => typeof item === "string"))) &&
      (project.hasCodexSessions === undefined ||
        typeof project.hasCodexSessions === "boolean") &&
      (project.hasGeminiSessions === undefined ||
        typeof project.hasGeminiSessions === "boolean")
    );
  }

  private sessionDirToSuffix(sessionDir: string): string {
    // Claude session dirs live under projectsDir; codex/gemini do not.
    const relative = sessionDir.startsWith(this.projectsDir)
      ? sessionDir.slice(this.projectsDir.length)
      : sessionDir;
    return relative.replace(/^[\\/]+/, "");
  }

  private normalizeDirSuffix(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  private cloneProject(project: Project): Project {
    return {
      ...project,
      mergedSessionDirs: project.mergedSessionDirs
        ? [...project.mergedSessionDirs]
        : undefined,
      hasCodexSessions: project.hasCodexSessions,
      hasGeminiSessions: project.hasGeminiSessions,
    };
  }

  private handleFileChange(event: FileChangeEvent): void {
    if (event.fileType !== "session" && event.fileType !== "agent-session") {
      return;
    }

    // Any session file delta can affect project existence/count/lastActivity.
    this.invalidateCache();
    if (event.provider === "codex") {
      this.codexScanner?.invalidateCache();
    } else if (event.provider === "gemini") {
      this.geminiScanner?.invalidateCache();
    }
  }

  private async scanProjects(): Promise<Project[]> {
    const projects: Project[] = [];
    const seenPaths = new Set<string>();
    // Map from normalized path to project index for cross-machine dedup
    const normalizedIndex = new Map<string, number>();

    // ~/.claude/projects/ can have two structures:
    // 1. Projects directly as -home-user-project/
    // 2. Projects under hostname/ as hostname/-home-user-project/
    let dirs: string[] = [];
    try {
      await access(this.projectsDir);
      const entries = await readdir(this.projectsDir, { withFileTypes: true });
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // Directory doesn't exist or unreadable — skip Claude project scanning
      // but continue to Codex/Gemini/metadata merge below
    }

    // Helper to add a Claude project, merging cross-machine duplicates
    const addOrMerge = (
      rawProjectPath: string,
      sessionDir: string,
      sessionCount: number,
      lastActivity: string | null,
    ) => {
      const projectPath = canonicalizeProjectPath(rawProjectPath);
      if (this.isHiddenProjectPath(projectPath)) return;
      if (seenPaths.has(projectPath)) return; // exact path duplicate
      seenPaths.add(projectPath);

      const normalized = normalizeProjectPathForDedup(projectPath);
      const existingIdx = normalizedIndex.get(normalized);

      if (existingIdx !== undefined) {
        // Cross-machine duplicate — merge into existing project
        const existing = projects[existingIdx];
        if (!existing) return;
        existing.sessionCount += sessionCount;
        if (!existing.mergedSessionDirs) {
          existing.mergedSessionDirs = [];
        }
        existing.mergedSessionDirs.push(sessionDir);
        if (
          lastActivity &&
          (!existing.lastActivity || lastActivity > existing.lastActivity)
        ) {
          existing.lastActivity = lastActivity;
        }

        // Prefer the local path for session creation.
        // Remote executor sessions (rsynced) may store a foreign cwd
        // (e.g., /Users/... on a Linux host). Swap to the local path
        // so new sessions can actually spawn in an existing directory.
        const localHome = homedir();
        const localHomePrefix = `${localHome}/`;
        const localHomePrefixWin = `${localHome}\\`;
        const existingIsLocal =
          existing.path.startsWith(localHomePrefix) ||
          existing.path.startsWith(localHomePrefixWin);
        const newIsLocal =
          projectPath.startsWith(localHomePrefix) ||
          projectPath.startsWith(localHomePrefixWin);
        if (!existingIsLocal && newIsLocal) {
          existing.path = projectPath;
          existing.id = encodeProjectId(projectPath);
          existing.name = getProjectName(projectPath);
        }
      } else {
        normalizedIndex.set(normalized, projects.length);
        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: getProjectName(projectPath),
          sessionCount,
          sessionDir,
          hasCodexSessions: false,
          hasGeminiSessions: false,
          activeOwnedCount: 0, // populated by route
          activeExternalCount: 0, // populated by route
          lastActivity,
          provider: "claude",
        });
      }
    };

    for (const dir of dirs) {
      const dirPath = join(this.projectsDir, dir);

      // Check if this is a project directory
      // On Unix/macOS: /home/user/project → -home-user-project (starts with -)
      // On Windows: C:\Users\kaa\project → c--Users-kaa-project (drive letter + --)
      if (dir.startsWith("-") || /^[a-zA-Z]--/.test(dir)) {
        const info = await this.getProjectDirInfo(dirPath);
        if (info) {
          addOrMerge(
            info.projectPath,
            dirPath,
            info.sessionCount,
            info.lastActivity,
          );
        }
        continue;
      }

      // Otherwise, treat as hostname directory
      // Format: ~/.claude/projects/hostname/-project-path/
      let projectDirNames: string[];
      try {
        const subEntries = await readdir(dirPath, { withFileTypes: true });
        projectDirNames = subEntries
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }

      const projectDirPaths = projectDirNames.map((projectDir) =>
        join(dirPath, projectDir),
      );
      for (let i = 0; i < projectDirPaths.length; i += CLAUDE_PROJECT_SCAN_BATCH_SIZE) {
        const batch = projectDirPaths.slice(i, i + CLAUDE_PROJECT_SCAN_BATCH_SIZE);
        const batchInfos = await Promise.all(
          batch.map((projectDirPath) => this.getProjectDirInfo(projectDirPath)),
        );

        for (let j = 0; j < batchInfos.length; j++) {
          const info = batchInfos[j];
          if (!info) continue;

          addOrMerge(
            info.projectPath,
            batch[j] ?? "",
            info.sessionCount,
            info.lastActivity,
          );
        }
      }
    }

    // Merge Codex projects if enabled
    if (this.codexScanner) {
      const codexProjects = await this.codexScanner.listProjects();
      for (const codexProject of codexProjects) {
        const projectPath = canonicalizeProjectPath(codexProject.path);
        if (this.isHiddenProjectPath(projectPath)) continue;
        const existing = projects.find(
          (project) => canonicalizeProjectPath(project.path) === projectPath,
        );
        if (existing) {
          existing.hasCodexSessions = true;
          continue;
        }
        seenPaths.add(projectPath);
        projects.push({
          ...codexProject,
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: getProjectName(projectPath),
          hasCodexSessions: true,
          hasGeminiSessions: false,
        });
      }
    }

    // Merge Gemini projects if enabled
    if (this.geminiScanner) {
      // Register known paths for hash resolution before scanning
      await this.geminiScanner.registerKnownPaths(Array.from(seenPaths));

      const geminiProjects = await this.geminiScanner.listProjects();
      for (const geminiProject of geminiProjects) {
        const projectPath = canonicalizeProjectPath(geminiProject.path);
        if (this.isHiddenProjectPath(projectPath)) continue;
        const existing = projects.find(
          (project) => canonicalizeProjectPath(project.path) === projectPath,
        );
        if (existing) {
          existing.hasGeminiSessions = true;
          continue;
        }
        seenPaths.add(projectPath);
        projects.push({
          ...geminiProject,
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: getProjectName(projectPath),
          hasCodexSessions: false,
          hasGeminiSessions: true,
        });
      }
    }

    // Merge manually added projects (from ProjectMetadataService)
    if (this.projectMetadataService) {
      const addedProjects = this.projectMetadataService.getAllProjects();
      for (const metadata of Object.values(addedProjects)) {
        const projectPath = canonicalizeProjectPath(metadata.path);
        if (this.isHiddenProjectPath(projectPath)) continue;
        // Skip if we've already seen this path from another source
        if (seenPaths.has(projectPath)) continue;

        // Verify the directory still exists
        try {
          const stats = await stat(projectPath);
          if (!stats.isDirectory()) continue;
        } catch {
          // Directory no longer exists, skip it
          continue;
        }

        seenPaths.add(projectPath);
        const encodedPath = projectPath.replace(/[/\\:]/g, "-");
        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: getProjectName(projectPath),
          sessionCount: 0,
          sessionDir: join(this.projectsDir, encodedPath),
          hasCodexSessions: false,
          hasGeminiSessions: false,
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: metadata.addedAt,
          provider: "claude",
        });
      }
    }

    // Fallback: if no projects were found from any source, include the user's
    // home directory so sessions can always be created even if detection is broken
    if (projects.length === 0) {
      const home = homedir();
      const encodedPath = home.replace(/[/\\:]/g, "-");
      projects.push({
        id: encodeProjectId(home),
        path: home,
        name: basename(home) || "Home",
        sessionCount: 0,
        sessionDir: join(this.projectsDir, encodedPath),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      });
    }

    return projects;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const snapshot = await this.getSnapshot();
    const project = snapshot.byId.get(projectId);
    return project ? this.cloneProject(project) : null;
  }

  private isHiddenProjectPath(projectPath: string): boolean {
    if (!this.projectMetadataService) return false;
    return this.projectMetadataService.isHiddenProject(
      encodeProjectId(projectPath),
    );
  }

  /**
   * Get a project by ID, or create a virtual project entry if the path exists on disk
   * but hasn't been used with Claude yet.
   *
   * This allows starting sessions in new directories without requiring prior Claude usage.
   */
  async getOrCreateProject(
    projectId: string,
    preferredProvider?: "claude" | "codex" | "gemini",
  ): Promise<Project | null> {
    let resolvedProjectId = projectId;

    // First check if project already exists
    const existing = await this.getProject(resolvedProjectId);
    if (existing) return existing;

    // Decode the projectId to get the path
    let projectPath: string;
    try {
      projectPath = decodeProjectId(resolvedProjectId as UrlProjectId);
    } catch {
      return null;
    }

    const canonicalProjectPath = canonicalizeProjectPath(projectPath);
    if (canonicalProjectPath !== projectPath) {
      const canonicalId = encodeProjectId(canonicalProjectPath);
      const canonicalProject = await this.getProject(canonicalId);
      if (canonicalProject) {
        return canonicalProject;
      }
      projectPath = canonicalProjectPath;
      resolvedProjectId = canonicalId;
    }

    // Validate path is absolute
    if (!isAbsolutePath(projectPath)) {
      return null;
    }

    // Check if the directory exists on disk
    try {
      const stats = await stat(projectPath);
      if (!stats.isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }

    // Determine provider: use preferred if specified, otherwise check for Codex/Gemini sessions
    let provider: ProviderName = preferredProvider ?? DEFAULT_PROVIDER;
    if (!preferredProvider) {
      // Check if Codex sessions exist for this path
      if (this.codexScanner) {
        const codexSessions =
          await this.codexScanner.getSessionsForProject(projectPath);
        if (codexSessions.length > 0) {
          provider = "codex";
        }
      }

      // Check if Gemini sessions exist for this path (only if no Codex sessions)
      if (provider === "claude" && this.geminiScanner) {
        const geminiSessions =
          await this.geminiScanner.getSessionsForProject(projectPath);
        if (geminiSessions.length > 0) {
          provider = "gemini";
        }
      }
    }

    // Create a virtual project entry
    // The session directory will be created by the SDK when the first session starts
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");

    // Determine the session directory based on provider
    let sessionDir: string;
    if (provider === "codex") {
      sessionDir = CODEX_SESSIONS_DIR;
    } else if (provider === "gemini") {
      sessionDir = GEMINI_TMP_DIR;
    } else {
      sessionDir = join(this.projectsDir, encodedPath);
    }

    return {
      id: resolvedProjectId as UrlProjectId,
      path: projectPath,
      name: getProjectName(projectPath),
      sessionCount: 0,
      sessionDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider,
    };
  }

  /**
   * Find a project by matching the session directory suffix.
   *
   * This is used by ExternalSessionTracker which extracts the directory-based
   * project identifier from file paths (e.g., "-home-user-project" or
   * "hostname/-home-user-project") rather than the base64url-encoded projectId.
   */
  async getProjectBySessionDirSuffix(
    dirSuffix: string,
  ): Promise<Project | null> {
    const snapshot = await this.getSnapshot();
    const normalizedSuffix = this.normalizeDirSuffix(dirSuffix);
    const project = snapshot.bySessionDirSuffix.get(normalizedSuffix);
    return project ? this.cloneProject(project) : null;
  }

  dispose(): void {
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
  }

  /**
   * Get project info from a session directory in a single readdir pass.
   * Uses directory mtime as a cheap proxy for lastActivity (one stat
   * on the dir itself instead of stat-ing every session file).
   */
  private async getProjectDirInfo(projectDirPath: string): Promise<{
    projectPath: string;
    sessionCount: number;
    lastActivity: string | null;
  } | null> {
    try {
      const entries = await readdir(projectDirPath, { withFileTypes: true });
      const jsonlFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name);

      if (jsonlFiles.length === 0) return null;

      // Count non-agent sessions
      const sessionCount = jsonlFiles.filter(
        (f) => !f.startsWith("agent-"),
      ).length;

      // Use directory mtime as lastActivity (updated when files are added/removed)
      const dirStat = await stat(projectDirPath);
      const lastActivity = new Date(dirStat.mtimeMs).toISOString();

      // Read cwd from session files in small batches and return early on first match.
      // Most project dirs have a session file with cwd near the top of the first file.
      const regularSessionFiles = jsonlFiles.filter((f) => !f.startsWith("agent-"));
      const orderedFiles =
        regularSessionFiles.length > 0
          ? [...regularSessionFiles, ...jsonlFiles.filter((f) => f.startsWith("agent-"))]
          : jsonlFiles;

      for (let i = 0; i < orderedFiles.length; i += CWD_SCAN_BATCH_SIZE) {
        const batch = orderedFiles.slice(i, i + CWD_SCAN_BATCH_SIZE);
        const batchCwds = await Promise.all(
          batch.map((file) => readCwdFromSessionFile(join(projectDirPath, file))),
        );

        for (const cwd of batchCwds) {
          if (cwd) {
            return { projectPath: cwd, sessionCount, lastActivity };
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}

// Singleton for convenience
export const projectScanner = new ProjectScanner();
