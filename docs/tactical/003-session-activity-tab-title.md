# Session Activity Tab Title Indicator

Status: Implemented

Progress:

- [x] 2026-05-31: Captured the agreed tactical plan. No client
  implementation has been started.
- [x] 2026-05-31: Added browser-local tab-title activity preference keys,
  a defensive `useTabTitleActivityPreference` hook, same-tab update
  publication, and focused persistence/default tests.
- [x] 2026-05-31: Added Appearance settings UI and English i18n strings for
  enabling the tab-title activity indicator and choosing focused-session vs.
  all-session scope.
- [x] 2026-05-31: Wired all-session scope into the existing tab-title badge
  hook using `InboxContext.totalActive`, with animation and focused tests.
- [x] 2026-05-31: Switched activity frames to same-family circle glyphs
  and made the animation cadence an explicit 1500 ms constant.
- [x] 2026-05-31: Removed the focused-session/all-session selector. The
  remaining toggle now means all-session activity.

## Context

Browser tabs currently show the base page title through
`packages/client/src/hooks/useDocumentTitle.ts`, and the global needs-attention
count is layered on top by `packages/client/src/hooks/useNeedsAttentionBadge.ts`.

Users who keep several Yep Anywhere tabs open need a lightweight way to notice
that a session is actively working or thinking without switching back to the
tab. The desired indicator is opt-in UI chrome, not a change to session
behavior.

The requested setting is:

- Show session activity in tab title.

## Decisions

- Store this as a browser-local Appearance preference, not a server setting.
- Default the feature off.
- When enabled, show activity if any session is actively working.
- Treat "activity" as active agent work, specifically `in-turn`.
- Do not show the activity indicator for:
  - `idle`;
  - `waiting-input`;
  - `hold`;
  - pending approvals or questions.
- Use a quiet two-frame indicator with same-family circle glyphs:
  - `(●) Project - Session`
  - `(○) Project - Session`
- Prefer the existing needs-attention count first, then the activity indicator:
  - `(2) (●) Project - Session`
- Compose tab-title prefixes from one place instead of adding another
  independent `document.title` mutator.
- Use global active session state already maintained by the client
  inbox/activity paths rather than adding a new polling loop.

## Non-Goals

- Do not change server session lifecycle, process ownership, or activity
  semantics.
- Do not add server-side timers, watchers, or polling for this feature.
- Do not animate the favicon in this pass.
- Do not expose this as a shared server policy. Different browsers and devices
  may choose different tab-title behavior.
- Do not implement focused-session-only scope in this pass. The setting is now
  intentionally a single all-session toggle.
- Do not treat waiting-for-input as working activity. Existing badges and
  notifications already cover attention-needed state.

## Tactical Work

### 1. Local Preference Model

- Add a localStorage key under `UI_KEYS`:
  - `tabTitleActivityEnabled`.
- Add a defensive hook such as `useTabTitleActivityPreference()` that:
  - loads default settings when no stored value exists;
  - persists updates;
  - can be used by Appearance settings and the title indicator hook.
- Consider same-tab synchronization only if multiple mounted consumers need it.
  If the preference is read only by settings plus one app-shell hook, simple
  React state is sufficient for the first slice.

### 2. Appearance Settings UI

- Add a settings item to `AppearanceSettings`:
  - title: "Show session activity in tab title";
  - description: mention that it animates the browser tab title while sessions
    are working.
- Use a checkbox/toggle for enablement.
- Keep the setting in Appearance because it affects local UI chrome only.
- Add i18n keys to the English catalog. For sparse locale files, only add
  non-English translations where an actual translation is available; otherwise
  rely on English fallback.

### 3. Single Title Composition Path

- Replace competing title prefix writers with a shared composition path.
- Keep `useDocumentTitle` responsible for computing or setting the sanitized
  base title, but avoid letting each indicator mutate `document.title`
  independently.
- One practical shape:
  - introduce a small title indicator provider/store in the app shell;
  - `useDocumentTitle` updates the base title;
  - needs-attention and activity update indicator state;
  - one effect writes the composed title.
- Alternative smaller first slice:
  - refactor `useNeedsAttentionBadge` into a generalized
    `useTabTitleIndicators` hook;
  - make it strip and reapply both known prefixes using one regex.
- The final composed order should be stable:
  - needs-attention count;
  - activity frame;
  - base title.

### 4. Focused-Session Activity Source

- Deferred. If reintroduced, derive focused-session activity from existing
  `SessionPage` state:
  - mother session activity: `processState === "in-turn"`;
  - focused `/btw` aside activity: focused aside status is `starting` or
    `running`.
- Register that boolean with the app-level title indicator source while the
  session page is mounted.
- Clean up the registration on unmount and when navigating between sessions.
- Do not use terminal pending tool rows as title activity; the planning
  decision is to show active work, not unresolved historical pending state.

### 5. Activity Source

- Prefer `InboxContext.totalActive > 0` for activity. The inbox active tier
  already tracks `in-turn` sessions from process-state changes.
- Avoid introducing a duplicate REST fetch loop like
  `useGlobalActiveAgents()` unless the inbox context proves insufficient.
- Ensure remote mode behaves the same as local mode by using the same app-shell
  context path used by `App` and `RemoteApp`.

### 6. Animation Lifecycle

- Start a `setInterval` only when all of these are true:
  - setting is enabled;
  - any session currently has activity;
  - the app shell is mounted.
- Clear the interval when activity stops, the setting is disabled, or the
  component unmounts.
- Use a 1500 ms cadence.
- Reset to the non-activity composed title immediately when activity stops.
- Keep the two frames to the same visible shape family: `(●)` and `(○)`.

### 7. Tests

- Add focused unit tests around the title composition helper:
  - no indicators;
  - needs-attention only;
  - activity only;
  - both prefixes in stable order;
  - stripping stale prefixes before recomposing.
- Add a hook/component test for animation lifecycle with fake timers:
  - interval starts only while enabled and active;
  - frame flips after 1500 ms;
  - interval is cleared when disabled or inactive.
- Add preference tests:
  - defaults are off;
  - settings persist.

## Open Questions

- Should the activity indicator keep animating while the browser tab is
  focused, or only when the tab is backgrounded? The current plan animates
  whenever the setting is enabled and matching activity exists.
- Should activity include only unarchived active sessions? Using the inbox
  active tier implies yes.
- Should externally owned active sessions count? The inbox active tier
  currently reflects server-known in-turn activity; keep that behavior unless a
  specific external-session mismatch is found.
- Should the settings copy say "working" or "thinking"? The implementation
  should use `in-turn`; the user-facing wording can stay "working" to include
  tool-running phases.

## Suggested Implementation Order

1. Add local preference keys and hook.
2. Add Appearance settings UI and English i18n keys.
3. Extract pure title composition helpers and tests.
4. Refactor needs-attention title badge into the shared composer.
5. Feed activity from `InboxContext.totalActive`.
6. Add animation lifecycle tests with fake timers.
7. Run focused client tests, then `pnpm typecheck`.

## Verification Checklist

- Fresh browser profiles do not show activity in the tab title.
- Enabling the setting starts showing `(●)` / `(○)` only during active work.
- The tab title shows activity when any active session is working.
- Pending approvals/questions still use the existing needs-attention badge and
  do not trigger the activity spinner by themselves.
- Existing needs-attention title counts still work and compose with the new
  activity indicator as `(N) (●) Title`.
- Timers are cleaned up after disabling the feature, navigating away from a
  session, or unmounting the app.
- Remote client routes behave consistently with local routes.
