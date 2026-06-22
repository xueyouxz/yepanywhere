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

Two complementary layers enforce this — one for YA's own keys, one for
vendor-named keys that may be in the env for other reasons.

**Layer 1 — `YEP_<MODULE>_<NAME>` consume-and-strip (the primary guard for
YA-owned keys).** A secret YA needs for a subsystem is provided under a
registered module prefix (e.g. `YEP_STT_XAI_API_KEY`,
`YEP_STT_DEEPGRAM_API_KEY`). On server load, `harvestYaModuleEnv`
(`packages/server/src/yaModuleEnv.ts`) moves every such var into a private
in-process store and **deletes it from `process.env`**, so it can never ride
the ambient environment into *any* spawned child — no per-provider masking
required. The subsystem reads it via `getModuleEnv("stt")[NAME]`, never
`process.env`. Private prefixes such as `YEP_STT_` are registered explicitly;
ordinary `YEP_*` toggles are not consumed merely because they contain an
underscore.

**Layer 2 — startup scrub plus per-provider `excludeEnv` for vendor-named
keys.** A literal `XAI_API_KEY` may be set because xAI's public docs use that
standard name. YA accepts it as an STT fallback, records it in config, then
deletes it from `process.env` during `loadConfig` so children do not inherit it
ambiently. `ACPClient.connect` builds the child env as
`{ ...process.env, ...config.env }`, and an overlay cannot delete an
inherited key, so the config carries an optional `excludeEnv?: string[]`
whose names are removed from the merged env just before `spawn`. The Grok
provider passes `GROK_BILLING_ENV_DENYLIST =
["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]` (local to `grok-acp.ts`) unless the
user has enabled the Grok Build provider option to pass the scrubbed
`XAI_API_KEY`; that opt-in injects only the ambient `XAI_API_KEY`, not
`YEP_STT_XAI_API_KEY`. It is
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

### The `ant` CLI — metered API, never a subscription path

`ant` is Anthropic's official CLI (`github.com/anthropics/anthropic-cli`;
install via `brew install anthropics/tap/ant`, a GitHub release binary, or
`go install github.com/anthropics/anthropic-cli/cmd/ant@latest`). It maps
every Claude API resource to a subcommand (`ant messages create`, `ant
models list`, `ant beta:agents …`), builds request bodies from typed flags
or piped YAML, inlines files into any string field with `@path`, and pulls
response fields out with `--transform` — a typed alternative to hand-written
`curl` or an SDK.

**YA does not use it, and as of this writing it is not installed here** (no
references in the tree; `command -v ant` is empty). The live question was
whether it *could* fit; the answer turns entirely on billing, and lands on
the wrong side of the rule above.

**It is a metered Claude API client with no subscription path.** Both auth
options bill per-token API usage: an `ANTHROPIC_API_KEY`, or `ant auth
login`, which runs a browser OAuth flow **against the Claude Console** (the
API platform) and caches credentials locally — convenience over managing a
raw key, not a different billing surface. The documented auth choices are
API keys, workspaces, named profiles, and Workload Identity Federation: all
Console/API constructs, none a claude.ai Pro/Max subscription. The Messages
quickstart's own sample response carries `usage.input_tokens` /
`output_tokens`. So `ant` sits squarely on the metered side of the
subscription-vs-metered split this topic governs — unlike Claude Code, whose
intended-default path is subscription auth.

That is why we do not adopt it for the core coding flow: `ant` is precisely
the "vendor CLI that honors an ambient `ANTHROPIC_API_KEY`" footgun named
above, keyed on the same `ANTHROPIC_API_KEY` the forward-looking note (a
non-provider consumer wanting a name Claude relies on ambiently) already
anticipates. It would earn a place only for a *deliberately* metered,
separate task — the way `ya-deepgram` / `ya-grok` STT are deliberate — and
no such need exists today. If one ever arises, it takes the same guard:
gate `ANTHROPIC_API_KEY` so wiring in `ant` for a YA-owned purpose never
silently flips a subscription Claude Code child to metered billing.

## Speech transcription cost

Server-routed speech backends (see
[pluggable-speech-recognition.md](pluggable-speech-recognition.md)) span
free-local and metered-cloud options. Local Whisper is free CPU/GPU time;
Deepgram (`ya-deepgram`) and xAI STT (`ya-grok`) are metered. Cloud
backends **auto-enable when their key is present** — a single-user
operator providing the key is itself the opt-in signal — while local/test
backends (`ya-whisper`, `ya-dummy`) stay explicit via `YEP_VOICE_BACKENDS`
(see [ya-env-vars.md](ya-env-vars.md)). xAI STT batch is ~$0.10/hr,
realtime ~$0.20/hr — cheap, but still a metered path, never a silent
default for a user who has not provisioned a key.

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
