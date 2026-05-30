# Server Message Routing

How a provider event becomes a wire frame on every connected client, and how
late joiners catch up. Read alongside:

- [`connection-matrix.md`](connection-matrix.md) — transports (Direct / WS /
  SecureConnection / relay)
- [`ws-auth-state-model.md`](ws-auth-state-model.md) — admission and SRP state
- [`packages/client/RENDERING_PERFORMANCE.md`](../../packages/client/RENDERING_PERFORMANCE.md)
  — what happens after the frame arrives in the browser

## One-paragraph summary

Each running agent is a `Process` (`packages/server/src/supervisor/Process.ts`).
The provider SDK's async iterator pumps `SDKMessage`s into the Process; the
Process keeps a tiny rolling buffer for late joiners, then synchronously fans
each event out to a `Set<Listener>` of WebSocket subscribers. A separate
`EventBus` carries cross-session activity (file changes, process spawn/exit,
session creation). There is no central message queue, no per-client outbound
buffer, and no batching: emit is in-process, in-thread, one frame per event.

## Path of one provider event

1. **SDK iterator** — `wrapIterator()` in
   `packages/server/src/sdk/providers/claude.ts` consumes the
   `@anthropic-ai/claude-agent-sdk` `query()` async generator, normalizes each
   provider message to a unified `SDKMessage`, and (when `LOG_SDK_MESSAGES=true`)
   tees a copy to `{logDir}/sdk-raw.jsonl` via `messageLogger.ts`.
2. **Process intake** — `Process.processMessages()` receives each `SDKMessage`,
   updates state (idle / in-turn / waiting-input / hold), and writes it into
   `currentBucket` (the rolling replay buffer).
3. **Streaming text accumulation** — for `stream_event` deltas, the Process
   appends to `_streamingText` keyed by `_streamingMessageId`
   (`Process.ts:132-135`). This is *not* sent as one frame per token at this
   layer; the SDK already chunks deltas and we forward each as-is to listeners.
4. **Fan-out** — `Process.emit()` (`Process.ts:1999-2019`) iterates
   `this.listeners: Set<Listener>` and calls each one inline. Listener errors
   are swallowed so one bad subscriber can't stall the others.
5. **WS encode** — each WS subscription wraps its listener with `createSendFn()`
   (`ws-relay-handlers.ts:253-304`), which JSON-encodes the event and writes
   one `ws.send()` per frame. Three wire variants negotiated at handshake:
   text JSON (legacy), binary `encodeJsonFrame` (Phase 0/1), or NaCl-encrypted
   binary envelope with optional gzip (Phase 3, `BinaryFormat.COMPRESSED_JSON`).

There is no outbound queue between (4) and (5). If a socket's send buffer is
full, the underlying `ws` library buffers it; if the send throws, the socket is
closed (`ws-relay-handlers.ts:295-301`).

## Late-join replay

When a new client subscribes to an active Process
(`subscriptions.ts:200-243`):

1. Send `connected` with `processId`, `state`, `permissionMode`,
   `deferredMessages`.
2. Walk `process.getMessageHistory()` (concatenation of `previousBucket` +
   `currentBucket`) and re-emit each as a `message` with `isReplay: true`.
3. If a streaming response is mid-flight, `process.getStreamingContent()`
   returns the accumulated text + `messageId`; the augmenter renders that to
   pending HTML and emits a single catch-up frame so the client sees partial
   output without waiting for the next delta.

The two buckets swap every 15 s (`BUCKET_SWAP_INTERVAL_MS`,
`Process.ts:127-130`). That gives a 15–30 s replay window — long enough to
cover most page reloads / network hiccups, short enough that an idle Process
holds at most ~30 s of messages in memory regardless of session length. Older
history is the responsibility of the JSONL files the provider CLI writes; the
client loads those over REST on session open.

## Activity bus

`packages/server/src/watcher/EventBus.ts` is a `Set<EventHandler>` with the
same synchronous emit shape as Process, broadcasting cross-session events:
`FileChangeEvent`, `SessionStatusEvent`, `ProcessStateEvent`,
`NetworkBindingChangedEvent`, browser-tab connect/disconnect, etc. WS clients
subscribe via `handleActivitySubscribe()`
(`ws-relay-handlers.ts:461-515`); the inbox UI uses this to refresh tier
ordering without polling.

## Backpressure / coalescing — what's there and what isn't

| Where | Mechanism | Why |
|-------|-----------|-----|
| Provider → Process | none | SDK iterator is the natural pacer |
| Process → listeners | none (sync emit) | sub-ms cost, simple to reason about |
| WS framing | `ws` lib socket buffer | OS-level backpressure suffices at YA's client counts |
| Heartbeats | 30 s interval | keepalive only, not coalescing |
| Upload chunk progress | every 64 KB (`PROGRESS_INTERVAL`) | avoid one frame per chunk |
| SRP handshake | token-bucket per peer (`ConnectionState.srpLimiter`) | brute-force defense |
| Replay buffer | two buckets × 15 s | bound memory |
| **Client-side throttle** | adaptive 100–750 ms in `useStreamingContent` / `useStreamingMarkdown` | the only render-rate governor in the system |

The deliberate choice is: **the client throttles, the server doesn't**. Server
work per event is cheap (one JSON encode + one socket write per subscriber);
React reconciliation is not. Pushing the rate limiter onto the server would
only help if a future provider produced deltas faster than the SDK currently
chunks them, *and* the network couldn't absorb them.

## Maintenance surface

A second HTTP server runs on `PORT + 1`
(`packages/server/src/maintenance/server.ts`) using raw Node `http`, deliberately
isolated from Hono and the WS event loop so it stays responsive when the main
loop is busy. It exposes liveness/status, runtime log-level changes, proxy
debug toggles, the Chrome inspector, and `/reload`. Useful during incident
response: if WS clients hang, `GET /status` still answers.

## Compute and memory choices, in plain terms

- **Sync fan-out, no queue.** O(subscribers) work per event, all on the main
  event loop. Justified at single-user / small-team scale; the hot path is
  short and the failure mode (slow listener) is contained by try/catch.
- **Two-bucket replay (15 s swap).** A standard ring buffer would also work,
  but bucket swap gives O(1) eviction and a coarse upper bound on memory per
  Process without bookkeeping per message. The cost is a coarse retention
  window (15–30 s, not exactly 15 s).
- **Streaming text accumulator.** One string per active streaming message,
  cleared on `message_stop`. Pays for itself the first time a client opens a
  page mid-response.
- **Per-client encryption + optional gzip.** Negotiated, not forced — clients
  that don't advertise compression don't pay decompression cost.
- **No outbound per-client buffer.** Relies on `ws`'s socket buffer for
  short-term backpressure and on the replay bucket for reconnects. A slow
  client that fills its socket buffer gets closed; on reconnect the bucket
  catches it up.

## Bespoke vs. standard, with onboarding lens

The three-option framing in [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
(library / hand-rolled minimal using standard names / fully bespoke) is the
policy. The notes below name the standard concept each piece implements so
contributors and agents can think and talk about the code in transferable
terms.

| Mechanism | Standard concept it implements | Notes |
|-----------|--------------------------------|-------|
| `Set<Listener>` pub/sub on Process and EventBus | **EventEmitter** (synchronous, no wildcards). | Hand-rolled minimal version. A library (`mitt`, `eventemitter3`, RxJS) would not change semantics at YA's scale; the existing code is the EventEmitter pattern in ~10 LOC. |
| Two-bucket replay | **Time-bucketed ring buffer with O(1) eviction.** | Hand-rolled minimal version (~20 LOC). The swap-on-timer shape is what bounds memory; a generic ring-buffer dep would lose the time-bucketed eviction without saving meaningful code. |
| Wire framing (text / binary / encrypted+gzip) | **Negotiated protocol envelope** (cf. WebSocket subprotocols, gRPC frame types). | Bespoke because the envelope carries SRP+NaCl session state through a relay that must not see plaintext; this is product-specific. Adding a fourth variant warrants an `AGENTS.md`-level discussion. |
| SRP rate limiter | **Token bucket.** | Hand-rolled minimal version (~30 LOC). Standard pattern, no library needed. |
| Maintenance server on `PORT + 1` | **Out-of-band admin/diagnostics endpoint** (cf. Kubernetes liveness probes, JMX). | Standard concept; deliberately on raw `http` rather than the main Hono app so it stays responsive when the main loop is busy. Keep that isolation. |
| `_streamingText` mid-stream catch-up | **Stateful resumable stream / replay log for in-flight messages.** | Closest analogy is a server-sent-events Last-Event-ID resume, but tied to YA's per-message streaming. Treat it as part of the replay contract. |

## Proposed cleanups (small, file-local)

These are not commitments — they're a place to record direction so future
contributors (or future-us) don't re-derive the cost/benefit each time. Each
row is scoped to a single file or hook, no cross-package impact. For
**architectural** proposals (outbound buffering, maintenance auth, unified
pub/sub, higher-scale fan-out), see
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) → "Large-scope refactor proposals".

| # | Change | Cost | Benefit | Recommendation |
|---|--------|------|---------|----------------|
| 1 | Replace silent listener `try { } catch { }` in `Process.emit()` (`Process.ts:2012-2018`) with a structured warn-log including subscription id and event type. | Trivial. ~5 LOC. | Stuck/buggy listeners stop being invisible; oncall has a thread to pull. | **Do it next time `Process.ts` is touched.** |
| 2 | Expose fan-out counters on the maintenance `/status` endpoint: per-Process listener count, total events emitted, last emit timestamp. | Small. ~30 LOC, no new deps; reuse the `connectionStats` shape in `maintenance/server.ts`. | A live regression in fan-out (a Process with zero listeners but active state, or a listener leak) becomes one curl away. Also a precursor to the higher-scale fan-out proposal in `ARCHITECTURE.md`. | **Do it next time `/status` is touched.** |
| 3 | Extract `useAdaptiveThrottle` hook shared by `useStreamingContent` and `useStreamingMarkdown`. | Medium. The two paths have parallel 100–750 ms adaptive logic; refs interact subtly so a regression test would be needed. | One place to tune the windows; less drift between the two surfaces. | **Do it the next time both files are edited in the same change**, not as a standalone refactor. |
| 4 | Make the bucket swap interval a `const` exported from a config module (currently `BUCKET_SWAP_INTERVAL_MS = 15_000` inline). | Trivial. | Lets test code shorten it without monkey-patching; documents that 15 s is a tuning knob, not magic. | **Low priority**; combine with the next bucket-related change. |
| 5 | Replace `getMessageHistory()`'s array concatenation with an iterator (or pass the two buckets directly to the replay loop). | Small. Maybe 10 LOC plus call-site updates. | Saves an allocation on every subscribe; matters under reconnect storms or many tabs. | **Skip until profiling shows it**; YA's typical client count makes this academic. |

The pattern: **clean up things that improve observability today (rows 1, 2)**
and **fold opportunistic refactors into changes that already touch the file
(rows 3, 4)**. The Contribution Ethos in `DEVELOPMENT.md` discourages
introducing dependencies for narrow utilities, so none of these add a runtime
dep.

For the client side, see the Review Checklist at the bottom of
[`packages/client/RENDERING_PERFORMANCE.md`](../../packages/client/RENDERING_PERFORMANCE.md);
the live cleanup direction there is "trace every high-rate path each time you
fix one," not a list of named refactors.

## Where this fits in the broader architecture

```
provider CLI ──► SDK iterator ──► Process ──► listeners ──► createSendFn ──► ws.send
                                     │                          ▲
                                     ├──► currentBucket ────────┘  (replay on subscribe)
                                     └──► _streamingText ───────┘  (catch-up on subscribe)

EventBus ──► activity listeners ──► createSendFn ──► ws.send
   ▲
   ├── file watchers
   ├── Process state changes
   └── session lifecycle
```

The whole routing layer is small enough to read in an afternoon. If you are
onboarding and want a single trace: open a session in the UI, set
`LOG_SDK_MESSAGES=true`, watch `~/.yep-anywhere/logs/sdk-raw.jsonl` and the
browser DevTools WS frame inspector simultaneously. Every line in the JSONL
should correspond to a frame on the wire (modulo replay markers and the
streaming catch-up).
