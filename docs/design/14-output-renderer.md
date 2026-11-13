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
| Asset worker  | OPFS reads, picture decoding (`createImageBitmap`, `ImageDecoder` for scaled JPEG decodes), font loading (`self.fonts`), layer rasterization to a software-backed `OffscreenCanvas` 2D, in raster lanes                                                                                                       | Touching the GPU device except to upload prepared bitmaps via the render worker |

Topology. The host creates the three workers and three `MessageChannel`s (asset↔render, link↔render,
link↔asset) and hands the ends over with a `ports` message (`packages/renderer/src/messages.ts`), again
after any worker restart. Arming runs link → asset → render (jobs, bitmaps, flips) without the main
thread. The host ⇄ link protocol is `apps/output/src/host-protocol.ts`: the link sends media commands
(`load {slot, key, blob|url, gen}`, `apply {transport}`, `pauseAt`, `holdPaused`, `route`, `vclear`,
`unload`), audio commands (`config`, `fadeOut`), `clock`, `title`, `rtc` signalling, `fatal`, `close`,
`reload`, `restartWorker`, `portRequest`, `mediaAck`, and a `view` (telemetry, introspection, diagnostics,
log) that the host caches so `window.__ordo.telemetry()`/`state()` stay synchronous. The host sends `tick`
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

## Video pictures and video inside a slide (asset worker)

An `ImageObject` whose media is a video draws that media's poster ([design/27](27-pptx-native-renderer.md)
§8): the link's `slideImages` maps every picture a slide draws through `stillFile` (an image itself, a
video's poster), as the operator's thumbnail worker does, and a preview also caches the posters of its
media. The manifest already ships posters.

A slide job that carries `video` (design/27 §7.2) is answered with `SRC_SCENE` under its unchanged key.
`rasterScene` (`packages/renderer/src/scene-raster.ts`) splits the objects around the playing one with
`splitScene`, measuring text with the drawer's own layout so that text overflowing its box into the video
goes over it; draws the base (with the poster unless the clip is hidden while stopped), transfers it, draws
the over on the same surface when anything is over the video, and encodes the plane at the output's scale
with the clip's size (the poster's when the clip's is unknown), so the clip lands exactly on its poster.
Since M7 base and over are each drawn as a tight sprite of what they reach (`rasterSceneSprites`), so an
over that is only a title is a title-sized bitmap at its offset.
Base and over draw the pictures the worker prepared for the whole slide (`slidePictures`), with the same
targets as the slide drawn as one bitmap; a prepared poster is the box's size, so its source's size
(`sourceSize`) fits the plane. A look that does not draw the slide as authored, an object that is gone or an
empty box leaves the slide one bitmap with its poster. Covered by `scene-raster.test.ts` and
`asset.worker.test.ts` (fakes) and `scene-raster.browser.test.ts`, which recomposes base, the clip through
`planeSample` and over in headless Chromium and compares them with the slide drawn as one bitmap, with and
without the clip playing, from source and from prepared pictures.

## Asset worker: raster lanes and picture decoding

The asset worker's jobs run in raster lanes (`apps/output/src/lanes.ts`, design/27 §7.5), so a slide that
decodes two large photos never holds up the props layer, which flips on every second:

- **Ranks.** Props first, then the live cue's layers, then the armed cue's (the _interactive_ lane), then
  bulk work (the _bulk_ lane): the pictures of the cue after the armed one (`warm`), prepared into the
  cache so that arming it after the next GO only draws. The link marks each job `live` or `armed`.
- **Chains.** Each layer is a chain: its jobs run one at a time, live before armed, because a layer's
  content must reach the renderer in the order its stacks expect (`LayerStack.offer`). Jobs of different
  layers run side by side, so one waiting for a file read or a decode (both off the thread) never holds up
  another. A bulk job starts only while no interactive job is queued or running.
- **Decodes.** A whole-file decode is the worker's largest allocation (96 MB for a 24 MP photo), so the
  chains share one bound (`Steps.decode`): at most two decodes run at once across chains, the most urgent
  job's first, and a bulk job's decode starts only while no interactive job is queued or running. A warm
  job that started before a GO therefore pauses at its next decode instead of decoding beside the slide
  job; one decode it had started already runs to its end (a decode cannot be stopped). With six 24 MP
  photos per cue at 4K and a warm job running when the GO arrives (the real lanes, pictures and cache, a
  fake decoder), the peak of pinned and cached bitmaps fell from 380 to 253 MiB (the cache's budget is
  256) and of live bitmaps from 531 to 376 MiB.
- **Turns.** Synchronous work (preparing a picture, drawing and taking the layer) runs in slices, each in a
  task of its own once it is the most urgent waiting slice; the messages that arrived meanwhile are handled
  first. A picture over 2 MiB-pixels (a 4K frame) is prepared in bands of whole rows
  (`preparePictureSteps`, byte for byte the one-pass bitmap: a masked picture is cut by its mask once, in a
  slice after its bands, unclipped; only a turned picture's own edge, where its mask shows it, may differ by
  a few levels, design/27 §7.5), so the longest slice is a band, the first
  of which also builds the source's mipmaps, or the layer's own draw. Nothing interrupts a running slice.
- **Cancellation.** After each plan, the link cancels the jobs no live or armed layer, props or warm job
  needs any more (the armed cue changed before its job ran, a props second passed): a queued job is dropped,
  a running one stops at its next slice, unpins and closes what it holds, and sends nothing. The link
  forgets them at once; a key needed again later is simply sent again, and a slide waiting for a late image
  keeps waiting for it.
- **Pins are counted** (`BitmapCache.pin`/`unpin`): jobs run side by side, and one's release must not unpin
  what another still draws. A cache insert never replaces an entry a draw holds; a target another job
  prepared meanwhile is taken, not made again.
- **Timing.** Each `done` (and `warmed`) carries its lane, the time it waited (queue, fonts, turns),
  `busyMs`, the time all its slices ran on the thread (picture bands included, the slice running when the
  result is sent counted so far), and its longest slice; the link keeps per-lane p50/p95 over the last 128
  jobs and the number cancelled (`__ordo.telemetry().lanes`, the diagnostics view's `rasterLanes`). The
  draw alone is `done.rasterMs`, which health reports (below).
- **Surface.** One CPU-backed canvas: shrunk to 1x1 while a job measures its reach (so a tight sprite never
  pays for a frame-sized backing), then sized to the sprite or the frame, drawn on and taken in the same
  slice. A resize or a transfer leaves it transparent, so it is cleared only when a draw failed before
  taking it (0.2 ms at 1080p, 1.1 ms at 4K saved per job). Drawing the first opaque layer with `'copy'`
  saved nothing on this software surface (it cost 0.4-1.5 ms more), so it is not done.

**Crop-aware decode** (`apps/output/src/decode.ts`). The hub prepares pictures for a 3840 px output
(design/27 §4), so a 1080p output decodes four times what it shows. When every use of a JPEG in a job
shows it at half its size or less, the worker decodes it with WebCodecs' `ImageDecoder` at the next eighth
at or above that size (JPEG scales by 1/8 to 8/8 in its inverse DCT: a cheaper decode, not a resample),
keeps only the visible crop with a margin when that is at most half of it, and lays every target out from
where that part lies in the whole picture (`PictureFrom`, `paintPictureFrom`). Chromium may pick an eighth
below the size asked for, so the eighth itself is asked for and a smaller frame is refused. Everything else
decodes the whole file as before: PNG, GIF and WebP, a JPEG with an EXIF orientation, uses that need five
eighths or more (a 4K output, mostly), a page that is not a secure context (no `ImageDecoder`; the venue
serves HTTPS) and any failure of the scaled path. Measured in headless Chromium 153 on this 4-core
container (`pnpm --filter @ordo/output bench:lanes`), one full-frame cover photo for a 1080p output: a
3840x2160 JPEG 107 to 48 ms, its longest task 35 to 11 ms; a 6000x4000 JPEG 176 to 128 ms, longest task 46
to 22 ms. The markers of `asset.lanes.browser.test.ts` land within 0.15 px of the whole-file decode, mean
difference 0.7-1.0 of 255 (PSNR 41-50 dB; Chromium's two JPEG paths differ about that much at full size).

**Measured** (headless Chromium 153, software canvas, this 4-core container under load; `bench:lanes`, 7
runs per size, a slide with a 6000x4000 and a 4000x3000 photo and text, nothing cached, a props job sent 2
to 200 ms after it): the props bitmap reached the renderer 5.2 ms p50 (9.6 max) after it was sent at 1080p
and 25.6 ms p50 (35.5 max) at 4K, against the link's 150 ms lead: never late. The slide took 183 ms (1080p)
and 404 ms (4K) to the renderer, 18 and 116 ms of it on the thread, longest slice 15 and 41 ms. The asset
worker before M7 (one chain, `--baseline`) delivered the same props 269 ms p50 (1080p) and 299 ms p50 (4K)
after sending: 5 of 7 and 7 of 7 flips more than a frame late. `asset.lanes.browser.test.ts` checks the
deadline at 4K in CI. Again on the integrated M7 tree (sprites, lanes and health together, 2026-11-07, load
average 3 to 4): the props bitmap 2.0 ms p50 (6.0 max) after sending at 1080p and 4.1 ms p50 (25.6 max) at
4K, none late; the worker before M7 149 ms and 246 ms p50, 3 and 6 of 7 late. After the integration's
repair (decodes bounded across chains, the coverage probe in slices of its own; load average 4): 2.2 ms p50
(8.9 max) at 1080p and 4.7 ms p50 (20.3 max) at 4K, none late, longest slice 15.4 and 37.8 ms; the worker
before M7 172 and 249 ms p50, 4 and 6 of 7 late.

**Measuring on a venue machine.** The asset worker's costs are CPU costs (a software canvas on purpose), so
they are measured on the venue's presentation PC itself, with its own Chrome: on the PC (Windows: a
checkout with Node and pnpm, `pnpm install`), run
`pnpm --filter @ordo/output bench:lanes --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" --headed --runs 9 --json lanes.json`
with the machine on mains power and nothing else running, once at the start of a service day and once after
an hour of a running service (thermal state). Record the Chrome version, CPU, the props p50/max per size and
the decode table in this section. `--check` fails if any props bitmap is more than a frame late. GPU
figures (uploads, frame time) belong to the render worker and are measured by `bench:venue` ("Measuring on
venue machines" below).

<!-- m9:render-seams -->
**Seams for M9's drawers** (design/27 M9 render-seams). Each is empty, or holds only today's behaviour, until an
M9 area track registers into it, so every existing picture is drawn exactly as before (the renderer's goldens
are byte-identical, and the tests pin each seam's calls by digest against the code before it):

- **Slide prepare steps** (`apps/output/src/prepare/index.ts`): what a worker reads, decodes or lays out before it
  draws a slide, besides its pictures. The asset worker runs them in the job's lane turns (`host.slice`, a
  cancelled job stops at `host.check`), the operator's thumbnail worker at once, from one registry
  (`registerPrepareStep`), so thumbnails draw what outputs draw. Steps run in order and return the files they
  found missing, which the asset worker reports with the missing pictures. Built in: the M9 shape drawers the
  slides need (`shape drawers`, below) and the geometry files (`ShapeGeom.ref`); M9 adds table layout, warp
  faces, vector pictures and decoration files.
- **Shape dispatch** (`renderer/src/shape.ts` `drawShapeObject`): `table` → `chart` → `decor` → geometry → legacy,
  by the first of the fields the clamp kept whose drawer is registered (`registerShapeDrawer`); until then such a
  shape draws what an older build draws once it strips the field. A kind's drawer may instead be loaded the first
  time a slide holds that kind (`registerShapeDrawerLoader`: the renderer's index registers the table's, so its
  code stays out of the operator's first paint, design/24 "Bundle budget"); the workers' prepare step `shape
  drawers` and the editor canvas call `loadShapeDrawers` before they draw (the canvas draws again once loaded).
  A registered 3-D look (`registerLook3d`) resolves a plan the effect composite draws (`EffectSource.look3d`).
- **Paint hooks** (`renderer/src/text/paint.ts`): `paintRich` puts glyphs on the context through a glyph painter
  (`PLAIN_PAINTER`; upright and warp ones registered by kind) and draws its face on a face target
  (`DIRECT_TARGET`; a face sprite registered by the 3-D look, whose alpha casts the shadow and glow), chosen per
  object and independently.
- **One sprite cache** (`renderer/src/spritecache.ts`): 64 MiB for every kind of sprite (effects today; geometry,
  decorations, 3-D faces and charts in M9), least recently used first, with counted pins as the bitmap cache has.
- **Picture pipeline** (`renderer/src/picture.ts`): `PictureSource` is a canvas image or a `VectorPicture`, which
  the source step that accepts it draws wherever `drawImage` would (`registerPictureSource`); target extensions
  widen a target's key or refuse to prepare it (`registerPictureTarget`); post steps change a prepared bitmap
  after its mask's cut (`registerPicturePost`).
<!-- /m9:render-seams -->

<!-- m9:tables-render -->
**Tables** (design/27 M9, `ShapeObject.table`). The renderer draws a table object itself (`renderer/src/table/`,
registered with the shape dispatch when `@ordo/renderer/table/index.ts` is loaded: by the table's loader, or by
the prepare step below), laying its rows out from its cells' text. The prepare step `table layouts`
(`apps/output/src/prepare/tables.ts`, imported by the asset worker and the thumbnail worker) lays each table of
the job's slides out in slices of 8 ms (`prepareTableLayout`; a cell once started is finished) before the
synchronous draw, so the draw lays out nothing and no task passes design/27 §13's 50 ms; the cells' layouts
are kept by their content, so the next job, a slide sent again and the thumbnails find them. A look that does
not draw the slide as authored prepares nothing.
<!-- /m9:tables-render -->

## Frame loop

```
every rAF (render worker, via requestAnimationFrame on the OffscreenCanvas's worker scope):
  now = hubNow()
  for each layer: if pendingFlip && now + frameMs/2 >= pendingFlip.at && armed is ready: swap; pendingFlip = null
  upload, within this frame's budget, the content of flips due now that is not ready; tick those layers again
  for each video slot: present the newest frame due at now + frameMs/2 (frame selection, below)
  upload what this frame samples that changed (a refresh of the live copy, content after a device loss)
  for each video source drawn: importExternalTexture (zero copy)
  encode one render pass, from the top-most opaque full-frame layer at full weight (else from the
  background): for each layer in [background, slide, lowerThird, media, props]:
     scissor to what its sources cover; draw layer A (outgoing) and B (incoming) with crossfade weight t
  submit
  upload the rest that changed (content armed for a coming flip) in strips, within the frame's budget
  record presented++, and missed += max(0, round((now - lastFrameAt)/frameMs) - 1)
```

- Every buffer, bind group, pipeline and sampler is created at startup or at arm time.
  The loop body creates no JS objects; state lives in pre-allocated typed arrays (hot-lint).
- All 14 pipelines (single sources t, e, v; the nine crossfade pairs; the test-pixel solid; the
  unblended single t for an opaque layer, `replace-t`) are compiled at startup, before the window
  reports ready.
- Every draw is a fullscreen triangle cut by a scissor rect to what its sources can cover (a tight
  sprite's rect, a contained video's fitted rect, a scene's base and over rects and its video's
  frame, the union of both sides of a crossfade), so a lyric band costs fragments for its band only.
- Uploads (design/27 §7.3) never run in `draw`. Armed content is uploaded after the frame's submit,
  in horizontal strips (`copyExternalImageToTexture` with a source and destination origin), the
  content a pending flip waits for first, at most 8 MiB per frame (`UPLOAD_BUDGET_BYTES`, whatever
  the output's size: a 4K frame, 33.2 MB, takes four) and no further strip once the frame's copies
  took 4 ms of the render worker's CPU time (`UPLOAD_BUDGET_MS`). A flip that is already due when its
  content arrives (late content: a GO to a cue that was not armed) is held to the time budget alone,
  right after the tick (`uploadDue`): its first copy of the frame is one 8 MiB strip, which times the
  frame's copies, and the rest follows in one go when that cost says it ends within the 4 ms, else as
  many rows as do. At about 2 ms a strip (what a 1080p copy costs here and on venue machines), late
  content at 1280x720, 1920x1080, 1920x1200 (9.2 MB, common WUXGA projectors) and 2560x1440 (14.7 MB)
  flips on the frame it arrives, as before strips; at 3840x2160 it flips on the second frame, each
  frame within the 4 ms; a slower copy moves the line down (a strip that takes the whole 4 ms leaves
  the rest to the next frame). A stack is
  `ready` once its last strip is in; a flip to content that is not ready waits (counted as a late
  flip) and the previous picture stays whole, since strips only ever go into the armed stack's
  texture. The layers of one GO (flips due at the same hub time) flip together: while one of them
  still uploads, the others wait for it, so a new background never shows with the old slide for the
  frames the slide's strips take (`LayerStack.uploadWaiting`; content that has not arrived holds
  nobody, it flips late on its own as before strips). Content armed a cue ahead is uploaded long
  before its GO; content that arrives on its flip's frame and whose copies end within the time budget
  is uploaded right after the tick and flips on time. Two uploads are whole by design and do take the frame's time
  before its draw: a `refresh` of the live copy (an image that arrived after the slide was armed: it
  is on screen and must not tear; about 9 ms of CPU at 4K on SwiftShader here), and, on a new or
  rebuilt compositor (device loss, a WebGPU retry), the live stacks before its first draw; the
  armed ones go in strips again (`LayerStack.resetUploads`). `uploadMs` counts the budgeted frames
  only (below), and the whole ones are reported apart. Canvas 2D draws bitmaps directly: it has no
  uploads and no gating. `e2e/outputs.spec.ts` runs its outputs on Canvas 2D (a software adapter is
  refused, design/27 §7.2); `slide-media.spec.ts` and `pptx-media.spec.ts` force one output onto
  WebGPU on SwiftShader (`?renderer=webgpu`), so the strip path runs end to end there at 1280x720
  (every frame one strip under the 8 MiB budget). Strips of several frames, the cue's layers waiting
  for each other and the whole uploads are covered by the compositor fakes (`gpu.sprites.test.ts`),
  the compositor golden and `bench:gpu`.
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

A layer stack is what one layer shows for one cue under this output's look: one bitmap (a
picture of everything the layer draws: ADR 0013), a video slot, or a scene (a base bitmap, the
slot's video through a plane and an over bitmap, design/27 §7.2), plus the transition. A bitmap
is full-frame or a tight sprite: the bounding box of what was drawn and its offset in the frame
(design/27 §7.3). WebGPU keeps two output-sized textures per layer (one per stack, plus two
over textures once a scene with an over is offered) and uploads each stack's bitmaps into its
texture at their offsets; nothing is allocated per object. The renderer holds exactly two
stacks per layer: `live` and `armed`. Arming builds the `armed` stack; GO swaps pointers at the
scheduled frame, once the armed stack is uploaded, and begins the crossfade; the old `live`
becomes free for the next arm.

Arm sequence for a cue (asset worker, then render worker):

1. Resolve the cue under the look: which objects are drawn and with which style
   (`authored` draws every object; `lyricOnly` builds a synthetic text object from the
   lyric box text and the look's band and style, plus the next slide's text if configured).
2. The link sends one job per layer that the renderer does not hold, marked `live` or
   `armed` (and, for the cue after the armed one, a `warm` job that only prepares its
   pictures); the asset worker runs them in its raster lanes ("Asset worker: raster lanes
   and picture decoding" below). A job draws the whole layer of the cue under the look, every
   object of it in z order, onto the asset worker's software-backed `OffscreenCanvas` 2D at
   output resolution (ADR 0013) and takes it with `transferToImageBitmap`: text through the
   shared drawers (fill, padding, wrap, alignment, outline, shadow, the rich text engine),
   shapes and pictures. The canvas is the size of what the layer reaches (`slideReach` and
   the other reaches of `sprite.ts`: each object as its drawer lays it out, text's lines grown
   by 0.3 em and united with the ink its glyphs measure, a PowerPoint shape by its geometry,
   outline and effect layers (`geomShapeReach`), its effects, turned with its box; M9's
   fields are known too: a table by its registered drawer's reach (`tableReach`: its grown rows,
   lines and each cell's text), a chart or decoration by its drawer's reach once one is
   registered and by its legacy shape until then, warped, vertical or 3-D text and 3-D or
   vector pictures as their plain text and box while no painter, face target or picture look
   is registered for them; an object such a hook draws reaches the frame), cut
   to the frame and drawn at that offset; the sprite's origin is aligned to a multiple of
   8 device px (`SPRITE_ALIGN`), since Chromium dithers gradients by device position and a
   sprite at any other offset differed from the full-frame draw by a level on thousands of
   gradient pixels;
   when that is most of the frame (over 80 %), or unknown (a slide's PowerPoint picture, an
   object with fields the reach does not know, a logo), the canvas is the frame. A drawing
   that touches the sprite's edge ring is drawn again full-frame, so a sprite never cuts what
   is drawn (`drawSprite`). Text is measured on the canvas shrunk to 1x1, so a sprite never
   pays for a full-frame backing. Fonts come from the service cache and are loaded into the
   worker's `FontFaceSet` at manifest time; a job waits for the font loads sent before it, so
   arm never draws a fallback for a face that was on its way. The font resolver (design/27
   §10) registers each family's faces under an internal name never resolved before, so a
   face that loads late (a failed read retried with backoff, a font added during the
   service) is used by the next draw without restarting the worker; the worker then reports
   the family `ready` and the link draws again in place the held slides that fell back for
   it.
3. Pictures are read from OPFS (or the hub) and decoded off the worker's thread; a picture a
   slide draws unrotated is resampled once into an sRGB bitmap of its device rectangle and
   copied 1:1 (design/27 §7.1), from a decode of only the part and scale its uses show where
   that is cheaper (crop-aware decode, below). Decoded pictures are kept in a 256 MiB LRU by
   file and target size, pinned while a draw holds them.
4. Post the bitmap (and its offset; `opaque` for a full-frame bitmap known to have no
   transparency: a cover-fitted JPEG or PNG without alpha, read from the file's header, or
   the props logo over an opaque clear colour) to the render worker, which uploads it into
   its stack's layer texture (`copyExternalImageToTexture`, a sub-rect copy at the
   sprite's offset) in strips, outside `draw` (Frame loop above). A stack is uploaded once
   per content (`Stack.version`), and again only after a device loss. An opaque layer at
   full weight is written without blending and hides everything under it: neither the
   clear nor the lower layers are drawn (WebGPU `replace-t`, Canvas 2D `'copy'`).
5. For video (background or media cue), the main thread creates a `<video>` for the
   armed asset from the OPFS file (`URL.createObjectURL(file)`), preloads to the first
   frame (`preload=auto`, wait for `canplaythrough` and one `requestVideoFrameCallback`),
   and pauses. Its frames are delivered to the render worker as `VideoFrame`s from the
   `requestVideoFrameCallback` loop; the worker imports them with
   `importExternalTexture` each frame.
6. Report `output.armed { ok: true }`. Any failure reports `ok: false` with the error
   and the previous live stack stays.

Memory bound: two stacks per layer (live and armed) plus a one-deep queue for content that
arrives while the armed stack is busy (the outgoing side of a fade, or the target of a flip
not yet due; the latest wins), so at most three pictures per layer, six for scenes (base and
over). The host keeps six media elements (two background, two media, two audio slots); the
renderer presents at most `MAX_VIDEO_SLOTS` (4) video slots, two newest frames each
(`FrameRing`).

## Video playback

- On GO the main thread calls `video.play()` at the scheduled time (it is already decoded
  to its first frame, so the first frame is presented on the GO frame).
- `requestVideoFrameCallback` posts each new frame (`vframe`, `timestamp` = `mediaTime`),
  tagged with the slot's load generation and, while the element plays, its clock: the
  transport's `startedAt` (hub time of media time 0) and the clip length when it loops.
  The render worker keeps the two newest frames per slot (`FrameRing`,
  `packages/renderer/src/frame-ring.ts`) and before each draw presents the newest frame whose
  timestamp is at or before the media time due on the vsync being drawn,
  `now + frameMs/2 − startedAt` (modulo the length when looping; the half-frame rule of
  flips). An element a little ahead of hub time is held back to the hub's frame; one
  behind shows its newest frame, and older (late) frames are dropped. Without a clock
  (paused, not started), with one frame only, or when the newest frame is more than
  250 ms from the expected time (a seek the clock has not caught up with), the newest
  frame shows; an older frame is never shown across a seek, a loop's wrap or a reload.
  Frames are closed when evicted by a newer one, when a frame of another generation
  arrives, on `vclear` and when the engine stops (unit tests count every open and close).
- The audio-master output routes the video element through the audio engine
  ([design/18](18-audio-engine.md)); other outputs mute their copies.
- Looping uses the `loop` attribute; `ended` on a non-looping cue sends `media.ended` to
  the hub (audio master only), and the look's `onEnd` rule applies.
- Alpha video (VP9 WebM with alpha) comes through the same path: the full-frame video
  shader weights by the external texture's alpha. External textures may not keep alpha on
  every GPU (design/27 §7.2), which is why a video in a slide's box never relies on it (a
  "video present" bit decides) and why an alpha clip is checked by eye on each venue GPU
  ("Measuring on venue machines"); where alpha is dropped the clip covers the layers under it.

## Text

Text is rasterized at arm time (ADR 0004). Golden images of the rasterizer and every
look live in `packages/renderer/golden/` (`pnpm --filter @ordo/renderer golden`, see
design/23). The rasterizer is in `packages/renderer` and
runs in the asset worker. Its output for a layer is one bitmap, full-frame or the tight
sprite of what the layer reaches, at its offset; the render worker composites it like any
image. `sprite.browser.test.ts` draws bands, rich and legacy text, shapes, the lower third,
props and scene parts both ways in headless Chromium and checks that each sprite at its
offset is the full-frame picture. Word wrap uses canvas
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
stacks. A software adapter (`isFallbackAdapter`, SwiftShader) counts as unavailable
(design/27 §7.2): the engine probes the adapter before it binds the canvas, so this fallback
needs no fresh canvas. The output URL's `?renderer=webgpu` keeps WebGPU on such an adapter
(tests); `?renderer=2d` forces Canvas 2D. A canvas keeps its first context kind, so every
switch between the two needs a fresh canvas: the worker asks the main thread (`needCanvas`),
draws on the new one, and the main thread puts it on screen only when the worker reports
`ready` or `restored` on it.
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
and a GO live discards any preview. The operator sends only the previewed slide's section
with the presentation-level fields (`previewSlice`, design/27 §3.4): the slide after it
travels too for the next-slide band, and a section over 1 MiB is cut to those two slides.

## Looks

The look is loaded at startup, on every hub `welcome` (a restarted live process may have dropped a
settings delta) and on a `library.delta` that changes settings, fonts or media. Fetches may overlap; an
answer older than one already applied is dropped, so a slow stale answer never overwrites a newer
config (review 2026-11-04 items 4 and 21). Lyric-only looks typeset the lyric
text into the band at arm time; the band is a `Box` in logical 1920x1080 space, and the
asset worker rasterizes it at the output's device resolution (`scale = width / 1920`), so
nothing is scaled on the GPU: the compositors copy every bitmap 1:1.

## Props and timers

Clock, countdown and elapsed timers are rasterized once per second by the asset worker,
as a tight sprite of the props it draws (the logo covers the frame: full-frame, opaque over
an opaque clear colour); the render worker swaps the layer's content atomically on the
second's flip, and a sprite that fits the frame's upload budget flips on its frame. Props in
opposite corners make one box over most of the frame, which stays full-frame. Messages are
rasterized on send. This keeps the frame loop free of text work. The stage look also
renders the live video's remaining time (`videoRemaining`, prd/04) as a prop. Props jobs
go first in the asset worker's raster lanes, so a slide that decodes meanwhile delays a
props bitmap by at most one slice (above); a props job of an earlier second still waiting
is cancelled by the next one.

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
2. Create the WebGPU device, compile all pipelines, allocate buffers and the layer textures.
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
other face) and characters no face it has covers (`health.fontCoverage`, "Health message"). Property tests (`plan.fuzz.test.ts`) feed random slides and looks within and
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

The link worker assembles a `health` report once a second (`buildHealth`, `packages/renderer/src/health.ts`,
and `LinkCore.buildHealth`); the hub keeps the latest per output and fans it out as `health.summary`
(ADR 0013). Every field is in `OutputHealth` (`packages/protocol/src/index.ts`):

```ts
{ t: 'health', presented, missed, longTasks, lateFlips, armed, armedOk, armError, live, cache: { ready, total },
  gpuLost, videoDropped, fps, audio, meters, mediaPositionMs, mediaDurationMs, error, appVersion, bus,
  recentLog, compositor, gpuMB, rasterMs: { n, p50, p95, max }, rasterHeavy, rasterAlarmMs, uploadMs, wholeUploads: { count, maxMs },
  budgets: { rasterP95Ms, uploadMs, gpuMB }, alarms, mainThreadStallMs, workers, quarantined,
  fontFallbacks, fontCoverage: { chars, count, scripts }, cacheRepairs, busTransport }
```

`videoDropped` comes from `video.getVideoPlaybackQuality().droppedVideoFrames`, `mainThreadStallMs` from the
link's watchdog ticks, `workers [{name, generation, restarts, lastReason, gaveUp}]` from the supervisor,
`quarantined {count, items}` from the error budgets, `busTransport` ('port' | 'window') from the fallback
bus.

**Performance (design/27 §13, M7).** Measured where the work happens, checked against the budgets of the
output's size:

| Field      | Measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Budget (`perfBudgets`)                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `rasterMs` | p50, p95 and max of the asset worker's slide draws over the last 64 slides (`done.rasterMs`: the job's synchronous draw on the worker's thread, from the surface to the picture taken, pictures prepared; `done.ms`, the whole job with its reads and decodes, from a worker that does not report it). Props, lower thirds and image cues do not count.                                                                                                                                                   | p95 ≤ 10 ms at 1080p and below, 30 ms at 4K, by pixel count between                                                                       |
| `uploadMs` | the render worker's telemetry `uploadMs`: its CPU time in texture uploads within the per-frame budget (strips of armed content), the longest such frame of the last minute (at most 128 of them), as the WebGPU compositor measures it (absent on Canvas 2D, which uploads nothing). Uploads whole by design (a `refresh` of the live slide, recovery after a device loss or a WebGPU retry) are not in it: `wholeUploads` counts them, with the longest of the last minute, for the tech, never an alarm | ≤ 4 ms per frame                                                                                                                          |
| `gpuMB`    | the compositor's layer and scene textures (WebGPU only; since M5): ordo's own allocation, a fixed function of the output's size and of the scenes that need over textures                                                                                                                                                                                                                                                                                                                                 | shown against 400 MB at 4K (five layers of two textures and the two over textures), by pixel count to the next MB: 100 at 1080p; no alarm |

`budgets` carries the three for the output's size; the output computes them because only it knows its size.
`alarms` lists the budgets passed now: `raster` (only once 20 slides were drawn: the first draws pay for
compiling and cold caches) and `upload`. The `raster` alarm reads the slides within the raster budget by
their content: a slide job whose drawing estimate (`rasterEstimateMs`, the units its drawing budget charges)
is past 80 % of the p95 budget at the output's size comes back `done.heavy` (`heavySlide`, design/27 §13's
named exception: traced decorations near the drawing budget take 45 to 48 ms at 4K on the bench machine,
held to the 50 ms of a task), and the link keeps its time in `rasterMs` but out of the alarm's window;
`rasterHeavy` counts such slides in the window, and the diagnostics and the alarm's detail name them.
<!-- m9:render-seams -->
_M6 merge re-review (M9 wave 1)._ The estimate counts what a slide draws besides its geometry: the effect layers
copied, the glyphs drawn blurred, the characters, the pictures copied or resampled, and the effect sprites the
draw had to make (`effects.ts` `effectWork` across the job), with constants fitted on 500 slides of 31 converted
decks (design/27 §13); the report carries the figures the alarm read (`rasterAlarmMs`, when heavy slides are
left out) and the alarm's log line and the operator's detail quote them, with every slide's p95 beside.
<!-- /m9:render-seams -->
GPU memory has none: `gpuMB` counts only the textures ordo
allocates, which the budget is derived from, so it cannot pass it at any size the app picks, and the GPU's
real pressure (video frames, the swap chain, other programs, an iGPU's shared memory) is not observable from
a page. The alarms are plain strings, so an alarm a newer output adds never fails an older hub's parse of the
whole report. An alarm that starts or ends writes a line to the window's log (`recentLog`), with the figures:
`performance alarm at 3840x2160: texture upload in strips 5.5 ms per frame (last minute) is over the 4 ms
budget`. The upload figure is a time window, so a slow frame stops counting a minute later whether or not
anything uploads meanwhile.

**Fonts.** `fontFallbacks` are families drawn text asked for that are not loaded (drawn in the fallback
font). `fontCoverage` are characters drawn this service that no face the output has covers, so the
machine's own fallback face drew them (another shape on every computer, or a box), with how many there are
and their scripts (ISO 15924; Zsye emoji, Zyyy symbols). The asset worker wraps its surface's `fillText` and
`strokeText` (`GlyphCoverage.instrument`, `packages/renderer/src/text/coverage.ts`), so the drawers are
unchanged, and after each job's picture is sent probes each new character once per stack, style and weight,
in slices of its own of 32 characters (`GlyphCoverage.probeSome`; 40 new Han characters cost about 1.5 ms,
which a props job then never waits behind; characters seen before are lookups, no slice):
measured with the stack's shipped faces (the resolver's internal names) before ordo's blank face, and with
the blank face alone. The blank face (`text/blankface.ts`, built in memory and registered in the worker's
face set under a name no font string holds) maps every code point to an empty glyph of no advance, so where
no shipped face has the glyph the stack equals the blank face alone exactly (advance and ink box), and the
computer's own fonts, whose answer depends on what the computer has, are never asked. Nothing is probed
before the blank face has loaded; default-ignorable characters are never reported. `self.fonts.check` cannot
tell: it says whether faces have loaded, not whether one has the glyph. Text whose family is not loaded is a
font fallback and is not probed glyph by glyph. Verdicts are kept until the faces change; a face that loads
draws again in place the held slides that had uncovered characters, as for a fallback family. Each new
character is logged once per service with its code point (`no font on this output has 1 character(s) of sl|…:
☧ (U+2627; Zyyy)`). `coverage.browser.test.ts` draws legacy and rich text with DejaVu Sans in a worker of
headless Chromium and requires exactly DejaVu's missing characters, whatever fonts the machine has;
`coverage.fonts.browser.test.ts` runs the same cases under two fontconfigs of its own (no face for the
characters, and generated CJK and Thai faces that the generic families resolve to).

**In the operator** (`apps/operator/src/lib/health.ts`, `outputIssues`). Each issue has a level. A performance
alarm is a warning: the output's dot in the top bar turns amber, its tooltip says what it means in plain
words, and a "things to check on the screens" tag opens Diagnostics. A missing font and characters without a
font are notes: nothing a volunteer can do during the service, so the dot stays as it is and the top bar says
nothing; the dot's tooltip and Diagnostics list them for the tech to fix before the next service. Each issue
has a label for the volunteer at the desk (what the audience may notice and whom to tell, no figures: "This
computer is slow to send new slides to the screen, so motion may stutter at a change.": the figure is the
render worker's CPU time, so it does not blame the graphics card) and a detail for the tech, with the figures
and the budget ("Texture upload in strips up to 5.1 ms of the render worker's time in one frame over the last
minute; budget 4 ms", and the whole uploads apart). Diagnostics has a "Performance and fonts" table per
output: slide drawing p50 / p95 and upload per frame against their budgets (amber when over), the whole
uploads, GPU memory against its budget (for information), the fonts, and the issues with their details. The
output's own diagnostics overlay (Ctrl+Shift+D) shows the same figures.

### Measuring on venue machines

The container this is built in has no GPU: WebGPU runs on SwiftShader, which checks correctness (the
compositor golden, the e2e specs) but measures the CPU. Real figures come from the venue's machines, measured
with their own Chrome:

1. On the machine (the Windows 11 presentation PC with its iGPU; a PC with a discrete GPU; a Mac): Node 22
   and pnpm, a checkout, `pnpm install`, Google Chrome installed. Mains power, other programs closed, the
   venue display connected at its native resolution.
2. From the checkout: `pnpm --filter @ordo/renderer bench:venue` (Chrome visible on that display and kept
   in front for the live run; on Linux add `--channel chrome`). One command records:
   - the machine (OS, CPU, memory, Chrome, display and refresh) and the WebGPU adapter (vendor, architecture,
     whether it is a software fallback, timestamp queries);
   - one full-frame copy at 1080p and 4K (CPU ms of the call, ms until the GPU has done it) and five
     full-frame layers composed in one pass (`venue.page.ts`);
   - the compositor as the render worker drives it (`gpu-venue.page.ts`; `bench:gpu` runs this part alone,
     for tuning the strips): a full-frame bitmap and a lyric-band sprite uploaded in one copy, in the
     default strips and in eighths of a frame (CPU ms per frame, frames per upload, and the latency until
     the queue reports the copies done beside the same round trip of an empty submit: done minus empty
     bounds the copies' GPU time, the fence and IPC excluded); five layers composed full-frame, as sprites,
     and as sprites over an opaque background (the replace path; GPU ms from timestamp queries; every layer
     is live first and each timed frame must encode five layer draws, or the run stops: a pass that draws
     nothing would time a clear); and a live run of the engine with and without strips, drawing on a canvas
     the page shows and transfers to the worker as the output does (frames presented and paced by the
     display), with a late flip each second (its content arriving after its flip time, a GO to a cue that
     was not armed): missed frames, late flips, frames from the late content's arrival to its flip, rAF
     interval, `uploadMs`. The compose figures are checked against `venue.page.ts`'s own five-layer pass
     (the same order of magnitude, or the row is flagged);
   - the asset worker's slide raster on this CPU (`bench:slides`: sermon text over a photo, a lyric with a
     shadow, a table, a scene slide, p50/p95 at 1080p and 4K, drawn as the worker draws them and drawn
     full-frame, and a blank full-frame job: the cost of a fresh frame-sized bitmap);

   and says which figures are over their budgets: slide raster p95 (10 ms at 1080p, 30 ms at 4K, 12 ms for
   text over a photo at 4K), the 4K upload in strips per frame (CPU p95, and done minus empty p95, ≤ 4 ms)
   and each 4K composition (GPU p95 ≤ 4 ms). `--headless` skips the live run unless `--live <s>` is given
   (it then checks the script only: a headless page is not paced by a display).
3. Results go to two places: the JSON it writes (`venue-results/<host>-<date>.json`; commit it as
   `docs/measurements/venue/<machine>-<date>.json`), and the table below, one row per machine, pasted from
   the line it prints at the end. Measure once at the start of a service day and once after an hour of a
   running service (thermal state), and again after a Chrome or driver update. If the 4K upload in strips
   is over 4 ms of GPU time per frame, lower `UPLOAD_BUDGET_BYTES` (`gpu.ts`) until it is not, and record
   both runs.
4. During a rehearsal, read the operator's Diagnostics "Performance and fonts" table (or download the
   operator log, which carries every output's health): the live `rasterMs`, `uploadMs` and `gpuMB` of the
   real outputs, and any alarm.

The "one full-frame copy" column is the worst case, which the render worker no longer does for armed content:
it uploads in strips within its per-frame budget (the strips column). An alpha video should be checked by eye
on each venue GPU (external textures may not keep alpha, design/27 §7.2).

The procedure needs a checkout, Node, pnpm and `pnpm install` on the presentation PC, which is heavy for a
church's tech. A bench page the hub serves, running `gpu-venue.page.ts` and the slide raster in the output's
own browser with nothing installed, would replace it; it is a follow-up, not built, so for now the tech
team runs the procedure once per machine.

| Machine                    | GPU | Slide raster p50 / p95 ms at 1080p: photo, lyric, table, scene; at 4K: the same | One full-frame copy, done p50 1080p / 4K | 4K upload in strips per frame p95, CPU / GPU | 4K compose GPU p95: 5 full-frame / sprites / replace | Live 4K: missed, late flips |
| -------------------------- | --- | ------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------- | --------------------------- |
| (venue PC, to be measured) |     |                                                                                 |                                          |                                              |                                                      |                             |

Measured in this container (2026-11-07, after the integration's repair; Chromium 153 headless, 4 shared
cores at a load average of 3 to 6, CPU canvas; `bench:venue --swiftshader --live 2`, so every GPU column
is SwiftShader's CPU, not a venue figure, and the live run is headless, not paced by a display):

| Machine                            | GPU               | Slide raster p50 / p95 ms at 1080p: photo, lyric, table, scene; at 4K: the same                  | One full-frame copy, done p50 1080p / 4K | 4K upload in strips per frame p95, CPU / GPU (done − empty) | 4K compose GPU p95: 5 full-frame / sprites / replace | Live 4K: missed, late flips |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- | --------------------------- |
| container, Xeon 2.3 GHz, 4 threads | SwiftShader (CPU) | 4.6 / 6.1, 10.7 / 13.0, 3.2 / 5.6, 7.0 / 8.8; 17.2 / 24.8, 38.0 / 45.7, 10.0 / 11.2, 32.5 / 34.6 | 82.3 / 338.5 (CPU)                       | 2.3 / - (SwiftShader's latency, not GPU time)               | 361.1 / 182.0 / 168.8 (CPU)                          | - (headless)                |

Read there:
- Text over a photo is within its budget at 1080p (p95 6.1 ms) and over the M7 exit's 12 ms at 4K (p50
  17.2, p95 24.8 ms; the load moved the p95 between 19 and 25 ms over the day). An imported slide whose photo
  is one of its objects reaches the whole frame, so it is drawn full-frame, and a blank full-frame job alone
  costs 9.9 ms p50 at 4K here (2.6 ms at 1080p): a fresh 33 MB software bitmap per job, its pages faulted
  in and cleared, then the transfer. The photo's 1:1 copy, the dimming rectangle and the text add about
  7 ms. Meeting 12 ms here needs the photo not to be copied into the slide's bitmap at all (its prepared
  bitmap sent to the renderer as a layer of its own, with the text as a sprite over it: not built), or a
  venue CPU that faults pages in faster; the venue PC's `bench:venue` row says which.
- The lyric with a shadow (six bold lines in the default lyric style) is over its p95 budget at 1080p (13.0
  against 10 ms) and at 4K (45.7 against 30 ms), and the scene (a title and a footer with shadows over a
  video) at 4K (34.6 against 30 ms): the canvas shadow is drawn per glyph run on the software canvas. The
  lyric's lines with their shadow reach 84 % of the frame, over `SPRITE_MAX_SHARE`, so it is drawn
  full-frame; the scene's over is a sprite, but its title and footer span the frame's height. The effect
  sprite cache of design/27 §7.5 is what would shrink both. The table is within budget at both sizes, now a
  sprite of 77 % of the frame.
- On the render worker's CPU, a 4K full frame uploaded in its default strips (8 MiB a frame) costs at most
  2.3 ms per frame (p50 1.9) over four frames, against 8.9 ms p50 (12.6 p95) in one copy: within the 4 ms
  budget. A 1080p frame is one strip (1.8 ms p50, 2.1 p95), so late content still flips on the frame it
  arrives (the live run: one frame from the late content's arrival to its flip at 1080p, with and without
  strips). A due flip is now held to the time budget alone (above), so late content at 1920x1200 and
  2560x1440 also flips on the frame it arrives, and at 4K on the second (`gpu.sprites.test.ts` at 2 ms a
  1080p copy; this run measured before that change). The live run reports late content that never flipped
  as "never flipped (n=0 of N)", and on a shown window `bench:venue` counts that, and a run that presented
  under half its seconds at the display's refresh (a hidden or throttled window), as over budget. The compositions now draw what they time (five layer draws a frame): 341.8 ms p50 for five
  full-frame layers at 4K on SwiftShader, against venue.page's plain pass of 208.6 ms, the same order. The
  GPU's own times are SwiftShader's here and are the venue row's to give.

CPU-side costs of tight sprites (`bench:sprites`, the asset worker's raster and the Canvas 2D compositor,
same run and machine; each job draws a slide of its own, made fresh, so neither layout memo holds it: the
sprite's reach lays it out and its draw reuses that layout, as the asset worker does; read the ratios, not
the absolute times):

| Measurement                                                                              | 1920x1080                | 3840x2160                 |
| ---------------------------------------------------------------------------------------- | ------------------------ | ------------------------- |
| Lyric-only band (legacy text), full-frame / sprite, p50                                  | 3.8 / 1.6 ms             | 24.5 / 13.6 ms            |
| Lyric-only band (rich source), full-frame / sprite, p50                                  | 3.9 / 1.8 ms             | 25.9 / 14.4 ms            |
| Lower third, full-frame / sprite, p50                                                    | 3.2 / 0.5 ms             | 10.2 / 1.3 ms             |
| Authored title (rich), full-frame / sprite, p50                                          | 3.5 / 1.3 ms             | 23.3 / 13.0 ms            |
| Six-line authored lyric (rich, regular weight), full-frame / sprite, p50                 | 7.0 / 4.9 ms             | 33.0 / 26.4 ms            |
| Bytes uploaded, band sprite against a full frame                                         | 1.6 / 8.3 MB             | 6.2 / 33.2 MB             |
| Canvas 2D frame of five layers, full-frame / sprites, p50                                | 4.1 / 1.4 ms             | 23.0 / 5.8 ms             |
| Render worker CPU per frame uploading a full frame, one copy / default strips, p50 (p95) | 1.5 (3.9) / 1.8 (2.1) ms | 8.9 (12.6) / 1.9 (2.3) ms |

The reach of text is its laid-out lines (the box itself is not painted) grown by 0.3 em for glyph overhang,
united with the ink each line or glyph run measures (`TextMetrics.actualBoundingBox*`), and grown by its
effects, so the authored lyric in regular weight is now a sprite of 46 % of the frame (it was full-frame
with a margin of one line height). The 0.3 em is not a bound: a tone mark stacked over a circumflex on a
Vietnamese capital reaches 1.11 em above its baseline, 0.46 em above its line box at a line height of 0.7,
and lies wholly outside the 0.3 em, where the sprite's edge ring cannot see it (only drawing that crosses
the ring sends a layer back to full-frame); the measured ink holds it (`sprite.browser.test.ts`: Vietnamese,
Thai, Arabic, Devanagari and Burmese at line heights 0.7 and 0.35, legacy and rich text). The legacy rows include the layout memo (`layoutText` per context, keyed
by every input and the font generation): the sprite's reach lays the text out once and the draw reuses it.
A layout carries the CSS font and letter spacing it was measured in, and `drawText` sets both from it, so
a layout from the memo draws in its own font whatever the context's state (a canvas resize resets it).
