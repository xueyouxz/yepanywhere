# Claude Provider Control

> YA's Claude-specific control surface distinguishes sessions YA can actively
> configure from sessions it can only observe through provider transcript files.

Topic: claude

Related topics: [session liveness and queue intent](session-liveness.md),
[emulated slash commands](emulated-slash-commands.md),
[provider refresh](provider-refresh.md),
[provider state machine](provider-state-machine.md), and
[thinking configurability](claude-thinking-config.md).

## Contracts

- In-session Claude model switching is a YA-owned-process capability, not a
  property of a Claude JSONL transcript. YA can switch a live Claude model only
  when it owns the active provider process and has the SDK `Query` control
  handle that exposes `setModel`. <!-- verified: SHA 9254832 -->
- TUI-started Claude sessions are external ownership from YA's perspective.
  YA may read and render their transcript, but it must not present in-YA
  mid-session model selection while the TUI owns the live process, because YA
  has no SDK process id or control handle to reconfigure. <!-- verified: SHA 9254832 -->
- Resuming or restarting a Claude session from YA creates a new YA-owned
  process for that session path. From that point, model controls may be
  available according to the new process capabilities; this is different from
  controlling the still-running external TUI process.
- A YA-owned Claude session normally has no YA-owned process after a full YA
  server restart. That owner loss is not by itself a handoff condition. If the
  persisted Claude transcript tail is safe to resume, a normal resume should
  start a new YA-owned SDK process with the same Claude session id. Handoff is
  reserved for an explicit unsafe-resume condition or for a user-requested
  replacement session.
- Replacement-session model choice is separate from mid-session model
  switching. A handoff/restart flow may choose the model for the replacement
  process even when the source session was external or no longer owned by YA.
- Claude SDK API-error assistant rows are transcript artifacts, not confirmed
  Anthropic `/v1/messages` responses. If the latest assistant response on the
  active branch is an SDK API-error row, YA must not normal-resume that Claude
  session; use the handoff/restart path so the next provider turn starts from a
  bounded prompt instead of a potentially synthetic `previous_message_id`.
- Claude `/goal` is exposed as a YA-side alias for `/loop wish ...`. YA injects
  the `goal` entry into the visible slash-command inventory only when the SDK
  inventory reports `/loop` and does not already report `/goal` itself. The
  inserted entry carries `emulation.providerText = "/loop wish {{argument}}"`,
  declaring that YA will substitute the user-supplied argument and send the
  expanded provider-text — not the literal `/goal ...` — when the user submits.
  If the SDK begins reporting `/goal` natively, the YA alias must step aside so
  the native command (and its arguments) reach Claude unaltered.
- Non-Claude providers should not get a YA-emulated `/goal` from this path.
  They should show goal-like slash commands only when their provider command
  inventory or another provider-native capability reports native support, or
  when a provider-specific emulation rule (separate from the Claude/`loop`
  alias here) is added.
- Live Claude activity must not depend on the original browser tab being the
  only observer. A later YA view of the same YA-owned process should receive
  enough replay, catch-up, durable transcript refresh, and liveness metadata to
  show the interesting agent text, tool runs, task/progress updates, and turn
  boundaries that an already-open tab saw.
- Local YA-owned Claude provider processes should make the canonical session id
  visible to later Bash tool shells as `AGENTCTL_SESSION_ID` once the SDK init
  message reports it. This is a child-shell `BASH_ENV` bridge for `agentctl`
  active-session upkeep, not an attempt to mutate the already-running Claude
  process environment; resume sessions may seed the id before startup, while
  remote dynamic injection needs a separate remote-side design.
- Claude SDK/API package refreshes are source refreshes when they add message
  types, control methods, transcript fields, model/command metadata, or resume
  behavior that YA consumes. Unknown SDK message types may be temporarily
  passed through for forward compatibility, but they must not become silent
  data loss or invisible state-machine drift.
- Claude provider-native interviews are `AskUserQuestion` tool calls surfaced
  through the SDK `canUseTool` path, not ordinary approval prompts and not a
  distinct session-state mode. YA must classify them as pending user questions,
  bypass approval allow/deny permission rules for that tool name, render the
  question/options/free-form "Other" UI, and answer by returning the SDK result
  with the original input plus an `answers` map. Single-select answers are
  strings; multi-select answers are string arrays. A completed interview can
  resume into another `AskUserQuestion`, which should reuse the normal
  waiting-input lifecycle instead of needing a special chained-interview state.

## Transcript Structure: Forest, Connector Rows, Dead Segments

Claude JSONL transcripts are a single-parent branching forest: `parentUuid`
is the only link type, each row has at most one parent, and a parent may
have several children (forks). No multi-parent rows have been observed;
code and docs that say "DAG" mean this forest (see the header comments in
`packages/server/src/sessions/dag.ts` and `packages/shared/src/dag.ts`).

Conversation rows routinely chain THROUGH non-conversation connector rows.
Observed connector types: `attachment` rows (CLI-injected context such as
`date_change` notices and file mentions — in observed sessions every
assistant turn descends from one) and `system` rows (e.g. `api_error`
retry bookkeeping). Any layer that drops connector rows breaks the parent
chain of everything after them.

"Dead segments" (branches with no descendants) arise two ways:

1. **Genuinely abandoned content** — rewind/fork/double-escape flows where
   the user deliberately branched away. Hiding these is correct.
2. **Falsely-dead live conversation** — CLI bookkeeping mis-parents the
   next turn. Verified instance (session `c5b32eda`, 2026-06-10): an API
   call failed (Cloudflare 502); the CLI created an `api_error` system row
   in memory with parent = the leaf at error time (an attachment row,
   since no assistant output existed yet) but did not write it. The retry
   succeeded and the full turn output was appended, chaining normally from
   that attachment row. At the NEXT user turn, the CLI flushed the
   buffered `api_error` row (error-time timestamp, so it appears
   out-of-order in the file) and parented the new user row to it — not to
   the real conversation tip. The entire successful retry output became
   graph-dead even though the user read it and the in-process model
   context contained it. This is provider-side behavior YA can only
   observe and render sanely.

Rendering contract for both cases: the server selects the active tip
timestamp-first (`buildDag`), re-includes dead branches containing
completed tool work as sibling branches in file order
(`collectVisibleClaudeEntries`), and the client's `orderByParentChain`
is stable/minimal-motion so missing connector rows can never relocate a
segment (a row moves only when its parent is present later in the same
array).

Open question (unverified, provider-side): whether `claude --resume`
rebuilds model context by walking `parentUuid` from the chosen tip. If it
does, a falsely-dead segment — the assistant's own completed work — would
be silently absent from the resumed context; the predicted symptom would
be a resumed session unaware of work it visibly completed before the
resume. No such report exists yet; this is a prediction to test, not an
observed failure. Adjacent to the existing API-error unsafe-resume
contract above.

## Current Problem Areas

Observed user reports:

- YA-owned Claude sessions can stop showing useful activity after more than a
  few turns of autonomous work, while `claude --resume <id>` later reveals that
  substantial work completed. In one observed case, the still-open original YA
  window displayed the interesting turn text and tool runs as work proceeded in
  a Claude TUI resume, but another YA view repeatedly looked stalled.
- After a full YA restart, sessions that were previously YA-owned often enter
  the handoff UI instead of normal Claude resume. After restart there is
  necessarily no old YA-owned process, but that should not make the transcript
  unresumable.

Suspected contributing areas to check before declaring this fixed:

- **Live replay and catch-up:** `Process` keeps only a short two-bucket replay
  window and intentionally excludes `stream_event` messages. Catch-up currently
  reconstructs accumulated assistant text, not the full newer Claude activity
  surface such as thinking deltas, task progress, tool progress, session state,
  prompt suggestions, permission denials, rate-limit notices, or mirror errors.
- **SDK message coverage:** the installed Claude SDK's `SDKMessage` union
  includes many messages beyond the historical `user`/`assistant`/`result`/
  `system status` surface. YA's live pass-through and durable
  `claude-sdk-schema` coverage must be audited together so unknown entries do
  not disappear from history, fail parsing, or leave the UI without a renderer.
- **State-machine intake:** Claude SDK now exposes `session_state_changed`
  (`running`, `requires_action`, `idle`) and other control/status messages.
  YA should decide whether those are stronger turn-boundary evidence than the
  older `result`/iterator-done path, and must not leave a process stuck
  `in-turn` or prematurely idle when the SDK has reported a clearer state.
- **Claude interview forms:** Claude's known `AskUserQuestion` path is now
  surfaced as actionable waiting-input UI with cancel, single-select,
  multi-select, and free-form "Other" answer paths. Claude SDK
  `requires_action` is liveness/state evidence, not proof that an interview
  prompt exists without a matching `AskUserQuestion` control request.
- **DAG and progress parenting:** durable Claude progress messages can affect
  `parentUuid` chains; the reader already has progress-aware DAG logic, but the
  live stream, incremental refresh, and resume-safety checks must use matching
  assumptions.
- **Subscriber failure visibility:** `Process.emit()` catches listener errors
  without logging. That protects peers, but it can hide a broken session
  subscriber or augmentation path that only affects some tabs.
- **Resume blocker scope:** the API-error active-branch guard is intentional,
  but normal "no owner after restart" and "external/TUI process owns this
  session" conditions should remain distinct from "unsafe to resume this
  transcript with Claude SDK".

## Invariants

- Client model-switch UI should require `ownership.owner === "self"` and a
  live YA process id.
- Server model-listing and model-switch routes should operate on active
  process ids, not on session ids alone.
- Claude transcript discovery should not imply control authority. A readable
  session file proves history exists; it does not prove YA can steer,
  interrupt, switch model, change thinking, or inspect live SDK commands.
- Claude transcript discovery does prove enough to attempt normal resume when
  the provider, project, and resume id are known and no explicit unsafe-resume
  blocker applies.
- Claude multiple-choice/cancel/free-form prompts must be observable as pending
  user input with enough metadata for YA to answer them through the SDK control
  path; hiding them in raw TUI/session state is a liveness bug.
- `AskUserQuestion` must not be auto-allowed or auto-denied by permission mode
  or explicit permission rules. Its `toolName` is the provider interview
  discriminator; the UI may show the one to four questions from one call in any
  ergonomic layout, and repeated calls after an answer are just repeated
  pending-input requests.
- Unknown Claude SDK messages must be observable during refresh work: either
  normalized/rendered, deliberately ignored with a documented reason, or logged
  as unsupported drift. A catch-all pass-through is not sufficient when the
  message carries user-visible activity or state.

## Representative Change Types

- Changing Claude session ownership detection or external TUI tracking.
- Moving `/model` or model-switch UI entry points between self-owned,
  external, and stopped sessions.
- Changing Claude SDK process creation, resume, or restart/handoff behavior.
- Adding a provider-side bridge that can control an already-running external
  Claude process.
- Changing Claude live message normalization, `Process` replay/catch-up
  behavior, or durable Claude transcript schemas.
- Changing the handoff-required decision, especially after YA restart or after
  a Claude SDK API-error transcript artifact.
- Refreshing `@anthropic-ai/claude-agent-sdk` in a way that changes message
  types, resume behavior, model/command catalog shape, or control methods.

## Tests That Should Fail On Contract Regressions

- An external/TUI-owned Claude session does not expose the `/model` command or
  model-switch modal from the main session composer.
- A model-switch API call without a live YA process id fails instead of trying
  to infer control from the session transcript.
- After YA resumes or restarts a Claude session into a YA-owned process, model
  controls are evaluated from that new process's advertised capabilities.
- A Claude session whose active-branch tail is an SDK API-error assistant row
  returns handoff-required from normal resume instead of passing the transcript
  back to the Claude SDK.
- A Claude session that was YA-owned before a YA server restart can be normally
  resumed from its persisted session id when its active-branch tail is safe.
- A newly attached YA view of an active Claude process receives recent
  user-visible activity and a truthful liveness/status state even when the
  original tab saw the live events earlier.
- Claude SDK message types that are user-visible or state-bearing have focused
  normalization or rendering coverage, and unsupported message types are not
  silently treated as proof of inactivity.
- `AskUserQuestion` produces a `question` input request, appears to activity
  consumers as `user-question`, carries single- and multi-select answers back
  through `updatedInput`, and ignores permission rules that would otherwise
  allow or deny the tool.
