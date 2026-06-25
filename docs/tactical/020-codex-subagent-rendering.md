# 020 - Codex subagent session rendering

Status: First slice implemented

Progress:

- [x] 2026-06-25: Confirmed from current Codex source/docs that Codex has
  explicit subagent workflows and spawned agent threads.
- [x] 2026-06-25: Inspected a real Codex Desktop `0.142.0` archive containing a
  root rollout and one spawned worker rollout.
- [x] 2026-06-25: Updated Codex rollout metadata schemas and subagent discovery.
- [x] 2026-06-25: Implemented Codex `getAgentMappings()` /
  `getAgentSession()`.
- [x] 2026-06-25: Rendered Codex `spawn_agent` rows through the same
  expandable agent-work UI shape used for Claude `Task`.

## Context

YA already has a provider-neutral server/client contract for subagent content:

- session readers expose `getAgentMappings()` and `getAgentSession(agentId)`;
- the client keeps child transcript content in `AgentContentContext`;
- `TaskRenderer` can map a parent tool call to an `agentId`, lazy-load the
  child session, and render the child transcript inline when expanded.

That contract was built around Claude's `Task` tool and Claude SDK sidechain
JSONL files. Codex now has a similar user-facing concept, but its durable shape
is different: a subagent is a separate Codex rollout thread, linked to the root
thread by session/tree metadata and by `spawn_agent` tool output.

Do not confuse Claude's subagent `Task` tool with Claude's newer todo-list
`TaskCreate` / `TaskUpdate` tools. The todo-list problem is tracked in
[`../../topics/task-list-rendering.md`](../../topics/task-list-rendering.md):
it shares the cross-message, id-correlated reconstruction shape, but it should
render as a checklist rather than an expandable child transcript.

The goal is not to make Codex look like Claude internally. The goal is to make
provider-specific adapters normalize both shapes into the same UI concept:

```text
main transcript row: "Agent task / subagent work"
  -> collapsed summary and status
  -> expandable child transcript loaded by agentId
```

## Observed Codex Shape

Real archive inspected on 2026-06-25 from Codex Desktop `0.142.0`:

- Root rollout id: `019efe56-862d-7f53-bca1-85a3b12e0001`
- Child rollout id: `019efe57-96fb-7541-9c82-1699a5761075`
- Child nickname: `Parfit`
- Child role: `worker`

The child rollout's first `session_meta` payload had:

```json
{
  "id": "019efe57-96fb-7541-9c82-1699a5761075",
  "session_id": "019efe56-862d-7f53-bca1-85a3b12e0001",
  "parent_thread_id": "019efe56-862d-7f53-bca1-85a3b12e0001",
  "source": {
    "subagent": {
      "thread_spawn": {
        "parent_thread_id": "019efe56-862d-7f53-bca1-85a3b12e0001",
        "depth": 1,
        "agent_path": null,
        "agent_nickname": "Parfit",
        "agent_role": "worker"
      }
    }
  },
  "agent_nickname": "Parfit",
  "agent_role": "worker",
  "multi_agent_version": "v1"
}
```

Important details:

- The child did **not** have `forked_from_id`. Do not require
  `forked_from_id` to detect Codex subagents.
- `session_id` remained the root thread id, while `id` was the child thread id.
- Top-level `parent_thread_id` and nested
  `source.subagent.thread_spawn.parent_thread_id` both pointed at the root.
- `source` was structured JSON, not a string.
- The parent rollout contained a `spawn_agent` `response_item` tool call. Its
  following `function_call_output` was:

  ```json
  {"agent_id":"019efe57-96fb-7541-9c82-1699a5761075","nickname":"Parfit"}
  ```

- The child rollout contained the full child transcript as normal Codex
  `response_item`, `event_msg`, `turn_context`, and tool-call entries.
- The parent received the child completion as a normal user-message
  `response_item` containing:

  ```text
  <subagent_notification>
  {"agent_path":"019efe57-...","status":{"completed":"..."}}
  </subagent_notification>
  ```

- The parent rollout can contain repeated `session_meta` records after later
  turns. Metadata discovery should keep using the first record for head
  metadata, while detail readers should tolerate repeated records.

## Current YA Gaps

`CodexSessionReader` has stubs that say Codex does not have subagent sessions
like Claude. That statement is stale.

Known gaps:

- `packages/shared/src/codex-schema/session.ts` models
  `session_meta.source` as `string | undefined`, but modern Codex can write a
  structured source object.
- Codex subagent detection currently depends on `forked_from_id`, which misses
  observed child rollouts that only have `parent_thread_id`.
- `CodexSessionReader.getAgentMappings()` returns `[]`, even though successful
  `spawn_agent` outputs directly map parent tool call id to child agent id.
- `CodexSessionReader.getAgentSession(agentId)` returns `null`, even though the
  child rollout is a normal Codex session file whose `id` is the agent id.
- The client has a Claude-specific `TaskRenderer` UI, but no provider-neutral
  "agent work" renderer that Codex `spawn_agent` can share.

## Rendering Direction

Render Claude and Codex subagents through one shared visual component, fed by
provider-specific adapters.

Recommended component split when the next refactor is warranted:

- `AgentWorkInline` (new shared component): collapsed/expanded row, status,
  role/type badge, optional nickname, summary, stats, loading state, nested
  transcript rendering.
- `TaskRenderer` (Claude adapter): converts Claude `Task` input/result into
  `AgentWorkInline` props.
- `spawn_agent` renderer (Codex adapter): converts Codex `spawn_agent`
  input/result into the same `AgentWorkInline` props.

The first implemented slice keeps the existing `TaskRenderer` file as the
owner of the nested transcript helpers and adds a narrow Codex
`spawn_agent` adapter. That avoids a broader component rename while preserving
the same visual row shape and `AgentContentContext` loading path.

Provider-specific fields should normalize roughly as:

| Concept | Claude `Task` | Codex `spawn_agent` |
| --- | --- | --- |
| Parent tool id | `tool_use_id` | `function_call.call_id` |
| Child id | `result.agentId` or mapping | `output.agent_id` |
| Role/type badge | `input.subagent_type` | `input.agent_type` or child `agent_role` |
| Display name | usually absent | `output.nickname` / `agent_nickname` |
| Task summary | `input.description` | first line or short summary of `input.message` |
| Prompt/details | `input.prompt` | `input.message` |
| Child transcript | Claude agent JSONL | Codex child rollout JSONL |

The collapsed row should be deliberately similar for both:

```text
[worker] Parfit  Demo subagent task for the user to observe    running
```

Expanded content should reuse the existing nested transcript path:

- `AgentContentContext` loads by `agentId`;
- loaded messages go through `preprocessMessages()`;
- `RenderItemComponent` renders the nested child transcript.

Do not invent a Codex-only nested transcript renderer unless the normalized
Codex `Message[]` shape cannot preserve necessary information.

## Transcript Noise And First Slice

Codex exposes lifecycle tools (`spawn_agent`, `wait_agent`, `send_input`,
`close_agent`) in the parent transcript. Claude exposes a single `Task` row plus
child messages/status.

Do not hide Codex lifecycle rows as the first slice. Hiding or regrouping tool
calls changes transcript inspectability and can obscure provider behavior.

First slice:

1. Make successful `spawn_agent` rows render as expandable agent-work rows.
2. Leave `wait_agent`, `send_input`, and `close_agent` as ordinary tool rows.
3. Suppress only duplicate/noisy `<subagent_notification>` display if the same
   completed status is already represented in the agent-work row, and only if
   the raw content remains inspectable in debug/raw views.

Later option:

- Group lifecycle controls into the same agent-work row as subdued timeline
  entries ("wait timed out", "sent interrupt", "closed completed agent"), once
  the raw-row first slice proves the data model.

## Server Implementation Shape

### Codex metadata schema

Extend the Codex session metadata schema to include:

- `session_id?: string`
- `parent_thread_id?: string`
- `source?: string | CodexSessionSource`
- `thread_source?: string`
- `agent_nickname?: string`
- `agent_role?: string`
- `agent_path?: string | null`
- `multi_agent_version?: string`

The structured source type only needs the observed subagent shape initially:

```ts
type CodexSessionSource =
  | string
  | {
      subagent?: {
        thread_spawn?: {
          parent_thread_id?: string;
          depth?: number;
          agent_path?: string | null;
          agent_nickname?: string | null;
          agent_role?: string | null;
        };
      };
    };
```

### Codex subagent detection

A Codex rollout is a spawned subagent if any of these are true:

- `payload.parent_thread_id` is a string;
- `payload.source.subagent.thread_spawn.parent_thread_id` is a string;
- `payload.thread_source` is a subagent/thread-spawn classification, if present.

`forked_from_id` is not required. It is a fork relationship, not the canonical
subagent indicator.

Keep spawned child rollouts out of ordinary session lists, but keep them
discoverable by `getAgentSession(agentId)`.

### `getAgentMappings()`

For the parent rollout:

1. Scan `response_item` entries for `payload.type === "function_call"` and
   `payload.name === "spawn_agent"`.
2. Record `call_id`.
3. Find the corresponding `function_call_output` with the same `call_id`.
4. Parse `payload.output` as JSON.
5. If it contains `agent_id`, return `{ toolUseId: call_id, agentId }`.

Failed `spawn_agent` calls should not produce mappings.

### `getAgentSession(agentId)`

Resolve a child rollout by:

- exact `session_meta.payload.id === agentId`;
- exact filename thread id if the metadata id is unavailable;
- optionally `agent_path` if Codex later uses a non-thread-id path for v2.

Then reuse the normal Codex entry-to-`Message[]` conversion for that rollout,
marking returned messages as subagent content so existing nested rendering and
styling apply.

Status can be inferred in this order:

1. last child `task_complete` event -> `completed`;
2. terminal error event or failed status -> `failed`;
3. parent `close_agent` previous status, if available;
4. child file still growing / recent -> `running`;
5. otherwise `pending` or `unknown`, matching existing agent-content semantics.

## Client Implementation Shape

Keep the state model provider-neutral:

- `toolUseToAgent` maps parent tool id to child id for both Claude and Codex.
- `agentContent[agentId]` stores the child transcript for both providers.
- `AgentContentContext.loadAgentContent()` remains provider-agnostic because
  the server route chooses the active session reader.

Implemented changes:

- `TaskNestedContent` and the spinner are shared from `TaskRenderer`.
- A Codex tool renderer for `spawn_agent` uses the shared nested transcript
  path.
- Codex result shape is normalized before rendering, since `spawn_agent`
  output is small (`agent_id`, `nickname`) and does not include Claude-style
  duration, token, or tool-count stats.

Remaining cleanup:

- Extract the shared row chrome into an `AgentWorkInline` component if Claude
  and Codex subagent rendering continue to converge.
- Move any new durable user-facing labels into i18n keys when this area gets a
  broader copy pass.

## Live vs. Reload Parity

Cold reload is the first priority because the uploaded archive proves enough
durable data exists to render after the fact.

Live rendering has two possible levels:

1. Basic parity: after `spawn_agent` output arrives, the row has an `agentId`.
   Expanding lazy-loads whatever the child rollout currently contains.
2. Rich live parity: watch/stream child rollout updates into `agentContent`
   while the parent session is open, so expanded content updates without manual
   reload.

Start with basic parity. Rich live parity touches watches, streaming, and
session liveness, so it should read `topics/architecture-mandates.md` first and
must preserve the invariant that idle provider sessions and closed tabs do not
consume server resources indefinitely.

## Tests

Server:

- Codex metadata schema accepts string `source` and structured subagent source.
- Codex subagent detector returns true without `forked_from_id`.
- Codex session listing excludes child rollouts.
- `getAgentMappings()` maps a successful `spawn_agent` call output.
- failed `spawn_agent` output does not map.
- `getAgentSession(agentId)` loads the child rollout and returns messages.
- repeated parent `session_meta` lines do not break detail loading.

Client:

- `spawn_agent` renders an agent-work row with role, nickname, summary, and
  status.
- expanding a Codex agent row calls `loadAgentContent()` with the `agent_id`.
- nested Codex child messages render through the same nested transcript path as
  Claude.
- existing Claude `Task` renderer snapshots/tests remain visually equivalent.

Manual:

- Use a Codex Desktop session that spawns one worker and one explorer.
- Reload YA and confirm both child rows remain expandable.
- Confirm the root session list does not show the child rollouts as top-level
  sessions.
- On mobile width, confirm collapsed rows fit without overlapping badges,
  summary text, status, or spinner.

## Non-Goals

- Do not make provider-native child thread ids replace YA-visible root session
  ids in URLs or session metadata.
- Do not rewrite Codex rollout files.
- Do not hide all Codex lifecycle tool rows in the first slice.
- Do not implement cross-provider subagents here.
- Do not add a long-lived server cache solely for subagent rendering unless
  profiling later proves lazy rollout reads are too expensive.

## Open Questions

- Should the visible generic label be "Agent", "Subagent", or "Task"? "Agent"
  is likely the best provider-neutral row label; keep provider names out of the
  visible label unless useful for debugging.
- Should `<subagent_notification>` messages become hidden system/status
  markers once the agent-work row owns completion state?
- How should Codex v2 `task_name` / `agent_path` map onto `agentId` if it stops
  exposing thread ids as direct targets?
- Should lifecycle actions (`wait_agent`, `send_input`, `close_agent`) be
  grouped under the spawned row after the first slice?
- Can live child rollout updates reuse existing focused-session watch plumbing,
  or would that risk background resource retention?
