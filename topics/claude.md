# Claude Provider Control

This topic covers YA's Claude-specific control surface: which Claude
sessions YA can actively configure, and which sessions it can only observe
through provider transcript files.

Related topics: [session liveness and queue intent](session-liveness.md),
[emulated slash commands](emulated-slash-commands.md).

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
- Replacement-session model choice is separate from mid-session model
  switching. A handoff/restart flow may choose the model for the replacement
  process even when the source session was external or no longer owned by YA.
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

## Invariants

- Client model-switch UI should require `ownership.owner === "self"` and a
  live YA process id.
- Server model-listing and model-switch routes should operate on active
  process ids, not on session ids alone.
- Claude transcript discovery should not imply control authority. A readable
  session file proves history exists; it does not prove YA can steer,
  interrupt, switch model, change thinking, or inspect live SDK commands.

## Representative Change Types

- Changing Claude session ownership detection or external TUI tracking.
- Moving `/model` or model-switch UI entry points between self-owned,
  external, and stopped sessions.
- Changing Claude SDK process creation, resume, or restart/handoff behavior.
- Adding a provider-side bridge that can control an already-running external
  Claude process.

## Tests That Should Fail On Contract Regressions

- An external/TUI-owned Claude session does not expose the `/model` command or
  model-switch modal from the main session composer.
- A model-switch API call without a live YA process id fails instead of trying
  to infer control from the session transcript.
- After YA resumes or restarts a Claude session into a YA-owned process, model
  controls are evaluated from that new process's advertised capabilities.
