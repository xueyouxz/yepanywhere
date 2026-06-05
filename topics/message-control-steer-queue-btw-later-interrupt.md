# Message-control and queue contract (busy/idle and later intent)

> Message-control is the UI-visible contract for direct sends, steering,
> queueing, `/btw`, and deferred or later intent while a session is busy.

This note defines the UI-visible contract for message-control decisions in a YA
session: when the composer can send directly, when it queues, how `/btw` is routed,
and how model-selection text is substituted while busy. It is a consumer contract
for both client behavior and provider-specific control adapters.

## State inputs that drive UI behavior

- `processState` from `Process`:
  - `idle`
  - `in-turn`
  - `waiting-input`
- `isCompacting` from process status subtype (`status=compacting`).
- `sessionLiveness.derivedStatus` for automation/scheduling decisions:
  - `verified-idle` is the key boundary used for background automation.
  - `verified-waiting-provider` and lower-priority statuses are non-final and do
    not authorize model edits.
- `status.owner` for action permissions (`self`, `external`, `none`).
- message `deliveryIntent`: `direct`, `steer`, `deferred`, or experimental
  `patient`.

## Model/indicator text contract (important)

The expanded bottom row next to the model selector must be status-first, not model-first.

1. Show normal model/provider text only when the session is effectively idle
   and not compacting.
2. Otherwise replace with provider-state copy:
   - `Thinking` for active turns (`in-turn`),
   - `Waiting for input` when `waiting-input`,
   - `Compacting` while `isCompacting` is true.
3. This text is also used as the canonical UX surface for compacting intent,
   both for auto-initiated compact attempts and user-issued compact flows.

Rationale:
- Model settings are likely stale or non-applicable while the turn is active.
- In turn mode, session control semantics are more valuable than model identity.

## Delivery intent behavior matrix

| Session condition | User action | Delivery intent / route | Why |
|---|---|---|---|
| `idle` | Send | `direct` | Normal turn submission into the current turn boundary.
|
| `in-turn`, provider has steering | Primary action | `steer` (best effort) | User asks for immediate interrupt-style continuation; fallbacks to queue if steer unsupported at time of send. |
| `in-turn`, provider has no steering | Queue action | `deferred` | Keep immediate turn ownership untouched; append to deferred queue. |
| Any busy non-steering path where queue exists | Queue action | `deferred` | Keep the active turn untouched; append to the deferred queue. |
| Any queue path | Route | `deferred` | Messages are inserted through YA-managed deferred delivery, not as direct steering. |
| Experimental patient queue enabled | Queue action | `patient` | Expert opt-in for softer "when done" intent; normal queue remains plain `deferred`. |
| `/btw` explicit route | Aside control | separate aside session | Not a queue path and not `steer`. |

### Queue text rule

- Default queueing never rewrites the user's text.
- Experimental patient queue mode may prepend `when done,` and attach
  `deliveryIntent: "patient"` metadata, but only when the user has enabled the
  experimental feature gate and selected that mode.
- Without that opt-in, softer wording such as `when done,` must be typed
  explicitly.
- Queueing does not make scheduling guarantees beyond keeping the message
  in-session and avoiding immediate active-turn injection.

## Compact-aware state transitions

- If YA triggers a pre-send compact attempt for a targeted provider/model,
  set `isCompacting` so UI enters `Compacting` state until YA receives a
  compact boundary event or the attempt fails/aborts.
- While compacting, show compacting copy and keep regular action constraints from
  the underlying turn/owner state (stop/queue/steer should follow those rules).
- If compaction is non-interruptible in the provider and blocks continuation,
  manual retry should remain a conscious user action, not automatic polling
  forever.

## `/btw` contract vs queue/steer

- `/btw` is a session-routing command, not a delivery intent.
- `/btw` must remain distinct from queue modes and steering.
- Parent session composer actions should be explicit; no implicit route sharing.

## Deferred queue reconciliation note (known desync)

Deferred rows should be treated as optimistic until the provider proves delivery.
For both Claude and Codex, there are observed cases where local queue state drifts:

- queued message remains visible after the provider has already consumed it,
- message disappears from history while still rendered in local queued state,
- message echoes are missing `tempId`, which delays removal from local scratch.

When the next reconnect/`connected`/`deferred-queue` snapshot does not resolve
the drift, preserve the row and expose recovery actions (`edit`, `cancel`, `retry`)
rather than implying a firm `"sent"` or `"queued"` terminal state.

Suggested reconciliation contract:

- prefer `tempId` match to mark definitive delivery,
- a bundled delivery is reconciled by identity, not text: when a queued batch is
  merged into one provider turn, the bundle records every chunk's `tempId`
  (`concatUserMessages` -> `UserMessage.tempIds`) and the delivered-turn echo
  carries that whole list (`tempIds` on the emitted user message). The client
  clears all of those chips by id on the echo — O(chips), and independent of the
  merged/time-marked turn text. This keeps the optimistic `sending` state intact
  (chips clear on the echo, i.e. proven delivery, not at promote time).
- fallback to content match only when no identifier is available,
- when neither path has confirmed, mark as `Queued (verifying)` in UI copy.
- if a row remains unverified across compact/turn boundaries, trigger a snapshot
  refresh before user-visible "stability" assumptions.
- the content-match fallback must tolerate provider-merged turns: split on the
  `\n\n--------\n\n` concatenation separator and strip any leading per-chunk
  `(Ns ago)` / `(Ns later)` time marker before comparing, because a multi-chunk
  queued send is delivered as a single turn carrying those prefixes. Without
  this, a chip stays stuck on `Sending queued message...` and persists across
  reload (queued chips live in `localStorage` under `queued-message-<id>`).
- match against the full loaded transcript, not just a recent tail, so a chip
  restored from storage on reload still reconciles after its delivered turn has
  scrolled back; guard the full scan with the queue timestamp (delivered turn
  must not predate the queue time beyond clock skew) so an unrelated older
  identical turn cannot false-match.

## Action matrix by readiness

- `idle`
  - primary send is direct.
  - model/menu edits are available when session ownership is clear.
  - compact commands may be exposed when adapter metadata supports them.
- `in-turn` / `waiting-input`
  - primary control is state-aware (`Steering/Queue/Compaction` as applicable).
  - full model editing is deferred/hidden by rule above.
  - compacting overlay remains copy-only and must not advertise model edits.
- non-`self` ownership
  - queue remains allowed where supported.
  - direct send and model edits should remain guarded, not forced.

## Known provider gaps / portability guardrails

- Codex
  - supports steering via provider controls and exposes compact behavior; compact
    can still fail if context is already saturated.
  - compacting is strongly non-interruptible in observed flows, so the overlay and
    no-auto-retry posture should be treated as expected behavior.
  - target-specific workaround currently validated for `gpt-5.3-codex-spark`:
    preemptive compact-on-idle boundary before user message send when usage
    pressure exceeds the tuned threshold.
- Claude
  - slash command availability is unevenly surfaced and no reliable internal
    compact control is validated in this contract layer.
  - steering is not currently part of the path, so queue/deferred paths carry the
    primary queueing burden.
- OpenCode
  - no validated compact command path is currently exposed.
  - control is split between status/event evidence and message routing; no automatic
    compact expansion beyond explicit template/handoff behavior.

## Provider-driven handoff status

Provider-native handoff has not been independently verified end-to-end in this
workstream. The scripted template-based handoff remains the validated behavior,
with prompt-visible context carry-forward to ensure recoverability even when
provider-native handoff is unavailable or unsupported.
