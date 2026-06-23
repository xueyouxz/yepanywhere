# Mobile horizontal swipe-scroll for grouped rows

Status: **proposal / deferred.** Captures the intended behavior and the
hazard that makes it non-trivial, so it can be picked up safely later.
No code lands from this doc yet.

See also: [`ui-architecture.md`](ui-architecture.md) (rendering boundary),
[`ui-control-alignment.md`](ui-control-alignment.md) (mobile hit targets).

## Goal

Inside an **Explored** group, each entry is a `Read <filename>` /
`Grep …` / `List …` row. On a phone the filename is wider than the
viewport. Today each entry truncates independently with an ellipsis
(`.explored-entry-summary { white-space: nowrap; overflow: hidden;
text-overflow: ellipsis }`), so the tail of every path is unreachable.

Desired: a horizontal swipe scrolls **the whole Explored rectangle as one
unit** — all entry rows move together, sharing a single horizontal scroll
offset, so the user can swipe left to read the tail of every path at once.
Rows must still **not wrap** (the current no-wrap behavior is correct and
must be preserved). This is synced horizontal scroll, not per-row scroll.

## Why one shared offset

The user asked for "scrolls adjacent items in sync … affecting the whole
explored rectangle." That rules out making each `.explored-entry` its own
horizontal scroller (rows would drift out of alignment). The clean shape is
a single horizontal scroll **viewport** (`.explored-group-body`) whose
content is intrinsically wider than the viewport; the vertical stack of rows
lives inside it, so every row inherits the same scrollLeft for free.

## Sketch (not yet implemented)

In `packages/client/src/styles/tool-rows.css`, on `.explored-group-body`:

- add `overflow-x: auto` (it already has `overflow-y: auto` and a
  `max-height`, so it becomes a 2-axis scroller);
- drop the per-entry `overflow: hidden` / `text-overflow: ellipsis` on
  `.explored-entry-summary` so each row reaches its natural width and the
  body content box grows past the viewport. Keep `white-space: nowrap`.
- the row container (`.explored-entry`) must size to content width
  (`width: max-content` / `min-width: 100%`) so all rows share the same
  content width and scroll together.

No JS is required for the scroll itself — one overflow-x container gives the
synced offset.

## The hazard: back-swipe gesture (the reason this is deferred)

On mobile browsers a horizontal swipe **starting near the screen edge** is
the OS/browser *back* gesture (history back → in this app, session →
session list). A horizontal scroller placed near that edge will fight the
back gesture: either the scroll eats the back gesture, or the back gesture
yanks the user off the session. This is the same edge-swipe ambiguity called
out for the file-viewer pane (see the back-gesture handling added to
`FileViewerModal`); resolve them with one consistent story.

Candidate mitigations, roughly in order of preference:

1. **`overscroll-behavior-x: contain`** on `.explored-group-body` — stops
   horizontal overscroll from chaining to history navigation once the user
   is inside the scroller. Cheap, CSS-only, try first.
2. **Keep the scroller off the screen edge.** The Explored body is already
   indented (`margin-left`, left border); a left gutter that never reaches
   `x=0` means a swipe that begins inside the rectangle is unlikely to be
   claimed as an edge-back gesture. Verify the indent is enough on real
   devices after the indent reductions in this batch.
3. **`touch-action`** tuning (`pan-x pan-y`) if the browser still
   misroutes the gesture.
4. **JS touch arbitration** as a last resort: track touchstart X; only treat
   as horizontal scroll when the gesture begins beyond an edge threshold.
   Avoid if 1–3 suffice — it is the brittle path.

## Open questions

- Does `overscroll-behavior-x: contain` alone defeat the back gesture on
  iOS Safari, or only Chrome/Android? Needs device testing, not emulator.
- Should there be a visible scroll affordance (fade/shadow on the right edge)
  so users discover the hidden tail? Probably yes; design after scroll works.
- Interaction with the existing vertical scroll (`max-height: 8.5rem`,
  `overflow-y: auto`) when both axes are scrollable in one container.

## Acceptance

- Swiping horizontally inside an Explored group reveals the tail of every
  path, with all rows moving in lockstep; rows never wrap.
- A back-swipe still works as expected and does not get eaten when the user
  is not trying to scroll horizontally; horizontal scroll does not
  accidentally trigger session→list navigation.
- Verify on a real phone (the gesture conflict does not reproduce on
  desktop or the emulator reliably).
