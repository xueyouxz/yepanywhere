# Recaps

> Recaps are short on-return summaries — what the agent did or is doing
> while the user was away — surfaced as a turn-style system message in
> the session view without polluting the underlying provider transcript.

This topic covers YA's "away summary" pseudo-turns. The Claude TUI emits
recaps natively (system subtype `away_summary`); YA reproduces the UX
across providers and across the SDK / TUI gap, since the SDK's
`--print --output-format stream-json` mode does not run the TUI's
idle-detection effect that triggers native recap emission.

## Contracts

- A recap is a server-emitted message with `type: "system"`, `subtype:
  "away_summary"`, and a plain-text `content` field. Provider-emitted
  recaps (e.g., a future SDK that exposes them natively) and YA-emitted
  recaps share the same on-wire shape so the client renderer does not
  need to know which side produced them.
- Recaps must not become part of the provider's persisted transcript.
  The JSONL session file represents the underlying agent's
  conversation; recaps are a viewer affordance and must be reproducible
  from session state, not stored as user/assistant turns.
- Recap generation is the provider's responsibility. Providers that
  cannot generate one cheaply (no cache fork, no second model handy)
  may decline; YA surfaces this as a capability gap rather than
  silently doing nothing.
- Triggering is YA's responsibility. The client signals "the user
  returned after being away" (e.g., via `visibilitychange` after a
  minimum hidden interval); the server decides whether the gap is large
  enough and whether the session has anything new to summarize.
- The hint suffix the Claude TUI appends to its first few recaps —
  ` (disable recaps in /config)` — is provider-specific noise. YA must
  strip it before rendering so users do not see CLI-only configuration
  instructions for a setting that is not theirs to change from YA.
- Recaps do not steer, queue, or interrupt the active turn. If a turn
  is mid-stream when the user returns, the recap waits until the turn
  resolves so it cannot interleave with live assistant output.

## Invariants

- One recap per "return event". Repeated visibility flips within a
  short window collapse to a single trigger; the user should not see a
  stack of recaps after wiggling focus.
- A recap with no new agent work to describe (no assistant turns since
  the user left) is suppressed. An empty or near-empty recap is worse
  than no recap.
- Recap text length is bounded by the provider's prompt (under ~40
  words for Claude-shape recaps); YA must not pad, decorate, or attach
  follow-up tool affordances that would invite further interaction with
  the recap message.
- Recaps survive reload only as live state. They are not persisted to
  YA's session metadata; on full page reload the recap area resets.
- Recap rendering is read-only. There is no reply box, no thumbs, no
  retry — clicking the recap row should not change provider state.

## Configuration and Native Capability

Common side-query configuration lives in
[side-session-config.md](side-session-config.md); next-turn prediction lives in
[prompt-suggestions.md](prompt-suggestions.md).

New sessions should not start with YA-simulated recaps enabled by
default. A provider with native recap support may default to native recaps
because YA does not need to spawn a side session, but the UI must still expose
`Off`: native recaps are not free, and the user must be able to disable them
for a new or existing session.

For simulated recaps, YA needs an explicit configuration surface rather
than a hard-coded model choice. The side model is shared for the parent
session's silent helper features; recaps must not get a separate
per-feature side model. A recap-specific setting may instead choose
execution mode, such as using the shared helper side session or forking
the main session/original model for higher fidelity. The latter strategy,
extended with an after-turn pointer and free-text instructions, is what
[fork-from-turn](fork-from-turn.md) uses for fork-after-summary.

`Cheapest` is the default helper model token. Providers map it to the
appropriate cheap side model for their backend, such as Haiku for Claude, so
the UI does not need to hard-code provider model names.

The UI locations are:

- New-session form: a `Recaps` control alongside provider/model/session
  defaults. It chooses `Off`, provider-native recaps when supported, or
  simulated recaps through the shared helper side session.
- Settings -> Providers: the default recap mode for future sessions and the
  shared helper side model, including `Same as main session`.
- Existing session menu: a `Recaps...` item for the active process. It changes
  future away-return triggers without restarting the parent session and without
  rewriting prior recap messages.

This mirrors native prompt suggestions. The current Claude path already
exposes native prompt suggestions (`promptSuggestions: true`) and the
client renders `prompt_suggestion` messages. If YA later simulates
prompt suggestions for providers without native support, it should use
the same side-session configuration as simulated recaps: both are
non-steering side queries over recent context, and both need the same
bounded lifecycle, session-level model choice, and restart behavior.

Hot or cold YA restarts can already reduce normal-workflow reliability
because providers do not all resume cleanly. Side-session features must
not amplify that: keep simulated recaps opt-in, keep side queries
bounded, and do not require restarting the parent provider session to
change recap configuration for future sessions.

## Representative Change Types

- Adding a provider implementation of `AgentSession.requestRecap` (or
  raising the provider capability flag).
- Changing the client trigger heuristic (idle threshold, focus events,
  network reconnect treated as "back from away").
- Changing recap rendering: dimmed turn card, side-dot glyph, position
  in the message list, stripping of provider-specific hint suffixes.
- Changing how the server records its "last user activity" timestamp,
  since the recap trigger depends on it.

## Tests That Should Fail On Contract Regressions

- A recap message is not written into the persisted Claude JSONL
  transcript.
- Two rapid visibility flips within the suppression window produce at
  most one recap.
- A recap fired against a session that has had no assistant output
  since the user left does not surface in the message list.
- The trailing ` (disable recaps in /config)` text is stripped from
  rendered content but the rest of the text is preserved verbatim.
- Recap rendering does not expose retry, copy-to-composer, or other
  actions that would let the recap become an editable user prompt.

## Decision: YA synthesizes rather than passing through

The Claude TUI generates recaps natively (system subtype `away_summary`
emitted by a TUI-side React effect that detects idle-then-return,
runs a cache-fork mini-inference, and renders the result). We do not
get them for free in the SDK path:

- `awaySummaryEnabled` exists in the CLI settings schema but is marked
  `@internal Hidden from public SDK types until external launch`, so
  there is no `awaySummaries: true` query option analogous to
  `promptSuggestions: true`.
- The trigger and fork live inside the TUI's React tree. The SDK
  spawns the CLI with `--print --output-format stream-json`, where
  the TUI never mounts. Setting `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=true`
  does not change that — the gate it controls only matters when a
  TUI is running.
- The TUI's internal recap fork uses `skipTranscript: true` to keep
  the JSONL clean. That flag is not exposed in the SDK's `query()`
  options, so a `resume:`-based recap on YA's side would append a
  visible turn to the underlying transcript.

YA therefore synthesizes recaps server-side: on a client "user
returned after ≥N min away" signal, the provider runs an ephemeral
`query()` with `persistSession: false`, feeds in recent assistant
text, and YA emits a synthetic `away_summary` system message into the
session's stream. This matches the on-wire shape the TUI would emit,
so the same client renderer handles both — once the SDK exposes
recaps natively, the YA-side path can become a fallback rather than
the default.

Alternatives considered:

- **Wait for SDK exposure.** Cheapest, but no timeline; meanwhile the
  feature is simply absent. Rejected as the v1 path because the UX
  payoff is concrete and the cost of the YA-side path is small.
- **Resume the live session for a one-turn recap.** Cheap (warm
  cache), but appends a user/assistant pair to the JSONL. Violates
  the no-extra-turns invariant above.
- **Run the CLI in a mixed-mode shim that mounts the TUI.** Possible
  in principle but invasive; loses the clean control protocol the SDK
  query provides, and the trigger still needs YA-side signals because
  the TUI's "user away" detection assumes a local terminal.

## Relationship to Side Sessions

The recap implementation is the first concrete example of a YA-simulated
helper feature: it runs outside the parent provider turn, reads bounded recent
parent context, and emits viewer state rather than provider transcript turns.
The shared configuration and catch-up rules live in
[side-session-config.md](side-session-config.md).

The important product constraint is that recaps do not get a private model or
side-session choice. If YA later simulates prompt suggestions or independent
quick questions, those features share the same session-level helper side
session and catch-up cursor. A recap-specific switch may choose behavior such
as "off", "native", "shared helper", or "fork main session using the original
model", but it must not introduce another hidden helper model setting.

`/btw` asides remain separate user-visible work streams, covered by
[provider-agnostic-btw-asides.md](provider-agnostic-btw-asides.md). They may
reuse the same bounded replay policy for unsupported providers, but their
parent/child UI and persistence are not the silent-helper recap path.
