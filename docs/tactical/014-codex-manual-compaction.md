# Codex Manual Compaction

Status: Implemented (2026-06-17).

Codex `/compact` now dispatches the native app-server `thread/compact/start`
RPC out-of-band via `Process.runProviderCommand` / the Codex provider's
`runProviderCommand` handler, instead of being delivered as `turn/start` text.
Claude's `/compact` continues to flow as an ordinary turn (the provider reports
`handled: false`), and now forwards trailing focus instructions verbatim. Codex
compaction takes no instructions, so any `/compact <text>` argument is dropped
server-side. See the protocol subset in
`packages/server/src/sdk/providers/codex-protocol/` (`ThreadCompactStart*`).

## Context

YA currently shows manual compaction only when the active owned process
advertises a `compact` slash command. Claude reaches that path through its
provider slash-command inventory. Codex does not: the YA Codex provider
currently advertises only the YA `goal` command, even though Codex app-server
has a native manual compaction RPC.

Evidence checked on 2026-06-13:

- Installed `codex-cli 0.137.0` generated app-server TypeScript that includes
  `thread/compact/start`, `ThreadCompactStartParams`, and
  `ThreadCompactStartResponse`.
- `~/code/reference/codex` at `e846fed2` documents `thread/compact/start` in
  `codex-rs/app-server/README.md` and implements it by submitting
  `Op::Compact`.
- Codex TUI exposes `/compact` as a built-in slash command and routes it to
  app-server `thread/compact/start`.
- YA's checked-in Codex protocol subset currently has `contextCompaction`
  rendering types and `NonSteerableTurnKind = "compact"`, but not
  `ThreadCompactStart*` request types.

The right YA behavior is therefore not to pass `/compact` as ordinary
`turn/start` text. It should treat `/compact` as a provider-native command for
Codex and call app-server `thread/compact/start` with the active `threadId`.

## Goals

- Expose an explicit manual `Compact` action for Codex where the current
  app-server supports `thread/compact/start`.
- Make `/compact` in the slash menu and session menu trigger the native Codex
  compaction RPC.
- Reuse YA's existing Codex compaction status/rendering path for
  `contextCompaction` started/completed items.
- Keep manual compaction discoverable and deliberate. Do not reintroduce hidden
  compaction from the passive context-usage indicator.
- Preserve Claude's existing manual compact behavior.

## Non-Goals

- Do not emulate Codex compaction by sending `/compact` as user text.
- Do not add free-form compact instructions for Codex unless upstream
  documents an argument surface for app-server compaction.
- Do not change Codex automatic compaction policy in this slice.
- Do not make compaction available for `codex-oss`, OpenCode, Gemini, or ACP
  providers unless those providers expose an equivalent native command.
- Do not broadly regenerate or consume unrelated app-server protocol surfaces
  beyond the small subset needed for this command.

## Implementation Shape

1. Update the checked-in Codex app-server protocol subset to include:
   - `ThreadCompactStartParams`
   - `ThreadCompactStartResponse`
   - the `thread/compact/start` request type if the local request union is
     imported into YA for typing.
2. Add a Codex provider command entry for `compact`, but model it as a native
   provider action rather than emulated provider text.
3. Extend the provider/process command handling path so a slash command can be
   handled out-of-band before normal message delivery. The Codex handler should:
   - require an active `CodexAppServerClient`;
   - require a known `runtimeState.threadId`;
   - call `activeClient.request("thread/compact/start", { threadId })`;
   - report a queue/send failure if the app-server rejects the request.
4. Ensure `Process.expandEmulatedSlashCommand` treats Codex `compact` as native
   so a typed `/compact` is not rewritten to `@compact`.
5. Keep the existing `SessionPage` manual compact gate:
   `status.owner === "self" && slashCommands.includes("compact")`.
   Once Codex advertises `compact`, the current session menu and slash menu can
   use the same `handleCompactSession` entry point.
6. Verify that Codex compaction progress still arrives through the existing
   event normalization path:
   - `context_compaction` or `contextCompaction` maps to `status=compacting`
     while running;
   - completion maps to `compact_boundary` / "Context compacted".

## Risk And Edge Cases

- Older Codex app-server builds may not support `thread/compact/start`.
  Feature-gate by probing generated protocol availability at build time and by
  surfacing app-server rejection as a failed compact request at runtime.
- Codex compact turns are non-steerable. Existing active-turn handling should
  continue to show compaction as busy work and should not claim that same-turn
  steering was accepted during compaction.
- A process may have no `threadId` yet, especially before the first successful
  start/resume response. In that state, do not advertise or accept Codex manual
  compact.
- `/compact anything` should probably be rejected or treated as `/compact`
  with a clear warning until Codex documents instruction arguments for
  `thread/compact/start`.
- If the native request returns immediately but no progress event follows,
  liveness/status should remain governed by the normal Codex turn lifecycle
  signals rather than inventing a YA-only spinner timeout.

## Test Plan

- Provider unit test: Codex `supportedCommands()` includes `compact` only when
  the provider can issue `thread/compact/start`.
- Provider unit test: queued `/compact` calls `thread/compact/start` with the
  active `threadId` and does not call `turn/start`.
- Provider unit test: `/compact extra text` is rejected or handled according to
  the chosen argument policy.
- Server route test: session message POST for Codex `/compact` reports success
  when the native command is accepted and an error when the provider rejects it.
- Client component/regression test: Codex manual compact appears in the session
  menu/slash menu only when `compact` is advertised.
- Existing compaction rendering tests should continue to cover the
  `status=compacting` and compact-boundary display path.

## Follow-Up

- Update `topics/session-context-actions.md` after implementation so the
  Codex section distinguishes "native app-server compact endpoint" from
  slash-command text delivery.
- Consider using the same native-command hook for future provider commands
  that are not ordinary user turns, such as fork/rollback/review mode, if they
  become productized in YA.
