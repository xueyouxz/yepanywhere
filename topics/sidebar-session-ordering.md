# Sidebar Session Ordering

> The sidebar session list must not reshuffle while the user is looking at it.
> Active sessions are pinned above idle ones in a stable order that does not
> reorder as their `updatedAt` churns; idle sessions sort by recency and may be
> deduped. Defines the two ordering regimes, why active rows must skip the
> recency sort and the duplicate-title grouping, where the stable order comes
> from, and the regression that this contract closes.

Topic: sidebar-session-ordering

See also: [ui-architecture](ui-architecture.md) (share the order at the data/render
boundary, don't re-sort per view), [session-liveness](session-liveness.md)
(what "active" means: `activity` = `in-turn` / `waiting-input`),
[scrollback-view-stability](scrollback-view-stability.md) (the same
"don't move what the user is reading" principle, applied to the transcript).

## The behavior we want

The sidebar (`packages/client/src/components/Sidebar.tsx`) shows three session
groups: **Starred**, **Last 24 Hours**, and **Older**. Active sessions can live
in **Starred** or **Last 24 Hours**, and both sections must use the same
active-row stability rule.

What the user wants, stated as the target:

1. **Active sessions are stable.** While one or more sessions are mid-turn, the
   sidebar must hold their order still. With several sessions active at once the
   list previously reshuffled every few seconds; that is the bug.
2. **Active sessions sit above idle ones.** A session the agent is working on is
   the thing the supervisor cares about, so the active group is pinned to the
   top of the Last 24 Hours section.
3. **Active sessions have no meaningful internal ordering — and that's fine.**
   The user explicitly does *not* want active rows sorted by any churning key.
   A brand-new session may appear at the top; an already-active session simply
   stays where it is. "Stable" beats "ranked."
4. **Idle sessions sort by recency and may be deduped where that section
   supports deduping.** Below the active group, idle sessions are ordered
   most-recent-first. Last 24 Hours and Older idle rows run through the
   duplicate-title grouping (the `(N hidden)` expander). They don't churn, so a
   recency sort over idle rows is safe.

## Why active rows must skip the recency sort

An active session bumps its `updatedAt` every few seconds for the whole turn.
Any comparator keyed on `updatedAt` therefore reorders the active rows on every
refetch — with N concurrent active sessions you get an N-way shuffle. The only
way to keep the active group stable is to **not sort it by a value that
changes**. So the active group is rendered in a *preserved* order, never sorted.

The stable order used to come from `useGlobalSessions`
(`packages/client/src/hooks/useGlobalSessions.ts`), which preserves order across
refetches: on a non-initial fetch it updates each session **in place** in its
existing position and only prepends genuinely-new session ids:

```js
const updated = prev.map((existing) => newDataMap.get(existing.id) ?? existing);
const filtered = updated.filter((s) => newDataMap.has(s.id));
const newSessions = data.sessions.filter((s) => !existingIds.has(s.id));
return [...newSessions, ...filtered];
```

After the sidebar moved to the session collection store, the same rule is owned
by `selectRecentSessionRecords` and `selectStarredSessionRecords`
(`packages/client/src/lib/sessionCollectionStore.ts`). The selectors record
when a row enters active state (`activeStartedAt`) and sort active rows by that
stable timestamp, while idle rows sort by `updatedAt`. A brand-new active
session may appear at the top; an already-active session must not move merely
because its `updatedAt` advances.

## Why active rows must skip the duplicate-title grouping

The idle path groups sessions by `(provider, projectId, normalized-title)` and
hides all-but-the-best of each cluster behind a `(N hidden)` expander, keeping
the one with the highest `messageCount`. Run over active sessions, that could
**hide a live, in-progress session** merely because another session shares its
title — a supervisor must never lose sight of running work. Active sessions are
also few, so there is no decluttering benefit. They are therefore split out
*before* `groupDuplicateSessions` is called and rendered in full.

## Implementation

`isActiveSession(session)` (module-level in `Sidebar.tsx`) is the single
predicate: `activity === "in-turn" || activity === "waiting-input"`.

The collection selectors use the equivalent predicate and return active rows
first:

```js
const active = records
  .filter((record) => isActiveActivity(record.activity))
  .sort(byActiveStartedAtDesc);
const idle = records
  .filter((record) => !isActiveActivity(record.activity))
  .sort(byUpdatedAtDesc);
return [...active, ...idle];
```

The Last 24 Hours render path then splits active rows out before deduping:

```js
const recentActive = recentDaySessions.filter(isActiveSession); // pinned, stable, never deduped
const idle = recentDaySessions.filter((s) => !isActiveSession(s));
const { visible, hidden } = groupDuplicateSessions(idle);       // recency sort + (N hidden) on idle only
```

Render order within Last 24 Hours: `recentActive` → `visible` → the `(N hidden)`
expander. The section and the empty-state guard both account for
`recentActive.length` so an active-only list is neither hidden nor mislabeled
"no sessions".

Starred rows are not deduped, but they still use the same selector-level
active-first ordering.

The **Older** section needs no active handling: an active session has a fresh
`updatedAt` and so is never older than 24h by construction.

## Contracts / invariants

- An active session's row position must not change due to its own `updatedAt`
  advancing. Only a real set change (a session entering/leaving the active
  group, or a brand-new session) may move active rows.
- Active sessions are never hidden behind the duplicate-title `(N hidden)`
  expander, regardless of shared titles or `messageCount`.
- Active sessions render above idle sessions in Starred and Last 24 Hours.
- The stable order is owned by the collection selectors. Views consume that
  order; they must not re-sort active rows by a churning key. Recency sorting
  is confined to idle rows.
- Idle rows may be deduped and sorted by `updatedAt` — they don't churn, so this
  is safe and is the desired recency behavior.

## Regression history

Before commit `7fc9d17c` ("Client: hide duplicate-title sessions behind
(N hidden) expanders"), the sidebar rendered `recentDaySessions.map(...)`
directly and inherited the hook's stable order, so active sessions did not
shuffle. That commit introduced `groupDuplicateSessions`, whose
`visible.sort((a,b) => updatedAt desc)` re-sorted the *entire* recent list —
including active rows — on every refetch, defeating the hook's preservation and
reintroducing the every-few-seconds shuffle for concurrently-active sessions.
The `(N hidden)` feature is the regression vector the user suspected; splitting
active rows out of that path is the fix.

After the session collection migration, Starred briefly regressed the same
contract by sorting all starred rows by `updatedAt`. Active starred rows could
therefore trade places during a turn. The selector now uses the same active-
first stable ordering as Last 24 Hours.
