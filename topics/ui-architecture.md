# UI Architecture

> UI architecture keeps shared rendering, layout, and interaction behavior
> attached to the data or render boundary that produces it, rather than patching
> generated DOM after the fact.

Topic: ui-architecture

## Render Boundary Principle

When two views present the same model data, prefer to share the component,
renderer, or source adapter that creates the UI state. Do not satisfy a view
request by adding a custom click interceptor that inspects already-rendered DOM
and rewrites destinations as a primary design; that creates view-specific
spaghetti and prevents other views of the same data from inheriting the fix.

Preferred order:

1. Amend the data/model/render generator so the current UI state is produced in
   the right shape for all callers that should share the behavior.
2. Add an explicit view-bound adapter near the origin when only one context
   should differ, such as public-share snapshot/live file links.
3. Add a default-preserving parameter when other callers need the old behavior.
4. Use post-render rewriting only as a small containment bridge, with the rule
   named and scoped so it cannot silently become the architecture.

## Public Share Example

Public shares have a valid reason for an independent unauthenticated top-level
page: the route is a read-only bearer-link trust boundary. That does not justify
forking the normal session/file presentation stack. The public route should feed
share-scoped loaders and link transforms into shared viewers, transcript rows,
media affordances, copy UI, spacing, and inspection behavior whenever those
affordances remain read-only.

Dynamic-scope or explicit snapshot/live link adaptation is acceptable for public
shares when the adaptation is attached to the shared rendering context or file
viewer source. It is not a license for arbitrary `onclick` URL surgery after
the UI has already been generated.

## Settings Pane Conventions

Settings panes apply changes immediately on interaction — the house style
for toggles, sliders, and selects (Notifications, Model, Appearance,
Development). A deferred Save/`hasChanges` flow is acceptable only for
free-text panes where partial input should not hit the server (Agent
Context, Lifecycle Webhooks, Providers, Local Access); continuous controls
like sliders debounce their saves rather than deferring them.

The per-pane undo affordance has a single implementation and a single
location: panes register their open-time snapshot revert via
`useSettingsUndo` (`pages/settings/SettingsUndoContext.tsx`), and
`SettingsLayout` renders the one Undo button top-right on the header row —
never inside scrollable pane content. A pane that adopts immediate apply
should register undo so accidental changes stay recoverable.
