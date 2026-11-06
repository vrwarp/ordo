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
`restartWorker`, `portRequest`, `mediaAck`, and a `view` (telemetry, introspection, diagnostics, log)
that the host caches so `window.__ordo.telemetry()`/`state()` stay synchronous. The host sends `tick`
(250 ms), `host` status (500 ms, and at once to every new link generation: media slots with their key,
`ended`, `paused`, position, duration and error; audio meters, long tasks, worker stats, painting, a
refused reload), numbered media events (`loaded`, `loadError`, `ended`, `error`), opener-closed, bus
ports and program-view answers. The link
keeps a mirror of the six media slots (2 background, 2 media, 2 audio), so slot choice, `busyUntil`,
retries and master-only ended reporting run exactly as before; the elements stay on the main thread
because the platform requires it (ADR 0005), and the autoplay-muted fallback lives with them.

Supervision. `Supervisor` (`@ordo/client`) watches a 250 ms heartbeat from each worker (dead after 4 s
for the link, 3 s for the renderer, 5 s for the asset worker; a stall-tolerant clock so a frozen main
thread does not condemn healthy workers) and restarts a dead or `fatal` worker, at most 5 times a
minute, then gives up and says so. Restarts per worker are in `health.workers`.

Liveness is judged on the host's timers, so it assumes a visible window. That holds by design: an output
is a fullscreen window on its own display and is never hidden or occluded during a service (Chrome
throttles a hidden window's timers to once a second and, after five minutes, to once a minute; the
stall-tolerant clock advances at most 500 ms per tick, so a worker that dies while the window is hidden
is restarted only once it is visible again, within its dead time). A hidden output is seen by nobody,
and becoming visible restores full-rate ticks, so nothing on the audience path depends on liveness while
hidden; message-driven liveness (a worker's death raising an event) is not offered by the platform for
`terminate`d or crashed dedicated workers, which is why heartbeats are used (review 2026-11-04 item 28).

- Link restart: the new link worker changes nothing on screen until it has a live state (persisted or
  from a bus): planning waits for the IndexedDB read, and a restarted worker without a state flips no
  layer (an empty plan would turn the picture the renderer still holds to black). It paints from IndexedDB (state, config, recent manifests) and OPFS,
  re-arms the live and armed cues (the renderer still holds them and tells the new link at once, so
  nothing changes on screen), reconnects, and the host asks the opener for a fresh bus port
  (`ordo.port.request`; the window.postMessage relay carries the bus meanwhile). What the media elements
  did meanwhile is not lost: the link acknowledges every media event (`mediaAck`); the host replays the
  ones a dead generation never acknowledged to its successor, and the first host status names every
  slot that has `ended`. The link reports `media.ended`/`audio.ended` for the live, playing, non-looping
  item whose element ended once its expected position has reached the end (so an element still ended
  from an earlier play does not count), on the audio master only, once per play (review 2026-11-04
  item 2: with `onEnd: advance`, a clip that ends while the link is down still advances the service).
- Render restart: the old worker took its canvas with it. The hold canvas is a main-thread copy: every
  snapshot the render worker posts (every 500 ms, every 150 ms while the program view is watched, and
  as soon as a flip has settled; never more than about 7 a second; half the output's resolution and never
  below 640x360, `snapshotSize`, so a 4K output is not covered by a 6x upscale; the worker's
  `createImageBitmap` copy returns in under 1 ms at every size measured, 1080p and 4K, 2D and WebGPU) is
  drawn onto the hidden hold canvas at once, because a bitmap from the render worker is backed by that
  worker's context and draws nothing once it dies (review 2026-11-04 item 1). A new or rebuilt WebGPU
  compositor is not copied until it has drawn for 1 s (a failing GPU presents garbage, white, before it
  reports the device lost); Canvas 2D never presents garbage, so its first frame is copied at once. The
  host shows the hold before it terminates the worker (the supervisor's `stop` hook, also on the worker's
  `error` event), and also as soon as the renderer misses its heartbeat (50 ms for this worker) for
  200 ms; see "Abrupt worker death" below for what each death mode shows. While the hold shows, the
  canvas underneath is hidden (a dead or device-lost canvas can be composited above the hold). The host
  then gives the new worker a fresh canvas, and lowers the hold 200 ms after the link reports the
  live content is held again (or after 8 s), so the new canvas is never seen fading in from black. The flips that
  re-arm the new worker are cuts (a late flip would otherwise crossfade from its arrival and be seen
  half-done when the hold drops; caught by the chaos spec's screencast), and a device-loss reason the old
  worker never recovered from dies with it. Each
  hold reason has its own pending lower, so raising one reason never cancels another's lowering; a hold
  nobody lowered comes down after 20 s, except a device-loss hold still waiting for `restored`, which
  stays up to 30 s (longer than the link's 15 s stuck-rebuild limit, so the lost canvas, white, is never
  uncovered between the two). While
  the renderer is silent, video frames are closed on the main thread instead of being posted to a worker
  that may be dead. This is the device-loss path with a new worker. In test mode the hold also carries
  the test pixel of the frame it copied, and `__ordo.state().holdCue` names that cue.
- Asset restart: fonts are reloaded and the cache is checked against the manifest. Raster surfaces are
  software-backed because bitmaps from an accelerated worker canvas turn black on screen when that
  worker dies (found by `e2e/chaos-output.spec.ts`).

Crash-only restart. The link worker checks `checkInvariants` after every applied state; a violation
asks for a full state, and a full state that still violates reloads the window. While live, no frame
presented for 3 s while the page is painting restarts the render worker; a second time within two
minutes reloads the window. A GPU device rebuild is not a stall: `lost` resets the renderer's grace and
the check waits until `restored` (at most 15 s). Repeated non-quota OPFS failures reload the window.
The host allows 3 reloads in 10 minutes (sessionStorage, `reload.ts`), so a deterministic failure cannot
become a reload loop; a refused reload for a stuck renderer restarts the render worker instead, and the
refusal is in `health.error` for the rest of the window (review 2026-11-04 item 9).

## Abrupt worker death

What the audience sees when the render worker dies without a supervised restart was measured in headless
Chromium (review 2026-11-04, "two things to know"; experiment pages under `/tmp/claude-0/limits`, headless
Chromium 1243 with SwiftShader; WebGPU works there with `--use-vulkan=swiftshader
--enable-features=Vulkan`, while the default ANGLE SwiftShader loses its device at start).

Death modes of a dedicated worker, and their signal:

| Mode                                | Signal                                               | Screen                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supervisor restart (stall, `fatal`) | none needed: the `stop` hook raises the hold first   | no gap                                                                                                                                                       |
| Uncaught exception in the worker    | `error` event, 2 to 3 ms after the throw             | the worker is not killed by it (its rAF loop keeps drawing); the supervisor restarts it under the hold in the same task                                      |
| Worker out of memory                | none from the worker                                 | a 2D worker allocating for 9 s never died and its canvas kept its frame; with WebGPU the whole renderer process died (the page is gone, nothing can help it) |
| Hang (busy loop, GC)                | missed heartbeats                                    | the canvas keeps its last frame (the worker is alive); hold after 200 ms of silence, restart after 3 s                                                       |
| Bare `terminate()` without `stop`   | none: Chrome raises no event for a terminated worker | only the chaos hook does this; the placeholder canvas can go white at once (below)                                                                           |

So no death mode that leaves the page alive is unsignalled except a bare `terminate()`, which only the
chaos hook performs. For it, the host notices the missing 50 ms heartbeat after 200 ms and the hold is up
within about 250 ms; the chaos spec reports, not fails, that window and records every composited frame
(CDP screencast) through each kill.

What a dead worker's canvas shows (6 trials each, sampled by CDP screenshots about every 30 ms): an idle
worker's last frame stays; with a running frame loop the placeholder is racy: software 2D white in 1 of 6
at 29 ms, accelerated 2D white in 0 to 6 of 6 depending on the run, WebGPU white in 4 of 6 at 32 to 69 ms.
The white is opaque (a canvas with `alpha: true` still composites white, not the page background), so a
hold placed behind the canvas cannot cover it.

The zero-copy alternative (the worker renders into its own `OffscreenCanvas`, posts
`transferToImageBitmap()` per frame, the main thread commits it to a `bitmaprenderer` canvas) does not
remove the class: the committed `ImageBitmap` stays backed by the worker's context, and the visible canvas
went white in 6 of 6 trials (2D, at 26 to 49 ms) and 4 of 6 (WebGPU) when the worker was terminated, the
same failure as the placeholder. Only a main-thread copy (`drawImage` of each frame into a 2D canvas the
main thread owns) survives: held in 6 of 6 trials in every configuration. Its commit is cheap on the main
thread (`drawImage` or `transferFromImageBitmap` 0.05 to 0.2 ms mean, p95 at most 1.3 ms, no long tasks,
1080p and 4K), but it puts the main thread on the frame path: with back-pressure (one bitmap in flight,
frames skipped meanwhile) this container's software pipeline committed 136 of 288 2D frames and 26 of 142
WebGPU frames at 1080p (54 of 580 at 4K), draw-to-commit p95 4 to 727 ms; without back-pressure the worker
queued 1,300 bitmaps and the page died. It also adds at least a frame to every GO and freezes the picture
during a main-thread stall. It is not adopted: the audience picture would depend on the host thread
(design/25) to close a gap that only the chaos hook can open. The placeholder path stays, with the hold.

## Slide images that arrive late

A slide whose image file cannot be read when it is prepared (not cached yet, the hub did not serve it) is
drawn without the image and still arms. The asset worker reports the hashes it could not read
(`done.missingImages`); the link keeps them per key, reports `N slide(s) drawn without image(s)` in
`health.error` and `missingImages` in `__ordo.state()`, and after every fill (a hub fill or a fallback-bus
file lands in the same store) and on the report itself (the file may have arrived while the job ran)
checks the store: once a missing image's file is there, the key is planned again as a `refresh` job, and
the render worker swaps the held copy in place, no flip, no hold (`LayerStack.offer` with `refresh`). A
key is drawn again at most every 2 s, so a cached file the worker still cannot read never loops. A cached
image that fails to decode is not reported as missing (it would be missing every time); it is drawn
without, like before. Covered by `link-core.test.ts` and the chaos spec's withheld-image test.

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
   waits on a font. The font resolver (design/27 §10) registers each family's faces under
   an internal name never resolved before, so a face that loads late (a failed read
   retried with backoff, a font added during the service) is used by the next draw
   without restarting the worker; the worker then reports the family `ready` and the link
   draws again in place the held slides that fell back for it.
3. For images, `createImageBitmap` from the OPFS blob (cached bitmaps by hash and size
   are reused). A picture a slide draws unrotated is resampled once into an sRGB bitmap
   of its device rectangle and copied 1:1 (design/27 §7.1).
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

Text objects with runs, paragraph styles or a rich style field go through ordo's text engine
(`packages/renderer/src/text`, design/27 §6): laid out in logical px whatever the output size, then
painted under the scale transform in the same pass order (fill box and highlights, shadows, glow,
outline, fill, underline and strike, bullets). Every other text object is drawn by `drawText` as above,
byte for byte, except that a paragraph containing a strong right-to-left character is measured and drawn
with `ctx.direction` set to its first strong character's direction. Lyric-only, next-slide and
lower-third bands go through the engine when the source object is rich, the text has a strong
right-to-left character or the look's style has a rich field: the source's readable text in the look's
style, shrunk to fit, with the source paragraphs' directions.

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

The look is loaded at startup, on every hub `welcome` (a restarted live process may have dropped a
settings delta) and on a `library.delta` that changes settings, fonts or media. Fetches may overlap; an
answer older than one already applied is dropped, so a slow stale answer never overwrites a newer
config (review 2026-11-04 items 4 and 21). Lyric-only looks typeset the lyric
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
cues, and reports `gpuLost++`. The hold canvas (a main-thread 2D copy of the latest
snapshot, see Render restart; opaque black when the device is lost before any copy, e.g.
right after a reload) is shown during the rebuild and the lost canvas is hidden (Chrome
composites it white). Snapshots taken around the loss are dropped; the hold comes down on
the first copy the rebuilt compositor makes after drawing for 750 ms without another loss
(or 2 s later), also across the 3-strikes switch to Canvas 2D on a fresh canvas.

## Render-plan clamps and quarantine

`packages/renderer/src/clamp.ts` clamps everything the planner hands on (design/25): box edges within
±2× the logical canvas, text to 10,000 characters, font sizes to [4, 1000] px, 200 objects and 16
distinct images per slide, finite numbers everywhere, unknown objects dropped; looks are completed from
the main look. `planFrame`/`planPreview` carry clamped copies (memoised by identity) and the rasterizer
re-applies the cheap clamps and culls lines far outside the canvas. The asset worker bounds the decoded
image bytes per cue (192 MiB) and reports text in a font family that is not loaded
(`health.fontFallbacks`; run, bullet and fallback fonts count, and so does Inter, which ships like any
other face). Property tests (`plan.fuzz.test.ts`) feed random slides and looks within and
far beyond the clamps: never throws, output within bounds.

Arm failures are classified (review 2026-11-04 item 3). A deterministic failure (the image does not
decode, the raster throws, the cached video does not play, the asset worker stops answering while it
draws the key and is restarted) counts toward quarantine: a slide, image or
media key whose arm fails that way three times within a minute (`ErrorBudget`) is quarantined for the
rest of the service: never flipped to (the layer shows nothing), never retried, listed in
`health.quarantined`; a new service (or End service) lifts it. A quarantined key stays required, so the
cue is not armed (`armedOk` false, `armError` "quarantined: …"). Unavailability (the file is not cached
yet and the hub did not serve it; a video streamed during an incomplete fill that fails, which the element
reports as a network or format error; a load timeout) is never quarantined: the key is retried after 1,
2, 4, 8 s, then every 15 s, and the backoff is lifted when a cache fill completes (for the keys whose file
it cached, or all of them when it completed). A file the hub answers 404 or 410 for is `missing`, not
unavailable (review F1): the fill and the arm try it again after 60 s, doubling to 5 min, the fill counts
it in the cache error budget, says once `cache: <hash> missing on the hub (HTTP 404)`, and `health.error`
lists `N file(s) missing on the hub`; a video known missing is not streamed into a media element at all
(the element would report a format error every few seconds). A slide's own images that cannot be read are
drawn without the image (the slide still arms) and drawn in once the file arrives ("Slide images that
arrive late"). A cached file that fails to decode is removed from OPFS and fetched
again; the link also compares cached sizes with the manifest every 30 s while live and after an
asset-worker restart (`health.cacheRepairs`).

Fills stream response bodies into the OPFS writable (`apps/output/src/opfs.ts`) instead of buffering
blobs. Downloads in flight belong to a shared set: a manifest change (a preview, a library delta, a
verify) cancels only those whose file left the manifest; the others continue and the new fill joins
them (review item 11). Each file that fails backs off between fills (network: 4 s doubling to 30 s;
storage: 10 s doubling to 5 min). A full disk (`QuotaExceededError`) fails the file at once, counts in
the `cache` error budget, and after 4 fills (or once the budget is spent) the file is given up on for
the service; `health.error` says "storage full: N file(s) not cached" while it lasts. A download that
stores 0 bytes on every attempt (`size`) is treated the same way: counted, given up on after 4 fills, and
shown as "N file(s) arrive empty from the hub" (review F10). A file whose every
download disagrees with the manifest's size is kept once and its size remembered (IndexedDB
`accepted:<outputId>`), so neither the fill nor the 30 s check fetches it again; it is reported in
`health.error` (review item 10).

## Health message

```ts
{ t: 'health', presented, missed, longTasks, lateFlips, armed, live, cache: { ready, total }, gpuLost, videoDropped }
```

`videoDropped` comes from `video.getVideoPlaybackQuality().droppedVideoFrames`. Additive fields:
`mainThreadStallMs`, `workers [{name, generation, restarts, lastReason, gaveUp}]`, `quarantined
{count, items}`, `fontFallbacks`, `cacheRepairs`, `busTransport` ('port' | 'window').
