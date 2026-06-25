# Permission Mode

> Permission mode is YA's per-session approval policy: a saved standing
> preference is provider-independent, while each selected model's capabilities
> determine which modes can be used for a particular launch or live session.

Topic: permission-mode

See also: [session-defaults](session-defaults.md) for why permission mode lives
with all-provider session defaults rather than provider/model economics.

## Auto mode and provider capability

`Auto` means provider-decided approval: the provider/model classifies each
permission prompt and may approve it or ask the user. In current YA code this
is exposed through model metadata, `ModelInfo.supportsAutoMode`; the only
checked-in provider that populates that metadata today is Claude. Within Claude,
support is still model-specific: live Claude SDK metadata or YA's fallback
catalog must mark a model with `supportsAutoMode: true` before the UI offers
`Auto` for that selected model.

This makes the user's observation accurate with one precise wording: choosing
`Auto` is an all-provider standing preference, not a provider-scoped default,
but a selected model that lacks `supportsAutoMode` must resolve that preference
to `Ask` (`default`) for display and launch. Switching from a Claude model that
supports `Auto` to Codex, Grok, or a Claude model that lacks the flag should
therefore show `Ask` as the effective selection while preserving the saved
preference as `Auto`.

The fallback is sensible because `Auto` is not "never ask". It means the
provider decides whether to ask on each permission request. A provider/model
without that classifier cannot faithfully run `Auto`; the conservative
equivalent is `Ask`, not `Bypass` and not a hidden provider-specific setting.

## Storage and launch rules

- Store `permissionMode` once in `newSessionDefaults`; do not add provider-keyed
  permission defaults merely because `Auto` is currently Claude-only.
- Filter the visible/effective mode by the selected model's capability. If the
  saved value is unsupported, render/use `default` (`Ask`) for that selection.
- Preserve the raw saved value across provider/model switches. A provider switch
  may change the effective selection, but it must not rewrite `Auto` to `Ask`
  unless the user explicitly chooses `Ask`.
- New-session launch must send only a mode the selected provider/model can
  honor. For unsupported `Auto`, send `default`.
