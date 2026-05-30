# Pixel-Scale Icon Aesthetics

Related topic: [Heartbeat ownership and timers](heartbeat.md).

This topic records contracts for tiny UI glyphs where vector geometry can look
reasonable in source but fail after rasterization in the actual toolbar,
device pixel ratio, theme, and button container.

## Contracts

- Judge icon changes from native-size rendered pixels in the real component
  context. A zoomed SVG/contact-sheet preview is useful for geometry debugging,
  but it can hide blur, centering, margin, and stroke-weight problems.
- The button boundary, background, and active state are part of the glyph read.
  Do not tune the path as though the SVG owns the whole button; toolbar icons
  usually occupy a smaller inner box with fixed visual margins.
- A square toolbar affordance cannot directly reuse a wide reference shape.
  Borrow semantic ingredients from references, then redraw for the square icon
  box. For heartbeat/vitals metaphors, the useful ingredients are a calm
  baseline, a compact decisive excursion, and enough tail to read as a signal.
- At 16-20 CSS pixels, rounded joins and dense zigzags can collapse into a
  signature, mountain, or abstract mark. Prefer fewer turns, decisive vertical
  contrast, and clear horizontal baseline space.
- For inactive controls, avoid high-saturation semantic color competing for
  attention. Use subtle low-saturation contrast in the glyph and let the
  button background/border carry active state. Active state may use the
  stronger domain color when it reinforces the state rather than merely
  decorating it.
- Avoid radial "spark/starburst/aperture" defaults unless the metaphor truly
  needs them. They are a common low-effort logo/icon attractor and can read as
  generic AI-brand ornament rather than product-specific intent.

## Heartbeat Icon Lesson

The heartbeat toolbar icon should evoke the emotional memory of a popular-media
vital-sign monitor more than it copies a clinical ECG strip. In a square
button, that means the final glyph must still look like a signal at native
pixels: flat lead-in, compact pulse, muted lead-out, and optical centering
inside the button. If the rendered pixels read as a handwritten signature,
letter M, mountains, or decorative sparkle, the source path is wrong even if
the SVG looks plausible at high zoom.

## Representative Change Types

- Adding or replacing compact toolbar icons.
- Reworking active/inactive icon color in dark or light themes.
- Moving an icon into a different button size, toolbar density, or device
  context.
- Using generated or reference imagery to derive a tiny product glyph.

## Tests And Checks

- Render the icon in the real component at normal CSS pixel size before
  accepting it.
- Check both active and inactive states, and at least one dark and one light
  theme when the color contract changes.
- Compare the native-size pixels against the intended semantic memory, not only
  against source SVG geometry or magnified screenshots.
