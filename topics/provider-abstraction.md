# Provider abstraction seam

When provider- or model-specific behavior belongs on the `AgentProvider`
interface instead of as inline `if (provider === "claude")` / `if (model
matches …)` branches in generic callers (routes, the Supervisor, shared
helpers).

See also: [`provider-state-machine.md`](provider-state-machine.md),
[`provider-context-economics.md`](provider-context-economics.md),
[`provider-refresh.md`](provider-refresh.md). Global aesthetic: the
"shared-facility contract" rule and agent-design's "promote to a dedicated
surface when you need to gate/render/audit".

## Status: NOT yet systematically applied

This is a forward-looking guideline, adopted incrementally. Existing
provider/model conditionals have **not** all been migrated — e.g. the
codex-spark targeted auto-compact (`tryQueueTargetedAutoCompact`), the
claude-only preemptive-compaction trigger (`maybeCompactBeforeDelivery`), and
the alias↔resolved model-identity canonicalization still live as inline
branches. `contextWindowFor` (below) is the first surface to adopt this seam.
Don't treat the presence of remaining inline conditionals as a bug to sweep;
migrate them when they next hit a trigger below.

### Candidate next surfaces

- **Requested ↔ reported model-name mapping.** The UI keys per-model settings
  by the alias the user picked ("opus"); a running session reports the resolved
  id ("claude-opus-4-8"). The provider is the one component that knows its own
  resolution, so a `provider.canonicalModelKey(model)` (or
  `aliasForReportedModel`) belongs there rather than as family-regex
  canonicalization scattered across the route, settings, and client. Pending a
  parked design decision on which identity is canonical (alias vs resolved id —
  the latter lets distinct aliases that resolve to the same model *share*
  settings, but "default" is subscription-dependent and resolvable only at
  runtime).
- **Preemptive-compaction policy.** The claude-only `maybeCompactBeforeDelivery`
  and the codex-spark-only `tryQueueTargetedAutoCompact` are two inline
  per-provider blocks that a single `provider.compactionPolicy` (default: none)
  would own.

## When to promote to a provider surface

Promote an inline provider/model conditional to an **optional**
`AgentProvider` method (default: no-op / identity / `undefined`) when any of:

1. **It recurs.** The same provider/model conditional appears in 2+ places.
   (The Claude always-1M family regex had spread to ~4 call sites — that was
   the tell that drove `contextWindowFor`.)
2. **A generic caller has to know provider internals.** A route should not
   "know" that Claude opus runs at 1M, or that codex-spark compacts at 85%.
3. **Adding a new provider would require editing the generic code** rather
   than just implementing the interface.

## When NOT to

A single, localized, one-off conditional stays inline. Don't abstract on first
sight — indirection has its own cost. The **default-does-nothing** property is
exactly what makes the surface cheap to add *later*, so there is no penalty for
waiting until a trigger above actually fires.

## The default-no-op contract (low blast radius)

Make the method optional with a default that preserves current behavior:

- Window/identity resolvers: return `undefined` to defer to the generic
  heuristic, so non-implementing providers are unaffected.
- Policy hooks (e.g. preemptive compaction): default to "no policy", so the
  generic path runs exactly as before.

A new optional method touches only the providers that opt in; every other
provider and caller is unchanged. That is the property that lets this be
adopted one surface at a time.

## First instance: `contextWindowFor`

`AgentProvider.contextWindowFor?(model): number | undefined` — the effective
context window this provider runs `model` at, or `undefined` to defer to
`getModelContextWindow`. `ModelInfoService.getContextWindow` consults it first
(before its alias-keyed cache and the shared heuristic), so the Claude
provider owns "opus is always-1M, sonnet is not" instead of leaking that into
`resolveCompactWindow`, the settings route, and the client. Sonnet's 1M needs
paid usage credits, so only opus is overridden; everything else defers.

## Per-model settings keying

Decided and **implemented** for the core path (task 029, 2026-06-16). Configs
key by the **YA model id**; the over-split prefix tree, `off`=0 tombstone, and
provider split override remain parked (see *Still parked* below). This is the
home of the requested↔reported model-name candidate surface named above.

**Decision:** configs are split by **YA model id** (the requested name), and
where YA **owns** the session the config is looked up by that same YA model id.
The reported→requested mapping is still worth keeping with some fidelity (for
external sessions and display), but it is **not** the storage key.

### Implemented (task 029)

- **Owned sessions key by the requested id.** `Process` tracks `_requestedModel`
  (the launch alias, following mid-session switches; the readonly `model` stays
  at the original) and exposes it as `Process.requestedModel` /
  `ProcessInfo.requestedModel`. The `/messages` threshold lookup keys by
  `body.model ?? process.requestedModel ?? <persisted> ?? <helper>`.
- **Survives restart.** `SessionMetadata.requestedModel` persists the launch
  alias (`persistLaunchMetadata`); the `/resume` route recovers it into
  `options.model` when the client sends none, and `enrichProcessInfo` falls back
  to it. The old vestigial `SessionMetadata.model` (reported, never read) was
  removed.
- **Helper for non-YA-started sessions.** `provider.yaModelIdForReported`
  (Claude: a fixed family-substring table, `claude-opus-4-8`→`opus`, etc.) is the
  last fallback when no requested id exists. Imperfect and one-to-(0+) by design.
- **No family fallback in the lookup.** `resolveCompactPercent` is now a direct
  single-id lookup; the canonicalization that used to need family matching now
  happens once, upstream, via the helper.

### Still parked

The over-split prefix tree (`-`/`.`/alpha↔digit) with longest-match inheritance,
`off`=0 tombstone semantics, and a provider-overridable split. The fixed helper
table is the interim stand-in for the prefix tree; it covers current Claude
families but won't inherit across unseen minor versions the way the tree would.

### The core type mismatch

"The model" is one `string` doing double duty for two different things:

- **requested model** — what YA config / the user chose (the YA alias, e.g.
  `opus`); and
- **reported model** — what the harness says it's running (the SDK-resolved id,
  e.g. `claude-opus-4-8`).

They differ, and because both are `string` the compiler can't catch
substituting one for the other. That is the actual bug class: `Process.getInfo()`
returns `model: resolvedModel ?? model`, i.e. it hands back the **reported**
model at the read boundary and discards the **requested** one, and that reported
string then gets used as a per-model config key it was never meant to be. The
status-quo *intent* was to key per-model settings (`compactAtContextPercent`) by
the **YA name** (the Settings slider does); the context quick-edit storing the
**reported** id was the deviation that fragmented the same model across two keys.

Fix the distinction nominally — a `RequestedModel` / `ReportedModel` brand (or at
minimum two separately-named fields surfaced at that boundary) so they can't be
swapped silently, with exactly one resolver where they cross. The two-field
minimum is now in place (`requestedModel` alongside the reported `model` on
`Process`/`ProcessInfo`/`LiveModelConfig`); the nominal brand is not yet.

### Rejected: probe-and-store-under-the-resolved-name

Initial idea: probe what each alias currently resolves to (`opus →
claude-opus-4-8`) and store config under the resolved name, so a non-owned
session (which reports the resolved name) is a direct lookup — no mapping,
search, or win-order. **Rejected because the resolution is not stable**: it
drifts with model versions and is subscription-dependent (`default` resolves to
different models per plan). Baking an unstable mapping into storage is brittle —
the stored key would silently stop matching when the resolution moves.

### Chosen shape

- **Owned sessions (YA-launched): key by the requested model** (the YA
  alias), which YA already tracks (`process.model`, persisted
  `SessionMetadata.model`). Don't key by `getInfo()`'s reported model.
  Distinct-by-choice: `opus` ≠ `best`, no forced sharing — max flexibility.
- **External sessions (attached/viewed, not YA-launched): no requested model**,
  so fall back to the **reported** name, canonicalized:
  - **provider-prefixed** (prepend the YA provider name if the reported name
    doesn't already start with it), so the namespace is provider-rooted;
  - **over-split into a prefix tree** — split on `-`, `.`, and alpha↔digit
    boundaries. Deterministic and applied identically at write and read;
    internal only, never user-facing. Over-splitting only makes prefixes *more*
    specific, so it can't cause wrong inheritance — it just adds harmless nodes
    and gives nicer minor-version grouping.
  - **longest-stored-prefix read.** Writing a setting writes the value at every
    prefix; an explicit node beats any inherited shorter prefix.
- **Inheritance survives resolution drift** — the robustness the rejected
  approach lacked: a bumped version (`claude-opus-4-9`), never configured, still
  reads `claude-opus-4`. Setting one model also populates broad prefixes, so an
  unconfigured sibling inherits the last-changed family value (accepted: an
  explicit per-model node always wins).
- **`off` is a stored 0, not a deleted key** — `{1–99 = percent, 0 = explicit
  off / don't inherit, absent = inherit}`. (Today the slider deletes at 0 and the
  validator drops 0; both flip.)
- **`default` is the holdout** — subscription-dependent, no reported name until a
  session runs; only learnable at runtime.

### Caveats / where the provider must override

The prefix family-default assumes a **stable component order** (family before
version). Provider naming doesn't always cooperate — Anthropic flipped it
(`claude-opus-4-8` is `{family}-{version}`, the older `claude-3-5-sonnet` was
`{version}-{family}`), so `claude-sonnet-4-6` yields a `claude-sonnet` prefix and
`claude-3-5-sonnet` yields none. For current models it's a non-issue, but it's
the reason the **provider may override the split / canonicalization** — default
is the universal over-split (no-op), a provider overrides only when its naming
needs re-ordering or to resolve an alias it has learned. This is the
requested↔reported / split surface, same default-does-nothing contract as
`contextWindowFor`.

### Recorded tension

Owned-by-requested gives distinct-by-choice (no sharing) and contradicts the
earlier "set opus, see it on best". You can't get both "distinct by choice" and
"shared by underlying model" from one key; owned-by-requested picks distinct. If
an owned setting should also apply when later *viewing an external* session of
the same model, owned would additionally write the resolved-name prefixes — but
that reintroduces the collapse. Owned-by-requested is the chosen default.
