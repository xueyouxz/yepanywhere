# Composer Rich Input (future vision)

> Aspirational, not planned. A future direction for the message composer's text
> input that would let inline interactive elements (speech pending tags with
> their own `✕`, and possibly attachment/command chips) live *in the text flow*
> with the caret naturally positioned after them — something a plain
> `<textarea>` structurally cannot do.

Topic: composer-rich-input

Status: **vision only.** The shipped approach is the textarea + overlaid
draft-mirror (see [mic-button-speech-ui.md](mic-button-speech-ui.md)); the
interim caret-after-tag behavior is faked there (option "B"). This doc records
why a richer input is the clean long-term structure, so the tradeoff is not
re-derived each time.

## Why a textarea can't do it

The composer input is a plain `<textarea>`. Two hard limits drive everything:

- **No inline interactive elements.** A textarea holds plain text only, so an
  inline `✕` on a pending speech tag can only be drawn in an overlaid,
  aria-hidden mirror — never a real child of the editable region. Pointer-events
  on the mirror tag make it clickable, but it is not part of the text model and
  not reachable by assistive tech as a control.
- **Caret position is value-driven.** A pending tag (e.g. `Listening…`) is
  zero-width in the textarea *value* — it exists only in the mirror — so the
  native caret sits structurally *before* the tag. Placing the caret *after* the
  tag requires either a real placeholder character in the draft value (which
  pollutes the text and could be submitted) or a faked, separately-rendered
  caret with the native one hidden.

## What a rich input would enable

A `contenteditable` (or a small rich-text model rendered to one) would make the
pending tags **real inline nodes**:

- Each pending batch transcription a real inline tag node at its own insertion
  point, before the caret, in arrival order, each with its own interactive,
  accessible `✕`.
- The caret naturally lands after a tag because the tag is a real node with
  real width in the document.
- Streaming interim preview, selected-span replacement, and the batch pending
  tags would unify on one node model instead of the value/mirror split.

## Costs and risks (why "not for now")

`contenteditable` is notoriously finicky; a switch must re-validate, at minimum:

- IME composition (CJK and others) — the current textarea path has explicit
  `isComposing` handling.
- Mobile soft keyboards, autocorrect, and `enterKeyHint`/submit behavior.
- Paste sanitization (today plain text + file paste are handled deliberately).
- Draft persistence/restore, undo/redo, selection math (the speech insertion
  ranges and their mapping-through-edit logic assume string indices).
- Accessibility and tests across all three composers (MessageInput,
  NewSessionForm, FloatingActionButton).

Until those are worth taking on, the textarea + mirror with a faked caret (B) is
the interim, and this richer input stays a vision.
