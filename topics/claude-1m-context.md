# Claude 1M Context Window

> How Claude Code decides between a 200K and 1M context window, why
> yepanywhere's context-usage percentage for the same session can differ
> across server restarts and resumes, and the exact evidence behind each
> claim. No fix is prescribed here — this is a record of verified behavior.

Topic: claude-1m-context

Related topics: [provider-context-economics](provider-context-economics.md),
[resume-compaction](resume-compaction.md)

## Why this doc exists

The displayed context-usage percentage for a Claude Opus session has been
observed to be wrong in both directions: understated (4% when it should be
higher relative to a 200K window) and over 100% (a real "120%" reading).
The same session has been seen to switch between these depending only on
server lifecycle, not on anything about the session itself. This doc
collects what was actually measured so future work starts from evidence
rather than re-derivation.

Everything below was verified against:
- CLI `claude` v2.1.175 (`~/.local/share/claude/versions/2.1.175`, a
  compiled Mach-O bun binary) and SDK
  `@anthropic-ai/claude-agent-sdk@0.3.170`.
- Live `claude -p "<tiny prompt>" --output-format json --model <X>` probes,
  reading `modelUsage[<model>].contextWindow` from the result.
- Two real sessions on this machine and the running server on
  `https://localhost:3400`.

Account/CLI behavior is account- and version-specific; the probe commands
are included so claims can be re-checked when either changes.

## What the SDK/CLI actually does

### The window is decided by the CLI, not by yepanywhere

There is no `[1m]`, `context-1m`, beta-header, or window logic anywhere in
the yepanywhere server. The server passes the model string through to the
SDK and trusts what the SDK reports. The 200K-vs-1M decision is made
entirely inside the Claude CLI/SDK and the account.

The relevant beta is defined in the SDK
(`@anthropic-ai/claude-agent-sdk/assistant.mjs`):
`long_context` → header `context-1m-2025-08-07`.

### The decompiled window resolver (CLI v2.1.175)

From `strings` on the CLI binary, the window resolver and its predicates:

```js
function H97(H,_){              // H = model, _ = betas
  if(Sw(H)) return 1e6;                          // model string has [1m]
  if(_?.includes(Jl.header) && KF(H)) return 1e6; // 1m beta present + 1m-capable model
  if(gy(H)) return 1e6;                           // auto-1M models on qualifying accounts
  ...                                             // else falls through to standard (200K)
}
function Sw(H){ if(yOH()) return!1; return /\[1m\]/i.test(H); }
function gy(H){ if(yOH()) return!1;
  let _=K9(H);                                    // canonical model id
  if(_!=="claude-fable-5" && _!=="claude-mythos-5"
     && _!=="claude-opus-4-7" && _!=="claude-opus-4-8") return!1;
  let q=Hw(H);                                    // account/auth tier
  return q==="firstParty"&&JO() || q==="anthropicAws" || q==="mantle";
}
function KF(H){ ... fable-5, mythos-5, opus-4-8/4-7/4-6,
                    sonnet-4-6/4-5/4-0 → true }    // "1m-capable"
function yOH(){ return O_(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT); }
```

Read this as three independent paths to 1M — explicit `[1m]` suffix; the
`long_context` beta on a capable model; or `gy()` auto-upgrade — and one
master kill switch (`yOH()`) that disables all of them. `yOH()` reads
exactly one thing: the env var `CLAUDE_CODE_DISABLE_1M_CONTEXT`.

The CLI also auto-adds the beta for auto-1M models (`if(Sw(H))_.push(Jl)`
and a push when the model is 1m-capable), so opus-4-8 sends the
`context-1m` beta without the user opting in.

The embedded API model metadata in the same binary lists
`claude-opus-4-8` with `max_input_tokens: 1000000`.

### Measured probe results

Tiny-prompt `claude -p ... --output-format json`, reading
`modelUsage[model].contextWindow`:

| `--model` | resolved model | reported contextWindow |
|---|---|---|
| `opus` | `claude-opus-4-8` | 1,000,000 |
| `opus[1m]` | `claude-opus-4-8[1m]` | 1,000,000 |
| `claude-opus-4-8` | `claude-opus-4-8` | 1,000,000 |
| `claude-opus-4-5` | `claude-opus-4-5` | 200,000 |
| `claude-opus-4-1` | `claude-opus-4-8` (resolved) | 1,000,000 |
| `sonnet` | `claude-sonnet-4-6` | 200,000 |
| `sonnet[1m]` | — | **error** (see below) |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` + `opus` | `claude-opus-4-8` | **200,000** |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` + `claude-opus-4-8` | `claude-opus-4-8` | **200,000** |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000` + `opus` | `claude-opus-4-8` | 1,000,000 (unchanged) |

`sonnet[1m]` on this account returned a result message with
`is_error: true, api_error_status: 429` and the text:

> "API Error: Usage credits required for 1M context · turn on usage
> credits at claude.ai/settings/usage, or use --model to switch to
> standard context"

### What the probes establish (only this)

- **opus-4-8 auto-runs at 1M** on this account: plain `opus`,
  `opus[1m]`, and the concrete id all report 1,000,000, with no error.
  This matches the `gy()` auto-1M path. The model field in the transcript
  is `claude-opus-4-8` with **no `[1m]` suffix** even when running 1M, so
  the model string alone cannot tell you the window.
- **sonnet-4-6 stays at 200K** by default (`sonnet` → 200,000), and is not
  in `gy()`'s auto-1M list. Requesting `sonnet[1m]` on this account is
  credit-gated (the 429 above).
- **`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` forces 200K** for opus-4-8 (both the
  alias and the concrete id), consistent with `yOH()` short-circuiting
  every 1M path. This was the only mechanism observed to produce a 200K
  opus-4-8 window. There was no model-string way to get a 200K opus-4-8.
- **`CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000` did not change** the reported
  window (stayed 1,000,000). Its effect was not characterized further here.

Not established: whether opus-4-8's 1M draws usage credits on this account
(the picker text in the binary says "Draws from usage credits", but the
probe did not error and credit accounting was not measured); how `gy()`
behaves on Bedrock/Vertex/gateway accounts; what exactly `JO()` requires
beyond a first-party base URL.

## How yepanywhere consumes this

yepanywhere never persists a session's real context window. It derives the
percentage from three layers, in this precedence:

1. **Live process value (most authoritative, transient).** `Process.ts`
   captures `contextWindow` from each SDK `result` message's `modelUsage`,
   taking the max across model entries
   (`packages/server/src/supervisor/Process.ts:2849`,
   `:2859`; getter at `:623`).
2. **In-memory model cache.** When a live process reports a window, it is
   cached via `ModelInfoService.recordContextWindow(...)`
   (`packages/server/src/routes/sessions.ts:2266`, `:2403`). The cache is a
   `Map` keyed by `"<provider>:<model>"`
   (`packages/server/src/services/ModelInfoService.ts:20`, `:67`) — **keyed
   by model, not by session**, and **in-memory only**. It is constructed
   empty on each server start (`packages/server/src/index.ts:383`); at
   startup only `claude-ollama` is warmed (`:483`), not `claude`. Even
   `warmProvider("claude")` would not help here: the Claude provider's
   model list is keyed by aliases (`opus`, `opus[1m]`, `default` —
   `packages/server/src/sdk/providers/claude.ts:382`, `:419`, `:425`), not
   the concrete `claude-opus-4-8` that sessions store. So the cache entry
   `claude:claude-opus-4-8` is **only ever** populated by a live process via
   path 1, and is gone after a server restart.
3. **Static heuristic fallback (often wrong for opus-4-8).**
   `getModelContextWindow(model, provider)`
   (`packages/shared/src/app-types.ts:247`) returns 1M only when the model
   string contains `[1m]` (`:259`); otherwise opus maps to `200_000`
   (`:216`, `DEFAULT_CONTEXT_WINDOW` `:190`). Because the live model string
   is `claude-opus-4-8` with no `[1m]`, this fallback yields **200,000** for
   an opus-4-8 session that is actually running 1M.

The reader composes these via `resolveContextWindow`
(`packages/server/src/sessions/reader.ts:174`, defaulting to
`getModelContextWindow`, overridden with `ModelInfoService.getContextWindow`
in `packages/server/src/app.ts`), then computes
`percentage = round(inputTokens / contextWindow * 100)`
(`packages/server/src/sessions/reader.ts:656`), where `inputTokens` is the
last assistant message's `input + cache_read + cache_creation`
(`:615`).

### Two endpoints disagree

- `GET /projects/:id/sessions/:id/metadata` returns the reader's value as-is
  (`packages/server/src/routes/sessions.ts:2029`). It does **not** apply the
  live-process override.
- `GET /projects/:id/sessions/:id` (detail) **does** override with
  `process.contextWindow` when a live process exists
  (`packages/server/src/routes/sessions.ts:2392`).

So for the same session with a live process, metadata and detail could
report different windows when the cache is cold.

### No clamp on some percentage surfaces

`ContextUsageIndicator` clamps the pie/label to 0–100
(`packages/client/src/components/ContextUsageIndicator.tsx:27`), but other
surfaces render the raw value:
`ProcessInfoModal.tsx:409` (`percentage.toFixed(1)%`) and
`renderers/tools/TaskRenderer.tsx:420` (`percentage.toFixed(0)% context`).
A raw percentage above 100 therefore displays literally (e.g. "120%").

## Observed reproductions

### Session A — `eb965abc-...` (default model, live)

- Transcript model: `claude-opus-4-8`, no `[1m]`.
- SDK `result` messages for this session
  (`~/.yep-anywhere/logs/sdk-raw.jsonl`, SDK logging on) reported, in the
  same result: `claude-opus-4-8 → contextWindow 1000000` and
  `claude-haiku-4-5-20251001 → contextWindow 200000` (haiku is used for
  side tasks like title generation).
- While the cache was warm, metadata reported window 1,000,000 and a single-
  digit percentage. After a later server restart (cache cold), the same
  session's metadata reported window 200,000 — even with `owner: self` —
  because metadata does not apply the live-process override.

### Session B — `3620c4de-...` (the "120%" case)

- Transcript model: `claude-opus-4-8`. Max single-call fill (last assistant
  message, `input + cache_read + cache_creation`) = **239,924 tokens**.
- **Zero** real compaction boundaries in the transcript (checked for
  `isCompactSummary`, `subtype: "compact_boundary"`, and `compactMetadata`;
  count was 0). A 200K-window session would have auto-compacted well before
  240K; this one did not, and a single API call carried 239,924 tokens —
  consistent only with a window larger than 200K. This is the clearest
  evidence on this machine that opus-4-8 here runs above 200K.
  - Caveat about an earlier mis-read: a first throwaway script flagged
    "compaction markers seen" using a crude substring match on the whole
    JSON line, which matched the literal word "compact" (e.g. the
    `/compact` entry in the session's slash-command list). The precise
    check immediately after returned 0. There was no compaction.
- With a cold cache and no live process, metadata reported window 200,000
  → 239,924 / 200,000 = **120%**.
- After the session was **resumed** (spawning a live process that reported
  1,000,000 and repopulated the model-keyed cache), metadata for the same
  unchanged 239,924 fill reported window 1,000,000 → **24%**. Because the
  cache is keyed by model, Session A simultaneously flipped back to a 1M
  window without being touched.

### Two different "restart" events, plus terminate

The displayed window/percentage is a function of the three-layer state
above, and three distinct events move it. They are easy to conflate but do
different things:

1. **Claude session resume** (a per-session event; YA spawns a new
   YA-owned SDK process for that session). The new process captures the
   real window from SDK `result` messages (path 1) and, once the detail or
   new-session route observes it, writes it to the model-keyed cache (path
   2). Effect: **repopulates the cache** → fixes the reported window for
   that model going forward. Because the cache key is the model, resuming
   one opus-4-8 session corrects the reported % for *every* idle opus-4-8
   session at once (observed: resuming Session B flipped Session A back to
   1M without touching it).

2. **YA server restart** (a process-global event; the whole yepanywhere
   server restarts). The `ModelInfoService` cache is reconstructed empty
   (`packages/server/src/index.ts:383`) and nothing warms
   `claude:claude-opus-4-8` (see path 2 above). Effect: **wipes the cache**
   → every idle opus-4-8 session reverts to the static 200K fallback until
   the next live opus-4-8 process runs. This is the state in which the
   "120%" reading appears.

3. **Terminate** (a per-process event; YA aborts a live process via
   `POST /api/processes/:processId/abort`,
   `packages/server/src/routes/processes.ts:146`). Termination runs
   `unregisterProcess`, which deletes the `Process` from the supervisor map
   and the session→process mapping
   (`packages/server/src/supervisor/Supervisor.ts:2986` and following), so
   `getProcessForSession` returns undefined and ownership becomes `none`.
   It does **not** touch the `ModelInfoService` cache. So terminate removes
   only the live-override layer (path 1); the reported window then falls
   back to whatever the cache holds (warm → still correct; cold → static
   200K). Terminate is therefore not an independent cause — it exposes the
   same cache/static layers that a server restart exposes.

   Status of this claim: derived from the code path above, and consistent
   with the observation that Session B shows `owner: none` yet a cached 1M
   window (a gone process whose cache entry survives). A clean isolated
   before/after terminate probe was **not** run: the only live session at
   investigation time (Session A) was `state: in-turn`, and aborting a
   user's active turn to test this was not worth the disruption.

### A session's window is not fixed for the session id

A session id does not have one context window for its whole life. YA can
switch the model of a live owned process via `Process.setModel`
(`packages/server/src/supervisor/Process.ts:1242`, updating
`_resolvedModel` at `:1262`), exposed as
`POST /api/processes/:processId/model`
(`packages/server/src/routes/processes.ts:372`). A model can also change on
resume or via a fork-with-override. So one session can run, e.g., opus-4-8
(1M) and later sonnet-4-6 (200K).

The reader already accounts for this: `extractModel` takes the model from
the **most recent** assistant message, with an explicit comment that the
model can change mid-transcript via `setModel`/fork
(`packages/server/src/sessions/reader.ts:696`). The window is therefore
resolved from the *current* (last) model, not the session's first model.

Two consequences worth keeping in mind:
- The model-keyed cache is a defensible fit here precisely *because* the
  window should track the current model rather than the session. Any future
  "persist the per-session window" idea must follow model changes, not write
  the window once at session creation.
- The displayed percentage at any instant is `last-assistant fill ÷
  current-model window`. After an opus→sonnet switch, a large opus-era fill
  divided by sonnet's 200K window can legitimately exceed 100% (a real
  over-limit that the CLI would resolve by compacting), which is distinct
  from the stale-cache "120%" bug above. The two causes look identical in
  the UI; only the window and model history distinguish them.

### The resulting non-determinism

For an idle opus-4-8 session, the displayed percentage depends on whether
any opus-4-8 process has run since the last server restart:

| Server state | Window used | Session B (239,924 fill) shows |
|---|---|---|
| Fresh after restart, no opus process run yet | 200,000 (static, wrong) | 120% |
| Any opus-4-8 process has run/resumed since restart | 1,000,000 (cached) | 24% |

## Related: the autocompact trigger (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`)

Adjacent to window *reporting* is when the CLI decides to **auto-compact**,
because that threshold is computed from the same effective context window.
This is CLI behavior, not yepanywhere behavior; YA only observes the
resulting compaction boundaries in the transcript.

Decompiled from CLI v2.1.175, the per-turn trigger token count:

```js
function qx_(H,_){            // H = effective context window in tokens
  let q=H-13000;             // default trigger: window − 13000 tokens
  let K=_.testPctOverride;   // = parseFloat(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
  if(K!==void 0 && !isNaN(K) && K>0 && K<=100)
    return Math.min(Math.floor(H*(K/100)), q);  // override is a PERCENT in (0,100]
  return q;
}
// related: function PcK(H,_) = min(H − round(H*precomputeBufferFraction), qx_(H,_))
// precomputeBufferFraction default (k1q) = 0.2
```

What the binary establishes:
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is read by `process.env`, parsed with
  `parseFloat`, and only applied when it is a number in `(0, 100]` — i.e. a
  **percent**, not a 0–1 fraction. It is named `testPctOverride` in the code
  (a testing knob).
- When set, the trigger becomes `floor(window * pct/100)`, but `Math.min`
  with `window − 13000` means it can only move the trigger **earlier**; it
  cannot push compaction past `window − 13000`, so it cannot be used to
  disable compaction.
- The default trigger (no override) is `window − 13000`. A separate
  "precompute" path (`PcK`) uses `precomputeBufferFraction`, defaulting to
  `0.2` (a 20% buffer, i.e. ~80% full).
- All of these are functions of the effective window `H`. The same percent
  therefore yields very different absolute triggers: ~80% of 1,000,000 vs
  ~80% of 200,000. This is why opus-4-8 (1M) sails past 200K with no
  compaction while sonnet (200K) compacts in the low-hundreds-of-thousands —
  consistent with the Session B evidence (239,924-token fill, no compaction).

Not characterized here: the exact interplay of the precompute, reactive,
and "blocking" thresholds (`PcK`/`WcK`/`testBlockingOverride`,
`CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`), or how `H` (effective window) is
reduced from the raw 1M/200K by reserved output/overhead (`P4H`).

This override is a useful, non-destructive way to *test* window math: set a
small percent and confirm a session compacts at the expected absolute token
count for its model's window.

## Fix (implemented): durable per-model window observations

The non-determinism above is path 2 being **in-memory only**: a server
restart drops every observed window, so idle opus-4-8 sessions fall back to
the static 200K heuristic (path 3) and read "120%" until some opus process
runs again. The fix makes observed windows survive restarts without changing
the resolution model — the window still tracks the *current model*, not the
session (see "A session's window is not fixed for the session id"), because
it stays keyed by model.

**Shape.** `ModelInfoService` keeps two layers, not one:

- **observed (durable).** Only `recordContextWindow(...)` writes it — fed from
  the **observation point itself**: `Process` emits a `context-window-observed`
  event for each `modelUsage` entry the moment a `result` message arrives
  (`Process.ts`), the `Supervisor` forwards it via the `onContextWindowObserved`
  callback (`Supervisor.observeProcessEvents`), and `app.ts` wires that to
  `ModelInfoService.recordContextWindow`. Keyed by `"<provider>:<model>"` with
  the model id **exactly as the SDK reports it** in `modelUsage` — no munging,
  because an observation should reflect what was observed (in practice the keys
  are bare concrete ids like `claude-opus-4-8`, matching the reader's lookup).
  **One record per model**: `{ contextWindow, observedAt }`.
  Persisted to `{dataDir}/model-context-windows.json` (versioned, debounced
  writes) and loaded on startup. Recording is **not** a side effect of any HTTP
  GET — an earlier version recorded only when the session-detail route happened
  to read a live process, so a model whose turns streamed over WS/relay without
  a detail fetch (verified: a standalone sonnet session) captured its window in
  the `Process` but never persisted it.
- **ingested (ephemeral).** `ingestModels`/`warmProvider` keep writing here as
  before — provider-list/heuristic values keyed by alias (`opus`, `opus[1m]`).
  Intentionally **not** persisted; persisting them would fill the durable file
  with static guesses under alias keys.

`getContextWindow` precedence is observed → ingested → static heuristic, and
the live-process value (path 1) still overrides everything at request time.
Full stack: **live process → durable observation → static default**.

**Why a file and not the transcript.** Verified empirically: a Claude `.jsonl`
holds the *numerator* but never the *denominator*. Assistant `message.usage`
carries only token counts (`input_tokens`, `cache_read_input_tokens`, …) with
no `contextWindow`, and `result` messages (which alone carry
`modelUsage[model].contextWindow`) are a streaming/SDK artifact Claude Code
does not write to the session file. The window is SDK-derived config that only
surfaces in the end-of-turn `result`, so there is nothing to recover it from
after the fact — hence our own small durable memo.

**Timing.** The window is observed and recorded at the same instant a YA-owned
process completes a full turn (the `result` handler that also calls
`transitionToIdle`) — no second trigger, no dependence on a client fetch. Until
a model has completed one turn under YA there is no observation and resolution
falls to the static default; after the first completion it is recorded,
persisted, and **flushes on every later completion** (so `observedAt` means
"last confirmed", not "first seen"). Recording cadence is turn-completion, not
per-request, and the debounced writer coalesces the per-model burst within one
turn. Self-correcting: a wrong or stale value is overwritten by the next real
observation, so no expiry logic is needed.

**Deliberately out of scope here** — each a clean follow-up the durable file
unlocks rather than blocks: a bolder static default for known auto-1M ids
(safe to add precisely *because* observations now correct it), unifying the
metadata/detail endpoints, the display-clamp question, the per-session
200K-Opus toggle (feasible per-spawn via `CLAUDE_CODE_DISABLE_1M_CONTEXT` in
the filtered child env — see below), and storing more per-model fields. The
record is intentionally just `{ contextWindow, observedAt }` (no cost/usage).

## Open questions (unresolved on purpose)

- **(Addressed by the fix above for the restart case.)** The remaining piece
  is whether to also ship a bolder static default for known auto-1M ids
  (opus-4-8/4-7, fable-5, mythos-5) so the *first* view of a never-run model
  on a fresh install doesn't briefly read 200K. Now low-risk because the
  durable observation overrides it on the first completed turn, but still
  account-specific (would understate on a non-qualifying account until then).
  Not done yet.
- Whether yepanywhere should expose a way to request a 200K Opus session.
  The only lever found is the CLI env var `CLAUDE_CODE_DISABLE_1M_CONTEXT`.
  Correction to an earlier assumption that this is unavoidably process-wide:
  YA spawns a fresh child per Claude session and already injects per-launch
  env defaults into the filtered child environment (`filterEnvForChildProcess`
  sets `ENABLE_PROMPT_CACHING_1H ??= "1"`,
  `packages/server/src/sdk/providers/env-filter.ts`). So a **per-session**
  toggle is feasible: persist a flag in `SessionMetadata` and set
  `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` in that one session's child env at
  launch/resume/fork. Constraint: env is fixed at spawn, so it cannot flip
  mid-session (only at launch/resume) — the same shape as model selection
  being a launch/owned-process capability. Deferred as a separate feature.
- Whether the metadata endpoint should apply the same live-process override
  the detail endpoint does, and whether raw percentages should be clamped at
  the surfaces noted above.
- The exact account conditions under which opus-4-8 does/doesn't auto-1M
  (the `gy()`/`JO()` predicates), and whether 1M draws usage credits here.

## How to re-check

```bash
# What window the CLI provisions for a given model string (account-specific):
claude -p "say ok" --output-format json --model opus \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:v.get("contextWindow") for k,v in (d.get("modelUsage") or {}).items()})'

# Force standard context:
CLAUDE_CODE_DISABLE_1M_CONTEXT=1 claude -p "say ok" --output-format json --model opus | ...

# What yepanywhere reports for a session (note: metadata vs detail can differ):
curl -sk https://localhost:3400/api/projects/<urlProjectId>/sessions/<sessionId>/metadata

# Max single-call fill + real compaction boundaries in a transcript:
python3 - <<'PY'
import json
f="<path>.jsonl"; mx=0; comp=0
for l in open(f):
    d=json.loads(l)
    if d.get("type")=="assistant":
        u=d.get("message",{}).get("usage") or {}
        mx=max(mx,u.get("input_tokens",0)+u.get("cache_read_input_tokens",0)+u.get("cache_creation_input_tokens",0))
    if d.get("isCompactSummary") or d.get("subtype")=="compact_boundary" or isinstance(d.get("compactMetadata"),dict): comp+=1
print("max single-call fill:",mx,"| real compaction boundaries:",comp)
PY
```
