Read and follow `CLAUDE.md` for repo context and instructions, and `DEVELOPMENT.md` for dev/contributor policy (setup, commands, contribution ethos). For architectural context (server message routing, client render pipeline, transports, auth state, large-scope refactor proposals), start at `ARCHITECTURE.md` rather than re-deriving from source.

Before fielding a user request to improve **stability**, **performance**, or **security**, read `ARCHITECTURE.md` first. Check whether the issue is already addressed in the large-scope refactor proposals or the per-doc cleanup tables, and whether a relevant trigger condition has now been met. If the proposed work would touch a load-bearing piece named in `ARCHITECTURE.md` (fan-out, replay buffer, streaming throttle, transport framing, auth state), prefer reading the linked detailed doc and surfacing the existing trade-off to the user before writing code.

## Architecture Mandates

Before modifying background loops, watchers, polling, retry timers, heartbeat
scheduling, session liveness, client stream/reconnect behavior, or server
catch-up paths, read `topics/architecture-mandates.md`. In particular, an idle
provider session and a closed client tab must never indefinitely consume server
resources.

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

## Landing the Plane (Session Completion)

After completing your session, offer proactively, briefly, a suggestion
to the user for what the next logical step in the plan might be, to remind
them of the overall context if this session was a part of a larger implementation plan
