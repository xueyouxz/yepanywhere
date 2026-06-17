Read and follow `CLAUDE.md` for repo context and instructions, and `DEVELOPMENT.md` for dev/contributor policy (setup, commands, contribution ethos). For architectural context (server message routing, client render pipeline, transports, auth state, large-scope refactor proposals), start at `ARCHITECTURE.md` rather than re-deriving from source.

Before fielding a user request to improve **stability**, **performance**, or **security**, read `ARCHITECTURE.md` first. Check whether the issue is already addressed in the large-scope refactor proposals or the per-doc cleanup tables, and whether a relevant trigger condition has now been met. If the proposed work would touch a load-bearing piece named in `ARCHITECTURE.md` (fan-out, replay buffer, streaming throttle, transport framing, auth state), prefer reading the linked detailed doc and surfacing the existing trade-off to the user before writing code.

## Architecture Mandates

Before modifying background loops, watchers, polling, retry timers, heartbeat
scheduling, session liveness, client stream/reconnect behavior, or server
catch-up paths, read `topics/architecture-mandates.md`. In particular, an idle
provider session and a closed client tab must never indefinitely consume server
resources.

## Provider Session Identity

YA URL session ids are the canonical user-facing session ids. Provider-native
ids such as OpenCode `ses_*`, Codex thread ids, or other backend resume handles
may be stored and passed back to the provider for resume, export, or debugging,
but they must not silently replace the YA-visible session id in URLs, persisted
YA metadata, REST/WebSocket payloads, or UI copy. If a provider truly requires
using its own id as a public/session id, document that exception in the
provider contract and make the mapping explicit in the UI/debug surfaces.

## Client I18n Readiness

When adding or changing client UI copy, prefer `useI18n().t(...)` and entries
in `packages/client/src/i18n/en.json` for user-facing sentences, labels,
headings, placeholders, tooltips, and aria text. Do not force brand names,
provider names, keyboard keys, terminal commands, code tokens, protocol values,
or source-like renderer text into i18n keys unless the surrounding copy needs
translation. For a permissive advisory scan of obvious raw English copy, run
`pnpm i18n:scan`; use `--include-info` to inspect low-priority labels and
`--max-warnings <n>` only when intentionally ratcheting the check toward CI.

## Biome Import/Export Ordering

Do not apply Biome's organize-imports/exports assist as a routine cleanup.
Keep import/export edits scoped to the symbols needed by the change. Whole-file
ordering churn, especially in barrel files, obscures review and carries no YA
runtime-safety benefit. Run the project lint wrapper for diagnostics, but do not
turn a one-line import or export addition into a broad reorder solely to satisfy
organize-imports advice.

## Vanilla Defaults

`topics/vanilla-defaults.md` is the overarching UX theory governing every new
user-visible feature. Out of the box, YA must feel exactly like the first-party
provider UIs users already know (Claude Code TUI, claude.ai, Codex): a
first-time user must not have to learn, or even notice, a new concept. Any
YA-novel user-visible behavior — including anything that modifies the user's
submitted text before it reaches the provider — ships configurable and
default-off. A believed-but-unproven benefit earns an option, never a default.
Novel features remain welcome; do not assume first-party harnesses already
cover all useful behavior. Read the topic before adding or enabling any
user-visible feature that is not configurable default-off.

## Hard Development Rules

Follow `topics/hard-development-rules.md` for binding upstream-facing
development rules. Read it before changing deployment-sensitive defaults,
configuration precedence, relay or endpoint selection, provider/model settings,
hosted-client endpoint selection, migrations, or maintainer-specific deploy
configuration.

## Codex Version Bump Audit

Treat `package.json` `yepAnywhere.codexCli.expectedVersion` as the repo's
declared Codex CLI target version. When that value increases, or when Codex
API/protocol docs or checked-in Codex protocol files have changed in a way that
plainly implies a newer target version, do a routine compatibility check before
making YA source changes that respond to the Codex-side change.

The routine check may be automatic and read-only at first: inspect the
Codex-facing surfaces that are most likely to drift, especially
`packages/server/src/sdk/providers/codex*`,
`packages/shared/src/codex-schema/`, generated protocol files, and related
tests/scripts such as `scripts/update-codex-protocol.mjs`. A preliminary audit
that only identifies likely drift can happen immediately without asking first.

Before actually editing YA code for that compatibility work, pause and ask the
user whether they want the audit enacted now. Quote a prompt they can approve
or reuse, for example: "Audit YA for Codex CLI/API changes from <old> to <new>:
compare the changed Codex docs/files against our Codex-facing types, protocol
definitions, generated files, and tests; update whatever is needed for
compatibility; then summarize the behavioral changes, risks, and follow-on work."

Also state the likely benefit in one sentence, e.g. that this catches protocol
or schema drift early and reduces silent breakage in YA's Codex integration.

## Reference Source (local-only)

`references/` holds upstream source cloned for local reading. It is gitignored
and absent on a fresh checkout, so never assume a given repo is present. When
working on the Codex provider — schema, scanner, normalization, app-server
protocol (`packages/server/src/sdk/providers/codex*`,
`packages/shared/src/codex-schema/`, generated protocol files) — the Codex Rust
source is invaluable; much of that work is effectively reverse-engineered from
Codex behavior. If `references/codex` is not present, run `pnpm
clone-references` (shallow, idempotent), then grep it directly. The Claude SDK
is not open source, so it is not included.

## Commit Lock Protocol

Before staging or committing, acquire `.git/yepanywhere-commit.lock`. The
required flow is:

1. Check for and acquire `.git/yepanywhere-commit.lock`.
2. If it already exists, sleep 10 seconds and retry.
3. Hold the lock through:
   - staging
   - staged diff review
   - `git commit`
4. Remove the lock after the commit completes.

The working tree may contain concurrent human or agent edits. Avoid reverting
or tidying unrelated changes unless the task directly requires them.

## Commit Message Guidance

Aim for a <=65 char subject, and strictly enforce a 72-column line wrap
for the body. Prefer bullet lists in the commit body when items are
numerous or complex; prose when the content is short and simple.

**Maintainer**, here, means the human reviewer or a future agent
(possibly you) re-reading this commit to understand or re-derive the
change.

For non-trivial commits, include a concise excerpt or synthesis of the
originating instruction (or motivating observation, when the change
wasn't user-prompted) that is feasible to land in the committed
changes. Summarize the motivating request and key implementation
direction so a Maintainer could paste the message, add their own
adjustments, and recreate something close to the intended result. Prune
digressions, secrets, and low-signal chat detail; do not aim for a
verbatim or exhaustive transcript.

The subject line is the conventional scannable headline result — keep
it scannable in `git log --oneline`. The synthesis lives in the body.
The 72-column body wrap applies to synthesis prose as well.

**Exemption**: skip the synthesis for mechanical or small + self-evident
changes — formatter passes, typo fixes, version bumps, trivial renames
with no substantive user direction. The conventional one-line message
alone is sufficient there.

**Series threading**: when a commit is part of a related series, append one
or more `Topic: <string>` trailers at the bottom of the body. The topic
string is freeform (descriptive phrasing fine; not constrained to a short
UPPERCASE codename). A series shares the exact same topic string across
its commits for each topic name you include; "first in wins": later
commits copy their topic lines verbatim so `git log --grep "Topic: ..."`
finds the chain. Use multiple `Topic:` lines when one commit touches
multiple topics, and switch a given topic only when it's obviously time for a
new one. Standalone commits with no expected follow-up: no trailer.

Example:
```
... body text ...
Topic: session-liveness
Topic: provider-model-glyphs
```

To avoid accidentally reusing a topic for an unrelated series, keep a
project-level `topics.md` log at the repo root and append each new
topic string to it when the series begins. The log is appended to
whether or not it's tracked in git. Format is freeform (not a
traditional ChangeLog) — typically a bulleted list with optional
one-line notes. Scan `topics.md` before opening a new series.
