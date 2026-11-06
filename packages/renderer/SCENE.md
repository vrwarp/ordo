# Media playing in place (M5 wave 1): contracts and work split

PowerPoint-style video and sound inside a slide: an `ImageObject` with `play` plays its clip in its box, at
its z-order (crop, rotation, flips, rounded or elliptical mask), and `Slide.audio` plays a sound that can
go on across N shown slides. The spec is [design/27](../../docs/design/27-pptx-native-renderer.md): the
Decisions, §3.1 (`Play`, `SlideSound`), §3.3 (runtime types), §7.2 (scene stack), §8 (media playable in
place), §13 (budgets), §14 items 5, 8 and 12, §15 M5. This wave builds the runtime for slides authored in
ordo's editor; extracting clips from .pptx files is a later wave (`packages/pptx-scene`, the import job and
`tools/pptx-fidelity` are out of scope).

## What the scaffold provides (shared contracts)

Change these only together with every item that uses them.

| Contract | Where |
|---|---|
| `Play`, `SlideSound` zod schemas; `ImageObject.play`, `Slide.audio` (`MediaOnEnd` moved above them) | `packages/domain/src/schemas.ts` |
| `Cue.mediaObjectId`, `mediaStart`, `mediaShowWhenStopped`, `slideAudio`; `MediaContent.objectId`; `AudioContent.untilCue`, `slideOwned` (`Cue.hidden` is M3's) | `packages/domain/src/live.ts` |
| `playingObject(slide)` (first `ImageObject` with `play`), `slideMediaIds(slide)` (what a shown slide plays, optional at goLive), `stillFile(m)` (image itself, video's poster) | `packages/domain/src/resolve.ts` |
| `clampPlay`, `clampSlideSound`; `clampSlide` keeps both | `packages/renderer/src/clamp.ts` |
| `sanitizePresentation` bounds both (`sanitizeSlideMedia`) | `packages/importers/src/sanitize.ts` |
| `SRC_SCENE = 3`; `Stack.over`, `Stack.plane` (pre-allocated, copied with `set()`), `Stack.videoGen`; `StackContent.over/plane/videoGen`; `LayerStack` carries and releases them | `packages/renderer/src/stacks.ts` |
| Plane encoding (`encodePlane`, `planeForward`, `planeSample` reference) and the base/over split (`splitScene`, `objectBounds`, `rotatedBounds`) | `packages/renderer/src/scene.ts` |
| `VideoFrames.gen` (frameGen per slot); `RenderEngine.setVideoFrame(slot, frame, gen)` | `compositor.ts`, `engine.ts` |
| `ToRender 'vframe'.gen`; `AssetToRender` scene fields; `AssetJob 'slide'.video`; `SlideDesc.video`; `MediaDesc.inSlide` | `messages.ts`, `plan.ts` |
| `MediaCommand 'load'.gen`: the link sends `SlotMirror.gen`, the host tags every `vframe` of that load with it, the render worker stores it | `apps/output/src/host-protocol.ts`, `link-core.ts`, `host.ts`, `render.worker.ts` |
| The render worker passes `SRC_SCENE` content from the asset port through to the engine | `apps/output/src/render.worker.ts` |
| `IngestOpts.trim` (type only) | `apps/hub/src/media/service.ts` |

Nothing produces the new fields yet, so behaviour is unchanged: the compositors draw an `SRC_SCENE` stack's
base as a bitmap until items B and C land, and every seam below is a stub with today's behaviour.

### The plane (16 floats)

| Floats | Content |
|---|---|
| 0..5 | inverse affine `a, b, c, d, e, f`: frame `u = a·x + c·y + e`, `v = b·x + d·y + f` from device px; rotation (clockwise about the box centre, as the Canvas 2D drawers) and flips folded in |
| 6..9 | `u0, v0, u1, v1`: texture UV at frame (0, 0) and (1, 1), linear between; crop and fit folded in; UV outside 0..1 is transparent |
| 10 | mask kind: `MASK_RECT` 0, `MASK_ELLIPSE` 1, `MASK_ROUND` 2 |
| 11, 12 | rounded-rect corner radii in frame units x, y |
| 13 | opacity |
| 14 | AA width in device px (1); per-axis widths in frame units are `aa·hypot(a, c)` and `aa·hypot(b, d)` (no derivatives) |
| 15 | flags: `PLANE_HAS_OVER` 1 (set by `encodePlane`), `PLANE_VIDEO` 2 (set per frame by the compositor in its own copy, only while `video.gen[slot] === stack.videoGen` and the slot has a frame) |

`planeSample(plane, x, y)` is the reference for what both compositors draw at a pixel centre: the weight is
the mask's coverage within the source, times opacity. Rect masks take, per axis, the nearer of the mask edge
and the source edge, and multiply the axes; rounded and elliptical masks take the smaller of their coverage
and the source's. Write the WGSL and the Canvas 2D path to match it.

The frame is the object's box, except for fit `contain` with a positive crop on the letterboxed axis: the
frame then shrinks to the fitted picture on that axis (exact for rect masks, approximated radii for rounded
ones; an ellipse keeps the box frame). Known limitation: a clip with alpha shows the poster in base through
its transparent parts.

### The split

`splitScene(objects, playIndex, { showWhenStopped, bounds })`: base = the objects below the playing one, the
playing one (its poster) unless `showWhenStopped === false`, and the upper objects that overlap neither the
video nor anything already in over; over = the upper objects that overlap the video, or overlap an object
already in over (so z order holds where they meet outside the video). Overlap uses axis-aligned bounds
widened by effects; text that overflows its box needs measured bounds (`bounds` callback, item E).

## Items (each on its own branch from the scaffold)

**(A) domain-reducer.** `packages/domain` `cues.ts` (`slideCueMedia` stub: the cue fields, `untilCue` counted
over shown slides of the same item, only for ids in `resolved.media`), `resolve.ts` (`referencedMediaIds`
adds `slideMediaIds`), `goLive.ts` (those ids are optional: a clip still processing or failed is left out with
a degraded note "video still processing; showing its poster; Go live again once it is ready"; goLive is
never refused for it). `packages/live-state` `index.ts` (`slideMediaLayer` and `slideAudioLayer` stubs per
§8 "Reducer": video with `objectId`, `state` paused for click start; slide-owned sound never restarted while
playing with the same cue and media; cleared when the live cue leaves `[cueIndex, untilCue]`;
`clear('slide')` clears slide-owned media; onEnd 'advance' unchanged), `invariants.ts`. Tests per §14.8.

**(B) gpu-scene.** `packages/renderer/src/gpu.ts`: 13 pipelines (`t e v`, `tt te tv et ee ev vt ve vv`,
`solid`) compiled before ready; uniform `{rectA, rectB, p, color, planeA[4], planeB[4]}` = 192 B in the 256 B
slots; one scene shader `c = base; if (video) c = video over c; if (hasOver) c = over over c`, crossfades
stay `mix(a, b, t) · opacity`; over textures allocated in the offer path on the first scene that has one
(never on a flip), else a 1x1 transparent texture; a 1x1 placeholder `VideoFrame` made at startup for
bindings; the video-present bit from `f.video.gen`; `drawLayer`/`writeRect`/`writePlane` `/* @hot */`.
Device loss re-uploads base and over. The compositor golden of §14.5 (SwiftShader WebGPU against Canvas 2D:
masks, crops, rotation, crossfade midpoints, stale generation and no frame show the poster).

**(C) canvas-scene.** `packages/renderer/src/canvas2d.ts`: per scene stack `drawImage(base)`; when the video
is present `save`, `setTransform(planeForward(plane))`, `clip(mask Path2D)` (built in the offer handler, not
per frame), 9-argument `drawImage(frame, crop…)` in frame units, `restore`; then `drawImage(over)`. The exact
'lighter' crossfade is unchanged.

**(D) link-arming.** `packages/renderer/src/plan.ts` (`MediaDesc.inSlide` when the media content has
`objectId`, its cue is the slide layer's cue and the look's slide mode is `authored`: media key '' with the
desc kept; `SlideDesc.video`), `apps/output/src/link-core.ts` (arm `inSlide` clips on every output, muted
unless the audio master, with `render: false` so `armVideo` posts no `SRC_VIDEO`; the `slideVideo` stub: a
synchronous `pair.pick` and the slot's `gen`, job posted at once, re-posted with `refresh` once a slot is
armed; `vclear` sender when the media layer clears; `showWhenStopped: false` sends `vclear` while not
playing), `host.ts`, `media.ts`, `host-protocol.ts`, `render.worker.ts`, `engine.ts` frame generations.

**(E) asset-scene.** `apps/output/src/asset.worker.ts` (`sceneParts` stub): with `job.video`, find the object,
`splitScene` with measured text bounds, draw base and over (null when empty), `encodePlane` at the output
scale with the poster's size, answer `SRC_SCENE` with `videoSlot`/`videoGen` from the job. Video
ImageObjects draw their Media's poster on outputs: `slideImages` (link-core) maps a video to
`stillFile(m)`; the operator thumbnail worker does the same.
Done: `rasterScene` and `sceneSlides` in `scene-raster.ts` (the worker's `sceneParts` calls them on its
surface, `transferToImageBitmap` as the take); text is measured with `layoutText`, and text using rich
text fields that can draw past it (M2 runs, paragraph styles, the office line model, insets, no wrapping)
counts as covering the whole frame until the measure uses the M2 layout. The plane uses the drawn poster's size; without a poster
the clip is stretched until the slide is drawn again with it. The operator's `stillHash` is `stillFile`.
Pixels: `scene-raster.browser.test.ts` (headless Chromium, skipped without one).

**(F) frames-uploads.** `packages/renderer/src/engine.ts`: a 2-deep frame ring per slot presenting the newest
frame whose timestamp is at most the expected media time (hubNow − startedAt, modulo the duration when
looping); uploads leave `draw()`: `offer` queues them and the frame loop drains the queue after submit.

**(G) hub-media.** `apps/hub/src/store.ts` (`sniff`/`EXT_KIND`: ASF `30 26 B2 75 8E 66 CF 11` for WMV/WMA,
MPEG-PS `00 00 01 BA`, AIFF `FORM....AIFF`), `media/service.ts` and `media/ffmpeg.ts` (`IngestOpts.trim` cut
in the delivery transcode, `-ss`/`-to` before the H.264/AAC encode; dedup keys on hash plus trim, an optional
`Media.trim` may be added to the schema for that; `measureLoudness` for video soundtracks, recorded in
design/18 as a product change).

**(H) editor.** `apps/operator`: `ObjectPanel.tsx` play options for a video object, `SlidePanel.tsx` slide
sound, 'Add video to slide' (an ImageObject showing the video's poster with `play`), image pickers accept
images only, a `SlideGrid.tsx` tag for slides with video or sound.

## Rules for every item

- Read §7.2 and §8 in full. Legacy behaviour stays unchanged for slides without the new fields.
- `/* @hot */` frame-path code stays allocation-free (`hot-lint.test.ts`); renderer goldens stay unchanged.
- Additive, minimal edits in shared files (`schemas.ts`, `clamp.ts`, `text2d.ts`): M1 and M2 change them
  on other branches.
- Checks: `npx biome check --write <paths>`, `npx tsc --noEmit -p <package dir>` for every package touched,
  `npx vitest run <paths>` from the repo root.
