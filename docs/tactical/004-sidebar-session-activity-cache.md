# Sidebar Session Activity Cache

Status: Implemented

Progress:

- [x] 2026-05-31: Captured the live Claude stale-activity repro and the
  tactical client-side fix shape.
- [x] 2026-05-31: Added global-session process-state reconciliation that
  clears inactive sidebar activity, clears stale pending-input state, and
  refetches after missed or non-running transitions.

## Context

Claude sessions can keep an owned process alive after a turn finishes. That is
intentional: the provider process remains reusable, and `owner: self` means YA
spawned and owns the process. It does not mean the agent is currently working.

A live repro on 2026-05-31 showed a Claude session that was clearly complete:

- `/api/processes` reported the process as `idle`;
- `/api/sessions` returned ownership `self` but no `activity`;
- `/api/inbox` placed the session in `recentActivity`, not `active`;
- the session detail process modal showed `Activity: Idle`;
- the compact sidebar row still displayed the pulsing activity dot.

The bug is therefore a stale client cache in the sidebar global-session list,
not a server lifecycle bug and not a reason to stop keeping Claude processes
alive while idle.

## Tactical Fix

Keep the existing provider lifecycle intact and make the sidebar cache more
defensive:

- Treat process-state events as lifecycle evidence, not ownership evidence.
- Normalize inactive process-state events such as `idle` and `terminated` to no
  row `activity`.
- Clear `pendingInputType` whenever a session leaves `waiting-input`.
- Preserve `owner: self` for idle Claude sessions.
- If a process-state event arrives before the row exists in the global-session
  cache, schedule a refetch so the row is reconciled from the server snapshot.
- After non-running transitions, schedule a short debounced authoritative
  refetch so an older in-flight `/api/sessions` response cannot leave the row
  permanently stale.

This is intentionally a narrow client hardening pass. It should not add server
polling loops, change Claude idle ownership, or reinterpret `owner: self` as
active work.

## Longer-Term Direction

The repeated staleness class points to the need for a shared, authoritative
client lifecycle object that is not tied to individual React hooks.

Desired properties:

- one client-side session/process lifecycle store shared by sidebar, inbox,
  agents, session detail, tab-title activity, and notifications;
- server snapshots and activity events both reconcile into that store;
- lifecycle state distinguishes ownership, transport/process liveness,
  active turn state, waiting-input state, and unread/attention state;
- missed events are healed by snapshot reconciliation, not by each component
  inventing its own polling or merge rules;
- React hooks become selectors over the store instead of independent caches.

The likely implementation belongs near the activity bus / connection layer,
not inside the sidebar component. It should be revisited when we next touch
session liveness, client stream/reconnect behavior, or global session list
state.

## Verification Checklist

- An owned idle Claude process does not show a compact sidebar spinner.
- An owned in-turn process still shows the spinner immediately.
- A waiting-input process shows the approval/question badge and not the
  spinner.
- A missed idle event is healed by a follow-up global-session refetch.
- The Agents page can continue to show idle owned Claude processes under
  "Idle".
