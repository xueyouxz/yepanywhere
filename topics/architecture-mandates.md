# Architecture Mandates

> YA's load-bearing architecture requirements must be explicit enough that
> future provider, transport, and client changes preserve bounded resource use,
> recoverability, and user-visible state correctness.

Topic: architecture-mandates

## Resource Quiescence

An idle provider session with no active client tab must never create unbounded
or repeating server work. Closed tabs must release server subscriptions, file
watchers, poll timers, retry timers, client-owned heartbeats, and queued
catch-up work. A provider process may remain recoverable or queryable, but it
must not spin merely because a prior UI view existed.

The resource owner for every recurring server action must be explicit:

- client-owned watches and streams are reference-counted and torn down on
  disconnect;
- provider-owned processes stop polling once the provider is verified idle or
  terminated, unless a bounded recovery operation is currently running;
- global background jobs have fixed cadence, bounded per-tick work, and no
  per-session loops created by stale client state;
- client retry/catch-up paths coalesce in-flight requests and avoid turning
  one provider event into repeated REST reads.

## Review Checklist

- Every poll, retry, heartbeat, watch, and catch-up path has a teardown path.
- Closed WebSocket/EventSource subscriptions remove server-side subscribers
  and clear timers.
- Idle sessions do not schedule per-session server work without a live owner or
  a bounded recovery reason.
- Session-detail reads for incremental refreshes reuse cached parse state or
  have instrumentation proving the remaining work is bounded enough.
- Client-side reconnect and catch-up logic cannot create overlapping request
  storms against the same session.
