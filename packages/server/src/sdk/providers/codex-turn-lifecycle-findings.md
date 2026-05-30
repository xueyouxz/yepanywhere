# Codex Turn Lifecycle Findings

This note records the Codex app-server contract checks behind YA's soft
interrupt and stale-tool handling. It is intentionally provider-adjacent so the
behavioral assumptions are near `codex.ts`.

## Sources

- OpenAI Codex app-server README:
  https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenClaw Codex app-server integration:
  https://github.com/pwrdrvr/openclaw-codex-app-server
- Local probe script:
  `scripts/probe-codex-app-server-turns.mjs`
- Default-off real contract test:
  `packages/server/test/sdk/providers/codex.test.ts`

## Supported Facts

- `codex app-server --listen stdio://` uses newline-delimited JSON-RPC 2.0 over
  stdio. YA sends client requests with `id`, receives matching responses, handles
  server notifications without `id`, and answers app-server requests with the
  same `id`.
- The OpenAI Codex app-server README documents `turn/steer` as appending user
  input to an active regular turn and returning a `TurnSteerResponse` containing
  a `turnId`.
- The README documents `turn/interrupt` as interrupting a running turn and
  marking it interrupted. Generated local protocol types for Codex CLI `0.125.0`
  match that shape: `{ threadId, turnId }` in, empty object out.
- OpenClaw's Codex adapter uses the same payload shape YA now uses:
  `{ threadId, expectedTurnId, input }` for `turn/steer` and
  `{ threadId, turnId }` for `turn/interrupt`.

## Local Probe Result

On 2026-04-25, `node scripts/probe-codex-app-server-turns.mjs` was run against
the installed Codex CLI in the user's authenticated context with
`CODEX_PROBE_MODEL=gpt-5.4-mini` and `CODEX_PROBE_EFFORT=low`.

Observed result:

- `thread/start` returned a thread id and selected `gpt-5.4-mini`.
- `turn/start` returned an in-progress turn id.
- `turn/steer` accepted the active turn and returned the same turn id in this
  run. YA still treats the returned id as authoritative because the protocol
  exposes it.
- `turn/interrupt` returned `{}`.
- A later `turn/completed` notification arrived for the interrupted turn with
  status `interrupted`.

The probe also observed that the `thread/start` response reported
`reasoningEffort: "xhigh"` even when the requested probe effort was `low`.
The turn-level `effort` request was still sent. That effort mismatch is not part
of the interrupt contract and should be investigated separately if it becomes
user-visible.

## Default-Off Verification

The committed Vitest coverage does not require real Codex credentials by
default. It uses a fake app-server to prove YA updates the active turn id from
`turn/steer` and sends `turn/interrupt` with that updated id.

To run the real contract probe through Vitest:

```bash
YA_CODEX_REAL_CONTRACT_TEST=true pnpm --filter @yep-anywhere/server exec vitest test/sdk/providers/codex.test.ts --run -t "real contract"
```

To run the probe script directly:

```bash
node scripts/probe-codex-app-server-turns.mjs
```

Both real checks create a temporary workspace and ask Codex not to modify files.
They still require the local user's Codex authentication and may consume model
quota, so they remain opt-in.

## Remaining Hypotheses

- A truly stuck Edit/Bash row can still be an upstream Codex/app-server lifecycle
  issue, especially if a file changed under the agent during an edit.
- Some stuck rows are local YA stale rendering: a Codex tool-use item was shown
  live, but the turn later completed or was interrupted without a matching item
  completion. YA now marks those items with `orphanedToolUseIds` so the renderer
  shows them as aborted rather than indefinitely pending.
