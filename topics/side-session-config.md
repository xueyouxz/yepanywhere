# Side Session Configuration

> Side session configuration is the shared opt-in, model-selection, and
> lifecycle contract for YA-simulated helper features that run outside the
> parent provider turn.

This topic covers helper features YA implements by issuing a separate
provider query or child session over a bounded excerpt of the parent
conversation. Recaps, simulated prompt suggestions, `/huh`-style quick
questions, and some `/btw` fallback shapes all need the same configuration
surface when the provider does not supply the feature natively.

Native provider features are different: if the provider emits the helper
message or suggestion as part of its ordinary session protocol, YA can surface
that capability without choosing a side model or owning another process.

## Contracts

- Native support and YA simulation must be modeled separately. A provider that
  emits native recaps or native prompt suggestions does not imply YA may spawn
  extra side queries for the same feature.
- A parent session may have at most one shared helper side session for silent
  simulated helper features. Recaps, prompt suggestions, and quick questions
  must not each get separate side-session model/provider choices; starting
  independent helper sessions repeats the same expensive catch-up work.
- New sessions default to native helper features only. Simulated helper
  features start disabled unless the user opts in at session creation or via a
  saved provider default.
- The side model is a session-level helper setting, not a per-feature setting.
  It may target the parent provider or a different configured helper provider,
  including a YA-operator inference server such as vLLM. The default token is
  `Cheapest`, which resolves through the helper-target registry to an
  appropriate cheap model (for example Claude may map it to Haiku, while an
  operator-run target may map it to a small Qwen-family model). The default
  comes from provider configuration, can be changed globally in provider
  settings, and can be overridden when creating a new session.
- Once helper targets can cross provider boundaries, stored helper model ids
  must be provider-qualified or otherwise globally unambiguous. A bare model
  id such as `haiku` or `qwen` is not enough if more than one helper provider
  can expose it.
- The helper model chooser includes `Same as main session`. When a feature's
  execution mode is a provider fork and the helper model equals the parent
  session model, YA should use that fork path. If a provider later supports an
  efficient fork with a model override, model override becomes a provider
  capability, not permission to add per-feature helper model choices.
- A feature may choose a different execution mode, such as forking the main
  session and original model instead of using the shared helper side session.
  That is a feature behavior toggle, not permission to configure a separate
  side model for that feature.
- In-session UI may toggle future helper requests for that session, but it must
  not restart or reconfigure the parent provider process just to change helper
  behavior.
- Side queries must be bounded in lifecycle and context. A hidden tab,
  abandoned helper request, YA hot restart, or failed provider resume must not
  leave a background helper process consuming resources indefinitely.
- Side query output is viewer state unless the feature explicitly says
  otherwise. Recaps and prompt suggestions must not write user/assistant turns
  into the parent provider transcript.

## Catch-Up Model

The main cost of simulated helpers is not just the visible request; it is
catching the side session up to the parent session. That catch-up can be token
expensive because it may need to replay recent user intent, assistant results,
tool outcomes, and condensed thought or progress summaries before the helper
can answer well.

Use a cumulative catch-up cursor for the one shared side session:

- Record the parent-session point the side session has caught up to.
- On the next helper request, replay only parent activity since that point,
  plus any bounded summary needed to preserve references.
- Advance the cursor only after the side session has accepted the replayed
  catch-up context.
- Keep replay policy explicit: read/edit/tool output may need truncation,
  redaction, or summary before entering the side session, and long thought-like
  spans should be summarized rather than copied unboundedly.

This is the product reason to require one reusable side session rather than
ad hoc one-shot helpers: the side session amortizes context assembly and
catch-up tokens across recaps, prompt suggestions, and quick side questions.

The shared side session is not hard-isolated by purpose. Its history may include
helper turns from other features: a recap request, then a prompt suggestion, then
a doubt pass. That leakage is more likely useful than harmful because the side
session accumulates contextual facts, and starting a fresh session for every
feature would repeatedly pay for prefix fill.

YA should therefore punctuate purpose scopes instead of pretending the helper
can forget perfectly. Each helper use opens an explicit scope, runs the
feature-specific instruction, then closes the scope. The closing turn should say
that the purpose is closed and that later uses should not interpret that scoped
instruction as their own task. This brackets contextual interpretation of the
current intent; it does not ask the model to erase prior useful facts. This is
limited-fidelity contamination control: the model may still use useful factual
context from prior scopes, but the current intent is bracketed by visible
begin/end markers rather than inferred by the agent.

Independent re-checks such as a doubt pass should not create a special
"partially caught up" mode where YA tries to omit the parent agent's solution.
YA is not clever enough to choose that boundary reliably. Use the same shared
side-session catch-up path, then put the independence requirement in the helper
instruction (for example, "solve this from scratch before comparing").

## Shared Controls

The same controls should back all simulated helper features:

- Provider settings: per-provider default side model, plus feature defaults
  such as "simulate recaps for new sessions" or "simulate prompt suggestions
  for new sessions". The side model chooser must include `Cheapest` and
  `Same as main session`, may include helper targets from other providers, and
  the feature default must include `Off`, even for native provider features.
- New-session form: one session-level side model override, plus per-feature
  toggles for native/simulated/off or feature-specific fork-main-session mode.
  Defaults come from provider settings; native helper support can appear
  enabled without a side model choice, but the user can still turn it off
  because native summaries and suggestions are not free.
- In-session controls: lightweight toggles for future helper requests in the
  current session. They change YA-side behavior only; they do not restart the
  parent agent or mutate prior helper output.
- Implementation config: one shared side-query envelope for context window,
  timeout, cancellation, failure reporting, and close-on-session-end cleanup.

## Helper Target Registry

YA settings include a helper target registry for operator-run or external
side-session backends. The first supported target kind is
`openai-compatible`: a named HTTP base URL such as
`http://localhost:8001/v1`, plus an optional served model id. A blank model
means "use the endpoint default" for servers that accept omitted model values;
when the UI discovers models via `/v1/models`, the user may still leave the
model blank or choose one of the returned ids.

Stored helper-side selections use `helper-target:<id>` rather than a bare
model name. That keeps a local vLLM model such as `Qwen/Qwen3.6-27B` distinct
from a provider-owned model with the same id and lets the parent session keep
its own provider/model unchanged.

The registry is configuration only until the helper execution layer knows how
to route a given feature to that target. The UI may expose configured helper
targets in the shared side-model chooser, but runtime support must still be
implemented and tested per helper feature.

## Relationship to Features

- Recaps summarize assistant work while the user was away. Native recap support
  can be enabled by default; simulated recaps use this topic's opt-in side
  model and lifecycle rules.
- Prompt suggestions predict the next user turn. Claude currently exposes this
  natively as `prompt_suggestion` via `promptSuggestions: true`; providers
  without native support should use the same simulated-helper controls as
  recaps rather than a separate hidden model setting. Because suggestions are
  disposable and user-confirmed, an operator-run weak/open model can be an
  acceptable helper target for this one feature even when it would be too low
  quality for recaps or independent re-checks.
- User-authored `doubt` from `github.com/graehl/agents` is the preferred
  fallback vocabulary for an independent re-check helper when no
  provider-native command exists. Native provider commands still win when
  advertised; YA should not shadow them with an emulation. Skills such as
  `rep` and `wish` are not side-session helpers; they belong to ordinary
  command emulation or provider command handling. See
  [emulated-slash-commands.md](emulated-slash-commands.md).
- `/btw` asides are user-visible child work streams, not silent helper
  affordances. Their parent/child UI and persistence live in
  [provider-agnostic-btw-asides.md](provider-agnostic-btw-asides.md), but any
  future lightweight fallback that replays only an excerpt of the parent
  transcript should reuse this side-query envelope.

## Tests That Should Fail On Contract Regressions

- A provider with native prompt suggestions can show suggestions without
  enabling simulated recaps or choosing a side model.
- A new session for a provider with only simulated recap support starts with
  recaps disabled unless the provider default or new-session override enables
  them.
- Enabling simulated recaps and simulated prompt suggestions for the same
  parent session creates at most one helper side session and one catch-up
  cursor.
- A parent session can choose a helper model from another provider or
  operator-run backend without changing the parent provider/model and without
  creating a per-feature helper model override.
- Changing the in-session simulated-helper toggle does not restart the parent
  provider process.
- A side query canceled by session end, tab disconnect, or timeout does not
  continue producing parent-session messages.
