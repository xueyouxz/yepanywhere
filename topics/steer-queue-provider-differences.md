# Steer/queue provider differences (Claude vs Codex)

> Steer/queue provider differences: what "send while the agent is busy"
> actually does in each provider's native stack, on what level Codex
> "uniquely" supports steering, and how each provider signals that a turn is
> really over.

Topic: steer-queue-provider-differences

See also:
- [message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md)
  — YA's UI-visible delivery-intent contract that consumes these facts.
- `packages/server/src/sdk/providers/codex-turn-lifecycle-findings.md` —
  Codex app-server probe evidence this doc builds on.

## The turn, precisely

A *turn* is one user input followed by the agent's full autonomous loop
(any number of tool calls and interim assistant updates) ending in a final
response. Interim updates are not turn ends:

- **Claude (verified in real `~/.claude/projects` JSONL, 2026-06-11):**
  mid-loop assistant records carry `stop_reason: "tool_use"`; only the
  turn-final record carries `end_turn` (or `stop_sequence`). Sampled
  sessions: 239 `tool_use` / 9 `end_turn`; 304 / 5. Turn boundaries ARE
  recoverable from JSONL history, contra the upstream belief that they are
  SDK-only.
- **Codex (verified by probe, see codex-turn-lifecycle-findings):** turn
  completion is a discrete `turn/completed` JSON-RPC notification; interim
  text arrives as items inside the active turn.

The motivating upstream demo (kzahel, 2026-06-11): one prompt running six
10-second sleeps with interim "Sleep n/6 finished" updates is ONE turn —
the native Codex app held his queued message until all six finished.

## Native send-while-busy semantics

### Codex

- Typed mid-turn input in the native TUI is pending steering: shown under
  `Messages to be submitted after next tool call`; `Esc` interrupts to
  submit immediately (observed 2026-06-05, reproduced 2026-06-11).
- The explicit queue affordance in the Codex app holds the message until
  `turn/completed` (observed in the upstream sleep demo).
- Protocol: `turn/steer` appends input to the active turn; the model sees
  it at its next inference step, i.e. after the in-flight tool call.

So native Codex "steer" ≡ "after next tool call", and native Codex
"queue" ≡ "at end of turn".

### Claude

Claude Code's command queue supports three priorities on user messages.
Evidence (2026-06-11): `SDKUserMessage.priority?: 'now' | 'next' |
'later'` in `@anthropic-ai/claude-agent-sdk` 0.3.170 `sdk.d.ts`, plus the
bundled CLI 2.1.173 implementation:

- rank table `{now: 0, next: 1, later: 2}`;
- the agent loop drains queued commands at post-tool-batch boundaries via
  `getCommandsByMaxPriority("next")` — so `later` items are NOT consumed
  mid-turn and wait for end of turn;
- a queued `priority === "now"` message additionally fires
  `abort("interrupt")` on the in-flight API request — stronger than Codex
  steer, which waits out the current tool call;
- internal task notifications inject with `next`; cron/loop scheduled
  prompts inject with `later`.

Mapping:

| Claude priority | Delivery | Codex equivalent |
|---|---|---|
| `now` | interrupt in-flight generation, inject | stronger than `turn/steer` (TUI `Esc`-steer is the close analog) |
| `next` | after the current tool batch | `turn/steer` ("after next tool call") |
| `later` | end of turn | app queue / YA `deferred` |

Default-lane resolution (verified in bundle 2.1.173, 2026-06-11): the
command-queue factory exposes `enqueue` (default `priority ?? "next"`)
and `enqueuePendingNotification` (default `"later"`). Prompt-mode
submissions — TUI Enter and bridge-injected user messages alike — route
through `enqueue` with no explicit priority, so **Claude's default
Enter-while-busy send is `next`**: same lane as Codex steer, not `now`
(a circulating claim that Enter is `now` is wrong — `now` is only ever
set explicitly) and not `later`. `later` defaults apply only to internal
pending notifications; cron/loop prompts pass `later` explicitly.

Why Claude `next` still *feels* slower than Codex steer: boundary
granularity. Claude drains `next` items at post-tool-batch boundaries —
one API response can bundle a long extended-thinking stretch plus
several tool executions before the next model request. Codex injects
after the single in-flight tool call. Same lane, coarser tick.

Consequence for YA: `claude.ts` now advertises steering and implements
`steer` by pushing the user message into YA's `MessageQueue` immediately.
`Process` stamps Claude steer messages with `priority: "next"` by default,
or `priority: "now"` when the Claude-only steer-now checkbox set
`metadata.steerNow`. YA-held queued (`deferred`) and patient messages are
still kept out of `MessageQueue` until their turn-end / verified-quiet
criteria pass; when they finally enter Claude, YA stamps `priority: "later"`
as a wire-level guard.

The full YA→Claude send path, naming both queue layers:

```
YA composer → either YA deferred queue (queue/patient timing) or immediate
steer path → YA MessageQueue (batch/concat) → SDK streamInput → CLI stdin
→ CLI command queue (YA stamps next/now/later) → drained at tool-batch
boundary / turn start
```

The agent SDK spawns this same CLI and is a thin stdio client, so YA is
always driving the queue machinery described above. YA controls *when*
a message enters the pipe (its own queues) and *which lane* it takes
(`priority` on the SDKUserMessage). The transcript JSONL is observation
only; a message visible there has left every queue.

## Levels of "soon" (urgency ladder, short of hard interrupt)

Every lane available for delivering new user input, most to least urgent,
with the invoking mechanism. Hard interrupts (Claude `query.interrupt()`,
Codex `turn/interrupt`) bracket the ladder but cancel work; they are not
"send" lanes.

| Level | Claude mechanism | Codex mechanism | YA UI |
|---|---|---|---|
| 0. Inject now (abort in-flight *generation*, keep the turn) | `priority: "now"` on a streamed user message; CLI fires `abort("interrupt")` on the turn's controller — sampling stops immediately, but running tools are NOT killed: the abort reason `"interrupt"` is threaded to tool executors, which auto-background running commands (subprocess kill is skipped for this reason; per-tool `interruptBehavior` may opt into `cancel`), and the model is re-called at once with the message | none as a single lane; TUI `Esc` on the pending-steer prompt composes interrupt+submit | Claude-only `Now` checkbox beside steer, default off |
| 1. After current tool call / tool batch | `priority: "next"`; the loop drains `getCommandsByMaxPriority("next")` at post-tool-batch boundaries (internal task notifications use this lane) | `turn/steer` RPC `{threadId, expectedTurnId, input}`; lands in the active turn's `pending_input`, consumed when the *next model request* is composed — it does NOT abort in-flight sampling, so during a long thinking/text stretch it waits for the whole current response (and its tool batch). Native TUI default for typed mid-turn input | ↗ steer |
| 2. End of turn (the real queue) | `priority: "later"`; not consumed mid-turn, starts the next turn at turn end (cron/loop prompts use this lane) | no protocol lane — the native app holds the message client-side until `turn/completed`; YA holds it server-side (`deferred`) | → queue |
| 3. End of turn + verified quiet window | not native | not native | Zz patient (`patienceSeconds`) |

Asymmetry worth knowing: Codex exposes steering in the protocol but
queueing only as client-side holding; Claude exposes all three native
lanes as data on the user message itself (`priority`), so "Claude can't
steer" was never a platform fact.

All lanes are client-side queue disciplines. The Messages API is
stateless — every request re-sends the conversation, so a queued message
reaches the LLM server only when the next request is composed with it
included (`now` = abort current request, message rides the immediate
re-request; `next` = next request after the tool batch; `later` = first
request of the next turn). This is why Claude's TUI can offer "press up
to edit queued messages": queue residency is purely local
(`popEditableAt` pulls the entry back into the composer), and the edit
window closes exactly when the entry is drained into a request. YA's
deferred queue is the same discipline one level up the stack.

### TUI affordances (or their absence)

The Claude TUI exposes NO keypress or mode toggle for `now` or `later`
(verified 2026-06-11: the 2.1.173 bundle contains zero producers of
`priority: "now"`; `"later"` is produced only by internal cron/loop
schedulers). The user-reachable surface is exactly: Enter → `next`,
Esc → hard interrupt (running command killed, turn ends). The
`now`/`later` lanes are wire-level — reachable only by programmatic
clients injecting messages with an explicit `priority` (SDK
`streamInput`, the desktop/claude.ai bridge). A supervisor like YA can
therefore expose a fuller send-mode UI than the native TUI itself.

Delivery is not response: in a live test (haiku, six 10s sleeps), a
plain Enter mid-turn produced a thinking block acknowledging the message
at the next tool boundary — the `next` lane delivered promptly — but the
model elected to finish its instructed sleep sequence before replying.
Steering hands the model the message; whether it acts mid-task is model
behavior. Perceived "Claude is less responsive than Codex" conflates
lane latency (similar) with model compliance (varies).

### `now` vs hard-interrupt+send

Both abort in-flight sampling instantly; everything around that differs.
Hard interrupt (Esc / `query.interrupt()`) ends the turn in a terminal
"interrupted" state, kills running tools (kill-class abort reasons such
as `user-cancel`), closes pending `tool_use` blocks as cancelled, and
the follow-up message starts a fresh turn against a model that was told
to stop. `priority: "now"` uses the distinct soft abort reason
`"interrupt"`: the loop never exits, running tools are auto-backgrounded
instead of killed (executors skip the kill for this reason; per-tool
`interruptBehavior` may opt into cancel), and the next model request is
composed immediately with the new message inside the same turn — the
model experiences mid-task steering, not a stop. Codex has no soft
variant: TUI `Esc` on the pending-steer prompt is literally
interrupt-then-submit, with the running tool killed.

## Is the patient lane redundant?

Mostly-idle sessions: yes-ish — once a queue really waits for end of
turn, patient only adds its quiet window. But "end of turn" and "agent is
really done unless we say something" differ exactly when turns chain
without user input: Claude background tasks settle and inject
`task-notification` commands at priority `next` (waking a new turn),
cron/loop prompts fire at `later`, and YA heartbeat turns start turns on
idle sessions. The unattended-for-hours scenario is the one where
chaining is common, so the patient lane is the only "wait for true
quiet" option. Keep: queue = end of turn (default), patient = optional
quiet window in seconds.

## On what level is "only Codex steers" true?

Historically, only at the YA-integration level: YA wired `steerFn` for
`codex` and `grok-acp` (`turn/steer`) while Claude busy sends were held in
YA's deferred queue. As of 2026-06-11, that is no longer true in YA:
Claude advertises `supportsSteering`, steer sends enter `MessageQueue`
immediately with `priority: "next"`, and the optional `Now` checkbox uses
`priority: "now"`. The Claude platform itself always supported both the
"after next tool batch" semantics (`next`) and the stronger immediate mode
(`now`); YA now exposes both, with `now` default-off.

## Perceived responsiveness, explained

- Codex steer lands within one tool call (seconds during tool-heavy work).
- Claude steer in YA lands at Claude's post-tool-batch boundary (`next`).
  This is the same conceptual lane as Codex steer but can feel coarser
  because one Claude loop tick may bundle extended thinking and several tool
  executions before the next model request.
- Claude queue in YA is deliberately different: queued sends stay in YA's
  deferred queue until the turn-end `result` boundary, then enter Claude as
  `priority: "later"`.

## "Really done forever unless we say something"

What each side gives YA as the done-signal:

- **Codex:** `turn/completed` notification (status completed / interrupted
  / failed). YA's codex provider maps it to a `result` message →
  `Process.transitionToIdle()`.
- **Claude:** the SDK `result` message per turn (YA's idle trigger), plus
  `system/session_state_changed` (`idle`/`running`/`requires_action`),
  plus — for history with no live process — JSONL `stop_reason`
  (`end_turn`/`stop_sequence` vs `tool_use`).

Caveats — "idle" is not literally "forever":

- `waiting-input` (tool approval, AskUserQuestion) pauses inside a turn;
  not idle, not done.
- Claude background tasks (backgrounded Bash/subagents) can settle after
  turn end and inject `task-notification` commands at priority `next`,
  waking a new turn with no user input. Scheduled cron/loop prompts
  (priority `later`) likewise start turns.
- YA's own heartbeat turns intentionally start new turns on idle sessions.

This is why YA's patient queue gates on `verified-idle` plus a per-item
quiet window (`patienceSeconds`) rather than trusting one idle edge: the
quiet window absorbs turn-chaining (background-task wakeups, heartbeats)
that a bare end-of-turn signal misses.
