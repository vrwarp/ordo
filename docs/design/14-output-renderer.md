# Design 14: Output renderer

`apps/output` plus `packages/renderer`. One window per display. The window's job is to
present one composited frame per vsync with nothing on the critical path that can block.

## Threads

| Thread | Owns | Never does |
| --- | --- | --- |
| Main | The `<canvas>` (control transferred), the `<video>` elements for the live and armed media, the WebSocket and fallback-bus receive, the health timer, Wake Lock, fullscreen | Layout beyond the canvas, decoding images, text, shader compilation |
| Render worker | WebGPU device, `OffscreenCanvas`, the frame loop, layer stacks, transitions, uniform buffers | Fetching, decoding, allocation inside the loop |
| Asset worker | OPFS reads, `createImageBitmap`, font loading (`self.fonts`), text rasterization to `OffscreenCanvas` 2D, manifest and cache management | Touching the GPU device except to upload prepared bitmaps via the render worker |

The main thread is otherwise idle, which is what makes `<video>` plus
`requestVideoFrameCallback` on it acceptable for the prototype (ADR 0005).

## Frame loop

```
every rAF (render worker, via requestAnimationFrame on the OffscreenCanvas's worker scope):
  now = hubNow()
  if pendingFlip && now + frameMs/2 >= pendingFlip.at: swapStacks(); pendingFlip = null
  for each video source with a new VideoFrame: importExternalTexture (zero copy)
  encode one render pass: for each layer in [background, slide, lowerThird, media, props]:
     draw layer A (outgoing) and layer B (incoming) with crossfade weight t, if transitioning
  submit
  record presented++, and missed += max(0, round((now - lastFrameAt)/frameMs) - 1)
```

- Every buffer, bind group, pipeline and sampler is created at startup or at arm time.
  The loop body creates no JS objects; state lives in pre-allocated typed arrays.
- All pipeline variants (opaque texture, alpha texture, external video texture, solid
  colour, crossfade pairs) are compiled at startup, before the window reports ready.
- `missed` is derived from rAF gaps; `PerformanceObserver` long tasks on both threads are
  counted separately. Both go in `health`.

## Layer stacks and arming

A layer stack is the fully prepared set of GPU resources for one cue under this output's
look: textures for every object, the video source for a background or media, the layout
of quads, and the transition parameters. The renderer holds exactly two stacks per
layer: `live` and `armed`. Arming builds the `armed` stack; GO swaps pointers at the
scheduled frame and begins the crossfade; the old `live` becomes free for the next arm.

Arm sequence for a cue (asset worker, then render worker):

1. Resolve the cue under the look: which objects are drawn and with which style
   (`authored` draws every object; `lyricOnly` builds a synthetic text object from the
   lyric box text and the look's band and style, plus the next slide's text if configured).
2. For each text object, rasterize to an `OffscreenCanvas` 2D at output resolution:
   fill, padding, word wrap to the box, alignment, outline via `strokeText`, shadow via
   canvas shadow properties, then `transferToImageBitmap`. Fonts come from the service
   cache and are loaded into the worker's `FontFaceSet` at manifest time, so arm never
   waits on a font.
3. For images, `createImageBitmap` from the OPFS blob (cached bitmaps by hash and size
   are reused).
4. Post bitmaps to the render worker, which uploads them into pre-allocated texture
   slots (`copyExternalImageToTexture`) and writes the quad list for the stack.
5. For video (background or media cue), the main thread creates a `<video>` for the
   armed asset from the OPFS file (`URL.createObjectURL(file)`), preloads to the first
   frame (`preload=auto`, wait for `canplaythrough` and one `requestVideoFrameCallback`),
   and pauses. Its frames are delivered to the render worker as `VideoFrame`s from the
   `requestVideoFrameCallback` loop; the worker imports them with
   `importExternalTexture` each frame.
6. Report `output.armed { ok: true }`. Any failure reports `ok: false` with the error
   and the previous live stack stays.

Memory bound: at most two stacks per layer, and one playing plus one armed video.

## Video playback

- On GO the main thread calls `video.play()` at the scheduled time (it is already decoded
  to its first frame, so the first frame is presented on the GO frame).
- `requestVideoFrameCallback` posts each new frame; the render worker presents the
  latest frame whose `mediaTime` is at or before now, and silently drops late ones.
- The audio-master output routes the video element through the audio engine
  ([design/18](18-audio-engine.md)); other outputs mute their copies.
- Looping uses the `loop` attribute; `ended` on a non-looping cue sends `media.ended` to
  the hub (audio master only), and the look's `onEnd` rule applies.
- Alpha video (VP9 WebM with alpha) comes through the same path; Chrome supplies the
  alpha plane in the external texture.

## Text

Text is rasterized at arm time (ADR 0004). The rasterizer is in `packages/renderer` and
runs in the asset worker. Its output for a text object is a bitmap and the box it
occupies; the render worker composites it like any image. Word wrap uses canvas
`measureText` with a greedy algorithm; outline is `strokeText` under `fillText`; shadow
uses canvas shadow properties on a separate pass to avoid outlining the shadow. The same
rasterizer runs in the operator's thumbnail worker so previews match outputs.

A hidden DOM text layer exists for a diagnostics overlay (Ctrl+Shift+D) only.

## Transitions

Crossfade: both stacks drawn, incoming alpha `t = smoothstep((now - at) / ms)`.
Backgrounds crossfade only when the background asset changes. Cut sets `t = 1`.
Key-colour looks fade text over the key colour; the clear colour never fades.

## Looks

The look is loaded at startup and on `library.delta`. Lyric-only looks typeset the lyric
text into the band at arm time; the band is a `Box` in logical 1920x1080 space; outputs
at other resolutions scale by the logical-to-device transform in the vertex shader.

## Props and timers

Clock, countdown and elapsed timers are rasterized once per second by the asset worker
into a small texture; the render worker swaps the texture atomically. Messages are
rasterized on send. This keeps the frame loop free of text work.

## Startup and recovery

1. Read the output id and token from the URL, open the WebSocket, send `hello`.
2. Create the WebGPU device, compile all pipelines, allocate buffers and texture slots.
3. Load the manifest; fill OPFS; load fonts; report `cache.progress`.
4. Apply `live.state`: arm the live cue, present it; arm the armed cue.
5. Request fullscreen on the assigned screen (triggered by the operator's launch gesture
   via the opened window's own `requestFullscreen` on load, which Chrome allows for
   windows opened by a user gesture) and acquire a Wake Lock.

`device.lost` rebuilds the device and pipelines from scratch, re-arms the live and armed
cues, and reports `gpuLost++`. A `<canvas>` 2D copy of the last presented frame (made
once per second, off the critical path, from the render worker's own copy) is shown by
the main thread during the rebuild so the screen never goes black.

## Health message

```ts
{ t: 'health', presented, missed, longTasks, lateFlips, armed, live, cache: { ready, total }, gpuLost, videoDropped }
```

`videoDropped` comes from `video.getVideoPlaybackQuality().droppedVideoFrames`.
