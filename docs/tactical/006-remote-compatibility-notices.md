# Remote Compatibility Notices

Status: Initial client slice implemented

Progress:

- [x] 2026-06-01: Captured the design direction for durable hosted remote
  compatibility notices, including the existing relay resume protocol cutoff
  and the upcoming backend/API update-recommended banner.
- [x] 2026-06-01: Added the pure notice engine, browser-local dismissal hook,
  remote notice banner, and replacement for the old relay resume modal.
- [x] 2026-06-01: Verified the focused notice tests and client typecheck.
- [x] 2026-06-01: Added host update guidance with visible versions, npm/source
  commands, and explicit server install-source metadata.

## Context

The hosted remote client can move faster than servers installed on user
machines. Most remote changes should remain backward compatible, but releases
that change backend APIs, remote transport semantics, or relay security posture
need a visible, dismissible notice so users understand when updating the local
server is recommended or required.

There are already several related user-facing prompts:

- the onboarding modal in the local app;
- the Codex CLI update prompt, which can update npm-global Codex installs;
- the existing relay session-resume protocol cutoff in `RemoteApp`;
- dev reload banners;
- Settings -> About version/update state.

These should not grow as independent one-off modals. A single compatibility
notice model should decide what to show, how severe it is, and when a user has
already dismissed it.

This is specifically about the hosted remote UI after a secure connection is
established. The relay remains a dumb encrypted pipe and should not inspect or
enforce application-level notice policy.

## Existing Signals

The server already exposes enough metadata for a first slice through
`GET /api/version`:

- `current`
- `latest`
- `updateAvailable`
- `resumeProtocolVersion`
- `capabilities`
- `installSource`

The relay registration path also reports optional compatibility metadata for
observability:

- `appVersion`
- `resumeProtocolVersion`
- `renderProtocolVersion`
- `capabilities`

The relay resume cutoff now checks `resumeProtocolVersion < 3`. Protocol 2
covered the security hardening released in `v0.4.0`, whose changelog includes:

- "Harden session resume replay defenses for untrusted relays"
- "Harden relay replay protection for SRP sessions"

Protocol 3 adds mutual resume server proof so a compromised relay cannot pair a
saved-session client with an impostor YA server that merely accepts the
client's proof. The hosted client now requires this protocol for relay Remote
Access; old YA servers can still be reached directly over localhost, a tunnel,
or a VPN. Compatibility reporting to the relay itself landed later in `v0.4.11`,
but the user-facing cutoff notice should still treat `<0.4.0` as the durable
version fallback when protocol metadata is absent.

## Goals

- Keep compatibility notices durable and data-driven instead of scattering
  hard-coded UI checks through `RemoteApp`.
- Preserve hosted remote access whenever basic usage still works.
- Allow multiple notices to coexist with explicit severity and stable IDs.
- Make dismissal stable per host/install/version/notice so a dismissed old
  warning does not suppress a future warning.
- Keep old warnings in code indefinitely when they document meaningful
  compatibility history.
- Leave room for server-provided notices from the update service later without
  requiring that infrastructure for the next release.

## Non-Goals

- Do not block hosted remote login for the upcoming update-recommended release.
- Do not move compatibility policy into the public relay.
- Do not auto-update Yep Anywhere from the phone in the first slice.
- Do not infer or shell out to package managers for Yep Anywhere updates in the
  first slice.
- Do not change the Codex CLI update flow, except for any later shared prompt
  coordination work.

## Notice Model

Add a pure function that converts server metadata into remote UI notices.

Conceptual shape:

```ts
type RemoteNoticeSeverity = "info" | "recommended" | "security" | "blocking";

interface RemoteCompatibilityNotice {
  id: string;
  severity: RemoteNoticeSeverity;
  title: string;
  body: string;
  action?: {
    label: string;
    command?: string;
    href?: string;
  };
  dismissKey: string;
}

interface RemoteCompatibilityInput {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  resumeProtocolVersion?: number;
  capabilities?: string[];
  relayUsername?: string | null;
  installId?: string | null;
}
```

The function should be deterministic and side-effect free:

```ts
getRemoteCompatibilityNotices(input): RemoteCompatibilityNotice[]
```

Severity meanings:

- `info`: non-urgent feature/capability gap.
- `recommended`: update recommended, but basic remote use remains broadly
  compatible.
- `security`: security or authentication hardening is missing; usage may
  continue, but the user should update.
- `blocking`: deliberate deprecation/cutoff where the hosted client cannot
  safely continue.

## Initial Notice Rules

### 1. Relay Resume Protocol Cutoff Notice

Show a `blocking` notice when either condition is true:

- `resumeProtocolVersion` is known and is lower than `3`;
- `resumeProtocolVersion` is absent and `currentVersion` is a comparable
  semver lower than `0.4.0`.

Suggested copy:

- Title: `Server update required`
- Body: `This hosted client requires current relay session-resume server
  verification. Update the local server, or use localhost, a tunnel, or a VPN
  with the old server.`
- Action command: `npm update -g yepanywhere`

This replaces the current `RemoteApp` modal check. It should be rendered as a
high-severity banner or notice, not as a blocking dialog.

### 2. Upcoming Backend/API Compatibility Notice

Show a `recommended` notice for the upcoming release when:

- the connection is through relay;
- the server version is below the chosen release baseline;
- basic compatibility is expected to continue;
- the notice has not been dismissed for that server/version.

The exact baseline should be set when the release version is chosen, for
example `0.4.29`.

Suggested copy:

- Title: `Update recommended`
- Body: `This hosted client includes backend/API compatibility changes. Basic
  remote use should still work, but updating the local server is recommended
  for this release.`
- Action command: `npm update -g yepanywhere`

If `currentVersion` is unknown or not comparable, avoid overclaiming. At most,
show a generic `recommended` notice when `updateAvailable` is true and
`latestVersion` is known.

### 3. Generic Update Available Notice

Optionally show a lower priority `recommended` notice when:

- `updateAvailable` is true;
- no more specific notice already covers the same update;
- the connection is through hosted remote.

This should not duplicate the release-specific backend/API notice. Prefer the
more specific notice when both match.

## Version And Metadata Policy

Prefer semantic metadata over version checks when metadata directly expresses
the compatibility concern:

- `resumeProtocolVersion` is the primary signal for the relay resume protocol
  cutoff notice.
- version `<0.4.0` is the fallback for servers that do not report the protocol.
- future render/client contract checks should prefer `renderProtocolVersion`
  once it exists.
- `capabilities` are useful for feature-level notice copy, but they should not
  be the only basis for a hard cutoff.

Use versions for release-specific guidance:

- known security baseline releases;
- known recommended-update releases;
- generic current/latest update state.

Do not treat dev/git versions as older unless they can be safely compared. For
`git describe`-style versions such as `0.4.0-3-gabcdef`, compare them as newer
than their base tag and still avoid npm-specific update actions.

Prefer explicit `installSource` metadata for update instructions:

- `npm-global`: tell the user to run `npm update -g yepanywhere`, then restart.
- `source`: tell the user to merge `origin/main`, run `pnpm install` and
  `pnpm build`, then restart.
- `release-package` or `unknown`: avoid claiming the package manager; show the
  npm command only as an npm-global example.

Older servers do not report `installSource`. Treat the missing field as
`unknown`, except that existing `git describe` versions such as
`0.4.28-6-g1ccc58f4` are a reliable source-checkout fallback.

## Dismissal

Dismissal should be browser-local and scoped narrowly enough that future
warnings can still appear.

Recommended key components:

- server install id when available;
- relay username as a fallback when install id is unavailable;
- notice id;
- current server version or protocol value that triggered the notice.

Example key shape:

```ts
remote-notice-dismissed:${installIdOrRelayUser}:${notice.id}:${versionOrState}
```

Dismissal behavior:

- dismissing the cutoff notice for `0.3.9` should not dismiss it for a
  different host;
- upgrading to `0.4.0+` should naturally remove the notice;
- a future notice with a different `id` should appear even if an older notice
  was dismissed;
- storage failures should be non-fatal and may cause notices to reappear.

## UI Placement

Create one `RemoteCompatibilityNotices` component rendered from connected
remote app content after authentication.

Suggested behavior:

- only render for relay-hosted connections initially;
- sort notices by severity;
- show one visible notice at a time at the top of the app, or stack compact
  banners if the design remains clean;
- never stack a notice modal on top of login, reconnect, or host-offline
  states;
- keep actions small: `Dismiss`, `Copy command`, and optionally `Settings`.

Prompt priority should be:

1. Login/reconnect/host-offline states.
2. Existing local onboarding modal, local app only.
3. Existing Codex update modal, local app only.
4. Remote compatibility notices after remote connection.
5. Dev reload banners.

The first implementation can keep local onboarding/Codex coordination as-is
and focus on remote compatibility notices.

## Tactical Work

### 1. Pure Notice Engine

- Add a small client module for remote compatibility notice derivation.
- Include semver comparison helpers or reuse an existing client-safe helper if
  one exists.
- Encode the initial notice rules:
  - relay resume protocol cutoff, protocol first and `<0.4.0` fallback;
  - upcoming backend/API recommended update baseline;
  - optional generic update-available fallback.
- Add focused unit tests for:
  - `resumeProtocolVersion < 3`;
  - missing protocol plus version `<0.4.0`;
  - version `0.4.0+` suppresses the cutoff notice;
  - unknown/dev versions avoid unsafe old-version claims;
  - release-specific recommended notice;
  - duplicate generic notice suppression.

### 2. Dismissal Hook

- Add a tiny localStorage-backed hook for dismissed remote notices.
- Scope keys by install id when available, then relay username fallback.
- Keep storage parse/write errors non-fatal.
- Add unit tests for dismissal keys and version-sensitive reappearance.

### 3. Remote UI Component

- Add `RemoteCompatibilityNotices`.
- Render it from connected remote app content.
- Replace the current `resumeProtocolVersion < 3` modal with the notice
  engine.
- Use existing banner/modal styling primitives where possible.
- Ensure text fits on mobile and actions wrap cleanly.

### 4. About Settings Visibility

- Optionally surface the same highest-severity remote notice in Settings ->
  About, near the existing server/client version display.
- Avoid duplicating copy by using the same notice engine.
- Keep the existing manual update check button.

### 5. Future Update-Service Notices

- Later, extend `/api/version` to include structured server/update-service
  notices if release policy needs to change without rebuilding the hosted
  remote client.
- Keep client-bundled notice rules for historical security baselines that
  should remain durable forever.
- Treat server-provided notices as additive and validated, not as arbitrary
  HTML.

## Verification Checklist

- A relay-connected server with `resumeProtocolVersion: 2` shows one
  `blocking` notice.
- A relay-connected server with no `resumeProtocolVersion` and version
  `0.3.9` shows the relay resume protocol cutoff notice.
- A relay-connected server with version `0.4.0` does not show the cutoff
  notice from version fallback alone.
- A server below the release compatibility baseline shows the
  update-recommended notice.
- Dismissing one notice hides only that notice for that host and triggering
  version/state.
- Reconnecting to another relay username or install id re-evaluates notices.
- Local direct app behavior is unchanged.
- Codex update prompt behavior is unchanged.
- Remote login, reconnect, and host-offline flows do not show stacked
  compatibility modals.
