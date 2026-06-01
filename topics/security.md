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

If public read-only shares gain file or rich-document viewing, that viewer must
use a share-scoped artifact model instead of accepting arbitrary local paths.
The public share path must not directly reuse `/api/local-file`,
`/api/local-image`, or project-file endpoints that are meant for
local/authenticated YA clients.

A safe public-share file viewer should expose only files that are visible from
the shared session content:

- A frozen snapshot share should persist an immutable manifest of linked files
  and required render assets at capture time, so later filesystem changes do not
  change what the link exposes.
- A live share may refresh its manifest only from transcript-visible links or
  other deliberate share content, not from arbitrary project paths supplied by
  the public viewer.
- Markdown or HTML images needed to render an allowed linked document may be
  included as a bounded transitive closure of that document's local references.
- Public endpoints should use opaque share asset identifiers or manifest
  entries, not raw absolute paths, project-relative paths, `..` traversal, or
  symlink-sensitive filesystem resolution requested by the browser.

The design point is intentionally narrower than "the user could ask the agent to
cat that file." That argument applies to the authenticated operator, not to an
unauthenticated public share recipient.

Until that share-scoped artifact model exists, public-share viewers must not
follow local/authenticated file links into the normal app. Blocking the click
with an explicit notice is preferable to falling through to Remote Access login,
which incorrectly suggests the public viewer should authenticate to read a
secret-link snapshot.

## Related Notes

- [`docs/tactical/000-relay-origin-and-share-gating.md`](../docs/tactical/000-relay-origin-and-share-gating.md)
  records the current public-share relay, opt-in, and revocation decisions.
- [`SECURITY.md`](../SECURITY.md) is the public security-policy entry point for
  reporting vulnerabilities and should stay operator-facing rather than carrying
  implementation-specific design contracts.
