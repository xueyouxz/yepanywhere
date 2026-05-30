# Session Liveness And Queue Intent

This topic covers YA's provider/session liveness contract and the features
that depend on it, especially heartbeat turns, deferred queue promotion, and
patient queue intent.

Related topic: [heartbeat ownership and timers](heartbeat.md).

## Contracts

- Transport liveness, process liveness, provider progress, and user intent are
  separate signals. A connected browser, ticking heartbeat, live child process,
  or detached background job is not proof that the active agent turn is still
  progressing.
- `SessionLivenessSnapshot` is the provider-neutral summary. It must carry raw
  evidence timestamps and a conservative derived status so clients can show
  uncertainty instead of inventing progress from silence.
- `verified-idle` is the only liveness status that means YA may safely treat a
  session as idle for automatic work. Synthetic heartbeat turns may also run as
  explicit steering-capable doubt probes after their quiet period, but that is
  a heartbeat-specific contract rather than a general idle claim.
- Heartbeat turns are idle-timeout checks, not wall-clock ticks. Once a session
  is `verified-idle`, the timeout anchor is the latest real provider/session
  liveness signal, including verified idle/progress, normalized provider
  messages, raw provider cadence, or successful provider probes; client
  transport heartbeats do not reset this timer.
- `verified-waiting-provider` means an active probe confirms the provider still
  owns the turn even though no user-visible progress has arrived recently.
  Queue controls may remain available, but the UI must not imply that a
  natural boundary has been reached.
- Raw provider/app-server events are cadence and debugging evidence, not proof
  of user-visible progress. They should be visible in snapshots/tooltips, but a
  recent raw event alone must not upgrade a stale active turn.
- `stream_event` transport traffic alone is not user-visible progress. A stale
  active turn should move to `verified-progressing` only when the stream event
  carries user-visible content (for example text/thinking delta content), not
  for envelopes that only describe connection state.
- Use the explicit term **user-visible liveness** for this upgrade gate: only
  content that is actually rendered to the user qualifies as progress.
- Provider control-channel probes may verify that a provider runtime is still
  responsive while the active turn is silent. They should be labelled by source
  and detail, and should not be described as user-visible progress.
- `long-silent-unverified` and `needs-attention` are product-visible states.
  They should not be hidden behind calm queue wording or spinner animation.
- Background or detached tool handles count as useful session context only
  when YA can tie them to a currently awaited foreground tool result. Detached
  jobs alone are not liveness evidence for the agent turn.
- Provider process/server liveness is weak evidence. It may explain why a
  session can still be recovered or queried, but it must not upgrade a silent
  active turn unless the provider exposes a real active-turn status signal.
- OpenCode `/session/status` is a real active-turn status signal for that
  provider. `busy` and `retry` entries are active evidence, `idle` and missing
  entries mean no active OpenCode work is reported for that session, and
  malformed present entries are probe errors rather than idle proof.
- OpenCode `session.status` and `session.idle` SSE events are raw
  provider-cadence/status evidence. They may reset idle quiet-period timers and
  help explain a silent turn, but raw SSE cadence alone should not become
  user-visible progress without a normalized message or active status probe.
- Patient queue intent is message intent, not scheduling proof. `Queue when
  done` should keep the message in the parent session and make the patience
  marker visible in the queued text; it should not steer the active turn or
  route through `/btw`.
- User-message composition timing and delivery intent are YA-owned metadata.
  They describe what the user did and intended, not whether the provider is
  alive, and provider adapters should forward them only through a real
  structured channel or through an explicit prompt-visible product decision.
- New-session initial prompts accepted by YA should remain recoverable from
  session history even if provider startup fails before transcript persistence.
  Lists and details may use metadata or the first-message full title as the
  copy source, but should not require the provider JSONL to exist first.

## Invariants

- Provider adapters may add stronger evidence, but weaker evidence must not
  upgrade a session to `verified-progressing` or `verified-idle`.
- Active probes are rate-limited and separate from stale-process termination.
  A failed or contradictory probe should update liveness evidence before any
  destructive recovery policy is considered.
- Probe timeouts must resolve into liveness evidence. A hung probe must not
  leave YA silently believing verification is still underway forever.
- Synthetic heartbeat turn scheduling must reset from the latest real
  provider/session signal while idle. It must not fire merely because the first
  idle timestamp is old when the provider/app-server has emitted newer
  liveness evidence.
- If a provider probe says the turn is idle while YA is still blocked in an
  active turn, the adapter should reconcile through the normal provider event
  path whenever possible. That keeps transcript, queue promotion, and client
  status semantics aligned.
- Patient queue prefixing is applied at queue time. Sending, steering, and
  non-patient queue paths must not silently inherit the patience marker.
- A raw event timestamp may explain that the provider transport is still
  emitting JSON-RPC traffic, but derived liveness still needs a normalized
  provider message, awaited tool lifecycle, or explicit active probe to claim
  progress.
- An OpenCode status map with no entry for the current session is different
  from a malformed entry for that session. Missing means no active entry;
  malformed means the provider contract is not understood and the probe should
  surface an error.
- OpenCode text parts must be interpreted through the corresponding
  `message.updated` role metadata when it is available. A user text part is not
  assistant progress and should not be rendered as an assistant message.
- OpenCode 1.14.39 may also emit `message.part.delta` SSE events. YA should
  continue treating `message.part.updated` as the canonical text-part event
  unless the adapter deliberately grows a separate delta-event path; raw delta
  cadence alone is not a stronger liveness proof.
- User-message metadata should survive REST acceptance, optimistic/replayed
  user echoes, and deferred queue summaries without becoming hidden prompt text.
- Deferred messages promoted at a natural turn boundary should produce the
  same user-message echoes as direct queue acceptance, even when a
  non-steering provider receives the promoted backlog as one concatenated
  provider turn. Client recovery must reconcile each visible queued chip
  against that concatenated turn rather than treating unmatched localStorage
  state as still pending.
- Initial-prompt recovery metadata is a copy/retry affordance. It must not
  replace transcript messages or be treated as provider progress evidence.

## Representative Change Types

- Adding a provider-specific status probe or raw event cadence source.
- Changing the reducer that derives `SessionLivenessSnapshot.derivedStatus`.
- Changing heartbeat turn gating, doubt-probe boundaries, or deferred queue
  promotion boundaries.
- Changing composer queue controls, patient/default queue mode, or queued text
  transformation.
- Adding user-message timing or delivery-intent metadata.

## Tests That Should Fail On Contract Regressions

- An idle process with contradictory active-provider evidence becomes
  `needs-attention`, not `verified-idle`.
- A stale active turn with recent active-provider evidence becomes
  `verified-waiting-provider`, not `long-silent-unverified`.
- A stale active turn with only a recent raw provider event stays
  `long-silent-unverified`.
- A stale active turn with a stream_event envelope but no user-visible progress
  stays `long-silent-unverified`.
- A stale active turn with no usable probe stays unverified.
- OpenCode `busy` and `retry` `/session/status` entries become active probe
  evidence, while an unrecognized present entry becomes probe error evidence.
- OpenCode user text parts do not become assistant messages when
  `message.updated` identifies the message role as `user`.
- Heartbeat turns queue from `verified-idle`, or from the heartbeat topic's
  explicit steering-capable doubtful-liveness path.
- Heartbeat turns remain deferred until the configured quiet period has elapsed
  since the latest real liveness signal, not merely since the first idle
  boundary.
- Patient queue prefixes exactly once, while ASAP queue and steering preserve
  the user's text.
- Deferred queue summaries preserve accepted delivery intent and composition
  timestamps for reconnecting clients.
- A failed or not-yet-persisted new session with an accepted initial prompt
  exposes a copy action for that prompt in session history.
- Claude control probes time out and surface errors rather than relying on
  process-alive as proof of progress.
