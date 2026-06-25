# Session Defaults

> Session defaults are the standing choices used to seed new YA sessions;
> some apply across all providers, while provider/model economics controls
> must be stored per provider rather than shared as one global value.

Topic: session-defaults

See also: [permission-mode](permission-mode.md) for the `Auto` permission-mode
fallback contract when a selected model cannot honor provider-decided approval.

## Contract

Session defaults are not one flat bucket. A default either answers "what should
new sessions generally do?" or "how should this provider/model spend work?".
Those scopes must stay separate in storage, UI grouping, and migration.

### All-provider defaults

All-provider defaults apply no matter which provider is selected. Provider
capabilities may decide whether a choice has an effect at launch, but the UI
should not hide or rewrite the user's standing preference merely because the
currently selected provider lacks the feature.

- **Default AI provider** — the provider chosen when opening a new-session form.
- **Permission mode** — the requested approval policy. A model may hide or
  ignore unsupported modes such as provider-decided `Auto`, but the saved
  default is not a provider/model economics choice.
- **Recaps** — recap mode, away threshold, and the tailed fallback model belong
  together. They are presented above AI Provider because they are a standing
  session-helper choice, not a property of whichever provider button happens to
  be selected.
- **Prompt suggestions** — expose `Off` / `Native` unconditionally. Launch code
  only enables native provider suggestions when supported, but the default UI
  must not show provider-specific "unsupported" copy in the all-provider area.
- **Show thinking** — display policy for already-produced thinking rows. This
  is not provider spend; it belongs outside the AI-provider-specific region and
  may keep the existing per-install/live-toggle persistence pattern.
- **Forked sessions** — fork-after-summary display/opening behavior, such as
  whether to open the forked session in a new tab when ready. This is a
  session-UI preference, not a provider/model economics choice.

### Provider-specific defaults

Provider-specific defaults depend on provider/model capabilities, cost, latency,
and naming. They must be keyed by provider, and model-sensitive values should be
resolved against that provider's available model metadata.

- **Model** — model ids are provider-local and cannot be shared across providers.
- **Service tier / speed tier** — provider-visible economics and latency knobs.
- **Thinking mode** — `off` / `auto` / `on` changes provider work requested.
- **Effort level** — effort labels are not comparable across providers; `high`
  on one backend is not a portable meaning or cost on another.

Switching AI Provider should restore that provider's provider-specific defaults
without disturbing all-provider defaults. Changing an all-provider default should
not overwrite per-provider model/thinking/effort choices.

## Recap fallback semantics

`Forked` is a preference for the higher-fidelity recap path, not permission to
silently fail when the selected provider or model cannot fork. If fork recap
generation is unavailable or fails before producing a recap, YA should fall back
to the tailed helper path when the provider can generate recaps at all.

Because `Forked` can fall back to `Tailed`, the fallback model selector is
labeled **Tailed Recap Model** and shown whenever a simulated recap mode can use
it (`Tailed` directly, or `Forked` as fallback). The selector is hidden for
`Off` and for purely native recap mode.

## UI placement

In the session-defaults panel and the new-session form:

1. All-provider defaults: recaps, including **Tailed Recap Model** when
   applicable; prompt suggestions; permission mode; and show-thinking display
   policy; forked-session behavior.
2. AI Provider. The selector is the boundary between all-provider defaults above
   and provider-specific defaults below.
3. Provider-specific defaults for the selected provider: model, service tier,
   thinking mode, and effort.

Permission-mode cards are equal-sized by design. Their captions should fit the
card grid with short explanatory text:

- `Ask` — `Ask every time`
- `Edit` — `Ask to run commands`
- `Plan` — `Do not attempt edits`
- `Bypass` — `Auto-approve all actions`
- `Auto` — `Provider decides`

## Storage and migration direction

Use a shape that preserves existing top-level fields while adding a scoped
provider-default map, for example:

```ts
interface NewSessionDefaults {
  provider?: ProviderName;
  permissionMode?: PermissionMode;
  recapMode?: RecapMode;
  recapAfterSeconds?: number;
  promptSuggestionMode?: PromptSuggestionMode;
  helperSideModel?: string;
  providers?: Partial<Record<ProviderName, ProviderSessionDefaults>>;
}

interface ProviderSessionDefaults {
  model?: string;
  serviceTier?: string;
  thinkingMode?: ThinkingMode;
  effortLevel?: EffortLevel;
}
```

Backward compatibility rule: top-level legacy `model` / service-tier-like
fields, and legacy `useModelSettings` thinking/effort values, seed the selected
provider's first provider-specific entry. Do not discard configured values on
read; normalize into the scoped shape on the next save.

## Implementation plan

1. **Pin this contract.** Create this topic, add the glossary/topic index row,
   and use it as the commit topic for the UI/storage changes.
2. **Recap UI and fallback.** Move recap controls above AI Provider; show
   **Tailed Recap Model** for `Tailed` and `Forked`; make `Forked` available
   whenever the provider can generate recaps; make server fork recap failures
   fall back to tailed generation.
3. **Prompt suggestions.** Show `Off` / `Native` unconditionally in the
   all-provider defaults area; remove provider-specific unsupported copy; keep
   launch-time native enablement capability-gated.
4. **Provider-specific defaults.** Add `newSessionDefaults.providers` and wire
   selected-provider model, thinking mode, and effort through it. Preserve legacy
   fields and existing saved preferences by seeding the selected provider on
   read/next save.
5. **All-provider placement.** Move permission mode, show-thinking display
   policy, and forked-session behavior out of the AI-provider-specific region.
   Keep show-thinking all-provider/per-install and separate from thinking mode +
   effort spend controls.
6. **Permission captions.** Shorten equal-width permission-mode card captions to
   the text above.
7. **Tests.** Cover provider switch persistence, all-provider recap/suggestion
   persistence, fork-to-tailed fallback, and the new ordering/label invariants in
   focused client/server tests before typecheck.
8. **Layout verification.** Verify the defaults panel is efficient and sensible
   in a modest 1200×1000 options content area: the core defaults should be
   usable without unnecessary scrolling, with recap/suggestion/provider/model/
   thinking/permission controls packed by their scope rather than stretched into
   a long vertical list.
