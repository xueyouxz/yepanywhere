# Provider and model compact glyphs (top-right status)

## Goal

Replace the verbose provider + model text in the composer header badge with
something that still communicates provider identity at a glance without
occupying as much horizontal space.

## Current implementation (unicode symbols) — not good enough

The current approach assigns abstract unicode symbols (◉, ⌬, ✦, etc.) to
each provider and model family. The symbols were chosen to avoid visual
similarity, but in practice:

- **None are recognizable** without memorization. Users see a random glyph
  and have no intuition for what it maps to.
- **They look alike**. Every candidate in the "geometric shapes" and
  "miscellaneous symbols" unicode blocks is either a filled/hollow circle,
  a star, or a diamond. A user scanning the header cannot distinguish
  `◉` (Claude) from `✦` (Gemini) from `⌬` (Codex) at small sizes.
- Color alone distinguishes nothing in the current glyph approach — the
  glyph is in `color: var(--provider-X)`, but the color is already carried
  by the dot and badge border, so the glyph adds zero signal.

**Exception**: Gemini's `✦` (U+2726 BLACK FOUR POINTED STAR) *is* their
actual brand mark and may be recognized by Gemini-familiar users. Worth
keeping for that provider at least.

## Recognizability analysis

The signals available, roughly ranked by how much identity they carry:

1. **Color** — already used (border, dot). Orange = Anthropic/Claude, green
   = OpenAI/Codex, blue = Gemini, purple = OpenCode.
2. **Text abbreviation** — 2–3 letter labels (`Cl`, `Cd`, `Gm`, `OC`) are
   immediately readable, language-independent, and require zero learning.
3. **Brand-matched shape** — Gemini `✦` is an actual brand icon. Nothing
   comparable exists in unicode for Claude, Codex, or OpenCode.
4. **Abstract symbol** — carries no identity. This is what the current set
   uses and why it fails.

## Recommended approach: short text abbreviations + provider color

Replace the unicode glyphs with 2–3 letter provider abbreviations rendered
in `color: var(--provider-X)`. The color carries the brand; the text
disambiguates within-color cases.

| Provider       | Abbrev | Color var              | Notes |
|----------------|--------|------------------------|-------|
| `claude`       | `Cl`   | `--provider-claude`    | Anthropic orange |
| `claude-ollama`| `Cl↓`  | `--provider-claude`    | `↓` = local download |
| `codex`        | `Cd`   | `--provider-codex`     | OpenAI green |
| `codex-oss`    | `Cd↓`  | `--provider-codex`     | OSS / local |
| `gemini`       | `✦`    | `--provider-gemini`    | Keep brand mark |
| `gemini-acp`   | `✦↓`   | `--provider-gemini`    | ACP = local transport |
| `opencode`     | `OC`   | `--provider-opencode`  | OpenCode purple |

Model sub-family abbreviations (appended after provider abbrev):

| Model family | Short | Compact rendering (claude) |
|--------------|-------|---------------------------|
| sonnet       | `S`   | `Cl S4.6`                 |
| opus         | `Op`  | `Cl Op4`                  |
| haiku        | `Hk`  | `Cl Hk3`                  |
| (unknown)    | —     | `Cl 4.6` (version only)   |
| gpt-5.4-spark | `⚡`   | `Cd ⚡`                    |
| gpt-5.4-codex-spark | `⚡`   | `Cd ⚡`                |
| gpt-5.3-codex-spark | `⚡`   | `Cd ⚡`                |
| gpt-5.4-mini | `5.4m`| `Cd 5.4m`                 |
| gpt-5.4      | `5.4` | `Cd 5.4`                  |
| gpt-4        | `4`   | `Cd 4`                    |
| 2.5-flash    | `2.5f`| `✦ 2.5f`                  |
| 2.5-pro      | `2.5p`| `✦ 2.5p`                  |

The pattern is: provider abbrev + space + model short. Fits in ~6–8 chars
for all common cases. Tooltip shows the raw full model ID (already wired).

## SVG option (medium effort, higher quality)

The project already renders inline `<svg>` elements for toolbar icons. A
`ProviderIcon` component with one `<path>` per provider is consistent with
the existing style and adds no dependencies.

**What we can do without copyright concerns:**
- Simple geometric approximations of brand shapes (not traced from official
  assets): a rounded-square "A" for Anthropic, a circle-spiral for OpenAI,
  a four-star for Gemini, an open-square for OpenCode.
- Size: 14×14px, `fill="currentColor"` so it inherits provider color
  automatically from the surrounding `color` CSS.

**What to avoid:**
- Importing official SVG logo files — licensing is ambiguous for
  reproduction in UI.
- Icon libraries (lucide, heroicons, etc.) — the project avoids adding
  general-purpose icon packages.

SVG is the right long-term answer for recognition but requires someone
to draw the shapes. Text abbreviations are the right short-term fix because
they can be done immediately and are actually *more* recognizable than any
non-brand unicode glyph.

## Bitmap/image option (not recommended)

`<img src="...">` with small PNGs adds asset-hosting concerns, doesn't
scale with the provider color theming, and is not simpler than inline SVG.

## Implementation note

The current `modelIndicatorText.ts` uses short provider abbreviations
(`Cl`, `Cd`, `OC`) with selected symbolic model-family glyphs for certain
cases (for example spark).
Switching to text abbreviations is a pure data change in that file:
replace `providerGlyphMap` values with strings like `"Cl"`, `"Cd"`, etc.
The rest of the rendering pipeline (density negotiation, tooltip wiring)
stays unchanged.

For Gemini keep `"✦"` — it is brand-recognizable and renders well at small
sizes. Consider keeping it even if other providers move to text.

## Matching contract (unchanged)

See the original contract section: normalize provider key and model string,
apply provider abbreviation, then model suffix rules (longest match first),
keep numeric version segments as plain text, full model ID in tooltip.
