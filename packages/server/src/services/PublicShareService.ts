import type {
  AppSession,
  FreezePublicSessionLiveSharesResponse,
  PublicSessionShareMetadata,
  PublicSessionShareMode,
  PublicSessionShareResponse,
  PublicSessionShareSessionStatusResponse,
  PublicSessionShareViewerActionResponse,
  PublicSessionShareViewerSummary,
  RevokePublicSessionSharesResponse,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { enforceOwnerReadWriteFilePermissions } from "../utils/filePermissions.js";

export const PUBLIC_SHARE_SECRET_BYTES = 64;
export const PUBLIC_SHARE_SECRET_BITS = PUBLIC_SHARE_SECRET_BYTES * 8;
const PUBLIC_SHARE_VIEWER_TTL_MS = 120_000;
const PUBLIC_SHARE_VIEWER_UPDATE_GRACE_MS = 30_000;
const PUBLIC_SHARE_VIEWER_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

export interface PublicShareRecord {
  version: 1;
  secretHash: string;
  mode: PublicSessionShareMode;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  capturedAt?: string;
  source: PublicSessionShareMetadata["source"];
  frozenSession?: AppSession;
  disconnectedViewerIds?: string[];
  viewerSnapshots?: Record<
    string,
    {
      capturedAt: string;
      frozenSession: AppSession;
    }
  >;
}

interface PublicShareState {
  shares: PublicShareRecord[];
}

interface ViewerAccessRecord {
  firstSeenAt: string;
  lastSeenAt: string;
  accessCount: number;
}

interface PublicShareStatusOptions {
  sessionUpdatedAt?: string | null;
}

export interface PublicShareServiceOptions {
  dataDir: string;
}

export interface CreatePublicShareOptions {
  mode: PublicSessionShareMode;
  source: PublicShareRecord["source"];
  title?: string | null;
  snapshot?: AppSession;
}

const EMPTY_STATE: PublicShareState = { shares: [] };

function hashSecret(secret: string): string {
  return createHash("sha512").update(secret, "utf8").digest("base64url");
}

function isValidSecret(secret: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
    return false;
  }
  try {
    return Buffer.from(secret, "base64url").length >= PUBLIC_SHARE_SECRET_BYTES;
  } catch {
    return false;
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

function sanitizeSessionForPublicShare(session: AppSession): AppSession {
  const {
    pendingInputType: _pendingInputType,
    activity: _activity,
    lastSeenAt: _lastSeenAt,
    hasUnread: _hasUnread,
    heartbeatTurnsEnabled: _heartbeatTurnsEnabled,
    heartbeatTurnsAfterMinutes: _heartbeatTurnsAfterMinutes,
    heartbeatTurnText: _heartbeatTurnText,
    ...rest
  } = session as AppSession & {
    heartbeatTurnsEnabled?: boolean;
    heartbeatTurnsAfterMinutes?: number;
    heartbeatTurnText?: string;
  };

  return {
    ...rest,
    ownership: { owner: "none" },
    messages: Array.isArray(session.messages) ? session.messages : [],
  };
}

function toPublicResponse(
  record: PublicShareRecord,
): PublicSessionShareResponse {
  if (!record.frozenSession) {
    throw new Error("Frozen share is missing its captured session");
  }

  const share: PublicSessionShareMetadata = {
    mode: record.mode,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    capturedAt: record.capturedAt,
    source: record.source,
  };

  return {
    share,
    session: record.frozenSession,
  };
}

function matchesSession(
  record: PublicShareRecord,
  projectId: UrlProjectId,
  sessionId: string,
): boolean {
  return (
    record.source.projectId === projectId &&
    record.source.sessionId === sessionId
  );
}

function minIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function parseIsoTime(value?: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isViewerActiveForStatus(
  lastSeenAt: number,
  now: number,
  options: PublicShareStatusOptions,
): boolean {
  if (now - lastSeenAt > PUBLIC_SHARE_VIEWER_TTL_MS) {
    return false;
  }
  const sessionUpdatedAt = parseIsoTime(options.sessionUpdatedAt);
  if (sessionUpdatedAt === null) {
    return true;
  }
  if (now <= sessionUpdatedAt + PUBLIC_SHARE_VIEWER_UPDATE_GRACE_MS) {
    return true;
  }
  return lastSeenAt >= sessionUpdatedAt;
}

function summarizeRecords(
  records: PublicShareRecord[],
): PublicSessionShareSessionStatusResponse {
  let frozenCount = 0;
  let liveCount = 0;
  for (const record of records) {
    if (record.mode === "frozen") {
      frozenCount += 1;
    } else {
      liveCount += 1;
    }
  }
  return {
    activeCount: frozenCount + liveCount,
    frozenCount,
    liveCount,
    activeViewerCount: 0,
    viewers: [],
  };
}

export class PublicShareService {
  private state: PublicShareState = EMPTY_STATE;
  private readonly filePath: string;
  private readonly viewerHeartbeats = new Map<string, Map<string, number>>();
  private readonly viewerAccesses = new Map<
    string,
    Map<string, ViewerAccessRecord>
  >();

  constructor(options: PublicShareServiceOptions) {
    this.filePath = path.join(options.dataDir, "public-shares.json");
  }

  async initialize(): Promise<void> {
    try {
      await enforceOwnerReadWriteFilePermissions(
        this.filePath,
        "[public-shares]",
      );
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      if (this.validateState(parsed)) {
        this.state = parsed;
        console.log(
          `[public-shares] Loaded ${this.state.shares.length} share(s)`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      console.warn("[public-shares] Failed to load state:", error);
    }
  }

  async createShare(options: CreatePublicShareOptions): Promise<{
    secret: string;
    secretBits: number;
    record: PublicShareRecord;
  }> {
    if (options.mode === "frozen" && !options.snapshot) {
      throw new Error("Frozen shares require a session snapshot");
    }

    const secret = randomBytes(PUBLIC_SHARE_SECRET_BYTES).toString("base64url");
    const secretHash = hashSecret(secret);
    const now = new Date().toISOString();
    const record: PublicShareRecord = {
      version: 1,
      secretHash,
      mode: options.mode,
      title: options.title ?? null,
      createdAt: now,
      updatedAt: now,
      ...(options.mode === "frozen" ? { capturedAt: now } : {}),
      source: options.source,
      ...(options.snapshot
        ? { frozenSession: sanitizeSessionForPublicShare(options.snapshot) }
        : {}),
    };

    this.state = {
      shares: [...this.state.shares, record],
    };
    await this.save();

    return {
      secret,
      secretBits: PUBLIC_SHARE_SECRET_BITS,
      record,
    };
  }

  getFrozenShareBySecret(secret: string): PublicSessionShareResponse | null {
    const record = this.getRecordBySecret(secret);
    if (record?.mode !== "frozen") {
      return null;
    }
    return toPublicResponse(record);
  }

  getRecordBySecret(secret: string): PublicShareRecord | null {
    if (!isValidSecret(secret)) {
      return null;
    }
    const secretHash = hashSecret(secret);
    for (const record of this.state.shares) {
      if (timingSafeStringEqual(record.secretHash, secretHash)) {
        return record;
      }
    }
    return null;
  }

  getSessionShareStatus(
    projectId: UrlProjectId,
    sessionId: string,
    options: PublicShareStatusOptions = {},
  ): PublicSessionShareSessionStatusResponse {
    const records = this.state.shares.filter((record) =>
      matchesSession(record, projectId, sessionId),
    );
    return {
      ...summarizeRecords(records),
      activeViewerCount: this.countViewersForRecords(records, options),
      viewers: this.summarizeViewersForRecords(records, options),
    };
  }

  async revokeSessionShares(
    projectId: UrlProjectId,
    sessionId: string,
  ): Promise<RevokePublicSessionSharesResponse> {
    const revokedRecords = this.state.shares.filter((record) =>
      matchesSession(record, projectId, sessionId),
    );
    const remaining = this.state.shares.filter(
      (record) => !matchesSession(record, projectId, sessionId),
    );
    const revokedCount = this.state.shares.length - remaining.length;
    if (revokedCount > 0) {
      this.state = { shares: remaining };
      for (const record of revokedRecords) {
        this.viewerHeartbeats.delete(record.secretHash);
        this.viewerAccesses.delete(record.secretHash);
      }
      await this.save();
    }
    return {
      revokedCount,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async revokeAllShares(): Promise<number> {
    const revokedCount = this.state.shares.length;
    if (revokedCount === 0) {
      return 0;
    }
    this.state = { shares: [] };
    this.viewerHeartbeats.clear();
    this.viewerAccesses.clear();
    await this.save();
    return revokedCount;
  }

  async freezeSessionLiveShares(
    projectId: UrlProjectId,
    sessionId: string,
    session: AppSession,
  ): Promise<FreezePublicSessionLiveSharesResponse> {
    const now = new Date().toISOString();
    const frozenSession = sanitizeSessionForPublicShare(session);
    let convertedCount = 0;
    const shares = this.state.shares.map((record) => {
      if (
        !matchesSession(record, projectId, sessionId) ||
        record.mode !== "live"
      ) {
        return record;
      }
      convertedCount += 1;
      return {
        ...record,
        mode: "frozen" as const,
        updatedAt: now,
        capturedAt: now,
        frozenSession,
        viewerSnapshots: undefined,
      };
    });
    if (convertedCount > 0) {
      this.state = { shares };
      await this.save();
    }
    return {
      convertedCount,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async freezeSessionViewerToken(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
    session: AppSession,
  ): Promise<PublicSessionShareViewerActionResponse> {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) {
      return {
        viewerId,
        convertedCount: 0,
        ...this.getSessionShareStatus(projectId, sessionId),
      };
    }

    const now = new Date().toISOString();
    const frozenSession = sanitizeSessionForPublicShare(session);
    let convertedCount = 0;
    const shares = this.state.shares.map((record) => {
      if (
        !matchesSession(record, projectId, sessionId) ||
        record.mode !== "live"
      ) {
        return record;
      }
      if (this.isViewerDisconnected(record, viewerId)) {
        return record;
      }
      convertedCount += 1;
      return {
        ...record,
        updatedAt: now,
        viewerSnapshots: {
          ...record.viewerSnapshots,
          [viewerId]: {
            capturedAt: now,
            frozenSession,
          },
        },
      };
    });
    if (convertedCount > 0) {
      this.state = { shares };
      this.removeViewerHeartbeatForSession(projectId, sessionId, viewerId);
      await this.save();
    }
    return {
      viewerId,
      convertedCount,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async disconnectSessionViewerToken(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
  ): Promise<PublicSessionShareViewerActionResponse> {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) {
      return {
        viewerId,
        ...this.getSessionShareStatus(projectId, sessionId),
      };
    }

    let changed = false;
    const shares = this.state.shares.map((record) => {
      if (!matchesSession(record, projectId, sessionId)) {
        return record;
      }
      const disconnectedViewerIds = new Set(record.disconnectedViewerIds ?? []);
      if (!disconnectedViewerIds.has(viewerId)) {
        disconnectedViewerIds.add(viewerId);
        changed = true;
      }
      const { [viewerId]: _removedSnapshot, ...remainingViewerSnapshots } =
        record.viewerSnapshots ?? {};
      return {
        ...record,
        disconnectedViewerIds: [...disconnectedViewerIds],
        viewerSnapshots:
          Object.keys(remainingViewerSnapshots).length > 0
            ? remainingViewerSnapshots
            : undefined,
      };
    });
    if (changed) {
      this.state = { shares };
      this.removeViewerHeartbeatForSession(projectId, sessionId, viewerId);
      await this.save();
    }
    return {
      viewerId,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  buildLiveResponse(
    record: PublicShareRecord,
    session: AppSession,
  ): PublicSessionShareResponse {
    const sanitizedSession = sanitizeSessionForPublicShare(session);
    return {
      share: {
        mode: record.mode,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: sanitizedSession.updatedAt,
        activeViewerCount: this.getActiveViewerCount(record),
        capturedAt: record.capturedAt,
        source: {
          ...record.source,
          provider: sanitizedSession.provider,
        },
      },
      session: sanitizedSession,
    };
  }

  buildFrozenRepairResponse(
    record: PublicShareRecord,
    session: AppSession,
  ): PublicSessionShareResponse {
    const sanitizedSession = sanitizeSessionForPublicShare(session);
    return {
      share: {
        mode: "frozen",
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        activeViewerCount: this.getActiveViewerCount(record),
        capturedAt: record.capturedAt,
        source: {
          ...record.source,
          provider: sanitizedSession.provider,
        },
      },
      session: sanitizedSession,
    };
  }

  getViewerSnapshotResponse(
    record: PublicShareRecord,
    viewerId: string,
  ): PublicSessionShareResponse | null {
    const snapshot = record.viewerSnapshots?.[viewerId];
    if (!snapshot) {
      return null;
    }
    return {
      share: {
        mode: "frozen",
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: snapshot.frozenSession.updatedAt,
        capturedAt: snapshot.capturedAt,
        activeViewerCount: this.getActiveViewerCount(record),
        source: record.source,
      },
      session: snapshot.frozenSession,
    };
  }

  isViewerDisconnected(record: PublicShareRecord, viewerId: string): boolean {
    return record.disconnectedViewerIds?.includes(viewerId) ?? false;
  }

  recordViewerHeartbeat(record: PublicShareRecord, viewerId: string): number {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) {
      return this.getActiveViewerCount(record);
    }
    if (this.isViewerDisconnected(record, viewerId)) {
      this.viewerHeartbeats.get(record.secretHash)?.delete(viewerId);
      return this.getActiveViewerCount(record);
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.pruneViewerHeartbeats(now);
    let viewers = this.viewerHeartbeats.get(record.secretHash);
    if (!viewers) {
      viewers = new Map();
      this.viewerHeartbeats.set(record.secretHash, viewers);
    }
    viewers.set(viewerId, now);
    let accesses = this.viewerAccesses.get(record.secretHash);
    if (!accesses) {
      accesses = new Map();
      this.viewerAccesses.set(record.secretHash, accesses);
    }
    const existing = accesses.get(viewerId);
    accesses.set(viewerId, {
      firstSeenAt: existing?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
      accessCount: (existing?.accessCount ?? 0) + 1,
    });
    return viewers.size;
  }

  getActiveViewerCount(record: PublicShareRecord): number {
    this.pruneViewerHeartbeats();
    return this.viewerHeartbeats.get(record.secretHash)?.size ?? 0;
  }

  private countViewersForRecords(
    records: PublicShareRecord[],
    options: PublicShareStatusOptions,
  ): number {
    const now = Date.now();
    this.pruneViewerHeartbeats(now);
    let count = 0;
    for (const record of records) {
      const viewers = this.viewerHeartbeats.get(record.secretHash);
      if (!viewers) continue;
      for (const lastSeenAt of viewers.values()) {
        if (isViewerActiveForStatus(lastSeenAt, now, options)) {
          count += 1;
        }
      }
    }
    return count;
  }

  private summarizeViewersForRecords(
    records: PublicShareRecord[],
    options: PublicShareStatusOptions,
  ): PublicSessionShareViewerSummary[] {
    const now = Date.now();
    this.pruneViewerHeartbeats(now);
    const byViewerId = new Map<
      string,
      Omit<PublicSessionShareViewerSummary, "shortId">
    >();
    for (const record of records) {
      const activeViewers = this.viewerHeartbeats.get(record.secretHash);
      const accesses = this.viewerAccesses.get(record.secretHash);
      const viewerIds = new Set<string>([
        ...(activeViewers?.keys() ?? []),
        ...(accesses?.keys() ?? []),
        ...(record.disconnectedViewerIds ?? []),
        ...Object.keys(record.viewerSnapshots ?? {}),
      ]);
      for (const viewerId of viewerIds) {
        const access = accesses?.get(viewerId);
        const lastHeartbeatAt = activeViewers?.get(viewerId);
        const active =
          typeof lastHeartbeatAt === "number" &&
          isViewerActiveForStatus(lastHeartbeatAt, now, options);
        if (!active) {
          continue;
        }
        const existing = byViewerId.get(viewerId);
        byViewerId.set(viewerId, {
          viewerId,
          firstSeenAt:
            minIso(existing?.firstSeenAt, access?.firstSeenAt) ??
            access?.firstSeenAt ??
            new Date(0).toISOString(),
          lastSeenAt:
            maxIso(existing?.lastSeenAt, access?.lastSeenAt) ??
            access?.lastSeenAt ??
            new Date(0).toISOString(),
          accessCount:
            (existing?.accessCount ?? 0) + (access?.accessCount ?? 0),
          active: (existing?.active ?? false) || active,
          disconnected:
            (existing?.disconnected ?? false) ||
            this.isViewerDisconnected(record, viewerId),
          frozen:
            (existing?.frozen ?? false) ||
            Boolean(record.viewerSnapshots?.[viewerId]),
        });
      }
    }

    return [...byViewerId.values()]
      .map((viewer) => ({
        ...viewer,
        shortId: viewer.viewerId.slice(0, 8),
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  private removeViewerHeartbeatForSession(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
  ): void {
    for (const record of this.state.shares) {
      if (matchesSession(record, projectId, sessionId)) {
        this.viewerHeartbeats.get(record.secretHash)?.delete(viewerId);
      }
    }
  }

  private pruneViewerHeartbeats(now = Date.now()): void {
    const cutoff = now - PUBLIC_SHARE_VIEWER_TTL_MS;
    for (const [secretHash, viewers] of this.viewerHeartbeats) {
      for (const [viewerId, lastSeenAt] of viewers) {
        if (lastSeenAt < cutoff) {
          viewers.delete(viewerId);
        }
      }
      if (viewers.size === 0) {
        this.viewerHeartbeats.delete(secretHash);
      }
    }
    for (const [secretHash, accesses] of this.viewerAccesses) {
      for (const [viewerId, access] of accesses) {
        const lastSeenAt = Date.parse(access.lastSeenAt);
        if (Number.isNaN(lastSeenAt) || lastSeenAt < cutoff) {
          accesses.delete(viewerId);
        }
      }
      if (accesses.size === 0) {
        this.viewerAccesses.delete(secretHash);
      }
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    await enforceOwnerReadWriteFilePermissions(
      this.filePath,
      "[public-shares]",
    );
  }

  private validateState(value: unknown): value is PublicShareState {
    if (!value || typeof value !== "object") {
      return false;
    }
    const shares = (value as { shares?: unknown }).shares;
    if (!Array.isArray(shares)) {
      return false;
    }
    return shares.every((share) => {
      if (!share || typeof share !== "object") return false;
      const record = share as Partial<PublicShareRecord>;
      return (
        record.version === 1 &&
        typeof record.secretHash === "string" &&
        (record.mode === "frozen" || record.mode === "live") &&
        typeof record.createdAt === "string" &&
        typeof record.updatedAt === "string" &&
        !!record.source &&
        typeof record.source.projectId === "string" &&
        typeof record.source.sessionId === "string" &&
        (record.mode === "live" || !!record.frozenSession)
      );
    });
  }
}
