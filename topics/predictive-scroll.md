# Predictive Scroll / On-Demand Hydration

Covers how tool-call rows avoid rendering expensive content until it is near the
viewport, how they estimate placeholder height before rendering, and how the
session sidebar loads sessions lazily as the user scrolls.

## Why defer rendering

Tool rows can contain:
- Shiki-highlighted code (CPU-intensive HTML parse on the client path)
- `FixedFontMathToggle` rendering (regex scanning, KaTeX, table construction)
- Large diff views with line-by-line processing

Rendering all rows up front on a long session blocks the main thread and makes
the session list feel slow to load. Instead, rows render a lightweight placeholder
until they approach the viewport.

## IntersectionObserver lookahead — `useNearViewportHydration`

`ToolCallRow` uses `useNearViewportHydration` (defined in `ToolCallRow.tsx`) to
gate expensive rendering behind an `IntersectionObserver` with a generous root
margin:

```
PREDICTIVE_SCROLL_AHEAD_PX = 1600   // lib/predictiveScroll.ts
rootMargin = "1600px 0px"           // top and bottom pre-load band
```

A row transitions from deferred to hydrated (`shouldHydrate = true`) when its
element enters the 1600px-above/below-viewport band. At that point,
`interactiveSummaryContent`, `collapsedPreviewContent`, and any expanded rich
content are computed and rendered.

**Force-hydrate paths** (bypass the observer):
- Pointer enters the row (`onPointerEnter={hydrateNow}`)
- Focus enters the row (`onFocus={hydrateNow}`)
- User clicks the header dot button (`hydrateNow` called in `handleDotClick`)

Rows that are not yet complete (`status !== "complete" && status !== "error"`)
skip deferral entirely and render immediately, since streaming content must be
live.

## Placeholder height estimation — `estimateDeferredPreviewHeightPx`

Before a Bash-like row hydrates, it shows a styled placeholder box
(`.tool-row-deferred-preview-box`) whose height is estimated from the output
preview only. The command itself now lives in the shared row header, so it is not
counted in the preview placeholder height. This prevents large layout shifts as
rows hydrate while the user scrolls.

**Algorithm** (only for Bash-like tools; other tools return `null`):

1. **Content width**: measured from the row's `getBoundingClientRect` when
   available; falls back to 720px.
2. **Chars per line**: `clamp(floor(width / 7.5), 24, 160)` where 7.5px is the
   average monospace character width.
3. **Output line count**: counts logical lines in stdout+stderr, wrapping long
   lines using the chars-per-line estimate.
4. **Output height**: `clamp(lineCount × 18, 35, 80)px + 12px` chrome, or a
   28px empty-output row.
5. **Total**: output height plus the 2px preview border, clamped to `[28, 94]px`.

Constants live in `DEFERRED_PREVIEW_HEIGHT` (exported from `ToolCallRow.tsx`)
so tests can reference them directly; see
`blocks/__tests__/ToolCallRow.preview-height.test.ts`.

The placeholder is rendered in a separate `hasDeferredPreviewShell` branch
(distinct from the live collapsed preview) using a CSS custom property
`--tool-row-deferred-preview-height` to pass the estimate to the style layer.

## Sidebar session lazy loading — `isNearScrollEnd`

The session sidebar paginates its session list. `isNearScrollEnd` (also in
`lib/predictiveScroll.ts`) checks whether the user is within `PREDICTIVE_SCROLL_AHEAD_PX`
(1600px) of the bottom of the sidebar scroll container:

```ts
element.scrollHeight - element.scrollTop - element.clientHeight <= aheadPx
```

When true, the sidebar fetches the next page of sessions. This reuses the same
lookahead constant as the row hydration, keeping the two prefetch distances
consistent.

## Correctness requirements

- **No layout collapse on hydration**: the deferred placeholder must be tall
  enough that replacing it with real content does not shift content that was
  already in the viewport. The `[32, 134]px` clamp is a conservative range;
  very long outputs can exceed 134px, so some shift is still possible.
- **scrollbar-gutter: stable** on `.session-messages` prevents the scrollbar
  appearing/disappearing from changing content width during streaming, which
  would otherwise cause all `overflow-x: auto` code blocks to flicker
  horizontal scrollbars.
- **State is not reset on hydration**: `dotExpanded`, `expanded`, etc. are
  initialised once at mount and persist through the component's lifetime;
  late-hydrating rows do not unexpectedly collapse rows that the user has
  already interacted with.
