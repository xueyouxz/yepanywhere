# Media Rendering and Routing

> YA shows images, video, and file previews from many places in the UI. Every
> one must pull the bytes *over the active connection* and display them from an
> object URL — never point an `<img>`/`<a>` straight at an `/api/...` URL — or
> it silently 404s in relay mode. Separately, each file is served by the route
> that matches where it lives (in-project, allow-listed local path, uploaded
> attachment, or public share).

See also:
- [`ui-architecture.md`](ui-architecture.md) — the render-boundary principle
  these surfaces are supposed to share instead of each re-solving fetching.
- [`rich-text-rendering.md`](rich-text-rendering.md) — how rendered Markdown/HTML
  produces the local-resource links that several of these surfaces consume.
- [`relative-filenames.md`](relative-filenames.md) — how the same paths are
  *displayed* (compacted to project-relative) across these surfaces.
- [`attachment-storage.md`](attachment-storage.md) — where uploaded attachments
  live and the allow-list behind `/api/local-image` and `/api/local-file`.
- [`relay-origin-and-share-gating.md`](relay-origin-and-share-gating.md) — why
  the relay origin has no API, and the public-share serving path.
- `docs/tactical/009-local-resource-link-routing.md` — the working log of the
  local-resource link/parser/modal build-out.

Topic: media-rendering-and-routing

## The connection rule (why media is different)

The client reaches the server two ways:

- **Direct** (`DirectConnection`) — localhost/LAN/Tailscale. The page origin
  *is* the YA server, so a plain `fetch("/api/...")` or `<img src="/api/...">`
  reaches it.
- **Relay** (`RelayProtocol` / `SecureConnection`) — the page is loaded from the
  hosted relay client (e.g. a static site), and the real server is on the far
  end of a WebSocket tunnel. **The page origin has no `/api` backend.** A native
  browser request to `/api/...` (an `<img src>`, an anchor navigation, a raw
  `fetch`) hits the static origin and 404s.

So in relay mode bytes can only arrive through `connection.fetchBlob(path)` over
the tunnel. The shared pattern across every surface is therefore: **fetch the
bytes as a `Blob` through the connection, wrap in `URL.createObjectURL`, render
that object URL.** Helpers that encapsulate this:

- `fetchMediaBlob` / `fetchLocalResourceBlob` (`components/LocalMediaModal.tsx`) —
  `connection.fetchBlob` when remote, credentialed `fetch` when direct.
- `useFetchedImage` / `useRemoteImage` (`hooks/useRemoteImage.ts`) — the hook
  form, returns an object URL.
- `RelayProtocol.fetchBlob` normalizes the `/api` prefix, so callers can pass
  either `/api/...` or `/...`.

The recurring bug is any surface that skips this and emits a bare API URL: it
works on the developer's own machine (direct mode) and 404s for everyone on a
phone through the relay. The base64 `data:` surfaces are immune (no network).

## Where media appears in the UI

Each surface below is named by *what the user is looking at*, then the component
and the route it pulls from.

### Inline in the transcript

- **Read tool result, inline image preview** — under a `Read` tool-call row in
  the message timeline, the expandable image with the `+ / -` toggle.
  `ImageFileResult` in `renderers/tools/ReadRenderer.tsx`. Bytes come as a
  base64 `data:` URL inside the tool result itself — no network, always works.
- **Embedded media inside rendered Markdown/HTML** — an `![](...)` image or
  video that appears inline within an assistant/user message body.
  `useLocalMediaInlinePreviews` (`components/LocalMediaModal.tsx`) hydrates the
  `local-media-inline-preview` placeholders emitted by the server Markdown
  augment; it's wired from `blocks/TextBlock.tsx` and
  `renderers/blocks/TextRenderer.tsx`. Route: `/api/local-image`. Relay-safe.
- **ViewImage tool result** — a "View Image" tool row (Codex `imageView` /
  `view_image`). Clicking the filename opens a modal with the picture.
  `renderers/tools/ViewImageRenderer.tsx` via `useFetchedImage` →
  `/api/local-image`. Relay-safe.

### Modals opened by clicking a link

- **File viewer modal (tool-result filename links)** — click a filename in a
  `Read`/`Edit`/`Grep`/`Write` row and a modal opens showing the file: code with
  highlighting, a Markdown preview, or — for images — the picture in the modal
  body. `SessionFilePathLink` → `FilePathLink` → `FileViewer` (in
  `FileViewerModal`). Routes: `/api/projects/:id/files` (metadata) and
  `/files/raw` (bytes). Relay-safe **as of the `fetchRawFileBlob` fix**; before
  that the image `<img src>` used the raw URL directly and 404'd in relay mode.
- **Local media modal (rendered-text media links)** — click an image/video link
  *inside* rendered Markdown/HTML and a modal shows it. `useLocalResourceClick`
  → `LocalMediaModal` → `/api/local-image`. Relay-safe.
- **Local file modal (rendered-text file links)** — click a non-media local file
  link in rendered text; a modal renders text/JSON/log inline, PDFs from a blob
  URL, and (direct mode) HTML/Markdown in a sandboxed iframe. `LocalFileModal`
  → `/api/local-file`. Relay-safe.

### Composer and new-session

- **Attachment chips** — image thumbnails on a sent user message and in the
  composer's pending-attachment row. `components/AttachmentChip.tsx` via
  `useRemoteImage` → `/api/projects/:id/sessions/:sid/upload/:filename`.
  Rendered from `MessageInput.tsx`, `MessageList.tsx`, and
  `blocks/UserPromptBlock.tsx`. Relay-safe.
- **New-session pending file preview** — a thumbnail in the new-session form for
  a file you've attached but not yet uploaded. `NewSessionForm.tsx`, using a
  local `File` object URL (pre-upload). No network, always works.

### Read-only shares

- **Public-share file viewer** — on a shared session page, clicking a file opens
  the same `FileViewer`, but backed by a share-scoped source
  (`publicShareFileViewerSource.ts`) that fetches `/public-api/shares/:secret/
  files/raw` through the relay+secret path. Relay-safe.

## Proposed refinement: anchored attachment hover preview

Current state: image attachment chips already show a full-image hover preview
after a brief linger (`AttachmentChip.tsx`, `HOVER_PREVIEW_LINGER_MS = 450`),
but the preview is a centered, viewport-fixed overlay. It does not choose a
direction from the thumbnail or avoid covering nearby context except by hiding
when the click modal opens.

Desired behavior for all image attachment thumbnails (composer, sent user
turns, and parsed user-prompt blocks):

- Keep the short hover delay so incidental cursor travel does not flash an
  image.
- Anchor the enlarged preview to the hovered thumbnail, not the center of the
  viewport.
- Choose the side with the most available space (prefer below/above when they
  can show the image at useful size; otherwise left/right), and flip when the
  first choice cannot fit.
- Resize the preview to fit inside the viewport with a small margin while
  preserving aspect ratio; never create page scrollbars or crop the image.
- Fetch/display bytes through the existing attachment preview path
  (`useCachedAttachmentImage` / `useRemoteImage`) so relay mode and cached
  thumbnail/full-image behavior stay unchanged.
- Leave touch behavior on the explicit click modal; hover-only enlargement is a
  desktop affordance.

## Which route serves the file (the "doors")

There are two routing systems and several serving routes. The serving route
determines the **permission model**, not just the URL.

Serving routes:

| Route | Access model | Source file |
|-------|--------------|-------------|
| `/api/local-image` | File-access allow-set (see below) | `routes/local-image.ts` |
| `/api/local-file` | Same allow-set (text/PDF/HTML/Markdown) | `routes/local-file.ts` |
| `/api/projects/:id/files` + `/files/raw` | Relative paths project-scoped; **absolute/`~` paths gated by the same file-access allow-set** | `routes/files.ts` |
| `/api/projects/:id/sessions/:sid/upload/:filename` | Files uploaded to that session | `routes/upload.ts` |
| `/public-api/shares/:secret/files/raw` | Share-scoped, capability-gated by secret | `routes/public-shares.ts` |

**The file-access allow-set** is one effective list enforced by **both** doors
(media routes and the project-files route), shared via
`routes/local-resource-policy.ts` (drive-letter/symlink-safe). It is the union
of user-toggled sources — projects ∪ uploads ∪ temp ∪ home ∪ custom — held live
in `middleware/file-access.ts` and editable in Settings → Local Access → File
access. `ALLOWED_FILE_PATHS` (alias `ALLOWED_IMAGE_PATHS`) pins it from the
environment. Secure by default: out-of-project absolute paths are denied unless
their folder is in the set. See `docs/tactical/018-file-access-scoping.md`.

Two client routing systems decide *which* surface a link opens:

- **Tool-result filename links** — `SessionFilePathLink` → `FilePathLink`. These
  always open the `FileViewer` against `/api/projects/:id/files`, regardless of
  whether the path is inside the project or an outside safe-dir path like
  `C:\tmp\...`. `getProjectViewerFilePath` only affects the *displayed* path, not
  the route.
- **Rendered-text links** — `useLocalResourceClick` parses each link into a
  `LocalResourceRef` (`local-media` | `local-file` | `project-raw-file`) using
  the shared `parseLocalResourceLink` (`packages/shared/src/local-resource.ts`).
  `normalizeResourceForProjectContext` sends *in-project* paths to the project
  `FileViewer`, and everything else to the `LocalMediaModal` / `LocalFileModal`
  (the allow-listed `/api/local-image` / `/api/local-file` doors).

The two routing systems still pick *different surfaces* for the same path, but
that no longer changes the **permission** outcome: both surfaces now resolve
against the same file-access allow-set. So a `C:\tmp` image that takes the
project-files route enforces the same allow-set as the media door would — the
historical "safe-dir image opened through the project files route" 404 is gone.

## Known sharp edges

- **Bare API URLs in relay mode** — the canonical failure. Fixed in the
  `FileViewer` by giving the default source a `fetchRawFileBlob`; watch for it
  in any new surface.
- **In-project vs. out-of-project routing** — tool-result links always use the
  project files route; rendered-text links split by location. The two systems
  don't share the in/out-of-project decision.
- **Both doors share one allow-set** — as of `docs/tactical/018`, the
  project-files route enforces the same file-access allow-set as the media
  doors for absolute/`~` paths (relative paths stay project-scoped). The set is
  secure-by-default, so absolute paths outside projects/uploads/temp are denied
  until the user adds the folder (Settings → File access) or sets
  `ALLOWED_FILE_PATHS`.
- **No single media component** — surfaces share the *fetch primitive*
  (`fetchMediaBlob` / `useFetchedImage`), not one `<RemoteImage>` element, so a
  fix has to be applied per surface or pushed into a shared source adapter.
