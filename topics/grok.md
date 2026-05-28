# Grok Build Provider

This topic tracks integration of xAI's Grok Build (the agentic coding CLI invoked as `grok`) as a YA provider. Emphasis is on ACP-driven live supervision for tool activity (read/edit/execute/think) and thinking visibility, CLI-native effort/model controls, and (later) history interop from `~/.grok/` artifacts. All prototype and implementation work is deliberately isolated to new Grok-specific files and behind `ENABLED_PROVIDERS` so that no other provider or core routing path can regress.

Related topics: [claude.md](claude.md), [provider-state-machine.md](provider-state-machine.md), [provider-model-glyphs.md](provider-model-glyphs.md), architecture-mandates.md.

## Background (as of late May 2026)

Grok Build is xAI's terminal-first coding agent (early beta, announced ~May 2026). It supports interactive TUI, headless (`grok -p "..."`), subagents, skills, AGENTS.md, hooks, MCP, rich sandbox + permission system (modes overlap YA's `plan`/`acceptEdits`/`bypassPermissions` etc.), and explicit ACP support for embedding in other apps/IDEs.

Local evidence on this host (non-destructive inspection of the installed binary and state):
- Version: `grok 0.1.220`
- `grok models` (authoritative): default `grok-build`, plus
  `grok-build-latest` available from the CLI.
- `~/.grok/models_cache.json`: only model `"grok-build"`, name "Grok Build", description "Best for advanced coding tasks", `supports_reasoning_effort: false`, context 512k.
- Top-level CLI flags (from `--help`): `-m/--model <MODEL>`, `--effort <LEVEL>` (values: low, medium, high, xhigh, max), `--reasoning-effort <EFFORT>`, `--permission-mode`, `-p/--single`, `grok models`, `grok sessions`, ACP integration path documented for "other apps".
- Session storage: `~/.grok/sessions/<encoded-cwd>/<uuid>/` containing `chat_history.jsonl`, `events.jsonl`, `updates.jsonl`, `summary.json`, plus top-level `session_search.sqlite`. Multi-file per-session layout (more like Codex than Claude's single rich jsonl).

ACP (via the already-vendored `@agentclientprotocol/sdk` and YA's `ACPClient`) is the highest-leverage integration surface. Protocol surfaces:
- `agent_thought_chunk` (thinking/reasoning exposure)
- `tool_call` / `tool_call_update` with `kind` in {"read","edit","delete","move","search","execute","think","fetch","other"}, `locations[]` (file+line follow-along), `content` including `Diff` for edits, raw I/O, status lifecycle
- `plan` updates
- Permission requests (map to YA `onToolApproval`)

This gives first-class visibility into read, edit (with diffs), bash/execute, and thinking — comparable or better structured than current Claude events for supervision use cases.

## Model and Effort Controls — Recommendation for YA New Session UI

YA's new-session flow (`NewSessionForm.tsx`, `useProviders`, `getAvailableModels()` from the provider, `useModelSettings` + `EFFORT_LEVEL_OPTIONS`, `ModelInfo` + `EffortLevel` / `ThinkingConfig` / `ThinkingOption` in `packages/shared/src/types.ts`) populates a per-provider model dropdown + optional effort/thinking toggle.

From the Grok CLI + cache (the source of truth for what the local `grok` binary will actually run):

- The only model id the CLI and TUI use is **`grok-build`** (display name "Grok Build" or "Grok Build (default)").
- `grok -m grok-build` (or simply omitting `-m`) selects it.
- The model entry explicitly reports `supports_reasoning_effort: false`.
- However the CLI itself exposes global flags `--effort` and `--reasoning-effort` (plus the values low/medium/high/xhigh/max line up closely with YA's `EffortLevel = "low" | "medium" | "high" | "max"`).

**Recommendation for the Grok provider implementation**:
- `getAvailableModels()` must return (at minimum) `[{ id: "grok-build", name: "Grok Build", description: "Best for advanced coding tasks", ... }]`.
- In the YA new-session UI the entry for a "grok" provider will therefore read naturally as **"grok-build"** (or "Grok Build" with the id in parens or tooltip). This matches what `grok models` and the TUI actually present to the user.
- Effort/thinking toggle: the provider can advertise support (via the existing `supportsThinkingToggle` flag or equivalent) and map the selected `EffortLevel` to the appropriate `--effort` / `--reasoning-effort` flag when constructing the start command or ACP session params. Default behavior when no effort is chosen: omit the flag (let the agent decide, consistent with the model's cache entry having `reasoning_effort: null`).

No special casing or UI changes are required in `NewSessionForm` or the model settings hooks; the normal per-provider `ModelInfo[]` path is sufficient.

API note: the underlying model is also exposed as `grok-build-0.1` on the public xAI API, but the CLI / local agent surface uses the `grok-build` slug.

## Integration Plan (Explicitly Isolated — Zero Risk to Other Providers)

The mandate from local rules and architecture docs is to prototype Grok-specific concerns without touching load-bearing shared paths.

**Phase 0 (research, this topic) — complete**
- Local + docs inspection of models, effort flags, ACP surface, session layout (done).
- Model name decision recorded above.

**Phase 1 (live supervision prototype — highest value, lowest surface)**
- Add `"grok"` (and/or `"grok-acp"`) to the `ProviderName` union and `ALL_PROVIDERS` list (additive only).
- New file only: `packages/server/src/sdk/providers/grok.ts` (or `grok-acp.ts`) that:
  - Implements `AgentProvider` + `startSession` using the existing `ACPClient`.
  - Spawns the `grok` binary with appropriate ACP/stdio flags (discover exact flag via `grok --help` or test; precedent is Gemini's `--experimental-acp`).
  - Normalizes `SessionNotification` / `agent_thought_chunk` / `tool_call` (kinds + diffs + locations) into `SDKMessage` (thinking blocks + tool_use/tool_result).
  - Wires permission callbacks to YA's `CanUseTool`.
  - Returns `ModelInfo[]` with the single `grok-build` entry.
  - Maps effort from YA `EffortLevel` to CLI flags where possible.
- Register the new provider instance in `providers/index.ts` (additive switch case + `getAllProviders`).
- Extend `ENABLED_PROVIDERS` parsing and the provider-resolution / routes paths (additive; existing providers unaffected when the env var is not set or does not include "grok").
- CLI detection + auth status: presence of `~/.grok/bin/grok` + `~/.grok/auth.json` or `config.toml` (read-only checks).
- All of the above lives in brand-new files or tiny additive deltas. `Process`, `Supervisor`, message routing, other provider implementations, and the client render pipeline are untouched.

**Phase 2 (history / interop)**
- New scanner: `packages/server/src/projects/grok-scanner.ts` (modeled on `codex-scanner.ts`).
- Minimal schema under `packages/shared/src/grok-schema/` for the multi-file jsonl + sqlite layout (only as needed for list + transcript loading).
- Wire into `ProjectScanner` (additive branch).

**Phase 3 (polish)**
- Update docs (CLAUDE.md provider list, `docs/research/provider-capabilities.md`, README table, competitive matrix).
- Add version expectation (like Codex) + audit note in `AGENTS.md`.
- Tests, mocks in `__mocks__/`, e2e if warranted.
- Publish remote client (per local rules) only after a verified live-supervision win.

**Explicit non-goals for early prototypes (stability protection)**
- No edits to `Process.ts`, `EventBus`, replay buffer logic, or any shared hot path.
- No changes to how other providers are instantiated or how their iterators are wrapped.
- Scanner/history work can be stubbed or behind a separate feature flag initially.
- ACP client and normalization code can be copied/adapted from `gemini-acp.ts` into the new Grok file (no shared refactoring until the Grok impl is proven).

This structure guarantees that enabling or even crashing the Grok prototype (via `ENABLED_PROVIDERS=grok`) cannot affect Claude, Codex, Gemini, or OpenCode users or sessions.

## Open Questions & Epistemic Status

- Exact ACP invocation flag for the `grok` binary (local test will resolve quickly).
- Real-world richness of `agent_thought_chunk` and `tool_call_update` (with diffs) for `grok-build` workloads — the protocol supports it; the backend implementation quality is the variable.
- Evolution of the on-disk multi-file + sqlite layout during the beta (treat as unstable; ACP live path is the stable contract for supervision).
- Whether `grok` will later advertise `supports_reasoning_effort: true` for the model or expose more granular thinking controls.

All claims above are grounded in direct local binary + state inspection on this machine plus the official docs.x.ai/build/* pages (as of the dates in the tool results). Beta software; surfaces can change.

## Steering, Interject, and /btw Forking Support

YA has two distinct but complementary mechanisms for "talking to an agent that is already working":

1. **In-turn steering / interjection** (`AgentSession.steer(message)` returning `Promise<boolean>`):
   - Sends additional user input into the *currently running turn* without cancelling it.
   - YA's `Process` prefers this path (when `in-turn` and `supportsSteering`) over simply queuing the message for after the turn ends.
   - The boolean return tells the caller whether the provider accepted it for immediate steering.

2. **/btw aside fork** (full parallel subsession):
   - YA creates an entirely new provider session (separate `startSession` call) that runs alongside the parent.
   - Special UI (split-pane or stacked "asides", `[YA /btw aside]` markers, transfer between mother/aside composers, `/done` to close).
   - Controlled by the client-side `BTW_ASIDE_FORK_PROVIDERS` whitelist + `providerSupportsBtwAsideFork`.
   - This is the "fork/subsession based btw-like flow".

Grok Build's own TUI makes the distinction very clear (from `~/.grok/docs/user-guide/03-keyboard-shortcuts.md`):

> When the agent is generating, `Ctrl+Enter` from the prompt sends a **mid-turn interjection without cancelling the turn**.
>
> | `Ctrl+Enter` | Interject (continues the current turn) |

`Ctrl+C` is the cancel/interrupt.

### ACP Primitives Available

- `session/prompt` — can be called more than once. Agents are expected to handle follow-up prompts while a turn is active (exactly the interject use case).
- Experimental `session/fork` (takes `sessionId`) — maps directly to YA's aside model.
- `session/cancel` — the interrupt path (already used by Gemini-ACP etc.).

Current state in YA's ACP providers (Gemini-ACP etc.): `supportsSteering = false` because the current `ACPClient.prompt()` wrapper + Gemini usage is "one prompt + wait for completion".

### Feasibility & Plan for the Grok Provider

**Good news**: Grok Build's native behavior + ACP surface makes this one of the *better* providers for both mechanisms.

Recommended approach (add to the Phase 1 implementation in the existing plan):

- Set `readonly supportsSteering = true;` on the Grok provider.
- Implement `steer(message)` in the `AgentSession` return value by calling a second `connection.prompt(...)` (or extend `ACPClient` with an `interject(sessionId, text)` helper that re-uses the same session). Return `true` on success.
- For the full `/btw` fork experience:
  - Add `"grok"` to `BTW_ASIDE_FORK_PROVIDERS` in `SessionPage.tsx` (YA-level forking will just work once the provider can start sessions).
  - Later (when Grok advertises the capability), prefer the native ACP `ForkSessionRequest` for the aside.
- `interrupt()` can be wired to `session/cancel` (or whatever Grok's ACP equivalent is).

A brand-new "explicit btw surface" is probably unnecessary. The existing `/btw` slash command + composer routing + the `steer` primitive should give users the same power as the TUI's Ctrl-Enter interject, plus the richer aside UI that YA already has for Claude/Codex users.

If Grok's ACP agent treats a second `prompt` during a turn as "start a new turn instead of interject", we may need a small protocol extension or a Grok-specific interject RPC — but given that the TUI itself offers the feature, the underlying agent loop is almost certainly already doing the right thing.

Update the tracking checkboxes below to include these items.

## Local Grok Build Documentation (Authoritative Source for Implementers)

**Critical for any future agent or human implementer:**

The most accurate and up-to-date information about Grok Build's CLI surface, ACP behavior, keyboard shortcuts (including the `Ctrl+Enter` interject), session storage layout, configuration, headless usage, and capabilities lives in the **locally installed documentation** on this machine:

- `~/.grok/docs/user-guide/`
  - `03-keyboard-shortcuts.md` — especially the "During an active turn" section documenting `Ctrl+Enter` interject.
  - `05-configuration.md`
  - `14-headless-mode.md`
  - Other files as they appear (skills, modes, ACP integration notes, etc.).

Also authoritative on this host:
- `~/.grok/bin/grok --help`
- `grok models`
- `~/.grok/models_cache.json`
- Actual session directories under `~/.grok/sessions/...` (multiple `.jsonl` files per session + `session_search.sqlite`).

Public docs at `https://docs.x.ai/build/...` are useful for high-level overview but lag the locally installed TUI docs. Always prefer the files under `~/.grok/docs/user-guide/` when implementing against the real binary.

Any subagent or human doing the implementation work **must** be explicitly instructed to read the contents of `~/.grok/docs/user-guide/` as primary source material alongside this topic file.

## Progress Snapshot (2026-05-26 Takeover)

Current live repo state has a Grok ACP provider at a verified Phase 1 point.
It has landed as an isolated provider integration, with history replay left as
explicit follow-up work.

What is already in place:

- `"grok"` is added to the shared and server provider names and provider list.
- `packages/server/src/sdk/providers/grok-acp.ts` starts `grok agent stdio`
  through the existing ACP client.
- Provider registration is wired through the server provider catalog and
  `ENABLED_PROVIDERS` filter path.
- The new-session client can see provider metadata once the server reports it;
  client provider badges/filter colors/registry are being filled in.
- Grok summary/session lookup is implemented in
  `packages/server/src/sessions/grok-reader.ts`, using Grok's native session
  ID (`summary.info.id` or the session directory basename) rather than a
  synthetic YA ID.
- Rich live ACP normalization now preserves `agent_thought_chunk` as thinking
  blocks, tool names mapped from kind/title (`Read`, `Bash`, etc.), tool
  kind/status, locations, raw input/content, and structured read/bash results.
- Active-turn steering is implemented by sending a second ACP
  `session/prompt` on the same live Grok session while keeping YA's update
  drain open until all active Grok prompt calls settle.
- Client provider registry/badges/filter colors/model glyphs are wired.
- `topics/grok.md` remains the active progress tracker; related reliability
  context is tracked in `tasks/015-verified-session-liveness.md`.

Issues found during takeover:

- Focused provider tests were failing before refinement:
  auth parsing treated any nonempty `auth.json` as authenticated, and mocked
  ACP tests expected connection side effects before advancing the async
  iterator.
- `grok models` on this host now reports `grok 0.1.220`, logged in via
  grok.com, default `grok-build`, and available `grok-build` plus
  `grok-build-latest`. The local `models_cache.json` still only lists
  `grok-build`.
- `grok agent stdio` accepts top-level `--effort`/`-m` before `agent`; putting
  `--effort` after `agent` is rejected by the CLI. Provider args should keep
  those flags before `agent`.
- The native-session-ID behavior is live-verified: the localhost new-session
  API blocks until Grok returns its own ACP session id, and process/metadata
  lookup works using that id.

Verification completed during takeover:

1. `grok-acp.test.ts` passes with 23 focused tests.
2. `REAL_GROK_TESTS=true FOREGROUND=1` real smoke passed against the installed,
   logged-in CLI.
3. `POST /api/projects/.../sessions` on localhost:3400 returned native Grok
   ids such as `019e6603-889a-7451-a3f1-e44f37cfb125`, and the matching
   `~/.grok/sessions/%2Flocal%2Fgraehl%2Fyepanywhere/<id>/summary.json`
   existed.
4. `/api/projects/.../sessions/<native-id>/metadata` and
   `/api/sessions/<native-id>/process` both resolved the same Grok id while
   the process was live.
5. A WebSocket session subscription observed thinking, `Read` and `Bash`
   tool uses, `kind`, `locations`, execute `status` lifecycle, tool results,
   structured file/stdout result payloads, and final assistant text.
6. Temporary Grok-provider sessions from this topic were aborted/removed from
   `~/.grok/sessions`, YA session metadata, and recents; no Grok YA processes
   or stale Grok debug processes remained after cleanup.

Known remaining gap:

- `GrokSessionReader.getSession()` is summary-oriented today. Native-id
  recovery/listing works, but full Grok transcript replay after server restart
  is still Phase 2 scanner/history work.

Near follow-up once the above is green:

- Live-smoke active-turn steering against the installed Grok CLI. Mocked
  coverage verifies the repeated ACP prompt path, but the beta CLI should still
  be exercised manually because native interject behavior is agent-side.
- Revisit model-list policy. `grok models` on 2026-05-26 reports
  `grok-build` and `grok-build-latest`, while `models_cache.json` currently
  only lists `grok-build`; YA should either expose only the stable default or
  dynamically reflect the CLI list.
- Keep local docs as the authoritative source for future work:
  `~/.grok/docs/user-guide/15-agent-mode.md`,
  `17-sessions.md`, `03-keyboard-shortcuts.md`, and related files.

## Tracking

The checkboxes below live in the committed topic doc and can be updated in
place. Liveness-specific evidence from the takeover is also mirrored in the
gitignored umbrella task `tasks/015-verified-session-liveness.md`.

- [x] Add "grok" / "grok-acp" to `ProviderName` + `ALL_PROVIDERS` (additive)
- [x] New `grok-acp.ts` minimal ACP-based provider returning the `grok-build` model and streaming normalized events (thinking + tools + approvals)
- [x] Effort / `--effort` mapping from YA `EffortLevel` using top-level CLI args
- [x] Auth/install detection and `isAuthenticated` using `~/.grok/` state, including nested auth profiles
- [x] Register + `ENABLED_PROVIDERS` wiring (no impact on default "all")
- [x] Native Grok session ID used in new-session URL and recoverable through provider metadata/process lookup
- [x] End-to-end live supervision test (visible read/bash/thought events in a desktop WebSocket subscription)
- [x] Rich ACP event fidelity test: thoughts, tool kind/status, locations, execute output, and structured read/bash results
- [x] Active-turn interject/steering via repeated ACP prompt (mocked coverage;
  live smoke still useful)
- [ ] (Phase 2) `grok-scanner.ts` + minimal schema for session listing + history — summary reader exists; full scanner/history replay not done
- [ ] Docs updates + version pinning note — topic and `CLAUDE.md` provider list updated; broader README/provider capability docs not done
- [ ] Decision point: promote "grok" to default-enabled once ACP surface proves stable

When the implementation work itself becomes a multi-session effort, a gitignored `tasks/NNN-grok-*.md` can be added then and cross-referenced here.

---

Topic: grok

<!-- epistemic status: local binary + cache + `grok models`/`--help` inspection + official docs.x.ai as of 2026-05; beta; plan prioritizes isolation per project rules -->
