# Provider Context Economics

> How conversation context actually flows and bills through providers —
> stateless replay, prompt-cache prefix semantics and TTL, what resume,
> fork, clear, and compaction each cost — and the UI rule that no session
> action may hide a full-replay price.

Topic: provider-context-economics

Related topics: [session-context-actions](session-context-actions.md),
[resume-compaction](resume-compaction.md),
[cost-efficiency](cost-efficiency.md),
[prompt-cache-keepalive](prompt-cache-keepalive.md),
[forged-transcript-handoff](forged-transcript-handoff.md)

## The model: stateless API + transcript replay

No provider keeps conversation state on the inference side between
turns. Every turn re-sends the rendered prefix (system prompt, injected
instruction files, all prior turns) and the provider re-processes it.
What makes long sessions affordable is the *prompt cache*: a
prefix-keyed cache of processed input.

Anthropic semantics (the best documented; OpenAI's automatic caching is
analogous with provider-set lifetimes):

- The cache key is the exact bytes of the rendered prefix up to a cache
  breakpoint. Any byte change earlier in the prefix invalidates
  everything after it. UUIDs, jsonl metadata, and message ids are *not*
  part of the rendered prompt — only rendered content bytes matter.
- Default TTL is 5 minutes, refreshed on use; a 1-hour TTL exists at a
  higher write premium (whether a given CLI uses it is per-tool and not
  something we have verified). Cache reads bill ~0.1x input price;
  writes ~1.25x (5m) / ~2x (1h).
- On subscription plans (Claude Pro/Max via the CLI) this is quota
  consumption rather than dollars, but the accounting is the same.

## What each operation costs

- **Continuing within TTL**: prefix is a cache read (~0.1x); only the
  new turn is full-price. The cheap steady state.
- **Resume after a gap > TTL** ("cold resume"): the next turn
  re-processes the entire prefix at full input price (plus the cache
  re-write premium), then the session is warm again. Key intuitions:
  the cost is *flat in gap length* — 10 minutes and 10 hours cost the
  same — and it is paid *once per cold gap*, not per subsequent turn.
  For a near-window transcript this single replay is the dominant cost
  of an old-session resume, which is the entire motivation for
  [resume-compaction](resume-compaction.md).
- **Clear (Claude TUI `/clear`)**: discards the conversation; bootup
  context (system prompt, CLAUDE.md, hook output) is re-injected
  mechanically and re-processed from scratch — usually small. Any
  agent-performed warm-up (file reads, derived state) is gone and the
  agent will redo it on demand.
- **Fork at a point** (Agent SDK `forkSession({upToMessageId})` /
  `resumeSessionAt`): the kept prefix is byte-identical to the source
  session's rendered prefix, so if the source was used within the TTL
  the fork's first turn is a cache read. A cold fork costs the same as
  a cold resume of the kept prefix. Fork never costs *more* than full
  resume; it strictly drops paid-for tail tokens.
- **Compaction**: one expensive summarization turn over the full
  context now, in exchange for a much smaller prefix afterwards. Can
  fail when the conversation is already too full; non-interruptible on
  Codex.
- **Template handoff**: a new session whose first turn carries a big
  quoted transcript — full price on that synthetic prefix, no cache
  inheritance (different bytes), but typically far smaller than the
  source context.

## OpenAI / Codex / others

Codex resume replays its rollout file through the Responses API, but YA's
active `codex` backend delegates to Codex app-server / CLI rather than calling
the OpenAI API directly. OpenAI API prompt caching now has documented
retention policies: the shorter-lived retained prefix generally lasts 5-10
minutes of inactivity and at most one hour, while extended retention on
supported models can keep cached prefixes up to 24 hours. The checked-in Codex
app-server protocol subset exposes cached-token accounting but no retention
override, so normal YA Codex sessions should treat TTL as provider-owned unless
a future protocol refresh proves otherwise.

Same shape: cold resume = one full-price prefix replay. ACP providers
(gemini-acp, grok-acp) and opencode hold session state behind their own
protocols; we cannot see or control their cache behavior, only observe
latency/usage.

## UI rule: no hidden costly ops

A session action must not silently imply a full uncached replay or an
emulated fallback that differs in kind from what the button names:

- Show fork/rewind controls only where the provider has a real
  prefix-fork primitive (Claude today). Do not emulate fork via
  template handoff behind a button named "fork".
- Cache warmth is not knowable client-side; where an action's price
  depends on it, state the rule ("re-reads context at standard price if
  idle longer than the cache window") instead of guessing or hiding.
- Compact and handoff actions should name their cost shape in copy
  (one summarization turn now / new session with quoted context),
  consistent with the Gate 4 copy requirements in
  [resume-compaction](resume-compaction.md).
- Keepalive-style cache warming must follow
  [prompt-cache-keepalive](prompt-cache-keepalive.md): explicit,
  client-owned, bounded, and never a hidden transcript turn or abandoned
  server cron.
