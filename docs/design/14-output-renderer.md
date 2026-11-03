# Design 14: Output renderer

`apps/output` plus `packages/renderer`. One window per display. The window's job is to
present one composited frame per vsync with nothing on the critical path that can block.

## Threads

The window follows design/25: a main thread that hosts and three supervised workers that compute.

| Thread        | Owns                                                                                                                                                                                                                                                                                                          | Never does                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Main (host)   | The `<canvas>` (control transferred) and the 2D hold canvas, the `<video>`/`<audio>` elements and `requestVideoFrameCallback` → `VideoFrame` transfer, the audio engine, fullscreen, Wake Lock, keys, the diagnostics overlay, the program-view `RTCPeerConnection`, the opener's port offers, the supervisor | Networking, state, storage, planning, decoding, text, anything a worker can do  |
| Link worker   | WebSocket and clock sync, the live mirror and reducer, the fallback-bus client, OPFS service-cache fill (streamed) and pruning, IndexedDB persistence, cue planning and arm orchestration, props scheduling, health assembly, preview, ended-event queueing                                                   | Touching the DOM; it drives the host's media elements with commands             |
| Render worker | WebGPU device, `OffscreenCanvas`, the frame loop, layer stacks, transitions, uniform buffers                                                                                                                                                                                                                  | Fetching, decoding, allocation inside the loop                                  |
| Asset worker  | OPFS reads, `createImageBitmap`, font loading (`self.fonts`), text rasterization to a software-backed `OffscreenCanvas` 2D                                                                                                                                                                                    | Touching the GPU device except to upload prepared bitmaps via the render worker |

Topology. The host creates the three workers and three `MessageChannel`s (asset↔render, link↔render,
link↔asset) and hands the ends over with a `ports` message (`packages/renderer/src/messages.ts`), again
after any worker restart. Arming runs link → asset → render (jobs, bitmaps, flips) without the main
thread. The host ⇄ link protocol is `apps/output/src/host-protocol.ts`: the link sends media commands
(`load {slot, key, blob|url}`, `apply {transport}`, `pauseAt`, `holdPaused`, `route`, `unload`), audio
commands (`config`, `fadeOut`), `clock`, `title`, `rtc` signalling, `fatal`, `close`, `reload`,
`restartWorker`, `portRequest`, and a `view` (telemetry, introspection, diagnostics, log) that the host
caches so `window.__ordo.telemetry()`/`state()` stay synchronous. The host sends `tick` (250 ms),
`host` status (500 ms: media slots, audio meters, long tasks, worker stats, painting), media events
(`loaded`, `loadError`, `ended`, `error`), opener-closed, bus ports and program-view answers. The link
keeps a mirror of the six media slots (2 background, 2 media, 2 audio), so slot choice, `busyUntil`,
retries and master-only ended reporting run exactly as before; the elements stay on the main thread
because the platform requires it (ADR 0005), and the autoplay-muted fallback lives with them.

Supervision. `Supervisor` (`@ordo/client`) watches a 250 ms heartbeat from each worker (dead after 4 s
for the link, 3 s for the renderer, 5 s for the asset worker; a stall-tolerant clock so a frozen main
thread does not condemn healthy workers) and restarts a dead or `fatal` worker, at most 5 times a
minute, then gives up and says so. Restarts per worker are in `health.workers`.

- Link restart: the new link worker paints from IndexedDB (state, config, recent manifests) and OPFS,
  re-arms the live and armed cues (the renderer still holds them, so nothing changes on screen),
  reconnects, and the host asks the opener for a fresh bus port (`ordo.port.request`; the
  window.postMessage relay carries the bus meanwhile).
- Render restart: the old worker took its canvas with it. The host raises the hold canvas (painted
  from the last snapshot), gives the new worker a fresh canvas, and lowers the hold when the link
  reports the live content is held again (or after 8 s). This is the device-loss path with a new worker.
- Asset restart: fonts are reloaded and the cache is checked against the manifest. Raster surfaces are
  software-backed because bitmaps from an accelerated worker canvas turn black on screen when that
  worker dies (found by `e2e/chaos-output.spec.ts`).

Crash-only restart. The link worker checks `checkInvariants` after every applied state; a violation
asks for a full state, and a full state that still violates reloads the window. While live, no frame
presented for 3 s while the page is painting restarts the render worker; a second time within two
minutes reloads the window. Repeated non-quota OPFS failures reload the window. The host allows 3
reloads in 10 minutes (sessionStorage), so a deterministic failure cannot become a reload loop.

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
- `missed` is derived from rAF gaps. The frame period is learned from the median of the
  first 16 gaps (so a 30 Hz or 50 Hz display is not counted as missed frames) and tracked
  with an EMA of on-time gaps; a sustained run of gaps at twice the period means the
  display rate halved, and the period is learned again.
- Long tasks: `PerformanceObserver('longtask')` works on the main thread only; Chrome does
  not deliver long-task entries in workers. The render worker therefore counts rAF gaps of
  50 ms or more (the Long Tasks threshold) that are not a pause as its long tasks
  (`FrameClock.stalls`, with `maxStallMs`). The main thread posts a `tick` to the link worker
  every 250 ms and the link worker reports the longest gap between ticks as
  `health.mainThreadStallMs`. All of it goes in `health`.

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

Text is rasterized at arm time (ADR 0004). Golden images of the rasterizer and every
look live in `packages/renderer/golden/` (`pnpm --filter @ordo/renderer golden`, see
design/23). The rasterizer is in `packages/renderer` and
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

## Compositor selection and canvas swaps

WebGPU is tried first; when it is unavailable the Canvas 2D compositor draws the same
stacks. A canvas keeps its first context kind, so every switch between the two needs a
fresh canvas: the worker asks the main thread (`needCanvas`), draws on the new one, and the
main thread puts it on screen only when the worker reports `ready` or `restored` on it.
After a fallback to Canvas 2D the worker retries WebGPU on a slow timer (60 s, doubling to
15 min) on a fresh canvas while Canvas 2D keeps drawing; the first frame is drawn into the
new compositor before the swap, and a failed retry hands the canvas back (`canvasUnused`).
A WebGPU device lost three times in a minute stays on Canvas 2D for the session.

## Send to preview

While no playlist is live, the hub relays the operator's `preview` message to one output
(protocol `PreviewMsg`). The output plans a frame from the presentation it carries
(`planPreview`): the named slide, or the first, under the output's own look, with the
presentation's background when the look shows backgrounds and the media is known (the
message may embed the media records as `presentation.media`), else the look's holding
slide. `clear` returns the output to idle. The message is ignored while a playlist is live
and a GO live discards any preview.

## Looks

The look is loaded at startup and on `library.delta`. Lyric-only looks typeset the lyric
text into the band at arm time; the band is a `Box` in logical 1920x1080 space; outputs
at other resolutions scale by the logical-to-device transform in the vertex shader.

## Props and timers

Clock, countdown and elapsed timers are rasterized once per second by the asset worker
into a small texture; the render worker swaps the texture atomically. Messages are
rasterized on send. This keeps the frame loop free of text work. The stage look also
renders the live video's remaining time (`videoRemaining`, prd/04) as a prop.

The per-second tick wakes 150 ms before each whole second, rasterizes that second's text
and flips exactly on the boundary. Every other evaluation of the props model (state
changes, periodic syncs) uses the same instant (`propsEvalTime`: the coming boundary when
inside the lead, else now), so no caller can flip the layer back to the previous second's
text; and the tick's delay is never zero (`propsTickDelay`), so there is no busy loop.

Deferred (prd/04 gap): the lower-third look's per-item "show media" option needs a field on
playlist items and on the look's media rule; the `Look` schema strips unknown keys, so it is
not a renderer-only change and is left for the domain model.

## Startup and recovery

1. Read the output id and token from the URL, open the WebSocket, send `hello`.
2. Create the WebGPU device, compile all pipelines, allocate buffers and texture slots.
3. Load the manifest; fill OPFS; load fonts; report `cache.progress`. The fill waits for the
   first live state (hub or the cached one); it never prunes on an idle manifest, and a
   complete live fill prunes only files that none of the recently filled manifests used
   (`cache-policy.ts`: 14 days, 6 GiB, 12 manifests), so End service followed by Go live
   downloads nothing.
4. Apply `live.state`: arm the live cue, present it; arm the armed cue.
5. Request fullscreen on the assigned screen (triggered by the operator's launch gesture
   via the opened window's own `requestFullscreen` on load, which Chrome allows for
   windows opened by a user gesture) and acquire a Wake Lock.

`device.lost` rebuilds the device and pipelines from scratch, re-arms the live and armed
cues, and reports `gpuLost++`. A `<canvas>` 2D copy of the last presented frame (made
once per second, off the critical path, from the render worker's own copy) is shown by
the main thread during the rebuild so the screen never goes black.

## Render-plan clamps and quarantine

`packages/renderer/src/clamp.ts` clamps everything the planner hands on (design/25): box edges within
±2× the logical canvas, text to 10,000 characters, font sizes to [4, 1000] px, 200 objects and 16
distinct images per slide, finite numbers everywhere, unknown objects dropped; looks are completed from
the main look. `planFrame`/`planPreview` carry clamped copies (memoised by identity) and the rasterizer
re-applies the cheap clamps and culls lines far outside the canvas. The asset worker bounds the decoded
image bytes per cue (192 MiB) and reports text in a font family that is not loaded
(`health.fontFallbacks`). Property tests (`plan.fuzz.test.ts`) feed random slides and looks within and
far beyond the clamps: never throws, output within bounds.

A slide, image or media key whose arm fails three times within a minute (`ErrorBudget`) is
quarantined for the rest of the service: never flipped to (the layer shows nothing), never retried,
listed in `health.quarantined`; a new service (or End service) lifts it. A cached file that fails to
decode is removed from OPFS and fetched again; the link also compares cached sizes with the manifest
every 30 s while live and after an asset-worker restart (`health.cacheRepairs`). Fills stream response
bodies into the OPFS writable (`apps/output/src/opfs.ts`) instead of buffering blobs.

## Health message

```ts
{ t: 'health', presented, missed, longTasks, lateFlips, armed, live, cache: { ready, total }, gpuLost, videoDropped }
```

`videoDropped` comes from `video.getVideoPlaybackQuality().droppedVideoFrames`. Additive fields:
`mainThreadStallMs`, `workers [{name, generation, restarts, lastReason, gaveUp}]`, `quarantined
{count, items}`, `fontFallbacks`, `cacheRepairs`, `busTransport` ('port' | 'window').
