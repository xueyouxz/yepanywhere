# Responsive Layout Gaps

> Responsive layout gaps are YA UI places where the visible contract depends on
> default font metrics or fixed pixel thresholds instead of content-measured
> layout invariants, so wider fonts or larger UI size make controls wrap,
> squeeze, or steal space needlessly.

Topic: responsive-layout-gaps

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
