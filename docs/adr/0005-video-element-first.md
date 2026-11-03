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
- A WebCodecs path would slot in behind the same `VideoSource` interface in
  `packages/renderer`.
