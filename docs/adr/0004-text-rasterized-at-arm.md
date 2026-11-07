# ADR 0004: Text rasterized at arm time

## Context

The founding document kept text as a DOM/CSS layer on the output main thread. The
prototype needs multiple text boxes with outlines and shadows, images and shapes in
z-order, crossfades that keep text and background in lockstep, a key-colour stream look,
and identical rendering in editor thumbnails.

## Decision

Text objects are rasterized to bitmaps in the asset worker with `OffscreenCanvas` 2D at
arm time, using fonts from the service cache, and composited in WebGPU with everything
else. The same rasterizer runs in the operator for thumbnails.

## Reasons

- One compositor means one transition timeline and no DOM layout on the main thread.
- Canvas 2D gives outlines, shadows and fills with the browser's text engine; quality
  matches DOM for the sizes used on slides.
- Arm-time rasterization keeps the frame loop free of text work.

## Consequences

- Memory: one RGBA bitmap per layer per stack (two stacks per layer), not one per text box: the
  asset worker draws every object of a layer into one picture at the output's device resolution
  (ADR 0013). Since M7 (design/27 §7.3) that picture is the tight sprite of what the layer draws, at
  its offset, wherever that is under 80 % of the frame: a lyric band at 4K is about 11 MB instead of
  33 MB to draw, transfer and upload, and its draw is scissored to its rect. On WebGPU each stack
  also holds an output-sized layer texture (two per layer, 331.8 MB for five layers at 4K).
- Arm time is the asset worker's: its jobs run in raster lanes (design/27 §7.5, design/14
  "Asset worker: raster lanes and picture decoding"). Props go first, then the live cue's
  layers, the armed cue's and the pictures of the cue after it, in short turns, so a slide
  that decodes large photos never delays the once-a-second props flip; superseded jobs are
  cancelled.
- Sub-pixel text animation is not available (none is required).
- A DOM text layer remains only for diagnostics.
