# Client Session Lifecycle Store

Status: Proposed

Progress:

- [x] 2026-05-31: Captured the design direction for the first concrete
  client-state slice around activity stream consistency.
- [x] 2026-05-31: Added the first pure reducer/selector module with focused
  tests for lifecycle semantics, snapshot/event races, and strict idle.
- [x] 2026-05-31: Added a lazy `useSyncExternalStore` shell that subscribes
  to activityBus events, exposes lifecycle selector hooks, and accepts API
  snapshot reports without wiring UI consumers yet.
- [x] 2026-05-31: Wired existing `/api/sessions`, `/api/inbox`, and
  `/api/processes` fetch paths to report lifecycle snapshots into the store
  as shadow state. No visible UI consumers have moved yet.

## Context

Several UI surfaces currently derive "what is this session doing?" from
separate React hooks and local caches:

- compact sidebar session rows via `useGlobalSessions`;
- inbox tiers via `InboxContext`;
- the Agents page via `useProcesses`;
- session detail state via `useSession`;
- recent/session-title dropdown indicators;
- tab-title activity animation;
- `/btw` aside/session affordances.

These surfaces subscribe to the same activity stream, but they do not share a
single client-side lifecycle object. Each hook independently merges server
events, REST snapshots, local optimistic updates, and reconnect refreshes.
That makes stale activity bugs easy to create: one view may clear an idle
process while another keeps pulsing because its cache missed the event or an
older API response won a race.

The live sidebar stale-activity repro documented in
`docs/tactical/004-sidebar-session-activity-cache.md` is the immediate example.
The server was consistent: Claude owned an idle reusable process, not active
work. The client sidebar cache was stale.

There is a related but separate sidebar staleness class around collection
membership and list projections. The sidebar currently keeps separate
`useGlobalSessions` caches for the unfiltered recent/older list and the
`starred: true` list. A star action can update local item state, then the
metadata event removes the row from the recent projection while the starred
projection never adds it because that hook only patches rows it already has.
The visible result is that a starred session can disappear until a full refresh.
Similarly, newly created sessions can be delayed or missed when creation events,
initial list fetches, duplicate-title hiding, and reconnect refreshes race.

That second class is not primarily a lifecycle-state bug. It is a
collection/index consistency bug: "which sessions should this list contain?"
is being derived independently by multiple hook instances.

## Goal

Introduce a small shared client-side session lifecycle store so activity
indicators are consistent by design.

The first slice should not rewrite all client state. It should centralize only
the lifecycle overlay needed by session activity UI:

- ownership;
- active work state;
- waiting-input state;
- pending input type;
- unread/attention hints where already available;
- enough timestamps/source metadata to resolve event-vs-snapshot races.

React hooks should become selectors over this store for lifecycle display
state, while existing hooks can keep owning their broader data models.

## Design Shape

Keep the existing `activityBus` as the transport/event source:

- connect/reconnect;
- subscribe to server activity frames;
- emit raw typed events such as `process-state-changed`,
  `session-status-changed`, `session-seen`, and `session-updated`.

Add a new store near the activity/connection layer, conceptually:

```ts
type SessionLifecycle = {
  sessionId: string;
  projectId?: UrlProjectId;
  ownership?: SessionStatus;
  activity?: "in-turn" | "waiting-input";
  pendingInputType?: PendingInputType;
  hasUnread?: boolean;
  title?: string | null;
  customTitle?: string | null;
  updatedAt?: string;
  lifecycleObservedAt: number;
  snapshotObservedAt?: number;
};
```

The exact type can evolve, but the key invariant is that ownership and active
work are separate fields:

- `owner: self` means YA owns a reusable provider process.
- `activity: "in-turn"` means active work and may show a spinner.
- `activity: "waiting-input"` means attention is needed and should not show a
  working spinner.
- `idle`, `terminated`, and missing activity normalize to no active work.

Use React's `useSyncExternalStore` with a small hand-rolled store before adding
a runtime dependency. If the selector/action surface grows enough to justify a
library, this store becomes the concrete evidence for evaluating Zustand.

## Inputs

### Activity Events

The store should subscribe once to `activityBus` and reduce raw events into
lifecycle entries:

- `process-state-changed`
  - set `activity` to `"in-turn"` or `"waiting-input"`;
  - clear `activity` for inactive process states;
  - set `pendingInputType` only for `"waiting-input"`;
  - clear `pendingInputType` whenever activity leaves `"waiting-input"`.
- `session-status-changed`
  - update ownership;
  - if ownership becomes `none`, clear process activity and pending input.
- `session-seen`
  - set `hasUnread` false.
- `session-metadata-changed`
  - update custom title/archive/star fields if the store keeps them.
- `session-updated`
  - update derived title/message/update hints if the store keeps them.
- `session-created`
  - seed a lifecycle row if enough session summary data is present.

### API Snapshots

Existing hooks should report snapshots into the store as they already fetch:

- `useGlobalSessions` can upsert lifecycle fields from `/api/sessions`.
- `InboxContext` can upsert active/attention/unread hints from `/api/inbox`.
- `useProcesses` can upsert authoritative process activity from
  `/api/processes`, including idle owned processes.
- `useSession` can upsert focused session ownership/activity/liveness from
  session detail responses and stream events.

This avoids new polling loops. The store learns from requests the app already
performs.

The first wiring should stay conservative:

- `/api/sessions` rows are authoritative for the rows they return because
  they include ownership and current process activity.
- `/api/inbox` should report positive attention/active tier activity and
  unread/title hints, but should not use passive tiers as a broad idle
  authority. The inbox response is ranked and capped per tier, so absence from
  a tier is not a complete session inventory signal.
- `/api/processes` should report the active process inventory, including idle
  owned processes, but should not treat the recently terminated process list as
  current ownership for this slice.

## Race Policy

The store should make race handling explicit instead of leaving it to every
hook.

Recommended first policy:

- Event reductions record `lifecycleObservedAt = Date.now()`.
- Snapshot reporters pass a `requestStartedAt` timestamp captured before the
  API request begins.
- A snapshot may fill missing fields and update non-lifecycle metadata.
- A snapshot must not overwrite lifecycle fields with data older than the
  latest activity event for that session.
- Reconnect/visibility refresh snapshots still heal missed events because they
  start after reconnect and therefore have a newer `requestStartedAt`.

This is intentionally simple. If server event timestamps prove more reliable
than client observation time, the store can later compare server timestamps
with a fallback to observation time.

## Selectors

Provide small selectors that encode UI semantics once:

- `useSessionLifecycle(sessionId)` returns the raw entry or undefined.
- `useSessionActivity(sessionId)` returns:
  - `isWorking`;
  - `needsInput`;
  - `pendingInputType`;
  - `ownership`.
- `useAnySessionWorking()` returns whether any known session is `in-turn`.
- `useSessionLifecycleMap(sessionIds)` returns a stable map for list rows.

List components can still render their existing row data, but activity badges
should use the lifecycle selector result as an overlay.

The global lifecycle store should not model the session-detail-only
"settling" affordance used by the bottom processing message. A session detail
view may briefly keep a local "Thinking..." / fun-phrase indicator while the
latest visible turn settles after an idle boundary. Global selectors should
remain stricter: `isWorking` is true only for canonical `in-turn` lifecycle
state, and an idle event clears sidebar/dropdown/tab-title activity
immediately.

## Related Sidebar Collection Staleness

The lifecycle store is intentionally an overlay, not the canonical owner of
sidebar row membership. It can fix stale badges such as an idle session still
showing a spinner, but it should not be expected to fix every sidebar
disappearance or delayed row.

Observed/likely collection staleness cases:

- starring a session from the sidebar can move it out of the recent/older
  projection before the separate starred projection has fetched or inserted it;
- unstarring has the inverse risk for starred-only rows;
- archiving/unarchiving has similar membership implications;
- newly created sessions depend on `session-created` events and/or a later
  `/api/sessions` snapshot reaching every mounted list projection;
- duplicate-title hiding can make a newly created or newly updated row appear
  absent even when it is technically present in the cache.

These should be handled as a follow-on "session collection store" or
"global-session index" slice, not by overloading lifecycle state. That later
store would own normalized session rows plus query projections such as:

- all non-archived recent sessions;
- starred sessions;
- archived sessions;
- search/filter results;
- sidebar recent-day and older buckets.

It would receive the same event and snapshot inputs, but its invariant would be
membership and ordering rather than activity semantics. Inbox tier membership
is adjacent but should remain server-owned at first because it is a ranked
product surface, not just a local projection of `/api/sessions`.

## First Slice

Keep the first implementation narrow:

1. Add the lifecycle reducer/selectors and pure tests. Done in the first
   slice as `packages/client/src/lib/sessionLifecycleStore.ts`.
2. Add the external-store shell and subscribe it to `activityBus` events.
   Done as `packages/client/src/lib/sessionLifecycleExternalStore.ts`.
3. Wire snapshot reporter functions into the existing
   `useGlobalSessions`, `InboxContext`, and `useProcesses` fetch paths first.
   Done via `packages/client/src/lib/sessionLifecycleApiSnapshots.ts`.
4. Move compact sidebar/global-session activity indicators to the lifecycle
   selectors.
5. Move tab-title activity to `useAnySessionWorking()` instead of directly
   depending on inbox active count.
6. Keep the Agents page itself using `/api/processes` as its source of process
   inventory.
7. Do not solve starred/recent/sidebar membership in this slice, except where
   lifecycle selectors can make existing rows display correct activity.

This should make the current stale sidebar class harder to reproduce without
forcing a full session-data migration.

## Later Slices

- Add a normalized global-session collection store for sidebar/session-list
  membership, including starred/recent/archived projection consistency.
- Recent/session-title dropdown indicators read from the lifecycle store.
- Session detail header/process badges reconcile their local stream state into
  the same store.
- `/btw` aside sessions report child session activity into the store so parent
  and child indicators use the same semantics.
- Inbox tier rendering can optionally consume lifecycle selectors for badges,
  while keeping tier membership server-owned.
- Add diagnostics for lifecycle entries: source, last event time, last snapshot
  time, and conflict drops.

## Non-Goals

- Do not add a new runtime state-management dependency in the first slice.
- Do not replace `activityBus`; it remains the stream transport.
- Do not move full global session rows, inbox tiers, or process inventory into
  the store yet.
- Do not make the lifecycle store responsible for sidebar list membership,
  starred projections, archive projections, pagination, search, or duplicate
  hiding.
- Do not add server polling, new watchers, or per-session loops.
- Do not reinterpret `owner: self` as active work.
- Do not change Claude idle process ownership or provider lifecycle behavior.
- Do not make inbox tier membership the canonical lifecycle state in this pass.

## Verification Checklist

- An owned idle Claude process does not show a sidebar or dropdown spinner.
- An owned `in-turn` process shows working activity immediately across all
  lifecycle-backed indicators.
- A `waiting-input` process shows attention/input state and not a working
  spinner.
- A stale in-flight `/api/sessions` response cannot reintroduce working
  activity after a newer idle event.
- A missed idle event is healed by a reconnect or visibility-refresh snapshot.
- Agents page can continue to show idle owned Claude processes under "Idle".
- Tab-title activity, sidebar rows, and session dropdown indicators agree for
  the same session state.
- No new recurring client/server work is created when the relevant UI surfaces
  unmount.
- Starred/recent/sidebar membership bugs are tracked separately and not masked
  as lifecycle-store regressions.
