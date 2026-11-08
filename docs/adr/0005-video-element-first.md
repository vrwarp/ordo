# ADR 0005: Video through the video element first

## Context

The founding document decodes video with WebCodecs in a worker into a ring buffer. That
needs a demuxer, a decoder lifecycle, and audio handling of our own. The output main
thread in this design is idle apart from the canvas transfer.

## Decision

For the prototype, each output plays video with an `HTMLVideoElement` on its main
thread, preloaded to the first frame at arm time, started on GO, and delivered to the
render worker as `VideoFrame`s via `requestVideoFrameCallback`. Audio for the audio-master
output is taken from the same element. WebCodecs is deferred until the soak test shows
jitter attributable to this path.

As built: the link worker drives the elements with commands (the host keeps six slots: two
background, two media, two audio). Each frame is posted tagged with the slot's load
generation and, while the element plays, its clock (the hub time of media time 0, and the
clip length when it loops); the render worker presents the newest frame due at the media
time of the vsync being drawn, so an element a little ahead of hub time is held back and one
behind shows its newest frame (design/14 "Video playback"). A video that plays inside a
slide's box is armed this way on every output, muted except on the audio master, and drawn
through the slide's scene (design/27 §7.2).

## Reasons

- Chrome's media pipeline decodes in the GPU and utility processes with hardware
  acceleration and handles A/V sync; our code stays small.
- The main thread does little else (it hosts the elements, the audio engine, fullscreen
  and the supervisor; networking, state, decoding and drawing are in workers, design/25),
  so `requestVideoFrameCallback` runs on time. When it does not, it shows: the link reports
  the longest gap between the main thread's watchdog ticks as `health.mainThreadStallMs`.

## Consequences

- The soak test reports `droppedVideoFrames` separately so this decision can be
  revisited with data.
- There is no `VideoSource` interface (the original text named one that was never built). The
  render worker receives the elements' frames as transferred `VideoFrame`s per media slot (`vframe`
  with the slot's load generation and clock), keeps the two newest per slot (`FrameRing`,
  `packages/renderer/src/frame-ring.ts`) and imports the presented one as an external texture each
  frame (design/14 "Video playback", design/27 §7.2). A WebCodecs decoder would replace the main
  thread's `requestVideoFrameCallback` loop as the producer of those `vframe`s; the renderer would
  not change.
