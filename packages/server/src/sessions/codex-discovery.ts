import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodexSessionMetaEntry } from "@yep-anywhere/shared";
import {
  SessionDiscoveryIndex,
  type SessionDiscoveryRecord,
} from "../indexes/SessionDiscoveryIndex.js";
import {
  type CodexRolloutDiscoveryIdentity,
  getCodexRolloutDiscoveryIdentity,
} from "../utils/codexRolloutFiles.js";
import { readFirstLine } from "../utils/jsonl.js";

export const CODEX_META_READ_MAX_BYTES = 1024 * 1024;

export interface CodexRolloutDiscoveryMetadata {
  id: string;
  cwd: string;
  timestamp: string;
  isSubagent: boolean;
}

export interface CodexDiscoveredSession {
  id: string;
  cwd: string;
  filePath: string;
  timestamp: string;
  mtime: number;
  size: number;
  isSubagent: boolean;
}

export interface ReadCodexRolloutMetadataOptions {
  sessionsDir: string;
  filePath: string;
  discoveryIndex?: SessionDiscoveryIndex;
  activeAfterMs?: number;
  maxBytes?: number;
}

export function createCodexSessionDiscoveryIndex(
  dataDir: string | undefined,
  sessionsDir: string,
): SessionDiscoveryIndex | undefined {
  if (!dataDir) return undefined;
  return new SessionDiscoveryIndex({
    baseDir: join(dataDir, "indexes", "session-discovery"),
    provider: "codex",
    sourceRoot: sessionsDir,
  });
}

export async function readCodexRolloutMetadata(
  options: ReadCodexRolloutMetadataOptions,
): Promise<CodexDiscoveredSession | null> {
  const stats = await stat(options.filePath);
  if (options.activeAfterMs && stats.mtimeMs < options.activeAfterMs) {
    return null;
  }

  const identity = getCodexRolloutDiscoveryIdentity(
    options.sessionsDir,
    options.filePath,
  );
  const cached = await options.discoveryIndex?.getRecord<CodexRolloutDiscoveryMetadata>(
    identity.shardKey,
    identity.key,
  );
  if (cached && isCachedRecordUsable(cached, identity, stats)) {
    if (shouldRefreshCachedRecord(cached, identity, stats)) {
      await options.discoveryIndex?.upsertRecord(identity.shardKey, {
        key: identity.key,
        relativePath: identity.relativePath,
        representation: identity.representation,
        metadata: cached.metadata,
        metadataByteLength: cached.metadataByteLength,
        fileSize: stats.size,
        fileMtimeMs: stats.mtimeMs,
      });
    }
    return toDiscoveredSession(cached.metadata, options.filePath, stats);
  }

  const firstLine = await readFirstLine(
    options.filePath,
    options.maxBytes ?? CODEX_META_READ_MAX_BYTES,
  );
  if (!firstLine) return null;

  const metadata = parseCodexSessionMeta(firstLine, stats);
  if (!metadata) return null;

  await options.discoveryIndex?.upsertRecord(identity.shardKey, {
    key: identity.key,
    relativePath: identity.relativePath,
    representation: identity.representation,
    metadata,
    metadataByteLength: Buffer.byteLength(firstLine, "utf-8") + 1,
    fileSize: stats.size,
    fileMtimeMs: stats.mtimeMs,
  });

  return toDiscoveredSession(metadata, options.filePath, stats);
}

function isCachedRecordUsable(
  record: SessionDiscoveryRecord<CodexRolloutDiscoveryMetadata>,
  identity: CodexRolloutDiscoveryIdentity,
  stats: Stats,
): boolean {
  if (!isCodexRolloutDiscoveryMetadata(record.metadata)) return false;

  if (identity.representation === "zstd") {
    if (record.representation === "zstd") {
      return record.fileSize === stats.size;
    }
    return true;
  }

  return stats.size >= record.metadataByteLength;
}

function shouldRefreshCachedRecord(
  record: SessionDiscoveryRecord<CodexRolloutDiscoveryMetadata>,
  identity: CodexRolloutDiscoveryIdentity,
  stats: Stats,
): boolean {
  if (record.relativePath !== identity.relativePath) return true;
  if (record.representation !== identity.representation) return true;
  return identity.representation === "zstd" && record.fileSize !== stats.size;
}

function toDiscoveredSession(
  metadata: CodexRolloutDiscoveryMetadata,
  filePath: string,
  stats: Stats,
): CodexDiscoveredSession {
  return {
    id: metadata.id,
    cwd: metadata.cwd,
    filePath,
    timestamp: metadata.timestamp,
    mtime: stats.mtimeMs,
    size: stats.size,
    isSubagent: metadata.isSubagent,
  };
}

function parseCodexSessionMeta(
  firstLine: string,
  stats: Stats,
): CodexRolloutDiscoveryMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine) as unknown;
  } catch {
    return null;
  }

  if (!isObjectRecord(parsed)) return null;
  if (parsed.type !== "session_meta") return null;
  if (!isObjectRecord(parsed.payload)) return null;

  const meta = parsed.payload as Partial<CodexSessionMetaEntry["payload"]>;
  if (typeof meta.id !== "string" || typeof meta.cwd !== "string") {
    return null;
  }

  return {
    id: meta.id,
    cwd: meta.cwd,
    timestamp:
      typeof meta.timestamp === "string"
        ? meta.timestamp
        : new Date(stats.mtimeMs).toISOString(),
    isSubagent: isSubagentSessionMeta(meta),
  };
}

export function isSubagentSessionMeta(
  meta: Partial<CodexSessionMetaEntry["payload"]>,
): boolean {
  if (
    !("forked_from_id" in meta) ||
    typeof meta.forked_from_id !== "string"
  ) {
    return false;
  }

  const source = meta.source;
  if (!source || typeof source !== "object") return false;

  const subagentSource = source as {
    subagent?: { thread_spawn?: { parent_thread_id?: string } };
  };

  return (
    typeof subagentSource.subagent?.thread_spawn?.parent_thread_id === "string"
  );
}

function isCodexRolloutDiscoveryMetadata(
  value: unknown,
): value is CodexRolloutDiscoveryMetadata {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.isSubagent === "boolean"
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
