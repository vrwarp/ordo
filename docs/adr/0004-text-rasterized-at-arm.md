# ADR 0004: Text rasterized at arm time

## Context

The founding document kept text as a DOM/CSS layer on the output main thread. The
prototype needs multiple text boxes with outlines and shadows, images and shapes in
z-order, crossfades that keep text and background in lockstep, a key-colour stream look,
and identical rendering in editor thumbnails.

## Decision

Text objects are rasterized to bitmaps in the asset worker with `OffscreenCanvas` 2D at
arm time, using fonts from the service cache, and composited in WebGPU with everything
else (or by the Canvas 2D compositor where WebGPU is unavailable, ADR 0013). The text is
drawn with the rest of its layer, shapes and pictures in z order, through the shared
drawers (`packages/renderer`): legacy text with `drawText`, rich text (runs, paragraphs,
bullets, autofit, bidi) with ordo's text engine (design/27 §6), and fonts through the font
resolver (design/27 §10), which registers each face under an internal name. The same
drawers run in the operator's thumbnail worker and the editor, so all three break lines
alike.

## Reasons

- One compositor means one transition timeline and no DOM layout on the main thread.
- Canvas 2D gives outlines, shadows, fills and glyph shaping with the browser's text
  engine; line breaking, alignment and fitting are ordo's own, so they do not depend on
  the browser. Quality matches DOM for the sizes used on slides.
- Arm-time rasterization keeps the frame loop free of text work. What it costs is
  measured: health reports each output's slide raster p50/p95 against its budget (10 ms at
  1080p, 30 ms at 4K, design/27 §13), and `pnpm --filter @ordo/renderer bench:slides`
  measures it per slide kind (design/14 "Health message").
- A glyph that no face the output has covers is drawn by the computer's own fallback face,
  as in any browser. The asset worker detects those characters while it draws and reports
  them (`health.fontCoverage`), so they are found before the service, not by the audience.

## Consequences

- Memory: a 1920x1080 RGBA bitmap per text box per armed stack; bounded by two stacks per
  layer.
- Sub-pixel text animation is not available (none is required).
- A DOM text layer remains only for diagnostics.
