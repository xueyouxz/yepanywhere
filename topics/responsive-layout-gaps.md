# Responsive Layout Gaps

> Responsive layout gaps are YA UI places where the visible contract depends on
> default font metrics or fixed pixel thresholds instead of content-measured
> layout invariants, so wider fonts or larger UI size make controls wrap,
> squeeze, or steal space needlessly.

Topic: responsive-layout-gaps

## Method and authority

Treat the layout guidance in `~/agents/topics/functional-layout.md` (and the
other `~/agents` UI docs) as an untested hint, not the authority for this work.
The authorities are quality field-practitioner advice and first-principles
reasoning about the actual mechanism. Where a finding here contradicts those
docs, the finding wins and the `~/agents` rule becomes a revision candidate,
recorded as such rather than silently followed.

## The anti-pattern

anti-pattern: '...' hiding text that doesn't fit computed by math fit to current font and size settings that are user-configurable

anti-pattern: Writing # of px container width rules for when to autocollapse or change layout without the reasoned-through widths being live computation w/ actual font sizes and contracts in mind

## The correct pattern

a layout constraint solving discipline that references real geometry and AGENTS instructions that user layout requests use it. efficiency and incremental evolution / simple code.

shortcuts for fixed-width text are not allowed; always measure real horizontal extents

The declarative form of "measure real extents" is font-relative units, not a JS
pass: `ch` for horizontal text width (exact for a fixed-width block like the
`Ran` line; it over-counts for proportional fonts, where you bias or measure)
and `lh`/`rlh` for vertical line allocation. These move the offending fixed-px
and fixed-character-count constants onto the live font metrics, which is what
actually cures the anti-patterns. Confirm current `lh` and `line-clamp` baseline
support before relying on them in committed code.

efficiency matters esp. where layout rules affect unbounded session content

## Two change axes, two cost budgets

Distinguish the parameter being changed; the cost budget differs, and this is
the load-bearing decision for the whole scheme.

- *Window/container resize* is frequent and live (drag). Its response must be
  smooth and cheap: continuous in width, with no per-frame re-measure or
  re-solve.
- *Font, size, and spacing preferences* change rarely and deliberately, in a
  settings pane. A full re-measure and even a discontinuous re-layout is
  acceptable there, because the user is already re-learning positions from the
  change.

So put expensive work on the rare event and keep the frequent one cheap:
recompute leaf intrinsic extents and any mode-threshold widths when a
font/spacing pref changes; on resize, only re-evaluate the already-solved
layout — CSS reflows continuously, and a JS allocator merely compares the
current width against cached thresholds (O(modes), no re-measure). The matching
failure mode is a *stale threshold*: a cached width cutoff not invalidated when
metrics change is the fixed-px anti-pattern returning, so font/size/spacing (and
browser zoom / text-size-adjust) changes must invalidate the cache and
re-measure.

## The plan

locate an appropriate constraint-aware layout pattern (maybe some basics are already part of standard css/dom) and apply it piecewise as gaps are noticed by user-developers. we do not necessarily need a big declarative conceptual render graph; we just need common-sense helpers that compute rules using correct patterns and considering our project font styles' configurability and the simple width dependent ladder from mobile to mid-width PC with e.g. changing a fixed left quick access bar to a toggleable drawer at medium-small widths, up to generous-width; max content width and other legibility / allocation preferences are often encountered.

### Prior art search / framework-lite invention

Three engines can execute a "declare min/max ranges per priority, solve for
fit" model; they are not equivalent, and this project's stated preferences pick
one.

**A. A general constraint solver** (Cassowary, and its de-facto JS port
`kiwi.js` / `@lume/kiwi`) — the engine behind Apple Auto Layout: linear
(in)equalities with priorities (`required` plus soft strong/medium/weak),
minimizing weighted violation. It matches "allowed ranges per priority level"
most literally and is still the wrong default here. A constrained optimum can
change *which* constraints are active as inputs vary, so the solution jumps at
those transitions — discontinuity, i.e. jitter, with the target itself
teleporting so damping only smears it. It also wants the whole variable system
(it owns a subtree rather than feeding one min/max request up to a host layout —
the scene-graph burden we want to avoid), and it is content-blind (you must feed
it measured intrinsic sizes anyway, after which it mostly re-derives what the
browser already would). Worst-case solve cost is a lesser objection than these.

**B. CSS intrinsic sizing** (Grid/Flexbox, `min-content` / `max-content` /
`fit-content()` / `minmax()` / `clamp()`, container queries) — the browser's own
constraint propagator, and the right default. It propagates min/max-content
contributions up the box tree and resolves flexible lengths against the
container. It is content-aware for free (`max-content` *is* a control's no-wrap
extent), continuous/monotone within a mode by construction (the low-jitter
property), incrementally adoptable per region with no global graph, and runs in
the engine with no JS. Its one structural limit: it cannot do *conditional
visibility* (drop control X when even its min will not fit — hiding changes the
budget the next decision sees, a feedback loop CSS will not close) and cannot
pick a discrete mode by measuring siblings (a container query keys on container
size, the proxy the specimen gap above shows is not the real fit predicate).
Note also that `flex-wrap` is itself a *discontinuous* primitive — a wrap is a
jump — so the continuity property holds only when shrink, not wrap, is the fit
mechanism. The current `.output-font-selector` and `.settings-item-actions` use
`flex-wrap: wrap`, which is the live form of this bug.

**C. A small measured allocator** (JS + `ResizeObserver`), used only where B
cannot reach — the shipped composer-bottom-bar pattern. Read rendered leaf
extents, walk a *priority order*, keep the richest set/mode whose summed extent
(plus gaps and required side slots) fits, fold the rest behind one overflow
affordance. It is a *monotone ladder of hand-authored modes* (wide ->
collapsed-drawer -> mobile), not an optimizer: enumerate a few discrete layouts
and pick the richest that fits. Monotone-in-width transitions are single,
predictable, and FLIP-animatable — you place the discontinuities instead of a
solver scattering them.

**Verdict — a two-tier system, not one solver.** Tier 1 is CSS intrinsic
sizing for within-region allocation; it covers most of the gap inventory (shrink
the slider track before wrapping the number; shrink/fit the font-selector row
before it wraps). Tier 2 is the measured allocator over a monotone mode ladder,
only for conditional visibility and discrete mode selection (collapse-to-drawer,
fold-to-overflow, side-specimen vs stacked). "Priority" lives in both but as
different artifacts: Tier-1 `fr`/flex weights and `minmax` floors decide who
*shrinks* first; Tier-2 drop order decides who *disappears* first. The
constraint-propagation instinct is correct and adopted — just split across two
tiers, each using the right tool, rather than bolted on as a solver.

This stays a ~1-D problem because vertical is an affordance (scroll) and the
constrained axis is almost always horizontal — which is exactly what intrinsic
sizing and a width-sorted ladder handle, and why no 2-D solver is warranted. A
general solver becomes *tolerable* only if confined to the rare font/spacing-
change path per *Two change axes* above (where jitter is welcome) while resize
stays the cheap evaluation; but since CSS already does the continuous part for
free, the solver earns its keep only when the rare-path allocation is genuinely
too complex for intrinsic sizing plus a ladder — which this gap inventory is
not. Not every gap is a Tier-1 fix, though: controls that must keep full labels
(e.g. the four font buttons) can only wrap or overflow, so they belong to Tier 2.

layout invariants specified by user deserve tests; every such test should be run under a range of font size settings and screen widths; this topic proposes concretely additionally testing with a larger UI font and a particular prose font, but this is not the only possibility.

## Current Gap Inventory

Scope of this first inventory: Settings → Appearance, because the UI font and
UI size controls make the failure mode directly reproducible there.

Browser measurement, 2026-06-24: 1280×900 viewport, UI font Source Serif 4,
UI size Larger.

| Surface | Selector / source | Observed gap |
|---|---|---|
| Typography side specimen | `.output-appearance-panel`, `.output-appearance-controls`, `.output-appearance-specimen` in `packages/client/src/styles/index.css` | The side-by-side switch is `@container output-appearance (min-width: 26rem)`. With the app sidebar expanded, the controls column measured 284 px and the specimen 312 px; UI font, Prose font, and Fixed font selectors wrapped. With the sidebar collapsed, the controls column measured 424 px and those same selectors fit on one row. The invariant is not "panel ≥ 26rem"; it is "controls no-wrap extent + gap + specimen minimum ≤ panel inline size." |
| UI font selector | `.output-font-selector` under `appearanceOutputUiFontLabel` in `AppearanceSettings.tsx` | Four labeled buttons wrap to two rows in the expanded-sidebar case even though collapsing the sidebar proves the same viewport has enough page-level space. |
| Prose font selector | `.output-font-selector` under `appearanceOutputFontLabel` | Same as UI font; the row's max usable width is the controls column left after the fixed specimen allocation. |
| Fixed font selector | `.output-font-selector` under `appearanceOutputFixedFontLabel` | Same failure with three buttons; IBM Plex Mono is wide enough that the 284 px controls column wraps the row. |
| Tool preview lines | `.settings-item-actions` row in `AppearanceSettings.tsx` | Range + numeric value/unit wrapped to two rows. The row uses content-width flex wrapping instead of using available inline space inside the settings item. |
| Max Content Width | `.settings-item-actions` row in `AppearanceSettings.tsx` | Range + numeric value/unit + reset wrapped to three rows at both expanded and collapsed sidebar states. This was the reported relayout-heavy slider. |
| Generated Title Length | `.settings-item-actions` row in `AppearanceSettings.tsx` | Same three-row pattern as Max Content Width. |
| Hover Card Delay | `.settings-item-actions` row in `AppearanceSettings.tsx` | Same three-row pattern as Max Content Width. |
| Hover Card Max Height | `.settings-item-actions` row in `AppearanceSettings.tsx` | Range + numeric value/unit + line-count estimate + reset wrapped to four rows. The estimate is useful, but it needs an allocated slot or a second-line contract, not accidental wrapping. |

Also: 'Ran' blocks can display wrapping followed by unused space on the second line, followed by ... truncation. This was probably implemented by a fixed #chars count since it's a fixed width font - but the width is configurable!

Non-gaps in the same measurement: Theme, Settings Icons, UI size, and Tab Size
stayed one row. Composer bottom-row overflow already has its own measured
allocator contract in [composer-bottom-bar-overflow](composer-bottom-bar-overflow.md).

Relevant private task notes: `tasks/021-output-appearance-render-polish.md`
records the earlier specimen-container-query work; `tasks/027-fork-recap-lifecycle.md`
records the later UI font/UI size feature that exposed these font-metric
assumptions.

## Layout Invariant Scheme

Browsers already have intrinsic sizing algorithms, not an arbitrary constraint
solver. CSS Grid and Flexbox compute `min-content`, `max-content`,
`fit-content()`, flex base sizes, shrink/grow, and container queries. Use those
first: express the invariant as intrinsic sizes and let the browser choose the
track sizes.

When the invariant depends on conditional visibility, priority, or a mixed set
of controls whose widths change after choices move, use a small measured
allocator. The allocator reads rendered child extents with `ResizeObserver`,
adds gaps and required side slots, and chooses the highest-priority visible set
or layout mode whose total extent fits the container.

The durable invariant should be stated before implementation. Example:

> The Typography button-choice row is fully visible in one row whenever its
> measured no-wrap extent is no greater than the available controls column; if
> that cannot hold, the whole Typography block stacks before individual choices
> wrap.

For the specimen case, the decision predicate should be:

`controlsNoWrapInlineSize + specimenMinInlineSize + columnGap <= panelInlineSize`

not a hard-coded `26rem` container query. CSS may approximate this with
intrinsic grid tracks; JS measurement is appropriate if the approximation still
depends on default font metrics.

For the plain settings action rows, the invariant should be:

> A settings row with a range, numeric value, unit, and reset keeps those controls
> in one visible row when the full settings item has enough inline space; the
> range track shrinks before the controls wrap.

That points to a shared settings-control grid: label/copy column plus an action
column whose range track is `minmax(<usable-min>, 1fr)` and whose number/unit
and reset slots are `max-content`. Wrapping should be an explicit narrow-mode
state, not a side effect of `flex-wrap: wrap` on a content-width action box.

## First conversions

Concrete starting points, in priority order. Each is a worked instance of the
two-tier verdict above.

### 1. Settings action rows → Tier 1 grid (the reference conversion)

`.settings-item-actions` (Max Content Width, Generated Title Length, Hover Card
Delay, Hover Card Max Height, Tool preview lines) is `flex-wrap: wrap` today, so
it breaks to 2–4 rows instead of shrinking. The fix already exists in this same
stylesheet: `.output-appearance-slider-row` is `grid-template-columns:
minmax(8rem, 1fr) max-content` — the range track shrinks continuously while the
value/unit slot stays intrinsic. Adopt that shape:

```css
.settings-item-actions {
  display: grid;
  /* range track          value+unit   reset */
  grid-template-columns: minmax(6rem, 1fr) max-content max-content;
  align-items: center;
  gap: var(--space-2);
}
```

The `minmax(<usable-min>, 1fr)` range absorbs all width change; number+unit and
reset are `max-content` so they never wrap internally; the Hover Card Max Height
line-count estimate gets its own `max-content` slot instead of wrapping to a
fourth row. State `<usable-min>` as the smallest operable track (≈6rem) and make
the narrow case an explicit two-row mode (controls under label, via a container
query on the settings item), not `flex-wrap`. Invariant: one row whenever
`usable-min + value/unit + reset + gaps ≤ item inline size`; below that, the
documented two-row mode, never per-control wrap.

### 2. Font selectors → Tier 2, but a selector ladder, not overflow-hide

`.output-font-selector` (UI / Prose / Fixed font, three–four full-label buttons)
cannot be Tier 1 — full labels can only wrap or overflow. But hiding font
choices behind a `...` is the wrong Tier-2 shape: these are mutually exclusive
options the user is choosing among, so all options should stay discoverable.
([composer-bottom-bar-overflow](composer-bottom-bar-overflow.md) already notes
appearance/settings previews "may need a friendlier multi-row or horizontally
scrollable treatment" and that arbitrary hiding is not preferred.) So the font
selector's mode ladder is **one row → explicit two-row → horizontal-scroll
strip** at the narrowest, with the selected option always visible. Replace the
accidental `flex-wrap: wrap` with that named ladder.

### 3. Vertical line reserve and the "Ran" block cap → font-relative units

- **Reserve at least N, at most M wrapped lines** — the one content-dependent
  (width→height) case. `min-height: calc(N * 1lh)` reserves N lines against the
  *live* line-height; cap with `max-height: calc(M * 1lh)` plus `overflow`
  (scroll) or `line-clamp: M` with ellipsis. No fixed px, so the reserve tracks
  font and line-height changes.
- **"Ran" block truncation** is a fixed character count for a fixed-width font,
  but the fixed-font *size* is configurable, so the cap drifts. Monospace makes
  `ch` exact: replace the char-count cap with `max-width: <N>ch; overflow:
  hidden; text-overflow: ellipsis; white-space: nowrap` (or `line-clamp` for a
  multi-line cap). One `ch`-based extent rule removes the observed "wrap, then
  unused space, then `…`" artifact — the symptom of mixing a wrap with a
  separate char-count truncation.

## Verification Direction

Add a browser-level layout check for the Appearance page that sets:

- UI font: Source Serif 4
- UI size: Larger
- viewport: at least one expanded-sidebar desktop width and one collapsed-sidebar
  desktop width

The check should assert row-count invariants from rendered geometry, not only
absence of horizontal overflow:

- UI font / Prose font / Fixed font selectors have one child top position when
  the chosen layout mode claims a side-by-side specimen.
- Max Content Width and sibling range rows have one child top position when the
  settings item has enough inline size for the measured child widths plus gaps.
- If those invariants cannot hold, the parent layout has chosen the documented
  stacked mode rather than letting individual controls wrap accidentally.
