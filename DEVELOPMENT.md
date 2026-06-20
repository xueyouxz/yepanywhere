# Development

## Setup

```bash
git clone https://github.com/kzahel/yepanywhere.git
cd yepanywhere
pnpm install
pnpm dev
```

Open http://localhost:3400 in your browser.

If you only want the main app and do not want to install the relay workspace, use:

```bash
pnpm setup:core
pnpm dev
```

## Commands

```bash
pnpm setup:core       # Install root + client + server + shared, skipping relay
pnpm dev              # Start dev server
pnpm lint             # Biome linter
pnpm typecheck        # TypeScript type checking
pnpm test             # Unit tests
pnpm test:e2e         # E2E tests
pnpm clone-references # Clone upstream source into ./references for local reading
```

## Reference Source

`pnpm clone-references` shallow-clones upstream source into `references/` for
local reading (currently the Codex Rust source, `codex-rs`, under
`references/codex`). The directory is gitignored and optional — clone it when
you want to grep upstream source while working on a related YA surface (e.g. the
Codex provider/schema/protocol). It is idempotent; delete a subdir and re-run to
refresh. The Claude SDK is not open source and is not included.

## Client I18n

Client UI copy should be i18n-ready by default. When adding visible sentences,
labels, headings, placeholders, tooltips, or aria text, add an English key to
`packages/client/src/i18n/en.json` and render it through `useI18n().t(...)`.
Non-English locale files are sparse overlays; only add translated locale values
when an actual translation is available.

Do not spend effort localizing brand/provider names, keyboard keys, terminal
commands, code tokens, protocol values, or source-like renderer text unless
they are embedded in real explanatory copy. To catch obvious misses, run:

```bash
pnpm i18n:scan
```

The scan is intentionally permissive and advisory. It warns on likely raw
English prose in client TSX, hides low-priority technical labels by default,
and can be inspected with `pnpm i18n:scan -- --include-info`. Use
`--max-warnings <n>` only when intentionally ratcheting it toward a blocking
check.

To review untranslated sparse-locale backlog without enforcing it on ordinary
code changes, run:

```bash
pnpm i18n:missing
pnpm i18n:missing -- --markdown --limit all > reports/i18n-missing-$(date +%F).md
```

`i18n:missing` reports English keys absent from non-English locale overlays and
always treats missing translations as advisory. Use this for daily or weekly
translation planning rather than as a blocking lint rule.

## Contribution Ethos: Minimalist Runtime

Running code — everything outside test/build tooling — is hand-built and lean on
dependencies. Before adding a runtime dep:

- **Narrow-scope utilities**: prefer a ~100-line hand-rolled implementation over
  a package. SGR parsers, debounces, small date helpers, tiny encoders — code
  them. A dep's long-term reading/audit cost usually exceeds the one-time write.
- **Exemptions**: don't hand-roll crypto (bcrypt, NaCl), auth protocols
  (SRP-6a), web frameworks (Hono), syntax highlighting (Shiki), or the official
  provider SDKs. Use the audited/canonical implementation.
- **Client bundle**: mobile-first — anything entering the client bundle must
  justify its payload. Prefer server-side rendering.
- **Mobile interaction**: visible controls and list rows must remain practical
  touch targets. Compact desktop density is acceptable only if mobile users can
  still tap the intended item without precision aiming; verify spacing-sensitive
  UI on a narrow viewport before landing.
- **Client rendering**: rich renderers should operate on block/tool-sized input
  and return cheap metadata they already know, such as whether output changed.
  Reuse a first completed scan for both control decisions and display instead
  of rendering once to decide whether a toggle exists and again to show it. See
  [packages/client/RENDERING_PERFORMANCE.md](packages/client/RENDERING_PERFORMANCE.md).
- **Dev-deps**: tooling (vitest, biome, playwright, tsx, types) doesn't ship to
  users; lower bar applies.

Rule of thumb: if a dep is essentially a one-file helper, write the file.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the entry-point map of how
provider events flow through the server to the client, the transport modes,
and the large-scope refactor proposals. Read it before changing message-flow
or render-path code.

## Port Configuration

Ports are derived from a single `PORT` variable (default: 3400):

| Port | Purpose |
|------|---------|
| PORT + 0 | Main server |
| PORT + 1 | Maintenance server |
| PORT + 2 | Vite dev server |

```bash
PORT=4000 pnpm dev  # Uses 4000, 4001, 4002
```

## Data Directory

Server state is stored in `~/.yep-anywhere/` by default:

- `logs/` — Server logs
- `indexes/` — Session index cache
- `uploads/` — Uploaded files
- `session-metadata.json` — Custom titles, archive/starred status

### Running Multiple Instances

Use profiles to run dev and production instances simultaneously:

```bash
# Production (default profile, port 3400)
PORT=3400 pnpm start

# Development (dev profile, port 4000)
PORT=4000 YEP_PROFILE=dev pnpm dev
```

Environment variables:
- `YEP_PROFILE` — Profile name suffix (creates `~/.yep-anywhere-{profile}/`)
- `YEP_DATA_DIR` — Full path override for data directory

## Server Logs

Logs are written to `{dataDir}/logs/server.log`. View in real-time:

```bash
tail -f ~/.yep-anywhere/logs/server.log
```

Environment variables:
- `LOG_LEVEL` — Minimum level: fatal, error, warn, info, debug, trace (default: info)
- `LOG_TO_FILE` — Set to "true" to enable file logging (default: off)
- `LOG_PRETTY` — Set to "false" to disable pretty console logs (default: on)

## Maintenance Server

A lightweight HTTP server runs on PORT + 1 for diagnostics when the main server is unresponsive:

```bash
curl http://localhost:3401/status          # Server status
curl -X POST http://localhost:3401/reload  # Restart server
```
