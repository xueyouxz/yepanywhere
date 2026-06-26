# 021 - Connection readiness vs. client state consistency

Status: Tier 1 + Tier 2 (settings) implemented

Progress:

- [x] 2026-06-26: Documented the relationship between the connection-readiness
  fetch race (this doc) and the session lifecycle/consistency race
  ([005](005-client-session-lifecycle-store.md)) before implementing either.
- [x] 2026-06-26: Implemented Tier 1 (transport-level readiness gate).
  Added `whenConnectionReady()` to
  `packages/client/src/lib/connection/index.ts` — resolves with the current
  connection, resolves outstanding waiters on connect, fast-rejects them on
  teardown, and times out after `CONNECTION_READY_TIMEOUT_MS` (15s). `fetchJSON`
  (`packages/client/src/api/client.ts`) now awaits it in the remote-client build
  instead of throwing when the connection isn't ready yet. Unit tests in
  `packages/client/src/lib/connection/__tests__/whenConnectionReady.test.ts`.
  This unsticks the ~20 fragile on-mount fetches and "Refresh while connecting"
  with no per-hook changes. Tier 2 not started.
- [x] 2026-06-26: Narrowed the Tier 2 design after review. Rejected a broad
  refetch-on-reconnect (jank/footgun, especially on mobile). Tier 2 is now an
  opt-in, background-only revalidation (no loading state when data exists,
  staleness-deduped, merge-not-replace) applied to settings pages only; churny
  live surfaces heal via events/005 instead. See "Tier 2 design".
- [x] 2026-06-26: Implemented Tier 2 (settings only). Added
  `useBackgroundRevalidation` (`packages/client/src/hooks/useBackgroundRevalidation.ts`)
  — debounced, in-flight-guarded, applies only when data changed (deep-equal),
  never sets a loading state when data exists, swallows errors. Adopted in
  `useNotificationSettings`, `useSubscribedDevices`, `useBrowserProfiles`,
  `useRemoteExecutors`, `useServerInfo`, `useNetworkBinding` (gated on
  `!applying`), and `useServerSettings`. Also made `useConnectedDevices`'
  reconnect/refresh backstop quiet (no loading flash on the device list).
  Unit tests in `useBackgroundRevalidation.test.ts`. Deferred: folding
  `InboxContext`'s now-redundant `isRemoteConnectionReady` gate (its tests
  assert the old behavior — separate cleanup), and `usePublicShareStatus`
  (already self-revalidates via polling).

## Why this doc exists

A user report ("can't toggle notification settings over the relay; the test
button is missing") turned out to be one instance of a broad client bug class.
While scoping the fix we found a second, already-started workstream
([005](005-client-session-lifecycle-store.md)) that looks related but targets a
different failure. This doc records the distinction so we build the right fix and
do not conflate the two.

There are **two separate races**. They share some plumbing (`activityBus`
reconnect events) but have different causes, different blast radii, and different
fixes.

- **Race A — connection readiness.** "Can this request even happen yet?" A
  fetch fires before the relay connection exists, throws, and never retries.
- **Race B — state consistency.** "Given requests do happen, do all views agree?"
  A stale snapshot or a missed event leaves one view showing different activity
  than another. This is what 005 addresses.

## Race A: connection readiness (the immediate bug)

### Mechanism

In the remote-client build, every API call goes through `fetchJSON`, which
throws immediately if the encrypted relay connection is not yet established:

```ts
// packages/client/src/api/client.ts:230-241
const globalConn = getGlobalConnection();
if (globalConn) return globalConn.fetch<T>(path, options);
if (isRemoteClient()) {
  throw new Error("Remote client requires SecureConnection - not authenticated");
}
```

`globalConnection` is a module-level singleton set by
`setGlobalConnection()` only after SRP auth completes
(`packages/client/src/lib/connection/index.ts:57-71`;
`packages/client/src/contexts/RemoteConnectionContext.tsx`, direct path ~369,
relay path ~548). There is **no readiness promise or event** on the connection
layer — readiness is observable only as `connection !== null` in React context.

Nearly every data hook is `useEffect(() => fetchOnce(), [])` with a `catch` that
records an error and then **never retries and never waits**:

```ts
// packages/client/src/hooks/useNotificationSettings.ts:28-44 (representative)
useEffect(() => {
  const fetchSettings = async () => {
    try {
      const { settings } = await api.getNotificationSettings();
      setState({ settings, isLoading: false, error: null });
    } catch (err) {
      setState((s) => ({ ...s, isLoading: false, error: String(err) }));
    }
  };
  fetchSettings();
}, []);
```

So any hook that mounts during the connect/reconnect window dies and stays dead
until the component remounts.

### Why it looked like a Windows-only / intermittent bug

A full page load is safe because the app shell's `ConnectionGate`
(`packages/client/src/RemoteApp.tsx`) blocks page rendering until
`connection !== null`. But three paths bypass that guarantee and mount hooks
while the connection is still coming up:

- client-side navigation between routes,
- a backgrounded tab resuming,
- a reconnect after a drop.

The original report ("works against the Mac server, not the Windows server; then
started working after I visited the Mac tab and came back") was Race A losing the
timing on one tab and being healed by a remount on return — not a server-OS bug.
The relay routing and the Windows server push storage are both fine.

### Symptom mapping (notification settings)

`hasSubscriptions` is derived from a single `getPushSubscriptions()` fetch
(`packages/client/src/hooks/useSubscribedDevices.ts:38-61`). When that fetch dies
on a not-ready connection, `hasSubscriptions` stays `false`, which:

- disables the three server-notification toggles
  (`NotificationsSettings.tsx:396,414,432` — `disabled={... || !hasSubscriptions}`),
- hides the device-list test section/button
  (`NotificationsSettings.tsx:477` — `{hasSubscriptions && ( ... )}`).

(Separately, the per-toggle test row in `PushNotificationToggle.tsx` clips its
button under a cramped flex layout on narrow screens — a cosmetic issue tracked
apart from Race A.)

### Blast radius

~20 hooks share the fragile pattern. Settings pages are worst-hit because they
are exactly what a user opens over the relay:

| Page | Fragile hook(s) | Waits for conn? | Retries? |
|---|---|---|---|
| Notifications | `useNotificationSettings`, `useSubscribedDevices` | no | no |
| Devices | `useBrowserProfiles` | no | no |
| Remote Executors | `useRemoteExecutors` | no | no |
| Local Access | `useServerInfo`, `useNetworkBinding`, `useServerSettings` | no | no |
| Remote Access | `useServerSettings`, `usePublicShareStatus` | no | no |
| About / Providers | `useVersion`, `useProviders` | partial | no |

Other affected hooks: `useProjects`, `useRecentSessions`, `useOnboarding`,
`useGlobalSessions`, `useGlobalActiveAgents`, `useConnectedDevices`,
`useReloadNotifications`. The last four already subscribe to `activityBus`
reconnect events and so self-heal on a *re*-connect — but **not** on the initial
not-ready mount, because `onReconnect` fires only after a first successful
connect.

### Existing partial mitigations

- **`InboxContext`** (commit `98c0f039`) gates its fetch on
  `isRemoteConnectionReady = !isRemoteClient() || remoteConnection?.connection !== null`
  and lists it in the effect deps, so it fires once the connection is ready.
  This is the correct shape, applied to exactly one surface.
- **`activityBus`** emits `reconnect` / `refresh` (visibility) events. A handful
  of hooks refetch on them. Good for re-connects; does nothing for the initial
  race.

There is no data-fetching library (no react-query/SWR). Data fetching is hand
-rolled `useState` + `useEffect` + `refetch`.

## Race B: state consistency ([005](005-client-session-lifecycle-store.md))

005 targets a different failure: once data is flowing, separate hooks
(`useGlobalSessions`, `InboxContext`, `useProcesses`, `useSession`) each merge
events, REST snapshots, and reconnect refreshes independently, so views disagree
— e.g. an idle session keeps pulsing because one cache missed the idle event, or
a stale `/api/sessions` response wins a race and reintroduces a spinner, or a
starred row disappears from a list projection.

Its fix is a shared `useSyncExternalStore` lifecycle store fed by `activityBus`
events plus API snapshot reporters, with an explicit event-vs-snapshot **race
policy** (`lifecycleObservedAt` vs `requestStartedAt`). Crucially, that policy
**assumes the fetches succeed** and only reconciles their *ordering*. It says
nothing about waiting for the connection.

## How the two races relate

| | Race A (021) | Race B (005) |
|---|---|---|
| Question | Can the request happen yet? | Do views agree once requests happen? |
| Cause | Fetch before `SecureConnection` ready; throws; no retry | Independent per-hook merge of events/snapshots/reconnects |
| Worst surface | Settings pages (no session activity at all) | Sidebar/inbox/agents activity badges, list membership |
| Fix locus | Transport boundary (`fetchJSON` / connection layer) | Shared lifecycle store + race policy |
| Shared dependency | `activityBus` reconnect/visibility events | `activityBus` reconnect/visibility events |

Key intersection: **005 inherits Race A.** Its snapshot reporters are wired into
`useGlobalSessions` / `InboxContext` / `useProcesses` fetch paths. If those
initial fetches die on a not-ready connection, the lifecycle store simply gets no
snapshot — the same fragility one layer up. 005's "a reconnect/visibility refresh
heals missed events" guarantee only holds if the underlying fetch path is sound.

Therefore: **fixing Race A first de-risks 005.** They are complementary, not
competing. Race A makes fetches reliably happen; Race B makes their results
reliably consistent.

## Recommended shape of the Race A fix

Fix it once at the transport boundary rather than per-hook:

1. **Connection-ready primitive.** Add `whenConnectionReady(timeoutMs?):
   Promise<Connection>` to `packages/client/src/lib/connection/index.ts`.
   `setGlobalConnection(conn)` resolves the pending promise; clearing it (null,
   on disconnect) installs a fresh pending promise so the next call awaits the
   next connection.

2. **Await instead of throw.** Change `fetchJSON`'s remote-client throw branch to
   `await whenConnectionReady(timeout)` and then use the resulting connection.
   This unsticks every on-mount fetch *and* "Refresh while still connecting"
   (the inbox-refresh complaint) with no per-hook changes. A timeout preserves
   real error states so the UI never hangs forever.

3. **Conservative background revalidation (settings only).** Add an *opt-in*
   helper that quietly revalidates a hook's data when the connection
   re-establishes, and apply it **only to the settings pages** for now. See
   "Tier 2 design" below for why this is deliberately narrow and what makes it
   non-disruptive.

4. **Fold in the special-case.** Once (1)–(2) land, collapse `InboxContext`'s
   bespoke `isRemoteConnectionReady` gate into the general mechanism so there is
   one pattern, not two.

### Non-goals for Race A

- No new runtime data-fetching dependency (consistent with 005's stance).
- Do not replace `activityBus`; it stays the stream transport.
- Do not solve collection membership / stale-activity consistency here — that is
  005.
- Do not change the cramped test-row layout here — separate cosmetic fix.

## Tier 2 design: conservative background revalidation

Tier 1 fixed the urgent failure (initial load + "refresh while connecting").
Tier 2 only addresses the *softer* gap: "data loaded fine, the client was
disconnected for a while, and now it may be stale." The original sketch —
extract `useRefetchOnReconnect` and adopt it broadly — is **rejected** as too
aggressive. A blunt "refetch everything on every reconnect" is a footgun,
especially on mobile where reconnects are constant (screen lock, app
backgrounding, network handoff). The decision is to make revalidation gentle,
opt-in, and scoped to settings pages for now.

### Jank does not come from refetching — it comes from how the refetch lands

Three avoidable mechanisms, all of which a naive helper would hit:

1. **Showing a loading state on revalidation.** Flipping `isLoading: true` while
   data already exists swaps good content for a skeleton/spinner and can block
   interaction. This is the worst outcome. Revalidation must be
   stale-while-revalidate: keep showing existing data, fetch quietly, and never
   set a loading state when data is already present. Distinguish "no data yet"
   (may show loading) from "have data, revalidating" (must not).
2. **Replacing the whole collection reference.** `setState(newArray)` re-renders
   every row and can jump scroll position. Merge/patch with structural sharing so
   unchanged items keep their references.
3. **Refetching on blips that changed nothing.** A 2-second screen-off should do
   nothing. Dedupe by staleness (skip if fetched within the last N seconds)
   and/or only act on a meaningful gap. `connectionManager` already knows
   disconnect duration and `activityBus` already emits a distinct
   `visibilityRestored` / `refresh`, so the signal exists.

### Prefer events over refetch for the churny surfaces

The high-churn surfaces (session/inbox/agent lists) are exactly the ones a
wholesale refetch would make janky — and they are already event-driven through
`activityBus`. While disconnected you miss *events*, not *snapshots*; on
reconnect the right move is a **reconcile snapshot** that fills missing fields
and never overwrites newer state. That is precisely 005's race policy. A
reconcile-into-store patches deltas instead of replacing arrays, so it is
inherently low-jank. These surfaces should heal through events/005, **not**
through a Tier 2 refetch.

### What Tier 2 actually ships

- An **opt-in** helper (background-only: never sets `isLoading` when data
  exists; staleness-deduped; merges rather than replaces) — designed to be hard
  to misuse, not a global switch.
- Applied **only to the settings pages** (notification settings, devices,
  executors, local/remote access) for now. These are non-event-backed, rarely
  change, and are visually safe to update silently (e.g. a toggle value
  correcting itself is invisible). They are also the lowest-risk place to prove
  the pattern.
- Everything else stays as-is: event-backed surfaces heal via 005; we do **not**
  broaden the helper to lists/dashboards.

### Tier 2 non-goals

- No broad/global refetch-on-reconnect.
- No loading skeletons or interaction-blocking on revalidation of
  already-present data.
- Do not apply the helper to session/inbox/agent lists or other high-surface
  -area data; those go through events/005.

## Sequencing

1. **Done (Tier 1):** Race A transport gate — `whenConnectionReady()` +
   `fetchJSON` await + tests.
2. **Done (Tier 2, settings):** `useBackgroundRevalidation` helper (no loading
   state when data exists, staleness-deduped, apply-only-when-changed), adopted
   in the settings read hooks + a quiet `useConnectedDevices` backstop. See
   "Tier 2 design" above.
3. **Remaining cleanup:** fold the `InboxContext` `isRemoteConnectionReady` gate
   into the Tier 1 mechanism (its tests assert the old gate, so this is a
   separate change).
4. Continue 005 on top, now that snapshot reporters fire reliably. The churny
   live surfaces heal via events/005, not a Tier 2 refetch.
5. Cosmetic: notification test-row layout, tracked independently.
