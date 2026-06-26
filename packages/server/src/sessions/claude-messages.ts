import type { ClaudeSessionEntry } from "@yep-anywhere/shared";
import {
  getLogicalParentUuid,
  isCompactBoundary,
} from "@yep-anywhere/shared";
import {
  buildDag,
  collectAllToolResultIds,
  findOrphanedToolUses,
  findSiblingToolBranches,
  findSiblingToolResults,
} from "./dag.js";

export interface VisibleClaudeEntriesResult {
  entries: ClaudeSessionEntry[];
  orphanedToolUses: Set<string>;
}

interface NormalizeClaudeEntriesOptions {
  includeOrphans?: boolean;
}

function hasQueueOperationContent(raw: ClaudeSessionEntry): boolean {
  if (raw.type !== "queue-operation" || raw.operation !== "enqueue") {
    return false;
  }

  if (typeof raw.content === "string") {
    return raw.content.trim().length > 0;
  }

  return Array.isArray(raw.content) && raw.content.length > 0;
}

function collectHistoricalQueueEntries(
  rawMessages: ClaudeSessionEntry[],
): Array<{ lineIndex: number; raw: ClaudeSessionEntry }> {
  const pendingEnqueues: Array<{ lineIndex: number; raw: ClaudeSessionEntry }> =
    [];
  const historicalEntries: Array<{
    lineIndex: number;
    raw: ClaudeSessionEntry;
  }> = [];

  for (let lineIndex = 0; lineIndex < rawMessages.length; lineIndex++) {
    const raw = rawMessages[lineIndex];
    if (raw?.type !== "queue-operation") continue;

    if (raw.operation === "enqueue") {
      if (hasQueueOperationContent(raw)) {
        pendingEnqueues.push({ lineIndex, raw });
      }
      continue;
    }

    if (
      (raw.operation === "dequeue" || raw.operation === "remove") &&
      pendingEnqueues.length > 0
    ) {
      const nextEntry = pendingEnqueues.shift();
      if (raw.operation === "remove" && nextEntry) {
        historicalEntries.push(nextEntry);
      }
    }
  }

  return historicalEntries;
}

function insertEntryByLineIndex(
  entries: Array<{ lineIndex: number; raw: ClaudeSessionEntry }>,
  entry: { lineIndex: number; raw: ClaudeSessionEntry },
): void {
  const insertAt = entries.findIndex(
    (existing) => existing.lineIndex > entry.lineIndex,
  );
  if (insertAt === -1) {
    entries.push(entry);
    return;
  }
  entries.splice(insertAt, 0, entry);
}

function getEntryUuid(raw: ClaudeSessionEntry): string | undefined {
  const uuid = "uuid" in raw ? raw.uuid : undefined;
  return typeof uuid === "string" ? uuid : undefined;
}

function getEntryParentUuid(raw: ClaudeSessionEntry): string | undefined {
  const parentUuid = "parentUuid" in raw ? raw.parentUuid : undefined;
  return typeof parentUuid === "string" ? parentUuid : undefined;
}

function isCompactSummaryEntry(raw: ClaudeSessionEntry): boolean {
  return raw.type === "user" && (raw as { isCompactSummary?: unknown })
    .isCompactSummary === true;
}

export function collectVisibleClaudeEntries(
  rawMessages: ClaudeSessionEntry[],
  options: NormalizeClaudeEntriesOptions = {},
): VisibleClaudeEntriesResult {
  const { includeOrphans = true } = options;
  const { activeBranch } = buildDag(rawMessages);
  const activeBranchUuids = new Set(activeBranch.map((node) => node.uuid));
  const allToolResultIds = collectAllToolResultIds(rawMessages);
  const orphanedToolUses = includeOrphans
    ? findOrphanedToolUses(activeBranch, allToolResultIds)
    : new Set<string>();

  const lineIndexByUuid = new Map<string, number>();
  for (let lineIndex = 0; lineIndex < rawMessages.length; lineIndex++) {
    const raw = rawMessages[lineIndex];
    const uuid = raw ? getEntryUuid(raw) : undefined;
    if (uuid) {
      lineIndexByUuid.set(uuid, lineIndex);
    }
  }

  const extrasByParent = new Map<
    string,
    Array<{ lineIndex: number; raw: ClaudeSessionEntry }>
  >();

  const pushExtra = (
    parentUuid: string,
    raw: ClaudeSessionEntry,
    lineIndex: number,
  ) => {
    const existing = extrasByParent.get(parentUuid);
    const entry = { lineIndex, raw };
    if (existing) {
      existing.push(entry);
    } else {
      extrasByParent.set(parentUuid, [entry]);
    }
  };

  const compactSummariesByParent = new Map<
    string,
    Array<{ lineIndex: number; raw: ClaudeSessionEntry }>
  >();
  for (let lineIndex = 0; lineIndex < rawMessages.length; lineIndex++) {
    const raw = rawMessages[lineIndex];
    if (!raw || !isCompactSummaryEntry(raw)) continue;

    const parentUuid = getEntryParentUuid(raw);
    if (!parentUuid) continue;

    const existing = compactSummariesByParent.get(parentUuid);
    const entry = { lineIndex, raw };
    if (existing) {
      existing.push(entry);
    } else {
      compactSummariesByParent.set(parentUuid, [entry]);
    }
  }

  for (let lineIndex = 0; lineIndex < rawMessages.length; lineIndex++) {
    const raw = rawMessages[lineIndex];
    if (!raw || !isCompactBoundary(raw)) continue;

    const uuid = getEntryUuid(raw);
    if (!uuid) continue;

    const summaries = compactSummariesByParent.get(uuid) ?? [];
    if (activeBranchUuids.has(uuid)) {
      for (const summary of summaries) {
        const summaryUuid = getEntryUuid(summary.raw);
        if (!summaryUuid || !activeBranchUuids.has(summaryUuid)) {
          pushExtra(uuid, summary.raw, summary.lineIndex);
        }
      }
      continue;
    }

    const logicalParentUuid = getLogicalParentUuid(raw);
    if (!logicalParentUuid || !activeBranchUuids.has(logicalParentUuid)) {
      continue;
    }

    pushExtra(logicalParentUuid, raw, lineIndex);
    for (const summary of summaries) {
      const summaryUuid = getEntryUuid(summary.raw);
      if (!summaryUuid || !activeBranchUuids.has(summaryUuid)) {
        pushExtra(logicalParentUuid, summary.raw, summary.lineIndex);
      }
    }
  }

  for (const sibling of findSiblingToolResults(activeBranch, rawMessages)) {
    const uuid = getEntryUuid(sibling.raw);
    pushExtra(
      sibling.parentUuid,
      sibling.raw,
      uuid ? (lineIndexByUuid.get(uuid) ?? Number.MAX_SAFE_INTEGER) : 0,
    );
  }

  for (const branch of findSiblingToolBranches(activeBranch, rawMessages)) {
    for (const node of branch.nodes) {
      pushExtra(branch.branchPoint, node.raw, node.lineIndex);
    }
  }

  for (const extras of extrasByParent.values()) {
    extras.sort((left, right) => left.lineIndex - right.lineIndex);
  }

  const entries: Array<{ lineIndex: number; raw: ClaudeSessionEntry }> = [];
  const includedUuids = new Set<string>();
  const includedNonUuidLineIndices = new Set<number>();
  const pushUnique = (raw: ClaudeSessionEntry, lineIndex: number) => {
    const uuid = getEntryUuid(raw);
    if (uuid) {
      if (includedUuids.has(uuid)) return;
      includedUuids.add(uuid);
    } else {
      if (includedNonUuidLineIndices.has(lineIndex)) return;
      includedNonUuidLineIndices.add(lineIndex);
    }
    entries.push({ lineIndex, raw });
  };

  for (const node of activeBranch) {
    pushUnique(node.raw, node.lineIndex);

    const extras = extrasByParent.get(node.uuid);
    if (!extras) continue;

    for (const extra of extras) {
      pushUnique(extra.raw, extra.lineIndex);
    }
  }

  for (const queuedEntry of collectHistoricalQueueEntries(rawMessages)) {
    const beforeLength = entries.length;
    pushUnique(queuedEntry.raw, queuedEntry.lineIndex);
    if (entries.length === beforeLength) continue;

    const appended = entries.pop();
    if (!appended) continue;
    insertEntryByLineIndex(entries, appended);
  }

  return {
    entries: entries.map((entry) => entry.raw),
    orphanedToolUses,
  };
}
