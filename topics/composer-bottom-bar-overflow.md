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

- Bottom-row controls should be represented as one ordered responsive control
  list with shared spacing and collapse rules, including shortcut help (`?`) and
  context percentage circle/text. The visual layout may still have left and
  right anchor groups, but splitting controls across unrelated containers with
  different spacing logic makes priority collapse fragile.
- Use a stable, tappable overflow (`...`) affordance, likely near the middle of
  the composer bottom row.
- Tapping `...` opens a popup/fold-out row; tapping `...` again dismisses it.
- The opened state is still one bottom-row control strip, not a detached
  explanatory panel: the `...` affordance remains selected at its stable anchor,
  and hidden icon buttons unfold next to it. Use the available side space around
  `...` first; if the left side is out of room while more hidden controls need
  to be shown, place them immediately to the right of `...` rather than letting
  the left side clip. The anchor slot must not move when opening. The strip can
  cover the composer if that is the cleanest narrow layout. Far-left and
  far-right controls may remain visible outside or behind the popup outline.
- Before hiding controls, spend cheap horizontal space first: reduce lateral
  composer/window padding and inter-button gaps down to the mobile-safe minimum
  (about 2px). Do not reduce bottom padding merely to fit the toolbar; vertical
  touch spacing remains a usability constraint.
- Lower-priority controls can vanish into the popup while the left and right
  anchor groups stay visually stable.
- Collapse should be progressive. Introducing `...` does not mean every
  eligible control disappears at once; hide only the controls needed for the
  current width, then move additional controls behind `...` at tighter widths.
- Hidden controls must remain reachable by tap/click from the popup menu, not
  disappear.
- The eligible set should include controls from both the left and right toolbar
  containers. Permission mode, attachment, slash, thinking, render/formula,
  heartbeat/pulse, and shortcut help may all collapse when space is tight; the
  exact priority order can be refined later.
- At squeeze widths, permission mode should use a pure icon/dot presentation
  rather than carrying text such as `Bypass` inline.
- Overflow priority does not require arbitrary reshuffling of the normal
  toolbar order. Prefer stable positions where possible; controls near the
  overflow affordance can collapse into it as space tightens.
- The overflow decision must be recomputed when conditional high-priority
  controls appear or disappear, including activity-dependent queue/patient
  controls while a turn is streaming. Adding or removing one of these controls
  should cause the lower-priority middle controls consumed by `...` to be
  recalculated from the current rendered state, not frozen from an earlier
  toolbar membership snapshot.

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
- Appearance/settings previews on mobile may need a friendlier multi-row or
  horizontally scrollable treatment. A temporary landscape-rotation hint is an
  acceptable fallback, but arbitrary user-controlled toolbar reordering is not a
  preferred direction unless a stronger need appears.

## Landed Surface

- First pass landed on 2026-06-07: at narrow widths, controls collapse behind a
  stable `...` affordance in tiers. Permission mode and attachment hide first;
  slash and thinking hide at a tighter width; render/formula, heartbeat/pulse,
  and shortcut help hide only at the tightest tier.
  Tapping `...` opens one absolute bottom-row menu attached directly to the
  selected `...` button: mode and attachment use the available left side, while
  slash, thinking, render/formula, heartbeat/pulse, and shortcut help spill to
  the right when left space would be tight.
- Context percentage, microphone, queue/patient controls, Stop, and send remain
  inline in that first pass.
