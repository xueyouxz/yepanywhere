# Prompt Suggestions

> Prompt suggestions are predicted next-user-turn affordances surfaced in the
> composer without becoming provider transcript turns unless the user accepts
> one.

This topic covers YA's next-turn suggestion surface. Today Claude provides the
capability natively: the SDK query is started with `promptSuggestions: true`,
provider `prompt_suggestion` messages are intercepted by the client, and the
suggestion is rendered in the composer rather than the message list.

## Contracts

- Prompt suggestions are suggestions, not queued turns. YA must not send one to
  the provider until the user explicitly accepts or edits it.
- Native provider suggestions and YA-simulated suggestions share the same UI
  shape: a composer affordance the user can accept, edit, or dismiss.
- Native provider suggestions may be the default for a provider, but the user
  still needs an `Off` control in provider defaults, new-session choices, and
  current-session controls because native suggestions consume provider work.
- Native suggestions do not require a side model. Simulated suggestions for
  providers without native support must use
  [side-session-config.md](side-session-config.md) for opt-in defaults, side
  model selection, bounded context, timeout, and cleanup. The side model is
  the parent session's shared helper setting, not a prompt-suggestion-specific
  model choice.
- A suggestion is tied to the current visible session state. New user input,
  session switch, focus on an aside, or provider progress that invalidates the
  predicted next turn should clear stale suggestions rather than presenting
  them as still-current.
- Suggestion output is not transcript state. Dismissing a suggestion should not
  mutate provider history, and accepting one should behave like normal user
  composer input.

## Invariants

- The client intercepts `prompt_suggestion` messages and keeps them out of the
  message list.
- Suggestions must not appear while the composer is already non-empty unless
  the UI makes the replacement/append behavior explicit.
- A simulated suggestion request must not run during active-turn steering in a
  way that competes with the user's live input path.
- Provider-specific wording or hints in a native suggestion message must not
  leak CLI-only settings into YA UI.

## Relationship to Recaps

Recaps and prompt suggestions differ in direction: a recap summarizes what the
agent already did while the user was away, while a prompt suggestion predicts
what the user might ask next. The configuration gap is the same for providers
without native support: both require a side query over bounded recent context,
both need the same shared side session, and both must remain out of the parent
transcript.

Claude currently has native prompt suggestions but not SDK-native recaps in the
same `--print --output-format stream-json` path. That means YA can enable
Claude prompt suggestions by default without side-session configuration, while
Claude recaps remain a simulated-helper feature until the SDK exposes native
away summaries.

Default policy: prompt suggestions may default on only when the provider
delivers them natively/smoothly as part of the ordinary session protocol.
Emulated or YA-simulated suggestions default off unless the user explicitly
enables that helper behavior.

Current implementation note: new-session launch, provider defaults, and handoff
all expose the `Off` / `Native` choice. `Native` is enabled only for providers
that advertise native prompt suggestions; providers that would need YA-side
emulation default to `Off`. Handoff carries the live process preference when
known, so an explicitly disabled session stays disabled in the replacement
session. The remaining gap is current-session mutation: there is not yet a
live-session toggle that changes future suggestions without starting a new
session.

## Tests That Should Fail On Contract Regressions

- A `prompt_suggestion` SDK message updates the composer suggestion state and
  does not render as a normal transcript row.
- Dismissing a suggestion removes it without queueing a user message.
- Accepting a suggestion follows the same send path as typed composer text.
- A simulated suggestion request for a non-native provider is disabled by
  default unless session/provider settings opt in through side-session
  configuration.
