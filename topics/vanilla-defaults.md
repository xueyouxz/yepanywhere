# Vanilla Defaults

> Out of the box, YA must feel exactly like the first-party provider UIs
> users already know; every YA-novel user-visible behavior ships
> configurable and default-off until promoted by a deliberate product
> decision.

Topic: vanilla-defaults

## Theory

YA's users arrive trained by first-party surfaces — the Claude Code TUI,
claude.ai web, the Codex CLI/app, desktop agent clients. The overarching
UX rule for all new user-visible features: a first-time user must not
have to learn, or even notice, a new concept. In the maintainer's words
(2026-06-11): "it should just be totally normal like the desktop
applications", "I don't want to have something that requires people to
think when they first use it", "the default behavior should just be
totally vanilla".

This is a rule about *defaults and onboarding*, not about ambition.
Novel features remain welcome — do not assume first-party harnesses have
already implemented every useful behavior. The constraint is only that
novelty must never be the out-of-the-box experience.

## Contract

- **Default behavior is indistinguishable from first-party
  expectations.** If a user who has only ever used the provider's own
  UI would be surprised, the behavior is YA-novel and falls under this
  contract.
- **YA-novel user-visible behavior ships configurable and default-off.**
  This applies to UI chrome, new interaction concepts, and — easy to
  miss — anything that modifies what the user submitted before it
  reaches the provider. Sent text is delivered verbatim by default,
  apart from explicitly invoked transforms (emulated slash-command
  expansion, attachment references): "when I send a message I want my
  exact message to be sent", with no YA-added framing or annotations.
- **Believed-useful is not proven-useful.** A plausible, even
  well-argued benefit does not earn default-on; it earns an option.
  Promotion to default-on is a product decision that should state why
  the behavior is safe and unsurprising for users who never chose it
  (see [hard-development-rules](hard-development-rules.md) for the
  configuration-precedence side of that bar).
- **Options must pay rent.** A default-off option that turns out not to
  be useful should be removed, not accumulated. The configuration
  surface is itself a user-visible cost.

## Known Exceptions

[prompt-cache-keepalive](prompt-cache-keepalive.md) is a deliberate
default-on exception for active-enough live clients, but only where a provider
exposes a no-context-move refresh path. The default must not create visible
session rows, future-visible provider context, or autonomous server upkeep for
sessions with no current client viewer; stronger hidden-message keepalive modes
remain explicit per-provider choices.

## Worked instances: queued-turn delivery

[compose-time-context-anchors](compose-time-context-anchors.md)
prepended `(Ns ago)` / `(Ms later)` staleness markers to queued turns at
delivery, so an agent would not misread a stale queued comment as
referring to its most recent output. The benefit was believed but
untested, and the mechanism rewrote provider input — the provider saw
text the user did not type. Upstream removed it outright
(`25e7f5d1`, "Keep queued messages verbatim"). The resolution under this
theory and [kzahel-disabled](kzahel-disabled.md): preserved behind
`YA_COMPOSE_ANCHORS=1`, default off.

Batched deferred flush is the sibling instance: merging several queued
turns into one `--------`-joined provider turn defeated the upstream
usage of queueing N "good, proceed" messages to buy N work slices, and
was claimed to differ from first-party queue delivery. Default is now
one verbatim deferred turn per delivery boundary; joining is preserved
behind a configurable compose-time join window
(`deferredJoinWindowSeconds` server setting / `YA_DEFERRED_JOIN_WINDOW_S`,
0 = never join). The blind-go-ahead intent itself deserves a first-class
control someday (a slice or duration budget), rather than riding on
queue mechanics.

## Related topics

- [hard-development-rules](hard-development-rules.md) — explicit user
  configuration is authoritative; trust-sensitive defaults need opt-in
  or migration paths.
- [kzahel-disabled](kzahel-disabled.md) — upstream disablement of a
  speculative feature is a product signal; prefer configurable
  default-off preservation over silent code stripping, with the
  maintainer choosing the resolution.
- [session-ui-customization](session-ui-customization.md) — the
  visibility/enablement configuration surface that default-off UI
  features typically live behind.
