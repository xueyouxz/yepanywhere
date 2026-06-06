# Scrollback View Stability

> When a reader has scrolled back from the live tail, streaming output and
> layout changes must not move what they are reading. Defines the two scroll
> regimes, the stability target and its required granularity, why the collapse
> trigger is independent of jitter, what the current implementation actually
> does, and the known regressions to fix.

Topic: scrollback-view-stability

See also: [`packages/client/RENDERING_PERFORMANCE.md`](../packages/client/RENDERING_PERFORMANCE.md)
("Transcript Layout Stability"), [predictive-scroll](predictive-scroll.md)
(placeholder-height prevention), [rich-text-rendering](rich-text-rendering.md)
(`useScrollPreservingToggle` / `lib/scrollAnchor.ts`).

## Two scroll regimes

The transcript reader is always in exactly one of two regimes, and the policy
differs between them:

- **Following the tail** — pinned at/near the bottom, watching live output.
  `shouldAutoScrollRef` is true; `isScrolledToBottom` is true. Here the view
  *should* track new content: appended rows and the streaming current turn may
  freely change height, and the view re-pins to the bottom.
- **Scrolled back** — the reader has scrolled up to read or review earlier
  content. `shouldAutoScrollRef` is false. Here the view *must hold still*: no
  streaming growth, expand/collapse, hydration, late markdown/highlight, or
  background heuristic may move the content the reader is looking at.

The boundary between regimes is itself a policy decision (see "Near-bottom
re-engage" below) and is the source of the worst current bug.

## Stability target (policy)

When **scrolled back**, the quantity to hold constant is a **content position**,
not a render row. The reader's eye is at some point in the content; that point
must stay put across a height change elsewhere.

1. **Anchor to a content position, at sub-item granularity.** A single thinking
   or output block routinely exceeds the viewport. "Top of the first visible
   item" is the wrong unit: if the reader is scrolled into the middle of a tall
   block and content *within that same block, above the reading line* reflows
   (a streaming line-wrap earlier in the block, a re-highlight, a late markdown
   augment), pinning the block's top lets the reading line drift by the
   intra-item delta. The held point must be *inside* the item — a line box,
   child block, or DOM text offset at the chosen viewport line — so it sits
   below the reflow, not above it.

2. **Target line: ~20% down the viewport, as a soft target.** The exact
   fraction is a comfort knob, not a correctness property: between-item growth
   is compensated in full regardless of the fraction, and the dangerous case
   (intra-item growth above the line) is governed by granularity, not by the
   fraction. 20% (eyes in the upper region, with headroom above) is the default;
   it is explicitly *not* 0% (a torn line at the very top reads worse) and the
   choice of 20% vs any nearby value is not load-bearing.

3. **Boundary snap (the "smart flex").** If the content at the target line is
   within a small threshold `T` of an item's top, snap the anchor *up* to the
   item top instead of freezing a torn line mid-paragraph. This reads better
   (clean semantic boundary) and is cheaper — it reuses the item-granular anchor
   path — so the expensive sub-item machinery is only needed when the reader is
   genuinely deep inside a block taller than the viewport. Snap **upward only**,
   bounded by `T` (≈ half to one line height, or a small viewport fraction);
   never push the item top off-screen. The snap is a **nice-to-have**, not on
   the critical path, and must engage only when scrolling has come to **rest** —
   a mobile momentum-scroll settle, or a discrete `PgUp`/`PgDn` jump. It must
   **not** fight smooth continuous mousewheel scrolling, where adjusting the
   position under an active scroll feels like the view resisting or jumping.

4. **Capture once, restore exactly.** Establish the anchor (including any snap)
   when scrolling settles, then restore to that fixed anchor on every
   subsequent reflow *without re-evaluating the snap*. Re-snapping each frame
   turns the ±`T` flex into its own jitter. The snap is a one-time reposition,
   not a live target.

5. **Restore before paint.** Height change and `scrollTop` restore must happen
   together in `useLayoutEffect` (or a tight rAF pair) so there is no visible
   intermediate frame.

### Native `overflow-anchor` tradeoff

CSS `overflow-anchor: auto` (browser scroll anchoring) gives sub-item
granularity for free — the browser holds a deep node near its anchor point —
but it will **not** do the boundary snap and is finicky under programmatic
`scrollTop` writes. YA has no `overflow-anchor` CSS and reimplements anchoring
manually at *row* granularity. The clean split, if pursued, is: native owns the
**scrolled-back** hold (sub-item, free), manual `scrollTop` owns only the
**following-the-tail** case. If the boundary snap matters, prefer a YA-owned
anchor (we control the snap and the sub-item position); native is the cheaper
sub-item fix but drops the snap. Either path needs browser verification — native
anchoring is suppressed under several conditions and fights manual scroll.

## Jitter is independent of the collapse/tidy trigger

A recurring confusion is to treat "auto-collapse on a timer" as the cause of
scroll jitter. It is not. **Jitter is purely whether a height change compensates
`scrollTop` against the anchor.** The *trigger* for a height change — a 4.2s
timer, a "block scrolled past while following", a "collapse previous when the
current thinking block completes", a streaming line-wrap — is orthogonal to
whether it jitters.

Consequences:

- Any tidy/collapse rule is jitter-free **if** it routes through the
  scrolled-back anchor restore and is **deferred or skipped while scrolled
  back**. Pick whatever trigger serves the reader's mode; the trigger is not the
  hazard.
- A content-driven trigger (e.g. collapse the previous thinking block when the
  next one *completes*) is strictly better than a wall-clock timer — the read
  grace becomes "as long as the next block streams" instead of a fixed guess —
  but it is still a past-row height change and so is bound by the same anchor +
  scrolled-back-guard rule. It also only tidies multi-block turns, not a lone
  block followed by idle.

## What the implementation does today

- **Item-granular anchor** — `getFirstVisibleRenderAnchor` (MessageList.tsx)
  records the first render row intersecting the viewport and a **signed**
  `topOffset = rowRect.top - scrollRect.top`. A negative offset (scrolled into a
  tall block) is preserved, so it *does* hold a mid-block scroll position — but
  only at *row* granularity, so intra-item reflow above the reading line is the
  uncovered case (see target #1).
- **`preserveScrollAfterTranscriptHeightChange`** applies that anchor (or a
  pure height-delta shift when no anchor row is found) and re-pins to bottom
  when following. It is currently wired to **exactly one caller**: the global
  hide/show-all-thinking toggle (`toggleThinkingItemsVisible`). Per-row thinking
  expand/collapse and streaming growth do **not** route through it.
- **`useScrollPreservingToggle`** (`lib/scrollAnchor.ts`) anchors the
  *acted-on element* (the Σ fixed-font toggle) — correct for that one control.
- **`ResizeObserver`** (MessageList.tsx) re-pins to bottom on every height
  increase while `shouldAutoScrollRef` is true. During streaming this fires at
  the flush cadence (~200ms).
- **Near-bottom re-engage** — both the `ResizeObserver` else-branch and the
  programmatic-scroll release flip `shouldAutoScrollRef` back to true whenever
  `isNearScrollBottom` holds, i.e. within `BOTTOM_FOLLOW_VIEWPORT_FRACTION`
  (0.45) of the viewport, capped at `MAX_BOTTOM_FOLLOW_THRESHOLD_PX` (520).
  Wheel/touch scroll calls `stopFollowingForUserScroll`, but a *small* scroll-up
  that stays inside this band is re-captured on the next flush.
- **`RENDERING_PERFORMANCE.md` "Transcript Layout Stability"** is the
  kzahel-side statement of the invariant (no timers/visibility/stream-status
  effects changing historical row height; tidy only via explicit user control).
  This topic is the YA-side elaboration of the *anchor target* that invariant
  leaves unquantified.

## Contracts / invariants

- Scrolled back ⇒ no automatic height change moves the anchored content
  position. Defer such changes until the reader returns to the tail.
- Every transcript height change, from any trigger, restores the scrolled-back
  anchor (content position, sub-item granularity) when not following — not just
  the one path currently wired.
- Following the tail ⇒ appended/current-turn growth re-pins to bottom; this is
  the only regime allowed to chase height.
- The collapse/tidy trigger is a UX choice; jitter-safety is a separate,
  always-required property.

## Planned improvements

Ordered roughly by reader impact.

1. **Streaming yanks a near-bottom reader down (~200ms cadence).** *Observed,
   streaming-on:* while the agent thinks for a long time, the reader cannot hold
   a scrolled-up position — every streaming flush (~200ms) re-pins them to the
   bottom. Escape only succeeds once they scroll far enough that the streaming
   turn is fully offscreen (past the near-bottom band), after which the view is
   stable. *Likely mechanism (corroborated by that escape behavior, not yet
   instrumented):* the `ResizeObserver` re-pins on every height increase while
   `shouldAutoScrollRef` is true, and the near-bottom re-engage heuristic
   (`isNearScrollBottom`, ~45% / ≤520px) keeps flipping follow back on after a
   small scroll-up — defeating the intended `thinkingDeltaFollowAllowedRef`
   guard. Fix direction: a deliberate scroll-up should *latch* scrolled-back
   until the reader returns to the actual bottom (or crosses a much tighter
   threshold), so a single small scroll-up is not re-captured by ongoing
   streaming growth.

   *Mitigation (symptom-hiding, not a fix):* at the start of a thinking turn,
   pre-allocate the block's expected height — an estimate, capped so it never
   exceeds ~60% of viewport height — so streaming growth re-flows *within* the
   reserved box instead of increasing transcript height on every flush, which
   reduces `ResizeObserver` re-pins. This only masks the yank (and over-reserve
   would itself shift layout, hence the cap); the latch above is the real fix.
   Same reserve-to-avoid-shift idea as predictive-scroll placeholder heights.
2. **Wire all height-change paths through the anchor.** Per-row thinking
   expand/collapse and streaming growth currently bypass
   `preserveScrollAfterTranscriptHeightChange`; route them through it so the
   scrolled-back hold applies regardless of trigger (target #1, #4).
3. **Sub-item anchor granularity.** Replace the row-granular anchor with a
   content-position anchor at the ~20% soft target (targets #1–#2) so intra-item
   reflow above the reading line stops moving the view. Evaluate native
   `overflow-anchor` for the scrolled-back hold versus a YA-owned anchor.
4. **Boundary snap (nice-to-have, not urgent).** Snap the anchor to a nearby
   item top within threshold `T` (target #3). Lower priority than 1–3, and
   gated: engage only at scroll rest (mobile momentum settle, `PgUp`/`PgDn`),
   never during smooth continuous mousewheel scrolling. Requires a YA-owned
   anchor — native `overflow-anchor` cannot do the snap.
5. **Re-introduce auto-tidy of thinking, jitter-free.** With the anchor wired,
   an attention-driven tidy (collapse a thinking block once scrolled past while
   following, or "collapse previous when current completes") can return the
   self-cleaning transcript without the original timer's hazards — deferred while
   scrolled back. Coordinate with the `RENDERING_PERFORMANCE.md` invariant, which
   currently forbids visibility-driven collapse and would need the documented
   tradeoff + browser verification it itself calls for. Context: commit
   `0958645d` removed the prior timer/moving-id auto-collapse to stop the jitter;
   this would restore the benefit (bounded reading time, tidy transcript) on the
   correct trigger.
