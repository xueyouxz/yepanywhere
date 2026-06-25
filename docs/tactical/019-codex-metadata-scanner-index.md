# 019 — Session discovery index and Codex metadata scanner

Status: In progress

Progress:

- [x] 2026-06-25: Captured the Codex session/storage constraints in
  `topics/codex-sessions.md`.
- [x] 2026-06-25: Captured current scanner gaps and `.jsonl.zst` default
  gating in `topics/codex-metadata-scanner.md`.
- [x] 2026-06-25: Implemented streaming zstd first-line reads for
  `readFirstLine()`, so default compressed metadata discovery no longer uses
  whole-file decompression.
- [x] Gate or revert default `.jsonl.zst` discovery until scanner metadata
  reads are first-line-only or cache-backed.
- [x] Add a durable provider-neutral session discovery index, with Codex as
  the first adapter.
- [x] Stop rereading Codex `session_meta` on ordinary append/mtime/size
  changes once the rollout head metadata has been indexed.
- [ ] Reconcile `.jsonl` and `.jsonl.zst` as two representations of one
  rollout with explicit transition tests and metrics.
- [x] Add streaming zstd first-line reads, or keep compressed discovery
  explicitly opt-in until that exists.
- [ ] Add Codex scanner metrics and slow logs.
- [ ] Make Codex watcher missed-event recovery bounded under expensive trees.

## Context

Codex stores local durable history as rollout files under a date-bucketed
sessions tree:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
```

YA needs project-oriented session lists, but Codex's directory layout is
time-oriented. The only cheap source of project membership is the rollout
head record, `session_meta`, whose payload includes `cwd`.

The current implementation works for ordinary small trees by using short-lived
caches and provider-neutral session-summary indexing. It now also has a
provider-neutral, sharded session discovery index used first by the Codex
adapter. That index is separate from the session-summary cache: it remembers
stable head metadata for provider files that have already been observed, but
it must never become an independent list of sessions.

The related topic docs define the product and architecture constraints:

- `topics/codex-sessions.md`
- `topics/codex-metadata-scanner.md`
- `topics/architecture-mandates.md`
- `docs/plans/session-cache-strategy-2026-02-22.md`

## Problem

`session_meta` is effectively append-immutable: once a rollout has been
created, ordinary session activity appends later JSONL records. It changes
mtime and size, but it should not change the first line.

The current scanner model does not encode that invariant strongly enough:

- `CodexSessionScanner` and `CodexSessionReader` keep 5-second scan caches.
- `SessionIndexService` persists normalized summaries, not a Codex rollout
  metadata catalog.
- `SessionDiscoveryIndex` now persists stable provider head metadata in
  provider/root/date shards, but callers still enumerate physical provider
  files first.
- Full validation still enumerates rollout files and can force metadata reads.
- Codex file events mark loaded Codex scopes dirty broadly because a raw file
  event does not cheaply identify the project scope.
- The Codex watcher has a periodic full-tree rescan on Windows/macOS by
  default. It avoids overlapping rescans, but it does not back off when the
  scan itself is expensive.

The `.jsonl.zst` case makes this sharper. Plain JSONL can read the first line
with a bounded partial read. A naive compressed reader that decompresses the
whole rollout just to recover `session_meta` would make default scanning
proportional to historical transcript size, not just file count.

## Desired Behavior

Default session lists should be complete by default. Hidden 14-day filtering
must not be the primary performance strategy.

Codex metadata discovery should instead be bounded by a durable discovery
index:

- First successful `session_meta` parse is cached by canonical rollout identity.
- Append/modify events refresh summary/detail state, not head metadata.
- Replacing, truncating, deleting, or compressing a rollout triggers targeted
  reconciliation.
- `.jsonl` and `.jsonl.zst` are representations of the same logical rollout.
- Compressed discovery is default-on only when it can use cached metadata or a
  streaming first-line zstd reader.
- Deletion and rotation visibility follows provider-owned files. A record in
  YA's discovery index does not make a missing provider session visible.

## Phase 0: Immediate Safety

Do this before relying on compressed rollout discovery in normal lists.

Implemented 2026-06-25 with option 1 below: `readFirstLine()` now uses a
streaming zstd decompressor and stops after the first decoded JSONL record or
the metadata byte limit. Full compressed session detail reads still use the
full-file path, which is acceptable because detail loading intentionally reads
the transcript.

Options, in preference order:

1. Implement streaming zstd first-line reads and keep `.jsonl.zst` discovery
   enabled only after tests prove discovery stops after the first decoded JSONL
   record.
2. Keep `.jsonl.zst` path recognition but skip compressed metadata reads unless
   a durable metadata cache already knows that rollout.
3. Gate `.jsonl.zst` scanning behind an explicit env flag such as
   `CODEX_SCAN_COMPRESSED_ROLLOUTS=slow`, documented as a recovery/debug path.
4. Revert default `.jsonl.zst` discovery until Phase 2/3 lands.

Acceptance criteria:

- [x] Normal Codex project/session listing never performs whole-file zstd
  decompression for metadata discovery by default.
- [x] Tests cover the chosen gate.
- [x] The user-visible behavior for plain `.jsonl` history remains complete.

## Phase 1: Provider-Neutral Discovery Index

Implemented 2026-06-25 as `SessionDiscoveryIndex`, with the first adapter in
`sessions/codex-discovery.ts`.

The index is provider-neutral and sharded instead of one large JSON file:

```text
{dataDir}/indexes/session-discovery/<provider>/<source-root-hash>/<shard>.json
```

For Codex, the shard is the rollout date bucket, for example:

```text
{dataDir}/indexes/session-discovery/codex/<root-hash>/2026/06/25.json
```

The generic record stores only normalized discovery metadata:

```ts
interface SessionDiscoveryRecord<TMetadata> {
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
```

For Codex, `metadata` currently contains only `id`, `cwd`, `timestamp`, and
`isSubagent`. Large raw `session_meta` fields such as base instructions are
not persisted in the discovery index.

The load-bearing invariant is that this index is derived and
non-authoritative:

- Provider files are enumerated first.
- Cache records are consulted only for currently observed files.
- Missing provider files are hidden immediately, even if stale records remain
  on disk.
- Stale shard cleanup can be lazy because it is not required for correctness.
- New sessions touch only the relevant provider/root/date shard, not a global
  monolithic JSON file.

Acceptance criteria:

- [x] First scan populates the discovery index.
- [x] Second scan after append/restart reuses metadata without updating head
  validation state for known rollouts.
- [x] Server restart reloads the discovery index.
- [x] Corrupt shard files are ignored without breaking plain session listing.
- [x] Deleted provider files are not resurrected from stale shard records.

## Phase 2: Codex Reader/Scanner Integration

Teach the existing Codex readers to ask the discovery index first.

Changes:

- `CodexSessionScanner.listProjects()` uses indexed metadata for known
  rollouts and reads first line only for new/suspect files.
- `CodexSessionReader.listSessionFiles()` uses indexed metadata for project
  filtering, instead of reparsing `session_meta` on each uncached scan.
- `SessionIndexService` full validation still stats session files, but it does
  not imply Codex metadata rereads for unchanged known rollouts.
- Broad Codex dirty marks become cheaper because reconciliation can start from
  path/stem metadata.

Important distinction:

- Discovery metadata freshness answers "which project/session is this
  rollout?"
- Session summary freshness answers "did visible transcript summary change?"

Those should not be conflated. A file append changes the second question, not
the first.

Acceptance criteria:

- [x] Appending to a known rollout does not reread line 1.
- [x] Changing mtime/size alone does not reread line 1.
- Replacing/truncating a rollout causes metadata validation or repair.
- [x] Existing project/session list tests still pass for plain Codex history.
- [x] Add cache-state tests around the new metadata reader.

Remaining gap: replacement detection is still conservative rather than
complete. Plain rollout appends are intentionally trusted; a same-path
replacement with a different first line but a non-shrinking file may keep
serving cached head metadata until a future explicit validation strategy is
added.

## Phase 3: Compression Reconciliation

Model compressed and plain files as one logical rollout.

Rules:

- Canonical identity is the plain `.jsonl` filename/stem.
- If both `.jsonl` and `.jsonl.zst` exist, prefer `.jsonl`.
- If `.jsonl` disappears and `.jsonl.zst` appears for the same stem, preserve
  indexed metadata and update representation/path.
- If only `.jsonl.zst` exists and no metadata is indexed, use the Phase 0 gate:
  streaming first-line reader, explicit slow opt-in, or skip.
- Opening a full compressed session detail may decompress/read the full file;
  the restriction is specifically about metadata discovery in list/scanner
  paths.

Acceptance criteria:

- A known plain rollout compressed to `.jsonl.zst` remains visible after
  watcher invalidation and after server restart.
- A plain+compressed sibling pair lists only one session.
- Scanner metrics distinguish cache-backed compressed discovery from zstd
  first-line reads.
- No default list path does whole-file zstd decompression for metadata.

## Phase 4: Streaming Zstd First-Line Reader

Implemented 2026-06-25 using Node's zstd stream APIs: `readFirstLine()` uses a
line-oriented compressed head reader for scanner use.

Requirements:

- Stop after the first decoded newline or a metadata byte limit.
- Preserve BOM stripping and empty-first-line behavior.
- Fail closed for unsupported Node versions: skip compressed metadata discovery
  unless an index hit exists or the user enabled the explicit slow path.
- Keep full-session `.zst` detail loading separate from metadata reading.

Tests:

- Reads first line from a compressed fixture.
- Does not consume/decompress the full file when the first line is near the
  start. Use a large fixture or an instrumented stream to prove early close.
- Handles missing zstd support.
- Handles malformed compressed data without breaking the scan.

## Phase 5: Watcher And Scheduling

Make missed-event recovery bounded.

Near-term options:

- Increase `CODEX_WATCH_PERIODIC_RESCAN_MS` dynamically when a periodic rescan
  takes a large fraction of the interval.
- Record duration and skip the next tick if the prior scan overran.
- Prefer date-bucket probing once the discovery index has high-water marks.
- Allow `CODEX_WATCH_PERIODIC_RESCAN_MS=0` to remain the hard opt-out.

Longer-term option:

- Replace frequent full-tree rescans with an index-backed reconciliation job
  that scans recent date buckets often and old buckets rarely, with explicit
  manual/debug full-rescan support.

Acceptance criteria:

- Periodic rescans cannot run continuously on a large tree.
- Slow logs identify the watched dir, files walked, duration, and backoff.
- Watcher teardown still clears timers and state.
- Existing `architecture-mandates` resource-quiescence requirements remain
  satisfied.

## Metrics

Add Codex scanner metrics before and after the index work:

- scan duration;
- directories walked;
- rollout files discovered;
- discovery index hits/misses;
- first-line reads by representation;
- zstd first-line reads;
- skipped compressed files due to missing gate;
- summary parses;
- watcher rescan duration and backoff interval;
- dirty-scope count.

Slow logs should fire for Codex metadata scans over a threshold, similar in
spirit to `SessionIndexService` performance logs.

## Verification Plan

Automated:

- Unit tests for discovery index load/save/corrupt-shard handling.
- Unit tests for canonical stem and plain/compressed sibling precedence.
- Unit tests proving append does not reread `session_meta`.
- Unit tests for server restart reuse of indexed metadata.
- Unit tests for compressed transition `.jsonl -> .jsonl.zst`.
- Unit tests for streaming zstd first-line reads if Phase 4 lands.
- Existing server tests:
  - `test/projects/codex-scanner.test.ts`
  - `test/sessions/codex-reader-oss.test.ts`
  - `test/routes/global-sessions.test.ts`
  - `test/config.test.ts`

Manual:

- Use a local Codex history with sessions older than two weeks.
- Confirm default lists show old sessions with `SESSION_AUTO_ARCHIVE_DAYS=0`.
- Compress a known rollout or use a fixture under a test Codex home and confirm
  it remains visible only through an allowed gate.
- Watch server logs with scanner perf logging enabled during global sessions,
  project sessions, and inbox navigation.

## Non-Goals

- Do not use hidden archive filtering as the performance fix.
- Do not spawn Codex to list local history.
- Do not rewrite provider rollout files.
- Do not make a global database migration a prerequisite for reading existing
  plain `.jsonl` history.
- Do not change YA-visible session ids while refactoring metadata identity.

## Open Questions

- Which file identity fields are portable enough on Windows to detect
  replacement without excessive stats?
- Should archived Codex sessions get a separate root in the same index, or a
  separate archive index?
- What is the right default for `CODEX_WATCH_PERIODIC_RESCAN_MS` after the
  discovery index exists?
- Should there be a user-facing "rebuild Codex history index" action, or only
  a maintenance/debug endpoint?
