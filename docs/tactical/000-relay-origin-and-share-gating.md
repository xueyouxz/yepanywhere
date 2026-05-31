# Relay Origin Restrictions And Share Gating

Status: In Progress

Progress:

- [x] 2026-05-31: Added relay allowed-origin parsing/matching and focused
  unit tests. The policy is loaded into relay config, but not enforced yet.
- [x] 2026-05-31: Enforced the relay allowed-origin policy for HTTP CORS and
  `/ws` upgrades. Disallowed browser websocket origins now receive 403 before
  `handleUpgrade`; disallowed HTTP origins receive no CORS allow-origin header.

## Context

The public relay exists to make Yep Anywhere usable for people who want
no-config / no-infra remote access from Yep Anywhere-controlled web origins,
not to provide a general-purpose public WebSocket relay for arbitrary domains.

Today, browser clients can open a WebSocket to `relay.yepanywhere.com/ws` from
origins such as `https://ya.graehl.org`. The relay currently accepts `/ws`
upgrades without checking the browser `Origin` header, and its HTTP endpoints
use permissive CORS. This is broader than the intended hosted-service boundary.

Public Read-Only Share also uses the configured remote relay, but it uses a
secret-link read path rather than the normal SRP/password-authenticated remote
login path. That feature should be explicitly opt-in before it is exposed in
the UI or usable through the server API. Its share contents are visible to the
relay because public-share reads are a plaintext relay exception, unlike the
normal encrypted Remote Access session.

The share viewer URL shape is still unsettled. The current GH Pages deployment
is somewhat janky for SPA routes because root `404.html` serves the remote app
for unknown paths while retaining an HTTP 404 status. That may explain why a
root path such as `/share/:secret` works today, but it should not be the
long-term contract for production routing.

## Decisions

- Restrict browser-originated relay access to Yep Anywhere-controlled origins.
- Allow `https://ya.graehl.org` during the current GH Pages hosted-share period.
- Allow `https://yepanywhere.com` and `https://*.yepanywhere.com`.
- Allow localhost development origins only through explicit relay config or dev
  defaults.
- Allow missing `Origin` on relay WebSocket upgrades so non-browser YA server,
  CLI, and native clients can still connect.
- Treat relay origin checking as browser abuse reduction, not authentication.
  The normal remote-login path must continue to rely on SRP + encrypted traffic.
- Gate Public Read-Only Share behind a persisted user setting that defaults off.
- Default Public Read-Only Share to the same relay configuration the user
  already configured for Remote Access.
- Keep the frontend share viewer URL configurable. It is currently GH Pages
  hosted via `ya.graehl.org`, but the expected steady state is under
  `yepanywhere.com` / `staging.yepanywhere.com`, likely either
  `/share/:secret` or `/remote/share/:secret`.

## Non-Goals

- Do not replace SRP or NaCl with origin checks.
- Do not make `Origin` a trusted identity signal. Non-browser clients can spoof
  it.
- Do not add a separate share-only relay registration path unless the shared
  Remote Access relay config proves insufficient.
- Do not redesign Public Read-Only Share encryption in this pass. Document the
  plaintext public-share relay exception clearly and gate it behind opt-in.

## Tactical Work

### 1. Relay Origin Policy

- Add relay config for allowed browser origins, likely
  `RELAY_ALLOWED_ORIGINS`.
- Support exact origins and wildcard subdomains, e.g.
  `https://*.yepanywhere.com`.
- Include production defaults for:
  - `https://yepanywhere.com`
  - `https://*.yepanywhere.com`
  - `https://ya.graehl.org`
- Decide whether localhost dev origins are built-in for `NODE_ENV !==
  "production"` or must be explicitly configured.
- Apply the policy to HTTP CORS responses for relay endpoints such as
  `/online/:username`.
- Apply the policy to `/ws` upgrade requests:
  - allow missing `Origin`;
  - reject present but disallowed browser origins before `handleUpgrade`;
  - log rejected origin and path at an appropriate rate.
- Add relay tests for:
  - allowed exact origin;
  - allowed wildcard subdomain;
  - allowed missing origin;
  - rejected random browser origin;
  - HTTP CORS behavior mirrors WebSocket origin policy.

### 2. Public Share Settings

- Add persisted server settings:
  - `publicSharesEnabled`, default `false`;
  - `publicShareViewerBaseUrl`, optional override for the viewer app base URL;
  - optional `publicShareAllowLive`, default `false` if live shares should be a
    second opt-in.
- Validate `publicShareViewerBaseUrl` as an HTTP(S) base URL. Allow a path
  prefix such as `/remote`, but reject query/hash components.
- Continue honoring `YEP_PUBLIC_SHARE_ORIGIN` as an environment override or
  bootstrap fallback for compatibility, but make the precedence explicit and
  consider renaming it to a base-URL variable.
- Enforce `publicSharesEnabled` server-side:
  - block `POST /api/public-shares`;
  - decide whether public reads for already-created links remain available or
    are disabled when the setting is off;
  - keep revocation/management endpoints usable so users can clean up existing
    links.
- Update API responses so the client can distinguish:
  - feature disabled;
  - relay not configured;
  - relay configured and shares enabled.
- Add tests for disabled-by-default behavior and configured behavior.

### 3. Share UI Gating

- Add an Advanced / Experimental settings section visible in normal builds.
- Add a Public Read-Only Share control with clear opt-in copy:
  - share viewers do not authenticate with the Remote Access password;
  - anyone with the secret link can read the shared session;
  - shared session contents are visible to the relay while being fetched;
  - frozen shares store a local sanitized snapshot;
  - live shares keep serving updates through the configured relay;
  - the share path is read-only but is not the same encrypted remote-login
    session.
- Hide session menu Share controls until the feature is enabled.
- Avoid running public-share status polling from the session page unless the
  feature is enabled or the session already has active shares that need
  management.
- Keep share management and revocation discoverable for sessions with existing
  shares, even if new share creation is disabled.
- Show the effective share frontend origin in settings and in the share modal.
- Avoid relying on GH Pages root `404.html` as the long-term direct-navigation
  mechanism for share links. The production route should return a normal 200
  response for the share viewer entry point once it is hosted under
  `yepanywhere.com`.

### 4. Nudge / Heartbeat UI Gating

- Add a user-facing setting for whether advanced heartbeat/nudge controls are
  visible.
- Default the controls hidden for new users.
- Keep existing session heartbeat settings honored by the server. Hiding the UI
  must not change the server-owned heartbeat scheduling contract.
- If a session already has heartbeat turns enabled, keep enough UI visible to
  turn it off or edit it.
- Move global heartbeat defaults out of prominent Agent Context settings or
  place them behind the same Advanced / Experimental visibility gate.

### 5. Documentation

- Update relay docs to say the public relay is intended for Yep
  Anywhere-controlled browser origins plus non-browser clients.
- Update remote-access docs to distinguish:
  - frontend web origins (`yepanywhere.com`, `ya.graehl.org`,
    `staging.yepanywhere.com`);
  - relay WebSocket origin (`relay.yepanywhere.com/ws`);
  - the user's YA server registered under a relay username.
- Update public-share docs/copy to call out that the feature reuses the
  configured Remote Access relay but does not use Remote Access password auth
  for viewers.

## Open Questions

- When `publicSharesEnabled` is turned off, should existing public share links
  stop resolving immediately, or should only new share creation be blocked?
- Should live public shares require a separate opt-in from frozen snapshot
  shares?
- Should `ya.graehl.org` remain in the production relay origin allowlist after
  share/login routes move under `yepanywhere.com`, or should it be a temporary
  compatibility entry with a removal target?
- Should the durable share route be `/share/:secret` at the site root or
  `/remote/share/:secret` inside the remote app basename? `/share` is cleaner
  for public links, but `/remote/share` fits the current remote-client build
  and avoids depending on the GH Pages root 404 fallback.
- Should localhost origins be allowed by default in packaged/dev relay builds,
  or always require explicit `RELAY_ALLOWED_ORIGINS`?
- Should relay origin rejections be exposed in relay telemetry, logs only, or
  both?

## Suggested Implementation Order

1. [x] Add and test relay origin parsing/matching.
2. [x] Enforce relay HTTP CORS and WebSocket upgrade origin checks.
3. Add server-side public-share settings and API enforcement.
4. Add Advanced / Experimental settings UI for public share opt-in and viewer
   origin.
5. Gate share controls and status polling in session UI.
6. Gate heartbeat/nudge controls behind the same advanced visibility model.
7. Update docs and user-facing copy.

## Verification Checklist

- A browser page on `https://evil.example` cannot open
  `wss://relay.yepanywhere.com/ws`.
- A browser page on `https://ya.graehl.org` can open the relay while it remains
  allowlisted.
- A browser page on `https://staging.yepanywhere.com` can open the relay when
  `*.yepanywhere.com` is allowlisted.
- A YA server connection with no browser `Origin` can still register with the
  relay.
- Public Read-Only Share is disabled by default in a fresh data dir.
- Share controls are hidden until the user enables the feature.
- Enabling Public Read-Only Share uses the existing Remote Access relay config
  by default.
- Existing active shares remain manageable and revocable.
