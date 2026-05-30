# Compact-and-handoff state policy (targeted codex mitigation)

This topic records an intentional, temporary mitigation for one specific
provider/model pairing observed to fail while compacting near context limits.

For the broader action/state contract used by composer controls (`direct`, `steer`,
`deferred`, `patient`), and for how compacting should drive the shared
model-selector replacement text, see
[`message-control-steer-queue-btw-later-interrupt.md`](./message-control-steer-queue-btw-later-interrupt.md).

## Scope and motivation

- Current experiment: auto-compact Codex sessions running on
  `gpt-5.3-codex-spark` when context pressure rises above a tight safety
  threshold before user message submission.
- This is not yet a general policy for all providers or models; it is an
  allow-listed path based on observed provider behavior and failure mode.
- The purpose is to avoid triggering provider-internal context failure while the
  user is idle and a boundary-crossing turn is about to be sent.

## Known state vocabulary for this policy

- `processState.idle` (source of truth for automation readiness)
- `processState.in-turn`
- `processState.waiting-input`
- `processState.hold`
- `isCompacting` (`status=compacting`)
- `sessionLiveness.derivedStatus.verified-idle`
- `sessionLiveness.derivedStatus.needs-attention`

## UI states and what must be shown

The state-machine contract from
[`provider-state-machine.md`](provider-state-machine.md) remains canonical.
This policy only narrows when the model-selector substitute text is shown:

- Show full model/provider info only when the session is idle.
- Show busy copy instead of model text while in-turn/waiting-input/hold or
  compacting (`Thinking`, `Waiting for input`, `On hold`, `Compacting`).
- Keep queue and manual stop/compact controls enabled according to normal
  state rules.

## Action matrix for the automatic compact guard

| Condition | What YA does | User-visible action |
|---|---|---|
| `processState != idle` | no auto-compact scheduling | full manual controls only |
| codex target provider/model + compact support + usage above threshold | enqueue `/compact` before current user turn | compact is queued first, user message still sent next |
| `/compact` enqueue fails | continue with user message | show warning only; do not block |
| manual `/compact` command present | do not run auto path | no duplicate attempt |
| deferred message path | do not run auto path | maintain existing deferred behavior |

## Trigger rules (targeted policy)

1. Provider must be `codex` and model must match allow-list:
   - `gpt-5.3-codex-spark` (and any explicit aliases for that release family if
     we see naming changes)
2. Process must be `idle` and not `status.owner=self`/`in-turn`.
3. Provider must advertise compact support for the active process.
4. Context pressure must exceed the configured compact boundary while message is
   accepted for send.
5. Ignore the path for manual compact commands and deferred queue promotions.

## Failure posture and fallback

- Compaction is non-interruptible at provider level and can itself fail. It is
  treated as a best-effort pre-send action and not a hard turn blocker.
- If provider compaction reports ready-but-unreachable or execution failures, the
  current user message should still proceed to avoid hard deadlock.
- If repeated failures occur, prefer handoff/start-new-session escalation over
  repeated compact retries.

## Planned extension criteria

Do not expand this list to all providers without evidence.
Promote from a targeted to broader policy only after we observe the same
pattern and verify provider-level prerequisites on each candidate path:

- provider emits a compact-capable command,
- compact is available while the process is idle,
- compact is known to improve survival for long sessions,
- and provider-specific fallback behavior is clear when compact fails.

## Provider-driven handoff verification status

- YA currently relies on template-guided handoff (including prior-turn context) as
  the validated recovery mechanism.
- Provider-driven handoff commands have not been independently proven to complete
  end-to-end in this workstream; treat this as a known limitation and keep the
  template path as the default behavior until observed.[^handoff]

## Provider-specific limitation notes

- Codex compact is currently non-interruptible while running and is the
  strongest current signal for this policy. Context shrinkage can still fail when
  the session is already too close to provider-side constraints, so this is a
  mitigation and not a guarantee.[^codex]
- Claude has no reliable compact affordance in current YA metadata surface; do
  not auto-run compact for this provider from this policy path until metadata
  and command flow are explicit.[^claude]
- OpenCode exposes no compact command in the metadata currently tracked here, so
  this policy is not portable to it without adapter-level change and explicit
  evidence of safe automation.[^opencode]

[^codex]: Keep automation text/controls aligned with the global provider state
machine, especially replacing model text with `Compacting` while compacting.
[^claude]: If future Claude support adds compact metadata and stable command
round-trips, reevaluate and add a provider-specific trigger branch.
[^opencode]: If OpenCode gains slash-command compact support, require explicit
`supportsSlashCommands` + non-ambiguous provider return states before enabling this
path.
[^handoff]: No provider-native handoff run has yet been validated as the active
  control path that succeeds independently of YA's template flow.
