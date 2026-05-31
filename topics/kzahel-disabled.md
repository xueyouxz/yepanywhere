# Kzahel-Disabled Features

> Kzahel-disabled features are YA UI or behavior experiments that upstream
> disables or removes, but that may still be worth preserving behind explicit
> user configuration.

Topic: kzahel-disabled

## Contract

When merging `kzahel/main`, treat an upstream commit that hides, disables, or
removes one of our speculative features as a product signal to record, not as
automatic proof that the implementation has no value. Read the incoming commit
carefully, cite the rejecting hash, and decide whether the feature should be:

- dropped because the underlying behavior is wrong or unsafe;
- retained but disabled by default;
- exposed through a customization or advanced-settings surface;
- replaced by a narrower UI that preserves keyboard access or expert workflows.

Prefer a resolution that keeps useful behavior configurable and default-off
over simply stripping code, unless the upstream commit demonstrates that the
behavior is incorrect, unsafe, or impossible to maintain.

Do not choose the resolution unilaterally. For each upstream commit that
reverts, hides, disables, or removes one of our speculative features, ask the
maintainer which resolution to pursue. Making a feature configurable is only
one option; the configuration UI burden may outweigh the benefit.

One possible compromise is a first-level `Enable experimental features` setting.
When enabled, it can reveal a set of experimental features for selective
configuration. Every experimental feature must link to its most relevant
`topics/*.md` document; a GitHub-viewable source link is sufficient, though YA
may also serve topic docs from the source tree.

Changes that only hide or disable a visible button while preserving its
keyboard accelerator can be logged without a full resolution plan. They still
matter because a later customization surface may want to expose the button
again while retaining the accelerator contract.

## Rejection Log

Record concrete upstream decisions here after merging or reviewing the relevant
kzahel commit.

| rejecting commit | feature | upstream action | suggested resolution | status |
|---|---|---|---|---|

## Related Topics

- [session-ui-customization.md](session-ui-customization.md) covers the
  user-facing path for enabling disabled or advanced session controls.
- [message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md)
  covers the underlying message delivery intents, including ASAP/deferred
  queue behavior.
