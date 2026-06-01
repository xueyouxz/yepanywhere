# Stable Tool Preview Rendering

Status: Stable preview rendering defaulted on 2026-06-01

Progress:

- [x] 2026-06-01: Captured the long-session scroll-jump regression and the
  preferred direction: a user-visible setting to disable deferred tool preview
  hydration.
- [x] Add a browser-local Appearance setting for stable tool preview rendering.
- [x] Wire the setting into `ToolCallRow` so completed/error rich tool previews
  hydrate immediately when enabled.
- [x] Verify focused renderer coverage and update this note with the shipped
  behavior.
- [x] 2026-06-01: After desktop/mobile validation, made stable preview
  rendering the default and kept deferred hydration as the explicit opt-out.

## Context

Long Codex sessions can contain many completed tool rows with rich previews:

- Bash output with ANSI, markdown-like output, and fixed-font rich rendering;
- Edit/apply_patch rows with collapsed diff previews;
- Write/Read previews with highlighted or rendered file content.

The v0.5.0-era long-session performance work introduced on-demand hydration for
completed/error tool rows. The goal was to reduce initial browser work in very
large sessions by avoiding offscreen rich preview DOM and formatter work until a
row approaches the viewport or the user interacts with it.

That improved initial browser metrics, but it creates visible scroll jumps when
rows hydrate while a user scrolls upward through history. The concrete repro is
a long Codex session where completed `apply_patch` rows start as a one-line
`Edit <file> ...` header and then expand into several lines of diff preview as
they enter the hydration band.

## Problem

Deferred hydration optimizes initial load at the expense of scroll stability.
For users who value stable transcript reading, the tradeoff is wrong:

- completed Edit rows can insert many lines of preview near or above the
  viewport;
- mobile viewports have less room for browser scroll anchoring to mask the
  insertion;
- "content changes as I scroll" feels like session order or message content is
  unstable, even when the underlying transcript is correct.

The existing mitigation is a Bash-specific placeholder height estimate. That
does not cover Edit rows, and extending it per renderer would make each rich
renderer responsible for maintaining a parallel height model. That model would
drift whenever CSS, fonts, mobile layout, wrapping, truncation, or renderer
features change.

## Direction

Prefer an explicit user choice over per-renderer height estimators.

Add a browser-local Appearance setting that lets users control stable tool
preview scrolling. When enabled, completed/error tool rows render their rich
collapsed previews immediately instead of entering deferred hydration mode.

Stable rendering is the default after desktop and mobile validation. This
deliberately spends more client CPU, DOM nodes, and memory on initial load to
avoid scroll jumps and late content insertion. Users can still disable the
setting if very large sessions feel slower.

## First Slice

The first implementation slice should be small and reversible:

1. Add a `localStorage`-backed client preference under `UI_KEYS`.
2. Expose the preference in Appearance settings with copy that states the
   tradeoff: more browser work for stabler scrolling.
3. Read the preference in `ToolCallRow`.
4. When enabled, make `useNearViewportHydration` return hydrated immediately and
   skip the `IntersectionObserver` path.
5. Add focused tests showing:
   - the default/current deferred behavior still exists;
   - the stable setting renders completed Edit previews immediately even when
     `IntersectionObserver` is available.

The first slice does not change server behavior, transcript ordering, REST
payload shape, or rich renderer internals.

Verification for the first slice:

- `pnpm --filter @yep-anywhere/client test -- src/components/blocks/__tests__/ToolCallRow.test.tsx`
- `pnpm --filter @yep-anywhere/client exec tsc --noEmit`
- `pnpm exec biome check docs/tactical/008-stable-tool-preview-rendering.md topics.md packages/client/src/lib/storageKeys.ts packages/client/src/hooks/useStableToolPreviewRendering.ts packages/client/src/pages/settings/AppearanceSettings.tsx packages/client/src/i18n/en.json packages/client/src/components/blocks/ToolCallRow.tsx packages/client/src/components/blocks/__tests__/ToolCallRow.test.tsx`

Verification after making stable rendering the default:

- `pnpm --filter @yep-anywhere/client test -- src/components/blocks/__tests__/ToolCallRow.test.tsx`
- `pnpm --filter @yep-anywhere/client exec tsc --noEmit`
- `pnpm exec biome check docs/tactical/008-stable-tool-preview-rendering.md packages/client/src/hooks/useStableToolPreviewRendering.ts packages/client/src/components/blocks/__tests__/ToolCallRow.test.tsx packages/client/src/i18n/en.json`

## Follow-Up Options

- Consider surfacing the setting near session controls in addition to
  Appearance if users need a faster way to opt out for extremely large sessions.
- Keep any future optimization below the layout-bearing row boundary: defer
  secondary decoration where possible, but avoid inserting or removing large row
  content while the user scrolls.
