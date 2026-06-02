# Security
> Security is YA's trust-boundary contract: local authenticated controls may
> expose privileged host state, while public and relay surfaces must stay
> explicit, scoped, and revocable.

Topic: security

## Trust Boundaries

YA has several surfaces with different security expectations:

- Local and authenticated remote users operate the YA server and can already ask
  an agent to inspect project files. Local file viewing APIs may therefore serve
  project files broadly when they are behind the authenticated/local app path.
- Public read-only share viewers are unauthenticated third parties who only hold
  a secret link. They must not inherit local/authenticated file-serving power.
- Relay paths reduce deployment friction, but relay access is not identity by
  itself. Authentication, encryption, explicit opt-ins, and server-side gates
  remain the controlling security mechanisms.

## Public Share File Access

Public read-only shares may open project files through a share-scoped public
route when the requested path is visible from the shared session content. The
viewer must not navigate into `/api/local-file`, `/api/local-image`, or
`/projects/.../file` directly, because those routes are authenticated/local app
surfaces and cause public viewers to fall into Remote Access login.

The current lightweight route serves project files whose relative or
project-root-absolute path is present in the shared transcript. Public clients
rewrite rendered local/project file links to `/share/:secret/file`, which fetches
`/public-api/shares/:secret/files` through the same relay and secret used for
the public session body. For rendered Markdown/HTML documents that are already
visible from the transcript, the route may also serve bounded local media assets
referenced by that document so public preview images do not fall through to
login-gated local routes.

A stronger public-share file viewer should eventually expose only manifest
entries and render assets captured from shared content:

- A frozen snapshot share should persist an immutable manifest of linked files
  and required render assets at capture time, so later filesystem changes do not
  change what the link exposes. The current route still reads the live project
  file after checking transcript visibility.
- A live share may refresh its manifest only from transcript-visible links or
  other deliberate share content, not from arbitrary project paths supplied by
  the public viewer.
- The current transitive render-asset allowance is still computed live from the
  referenced Markdown/HTML source. A frozen manifest should eventually capture
  those image references at share creation time.
- Public endpoints should use opaque share asset identifiers or manifest
  entries, not raw absolute paths, project-relative paths, `..` traversal, or
  symlink-sensitive filesystem resolution requested by the browser.

The design point is intentionally narrower than "the user could ask the agent to
cat that file." That argument applies to the authenticated operator, not to an
unauthenticated public share recipient.

Until a full manifest exists, public-share viewers must not follow
local/authenticated file links into the normal app. A share-scoped relay request
is acceptable for transcript-visible project files; otherwise blocking the click
with an explicit notice is preferable to falling through to Remote Access login,
which incorrectly suggests the public viewer should authenticate to read a
secret-link snapshot.

## Public Share Relay Privacy

Normal authenticated Remote Access is relay-mediated but end-to-end encrypted.
Public shares are different: current public-share relay requests carry the
share URL secret, request path, and response contents as plaintext relay
payloads. The relay transport still uses WSS to protect the browser-to-relay hop
from ordinary network observers, and the current relay forwards without logging
share payloads, but a relay operator who inspects frames can see public-share
contents. Public shares should therefore be described as unguessable
bearer-link read-only views, not as relay-operator-private views. See
[`topics/relay-origin-and-share-gating.md`](relay-origin-and-share-gating.md).

## Related Notes

- [`docs/tactical/000-relay-origin-and-share-gating.md`](../docs/tactical/000-relay-origin-and-share-gating.md)
  records the current public-share relay, opt-in, and revocation decisions.
- [`SECURITY.md`](../SECURITY.md) is the public security-policy entry point for
  reporting vulnerabilities and should stay operator-facing rather than carrying
  implementation-specific design contracts.
