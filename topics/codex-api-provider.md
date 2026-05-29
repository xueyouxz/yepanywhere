# Codex API Provider

> A future Codex API provider would use OpenAI Platform API keys and the
> Conversations/Responses APIs as a separate opt-in backend, preserving the
> current Codex CLI/app-server path for ChatGPT subscription users.

## Current decision

YA's active Codex backend is intentionally oriented around users who already
have Codex access through a ChatGPT subscription. It delegates session state,
tool/runtime behavior, compaction, and persistence to `codex app-server` or
`codex exec resume`, so YA does not need to collect an OpenAI Platform API key
for the normal Codex path.

The OpenAI Conversations API is not a drop-in replacement for that path because
it requires API authentication and API billing. It should therefore be treated
as a future provider family, not as an internal rewrite of the existing `codex`
provider.

## Alternative provider proposal

Add a separate API-key-backed provider only when YA intentionally supports
OpenAI Platform billing:

- Provider identity: use a distinct provider name such as `openai-api` or
  `codex-api`, not `codex`, so UI, docs, support expectations, and billing
  semantics stay clear.
- Authentication: store or reference an OpenAI API key through YA's server-side
  secrets/settings path. Never route the key through the browser client.
- State: create and persist an OpenAI `conversation` id per YA session, then
  send turns through the Responses API with that conversation id. Persist the
  conversation id in YA metadata alongside the YA session id.
- Transcript: keep YA's normalized message stream as the product-facing history,
  but treat the OpenAI conversation object as the provider-owned context source.
- Tools: map YA/provider tool calls and tool outputs to Responses input items
  exactly enough for the model to continue; do not widen generic YA tool schemas
  just to mirror every Responses item until the UI needs them.
- Compaction: prefer the API's native context-management and compaction items
  once the provider owns Responses calls. Surface compaction status through the
  existing `compact_boundary`/`status=compacting` UI contract.
- Retention/privacy: document that OpenAI conversation objects are API Platform
  state with their own retention semantics. If the user needs a no-retention or
  ZDR-friendly mode, design it separately around stateless Responses input arrays
  and explicit compaction, rather than silently using durable Conversations.

## Trigger to build

Build this provider when there is a real YA user who wants API-billed OpenAI
usage, or when Codex CLI/app-server stops exposing enough control for a
required YA feature. Until then, the current backend remains preferable because
it matches the product's subscription-user target and keeps Codex runtime
behavior inside the supported Codex client.

## Relationship to context guardrails

This is a long-term alternative to the current context-budget guardrail work.
The near-term path should still improve visibility, warning, and provider-native
compact/handoff affordances for the subscription-backed Codex provider. The API
provider only becomes relevant when YA is ready to own OpenAI API state,
billing, privacy, tool mapping, and compaction policy directly.

