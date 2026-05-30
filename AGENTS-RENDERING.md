# Output rendering for agents

How agent output is displayed to users in Yep Anywhere. Use these
formatting features freely when responding through a YA-supervised
session (Claude Code, Codex, Gemini, etc.).

## Markdown (GitHub-flavored)

Text responses are parsed as GFM and rendered as sanitized HTML:

- Headings, **bold**, *italic*, ~~strikethrough~~, `inline code`
- Ordered / unordered / nested / task lists (`- [ ]` / `- [x]`)
- Block quotes
- Tables with header alignment
- Fenced code blocks — tag the fence with a language (` ```ts `,
  ` ```python `, ` ```sh `, etc.) for syntax-highlighted output via
  Shiki
- Links: `[text](https://…)` and autolinked URLs; `http`, `https`,
  `mailto` schemes only

Raw HTML inside markdown is escaped, not passed through. Do not rely on
embedding HTML tags.

## Local file links

Absolute local paths ending in a media extension become in-app preview
affordances:

- `![alt](/path/to/image.png)` — clickable thumbnail (opens modal)
- `[caption](/path/to/clip.mp4)` — clickable video placeholder

Recognized extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`,
`tiff`, `svg`, `mp4`, `webm`, `mov`, `avi`, `mkv`, `ogv`. Other local
paths render as links into the in-app file viewer.

## Tool results

Structured results from Bash, Edit, Write, Read, Grep, Task, etc. have
dedicated renderers (diff views, collapsible panels, status badges).
Do not paraphrase or re-quote tool output in your prose — the client
already displays it richly below your message.

## ANSI color

Terminal-style SGR escape sequences (the CSI `\x1b[...m` family) are
parsed and rendered as styled spans. Supported: 16 base + 8 bright
foreground/background colors, bold, italic, underline, strikethrough,
and reverse-video. 256-color and 24-bit truecolor params are parsed
for offset correctness but fall back to the default color (attributes
still apply). Non-SGR escapes (cursor moves, OSC titles, etc.) are
silently stripped.

**Where it renders:**

- Inside **Bash / BashOutput tool results** — stdout/stderr with ANSI
  escapes are auto-rendered. You can safely pass `--color=always` to
  any color-capable tool, or set `CLICOLOR_FORCE=1` / `FORCE_COLOR=1`
  / `TERM=xterm-256color` in the environment.
- Inside **fenced code blocks in your reply text** — either tag the
  fence ` ```ansi ` explicitly, or simply paste text that contains
  raw escape bytes; auto-detection will route it through the ANSI
  renderer instead of Shiki.

**When to use it:**

- Showing colored diffs (`git diff --color=always`, `delta
  --color-only`, `diff --color=always`)
- `ls --color=always`, `rg --color=always`, `grep --color=always`
- Compiler / linter output that already colors severity (`cargo`,
  `gcc`, `tsc`, `clippy`)
- Any script output you author that uses SGR escapes intentionally

Agents running inside YA can assume the effective TERM is
`xterm-256color`-compatible for coloring purposes. Do not rely on
cursor-movement, alternate-screen, or other non-color terminal
features — those escapes are dropped.

## LaTeX math (KaTeX)

TeX math is rendered server-side via KaTeX. Two forms, same as Pandoc
and most GitHub-style math extensions:

- **Inline**: `$…$` — e.g. `the residual is $y - \hat{y}$ at step t`.
  Requires non-space immediately after the opening `$` and before the
  closing `$`; the closing `$` must not be followed by a digit or
  another `$`. This means `$100 and $200` (currency) is left alone.
- **Display / block**: `$$…$$` on its own — can span multiple lines.
  Renders centered as a `div.katex-display` block.

KaTeX is invoked with `throwOnError: false` and `strict: "ignore"`, so
unknown commands render as a visible error span instead of failing the
whole message. `\href` and other macros that could emit arbitrary
attributes run with `trust: false`, so `javascript:` / `data:` URLs in
math are rejected even though the KaTeX HTML bypasses the outer
sanitize-html pass.

When to use it:

- Algorithm descriptions, loss functions, gradient derivations
- Statistical notation in research-paper or log updates
- Matrix / vector expressions in explanations

Prefer the `$…$` / `$$…$$` syntax in message bodies over rendering
equations as ASCII — the rendered output is clickable, selectable, and
scales with font size. Inside fenced code blocks math is **not**
rendered (code blocks are opaque to the math extension).

## Sanitization

Rendered HTML is passed through `sanitize-html`. Disallowed tags are
escaped (visible) rather than silently stripped, so oversights surface
in the output. KaTeX output is substituted in after sanitization via
placeholder spans, so KaTeX's own markup (spans, MathML) doesn't need
to be added to the allowlist.
