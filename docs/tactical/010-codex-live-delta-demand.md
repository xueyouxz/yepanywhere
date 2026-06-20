# Codex Live Delta Demand

## Problem

Codex app-server live delta notifications can be expensive in YA because they
are currently converted into cumulative `_isStreaming` messages and then
processed by each active session subscription. A browser-local "response
streaming" preference can suppress rendering on that client, but by itself it
does not tell the server that live deltas are unwanted.

The server-level `YEP_CODEX_DISABLE_LIVE_DELTAS=true` diagnostic switch is useful
for isolating event-loop pressure, but it is too coarse for normal use: it
affects every connected client regardless of whether one of them actually wants
live streaming.

## Desired Behavior

Session subscribers should advertise whether they want live provider deltas.
For Codex:

- If at least one active session subscriber wants live deltas, YA keeps
  receiving and processing Codex live delta notifications.
- If no active session subscriber wants live deltas, YA drops Codex live delta
  notifications at the provider boundary, before raw logging, normalization,
  augmentation, replay buffering, or relay/client emission.
- A subscriber that opted out should not receive live `_isStreaming`,
  `stream_event`, `pending`, or streaming block `markdown-augment` events even
  when another subscriber opted in.
- Final `item/completed`, `turn/completed`, errors, approvals, token usage, and
  final markdown augments continue to flow.
- Older clients that omit the new subscription field default to wanting live
  deltas.

This keeps the UI preference browser-local while making backend work reflect
active subscriber demand.

## Non-Goals

- Do not dedupe augmentation across subscribers. `ARCHITECTURE.md` already
  records the larger fan-out/async-dispatch proposal; this work should not
  enact it.
- Do not add a synchronized global setting for response streaming.
- Do not change persisted transcripts or replay semantics for completed
  messages.

## Implementation Shape

1. Extend session subscribe messages with an optional `wantsLiveDeltas` boolean.
2. Have the client populate that field from the browser-local streaming
   preference at subscribe time, and resubscribe when that preference changes.
3. Reference-count live-delta demand on the `Process` so cleanup on unsubscribe
   immediately releases demand.
4. Pass a provider start predicate, `shouldEmitLiveDeltas`, from `Supervisor`
   into provider sessions. For Codex, use it together with the env diagnostic
   switch to suppress live delta notifications at app-server notification
   intake.
5. Filter live streaming messages per subscription so a non-streaming subscriber
   does not pay augmentation or transport cost when another subscriber keeps
   provider live deltas enabled.

## Caveat

When a new process is created and no session subscriber is attached yet, the
provider demand predicate is false. Any live deltas emitted in that gap may be
dropped. Final completed items remain authoritative, so correctness is
preserved; the trade-off favors avoiding backend work with no current live
consumer.
