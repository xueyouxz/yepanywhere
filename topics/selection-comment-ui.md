# Selection Comment UI

> Select a span of agent output and turn it into a `>` blockquote in the
> composer, so a follow-up turn can comment on a specific passage. The quoted
> source keeps a subtle green tint until that quote is removed from the composer
> or the turn is sent, so you can see what you have already pointed at.

See also:

- [`ui-architecture.md`](ui-architecture.md) — render-boundary principle: the
  tint and the per-paragraph controls attach to the block renderer that owns
  the source, not to post-rendered DOM.
- [`composer-rich-input.md`](composer-rich-input.md) — the composer is a
  `<textarea>` + overlaid mirror; that bounds how the quote lands and forces
  the tint↔draft link to be reconciled against a plain string, not real nodes.
- [`session-ui-customization.md`](session-ui-customization.md) — whether the
  per-paragraph quote circle is always-on or a hideable/optional control.

Topic: selection-comment-ui

Status: **Phase 1 shipped 2026-06-23; the two contract gaps fixed 2026-06-23.**
Assistant text blocks can be quoted via selection typing, a floating selection
`>` button, or per-paragraph `>` circles; the resulting `>` block is inserted
into the composer and the selected source span is tinted until the quote is
removed or sent. Wider quotable surfaces and right-mouse line-select remain
design/follow-up work.

## Resolved gaps (Phase 1)

Both were fixed 2026-06-23, verified in the running app.

- **Floating `>` button on small/partial selections — fixed.** The button did
  appear for short selections, but was mispositioned: it is placed (top/left)
  relative to the `.message-list` rect in JS, yet `.message-list` was
  statically positioned, so the absolute `.selection-quote-button` resolved
  against a farther positioned ancestor and landed in the centering margin —
  next to a short selection it sat far left, reading as "no button." The
  originally-predicted cause (the copy path's coverage-equality gate in
  `extractMarkdownSnippetsFromSelection`) was wrong: browser repro confirmed the
  extractor returns snippets for short selections. Fix: `position: relative` on
  `.message-list` so the JS offsets match the button's containing block.
- **Circles per text block, not per paragraph — fixed.** `TextBlock` now
  renders an overlay rail (`.text-block-quote-rail`) with one circle at the end
  of each top-level rendered block (paragraph / list / heading), each quoting
  just that block via `getMarkdownSnippetForSubElement` — which recovers the
  block's source span through the same `getMarkdownForVisibleSelection` map the
  copy/selection path uses. The whole-block circle stays as a fallback when no
  paragraphs are measured (e.g. while streaming). Circles keep the existing
  hover-reveal and Appearance always-show behavior; the rail never intercepts
  pointer events, so text selection is unaffected.

## Vocabulary

- **Quote-comment** — the action: a selected span of agent output becomes a
  `>` blockquote appended to the composer, and focus moves to the composer.
- **Comment anchor** — the persistent association between one inserted quote
  block and the source span it came from. Tracked in a per-session list.
- **Comment tint** — the subtle green paint on an anchored source span.
- **Quote circle** — the circled `>` affordance that triggers quote-comment.
  Two placements: floating next to a live selection, and one per paragraph.

The vernacular here is GitHub's "quote reply" (`>` blockquotes), which is the
mental model the feature was requested under.

## What the user sees (contract)

Three entry points, one action.

1. **Type over a selection.** With a non-collapsed selection inside agent
   output and focus *not* already in a text field, the first printable
   keystroke: appends the selection as a quote block to the composer, moves
   focus to the composer, and that same keystroke becomes the first character
   of the comment typed below the quote.
2. **Quote circle near a selection.** A floating circled `>` appears next to a
   live selection. This is the primary path on touch, where there is no "start
   typing" trigger. Tapping it focuses the composer (raising the soft keyboard)
   and runs the same quote-comment.
3. **Per-paragraph quote circle.** Each agent paragraph/block carries a circled
   `>` at its end. Default visibility is hover-revealed on desktop, like the
   existing copy and render-toggle buttons in `text-block-actions`
   (`components/blocks/TextBlock.tsx`). An **Appearance** option — "always show
   quote circles" — switches them to always-visible; this is what makes them
   usable on touch (no hover) and is also offered on desktop for users who want
   them shown without moving the mouse near. Clicking quotes that paragraph.
   Its tooltip points the user at the finer path:
   highlight text — or right-drag
   to select lines (see the line-select helper below) — to comment on a specific
   sub-range instead of the whole paragraph.

The quote block itself:

- Each source line is prefixed `> `. A selection spanning multiple blocks
  yields one `> ` block per source block, blank-line separated (the existing
  copy path already splits per source element and joins with `\n\n`).
- If the composer already holds text, two blank-line-separated newlines come
  first — this is exactly the existing `appendComposerTransferDraft` rule, not
  a new one.
- After insertion the caret sits after the quote, on a fresh line below it,
  ready for the comment.

After a quote-comment fires, the live selection is cleared and the source span
gets the comment tint.

**Tint lifecycle — the anchor list.** Each quote block has a matching anchor,
hence a tint:

- A tint clears when its quote block is removed from the composer — concretely,
  when none of that block's `>`-prefixed lines remain in the draft (the user
  deleted the quote). Editing words *inside* a surviving `>` line keeps it.
- All tints clear when the turn is sent.

Additional quote-comments add more anchored ranges to the same tint. Clearing all
matching `>`-prefixed quote lines from the composer, or sending the turn, clears
all corresponding tints.

## Reuse map (mostly assembly, not new machinery)

The genuinely hard parts already exist for copy-selection-as-markdown and the
`/btw` composer transfer. This feature wires them to a second consumer.

- **Selection → markdown source.** `getMarkdownForVisibleSelection(source,
  selectedText, { textBefore })` in `lib/markdownSelectionCopy.ts` already maps
  a rendered selection back to its markdown source, and every agent text block
  registers its source via `registerMarkdownCopySource` (TextBlock).
  `copyMarkdownSelectionToClipboard` already walks the
  `[data-markdown-copy-source]` elements a selection crosses and joins per-block
  snippets with `\n\n`. Factor the snippet extraction out of the clipboard
  writer into a shared `extractMarkdownSnippetsFromSelection(root)` returning
  the per-block snippets plus their source elements/ranges; copy and
  quote-comment both call it. (Render-boundary principle: extend the generator,
  do not post-process the DOM.)
- **"Two newlines if the composer is non-empty."** `appendComposerTransferDraft`
  in `pages/SessionPage.tsx` *is* this rule, already used by the `/btw`
  transfer. Quote insertion = `appendComposerTransferDraft(getDraft(),
  quotedBlock)`.
- **Transfer-into-composer precedent.** `transferBtwTurnToMotherComposer` /
  `applyMotherComposerTransfer` push text up through `draftControlsRef` (a
  `DraftControls` from `useDraftPersistence`) into the Mother composer,
  including the "composer not mounted yet → stash pending" case. Quote-comment
  follows the same shape.
- **Caret placement + range reconciliation.** `lib/textareaSelection.ts`
  (capture/restore helpers) and the speech-commit reconciliation in
  `lib/speechDraftTransaction.ts` are the precedent both for "mutate the draft
  string, then place the caret deterministically" and for "track a range
  through later edits" — the exact shape the tint↔draft reconciliation needs.
- **Source↔visible mapping for painting tint over rendered markdown.**
  `buildVisibleSourceMap` (same file) maps source offsets ↔ visible text, which
  is what turns a stored source range back into a paintable DOM range.

Net new code: the keystroke-capture trigger, the quote circles, the anchor
list + tint paint + reconciliation, and the right-mouse line-select helper.

## Where state lives

`SessionPage` already owns `draftControlsRef` and hands callbacks to both
`MessageList` and `MessageInput`; it is the shared parent and the right home
for the anchor list. Concretely a `useCommentAnchors` hook (or a small
session-scoped context) holding `{ id, messageId, blockIndex, sourceRange,
quotedText }[]`, with:

- `MessageList` / the block renderer reading anchors to paint tint at the
  render boundary.
- A draft-watch reconciler dropping anchors whose `>` lines are gone.
- The submit path clearing all anchors next to the existing
  `draftControls.clearDraft()` calls — that is the send seam.

Persisting anchors alongside the draft (shared lifecycle, shared localStorage
namespace) would let a reload that restores the draft also restore the tint.
Follow-up, not v1.

## Cruxes / hard parts

## Unfulfilled UI contract gaps

The shipped phase fixed basic quote-comment insertion, but several requested UI
contracts remain open:

- **Right-click/right-drag paragraph selection.** Selecting whole paragraphs (or
  line/block ranges) by right-click-dragging was part of the intended advanced
  selection path. It is not yet implemented. The gesture should feed the same
  quote-comment action as ordinary text selection, producing a range that maps
  back to source markdown rather than a DOM-only scrape.
- **Selection-local `>` button.** Any completed selection in agent output should
  surface a `>` quote-comment button positioned relative to the mouse/touch end
  point at selection-drag end. It must not depend on selecting a large span or
  landing near a particular paragraph action rail. The current floating button
  exists, but this contract is broader: every valid selection should get a
  visible nearby action.
- **Dedicated action lane for auto-shown `>` circles.** Paragraph and system
  output section quote buttons, especially when configured always-shown, need
  their own reserved column/lane. They must not overlay or obscure the paragraph
  text, system output, or adjacent controls. The fix belongs in the shared
  block/action layout, not in per-paragraph positioning patches.

These are UI-surface obligations for the same quote-comment primitive; do not
build a parallel quote path for them.

### Tint paint over rendered markdown

The recovered range is a DOM `Range` clipped to the registered markdown source
element. YA registers one CSS Custom Highlight API highlight under
`::highlight(comment-tint)` and adds every live anchor range to it. It paints
without mutating the DOM, so it does not fight React re-renders or the
streaming-markdown container swaps inside `TextBlock`.

Robustness is **best-effort by design**: the tint is a reminder of what you
quoted, not load-bearing. If a re-render or virtualization drops a range it
re-resolves on the next render from the anchor descriptor. The source-mode
`<pre className="text-block-source">` case is trivial — wrap the offset range
directly.

### Keystroke capture

A capture-phase `keydown` on the message-list root, firing only when: a
non-collapsed selection lies within registered copy-source elements; focus is
not already in an input/textarea/contenteditable; and the key is a bare
printable character (`key.length === 1`, no Ctrl/Meta/Alt). On match,
`preventDefault`, run quote-comment, focus the composer, and append the typed
character to the draft ourselves — the original event will not be redelivered
to the newly focused textarea. Ctrl+C is not a bare printable key, so it still
routes to the existing `copy` handler in `MessageList`; no conflict.

### Clearing attribution (which anchor owns which `>` lines)

On each draft change, reconcile anchors against the draft. Recommended
heuristic: an anchor is live while at least one of its quoted lines still
appears as a `>`-prefixed line in the draft, matched on the first quoted line's
content signature so an anchor that was edited or moved is still found. Exact
line-range tracking through arbitrary edits is fragile (the speech range-mapping
work shows why); a content-signature match is good enough for a reminder tint.

## Right-mouse line-select helper (ancillary)

A general selection enhancement in agent output that feeds the same quote
pipeline. In areas with no more specific context menu:

- Hold the **right** mouse button and drag past a small threshold → begin
  line-granularity selection (snap each selection end to a line boundary), and
  suppress the context menu for that gesture.
- Right-click without dragging past the threshold (a "click") → normal context
  menu; do not suppress.
- Double right-click → select the enclosing paragraph.

Implementation outline: a `pointerdown(button === 2)` → `pointermove` →
`pointerup` state machine on the message-list container, plus a `contextmenu`
handler that `preventDefault`s *only* when a line-drag actually started this
gesture. Hit-test pointer → caret with `caretPositionFromPoint` (standard) /
`caretRangeFromPoint` (WebKit fallback), then expand each end to its line.
"Line" can mean a visual line box (`Range.getClientRects`) or a source line;
prefer visual line boxes so the selection matches what the user sees.

Coordinate with the existing container `pointerdown` listener in `MessageList`
(scroll-follow) so neither breaks the other, and never interfere with normal
left-button text selection.

**Platform risk to validate on Linux first:** `contextmenu` timing (press vs
release) and whether suppressing it mid-gesture is reliable across Chromium and
Firefox. This is the fiddliest part of the whole feature and is therefore Phase
3; prototype it behind a flag before committing to it. The keystroke and
quote-circle paths do not depend on it, so it can ship later without holding up
the rest. Where the gesture is known not to mesh with a platform's native
context-menu behavior, disable it outright there (feature-detect / platform
gate) rather than ship a half-working right-drag — the per-paragraph circle
already covers whole-paragraph quoting on those platforms.

## Phasing

- **Phase 1 — core quote-comment over assistant text.** Shipped 2026-06-23:
  keystroke trigger, floating selection quote circle, hover circles
  (hover-default + Appearance "always show"), quote insertion, and selected-span
  comment-anchor tint with draft reconciliation. Scope is assistant text blocks,
  matching the existing copy-source scope. The two early gaps (small-selection
  floating button, per-paragraph vs per-block circles) were fixed 2026-06-23 —
  see *Resolved gaps*.
- **Phase 2 — widen quotable scope.** Extend the same selection→quote pipeline
  to edit diffs, any outline-expanded text (including expanded Read contents),
  user turns, thinking summaries (see below), and other rendered agent output.
  Each surface needs a registered markdown/text copy-source so the shared
  extractor can recover its source; the pipeline itself does not change.

  **Thinking summaries — quote while streaming *or* finished.** We want to
  select and comment on a thinking-summary item even mid-stream, not only once
  it settles. This is the one Phase-2 surface whose source is *live*: a
  streaming thinking summary keeps growing/rewriting, so the comment anchor
  cannot track a moving source the way it tracks a settled block. Snapshot the
  quoted text at quote time (the `>` block is a frozen copy regardless), and
  either drop the tint when the underlying streaming text mutates out from under
  the range or re-resolve it best-effort against the latest text. The quoted
  composer content is unaffected either way; only the tint is at risk.
- **Phase 3 — right-mouse line-select helper.** Below; intentionally last
  because it is the fiddliest and the rest does not depend on it. May be
  disabled outright on platforms where the gesture does not mesh with native
  context-menu timing.

## Decisions

- 2026-06-23 — **Tint paint = selected-span CSS highlight.** V1 keeps a list of
  live anchor ranges and paints them with `::highlight(comment-tint)`; the tint
  is a reminder, not load-bearing.
- 2026-06-23 — **Per-paragraph circle = hover-default, Appearance toggle for
  always-show.** The always-show mode covers touch (no hover) and is also a
  desktop option. Lives in the Appearance settings pane.
- 2026-06-23 — **Scope is phased** (assistant text first; see Phasing).
- 2026-06-23 — **Right-mouse line-select is a later phase** and may be disabled
  on known-incompatible platforms.

## Still open

- **Anchor persistence across reload** (follow-up; tint re-attaches to a
  restored draft).

## Default-preserving note

Quote-comment is purely additive — a new trigger, new buttons, a new tint — and
changes no existing default, satisfying the YA "UI changes preserve non-buggy
defaults" rule. The per-paragraph circle stays hover-revealed (desktop) by
default and only becomes always-visible when the user opts in via the Appearance
"always show quote circles" setting; even then, keep it as unobtrusive as the
existing `text-block-actions` buttons.

This is a client-only feature (composer + transcript rendering); no server
change, so no `reyep` restart is needed to exercise it during development.
