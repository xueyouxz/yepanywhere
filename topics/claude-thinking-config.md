# Claude Thinking Configurability

> YA maps its thinking/effort toggle to the Claude Agent SDK as adaptive
> thinking plus an effort level, and never emits a fixed token budget.
> Several thinking- and cost-control knobs the installed Agent SDK
> already exposes are not yet surfaced; this note records them and a
> staged proposal to widen YA's control surface.

Topic: claude-thinking-config

Related topics: [claude provider control](claude.md),
[cost efficiency](cost-efficiency.md),
[provider refresh](provider-refresh.md).

## Current state (verified against installed SDK, 2026-06-07)

- `thinkingOptionToConfig` (`packages/shared/src/types.ts`) is the **sole**
  constructor of a `ThinkingConfig`. Every thinking-enabled option
  resolves to `{ type: "adaptive", display: "summarized" }`: `"auto"` →
  adaptive summarized; `"on:<effort>"` → adaptive summarized + effort; a
  plain `EffortLevel` → adaptive summarized + effort. Only `"off"` →
  `disabled`.
- The `{ type: "enabled"; budgetTokens }` union member exists but is
  **never emitted** — the in-code comment notes it "crashes the CLI" on
  Opus 4.6+ (it is the older-model fixed-budget form). Adaptive is the
  only enabled path, which is the correct behavior on current Opus.
- The Claude provider passes the result straight to the Agent SDK query —
  `thinking: options.thinking`, `effort: options.effort`
  (`packages/server/src/sdk/providers/claude.ts`). No remap to a budget.
- `setMaxThinkingTokens(tokens)` is wired as a Query control in the
  provider bridge (`claude.ts`, near the `Query` control handle), but it
  is a runtime SDK method, not a surfaced user control. On adaptive
  Opus 4.6+ a fixed thinking-token budget is the *older* path, so this
  may be a no-op there — verify before exposing it as a live control.

## SDK-exposed but not surfaced by YA

Grounded in `@anthropic-ai/claude-agent-sdk` `sdk.d.ts` (these are
source-refresh-sensitive — pin and re-read the version when acting, per
[claude provider control](claude.md) on SDK refreshes):

- **`taskBudget?: { total: number }`** (query Options) — sent as
  `output_config.task_budget` (beta `task-budgets-2026-03-13`, marked
  `@alpha` in the typings). A per-run token countdown the model is *made
  aware of* and paces against, distinct from a hard cap. This is the
  highest-value add: it is the API-native lever for bounding a long
  autonomous run by token/latency/quota, which is exactly the
  [cost efficiency](cost-efficiency.md) concern.
- **`maxBudgetUsd?: number`** (query Options) — a USD spend cap. Directly
  serves the cost-efficiency mandate; not surfaced. Verify hard-stop vs.
  advisory semantics before exposing.
- **Integer `effort`** — `effort` accepts a number as well as the named
  levels (`low|medium|high|xhigh|max`); YA's `EffortLevel` is named-only.
  Probably keep named for the UI, but the finer dial exists.
- **Per-model capability flags** — model metadata carries
  `supportsAdaptiveThinking` (YA already reads `supportsEffort`). The
  toggle/effort UI could be gated per selected model rather than a fixed
  `supportsThinkingToggle = true`.

## Showing thinking text — request side and render side

This was the "I have never once seen Claude thinking in YA" issue. Two
layers are involved:

- **Layer A — request `display: 'summarized'`.** On Opus 4.7/4.8 thinking
  text is *omitted by provider default* — the API streams only pings
  during a redacted-thinking phase, so there is no reasoning text to
  show. The opt-in is `display: 'summarized'`, and it **is** reachable:
  `ThinkingAdaptive` in the installed SDK is
  `{ type: 'adaptive'; display?: 'summarized' | 'omitted' }`. YA's shared
  `thinkingOptionToConfig` now always emits
  `{ type: "adaptive", display: "summarized" }` whenever thinking is
  enabled. The client "Show thinking" preference is display-only; it
  decides whether already-produced thinking rows render.
- **Layer B — render already exists.** The thinking-block renderer is
  built and wired: `thinkingRenderer`
  (`packages/client/src/components/renderers/blocks/ThinkingRenderer.tsx`)
  is registered in `renderers/index.ts` and handles
  `type: ["thinking", "reasoning", "reasoning_text", "summary_text"]`,
  extracting text from `block.thinking`, the `summary[]` array (the
  summarized-thinking shape), or `block.text`. It renders a collapsed
  "Thinking" pill that expands on click — the persistent, on-demand
  analog of the TUI's `C-o` (and better: the TUI discards summaries when
  thought completes; YA keeps them collapsed-but-available). So no
  renderer needs building. The one open question is *delivery*: do
  summarized blocks reach the client via the persisted assistant message
  (in which case render is automatic) or only via `stream_event` deltas?
  Per [claude provider control](claude.md) "Current Problem Areas",
  `Process` keeps a short replay window that **excludes `stream_event`**;
  if summaries arrive only as stream deltas they could be dropped on
  catch-up. This is the only thing the isolating test below needs to
  settle — and it is verify-first, not assumed-broken.

Codex similarly **always** requests reasoning summaries: the Codex
provider hard-codes `summary: "auto"` (`packages/server/src/sdk/
providers/codex.ts`), so Codex transcripts carry `summary_text` blocks
that the shared renderer already shows. Codex's user-facing show/hide is
the render-only transcript collapse, not a request control. Claude now
follows that same product shape: request summaries from the provider, then
let YA decide whether to render them to a given client.

On Opus 4.7/4.8 the provider default is to show no thinking blocks. YA
overrides that by explicitly requesting summarized display when thinking
is enabled. In practice summaries appear routinely only at effort `high`
or above, so low-effort turns may still produce little or no thinking
text.

That setting does **not** rescue YA, though YA already loads it: the
Claude provider passes `settingSources: ["user", "project", "local"]`
(`packages/server/src/sdk/providers/claude.ts`), so the headless SDK
subprocess reads the same `showThinkingSummaries: true`. Yet thinking
blocks still never appear in YA on Opus 4.8 — evidence that
`showThinkingSummaries` is an interactive-TUI render setting the headless
SDK consumer does not act on. YA must therefore request `display:
'summarized'` itself (Layer A) and render the returned blocks (Layer B);
the user's settings.json opt-in is not a path YA can lean on. Both layers
are fixable.

Isolating test (feedback loop): set `display: 'summarized'` on one
adaptive turn that needs reasoning and watch whether
`SDKPartialAssistantMessage` thinking blocks arrive. Arrival with no UI
render ⇒ Layer B (render); no arrival ⇒ Layer A still gating (or the
model/CLI is not honoring `display`).

## Proposal (incremental, each gated)

1. **Confirm summarized-block delivery.** YA now requests summaries when
   thinking is enabled, and the renderer already exists. Keep the
   isolating test above in mind: if summarized blocks arrive but do not
   render, fix Layer B; if no summarized blocks arrive, re-check Claude
   SDK support or model behavior.
2. Surface `taskBudget.total` as an optional per-session token-budget
   control in the new-session / effort UI, default unset (let the model
   decide), behind a capability flag tied to model support and the alpha
   status. Prefer a few presets over a raw number field.
3. Surface `maxBudgetUsd` as an optional spend cap, consistent with the
   cost-efficiency default-modest rule — do not default it on, and do
   not seed an expensive ceiling.
4. Decide whether `setMaxThinkingTokens` should become a live mid-session
   control; first confirm it is not a no-op on adaptive Opus 4.6+.
5. Gate the thinking/effort toggle per model via the
   `supportsAdaptiveThinking` / `supportsEffort` metadata rather than a
   fixed toggle.

Before building any step: re-read the pinned SDK `sdk.d.ts` (field names,
beta header, alpha-status drift) and the model capability metadata. Beta
and alpha controls go behind capability flags and are never defaulted on,
per [provider refresh](provider-refresh.md).
