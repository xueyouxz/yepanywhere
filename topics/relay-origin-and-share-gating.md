# Relay Origin And Share Gating

> Public share and relay-origin rules keep hosted links, relay transport, and
> secret-bearing read-only access explicit about who can fetch what and who can
> observe it.

Topic: relay-origin-and-share-gating

## Public Share Authorization

Public shares are bearer-link read-only views. The server generates at least a
512-bit URL secret, stores only a hash of that secret, and exposes no public
lookup route by project id, session id, or sequential share id. This blocks
guessing from no link.

Anyone who possesses the full public share URL can fetch the share until it is
revoked or, for live shares, until the owner stops live access. That includes a
party who observes the public share secret in transit through an authorized
public-share transport.

## Relay Operator Visibility

Normal authenticated Remote Access uses SRP plus NaCl end-to-end encryption.
For that mode, the relay should see connection metadata such as username,
timing, and sizes, but not decrypted application contents.

Public shares are currently a deliberate exception. The hosted public viewer
opens a relay WebSocket and sends unauthenticated, share-secret-bearing
`GET /public-api/shares/:secret...` requests as plaintext relay payloads. WSS
protects the browser-to-relay hop from ordinary network observers, and the
current relay implementation forwards frames rather than logging share payloads,
but a relay operator who inspects or modifies the relay can see the public share
request path, bearer secret, and response contents.

Therefore public shares are secret-link protected against guessing and against
viewers who do not possess the link, but they are not currently private from the
relay operator. User-facing security claims must not describe public shares as
relay-operator-private until a public-share E2E design lands.

## Public File Views

Public-share file views may use a dedicated unauthenticated top-level route so
the read-only trust boundary remains explicit. Inside that boundary, shared UI
code should still carry the normal file-viewer shell, spacing, rendered
Markdown behavior, local-media modal, copy affordances, and line/source toggle
behavior where those affordances are read-only.

The same architecture rule applies to the public session viewport: an
independent unauthenticated shell can be safer, but transcript rows, rendered
item flow, inspection affordances, copy interactions, spacing, and other
read-only UI behavior should stay shared with the normal session surface where
the trust boundary permits it.

Share-scoped file requests are allowed only for files visible from shared
session content and for bounded transitive render assets from visible
Markdown/HTML sources. Frozen snapshot shares should eventually capture an
immutable manifest of linked files and render assets; live shares may refresh
that manifest only from deliberate share-visible content.

## Future E2E Direction

A relay-operator-private public share design needs encryption before relay
payloads are produced. Plausible shapes include a fragment-held public-share
decryption key, encrypted request/response envelopes for the public share API,
opaque manifest asset ids instead of raw paths, and snapshot assets encrypted at
capture time. The browser fragment can keep secrets out of HTTP requests, but
the design still has to account for hosted JavaScript integrity and revocation.
