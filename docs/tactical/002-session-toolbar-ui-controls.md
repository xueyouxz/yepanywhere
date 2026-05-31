# Session Toolbar UI Controls

Status: In Progress

Progress:

- [x] 2026-05-31: Added `UI_KEYS.sessionToolbarVisibility` and a defensive
  localStorage-backed visibility hook with same-tab updates.
- [x] 2026-05-31: Added Appearance settings for Session Toolbar visibility,
  including a compact hand-rolled preview and reset action. The preview is now
  considered a stopgap because it does not share ordering/layout with the real
  composer toolbar.
- [x] 2026-05-31: Wired low-risk toolbar chrome to the visibility model:
  slash menu, model indicator, microphone/speech selector, context usage,
  `/btw`, nudge, queue buttons/toggle, and session status chips.
- [x] 2026-05-31: Refactored the session toolbar into a smart wrapper plus
  `MessageInputToolbarView`, then replaced the hand-rolled Appearance preview
  with an inert `SessionToolbarPreview` using mock toolbar data.

## Context

Session toolbar controls have accumulated organically: slash command access,
voice input, context usage, `/btw`, nudge, liveness/status, and queued-message
controls all compete for space in the primary composer toolbar.

Some of these features are valuable but not universally wanted in the primary
toolbar. They are less intrusive when kept in the session `...` menu, where
they remain discoverable without consuming composer space.

This is a UI customization problem, not a server behavior or feature-security
problem. Hiding a toolbar affordance should generally not disable the
underlying capability.

## Decisions

- Store session toolbar visibility in browser localStorage, not server
  settings.
- Treat toolbar visibility as per-browser UI chrome:
  - desktop and phone can diverge;
  - different browser profiles can diverge;
  - remote users connecting to the same Yep server do not share the preference.
- Keep behavior/configuration settings on the server when they affect server
  behavior or shared policy. Examples:
  - global nudge defaults;
  - public share enablement and viewer URL;
  - relay/Remote Access config.
- Keep session `...` menu entries available for features whose toolbar button
  is hidden, unless a later setting explicitly disables the feature itself.
- First slice should hide only low-risk visible toolbar chrome. It should not
  change message delivery semantics.
- The Appearance preview should not duplicate the toolbar UI by hand. It should
  instantiate the same pure render component used by the real session composer,
  with mock data and inert callbacks.

## Planned Toolbar Visibility Keys

- Slash menu.
- Model indicator.
- Microphone and speech-method selector.
- Context usage.
- `/btw` toolbar button.
- Nudge toolbar button.
- Queue buttons and queue-mode toggle.
- Session status/liveness chips.

## Non-Goals

- Do not disable slash command parsing when the slash menu is hidden.
- Do not disable `/btw` command handling when the `/btw` button is hidden.
- Do not disable nudge behavior or hide the session `... -> Nudge...` entry
  when the nudge toolbar button is hidden.
- Do not change server-side heartbeat/nudge scheduling in this pass.
- Do not move global nudge defaults out of Agent Context in the first slice.

## Tactical Work

### 1. Local Visibility Model

- Add a `UI_KEYS.sessionToolbarVisibility` localStorage key.
- Add a focused hook that:
  - loads defaults when no preference exists;
  - validates stored JSON defensively;
  - exposes per-control updates;
  - syncs same-tab consumers through a small external store.
- Default every toolbar control to visible for backward compatibility.

### 2. Appearance Settings UI

- Add a Session Toolbar subsection to Appearance.
- Show a preview that reflects the current visibility toggles and matches the
  real toolbar ordering and grouping:
  - left cluster: mode, attach, slash, thinking, render mode, nudge,
    speech/microphone, model indicator;
  - status cluster: liveness / last activity;
  - right cluster: shortcuts help, context usage, `/btw`, stop/queue/send.
- Add toggles for each planned visibility key.
- Add a reset-to-defaults action.
- Keep copy clear that these settings affect toolbar visibility only.
- Replace the current chip-based preview with the real toolbar render path.

### 3. Toolbar Wiring

- Read the visibility hook inside `MessageInputToolbar` so both the normal
  composer toolbar and approval toolbar use the same preference.
- Hide low-risk chrome based on the visibility model:
  - slash menu;
  - model indicator;
  - microphone and speech-method selector;
  - context usage;
  - `/btw` button;
  - nudge button;
  - session status/liveness chips;
  - secondary queue buttons/toggle.
- Keep primary send/steer/queue behavior intact.

### 4. Pure Render Toolbar Refactor

`MessageInputToolbar` is currently both a smart component and the render view.
It reads live hooks/state (`useModelSettings`, `useVersion`,
`useSessionToolbarVisibility`, render-mode context, relative time), performs
layout measurements, and renders controls that can mutate real settings or open
menus.

Refactor it into:

- `MessageInputToolbar` smart wrapper:
  - keeps existing public props;
  - reads hooks and live session/application state;
  - computes model label/density, voice availability, liveness/status display,
    queue labels, and visibility;
  - passes a fully materialized view model to the pure view.
- `MessageInputToolbarView` pure render component:
  - takes a toolbar view model and inert callbacks;
  - does not call app hooks;
  - does not fetch server version;
  - does not touch localStorage;
  - does not start speech recognition;
  - renders the actual toolbar DOM ordering and CSS classes.
- `SessionToolbarPreview` settings component:
  - builds mock view-model data;
  - uses current toolbar visibility;
  - renders `MessageInputToolbarView` inside an inert preview wrapper;
  - prevents real side effects by passing no-op callbacks and disabling
    dropdown/portal behavior where needed.

Implementation notes:

- Split live controls that have internal side effects into view-friendly modes:
  - slash command button should support a disabled/inert preview state, or the
    pure view can render the same button shell without opening a portal;
  - voice button should not mount `VoiceInputButton` in preview because it
    touches speech-recognition hooks;
  - model indicator density measurement can remain in the smart wrapper or be
    disabled/fixed in preview;
  - render-mode and nudge controls should receive no-op callbacks in preview.
- Keep the real session composer unchanged behaviorally after the refactor.
- Prefer a view-model shape that keeps future toolbar controls easy to add
  without re-creating the preview by hand.

Current state:

- `MessageInputToolbarView` now owns the toolbar DOM order and CSS classes.
- The live `MessageInputToolbar` wrapper still owns app hooks, layout
  measurement, liveness derivation, model-density selection, and real action
  callbacks.
- `SessionToolbarPreview` renders the same view with mock state and no-op
  callbacks inside an inert preview wrapper.
- The preview intentionally uses a microphone button shell instead of mounting
  `VoiceInputButton`, so it does not initialize speech-recognition hooks.

### 5. Follow-On Behavior Choices

- Decide whether "disable queued message input" should be a separate behavior
  setting rather than a toolbar visibility setting.
- Decide whether global nudge defaults should move out of Agent Context into a
  more appropriate settings category.
- Consider a separate per-device compact-toolbar preset for phones.

## Verification Checklist

- Toolbar controls default to visible in a fresh browser profile.
- Appearance settings toggles persist after reload.
- Toggling a control updates the real-component preview and the session
  toolbar.
- The preview uses the same ordering and primary CSS classes as the real
  composer toolbar.
- Interacting with the preview cannot open real menus, start voice input,
  change model/thinking settings, queue messages, or mutate session nudge state.
- Hidden nudge toolbar control does not remove the session `... -> Nudge...`
  menu entry.
- Hidden `/btw` toolbar control does not remove typed `/btw` command handling.
- Hidden queue controls do not alter server queue APIs or existing keyboard
  shortcuts.

Latest verification:

- `node scripts/biome.cjs lint ...` on `MessageInputToolbar.tsx`,
  `SessionToolbarPreview.tsx`, `AppearanceSettings.tsx`, and
  `useSessionToolbarVisibility.ts`.
- `pnpm --filter @yep-anywhere/client build`
- `pnpm --filter @yep-anywhere/client test -- src/components/__tests__/MessageInput.test.tsx`
- Playwright smoke check against `http://localhost:3402/settings/appearance`
  confirmed the preview renders `.message-input-toolbar` with the expected
  control order, and that toggling Slash Menu hides/restores the preview slash
  button.
