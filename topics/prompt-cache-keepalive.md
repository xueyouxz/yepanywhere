# Prompt Cache Keepalive

> Prompt-cache keepalive is YA's policy for preserving provider prompt-cache
> warmth for active-enough live clients, with explicit cost, cadence,
> transcript, and provider-capability bounds.

Topic: prompt-cache-keepalive

Related topics: [provider-context-economics](provider-context-economics.md),
[session-liveness](session-liveness.md), [heartbeat](heartbeat.md),
[resume-compaction](resume-compaction.md), [cost-efficiency](cost-efficiency.md),
[vanilla-defaults](vanilla-defaults.md)

## Motivation

Long provider sessions are cheap and responsive only while their rendered
prompt prefix remains cache-warm. Once the prompt cache expires, the next
turn pays the cold-resume cost: full prefix prefill, extra latency, and
sometimes provider-side summarization or compaction pressure. The user pain is
not only money or quota; it is also quality loss when a provider decides to
compress, summarize, or otherwise rebuild context after the gap.

The product goal is narrow: avoid needless cache eviction for a session the
user is still actively supervising in YA, including a backgrounded browser tab
or app window that remains connected. The goal is not to occupy provider cache
capacity for abandoned sessions or to run recurring provider work after the
user closed the view.

This topic is a deliberate exception to [vanilla-defaults](vanilla-defaults.md):
for providers with a literal no-context-move refresh path, YA may default to a
reasonable expected-cost-saving keepalive for active-enough clients. The user
benefit is avoiding the much larger cold full-history recompute cost; the
product risk is bounded by requiring no visible session row and no future
context noise in the default path.

## Provider Ground Truth

For this topic, "cache-warm" means the provider can reuse a previously
submitted prompt prefix without recomputing the full prefix prefill. Whether
the provider describes that retained representation as in-memory cache,
extended cache, or another storage tier is an implementation detail unless it
changes TTL, price, privacy, or rate-limit behavior.

A literal no-context-move refresh is a provider operation that uses or refreshes
the cached prefix without adding a user/assistant item, generated assistant
content, or semantic instruction that future turns can condition on. It may
produce provider usage/accounting metadata and a YA debug/status event; it must
not appear as an in-session transcript row.

Provider cache behavior is not uniform enough for a single hard-coded timer:

- Anthropic prompt caching defaults to a five-minute TTL, refreshed when the
  cached prefix is used. A one-hour TTL exists and costs more on metered API
  paths. Claude Code subscription paths may request or receive one-hour prompt
  caching by default; YA-owned Claude launches currently set
  `ENABLE_PROMPT_CACHING_1H=1` unless the operator explicitly overrides it.
- OpenAI API prompt caching has two retention policies in current official
  docs. The shorter-lived retained prefix generally stays active for 5-10
  minutes of inactivity, up to one hour. Extended retention keeps
  supported-model cached prefixes active longer, up to 24 hours; the default
  depends on the
  organization's data-retention posture. The active YA `codex` provider does
  not call the OpenAI API directly, so YA cannot simply set
  `prompt_cache_retention` on normal subscription-backed Codex sessions.
- Codex app-server exposes cached-token accounting in its protocol, but the
  checked-in YA protocol subset does not expose a cache-retention control.
  Treat Codex cache TTL as provider-owned until a documented app-server field
  or API-direct provider exists.
- ACP providers, OpenCode, and local/compatible endpoints may report cache
  usage, hide it, or not implement a meaningful prefix cache. Unknown is not
  zero; it is unknown, and the UI should avoid precise TTL claims.

Sources:

- OpenAI prompt caching docs:
  <https://developers.openai.com/api/docs/guides/prompt-caching>
- Anthropic prompt caching docs:
  <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
- Claude Code prompt caching docs:
  <https://code.claude.com/docs/en/prompt-caching>

## Contract

Prompt-cache keepalive is a user-visible resource policy, not a hidden
provider optimization.

- **Default-on exception is no-context-move only.** YA may default keepalive on
  for active-enough clients only when the provider exposes a literal
  no-context-move refresh path with bounded cost and cadence. Hidden micro-turns
  or synthetic messages that become provider-visible conversation context are
  not part of the default path.
- **Configure uniformly per provider.** The persisted user setting should be
  keyed by provider, not by individual session or by one global all-providers
  switch. Each provider row should expose the same shape -- off, provider
  native/default behavior, default no-context keepalive when supported, and
  stronger user-enabled keepalive modes if they are ever added -- while
  provider capability facts decide which choices are enabled and what copy
  explains them.
- **Active-enough client lease required.** YA may schedule a default keepalive
  only while at least one client has a live subscription/lease for that session
  and still looks like an active enough tab/app window. A backgrounded tab
  counts if its connection remains alive and healthy. A closed tab,
  disconnected phone, or stale localStorage record does not.
- **No viewer, no default keepalive.** The server must not autonomously
  maintain prompt-cache warmth for sessions with no current client viewer,
  even if the session is recent, expensive, or likely to be resumed soon.
- **No provider-owned abandoned cron.** Provider adapters may expose facts and
  a one-shot keepalive operation. They must not independently create recurring
  refresh work that survives the client lease that asked for it.
- **One-shot provider surface.** The provider layer should expose a capability
  shaped like "known TTL/cost facts" plus "run one cache refresh now if safe".
  A scheduler above the provider decides whether and when to call it.
- **TTL less than or equal to zero means no useful keepalive.** Use this for
  providers with no meaningful prompt cache, no exposed retention window, or a
  retention window long enough that YA should not refresh it proactively.
- **No transcript or context pollution by default.** A default keepalive must
  not appear as a user turn, assistant response, slash command, synthetic system
  row, or hidden provider-visible instruction. If a future provider can only be
  kept warm by sending a small message, that mode must be explicitly named in
  UI/settings and shown as stronger than the default no-context mode.
- **No activity-age pollution.** Keepalive must not reset UI-facing "last
  activity" ages such as session `updatedAt`, toolbar/session-list relative
  time, real provider-message timestamps, unread cutoffs, or recents ordering.
  Its own refresh timestamp is internal scheduling/log metadata only.
- **No semantic steering masquerading as keepalive.** Sending `.`, `continue`,
  "status?", or similar is not a neutral cache touch. It can change the agent's
  plan, consume turn budget, trigger tools, alter summaries, and pollute future
  context. It is a user-configured heartbeat/nudge, not a provider-neutral
  prompt-cache keepalive.
- **Cost and rate limits still matter.** Cached-token discounts reduce prefill
  cost but do not make refreshes free. OpenAI docs say cached prompts still
  count against token-per-minute (TPM) rate limits; Anthropic one-hour cache
  writes have different metered pricing. Keepalive cadence must be bounded and
  observable.
- **Never use summarization as a silent cache substitute.** If avoiding a cold
  resume requires compaction or summary generation, route through the
  resume-compaction contract: explicit user choice, progress state, and
  failure handling.

## Architecture Shape

The clean split is:

1. **Provider capability facts.** A provider reports its best known
   prompt-cache retention window and whether it has a no-context-move refresh
   path, a hidden-message refresh path, or no useful refresh path. The fact may
   be exact, documented-default, inferred, or unknown; UI copy should preserve
   that distinction. These facts feed a uniform per-provider settings surface
   rather than hard-coding provider-specific controls.
2. **One-shot keepalive action.** A provider implements a single
   `refreshPromptCache`-style action only when it can name the resulting
   transcript, cost, and liveness effects. If all it can do is send a normal
   user message, the capability should say so instead of pretending it is
   invisible.
3. **Client-owned lease and scheduler.** The server can run the timer for
   reliability under background-tab throttling, but the timer is owned by live
   client subscription state. Closing the last subscribed client cancels the
   timer.
4. **Visible status.** UI can show unobtrusive cache-warmth metadata such as
   last refresh age, next refresh due, or known TTL. This belongs in a tooltip,
   compact status chip, or settings/debug surface before it becomes first-run
   chrome.

This keeps resource ownership compatible with
[architecture-mandates](architecture-mandates.md): an idle provider session
with no active client tab must not create repeating server work.

## Scheduling Rules

If keepalive is implemented, the first scheduler should be conservative:

- schedule by default only for providers whose keepalive setting resolves to an
  enabled no-context-move capability;
- require explicit user/provider opt-in before using any hidden-message
  refresh path;
- require `verified-idle` or another provider-specific safe-idle state before
  sending anything that could become a real turn;
- fire before the documented TTL, with jitter and a minimum interval so many
  open tabs do not align into a burst;
- coalesce multiple client leases for the same YA session into one timer;
- pause while a provider turn is active unless the provider documents a
  non-turn cache-touch primitive;
- log a bounded event with provider, session id, capability path, and token
  usage summary, not transcript content;
- stop immediately when the last live session subscription closes.

The exact margin depends on the provider. For a five-minute TTL, a refresh
around 3-4 minutes after the last real provider/cache-use signal is plausible.
For a one-hour TTL, the marginal value is much lower and the cadence must not
turn YA into a background load generator. For a 24-hour OpenAI extended cache,
YA should generally expose the fact and do no refresh.

## UI Notes

Use quiet, inspectable feedback:

- a small age/TTL indicator or tooltip near existing liveness/context status;
- a uniform provider settings row in the same area as other model economics
  choices -- model, effort, thinking, and related cost/latency controls -- that
  names that provider's behavior, cadence, and whether refresh creates
  transcript-visible or future-context-visible turns;
- no first-run banner or new default toolbar control.

The `now` label conflict in the composer is adjacent UI cleanup, not part of
this contract. If keepalive status uses relative time copy such as "now", make
it visually distinct from Claude's steer-now control or move it into hover
text so the two controls are not confused.

## Open Questions

- Does Codex app-server expose or plan a documented cache-retention override
  comparable to OpenAI API `prompt_cache_retention`? Current YA protocol files
  do not show one.
- Is there any provider-native "touch cache without a transcript turn" path
  for CLI-backed sessions? Do not assume one from cached-token accounting.
