# Resume Compaction

> Resume compaction is YA's provider-neutral compact-before-resume
> contract for old or context-heavy sessions, preserving the same
> provider session when upstream supports it instead of silently starting
> a YA handoff.

Topic: resume-compaction

Related topics: [claude](claude.md),
[session-context-actions](session-context-actions.md),
[compact-and-handoff](compact-and-handoff.md),
[provider-refresh](provider-refresh.md),
[provider-state-machine](provider-state-machine.md),
[session-liveness](session-liveness.md),
[cost-efficiency](cost-efficiency.md),
[injected-message-visibility](injected-message-visibility.md)

## Motivation

Claude TUI exposes a useful old-session choice: resume the full long
session, or resume from a provider-created summary when the transcript is
large enough that full resume may consume substantial budget. YA currently
does not model that choice directly. In old or disconnected Claude sessions,
the user can instead see a new-session or handoff-shaped dialog even when
the desired behavior is still same-session continuation after compaction.

This concern is initiation and control. YA already has credible read/render
support once compaction boundaries exist.

## Current Ground Truth

As of 2026-06-08, checked evidence supports these starting assumptions:

- Claude transcript `compact_boundary` messages already preserve DAG
  continuity and context-usage accounting in YA's reader/render path.
- Codex app-server `compaction` / `context_compaction` items already
  normalize into the same visible system boundary.
- The shared provider interface has no explicit `compact()` method.
  Existing generic control is slash-command discovery plus sending a
  prompt such as `/compact` when the provider advertises it.
- The Claude Agent SDK documents `/compact` as a slash command, session
  resume through a provider resume id, `system` compact boundary messages,
  and failure cases when the conversation is already too full to compact.
- The user has observed at least one YA-visible compaction attempt fail with
  a "context too full" style error. That supports treating compaction as
  constrained by provider context limits, not as an unlimited external
  summarization service.
- OpenAI documents `POST /v1/responses/compact`, and Codex local protocol
  files expose compaction items, but YA's checked-in Codex adapter observes
  compaction events rather than initiating a compact RPC.

Evidence anchors:

- Claude commands: <https://code.claude.com/docs/en/commands>
- Claude Agent SDK sessions:
  <https://code.claude.com/docs/en/agent-sdk/sessions>
- Claude errors: <https://code.claude.com/docs/en/errors>
- OpenAI Responses compact:
  <https://platform.openai.com/docs/api-reference/responses/compact?api-mode=responses>

Do not infer from the Claude TUI wording or the "context too full" failure
that Anthropic uses the same model, a cheaper model, a special atomic
"resume from summary" SDK call, or a budget-free operation. Treat the
cheaper path as a user-visible cost/context tradeoff until upstream
documents a stronger claim.

## Product Contract

When a stopped provider session is old or context-heavy and the provider
can safely compact before the next user turn, YA should offer an explicit
choice:

- Full resume: keep today's semantics and ask the provider to load the
  full conversation history.
- Compact then resume: resume the same provider session, run provider
  compaction first, and submit the user's queued turn only after a compact
  boundary or equivalent success signal arrives.
- Handoff/new session: remain an explicit fallback for providers or states
  that cannot compact the same provider session safely.

The YA URL session id remains canonical. Provider-native ids may be used as
resume handles, but compact-first resume must not silently replace the
YA-visible session id in URLs, persisted metadata, REST or WebSocket
payloads, or UI copy.

Compaction is a bounded user-initiated operation. It may take minutes on a
large transcript, may spend provider budget, and may fail if the upstream
conversation is already too full. YA should show progress and preserve the
provider state-machine rules while it is running instead of presenting the
session as idle.

## Implementation Gates

Gate 0, evidence refresh: Before code changes, re-check current Claude SDK
types/docs, OpenAI compact docs, and the local Codex protocol surfaces. The
known path may have moved, and provider-refresh rules require YA-facing
assumptions to be verified against the current upstream.

Gate 1, read/render audit: Confirm existing compact boundary rendering and
history continuity still work for Claude and Codex. In particular, parse
both persisted camel-case and current SDK snake-case Claude compact metadata
if both shapes can appear in local transcripts. Keep
`local_command_output` display separate from the actual compaction boundary.

Gate 2, provider contract: Add a first-class resume mode or capability
surface before wiring UI. A conservative starting shape is a provider
capability such as `compactBeforeResume` plus a resume option like
`resumeMode: "full" | "compact-first"`. Do not add a generic `compact()`
method unless at least one provider implementation has a real callable
operation and the failure semantics are specified.

Gate 3, Claude same-session prototype: For compact-first resume, start or
resume the same Claude provider session, send the native `/compact` command
only when advertised, wait for `compact_boundary` or an equivalent compact
success status, then submit the user's turn in the same provider process.
On failure, timeout, or unsupported command, surface a controlled decision
instead of silently falling back to handoff.

Gate 4, old-session UI choice: When YA detects a stopped old or
context-heavy session and the provider supports compact-first resume, show
the user a clear choice before the next turn is attempted. Copy should say
that full resume may consume more context/budget, compact-first summarizes
older context and can fail, and handoff starts a replacement session.

Gate 5, Codex initiation probe: Treat Codex as a separate provider-specific
gate. YA currently observes Codex compaction items; initiating compaction
requires selecting an upstream mechanism, reviewing credential and cost
behavior, and adding tests around local app-server or API protocol drift.

Gate 6, rollout and verification: Keep the feature prompt-gated or
configuration-gated until Claude same-session resume, failure handling,
queue ordering, and UI state have tests. Log enough provider-phase detail
to debug slow compactions without dumping transcript content.

## Failure Posture

If provider compaction fails because the conversation is too full, offer a
full resume or explicit handoff; do not retry compaction in a loop.

That failure mode is evidence about provider constraints, not a license to
invent a separate YA-side summarizer as a silent fallback. A separate
summarizer would be a different feature with its own model, privacy, cost,
and quality contract.

If the provider does not advertise a compaction command or callable compact
surface, keep the current full-resume or handoff behavior and explain the
missing provider capability in debug surfaces.

If no client is actively requesting the resume, do not start background
compaction. A closed tab or idle provider session must not indefinitely
consume server resources.

If the provider documents a model choice for compaction, model it
explicitly. Otherwise do not silently switch to a different or allegedly
cheaper model on the user's behalf.

## Test Plan

- Provider-interface unit tests for `full` versus `compact-first` resume
  mode selection and unsupported-provider failure.
- Claude fake-provider tests where `/compact` emits compacting status,
  a compact boundary, and then accepts the queued user turn in the same
  resumed session.
- Claude failure tests for command-not-advertised, compact timeout, and
  upstream compact failure.
- Reader tests that preserve continuity and metadata for both old persisted
  and current SDK compact boundary shapes.
- Client tests for the old-session choice and busy/progress state.
- Codex regression tests proving existing compaction item normalization
  remains intact before any Codex initiation work is added.

## Live threshold trigger (task 029)

Distinct from resume-time compact-first above: a **live, in-session**
preemptive compaction, configured per model as "compact at X% of that model's
context window" (`clientDefaults.compactAtContextPercent[model]`). It reuses the
same `Supervisor.tryResumeCompaction` primitive, so it drives the **native
`compact_boundary`** (same result + render contract) and the injected `/compact`
carries no user echo (`metadata.hidden`; see
[injected-message-visibility](injected-message-visibility.md)). The route
resolves the live model's percent (it holds the settings) and threads it via
`ModelSettings.compactAtContextPercent`; the Supervisor stays settings-agnostic.
The pure decision is `crossesCompactThreshold(percent, contextWindow,
inputTokens)`; the orchestration is `Supervisor.maybeCompactBeforeDelivery`,
called from `queueMessageToSession` just before delivering a turn.

Design intent and invariants (user-confirmed 2026-06-16):

- **Voluntary, momentum-preserving.** It is a "do it when the user won't be
  bothered" compaction, not a needed one. Idle-gated: it returns immediately
  unless the process is idle, so it never interrupts an active turn.
- **Harness-enforced compaction is untouched and remains the backstop.** This
  trigger is purely *earlier and additive*; nothing about the harness's own
  auto-compaction changed. When the trigger does not fire (off, usage unknown,
  non-idle, non-claude) the enforced path behaves exactly as before. The
  voluntary threshold (e.g. opus 28% ≈ 280K of a 1M window) sits well below the
  harness's enforced point (~800K on 1M), so in steady state the two never fire
  together — the voluntary one keeps usage from ever reaching the enforced one.
- **No double compaction.** Live usage is re-read and re-tested *immediately
  before* executing — there is no deferral gap between deciding and running — so
  a prior compaction (the harness's enforced one or a previous voluntary one)
  that dropped usage below the threshold makes the next evaluation a no-op.
- **Conservative (task 002).** Claude only, idle only, only when usage is known;
  best-effort — the turn is delivered regardless of the compaction outcome, with
  no retry loop; failure is logged, never blocks the turn.

Scope boundary (v1): only fresh REST turns through `queueMessageToSession`
evaluate the trigger. Deferred-queue promotions go through `Process.queueMessage`
directly and bypass it; the next fresh turn re-evaluates. Acceptable because the
trigger is voluntary and the enforced backstop still covers the deferred path.

## Open Questions

- Does Claude TUI use only the documented slash command path, or does it
  have an additional internal resume-from-summary affordance? YA should not
  depend on an undocumented answer.
- Which signal should trigger the prompt: elapsed inactivity, transcript
  token count, provider resume failure, or a combination? The first rollout
  should prefer explicit user choice over fragile prediction.
- Should compact-first resume be available from the ordinary stopped-session
  composer, the restart/handoff dialog, or both? The provider contract
  should be decided before UI copy spreads.
