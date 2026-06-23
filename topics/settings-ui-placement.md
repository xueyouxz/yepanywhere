# Where settings / UI options live

Topic: settings-ui-placement

Status: contract note. Two questions for any new user-facing option: **which
category** it appears under, and **which persistence mechanism** backs it. This
captures the precedents so new options land consistently instead of wherever
the nearest code happened to be.

See also:
[vanilla-defaults](vanilla-defaults.md) (novel user-visible behavior ships
configurable + default-off — governs whether an option is even default-on),
[fork-from-turn](fork-from-turn.md) (the worked example below: fork-after-summary
auto-open).

## Persistence mechanisms (pick one deliberately)

YA has three, and the choice is about *scope of persistence*, not convenience:

1. **Client-local UI preference** — `localStorage` via a `UI_KEYS` entry
   (`lib/storageKeys.ts`) and a small hook returning `[value, setValue]`.
   Models: `useAttachmentUploadQuality`, `useOutputAppearance`. Use for a pure
   local view/UX preference that need not follow the user to another
   device/install (fonts, spacing, local rendering toggles).

2. **Server-scoped / per-install preference** — `useModelSettings`'s
   `getServerScoped("key")` / `setServerScoped` (keyed by `installId`). Model:
   `showThinking`. Use for a session-interaction preference that should persist
   per install and typically pairs with a **live in-session toggle** (the
   toolbar `showThinking` switch seeds from this default). The `UI_KEYS` entry
   names the key, but access goes through the server-scoped helpers, not raw
   `localStorage`.

3. **Server-persisted setting** — `useServerSettings` / `updateSetting`
   (`settings.*`). Model: `newSessionDefaults` (in `ModelSettings.tsx`). Use for
   config applied at session start that is genuinely server/session state
   (default model, permission mode, delivery windows) and must survive on the
   server.

Decision rule: pure local rendering/UX → (1). A per-install session preference,
especially one with a live override → (2). Session/server config that seeds new
sessions → (3).

## Categories (what each is *for*)

The category registry is `CATEGORY_COMPONENTS` in
`packages/client/src/pages/settings/SettingsLayout.tsx`; labels/descriptions come
from `getSettingsCategories` in `packages/client/src/i18n-settings.ts`. Current
inventory: `appearance`, `toolbar`, `model`, `message-delivery`,
`agent-context`, `notifications`, `webhooks`, `devices`, `local-access`,
`remote`, `providers`, `speech`, `remote-executors`, `emulator`, `environment`,
`about`, `development`.

Placement precedents (the load-bearing ones — choose by *what the user is
conceptually adjusting*, not where the code lives):

- **Appearance** — things you can **see at rest, without mouseover first**:
  visual rendering (fonts, spacing, and visibility toggles like show-thinking's
  display). `AppearanceSettings.tsx` / `useOutputAppearance`.
- **Toolbar** — which **commands / affordances** are shown in the toolbar.
  `ToolbarSettings.tsx`.
- **Model + new-session defaults / options** — things **set on session start**:
  default model, permission mode, thinking config, and UI elements that seed a
  new session. `ModelSettings.tsx` hosts `newSessionDefaults`; `showThinking`
  (server-scoped, with a live toolbar toggle) lives in this cluster via
  `useModelSettings`.

Introduce a **new category** only when a sizable cluster of options doesn't fit
an existing one; a single niche toggle joins the nearest existing category.

## The default + live-override pattern

A persistent default may be paired with an **ephemeral, in-context toggle** that
seeds from it. `showThinking` is the canonical case: a per-install default
(settings) plus a live toolbar switch for the current session. The override is
**not itself a setting** — it is transient session/job state. Reach for this
pattern when the user may want to flip the behavior for *this* session/action
without changing their standing default.

## Worked example: fork-after-summary auto-open

The fork-after-summary "open the forked session in a new tab when ready" option
(see [fork-from-turn](fork-from-turn.md)) is, in the project owner's words,
"analogous to show thinking, a little more niche." It therefore follows the
`showThinking` precedent rather than a bespoke mechanism:

- **Persistent default:** a server-scoped per-install preference in the
  model / new-session cluster (`useModelSettings`, surfaced under the
  new-session options in `ModelSettings.tsx`), **default-off** per
  [vanilla-defaults](vanilla-defaults.md). (A future dedicated "Sessions"
  category could absorb it if that cluster grows; not warranted for one toggle.)
- **Live per-fork override:** an ephemeral toggle on the `ForkSummaryIndicator`
  during the *generating* phase, seeded from the default. It is per-fork
  transient state, not a setting.
- **What the toggle does — and does not — control:** the forked session is
  created and *starts* (the summary is submitted as its first user turn) as soon
  as generation completes, unless canceled. The toggle gates only the
  client-side `window.open` to a new tab; the fork/session runs regardless, and
  the indicator's link is how the user reaches the already-running session.
  Because the auto-open decision is read at the *ready* transition (after a long
  await), read the live toggle value from a ref — like the abort ref — so a flip
  during generation is honored.
