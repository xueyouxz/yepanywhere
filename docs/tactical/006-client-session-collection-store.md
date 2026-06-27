# Client Session Collection Store

Status: Row-returning global session hook retired / inventory consumers next

## Progress

- 2026-06-27: Added the normalized collection reducer/selectors, lazy
  React external-store shell, activity-bus reducers, and `useGlobalSessions`
  snapshot reporting as a shadow slice.
- 2026-06-27: Removed the inert lifecycle-store slice so lifecycle facts live
  on the session collection entity instead of a parallel overlay.
- 2026-06-27: Migrated the sidebar's Starred, Last 24 Hours, and Older
  buckets to collection selectors while keeping the existing
  `useGlobalSessions` hooks mounted as fetch/pagination feeders.
- 2026-06-27: Migrated the Global Sessions page to query-backed collection
  records while keeping `useGlobalSessions` as the server fetch, stats,
  project-list, and pagination owner.
- 2026-06-27: Closed the first sidebar migration gap: local row actions and
  `useGlobalSessions` event handlers now report created/metadata events into
  the collection directly, so starred rows and newly-created rows do not depend
  solely on a later server broadcast or REST recovery snapshot.
- 2026-06-27: Added rowless session feed hooks and migrated Sidebar plus Global
  Sessions fetch ownership to them.
- 2026-06-27: Migrated the Recent Sessions dropdown to the feed-plus-collection
  pattern and deleted the row-returning `useGlobalSessions` compatibility
  wrapper. `024-session-collection-feed-hooks.md` is now complete.

## Context

`005-client-session-lifecycle-store.md` proposed a small React-compatible store
for lifecycle facts: ownership, active work, waiting-input, and unread hints.
The first shadow implementation had no production UI consumers and overlapped
with this broader collection-store model, so it has been removed. This store is
the successor: it owns basic session facts, lifecycle fields, and list/query
membership together instead of keeping a parallel lifecycle overlay.

The sidebar now has a related collection consistency problem:

- new sessions can arrive through `session-created`, then disappear when a
  stale `/api/sessions` response does not include the provider transcript yet;
- starring a session updates one row, removes it from the recent/older
  projection, and waits for a separate starred-filtered hook to learn about it;
- other tabs can miss ephemeral activity events and rely on later REST
  snapshots to recover.

This is not primarily a transport problem. `activityBus` is still the fast
event source, and REST snapshots remain the durable reconciliation source. The
missing piece is one client-side collection object that owns basic session
facts and derives list projections from those facts.

## Goal

Add a normalized client-side session collection:

```ts
entities: Map<sessionId, SessionCollectionRecord>
queries: Map<QueryKey, SessionCollectionQueryState>
```

`entities` is the best-known local snapshot for each session. `queries` stores
server result membership and pagination metadata as ordered session ids, not
duplicated row objects.

The implementation can use React's `useSyncExternalStore`, but that is plumbing.
The product concept is a Backbone-like session collection that works with
React.

## Inputs

The collection should reduce the same inputs the UI already receives:

- `/api/sessions` snapshots:
  - upsert returned rows into `entities`;
  - replace or append the relevant query's ordered ids;
  - do not delete unrelated entities simply because a filtered/paginated
    response omitted them.
- `session-created`:
  - seed an event-created entity immediately;
  - keep it visible in simple projections until an authoritative later event or
    snapshot supersedes it.
- `session-updated`:
  - patch title, message count, updated timestamp, model, and hover excerpt.
- `session-metadata-changed`:
  - patch custom title, starred, archived, parent, and effective project fields;
  - move derived projections atomically because they read one canonical entity.
- `session-status-changed` and `process-state-changed`:
  - patch ownership and activity fields, using the same stale-snapshot race
    policy originally sketched for the lifecycle store.
- `session-seen`:
  - clear unread state.

No new polling loop is required. Existing fetch paths and activity events feed
the store.

## Race Policy

Each reducer records observation timestamps for the field group it owns:

- metadata fields (`isStarred`, `isArchived`, `customTitle`, parent/project);
- lifecycle fields (`ownership`, `activity`, `pendingInputType`);
- content fields (`title`, `messageCount`, `updatedAt`, model/excerpt);
- unread fields.

Snapshot reporters pass `requestStartedAt`, captured before the HTTP request.
Snapshots may fill missing fields, but must not overwrite a field group changed
by a newer event. A reconnect or visibility-refresh snapshot starts after the
missed event window and can therefore heal stale local state.

Query result replacement is scoped to the query key. A response for
`starred=true` must not imply that a row no longer belongs to the unfiltered
recent query, and a short first page must not imply that older entities do not
exist.

## Query Shape

Query keys should represent the server request shape, excluding cursor-only
pagination state:

```ts
{
  scope: "global-sessions",
  projectId?: string | null,
  searchQuery?: string,
  limit?: number,
  includeArchived?: boolean,
  starred?: boolean
}
```

The query stores ids plus pagination state:

```ts
{
  key: string,
  ids: string[],
  hasMore: boolean,
  requestStartedAt: number,
  fetchedAt: number
}
```

Selectors can either read query ids for server-owned result ordering or derive
simple local projections from `entities`:

- starred sessions;
- non-archived recent sessions;
- older sessions;
- a single session by id.

Search and complex filtered pages should stay query-backed at first. Inbox tier
membership should remain server-owned because it is a ranked product surface,
not a plain projection.

## Migration Plan

1. [x] Add the collection reducer/selectors and tests with no UI consumers.
2. [x] Add a lazy external-store shell, subscribing once to `activityBus`
   while there are mounted consumers.
3. [x] Wire existing `useGlobalSessions` fetches to report snapshots into the
   store. This keeps current UI behavior unchanged while the store runs as
   shadow state.
4. [x] Move the sidebar to collection selectors first. It has the clearest
   projection bugs and the fewest filter dimensions.
5. [x] Move Global Sessions page next. Keep pagination/query ids server-owned.
6. [ ] Keep InboxContext and Agents page as server-owned inventories initially,
   but let them report snapshots into the collection store.
7. [x] Retire row-returning `useGlobalSessions` in favor of purpose-built feed
   hooks. See `024-session-collection-feed-hooks.md`.

## Non-Goals

- Do not add Zustand or React Query in the first slice. A hand-rolled store is
  enough to prove the state model.
- Do not replace `activityBus`; it remains the event transport.
- Do not add a parallel lifecycle store. Lifecycle facts are fields on the
  session collection entity.
- Do not make activity events durable. Missed events are healed by REST
  snapshots.
- Do not move inbox tier membership into the collection store.
- Do not rewrite session detail transcript state.
- Do not solve feed-hook readiness/pagination cleanup in this doc; that is the
  follow-on tracked in `024-session-collection-feed-hooks.md`.

## Verification Checklist

- `session-created` followed by an older empty `/api/sessions` snapshot keeps
  the entity.
- `starred: true` moves a row into starred selectors without waiting for a
  separate starred fetch.
- `starred: false` removes a row from starred selectors and makes it eligible
  for recent/older selectors.
- A stale snapshot cannot undo a newer metadata event.
- Query result ids update without duplicating row objects.
- Row-returning `useGlobalSessions` is gone; migrated surfaces use rowless
  feed hooks plus collection selectors.
- Sidebar active rows remain pinned above idle rows and do not reshuffle merely
  because `updatedAt` advances during an active turn.
- Global Sessions renders rows from the collection query for its current
  server request shape, while filters and pagination still follow the existing
  page behavior.
- Starring from a list row emits a local metadata event after the API succeeds,
  letting the collection move the row into starred projections immediately.
- A hook-observed `session-created` event reports the entity into the
  collection directly, and an older empty `/api/sessions` snapshot does not
  remove it.
