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

- Memory: a 1920x1080 RGBA bitmap per text box per armed stack; bounded by two stacks per
  layer.
- Sub-pixel text animation is not available (none is required).
- A DOM text layer remains only for diagnostics.
