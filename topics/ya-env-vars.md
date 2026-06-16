# YA environment variables

> The environment variables Yep Anywhere reads, and the naming
> conventions that distinguish YA-private secrets (consumed and stripped
> on load) from plain YA config toggles and inherited system vars.

Topic: ya-env-vars

`packages/server/src/config.ts` (`loadConfig`) is the source of truth for
the full set and exact defaults; this doc curates the *meaningful*
operator-facing vars and the conventions. Deep tuning knobs (session-index
timings, codex rescan intervals, cache TTLs) live only in `config.ts`.

## Naming conventions

- **`YA_<module>__<NAME>` — YA-private module env, consume-and-strip.** Read
  for a YA subsystem, then **deleted from `process.env` on load** so it can
  never leak into a spawned child CLI (`harvestYaModuleEnv` in
  `packages/server/src/yaModuleEnv.ts`; read via `getModuleEnv(module)`).
  Module and name split on the **first** `__`. This protects credentials
  whose bare names another vendor's CLI would honor — see the billing
  footgun in [cost-efficiency.md](cost-efficiency.md). Use this prefix for
  module-scoped knobs that sit beside those credentials, too, so one subsystem
  does not grow two YA env families.
- **Vendor-named fallback secrets** — accepted only where explicitly
  documented. `XAI_API_KEY` is accepted as a convenience fallback for Grok STT,
  then deleted from `process.env` during config load. `YA_stt__XAI_API_KEY`
  takes precedence and is preferred because it isolates STT billing from Grok
  Build provider billing.
- **`YA_<NAME>` — YA-specific config toggle (non-secret).** Meaningful only
  inside YA; not a credential, so it is read normally (not stripped) and
  has no `__`. New YA-only toggles should take this prefix;
  `YA_VOICE_BACKENDS` is the first (renamed from `VOICE_BACKENDS`).
- **`YEP_ANYWHERE_*` — pre-existing internal prefix** (profile, data dir).
  Excluded from child env by `filterEnvForChildProcess`.
- **Unprefixed** (`PORT`, `VOICE_INPUT`, `ENABLED_PROVIDERS`, `LOG_*`,
  `WHISPER_*`, …) — historical YA config that predates the `YA_` prefix.
  Candidates to migrate to `YA_` for consistency; not yet done.

## Meaningful variables

### Ports & instance
| Var | Meaning |
|-----|---------|
| `PORT` | Base port (default 3400). Main = PORT+0, maintenance = PORT+1, vite = PORT+2. |
| `MAINTENANCE_PORT` | Override maintenance port (0 disables). |
| `VITE_PORT` | Override vite dev port. |
| `YEP_ANYWHERE_PROFILE` | Profile suffix → `~/.yep-anywhere-<profile>/`. |
| `YEP_ANYWHERE_DATA_DIR` | Full data-dir path override. |
| `CLAUDE_CONFIG_DIR` | Claude Code config dir (sessions scanned from `<dir>/projects/`). |

### Providers & features
| Var | Meaning |
|-----|---------|
| `ENABLED_PROVIDERS` | Comma list of exposed providers (empty = all). |
| `VOICE_INPUT` | `false` disables the mic button server-side. |
| `YA_VOICE_BACKENDS` | Explicit local/test speech backends (`ya-whisper`, `ya-dummy`). Cloud backends auto-enable on key presence instead. |
| `YA_DEFERRED_JOIN_WINDOW_S` | Max seconds between consecutive compose times for queued-while-busy turns to join into one `--------`-joined provider turn at a delivery boundary. Default 0: never join — one verbatim turn per boundary. Server setting `deferredJoinWindowSeconds` overrides ([compose-time-context-anchors](compose-time-context-anchors.md)). |
| `YA_COMPOSE_ANCHORS` | `1` prepends `(Ns ago)` / `(Ms later)` staleness anchors to delivered queued turns. Default off: queued text reaches the provider verbatim. Server setting `composeAnchorsEnabled` overrides. |

### Speech credentials & engine (the `stt` module)
| Var | Meaning |
|-----|---------|
| `YA_stt__XAI_API_KEY` | xAI key → `ya-grok` backend; auto-enables when set. |
| `XAI_API_KEY` | xAI standard key accepted as a `ya-grok` STT fallback, then scrubbed from child env. Grok Build receives it only when its provider setting explicitly opts in. |
| `YA_stt__SHARE_XAI_KEY_WITH_CLIENTS` | `1` lets authenticated private clients borrow the configured long-lived xAI STT key for direct browser-to-xAI batch transcription. Default false; direct streaming instead mints short-lived xAI client secrets from `YA_stt__XAI_API_KEY` and does not require exposing the long-lived key. |
| `YA_stt__DEEPGRAM_API_KEY` | Deepgram key → `ya-deepgram` backend; auto-enables when set. |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | Local Whisper tuning. `ya-whisper` runs through the committed pixi `stt` environment; bootstrap it with `pixi run -e stt stt-bootstrap` before enabling the backend. |

See [pluggable-speech-recognition.md](pluggable-speech-recognition.md) for
backend semantics and [cost-efficiency.md](cost-efficiency.md) for the
metered-vs-free and billing-isolation rules.

### Logging & diagnostics
| Var | Meaning |
|-----|---------|
| `LOG_LEVEL` / `LOG_FILE_LEVEL` | Minimum console / file log level. |
| `LOG_TO_FILE` | `true` enables file logging. |
| `LOG_DIR` / `LOG_FILE` | Log directory / filename overrides. |
| `LOG_PRETTY` | `false` disables pretty console logs. |
| `PROXY_DEBUG` | Enable proxy debug logging at startup. |

### Auth & serving
| Var | Meaning |
|-----|---------|
| `AUTH_DISABLED` | `true` bypasses auth (recovery only). |
| `AUTH_COOKIE_SECRET` | Override auth cookie secret. |
| `SERVE_FRONTEND` | `false` runs API-only (no static client). |
| `MAX_UPLOAD_SIZE_MB` / `MAX_QUEUE_SIZE` | Upload / queue limits. |
| `ALLOWED_IMAGE_PATHS` | Extra dirs allowed for local image serving. |
