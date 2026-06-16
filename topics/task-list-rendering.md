# Task-List Rendering

> How YA should render the agent's task/todo list now that recent Claude builds
> emit incremental task events (`TaskCreate`/`TaskUpdate`) instead of a single
> self-contained todo snapshot. This topic frames the problem and its
> constraints; it does not commit to an implementation.

For some time the agent's task list arrived as a self-contained snapshot: the
`TodoWrite` tool's result carried the entire list (`newTodos: [{content,
status, ...}]`) on every change, so a single renderer could draw the whole list
from one message in isolation. Recent Claude builds replaced that with a family
of **incremental** tools — `TaskCreate`, `TaskUpdate`, and the rest of the
`Task*` namespace — where each event is a delta. No single message contains the
full list anymore. With no renderer registered for these tools, they currently
fall through to the raw-JSON fallback, which is what surfaced this topic (a
"TaskUpdate done" row with a `{success, taskId, statusChange}` blob instead of a
checklist).

The `TodoWrite` path still exists and still works for any provider that emits
it. This topic is specifically about the new delta-based `Task*` shape.

## What the data looks like

Observed in real Claude sessions:

- **`TaskCreate`** — one call per task. Input carries `subject`, `description`,
  `activeForm`. Result is a string like `Task #1 created successfully:
  <subject>`. The `#N` is the task's id and is assigned sequentially.
- **`TaskUpdate`** — one call per status change. Input is `{taskId, status}`.
  The structured result carries `{success, taskId, updatedFields,
  statusChange: {from, to}}` — so it reports both the prior and new status.
- **`TaskGet` / `TaskList`** — if the agent calls these, their results are
  full snapshots. The agent does **not** call them on a regular cadence, so
  they cannot be relied on as the rendering source; they are at most an
  opportunistic resync signal.

Key consequence: to show "the task list as of here," some component must
**reconstruct** state by folding every `TaskCreate` (id ↦ subject) and
`TaskUpdate` (id ↦ latest status) seen up to that point. A self-contained
per-tool renderer — the way `TodoWrite` works today — cannot do this, because a
renderer only sees its own tool call.

## Constraints that shape any solution

These are properties of the existing system that a solution has to live within,
not preferences.

- **No single message is sufficient.** Rendering requires accumulated state
  across messages. This is the core departure from `TodoWrite` and from every
  other tool YA renders.
- **The transcript is already a flat, ordered array by the time anything
  renders it.** The jsonl is read and the parent-uuid chain resolved into an
  in-order `Message[]` once at load. There is no per-render graph walk up
  parent uuids, and a solution should not introduce one. Accumulation is a
  linear scan over an array that already exists, not a tree traversal.
- **The server holds nothing between requests.** `reader.getSession` re-reads
  and re-parses the jsonl from disk on every GET, builds the `Message[]`,
  slices it, augments it in place, serializes the response, and discards the
  array. YA is deliberately memory-conservative; a solution that requires a
  long-lived per-session cache is in tension with that posture and needs to
  justify itself.
- **The default load is a tail, not the whole session.** The web client
  requests `tailCompactions: 2` on initial load for *all* providers (not just
  Codex). So the common case is that the client receives only the last two
  compaction boundaries' worth of messages. A `TaskUpdate` in that window can
  reference a `TaskCreate` that is *outside* it. Whatever reconstructs the list
  has to cope with referencing tasks whose creation is off-window.
- **Two ingestion paths must agree.** Live streaming (`stream-augmenter`) and
  cold history GET (`persisted-augments` over `reader.getSession`) are separate
  code paths that must produce the same rendered result, or a session will look
  different while live vs. after reload.
- **There is an existing augment pattern to be consistent with (or to
  deliberately diverge from).** Edit/Write/Read/ExitPlanMode already inject
  precomputed `_`-prefixed fields directly into the tool JSON server-side, and
  the client renderer just reads them. That pattern exists; the open question
  is whether task state fits it cleanly.

## Where the work could live — and the trade-offs

The decision is essentially **who owns reconstruction** and **when it runs**.
The realistic options, with the tensions each carries:

### Client-side reconstruction

The client already builds an ordered `RenderItem[]` in `preprocessMessages`, a
pure sequential pass. A running task map could be folded in there with no new
data channel.

- *For:* no server changes, no new wire format, reconstruction happens exactly
  where render items are already assembled.
- *Against:* pushes accumulation logic onto the client, which is the
  memory-constrained, battery-constrained side, and which only ever holds a
  *slice* of the session. Off-window `TaskCreate`s simply aren't present
  client-side under the `tailCompactions: 2` default, so the client cannot
  resolve their subjects without an additional fetch. This is the option the
  maintainer leaned away from.

### Server-side injection (consistent with existing augments)

The server reconstructs the list and injects a snapshot (e.g. a `_taskSnapshot`
field) into the relevant task event(s), mirroring how `_diffHtml` is injected
into Edit. The client stays a pure renderer.

- *For:* matches an established pattern with four precedents; the client stays
  dumb; the full `Message[]` is already materialized server-side *before* the
  slice, so building the map is a linear scan over an array that already
  exists, costing no extra read/parse and retaining nothing after the request.
- *Against:* every existing inline augment is **self-contained per message** —
  this would be the first augment that carries **cross-message accumulated
  state**. That is the genuinely novel wrinkle and the part that feels "not the
  cleanest." It also has to be implemented in both the live and cold paths.
- *Cost shape:* the heavy part people fear (walking a huge session per load)
  does not exist — uuid resolution already happened, and only the rare `Task*`
  events carry meaningful state, so a task-only scan touches a tiny fraction of
  messages. Reconstruction must run over the **full** array *before* slicing so
  off-window creations resolve; this is free only because the full array is
  transiently in memory at that moment anyway.

### Persisted/cached reconstruction

Maintain the resolved list incrementally on the write path (the live stream
sees every task event) and store it (session-metadata or a sidecar) so cold GET
just reads it.

- *For:* cold reads do zero reconstruction.
- *Against:* introduces exactly the long-lived per-session state the rest of
  the system avoids. Likely premature unless profiling shows the task-only scan
  actually matters; tasks are few enough that it probably never will.

### Minimal stopgap (orthogonal to the above)

Register lightweight renderers for `TaskCreate`/`TaskUpdate` that show a
one-liner ("✓ Task 1 → completed", "+ Task: …") instead of raw JSON, with no
reconstruction at all.

- *For:* removes the ugly JSON blob immediately, tiny effort, compatible with
  any of the real solutions landing later.
- *Against:* not a real task-list view; it shows events, not state.

## Open questions

- **Snapshot granularity.** Inject the resolved list into *every* task event,
  or only the latest surviving one (render the current list once, near the
  bottom, rather than re-drawing it at each historical `TaskUpdate`)? Affects
  wire size and how history reads.
- **Off-window creations under the tail default.** If reconstruction runs
  server-side over the full array before slicing, this is handled; if any part
  is client-side, how does it resolve subjects for tasks created before the
  window without an extra fetch?
- **Drift / self-healing.** `TaskUpdate`'s `statusChange.from` lets a
  reconstructor detect when its map disagrees with reality; a `TaskGet`/
  `TaskList` result is a free full snapshot to resync from. Worth defining how
  much of this robustness is in scope vs. trusting the event stream.
- **Live vs. reload parity.** Whatever owns reconstruction has to behave
  identically on the streaming path and the cold GET path.
- **Provider scope.** This is a Claude-shape problem today. Does the chosen
  representation generalize to other providers' task/plan constructs (cf.
  `UpdatePlan`), or is it Claude-specific?

## Related

- [`rich-text-rendering.md`](rich-text-rendering.md) — the action-panel
  rendering pipeline and the server-side `_`-augment injection pattern this
  problem would likely reuse.
- [`ui-architecture.md`](ui-architecture.md) — rendering-boundary and
  shared-view decisions.
- [`cost-efficiency.md`](cost-efficiency.md) / [`memory-growth.md`](memory-growth.md)
  — the memory-conservative posture the constraints above derive from.
