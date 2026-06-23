# Session Context Actions

> How long provider session context survives, how it is recovered after
> inactivity, and the capability ground truth for a richer session action
> set — clear, fork, handoff (including synthetic-turn replay), and
> user-initiated compaction — per provider.

Topic: session-context-actions

Related topics: [provider-context-economics](provider-context-economics.md),
[forged-transcript-handoff](forged-transcript-handoff.md),
[resume-compaction](resume-compaction.md),
[compact-and-handoff](compact-and-handoff.md),
[provider-state-machine](provider-state-machine.md),
[session-liveness](session-liveness.md),
[session-reactivation](session-reactivation.md) — planned message-less
reactivate (spawn an idle live process with no turn),
[session-ui-customization](session-ui-customization.md),
[recaps](recaps.md),
[fork-from-turn](fork-from-turn.md) — per-turn fork / fork-after-summary, which
revises the handoff decision below

## Context lifetime and recovery after inactivity

Nothing semantically owned by the conversation is discarded by
inactivity; what dies is the *process* and the *cache warmth*.

- YA reaps an idle provider process after `IDLE_TIMEOUT` seconds
  (default 60 minutes, matching the prompt-cache window;
  `DEFAULT_IDLE_TIMEOUT_MS`/`DEFAULT_IDLE_TIMEOUT_SECONDS` in
  `packages/server/src/defaults.ts`, env parsing in `config.ts`). The
  supervisor `Process` tracks this as an intentional idle reap, distinct
  from a crash.
- The transcript persists on disk independently of the process: Claude
  writes jsonl under `{CLAUDE_CONFIG_DIR}/projects/`, Codex writes
  rollout files under its own sessions dir. These survive server
  restarts and host reboots; there is no provider-side expiry we have
  observed for local CLI transcripts.
- Recovery is resume-by-provider-session-id: the provider process is
  relaunched with `resume` and reconstructs its context by replaying
  the transcript. The user-visible costs are (a) startup latency and
  (b) a cold prompt cache — Anthropic's ephemeral cache has a ~5-minute
  TTL, so resuming a long-idle session reprocesses the full input at
  uncached prices. That cost asymmetry is the whole motivation for
  [resume-compaction](resume-compaction.md): offer compact-first resume
  instead of full replay for old or context-heavy sessions.
- Claude edge case: a session whose latest assistant message is a
  recorded API error is treated as not safely resumable
  (`handoff-required` in `packages/server/src/routes/sessions.ts`); the
  validated recovery there is the template handoff.

In-memory-only state (deferred queue contents, per-process status) is
the one thing a reap or server restart can lose ahead of the
transcript; the restart-handoff path explicitly folds still-queued user
turns into the handoff text for this reason
(`getRestartQueuedMessages`).

## Clear

What Claude Code's `/clear` actually does, per the Agent SDK surface
(verified against the vendored `@anthropic-ai/claude-agent-sdk` 0.3.170
`sdk.d.ts`): it starts a fresh conversation and fires `SessionStart`
with `source: 'clear'` (the sources are
`'startup' | 'resume' | 'clear' | 'compact'`). The system prompt,
CLAUDE.md, and SessionStart hook context are re-injected — but that
injection is *mechanical harness work*, not agent work. `/clear` does
**not** preserve any agent-performed warm-up (file reads, derived
understanding); there is no "bare agent read state" snapshot to fork
back to. So a YA "clear" action is honestly equivalent to "new session,
same project/provider/model" — the convenience is staying in place in
the UI, not saved tokens.

If the goal is to keep warm-up work without the rest of the
conversation, that is not clear, it is **fork at a point** (below):
fork/resume up to the message UUID just after the agent finished its
initial reads.

Decision (2026-06-11): YA's clear should be implemented as
fork-up-to-a-point where the provider supports real prefix fork
(Claude today), with plain new-session as the fallback elsewhere; and
the general form is a per-turn "fork from here" (rewind-and-continue)
control, shown only where no full-replay emulation would be hidden
behind it. Cost semantics in
[provider-context-economics](provider-context-economics.md).

UI placement: a `Clear` entry in the session kebab menu
(`SessionMenu.tsx`, next to star/archive), not a bottom-bar control —
the composer bar is contested space and kzahel has disabled speculative
session-UI controls before; see
[session-ui-customization](session-ui-customization.md) and
`topics/kzahel-disabled.md`. Implementation is provider-neutral: create
a new session with the same project/provider/model and navigate to it.

## Fork

Claude is the only provider with a first-class fork surface today.
Verified in SDK 0.3.170 `sdk.d.ts` (none of these are used by YA yet):

- `forkSession(sessionId, { upToMessageId?, title? })` — copies the
  transcript into a new session file with remapped UUIDs and a
  preserved parent chain; `upToMessageId` slices the copy at a chosen
  message (inclusive). Returns a new session id resumable via
  `query({ options: { resume } })`. Forks drop undo/file-history
  snapshots.
- `query` options `resume` + `forkSession: true` — resume-as-fork
  (continue from an old session under a new id, leaving the original
  intact).
- `resumeSessionAt: <message uuid>` — resume the same session but only
  up to a given message; the branch-from-a-point primitive without
  creating a separate file first.

Other providers: Codex has no documented fork primitive; copying a
rollout file under a new id is plausible but unverified. ACP providers
(gemini-acp, grok-acp) and opencode hold session state provider-side
with no exposed branch surface. A YA fork action should therefore ship
as a Claude-capability-gated feature (a provider capability flag, same
pattern as compact support), not a generic session action.

## Handoff and synthetic-turn replay

Current validated mechanism: the scripted template handoff
(`buildRestartHandoff` in `packages/server/src/routes/sessions.ts`) —
one bounded user message carrying source-session metadata, recent
transcript, any compact summary, and still-queued turns. The originally
planned agent-summarization hook was dropped at first: the template plus
the source session id was enough, because agents look up the named
session when they need more. `RestartSessionModal` already lets the
user pick a different target provider/model, so "handoff to other
agent" exists today via restart-handoff.

Revised (2026-06-23): agent summarization returns as an explicit
opt-in, not the default. [fork-from-turn](fork-from-turn.md) builds a
working LLM-summary facility (the generalized recap/summary path), and
the same summary-instruction control is offered both by fork-after-summary
and on standard handoff. The default stays template + source-session-id;
the generated summary is opt-in. The earlier "dropped" posture held only
while no working summary path existed — it is superseded now that one is
committed to build.

The unexplored alternative — replaying selected or synthetic
user/assistant turns as real context rather than quoting them inside
one user message — splits by provider:

- **Claude, selected real turns**: fully supported and low-risk via
  `forkSession({ upToMessageId })` / `resumeSessionAt`. This covers
  most of the value ("hand the new agent the conversation up to here")
  without forging anything. It cannot *drop interior turns* — the slice
  is a prefix, not an arbitrary selection.
- **Claude, synthetic turns**: the transcript is plain jsonl that the
  SDK replays on resume, so writing a fabricated session file and
  resuming it is possible in principle. Unverified, and fragile: the
  uuid/parentUuid chain and message schema are provider-versioned
  internals (our own Zod schemas in `packages/shared` chase them), and
  drift breaks silently. One API-level constraint to know: mid-history
  assistant turns are ordinary and fine, but a *trailing* assistant
  prefill 400s on current models, so a forged transcript must end on a
  user/tool turn.
- **Codex**: rollout files are similarly on disk; same in-principle
  forgery, same unverified/fragile status, no fork primitive.
- **ACP providers and opencode**: no injection surface — context can
  only enter as real user messages, so the template handoff is the
  ceiling there.

Assessment: prefer fork-slice (Claude) and template handoff
(everywhere) as the supported paths; treat forged synthetic transcripts
as an experiment requiring its own validation gate, not a feature
foundation.

## User-initiated compaction

Manual compaction is available wherever the provider advertises a
compact slash command; YA already has the machinery:

- The Supervisor's compact-first resume (`ResumeMode =
  "full" | "compact-first"`, `Supervisor.ts`) discovers an advertised
  `compact`/`compress` slash command, queues it, and waits for the
  compact boundary before submitting the user turn.
- Claude (`supportsSlashCommands = true`) documents `/compact
  [instructions]` — the optional free-text instructions are the only
  "aggressiveness" knob: a focus directive ("keep only the auth-bug
  work"), not a numeric shrink level. Compaction can fail when the
  conversation is already too full; see the failure posture in
  [resume-compaction](resume-compaction.md).
- Codex advertises `/compact` (no instruction argument observed); the
  targeted auto-compact guard for `gpt-5.3-codex-spark` is documented
  in [compact-and-handoff](compact-and-handoff.md). Codex compaction is
  non-interruptible while running.
- Gemini CLI has `/compress`, but YA's gemini adapters set
  `supportsSlashCommands = false`, so no YA path today. opencode and
  codex-oss likewise expose no compact command through YA.
- Raw-API compaction exists (Anthropic `compact-2026-01-12` beta with
  compaction blocks; OpenAI `POST /v1/responses/compact`) but YA wraps
  CLIs and does not call these directly; they matter only if a future
  API-direct provider lands.

A "Compact now" session action would be thin: send the advertised
compact command on an idle process, show the `Compacting` busy state
per [provider-state-machine](provider-state-machine.md), and surface
failure without retry loops.

## Proposed action set (design sketch, not yet built)

Session kebab menu, capability-gated per provider, hidden or
configurable per [session-ui-customization](session-ui-customization.md):

| Action | Mechanism | Providers |
|---|---|---|
| Clear | New session, same project/provider/model; navigate | all |
| Fork | `forkSession` / `resumeSessionAt` at a chosen message | claude |
| Handoff to agent | Existing restart-handoff with provider/model picker | all |
| Compact now | Queue advertised compact command; busy state | claude, codex |

Open questions: where fork's "choose a point" lives in the transcript
UI; whether clear should offer "keep a recap" (see
[recaps](recaps.md)); whether compact-now belongs in the same menu or
near the context-usage indicator.

Decision (2026-06-12): do not make the context-usage indicator itself
send `/compact`. Accidental clicks can mutate an existing session, and
the indicator is expected to be passive status chrome. Keep compaction
behind explicit slash-command/session-menu paths unless a future design
adds a clearly named, deliberate control.
