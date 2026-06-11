# Edit-turn inline editing

> Edit-turn is the proposed inline UI contract for editing queued or sent user
> turns without making an empty composer look like a fresh draft.

Topic: edit-turn

## Proposal status

Queued-turn inline editing is implemented as of 2026-06-11: clicking a queued
turn edits it in place, blur saves the queued text in place, and `Cancel edit
(Esc)` restores the original text without moving it into the composer. Sent-turn
editing is still correction editing through the composer. The remaining proposed
direction is to make sent-turn correction use the same inline target shape when
that product contract is ready.

## Problem

Editing a previous turn through the normal composer creates an ambiguous empty
state: if the user selects all text and deletes it, the screen can look the same
as a fresh-message composer. The UI needs a discoverable escape hatch and a
visible edit target so a destructive-looking local edit can be cancelled without
guessing which mode is active.

## Inline edit contract

- Entering edit mode replaces the target queued or sent user turn with an
  inline textarea/editor at that turn's transcript position.
- Focus moves into the inline editor. The normal composer should not be the
  active fresh-message target while inline edit is active.
- The editor autogrows with input up to a bounded height, then scrolls
  internally. Controls remain attached to the edited turn.
- The turn shows a visible edit-state control such as `Cancel edit (Esc)`.
- Pressing `Esc` while focus is inside the inline editor cancels edit mode,
  restores the original turn text, and removes the visible cancel control. That
  disappearance is the confirmation that the cancel happened.
- Select-all/delete leaves an empty inline editor in edit mode. Empty text does
  not collapse back into a fresh composer state.
- Higher-priority UI layers, such as menus or dialogs, may consume `Esc` first.
  The visible cancel control must always perform the same edit-cancel action.

## Queued vs sent turns

Queued turn editing is scratchpad editing: the saved result should update the
queued item while preserving the queue contract, including original queue
position and any edit barrier needed to keep later queued items from passing it.

Sent turn editing is correction editing under the current YA model. It does not
mutate the historical provider transcript, and the user-facing submit action
should not imply transcript rewind. Prefer labels like `Send correction` or
`Submit correction` over `Resend from here`.

Use a rewind-style label only if YA later implements a separate explicit flow
that discards or supersedes later assistant output and replays from the edited
turn. That is a different product contract from the existing latest-turn
correction path.

## Scroll and autofollow

Entering inline edit mode should pause transcript autofollow enough that the
edited turn does not move away while the user is typing. On cancel or submit,
YA may reenter autofollow if there is no unread text yet. If new unread content
arrived while edit mode was active, preserve the paused/read-position state
instead of snapping to the bottom.

## Relation to existing composer controls

The visible `Cancel edit (Esc)` control is the discoverable escape hatch. It is
stronger than relying on cursor focus alone, and the inline cursor is stronger
than a composer banner because the target turn remains the physical editing
surface.

If an incremental implementation keeps composer-restored edits for a while, the
same escape-hatch invariant still applies: edit mode persists until explicit
submit or cancel, and empty text is still edit mode rather than a fresh draft.
