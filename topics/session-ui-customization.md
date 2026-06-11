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
`nudge`, `microphone`, `sessionStatus`, `shortcutsHelp`, `contextUsage`, `btw`,
and `queueControls`. Toggling a control updates the
preview immediately.
Controls are three-valued in client storage: missing/`default` follows the
current client default, while booleans are explicit local choices. The server
also persists `clientDefaults.sessionToolbarVisibility` so the last selected
toolbar value becomes the default for devices with no explicit local override.
Resetting the toolbar visibility clears local overrides and returns that
browser to following the server client default.

The former composer model indicator chip is removed from the customizable
toolbar. The top-right provider badge remains the model/effort status surface
and opens the mid-session model, thinking, and effort control panel for owned
sessions.

This is the resolution path for session controls that are useful to some users
but too busy, speculative, or maintainer-contested for the default UI. Examples
include composer delivery choices such as regular queue versus patient queue,
secondary search/edit controls, and other advanced per-session actions.

Patient queue is a distinct per-item delivery intent, not a magic prompt prefix.
The phrase `when done, ` is ordinary user-authored text. YA must not add it
when queueing. The active composer model is:

- **Plain Enter** follows the user's selected default action for the active
  steering state, currently steer by default when the provider supports
  steering.
- **Ctrl+Enter** is the "other" regular action: if Enter steers, `Ctrl+Enter`
  regular-queues; if Enter queues, `Ctrl+Enter` steers. Patient is not the
  shortcut.
- The **straight-arrow queue button** remains available for steering providers
  while a turn is active, including mobile users who cannot rely on keybinds.
  The patient-switch visibility setting must not hide this alternate send
  option.
- The **patient stopwatch toggle** is default-off and affects only future queue
  submissions. Accepted queued items keep their own regular or patient intent.
- Patient queued rows wait for their per-item verified-quiet patience seconds
  (default 30s).
  Regular queued rows may pass patient rows at delivery time, so UI should
  visibly distinguish patient rows while preserving composition order in the
  scroll-following queue tail.
- The `?` shortcut help should mention right-click/long-press as the route to
  change key behavior. The first narrow setting is swapping Enter and
  `Ctrl+Enter`; broader keybind remapping can build from there.

`onQueue` is only supplied while the agent is running, so a "done" agent never
reaches the queue path. The `queueControls` appearance toggle controls only
the regular/patient switch; the alternate Steer/Later send button remains
visible when dual-action delivery is available. Tooltips must state the regular
queue and patient queue distinction. See
[`message-control-steer-queue-btw-later-interrupt.md`](message-control-steer-queue-btw-later-interrupt.md).

## Remaining work

Relative to the landed surface:

- Toggling is a checkbox list beside the preview, not click-on-the-mockup-
  control interaction.
- Visibility is binary show/hide; there is no "visible but disabled" treatment
  (dimmed / crossed-out) that keeps a removed control legible in the real UI.
- No per-session override distinct from the browser-local explicit choice yet.
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
