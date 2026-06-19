# Provider Refresh

> Provider refresh is YA's discipline for updating provider-facing protocol
> references, model and command catalogs, schema assumptions, and fallback
> constants when an upstream CLI, SDK, or harness change affects YA-visible
> behavior.

Topic: provider-refresh

Related topics: [claude](claude.md), [grok](grok.md),
[opencode-backend](opencode-backend.md),
[provider-state-machine](provider-state-machine.md),
[provider-model-glyphs](provider-model-glyphs.md),
[cost-efficiency](cost-efficiency.md).

## Contract

Provider release numbers are refresh triggers, not proof that YA behavior must
change. The thing to refresh is the provider surface YA actually consumes:

- startup command, flags, environment filtering, and authentication state;
- model catalog, default model, effort/thinking metadata, service tiers, and
  fallback constants;
- provider command inventory, steering, interrupt, compaction, permission, and
  session-resume controls;
- live protocol events, generated protocol types, event-normalization code, and
  approval/user-input request shapes;
- durable transcript, session index, storage schema, and reader coverage;
- UI-facing provider/model glyph rules only when the model ids users see have
  changed enough to make the existing rendering misleading.

An installed version may be newer than a recorded/expected version without
forcing code changes only when a refresh probe shows no YA-visible difference.
Record that evidence in this topic or the provider topic and keep a concrete
next trigger. Do not leave or lower a declared version just to silence work
when generated types, runtime probes, model catalogs, or schema coverage have
actually changed.

Cost and credential boundaries still apply during refresh work. Do not turn a
subscription-backed provider into an API-billed provider, or pass an ambient API
key to a CLI that normally uses browser/subscription auth, unless the user made
that choice explicit. See [cost-efficiency](cost-efficiency.md).

## Generic Refresh Loop

1. Identify the provider-owned sources of truth. Separate generated protocol
   files, live model/command catalogs, package APIs, local CLI docs, and durable
   transcript schemas.
2. Probe the current install. Capture the exact version, relevant `--help`
   output, model list, generated protocol check, and a small session/export
   sample when schema drift is the risk.
3. Diff YA-visible shape, not raw prose. Prefer normalized fingerprints:
   model ids plus metadata fields YA uses; flag names and accepted positions;
   generated file add/remove/change list; event or part-type coverage counts;
   package current/wanted/latest; schema parse failures or unknown entry counts.
4. Classify the result:
   - **No-op evidence**: version changed, but all consumed surfaces are stable.
     Record the probe and allow the recorded version to lag until the next
     trigger.
   - **Doc refresh**: comments, topic evidence, or fallback rationale are stale,
     but runtime behavior is still correct.
   - **Source refresh**: generated files, package APIs, hardcoded fallback
     constants, command flags, normalization, or tests need edits.
   - **Design refresh**: a new provider control surface exists but adopting it
     changes architecture or product behavior.
5. Enact source refreshes only after the provider-specific gate is satisfied.
   Codex compatibility edits, for example, are covered by the Codex version bump
   audit rule in `AGENTS.md`: the read-only drift check is allowed immediately;
   code edits should be explicitly approved.

## Codex

YA's active Codex backend is the installed `codex` CLI app-server path.
App-server generated types and JSON-RPC probes are the load-bearing refresh
inputs.

Former path note: YA previously carried `@openai/codex-sdk` and older docs
described that package as the Codex backend. It is no longer relevant to the
active provider or periodic Codex refresh flow. Do not fetch, mirror, or
regenerate an SDK replica for Codex refresh work unless the backend is
intentionally redesigned to import that package again.

Primary sources:

- root `package.json` `yepAnywhere.codexCli.expectedVersion`;
- `codex --version`;
- `scripts/update-codex-protocol.mjs`;
- `packages/server/src/sdk/providers/codex-protocol/generated/`;
- `packages/server/src/sdk/providers/codex-protocol/index.ts`;
- `packages/server/src/sdk/providers/codex-protocol/README.md`;
- `packages/server/src/sdk/providers/codex.ts`;
- `packages/shared/src/codex-schema/`;
- persisted JSONL under `~/.codex/sessions/`.

Routine probes:

```bash
codex --version
pnpm codex:protocol:check
```

For a no-token model catalog check, query `codex app-server --listen
stdio://`, send `initialize`, send `initialized`, then call `model/list`.
`scripts/probe-codex-app-server-turns.mjs` is useful for steering/interrupt
contract checks, but it starts a real model turn and is not a routine catalog
probe.

Difference detectors:

- `pnpm codex:protocol:check` exits nonzero or lists generated file drift.
- `model/list` ids or fields consumed by `normalizeModelList()` differ from
  `PREFERRED_MODEL_ORDER`, fallback constants, tests, or UI expectations.
- Session JSONL adds entry or payload shapes that fall through only because
  `parseCodexSessionEntry()` returns raw unknown entries.
- App-server turn, steer, interrupt, approval, user-input, raw-item, or token
  usage notifications change shape.
- Server startup warns that detected Codex version differs from
  `expectedVersion`; this alone is a trigger to run the checks above.

`expectedVersion` records the Codex CLI version YA's checked-in app-server
protocol subset was last audited against. It is not a minimum supported version:
older installs may continue to work when YA does not need newer protocol fields,
and version-sensitive behavior should be capability- or version-gated where
possible.

Current source refresh, 2026-06-16:

- Installed Codex is `codex-cli 0.140.0`; repo expected version is `0.140.0`.
- `pnpm codex:protocol:check` is clean after regenerating the checked-in
  app-server subset. Notable protocol drift from the 0.139 target: generated
  `AgentMessageInputContent` now admits `input_text`; `ThreadSource` is now
  provider-defined `string`; `ToolRequestUserInputParams` gained
  `autoResolutionMs`; `ThreadStartParams` gained selected capability roots; and
  `ThreadItem` gained `subAgentActivity`.
- App-server `model/list` returned the same visible YA model set:
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`; `priority`
  service tier remains on `gpt-5.5` and `gpt-5.4`.
- Runtime compatibility change: YA now normalizes live `subAgentActivity`
  items into visible system messages. Codex docs say subagent activity is
  surfaced in the first-party CLI/app, so silently dropping those app-server
  items would make YA less faithful to the provider UI. Selected capability
  roots remain protocol-only for YA because this provider path does not set
  them, and tool user-input requests still receive empty answers in the current
  MVP path.

Status: Codex 0.140 compatibility refresh complete in source; no new
latest-Codex requirement was introduced.

Previous source refresh, 2026-06-14:

- Installed Codex is `codex-cli 0.139.0`; repo expected version is `0.139.0`.
- `pnpm codex:protocol:check` failed only because generated
  `v2/TurnStartParams.ts` changed a comment from turn-scoped environments to
  environments that also apply to subsequent turns. Regenerating the checked-in
  app-server subset produced no type-shape or runtime contract change.
- No Codex provider code needed changing: YA already treats turn environment
  overrides as sticky in the same way as the app-server comment now says, and
  the provider currently does not send `environments` on ordinary user turns.

Status: Codex 0.139 compatibility refresh complete in source; no new
latest-Codex requirement was introduced.

Previous source refresh, 2026-06-09:

- Installed Codex is `codex-cli 0.138.0`; repo expected version is `0.138.0`.
- `pnpm codex:protocol:check` is clean after regenerating the checked-in
  app-server subset. Notable protocol drift from the 0.135 target: generated
  `ReasoningEffort` is now provider-defined `string`; raw `ResponseItem` gained
  opaque `agent_message`; approval params gained `environmentId`; thread
  metadata gained `parentThreadId`; user-message params/items gained client ids;
  resume responses can include `initialTurnsPage`; workspace roots are typed as
  absolute paths; `persistExtendedHistory` is no longer part of start/resume
  params.
- Runtime compatibility change: YA no longer sends the deprecated
  `persistExtendedHistory` start/resume field. The field was already optional
  and deprecated in prior Codex versions, so omitting it avoids unknown-field
  risk on 0.138 without forcing old users to upgrade.
- App-server `model/list` still returned the visible YA model set:
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`; `priority`
  service tier remains on `gpt-5.5` and `gpt-5.4`.
- Startup version mismatch wording now describes the package value as an
  advisory audited target, not a strict version requirement.

Status at the time: Codex 0.138 compatibility refresh complete in source; no
new latest-Codex requirement was introduced.

Previous read-only audit, 2026-06-05:

- Installed Codex is `codex-cli 0.137.0`; repo expected version is `0.135.0`.
- `pnpm codex:protocol:check` failed. New generated files:
  `v2/SortDirection.ts`, `v2/ThreadResumeInitialTurnsPageParams.ts`,
  `v2/TurnsPage.ts`. Changed generated files:
  `v2/PermissionsRequestApprovalParams.ts`, `v2/Thread.ts`,
  `v2/ThreadItem.ts`, `v2/ThreadResumeParams.ts`,
  `v2/ThreadResumeResponse.ts`, `v2/ThreadStartParams.ts`,
  `v2/TurnStartParams.ts`, `v2/TurnSteerParams.ts`.
- App-server `model/list` returned `gpt-5.5`, `gpt-5.4`,
  `gpt-5.4-mini`, and `gpt-5.3-codex-spark`.

Status at the time: Codex was due for a source refresh because generated
protocol files had changed.

## Claude

YA uses the official `@anthropic-ai/claude-agent-sdk` package and its native
Claude Code executable packages. There is no checked-in generated Claude
protocol; refresh work is package/API driven plus transcript-schema and model
catalog checks.

Primary sources:

- `packages/server/package.json` and `pnpm-lock.yaml` for
  `@anthropic-ai/claude-agent-sdk`;
- SDK `query()` control methods used in `packages/server/src/sdk/providers/claude.ts`;
- live `supportedModels()` and `supportedCommands()` from the SDK handshake;
- `CLAUDE_MODELS_FALLBACK`, `mergeClaudeModels()`, and `/goal` alias logic;
- `packages/shared/src/claude-sdk-schema/`;
- persisted Claude session JSONL under `~/.claude/projects/` or the configured
  `CLAUDE_CONFIG_DIR`.

Routine probes:

```bash
pnpm --filter @yep-anywhere/server outdated @anthropic-ai/claude-agent-sdk --format json
pnpm --filter @yep-anywhere/server test -- test/sdk/providers/claude.test.ts
```

When authenticated and the live model catalog matters, probe the provider's
`getAvailableModels()` path or the server provider catalog rather than updating
fallbacks from memory. A fallback edit is warranted only when the fallback would
be user-visible during auth/probe failure or when tests encode an outdated
normalization contract.

Difference detectors:

- Package latest version exceeds the lockfile version.
- SDK types or runtime methods used by `query()`, `supportedModels()`,
  `supportedCommands()`, `setModel()`, `setMaxThinkingTokens()`, `interrupt()`,
  or `mcpServerStatus()` change.
- The SDK starts reporting `/goal` natively or stops reporting `/loop`; YA's
  `/goal` alias must continue to step aside for native support.
- Claude transcript JSONL adds entry/content/tool-result shapes not represented
  by `claude-sdk-schema` or visible normalization tests.
- Model ids, effort levels, or context windows change enough to make fallback
  constants or model glyph rules misleading.

Current source refresh, 2026-06-19:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.170` to `0.3.183`,
  whose package metadata declares bundled Claude Code `2.1.183`.
- Claude Code 2.1.181 added automatic recovery for API connection drops during
  thinking. This matters to YA because local provider startup prefers the
  SDK-bundled executable over an independently installed `claude` binary.
- YA now opts into Claude Code's persistent retry watchdog for retryable
  429/529 responses and preserves the original in-flight request with
  exponential backoff capped at five minutes. The documented retry-count limit
  is set to an effectively unbounded value for other transient server, timeout,
  and connection failures. Both launch values preserve explicit operator
  overrides.
- SDK type drift adds `system/informational` user-visible banners and
  `system/worker_shutting_down` remote-worker lifecycle events. YA's loose
  server pass-through accepts both. `worker_shutting_down` is not authoritative
  for YA's locally owned process lifecycle; `informational` still needs a
  deliberate client rendering policy because the current system-message
  allowlist drops it.

Status: retry compatibility is refreshed through Claude Code 2.1.183. The new
informational-message rendering surface remains a known follow-up rather than a
retry-path blocker.

Current read-only/local audit, 2026-06-14:

- Local `claude --version` reports `2.1.177 (Claude Code)`.
- YA has no checked-in expected Claude CLI version gate analogous to Codex's
  `expectedVersion`. The Claude provider resolves the installed executable,
  checks `--version` for usability, and relies on SDK/live catalog probes for
  model and command surfaces.
- The 2.1.177 behavior YA currently depends on is already recorded in
  [claude](claude.md) and [session-ownership](session-ownership.md): `--resume`
  appends to the same transcript file, live processes do not re-read external
  appends, concurrent writers fork the `parentUuid` chain, and later resume can
  silently drop one branch. No provider source change is indicated by this
  local version check.

Status: Claude 2.1.177 awareness is documented; no source refresh needed from
the local CLI version alone.

Previous source refresh, 2026-06-09:

- `@anthropic-ai/claude-agent-sdk` was refreshed from `0.3.158` to `0.3.170`,
  whose package metadata declares bundled Claude Code `2.1.170`.
- Fable surfaced in the new SDK types as the `fable` model alias and
  `claude-fable-5` full model id. YA now exposes a fallback `fable` option so
  users can select it even when the live model probe is unavailable.
- Fable context and effort metadata are reflected in YA's fallback catalog:
  1M context, adaptive thinking, and `low`/`medium`/`high`/`xhigh`/`max`
  effort levels with `high` as the default.
- SDK model metadata already carried optional adaptive/fast/auto mode flags;
  YA now preserves those fields from `supportedModels()` rather than dropping
  them.
- Follow-up UI mapping:
  - `supportsAdaptiveThinking: false` hides adaptive thinking modes in the
    shared thinking controls and normalizes outgoing turn settings to `off`.
  - `supportsEffort: false` hides the forced `on:<effort>` mode while keeping
    adaptive `auto` available.
  - `supportsAutoMode: true` exposes permission mode `auto` in the session
    toolbar and in new-session/new-session-default permission choices. Absent
    metadata keeps the previous permission-mode list for older executables.
    The fallback `fable` catalog entry must carry this flag too; otherwise
    cached or fallback provider discovery hides the new permission option even
    after the model itself appears.
- `supportsFastMode` is still metadata-only in YA. Claude Code exposes fast
  mode as `/fast` or a settings-layer `fastMode` knob with explicit cost
  trade-offs, not as an existing YA per-turn/process-config field. Exposing it
  should be a separate provider-control slice with an explicit default/on/off
  setting and cost copy rather than silently attaching it to model selection.
- Other SDK drift inspected but not enacted in this slice: pending
  `request_user_dialog` replay fields, usage and skill-reload control methods,
  repo-root/stage-file control requests, and additional hook/settings schema
  growth. No current YA call site requires those methods for Fable exposure.

Status at the time: Claude Fable/model-metadata refresh complete in source.
Older Claude Code executables can still use the existing model choices;
selecting `fable` requires an upstream install/account that recognizes that
alias.

Previous read-only audit, 2026-06-05:

- `@anthropic-ai/claude-agent-sdk` is pinned/current at `0.3.158`; latest npm
  version is `0.3.163`.

Status: Claude is due for a package/API audit and likely dependency refresh.
No checked-in generated Claude protocol needs regeneration.

## Grok ACP

Grok Build is beta and its local installation is the best source of truth for
the provider YA actually launches. Public docs are secondary to the installed
CLI docs and local caches.

Primary sources:

- `grok --version`;
- `grok models`;
- `~/.grok/models_cache.json`;
- `grok --help`, `grok agent --help`, and `grok agent stdio --help`;
- local docs under `~/.grok/docs/user-guide/`, especially
  `15-agent-mode.md`, `17-sessions.md`, `03-keyboard-shortcuts.md`,
  `11-custom-models.md`, and `22-permissions-and-safety.md`;
- `packages/server/src/sdk/providers/grok-acp.ts`;
- `packages/server/src/sessions/grok-reader.ts`;
- ACP SDK dependency `@agentclientprotocol/sdk`;
- persisted sessions under `~/.grok/sessions/`.

Routine probes:

```bash
grok --version
grok models
node -e 'console.log(require("fs").readFileSync(`${process.env.HOME}/.grok/models_cache.json`, "utf8"))'
grok agent --help
grok agent stdio --help
```

Difference detectors:

- `grok models` or `models_cache.json` contains model ids or metadata not
  represented by `GROK_MODELS`, or the default model changes.
- `grok agent` flags move between top-level, `agent`, and `agent stdio`
  positions; YA currently places effort/model flags before `agent stdio`.
- Local docs add or remove ACP methods, permission modes, interject/steering
  semantics, session storage files, compaction behavior, or custom-model
  credential precedence.
- ACP update or permission request shapes no longer match `GrokACPProvider`
  normalization tests.
- `@agentclientprotocol/sdk` changes enough to alter `ACPClient` request,
  notification, or permission typings.

Current read-only audit, 2026-06-05:

- Installed Grok is `grok 0.2.22 (967574cb1) [stable]`; the topic and provider
  header still contain `0.2.3` and `0.1.220` evidence.
- Local user-guide docs were refreshed at `2026-06-05 01:01 UTC`.
- `grok models` reports default `grok-build` and available
  `grok-composer-2.5-fast` plus `grok-build`.
- `models_cache.json` now stores models in an object keyed by id and includes
  `grok-composer-2.5-fast`; YA's provider still hardcodes only `grok-build`.
- `grok agent --help` exposes `-m/--model`, `--reasoning-effort`, and
  `--always-approve`; `grok agent stdio --help` still has no subcommand flags.
- `@agentclientprotocol/sdk` is pinned/current at `0.12.0`; latest npm version
  is `0.24.0`.

Status: Grok ACP is due for at least a doc/header/model-catalog refresh, and
possibly a source refresh if YA should expose `grok-composer-2.5-fast` or adapt
to the newer ACP SDK.

## OpenCode

YA's OpenCode backend currently uses `opencode serve` over HTTP/SSE plus durable
storage/export readers. The provider dynamically queries `opencode models`, so
ordinary remote model-catalog changes do not by themselves require a source
refresh unless fallback constants, sorting, or model glyphs become misleading.

Primary sources:

- `opencode --version`;
- `opencode models`;
- `opencode serve --help`;
- `opencode acp --help` for strategic ACP comparison;
- live SSE events from `opencode serve`;
- `opencode export <sessionID>` and storage under
  `~/.local/share/opencode/storage/`;
- `packages/server/src/sdk/providers/opencode.ts`;
- `packages/server/src/sessions/opencode-reader.ts`;
- `packages/shared/src/opencode-schema/`;
- [opencode-backend](opencode-backend.md) coverage tables.

Routine probes:

```bash
opencode --version
opencode models
opencode serve --help
opencode acp --help
```

When transcript/rendering compatibility is the question, sample real exports
and SSE fixtures, then count part/event types against visible YA block coverage
as described in [opencode-backend](opencode-backend.md). Keep both raw coverage
and coverage after excluding deliberate metadata-only parts.

Difference detectors:

- `opencode serve` request/response, SSE, liveness, or permission route shapes
  change.
- New stored/export part types are skipped by `convertOpenCodeParts()` but
  should be visible text, thinking, tool use, tool result, or file-change UI.
- `opencode models` changes the provider/model id format, breaking
  `provider/model` parsing or the `local-glm/*` first sorting contract.
- `opencode acp` becomes mature enough to justify a design comparison against
  the current HTTP/SSE provider.
- Model ids become misleading in the model indicator UI; that belongs with
  [provider-model-glyphs](provider-model-glyphs.md), not necessarily the
  provider runtime.

Current read-only audit, 2026-06-05:

- Installed OpenCode is still `1.15.13`, matching the existing
  [opencode-backend](opencode-backend.md) local sample version.
- `opencode models` returns a current dynamic catalog including new Copilot,
  OpenAI, Claude, Gemini, Hugging Face, and `local-glm` entries; this is
  runtime data and the provider already queries it dynamically.
- `opencode acp --help` exists, but YA still uses `opencode serve`.

Status: OpenCode is not due for a routine version refresh from the local binary
state. It has a design-refresh candidate if YA wants to evaluate the ACP backend
instead of the current HTTP/SSE backend, and the dynamic model catalog may
justify a separate glyph/UI polish pass.

## Package Cross-Checks

The server package currently pins provider-adjacent packages as follows:

| package | current/wanted | latest observed | role |
|---|---:|---:|---|
| `@anthropic-ai/claude-agent-sdk` | `0.3.158` | `0.3.163` | Active Claude provider dependency |
| `@agentclientprotocol/sdk` | `0.12.0` | `0.24.0` | Active ACP client dependency for Grok/Gemini |

Treat both rows as provider-refresh inputs.
