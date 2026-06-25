# Codex Metadata Scanner

> The Codex metadata scanner is the YA subsystem that maps date-bucketed Codex
> rollout files to projects and session summaries by reading rollout head
> metadata; its current shortcut caches help common navigation but do not yet
> provide a durable, bounded, compression-aware index.

Topic: codex-metadata-scanner

Related topics: [codex-sessions](codex-sessions.md),
[provider-refresh](provider-refresh.md),
[session-liveness](session-liveness.md),
[architecture-mandates](architecture-mandates.md).

Implementation plan:
[`docs/tactical/019-codex-metadata-scanner-index.md`](../docs/tactical/019-codex-metadata-scanner-index.md).

## Why It Exists

Codex stores local rollouts by time, not by project:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl
```

YA's project and session lists are project-oriented. To build those lists,
the server must learn each rollout's cwd from `session_meta`. The metadata
scanner exists to bridge that mismatch without spawning a Codex runtime.

The important invariant: `session_meta` is head metadata. After the first
successful parse for a rollout, its id/cwd/timestamp should be treated as
stable unless there is evidence the file was replaced or corrupted. Ordinary
append activity should not force repeated metadata reads.

## Current Implementation Shape

Current Codex discovery uses layered caches, not a durable Codex metadata
index:

- `CodexSessionScanner` recursively finds rollout files, reads first-line
  `session_meta`, groups by cwd, and caches the result for 5 seconds.
- `CodexSessionReader` has a shared 5-second scan cache keyed by sessions
  directory and active-window scope.
- `ProjectScanner` keeps a short-lived project snapshot and coalesces
  concurrent scans.
- `SessionIndexService` persists normalized session summaries and avoids
  reparsing unchanged sessions, but full validation still enumerates files
  through the reader and stats discovered paths.
- `FileWatcher` marks Codex scopes dirty when rollout files change; because a
  raw file event does not identify the owning project scope cheaply, loaded
  Codex scopes are marked dirty broadly.

These layers are useful for normal navigation and request bursts. They do not
change the underlying worst case: discovering an uncached or invalidated Codex
tree still walks rollout files and reads head metadata.

## Compression Gate

Codex may compress older rollouts to `.jsonl.zst`. YA should support those
files eventually, but compressed discovery has a stricter performance bar than
plain JSONL.

Plain `.jsonl` first-line reads can use a partial file read and stop once a
newline is found. A naive `.jsonl.zst` implementation that reads and
decompresses the whole file just to find the first line is not acceptable for
default scanner paths.

Default `.jsonl.zst` discovery is gated on at least one of:

- a durable metadata cache hit from the earlier plain `.jsonl`
  representation;
- a streaming zstd first-line reader that stops after decoding the first JSONL
  record;
- an explicit opt-in slow path for users who accept whole-file decompression
  during discovery.

As of 2026-06-25, YA satisfies this gate with a streaming zstd first-line
reader in `readFirstLine()`. Keep that separation intact: full compressed
session detail loads may read the full transcript, but scanner metadata
discovery must not depend on whole-file zstd decompression.

## Watcher And Scheduling Gaps

There is not yet an adaptive Codex scanner scheduler.

The server creates a `FileWatcher` for the Codex sessions directory. On
Windows and macOS, the Codex watcher currently enables a periodic full-tree
rescan by default because recursive `fs.watch` can miss deep file writes. The
rescan has an overlap guard, so a second rescan does not start while one is in
progress, but it does not dynamically back off when a scan is expensive.

Known gaps:

- no duration-based backoff;
- no scan budget or time slicing;
- no "scan took as long as the interval, increase interval" policy;
- no date-bucket high-water mark for routine active-list discovery;
- no per-scope dirty precision for Codex project lists;
- no persistent rollout metadata index to make watcher events cheap to
  reconcile.

This is acceptable only under YA's current single-user/small-team assumption.
It is not a design for millions of rollout files.

## Performance Failure Modes

The main costs are filesystem and metadata costs, not full transcript parsing:

- recursive `readdir` over the sessions tree;
- `stat` calls during validation and watcher rescans;
- first-line reads for uncached rollouts;
- repeated first-line reads after TTL expiry or broad invalidation;
- full decompression if compressed files are read without streaming
  first-line support;
- route fan-out that asks for global, project, inbox, and provider-catalog
  views close together.

Turning `SESSION_AUTO_ARCHIVE_DAYS` off makes default lists complete, which is
the correct user-visible default, but it also removes the old active-window
shortcut that skipped old Codex files during default scans. Completeness and
scanner cost need to be reconciled through better indexing, not hidden
session filtering.

## Required Near-Term Fixes

Before broadening Codex history discovery, especially compressed discovery,
the scanner should gain:

1. A durable Codex metadata index keyed by canonical rollout stem, physical
   path, file identity where available, and representation (`plain` or
   `zstd`).
2. Metadata immutability rules: append/mtime/size changes refresh summaries,
   not `session_meta`, unless replacement/truncation evidence exists.
3. Compression reconciliation: `.jsonl` and `.jsonl.zst` map to the same
   logical rollout, with plain-precedence and transition-safe dirty handling.
4. Keep streaming zstd first-line reads covered by tests so scanner discovery
   does not regress to full compressed transcript decompression.
5. Scanner metrics and slow logs specific to Codex metadata discovery.
6. Adaptive periodic-rescan behavior or a different missed-event recovery
   strategy that cannot spin indefinitely on very large trees.

## Non-Goals

- Do not spawn Codex just to list local sessions.
- Do not forge or rewrite rollout files to make scanning easier.
- Do not hide old sessions by default as a substitute for a bounded scanner.
- Do not make `.jsonl.zst` default discovery depend on whole-file
  decompression.
- Do not silently replace YA-visible session ids with provider-native ids while
  refactoring the scanner.
