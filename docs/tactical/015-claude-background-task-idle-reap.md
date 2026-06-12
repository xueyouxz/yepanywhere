# Claude Background Task Idle Reap

Status: Proposed.

Progress:

- [x] 2026-06-12: Captured the incident evidence from a live Claude session
  that YA reaped while Claude-owned background work was still capable of
  waking the agent.
- [ ] Bump the default owned-process idle reap timeout from 5 minutes to 20
  minutes as an immediate risk reducer.
- [ ] Wire Claude SDK background-task and scheduled-wakeup evidence into
  owned-process retention.
- [ ] Add regression coverage so an owned Claude process with pending
  provider-owned wakeups is not idle-reaped.
- [ ] Keep explicit operator configuration authoritative: an `IDLE_TIMEOUT`
  env override must continue to win over the new no-config default.

## Problem

YA currently treats a Claude SDK `result` message, and Claude
`system/session_state_changed` with `state: "idle"`, as enough to transition
an owned `Process` into YA's idle state. The idle reaper then terminates that
process after `DEFAULT_IDLE_TIMEOUT_MS`, currently 5 minutes, unless another
retention feature such as a live delta subscriber or heartbeat retention is
active.

That conflates two different concepts:

- foreground turn boundary: Claude has stopped the current visible model turn;
- provider quiescence: Claude has no registered background task, cron, loop,
  or other provider-owned wakeup that can continue the session without another
  user prompt.

Claude background tasks can produce tool results after an `end_turn` /
`result` boundary and wake the agent again. Reaping the process during that
window breaks the Claude SDK control stream while the provider still believes
the session is alive.

## Incident Evidence

Observed session:

- YA session id:
  `577ffc1c-13ec-436f-b608-f2341a6b53aa`
- YA URL:
  `projects/QzovVXNlcnMvdXNlci9Eb2N1bWVudHMvY29kZS9wbGF5Ym94/sessions/577ffc1c-13ec-436f-b608-f2341a6b53aa`
- Project path decoded from the YA project id:
  `C:/Users/user/Documents/code/playbox`
- Claude JSONL:
  `C:/Users/user/.claude/projects/C--Users-user-Documents-code-playbox/577ffc1c-13ec-436f-b608-f2341a6b53aa.jsonl`

YA resumed the correct Claude session. The live Windows process was launched
with:

```text
claude.exe --resume 577ffc1c-13ec-436f-b608-f2341a6b53aa --model claude-fable-5 --permission-prompt-tool stdio ...
```

So the bug was not a provider-native id replacing the YA id, and not an
unknown external Claude process taking over the session.

Timeline from the incident:

- `2026-06-12T22:08:12.976Z`: Claude background task
  `bp6j0f702` was registered in the JSONL.
- `2026-06-12T22:08:54.507Z`: Claude background task
  `b2j56ihf0` was registered.
- `2026-06-12T22:09:32.701Z`: Claude background task
  `biowuf4pf` was registered.
- `2026-06-12T22:09:37.507Z`: Claude emitted an assistant message with
  `stop_reason: "end_turn"` and text saying it was waiting for the build to
  complete.
- `2026-06-12T22:09:37.569Z`: YA marked the owned process idle.
- `2026-06-12T22:14:37.303Z`: a background tool result arrived:
  `test result: ok. 30 passed...`.
- `2026-06-12T22:14:37.580Z`: YA reaped and unregistered the process.
- After the reap, Claude continued appending to the transcript and attempted
  more tool calls. Those failed with `Tool permission request failed:
  Error: Stream closed`.
- `2026-06-12T22:16:51.537Z`: Claude finally reported that it was blocked
  because the permission prompt stream had closed.

The process record observed through YA showed:

- process id: `5b98248a-6592-48d5-9da3-5156752fc26c`
- provider: `claude`
- session id: `577ffc1c-13ec-436f-b608-f2341a6b53aa`
- state: `terminated`
- idle since: `2026-06-12T22:09:37.569Z`
- terminated at: `2026-06-12T22:14:37.580Z`
- liveness: `verified-idle`

The apparent external-session transition was therefore a downstream symptom:
YA stopped owning the process while the real Claude process continued briefly
and kept writing to the JSONL.

## Current Code Bearings

Relevant implementation points:

- `packages/server/src/supervisor/Process.ts`
  - `message.type === "result"` calls `transitionToIdle()`.
  - Claude `system/session_state_changed` with `state: "idle"` also calls
    `transitionToIdle()`.
  - `transitionToIdle()` starts the idle reap timer.
- `packages/server/src/supervisor/types.ts`
  - `DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000`.
- `packages/server/src/config.ts`
  - normal startup passes `config.idleTimeoutMs` into the supervisor, so the
    `IDLE_TIMEOUT` default there must move with `DEFAULT_IDLE_TIMEOUT_MS`.
- `packages/server/src/supervisor/Process.ts`
  - idle reaping calls the provider abort function.
- `packages/server/src/sdk/providers/claude.ts`
  - YA uses the Claude Agent SDK `query()` stream.
  - On Windows, the custom spawn wrapper uses `shell: true`; the captured PID
    can be a shell/wrapper process rather than the final `claude.exe`.

There is prior intent in commit `676747c0 Fix idle Claude session reaping` to
reap idle processes unless a concrete retention feature is active. This
incident shows that Claude background tasks and scheduled wakeups must be
treated as concrete retention features for owned Claude sessions.

## Claude SDK Evidence

The installed SDK is `@anthropic-ai/claude-agent-sdk@0.3.170`, with Claude Code
version `2.1.170`.

The ordinary `SDKResultMessage` does not include background-task or scheduled
wakeup metadata. Treating `result` as provider quiescence is therefore unsafe.

The SDK does expose the needed concepts:

- `StopHookInput.background_tasks?: BackgroundTaskSummary[]`
  - SDK docs say this represents in-flight background work and lets hooks
    distinguish "session is done" from "session is paused waiting for
    background work to wake it".
- `StopHookInput.session_crons?: SessionCronSummary[]`
  - SDK docs say this represents session-scoped cron tasks, `ScheduleWakeup`,
    and `/loop` work that will wake the session later.
- The SDK stream also has task lifecycle system messages:
  `task_started`, `task_updated`, `task_progress`, and `task_notification`.
  Current SDK typings expose:
  - `task_notification.status`: `completed`, `failed`, `stopped`;
  - `task_updated.patch.status`: `pending`, `running`, `completed`, `failed`,
    `killed`, `paused`;
  - `task_updated.patch.is_backgrounded?: boolean`.
- The SDK comment for `session_state_changed idle` says it is an authoritative
  turn-over signal after held-back result flushing and the background-agent
  loop exits. That is useful, but it is still a turn-over signal, not a
  standalone "nothing can wake this session later" signal.

Important distinction:

- `backgroundTasks()` in the SDK is an action that backgrounds foreground
  tasks. It is not an introspection API.
- A no-op Stop hook can be used as an observational hook to capture
  `background_tasks` and `session_crons` without changing the transcript or
  model behavior. Implementation must return the minimal continue/neutral hook
  output and avoid `additionalContext`, `decision`, or any other field that
  could alter the model turn.

## Tactical Mitigation

First step: increase the no-config default idle reap timeout for owned
provider processes from 5 minutes to 20 minutes.

Rationale:

- The incident reaped at almost exactly 5 minutes after the apparent idle edge.
- Background builds/tests commonly finish just after a few minutes.
- A 20-minute timeout reduces the chance of breaking active Claude work while
  the correct retention model is implemented.
- This is only a mitigation. It does not make `result` a quiescence signal.
- Existing explicit `IDLE_TIMEOUT` deployments should keep their configured
  value; this is a new-install/no-env default, not a configuration precedence
  change.

Guardrail for this mitigation: do not remove idle reaping entirely. The
architecture mandate still stands: an idle provider session and a closed client
tab must not indefinitely consume server resources.

## Correct Solution

Introduce explicit provider-retention evidence for Claude. A Claude-owned
process should not be reaped while any known provider-owned wakeup remains.
The useful internal question is not whether the session is "done forever";
with session crons and loops that may be unknowable. The question is whether
the process is **reap eligible now**.

Candidate retention model:

- Add a provider-retention snapshot surface from the Claude provider to
  `Process`, rather than hiding the decision only in the supervisor-level
  heartbeat/feature retention callback. Provider-owned wakeups are lifecycle
  evidence of the running process itself.
- Track the latest Stop hook snapshot for the session:
  - `background_tasks.length > 0`
  - `session_crons.length > 0`
- Track live SDK task lifecycle messages as supporting evidence:
  - add/update task on `task_started`, `task_updated`, `task_progress`;
  - settle/remove task on `task_notification` with `completed`, `failed`, or
    `stopped`;
  - settle/remove task on `task_updated.patch.status` with terminal statuses
    such as `completed`, `failed`, or `killed`;
  - treat `is_backgrounded` and non-terminal task status as retention evidence;
  - treat unknown task status conservatively as retention evidence until a
    terminal update or a clean empty Stop hook snapshot proves otherwise.
- Consider a Claude-owned process reap eligible now only when:
  - the process is owned by YA;
  - Claude has reached a turn boundary;
  - Claude has emitted `session_state_changed idle`, if available;
  - the latest Stop hook snapshot has no `background_tasks`;
  - the latest Stop hook snapshot has no `session_crons`;
  - no live task map entry is non-terminal;
  - no YA-level retention feature is active, such as live subscribers,
    heartbeat retention, waiting input, or deferred queue work.

Suggested state naming:

- `idle`: the visible foreground turn is over.
- `provider-retained`: the foreground turn is idle, but Claude has known
  background/scheduled work that may wake it.
- `reap-eligible-now`: idle and no provider-owned wakeup evidence currently
  remains.

The UI does not need to show every internal distinction immediately. The
server-side lifecycle decision does.

## Guardrails

- Do not treat `result` alone as safe-to-reap for Claude.
- Do not treat JSONL absence of `backgroundTaskId` as proof of quiescence.
  JSONL is useful forensic evidence, but the live SDK hook/control stream is
  the authoritative place to observe current registered wakeups.
- Do not break heartbeat behavior. Heartbeat turns are YA-owned work and remain
  separate from Claude-owned background task wakeups. Cheap cooperation is
  enough: while provider-retained, the session should not look like plain
  `verified-idle` to heartbeat scheduling, so heartbeat does not inject a YA
  turn into a provider-owned pause.
- Do not let the fix keep truly idle sessions forever. If Stop hook data says
  no background tasks and no session crons, the normal idle reap policy should
  still apply after the configured timeout.
- Do not break `waiting-input`; pending approval/input must continue to block
  idle reaping independently of provider-retained background work.
- Do not break deferred queue semantics. YA intentionally promotes queued
  messages at whole-turn boundaries, not at every internal tool boundary.
- Do not replace YA-visible session ids with Claude/provider-native ids.
- Do not classify a YA-owned Claude session as external merely because the
  JSONL keeps changing after YA has hit an internal idle edge.
- Be careful on Windows: if the captured spawn PID is a shell wrapper, aborting
  it may not terminate the final `claude.exe` cleanly. Reap decisions should be
  correct before relying on process termination as cleanup.
- Keep remote Claude sessions in mind. Remote sync currently happens after
  result messages; retention state must not assume local filesystem-only
  observation.
- Keep client subscription retention separate. Live delta subscribers can
  retain an idle process for replay/UX reasons; Claude background tasks retain
  it because the provider itself may still continue work.

## Test Plan

Add focused coverage before changing the lifecycle rules broadly:

- Unit test: Claude `result` followed by Stop hook data with one
  `background_tasks` entry does not become reap-eligible-now.
- Unit test: Claude `session_state_changed idle` with one `session_crons`
  entry does not become reap-eligible-now.
- Unit test: after a `task_notification` settles the last background task and
  the Stop hook snapshot is empty, normal idle reap eligibility returns.
- Unit test: `task_updated.patch.status: "killed"` clears retention for that
  task, while unknown or non-terminal statuses retain conservatively.
- Regression test: no live subscribers and heartbeat disabled still reap a
  truly idle Claude process after the timeout.
- Regression test: no explicit `IDLE_TIMEOUT` uses the new 20-minute default,
  while an explicit env override still wins.
- Regression test: `waiting-input` still blocks idle reap.
- Regression test: deferred queue promotion still happens at whole-turn idle
  boundaries.
- Regression test: heartbeat scheduling skips or treats provider-retained
  Claude idle as not plain verified idle, without making heartbeat the primary
  lifecycle owner.
- Windows-focused manual test: start a Claude session that backgrounds a long
  command, wait past the previous 5-minute timeout, confirm YA still owns the
  session and permission/tool calls continue after the task wakes the agent.

## Open Questions

- Should the implementation expose provider-retained idle in `/api/processes`
  now, or keep it as internal liveness evidence until the UI has a clear need?
- Does Claude always fire Stop hooks before every wake-capable pause, including
  background shell tasks, background subagents, `/loop`, and scheduled wakeups?
- Should `session_state_changed idle` become the preferred Claude turn boundary
  over `result`, with `result` retained only for older SDK versions?
- How should provider-retained idle be exposed in `/api/processes` and session
  activity copy without making YA-visible behavior feel novel or confusing?
- Should the default 20-minute mitigation stay global for owned provider
  processes, or narrow later if another provider shows materially different
  resource/cost behavior?
