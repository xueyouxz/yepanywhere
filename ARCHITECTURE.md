# Architecture

Entry point for understanding how Yep Anywhere is shaped. Read this first
before changing message-flow, transport, or render-path code, and before
proposing cross-cutting refactors.

This file is intentionally short — each link below is the load-bearing
detailed doc. Update this file when the high-level picture changes; update the
linked docs when the details change.

## Shape

```
┌──────────────┐    ┌──────────────────────────┐    ┌────────────────────┐
│ provider CLI │ ── │ Process (per session)    │ ── │ WebSocket clients  │
│ (Claude SDK, │    │  rolling replay buffer + │    │  (browser, mobile, │
│  Codex, ...) │    │  streaming-text catch-up │    │   relay-mediated)  │
└──────────────┘    └──────────────────────────┘    └────────────────────┘
                              │
                              └─ EventBus ── activity subscribers
                                 (file watches, process state,
                                  session lifecycle, network)
```

- **Server** is a Hono app plus a per-session `Process` supervisor and a
  global `EventBus`. Fan-out is synchronous in-process pub/sub. There is no
  central message queue and no per-client outbound buffer; the wire is the
  buffer.
- **Client** is a React app with one `ConnectionManager` singleton coordinating
  reconnect across multiple subscriptions. Distributed hook-and-context state
  (no Redux/Zustand). Streaming text and markdown go through ref-based DOM
  updates with adaptive 100–750 ms throttling, not React state per token.
- **Relay** (optional) is a dumb pipe carrying NaCl-encrypted frames between
  client and server when neither has a routable address to the other.

Single-user / small-team scale is assumed throughout — see the cleanups
section below for what would have to change at higher fan-out.

## Detailed docs

- [`docs/project/server-message-routing.md`](docs/project/server-message-routing.md)
  — provider event → Process → fan-out → wire; late-join replay; the small
  per-file cleanup proposals.
- [`packages/client/RENDERING_PERFORMANCE.md`](packages/client/RENDERING_PERFORMANCE.md)
  — the React render/update pipeline, what's coalesced, what stays immediate,
  the streaming-markdown ref pattern, and the review checklist.
- [`docs/project/connection-matrix.md`](docs/project/connection-matrix.md) —
  the four client transport modes (Direct / WS / SecureConnection /
  SecureConnection-via-relay) and which auth/encoding each uses.
- [`docs/project/ws-auth-state-model.md`](docs/project/ws-auth-state-model.md)
  — admission policy (`local_unrestricted` / `local_cookie_trusted` /
  `srp_required`) and the SRP transport state machine.
- [`docs/project/2026-01-05-server-side-rendering.md`](docs/project/2026-01-05-server-side-rendering.md)
  — server-rendered markdown / diff / file-highlight augments that the client
  consumes through the streaming path.
- [`docs/project/relay-design.md`](docs/project/relay-design.md) — the
  end-to-end-encrypted relay; the "dumb pipe" contract.

## Bespoke vs. standard — and what to learn from it

There are three options for any small mechanism, not two:

1. **Pull in an external library.** Best when the library is audited,
   broadly used, and YA has no need to fix or change it. The Contribution
   Ethos in [`DEVELOPMENT.md`](DEVELOPMENT.md) lists the standing exemptions
   (NaCl, bcrypt, SRP-6a, Hono, Shiki, official provider SDKs). New deps
   beyond those need a clear bug-avoidance vs. complexity-exposure argument —
   familiarity of the name is not enough.
2. **Hand-rolled minimal version using the popular library's names and
   concepts.** Often the best choice for narrow utilities (debounce, ring
   buffer, EventEmitter, adaptive throttle, simple cache). YA owns the code
   so the "can't fix upstream" blocker vanishes; new contributors still see
   familiar vocabulary and learn transferable concepts. This is *not* a hard
   fork — implement only the surface YA actually uses, not a competing
   reimplementation of the upstream library's full API.

   **Where it lives:**
   - **Single function** (debounce, formatBytes, parseSGR, …) — an
     independent file, either in a small `utils/` neighborhood or co-located
     next to its one use. No package boundary; no test infrastructure beyond
     a unit test alongside.
   - **Multi-function mini-library mirroring a standard concept** (an
     EventEmitter-shaped `Topic<T>`, a `RingBuffer`, an
     `AdaptiveThrottle` hook) — its own module with a clear boundary:
     a single file under `packages/shared/src/` (or a workspace package if
     reuse across packages warrants it), with its own test file. The
     boundary is what makes "this is the standard concept, named the
     standard way, scoped to what we need" legible to a new reader.
   The size threshold between the two is judgment, not a number; if a
   utility grows multiple related functions or holds state, it's earned its
   own module.
3. **Bespoke names and shape.** Reserve for code where the YA-specific
   semantics genuinely don't match any standard pattern (e.g. the
   server-rendered streaming-markdown augment path, or the SRP+NaCl relay
   envelope). When you do this, document the closest standard concept the
   reader should think of, even if it's a loose analogy.

The goal of the per-mechanism notes in `server-message-routing.md` and
`RENDERING_PERFORMANCE.md` is to make those mappings explicit — EventEmitter
pub/sub, ring buffer for replay, adaptive throttling, ref-based DOM patching,
SRP-6a authenticated key exchange — so that:

- a contributor new to web dev recognizes what they're reading and picks up
  vocabulary that transfers to other React/Node projects, not only to YA;
- an agent (or future-us) given an unfamiliar file has the standard keywords
  to search for, reason about, and discuss with the user.

If you spot bespoke code without a clear mapping back to a standard concept,
adding that mapping to the relevant doc is welcome on its own — independent
of any decision to refactor.

## Large-scope refactor proposals

These are **proposals, not commitments.** They record direction so a future
reader can tell what's been considered and under what conditions it would
become worth doing — not so the next contributor enacts them.

Small, file-local cleanups live next to their code (e.g. the table at the end
of `server-message-routing.md`). This section is for **architectural** changes
— ones that cross packages, change a cross-cutting invariant, alter the
fan-out or persistence contract, or need design-level discussion before
implementation. Each entry should make the trigger explicit so the proposal
isn't enacted prematurely. Where an entry mentions a possible library, treat
that as one option among the three above (library / minimal hand-rolled /
bespoke), not a recommendation.

### Outbound buffering / per-listener async dispatch

**Problem today.** `Process.emit()` calls every listener inline on the main
event loop. A listener whose body does real work (rather than just `ws.send`)
stalls all peers for that Process for the duration of its work.

**Proposal.** Introduce a per-subscription microtask queue between
`Process.emit` and the WS send, so the listener body can return immediately
and the actual encode/send happens off the emit hot path.

**Cost.** Real complexity: ordering guarantees across `message`, `state-change`,
and `tool-approval`; drain semantics on unsubscribe; error propagation when
the queue overflows.

**Benefit.** Subscriber isolation; a single slow tab or augmenter call can't
delay other tabs.

**Trigger.** Defer until a witnessed regression where one client's work
visibly slows others. Today the SDK iterator paces input and `ws.send` is
non-blocking; no observed pain.

### Auth on the maintenance server

**Problem today.** `packages/server/src/maintenance/server.ts` (port `+1`)
relies on localhost binding plus a CORS-aware origin check. On a single-user
dev box this is fine. On a shared or multi-user host, any local user can
toggle log levels, force `/reload`, or open the inspector.

**Proposal.** Add a token model (one-time token written to the data dir at
startup, read by curl/scripts that need it). Keep the localhost binding;
treat the token as defense in depth.

**Cost.** Designing the token model (rotation, format, persistence path,
`--no-auth` escape hatch for tests) plus updating every documented `curl`
example.

**Benefit.** Defense in depth; YA can be safely enabled on multi-user dev
hosts or transient cloud VMs.

**Trigger.** Defer until YA actually runs somewhere multi-user, or a
threat-model review flags the gap. Note in `CLAUDE.md`/`DEVELOPMENT.md` if
multi-user becomes a target.

### Unified pub/sub abstraction

**Problem today.** `Process.listeners` and `EventBus.subscribers` are both
`Set<(event) => void>` with the same subscribe/emit/cleanup shape, defined
independently. A third pub/sub would tempt a copy.

**Proposal.** Extract a tiny `Topic<T>` helper (~30 LOC) with `subscribe`,
`emit`, `size`, and a hook for metrics/limits. Migrate both call sites.

**Cost.** Small in lines; the cost is conceptual — making the simplest
possible thing (a `Set`) one indirection less obvious.

**Benefit.** One place to add fan-out metrics, per-subscriber rate limits, or
async dispatch (see "Outbound buffering" above) when the time comes.

**Trigger.** **Wait for the third pub/sub.** Two call sites does not justify
the abstraction; introducing it now is the kind of premature reshape the
Contribution Ethos warns against.

### Higher-scale fan-out (queue / shared bus)

**Problem today.** Synchronous `for (const listener of this.listeners)` works
to maybe ~100 concurrent listeners per Process. A user with many open tabs or
a multi-user deployment with broadcasted activity events would eventually feel
this on the main loop.

**Proposal.** Move fan-out off the main loop (worker thread, or yield via
`setImmediate` between batches), and/or coalesce activity events on the server
side rather than relying entirely on client-side debouncing.

**Cost.** Significant. Worker threads change the ownership model for Process
state; server-side coalescing of activity events changes a current invariant
("client sees every event").

**Benefit.** Headroom for multi-user / many-tab deployments.

**Trigger.** Defer until concrete fan-out numbers (instrument `/status` first
— see proposal #2 in `server-message-routing.md`) show the main loop is being
pinned by emit.

### Client transcript virtualization

**Problem today.** `MessageList` renders the full message array. Typical
sessions are <50 messages; long-running sessions can grow into the hundreds or
low thousands.

**Proposal.** Introduce row virtualization for the message list, preserving
the existing `stabilizeRenderItems` identity contract. Library vs.
hand-rolled is a separate question for the Contribution Ethos at the time
(e.g. `react-virtuoso` or `react-window` are the standard reference shapes,
but a small purpose-built virtualizer using their concepts may fit YA better).

**Cost.** Medium. Virtualization interacts with auto-scroll, find-on-page,
search anchors, and the augment-on-DOM streaming path; each needs verification.

**Benefit.** Bounded render cost as transcripts grow.

**Trigger.** Defer until a real long-session profile shows row count is the
dominant cost, not formatter work. The `RenderProfile` markers documented in
`RENDERING_PERFORMANCE.md` are the right tool to confirm.

---

Add new entries here when a contributor identifies an architectural shift
worth recording but not yet enacting. Keep each entry to the same shape:
**problem today → proposal → cost → benefit → trigger.** The trigger is the
load-bearing field — it's how a future reader knows whether the proposal is
still latent or now actionable.
