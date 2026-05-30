# Rich-Text Rendering

Covers the rendering pipeline for agent action panels — what transforms apply to
command output, file reads, diffs, and edits; which are always-on vs. user-toggleable;
and the rationale for each choice.

## Panel types

| Panel | Where rendered | Source data |
|-------|---------------|-------------|
| **Bash output** | `BashCollapsedPreview` / expand | stdout + stderr from tool result |
| **Read — code file** | `TextFileResult` → `FileModalContent` | `_highlightedContentHtml` from server (Shiki) |
| **Read — markdown file** | `TextFileResult` → `FileModalContent` | `_renderedMarkdownHtml` from server |
| **Read — plain text / log** | `TextFileResult` → `FileModalContent` | raw `file.content` |
| **Edit diff** | `EditCollapsedPreview` → `DiffMathView` | unified-diff string |
| **Diff nested in Bash output** | `BashCollapsedPreview` → `FixedFontMathToggle` | detected via `looksLikeUnifiedDiff` |

## Always-on transforms

These run unconditionally and are not user-configurable:

- **ANSI escape stripping** — applied before all rendering so raw escape codes
  never appear as literal characters. (`stripAnsiEscapes` inside `renderFixedFontRichContent`)
- **Shiki syntax highlighting** — server-side, keyed on file extension, stored as
  `_highlightedContentHtml` on `ReadResultWithAugment`. Applied only to files the
  server recognises as source code.
- **Server markdown rendering** — server-side, for `.md`/`.markdown` files, stored
  as `_renderedMarkdownHtml`. Produces sanitised HTML used for the default preview.
- **Line numbers** — shown in the plain-text fallback path (no Shiki highlight).

## Toggleable transforms (sigma Σ button)

`FixedFontMathToggle` wraps a source view and, if `rendered.changed = true`, shows
a small circular Σ button at the bottom-right of the panel. Clicking it toggles
between source and rendered mode; state is per-panel (local override) or globally
toggled via Ctrl/Cmd+Shift+M.

**What the toggle renders:**

- Markdown tables (`| col | col |` syntax) → `<table>` with aligned cells
- Markdown headings, blockquotes, lists, horizontal rules → styled inline elements
- Inline math `$…$` and display math `$$…$$` → KaTeX HTML
- Backtick inline code → `<code>` spans
- Bold `**…**` / `__…__` → `<strong>`
- Markdown file links `[label](./path)` → clickable links that open a file-viewer
- Unified diffs — detected automatically via `looksLikeUnifiedDiff`; diff-aware
  mode strips `+`/`-` gutter before rendering inline content and colours lines

**Detection heuristic (`mayHaveFixedFontRichContent`):** returns true if the
source text contains `$`, `` ` ``, `[`, `**`, or `__`, or if any line matches a
markdown structural pattern. This is deliberately broad to avoid missed renders on
output that mixes prose and code; see "code file exclusion" below.

**Global render mode:** `RenderModeProvider` holds `globalMode` (default
`"rendered"`) and a set of per-panel override IDs. A panel starts in the global
mode unless the user has toggled it locally. `toggleGlobalMode` resets all local
overrides.

## Code file exclusion — and math opt-in

Source files identified by Shiki (`_highlightedContentHtml` present) skip the
full `FixedFontMathToggle` pipeline in `FileModalContent`. Rationale: TypeScript,
JavaScript, Python etc. are saturated with `$` (template literals), `` ` ``,
`[` (arrays), `**` (operators), and `//` (comments that trigger heading heuristics),
causing near-universal false-positive detection of markdown structure. Shiki already
provides the best available source view.

**Math opt-in for code files:** `FileModalContent` runs `renderFixedFontMath`
(KaTeX only — no markdown structural transforms) on the raw content. If real math
is detected (`rendered.changed = true`), a Σ button appears defaulting to **off**.
Clicking it switches from the Shiki-highlighted view to a plain-text+KaTeX view;
clicking again restores Shiki. This uses a local `useState(false)` rather than
the global render mode, so the default stays off regardless of Ctrl/Cmd+Shift+M.
Note: math mode currently loses Shiki colouring — the two renders are mutually
exclusive until a compositing path is built.

Plain-text / log / output files (no `_highlightedContentHtml`) retain the full
`FixedFontMathToggle` pipeline (ANSI colour, markdown tables, math) with the
sigma button defaulting to rendered if rich content is detected.

For markdown files, `FileModalContent` uses its own outer Σ button (not
`FixedFontMathToggle`) to toggle between the server-rendered HTML preview and
the raw source view — avoiding double-sigma situations.

## Sigma button placement and scroll preservation

The Σ button is `position: absolute; right: 0.4rem; bottom: 0.25rem` within its
`.fixed-font-render-toggle` container — intentionally inside the container's
right edge to avoid overlap with the `UserTurnNavigator` scrollbar rail (which
occupies the rightmost ~34px of the viewport at z-index 25).

When the toggle changes the panel's height, `useScrollPreservingToggle`
(`lib/scrollAnchor.ts`) records the button's offset from the nearest
`overflow: auto/scroll` ancestor before calling the toggle, then restores
`scrollTop` via `useLayoutEffect` (before paint) so the button appears
stationary.

## Why source code read/edit sections are not rich-rendered

Even when a source file contains legitimate markdown or KaTeX in doc-comments or
string literals, applying `FixedFontMathToggle` to the whole file would be
incorrect: the renderer has no syntactic knowledge of the host language and cannot
distinguish a `$` that begins inline math from one that is part of a shell
variable, a PHP sigil, a JavaScript template literal, or a regex. Similarly,
`#` in Python/shell is a comment character but triggers heading detection; `---`
in a YAML front-matter separator triggers horizontal-rule detection inside
surrounding code.

The KaTeX inline-math filter (`tryMatchInlineMath`) is deliberately tight: it
requires at least one of `\ ^ { } +` or a digit inside the `$…$` span, and
rejects patterns that look like shell variable spans (`$VAR >>$OTHER`). In
practice this filters out the vast majority of false positives in prose and
command output. Edge cases remain — e.g. `echo $A=+$B` in a Bash snippet,
where `$A=+$B` satisfies the `+` heuristic — so the filter is good but not
exact.

For rich-rendering inside source code to make sense, the renderer would need to:

1. Parse the host language well enough to identify comment and string-literal
   token boundaries (or receive those boundaries pre-computed from the server
   alongside the Shiki highlight data).
2. Apply inline math rendering only within those token spans, not to the
   whole file (markdown structural transforms like headings and lists would
   still be suppressed).
3. Composite the Shiki-coloured source tokens with the rendered inline content
   so neither layer clobbers the other.

This is a non-trivial language-aware post-processing step. The ambition of
showing LaTeX math inside source-code reads/edits — scoped to doc-comments and
string literals — may be revisited in the future. Until then, the safe choice
is to show Shiki-highlighted source as-is and let the user read embedded
formulas as literal text, matching the experience in their editor.

## Known gaps / future work

- C/C++ UTF-8 escape sequences in string literals (e.g. `"\xc3\xa9"` → `é`) are
  not decoded. This would require detecting string literal boundaries and only
  applying UTF-8 decoding there, with the same Σ toggle UI.
- Comment/string-literal markdown rendering in source files is not attempted;
  the tradeoff between false positives and useful rendering favours
  source-only display for all code.
