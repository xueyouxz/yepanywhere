# Features Disabled by kzahel/main

> Features disabled by kzahel/main are YA UI or behavior experiments that
> upstream disables or removes, but that may still be worth preserving behind
> explicit user configuration.

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
| `78da755` | Patient/ASAP queued-message mode | Removed the visible queue-mode toggle, prompt prefixing, `patient` metadata, and related queue tests/docs. | Restore as experimental/default-off: normal queue remains plain `deferred`; enabling `Experimental features` reveals the patient/ASAP toggle and emits `patient` only for that path. | Superseded: the visible toggle and the `Experimental features` gate (its sole entry) were both removed. The "when done, " prefix + `patient` intent is now bound to the Ctrl+Enter accelerator only; plain-Enter steer and button-click queue stay unprefixed. See [session-ui-customization.md](session-ui-customization.md). |
| `cdef7bf` | `/btw` toolbar button default visibility | Made the `/btw` toolbar control hidden by default through toolbar customization. | Accept upstream default; typed `/btw` and the keyboard accelerator remain valid regardless of toolbar visibility. | Accepted. |
| `750fe20` / `cee1f6b` | Message and user-prompt controls | Hide secondary message/user prompt actions until hover or focus. | Accept upstream preference as a screen-efficiency tradeoff; keep accelerators discoverable in hover/focus help where applicable. | Accepted. |
| `25e7f5d1` | Compose-time anchors + batched deferred flush | Removed `(Ns ago)` / `(Ms later)` anchors and the anchor helper/docs; queued messages reach the provider verbatim. Separately objected (in discussion) that flushing several queued turns as one `--------`-joined turn defeats one-slice-per-queued-message use and differs from first-party UIs. | Maintainer resolution (2026-06-11): preserve both behind explicit config, default off — `composeAnchorsEnabled` / `YA_COMPOSE_ANCHORS` and a compose-time join window `deferredJoinWindowSeconds` / `YA_DEFERRED_JOIN_WINDOW_S` (0 = never join); default delivery is one verbatim deferred turn per boundary. UI surface planned as a "Message Delivery" settings pane. See [compose-time-context-anchors.md](compose-time-context-anchors.md) and [vanilla-defaults.md](vanilla-defaults.md). | Implemented (server side; pane pending). |

## Related Topics

- [session-ui-customization.md](session-ui-customization.md) covers the
  user-facing path for enabling disabled or advanced session controls.
- [message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md)
  covers the underlying message delivery intents, including ASAP/deferred
  queue behavior.
