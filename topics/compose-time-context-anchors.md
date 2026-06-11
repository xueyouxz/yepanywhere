# Compose-Time Context Anchors

> Opt-in (default off): queued/deferred user turns are delivered verbatim,
> one per delivery boundary; a non-zero join window merges
> consecutively-composed queued turns into one separator-joined provider
> turn, and compose anchors prepend `(Ns ago)` / `(Ms later)` staleness
> text.

Topic: compose-time-context-anchors

## Status

Both behaviors here are default-off per
[vanilla-defaults](vanilla-defaults.md), after upstream removed the anchors
and objected to the batched flush (`25e7f5d1`, "Keep queued messages
verbatim"; see the [kzahel-disabled](kzahel-disabled.md) rejection log). The
default contract is simple: queued/deferred delivery preserves the user's
message text exactly (apart from explicitly invoked slash-command expansion
and attachment references), and each completed-turn delivery boundary takes
exactly one turn off the deferred queue — N queued "proceed"-style messages
yield N work slices.

Open question: whether first-party provider UIs truly deliver one queued
message per turn (the maintainer-relayed upstream claim) has not been
independently verified. If first-party queue flushing turns out to batch,
the batch-flush default could be revisited as a product decision.

## Configuration and precedence

Two knobs, resolved at each delivery boundary as: server setting (UI) when
set, else env var, else off.

| knob | server setting | env var | default |
|---|---|---|---|
| join window (seconds) | `deferredJoinWindowSeconds` | `YA_DEFERRED_JOIN_WINDOW_S` | `0` = never join |
| compose anchors | `composeAnchorsEnabled` | `YA_COMPOSE_ANCHORS=1` | off |

The server settings are stored by `ServerSettingsService` (PUT
`/api/settings`), which publishes them to a live bridge
(`supervisor/deferredDeliverySettings.ts`) so changes apply to the next
delivery boundary without a restart. The client exposes both settings in
the "Message Delivery" pane (not Appearance, not new-session defaults):
a slider with an adjacent numeric input where 0 reads as "never batch
consecutive queued turns". Changes apply immediately (no Save button);
the header-row Undo reverts to the pane-open snapshot (see
[ui-architecture](ui-architecture.md) § Settings Pane Conventions). The
pane also hosts `clientDefaults.steerNowDefault`: the initial state of
the per-turn "now" steering toggle for providers with a "now" lane
(currently Claude only — Codex has steer vs queue but no "now"); the
toggle itself stays per-turn, and its visibility is a Toolbar settings
control — see
[steer-queue-provider-differences](steer-queue-provider-differences.md).

## Opt-in: join window (`deferredJoinWindowSeconds` > 0)

The leading run of queued turns whose consecutive compose times each fall
within the window is merged into one provider turn joined with
`\n\n--------\n\n` separators (`concatUserMessages`). The window is
*sliding* — each send within N seconds of the *previous* send extends the
group, so a steady burst chains into one turn and the first real pause
splits — rather than fixed to the first message, which would arbitrarily
split mid-burst. A large window approximates "always join" (the original
batched flush). The merged turn carries every chunk's `tempId` so queued
chips reconcile by identity (see
[message-control-steer-queue-btw-later-interrupt](message-control-steer-queue-btw-later-interrupt.md)).

A proper first-class control for the "keep working through my queued
go-aheads" intent (a slice/duration budget rather than N queued nudges)
would be a better long-term home for the never-join use case; nothing
ships for that yet.

## Opt-in: staleness anchors (`YA_COMPOSE_ANCHORS=1`)

When a session is busy, the YA composer queues user turns into the
per-process deferred queue. Those turns are held server-side and promoted at
a later delivery boundary. By then the message may be meaningfully stale:
the agent did work the user had not seen when they composed it, so a queued
comment ("that looks wrong") risks being read against newer output than the
user meant. Anchors mark that staleness:

- **Computed at delivery, never at queue time.** Elapsed seconds come from
  `Date.now()` at the promotion call. Re-queueing (edit-and-resubmit)
  re-stamps compose time.
- **First delivered chunk → `(Ns ago)`** (whole seconds from compose to
  delivery); **each later chunk → `(Ms later)`** (gap after the previous
  chunk's compose time). Under batched flush the anchors land between the
  shared `--------` separators.
- **Threshold.** Anchors below `MIN_COMPOSE_ANCHOR_SECONDS` (10) are omitted
  as noise. A side effect: with a join window of 10s or tighter, joined
  chunks never earn an `(Ms later)` note — only the group's initial
  `(Ns ago)` can appear.
- **Anti-skew.** The compose time is `metadata.serverReceivedAt` (stamped at
  the route) falling back to the queue entry's `timestamp` — both server
  clock, so differencing against server `Date.now()` has no client/server
  skew.
- **Placement invariant.** The anchor is prepended **after** emulated
  slash-command expansion, never before, so a queued `/command` is still
  detected as a leading slash. Provider input and client echo carry the same
  anchored text (preserving JSONL/echo dedup).
- The interrupt drain path (`Process.interrupt`, `INTERRUPT_PREAMBLE`) is
  intentionally **not** anchored; it is a user-driven immediate flush with
  its own framing.

## Can models use the anchors at all?

Models have no innate sense of elapsed time: a context window is tokens,
not a clock, and (as upstream noted) provider contexts are not generally
timestamped, so an agent cannot know how long ago a queued message was
composed — or that it predates work just finished — unless text says so.
That is the argument *for* an explicit anchor: it is the only mechanism by
which the model *can* be time-aware here, and models handle explicit
durations in text fine.

Usability, though, depends on the agent's instructions defining the
convention. An agent whose harness instructions document the queued-send
separator convention can read `(93s ago)` as "this comment predates my
recent work" and resolve references accordingly. Without such instructions,
a bare parenthetical is plausibly misread as user-typed text. The benefit
(stale-reference disambiguation) is believed from use, not measured —
which, per [vanilla-defaults](vanilla-defaults.md), is exactly why it earns
an option and not a default.

## Legacy compatibility

Older transcripts and local pending-chip state can still contain anchored
queued turns. Client-side reconciliation continues stripping leading
`(Ns ago)` / `(Ms later)` markers when matching an old delivered turn
against a persisted queued chip (`useSession.ts`), and must also tolerate
turns produced with the opt-ins enabled.

## Implementation

- `packages/server/src/config.ts` — `deferredJoinWindowSeconds` /
  `composeAnchors` from `YA_DEFERRED_JOIN_WINDOW_S` / `YA_COMPOSE_ANCHORS`
  (see [ya-env-vars](ya-env-vars.md)).
- `packages/server/src/supervisor/deferredDeliverySettings.ts` — live
  bridge: `publishDeferredDeliverySettings` (called by
  `ServerSettingsService` on load and update) and
  `resolveDeferredDeliverySettings` (published settings, then env).
- `packages/server/src/services/ServerSettingsService.ts` +
  `packages/server/src/routes/settings.ts` — `deferredJoinWindowSeconds`
  and `composeAnchorsEnabled` server settings with PUT validation.
- `packages/server/src/supervisor/Process.ts` — `resolveDeferredDelivery`
  (constructor override for tests, then the bridge), `leadingJoinGroup`
  (sliding window; 0 never joins), `promoteEligibleDeferredAfterTurn`
  (one join group per boundary), `promoteEligiblePatientDeferredMessages`
  (all join groups queued in one pass; scheduling unchanged),
  `deferredComposeAnchors`, `queueMessage`'s `composeAnchor` option.
- Tests: `packages/server/test/supervisor/composeTimeAnchor.test.ts` (pure)
  and the "one verbatim deferred turn per delivery boundary" /
  "within the join window" / "splits queued turns at compose-time gaps" /
  "compose-time anchors when opted in" cases in
  `packages/server/test/process.test.ts`.

## Observed UI Edge Case

- Observed on 2026-06-07: a queued/compose-age UI tag could show `1h ago` in
  a session where the active owner had not typed in that window. Hypothesis:
  the displayed relative-age tag uses a stale compose/source timestamp from
  a possible TUI owner or restored draft rather than the relevant YA
  composition event for this client. A UI timestamp-source bug candidate,
  separate from the server-side delivery contract above.
