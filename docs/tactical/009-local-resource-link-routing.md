# Local Resource Link Routing

Status: Proposed

Progress:

- [x] 2026-06-02: Captured the remote relay local-file link failure mode and
  the preferred organization direction.
- [x] 2026-06-02: Added the shared local-resource parser for legacy hrefs and
  semantic `data-ya-resource` attributes, with focused shared tests.

## Context

YA renders links to files, images, videos, Markdown documents, and project files
from several places:

- server-rendered Markdown augments in `packages/server/src/augments/`;
- standalone local document routes such as `/api/local-file`;
- local media routes such as `/api/local-image`;
- project file routes under `/projects/:projectId/file`;
- public-share link rewriting and share-scoped file routes;
- client-side modals for rendered transcript, read/edit previews, and file
  viewer panels.

Those surfaces do not all run under the same transport. Direct localhost/LAN
clients can fetch `/api/...` URLs with cookies. Hosted remote clients must use
`SecureConnection` over SRP + NaCl, optionally through the public relay. Public
share viewers use a separate share-scoped relay flow and must not inherit
authenticated local file access.

That means a rendered link is not just a URL. It carries at least four pieces
of context:

- what kind of local resource it refers to;
- who interpreted it as a local resource;
- whether the current viewer is direct, authenticated remote, or public share;
- whether the path is project-relative, project-root absolute, or arbitrary
  local absolute;
- whether the UI should navigate, open a modal, fetch a blob, or block with an
  explicit notice.

## Observed Problem

A hosted remote URL such as:

```text
https://staging.yepanywhere.com/api/local-file?path=C%3A%2Ftmp%2Fexample.json
```

is a plain browser navigation to the hosted site's HTTP route. It does not go
through the authenticated `SecureConnection` relay request path, so it bypasses
the transport that can actually reach the user's YA server.

The code already has pieces of the right behavior, but they are uneven:

- `RelayProtocol.fetch()` and `fetchBlob()` can route API requests through the
  secure WebSocket transport.
- The relay server-side request handler can route those requests through the
  Hono app and encode binary content such as images, videos, and PDFs.
- Local media links are emitted with semantic classes such as
  `.local-media-link`; the client intercepts those links and loads blobs via
  the current connection.
- Plain local file links are emitted as `/api/local-file?...` anchors without an
  equivalent local-file modal or resolver in the normal session UI.
- Public shares have their own link rewriting for `/api/local-file`,
  `/api/local-image`, and `/projects/.../file`, but that logic is intentionally
  share-scoped and not the general authenticated remote behavior.
- `local-file` and `local-image` have similar security goals but different path
  validation details. In particular, Markdown rendering recognizes Windows
  drive paths, while `local-file` currently checks for POSIX-style absolute
  paths.

The practical result is that local media often works better than local text or
document links in remote mode, and project file links work better than raw
`/api/local-file` links because they land on an SPA route that calls the API
client.

## Agent Text vs YA Metadata

Agents do not create trusted YA resource metadata. They create ordinary text,
Markdown links, image links, tool output, or file paths. YA then interprets
local-looking references and decides whether to render them as local resources.

The intended pipeline is:

```text
agent output
  -> YA renderer recognizes a candidate local resource
  -> renderer emits fallback href plus YA-owned semantic metadata
  -> client chooses a direct, remote, public-share, or standalone open behavior
  -> server route enforces auth, approved folders, path safety, and type policy
```

For example, an agent might write:

```md
![probe](C:/tmp/playbox-zero-g-compare.png)
```

or:

```md
[probe json](C:/tmp/playbox-zero-g-compare.json)
```

The server renderer may interpret those as candidate local resources and emit:

```html
<a
  href="/api/local-image?path=C%3A%2Ftmp%2Fplaybox-zero-g-compare.png"
  class="local-media-link"
  data-ya-resource="local-media"
  data-ya-path="C:/tmp/playbox-zero-g-compare.png"
  data-ya-media-type="image"
>
  probe
</a>
```

or:

```html
<a
  href="/api/local-file?path=C%3A%2Ftmp%2Fplaybox-zero-g-compare.json"
  data-ya-resource="local-file"
  data-ya-path="C:/tmp/playbox-zero-g-compare.json"
>
  probe json
</a>
```

Those attributes are YA's interpretation of agent output, not authorization.
They are hints for the client UI so it can avoid raw browser navigation and
choose the right modal/blob/SPA behavior. The actual read still goes through an
authenticated route on the user's YA server, which must reject paths outside
approved folders or unsupported file types.

This matters for approved folders such as temp directories and project roots:
the renderer can make a link interactive when it recognizes the shape, but the
server remains the authority on whether the current install is configured to
serve that path. A remote modal should show the server's rejection clearly
instead of falling through to a hosted `/api/...` navigation or treating the
agent's path as proof that access is allowed.

## Design Direction

Do not add one-off interceptors for each new broken URL. Introduce a small
local-resource link model and make every renderer choose through that model.

Conceptual shape:

```ts
type LocalResourceKind =
  | "local-file"
  | "local-media"
  | "project-file"
  | "project-raw-file";

interface LocalResourceRef {
  kind: LocalResourceKind;
  path: string;
  projectId?: string;
  lineNumber?: number;
  lineEnd?: number;
  columnNumber?: number;
  renderMarkdown?: boolean;
  download?: boolean;
}

interface LocalResourceHref {
  href: string;
  attributes: Record<string, string>;
}
```

The model should be owned by shared client/server-safe code where possible, with
separate resolver adapters for contexts that cannot share implementation.

The model represents YA's parsed interpretation of an agent-authored or
server-authored link. It should never be treated as proof that the path is safe
to read.

### Runtime Contexts

The same `LocalResourceRef` should resolve differently depending on context:

| Context | Expected behavior |
|---------|-------------------|
| Direct authenticated app | Native `/api/...` fetches and SPA routes are OK. |
| Remote authenticated app | API reads use `connection.fetch()` / `fetchBlob()`; browser navigations stay on SPA routes or blob URLs. |
| Public share | Rewrite to `/share/:secret/file` only when share policy allows it; otherwise block with a notice. |
| Standalone rendered local document | Emit a usable fallback URL, but preserve semantic attributes so an app shell can hydrate it if present. |

### Rendered HTML Contract

Server-rendered Markdown and document HTML should keep ordinary `href`
fallbacks for direct mode, but also include semantic attributes that describe
the resource:

```html
<a
  href="/api/local-file?path=..."
  data-ya-resource="local-file"
  data-ya-path="..."
  data-ya-line="8"
>
  README.md
</a>
```

Media can keep the existing `.local-media-link` classes during migration, but
new code should prefer the generic `data-ya-resource` contract so local media,
local files, project files, and public-share rewrites share the same parsing
path.

The rendered HTML contract is intentionally redundant:

- `href` preserves direct-mode behavior, copy/paste, browser status text, and
  no-JS fallback behavior;
- `data-ya-resource` and related attributes preserve YA's parsed meaning without
  requiring every client context to reverse-engineer query strings;
- existing class names such as `.local-media-link` remain migration shims until
  the generic local-resource handler covers the same behavior.

Because these attributes are rendered from agent-visible text, every value must
be escaped for HTML attributes. The client parser should also tolerate missing
or malformed attributes and fall back to parsing the legacy href shape.

### Client Handling

The normal session UI should have one delegated local-resource handler, not
separate ad hoc handlers per renderer.

Responsibilities:

- parse `data-ya-resource` attributes and legacy `/api/local-file`,
  `/api/local-image`, and `/projects/.../file` hrefs;
- respect browser link gestures such as Cmd/Ctrl-click where the target is an
  SPA route that can work in remote mode;
- prevent raw `/api/...` navigations in hosted remote mode;
- open local media in the existing media modal;
- open local text/Markdown/JSON/log files in a local file modal or the project
  file viewer where a project-relative mapping exists;
- fetch binary documents through `fetchBlob()` and open a blob URL when a modal
  is not practical;
- show an explicit blocked/unavailable notice for references that cannot be
  safely resolved in the current context.

The handler should treat semantic attributes as preferred input but not as a
security boundary. It may choose "open image modal through relay" from
`data-ya-resource="local-media"`, but the eventual `fetchBlob()` still goes to
the server route that enforces the configured approved folders.

### Server Handling

`/api/local-file` and `/api/local-image` should share path classification and
allowed-path containment helpers. They should not drift on:

- POSIX vs Windows absolute-path recognition;
- symlink resolution and directory containment;
- project scanner allowed roots;
- content type allowlists;
- line/column suffix parsing.

This does not mean arbitrary local file access becomes broader. It means the
two local resource routes should enforce the same trust boundary with the same
path semantics.

## Tactical Work

### 1. Inventory and Tests

- Add focused tests around current remote-mode behavior for rendered
  `/api/local-file` links.
- Add tests for Windows drive local-file paths matching the Markdown renderer's
  recognized paths.
- Add renderer tests that prove agent-authored Markdown links become
  YA-authored semantic metadata while preserving fallback hrefs.
- Identify every raw local resource URL source:
  - `safe-markdown.ts`;
  - `local-file.ts`;
  - `local-image.ts`;
  - `FileViewer`;
  - `FilePathLink`;
  - public-share rewriting.

### 2. Shared Resource Parser

- Create a parser that converts hrefs and data attributes into
  `LocalResourceRef`.
- Support legacy URL shapes first so existing rendered content keeps working.
- Prefer `data-ya-resource` attributes when present, but keep href parsing as
  fallback and migration support.
- Keep parser output descriptive only; do not encode allowed-folder decisions in
  the client parser.
- Keep public-share path normalization separate from authenticated local file
  resolution; public shares have stricter policy.

### 3. Generic Client Handler

- Replace local-media-only click handling with a generic local-resource handler.
- Keep `LocalMediaModal` as the media renderer, but make it one branch of the
  generic handler.
- Add a local-file branch for text/Markdown/JSON/log/PDF links:
  - text-like files can use `connection.fetch()` when the response is text;
  - binary and PDF files can use `fetchBlob()` and object URLs;
  - project files should prefer the existing `FileViewer` when the project
    context is known.
- In hosted remote mode, block raw `/api/...` navigation unless the handler has
  converted it to a blob URL or SPA route.
- Surface server rejections in the modal/notice path so "outside approved
  folders" is visible as an authorization/configuration result rather than a
  broken hosted-client link.

### 4. Server Route Cleanup

- Extract shared local path helpers used by both local-file and local-image.
- Align Windows path support with the Markdown renderer's recognition rules.
- Keep existing allowed-path checks and add regression tests before broadening
  any accepted path syntax.
- Keep approved-folder checks server-side even when the renderer emitted
  `data-ya-resource`; semantic metadata is never authorization.

### 5. Public Share Compatibility

- Keep public-share rewriting explicit and share-scoped.
- Move any parsing helpers into shared code only if they do not weaken public
  share policy.
- Public viewers should continue to see a clear notice rather than being sent
  to Remote Access login for local/authenticated-only file links.

## First Slice

The first implementation slice should be small:

1. Add a shared parser for legacy local resource hrefs.
2. Add a generic delegated click handler in normal rendered message/file
   previews that blocks raw `/api/local-file` navigation in remote mode.
3. For local media, route to the existing media modal unchanged.
4. For local text-like files, open a simple modal populated through the current
   connection.
5. Add tests for direct mode, remote mode, and Windows `C:/...` local-file
   references.

Leave broader file viewer download/open-new-tab cleanup for a follow-up unless
the first slice naturally touches those buttons.

The semantic attribute emission can follow immediately after this first slice:
once the generic handler can parse both legacy hrefs and `data-ya-resource`
attributes, server renderers can start emitting explicit metadata without
breaking already-rendered or persisted content.

## Non-Goals

- Do not make public-share viewers authenticated operators.
- Do not move application-level link policy into the public relay; the relay
  remains a transport.
- Do not change relay default selection or endpoint precedence.
- Do not introduce a client-side filesystem model.
- Do not replace all renderer links in one pass if a legacy parser can preserve
  behavior during migration.

## Acceptance Criteria

- Clicking a rendered `/api/local-file?path=...` link in hosted remote mode
  never navigates the browser to the hosted site's raw `/api` route.
- The same link reaches the user's YA server only through the established
  secure connection.
- Media, text, Markdown, JSON, PDF, and unsupported file references have
  deliberate UI outcomes: modal, SPA route, blob URL, or explicit notice.
- Agent-authored links are interpreted by YA renderers into semantic metadata,
  and that metadata is treated as UI routing information rather than
  authorization.
- Paths outside approved folders produce clear server-driven errors in remote
  modals/notices rather than raw hosted-client navigation.
- Public-share behavior remains narrower than authenticated remote behavior.
- POSIX and Windows absolute-path recognition is consistent between Markdown
  rendering and local resource serving.
- Tests cover both URL generation and click handling so future renderers do not
  reintroduce raw relay-bypassing links.

## Open Questions

- Should local-file text modals reuse `FileViewer`, or should arbitrary
  absolute local files get a smaller viewer that does not require `projectId`?
- Should rendered local-file links preserve browser new-tab gestures by opening
  a generated blob URL, or should remote mode always prefer an in-app modal?
- Should `/api/local-file` return binary wrappers over relay for all supported
  file types, or should the client choose `fetch()` vs `fetchBlob()` from file
  extension first?
- How much standalone HTML compatibility is required for documents served by
  `/api/local-file?render=1` outside the React app shell?
