# Provider state machine (UI contract)

This topic defines the provider/process state contract that YA should render in
the session UI: what it means, what to advertise in UI surfaces, and what actions
are valid in each state.

## Source states

- `processState` (`idle`, `in-turn`, `waiting-input`, `hold`) from process status
- `sessionLiveness.derivedStatus`:
  - `verified-progressing`
  - `recently-active-unverified`
  - `long-silent-unverified`
  - `verified-waiting-provider`
  - `verified-idle`
  - `verified-held`
  - `needs-attention`
- `isCompacting` (`system` status subtype `status` + `status=compacting`)
- `status.owner` (`self` / `external` / `none`) for action availability

`terminated` is a derived/diagnostic condition for unhealthy termination; it is
shown through liveness status (`needs-attention`) and server recovery workflows
rather than as a first-class interactive state.

## Primary UI-advertised model text

In `SessionPage`, the model selector title is computed from:
`currentOwnedProcessId` + `isCompacting` + `processState`.

- no owned process → `Slash commands`
- `isCompacting` → `Compacting`
- `processState === "in-turn"` → `Thinking`
- `processState === "waiting-input"` → `Waiting for input`
- `processState === "hold"` → `On hold`
- otherwise → normal provider/model selector text (e.g. `sonnet · Thinking off`)

This text lives in `slashModelIndicatorTitle` and is passed to both:
`MessageInput` (`modelIndicatorTitle`) and `MessageInputToolbar`.

## Action matrix

| State | Safe actions | Disabled/blocked actions |
|---|---|---|
| `idle` | Send, queue, /model, queue mode, `/compact` if exposed | stop (no active turn), tool approval controls |
| `in-turn` (`status.owner="self"`) | Stop (interrupt/abort), queue/steer depending provider and queue mode, `/compact` if available | /model editing text; direct model/config change while active |
| `waiting-input` (`status.owner="self"`) | Answer prompt with approval path (`ToolApprovalPanel` or `QuestionAnswerPanel`) | regular composer send action; stop is currently off |
| `hold` | Resume/Unhold, queue text, /model (not state-advertised) | normal immediate send when active turn controls expect running progress |
| `compacting` (overlay) | same as underlying `processState` | model/config substitution text is busy copy only |
| `needs-attention` | show warning copy and retain manual controls as supported | no automatic idle assumptions |
| `verified-idle` (liveness) | treat as normal boundary for automation | should not be assumed from `recently-active-unverified` / `long-silent-unverified` |

Action gating rules:

- Process state controls primary action availability; liveness is advisory/copy.
- Only queue/steer paths are valid when active turn is in progress and there is no
  immediate send path.
- The compacting overlay never changes process-level controls; it only changes
  visible status copy.

## UI surfaces that must agree

- `SessionPage`: `slashModelIndicatorTitle`, status chip context, placeholder text,
  and `processState`-driven placeholders.
- `MessageInputToolbar`: model title + liveness chip (`sessionLiveness`).
- `MessageInput`: model title + slash command menu.
- `StatusIndicator`: hides idle/no-owner edge cases and reflects `in-turn`, `waiting-input`.
- `MessageList`: compaction banner for compaction events.
- `ProcessInfoModal`: process + liveness metadata.

## Implementation invariants

1. Use concise status text while busy to avoid implying model reconfiguration is
   safe during active work.
2. Use `verified-idle` as the only stable boundary for automation and
   completion assumptions.
3. Keep liveness-derived states visible without turning them into hard action locks.

## Queue-state consistency edge case (provider desync)

Claude and Codex sessions can report queued message state that diverges from
provider acceptance state.

- a deferred/queued row can remain marked `Queued` after provider replay already
  accepted it, or
- a sent/accepted row can remain pending when local state still shows queued.

The contract is: local queue indicators are advisory until reconciliation arrives.
A message is considered sent only when one of these confirms:

- user message echo with matching `tempId`,
- deferred-queue refresh that omits that `tempId`,
- reconnect/session snapshot showing the message in history and not in queued summary.

When this mismatch is observed, UI should preserve the queued row for recovery
actions (`cancel`, `edit`, `retry`) and mark the state as uncertain rather than
forcing silent state transitions.[^claude-queued-bug][^codex-queued-bug]

## Provider-specific capability notes

- Claude does not expose provider steering (`supportsSteering=false`), so active
  in-turn control is limited to existing stop/approval paths; queue behavior still
  works for turn-end replay.[^claude]
- OpenCode reports no slash commands or permission-mode/steering toggles in current
  provider metadata (`supportsSlashCommands=false`, `supportsPermissionMode=false`,
  `supportsSteering=false`), so state is mainly communicated through process/liveness
  signals rather than slash-driven controls.[^opencode]
- Codex can surface steering and compact-capable command flow, but still
  participates in the same process state machine and compaction non-interruptible
  UX path.[^codex][^handoff]

## Optional Provider Detail Dictionary

Providers may carry optional, provider-specific detail when it either maps cleanly
to existing renderer semantics or preserves compact signal for a later provider
UI. These fields are additive: generic session rendering must keep working when
they are absent. When the UI grows a provider-neutral renderer contract, promote
matching fields out of provider-specific namespaces instead of keeping duplicate
Grok-only paths. For example, future first-class diff/ListDir/plan renderers
should use optional provider-agnostic fields when the semantics are one-to-one;
Grok-only provenance and lossy raw structures stay under `providerDetails.grok`.

| Field / capability | Source | Current YA mapping | UI status |
|---|---|---|---|
| `tool_use.input.kind` / `title` / `status` | Grok ACP `tool_call*` | Carried on Grok tool inputs; `title`/`kind` also choose the closest YA tool name. | Generic tool row status is rendered via existing result pairing; explicit metadata expansion is not landed. |
| `tool_use.input.locations` | Grok ACP `locations[]` | Carried when present; first location can help derive `Read.file_path`. | First-class location/follow-along UI is not landed. |
| `tool_use.input.rawInput` | Grok ACP `rawInput` | Carried when useful for future inspection; normalized fields are still populated for `Read`, `Bash`, `Grep`, `Edit`, `TodoWrite`, and `Write` when one-to-one enough. | Existing renderers use normalized fields; raw expansion is not landed. |
| `tool_use.input.content` | Grok ACP update `content[]` | Carried for non-terminal tool update detail such as diff snippets or short status text. | Dedicated inline expansion is not landed. |
| `toolUseResult` normalized from Grok `rawOutput` | Grok `ReadFile`, `Bash`, `GrepSearch`, `SearchReplace`, `Todo` | Mapped to existing YA result schemas for `Read`, `Bash`, `Grep`, `Edit`, and `TodoWrite` when fields line up. | Rendered by existing tool rows. |
| Grok custom `rawOutput` fallback | Grok `rawOutput` types without a close YA schema, e.g. `ListDir` | Kept as compact provider result data rather than forcing a misleading generic tool schema. Per-update `_meta` is intentionally not carried. | Fallback JSON only; custom Grok UI is not landed. |
| `message.content[].grokPlan.entries` | Grok ACP `plan` | Plan entries are carried on a thinking block while also rendering readable `status: content` text. | Thinking text renders; structured plan UI is not landed. |
| dynamic command inventory | Grok `available_commands_update` | Live Grok `availableCommands` maps into the existing `SlashCommand[]` provider hook and `/` menu names; descriptions, argument hints, and compact `providerDetails.grok` provenance are preserved on the command objects. Persisted replay still treats command updates as capability evidence, not transcript messages. | `/` menu names are wired for live sessions. Description/hint/provenance display is not landed. |
| `SlashCommand.providerDetails.grok.source/scope/path` | Grok command `_meta` | Carries whether a command is built-in or skill-backed, plus skill scope/path when Grok reports them. `_meta.tools` is intentionally ignored as noisy tool inventory, not slash-command UI data. | API-carried only; client command menu does not yet display provenance or hints. |

When adding fields here, prefer the existing renderer schema if the semantic map
is close enough. If not, keep the Grok-specific structure compact and explicit
rather than widening a generic schema until the UI actually consumes it.

## Provider handoff verification status

- Provider-native handoff behavior has not yet been independently verified as a
  production-safe control path across provider surfaces. The current default remains
  template-driven handoff as the validated recovery baseline.

[^claude]: If a future Claude provider path adds steering, the above matrix should be
re-evaluated for `in-turn`/`waiting-input`.
[^opencode]: OpenCode tool-approval semantics are explicitly marked as experimental in
provider metadata; avoid baking policy assumptions beyond current runtime signals.
[^codex]: Codex is non-interruptible while compacting at the provider level; treat
compact progress as a terminal visual lockout for model-selector details.
[^handoff]: Provider-driven handoff has not been independently proven as an
  end-to-end baseline in this codebase; prefer explicit provider handoff validation
  before replacing scripted handoff templates.
[^codex-queued-bug]: Codex queue-state reconciliation gaps have been observed as
  visual state drift; treat queued status text as advisory and keep recovery
  actions available when stale.
[^claude-queued-bug]: Claude queue-state reconciliation gaps have been observed as
  visual state drift; treat queued status text as advisory and keep recovery
  actions available when stale.
