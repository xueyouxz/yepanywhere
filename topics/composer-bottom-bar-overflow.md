# Composer Bottom-Bar Overflow

> Composer bottom-bar overflow preserves high-priority session controls on
> narrow screens by folding lower-priority controls into a tappable popup menu
> anchored in the composer bottom row.

Topic: composer-bottom-bar-overflow

## Concern

The session composer bottom row can contain delivery controls, Stop, queue and
patient controls, microphone, context percentage, shortcuts help, render/formula
toggles, heartbeat/pulse, `/btw`, attachments, and other optional controls. On
narrow screens those controls can crowd or overlap each other. The fix should
not make controls vanish permanently or force users to discover settings before
they can reach a control.

## Contract

- Use a stable, tappable overflow (`...`) affordance, likely near the middle of
  the composer bottom row.
- Tapping `...` opens a popup/fold-out menu; tapping `...` again dismisses it.
- The popup is constrained to the composer bottom-row interaction zone. It can
  expand both left and right from the `...` anchor and may cover the composer
  if that is the cleanest narrow layout.
- Lower-priority controls can vanish into the popup while the left and right
  anchor groups stay visually stable.
- Hidden controls must remain reachable by tap/click from the popup menu, not
  disappear.
- Overflow priority does not require arbitrary reshuffling of the normal
  toolbar order. Prefer stable positions where possible; controls near the
  overflow affordance can collapse into it as space tightens.

## Priority Notes

- Primary message actions, Stop, queue/patient controls, and microphone should
  stay reachable before lower-priority controls are shown inline.
- Formula/render controls and heartbeat/pulse controls are lower priority than
  microphone for narrow inline space. They can move behind overflow earlier.
- Shortcut/help (`?`) is lower priority than context percentage, because context
  percentage is live session state while `?` is reference/help.

## Open Design Notes

- The fold-out can behave like gullwing doors: lower-priority controls near the
  stable middle overflow anchor move into a menu that expands left and right,
  while higher-priority anchors remain in place.
- This topic is about responsive reachability. It does not replace the separate
  session-toolbar visibility customization surface, which controls whether a
  user wants a control available at all.
