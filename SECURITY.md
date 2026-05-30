# Security

Yep Anywhere is a single-user, self-hosted remote UI for local agent
processes. It can expose shell, file, and tool-approval capabilities of the
underlying provider CLIs, so deployments should treat the server as sensitive
developer infrastructure.

This document describes security features that are present in upstream
`kzahel/main`.

## Default Exposure

- The server binds to `127.0.0.1` by default.
- Remote access is opt-in. When enabled, remote clients authenticate through
  the SRP-based secure WebSocket transport described below.
- Debug or recovery settings such as `AUTH_DISABLED=true` and
  `ALLOWED_HOSTS=*` intentionally reduce protection and should be used only in
  controlled environments.

## HTTP API Protections

- API requests pass through Host validation unless `ALLOWED_HOSTS=*` is set.
- CORS allows only configured/recognized origins and sends credentials only
  for accepted origins.
- Mutating API requests require the `X-Yep-Anywhere: true` header, adding a
  simple CSRF barrier for browser-originated forms and simple requests.

## Local Password Auth

- Optional local password auth uses bcrypt password hashes.
- Browser sessions use high-entropy server-generated session IDs stored in
  HTTP-only cookies with `SameSite=Lax`; cookies are marked `Secure` when the
  request is HTTPS.
- Auth state is stored in `auth.json`; on POSIX platforms the server attempts
  to enforce owner read/write-only file permissions.
- A desktop auth token can act as an additional local app auth path when the
  desktop integration provides one.

## Remote Access Transport

- Remote access uses SRP-6a so the password is not sent to the server or relay.
- The server stores SRP verifier material, not the plaintext remote-access
  password.
- After SRP succeeds, client/server traffic is encrypted with NaCl secretbox
  using keys derived from the SRP session key.
- Relay mode forwards opaque SRP and encrypted traffic; the relay is not meant
  to read application payloads.
- SRP handshakes include per-connection and per-username throttling plus a
  handshake timeout.

## Rendered Content

- Server-rendered markdown disables raw HTML passthrough and sanitizes output
  through an allowlist of tags, attributes, and URL schemes.
- Markdown links and images are limited to supported URL schemes; local media
  links are rewritten through a server endpoint rather than exposed directly as
  arbitrary browser URLs.
- KaTeX rendering is configured with `trust: false`.

## Local Media and Static Files

- Local media serving is restricted to configured allowed path prefixes and
  recognized media extensions, and resolves symlinks before checking the
  allowed prefixes.
- Production static HTML responses include a `frame-ancestors` Content Security
  Policy for the web app and supported desktop origins.

## Reporting

For suspected vulnerabilities, avoid public issues that include exploit details
until a fix or mitigation is available upstream. Prefer a private maintainer
channel first, then publish a minimal public summary after the fix is merged.
