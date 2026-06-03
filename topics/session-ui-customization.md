# Session UI Customization

> Session UI customization lets users choose which session controls are visible
> or enabled while preserving keyboard-driven access to advanced actions.

Topic: session-ui-customization

## Landed surface

The first customization surface has shipped: Appearance settings → "Session
toolbar" renders a live `SessionToolbarPreview` mockup beside a per-control
visibility list, plus a reset-to-defaults action.
<!-- verified: AppearanceSettings.tsx:51-121,327; SessionToolbarPreview.tsx -->
Visibility state is held by `useSessionToolbarVisibility` and currently covers
`modeSelector`, `attachments`, `slashMenu`, `thinkingToggle`, `renderMode`,
`nudge`, `microphone`, `modelIndicator`, `sessionStatus`, `shortcutsHelp`,
`contextUsage`, `btw`, and `queueControls`. Toggling a control updates the
preview immediately.

This is the resolution path for session controls that are useful to some users
but too busy, speculative, or maintainer-contested for the default UI. Examples
include composer delivery choices such as ASAP versus deferred/"when idle"
send, secondary search/edit controls, and other advanced per-session actions.

Patient queued messages graduated out of the experimental gate entirely: the
former `Experimental features` setting in Advanced (its only entry was this
feature) and the in-composer patient/ASAP toggle button were both removed.
<!-- verified: useDeveloperMode.ts no longer defines experimentalFeatures -->
The "when done, " prefix is now bound purely to invocation method rather than
any mode or visibility toggle:

- **Plain Enter** while the agent is busy steers immediately (when steering is
  supported) and is never prefixed — adding "when done" to an immediate steer
  would contradict its meaning.
- **Ctrl+Enter** queues a deferred message and prepends "when done, " (with
  case-insensitive dedup so a message already opening with "when done" is left
  alone). This is the only path that adds the prefix.
- A **button-click queue** stays unprefixed (plain deferred).

`onQueue` is only supplied while the agent is running, so a "done" agent never
reaches the queue path. The queue control's *visibility* is the
`queueControls` appearance toggle above; its tooltip surfaces the Ctrl+Enter
"when done" accelerator even though the visible button itself does not prefix.
See [`message-control-steer-queue-btw-later-interrupt.md`](message-control-steer-queue-btw-later-interrupt.md).

## Remaining work

Relative to the landed surface:

- Toggling is a checkbox list beside the preview, not click-on-the-mockup-
  control interaction.
- Visibility is binary show/hide; there is no "visible but disabled" treatment
  (dimmed / crossed-out) that keeps a removed control legible in the real UI.
- No global-defaults vs per-session-override distinction yet.
- Hidden controls do not guarantee a surviving keyboard-accelerator hint on a
  hover/tooltip surface.

## Contract

- Defaults may stay conservative, but optional controls should have a path to
  remain available without rebuilding the UI for each maintainer preference.
- A disabled visible button is a UI preference, not necessarily a disabled
  command. If the keyboard accelerator still works, tooltip and mouseover
  surfaces should continue to show that accelerator.
- Customization state should distinguish global defaults from per-session
  overrides, matching the pattern used by new-session/global defaults where
  possible.
- Controls disabled by upstream preference should be candidates for
  configurable default-off restoration before the implementation is removed.

## Mockup Requirements

The landed surface shows a realistic session composer/toolbar mockup
(`SessionToolbarPreview`). The target end state, not yet fully reached, is that
clicking a control in the mockup itself toggles whether the real session UI
shows or enables that feature, and that disabled controls remain legible in the
mockup using a visual treatment such as dimming or strikethrough/cross-out so
the user understands what can be restored.

The hover surface for grouped or secondary actions should include keyboard
accelerators for actions that remain available by shortcut, even if their
visible buttons are disabled.

## Related Topics

- [kzahel-disabled.md](kzahel-disabled.md) logs upstream-disabled features that
  should be reconsidered as configurable default-off session controls.
- [message-control-steer-queue-btw-later-interrupt.md](message-control-steer-queue-btw-later-interrupt.md)
  defines message delivery behaviors that session customization may expose or
  hide.
