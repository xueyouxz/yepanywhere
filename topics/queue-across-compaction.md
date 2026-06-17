# Queue survival across compaction boundaries

> YA's "deliver the next queued message once the agent is genuinely finished"
> queue (the `patient` / verified-idle queue) must keep working across provider
> compaction. It does on Codex. On Claude it is broken: a compaction-induced
> process termination silently throws the queue away, defeating the whole point
> of queueing turns across a long, self-compacting run (e.g. a Ralph loop of
> "proceed" messages).

Topic: queue-across-compaction

Related topics:
[message-control-steer-queue-btw-later-interrupt](message-control-steer-queue-btw-later-interrupt.md),
[resume-compaction](resume-compaction.md),
[compact-and-handoff](compact-and-handoff.md),
[CLAUDE](CLAUDE.md),
[provider-state-machine](provider-state-machine.md),
[session-liveness](session-liveness.md).

## The queue this doc is about

The feature here is: **queue one or more messages and have the next one
delivered only once the agent is genuinely done — all work and background tasks
finished, no self-revival.** In code this is the `patient` delivery intent,
promoted only at `verified-idle`
(`promoteEligiblePatientDeferredMessages`, gated on
`liveness.derivedStatus === "verified-idle"` in `Supervisor.ts`). When this doc
says "the queue," it means this one.

### Terminology aside (do not let this dominate)

There is one server-side queue structure, `Process.deferredQueue`, holding items
with one of two delivery intents:

- **`patient` / verified-idle** — the subject of this doc, above.
- **`deferred` / turn-end** (the default) — promotes the next message at the end
  of the current turn/tool call, without consulting background tasks or
  liveness. It drains seconds later and is only marginally gentler than
  steering. It is **not** what people mean by "queue until the agent is done,"
  and the compaction bug below is not interesting because of it.

The `deferred` vs `patient` split is a well-known naming trap (`patient` was a
later coinage for what was originally just "a queued message"). It is recorded
in the root `GLOSSARY.md`; that is the right level of attention for it. The rest
of this doc stays focused on the verified-idle queue.

## What compaction must not do

Compaction is exactly the moment this queue needs to survive: long autonomous
runs are the ones that both fill context (triggering compaction) and want a
standing queue of follow-up turns. A queue that silently evaporates the moment
the provider compacts is worse than no queue, because the user believes work is
still scheduled.

The queue lives in `this.deferredQueue` and is meant to persist until each entry
is promoted at its boundary. Nothing about compaction should empty it.

## Provider behavior, as verified by code reading (2026-06-17)

### Codex — works: compaction is absorbed inside a turn

Codex runs each turn as a `while (!turnComplete)` notification loop
(`packages/server/src/sdk/providers/codex.ts`, app-server turn loop). A
`context_compaction` notification is converted to a `compact_boundary` system
message and yielded **inline**; it does not set `turnComplete` (only
`isTurnTerminalNotification` does). So:

- Compaction happens mid-turn; the turn continues afterward.
- Compaction never terminates the Codex process, so `deferredQueue` is never
  dropped. The session reaches `verified-idle` after the post-compaction work
  completes, and the next queued message promotes normally.

Net: the standing queue keeps delivering across compaction boundaries. This
matches the originally observed working behavior for Codex runs.

### Claude — broken: compaction can terminate, termination drops the queue

A Claude compaction that fails ("context too full") or leaves an SDK api-error
tail trips `markTerminated` (`Process.ts`, the
`isClaudeSdkApiErrorMessage(...) → abortFn / markTerminated` branch in the
message handler). When that happens the queue is lost:

- `markTerminated` does **not** drain or hand off `this.deferredQueue` (it clears
  timers and pending tool approvals only).
- The Supervisor's `terminated` event handler only emits a notification
  (`Supervisor.ts`, `event.type === "terminated"` → `emitProcessTerminated`); it
  does **not** recover queued messages.
- The recovery routine that *would* preserve them
  (`recoverDeferredMessagesAfterHardAbort` via
  `drainPendingUserMessages("promoted")`) is wired **only** to the
  interrupt-fallback hard-abort path, not to spontaneous termination.

So when a Claude compaction blows up, every remaining queued message is silently
discarded and the run stops being fed. User-visible symptom: "the session broke
and I had to terminate and restart manually."

(Separately and more minor: the UI's manual `/compact` is itself fragile — it
goes through the raw `messageQueue` with no idle gate or completion watcher, and
the client strips any text typed after `/compact`. That is a compact-trigger
bug, not the queue-survival bug, and is tracked alongside the compact-instruction
stripping in `handleCustomCommand`/`handleCompactSession`.)

### Asymmetry worth noting

The codebase already treats compacting-while-busy as unsafe in the paths it
controls: auto-compact (`tryQueueTargetedAutoCompact`) refuses unless
`state === "idle"`, and resume-compaction (`tryResumeCompaction`) refuses
non-idle starts and wraps the compact in a `watchResumeCompaction` observer that
detects failure/timeout/termination. The least-guarded path is the one that hurt
the queue.

## Fix directions (not yet implemented)

Candidate directions, not a committed design:

- **Recover the queue on spontaneous termination (the fix that matters).** Make
  the Supervisor `terminated` handler (and/or `markTerminated`) drain and
  re-enqueue `deferredQueue` onto the replacement process the same way the
  interrupt-fallback path already does via
  `recoverDeferredMessagesAfterHardAbort`. This stops the silent loss and
  generalizes to any spontaneous termination, not just compaction.
- **Make compaction a recognized boundary the queue is aware of**, so a forced
  restart hands the standing queue forward instead of dropping it.
- When implementing, it would be nice for the eager `deferred` items to be
  handled reasonably too (carried forward, not lost), but they are not the point
  and should not drive the design.

## Invariants the fix must preserve

- A compaction must not silently empty the queue. If a restart is unavoidable,
  the queued messages are handed to the replacement process, not dropped.
- The verified-idle promotion contract is unchanged: a queued message is
  delivered only once the agent is genuinely finished, not pulled forward by the
  compaction itself.
- Codex's working behavior (compaction absorbed inline, queue untouched) must not
  regress.

## Status

Investigation only as of 2026-06-17. No code changes made. Behavior above was
established by reading the supervisor/process/provider source; the Claude
compaction failure was reasoned from the termination/recovery code paths rather
than reproduced with a live failed compaction.
