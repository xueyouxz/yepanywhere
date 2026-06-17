# Queued messages (server-authoritative)

> Queued ("deferred") messages are server-owned state. The client renders the
> server's list and issues add/cancel requests. It never keeps its own copy of
> the queue, never reconciles by text, and never persists the queue to disk.

Topic: queued-messages

This note defines the intended design for queued messages. It is a deliberate
simplification back toward the original, working implementation. The current
code diverges from it — it mirrors the queue into `localStorage`, layers on
client-only delivery states, and reconciles the two stores by fuzzy text
matching. That divergence is the source of a large, untrustworthy class of
split-brain bugs (see "What we are removing" below) and is being corrected.

Provider-level delivery facts (Claude `now/next/later` lanes, Codex
`turn/steer`, end-of-turn boundaries) live in
[steer-queue-provider-differences.md](steer-queue-provider-differences.md). The
busy/idle composer contract lives in
[message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md).
This note is narrower: it governs *where queued-message state lives and how the
client learns about it*.

## Principles

1. **Server-authoritative.** The single source of truth is the in-process
   queue on `Process` (`deferredQueue`). Every client renders exactly what the
   server reports. There is no client-side queue model, merge step, or
   reconciliation pass.
2. **There is one composer draft, and it is the only client-persisted state.**
   Queued messages introduce no draft of their own. The only thing persisted on
   the client is the existing main session composer draft — the text you are
   typing — using the same draft persistence the composer already has. "Queue"
   versus "send now" is a routing decision made at submit time on that single
   composer's content (the steering mechanism), not a separate editor or a
   separate draft store. The queue itself is never written to `localStorage`.
3. **Identity is a server-owned id, never text.** Messages are addressed by id.
   Three queued messages that all say "proceed" are three distinct ids and are
   never collapsed, matched, or de-duplicated by their content.
4. **Ephemeral by design.** The queue lives in the Process. It dies when the
   process restarts and dies when the session stops. It is not persisted to
   disk, and that is acceptable — losing the queue on process death is expected
   behavior, not a failure to defend against.
5. **No optimism.** Queuing and cancelling behave exactly like sending a normal
   session message: the composer disables, the request goes to the server, and
   the UI only changes when confirmed server state comes back. No optimistic
   chip, no optimistic removal, no revert path.

## Behavior contract

- **Refresh / any tab / any machine → identical state.** Because every client
  renders the server's list, there is nothing to diverge. Open the session in
  two tabs and you see the same queue.
- **Queue (add).** Only offered while a turn is active (`in-turn`). The composer
  disables on submit; the chip appears when the server's updated queue is
  delivered. Queuing is meaningless when idle.
- **Idle send.** When the session is idle the queue affordance is not shown; a
  send goes straight through as a normal message. Nothing is queued.
- **Cancel (delete).** Issue the delete request; the chip disappears only when
  the next server state no longer contains it. A delete of an already-gone id is
  a no-op.
- **Process restart / session stop.** The queue is gone. Clients reflect the
  empty (or rebuilt) server state on their next sync. No local resurrection of
  "recovered" entries.

## Surface

- **List:** the client receives the queue from the server only — the `connected`
  event payload on (re)connect and `deferred-queue` SSE events on change. No GET
  fallback is required for correctness; the connection stream is the channel.
- **Add:** `POST` a queue request; the server appends and broadcasts the new
  list.
- **Cancel:** `DELETE` by id; the server removes and broadcasts the new list.
- **Draft:** the main composer's existing single draft, persisted in
  `localStorage` per session and cleared on a confirmed send. Queue and send-now
  share this one draft; there is no queued-message-specific draft.

The client holds no queued-message React state of its own beyond rendering the
last server-reported list; it does not maintain `deliveryState`,
`recovered`/`verifying` flags, client `tempId` reconciliation, or any text-match
removal logic.

## Non-goals (explicitly deferred)

These are intentionally out of scope for the core. Reordering and inline editing
are reasonable future features and can be layered on **once the basic
queue/cancel functionality is bug-free and trustworthy** — they are deferred,
not rejected. The point of this note is to ship a correct minimum first.

- **Editing a queued message.** To change a queued message, cancel it and queue
  a new one. (Future: in-place edit can be added on top of the server model.)
- **Reordering / reshuffling the queue.** (Future: server-side reorder by id.)
- **Steering a queued message into the active turn.**
- **"Jump to context" / nearest-timestamp navigation** from a queued chip.
- **Disk persistence** of the queue.
- **Optimistic UI** for add or delete.
- **Any fuzzy or content-based matching**, ordering inference, or client merge.

## What we are removing and why

Each removed piece maps to a concrete bug class it produced:

- **`localStorage` mirror of the queue** → split-brain between the persistent
  client copy and the ephemeral server queue: ghost chips that look queued but
  will never send, and chips that send twice.
- **Client `deliveryState` (`queued`/`sending`/`recovered`/`verifying`) and
  the connected-event merge** → "recovered" scratchpad entries the server has
  no record of, kept alive locally and never delivered.
- **Fuzzy text matching (`userTextContainsDeferredContent`, time-marker
  stripping, transcript/echo removal)** → identical or similar messages (the
  "proceed / proceed / proceed" case) collapsing into each other or being
  removed before they are actually delivered.
- **Client `tempId` re-threading and the edit barrier** → fragile id churn and
  an orphaned server-side barrier that silently blocks delivery of everything
  behind it.
- **Optimistic add/remove with revert paths** → transient failures that reorder
  the queue or leave the UI inconsistent with the server.

The original simple implementation — render the server's queue, add, cancel —
worked. This note codifies returning to that and keeping richer features off the
critical path until the base is solid.
