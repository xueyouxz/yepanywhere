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
  resolves to `{ type: "adaptive" }`: `"auto"` → adaptive; `"on:<effort>"`
  → adaptive + effort; a plain `EffortLevel` → adaptive + effort. Only
  `"off"` → `disabled`.
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

## Showing thinking text — why it never appears, and the real path

This is the "I have never once seen Claude thinking in YA" issue. Two
layers, both real and both fixable:

- **Layer A — request omits `display`.** On Opus 4.7/4.8 thinking text is
  *omitted by default* — the API streams only pings during a
  redacted-thinking phase, so there is no reasoning text to show. The
  opt-in is `display: 'summarized'`, and it **is** reachable:
  `ThinkingAdaptive` in the installed SDK is
  `{ type: 'adaptive'; display?: 'summarized' | 'omitted' }`. YA's shared
  `ThinkingConfig` (`packages/shared/src/types.ts`) constructs
  `{ type: "adaptive" }` with **no `display` field**, so it defaults to
  `'omitted'`. That alone explains seeing no thinking text — the model is
  told not to return it.
- **Layer B — stream/render drops thinking.** Even with `'summarized'`
  set, YA must surface the thinking content. `SDKThinkingTokensMessage`
  (`subtype: 'thinking_tokens'`) carries only an `estimated_tokens`
  progress estimate — its own doc string says it is "for spinners/pills,
  not the authoritative billed output_tokens," digested from
  `thinking_delta` during the redacted phase. The reasoning *text*
  arrives as thinking blocks on `SDKPartialAssistantMessage` /
  assistant-message content. Per [claude provider control](claude.md)
  "Current Problem Areas", `Process` keeps a short replay window and
  **excludes `stream_event`**, and catch-up does not reconstruct thinking
  deltas — so even the progress pings are likely dropped today.

The TUI shows nothing by default for the same Layer-A reason; a thinking
spinner/token pill is the most the redacted default yields. So "never see
thinking" is expected behavior, not proof of a YA-specific bug — but it
*is* fixable on both layers.

Isolating test (feedback loop): set `display: 'summarized'` on one
adaptive turn that needs reasoning and watch whether
`SDKPartialAssistantMessage` thinking blocks arrive. Arrival with no UI
render ⇒ Layer B (render); no arrival ⇒ Layer A still gating (or the
model/CLI is not honoring `display`).

## Proposal (incremental, each gated)

1. **Show thinking text** (highest priority — the concrete cause of
   "never see thinking"). Add `display: 'summarized'` to YA's adaptive
   `ThinkingConfig` (`packages/shared/src/types.ts`), then render the
   thinking blocks: confirm the `stream_event` / `Process` replay path no
   longer drops `SDKPartialAssistantMessage` thinking content, and add a
   renderer. Optionally surface the `thinking_tokens` estimate as a live
   thinking spinner/pill regardless of `display`. Run the isolating test
   above to separate the request layer from the render layer.
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
