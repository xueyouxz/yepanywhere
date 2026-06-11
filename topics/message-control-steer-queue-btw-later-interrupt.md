# Message-control and queue contract (busy/idle and later intent)

> Message-control is the UI-visible contract for direct sends, steering,
> queueing, `/btw`, and deferred or later intent while a session is busy.

This note defines the UI-visible contract for message-control decisions in a YA
session: when the composer can send directly, when it queues, how `/btw` is routed,
and how model-selection text is substituted while busy. It is a consumer contract
for both client behavior and provider-specific control adapters.

Provider-level facts behind these intents — Claude's `priority`
(now/next/later) lanes, Codex `turn/steer` vs app-side queueing, and
end-of-turn signals — live in
[steer-queue-provider-differences.md](steer-queue-provider-differences.md).

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
- message `deliveryIntent`: `direct`, `steer`, `deferred`, or `patient`.

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
| `idle` | Send | `direct` | Normal turn submission into the current turn boundary. |
| `in-turn`, provider has steering | Primary action | `steer` (best effort) | User asks for immediate interrupt-style continuation; fallbacks to queue if steer unsupported at time of send. |
| `in-turn`, provider has no steering | Queue action | `deferred` | Keep immediate turn ownership untouched; append to deferred queue. |
| Any busy non-steering path where queue exists | Queue action | `deferred` | Keep the active turn untouched; append to the deferred queue. |
| Any queue path | Route | `deferred` | Messages are inserted through YA-managed deferred delivery, not as direct steering. |
| `Ctrl+Enter` alternate send | opposite of the visible Enter/default action | `steer` or `deferred` | In active steering sessions, Enter and `Ctrl+Enter` are complementary: one steers now, the other regular-queues. Patient is not the alternate-send shortcut. |
| Patient queue setting enabled for a new queued item | Queue action | `patient` | Per-item patient intent waits for the quiet/verified-idle patience threshold before delivery. This is a super-delay queue option, independent of provider steering support. |
| Queued chip on steering-capable active turn | `Steer now` | `steer` | User explicitly overrides queued/patient waiting and injects the queued item into the active turn. |
| `/btw` explicit route | Aside control | separate aside session | Not a queue path and not `steer`. |

### Queue text rule

- Default queueing never rewrites the user's text.
- The phrase `when done, ` is ordinary user-authored prompt text, not a YA queue
  mechanism. New patient queue submissions do not prepend it.
- Regular queue sends attach `deliveryIntent: "deferred"`.
- Patient queue sends attach `deliveryIntent: "patient"` and keep their own
  accepted queue timestamp/metadata. Changing the patient setting later does
  not mutate already queued items.
- `Steer now` on an existing queued chip strips one recognized patient prefix
  before steering for legacy queued items, because the user has explicitly
  overridden old prompt-visible "when done" wording with "now".
- Regular and patient queue entries are separate per-item intents. Regular
  entries may pass patient entries at delivery time. The composer tail should
  preserve the user's typed order while making patient rows visibly distinct
  (for example by offset, tone, status text, and age) so the display does not
  imply one strict FIFO when patient rows are waiting for the quiet threshold.
- Queueing remains in-session and avoids immediate active-turn injection.
- Patient mode is a persistent queue setting, not a replacement for the queue
  action. The status-bar appearance setting for queue controls gates only the
  regular/patient switch, defaults hidden for new users, and should be labeled
  as the patient-queue switch. It must not hide the alternate Steer/Later send
  button: in dual-action active sessions the non-primary send option remains
  visible whenever the provider/action state supports it.
- When the visible queue action is available, its icon/color should change so
  the click invitation reflects whether it will create a regular queued item or
  a patient queued item.
- The patient-mode switch should stay compact: show the active state in the
  switch glyph/thumb, but keep the actual quiet interval in tooltip and
  acknowledgement copy rather than widening the toggle with `Nm` text.
- Observed on 2026-06-07: patient rows did deliver per contract after the quiet
  threshold, while a later regular queued row passed them as intended.

### Patient countdown and promotion proposal

Status: proposal.

- When a session is idle and patient queued rows are counting toward autosend,
  patient rows should show a countdown to the quiet-threshold send time.
- Patient rows should expose an explicit promote/send-now action.
- Promoting a lower patient row should promote all patient rows above it, because
  that preserves typed order within the patient lane and avoids sending a later
  patient thought while earlier patient context remains delayed.
- This is distinct from regular queued rows jumping ahead during active work:
  promotion is a user override of patient waiting, not a change to the ordinary
  regular-vs-patient delivery ordering.

Narrow bottom-row overflow is tracked in
[`composer-bottom-bar-overflow.md`](composer-bottom-bar-overflow.md).

### Queued-item navigation affordance

Status: first implementation landed on 2026-06-06. Current queued rows expose
copy, edit, cancel, steering-capable `Steer now`, and a context jump. The first
anchor is the queued row's accepted timestamp, not the earlier first-typed-char
timestamp.

- Queued rows of all delivery intents should include a hyperlink-style jump
  affordance. It jumps to the scroll/view position where the message was
  significantly begun (earliest non-deleted character timestamp) when that
  anchor is available; using the sent/accepted timestamp is the simpler first
  implementation.
- After such a jump, show a temporary one-shot jump-back anchor with a matching
  icon in the left gutter. Activating it returns to the queued row and removes
  the one-shot anchor.
- The jump affordance is independent of edit/cancel/steer controls and applies
  to regular queued, patient queued, and recovered/verifying queued rows.

Clarified intent (2026-06-10, from the originating request):

- The affordance is navigation-only. It must not render a visible turn-like
  row, marker, or duplicated content at the compose position — its purpose is
  to let the reader see the agent-output context around the moment the
  message was typed, not to relocate or mirror the sent turn there. The only
  in-transcript artifact is the existing one-shot jump-back gutter icon
  after an explicit jump.
- Jumping is click-driven only. Queue promotion, merged delivery, reconnect,
  snapshot reconciliation, and re-renders must never scroll the view to a
  compose anchor on their own (see
  [scrollback-view-stability](scrollback-view-stability.md) for the general
  no-unsolicited-movement contract).
- The affordance should survive delivery: each chunk section of a sent
  multipart queued turn (the `--------`-separated blocks) gets its own
  side-link jump icon, because the chunks were composed at different times.
  Currently the affordance exists only on pre-delivery queued rows and
  disappears at delivery; per-chunk icons on the delivered turn are the
  intended extension, not yet implemented.

Observed bug (2026-06-10, diagnosed and fixed): the reader's scroll was
repeatedly pulled to the first merged send's compose context without the
affordance being knowingly clicked. It was not a scroll-writer at all: the
transcript content itself was being reordered on every merge. Claude
transcripts chain conversation rows through hidden connector rows
(`attachment`, `system`/api_error), and live stream rows arrive without
`parentUuid`. The client's `orderByParentChain` treated rows whose parent
chain was broken (missing connector) as orphans to append at the tail, and
parentUuid-less stream rows as roots to pull forward — so an api_error
fork's dead branch landed at the bottom of the transcript (directly above
the queued chips) and stuck there across merges, which read as "scroll
pulled to old context". Two fixes: `orderByParentChain` is now stable and
minimal-motion (only a row whose parent appears later in the array moves,
to just after its parent; broken-chain and parentless rows keep their
position), and the incremental-fetch cursor now tracks the newest
JSONL-sourced row instead of the array tail, so streaming can no longer
advance it past never-fetched connector rows.

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
  - native Codex TUI evidence suggests typed mid-turn input can wait under
    `Messages to be submitted after next tool call`, while `Esc` on that prompt
    interrupts enough to submit the pending steer promptly. Treat YA steering as
    active-turn input, not a stop guarantee; Stop/interrupt remains separate for
    mistaken or slow running tools.
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
