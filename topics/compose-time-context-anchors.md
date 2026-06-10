# Compose-Time Context Anchors
> Queued user messages delivered later carry a compose-time staleness anchor
> (`(Ns ago)` / `(Ms later)`) computed at the moment of delivery, so the agent
> can tell how old a queued turn is relative to the work it just finished.

Topic: compose-time-context-anchors

## Concern

When a session is busy, the YA composer queues user turns into the
per-process deferred queue (see
[message-control-steer-queue-btw-later-interrupt](message-control-steer-queue-btw-later-interrupt.md)).
Those turns are held server-side and promoted to the provider at a later
delivery boundary — after the active turn completes, or after a completed tool
result for steer-capable providers. By then the message may be meaningfully
stale: the agent did work the user had not seen when they composed it.

This topic defines the contract for annotating that staleness. It mirrors the
harness "Queued-send time separators" convention (`--- (Ns ago)` before the
first chunk, `--- (Ns later)` between chunks) so that an agent reads queued
staleness the same way regardless of which supervisor delivered the turn.

## Contract

- **Computed at delivery, never at queue time.** The elapsed seconds are
  computed from `Date.now()` at the promotion call, not baked in when the
  message was enqueued. A message that sits in the deferred queue longer shows
  a larger number; re-queueing (edit-and-resubmit) re-stamps its compose time.
- **First delivered chunk → `(Ns ago)`.** `N` = whole seconds from the chunk's
  compose time to delivery.
- **Each later chunk → `(Ms later)`.** `M` = whole seconds after the *previous*
  chunk's compose time (an inter-chunk gap, independent of delivery time). When
  multiple deferred turns promote together they are concatenated into one
  provider turn, so the anchors land between the shared `--------` separators.
- **Threshold.** Anchors below `MIN_COMPOSE_ANCHOR_SECONDS` (10) are omitted as
  noise — a freshly delivered message needs no staleness note. This applies to
  both the `(Ns ago)` intro and inter-chunk `(Ms later)` tags. Even a single
  queued message gets the intro anchor when it crosses the threshold.
- **Units are whole seconds**, matching the documented convention the agent
  uses to interpret these. A large value (e.g. `(1200s ago)`) is expected for
  long-running turns and is not reformatted into minutes/hours.

## Compose-time source (anti-skew)

The anchor's start point is the message's compose time, taken from
`metadata.serverReceivedAt` (stamped on every user turn at the route,
`routes/sessions.ts`) and falling back to the deferred queue entry's own
`timestamp`. Both are **server clock**, so differencing against `Date.now()`
(also server clock) has no client/server skew. Client-supplied times
(`composition.submittedAt`, `clientTimestamp`) are deliberately not used as the
differencing anchor to avoid skew.

## Placement vs. slash-command expansion (invariant)

The anchor is prepended **after** emulated slash-command expansion, never
before. A queued `/command` must still be detected as a leading slash; prefixing
`(Ns ago)\n\n` ahead of expansion would defeat detection. In `Process`, the
anchor is threaded as the `composeAnchor` option of `queueMessage` and applied
to the already-expanded provider text, so both the provider input and the
matching client echo carry the same anchored text (preserving JSONL/echo
dedup).

## Scope boundary: interrupt drain is not anchored

The interrupt path (`Process.interrupt`) drains direct + deferred queues into a
single packet carrying `INTERRUPT_PREAMBLE` ("resumable after"). That is a
user-driven *immediate* flush with its own framing, not an automatic
deliver-later boundary, so compose-time anchors are intentionally **not**
applied there. If staleness signalling is later wanted for interrupted deferred
messages, it should be reconciled with the preamble rather than stacked on top.

## Surfaces

- **Provider input**: the agent receives the anchor inline at the top of the
  delivered chunk(s).
- **Client echo / transcript**: the same anchored text is echoed, so the
  rendered user turn shows the anchor (consistent with how the harness shows the
  injected separator as part of the user turn).
- A separate, optional UI affordance — relative-time ("ago") mouseover tags on
  turns, and the queued-row compose-context jump — is a client-package concern
  tracked independently of this server-side delivery contract; the jump
  affordance's contract lives in
  [message-control-steer-queue-btw-later-interrupt](message-control-steer-queue-btw-later-interrupt.md)
  § Queued-item navigation affordance.

## Observed UI Edge Case

- Observed on 2026-06-07: a queued/compose-age UI tag could show `1h ago` in a
  session where the active owner had not typed in that window. Hypothesis: the
  displayed relative-age tag is using the stale compose/source timestamp from a
  possible TUI owner or restored draft rather than the relevant YA composition
  event for this client. This is a UI timestamp-source bug candidate, not a
  change to the server-side delivery-anchor contract above.

## Implementation

- `packages/server/src/supervisor/composeTimeAnchor.ts` — pure
  `composeTimeAnchor` / `composeTimeAnchors` and `MIN_COMPOSE_ANCHOR_SECONDS`.
- `packages/server/src/supervisor/Process.ts` — `composedAtMsForEntry`,
  `deferredComposeAnchors`, `queueMessage`'s `composeAnchor` option for
  single-message promotion, and stitched batch promotion that applies per-entry
  anchors before concatenating the live echo/provider turn.
- Tests: `packages/server/test/supervisor/composeTimeAnchor.test.ts` (pure) and
  the "prefixes promoted deferred turns with compose-time anchors" case in
  `packages/server/test/process.test.ts`.
