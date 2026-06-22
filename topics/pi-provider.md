# pi Provider

> pi is Mario Zechner's provider-agnostic coding agent. This topic covers (a)
> integrating pi as a YA provider backend and (b) periodically tracking
> Zechner's pi work — the web-UI/TUI split and third-party remote web clients —
> because a remote pi supervisor overlaps YA's value proposition.

Topic: pi-provider

## What pi is (confirmed against the local checkout, 2026-06-21)

A TypeScript monorepo coding agent. The fork at `~/pi` (`origin
git@github.com:graehl/pi.git`, `upstream git@github.com:earendil-works/pi.git`,
`v0.79.9`) has four packages:

| Package | npm name | Role |
|---|---|---|
| `packages/agent` | `@earendil-works/pi-agent` | the **agent loop** + `AgentEvent` / `AgentMessage` types (`src/types.ts`, `src/harness/`) |
| `packages/ai` | `@earendil-works/pi-ai` | provider matrix, `ModelRegistry`, `transformMessages` cross-provider normalization, base message types |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | the `pi` binary + `AgentSession` runtime, tools, sessions, modes |
| `packages/tui` | — | the interactive terminal UI |

This resolves the prior "treat the repo/org relationship as unconfirmed" note:
the live upstream is `earendil-works/pi` under the `@earendil-works/*` scope
(`badlogic/pi-mono` is the older home). The Feb research doc
([`../docs/research/opencode-vs-pi-mono-provider-backend-comparison.md`](../docs/research/opencode-vs-pi-mono-provider-backend-comparison.md))
still holds for the *recommendation*; the surface facts below supersede its
package/path details.

**The runtime is mode-agnostic.** `coding-agent/src/core/agent-session.ts`
(`AgentSession`) and `createAgentSessionRuntime()` are the shared layer; the docs
state outright that **interactive (TUI), print, and RPC modes are all peer
consumers of the same runtime**. The agent loop lives in `pi-agent`, not in the
TUI. The four modes (`src/modes/`):

- `--mode rpc` — headless JSON-RPC over stdin/stdout (`modes/rpc/`), strict
  LF-delimited JSONL framing. Commands in, responses + event stream out.
- `--mode json` — one-shot JSON event stream (`modes/print-mode.ts`).
- `interactive` — the TUI (`modes/interactive/` + `packages/tui`).
- in-process SDK — `createAgentSession()` / `createAgentSessionRuntime()`
  imported directly (`docs/sdk.md`), no subprocess.

**Sessions** are append-only JSONL trees at
`~/.pi/agent/sessions/--<cwd-with-/→->--/<timestamp>_<uuid>.jsonl`, v3 format
(`id`/`parentId` branching, in-place `/tree` navigation, `/fork`, `/clone`).
Header line `{"type":"session","version":3,"id","cwd",...}`, then `AgentMessage`
entries (roles: user, assistant, toolResult, bashExecution, custom,
branchSummary, compactionSummary).

**Events** (`AgentSessionEvent` = `AgentEvent` ∪ session-level): `agent_start/end`,
`turn_start/end`, `message_start/update/end` (with `assistantMessageEvent`
deltas: `text_delta`, etc.), `tool_execution_start/update/end`, plus
`queue_update` (full steering + follow-up queues), `compaction_start/end`,
`auto_retry_start/end`. This is already close to a normalized envelope.

## Why YA cares

The research doc's conclusion stands: **pi is the better primary
agnostic-backend candidate than OpenCode** for YA's goal (provider/model
agnosticism, bring-your-own keys, transparent session persistence, flexible
local tool execution). Separately, pi's own remote/web-UI direction matters
competitively — a good remote pi supervisor overlaps YA directly, so tracking it
informs both "should YA add pi" and "what does YA's mobile supervisor offer that
a pi-native web UI does not."

## "Bypassing the TUI" is the supported design, not a fork hack

The framing motivating this work — Zechner's recent refactor *lets us bypass the
pi TUI* — is right, but the load-bearing correction is: **bypassing the TUI is
not extra work and does not require the fork.** Post-refactor (`earendil-works/pi#339`,
agent-loop → `pi-agent`, `AppMessage`/`AgentMessage` throughout), RPC mode, JSON
mode, and the in-process SDK are first-class peers of the interactive TUI on one
`AgentSessionRuntime`. None of them drive the TUI; none scrape a pty. So the
real decision is **which IPC boundary** to bind to, not whether headless is
possible:

- **Plan A — subprocess RPC** (`pi --mode rpc`): pi runs as its own process; YA
  speaks JSON-RPC. This is "pi exactly as shipped, in its headless front-door."
- **Plan B — in-process SDK**: YA imports `@earendil-works/pi-coding-agent` and
  drives `AgentSession` in the server process; no `pi` subprocess at all.

Both bypass the TUI. Per the user's steer: **if Plan A's RPC surface already
covers YA's usual provider patterns (it does — see the mapping below), the first
version uses Plan A**, mirroring how Codex (app-server JSON-RPC subprocess) and
OpenCode (`opencode serve` HTTP/SSE subprocess) are integrated. Plan B is the
documented deeper-bypass alternative, taken only when the subprocess boundary's
costs (below) justify it.

## The fork (`graehl/pi`) is the integration target

`~/pi` → `origin graehl/pi`, tracking `upstream earendil-works/pi`. We are
contributors, **not maintainers**, of upstream, and upstream review is slow/uncertain.
Pinning YA to the fork buys freedom to land **modest, YA-shaped changes** without
blocking on upstream:

- a bundled **YA permission-bridge extension** (see Permissions below);
- any event-metadata or RPC-field additions YA needs that upstream hasn't taken;
- a pinned, known-good version so a YA release isn't hostage to upstream churn.

Discipline (small, to keep upstream-mergeable): keep fork deltas as additive
extensions/flags where possible; rebase the fork on `upstream` periodically;
open the useful deltas as upstream PRs but do not gate YA on their acceptance.
This mirrors the kzahel-vs-graehl staging relationship YA already runs. **Do not**
assume a delta landed upstream — check the fork's actual `git log origin/main`
vs `upstream/main` before relying on a change.

## Plan A — subprocess RPC mode (likely first version)

**Status: LANDED (live path) 2026-06-21.** `PiProvider`
(`packages/server/src/sdk/providers/pi.ts`) + `PiRpcClient`
(`pi-rpc-client.ts`) spawn `pi --mode rpc` per session, learn the session id
via `get_state`, and stream each `prompt` turn's agent events until `agent_end`,
normalizing `message_*` / `tool_execution_*` / usage into YA SDKMessages.
Registered in `providers/index.ts`; `pi` added to `ProviderName` /
`ALL_PROVIDERS` (additive). Verified by the `pi-rpc-client` framing/correlation
test and a transport smoke against the real binary (39 `provider/id` models).
Durable `PiSessionReader` **LANDED 2026-06-22** (see § "Durable transcripts" —
pi sessions now survive a YA server restart). Remaining deferred follow-ups:
true steering wiring (`supportsSteering=false` for now), and the
`tool_execution_start` permission bridge (tools run autonomously). Tool name **and argument-field** normalization
is **done** (`pi-tools.ts` `normalizePiTool`; see
[`provider-read-edit-disciplines.md`](provider-read-edit-disciplines.md)).

Add a `pi` provider that spawns `pi --mode rpc --provider <p> --model <m>
--session-dir <dir>` per session and speaks the JSONL protocol. RPC maps onto
YA's `AgentProvider` / `AgentSession` (`packages/server/src/sdk/providers/types.ts`)
with no missing primitive:

| YA `AgentSession` surface | pi RPC | Notes |
|---|---|---|
| `queue` initial + user turns | `{"type":"prompt","message",images?}` | accepts/queues; failures arrive on the event stream, not a 2nd response |
| `steer(msg)` / `supportsSteering` | `{"type":"steer"}` + `set_steering_mode` | delivered after current turn's tool calls, before next LLM call — **true steering** (unlike OpenCode) |
| follow-up queue | `{"type":"follow_up"}` + `set_follow_up_mode` | delivered when agent idle |
| `abort()` / `interrupt()` | `{"type":"abort"}` | graceful turn abort without killing the process; SIGTERM stays the hard stop |
| `setModel` / `supportedModels` | `set_model` / `cycle_model` / `get_available_models` | full `Model` objects returned |
| thinking/effort | `set_thinking_level` (off…xhigh) / `cycle_thinking_level` | maps YA thinking + effort |
| `/compact` via `runProviderCommand` | `{"type":"compact",customInstructions?}` | native, returns summary + token deltas |
| liveness / `probeLiveness` | `get_state` (`isStreaming`,`messageCount`,`pendingMessageCount`) + event cadence | poll-cheap |
| `forkSession` | `pi --fork <id>` at startup (or runtime fork) | real prefix fork, cache-warm |
| durable transcript | `PiSessionReader` over `~/.pi/agent/sessions` | see Durable transcripts |

Event normalization: pi `message_*` deltas → YA `text`/`thinking` blocks,
`tool_execution_*` → YA `tool_use`/`tool_result` (pair by `toolCallId`),
`queue_update` → YA queued-message UI, `compaction_*` → YA compaction indicator.
The `assistantMessageEvent.text_delta` stream is the high-rate path — apply the
same coalescing discipline YA already requires (see CLAUDE.local.md *Client
Performance Path Coverage*).

**Framing caveat (real bug source):** RPC is strict LF-only JSONL. Node
`readline` is **not** protocol-compliant (it also splits on U+2028/U+2029, valid
inside JSON strings) — the YA-side reader must split on `\n` only and strip a
trailing `\r`. The docs call this out explicitly.

## Plan B — in-process SDK embed (alternative bypass)

YA imports `@earendil-works/pi-coding-agent` and drives the session directly:

```ts
const { session } = await createAgentSession({ sessionManager, authStorage, modelRegistry, ... });
session.subscribe(ev => /* map to YA blocks */);
await session.prompt(text);   // steer(), followUp(), abort(), compact(), setModel(), navigateTree(), dispose()
```

`createAgentSessionRuntime()` is the layer to use when YA needs to *replace* the
active session (new/resume/fork/import) and rebuild cwd-bound state — the same
layer the built-in modes use.

Pick B over A when the subprocess boundary's costs bite: no JSONL-framing
fragility, no per-session process/stdio management, lower latency, and direct
in-process access to the `tool_execution_start` "can block" hook for approvals
(no RPC round-trip). Costs of B: pi's deps load into the YA server process;
version/packaging coupling is tighter (the published `yepanywhere` bundle copies
`packages/server` deps verbatim and advertises zero external deps — same
constraint that pushed the OpenCode DB reader to `node:sqlite` over
`better-sqlite3`); a pi crash is in-process. Phase B behind a flag and A/B the
latency/memory/failure behavior before defaulting to it (the research doc's
Phase 2).

## Permissions (shared by A and B) — the one real integration cost

pi has **no OpenCode-style standalone permission endpoint**; by default it runs
tools autonomously. Confirmed mechanism for a YA approval UX: the extension hook
`tool_execution_start` is documented as *"Fired before a tool executes. Can
block."* So YA bundles a small **permission-bridge extension** in the fork that,
per `tool_execution_start`, asks YA for a decision and blocks the tool until it
returns:

- **Under Plan A (RPC):** the extension round-trips through RPC's
  `extension_ui_request {method:"confirm"}` → `extension_ui_response {confirmed}`.
- **Under Plan B (SDK):** the extension calls YA's `onToolApproval`/`canUseTool`
  in-process directly.

This is the "thin permission-policy layer" the research doc predicted, and the
clearest single justification for pinning the fork (ship the extension with pi
rather than depend on upstream adding a permission protocol).

## Durable transcripts — `PiSessionReader` (opencode-DB-reader analogue)

**LANDED 2026-06-22.** `packages/server/src/sessions/pi-reader.ts` reads
`~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`, resolves the v3 tree's
active-leaf→root path, and maps nodes to normalized YA messages (assistant
thinking/text/toolCall, `toolResult`→`tool_result`). Wired as a cross-provider
source in `provider-resolution.ts` (cwd filter is the membership test, like
Grok), in `app.ts` `readerFactory` `case "pi"`, and as a fallback in the
sessions route's transcript-load chain. `UnifiedSession` gained a `pi` variant;
`normalizeSession` passes pi messages through. Verified against a real session
(reload of a restart-orphaned pi session now returns its full transcript, not
404). The original design notes below stand as the rationale.

Add `PiSessionReader` over `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`,
returning the same normalized `{ message, parts }` shape the renderer already
consumes (so `normalization.ts` and the client need no change — same contract the
`OpenCodeDbReader` honored). pi's JSONL is **plain append-only files**, so unlike
OpenCode 1.16+ there is no SQLite hop and no `pi export` subprocess to truncate —
read the file directly; it is strictly the safer durable source. Honor the v3
tree (`id`/`parentId`): the durable view is the **active leaf's** path to root,
matching `/tree` semantics, not every branch. This makes reload / attach-to-an-
externally-(TUI-)owned pi session render without spawning pi, exactly as the
OpenCode DB reader did for unowned OpenCode sessions
([`opencode-backend.md`](opencode-backend.md) § *Direct SQLite reader*).

## Action rendering hardening — implemented 2026-06-22

The pi provider is still rough-draft work, and action rendering should be
hardened as a provider-contract bug, not as client cosmetics. The regression
trace is session `019ef029-d5e1-7bfd-be5f-949333d5daf7` in project
`/local/graehl/trtllm-speculative/draft`: the REST payload for the reloaded
session contains raw pi tool names and fields (`read` + `path`, `edit` +
`edits[]`, `bash` + `command`) instead of the canonical `Read`/`Edit`/`Bash`
shape documented in
[`provider-read-edit-disciplines.md`](provider-read-edit-disciplines.md). In
that observed transcript, the durable reader returned 30 `bash`, 25 `read`, and
6 `edit` raw tool calls. The client registry is case/name-sensitive for these
names, so many rows fall through to the raw fallback and use the default
complete-result summary (`done`) even when expanded content is present.

**Target baseline.** pi's own TUI already has the product answer for core
built-ins: `read`, `bash`, and `edit` each define tool-local `renderCall` /
`renderResult` logic (`packages/coding-agent/src/core/tools/{read,bash,edit}.ts`)
that produces useful headlines and inspectable detail. YA does not need to
invent a new pi action vocabulary; it should match that headline/detail contract
while projecting it into YA's existing canonical `Read`/`Bash`/`Edit` cards.

**Primary diagnosis.** The live path and durable path have drifted. Live
`PiProvider.mapEvent()` calls `normalizePiTool()` on `tool_execution_start`,
but `PiSessionReader.mapNode()` currently maps persisted `toolCall` blocks
straight through. That contradicts the `PiSessionReader` note that durable
mapping mirrors the live mapper, and it means every reloaded/restart-survived pi
session can lose rich action rendering even if the live turn looked acceptable.
Name/field normalization alone is not enough: pi tool results are persisted as
text content (usually with no `details` on successful `read`/`bash` calls),
while YA's rich renderers expect structured result shapes for `Read`, `Write`,
`Bash`, and `Edit`.

**Secondary diagnosis.** YA ignores pi `tool_execution_update` events. The pi
agent API documents `tool_execution_update { partialResult }`, and pi's built-in
`bash` tool already streams stdout/stderr through `onUpdate`, throttles
snapshots, and records a `fullOutputPath` for truncated output. YA only maps
`tool_execution_start` and `tool_execution_end`, so live bash output cannot be
previewed progressively, and a future live-output implementation must
accumulate per-`toolCallId` output rather than forwarding only the latest delta
or snapshot as the final text. A separate unbuffered `tee` or tail watcher is a
fallback only if pi's existing `onUpdate` stream proves insufficient for
non-line-flushing commands.

**Implemented slice.** The 2026-06-22 rendering-normalization hardening landed
these pieces:

1. **Unified pi tool-use normalization at the source boundary.** Both
   `PiProvider.mapEvent()` and `PiSessionReader.mapNode()` use
   `normalizePiTool()`, and `message.toolUse` carries the canonical
   `{id,name,input}`. Acceptance check: the REST payload for the observed
   session should show `Read`/`Edit`/`Bash` with `file_path` where applicable;
   no pi built-in action reaches the fallback renderer merely because of lower
   case or pi field names.
2. **Added pi result normalization, not just tool names.**
   `normalizePiToolResult(...)` is keyed by canonical tool name plus the
   original tool input:
   - `Bash`: map text content to YA's `BashResult` shape
     (`stdout`/`stderr`/`interrupted`/`isImage`) and preserve any pi truncation
     or `fullOutputPath` evidence when present.
   - `Read`/`Write`: synthesize `type:"text"` file results from the tool input
     path and returned text (`filePath`, `content`, `numLines`, `startLine`,
     `totalLines`) so interactive file summaries and file viewers engage.
   - `Edit`: for single-element pi `edits[]`, keep the expanded
     `old_string`/`new_string` and let the existing edit augment compute the
     diff; for multi-edit, preserve pi `details.patch` as a raw patch so the
     existing raw-patch augment computes the diff. A non-vanilla pi
     `apply_patch` tool maps to the same canonical `Edit` raw-patch path as
     Codex `apply_patch`; vanilla pi sessions are unchanged because they never
     emit that tool.
   - `Grep`/`Glob`/`LS`: either parse into existing structured result shapes
     when trivial, or deliberately leave text with a useful summary; do not
     mislabel an unknown shape as a richer renderer contract.
   Acceptance check: row headers and collapsed summaries say the action target
   (`Ran <command>`, filename, match/file counts or explicit fallback), not
   generic `done`; expanded rows expose detail at least as discoverably as the
   pi TUI for reads, commands, and edits while preserving the same full text the
   raw pi transcript contains.
3. **Consumed live `tool_execution_update` deliberately.** The live mapper keeps
   a per-tool state map keyed by `toolCallId`; pi Bash partial results update
   the same pending row via a duplicate same-id `tool_use` snapshot carrying
   `_previewResult`, while the terminal result still arrives only on
   `tool_execution_end`. Acceptance check: a long-running pi `bash` command
   shows progressive output, final output is not only the last update, and
   truncated output exposes pi's `fullOutputPath` when available.
4. **Fixed stale advisories and docs in the same pass.** The client Pi provider
   metadata no longer says `PiSessionReader` is unwired, and
   `provider-read-edit-disciplines.md` records live/durable pi normalization.
5. **Added regression fixtures.** `pi-tools.test.ts`, `pi-reader.test.ts`,
   `preprocessMessages.test.ts`, and `ToolCallRow.test.tsx` cover canonical
   names/fields/results, durable reload parity, duplicate live tool snapshots,
   and pending Bash preview rendering.

## Capability flags (initial `AgentProvider`)

`supportsSteering=true`, `supportsSteerNow=true` (steer lands before next LLM
call), `supportsThinkingToggle=true`, `supportsSlashCommands` — pi has native
`/compact`, `/fork`, etc.; advertise once the command inventory is wired,
otherwise start `false`. `supportsPermissionMode=true` (via the bridge
extension). `supportsRecaps`/`supportsNativePromptSuggestions` start absent.
`forkSession` implemented (real fork). Per CLAUDE.local.md *UI Changes Preserve
Non-Buggy Defaults*, gate the provider behind `ENABLED_PROVIDERS` and do not
change any existing provider's defaults.

## What to track (periodic)

Re-check and date-stamp:

- **`earendil-works/pi#339`** — agent-loop → `pi-agent`, `AppMessage`
  throughout — **confirmed landed** in the `~/pi` checkout (packages
  `agent`/`ai`/`coding-agent`/`tui`; `createAgentSessionRuntime` is the shared
  layer the modes consume). This is the refactor that makes the TUI-bypass clean.
- **`VVander/pi-remote-web-ui`** — third-party browser UI: in-process single
  `AgentSession`, WebSocket broadcast with `state_sync` full-history replay,
  SSH-port-forward access (binds `127.0.0.1`, key auth). A reference
  implementation of Plan B's embedding and a competitive data point for remote
  pi supervision. Desktop-oriented; modest traction.
- **General:** RPC protocol stability (`modes/rpc/rpc-types.ts`), any official pi
  web UI / TUI split, and whether refactors move the session/event surface a YA
  adapter binds to. Also: `git log origin/main..upstream/main` on `~/pi` before
  relying on a fork delta.

## Related

- [`opencode-backend.md`](opencode-backend.md) — the other agnostic-backend
  candidate; pi recommended primary, OpenCode secondary/fallback. Its direct-DB
  reader is the model for `PiSessionReader`.
- [`provider-abstraction.md`](provider-abstraction.md) /
  [`provider-state-machine.md`](provider-state-machine.md) — the
  `AgentProvider` / `AgentSession` contract a pi adapter must satisfy.
- [`deferred-roadmap.md`](deferred-roadmap.md) — item 7 places this in priority
  order (7.1 integration, 7.2 progress tracking).
