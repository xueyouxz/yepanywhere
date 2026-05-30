# Cost efficiency

> YA should minimize the money and quota its operation costs the user —
> preferring subscription/local capacity over metered APIs, avoiding
> accidental expensive paths, and never silently switching a credential or
> model to a pricier one.

Topic: cost-efficiency

This is a cross-cutting concern, not a module. Anything that spends the
user's money or quota on their behalf — provider API calls, model/effort
selection, speech transcription, polling and token churn — falls under it.
The guiding rule: the cheap, expected path is the default; any move to a
costlier path is explicit, visible, and chosen.

## Subscription / local capacity is preferred over metered APIs

Several providers can run against either a flat-rate subscription (browser
login) or a metered pay-as-you-go API key. The subscription path is the
user's intended default; metered billing must never be entered by accident.

**Billing footgun — vendor CLIs that honor an ambient API key.** A CLI that
reads an API-key env var "takes precedence over browser credentials" can be
flipped from subscription to metered billing just by inheriting that env
var from YA's process. The first concrete case: Grok Build honors
`XAI_API_KEY` / `GROK_CODE_XAI_API_KEY`. Because a future YA feature (xAI
Speech-to-Text) wants an xAI key for a *non-provider* purpose, that key must
never reach the Grok child process.

**Mechanism (env masking).** `ACPClient.connect` builds the child env as
`{ ...process.env, ...config.env }` and an overlay cannot delete an
inherited key, so the config carries an optional `excludeEnv?: string[]`
whose names are removed from the merged env just before `spawn`. The Grok
provider passes `GROK_BILLING_ENV_DENYLIST =
["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]` (local to `grok-acp.ts`). It is
scoped to that one provider on purpose: the shared
`filterEnvForChildProcess` allowlist is **not** widened to drop vendor API
keys, because that would change the child env of established providers that
may rely on ambient passthrough (a rug-pull). Grok is new and not yet
public, so it carries its own mask.

**Don't widen the static mask blindly.** The hazard is one env-var name
serving two masters; an unconditional strip is correct only while exactly
one consumer wants the name. This is the **first non-provider use of an API
key in YA**. When a *second* YA-owned consumer wants a name an existing
provider relies on ambiently (e.g. a future non-provider use of
`ANTHROPIC_API_KEY` while Claude still needs it), do not add a static
strip — gate it: mask `X` from provider P's child **only when** YA has
itself configured a competing value for `X` this run ("requested creds").

## Speech transcription cost

Server-routed speech backends (see
[pluggable-speech-recognition.md](pluggable-speech-recognition.md)) span
free-local and metered-cloud options. Local Whisper is free CPU/GPU time;
Deepgram and (planned) xAI STT are metered. Backend selection is operator
config (`VOICE_BACKENDS`), so the user picks the cost tier explicitly. xAI
STT batch is ~$0.10/hr, realtime ~$0.20/hr — cheap, but still a metered
path that should be opt-in, not a silent default.

## Model and effort selection

Higher-effort / larger-context runs cost more. YA's defaults should be the
modest option, with effort/model escalation a user choice (see
[provider-state-machine.md](provider-state-machine.md) for how providers
advertise models/effort). Do not default a provider to its most expensive
model or effort level.

## Client/server churn has a token cost

For provider sessions billed per token, redundant streaming, re-prompting,
or chatty polling spends real money, not just CPU. Coalescing and
backpressure work (client render path, heartbeat/liveness polling) has a
cost dimension on top of its performance one; weigh it when a path can be
high-rate against a metered backend.

## Related

- [grok.md](grok.md) — provider where the first billing footgun appeared.
- [pluggable-speech-recognition.md](pluggable-speech-recognition.md) —
  metered vs. free transcription backends.
