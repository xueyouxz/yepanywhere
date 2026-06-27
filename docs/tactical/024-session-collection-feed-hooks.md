# Session Collection Feed Hooks

Status: Implemented

## Progress

- [x] 2026-06-27: Added `useGlobalSessionsFeed`, a rowless feed hook that owns
  `/api/sessions` fetches, stats/project side data, pagination, activity-event
  refetch triggers, and snapshot reporting into the collection.
- [x] 2026-06-27: Added query-state access for collection pagination and
  optimistic/prepend query-id updates for locally observed created sessions.
- [x] 2026-06-27: Moved Sidebar to `useSidebarSessionFeeds`, with rows still
  rendered only from collection projections.
- [x] 2026-06-27: Moved Global Sessions to `useGlobalSessionsFeed`, with rows
  rendered only from collection query records.
- [x] 2026-06-27: Moved Recent Sessions dropdown to `useGlobalSessionsFeed`
  plus collection query records.
- [x] 2026-06-27: Deleted the temporary `useGlobalSessions` compatibility
  wrapper and its obsolete hook-local row reconciliation test.

## Context

`006-client-session-collection-store.md` moved sidebar and Global Sessions row
rendering to the normalized client session collection. That fixed the original
split-brain row projection bugs, but at the start of this follow-on the old
`useGlobalSessions` hook still owned too many jobs:

- it fetches `/api/sessions`;
- it stores a private hook-local `sessions` array;
- it listens to activity events and mutates that private array;
- it reports snapshots/events into the collection;
- it returns rows, stats, project options, loading, errors, and pagination.

The desired end state is not a compatibility wrapper around that model. The
desired end state is to retire row-returning global-session hooks entirely.
Server query hooks should fetch and report data into the collection, but
rendered session rows should come only from collection selectors.

## Decision

Do not bring in React Query/SWR for this slice.

The hard part is not generic request caching. The hard part is YA-specific
session state reconciliation:

- REST snapshots are only one input;
- activity events and local successful row actions are also inputs;
- stale snapshots must not overwrite newer field groups;
- sidebar projections need active-row stable ordering;
- remote relay fetches must respect secure-connection readiness;
- missed events recover through later snapshots.

A generic query cache would still need to report every result into the session
collection. It would add another cache layer without removing the race policy.
Keep the repo's minimalist runtime posture and build the small feed layer we
actually need.

## Ownership Model

Separate the three responsibilities:

- **Session collection** owns session facts, observation timestamps, query ids,
  and derived projections.
- **Feed hooks** own readiness, REST fetches, pagination, stats/project option
  side data, and snapshot reporting.
- **UI surfaces** compose feed state with collection selectors; they do not own
  row arrays.

The invariant:

```ts
// Good: fetch/controller state from feed, row state from collection.
const feed = useGlobalSessionsFeed(options);
const rows = useSessionCollectionQueryRecords(feed.query);

// Bad: a data hook returns row objects that a view can render directly.
const { sessions } = useGlobalSessions(options);
```

Feed hooks may return query descriptors and control state. They should not
return session rows.

## Readiness Contract

Feed hooks are the right layer to answer "can this request happen yet?"

- Local mode can fetch when the app API client is available.
- Remote relay mode must wait until the secure connection is authenticated and
  open. Use the existing connection-readiness primitives from
  `021-client-connection-readiness-vs-state-consistency.md`; do not re-create a
  per-hook relay gate.
- A feed mounted while remote connection is connecting should not report an
  authoritative empty snapshot and should not show "no sessions" merely because
  the transport is not ready.
- Reconnect and visibility refresh should trigger reconciliation fetches when
  the feed is ready again. Those snapshots must merge into the collection using
  the existing request-started race policy.

The collection itself should not know about relay readiness or transport state.
It only reduces snapshots/events that actually arrive.

## Target Hook Shape

First target:

```ts
const feed = useGlobalSessionsFeed({
  projectId,
  searchQuery,
  includeArchived,
  starred,
  limit,
  includeStats,
});
```

Return shape:

```ts
{
  query: SessionCollectionQueryDescriptor;
  ready: boolean;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refetch: () => Promise<void>;
  stats: GlobalSessionStats;
  projects: ProjectOption[];
}
```

No `sessions` field.

Sidebar can use a composed wrapper:

```ts
const sidebarFeeds = useSidebarSessionFeeds();
const starred = useStarredSessionRecords();
const recent = useRecentSessionRecords();
const older = useOlderSessionRecords();
```

`useSidebarSessionFeeds()` owns the unfiltered and starred feed instances and
returns aggregate loading plus load-more controls. It returns no rows.

## Pagination

Do not keep a private hook-local row array just to compute cursors.

The feed should derive pagination from collection query state:

- query state owns ordered ids and `hasMore`;
- `loadMore` reads the last complete record for that query and uses its
  `updatedAt` as the current `/api/sessions?after=...` cursor;
- if the query has no ids, `loadMore` is a no-op and the caller should perform
  an initial `refetch`;
- if the last id has no complete record or no `updatedAt`, prefer refetching
  the first page over guessing.

If `/api/sessions` later grows a real opaque cursor, store that cursor in query
state and stop deriving the cursor from row timestamps.

## Event Handling

The feed layer can continue to subscribe to `activityBus` for fetch-side
concerns:

- report `session-created` and metadata events into the collection as a
  backstop when the feed observes them;
- debounce refetches when an event implies server-owned query membership may
  have changed, especially search/filter pages;
- refetch on reconnect/visibility refresh only when ready.

Reducers and selectors stay in the collection store. The feed should not
duplicate projection logic.

## Migration Plan

1. [x] Add `useGlobalSessionsFeed` beside `useGlobalSessions`.
   - Move fetch/pagination/stats/projects/error/loading into it.
   - Report snapshots into the collection.
   - Return no rows.
   - Use connection readiness through existing API/connection primitives.
2. [x] Add collection query-state accessors needed by pagination.
   - A hook such as `useSessionCollectionQueryState(query)` can expose ids and
     `hasMore` without exposing row arrays as feed-owned state.
3. [x] Move Sidebar to `useSidebarSessionFeeds`.
   - Sidebar rows stay on `useStarredSessionRecords`,
     `useRecentSessionRecords`, and `useOlderSessionRecords`.
   - Sidebar no longer imports `useGlobalSessions`.
4. [x] Move Global Sessions page to `useGlobalSessionsFeed`.
   - Rows stay on `useSessionCollectionQueryRecords(feed.query)`.
5. [x] Move Recent Sessions dropdown off `useGlobalSessions().sessions`.
   - Use a small feed plus query records, or a dedicated recent projection if
     the dropdown only needs simple recency.
6. [x] Delete `useGlobalSessions`.
   - No compatibility wrapper unless a short-lived branch needs it during the
     same patch series.
   - Remove hook-local session array reconciliation and event patching.

## Non-Goals

- Do not add React Query/SWR/Zustand for this slice.
- Do not move Inbox tier membership into the collection. Inbox ranking remains
  server-owned.
- Do not move process inventory ownership into the collection. Agents/process
  surfaces can report facts into the collection, but their inventory remains
  server-owned initially.
- Do not add polling loops.
- Do not make the collection depend on relay connection state.

## Verification Checklist

- [x] Sidebar cannot render hook-local rows because its feed wrapper exposes no
  row arrays.
- [x] Global Sessions renders rows only from collection query records.
- [x] Recent Sessions dropdown no longer consumes `useGlobalSessions().sessions`.
- [x] A remote relay feed mounted before secure connection readiness does not
  publish an empty authoritative snapshot.
- [x] `loadMore` works from collection query state after the first page.
- [x] Starring, archiving, and new-session creation still move sidebar projections
  immediately through collection events/reports.
- [x] Active starred and active recent sidebar rows do not reshuffle when their
  `updatedAt` values advance.
