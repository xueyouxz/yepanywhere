# Relative filename display

## Contract

File paths shown in the UI must be the shortest unambiguous form:

1. **Project-relative** — if the file is under the session's project root,
   strip the prefix and show `src/foo.ts` (no leading slash).
2. **Home-relative** — if outside the project but under `~`, show `~/...`.
3. **Absolute** — fallback when neither applies.

The compact display label (visible text) may still be filename-only for
space reasons. The full display path must appear in the tooltip (`title`
attribute) so the user can identify the file without opening it.

## Implementation

### Shared utility

`packages/client/src/lib/text.ts` — `makeDisplayPath(filePath, projectPath)`:
- Tries project-relative first (strips `projectPath + "/"` prefix).
- Falls back to `shortenPath()` for home-relative.
- Used by Read, Write, and Edit tool renderers.

### Tool renderers

| Tool | Compact label | Tooltip (`title`) | Detail / modal |
|------|---------------|-------------------|----------------|
| Read | filename only | `makeDisplayPath`  | — |
| Write | filename only | `makeDisplayPath`  | — |
| Edit | filename or `filename +N files` | `makeDisplayPath` for every target, including pending multi-file edits | `makeDisplayPath` in diff modal header / pending target modal |

### Fixed-font content (code blocks, diffs)

`packages/client/src/components/ui/FixedFontMathToggle.tsx` —
`renderMarkdownFileLink()` handles `[label](href)` patterns inside
fixed-font content. `resolveMarkdownFileLink()` normalizes the href and
strips its leading `/` (a side-effect of `normalizeProjectPath`). The
title reconstructs the absolute path with a `/` prefix, then applies
`makeDisplayPath` with `options.projectPath` so the tooltip shows
project-relative or `~/…` form. `projectPath` is threaded from
`sessionMetadata` into `RenderOptions` at render time.

### Normal markdown text (assistant messages)

`packages/server/src/augments/safe-markdown.ts` — local-file markdown
links (`[label](./path)`) get `title` set to the href (absolute path)
when the markdown does not supply an explicit title.

When a Markdown document is rendered with a known local base, ordinary
relative links are resolved against that document's directory for preview
purposes. Markdown targets route through `/api/local-file?path=...&render=1`
so browser link gestures open a rendered, content-only document. Local media
targets route through `/api/local-image`.

### File path anchors

`packages/client/src/components/FilePathLink.tsx` renders path mentions as
native anchors to `/projects/:projectId/file?path=...`. Plain left click
opens the in-app file modal. Browser link gestures fall through, so middle
click, command/control click, and similar browser gestures open the
standalone file viewer.

### `transformFilePathsToHtml` — dead code

`packages/shared/src/filePathDetection.ts` exports this function and
it is re-exported in `packages/client/src/lib/filePathDetection.ts`,
but it is never called anywhere in the live codebase. The `.file-link`
CSS class it would generate appears to be dead styling as well.

## projectPath availability

`projectPath` comes from `SessionMetadataContext` (populated in
`SessionPage` from the project API). It is `null` when no project is
associated with the session. `makeDisplayPath` handles `null` gracefully
by falling back to `shortenPath`.
