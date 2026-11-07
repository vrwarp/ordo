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

## Reasons

- Chrome's media pipeline decodes in the GPU and utility processes with hardware
  acceleration and handles A/V sync; our code stays small.
- The main thread has nothing else to do, so `requestVideoFrameCallback` runs on time.

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
