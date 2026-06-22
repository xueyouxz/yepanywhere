# Stream-vs-durable message id dedup

> A provider's live-stream message ids can diverge from its durable
> (JSONL/DB) ids; when a backfill merges durable rows the client already
> has from the stream, messages render twice. Align ids deterministically
> where the provider allows it; fall back to a tight content+timestamp
> reconcile only where it cannot.

Topic: stream-durable-id-dedup

## The defect this prevents

The client holds a live array merged from two sources: the **stream**
(SSE/SDK, tagged `_source: "sdk"`) and **durable backfill** (`_source:
"jsonl"`, fetched via the REST message list). Dedup across the two is by
message id (`getMessageId` in `mergeMessages.ts`). If the same message
carries different ids in each source, the backfill copy is appended as a
duplicate.

In a live, owned session the durable rows are normally never merged
mid-turn (`handleFileChange` early-returns for owned sessions). An
**interrupt/steer** breaks that: abort -> idle -> new turn forces a stream
re-subscribe -> `connected` -> `fetchNewMessages()` -> merge of the
now-persisted post-interrupt rows. Hence the report "every message after I
interrupted to deliver a queued steer is double-displayed."

## Two-layer remedy

1. **Deterministic id alignment (preferred).** Make the streamed id equal
   the durable id, so dedup-by-id just works. No false-merge risk.
2. **Approx-dedup backstop.** `lib/linearMessageDedup.ts`
   (`reconcileLinearMessages`, `hasEquivalentJsonlMessage`) merges
   same-fingerprint (type+role+content) cross-source copies within a tight
   timestamp window. Gated by the provider capability
   `needsApproxMessageDedup` (codex, codex-oss, opencode). The window is
   **2s** (default and replay): a human does not send two identical turns
   that fast, so this minimizes the real risk — silently merging two
   genuinely-distinct identical messages (the old 90s replay window made
   that risk large). Deterministic alignment carries the load; this only
   catches the residue. The optional capability `approxDedupExcludesTools`
   (codex, codex-oss) removes tool_use/tool_result messages from this
   backstop entirely: their uuids are deterministic (call_id), so the
   backstop is redundant for them and would otherwise be the one place a
   legitimately-repeated identical tool call could be wrongly merged. The
   `excludeTools` option on both backstop functions implements this; OpenCode
   leaves it off.

## OpenCode

Verified against `references/opencode` (run `pnpm clone-references` —
note it fetches only Codex; OpenCode was cloned manually for this):
`/event` is **forward-only** (no replay on connect), so duplication is
purely the REST backfill. The send API `POST /session/:id/message` accepts
an optional client `messageID` and adopts it as the durable SQLite primary
key; live `message.part.updated` carries `part.messageID` == the durable
`message.id`.

- **Assistant: fixed deterministically.** Emit each streamed assistant
  message under its own `part.messageId` (`opencode.ts`), not a
  carried-over "current" id. Streamed uuid == durable id.
- **User echo: on the backstop.** Streamed user uuid is YA's queue
  `message.uuid`; durable is OpenCode's `message.id`. They never match,
  so the 2s reconcile handles it (steer message + durable copy are
  identical content within 2s). Residual gap: two identical steers <2s
  apart.

### Deferred option A (more accurate user-echo fix)

The clean deterministic user-echo fix is to **mint an OpenCode-format id
(`msg_` + ascending suffix; see OpenCode `Identifier`, schema only
requires the `msg` prefix) as the queue `message.uuid` itself**, then pass
it as `messageID` on the send POST. Then echo uuid == queue uuid ==
durable id, all consistent.

Why deferred, not done: `message.uuid` is also the key the supervisor uses
to attach the client `tempId` for optimistic-send reconciliation
(`Process.ts` queue path; client reconciles by `tempId` in `useSession`).
Repointing only the echo uuid would break that and double the user's *own*
sends. A correct A therefore changes the **shared, provider-agnostic queue
path** to be provider-aware, and needs a sweep confirming no
`message.uuid` consumer assumes a random-UUID format. Disproportionate vs.
the backstop, which already covers the case — revisit only if the
2s-identical-steer residue actually bites.

## Codex

YA drives Codex over the app-server **thread-item** stream
(`thread/start` with `experimentalRawEvents: false`), so the live render
path is `item/started`/`item/completed` → `convertItemToSDKMessages`
(NOT the `rawResponseItem/*` path, which is opt-in and unused here). What
id a thread item carries decides whether alignment is possible, and it
splits by item class (verified in `references/codex`
`app-server-protocol/src/protocol/thread_history.rs`):

| Item | Live thread `item.id` | Durable rollout id | Aligned? |
|---|---|---|---|
| Tool calls/results | `payload.call_id` (`id: payload.call_id.clone()`) | `call_id` on the response item | **Yes** — both key on `call_id` |
| User turns | counter `item-{N}` + separate `client_id` | event_msg `client_id` (null until YA sends it); also a positional response-item copy | Deferred (see below) |
| Assistant / reasoning | counter `item-{N}` (`next_item_id()`) | `response_item.payload.id` — **null in practice** | **No** — no shared id; backstop only |

The decisive correction over the original plan: in the active
(thread-item) config, assistant messages have **no shared id either
side** — the live id is a synthetic per-thread counter and the rollout's
`payload.id` is null (confirmed on a real 2026-06 rollout: 13 assistant
items, all `payload.id == null`). So the "Assistant w/ `ResponseItem.id`"
class does not occur, and *all* assistant messages fall to the
content+timestamp backstop. Only **tool calls** are cleanly alignable.

### Done: tool-call id alignment

Both sides now key the rendered message uuid on `call_id` (call →
`call_id`, result → `${call_id}-result`), independent of turn — `call_id`
is globally unique, so no turn scoping is needed:
- Live (`codex.ts`): `convertItemToSDKMessages` routes tool-backed thread
  items (`isToolBackedThreadItem`) through `buildItemToolUuid(item.id)` /
  `buildItemResultUuid(callId)`; message/reasoning items keep
  `${itemId}-${turnId}`. The streaming-result and (opt-in) rawResponse
  paths use the same helpers.
- Durable (`normalization.ts`): `codexDurableResponseItemUuid` maps
  `function_call`/`custom_tool_call`/`web_search_call` →
  `call_id`, `*_output` → `${call_id}-result`; the `exec_command_end`
  event result keys on `${call_id}-result` too. Messages keep the
  positional `codex-${index}-${ts}` uuid (the index still advances, so
  positional ids stay stable).
- Contract test: `render-parity.test.ts` "aligns Codex tool-call uuids
  across stream and durable sources" asserts uuid equality per `call_id`,
  and "dedups Codex tool messages by id … with the backstop off" proves the
  ids carry tool dedup without `reconcileLinearMessages`.
- Backstop excluded for tools: with the ids deterministic, the approx-dedup
  backstop no longer runs over Codex tool messages
  (`approxDedupExcludesTools`); it stays on only for the residual non-tool
  messages. See the Two-layer remedy note above.

### Deferred: user-turn id alignment

The round-trip exists — sending `clientUserMessageId` on `turn/start`
(`codex.ts:createTurnStartParams`) and `turn/steer` makes Codex persist it
as the event_msg `user_message.client_id` (`references/codex`
`core/src/session/mod.rs:3717` sets `client_id: client_user_message_id`),
and the live echo already uses the same `message.uuid`. The blocker is the
durable double-source: when response-item user messages exist (the norm),
`hasCodexResponseItemUserMessages` renders the user turn from the
**response item** (positional uuid, no `client_id`) and skips the event_msg
that carries `client_id`. Aligning requires either correlating the two or
flipping that gate — entangled, and low marginal value over the 2s
backstop (the residue is only two identical steers <2s apart). Not done.

### Pitfalls that turned out fine (for the deferred user-turn work)

Confirmed non-issues while doing the tool-call alignment, recorded so the
user-turn step doesn't re-investigate them:
- The live `-result` suffix correlation moved in lockstep: tool-result
  uuids derive from the same `call_id` as the call, on both sides.
- `getCodexEntryDedupeKey` (`codex-reader.ts`) keys the **within-file**
  dedup on timestamp+role+content, not on ids, so changing the rendered
  uuid does not touch it; the tool-context maps key on `call_id`, which is
  unchanged. No regression there.
- Parsing `response_item.id` is pointless for assistants (null in
  practice); only `user_message.client_id` is worth parsing, and only once
  the user-turn renderer is changed to consume it.

## pi

Same shape as OpenCode's user echo, and the durable copy only began to exist
when `PiSessionReader` landed (`e7428b09`) — before that pi routed to
`NullSessionReader`, so there was no second copy to collide with. The divergence:

| Source | User-turn uuid | Where |
|---|---|---|
| Live stream echo | YA queue `message.uuid` | `pi.ts` (`yield {type:"user", uuid: message.uuid}`) |
| Durable backfill | pi JSONL node `id` | `pi-reader.ts` `mapNode` (`uuid = node.id`) |

They never match, and pi originally shipped `needsApproxMessageDedup: false`, so
by-id dedup left the **first turn double-rendered** — visible only on that turn
because it is the one actively-streaming turn whose user node is already
persisted+loaded while the assistant is still single-sourced from the live
stream; later owned turns don't merge durable rows mid-stream (`handleFileChange`
early-return). The server-side uuid duplicate-guard (`Process.ts` ~2663) only
catches same-uuid optimistic+echo collisions; the durable copy arrives via the
REST path and never enters that bucket.

- **User echo: on the backstop (landed).** `PiProvider.needsApproxMessageDedup =
  true`. Both copies carry timestamps — the live echo is stamped at emit time by
  `Process.withTimestamp` (`Process.ts:2650`) and stored for replay, the durable
  copy carries pi's node timestamp — and they are co-temporal (same moment pi
  persists the user node), identical content, so the 2s reconcile merges them.
  Residual gap: two identical prompts <2s apart, plus the long-turn assistant
  case below.

### Deferred: deterministic alignment needs a `graehl/pi` fork

Unlike OpenCode (whose send API accepts a client `messageID`), **pi exposes no id
hook over RPC**, verified against `~/pi` (`@earendil-works/pi`):

- pi mints node ids itself: `appendMessage` → `createEntryId()` →
  `uuidv7().slice(0,8)` with collision retry (`harness/session/jsonl-storage.ts`,
  `session.ts`). Random and unpredictable, so YA cannot pre-compute them.
- The `prompt`/`steer`/`follow_up` RPC commands' `id?` field is the **request
  correlation id**, not a node id (`modes/rpc/rpc-types.ts`); there is no
  message-id parameter pi would adopt.
- pi never *surfaces* the persisted node id either: `message_start` is emitted
  for user messages but carries only the logical `AgentMessage` (no entry id;
  `agent-loop.ts:112`), and `get_messages`/`get_state` return
  `AgentMessage[]` / session meta — also no entry ids (`agent-session.ts:839`,
  `modes/rpc/rpc-mode.ts`). The entry id lives **only** in the durable JSONL,
  which is exactly what `PiSessionReader` reads.

So a YA-only deterministic fix is impossible. The clean fix is a fork change to
`graehl/pi` (the designated integration target): add an optional `id` to
`appendMessage` and thread a client-supplied id from the `prompt` RPC down to the
user-message append, then YA passes its queue `message.uuid`. Note this is
*simpler* than OpenCode's deferred option A — YA's queue uuid path is unchanged
(pi adopts YA's existing uuid; YA's `tempId` reconciliation is untouched). A
complete version surfaces session entry ids in the message-lifecycle events
(harness injects the id at append time) so assistant/tool uuids align too,
retiring the backstop dependence entirely. Deferred while we stay on upstream
pi (no fork); the backstop covers the reported symptom in the meantime.

### Resume uuid is already pi's id (not gated on the first turn)

A tangent that came up: pi writes its session **header file at startup**
(`jsonl-storage.ts` `create`), so the resumable id (= filename uuid = header
`id`) exists before any turn. pi's `get_state` returns it (`pi.ts` resolves it
synchronously), the init message carries it, and the generic
`waitForSessionId()` + init remap (`Supervisor.ts:898`, `Process.ts:2710`)
already adopt it as the canonical/URL id — pi is not special-cased out. So the
URL uuid is already `pi --session <uuid>` resume-capable; no first-turn block is
needed for it, and a first-turn block would *not* hand YA the user node id
anyway (pi doesn't emit it; see above).

## Key files

- `packages/client/src/providers/implementations/PiProvider.ts` — pi capability.
- `packages/server/src/sessions/pi-reader.ts` — durable pi node-id mapping.
- `packages/server/src/sdk/providers/pi.ts` — pi live stream user-echo uuid.
- `packages/client/src/lib/linearMessageDedup.ts` — the shared backstop.
- `packages/client/src/providers/types.ts` — `needsApproxMessageDedup`.
- `packages/client/src/hooks/useSessionMessages.ts` — merge + dedup gates.
- `packages/server/src/sdk/providers/opencode.ts` — OpenCode stream ids.
- `packages/server/src/sessions/normalization.ts`,
  `packages/server/src/sessions/codex-reader.ts` — durable Codex ids.
- `packages/shared/src/codex-schema/session.ts` — Codex schema (drops ids).
