# UI control alignment baselines

This topic defines the row-alignment contract for header/toolbars and other
compact control groups.

## Baseline policy

When a user requests vertical movement of status/control elements,
alignment changes should be made by changing a shared metric, not by per-control
`transform: translateY(...)` nudges.

Preferred sequence:

1. Define or reuse a shared control-row token (height/padding/gap).
2. Apply the token through a common selector used by the row containers.
3. Update related glyph or icon alignment only when token changes preserve
   semantic size and hit target.
4. Regressively verify neighboring controls in the same row and its subpanels.

Examples:

- session header controls (`session-header-left`, `session-header-right`,
  and nested status badges),
- composer controls (`message-input-toolbar`, `message-input-left`,
  `message-input-actions`, and their compact variants),
- new session toolbar controls (`new-session-form-toolbar-left`, submit and
  auxiliary buttons).

## Anti-hack rule

Ad-hoc `translateY()` and similar transforms that exist solely to make a control
“sit better” should only be allowed for transient animation or intentional
overlay motion.

For steady-state alignment corrections:

- prefer container-size tokens (padding/line-height/height/border box),
- prefer consistent glyph envelope sizing,
- then adjust row-level spacing variables.

This avoids requests like “move this 1px up” becoming a permanent exception.
