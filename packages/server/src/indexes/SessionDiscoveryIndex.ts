import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger } from "../logging/logger.js";

const CURRENT_VERSION = 1;

export interface SessionDiscoveryRecord<TMetadata = unknown> {
  key: string;
  relativePath: string;
  representation?: string;
  metadata: TMetadata;
  metadataByteLength: number;
  fileSize: number;
  fileMtimeMs: number;
  firstSeenAtMs: number;
  lastValidatedAtMs: number;
}

export interface SessionDiscoveryShardState<TMetadata = unknown> {
  version: 1;
  provider: string;
  sourceRootHash: string;
  sourceRootPath: string;
  shardKey: string;
  updatedAtMs: number;
  records: Record<string, SessionDiscoveryRecord<TMetadata>>;
}

export interface SessionDiscoveryIndexOptions {
  /** Base directory for sharded discovery indexes. */
  baseDir?: string;
  /** Provider namespace, e.g. "codex" or "claude". */
  provider: string;
  /** Provider-owned history root this index describes. */
  sourceRoot: string;
}

export interface UpsertSessionDiscoveryRecord<TMetadata = unknown> {
  key: string;
  relativePath: string;
  representation?: string;
  metadata: TMetadata;
  metadataByteLength: number;
  fileSize: number;
  fileMtimeMs: number;
  nowMs?: number;
}

function defaultBaseDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".yep-anywhere", "indexes", "session-discovery");
}

function hashPath(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function encodePathSegment(segment: string): string {
  const encoded = encodeURIComponent(segment).replace(/\./g, "%2E");
  return encoded || "_";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDiscoveryRecord(
  value: unknown,
): value is SessionDiscoveryRecord {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.key === "string" &&
    typeof value.relativePath === "string" &&
    (value.representation === undefined ||
      typeof value.representation === "string") &&
    isObjectRecord(value.metadata) &&
    typeof value.metadataByteLength === "number" &&
    value.metadataByteLength >= 0 &&
    typeof value.fileSize === "number" &&
    value.fileSize >= 0 &&
    typeof value.fileMtimeMs === "number" &&
    typeof value.firstSeenAtMs === "number" &&
    typeof value.lastValidatedAtMs === "number"
  );
}

/**
 * Provider-neutral, sharded cache for immutable session discovery metadata.
 *
 * This index is deliberately non-authoritative: callers must enumerate the
 * provider-owned history files first and then use this cache only for observed
 * files. A stale record on disk must never make a deleted provider session
 * visible again.
 */
export class SessionDiscoveryIndex {
  private readonly baseDir: string;
  private readonly provider: string;
  private readonly providerPathSegment: string;
  private readonly sourceRootPath: string;
  private readonly sourceRootHash: string;
  private readonly shardCache = new Map<string, SessionDiscoveryShardState>();
  private readonly dirtyShardKeys = new Set<string>();
  private readonly savePromises = new Map<string, Promise<void>>();

  constructor(options: SessionDiscoveryIndexOptions) {
    this.baseDir = options.baseDir ?? defaultBaseDir();
    this.provider = options.provider;
    this.providerPathSegment = encodePathSegment(options.provider);
    this.sourceRootPath = path.resolve(options.sourceRoot);
    this.sourceRootHash = hashPath(this.sourceRootPath);
  }

  getRootHash(): string {
    return this.sourceRootHash;
  }

  getShardPath(shardKey: string): string {
    const segments = this.getShardSegments(shardKey);
    const dirs = segments.slice(0, -1);
    const fileName = `${segments[segments.length - 1] ?? "_root"}.json`;
    return path.join(
      this.baseDir,
      this.providerPathSegment,
      this.sourceRootHash,
      ...dirs,
      fileName,
    );
  }

  async getRecord<TMetadata = unknown>(
    shardKey: string,
    key: string,
  ): Promise<SessionDiscoveryRecord<TMetadata> | null> {
    const shard = await this.loadShard(shardKey);
    const record = shard.records[key];
    return record
      ? (record as SessionDiscoveryRecord<TMetadata>)
      : null;
  }

  async upsertRecord<TMetadata>(
    shardKey: string,
    input: UpsertSessionDiscoveryRecord<TMetadata>,
  ): Promise<void> {
    const shard = await this.loadShard(shardKey);
    const existing = shard.records[input.key];
    const nowMs = input.nowMs ?? Date.now();
    const record: SessionDiscoveryRecord<TMetadata> = {
      key: input.key,
      relativePath: input.relativePath,
      ...(input.representation !== undefined
        ? { representation: input.representation }
        : {}),
      metadata: input.metadata,
      metadataByteLength: input.metadataByteLength,
      fileSize: input.fileSize,
      fileMtimeMs: input.fileMtimeMs,
      firstSeenAtMs: existing?.firstSeenAtMs ?? nowMs,
      lastValidatedAtMs: nowMs,
    };

    shard.records[input.key] =
      record as SessionDiscoveryRecord<unknown>;
    shard.updatedAtMs = nowMs;
    this.dirtyShardKeys.add(shardKey);
  }

  async removeRecord(shardKey: string, key: string): Promise<void> {
    const shard = await this.loadShard(shardKey);
    if (!(key in shard.records)) return;
    delete shard.records[key];
    shard.updatedAtMs = Date.now();
    this.dirtyShardKeys.add(shardKey);
  }

  async flush(): Promise<void> {
    const shardKeys = Array.from(this.dirtyShardKeys);
    this.dirtyShardKeys.clear();

    await Promise.all(
      shardKeys.map(async (shardKey) => {
        try {
          await this.saveShard(shardKey);
        } catch (error) {
          this.dirtyShardKeys.add(shardKey);
          getLogger().debug(
            { err: error },
            `[SessionDiscoveryIndex] Failed to save ${this.provider} shard ${shardKey}`,
          );
        }
      }),
    );
  }

  private getShardSegments(shardKey: string): string[] {
    const normalized = shardKey.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const rawSegments = normalized ? normalized.split("/") : ["_root"];
    return rawSegments.map(encodePathSegment);
  }

  private async loadShard(
    shardKey: string,
  ): Promise<SessionDiscoveryShardState> {
    const cached = this.shardCache.get(shardKey);
    if (cached) return cached;

    const shard = await this.readShardFromDisk(shardKey);
    this.shardCache.set(shardKey, shard);
    return shard;
  }

  private async readShardFromDisk(
    shardKey: string,
  ): Promise<SessionDiscoveryShardState> {
    const empty = this.createEmptyShard(shardKey);
    try {
      const content = await fs.readFile(this.getShardPath(shardKey), "utf-8");
      const parsed = JSON.parse(content) as unknown;
      if (!this.isValidShardState(parsed, shardKey)) {
        return empty;
      }

      const records: Record<string, SessionDiscoveryRecord> = {};
      for (const [key, record] of Object.entries(parsed.records)) {
        if (key === record.key && isValidDiscoveryRecord(record)) {
          records[key] = record;
        }
      }

      return {
        ...parsed,
        records,
      };
    } catch {
      return empty;
    }
  }

  private isValidShardState(
    value: unknown,
    shardKey: string,
  ): value is SessionDiscoveryShardState {
    if (!isObjectRecord(value)) return false;
    return (
      value.version === CURRENT_VERSION &&
      value.provider === this.provider &&
      value.sourceRootHash === this.sourceRootHash &&
      typeof value.sourceRootPath === "string" &&
      value.shardKey === shardKey &&
      typeof value.updatedAtMs === "number" &&
      isObjectRecord(value.records)
    );
  }

  private createEmptyShard(shardKey: string): SessionDiscoveryShardState {
    return {
      version: CURRENT_VERSION,
      provider: this.provider,
      sourceRootHash: this.sourceRootHash,
      sourceRootPath: this.sourceRootPath,
      shardKey,
      updatedAtMs: Date.now(),
      records: {},
    };
  }

  private async saveShard(shardKey: string): Promise<void> {
    const existing = this.savePromises.get(shardKey);
    const savePromise = (existing ?? Promise.resolve()).then(() =>
      this.writeShard(shardKey),
    );
    const trackedPromise = savePromise.finally(() => {
      if (this.savePromises.get(shardKey) === trackedPromise) {
        this.savePromises.delete(shardKey);
      }
    });
    this.savePromises.set(shardKey, trackedPromise);
    await savePromise;
  }

  private async writeShard(shardKey: string): Promise<void> {
    const shard = this.shardCache.get(shardKey);
    if (!shard) return;

    const shardPath = this.getShardPath(shardKey);
    const tempPath = `${shardPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    try {
      await fs.mkdir(path.dirname(shardPath), { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(shard, null, 2)}\n`);
      await fs.rename(tempPath, shardPath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {
        // Best-effort cleanup for failed atomic writes.
      });
      throw error;
    }
  }
}
