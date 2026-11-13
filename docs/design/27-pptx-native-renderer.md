# Design 27: Native PowerPoint slides

Packages and apps involved:
- `packages/pptx-scene` (new): the deck parser and converter.
- `packages/renderer`: rich text, the scene stack and geometry.
- `packages/domain`: optional schema fields, readable text, size checks.
- `packages/live-state`: slide media and hidden-slide navigation.
- `apps/hub`: the native import job, picture preparation, the LibreOffice follow-up, legacy text repair.
- `apps/output`: video played inside the slide.
- `apps/operator`: the editor.
- `apps/stage`: text direction and a notes region.
- `tools/pptx-fidelity`: measurement against LibreOffice.

Status: proposed (2026-11), revised 2026-11-06 after a completeness review (§19 lists what changed). The pptx-preview path of design/20 "PPTX and PDF" is retired once the M8 gates hold. LibreOffice stays (§5) until M9 makes it optional at run time (§15).

## Today

Each PowerPoint slide becomes one 1920x1080 picture, drawn at import by LibreOffice or by the wrapped pptx-preview renderer. The import also extracts the slide text, but nothing on the live path reads it, and the extracted boxes are matched by list index, so they shift after a hidden slide. Embedded video and audio are dropped (design/20 "Embedded media"). "Make editable" lays theme-styled text boxes over a picture that still contains the original text.

## What this design does

It makes PowerPoint slides native to ordo:
- The hub parses the deck on the CPU pool (the deck is untrusted input) and writes ordinary ordo slide objects, extended with optional fields.
- A volunteer can edit them: fix a lyric typo, change an announcement date, swap the series background, add a verse.
- Every screen draws them with the same code. They stay sharp at any output resolution.
- Embedded clips play in place.

What ordo cannot reasonably model (charts, SmartArt without a drawing, OLE, 3D, WordArt warps) becomes a locked, transparent LibreOffice art picture at its place in the z-order. The background, the pictures and the text around it stay native and editable.

## Decisions

1. **One model for rendering and editing.**
   - The hub turns the deck into a hub-internal scene IR: EMU units, full affine transforms, inheritance resolved. It emits ordinary `SlideObject`s and then discards the IR.
   - Only the objects are stored. `Slide.pptx` keeps provenance only: the deck hash, the slide index, the converter version and a digest of what it wrote. It never holds a second copy of drawable content. The one exception is `artText`: the text of text bodies that had to be baked into an art picture, kept for search.
   - Every consumer reads those objects through the same `@ordo/renderer` and `@ordo/domain` functions (ADR 0004): outputs, the thumbnail worker, look previews, the Konva editor, stage text, lyric-only looks, cue labels and search.
2. **Editable first.** Each element becomes the richest ordo object that reproduces it:

   | PowerPoint element                                   | ordo object                                                          |
   | ---------------------------------------------------- | -------------------------------------------------------------------- |
   | Text                                                 | `TextObject` with sparse runs and paragraph styles                   |
   | Picture                                              | `ImageObject` with crop, mask and flip                               |
   | Simple shape                                         | `ShapeObject`                                                        |
   | Video                                                | `ImageObject` (the deck's poster) with `play`                        |
   | Sound                                                | `Slide.audio`                                                        |
   | Background                                           | `backgroundMediaId` or a bottom object                               |
   | Notes, sections, hidden slides, transitions, timings | the existing ordo fields, plus `Slide.hidden` and `Slide.transition` |

   What cannot reasonably be edited becomes a **locked** object (move, resize, delete and z-order only). That is either a native drawing (SmartArt with a drawing cache, table grids) or a transparent LibreOffice art picture. Backgrounds and playing videos are never baked into a picture.
3. **The parser decides a class per slide.**
   - _native_: everything is ordo objects.
   - _hybrid_: one locked, transparent LibreOffice art `ImageObject` covering the z-range of the residual elements, with native objects below and above it.
   - _picture_: a whole-slide LibreOffice picture plus text boxes keyed by shown index. This is the last resort.
4. **Drawing is split between Canvas 2D and WebGPU.**
   - Canvas 2D, in the asset worker, draws everything static at each output's device resolution: text, vectors, pictures and effects.
   - WebGPU composites the layers. It plays an in-slide video in its box, at its z-order, inside the slide layer, with an exact crossfade. This is the new `SRC_SCENE` stack.
   - The Canvas 2D compositor mirrors every GPU feature.
   - There is no GPU text. Rasterizing at device resolution is already crisp at 4K, and GPU text would fork shaping, bidi and font fallback away from the editor.
5. **One text engine, shared by every drawer.**
   - It lays out in logical px, so 1080p, 4K, the editor and thumbnails break lines identically.
   - It uses LibreOffice's line model and autofit (ported from `pptx-render/src/page.ts`), UAX#14 line breaking and UAX#9 bidi.
   - Lyric-only bands, the next-slide band and the stage honour paragraph direction too.
6. **Fonts are deterministic.**
   - Every face is shipped through ordo's Font/OPFS path and registered under an internal family name that has never been resolved.
   - Metric-compatible substitutes are bundled.
   - Script fallback faces are sent to every output whatever the playlist, so an offline output never falls back to the operating system's fonts glyph by glyph.
7. **Media plays in place through the existing transport.**
   - The slide cue fills `layers.media` (video) or `audio` instead of clearing them (`live-state/src/index.ts:213`).
   - F8, onEnd, the LayerBar, the stage's remaining time and audio-master routing are all reused.
   - No new LiveEvent is needed.
   - Re-entering its slide never restarts a slide sound that is still playing.
8. **LibreOffice stays.** It has three roles:
   - the fidelity reference in `tools/pptx-fidelity`;
   - the renderer for hybrid art, picture slides and metafiles, run only on the slides that need it;
   - on-demand reference pictures for the operator.

   It is never on the native critical path.
9. **Schema growth is additive.**
   - Fields are optional and bounded.
   - There is no new `SlideObject` union member and no widened stored enum. Both were verified to blank the slide at goLive in an older build (`goLive.ts:69-87`).
   - Enums inside _new_ fields use `.catch(default)`, so a value added later degrades instead of failing `Slide.safeParse`.
   - No data migration is needed.
   - Every path that carries a whole presentation or playlist has a size budget (§3.4).
10. **Builds and transitions.**
    - The final state is drawn. A paragraph build can be split into progressive slides by an import option or an editor action (M8).
    - A PowerPoint fade becomes a `Slide.transition` crossfade. Other transitions become a crossfade or a cut, and each one is logged.
    - Precedence is `item ?? slide ?? presentation`, so the operator's choice for this service wins.
11. **Hidden slides stay in the service.**
    - Their cues are flagged `hidden`.
    - Next, Prev, auto-advance and onEnd advance skip them.
    - A click in the grid or goToSlide still shows them, as in PowerPoint.

## Why this design

Three architectures were scored, 1-10 (delivery risk: 10 = lowest risk).

| Design                         | Performance | Fidelity potential | Fit with ordo | Editability | Robustness/security | Delivery risk |
| ------------------------------ | ----------- | ------------------ | ------------- | ----------- | ------------------- | ------------- |
| raster-hybrid                  | 7           | 8                  | 7             | 9           | 8                   | 5             |
| gpu-native                     | 7           | 7                  | 5             | 7           | 7                   | 3             |
| **ordo-first-staged (chosen)** | **8**       | 7                  | **9**         | 8           | 8                   | **7**         |

The chosen design changes the least for static slides, which keep today's one-bitmap path. Per-cue raster cost stays in the asset worker, off the frame path: 3.2 ms at 1080p and 14.4 ms at 4K, measured. Video inside a slide uses the cheapest exact compositing. Coverage is staged and measured against a census of shown worship slides:

| Tier     | Shown worship slides covered (cumulative) |
| -------- | ----------------------------------------- |
| T1       | 30.9%                                     |
| T1 + T2  | 73.3%                                     |
| T1 to T3 | 87.6%                                     |
| T1 to T4 | 92.5%                                     |
| T1 to T5 | 95.8%                                     |
| Fallback | 4.2%                                      |

Source: a census of 4,897 shown slides of worship decks in the local validation suite (not committed: the decks come from many sources and licences). Of the 73 slides in five real sermon decks kept outside the repository, 72 are T2; the 73rd has an sp3d.

**Grafted from raster-hybrid:**
- the video carrier is the `ImageObject` itself (`ImageObject.play`), so a clip has a box, z-order, crop, mask and delete/duplicate behaviour like any object, and an old build still draws its poster;
- a light native job with a heavy LibreOffice follow-up;
- LibreOffice pictures at 3840 px;
- transparent art from a white/black double render (verified with a local probe), now used from M3;
- a measure LRU;
- picture decode sized to the visible crop;
- opaque-first `copy` compositing;
- an effect sprite cache.

**Grafted from gpu-native:**
- `.catch()` enums in new fields;
- the complex-script segment rules (ZWJ at style cuts inside joining-script words, grapheme-safe emergency breaks, the `fonts.check` coverage report);
- video frame selection by media time;
- uploads moved out of `draw()`;
- treating `isFallbackAdapter` as Canvas 2D.

**Rejected:**
- build steps as extra cues: this changes cue counts, arrangement navigation and Stream Deck/MIDI habits for every client;
- slide-level media with a numeric z index: it drifts under editing;
- a full GPU scene compositor with SDF shapes and sprite sheets: editor and output pixels drift apart, it needs a 520 MB GPU budget at 4K, and it has the largest delivery risk;
- loose strings for every enum;
- hidden slides as cue-less slides: they could not be shown during a service, and ADR 0007's lock prevents unhiding until End service.

**Re-verified for this design** (code read or re-run):
- `gpu.ts`: layer textures are `RENDER_ATTACHMENT` (243-244). `U` is 64 B in 256 B slots (18-27). There are 7 startup pipelines (203-228). Uploads happen inside `drawLayer` (337-338).
- `clamp.ts` drops unknown object types (144-178) and whitelists slide fields (186-225).
- The slide cue clears the media layer (`live-state/src/index.ts:213`). `next` is `live + 1` and `autoAdvance` wraps within the item (same file).
- Cue transition = `item.transition ?? p.transition` (`cues.ts:53`).
- Optional goLive media exists only for holding slides and the logo (`goLive.ts:219-221`).
- `manifestFiles` already ships video posters (`resolve.ts:56-65`).
- Text layout today measures at _device_ scale (`text2d.ts:84-101`), so line breaks can differ between 1080p, 4K and the editor. The ascent is a fixed 0.8 × size (`text2d.ts:179`).
- The worker FontFace probe was re-run:
  - a family string measured before its FontFace is added keeps its fallback width (394.36 px) after the face is added;
  - a family never resolved before takes the new face (375.14 px, Carlito).

**Corrected by the review** (code read):
- Today's "look hides media" path arms the clip only on the audio master (`link-core.ts` `syncVideos`: `md && !mdSlot && !live.media.key && audioMaster`). `armVideo` also posts `SRC_VIDEO` content to its layer whenever that layer is not the media layer. In-slide video therefore needs its own arming and slot-ownership rule (§7.2).
- `MediaSlot.apply` loops modulo the whole clip duration (`media.ts:150-175`). Trims are therefore baked into the clip at import, not applied at run time (§8).
- `Arrangement` lists `sectionIds`, not slides (`schemas.ts`). A hidden slide cannot be "left out of the arrangement", so hidden slides become flagged cues (§9).
- `sanitizePresentation` spreads unknown fields through but cuts text at 10,000 characters (`importers/src/sanitize.ts`). Runs and paragraph styles must be cut with the text (§3.2).
- The operator's preview sends `{...presentation, media}` (`PreviewControl.tsx`). `live.adopt` carries the whole LiveState. Both are capped at 16 MiB and close the socket when they exceed it (`ws.ts:38-39`). Library snapshots send every presentation in full (`library.ts:543-555`). Size is therefore budgeted (§3.4).
- The hub's image ingest downscales pictures over 3840 px (`media/service.ts` transform). A ready-picture path bypasses that, so pictures are prepared explicitly (§4).
- Legacy `imported.textBoxes` were matched by list index (`imports.ts:550`), so they are wrong after a hidden slide. They are repaired before any reader trusts them (§11).
- Jobs run FIFO per class (`jobs.ts:160`). The LibreOffice follow-up is therefore queued before the deck's own clip transcodes (§5).
- The hub runs on a Synology-class NAS with a 4 GB cap (`deploy/compose.yaml`), not on the 4-core container where the benchmarks ran (§13).

## 1. Modules

| Module                                                                                   | Contents                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pptx-scene` (new, `@ordo/pptx-scene`)                                          | Pure TypeScript: no DOM, no JSZip, no fs. Input is a `PartSource` (`Map<string, Uint8Array>` from `extractZip`). Runs on the hub CPU pool (task `pptx-scene`) and in Node for the harness.                                                                                                                                                                                                                             |
| `pptx-scene/src/xml.ts`                                                                  | Moved from `pptx-render/src/xml.ts` and made dependency-free (its own linear reader instead of fast-xml-parser). Bounded, order-preserving parse (depth 256, 250k tags, linear start-tag scan, indexed child lookup), plus: no DTD at all (`<!DOCTYPE` and every other declaration refused, only the five predefined entities and numeric references decoded, so nothing expands), `attrs` as null-prototype objects.  |
| `opc.ts`                                                                                 | Content types (an override naming a missing part is ignored). Relationships resolved inside the package: percent-decode, normalise, case-insensitive (a duplicate that differs only by case keeps the first), matched by type URI, Strict→Transitional (port of `annotate.ts:1478-1539`). External targets are logged with their host only.                                                                            |
| `deck.ts`                                                                                | `presentation.xml`: `sldSz` (one default, 12192000x6858000), `sldIdLst` with a prefix-agnostic r:id, duplicates placed once, `show="0"/"false"` hidden flag and shown index (port of `annotate.ts:725-800`), `p14:sectionLst`, `defaultTextStyle`, `embeddedFontLst`.                                                                                                                                                  |
| `frame.ts`                                                                               | EMU → logical px: `s = min(1920/cx, 1080/cy)`, `x0 = (1920 − cx·s)/2`, `y0 = (1080 − cy·s)/2`. The same mapping as `fitPage` (`ffmpeg.ts:332`). 1 pt = `12700·s` px, which is 2.0 px for both standard sizes.                                                                                                                                                                                                          |
| `theme.ts`, `color.ts`                                                                   | Theme fonts (major, minor, ea, cs, per-script `a:font`), clrScheme, master clrMap merged with the slide's clrMapOvr, fmtScheme fill/line/effect/bgFill lists, full prstClr table, colour modifiers (§4).                                                                                                                                                                                                               |
| `inherit.ts`                                                                             | Placeholder matching; xfrm/bodyPr chain; list-style chain (§4).                                                                                                                                                                                                                                                                                                                                                        |
| `text.ts`, `walk.ts`, `picture.ts`, `background.ts`, `media.ts`, `timing.ts`, `notes.ts` | Shape-tree walk, text bodies, pictures, backgrounds, embedded media, `p:timing`/transitions, notes.                                                                                                                                                                                                                                                                                                                    |
| `classify.ts`                                                                            | Per-element `native / approx / residual`, slide class, art z-range, tier T1-T5 and reasons, size budgets (§3.4).                                                                                                                                                                                                                                                                                                       |
| `emit.ts`                                                                                | IR → ordo objects with `pptxmedia:<n>` placeholder ids (numbered in first-use order, the part of each listed in `EmitResult.media`, so a long part name never makes an id the schema refuses), plus a per-slide digest.                                                                                                                                                                                                |
| `rendercopy.ts` (M3)                                                                     | The minimal deck for LibreOffice (§5). Replaces the main-thread `pptxForRendering`.                                                                                                                                                                                                                                                                                                                                    |
| `index.ts`                                                                               | `parseDeck(src, opts): DeckScene`; `emitSlides(scene, opts): EmitResult`.                                                                                                                                                                                                                                                                                                                                              |
| `packages/domain/src/readable.ts`, `bullets.ts` (M2)                                     | `readableText(o)`: `TextObject.text` with automatic numbers and bullets written as text, for the stage, bands, labels and search. `textScripts(text)` for the font scan. `bullets.ts`: `paraLabels(o)` and the number counter (port of `annotate.ts` `autoNumber`) that the renderer's bullets draw too, and the Wingdings/Symbol table (`symbolFontChar`) for the converter.                                          |
| `packages/domain/src/size.ts` (M3)                                                       | JSON size estimates for slides, presentations and resolved playlists (§3.4).                                                                                                                                                                                                                                                                                                                                           |
| `packages/renderer/src/text/` (M2)                                                       | `itemize.ts`, `breaks.ts` (UAX#14 via npm `linebreak` 1.1.0, MIT; 2.0.0 was days old when chosen; `Intl.Segmenter`), `bidi.ts` (npm `bidi-js` 1.1.0, MIT), `measure.ts`, `lines.ts`, `office.ts` (LibreOffice line model and autofit, ported from `pptx-render/src/page.ts:202-426`), `bullets.ts` (port of `annotate.ts` `autoNumber`), `paint.ts`, `rich.ts`, `fonts.ts` (the resolver, §10).                        |
| `packages/renderer/src/content.ts` (M3)                                                  | `slideContent()`, the one fallback rule (§5). As built, the rule itself is `packages/domain/src/content.ts` (`slideContent`, `drawnMediaIds`), so `referencedMediaIds` follows it too; the renderer's module re-exports it and adds `drawableContent` (the rule over the clamped slide, memoised).                                                                                                                     |
| `packages/renderer/src/scene.ts` (M5)                                                    | Video split and the plane encoding (§7.2).                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/renderer/src/geom/` (M6)                                                       | `presets.gen.ts` (compiled from POI by `tools/geom-gen`), `ops.ts` (the compiled form: op codes and value slots), `compile.ts` (a preset or a custGeom as strings → the compiled form, bounded), `eval.ts` (guide evaluator), `arc.ts` (arcTo as cubic segments, POI's visual-angle rule), `path.ts` (sub-paths in box space, text rect, sites), `draw.ts` (Canvas 2D: LibreOffice's order, even-odd rule and shades). |
| `third_party/poi-presets/`, `tools/geom-gen/` (M6)                                       | Vendored POI 5.2.5 `presetShapeDefinitions.xml` (Apache-2.0) with two documented fixes, and the generator.                                                                                                                                                                                                                                                                                                             |
| `apps/hub/src/pptx/` (M3)                                                                | `nativeJob.ts`; `mediaParts.ts` (generalised `mediaFor`); `pictures.ts` (picture preparation, §4); `fallback.ts` (LibreOffice follow-up); `art.ts` (pool task `pptx-art`: white/black alpha and bounding-box crop); `report.ts`; `textRepair.ts` (legacy textBoxes repair, §11); `reimport.ts` (M4).                                                                                                                   |
| `apps/hub/src/fonts/bundled.ts` (M3)                                                     | Registers the bundled substitutes and script fallbacks.                                                                                                                                                                                                                                                                                                                                                                |
| `tools/pptx-fidelity/src/native.ts`, `native-page.ts` (M1)                               | The native column of the harness.                                                                                                                                                                                                                                                                                                                                                                                      |

## 2. Data flow

```
POST /import/document  (423 while live, ≤1 GiB, zip+.pptx sniff, stored by SHA-256; renderer=native is the route default)
 └─ light job 'pptx-native' {hash, name, options}
     1 extractZip(store.abs(deck), skip filter): XML parts in memory (≤8 MB each, ≤64 MB total);
       referenced ppt/media/* and ppt/fonts/* spilled under generated names (≤1 GiB; ≤2,000 pictures,
       ≤50 clips, ≤20 fonts); embeddings, vbaProject, customXml skipped; .proPlaylist nesting off
     2 pool 'pptx-scene' (batches ≤150 slides; slide parts transferred, shared masters/layouts/themes/presentation
       copied into each batch; 2 min per batch, ≤15 min of pool time per import; 512 MB heap)
       ─► DeckScene + emitted objects ('pptxmedia:<n>' ids, each with its part)
     3 classification and size budgets (§3.4): slides over budget become picture class (logged)
     4 if any slide is hybrid/picture or has a metafile: enqueue heavy job 'pptx-lo' now, before any clip job
     5 pictures ─► prepare (header check, downscale to display need, convert) ─► addReadyPicture;
       clips ─► MediaService.ingest (never awaited; trims baked); SHA-256 dedup through the media hash index;
       part→mediaId pairs recorded with ctx.setPayload
     6 remap placeholders, sanitizePresentation, lib.savePresentation ── version 1 (native objects for every
       slide; slides waiting for LibreOffice carry pptx.pending)
 heavy job 'pptx-lo' (re-queued with backoff while the presentation is live-locked)
     pool 'pptx-render-copy' ─► soffice once (each art slide twice: forced white and forced yellow background;
     picture-class slides once) ─► pdftoppm -r 288 -f k -l k per needed page ─► pool 'pptx-art'
     (alpha from the two pages, colour un-blended, bounding-box crop) ─► PNG ─► addReadyPicture
     ─► patch slides whose digest is unchanged ── version 2
 goLive ─► resolvePlaylist: referencedMediaIds (+play clips, slide audio, posters, refMediaId; those optional)
        ─► referencedFontFamilies (+run, bullet and fallback fonts; CJK faces when the text has CJK)
        ─► size check (§3.4) ─► manifest ─► every client
 output: planFrame ─► link: in-slide clip armed on every output (§7.2) ─► slide AssetJob {video: slot, gen}
        ─► asset worker: clampSlide ─► slideContent ─► rich layout ─► Canvas 2D at width/1920
        ─► SRC_BITMAP, or SRC_SCENE {base, over, plane, slot, gen} ─► WebGPU / Canvas 2D compositor
 operator: thumb worker drawSlide2D; editor ObjectNode → the same drawers at scale × devicePixelRatio;
        labels, search and lyric-only looks read readableText(TextObject)
 stage: readableText of lyricObjectId, direction per paragraph (CSS unicode-bidi: plaintext);
        Slide.notes in an optional notes region
```

Imports stay refused while live (`routes.ts:336-339`). A presentation in the live playlist stays read-only (ADR 0007), and no hub job writes it during a service.

## 3. Stored model

### 3.1 Additions to `packages/domain/src/schemas.ts`

```ts
// Shared. Enums inside new fields use .catch(default); every array, string and number is bounded.
const frac = z.number().min(-1).max(1);
const Shadow = z.object({ dx: coord, dy: coord, blur: length, color: Rgba }); // same shape as TextStyle.shadow
const Glow = z.object({ radius: length, color: Rgba });

export const ObjectOrigin = z.object({
  src: z.string().max(16),                                          // 'pptx'
  shapeId: z.number().int().min(0).max(2_147_483_647).optional(),   // p:cNvPr id
  ph: z.string().max(40).optional(),                                // 'title' | 'body' | 'body:2' | 'subTitle' …
  role: z.string().max(20).optional(),  // title|body|text|picture|shape|bg|deco|poster|cell|grid|art (string: can grow)
  group: z.number().int().min(0).max(100_000).optional(),           // flattened group or shape+text pair: selected together
});
const common = { origin: ObjectOrigin.optional(), locked: z.boolean().optional() }; // locked: move/resize/delete/z only

export const Gradient = z.object({                                                   // M6
  kind: z.enum(['linear', 'radial']).catch('linear'),
  angle: z.number().min(-36_000).max(36_000).optional(),   // degrees clockwise from left→right (OOXML ang/60000)
  stops: z.array(z.object({ at: z.number().min(0).max(1), color: Rgba })).min(2).max(16),
  center: z.object({ x: frac, y: frac }).optional(),       // radial focus in box fractions
});
export const ShapeGeom = z.object({                       // M3: ellipse/roundRect; M6: every preset and paths
  preset: z.string().max(40).optional(),                  // POI preset name, evaluated at draw time (resize keeps corners)
  adj: z.array(z.tuple([z.string().max(16), z.number().min(-1e7).max(1e7)])).max(10).optional(), // pairs: no deck keys
  paths: z.array(z.object({
    d: z.string().max(40_000),                            // M L C Q Z and numbers only; ≤4,096 points (clamp)
    w: z.number().min(0).max(1e9), h: z.number().min(0).max(1e9),  // the path's own space, scaled to the box
    fill: z.enum(['norm', 'none', 'lighten', 'lightenLess', 'darken', 'darkenLess']).catch('norm').optional(),
    stroke: z.boolean().optional(),
    cont: z.boolean().optional().catch(undefined),        // M6: continues the path before it (one path in pieces)
  })).max(8).optional(),
  ref: z.string().min(1).max(100).optional().catch(undefined), // M6 round 2: the paths are in a geometry file
});
// M6 round 2: a geometry file, JSON in the content store named by its SHA-256 (ShapeGeom.ref), ≤ 400 KB;
// read by drawers before they draw, like a picture; without it the geometry is the rest of ShapeGeom.
export const GeomFile = z.object({ paths: z.array(ShapeGeomPath).min(1).max(8) }); // ShapeGeomPath: an item of paths

// TextStyle (box level; themes and looks can use these too)                         // M2 unless noted
  lineModel: z.enum(['ordo', 'office']).catch('ordo').optional(), // office = LibreOffice/PowerPoint line model
  insets: z.object({ l: length, t: length, r: length, b: length }).optional(), // replaces padding when present
  wrap: z.boolean().optional(),                                    // false = PowerPoint wrap="none"
  autofit: z.enum(['none', 'shrink']).catch('none').optional(),
  fitScale: z.object({ font: z.number().min(0.01).max(1), spacing: z.number().min(0).max(1) }).optional(),
                                                                   // PowerPoint's stored normAutofit, or the last fit;
                                                                   // kept by edits while the text still fits (§11)
  justify: z.boolean().optional(),                                 // box-level justify; `align` is never widened
  direction: z.enum(['ltr', 'rtl', 'auto']).catch('auto').optional(),
  lang: z.string().max(35).optional(),                             // BCP 47 → ctx.lang
  fallbackFonts: z.array(z.string().max(300)).max(8).optional(),   // metric substitute, ea/cs fonts, script fallbacks
  underline: z.boolean().optional(),
  glow: Glow.optional(),
  paint: Gradient.optional(),                                      // M6: gradient text over the box

export const TextRun = z.object({     // sparse annotation over TextObject.text (UTF-16 offsets)
  start: z.number().int().min(0).max(MAX.text), end: z.number().int().min(0).max(MAX.text),
  fontFamily: z.string().max(300).optional(), fontWeight: z.number().min(0).max(1000).optional(),
  fontStyle: z.enum(['normal', 'italic']).catch('normal').optional(),
  sizeScale: z.number().min(0.01).max(50).optional(),   // × style.fontSizePx: box Size and themes scale every run
  color: Rgba.optional(), highlight: Rgba.optional(),
  underline: z.boolean().optional(), strike: z.boolean().optional(),
  baseline: z.number().min(-1).max(1).optional(),       // OOXML baseline/100000; +0.3 = superscript verse number
  letterSpacing: z.number().min(-1000).max(1000).optional(),
  caps: z.enum(['none', 'all', 'small']).catch('none').optional(),
  outline: z.object({ width: length, color: Rgba }).nullable().optional(), // null = none, overrides the style
  shadow: Shadow.nullable().optional(),
  lang: z.string().max(35).optional(),
});
export const TextPara = z.object({    // index i ↔ text.split('\n')[i]; null = box defaults
  align: z.enum(['left', 'center', 'right', 'justify', 'distribute']).catch('left').optional(),
  soft: z.boolean().optional(),       // PowerPoint a:br: continues the previous paragraph (no bullet, no space before)
  level: z.number().int().min(0).max(8).optional(),
  indentPx: coord.optional(),         // marL
  firstLinePx: coord.optional(),      // indent; negative = hanging bullet
  spaceBeforePx: length.optional(), spaceAfterPx: length.optional(),
  lineSpacing: z.number().min(0).max(13.2).optional(),  // × single (single = 1.2 × F in the office model)
  lineSpacingPx: length.optional(),                      // exact pitch
  bullet: z.object({
    char: z.string().min(1).max(8).optional(),           // Unicode (Wingdings/Symbol mapped at import)
    auto: z.string().max(40).optional(),                 // 'arabicPeriod' | 'arabicParenBoth' | …; unknown → arabicPeriod
    startAt: z.number().int().min(1).max(32_767).optional(),
    fontFamily: z.string().max(300).optional(), color: Rgba.optional(),
    sizePct: z.number().min(0.1).max(4).optional(),
  }).nullable().optional(),                              // null = explicitly none (PowerPoint buNone)
  rtl: z.boolean().optional(),
  hidden: z.boolean().optional(),                        // M8 split reveal: laid out, not drawn
});
// TextObject
  runs: z.array(TextRun).max(2000).optional(),
  paras: z.array(TextPara.nullable()).max(5000).optional(),
  ...common,

export const Play = z.object({                           // M5: the clip an ImageObject plays in its box
  mediaId: Id,                                           // the clip (trim already baked); ImageObject.mediaId is the poster
  start: z.enum(['auto', 'click']).catch('auto').optional(), // click = goes live paused at 0; F8 plays
  loop: z.boolean().optional(),
  onEnd: MediaOnEnd.catch('hold').optional(),           // 'black' = PowerPoint "Rewind after playing": the poster shows again
  gainDb: z.number().min(-100).max(100).optional(),     // 20·log10(vol/100000)
  muted: z.boolean().optional(),
  showWhenStopped: z.boolean().optional(),              // false = PowerPoint "Hide while not playing"
});
// ImageObject
  crop: z.object({ l: frac, t: frac, r: frac, b: frac }).optional(),   // M1: srcRect fractions; negative pads transparent
  flipH: z.boolean().optional(), flipV: z.boolean().optional(),         // M3
  mask: ShapeGeom.optional(),                                           // M3 ellipse/roundRect; M6 any preset or path
  adjust: z.object({ brightness: frac.optional(), contrast: frac.optional(), grayscale: z.boolean().optional() }).optional(),
  stroke: z.object({ width: length, color: Rgba }).optional(), shadow: Shadow.optional(),
  play: Play.optional(),                                                // M5
  ...common,
// ShapeObject (`shape` stays rect|ellipse|line and `fill` stays a solid colour: what an older build draws)   // M6
  geom: ShapeGeom.optional(), gradient: Gradient.optional(),
  dash: z.enum(['solid', 'dot', 'dash', 'dashDot', 'longDash', 'longDashDot', 'sysDot', 'sysDash']).catch('solid').optional(),
  lineJoin: z.enum(['miter', 'round', 'bevel']).catch('miter').optional(),   // M6 repair: a:round, a:bevel, a:miter
  lineCap: z.enum(['flat', 'round', 'square']).catch('flat').optional(),     // M6 repair: a:ln cap
  ends: z.object({ head: ArrowEnd.optional(), tail: ArrowEnd.optional() }).optional(),
  // ArrowEnd = z.enum(['none','triangle','stealth','arrow','oval','diamond']).catch('none')
  flipH: z.boolean().optional(), flipV: z.boolean().optional(),
  shadow: Shadow.optional(), glow: Glow.optional(), softEdge: length.optional(),
  ...common,

export const SlideSound = z.object({                     // M5: one sound per slide (PowerPoint embedded audio)
  mediaId: Id,                                           // trim already baked
  start: z.enum(['auto', 'click']).catch('auto').optional(),
  loop: z.boolean().optional(), gainDb: z.number().min(-100).max(100).optional(), muted: z.boolean().optional(),
  slides: z.number().int().min(1).max(999).optional(),   // numSld: plays across N shown slides of the same item
});
// Slide
  hidden: z.boolean().optional(),                        // M3: cue flagged hidden; Next/Prev/auto-advance skip it (wave 1: no cue yet, as §15 M3 says)
  transition: Transition.optional().catch(undefined),    // M3: cue transition = item ?? slide ?? presentation
  audio: SlideSound.optional(),                          // M5
  pptx: z.object({                                       // M3: provenance only, never drawable content
    fileId: Id,
    index: z.number().int().min(0).max(100_000),         // p:sldIdLst position
    shown: z.number().int().min(0).max(100_000).optional(), // shown-slide position; absent for a hidden slide
    class: z.enum(['native', 'hybrid', 'picture']).catch('native'),
    version: z.number().int().min(1).max(1_000_000),     // converter version
    digest: z.string().max(100).optional(),              // hash of the objects the converter wrote: the "unedited" test
    pending: z.boolean().optional(),                     // LibreOffice work for this slide still running
    notes: z.array(z.string().max(200)).max(16).optional(), // what was approximated, shown in the editor
    artText: z.string().max(MAX.text).optional(),        // text baked into the art picture (search only)
    refMediaId: Id.optional(),                           // LibreOffice picture of the whole slide (on demand)
    show: z.enum(['objects', 'picture']).catch('objects').optional(),
  }).optional(),
// Slide.imported (existing record)
  textAligned: z.boolean().optional(),                   // M3: textBoxes keyed by shown slide; text readers trust them
// Presentation.source
  native: z.object({ version: z.number().int().min(1).max(1_000_000), slides: z.number().int().min(0).max(100_000),
    native: z.number().int().min(0).max(100_000), hybrid: z.number().int().min(0).max(100_000),
    picture: z.number().int().min(0).max(100_000),
    slideRect: z.object({ x: coord, y: coord, w: length, h: length }).optional(), // the deck's area in 1920x1080
  }).optional(),
// Font
  unicodeRange: z.string().max(4000).optional(),         // M3: CSS unicode-range of a subset face (Google Fonts)
  scope: Id.optional(),                                  // M8: a deck-embedded face: only this presentation
  embed: z.object({ fsType: z.number().int().min(0).max(65_535), subset: z.boolean() }).optional(), // M8
// PropsRule (M4, stage look)
  notes: z.boolean().optional(),                         // stage notes region, drawn in style['notes']
```

<!-- m9:schema -->
_Built for M9 (schema track; every stored field of M9 in one change, `packages/domain/src/schemas.ts`):_

```ts
// Every field below is .optional().catch(undefined); every enum inside .catch()es; arrays, strings, numbers bounded.
ShapeGeom  += { adjWide: [name ≤ 16, ±21_600_000][] ≤ 10 }        // preferred by name over adj (which stays ±1e7)
GeomFile    = { paths: ShapeGeomPath[1..64] }                      // was 8; inline ShapeGeom.paths keeps .max(8)
GEOM_FILE_MAX_BYTES = 2_600_000                                    // was 400_000; also bounds a DecorFile
Look3d      = { bevel?, back?: { prst: BEVEL_PRESETS, w, h ≤ 1_000 }, depth? ≤ 1_000, lift? ±1_000,
                contour?: { width ≤ 500, color }, side?, material?: MATERIALS, light?: { rig: LIGHT_RIGS,
                dir?, rot? }, camera?: { prst: CAMERA_PRESETS, fov?, rot?: [lat, lon, rev], zoom? },
                grow? ≤ 500, flat? }                               // names: domain/src/three-names.ts (62/27/15/12)
ShapeObject += { table?: TableData, chart?: ChartData, decor?: DecorData, look3d?: Look3d }
ImageObject += { look3d?: Look3d, vectorFonts?: string[] ≤ 8 }
TextObject  += { warp?: { preset: TEXT_WARPS (40), adj? ≤ 4 }, writing?: { upright: none|cjk|all, reverse? },
                 centerBlock?: boolean, look3d?: Look3d }          // on the object, never on TextStyle (decision 5)
TableData   = plan §3 (TABLE_LIMITS: 256 rows, 64 columns, 4,096 slots, 10,000 / 60,000 characters, palettes)
ChartData   = charts.md §3.2 in domain/src/chart.ts (CHART_LIMITS), built over schemas.ts's own pieces
DecorData   = { w, h, paints: DecorPaint[1..64], parts: DecorPart[≤ 256], ref? } ; DecorFile = { parts[1..256] }
SlidePptx  += { missing: string[] ≤ 16 of ≤ 40 }                   // '<kind>[:<subtype>]', MISSING_KINDS (missing.ts)
// media.ts: VECTOR_MIME = 'application/vnd.ordo.vector' (Media stays kind 'image').
```

- **Not written** (M9 decision 4: no legacy table group): `TableData.shadow` and `ChartData.shadow` are left
  out, and so is `content.ts`'s `tableShadows`; an older build draws a table's background rect, a chart's
  area. A table's edge indices are bounded by 256 (the row count, which covers the column edges too).
- **`chart.ts`** cannot import `schemas.ts` (which imports it for `ShapeObject.chart`), so `chartSchemas()`
  takes `Rgba`, `length`, `Gradient`, `LineDash`, `TextRun` and `TextPara` from `schemas.ts`, which exports the
  resulting `Chart*` schemas. `chart.ts` and `three-names.ts` are fingerprinted with the schema for
  `APP_VERSION` (`packages/protocol/src/version.test.ts`).
- **Clamp** (`renderer/src/clamp.ts` dispatching to `clamp/{table,chart,decor,look3d,warp,writing,vector}.ts`):
  each area file re-validates its field with the schema and keeps it (a decoration's path strings are
  re-tokenised, vector picture families cleaned through the object's `FontBudget`); the area tracks fill in
  the full clamps. `clampObject` keeps at most one of `table` > `chart` > `decor` on a shape, the first usable
  one, and drops `look3d` on any of them; `clampGeom` keeps `adjWide` within ±21,600,000. `isRichText` is true
  for a text object with any of `RICH_OBJECT_KEYS` (warp, writing, centerBlock, look3d), so the legacy
  `drawText` never meets them.
- **Sanitize** (`importers/src/sanitize.ts` dispatching to `sanitize/{table,chart,decor,look3d,warp,writing}.ts`):
  cell texts cut to 10,000 with their runs and paragraph styles and the table to 60,000 (later cells emptied);
  runs sorted, inside their text and naming a run style that exists; chart names, categories and labels to
  255, titles to 1,000 with their runs and paras, format codes to 64; decoration paths re-tokenised; palette
  indices that name no entry dropped; numbers finite and bounded; `missing` entries one line of ≤ 40, once each.
- **Readers** (`domain/src/m9-readers.ts`): `tableText` (rows by '\n', cells by '\t', readable numbers),
  `chartText`, `objectSearchText`; `extraFontFamilies` and `extraText`, which `referencedFontFamilies` and
  `scriptFontFamilies` read, so goLive ships the faces of table, chart and vector picture text;
  `drawnShapeFileRefs` (geometry and decoration files), which goLive's manifest uses. `palette.ts`:
  `canonicalJson`, `Palette` (Map-deduped, capped) and `paletteIndex`.
- **goLive**: a slide with `pptx.missing` goes live with a `degraded` entry naming what is left out
  (`missingSlideReason`: 'PowerPoint slide with something ordo cannot draw (a chart, …): it is left out',
  kind 'drawing'); a slide waiting for LibreOffice is reported as waiting instead.
- **Older builds**: `schemas.prev.test-util.ts` stays 0.1.x's schema (M9 lands in 0.2.0, M9 decision 1); it
  strips every M9 field and the M9 fixture slide (`domain/src/m9.test-util.ts`, 10.8 KB) still parses and draws
  its legacy shapes and text.
<!-- /m9:schema -->

### 3.2 Compatibility rules

- **`TextObject.text` stays canonical.** Runs and paragraph styles annotate it. `firstText`, cue labels, search, stage `slideText`, lyric-only looks, 'Make lyric box' and themes keep working. Readers that show text to people go through `readableText(o)`, which writes automatic numbers and bullets as text, so verse numbers survive on the stage and the stream.
- **The importer always writes the closest legacy values**, so an older build, which strips every new key, still draws something sensible:
  - text in its dominant run's style, with `padding` = the smallest inset;
  - pictures stretched and uncropped;
  - shapes as rect, ellipse or line with a solid fill (the first gradient stop);
  - (M6) a table's grid as its line looks' outline and its fills' bounding boxes, and a merged run of shapes
    of one look (§15 M6 "the object budget") as a `line`: an older build draws nothing for a run without an
    outline and the run's outline colour along the union box's midline for one with an outline (the M6
    drawing needs the stroke, so it cannot be left out of the legacy fields);
  - video as its poster picture;
  - the art as an ordinary image.

  Hub and clients ship together, and the socket version check reloads clients. After a rollback, though, the next save of an imported presentation loses its formatting for good. The release notes say so. The schema ships one release before the importer starts writing the new fields.
  - Text is the exception to "closest": rich text needs the unscaled `fontSizePx` and the shape's own box, so the legacy values beside it are not M1's legacy emission (`EmitOptions.richText: false`). An older build after a rollback draws a PowerPoint-shrunk box at its unscaled size (`fitScale` is stripped) and so overflows it, ignores `lnSpcReduction` in `lineHeight`, wraps `wrap="none"` lines (the box is not widened), and places text at the smallest inset without folding the other insets or paragraph margins into the box. Accepted: the rollback window is one release, and the release notes say that imported text may overflow or wrap there until the presentation is imported again.
- **Each field is wired everywhere it is read, in the same change:**
  - the schema;
  - `sanitizePresentation` (runs and paras are cut together with the text: a run whose start is at or past the cut is dropped, its end is clamped; extra paras are dropped);
  - the `clamp.ts` whitelists (`clampStyle`, `clampObject`, `clampSlide`);
  - drawing (`text2d.ts` / `text/`);
  - the editor panels and `SlideCanvas`;
  - `referencedMediaIds` and `referencedFontFamilies` / `jobFontFamilies`;
  - both `slideImages` copies (`thumbs.ts:210-222`, `link-core.ts:982-995`);
  - `previewMedia` (`preview.ts:34-53`);
  - design/11, design/15 and design/20.
- **`clampObject` rules:**
  - runs that are unsorted, overlapping or out of range are dropped;
  - paras are capped at 1,000 (render) against 5,000 (schema);
  - path strings are re-tokenised (only `MLCQZ` plus numbers) before `new Path2D`;
  - a box's font size (`fontSizePx`) is clamped to 4-1,000 px, and every run's effective size (`fontSizePx × sizeScale`, after autofit) to 2-1,000 px, the same bounds as `IMPORT_LIMITS` (`fontSizeMin`, `runFontSizeMin`; the parser's 1-4,000 pt clamp applies only before conversion). Raised and lowered runs and bullets are still drawn at no less than 4 px (§6).
    - Why 2 px for runs (`CLAMP.minRunFontPx`): it is 1 pt, PowerPoint's smallest size, on both standard deck sizes, and the office model's rounding never goes below it either. Dense verse decks separate list items with 1 pt paragraphs (`<a:rPr sz="100"/>` on a space), which PowerPoint and LibreOffice draw 2.4 px tall; at the 4 px floor each was 4.8 px and every line below it moved 2.4 px further per spacer (a list pitch of 21.4 px against LibreOffice's 19.1). With the run floor at 2 px (measured against LibreOffice's pictures, `--lo-compat`), four slides of worship shards 0 and 2 rose, from 0.342, 0.344, 0.292 and 0.544 to 0.764, 0.464, 0.388 and 0.563 (shard means 0.795 → 0.801 and 0.832 → 0.834); no other slide moved by more than 0.001 and none fell, and the sermon decks did not change. Box sizes keep 4 px, so legacy text, bands and an older build draw as before.
- **`PptxRenderer` is not widened.** "native" exists only as a route form field and in the job payload. Native imports are recorded in `source.native`, so an older build never resets presentation settings through quarantine.

### 3.3 Runtime types (TypeScript only, all optional, so old snapshots and journals stay valid)

```ts
// packages/domain/src/live.ts
Cue += {
  hidden?: true;                          // slide cue of a hidden slide: next/prev/auto-advance/onEnd skip it
  mediaObjectId?: string;                 // slide cue: the ImageObject that plays `mediaId` in its box
  mediaStart?: 'auto' | 'click';
  mediaShowWhenStopped?: boolean;
  slideAudio?: { mediaId: string; start: 'auto' | 'click'; loop: boolean; gainDb?: number; untilCue: number };
};
MediaContent += { objectId?: string };
AudioContent += { untilCue?: number; slideOwned?: boolean };

// apps/output host protocol
MediaCommand 'load' += { gen: number };   // the link's slot generation (SlotMirror.gen)
MediaCommand += { k: 'vclear'; slot: number; key: string; at?: number };  // the host sends ToRender 'vclear'
ToRender 'vframe' += { gen: number };
ToRender 'vframe' += { startedAt?: number; loopMs?: number };  // while playing: the clock frames are presented by (§7.2)

// packages/renderer/src/stacks.ts, messages.ts, plan.ts
export const SRC_SCENE = 3;
Stack<B> += { over: B | null; plane: Float32Array /* 16, pre-allocated, copied with set() */; videoGen: number };
StackContent<B> += { over?: B | null; plane?: Float32Array; videoGen?: number };  // SRC_SCENE also uses videoSlot
AssetJob 'slide' += { video?: { objectId: string; slot: number; gen: number } };
SlideDesc += { video?: { objectId: string; mediaId: string; hash: string } };
MediaDesc += { inSlide?: { objectId: string; showWhenStopped?: false } };
```

### 3.4 Size budgets

Whole presentations travel in goLive (to every client, into the journal, snapshots and 8 cached bundles, through a 1.5 s library fetch), `preview` and `live.adopt` (16 MiB, the socket is closed above it), PUT (32 MiB), library snapshots and deltas (every presentation to every operator) and revisions (full copies). Rich slides are about ten times larger than today's picture slides, so:

| Unit              | Budget                                                                                                                                                                                                                        | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slide JSON        | typical ≤ 8 KB (measured 3.4 KB); hard 64 KB, else picture class                                                                                                                                                              | `classify.ts`; `emit.ts` stops writing text formatting past it, writes large geometries once as geometry files (`ShapeGeom.ref`, M6 round 2), measures the slide as the hub stores it (`storedSlideBytes`) and classes a slide still over it picture (`EmittedSlide.overBudget`); the hub's import treats that slide as its own slide budget does, so a slide over 64 KB either way is one compact picture slide, logged once and counted once |
| Geometry files    | ≤ 400 KB each (8 paths of 40,000 characters); ≤ 32 MB per import, else the slide that needs more is compact                                                                                                                   | `geoms.ts` (hub), `PPTX_LIMITS.geomFileBytes`; readers refuse a larger file                                                                                                                                                                                                                                                                                                                                                                    |
| Presentation JSON | ≤ 4 MiB at import. Once the running total passes 3 MiB, the remaining slides use the compact picture class; the import card says so. The editor warns above 4 MiB but saves (PUT allows 32 MiB).                              | importer, editor                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Preview           | only the previewed slide's section is sent, with the presentation-level fields (`previewSlice`), so it stays far below 16 MiB                                                                                                 | `PreviewControl.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Resolved playlist | `resolvePlaylist` adds a `degraded` warning above 12 MiB ("too large for an operator takeover"). The operator checks the size before `live.adopt` and refuses locally above 15 MiB instead of tripping the cap.               | `goLive.ts`, operator engine                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Library snapshot  | its size is reported in hub health; a test keeps a year of weekly 17-slide sermon decks under 6 MB. A summary-only snapshot (bodies fetched on open) is the follow-up if a venue passes 32 MB; it is not part of this design. | health, test                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Revisions         | unchanged policy (50 or 30 days); a 1 MB presentation edited often costs ≤ 50 MB, noted in design/12                                                                                                                          | docs                                                                                                                                                                                                                                                                                                                                                                                                                                           |

As built in M3 (`packages/domain/src/size.ts`):
- `planImportSizes(sizes, compact, reserve)` keeps 256 KiB of the 4 MiB for the presentation's own fields, sections, arrangement and `source.log`, and returns the reason per compact slide ('slide' over 64 KB, 'presentation' for the tail) and the tail's first slide: the tail is contiguous, "slide n and later". `compactSlide` is the version-1 compact form (no objects, `pending`, the text in `artText`); `compactSlideBytes` adds version 2's page picture and text boxes, so a compact slide counts its text twice. A 2,000-slide deck of 300-character slides keeps about 200 editable slides that way; if version 2 dropped `artText` once aligned text boxes carry the text, it would keep about 800.
- `previewSlice` also sends the slide after the previewed one, for the next-slide band. The operator refuses a preview over 15 MiB, warns on save above 4 MiB and refuses above 32 MiB.
- Above 15 MiB the operator never sends `live.adopt`: it holds the service to End service and then ends the hub's older copy with its idle state (design/17 "Hub returns"). A 13 MiB playlist gets the warning and still hands back; §14.10's two checks are separate thresholds.
- Hub health reports `librarySnapshotBytes` (design/12 "Logging and diagnostics"). A year of weekly synthetic sermon decks (52 × 17 slides through the converter, 5 pictures each) measures 1.5 MB.

## 4. Parser and converter rules

**Order and identity**
- Slides are ordered by `p:sldIdLst`; if it is empty, by `slideN` number. At most 2,000 slides.
- Hidden slides are imported in place with `Slide.hidden` (they become flagged cues, §9).
- Every per-slide result is keyed by the **shown index**: media, LibreOffice pages, and textBoxes on picture slides. This fixes the verified shift after a hidden slide (`imports.ts:550`). Picture-class slides set `imported.textAligned`.

**Alternate content.** `mc:AlternateContent`: use the first `mc:Choice` whose `Requires` namespaces the parser understands, else `mc:Fallback`, never both. `annotate.ts` walks both branches; that is not ported.

**Inheritance**
- Placeholder matching:
  - on the layout, by idx, else by type;
  - on the master, by type class: ctrTitle and title → title; dt, ftr, sldNum and hdr → themselves; everything else → body.
- xfrm and bodyPr come from own → layout → master.
- A placeholder with no position anywhere: dt/ftr/sldNum/hdr are not drawn; any other placeholder gets the whole slide.
- Empty placeholders (prompt text only) are not drawn.
- The paragraph-property chain is, nearest first:
  1. the paragraph's own pPr;
  2. the shape's lstStyle;
  3. the layout placeholder's lstStyle;
  4. the master placeholder's lstStyle;
  5. master txStyles: titleStyle for title placeholders, bodyStyle for other placeholders, otherStyle for dt/ftr/sldNum/hdr;
  6. presentation `defaultTextStyle`.

  In each list: `lvl(N+1)pPr`, then `defPPr`.
- **Non-placeholder shapes use `defaultTextStyle`, not otherStyle.** This was verified in LibreOffice and matters in 126 of 580 decks. `annotate.ts:1941-1946` has it wrong.
- The nearest `buNone` switches bullets off.
- Run properties: a run's own `rPr` wins. Otherwise each property takes the first `defRPr` value along the chain. An own solidFill or noFill overrides an inherited gradient.

**Colours**
- Colour elements: srgbClr; schemeClr through clrMap, overridden attribute by attribute by the slide's `clrMapOvr` (which also applies to inherited master and layout shapes and to the background); sysClr lastClr; the full prstClr table; scrgbClr (gamma-encoded); hslClr.
- Modifiers apply in document order:
  - tint and shade work on linear values with γ 2.3 (LibreOffice: black + tint 95% = #454545);
  - lumMod, lumOff, satMod, satOff, hueMod and hueOff work in HSL;
  - alpha, alphaMod and alphaOff.
- `phClr` takes the referencing style's colour (fillRef, lnRef, effectRef, bgRef). Its own modifiers apply after that colour's.

**Fonts.** A run's typeface comes from its rPr latin, else the inherited one, else the theme (+mj-lt for title placeholders, +mn-lt otherwise). ea and cs are resolved the same way, including `+mj-cs`/`+mn-cs` and the theme's per-script `a:font` entries. The family stays the deck's own (e.g. "Calibri"). Substitutes, the ea/cs families and the bundled script fallback for every script present in the text go into `fallbackFonts` (§10).

**Text bodies** → one `TextObject` per body, `style.lineModel = 'office'`:
- `style` is the dominant run's values (most characters). Other runs become sparse `runs`.
- Paragraphs become `paras`: align (incl. justify and distribute), level, marL/indent, spacing (spcPts in 1/100 pt; spcPct as a share of F), line spacing, bullets, rtl. `a:br` becomes `\n` with `soft: true`. `a:tab` becomes a space (logged once per deck; Canvas draws tabs as spaces).
- Sizes: px = pt × 12700 × s, clamped to 1-4,000 pt in the parser and when stored to 4-1,000 px for the box size and 2-1,000 px for a run (§3.2). A run's `sizeScale` is its real size over the box's, never raised to the box floor: a 1 pt spacer under 7 pt text is 2/14.
- Text outline: `a:ln w` → `outline.width = w/2`, because ordo strokes 2× under the fill. An outline without a solid fill is not drawn. Hollow text (noFill) becomes alpha 0 plus the outline.
- Run text shadows and coloured outlines are drawn as PowerPoint draws them.
- `cap="all"` → `caps` (applied at draw time, so offsets stay valid). Fields keep their stored `a:t` text (logged). Hyperlinks are dropped (logged).
- Body properties: insets (defaults 7.2/3.6 pt) → `insets`; anchor → `valign`; `wrap="none"` → `wrap:false`.
- Autofit: `normAutofit` → `autofit:'shrink'` plus `fitScale` from fontScale/lnSpcReduction of the shape's own `a:bodyPr` (an inherited `normAutofit` keeps the policy, but its scale was fitted to the layout's prompt text, so the box shrinks from full size). `spAutoFit` keeps the stored (already grown) xfrm; the editor warns when later edits overflow it (§11).
- Text in non-rect presets uses the preset's text rect from the POI table (M6). Before M6, rect/roundRect/ellipse text rects are computed directly; other presets are 'approx'.
- `vert ≠ horz` and `anchorCtr` are residual until M9; `numCol > 1` until M8; `anchorCtr` only when it moves text, not when every paragraph that draws something is centred (a centred line keeps its place whatever the width of the centred block).

**Shapes with text.** A shape that has a fill or line _and_ text becomes a `ShapeObject` plus a `TextObject` sharing `origin.group`. The editor selects, moves and transforms them as one group (§11).

**Pictures** (`p:pic`, and blipFill on shapes) → `ImageObject{fit:'stretch'}`:
- `crop` from srcRect (negative values allowed). fillRect insets fold into the box and the crop.
- `mask` from prstGeom/custGeom; flips; `alphaModFix` → opacity; `a:lum` → `adjust`.
- duotone, clrChange, grayscl and biLevel are baked at import into a derived PNG (a new deduplicated Media, still replaceable).
  - _As built (M6 wave 2):_ so are `a:lum` brightness and contrast, so PowerPoint's recolour presets (grayscale, sepia, washout, black and white, the accent duotones) all are. The converter reads the effects in document order with their colours resolved (in the fill's own colour context, so a theme fill's `phClr` is its reference's colour) and lists each distinct part and recipe once as a `pptxmedia:bake<n>` placeholder with its recipe (`@ordo/pptx-scene` `bake.ts`); the hub decodes the source with ffmpeg to RGBA at the picture's prepared size, applies the recipe in pool task `pptx-bake` with LibreOffice's arithmetic (luminance, thresholds, the colour change's tolerance by format, PowerPoint's brightness and contrast) and stores the result as a ready picture, deduplicated by the source's hash and the recipe (`apps/hub/src/pptx/bakes.ts`). `alphaModFix` stays the image's `opacity`. Any other blip effect (a blur) keeps the picture approx, drawn without it; a picture that cannot be baked is drawn as it is, with a warning.
- `a14:imgProps/a14:imgLayer`: the blip is PowerPoint's already-corrected result (verified on 20 slides of real sermon decks), so it is drawn as is. `.wdp` layers are ignored.
- `svgBlip` uses its PNG fallback; raw SVG is never used.
- EMF/WMF are converted to PNG by LibreOffice in the follow-up job (the slide is `pending`).
- **Picture preparation** (`apps/hub/src/pptx/pictures.ts`), so no consumer decodes more than it shows:
  - The bytes are sniffed and the header is checked (PNG/JPEG/GIF/WebP; ≤ 8,192 px a side, ≤ 40 MP after preparation).
  - The display need is the widest use of the part in the deck: the box width at 3840 px ÷ the visible crop fraction, capped at 8,192 px.
  - A source more than 1.25× its need is downscaled by ffmpeg: JPEG q90 when opaque, PNG or lossless WebP with alpha. This is the same rule the hub already applies to uploaded images over 3840 px, which a ready-picture path would otherwise bypass.
  - TIFF and BMP become PNG. Animated GIF, APNG and animated WebP become a first-frame PNG (logged).
  - Pictures are drawn as stored. PowerPoint ignores a JPEG's EXIF orientation (the boxes of tagged photos in
    the worship set have the stored aspect) and browsers apply it, so preparation removes it: the tag is set
    to 1 in a kept copy, and conversions do not turn the picture.
  - The original stays in the stored deck, so a re-import can use it.
  - Pictures are stored with alpha through `addReadyPicture` (ready, no job), deduplicated by SHA-256 of the prepared bytes plus the source part's hash.

**Simple shapes.** rect, roundRect, ellipse, line and straight connectors with a solid fill/line → `ShapeObject` with legacy fields only. Everything else is M6 (`geom`, `gradient`, `dash`, `ends`, effects).

**Groups** are flattened into absolute boxes with `origin.group`, using a composed full affine:
- child box → scaled chExt→ext and translated, then the group's rotation and flips about its centre;
- a missing off/chOff means the origin; ext and chExt substitute for each other;
- depth ≤ 32;
- a child's own box is scaled along the group's axes, then turned, so it is never sheared; turned by 45° up to 135° (or 225° up to 315°) it takes the scales the other way round, as LibreOffice imports it and says MSO draws it (M6 wave 2 round 1, measured with a probe deck);
- a child the composed affine would shear is approx (`shear`): placed so, not left to the art.

**Master and layout decorations** are drawn under the slide's own shapes unless `showMasterSp="0"` (on the slide or the layout). They become objects with `role:'deco'`: unlocked, deletable per slide, and covered in bulk by 'Apply to similar'.

**Backgrounds.** Looked up on the slide, else the layout, else the master. `bgRef ≥ 1001` means `bgFillStyleLst[idx−1001]` with phClr.
- A picture background (stretched, aspect within 1% of the slide, no crop, tile, recolour or alpha) on a 16:9 deck → `Slide.backgroundMediaId`. The aspect must be known: a spilled picture's size is read from the first bytes of its file (`ParseOptions.pictureSize`), and a picture of unknown size stays a bottom image stretched over the slide on white. It is promoted to `Presentation.backgroundMediaId` when every slide shares it (the pro7 pattern, `pro7.ts:838-857`), so the existing pickers swap it.
- Any other picture background → a bottom `ImageObject{role:'bg'}`. The background layer is cover-fit while PowerPoint pillarboxes 4:3.
- Solid or gradient → a bottom rect `ShapeObject{role:'bg'}` over the slide area. With the import option 'Extend plain backgrounds to 16:9' (on by default), it covers the whole 1920x1080 frame instead.
- Tiled → pre-tiled into a picture at slide size.
  - _As built (M6 wave 2):_ with the tiled picture fills of shapes, through the same bake: one picture over the whole box at its display need, the tile the picture's size at its header's stated resolution (PNG `pHYs`, JPEG JFIF; else 96 dpi) times `sx`/`sy`, its corner by `algn` and `tx`/`ty`, every other tile mirrored by `flip`, `a:srcRect` the part one tile shows. A tile of unknown size is drawn stretched, as before.
- 4:3 decks otherwise keep their 240 px bars empty, so the playlist or presentation background, or black, shows through. `source.native.slideRect` records the slide area for the editor's guide.
- A background is never baked into an art picture (§5).

**Media.** `p:pic` with `a:videoFile`/`a:audioFile` + `p14:media` (see §8):
- **Video:** the poster blip becomes the `ImageObject` and the clip becomes `play`. Videos are never baked into an art picture.
- **Full-slide video at the bottom of the z-order, looping and muted:** `backgroundMediaId` (a motion background).
- **`<p:video fullScrn="1">`:** the play box becomes the slide rect with the poster contain-fitted.
- **Audio** (any audio file or narration): `Slide.audio`. Transition sounds and animation sounds are skipped by default (import option 'Import transition sounds'). They are short effects, and a slide sound replaces running playlist audio once it starts (at once for an autoplay sound, on F8 for a click-start one; §8). The audio icon is dropped unless `showWhenStopped` is set and it is on-slide.
- **Kind** is decided by sniffing the bytes, not the element: pptxgenjs writes audio under `a:videoFile`.
- **Linked External clips:** `[warn] slide N: linked video (<host>) not imported`, never fetched. Their poster stays as an ImageObject.

**Church mappings**
- `lyricObjectId` = the body placeholder with the most characters; else the largest text by characters × area, excluding title, footer, date and slide number. The title is used only when it is the only text. On bilingual slides with one box per language, the first box in reading order is the lyric box. Lengths are compared with Han, Kana and Hangul weighed as 2.5 Latin characters (a Korean line takes a quarter to a half of the characters of its English translation), and languages like with like: different script classes, or two different primary subtags when both boxes carry a language. The other box gets `role:'translation'`, for a later bilingual band.
- notesSlide body → `Slide.notes`.
- `p14:sectionLst` → Sections plus a Default arrangement in order.
- Transitions: fade/dissolve → `Slide.transition` crossfade (`p14:dur`, else 700 ms); none → cut; anything else → crossfade (logged).
- `advTm` → `durationMs`. A looping show with every slide timed → kind `loop`.

**Defects not ported from `annotate.ts` / `pptx.ts`:**
- otherStyle used for non-placeholder text;
- tint/shade blended in gamma-encoded space;
- scrgbClr without gamma encoding;
- walking both mc branches;
- missing satMod/hue modifiers, hslClr and most prstClr names;
- unresolved cs fonts;
- pptx-preview's text rectangles;
- two default slide sizes;
- independent x/y scaling (`pptx.ts:409-412`);
- hidden slides counted in the page index;
- plain `{}` maps keyed by deck strings.

## 5. Classification, fallback and LibreOffice

**Element support**
- **Residual:**
  - a chart (`a:graphicData uri` …/chart);
  - SmartArt without `ppt/diagrams/drawingN.xml` (with it, the shapes are drawn natively as a locked group with editable text);
    _as built (M6 wave 2, `pptx-scene` `smartart.ts`):_ the drawing is the one the data model's `dsp:dataModelExt` names; its `dsp:` shapes are read through the ordinary shape walk at the frame's coordinates, each node's text in PowerPoint's text rectangle (`dsp:txXfrm`) and in the colours part's node text colour (LibreOffice's rule); a drawing is native or in the art as a whole (a residual shape in it, an art element above part of it inside the art range, or the 150-object budget sends all of it), and the render copy keeps its frame;
  - OLE;
  - maths;
  - ink;
  - sp3d with a non-zero bevel or extrusion (a no-op scene3d/sp3d is ignored);
  - a real `prstTxWarp` (not textNoShape);
  - vertical text (until M9);
  - tables (until M6; since M6 only those with vertical cell text or past the slide's object budget, a table of more drawn cells than a slide may have objects among them);
  - a metafile that fails conversion.
- **Approx** (drawn natively, logged): reflection, inner shadow, soft edge on pictures before M8, kerning differences, unknown transitions.
- Everything else is native.

<!-- m9:conv-seams -->
_As built (M9 wave 1, track `conv-seams`):_
- **One decision table** (`pptx-scene` `residual.ts`, `RESIDUAL_ROWS`): a row per reason the classifier and
  the readers write (`ElementBase.reasons`, the census's `art:<reason>`), with its decision (`native`,
  `approx`, `residual`, or `unread`: not in the IR, such as ink), the census features it is a case of, who
  rates it (the classifier from the XML, a reader's own verdict, a slide budget) and, for a residual one, the
  kind a hub without LibreOffice records (`MISSING_KINDS`: `chart`, `smartart`, `ole`, `metafile`, `math`,
  `ink`, `decoration`, else `element`). `classify.ts` rates elements through it (`decisionOf`); every
  `FALLBACK_FEATURES` entry has a row, and the census features and tiers do not change with a decision. The
  M9 areas change their own rows.
- **Real 3-D is approx, never residual**: a bevel with a size or an extrusion is `3d`, or `3d:camera` when
  its `a:scene3d` camera turns the face (a preset other than `orthographicFront`, `perspectiveFront`,
  `legacyObliqueFront`, `legacyPerspectiveFront`, or a rotation with a latitude or longitude). It is drawn
  flat, as version 1 already drew it and as LibreOffice's art shows 63 of the 68 `art:3d` slides, with the
  note "3-D is drawn flat (an approximation)". A SmartArt drawing with bevels (3-D quick styles) is therefore
  native rather than sent whole to the art. Only on a slide past the 150-object budget does real 3-D still go
  to the art first (`budget:3d`, reason `art:budget:3d`), drawn flat in version 1 until the art replaces it,
  as all real 3-D did before: the budget's other steps then choose as they did (where 3-D shapes go past the
  budget once decorations hold its shapes is `decor-conv`'s, M9 decision 6).
- **Measured** (`scratchpad/m9/w1/conv-seams/`). Census over E: `art:3d` on 74 slides → 0. 59 worship slides
  and the sermon 3-D slide go hybrid → native (worship native 2,620 → 2,679 of 2,820, 95.00 %; sermons 73 of
  73); 3 hybrid slides keep their other residual (OLE, vertical text, a warp); the 11 picture slides with
  3-D stay pictures for their budgets alone (10 + 1 `budget:pictures`; 1 over 64 KB as stored, `art:budget:3d`
  in place of `art:3d`). No slide's class got worse; no slide's objects changed (the 63 that were hybrid
  store one note more). The harness (`--lo-compat --before hub`) draws all 74 slides exactly as before:
  their score equals the before-harness one on every slide (mean 0.8719 hybrid, 0.9311 picture). Their
  before-hub score, LibreOffice's own pixels pasted in the art box, stays higher (0.9556 on the 60 now
  native; 39 of them more than 0.02 above): the 3-D look of `three-rim` and `three-turned` is what closes it.
- **Without LibreOffice** (`EmitOptions.libreoffice: false`, `hybrid.ts` `withoutLibreOffice`): neither the
  art nor the metafile conversion is planned (`EmittedSlide.art` and `.metafiles` absent, so nothing is
  pending). Version 1's objects stay as they are, and what nothing draws is listed by kind
  (`EmittedSlide.missing`: each residual element of the art range, `smartart` for a SmartArt drawing's, and
  `metafile` for pictures waiting for conversion); the slide is class hybrid (decision 8) with a reason
  `missing:<kind>` per kind after its own, `EmittedSlide.artText` keeps the art's text, and one note says
  what is not drawn. A picture-class slide is left to the budget ladder (`ladder`).
<!-- /m9:conv-seams -->

**Slide class.**
- **native:** no residual element, ≤ 150 objects, ≤ 12 distinct pictures, ≤ 64 KB of JSON, every path ≤ 4,096 points.
- **hybrid:** let Rmin and Rmax be the z positions of the lowest and the highest residual element. The **art range** is [Rmin, Rmax].
  - The **art** is one locked, transparent `ImageObject{role:'art', locked:true, fit:'stretch'}`, placed in the z-order at Rmin. Its box is the bounding box of the elements it contains.
  - The art contains every residual, and every non-residual element of the art range that overlaps an art element above it.
  - Elements below Rmin and above Rmax are native objects at their own z. A non-residual element inside the range that no art element above it overlaps is also native, placed just above the art.
  - The slide background, any `role:'bg'` object and every play video are always native. They are never inside the art, even when that bends the z-order: a residual drawn above a video it overlaps ends up under the video, which is logged as approx.
  - Text of text bodies that end up inside the art goes to `pptx.artText` (search and labels).
  - Any drawer, and any old build, draws this as an ordinary image object.
- **picture:** a parse failure on that slide, or budgets the hybrid split cannot meet. Stored as `imported` with textBoxes, keyed by shown index, with `textAligned`. The page picture is stored at the slide's aspect, not padded, so contain-fit leaves the same empty bars as native slides.
  - _As built (M6, fidelity round 1; `pptx-scene` `classify.ts` `shapeRuns`, `fitShapes`, `emit.ts`):_ before a slide over 150 objects is a picture, two steps keep it native or hybrid.
    - **Shapes of one look are one object.** On a slide over the budget with every shape apart, z-adjacent shapes without text in one top-level group or among one layout's or master's decorations, with the same opaque solid fill and the same opaque solid line (either may be none), without arrowheads, shadow, glow or soft edge, are one `ShapeObject`: their paths (at most 8, each string within 40,000 characters) in z-order, each shape's rotation and flips in its points, in the union of their boxes. `drawGeom` fills and strokes path after path as separate shapes are drawn, so it looks as they do; the one order it changes is an open outline, which a geometry strokes after all its paths, so a shape with both a fill and a line merges only when its outlines are closed. Its legacy shape is a line (no filled union rectangle for an older build), as a thin custom geometry's is. The slide's own ungrouped shapes stay apart. Tables and SmartArt drawings go to the art only when this is not enough.
    - **Then elements without text go to the art** (`budget:shapes`, reason `art:budget:shapes`): the fewest of the layout's and master's decorations without text, bottom first, so the art stays at the bottom and the slide's text native above it; then the costliest z-contiguous run of pictures and shapes without text in one top-level group, and once no group has one, of ungrouped ones. Such an element emits nothing in version 1 (as a residual table), so version 1 stays within the budget with the slide's text drawn until the art replaces it. A slide stays a picture when it passes the budget with every element without text in the art (its text alone does), or passes 12 pictures or 64 KB.
    - Measured: of the 44 shown worship slides of shards 0-2 that were picture class for `budget:objects` (12 decks, 150-784 objects), 10 are native, 6 hybrid for residuals they already had (sheared group children, custom geometry past the bounds, a table) with their runs merged, 27 hybrid with `art:budget:shapes`, and one picture for its 64 KB of text formatting; all native and hybrid ones have at most 150 objects in version 2. Against LibreOffice 24.2 (`--engine native --lo-compat`): the native ones 0.964 → 0.981 (before, the renderer's 200-object clamp cut their top objects in the harness), the hybrid ones 0.833 → 0.913 without the art and 0.989 with LibreOffice's pixels in the art box (an estimate of version 2). No other slide of the shards or the sermon decks changes (the sermon decks stay 0.955; shard 0 goes 0.843 → 0.842, all of it the one picture slide, drawn by LibreOffice in the hub). Version 1 of 6 of the hybrid slides still passes 150 objects, from the residual shapes (shear, 3D) every hybrid slide draws natively until its art arrives.

The budgets keep slides inside the render clamps (200 objects, 16 images, 192 MiB, `clamp.ts:22-38`), so nothing is silently dropped.

<!-- m9:decor-conv -->
_As built (M9 wave 2, track `decor-conv`; `pptx-scene` `budget.ts`, `decor.ts`, `sheet.ts`, `bake.ts`; decisions.md
"Slow-to-draw elements"):_ **the budgets never make a slide hybrid or a picture.** Nothing is sent to the art for
a budget, and nothing for being slow to draw: the drawing budgets choose how an element is drawn (from the
slide's decoration plate, or live), never whether. The M6 steps above stay only behind `ParseOptions.budgetArt`,
the fidelity harness's A/B.
- **Culling** (always, before anything is counted): an element whose bounds, grown by its shadow, glow and half
  its outline, miss the slide area (the deck's, not the frame: a 4:3 deck's side bars are off the slide), or a
  shape that shows nothing (no visible fill, line, text or effect), is not imported, as a hidden element: not
  emitted, counted, put in the art or its text. Clips, sounds and SmartArt drawings' elements are never culled;
  groups per leaf. On the shown slides of E: 3,059 elements on 287 worship slides, 2 invisible shapes on 2
  sermon slides (no drawing change).
- **The steps**, each after the first only while the slide passes 150 objects as version 1 draws it (the art
  range's elements counted as themselves: version 1, and a hub without LibreOffice for good, draws them), the
  runs that save most first, stopping as soon as it fits: a table or a chart is one object; shapes of one look
  merge as above; **decorations** of one SmartArt drawing, top-level group or layout/master source, then of one
  source (the slide's own ungrouped shapes too), each one locked `ShapeObject.decor`; between them
  **composites** of z-adjacent plain pictures (any rotation) as one picture over their union box; and, only for
  a slide still over, real 3-D drawn flat in decorations (`3d:flat-in-decoration`; otherwise 3-D never joins a
  decoration, and merges by look only with an equal 3-D digest and disjoint boxes, decision 6). Objects left
  that are text or that no step can merge stay up to 190; past that, and never past the render clamp's 200,
  the guard leaves the topmost elements without text out, then text (class hybrid, `missing:<kind>`; never
  reached on E). Past 12 distinct pictures an **atlas** packs the fewest smallest into one sheet, each object
  keeping its box and showing its cell through its crop.
- **A decoration draws what its shapes draw**: each member is emitted as a single shape is, then its geometry
  built at its box as the renderer builds it and placed (flips, rotation) into the decoration's own space (its
  box in logical px); parts in z-order, a member's first marked `s: 1`; its look a paint (fill; gradient laid on
  the member's own box, `DecorPart.frame`, mirrored by its flips; stroke; dash; shadow), equal paints shared;
  a path too long for one part a `cont` chain. A member is drawn as `drawGeomShape` draws a shape: its shadow,
  then its fills and stroke, with miter joins and flat caps, so an outline with round or bevel joins or round
  or square caps joins only when it is at most 2 logical px wide (`THIN_LINE_PX`; `DecorPaint` has no joins or
  caps). Caps: 256 parts, 64 paints, 16,384 points, 24 shadowed shapes. Legacy: an empty line, locked (an older
  build draws nothing, §3.2). A large decoration is a decoration file (`DecorData.ref`, `pptxdecor:<n>`), only
  with the 'decorFile' field: the hub's and the client's `M9_WRITES` leave it out until `decor-render` names
  decoration files, so their decorations keep their parts in the slide and no placeholder is ever stored.
- **Sheets** (`pptxmedia:sheet<n>`, `EmitResult.sheets`, `SheetBake`, made by the hub and the harness,
  `decor-render`): cells at the 3840 density, in z-order, each the picture as its object draws it (crop,
  recolour, flips, a turn by quarter turns exactly or by any angle sampled bilinearly, opacity), at most 64
  cells, 8,192 px a side, 16 MP out and 32 MP decoded; the objects as they are without the sheet go with it
  (`EmittedSlide.sheets`), for an importer that cannot make it.
- **Kept whole** (the wave 1 re-review): an object past the slide's drawing or effect budget is stored as it
  is, its gradient, geometry, dash, ends and effects kept (`emit.ts` `fitDrawing`, `fitEffects` no longer
  flatten it to its legacy copy), and a shape past the drawing budget is never sent to the art
  (`custGeom:complex`, `geom:complex` are no longer written): every drawer draws it as its own budget allows
  until the slide's decoration plate holds it. `EmittedSlide.plate` names the slide's static decoration stack
  (its bottom objects up to the first text, table, chart or picture that plays), the objects above it with
  effect layers, and those its drawing budgets draw past them (`pastBudget`): what the client bakes.
- **Measured** (`scratchpad m9/w2a/decor-conv/`): census of E, worship native 2,679 → 2,729 of 2,820 (96.77 %),
  hybrid 104 → 74, picture 37 → 17 (all 17 for 64 KB, the ladder's: 10 of text formatting, 7 as stored);
  `art:budget:shapes` 30 → 0, `budget:pictures` 13 → 0, `art:custGeom:complex` 16 → 0, `art:budget:3d` 1 → 0;
  BannerStyle 225 → 41 objects (culled 205 elements off the slide; its 3-D shapes merge); one slide over 150
  objects, a 96-cell table counted as one object and emitted as its M6 group until `tables-conv`'s table object.
  Sermons: 73 of 73 native, unchanged.
<!-- /m9:decor-conv -->

**One rule for every drawer.** `slideContent(slide): { pictureMediaId?: string; objects: SlideObject[] }` in `packages/renderer/src/content.ts`:
- `pptx.show === 'picture'` and `pptx.refMediaId`: the reference picture plus only the objects without `origin` (the operator's own additions);
- otherwise: `imported?.imageMediaId` plus all objects.

It is used by `drawSlide2D`, `slideVisible` (`plan.ts:138-144`), both `slideImages` copies, `SlideCanvas`, `previewMedia` and `referencedMediaIds`, where `refMediaId` is optional like holding slides and the logo. It replaces the unused `skipImported` hook (`text2d.ts:298, 322`). The picture is decoded only when shown, which matters for the 16-image and 192 MiB budgets.

As built (M3 wave 2):
- The rule is `slideContent(slide): { pictureMediaId?, reference, objects }` in `@ordo/domain` (`content.ts`), with `drawnMediaIds(slide)` (the picture, then the image objects drawn, once each). `@ordo/renderer` re-exports both and adds `drawableContent(slide)`, the rule over the clamped slide, memoised per slide.
- Drawers: `drawSlide2D` (as authored; lyric-only bands still read the slide's own text), the scene split (`sceneSlides`: the split is over the drawn objects, base starts with the picture; an imported play object under a reference picture is no scene), the planner (`slideVisible`; the in-slide video only for a drawn play object, so an imported clip under a reference picture is not drawn and its sound still plays on the audio master, as in lyric-only looks), `jobFontFamilies`, the thumbnail worker, look previews (`lookPreviewJob`), the editor canvas (`canvasContent`: only the drawn objects are selectable) and `previewMedia`.
- Media: both `slideImages` copies, `previewMedia` and `referencedMediaIds` name the pictures drawn, so a goLive ships the reference picture and the operator's pictures, not the imported pictures it hides. A reference picture that is missing or not ready never refuses the service: it is left out with a `degraded` note at the slide ("the slide shows only the objects added in ordo"). The render clamp's 16-picture budget counts only drawn pictures, and keeps the hidden objects, whose text bands and the stage still read.
- `origin` is what tells the import's objects from the operator's: the native job marks every object it writes (converted objects, metafiles put back by version 2, the job's own background on white; the art already was) with at least `{ src: 'pptx' }`, keeping an origin the converter wrote.

**Two-phase save.**
- Version 1 has native objects for every slide.
  - Hybrid slides show their non-residual elements natively. Residuals are left out until version 2.
  - EMF/WMF pictures are left out until converted.
  - Slides that wait for LibreOffice carry `pptx.pending`; `resolvePlaylist` adds a `degraded` note for them, so goLive is never refused.
- The heavy `pptx-lo` job is enqueued **before** any clip ingest. Jobs run FIFO per class (`jobs.ts:160`), so art no longer waits behind the deck's own video transcodes.
- While the presentation is live-locked (ADR 0007), the job re-queues itself with backoff and never writes it.
- When it runs, it:
  1. builds the render copy on the pool (`pptx-render-copy`);
  2. runs soffice **once**;
  3. runs `pdftoppm -r 288 -f k -l k` per needed page (page k = the k-th slide in the render copy, so hidden slides cannot shift pages);
  4. runs pool task `pptx-art`: for each art slide, from its two pages, alpha and colour, cropped to the art's bounding box. Over white and black that would be alpha = 1 − max(white − black)/255 and colour = black/alpha; the second page is yellow (#FFFF00) instead, because LibreOffice draws text of automatic colour white on any background of luminance 156 or less (verified in M3 with a probe deck: automatic black text came back white over black), so alpha = 1 − (white − yellow)/255 in the blue channel and colour = (yellow − (1 − alpha)·yellow background)/alpha. Picture-class pages are contain-fitted at the slide's aspect, 3840 px wide at 16:9;
  5. `addReadyPicture`;
  6. converts metafiles to PNG;
  7. patches only the slides whose objects still match `pptx.digest`: the art object replaces the art-range objects. A slide someone edited meanwhile gets the art as an extra locked object at the end, plus a note, and keeps the operator's objects.

**Render copy** (built in the worker, linear tag scans, part budgets):
- only the needed slides in `sldIdLst`; every art slide appears twice, once with its background forced to white and once to yellow (step 4; slide, layout and master backgrounds overridden, master shapes hidden);
- on art slides, every element outside the art and every native element inside the range is removed, so only the art's own elements are printed;
- on picture-class slides, nothing is removed except media payloads;
- media payload relationships are removed (posters stay);
- `vbaProject.bin`, OLE binaries (their preview pictures stay) and External relationships are removed;
- the outline strip is applied (LibreOffice draws coloured outlines on filled text as hollow letters; design/20:113-119).

This replaces `pptxForRendering` (`pptx.ts:546-582`), which runs on the library main thread with unbounded JSZip reads and a quadratic regex. The 'Pictures (LibreOffice)' import option uses the same worker-built copy.

**Operator fallback.**
- 'Show PowerPoint picture' (SlidePanel, and presentation-wide) queues a heavy `pptx-reference` job. It renders all shown slides once into `pptx.refMediaId` and sets `show:'picture'`.
- The route refuses it while the presentation is locked.
- The editor warns that the picture does not show their edits.
- There is no automatic per-output fallback, so outputs never disagree.

**soffice hardening.**
- External relationships are stripped from the render copy before LibreOffice sees it. This is the primary control.
- As defence in depth, soffice runs in an empty network namespace (`unshare -rn`) where the container allows it (the default Docker seccomp profile and Synology usually do not), else with proxy variables pointing at a dead port.
- An address-space cap (`prlimit --as`, tuned on the reference NAS) and the `tools.run` timeouts with SIGKILL apply.

This enforces what design/21:57-59 claims and the code does not. The Dockerfile adds `fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core`, so LibreOffice's art uses the same metrics as ordo.

## 6. Text engine (`packages/renderer/src/text`, M2)

**Entry points**
```ts
export interface Measurer {
  width(font: string, dir: 'ltr' | 'rtl', lang: string, spacingPx: number, text: string): number;
}
export type Seg = {
  start: number;
  end: number;
  x: number;
  w: number;
  run: number;
  level: number;
  font: string;
  sizePx: number;
  shift: number;
};
export type LaidLine = {
  para: number;
  top: number;
  baseline: number;
  height: number;
  x: number;
  w: number;
  segs: Seg[];
  extraPerSpace: number;
  bullet?: { text: string; x: number; font: string; sizePx: number; color: Rgba };
};
export type RichLayout = {
  lines: LaidLine[];
  fontScale: number;
  spacingScale: number;
  overflow: boolean;
  ink: Box;
};
export interface FontEnv {
  font(req: FaceRequest): string;
  readonly generation: number;
} // §10; a new generation re-lays out
// FaceRequest = { family, fallbacks, weight, italic, smallCaps, sizePx, script }; packages/renderer/src/text/README.md
export function layoutRich(m: Measurer, o: TextObject, env: FontEnv): RichLayout; // logical px, pure, memoised
export function paintRich(ctx: Ctx2D, o: TextObject, l: RichLayout, scale: number, env: FontEnv): void;
```

**Dispatch.**
- `drawObject` sends a TextObject to the rich engine when it has `runs`, `paras` or any new style field. Otherwise legacy `drawText` runs **byte for byte as today**; the existing goldens guard it.
- The rich engine's `'ordo'` line model reproduces `drawText`'s vertical metrics: pitch `lineHeight × size`, baseline at `(pitch − size)/2 + 0.8 × size` (`text2d.ts:178-180`). Turning on RTL or shrink-to-fit for an existing box therefore does not move its lines vertically.
- In both models a paragraph's `lineSpacing` is a multiple of single spacing (1.2 × F) and `lineSpacingPx` the pitch; a paragraph with neither takes the box's `lineHeight`.
- `'office'` uses LibreOffice's model.

**Bands, stage and readable text.**
- Lyric-only bands and the next-slide band draw `readableText` of the lyric object in the look's style.
- When the source object is rich (or the text contains strong RTL characters), the band goes through `layoutRich` with the look's style and the object's `paras` direction; a soft line stays soft, so it takes its paragraph's direction as on the slide. It shrinks no further than half size, as `drawText`'s bands do, so a Hebrew lyric shrinks like a Latin one.
- Legacy `drawText` sets `ctx.direction` per paragraph only when that paragraph contains a strong RTL character (first strong character wins). LTR text, and so every existing golden, is unchanged.
- The stage renders text with CSS `unicode-bidi: plaintext`, so each paragraph takes its direction from its content whatever the stage look's style says.

**Determinism.**
- Layout always runs at logical scale: `measureText` at the logical font size, positions in logical px.
- Painting applies `ctx.scale(scale, scale)` on top of the caller's transform (thumbnails translate first, the editor adds devicePixelRatio) and draws each segment at its reference x.
- Line breaks, autofit results and positions are therefore identical at 960, 1920 and 3840 wide, in the editor and in thumbnails. Today they are not: `text2d.ts:84-101` measures at device scale.
- Advances at device size can differ from the reference × scale by a fraction of a pixel. That residue stays inside a segment and never moves a break.

**Pipeline**
1. **Itemize.** Paragraphs are the `\n` pieces; `soft` continues the previous paragraph: it takes its style, spacing and direction, overriding only what its own `paras[i]` sets, and has no bullet and no space between them. Style runs are runs ∩ paragraphs. An empty paragraph's end mark is the run covering its `\n`; the last paragraph, which has none, takes the run covering the `\n` before it.
2. **Bidi.** UAX#9 per paragraph (bidi-js), run only when strong RTL characters exist or a direction is set. The base direction comes from `paras[i].rtl`, else `style.direction`, else `auto` (first strong character of the whole soft-break chain, which is one PowerPoint paragraph). bidi-js classifies UTF-16 units, so astral characters are passed as two BMP characters of their class.
3. **Breaks.**
   - UAX#14 opportunities over the logical text. U+00A0, U+202F and U+2060 (also U+2007, U+2011 and U+FEFF) never break on either side, which fixes the verified 'Dieu !' split. After a breaking space a line may still end before one (UAX#14 LB18), as LibreOffice breaks the ". \u00A0" that text pasted with two spaces after a full stop stores.
   - SA scripts (Thai, Lao, Khmer, Myanmar) break at `Intl.Segmenter` word boundaries; CJK follows the ID/CL/NS classes.
   - Emergency breaks fall only between clusters: `Intl.Segmenter` graphemes joined across a conjunct-forming virama, so Tamil 'க்ஷி' stays whole. Graphemes alone do not keep it whole: UAX#29 GB9c joins conjuncts in six Indic scripts only, not Tamil, Kannada or Sinhala.
   - An emergency break costs what its line holds, never what is left of the word: the cut is found by galloping from the piece's start (1, 2, 4, ... clusters, then a bisection), cluster boundaries are found only that far (one list per piece serves every line and autofit step), and the rest of the word is carried unmeasured until it may fit. A 10,000-letter word in a narrow box is laid out in linear time (`rich.fuzz.test.ts`).
4. **Segments.** A segment is a maximal substring with one style run, one bidi level and no break opportunity inside. It is also cut between two scripts that need different fallback faces (Han and kana count as one), so each segment asks for one.
   - A style boundary _inside_ a word of a joining script (Arabic, Syriac, N'Ko, Mongolian, Adlam) is drawn with U+200D on both sides of the cut when the letters on both sides join (by their ArabicShaping joining types: none after alef, dal or waw), which keeps medial and final forms. Widths are measured the same way.
   - Inside a cluster (an Indic syllable cluster, a letter with its marks, an emoji sequence), the cut moves to the cluster end (counted in `PreparedPara.movedCuts`).
5. **Measure.** `measureText` with `ctx.font` set to the resolved internal-name stack (§10), and `ctx.direction`, `ctx.lang` and `ctx.letterSpacing` set per segment. The trailing spacing Canvas adds after the last character is subtracted. Widths go into an LRU cache (20,000 entries, key `font|dir|lang|spacing|text`) for strings of at most 256 UTF-16 units, so a hostile word never leaves megabytes of keys in a worker. `measureText` and `fillText` always see the same string in the same state.
6. **Lines.** Greedy fill.
   - Available width = box − insets − marL − first-line indent; a hanging bullet sits in the negative indent and its box is at least −indent wide.
   - Trailing spaces hang at a wrap. At the end of a paragraph or before an `a:br` they are text and are aligned with the rest (LibreOffice 24.2 and PowerPoint: centred "Amen " sits half a space left of "Amen").
   - `wrap:false` never wraps; a line grows from its alignment (centre both ways, right leftwards, left rightwards).
   - A right-to-left paragraph mirrors its start: indents and the bullet are on the right and its trailing space hangs on the left. `align` stays visual.
   - Then UAX#9 L2 visual reordering between segments. The browser orders glyphs within a segment.
7. **Line model `'office'`** (LibreOffice, measured in the pptx-render commits; `page.ts:202-353`).
   - F = the size of the paragraph's main run: its first run without a baseline shift, else its first run, else the end mark, after autofit. A larger unshifted run raises F for its own line (LibreOffice sizes each line by its portions), so lines never overlap.
   - Single spacing: pitch 1.2F, first baseline F below the line top.
   - Proportional p ≠ 1: h = 1.2F·p·k, where k is the autofit spacing scale. The baseline is F + (h − 1.2F) when p > 1, else min(F, 0.8h).
   - At PowerPoint's stored `fitScale` (step 10) its spacing is drawn the PowerPoint way: OOXML subtracts `lnSpcReduction` (1 − `fitScale.spacing`) from every paragraph's proportional spacing, single spacing included, so p becomes max(0, p − r) and k does not apply to it (100 % less 20 % is 80 %, 90 % is 70 %, where LibreOffice's k gives 72 % and leaves 100 % alone). Exact spacing and spcBef/spcAft are scaled by 1 − r. LibreOffice's k stays for the search and for `--lo-compat`.
   - Exact spacing P: h = P·k.
   - spcBef/spcAft are scaled by k and not drawn before the first paragraph or after the last.
   - An empty paragraph takes its end-mark size; a trailing `a:br` (one that ends a paragraph, the last or one before another paragraph) adds a line as tall as the paragraph's end mark, whatever the size of the text before it, at single spacing: proportional spacing (and with it k) does not apply to it, exact spacing does. An empty line between two `a:br` and an empty paragraph keep the paragraph's spacing. Measured in LibreOffice 24.2: a 40 pt trailing line is 96 px at 80, 90 and 150 %, 80 px at an exact 40 pt.
   - Superscript and subscript are drawn at 0.58 × size (at least 4 px), shifted by baseline × size, without growing the line.
8. **Align.**
   - justify spreads extra space over the inter-segment spaces of non-last lines; distribute also justifies the last line;
   - there is no kashida (a known gap for Arabic);
   - RTL paragraphs start at the right.
9. **Anchor and insets.**
10. **Autofit `'shrink'`.**
    - Use `fitScale` while the text fits at that scale, when the box is drawn with the face PowerPoint fitted it with or a metric-compatible one.
      - PowerPoint computed the scale with the box family's own widths, so it holds only for those widths: the family's own face, or a metric substitute (Carlito, Caladea, Liberation, Gelasio and the other metric clones of `METRIC_FAMILIES` in `text/fonts.ts`). There PowerPoint's scale is what PowerPoint draws, and ordo keeps it even where LibreOffice, which fits again, draws differently.
      - The font environment decides (`FontEnv.metricMatch` of the box's `fontFamily` and `fallbackFonts`, §10). A box drawn with another face (Aptos, Corbel, Calibri Light or Gill Sans MT drawn with Inter: §10 "Non-metric families") is laid out without `fitScale` (`storedFitHolds` in `rich.ts`) and fitted from full size, as LibreOffice fits every box.
      - Why: kept, PowerPoint's 92.5 % font and 90 % spacing for an Aptos body still fits when drawn with the wider Inter (717 of 733 px), but every line breaks elsewhere than in PowerPoint and in LibreOffice, whose search ends at 37 pt and 100 % spacing instead of 41 pt and 90 %. On the sermon decks this lifted the three slides it touches from 0.734, 0.594 and 0.594 to 0.956, 0.899 and 0.899 (ordo's way 0.932 → 0.942). On worship shards 0 and 2 it changed 39 slides, each now drawn as LibreOffice's way draws it but for the other policies: 38 rose and one fell to its LibreOffice-way score; LibreOffice's way did not change anywhere.
      - The object keeps `fitScale`: uploading the real family brings PowerPoint's scale back (the font generation changes). The converter cannot decide this, because only the drawer knows which faces it has.
    - Otherwise run LibreOffice's search (`page.ts:355-402`): 10 bisection steps on the font %, quantised `floor(18·mid/100·10)/10/18·100`, spacing tries 100/90/80%, 0.5 mm slack, run size `max(1, round(round(pt)·font%))`. Because the text overflows at the stored scale, the result can only be smaller, so an edit never makes text jump larger. A box whose stored scale does not hold has none, so its size follows the search alone, as in LibreOffice.
    - During the search, widths scale linearly from one measure at the base size. Only the final size is re-measured.
    - Points are 2 logical px (both standard deck sizes). The `'ordo'` model scales run sizes exactly and has no spacing scale.
    - Text edits keep `fitScale`; only 'Re-fit text' clears it (§11).
11. **Bullets.**
    - Character bullets use their own font and size. Wingdings/Symbol PUA codes are mapped to Unicode at import (0x6C→●, 0x6E→■, 0xA7→▪, 0xD8→➢, 0xFC→✓, 0x71→❑, 0x76→❖, Symbol 0xB7→•; U+F0xx offset stripped). So are the Office themes' Wingdings 2, Wingdings 3 and Webdings bullets (Wingdings 2 0x97→●, 0x96→•, 0x9A→○, 0xA0→▪; Wingdings 3 0x75→▶, 0x7D→▸; Webdings 0x34→▸), from LibreOffice's fontcvt tables where they name a standard character and as the nearest common shape where they map into OpenSymbol's private-use area. An unknown code, a code of another symbol font (Marlett, MT Extra, Monotype Sorts, Zapf Dingbats…) and any other private-use character become '•' in the text's font: no output font draws them.
    - Automatic numbers keep a counter per level, keyed by type:startAt (`annotate.ts:2122-2137`). Labels: arabic, roman, alpha and circled ①-⑳, in period, ParenR, ParenBoth and plain forms; `(17)` for verse numbers. The same counter code serves `readableText`.
    - An empty paragraph draws no bullet and does not advance the counter.
    - A bullet is drawn at `sizePct` × F within 4-1,000 px, in its paragraph's direction and its first run's language, so a Hebrew or Arabic number reads as the band's `readableText` writes it ('.1' for '1.' in a right-to-left paragraph). It takes the first run's shadow, outline and glow (passes 2-4) and its colour, as PowerPoint gives it the first run's character formatting.

**Paint passes.** In today's order, under the scale transform:
1. text fill box (`style.fill`) and highlight;
2. shadow of every line (run shadow, else box shadow);
3. glow (`shadowBlur` with zero offset);
4. outline (`strokeText` at 2× width, round joins);
5. fill (solid; or the gradient painted over the whole box when every run shares it, else per run);
6. underline and strike (thickness F/18, underline at baseline + 0.1F, no descender skipping, as LibreOffice);
7. bullets.

Hidden paragraphs (M8) are laid out but not painted, so revealed lines never move.

**Not supported:** vertical text (residual until M9 emulates it), kashida, OpenType feature settings per call. harfbuzzjs (MIT) stays the escape hatch if browser-measured fitting proves non-deterministic across operating systems.

## 7. Drawing: Canvas 2D and WebGPU

### 7.1 Static slides

- **One bitmap per layer.** The asset worker draws `slideContent(slide)` with the shared drawers onto its CPU-backed (`willReadFrequently`) OffscreenCanvas at `scale = width/1920`, and transfers one `SRC_BITMAP`: since M7 a tight sprite at its offset where that saves pixels, else full-frame (§7.3), and marked opaque when it is a full-frame opaque picture.
- **Rasterized at device resolution:** text, vectors, gradients, effects and pictures (crop via the 9-argument `drawImage`, mask via a clip path, flip via the transform, `adjust` via `ctx.filter`). _Since M6 wave 2 (as merged):_ a mask is cut by an anti-aliased 'destination-in' fill of the union of the geometry's filled paths, not a clip (a 2D clip on an OffscreenCanvas is not anti-aliased in Chromium); a gradient of two stops inside 0..1 is drawn as stops at 0 and 1 over that part of its line (`paint.ts` `fastStops`: the same colours, on Skia's two-stop fast path).
- **Decode target.** A picture is prepared at its displayed device size, upscaling included, and converted to sRGB once.
  - The target (`pictureTarget`, `packages/renderer/src/picture.ts`) is the box's device rectangle widened to whole pixels and cut to the canvas, at most 16 MP. A 128 px tile stretched over the slide is prepared at the slide's size; a photo overflowing the slide on every side at the output's size (8.3 MB at 1080p), not its box's (35.8 MB for a 3920x2280 box). Not min(native, device): enlarging on every draw is the cost this avoids.
  - The decoder resamples the visible crop once from the decoded file (fit and crop applied) into a CPU-backed sRGB OffscreenCanvas and keeps `transferToImageBitmap()` of it (`preparePicture`). The colour profile of a JPEG that has one is therefore applied once.
  - The picture keeps its exact sub-pixel position and size inside that bitmap, as the source path draws it. Rounding the box to whole pixels was measured too; LibreOffice's `DrawTransformedBitmapEx` rounds that way, but only after quantising positions to 1/100 mm. Moving pictures by up to half a pixel lowered 141 of the 924 slides of worship shard 0 against LibreOffice, by up to 0.024 SSIM. With the exact position, 24 slides were lower, by at most 0.005.
  - Smoothing is `imageSmoothingQuality` 'medium' (bilinear, mipmapped when reducing), the closest to LibreOffice's bitmap scaling (bilinear when enlarging, area-averaging when reducing). Over the sermon decks and worship shard 0 it scored higher than 'high' (bicubic when enlarging) on 58 slides and lower on 3, by at most 0.0007; 'low' scored lower in the mean.
  - `drawImageFit` copies a bitmap prepared for exactly that target 1:1 at the target's origin, with no resampling and no clip. The image lookup receives the target, and `slidePictures` lists what `drawSlide2D` will ask for, so a decoder prepares before the synchronous draw.
  - A rotated picture, one with round corners and one over 16 MP keep the source path: decoded to cover the output (`downscaleFor`) and drawn through the transform and the clip.
  - The decode cache is keyed by hash and target (`pictureKey`). A full-slide picture takes 8.3 MB at 1080p and 33 MB at 4K, within the 256 MiB LRU.
  - The asset worker (`apps/output/src/pictures.ts`) groups a cue's uses by file: a file whose targets are not all cached is decoded once and every missing target is prepared from that decode, which is then closed (a slide showing one photo at 200 sizes decodes it once). What the draw holds is pinned in the LRU from the preload until the draw is done, so no insert or prune of the same cue closes a bitmap the draw is about to use (drawing a closed bitmap throws and loses the slide). A cue prepares at most 32 targets (the LRU holds 64) and checks each against the cue's bitmap budget before preparing it (`w × h × 4`); a target past either is drawn from the source, reduced to cover the output.
  - Why: Chromium's rasterizer resamples a picture drawn at any other size on every draw, and converts a picture that kept its colour profile on every draw. A full-slide picture cost 4.4-5.2 ms at 1920 and 17-23 ms at 3840 that way (12.8 and 46 ms with a profile), against 0.7 and 2.7 ms for a 1:1 copy. Before, a picture was decoded just large enough to cover the output and redrawn at the box's size on every draw. Harness raster p95 (median of 3 draws, Chromium's software rasterizer): on the 73 sermon slides from 10.5 to 3.4 ms at 1920 and from 44.3 to 12.4 ms at 3840; on the 924 slides of worship shard 0 from 15.6 to 5.2 ms and from 49.9 to 21.2 ms. Mean native SSIM rose slightly on both (0.9438 to 0.9439, 0.7947 to 0.7954).
  - Import-time preparation (§4) already bounds the source. The thumbnail worker draws from 640 px sources and can follow later.
- **Art and page pictures** are made at 3840 px density instead of 1920x1080, so they are no longer upscaled on 4K outputs.
- **Clear.** A first draw that is opaque and covers the frame uses `globalCompositeOperation = 'copy'`, which skips the clear (11.4 ms at 4K, measured).

### 7.2 Scene stack: video inside the slide (M5)

A slide whose playing `ImageObject` (`play`) is on the media layer becomes a **scene stack** on the slide layer. Static slides never pay for it.

- **base** (one bitmap, a tight sprite at its offset since M7, §7.3): objects 0..k, where k is the play object, drawn with its poster. The poster therefore shows whenever the slot has no frame: not loaded, onEnd 'black', or a slot taken by another clip. With `showWhenStopped: false`, or a play object below full opacity (the video is mixed over base at that opacity, so the poster would show through it), the poster is left out of base.
- **video plane:** an mdPair slot (2-3, below `MAX_VIDEO_SLOTS = 4`), placed at the play object's box and fitted with the clip's own size (`Media.width` x `height`, in `SlideDesc.video` and the job's `video.w`/`h`), not the poster's: a custom poster may have another aspect. A plane whose box is under 1e-3 logical px or that would hold a non-finite float is not encoded (the slide stays one bitmap).
- **over** (one bitmap, a tight sprite at its offset since M7; usually absent): objects above k that _intersect_ the video box, for example a title over a video. Upper objects that do not overlap the box go into base.
- **plane** (16 floats, pre-allocated and copied with `set()`):

  | Floats | Content                                                                                           |
  | ------ | ------------------------------------------------------------------------------------------------- |
  | 0..5   | inverse affine, device px → box-local unit square (rotation and flips folded in)                  |
  | 6..9   | UV rect after crop (outside 0..1 is transparent)                                                  |
  | 10     | mask kind: 0 rect, 1 ellipse, 2 rounded rect                                                      |
  | 11, 12 | corner radius in box units x, y                                                                   |
  | 13     | opacity                                                                                           |
  | 14     | AA width in box units (from the affine scale; no derivatives)                                     |
  | 15     | flags: bit 0 hasOver; bit 1 video present (written per frame from the slot-ownership check below) |

**Arming and slot ownership** (`apps/output/src/link-core.ts`). This is not today's "look hides media" path, which arms only on the audio master and posts `SRC_VIDEO` to non-media layers.
- `planFrame` marks `MediaDesc.inSlide` when all of these hold:
  - the media content's `objectId` is set;
  - its `cueIndex` is the slide layer's cue;
  - the look's slide mode is `authored`.

  The media layer key becomes `''` and its desc is kept, so the reducer's transport, audio routing on the master and `media.ended` keep working.
- **Every output arms the clip.** `syncVideos` arms an `inSlide` clip on every output, not only on the master. It uses the media desc key (`md|cueIndex|mediaId|hash`) in the mdPair, muted unless the output is the audio master, with a new `render: false` flag so `armVideo` never posts `SRC_VIDEO` content for it. Transport (`apply`), `route` and `holdPaused` then find the slot by the desc key exactly as for a media video. `protectedKeys` already protects desc keys.
- **The slide job does not wait for the video.** `ensureContent` for the slide layer picks the slot synchronously (the same `pair.pick` that `armVideo` uses) and posts the slide AssetJob at once with `video:{objectId, slot, gen, w?, h?}`, where `gen` is the slot's load generation (`SlotMirror.gen`). It never waits for 'loaded', so a slow clip never delays the slide flip. When no slot is free (both busy fading), the job is posted without video (poster only) and re-posted with `refresh` once a slot is armed. The asset worker answers `SRC_SCENE {bitmap: base, over, plane, videoSlot, videoGen}` under the unchanged slide key.
- **Generations stop a reused slot from showing the wrong clip.** The host's `load` command carries `gen`, and every `vframe` is tagged with the generation it was loaded under. The engine keeps `frameGen[slot]` in a pre-allocated Int32Array. The compositors set the plane's "video present" bit only while `frameGen[slot] === stack.videoGen`. After Clear media, or when a playlist media cue takes the media layer, the slot can be reloaded with another clip, and the live slide then simply shows its poster. When the media layer clears, the link also sends `vclear` for the slot, at the hub time the clip pauses (when the media layer's fade ends, or the slide's when the slide leaves with it). It goes through the host as the `vclear` media command: the host sends the renderer's existing `vclear` (`render.worker.ts`) on the channel its frames travel, so it lands after every frame already sent, and it delivers no frame of that key again until it plays or another key loads.
- **Outgoing slots first.** Each sync marks the live videos that just left (`pauseAt`, `busyUntil`) before anything is armed, so the next slide's clip never takes the slot of a clip still fading out with its slide; it waits, its slide is drawn with the poster, and is drawn again in place once the slot frees.
- **Re-entry (GO then a quick Prev).** The clip of the slide just left is then the armed clip. It plays on as the outgoing side of the fade (no `holdPaused` while its slot is busy fading), keeps its picture (no `vclear` for an outgoing key that is armed), and when the fade ends the link sends `apply` paused at 0, which seeks it back to its first frame for the next GO. Any armed clip that played since it loaded (`SlotMirror.played`) is sought back the same way instead of `holdPaused`, so a GO never plays on from where it stopped (the host only seeks a playing clip more than 250 ms off).
- In lyric-only and hidden slide modes the boxed video is not drawn, but its sound still plays on the master. `inSlide` is not set, and the master arms the clip for sound as today.
- **Frame selection.** `vframe` keeps a 2-deep ring per slot and presents the newest frame whose timestamp is ≤ the expected media time (hubNow − startedAt, modulo the duration when looping). This fixes the design/14:217-218 mismatch.
  - Built as `FrameRing` (`packages/renderer/src/frame-ring.ts`). The host adds the clock to each `vframe` while the element plays: `startedAt` from the slot's 'playing' transport and `loopMs` from the element's duration when it loops. The expected time is taken on the vsync being drawn (hubNow + frameMs/2 − startedAt, the half-frame rule of flips).
  - The newest frame shows without a clock (paused, not started), with one frame, or when it is more than 250 ms from the expected time (the host's own seek threshold): a seek the clock has not caught up with never freezes the picture. The older frame shows only while the newest is early and the older comes before it within that window, so a frame from before a seek, a loop's wrap or a reload never shows.
  - Frames are closed when a newer one evicts them, when a frame of another generation arrives, on `vclear` and when the engine stops.
- **Fallback adapter.** An output whose adapter reports `isFallbackAdapter` (SwiftShader) is treated as Canvas 2D.

**WebGPU.**
- **Single pass.** One fragment shader composes each stack: `c = base; if (video present) c = video over c; if (hasOver) c = over over c`. A crossfade stays the existing exact `mix(sceneA, sceneB, t) · opacity` in the one fullscreen triangle per layer. No intermediate render; each stack holds one video.
- **Uniform.** `U` grows to `{rectA, rectB, p, color, planeA[4], planeB[4]}` = 192 B, which fits the existing 256 B slots (`UNIFORM_SIZE` 64 → 192). M7 adds the over rects `overA`, `overB` for tight overs (224 B, §7.3).
- **Pipelines.** Source kinds are t (bitmap), e (full-frame video) and v (scene). That gives singles `t e v`, pairs `tt te tv et ee ev vt ve vv`, plus `solid`: 13 pipelines, all compiled in `compile()` before ready (7 today). A `vv` bind group holds two external textures (8 sampled-texture slots) plus four 2D textures, within the default limit of 16.
- **Bindings for v:** base = the existing layer texture; over = one of two full-frame textures allocated on the first scene offer (in the offer handler, never on a flip; +66 MB at 4K), or a 1x1 transparent texture created at startup; video = the slot's external texture.
- **Slot without a frame.** A 1x1 `VideoFrame`, created at startup from an OffscreenCanvas, is imported only to satisfy the binding. The "video present" bit, not its alpha, decides whether the video is sampled, because external textures may not keep alpha.
- **Per playing video per frame:** one `importExternalTexture` plus one bind group, the objects `gpu.ts:9-10` already allows.
- **Hot path.** `drawLayer`, `writeRect` and `writePlane` are `/* @hot */` and allocation-free (hot-lint). The generation check is an integer compare.
- **Device loss** re-uploads base and over from the retained bitmaps (`engine.ts:293-297`).

**Canvas 2D compositor**, per stack:
1. `drawImage(base)`;
2. when the video is present: `save` → `setTransform(device affine)` → 9-argument `drawImage(VideoFrame, crop…)` of the visible part of the UV rect → `restore`. An upright plane (no turn or a quarter turn, flips allowed) with a rect mask needs nothing more; its edges snap to whole pixels, as Chromium draws every upright image;
3. `drawImage(over)`.

Masks and turned edges are cut with fills, not `clip`: Chromium 153 anti-aliases neither a 2D clip on an `OffscreenCanvas` nor the edges of a drawn `VideoFrame`, even turned (measured), while fills are anti-aliased. The video is drawn into a frame-sized mask canvas within its whole-pixel bounds (a turned plane is first drawn 1.5 px larger, so the pixels its edge half covers have video under them), kept with `'destination-in'` where the visible rect (turned planes) and the mask `Path2D` (ellipse; rounded rect with its straight sides pushed outside the frame, so a frame edge is cut once) cover it, and that rect is copied to the target. Mask paths, the mask canvas and a scene canvas are made in the offer handler (`Canvas2DCompositor.prepare`, `Compositor.prepare`), never per frame; the two canvases cost 8 MB each at 1080p (33 MB at 4K) once a scene, or a masked or turned scene, is offered.

A scene is several draws, so it is composed at full alpha before it is weighted: in the scene canvas during a crossfade, then mixed like any source, or in the existing scratch canvas when it fades alone. The exact `'lighter'` crossfade (`canvas2d.ts:60-85`) is otherwise unchanged. `golden/canvas-scene-run.ts` checks these pixels against the `planeSample` reference in headless Chromium.

**Later (when the data asks for it).** Per-element animation (fly, wipe, zoom) needs more than one item per stack. It will render the stack into its layer texture, which is already `RENDER_ATTACHMENT`, with an instanced quad pipeline, and keep the pair pipelines for exact crossfades. The plane table is the extension point. It is not part of this design's milestones.

### 7.3 Uploads

`copyExternalImageToTexture` runs inside `drawLayer` today, in the rAF frame (`gpu.ts:337-338, 415-435`), and its 4K cost on a real GPU is unmeasured.

- **M5:** uploads leave `draw()`. `offer` queues them, and the frame loop drains the queue after `submit`.
  - Built as `Compositor.drainUploads(f, all)`; the queue is the stacks whose `version` differs from the uploaded one. Before each draw the frame loop uploads only what that draw samples (live stacks, and outgoing ones while fading): content flipped on the frame it changed, such as content promoted from the queue or a `refresh` of the live copy. After the submit it uploads the rest, which is armed content for a coming flip.
- **M7:** the queue is tuned from venue measurements. Uploads go in strips (`copyExternalImageToTexture` with an origin; at most about 8 MB per frame, a quarter of a 4K frame). A stack is not flippable before its upload completes; `LayerStack` already holds the previous content for late content (`stacks.ts:133-170`). Arming normally happens a full cue ahead.
  - Built (M7 wave 1): `GpuCompositor` copies armed content after the submit in whole-row strips, the content a pending flip waits for first, within `UPLOAD_BUDGET_BYTES` (8 MiB, absolute: a 4K frame takes four) and `UPLOAD_BUDGET_MS` (4 ms of the render worker's CPU time in the copies) per frame; `Stack.ready` gates the flip (`LayerStack.gated` on WebGPU). Right after the layers tick, `uploadDue` uploads the content of flips due on this frame within the time budget alone (the byte budget, which spreads armed content over frames, does not hold a flip that is already due): one strip, which times the frame's copies, then the rest in one go when that cost says it ends within the 4 ms, else as many rows as do. Late content (a GO to a cue that was not armed) at 1080p, 1920x1200 and 2560x1440 therefore flips on the frame it arrives, as before strips, and 4K in two frames, where one 8 MiB copy costs about 2 ms (the tests' clock; venue GPUs to confirm), and the one tail copy can overshoot the 4 ms where copies cost more than the first strip predicts; larger content keeps the previous picture whole (strips only go into the armed texture) and flips once its last rows are in, as a late flip. The layers of one GO (flips due at the same `at`) flip on one frame: while one still uploads, the others wait (`LayerStack.uploadWaiting`, the engine's `tickLayers`), so the cue is never shown torn (a new background with the old slide); content that has not arrived holds nobody. A `refresh` of the live copy is on screen and is uploaded whole before the draw. After a device loss or a WebGPU retry the live stacks are uploaded whole before the first draw and the armed ones in strips (`LayerStack.resetUploads`); a retry whose first draw fails gives the stacks back to Canvas 2D ungated. Telemetry `uploadMs` is the longest budgeted upload frame of the last minute (whole uploads by design are counted apart, `wholeUploads`), so one deliberate large copy never raises the `upload` alarm. `e2e/outputs.spec.ts` runs its outputs on Canvas 2D (a software adapter is refused, §7.2); `slide-media.spec.ts` and `pptx-media.spec.ts` force one output onto WebGPU on SwiftShader at 1280x720, where every upload is one strip, so multi-frame strips, the cue's layers waiting for each other and whole uploads are covered by the compositor fakes (`gpu.sprites.test.ts`), the compositor golden and `bench:gpu`. Measured here on SwiftShader (CPU, `bench:venue --swiftshader`, 2026-11-07 after the integration's repair; one run, one set of figures, which design/14 records too): a 4K full frame costs the render worker 8.9 ms p50 (12.6 p95) in one copy and at most 2.3 ms per frame (p50 1.9) in its four strips; a 1080p frame is one strip, 1.8 ms p50. GPU times come from `bench:venue` (which runs `bench/gpu-venue.ts`) on venue hardware (design/14 "Measuring on venue machines").
- **M7 tight sprites:** the asset worker sends the bounding box of the drawn content plus its offset. The GPU clears the layer texture with a render pass and copies into the sub-rect. Canvas 2D draws at the offset. On 16:9 decks the photo is on the background layer, so the slide layer usually holds only text and this removes most of the clear, transfer and upload.
  - Built (M7 wave 1), with two changes. No clear: the sprite is copied into its layer texture at its frame offset, the shaders sample layer textures in frame coordinates and mask each source to its rect (a scene's base and over each have theirs: `U` is 224 B, `overA`/`overB` added), and texel centres map 1:1, so stale texels outside the rect are never read; every draw is scissored to what its sources cover. The box is known before drawing (`sprite.ts`: each object's reach as its drawer lays it out, the rich engine's memoised layout and paint plan, legacy `layoutText` memoised per context and bounded by its laid-out block, since `drawText` paints nothing else of the box; the block or lines grown by 0.3 em, `OVERHANG_EM`, united with the ink every line or glyph run measures, `TextMetrics.actualBoundingBox*`, since a glyph part that is a shape of its own, such as a tone mark stacked over a circumflex on a Vietnamese capital, can lie wholly outside the line box and the 0.3 em with tight line spacing, where the edge ring never sees it; effects; turned with its box); anything unbounded (a slide's PowerPoint picture, an object with fields the reach does not know, such as M6 geometry until it reports its bounds) stays full-frame, as does a box over 80 % of the frame, and a drawing that touches the sprite's edge ring is drawn again full-frame (`drawSprite`), so a sprite never cuts what is drawn. Scenes draw base and over as sprites (`rasterSceneSprites`). Checked pixel for pixel against the full-frame draw in headless Chromium (`sprite.browser.test.ts`) and in the compositor golden (sprites at offsets, crossfades between full-frame and tight layers, scenes with tight overs, strips mid-upload). Asset worker raster at 4K, full-frame → sprite, p50 (`bench:sprites`, CPU, loaded container, each job a fresh slide whose layout the reach makes and the draw reuses): a legacy lyric band 24.5 → 13.6 ms, a lower third 10.2 → 1.3 ms, a rich title 23.3 → 13.0 ms (design/14 "Measuring on venue machines").
  - _As merged with M6 wave 2:_ a PowerPoint shape is bounded too (`geomShapeReach`): its geometry's points past its box, its outline's joins, caps and arrowheads (`drawnBounds`, what its effect layers are made over), flips and rotation, its shadow (offset, three sigmas of its blur) and glow (half its radius and three sigmas of the rest), plus each blur layer's slack of 10 device px; a soft edge fades inside the shape; a shape whose geometry file is not read yet reaches nothing. A masked picture reaches its turned box (its prepared bitmap covers the turned box's bounds), gradient text its glyphs. A slide's reach is taken over its objects as its drawing budget draws them (`withinDrawBudget`). A sprite starts at a multiple of 8 device px (`SPRITE_ALIGN`): Chromium dithers gradients by device position, and a sprite at any other offset differed from the full-frame draw by a level on thousands of gradient pixels. Effect layers are made and cached without the transform's whole device px, so a shape at another sprite offset draws from the same cached layers. `sprite.browser.test.ts` checks callouts, arrowheads, a mitred star, shadows, glows, soft edges, a turned star-masked picture and gradient text pixel for pixel against the full-frame draw.
  - _M6 merge repair:_ "pixel for pixel" is within a tolerance, which real slides reach and synthetic ones mostly do not. A sprite's device translation differs from the frame's by its offset, which moves float32 device coordinates by about 1e-4 px; that flips an anti-aliasing sample of a curve or a glyph's subpixel bucket on a few edge pixels. Over 268 converted worship slides, with their backgrounds removed so that 96 draw as tight sprites, 19 slides at 1920 and 22 at 3840 differed from their full-frame draw (premultiplied): at most 287 pixels of a slide; at most 70 levels on 180 glyph-edge pixels of an autofit Cambria text and 55 levels on 39 edge pixels of a traced outline; turned pictures by a level; nothing outside the sprite's rect and no ring miss. No difference is visible. The synthetic cases above (shadows, glows, soft edges, layered panels, masks including a geometry-file one, connectors, a mitred zigzag, geometry files read and not read, a table group) are identical at 1920 and 3840. The check therefore allows 24 pixels and 8 levels on its half-size synthetic cases, and 400 pixels and 72 premultiplied levels on a real-like slide (traced outlines read from geometry files, office-model autofit text, turned text) drawn at 1920 and 3840: 31 pixels at 6 levels and 131 pixels at 66 levels when last run.
  - _M6 merge repair:_ an arrowhead reaches around the end point it sits on (the start and end of each open sub-path of a stroked path, as `withEnds` draws them), not the whole box on every side (`drawnBounds`): five connectors whose ink covers 61 % of the frame reached 1801x1295 logical px with their boxes grown by their largest arrowhead and fell back to a full-frame layer; a 12x6 line with large arrowheads reached 410x404 px. The effect layers and the effect budget's areas use the same bounds.
- **M7 opaque-first:** a full-frame bitmap the asset worker knows to be opaque (a cover-fitted JPEG or a PNG without alpha, read from its header by `apps/output/src/opaque.ts`; the props logo over an opaque clear colour) is sent `opaque`. The compositors start the frame at the top-most such layer shown at full weight and write it without blending (WebGPU `replace-t`, the 14th pipeline; Canvas 2D `'copy'`), so neither the clear nor the layers under it are drawn.

### 7.4 Editor, thumbnails, stage

- **Editor.** `SlideCanvas` (`apps/operator/src/views/editor/SlideCanvas.tsx`) keeps one Konva node per object.
  - Rich text is drawn by `paintRich` into its cached offscreen canvas at scale × `devicePixelRatio`. Today it is drawn at 1:1, so it is blurry on HiDPI screens.
  - Pictures use crop, mask and flip through `drawImageFit`.
  - A play object shows its poster with a ▶ badge.
  - Locked objects show a lock badge.
  - A text box whose layout overflows shows a dashed red bottom edge.
  - On 4:3 decks, `source.native.slideRect` is drawn as a guide.
- **Thumbnails.** The thumb worker uses `drawSlide2D` → `slideContent`. Its cache key is the slide JSON hash, so new fields re-render automatically. Pictures are decoded at 640 px from prepared sources (§4).
- **Stage.** It shows `readableText` of `lyricObjectId` with `unicode-bidi: plaintext`. An optional notes region (`PropsRule.notes`) shows `Slide.notes`. `nextText` skips hidden cues.

### 7.5 Caches and queues

**Asset worker**
- the decoded-picture LRU (256 MiB, unchanged; keyed by hash and target size, `pictureKey`, §7.1);
- the measure LRU;
- the layout memo per object identity, box and font generation;
- an effect sprite cache (large blurred shadows, glows; key fnv(object JSON) × scale, ≤ 64 MiB). _As built (M6 wave 2):_ `effects.ts`, keyed by the shape's JSON without its identity and the device transform, LRU within 64 MiB; blurs are made at reduced resolution (§15 M6 "As built"). _M6 repair:_ a shape whose composite (its layers and itself at full resolution) fits 8 MiB is cached whole; a larger one is cached whole too until the cache lets its sprite go and it is needed again (it thrashes), and from then on caches only its reduced layers (each at most `BLUR_MAX_PIXELS`, 4 MB) and draws itself over them as vectors, so a 4K slide of three large shadowed panels no longer rebuilds 33 MB sprites on every raster (150 ms → 30 ms at 3840; one panel, which stays cached whole, 15 ms), and a slide's effects are bounded by its effect budget (§12).
- **Two raster lanes (M7):** _interactive_ (props, lower third) and _bulk_ (slide, image), each its own promise chain gated on font loads. A 4K decode can no longer delay the once-a-second props flip (one chain today, `asset.worker.ts:57-60`). Slide jobs yield between objects, so no task exceeds 50 ms.
  - **As built (M7 wave 1, item B; design/14 "Asset worker: raster lanes and picture decoding").** Ranks, not two chains: props, then the live cue's layers, then the armed cue's (_interactive_), then _bulk_ work, the pictures of the cue after the armed one (`warm`, which the link sends so that arming that cue after the next GO only draws). Each layer is a chain (its content must reach the renderer in order); chains run side by side, so a job waiting for a read or a decode (off the thread) holds nothing up, and bulk work starts only while nothing interactive is queued or running. Synchronous work runs in turns, the most urgent waiting slice first, each in a task of its own after the messages that arrived meanwhile (`apps/output/src/lanes.ts`). A slide does not yield between objects (its draw is one slice, 14-22 ms at 4K, §13), but a picture over 2 MiB-pixels is prepared in bands of whole rows (`preparePictureSteps`, byte-identical), so the longest slice measured at 4K was 41 ms. Superseded jobs are cancelled by the link (dropped, or stopped at their next slice); pins are counted so jobs side by side never unpin each other's bitmaps. Font loads gate the jobs sent after them only. Each result carries its lane's wait, raster time and longest slice; the link keeps per-lane percentiles (`telemetry().lanes`). Measured (`bench:lanes`, headless Chromium 153, this container): a props bitmap sent while a 4K slide decodes two large photos arrives 26 ms p50, 36 ms max after it was sent (the lead is 150 ms); before M7, 299 ms p50, every one late.
  - _As merged with M6 wave 2:_ a slide job (and a warm job) reads the geometry files its slides draw (`ShapeGeom.ref`) before its pictures, off the thread as a picture's file is read; each file's parse (JSON and the paths' re-tokenising, 5-15 ms for a file of 320 KB) runs in the job's turn (`readGeomFiles`' step), so a props flip never waits for it, and a cancelled job leaves a shared read for the next caller to parse. Masked and flipped pictures are prepared in bands like any other and decoded crop-aware: the region a mirrored picture shows is mirrored about its box's centre, and a turned masked picture is decoded for its whole box. M6's baked pictures (recoloured, tiled) are ordinary files to the lanes. _M6 merge repair:_ a masked picture's bands are drawn uncut and its mask is cut once, in a step of its own after the last band and without a band's clip, as the one-pass preparation and the source path cut it: cut per band, Chromium anti-aliased the 'destination-in' fill differently under each band's clip, so a masked picture over `PREPARE_STEP_PIXELS` at 4K (a large ellipse or rounded photo) differed from the one pass by up to 82 alpha levels on 6,940 edge pixels. Banded preparation is now the one pass byte for byte for masked and mirrored pictures too (`asset.lanes.browser.test.ts`), except a turned one's own edge where it shows (a turned rounded-rectangle frame, whose straight sides are the picture's): Chromium anti-aliases a turned picture's edge differently under a clip, by up to 14 premultiplied levels on 1,244 edge pixels of a 1857x1703 target at production bands (none for a turned star or ellipse, whose mask hides the picture's edge). The cut is the longest step of such a preparation: a full-frame masked picture at 4K takes 6 to 8 ms a band and 32 to 37 ms for the cut with the bitmap's transfer (11 to 22 ms a band before, cut per band), within the 50 ms of a task and the props flip's 150 ms lead.
  - **Crop-aware decode (as built).** A JPEG whose uses all need half its size or less is decoded with `ImageDecoder` at the next eighth at or above (an inverse-DCT scale, not a resample), cut to its visible part with a margin when that is at most half of it, and laid out from where that part lies (`PictureFrom`); a 4K-prepared photo on a 1080p output decodes in 48 ms instead of 107, its longest task 11 ms instead of 35. PNG, GIF, WebP, EXIF-oriented JPEGs and uses of five eighths or more decode whole as before (`apps/output/src/decode.ts`).
  - **Opaque-first copy (CPU side, measured, not adopted).** On the asset worker's software surface `'copy'` for the first opaque layer cost 0.4-1.5 ms more than drawing over the transparent surface; what saves work is not clearing a surface whose picture was just taken (1.1 ms at 4K).

## 8. Media playable in place (M5)

**Domain.**
- `referencedMediaIds` adds `play.mediaId`, `Slide.audio.mediaId` and `refMediaId` (when `show === 'picture'`).
- `resolvePlaylist` treats play and slide-audio media as **optional**. A clip still transcoding or failed is left out with a `degraded` note ("video still processing; showing its poster; Go live again once it is ready"). goLive is never refused for it.
- `expandCues` fills slide-cue fields only for ids present in `resolved.media`, which keeps the invariant `invariants.ts:36-41`:
  - for the playing video (the first `ImageObject` with `play`, in z order): `mediaId`, `mediaKind 'video'`, `loop`, `onEnd`, `audio {gainDb}`, `mediaObjectId`, `mediaStart`, `mediaShowWhenStopped`;
  - for `Slide.audio`: `slideAudio`, with `untilCue` = the index of the last cue of the same playlist item reached after `slides` shown (non-hidden) slides.
- Hidden slides produce cues flagged `hidden` (§9). Their media works the same way when they are shown.

**Reducer** (`goTo` slide branch, pure; replaces the unconditional clear at `index.ts:213`):
- **Video:** `layers.media = {kind:'media', cueIndex: index, mediaId, mediaKind:'video', objectId, loop, onEnd, state: start === 'click' ? 'paused' : 'playing', startedAt: at, positionMs: 0}`. With no video, the media layer is cleared as today. Re-entering a slide restarts its video, as PowerPoint does.
- **Audio:** an autoplay sound sets `state.audio` the same way (state 'playing'), with `slideOwned: true` and `untilCue`.
  - **A slide-owned sound that is still playing is never restarted:** when `audio.content` is slide-owned with the same `mediaId`, state 'playing', and the entered index inside its `[cueIndex, untilCue]`, the slide branch keeps it playing. An announcement loop that wraps back to slide 1, an operator stepping back, or an arrangement that repeats the slide inside the range therefore keeps the music running. A repeat extends `untilCue` to the repeat's own range; `cueIndex` and the transport stay.
  - Slide-owned audio is cleared when the live index leaves `[audio.cueIndex, untilCue]`.
  - Playlist audio cues keep playing under slides as today. A slide's own autoplay sound replaces them when the slide goes live; the importer and the editor warn about this, and transition sounds are not imported by default.
  - **A click-start sound waits for F8.** Entering its slide leaves the audio slot as it is, so playlist audio (walk-in music) or another slide's sound in range plays on. `pendingSlideSound(state)` names the waiting sound: the live slide cue's click-start sound while the slide layer shows that cue and the audio slot does not hold it. F8 starts it (state 'playing' at the F8's `at`), replacing what plays. Every client derives this from the cues, so `LiveState` carries no new field; the audio master preloads the waiting sound paused.
- **One click target per slide** (`mediaPlayTarget`): F8 (`media.play`) acts on the waiting click-start sound, unless the media layer's video is paused (a click-start video waiting for its click, or one the operator paused), which F8 plays first. Otherwise it toggles the media layer's video, else the audio slot. So a click video with a click sound takes F8 for the video, then F8 for the sound, as PowerPoint's click sequence does; an autoplay video with a click sound takes F8 for the sound, then F8 toggles the video. Shift+F8 restarts the video when there is one, else starts the waiting sound, else restarts the audio slot. The LayerBar's play button follows the same target and names the waiting sound.
- `clear('slide')` also clears slide-owned media.
- F8, Shift+F8, Clear media, onEnd (hold, black, advance), the stage's remaining time, the LayerBar, Stream Deck and MIDI, and the hub's `media.ended` checks work unchanged, because `cueIndex` is the slide's own cue. onEnd 'advance' goes to the next non-hidden cue.

**Output.**
- The armed plan preloads the next slide's clip, paused on its first frame (`link-core.ts:836-842, 1180-1183`), on every output (§7.2).
- With `showWhenStopped: false`, the link sends `vclear` for the slot whenever the reducer's state is not 'playing' (also for the armed clip, and before its load reaches the host, so not even its first frame shows), and the base has no poster, so nothing shows until the clip plays.
- An `ImageObject` whose `mediaId` is a _video_ Media (Pro7 video fills, earlier editor picks) draws that Media's poster on outputs, as thumbnails and the editor already do: `slideImages` maps a video to `poster.hash`, which the manifest already ships. Today outputs draw nothing for it (`asset.worker.ts:199-203`, `link-core.ts:982-995`). It plays only once it has `play`; `play.mediaId` may be the same video.

**Hub.**
- `sniff`/`EXT_KIND` gain ASF (GUID `30 26 B2 75 8E 66 CF 11`, WMV/WMA), MPEG-PS (`00 00 01 BA`) and AIFF (`FORM....AIFF`, also `AIFC`). An ASF file is a WMA when its header lists audio streams only (a video when the head cannot tell: the media job turns an audio-only file into an audio item).
- Clips are ingested with `checkExtension:false`, tags `['pptx']` and the name `<deck title> – slide N video`, **never awaited** (heavy concurrency 1), after `pptx-lo` is enqueued.
- **Trims are baked.** `p14:trim` becomes `IngestOpts.trim {startMs, endMs}`. The media job cuts the delivery (`-ss`/`-to` before the H.264/AAC transcode), so loops, onEnd, the stage's remaining time and `media.ended` need no trim logic. The item records it as the optional `Media.trim`, and deduplication keys on hash plus trim (`MediaService.findClip`, `ingestOnce`), so one file used whole and trimmed gives two clips.
- **Square pixels.** Anamorphic sources (DVD MPEG-PS, DV, some WMV: 720x480 at 32:27 is 16:9) are resampled to their display size at ingest (`scale=iw*sar:ih,setsar=1` before the fit, in the H.264 and VP9 paths and the poster). `Media.width`/`height`, probed from the delivery, is then the shape on screen, which the plane fits the clip with (§7.2); otherwise the picture is squeezed.
- A clip that fails gives `[warn]`, and its object stays a poster.
- Video soundtracks get `measureLoudness` like audio files. This changes the playback level of every newly ingested video, not only PowerPoint clips, and is recorded as a product change in design/18 and in the release notes.
- `gainDb = 20·log10(vol/100000)`, clamped to −100 (`volumeGainDb`, which also caps it at 0 dB); mute → `muted`.

**p:timing mapping.**
- autoplay = a `presetClass="mediacall"` cTn with `afterEffect`/`withEffect` in mainSeq before the first click;
- click = `clickEffect` or `interactiveSeq` togglePause;
- `repeatCount="indefinite"` → `loop`;
- 'Rewind after playing' → onEnd `'black'` (the poster shows again);
- `showWhenStopped="0"` → `showWhenStopped: false`;
- `p14:trim` → baked (above);
- `numSld` → `slides`;
- only the first video and the first sound per slide play; others keep their posters (logged).

_As built (M3 wave 2, `packages/pptx-scene/src/media.ts`, `timing.ts`; `apps/hub/src/pptx/clips.ts`):_
- 'Rewind after playing' is the media node's `fill="remove"` (`fill="hold"` holds the last frame). A play
  effect counts when it plays (`playFrom(…)`, `play`, `togglePause`); pause and stop effects do not. A clip
  nothing in the timing starts is a click (PowerPoint shows its play controls); an automatic start wins over a
  trigger that also toggles the clip, as PowerPoint writes "Automatically".
- `p14:trim end` is how much is cut from the end of the clip, not where the kept part ends (verified on real
  decks: `end="6458.3125"` on a 146.458 s sound keeps 140 s), so the hub probes a trimmed clip's duration
  before it ingests it.
- Muted for the motion background is `mute="1"` or `vol="0"` (a real deck mutes its loop with the volume).
  The promotion also needs a 16:9 deck, an automatic, looping video whose box is the slide (each edge within
  2.5 %, unturned, uncropped, unmasked, opaque, its poster at the slide's aspect when known) with nothing of
  the slide's own below it; what it covers is left out. It stays the slide's background, never the
  presentation's, and goLive treats a PowerPoint slide's own background as optional like its clips
  (`SlidePlay.role` 'background'; `expandCues` shows the item's or the presentation's instead), so a motion
  background still transcoding never refuses the service. Accepted gap (M3 wave 2): unlike a boxed clip, a
  motion background still transcoding or failed after the import has no poster to fall back to (the
  converter leaves out what it covers, its poster included, and the hub puts the poster back only when the
  clip cannot be imported at all), so until the operator goes live again once it is ready the slide's text
  shows over the item's or presentation's background, or black; the banner names it ('went live without
  media that is not ready'). Keeping the poster as a still background (a `Slide.pptx` poster id `expandCues`
  would use) is left for a later wave.
- The hub sniffs each clip part before the batches (`SceneTaskInput.mediaKinds`), so the converter decides
  video or sound by the bytes. Clips are stored with `IngestOpts.queue: false` and their media jobs queued in
  the transaction that saves version 1, right after `pptx-lo` (`JobQueue.enqueue` `after`: jobs start in
  creation order, and ids are random within a millisecond). Clip placeholders are `pptxmedia:clip<n>`, one per
  part and trim, listed in `EmittedSlide.clips`.

## 9. Builds, transitions and hidden slides

- **Final state.** Every slide draws its final state, as LibreOffice and pptx-preview do. Exit, emphasis and motion effects are dropped (logged).
- **Split reveal into slides (M8).** An import option (off by default) and an editor action turn `p:bldP` paragraph builds (21.8% of worship decks) into progressive slides.
  - The slides share object ids. Slide i sets `TextPara.hidden` on the paragraphs after i, so layout is identical and nothing moves.
  - Each click becomes a GO, which is how worship operators already work.
  - On today's exact crossfade, a fade build is reproduced pixel for pixel on any compositor.
  - Stage, thumbnails and cue labels need no change.
- **Slide transitions.** `expandCues` uses `item.transition ?? slide.transition ?? p.transition` (`cues.ts:53`), so a transition the operator sets on the playlist item for this service wins. Push and wipe styles are not in scope.
- **Hidden slides** (`Slide.hidden`, M3). `expandCues` emits their cues with `hidden: true` (labels unchanged). The reducer (pure, the same on every client) skips flagged cues in:
  - `next` (target = the first non-hidden cue after `live`);
  - `prev`;
  - the `armed` choice after a GO;
  - `autoAdvance` (wrapping within the item);
  - onEnd 'advance';
  - `nextItem` and `goToSection` (the first non-hidden cue of the target).

  `go` with an explicit cue (a click in the grid, `goToSlide`, a Stream Deck slide key) shows a hidden slide. SlideGrid draws hidden slides dimmed with a 'hidden' tag. The stage's `nextText` skips them. An older build strips `hidden` and shows them as normal slides.

  As built (M3 wave 2): `nextShownCue`/`prevShownCue` in `cues.ts` carry the rule; the outputs' armed plan, the lyric-only next band and the look previews follow it. An item whose slides are all hidden is passed by `nextItem`, `prevItem` and the Stream Deck's next-items keys. A jump that names a group (a section key, a section header in the grid, a playlist item double-clicked) lands on its first shown cue, or on its first cue when every slide of the group is hidden. A pending or failed hidden slide is listed in `degraded` at its cue, since a click can show it.

## 10. Fonts

**Resolver (M2).** Used by the asset worker, the thumbnail worker and the editor.
- Every face is registered as `FontFace('o' + hash8(scope + family + sorted face hashes), buffer, {weight, style, unicodeRange})`. A change in a family's face set gives a new, never-resolved name, so a late or retried font takes effect. This is the verified worker cache behaviour, and it fixes "a font that failed early stays missing" (`link-core.ts:1747-1751`). A family is added to font strings only once its faces have loaded; the layout memo's font generation changes then.
- Font strings are built only from loaded internal names, in this order:
  1. the exact library face (upload, google, bundled; a scoped face only for objects of its own presentation);
  2. `fallbackFonts` (metric substitute, then the ea/cs family and its substitute, then the script fallbacks the importer recorded);
  3. the bundled ordo script fallback for the segment's script (Noto Hebrew, Naskh Arabic, Devanagari, Tamil, Thai, Myanmar; Noto CJK when shipped);
  4. the original family name (last resort, reported; the editor's PowerPoint card asks for an upload);
  5. a generic family.
- The legacy `fontString` uses the same resolver when one is installed.
- The asset worker reports text that no shipped face covers in `health.fontFallbacks`, with its script (M3, with the script fallbacks). `self.fonts.check` cannot do it: it says whether the matching faces have loaded, not whether one has the glyphs. The text is measured with the shipped stack before a blank face of ordo's own instead, which every code point lands on as nothing: the measure differs from the blank face alone where a shipped face has the glyph.
  - _As built (M7 wave 1, item C):_ reported as `health.fontCoverage` (`chars`, `count`, `scripts`), not in `fontFallbacks`, which keeps the families that are not loaded. `GlyphCoverage` (`packages/renderer/src/text/coverage.ts`) wraps the asset worker's surface's `fillText` and `strokeText`, so the drawers are unchanged, and probes each new character once per stack, style and weight after the job's picture is sent: the stack's shipped faces (the resolver's internal names) before the blank face, against the blank face alone, comparing the advance and the ink box (a covered mark has no advance but has ink). The blank face (`packages/renderer/src/text/blankface.ts`) is an OpenType font built in memory, ten tables and 744 bytes, whose cmap maps U+0000 to U+10FFFF to one empty glyph of no advance (one format 13 group, as Adobe Blank does); OTS accepts it. The asset worker registers it in its face set under `o-blank-` and 8 random hex digits, a name no font string a drawer builds holds, and waits for its load before probing (no verdict and no report until then). Default-ignorable characters are never reported. Verdicts are kept until the faces change; a face that loads draws again the held slides that had uncovered characters. Design/14 "Health message".
  - _Repair (PR 1's CI):_ the first probe compared the shipped stack before `serif` and before `monospace` with each generic alone. Where no face of the computer has a character, Chromium measures the .notdef box of the stack's first family, so the shipped stack never equalled the generic and Han and Thai text passed for covered (the ubuntu-24.04 runner has no CJK or Thai face); where the computer's faces answer by the first family (a bold fallback on Linux, the fallbacks of Windows and macOS in general), the same. The blank face never lets a character reach the computer's fonts. `coverage.fonts.browser.test.ts` runs the coverage cases under two fontconfigs of its own (no face for the characters; generated CJK and Thai faces the generics resolve to), each of which the first probe failed; a probe costs two measures instead of four (40 new Han characters 1.5 ms, from 13 ms).
- Remove `'inter'` from `FALLBACK_FAMILIES` (`raster.ts:139-148`) and bundle Inter, so the default font is shipped like any other.

_As built (M2, `packages/renderer/src/text/fonts.ts`):_
- The original family name enters a stack only while its faces have not loaded, and the generic step is ordo's default face (Inter, once shipped) followed by today's chain `"Inter", "Segoe UI", Arial, sans-serif`, so an object whose family has not loaded draws as it did before the resolver.
- No internal name is handed out twice: a face set that comes back gets a salted name.
- A face that fails is left out of its family's round, which loads without it; it is retried with backoff (2 s doubling to 5 min), at once on the next sync, and after each complete cache fill of the output. A retry loads the failed face alone first, so a broken face in a 51-face family costs one read per retry, not 51. Families a later list leaves out keep their faces (content on screen may use them) but are no longer retried.
- Reading and parsing a face time out after 15 s, and a sync never waits for a background retry already running (its result is announced as a late change), so a half-open read cannot hold up the asset worker's job queue.
- When faces become available, the asset worker reports their families `ready`, and the link draws again in place the held slides that fell back for them. The thumbnail worker's client drops its cached thumbnails; the editor redraws.
- goLive matches family names case-insensitively, as CSS and the resolver do.
- `'inter'` left `FALLBACK_FAMILIES` in M2: until M3 bundles Inter, an output whose library has no Inter reports it as a fallback.
- `pnpm --filter @ordo/renderer late-font` checks in headless Chromium, in a worker and on a page, that text drawn before its face loaded is drawn with that face on the next draw. In the worker it also re-runs the probe: a family measured before its face was added keeps its fallback width (on a page it takes the face).

**Bundled substitutes and script fallbacks (M3).**
- The hub registers a fixed list of OFL/Apache faces installed by the Dockerfile as `Font{source:'bundled'}` (the value exists and is unused, `schemas.ts:272`), idempotently by hash:

  | Substitute                                                                                                          | For                                 |
  | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
  | Carlito                                                                                                             | Calibri, Calibri Light (not metric) |
  | Caladea                                                                                                             | Cambria                             |
  | Liberation Sans, Serif, Mono                                                                                        | Arial, Times New Roman, Courier New |
  | Noto Sans (Latin, Greek, Cyrillic), Noto Sans Hebrew, Noto Naskh Arabic, Noto Sans Devanagari, Tamil, Thai, Myanmar | script fallbacks                    |
  | Inter                                                                                                               | ordo's default font                 |

- **Always on every output.** Inter and the script-fallback faces (a few MB in total) are added to the output-config fonts (`link-core.ts` `ensureFiles` already merges `config.fonts`). Every output therefore caches them in OPFS, whatever the playlist, and an offline output never falls back to the operating system per glyph.
- **CJK faces** (large) are shipped only when needed: `resolvePlaylist` scans the presentations' text (`textScripts`), and `referencedFontFamilies` adds the CJK families when Han, Kana or Hangul text is present.
- Gelasio (for Georgia) and Noto CJK come on demand through the Google job.
- URW base35 (AGPL with a font exception) and Wine's fonts (LGPL) are not shipped.
- `referencedFontFamilies` and `jobFontFamilies` include run fonts, bullet fonts and `fallbackFonts`, so goLive ships them by exact family and outputs pre-cache them in OPFS.
- Font loads that fail are retried with backoff instead of only being logged.

**As built in M3** (`apps/hub/src/fonts/bundled.ts`, licences in `apps/hub/src/fonts/LICENSES.md`):
- The image installs `fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 fonts-noto-core fonts-inter` (bookworm, all SIL OFL 1.1) and keeps their copyright files. `ORDO_FONTS_DIR` (the image sets `/usr/share/fonts`) is where the hub looks; unset, nothing is registered.
- Faces: Inter, Carlito, Caladea, Liberation Sans, Serif and Mono and Noto Sans in regular, italic, bold and bold italic; the Noto script faces in regular and bold.
- Registration runs at every start. An unchanged file changes nothing. A changed file (a newer image) replaces the row's file. A face the library already has from an upload or Google Fonts (same family, weight, style and range) is left alone. Bundled rows no longer listed are removed. Bundled rows cannot be deleted (409).
- The Hebrew, Arabic, Devanagari, Tamil, Thai and Myanmar faces carry their script's `unicodeRange`, so a script fallback listed before a deck's own family never draws its Latin text. Noto Sans has no range, because people also pick it for Latin text.
- Liberation Sans Narrow is not bundled: only Liberation 1.x has it, under the GPL with a font exception.
- The output-config fonts are every library face except the CJK fallback families (`isOnDemandFontFamily`: the Han, Kana and Hangul entries of `SCRIPT_FALLBACK_FONTS`), unless a look's text style names one.
- The goLive scan adds `SCRIPT_FALLBACK_FONTS` of every script in the presentations' text objects (`scriptFontFamilies` in `resolve.ts`), so a manifest also carries the bundled face of each script it uses. Han in a text with Kana or Hangul counts as Japanese or Korean. Han alone names every CJK family, and goLive ships those the venue added.

**Google Fonts.** `parseFontCss` (`google.ts:72-84`) keeps every unicode-range subset. Each subset is a Font row with `unicodeRange`, which the three drawers pass to `FontFace`. A bilingual deck's Hebrew or Arabic family therefore arrives with its script, and subsets of one family, weight and style no longer collide.
- As built in M3: the range is stored normalised (sorted, merged, at most 4,000 characters, coarsened by merging the closest neighbours when longer).
- A family keeps at most 400 faces. CJK families come in about a hundred slices per weight, so above that only the weights nearest 400 and 700 are kept.
- A download replaces the family's earlier Google faces, including the Latin-only faces of downloads made before subsets were kept.
- `FontLoad.unicodeRange` carries the range to the asset worker.

**Non-metric families.** Century Gothic, Tahoma, Aptos, Gill Sans and Trebuchet are named in the import card: "Upload Century Gothic for exact line breaks". Uploading the real font fixes it automatically, because the family stays first in the stack.
- Until then, a shrunk box in such a family is drawn with another face's widths, so PowerPoint's stored autofit scale is not used: the box is fitted again from full size, as LibreOffice fits it (§6 step 10). The resolver's `metricMatch(family, fallbacks)` decides: true when the family's own faces have loaded and are not a stand-in (`FontFile.substitute`: another family's face registered under its name, as the fidelity harness registers fontconfig's choice), or when the first loaded `fallbackFonts` entry is a metric clone of the family (`METRIC_FAMILIES`: fontconfig's metric aliases and the bundled substitutes above; Calibri Light has none). Once the real font is uploaded, the stored scale is used again.
- Rejected: dropping `fitScale` in the converter for the non-metric families. The hub cannot know which faces an output will have, and PowerPoint's scale would be lost even after the real font is uploaded.

**Embedded fonts (M8).** They are EOT, 88% MTX-compressed.
- Decoded on the pool by a bounded TypeScript MTX/LZCOMP+CTF decoder written from the W3C MTX submission. `eot2ttf` via `tools.run` (timeout, SIGKILL, address-space cap, ≤32 MB in, ≤64 MB out) is the stop-gap.
- Validated with `fonts/sfnt.ts`.
- Stored as `Font{source:'upload', scope: presentationId, embed}` under the `p:embeddedFont` typeface and slot, not the font's own name table.
- Never upserted over a library face (`library.ts:467-480`).
- goLive ships a scoped face only with its own presentation (the family filter in `resolvePlaylist` checks `scope`). The resolver uses it only for objects of that presentation, so a deck's subset 'Calibri' never reaches another deck.
- fsType preview&print faces and subset faces are view-only: the editor warns before new characters are typed.

## 11. Editability and editor extensions

### Mapping

| PowerPoint                                                        | ordo                                                                                                     | The operator can                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Title, body or subtitle placeholder; text box; text in a shape    | TextObject with runs, paras, insets, autofit, direction, fallbackFonts (+ ShapeObject in the same group) | edit text keeping formatting; format a selection; edit paragraphs; edit the box; move the shape and text together        |
| Main body text                                                    | `lyricObjectId`                                                                                          | lower thirds, stream key, stage, cue labels and search show it (with verse numbers via `readableText`); 'Make lyric box' |
| Picture                                                           | ImageObject with crop, mask, flip, adjust                                                                | replace (re-cropped to the box, never distorted), crop, mask, flip, opacity, 'Use as background'                         |
| Full-slide picture background                                     | `backgroundMediaId` (16:9) or bottom ImageObject `role:'bg'`                                             | swap with the existing pickers; 'Replace on all slides'                                                                  |
| Solid or gradient background                                      | bottom ShapeObject `role:'bg'`                                                                           | colour                                                                                                                   |
| Master/layout decoration (logo, bars)                             | objects `role:'deco'`                                                                                    | edit or delete per slide; 'Apply to similar'                                                                             |
| rect, roundRect, ellipse, line, connector                         | ShapeObject                                                                                              | fully                                                                                                                    |
| Other presets, custom geometry (M6)                               | ShapeObject with `geom` (+ nearest legacy `shape`)                                                       | fill, stroke, dash, arrowheads, box; geometry locked until adjust handles exist                                          |
| Group                                                             | flattened objects sharing `origin.group`                                                                 | select, move and transform together; Alt-click one; Ungroup                                                              |
| Table (M6)                                                        | one TextObject per cell (shrink to fit) over locked grid shapes                                          | cell text                                                                                                                |
| SmartArt with a drawing cache (M6)                                | locked shapes plus editable text                                                                         | text                                                                                                                     |
| Embedded video                                                    | ImageObject (poster) with `play`                                                                         | replace clip, start auto/click, loop, at end, volume, show when stopped, box, crop, mask; 'Use poster only'              |
| Embedded sound                                                    | `Slide.audio`                                                                                            | replace, start, loop, volume, 'continue for N slides'                                                                    |
| Notes, sections, hidden slides, timings, transitions              | `Slide.notes`, Sections + Default arrangement, `Slide.hidden`, `durationMs` / loop, `Slide.transition`   | all                                                                                                                      |
| Chart, OLE, maths, 3D, WordArt warp, vertical text (v1), overflow | locked transparent art ImageObject (`role:'art'`) at its z                                               | move, resize, delete, z-order; edit in PowerPoint and re-import                                                          |

### Editor extensions for churches

Every edit is a pure op in `apps/operator/src/views/editor/ops.ts` through `change(fn, key)`:
- one undo step per op (coalesced per key, 200 deep);
- whole-presentation PUT with rev;
- validation by the hub schema and a revision row;
- the live lock (ADR 0007) is unchanged.

The extensions, in priority order (M4 unless noted):

1. **Fix text without losing formatting.**
   - The textarea stays.
   - `editText(obj, next)` diffs the common prefix and suffix. Text that replaces a selection takes the style of the text it replaces (its first character), so a retyped bold date or raised verse number stays bold or raised. Text typed at a paragraph's start takes the style of that paragraph's first character, or in an empty paragraph its end mark; anywhere else, the style of the character before it. Runs inside a deleted range are trimmed. Paragraph styles are inserted or removed with the `\n` count; a new line copies the style of the paragraph it splits.
   - Soft paragraphs (a:br lines) stay lines of their PowerPoint paragraph: deleting a paragraph's first line leaves its remaining soft lines that paragraph's style (bullet, number, indents, spacing), and a line split off a soft line by Enter takes the paragraph's style without `soft`, so Enter always starts a new paragraph or stanza.
   - It keeps `fitScale` while the edited text still fits at that scale. A one-character fix therefore never changes the text size; overflowing text shrinks (§6 step 10). 'Re-fit text' in TextStyleEditor clears `fitScale` on request. A box drawn with a face other than the one PowerPoint fitted (no metric match, §10) is fitted from full size after every edit, as LibreOffice does, until the family is uploaded.
   - This is what makes a typo fix or a date change safe in the 20-27% of real worship text bodies that mix styles.
2. **Format a selection.** A bar over the textarea: Bold, Italic, Underline, colour (swatches from the deck's theme colours), Size ±, Superscript (verse numbers), Clear formatting.
   - `formatRange(obj, start, end, patch)` splits and merges runs and normalises them: sorted, non-overlapping, at most 2,000, equal neighbours merged.
   - The box Size control scales every run, because `sizeScale` is relative.
3. **Paragraph strip** for the paragraphs the selection touches (`setParas`): align L/C/R/Justify, bullets on/off, numbering `1.` / `(1)` with 'Start at' (verses), indent ±, space before/after, line spacing, direction Auto/LTR/RTL. This closes PRD 03's deferred auto-shrink, RTL and bullets.
4. **Box options in TextStyleEditor:** 'Shrink text to fit', 'Re-fit text', direction, wrap, four insets, and 'Fallback font' for bilingual congregations (pre-filled from the deck's ea/cs fonts). An overflowing box shows a dashed red edge on the canvas, and the panel says "Text does not fit: turn on Shrink text to fit or enlarge the box". PowerPoint grow-to-fit boxes import at their grown height, and this is how later edits are flagged.
5. **Groups and shape+text pairs.**
   - Selection becomes `{ ids: string[]; primary: string }`. The ObjectPanel edits the primary object; the box editor edits the group's bounding box.
   - A click on an object with `origin.group` selects the whole group. Alt-click (long-press on touch) selects one member.
   - Drag moves every member. The Transformer scales every member's box about the group box (font sizes do not scale) and rotates members about the group centre.
   - Delete, Duplicate and z-order act on the group as a block that stays contiguous.
   - 'Ungroup' clears `origin.group`.
   - Ops `moveObjects`, `transformGroup`, `deleteObjects`, `duplicateObjects`, `ungroup`, one undo step each.
6. **Pictures.**
   - Crop: numeric first, then Konva crop handles that move crop fractions while the box stays.
   - Mask: none, ellipse, rounded. Flip.
   - **Replace keeps the look, not the crop numbers.** The new picture is cover-cropped to the box's aspect and centred on the old crop's centre (clamped to the picture), so a picture of another aspect is never distorted. Box, mask, flip, opacity, stroke and shadow are kept. A picture with `fit:'contain'|'cover'` keeps its fit and drops the crop.
   - 'Use as background' moves a full-slide picture to `backgroundMediaId`.
   - The picker accepts images only; video goes through the media panel. This removes today's image-picker-accepts-video break (`ObjectPanel.tsx:131`).
7. **Backgrounds.** 'Replace background on this slide / on all slides using it' (`replaceBackground(mediaId, scope)`) for sermon-series art. In one undo step it rewrites slide and presentation `backgroundMediaId` and `role:'bg'` images, using the replace rule of item 6. It also offers 'Use video as motion background'. Hybrid slides change too, because their backgrounds are never inside the art.
8. **Find and replace** across the presentation (`findReplace(p, find, repl, {case, wholeWord})`): `editText` on every text object, one change, formatting kept. Later across every presentation of a playlist.
9. **Hide and unhide slide.** The slide is dimmed in SlidesPanel and flagged on its cue: Next skips it, a click shows it (§9).
10. **Apply this box's style to similar boxes** (`applyStyleToSimilar`, matched by `origin.ph` or `role` and master shapeId). This replaces master editing.
11. **'New slide like this'.** Duplicates the slide with its text cleared, for adding a verse or an announcement.
12. **PowerPoint card in SlidePanel:**
    - 'Rebuilt from PowerPoint' with the class, the approximations (`pptx.notes`, `source.log`) and missing fonts with an 'Upload font' link;
    - 'Show PowerPoint picture' (guarded by `digest`; it warns that the picture does not show edits);
    - 'Reset slide from PowerPoint'.

    A presentation-level 'Re-import from PowerPoint…' sits in PresentationPanel.
13. **Stage notes for the preacher:** `PropsRule.notes` region fed from `Slide.notes`.
14. **Video and sound panels (M5):**
    - video: start Automatically / On click (F8), loop, at end Hold / Black (rewind) / Next slide, volume, show when stopped, replace, 'Use poster only';
    - sound: replace, start, loop, volume, 'continue for N slides', with a warning when it replaces running playlist audio;
    - SlideGrid shows a `video` / `audio` tag on slide thumbnails (the `.tag` already used for media cues, `SlideGrid.tsx:154`);
    - one playing video per slide is enforced: the panel says which object plays.
15. **Media library hygiene (M3).** MediaTab hides media tagged `pptx` or `document` unless 'Show presentation pictures' is ticked. Deleting a media item that stored presentations reference asks for confirmation and names them, because a missing picture refuses goLive.
16. **Later (M8):** 'Split reveal into slides'; 'Convert to song' (lyric objects → sections and arrangement, kind song) with a 'Re-flow lyrics' op using the stored but unused `linesPerSlide`; preset adjust handles from the compiled `ahLst`; a bilingual band that also shows the `role:'translation'` box.
17. **Optional (M4):** a three-way merge per slide on 409 (base = `ed.base`, mine = draft, theirs = the 409 body's `current` once `ApiFailure` keeps it, `packages/client/src/api.ts:35-39`), so two volunteers editing different slides, or a volunteer and the version-2 patch, do not overwrite each other. Built in M4 (item H, `views/editor/merge.ts`): slide and object level, the rules in §15 M4 "As built, item H".

**Locked objects** show 'From PowerPoint (not editable)'. The Transformer allows move and resize (aspect kept for art). Delete and z-order work; text and geometry fields are read-only.

**Themes.** `applyTheme` replaces the lyric object's box style. Unless they are overridden, it drops the runs' visual overrides (fontFamily, color, sizeScale, letterSpacing, outline, shadow, highlight). It keeps structural formatting (fontWeight, fontStyle, underline, strike, baseline, caps) and `paras`, so verse superscripts, emphasis and numbering survive a theme change.

**Not built:** animation timelines, chart/SmartArt/WordArt/3D editing, master and layout editing, table row and column editing, custom path editing, gradient editors, hyperlinks and actions, PPTX export (prd/05), real-time co-editing, on-canvas rich text editing.

### Round trip and migration

- **Round trip.** There is no PPTX export. The deck stays stored (`fileReferenced`, `library.ts:446-452`). Inheritance is frozen at import: a changed PowerPoint master means a re-import.
- **Re-import.** 'Re-import from PowerPoint' (a hub job on the stored deck; refused while the presentation is locked):
  - regenerates only slides whose objects still match `pptx.digest`. The digest covers the import's objects only (those with an `origin`): the native import, the re-import and the LibreOffice patch all write it that way (`apps/hub/src/pptx/digest.ts`), so an object added in ordo never makes a slide edited, before or after a re-import kept it;
  - keeps slide ids, sections, arrangements, notes, durations, per-slide backgrounds, the lyric box the volunteer chose (an imported one mapped to the fresh object of the same PowerPoint shape) and the operator's own objects (those without `origin`, kept on top);
  - saves a new revision that History can restore.
- **No data migration.** Today's picture slides (`imported`) and made-editable slides render exactly as before.
- **Legacy text repair (M3).** The fix-now text fallback must not show another slide's text, so it is gated:
  - `firstText`, stage `slideText` and the search haystack fall back to `imported.textBoxes` only when `imported.textAligned` is set (and to `pptx.artText` on hybrid slides).
  - A one-shot, resumable hub maintenance job (`textRepair.ts`) runs over every pptx-sourced presentation whose deck is still stored. It re-extracts the text with pptx-scene, keyed by the slides the pages actually show:
    - for `source.renderer` 'libreoffice' or unset, pages count shown slides;
    - for 'pptx-preview', pages count shown slides only when the page count equals the shown count, else every listed slide.
  - It rewrites `textBoxes` with the uniform contain mapping, sets `textAligned`, and saves a new revision.
  - It skips presentations that are locked (retried after End service) or whose deck is gone. Those keep today's behaviour: no text fallback.
- **'Re-import as editable'** is opt-in for legacy PowerPoint presentations. Slides are matched with the same page rule as the repair job. Legacy slides are handled by kind:
  - **page slides** (`imported` present): replaced by the native slide; objects the user added on top are kept on top;
  - **made-editable slides** (no `imported`; in a pptx-sourced presentation; the bottom object is a full-frame ImageObject whose media is tagged 'document'): that page picture and every text object whose text equals an extracted box are replaced by the native slide. Other objects are kept on top. A text object at an extracted box's place (overlapping it by 60 % of their union) with another text is the volunteer's correction of that box: the slide is kept as it is and counted as edited (the rebuild would bring the deck's old wording back, and keeping the box would show both), unless the request resets it. The dialog lists these slides, and the user can keep any of them unchanged;
  - **any other slide:** kept as it is.

  Slide ids, sections, arrangements, notes (unless empty), durations and per-slide backgrounds are kept. The result is one new revision.
- **'Make editable'** on a single legacy slide runs the native converter for that page, which removes the doubled text.
- **Fix-now items for legacy slides (M3):**
  - the gated text fallback and the repair job (above);
  - `previewMedia` includes the imported picture;
  - new picture-class textBoxes use the uniform mapping and the shown index;
  - video ImageObjects draw their poster on outputs.
- **Trade-offs:**
  - after a text edit, layout is ordo's (LibreOffice model) and PowerPoint's stored fit is kept only while the text fits, so an overflowing edited box can land one size step away from PowerPoint;
  - outlines keep ordo's semantics (`width = w/2`, stroked under the fill);
  - art is LibreOffice's pixels;
  - one playing video and one sound per slide (others become posters).

## 12. Security bounds (the deck is untrusted)

**Process**
- Parse only on the CPU pool: 512 MB heap, 2 minutes per batch of ≤150 slides, at most 15 minutes of pool time per import (beyond it, the remaining slides become picture class, or the import fails cleanly when nothing is saved yet), termination on timeout.
- If the pool cannot start, the import fails with a clean message (nothing is saved; it can be tried again). Never parse inline on the event loop (which `extractPptx` and `pptxForRendering` did), and never hand the upload to LibreOffice instead: its render copy needs the pool too, and LibreOffice never sees a deck as uploaded (§5).

**Zip** (`extractZip` semantics)
- Trust the central directory only.
- Refuse encrypted entries and unknown methods; count inflated bytes against declared sizes.
- ≤ 200k entries; XML ≤ 8 MB per part and ≤ 64 MB in all; spilled media ≤ 1 GiB per import.
- At most 2,000 picture parts, 50 clips and 20 font parts per deck are extracted; the rest are logged and keep their posters or fallbacks. This bounds the Media rows and jobs one deck can create. The clip limit counts clips as stored, one per part and trim, so one part trimmed differently on every slide still makes at most 50.
- Add a `skip` filter (only referenced media and font parts spill) and `nested:false`.
- Entry names never become paths (`Store.abs` and generated names only).

**XML**
- Refuse `<!DOCTYPE` and every other markup declaration: no entity is defined, and only the five predefined entities and numeric references are decoded, one character each (pptx-scene's own reader; fast-xml-parser is not on this path).
- Before parsing, count ≤ 250k tags per part and ≤ 5,000 shapes per slide.
- Depth 256; ≤ 2,000 slides; group depth ≤ 32.
- A parse error quarantines that slide (class picture), never the deck.

**Prototype safety**
- No plain object is keyed by deck strings (local names, relationship ids, part names, typefaces, scheme names): use `Map` or `Object.create(null)`. fast-xml-parser lets `a:__proto__` and `a:constructor` through, and prefix stripping would create the dangerous keys.
- Job payload maps are arrays of pairs, with part names ≤ 512 characters; `adj` is an array of pairs.

**Numbers.** Every number is finite and clamped:
- slide side 1-51,206,400 EMU; logical coordinates ±100,000; box span ±2× the canvas; font 1-4,000 pt in the parser, 4-1,000 px stored for a box and 2-1,000 px for a run;
- per text object at most 16 distinct run and bullet families and 64 distinct size scales (`FontBudget` in `clamp.ts`, the same in `sanitizePresentation`): later families take the box's, later scales the nearest kept one. Each new family name costs the browser a platform font lookup (about 1 ms in Chromium), so 2,000 runs with 2,000 families would cost seconds per object. Family names lose every control character (a form feed is a CSS newline that voids the whole `ctx.font` assignment). A family is keyed by that cleaned name, trimmed and lower-cased, and every name with the key takes the spelling first kept, so names differing in case, surrounding spaces, quotes or control characters neither take more places nor make more font strings;
- adj ±1e7; ≤ 256 guides per shape; ≤ 4,096 path points per stored path (8 stored paths; a `cont` chain draws as one path of at most 8 × 4,096) and 64k per slide; ≤ 16 gradient stops;
- **drawing cost** (M6 repair, finish and finish review; renderer `geom/cost.ts`, `geom/outline.ts`, `geom/bounds.ts`, `geombudget.ts`): the counts above do not bound the time a shape takes (a zigzag of 4,000 points across its box took 1.5 s at 1920, a 21,600-point chain 22.7 s; a tiny custGeom stroked 400 px wide 3.9 s at 3840, 24,000 arrowheads on short open sub-paths 2.6 s). One estimate, in logical px of edge, rates a shape as it is drawn: each filled path or chain (its edges' length along their longer axis × (1 + the most edges active at once / 64)); each outline as the polygon Canvas fills for it (two offset edges a leg, every vertex's join, every open sub-path's caps, `GEOM_COST.dash` a dash, an arrowhead's own fill or, open, its own stroke, and its area), rated the same way, with `GEOM_COST.leg` a leg for the stroker's own work; the pixels each fill paints (the span of its points cut to the canvas; a logical px² `GEOM_COST.area` for a translucent colour, `opaqueArea` for an opaque one, `gradientArea` or `opaqueGradientArea` for a gradient, about five times a colour's: a full-slide translucent gradient takes about 11.7 ms at 4K, a translucent colour 2 ms; _M6 merge repair:_ `GEOM_COST.slowGradient`, twice that, for a gradient Skia cannot draw on its two-stop fast path, of three stops or more or two at one position (`slowGradient`): a full-slide translucent 4-stop gradient took 17 to 19 ms at 4K past a blank job, 8 to 11 for two stops at 0 and 1, and three of them 67 to 69 ms while the budget kept all three; two stops inside 0..1, such as PowerPoint's radial decorations at 0 and 60 % (29.7 ms a full slide before, 19.8 after), are drawn as two at 0 and 1 over that part of the gradient line, so they cost what a two-stop gradient does, and end stops repeating their neighbour's colour are dropped first (`stops.ts`); the converter follows: on the 2,713 shown worship slides, 8 slides of two traced-decoration templates, whose 3-stop backgrounds now count twice, send their last decorations to the art (`custGeom:complex`, native 2,525 → 2,517; 0.01 to 0.02 lower against LibreOffice on those slides; their 4K raster 42 → 30 ms on one template, unchanged on the other), and a deck's 0..60 % radial decorations draw 30 % faster at 4K with the same pixels) and the area each outline covers (`area`), legacy shapes included; the passes a shadow, a glow and a soft edge make over the shape's silhouette; and `GEOM_COST.point` (10) a stored point for parsing, rating and tracing it (about 0.25 µs at 4K). At most about 29 ns a unit at 4K over the worst arrangements measured (outlines are upper bounds: Chromium strokes most hostile ones 5 to 500 times faster than rated, thin dashes and arrowheads within 0.2 to 0.7). A stored geometry's fill is at most 1.3M, past which the converter sends it to the art (`custGeom:complex`) and the renderer draws the legacy shape; a slide's shapes (custom and preset geometries, picture masks and the outlines along them) at most 1.3M with their stored points, and the points at most 64k, past which later shapes go to the art (`custGeom:complex`, `geom:complex`) or draw as legacy shapes (without their stored geometry, gradient (its first stop), dash, arrowheads, joins and caps). Every object's legacy copy is counted first and never refused (`slidePlan`), and what is drawn on top of it must fit: a slide draws within the budget whenever its legacy copies do, and one within it is drawn as it is, whatever the order (legacy fills are bounded by the object budget alone, about 2 ms a translucent full-slide fill at 4K, as an older build draws them). A slide at the budget draws its geometry and fills in at most about 38 ms at 4K cold, within 50 ms with the clear and the copy out. The converter charges the slide's background first (a full-slide fill laid on white), and a shape it sends to the art for this budget emits nothing in version 1 unless it has text (then its legacy shape under its text, charged), as `budget:shapes` does. _M9 wave 1 repair:_ a preset shape without text that only its pixels put past the budget (no dash and no arrowhead, whose cost is the path's) is not sent there while the legacy copies of everything kept, its own included, fit the budget (`walk.ts` `keepPastBudget`, `WalkState.floors`: the floor `slidePlan` counts first): it is emitted as it is and charged as its legacy copy, and the emitted slide's own plan (`fitDrawing`) draws what fits natively in z-order and the rest as legacy shapes, exactly as the renderer draws a slide past its budget. So a full-slide radial panel over a radial background (two opaque slow radials, past `GEOM_COST.slide` since render-seams' raster repair), or a plain panel after a large translucent 3-stop decoration (a worship lyric template, 10 % costlier since `gradientArea` 0.22), stays on a hub without LibreOffice, in its legacy colour where no gradient fits; the floors still bound a stack of full-slide fills (13 of the review's 140, 26 ms at 4K). A change to `GEOM_COST` or `areaWeight` changes what the converter sends to the art beyond the exit set: its wave runs the census of the 667-deck suite before and after. The converter rates what it will emit with the same functions (`slideCustom`, and `fitDrawing` on the emitted objects), so every drawer (asset worker, thumbnails, editor canvas, each part of a scene slide after the slide is planned once) draws natively what the converter kept. A dashed outline is drawn at least 0.5 px wide (`clamp.ts`). A slide's shape effects: their layers' area at most 10 slide areas (a soft edge counts 8 times: its body is cut by its mask at full resolution on every raster, its reduced mask is cached), past which later shapes lose them (the converter notes it; the renderer leaves them out). Each layer is sized by what the shape draws (`bounds.ts` `drawnBounds`: its geometry's points, past its box included, grown by its outline's sharpest miter within the limit, its caps and arrowheads), placed on the slide and cut to the canvas and the effect's reach as `effects.ts` cuts it, in the converter (`fitEffects`, `fitDrawing`), the renderer's budget and the drawers alike (the M6 finish review: a 10 px custGeom whose path covers the slide weighed 0.0005 slide areas a shadow, a 10 px rect with a 500 px outline 0.001). Not in the estimate: the clamp of inline path text (about 0.5 µs a point; the converter stores large geometries in files, read and clamped once);
- geometry files (`ShapeGeom.ref`, M6 round 2): ≤ 400 KB each, parsed only by drawers that asked for them by name, their paths re-tokenised and bounded as inline paths are; a drawer keeps at most 4,096 files and 32M characters of their path text; an import stores at most 32 MB of them. _M6 repair:_ the pool task names them (re-tokenised, serialised and hashed off the library's event loop) and returns at most 32 MB a batch; the job applies the 32 MB as batches arrive, so it never holds more; a slide whose file is dropped or could not be stored is a compact picture; a shape whose only geometry is a file not read yet draws nothing until it is (an older build still draws the legacy shape); the editor refuses a file over 400 KB unread;
- recolour and tile bakes (M6 repair): at most 500 distinct bakes an import (the rest show their source pictures, noted), each charging the picture budget with what it decodes and makes (source, read size and output, in megapixels) and its pool time against the import's 15 minutes;
- colour maths clamped to 0..1; NaN and Infinity become 0.

**Relationships.**
- Resolved inside the package only.
- `TargetMode=External` is logged with its host and never fetched; it is also stripped from the render copy before LibreOffice sees it.
- `vbaProject.bin`, OLE payloads and raw SVG are never extracted or passed on (PNG fallbacks and OLE preview pictures are used).

**Media**
- Kind decided by sniffing, then `DECODE_LIMITS`.
- Pictures go through preparation (§4). `addReadyPicture` (a ready picture without a job) accepts only checked PNG/JPEG/GIF/WebP headers, ≤ 8,192 px a side and ≤ 40 MP, with animation (GIF, APNG, animated WebP) already flattened. Everything else goes through ffmpeg first. This bounds what outputs, the editor and the thumbnail worker decode.
- Names go through `baseName` (≤ 500).

**Logs.** Deck-derived strings in job log lines and `source.log` (titles, hosts, font names, part names) have control characters and newlines stripped and are cut to 200 characters, so a deck cannot forge `[warn]`/`[error]` lines or the 'HH:MM:SS msg' format.

**Fonts.** EOT ≤ 32 MB; decoded ≤ 64 MB with `FONT_LIMITS`-style table caps; then sfnt validation.

**External tools.** Only through `run()` (no shell, SIGKILL timeout, minimal env); ffmpeg and ffprobe keep `-protocol_whitelist file,pipe`, and clips are probed under a name from their sniffed bytes, never the part's; soffice without network where possible and with an address-space cap (§5); `eot2ttf` with an address-space cap.

**Saving.** Everything goes through `sanitizePresentation` (which now cuts runs and paras with the text) and the validating `lib.savePresentation`.

**Rendering.** `clamp.ts` re-bounds every new field: runs ≤ 2,000 (sorted, in range, else dropped), paras ≤ 1,000, path strings re-tokenised (those of geometry files too, `geom/stored.ts`), geometry refs of 1-100 printable characters, stops ≤ 16, effect sizes ≤ `maxEffectPx`, font sizes 4-1,000 px for boxes and 2-1,000 px for runs. Unknown values fall back to defaults; nothing throws.

## 13. Performance budgets

Measured at design time, before M7 (renderer bench, 4-core container, CPU canvas; the tight text sprite row was an estimate of the drawing alone; the as-built figures, transfer and the fresh bitmap included, are in design/14 "Measuring on venue machines": a lower-third sprite 1.3 ms at 4K, a lyric band 13.6 ms):

| Measurement               | 1080p   | 4K                 |
| ------------------------- | ------- | ------------------ |
| Full-frame authored slide | 3.2 ms  | 14.4 ms (p95 22.3) |
| Clear                     | 2.8 ms  | 11.4 ms            |
| Tight text sprite         | 0.1 ms  | 1.3 ms             |
| Layer textures            | 82.9 MB | 331.8 MB           |

The current JSZip text path takes 1.17 s per 100 slides.

**Reference hardware.** The hub runs on a Synology-class NAS (4-core x86 such as a Celeron J4125, `mem_limit: 4g`, `deploy/compose.yaml`). Hub budgets below are stated for that NAS. Until M3 measures one, they are taken as the container figures × 2.5. Output and editor budgets are for the venue's Windows 11 presentation PC (design/22).

| Budget                                         | Target                                                                                                                                                                                          | Enforced by                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub parse + emit                               | ≤ 30 ms per slide p95 in the container (≤ 75 ms on the NAS); ≤ 4 s per 200 slides on one pool worker (≤ 10 s NAS)                                                                               | harness timings, suite run, NAS run (M3)                                                                                                                                                                                                                                                                                                                               |
| Pool worker heap                               | ≤ 256 MB over the 637-deck suite                                                                                                                                                                | suite run                                                                                                                                                                                                                                                                                                                                                              |
| 17-slide sermon deck (≤12 MB), version 1 saved | ≤ 5 s after job start in the container, ≤ 12 s on the NAS, before any soffice process                                                                                                           | M3 e2e                                                                                                                                                                                                                                                                                                                                                                 |
| Picture preparation                            | ≤ 1.5 s per 24 MP photo on the NAS; prepared pictures ≤ 8,192 px and ≤ 40 MP                                                                                                                    | M3 e2e                                                                                                                                                                                                                                                                                                                                                                 |
| LibreOffice work                               | proportional to the slides that need it; one soffice run per import (art slides counted twice as pages)                                                                                         | job log                                                                                                                                                                                                                                                                                                                                                                |
| JSON sizes                                     | per §3.4                                                                                                                                                                                        | importer, tests                                                                                                                                                                                                                                                                                                                                                        |
| Asset worker slide raster p95                  | ≤ 10 ms at 1080p, ≤ 30 ms at 4K; after M7 ≤ 12 ms at 4K for text over photo; a slide past it by its drawing estimate ≤ 50 ms (named exception below)                                            | `bench:slides` (six slide kinds, M6's two included, `--check`), health `rasterMs` p50/p95 over the last 64 slides with the `raster` alarm (M7) over those within the budget by their content (`rasterHeavy` counts the rest)                                                                                                                                           |
| Longest asset-worker task                      | ≤ 50 ms; props flip never > 1 frame late during a slide decode (M7; as built: longest slice 41 ms and props bitmap ≤ 36 ms after sending at 4K, `bench:lanes`)                                  | health long tasks; `asset.lanes.browser.test.ts`; per-lane `longestMs` in telemetry; tables: `bench:tables` (the largest tables' longest prepare slice and draw at 3840, median of five runs)                                                                                                                                                                                                                                                                                    |
| Rich layout                                    | ≤ 1 ms warm, ≤ 5 ms cold per 400 characters; autofit ≤ 12 layouts                                                                                                                               | unit bench                                                                                                                                                                                                                                                                                                                                                             |
| Render worker                                  | zero missed vsync; no task ≥ 50 ms; nothing allocates or compiles on GO; static slides add 0 draws; in-slide video adds 1 external texture + 1 bind group per frame, same single pass per layer | hot-lint, soak, e2e                                                                                                                                                                                                                                                                                                                                                    |
| Uploads                                        | ≤ 4 ms per frame at 4K on the reference venue GPU (M7)                                                                                                                                          | health `uploadMs` with the `upload` alarm (M7); `bench:venue` on the venue machine                                                                                                                                                                                                                                                                                     |
| GPU memory at 4K                               | static slides +0; +66 MB only once a scene needs `over`; total ≤ 400 MB (5 layers: 331.8 MB of layer textures + 66.4 MB of over = 398.2 MB)                                                     | health `gpuMB` (reported since M5: layer and over textures) shown against the budget for the output's size (M7: 400 MB at 4K, by pixel count, 100 MB at 1080p). No alarm: `gpuMB` is ordo's own allocation, a fixed function of the size and of the scenes with an over, so it meets the budget by construction; the GPU's real pressure is not observable from a page |
| GPU time per frame                             | ≤ 4 ms at 4K on a venue iGPU (timestamp-query where available)                                                                                                                                  | M7 measurement (`bench:venue`: five full-frame layers in one pass, timestamp queries)                                                                                                                                                                                                                                                                                  |
| Editor                                         | rich box re-layout + redraw ≤ 8 ms for 1,000 characters; thumbnail ≤ 15 ms at 640 px; opening a 17-slide sermon deck decodes no picture larger than its prepared size                           | unit bench, M4 e2e                                                                                                                                                                                                                                                                                                                                                     |
| Sync                                           | in-slide video start skew within design/23 bounds (17 ms real GPU, 100 ms SwiftShader)                                                                                                          | e2e                                                                                                                                                                                                                                                                                                                                                                    |

**Named exception to the asset worker slide raster p95** (M6 merge review): _a slide whose drawing estimate is past the raster budget._ The drawing budget keeps a slide whole up to `GEOM_COST.slide` (about 38 ms of geometry and fills at 4K, within the 50 ms of an asset-worker task with the clear and the copy out), not up to the 10 / 30 ms raster p95. The worship decks' traced decorations reach it: a template slide of about 100 geometry-file shapes and 36 path shapes over a 4-stop background takes 19 to 21 ms at 1080p and 45 to 48 ms at 4K job-warm, and 55 of 100 traced-outline slides take over 50 ms cold at 4K. Such a slide is held to the 50 ms task, not to the p95: the asset worker marks it `heavy` when its drawing estimate (`health.ts` `rasterEstimateMs`: a fresh full-frame bitmap, 10 ms at 4K by pixel count, and the units the budget charges at 29 ns at 4K, 0.4 of that at 1080p; fitted over 343 full-frame converted slides at 10.9 ms + 32.8 ns a unit at 4K and 2.8 ms + 12.4 ns at 1080p) is past 80 % of the p95 budget at the output's size (`heavySlide`), and health reports its time in `rasterMs` and counts it in `rasterHeavy`, but the `raster` alarm, which tells the operator the computer is slow, reads only the other slides (`rasterAlarm`). `bench:slides` has a traced-decoration kind (a 3-stop background, eight filled outlines of 1,000 to 2,000 points and 70 thin strokes; heavy, checked at 50 ms: 43 ms p50 and 46 p95 at 4K, 19 and 22 ms at 1080p when added) and a gradient-decoration kind (two large radial decorations at 0 and 60 %, within 10 / 30 ms: 17 ms p50 at 4K). The estimate is not an upper bound for every part of such a slide: 110 thin round-joined open strokes of 10 to 25 points cost about 64 ns a unit at 4K and the filled outlines of cubic curves about 50, against the 29 the budget assumes, which the background's and the traced outlines' points (rated well above their cost) make up for on the worship decks' slides. Tables (warm p95 5.1 / 14.8 ms) and SmartArt drawings (5.8 / 17.2 ms) are within the p95 on their own. The way out is the same as the effect budget's: a draw that yields between objects, or composites of heavy effect-free shapes cached by content key as `effects.ts` caches effect layers.

<!-- m9:render-seams -->
_M6 merge re-review, fixed in M9 wave 1 (render-seams)._
- **What the heavy-slide estimate counts.** `rasterEstimateMs` (`health.ts`) is no longer the geometry units alone:
  it adds the effect layers copied or enlarged from the cache (`SlideDrawCost.effects`), the glyphs drawn blurred
  (`textEffects`: a box or run shadow, or a glow, each character's em square), the characters laid out and drawn
  (`chars`), the pictures copied 1:1 and those drawn from their source (`pictures`, `sourcePictures`; a slide's
  reference picture counts as one copied), and the effect sprites the draw had to make, which the asset worker
  reads from `effects.ts` `effectWork` across the job (`effectsMade`: canvases at full resolution and reduced),
  so a slide's first raster that builds its shadow layers is heavy by its content, not a slow computer. The
  constants (`RASTER_ESTIMATE`) are the estimate's own fit: non-negative least squares over 500 slides of 31
  converted decks (the re-review's 22 worship decks, 7 ordinary shard decks, 2 sermon decks), each drawn as the
  asset worker draws it, first in deck order with the sprite cache emptied at each deck's start and then warm,
  divided by 1.31 (the container ran that much slower that day than in the M6 review's session, by both
  sessions' job-warm intercepts: 14.3 / 3.7 ms against 10.9 / 2.8). At 4K a fresh frame with a first raster's own
  costs is 13.3 ms, a million units 25.6 ms, a slide area of effects copied 3.8 ms, of glyphs blurred 18.1 ms, a
  thousand characters 10.8 ms, a slide area of pictures copied 2.5 ms, of effect canvases made 35 (full) and 62
  (reduced); at 1080p 4.1, 9.9, 0, 3.3, 5.1, 0.7, 11.1 and 27 ms. Measured over estimated on first rasters: p50 0.99,
  p90 1.24 at 4K; 0.86, 1.41 at 1080p. The alarm simulated deck by deck on those first rasters at the reference
  speed (`scratchpad m9/w1/render-seams/fit`): at 4K it fires on 2 of the 26 decks of five slides or more (was 10)
  and the slides it reads have a p95 of 27.7 ms (was 55.3); at 1080p on 5 (was 10), p95 12.7 ms (was 21.0). What is
  left at 1080p is first-raster cost the content does not explain (an ordinary 20-slide deck draws its first
  rasters in 14 to 23 ms against 5 to 7 ms warm, at about 300 characters a slide).
- **The figures the alarm quotes.** The report carries the window the alarm read (`HealthReport.rasterAlarmMs`,
  when heavy slides are left out of it); the alarm's log line and the operator's detail quote it, with every
  slide's p95 beside (`slide raster p95 34.5 ms is over the 30 ms budget (p50 19 ms, 20 slides; 9 more past the
  budget by their content, not counted (p95 of all 29: 41.4 ms))`).
- **Opaque slow radial gradients.** `areaWeight` gives an opaque radial gradient off Skia's fast path no opaque
  discount (`FillPaint.radial`; the converter's `drawSpecOf` and background cost say radial for a path gradient):
  two opaque full-slide 4-stop radials took 49.7 ms p50 at 4K while rated 1.17M units; now one is kept and the
  other drawn as its legacy colour (the converter now emits such a shape for the renderer's plan to draw so,
  rather than send it to the art, wave 1 repair: on the suite, 55 slides of 10 decks had lost a textless shape
  to `geom:complex` and 21 of them went hybrid, a hub without LibreOffice showing them without it). The raster
  bench checks a stack of three (`OPAQUE_RADIAL_GRADIENTS`): 31.8 to 35.9 ms p50 and 33.3 to 42.9 p95 at 3840
  in three runs, 8.1 to 9.3 / 8.3 to 11.2 at 1920. _(M9 wave 2, `decor-conv`: such a shape is stored whole,
  never flattened to its legacy colour; the renderer's plan draws it so until the slide's decoration plate
  holds it.)_
- **The share the heavy-slide estimate leaves out of the alarm** (wave 1 review, measured over E, warm draws,
  no effect sprites made): 689 of the 2,820 worship slides (24.4 %) are heavy at 1080p and 723 (25.6 %) at 4K,
  against 149 with the geometry units alone; of the 73 sermon slides 10 at 1080p and 17 at 4K (none before).
  The typical one is a photo background under about 250 characters of shadowed lyric (at 4K: frame 13.3, blurred
  glyphs about 9, characters 2.7 and the picture 2.5 ms, past 24 ms), which the harness draws warm in 3.0 / 10.6 ms
  p95 (sermons, 1920 / 3840) against estimates of 7.1 to 8.9 and 24 to 31 ms. So the raster alarm reads about
  three quarters of an ordinary worship deck. The constants were checked only on the 500 slides they were fitted
  on; open for the renderer: refit them on first rasters outside the fit (E through the asset worker's path), or
  judge a slow computer by measured over predicted time (the M6 re-review's proposal), so that ordinary
  shadowed text stays in the alarm.
- **Headroom for stacked translucent gradients.** `GEOM_COST.gradientArea` is 0.22 (was 0.2): over one another
  such gradients cost about 12.6 ms a full slide each at 4K, not the 11.7 of one over a clear canvas, and three
  full-slide ones at 0 and 60 % (all kept at 0.2, 47.7 ms p50 and 52.7 p95 at 4K in the re-review) left the 50 ms
  task no headroom. Now two are kept: in three runs of `bench/raster.ts --check` each, alternating with the base
  build on one quiet machine, the row took 36.3 to 36.6 ms p50 and 37.1 to 38.8 p95 at 3840 (base: 40.3 to 45.9 p50,
  47.1 to 54.2 p95, over the bound in two runs), 9.2 to 9.6 p50 at 1920. The six translucent full-slide gradients
  row drops the same way (36.6 to 42.8 ms p50 at 3840; base 41.9 to 44.3, over the bound once). Every other row is
  within the runs' noise of the base build (`scratchpad m9/w1/render-seams/bench-cmp.txt`).
- **No converted slide changes**: the census of E is identical to the base's in every slide's class, reasons,
  objects, geometry count and bytes (the converter rates its emitted shapes with the same functions).
<!-- /m9:render-seams -->

**Named exception to the editor's 15 ms thumbnail at 640 px** (M6 merge review): _the first thumbnail of a heavy traced-outline slide_, which builds its geometry paths and its effect layers: 22.6 ms for a slide of 136 shadowed geometry-file shapes, 19.2 ms and 13.9 ms for two others; later draws take 1 to 8 ms. The thumbnail worker draws in a worker of its own, so the editor's main thread does not wait for it.

**Named exceptions to the 50 ms asset-worker task** (M6 finish review; a slide's draw is one task, §7.5 "Two raster lanes"):
- _A slide at its effect budget, drawn cold_ (no layer cached): on the CPU-backed canvases of the asset worker, enlarging a reduced blur layer costs about 20 ms a slide area at 4K and a composite's allocation about 14 ms more, so 10 slide areas of layers take a few hundred ms the first time (the review's twenty custGeoms past their boxes with shadows, nine kept: 379 ms p95 at 3840, 300 ms at 1920; the corpus's most effected slides, 6.4 to 9.1 slide areas, 120 to 225 ms cold and 15 to 94 ms warm at 3840, 32 to 87 ms cold at 1920). Rasters after the first reuse the cached composites and layers. The raster bench checks these slides at 400 / 500 ms (1920 / 3840) cold. Bounding them at 50 ms would cut the effect budget to about one slide area, which 102 of the corpus's 2,927 slides pass (12 decks); the way out is a slide draw that yields between objects, or effect layers composed by the GPU compositor (M7).
- _A full-slide soft edge, drawn cold_: its first raster makes the eroded, blurred mask and a full-resolution body cut by it, 97 to 118 ms at 3840 (134 ms before the body was cut in place, without a copy), 15 ms warm.

## 14. Testing and fidelity measurement

1. **`tools/pptx-fidelity --engine native|ppv|both` (M1).**
   - `native.ts` reads the deck with `extractZip`, runs `parseDeck` and `emitSlides`, and writes `slides.json` plus the pictures.
   - `native-page.ts` is an esbuild bundle of `@ordo/renderer`, loaded in headless Chromium the way `golden/run.ts` loads its page.
     - It draws each shown slide with the real `drawSlide2D` (background cover-fit under it, like the thumbnail worker) at 1920x1080, then crops the slide rect, so 4:3 decks compare like for like.
     - It also renders at 3840 for raster timing.
   - Fonts: the host `fc-match` file of every requested family (`pptx-render/src/fonts.ts`), registered under internal names; the bundled substitutes once M3 lands.
     - _As built (M2):_ the page installs the renderer's `FontResolver` as its font environment, as the asset and thumbnail workers do, and the slides keep the deck's family names. Every requested family (run, bullet and `fallbackFonts` families included) gets its `fc-match` faces; ordo's default face is registered, and so are the `SCRIPT_FALLBACK_FONTS` families of the text's scripts that are installed, each with its script's `unicodeRange`. A missing one falls back per glyph as LibreOffice's does; `--script-stand-ins` registers fontconfig's face for the script's language under its name instead (closer to an output, further from LibreOffice: Arabic set in Times New Roman lost 0.02 on a worship deck). A face fontconfig gives for another family (Inter for Aptos) is registered as `substitute` unless one of its names is the family or a metric clone of it, so the resolver does not take it for the family's own face and fits such boxes again as an output without the family does (§6 step 10).
   - Scoring uses the existing `ssim()` (greyscale, 960x540). Cached LibreOffice pictures are reused through `--out` (the local validation suite and the sermon decks are kept outside the repository).
   - `summary.json` gains, per slide: `nativeSsim`, tier, class, reasons, `convertMs`, `rasterMs` at 1920/3840. The report gains a native column and per-tier and per-feature (manifest `features`, worship-high first) means.
   - `--no-ppv` skips pptx-preview. `--baseline` gates regressions: no worship deck drops by more than 0.02.
   - `--lo-compat` (harness only) draws like LibreOffice where the policies differ: no run shadows, hollow outlined text, re-fit instead of the stored scale. Policy rules are reported separately, so progress is not hidden.
     - _As built (M2):_ the converter writes the text with LibreOffice 24.2's policies (`EmitOptions.loCompat`, never set by the hub): no run shadows (an unfilled shape's shadow on its text stays), no outline on filled text (the reference pictures come from `pptxForRendering`'s copy, which strips them, so hollow letters never appear in them), shrink-to-fit re-fitted from full size, and only for a shape's own `normAutofit` (LibreOffice ignores one inherited from a layout or master placeholder; measured with a probe deck). The harness emits each deck both ways and records per slide the rules that change its drawing (`runShadow`, `textOutline`, `refit`, `inheritedFit`); with `--lo-compat` such a slide is drawn both ways, and `summary.json` and the report give the means both ways, per rule and overall. `--baseline` compares ordo's own drawings.
   - _Also built in M2:_ per-slide text features read from the slide's XML with the suite inventory's rules (superSub, lnSpcPct, normAutofitScaled, rtl, rtlScriptText, bulletsAuto) and the census's mixedRuns, with means per feature, per tier and per deck next to the M2 targets; `--slides [DECK:]LIST` scores only some slides.
   - Decks with embedded fonts are excluded from means; LibreOffice 24.2 ignores them (it drew Inter).
   <!-- m9:base -->
   - _Built for M9 (base track; `tools/pptx-fidelity/README.md`):_
     - `src/census.ts`: the census as a harness tool. It reads every file of `DECK_RE` (`.pptx`, `.pptm`,
       `.ppsx`, `.ppsm`, `.potx`, `.potm`, as a fidelity run does), converts each deck in the harness's worker,
       and writes per shown slide the converter's tier, class and reasons and the hub's view: `stored`
       (`storedSlideBytes`), `hub` and `hubWhy` (`hubClasses`: the import's geometry-file budget, then
       `planImportSizes`, as `nativeJob.ts` runs them). A link whose deck is gone is a row
       `unreadable: "missing target"`, never an error.
     - `--before hub` (`src/beforehub.ts`) writes `perSlide.beforeHubSsim`: what a hub with LibreOffice showed
       before M9. A slide the hub stores as a picture shows LibreOffice's page (1). A hybrid slide is scored
       with LibreOffice's pixels pasted over its art box, and a slide with metafile pictures with them pasted
       over the metafiles' boxes, on the native page. `nativeSsim` stays the harness's before: residual
       elements draw nothing.
     - `maxObjectMs` (`src/native-page.ts`, §13's 50 ms task): once a deck's slides are timed, each slide is
       drawn again object by object as `drawSlide2D` draws them, cold (a copy of the slide, the effect sprites
       cleared, its pictures prepared outside the times). Each `drawObject` is timed with its flush, at 1920
       and 3840 px, and the largest is kept with its object's id.
   <!-- /m9:base -->
   <!-- m9:harness -->
   - _Built for M9 (harness track; `tools/pptx-fidelity/README.md`):_
     - `--before hub` now takes the hub's real picture: each deck with a slide the hub does not store native,
       with pending metafiles, or that the converter did not emit, is imported once through this checkout's
       hub with LibreOffice (`src/hub-import.ts`), and its version 2 of those slides is drawn by the harness's
       renderer and scored (`beforeHubFrom: 'hub'`). The wave-0 pixel paste is kept as `beforeHubPaste`, a
       labelled fallback where the hub gives no score (`--before paste` alone). It was no bound of version 2:
       it took LibreOffice's background inside the art box, missed the art's spill past the box, and stood at
       1 for picture slides, which really show the hub's stored page.
     - F, the exit's set, is every slide not stored native, every slide with metafiles left to LibreOffice
       (`perSlide.metafiles`), and every shown slide the converter did not emit (scored as the hub's
       LibreOffice picture). `native.all.causes` tables F by cause as `exit_ssim.py` groups it.
     - `--no-libreoffice` scores what a hub without LibreOffice shows (`noLoSsim`, `missing`), drawn from the
       deck emitted with `EmitOptions.libreoffice: false` as the hub stores it; `--hub-budget` draws every slide
       as the hub stores it (`hubStoredSlide`, the hook the budget ladder fills).
     - Registries: `src/compat/` (one LibreOffice policy rule per file) and `src/features/` (one XML feature
       family per file, with the parts a slide names), each listed once; `src/exceptions.ts` (named
       exceptions by deck SHA-256 prefix, slide and reason, lifting gate 2 only unless the entry says 'all');
       `src/libreoffice.ts` (`pptxToPdf`, moved out of the hub's `media/ffmpeg.ts`: the hub keeps only its
       sandboxed LibreOffice path).
     - `maxObjectMs` reads the deck's geometry files again before each slide's object pass, so a geometry in a
       file is built inside the times.
     - `src/hub-import.ts` is also the exit's soffice-less import of the whole worship set (§15 M9 exit,
       plan §6.3), with `--dry-run`.
   <!-- /m9:harness -->
2. **Committed probe decks.** Synthetic generators, as in `corpus.ts`, one per verified rule:
   - tint/shade (#454545);
   - defaultTextStyle for non-placeholders;
   - hidden slides, the shown index and hidden-cue navigation;
   - 4:3 mapping and empty bars on native, hybrid and picture slides;
   - group affine with rotation and flips;
   - numbering with startAt;
   - clrMapOvr; mc:AlternateContent;
   - line spacing and autofit sizes;
   - superscript;
   - RTL and NBSP;
   - media timing (auto, click, loop, vol, trim baked, numSld, rewind, showWhenStopped, fullScrn);
   - a chart slide with a photo background and a video below the chart (art z-range, transparent art, background swap);
   - a 48 MP photo (picture preparation).

   CI runs `--engine native --corpus` and fails on a drop of more than 0.01 against the committed baseline.
3. **Parser fuzz and limits** (patterns of `pptx.fuzz.test.ts`): billion laughs, DOCTYPE, `a:__proto__`/`a:constructor`, depth, huge parts, lying zip headers, cyclic rels, External targets, 5,001 shapes, NaN and huge numbers, 10k path points, hidden-only decks, 10,000 tiny media parts, control characters in names. Each must finish in under 5 s.
4. **Renderer goldens** (`golden/page.ts`).
   - Legacy cases stay byte-identical.
   - New cases: runs, verse superscripts, justify, bullets and numbering, autofit, Hebrew and Arabic, mixed bidi, the Arabic ZWJ style split, a Tamil grapheme break, CJK, 'Dieu !' NBSP, crop with negative padding, mask, flip, a Hebrew lyric-only band (punctuation at the left end), presets (M6; as built: shape-presets, shape-gradients, shape-lines, shape-effects, image-mask, image-mask-prepared, rich-gradient-text).
   - A line-break invariance test at 960/1920/3840.
   - **The skip trap is fixed:** `meta.fonts` is built from the files actually used, and CI fails on a skip (`run.ts:60-74`).
5. **Compositor golden (M5).** WebGPU under `--enable-unsafe-webgpu --use-angle=swiftshader` (the minimal set verified to import external textures in a worker) against the Canvas 2D compositor, pixel by pixel: scene stacks with a synthetic `VideoFrame` from a canvas, masks, crops, rotation, crossfade midpoints, a stale generation (poster shows), and no frame (poster shows, never black). Tolerance 40 per channel, ≤ 0.4%. Built as `golden/compositor-run.ts`; it also compares WebGPU with the `planeSample` reference within a tighter bound, and it adds `--use-vulkan=swiftshader --enable-features=Vulkan` (design/23), because with the ANGLE flags alone Chromium 1243 loses the device at its first pipeline.
6. **Preset golden (M6).** All 187 presets with default adjustments, `@ordo/renderer/geom` against LibreOffice (a probe deck through soffice); the evaluator is unit-tested against POI semantics.
   - _As built (M6 wave 1):_ `pnpm --filter @ordo/geom-gen golden` (`tools/geom-gen/src/golden`). The probe deck has six presets to a slide, each in a 360x240 px box with its own fill and a 3 px outline; LibreOffice's pages come from `soffice --convert-to pdf` and `pdftoppm -r 144`, ordo's from `drawGeom` in headless Chromium, and each box is scored with the harness's SSIM (`tools/pptx-fidelity/src/ssim.ts`, now shared with `main.ts`). It fails on a preset under 0.95 that `exceptions.ts` does not list, or on a drop of more than 0.01 against `baseline.json`. With LibreOffice 24.2.7: 186 of 187 at ≥ 0.95, mean 0.9959. The listed one is funnel (0.928): LibreOffice's preset table reads the guide name `2da` as the number 2. The golden found that LibreOffice strokes open paths after every other path (chartX, chartStar, chartPlus), and `draw.ts` now does too.
7. **Schema compatibility.**
   - The previous release's schema parses new slides (stripped), and the stripped slides draw non-empty.
   - `.catch` enums and clamp property tests; sanitize property test: cutting text keeps runs and paras in range.
8. **Reducer and invariants.**
   - Slide video and audio: click start, re-entry, `clear('slide')`, `media.ended` advance.
   - Slide audio: `untilCue` over shown slides, and no restart while playing across a loop wrap.
   - Hidden cues skipped by next, prev, autoAdvance, onEnd advance, nextItem and goToSection, but reachable by `go`.
9. **Editor ops.** Property tests: 10,000 random `editText`/`formatRange` sequences keep runs sorted, non-overlapping and in range. Also: `findReplace`, `replaceBackground` (no distortion across aspects), `applyStyleToSimilar`, group transforms, `applyTheme` keeping verse superscripts, and `editText` keeping `fitScale` while the text fits.
10. **Size budgets.** A 2,000-slide synthetic deck imports within 4 MiB (the tail becomes picture class, logged). Preview of the largest slide's section stays < 1 MiB. A 13 MiB resolved playlist gets the degraded warning, and the operator refuses adopt locally.
11. **Migration.**
    - The legacy repair job on a stored deck with a hidden slide (LibreOffice and pptx-preview variants): stage, labels and search show the right slide's text.
    - Re-import of made-editable slides replaces the page picture and matching boxes and keeps user objects.
12. **e2e.** Import → goLive → two outputs (slide pixels, in-slide video at its z, F8, onEnd advance, skew) → stage text and notes → lower-third and stream text → search and cue labels. Also: Clear media during an in-slide video and then arm the next slide's clip; the live slide shows its poster, never the next clip. The authored-slide half (no import) is `e2e/slide-media.spec.ts` (M5 wave 1). The imported half is `e2e/pptx-native.spec.ts` (slide pixels against the harness at 1080p and 4K, stage, Lobby and Stream text, cue labels, search, the hidden slide) and `e2e/pptx-media.spec.ts` (PowerPoint clips and sounds through the M5 exit), on synthetic probe decks (`e2e/pptxdecks.ts`), M3 wave 2. The stage's notes region is M4's (`PropsRule.notes`), so notes are checked in the stored slides.
13. **Perf.** The raster bench moves into `packages/renderer/bench` with rich slides at 1080p and 4K. A 30-minute 4K soak with slide videos on a reference venue GPU runs before media ships. The hub budgets are measured once on a reference NAS in M3.

## 15. Milestones

Items marked **∥** can be done in parallel by separate agents. M4 and M5 can also run side by side: they touch different packages and both need M3.

### M1: Native-lite in the fidelity harness (1-2 days)

**Scope.**
- `packages/pptx-scene` first version:
  - reading: xml (moved), opc, deck order with hidden slides and the shown index, `sldSz` with the contain map;
  - colours: theme colours with clrMap/clrMapOvr; srgb, scheme, sys and prst; lumMod, lumOff, alpha, and tint/shade in linear γ 2.3;
  - inheritance: placeholder xfrm/bodyPr inheritance; first-run style through the chain (`defaultTextStyle` for non-placeholders): size, colour, bold, italic, latin font through the theme;
  - slide content: algn → align; anchor → valign; insets → padding; outline w/2; outer shadow; lnSpcPct → lineHeight; master/layout shapes with showMasterSp; solid and stretched-picture backgrounds; rect/roundRect/ellipse/line; `p:pic` stretch; groups by offset and scale; the tier classifier.
- It emits only today's objects plus one new field, `ImageObject.crop` (schema, clamp, 9-argument `drawImageFit`, one golden case).
- The harness gains `--engine`, `--no-ppv` and the native column.

**Files.** `packages/pptx-scene/**`; `packages/domain/src/schemas.ts`; `packages/renderer/src/clamp.ts`, `text2d.ts`, `golden/page.ts`; `tools/pptx-fidelity/src/main.ts`, `native.ts`, `native-page.ts`, `report.ts`, `package.json`.

**Exit.**
- The run completes on the 5 sermon decks and on at least one worship-high validate shard (90+ decks) with cached LibreOffice pictures, and nothing aborts it; a deck the converter cannot read is a note.
- `summary.json` has native SSIM, tier, reasons, `convertMs` and `rasterMs` (1920/3840) for every LibreOffice-drawn slide.
- Native beats an all-black frame on ≥ 95% of slides: its SSIM against LibreOffice's page is higher than an all-black frame's, or it matches the page at ≥ 0.999 (`tools/pptx-fidelity` `report.ts` `beatsBlack`), so an all-black page drawn all black is not a loss.
- The 5 sermon decks: every slide renders, and mean native SSIM ≥ 0.80 is recorded next to pptx-preview's.
- The T1 share of shown worship slides is within ±3 points of the census (30.9%).
- A synthetic 4:3 deck places its boxes within 2 px of LibreOffice's page.
- `native-baseline.json` is saved.
- Existing renderer tests and goldens are unchanged; no file under `apps/` changes.

**Parallel.**
- ∥ reading layer (xml move, opc, deck, frame);
- ∥ theme and colour with probe-value unit tests;
- ∥ inheritance and emission (text, pictures, shapes, backgrounds);
- ∥ `ImageObject.crop` (schema, clamp, draw, golden);
- ∥ harness native column (esbuild page, fonts, LibreOffice reuse, report);
- ∥ tier classifier (the census rules of §5).

### M2: Rich text model, text engine and font resolver (about 3 weeks)

**Scope.**
- Schema: `TextRun`, `TextPara`, the TextStyle additions, `ObjectOrigin`, `locked`; whitelisted in `clamp.ts`; `sanitizePresentation` cuts runs and paras with the text.
- The `text/` engine: breaks, bidi, segments with the joining and grapheme rules, office line model and autofit (with `fitScale` kept while it fits), bullets and numbering, paint passes, caches.
- `drawObject` dispatch; legacy path unchanged, except that `ctx.direction` is set for paragraphs with strong RTL characters; bands with rich or RTL text go through `layoutRich`.
- `readableText` and `textScripts` in the domain; bands, labels and search use `readableText`.
- Font resolver with internal names in the asset worker, thumbnail worker and editor; font retry; the `inter` fix.
- `referencedFontFamilies` / `jobFontFamilies` cover runs, bullets and fallbacks.
- `SlideCanvas` draws rich text at devicePixelRatio.
- The converter emits runs, paras, bullets (symbol mapping), superscripts, rtl/lang, autofit with `fitScale`, insets, wrap, `lyricObjectId` and `fallbackFonts` (including script fallbacks).
- Golden skip-trap fix.

**Files.** `packages/domain/src/schemas.ts`, `resolve.ts`, `readable.ts`, `bullets.ts`, `cues.ts`; `packages/importers/src/sanitize.ts`; `packages/renderer/src/text/*`, `text2d.ts`, `clamp.ts`, `raster.ts`, `golden/page.ts`, `golden/run.ts`; `apps/output/src/asset.worker.ts`, `link-core.ts`; `apps/operator/src/workers/thumb.worker.ts`, `services/fonts.ts`, `lib/search.ts`, `views/editor/SlideCanvas.tsx`; `packages/pptx-scene/src/text.ts`, `emit.ts`; root `package.json` (linebreak, bidi-js).

**Exit.**
- Legacy goldens are byte-identical, and the new rich goldens pass, including the Hebrew band.
- Identical line breaks at 960/1920/3840.
- Harness on the worship decks: T1+T2 slides render natively, with mean SSIM ≥ corrected pptx-preview on the same slides. superSub, lnSpcPct, normAutofitScaled, rtl and rtlScriptText feature means are ≥ pptx-preview's (0.61, 0.75, 0.77, 0.71, 0.66).
- Sermon decks: 72 of 73 slides are native class, and each deck's mean is ≥ pptx-preview − 0.01.
- Harness raster p95 ≤ 8 ms at 1920 and ≤ 30 ms at 3840 on sermon slides.
- A late-loaded font takes effect without a worker restart.
- The previous-release schema test and the sanitize property test pass.

**Parallel.**
- ∥ breaks, bidi and segments (UAX#14/9, NBSP, graphemes, ZWJ);
- ∥ office line model and autofit port;
- ∥ bullets, numbering, symbol mapping and `readableText`;
- ∥ paint passes and caches;
- ∥ font resolver in three drawers;
- ∥ schema, clamp, sanitize and compatibility test;
- ∥ converter rich emission;
- ∥ goldens (incl. RTL bands) and skip-trap fix.

### M3: Hub native import (editable) with per-slide LibreOffice fallback (about 3-4 weeks)

**Scope.**
- **Pipeline:**
  - light job `pptx-native`: `extractZip` with the skip filter, part caps and spill budget; pool task `pptx-scene` (transferred, batched, 15-minute import budget); picture preparation and `addReadyPicture`; SHA-256 dedup with a new media hash index (SQL DDL) and resume pairs;
  - classification with the art z-range and the size budgets (§3.4); two-phase save; heavy `pptx-lo` follow-up enqueued before any clip (render copy with white/black art pages, soffice once, selected pages at 288 dpi, pool task `pptx-art`, metafile conversion, digest-guarded patch, deferral while locked, soffice hardening); `pptx-reference` job.
- **Slide data:**
  - `Slide.pptx` (with `artText`), `hidden` (flagged cues and reducer navigation), and `transition` (`item ?? slide ?? presentation`); flips and ellipse/roundRect masks;
  - notes, sections, `lyricObjectId`, background promotion and the 'Extend plain backgrounds' option, transitions, advTm;
  - `source.log` and `source.native` (with `slideRect`).
- **Shared fallback rule:** `slideContent()` in every drawer.
- **Fonts:** bundled fonts and the Dockerfile; script fallbacks sent to every output through output-config fonts; CJK by text scan; `Font.unicodeRange` and Google Fonts subsets.
- **Sizes:** §3.4 budgets in the importer, `previewSlice`, the resolved-playlist warning and the local adopt check, snapshot size in health.
- **Route:** `renderer=native` is the default; ImportTab offers 'Editable (recommended)' / 'Pictures (LibreOffice)'.
- **Wiring left from M1** (M1 changed nothing under `apps/`): the editor's `SlideCanvas` image node passes
  `o.crop` to `drawImageFit`, and 'Replace image' drops the old picture's crop, so the editor shows the
  `ImageObject.crop` every other drawer already honours (§3.2 "Each field is wired everywhere it is read").
- **Fix-now and migration:**
  - `previewMedia`;
  - uniform mapping, shown index and `textAligned` for new picture textBoxes;
  - the legacy text repair job, and the gated text fallback for `firstText`, stage and search;
  - video ImageObjects draw their poster on outputs;
  - MediaTab hides `pptx`/`document` media; reference-aware delete confirmation.
- Hub budgets measured on a reference NAS.
- **As built in wave 2, item A (clips):** clip and poster extraction with the `p:timing` mapping, trims baked,
  motion backgrounds, linked and failed clips as posters with `[warn]` lines (§8 "As built";
  apps/hub/src/pptx/README.md "Wave 2, item A").
- **As built in wave 2, item B (one fallback rule):** `slideContent()` in every drawer (§5 "As built").
- **As built in wave 2, item C (hidden slides):** flagged cues that sequential navigation skips and a click shows (§9 "As built").
- **Wave 2 end to end** (§14.12): a probe deck imported through the route draws on an output at 1080p (WebGPU) and at 4K (Canvas 2D) as the harness's native page draws it (SSIM 1.000 and 0.999 on three slides); the stage, the Lobby and Stream looks (set to show non-song text), cue labels and search show the slide text with its verse numbers; Next and Prev skip the hidden slide and a double-click in the grid shows it. The verse numbers are the text's own digits, raised by runs since M2's second wave: a band whose source is rich text is laid out by the rich engine in the look's style (§6 "Bands, stage and readable text"), so the verse the Lobby and Stream bands are compared with is typed in ordo the same way, its numbers raised.
- **As built in wave 1** (apps/hub/src/pptx/README.md): everything above except rich text emission and clip extraction (with M2 and M5), `slideContent()` in every drawer (wave 2), hidden-cue navigation (wave 2; hidden slides gave no cue until then), and flips, ellipse/roundRect masks and recolouring of pictures (wave 2; drawn unflipped, as rects and without the recolouring, each noted on the slide; flips and those masks are written and drawn since M4 item D). Every read of a stored deck spills only referenced pictures and refuses overlapping zip entries; a LibreOffice run that fails is retried, then the slides it could not draw are marked `Slide.pptx.failed`; a save that brings back pending slides queues the follow-up again.

**Files.**
- `apps/hub/src/pptx/*`, `imports.ts`, `routes.ts`, `pool.ts`, `cpu.worker.ts`, `jobs.ts`, `media/service.ts`, `media/ffmpeg.ts`, `library.ts`, `db.ts`, `fonts/bundled.ts`, `fonts/google.ts`; `Dockerfile`.
- `packages/importers/src/zip-stream.ts`, `remap.ts`, `pptx.ts`.
- `packages/pptx-scene/src/media.ts`, `notes.ts`, `timing.ts`, `classify.ts`, `rendercopy.ts`.
- `packages/domain/src/schemas.ts`, `cues.ts`, `resolve.ts`, `goLive.ts`, `size.ts`.
- `packages/live-state/src/index.ts` (hidden-cue navigation).
- `packages/renderer/src/content.ts`, `text2d.ts`, `plan.ts`.
- `apps/output/src/link-core.ts`.
- `apps/operator/src/services/thumbs.ts`, `lib/preview.ts`, `lib/search.ts`, `views/editor/SlideCanvas.tsx`, `views/editor/PreviewControl.tsx`, `views/live/SlideGrid.tsx`, `views/library/ImportTab.tsx`, `views/library/MediaTab.tsx`, `core/engine.ts` (adopt size check).
- `apps/stage/src/model.ts`.

**Exit.**
- Each of the 5 sermon decks: version 1 is saved ≤ 5 s after job start in the container and ≤ 12 s on the reference NAS, before any soffice process starts. At least 72 of 73 slides are native class; the sp3d slide is native if its bevel is a no-op, else hybrid with only that slide sent to LibreOffice. Text has runs where the deck mixes styles; `lyricObjectId` and notes are set; no picture exceeds its prepared size.
- After goLive, an e2e capture of three imported slides from an output at 1080p and 4K matches the harness rendering at SSIM ≥ 0.99.
- Stage, lower-third and stream looks, cue labels and search show the slide text, with verse numbers.
- A 4:3 deck aligns with LibreOffice within 2 px, and its bars stay empty on native, hybrid and picture slides.
- A deck with a hidden slide keeps notes, pictures and text aligned. Next skips the hidden slide, and a click shows it.
- A deck with a chart over a photo background: only that slide is hybrid. Version 2 adds a transparent art object; 'Replace background on all slides' changes that slide too; an edit made in between survives.
- A legacy picture deck with a hidden slide: after the repair job, stage text and labels match each slide.
- No deck of the 1,068 worship set fails to import. Pool heap ≤ 256 MB over the suite.
- Fuzz through the job: a bad deck gives a clean failure or a picture fallback.
- A synthetic 2,000-slide deck stays within 4 MiB; preview of any slide sends < 1 MiB.
- The rolled-back-schema test passes.

**Parallel.**
- ∥ pool task, `extractZip` skip, caps and batching;
- ∥ picture preparation, `addReadyPicture` and hash index;
- ∥ `pptx-lo` follow-up: render copy, art alpha, page selection, metafiles, soffice hardening, digest patch, lock deferral;
- ∥ `slideContent` in all drawers plus `previewMedia` and `previewSlice`;
- ∥ church mappings in domain and cues, and hidden-cue navigation in the reducer;
- ∥ bundled fonts, Dockerfile, output-config script fallbacks, `unicodeRange` and Google subsets;
- ∥ size budgets and checks;
- ∥ fix-now bugs, legacy text repair and MediaTab;
- ∥ ImportTab and route.

### M4: Editor for churches, wave 1 (about 3-4 weeks; parallel with M5)

**Scope.**
- Ops: `editText` (keeps `fitScale` while it fits), `formatRange`, `setParas`, `findReplace`, `hideSlide`, `replaceBackground`, `applyStyleToSimilar`, `newSlideLike`, `setCrop`/`setMask`/`setFlip`, `replacePicture` (aspect-preserving re-crop), group ops (`moveObjects`, `transformGroup`, `deleteObjects`, `duplicateObjects`, `ungroup`).
- UI:
  - multi-object group selection with the Konva Transformer over the group box; Alt-click for members;
  - format bar, paragraph strip, TextStyleEditor box options and 'Re-fit text';
  - overflow indicator; 4:3 slide-rect guide;
  - crop numeric input then handles;
  - lock badges;
  - SlidePanel PowerPoint card ('Show PowerPoint picture', 'Reset slide', missing fonts);
  - PresentationPanel import report and 'Re-import from PowerPoint' (legacy slide kinds as in §11);
  - make-editable rerouted.
- `applyTheme` keeps structural run formatting.
- Stage notes region and stage direction.
- Optional: three-way merge on 409.
- **As built, the scaffold** (`apps/operator/src/views/editor/M4.md`, which assigns the eight items): the ops
  as typed stubs in `views/editor/ops/` (one module per item), applied through `actions.ts`; the multi-object
  selection in the editor store; `FormatBar`, `ParagraphStrip`, `CropControl` and the canvas guides mounted;
  `PropsRule.notes`; `ApiFailure.details`; the re-import route and job stubs; `e2e/editorhelpers.ts`. The
  converter now writes `ObjectOrigin` (shape id, placeholder, role, group: a flattened group or a shape with
  its text), which M3 had left out and groups, 'Apply to similar' and the re-import need.
- **As built, item A (text ops):** `ops/text.ts` through `actions.ts`, one undo step each: `formatRange`
  (splits the runs at the range ends and normalises them: sorted, non-overlapping, equal neighbours merged,
  empty runs dropped; a change past 2,000 runs is refused), `resizeRange`, `selectionStyle` (fields
  resolved as the engine resolves them), `setParas`, `selectionParas`, `refitText` (the only op that clears
  `fitScale`) and `themedRuns` (structural run fields and `paras` kept; `VISUAL_RUN_FIELDS` and
  `style.fitScale` dropped unless the slide overrides them). The theme override paths for runs are
  `runs.<field>` per visual field and `runs` for all of them, marked by `formatSelection` and
  `resizeSelection` on a themed lyric object (`runOverrides`, `textOnSlide`). The domain `editText` needed
  no fix: it keeps `fitScale`, and the engine fits smaller only when the edited text overflows. Tests:
  `apps/operator/test/textOps.test.ts` (the fit rule through `layoutRich` with a fixed-width measurer),
  `textOps.fuzz.test.ts` (10,000 random sequences of `editText`, `formatRange`, `resizeRange` and
  `setParas`), `e2e/editor-text.spec.ts`.
- **As built, item B (groups and locked objects):** `ops/group.ts` (the group ops, `clickSelection`, the group
  box and the member transform: centres by the group's affine, sizes by its scale along each member's axes,
  rotation turned with the group; a locked member keeps its rotation and locked art its aspect) through
  `actions.ts`, one undo step each; the canvas's Transformer spans every selected node, a drag of any member
  moves the selection (the group box snaps as one), a long press under a finger selects one member; lock
  badges; `GroupPanel.tsx` (the 'From PowerPoint (not editable)' note, the group note with 'Select one',
  'Select the group' and 'Ungroup', the group box editor with 'Turn by'); Delete, Ctrl+D, arrows, z-order
  and Ungroup on the selection. Tests: `apps/operator/test/groupOps.test.ts` (properties and 200-step undo),
  `e2e/editor-group.spec.ts`, `e2e/ipad/group.spec.ts`.
- **As built, item C (format UI):** `FormatBar.tsx` (the 'Text format' toolbar over the text field: font,
  Size − / +, Bold, Italic, Underline, Strikethrough, Superscript, Subscript, Caps, Clear formatting, the
  deck's colours first, a highlight; letter spacing, outline, shadow and language behind 'More'),
  `ParagraphStrip.tsx` (align, list with bullets or numbers and 'Start at', level, indent, spacing, line
  spacing, direction), `TextStyleEditor`'s `box` options (four insets, wrap, 'Shrink text to fit' with
  'Re-fit text', the line model, direction, 'Fallback font'), `CanvasGuides.tsx` with `textFit.ts` (the
  dashed red edge of a box whose text does not fit, laid out as the drawers lay it out, the panel's note,
  and the area of a deck that is not 16:9) and `formatControls.tsx` (the shared toggles, radio groups and
  the text field's refocusing). Each component is a store-bound wrapper and a props-only view. Tests:
  `apps/operator/test/formatUi.test.ts`, `e2e/editor-format.spec.ts`.
- **As built, item D (pictures):** `ImageObject.flipH`, `flipV` and `mask` (a `ShapeGeom`) in the schema,
  `clampObject` (`clampMask`: a preset and 10 adjust pairs) and `drawImageFit` (mirrored about the box's
  centre inside the rotation, then cut by an ellipse or a rounded-rect clip, `pictureCut` reading masks as
  the video plane does; another preset is the box until M6). A masked or flipped picture has no prepared
  target, so the outputs draw it from its source. The converter writes `flipH` (a vertical flip is a
  horizontal one turned half a turn) and ellipse/roundRect masks beside the legacy `radius`, and no longer
  notes them. Goldens `image-shape` (the thumbnails' path), `image-shape-prepared` (the outputs' lookup)
  and `image-shape-editor` (the editor's Konva node transform) compare with one PNG (`SAME_AS`). Ops
  `setCrop`, `setMask`, `setFlip`, `replacePicture` (with `coverCrop`); the Object panel's crop fields,
  'Keep proportions', 'Crop on the slide' (handles that move and scale the picture at its aspect behind the
  fixed box, `cropGeometry.ts`), mask and flips (design/15 "Editor"); `e2e/editor-pictures.spec.ts`.
  _As merged with M6 wave 2:_ the drawers cut pictures with M6's masks (any preset, freeform paths or a
  geometry file, by an anti-aliased 'destination-in' fill of the geometry's union), and masked and flipped
  pictures are prepared like any other (`pictureTarget` keys the mask and flips); `pictureCut`,
  `isShapedPicture` and `clampMask` are gone (`clampGeom`). The editor still offers ellipse and rounded
  masks; a PowerPoint mask of another geometry checks no choice in the radio group and hides 'Corner
  radius', as an ellipse or rounded one does. The video plane still cuts only ellipse and roundRect. The
  converter keeps M4's cut of a mirrored picture past the render bounds and writes M6's masks.
- **As built, item E (slide ops):** `ops/slides.ts` through `actions.ts`, one undo step each: `findText`
  and `findReplace` (case folded unless asked, whole words by Unicode letters, marks and digits, a space
  finding a no-break space; each match replaced with `replaceText`, the rule `editText` applies to a replaced
  selection, so it takes the style of the first character it replaces; locked objects and a result past the
  text bound left alone), `hideSlide`, `replaceBackground` and `replaceBackgroundOf` (a slide's background
  is its bottom unlocked `role: 'bg'` picture, drawn over any `backgroundMediaId`, else its own, else the
  presentation's; scope 'all' rewrites every use of that picture, `role: 'bg'` pictures through
  `replacePicture`; a slide drawing the new picture through `backgroundMediaId` loses the bottom `role:
  'bg'` shapes that would hide it; a video replaces `role: 'bg'` pictures as the `backgroundMediaId`),
  `similarObjects` (the same `origin.ph`, else `role: 'deco'` and its `shapeId`: a slide's own boxes are
  never matched by id, PowerPoint numbers shapes per slide), `applyStyleToSimilar` (the box style without
  `fitScale`, which a target keeps when only colour, fill, alignment and the like change; paragraph styles
  by level, each paragraph keeping `soft`, `hidden` and its own numbering start), `newSlideLike`,
  `useAsBackground` (an unrotated unlocked picture covering the slide area; the `role: 'bg'` objects below
  it removed), `clearSlideBackground`. UI: `FindReplaceDialog.tsx` ('Find…', Ctrl+F), `BackgroundReplace.tsx`
  (the Slide panel's background with its scope, the Presentation panel's 'Replace on all slides…'),
  `ObjectSlideOps.tsx` ('Apply to similar boxes…', 'Use as background'), the slide list's dimmed hidden
  slides, 'New slide like this' and 'Hidden'. Tests: `apps/operator/test/slideOps.test.ts` (find and replace
  property: text, run invariants and every character's style outside the matches; no distortion across
  aspects through item D's `replacePicture`), `e2e/editor-slides.spec.ts`.
- **As built, item F (PowerPoint card and re-import):** `apps/hub/src/pptx/reimport.ts` (`planReimport`,
  `mergeReimport` pure; the light `pptx-reimport` job). The job runs the native job's steps 1-5 without the
  save (`nativeJob.ts` `buildNative`, only the deck slides a one-slide request needs: `NativeJobEnv.only`)
  and merges into the presentation as it is when the conversion ends, saving one revision with its
  `pptx-lo` (earlier follow-ups' art, page and metafile pictures of the same slide and deck elements reused,
  `earlierWork`) and the clips' media jobs. A re-import of some slides budgets them with the slides it keeps
  (`NativeJobEnv.reserve`, `keptBytes`), so they go compact where the merged presentation would pass §3.4's
  budget, and the job logs a warning when it is still over. Rules beyond §11: "unedited" means `digest`
  matches the objects with an `origin`, or (a digest stored before that rule) all the objects (objects
  added in ordo are kept on top and are not an edit); a slide the
  same converter would write again with its LibreOffice work done is left alone, so a re-import that changes
  nothing saves nothing; slide-level settings (timing, transition, hidden, sound, background, the reference
  picture) stay, on a legacy slide only where the operator set them; a legacy page whose deck slide is a
  picture again stays; a made-editable slide is placed by its picture's name ('<title> – N', the picture
  import's page) else by the deck slide whose text its boxes repeat (whitespace folded); a legacy deck
  converted whole gets its one background back as the presentation's; the presentation becomes a native
  import (`source.native` counted over its slides, the fresh `source.log` on a whole re-import). The job
  defers while live and while a `pptx-lo` of the presentation is queued or running. 'Make editable' on a
  legacy page with a stored deck is that job (`imports.ts` `makeEditableNative`, 202). Editors take the
  revision over (`PPTX_JOB_SAVERS`). Operator: `PptxSlideCard.tsx` (edited state, fonts to upload, 'Show the
  PowerPoint picture on the screens' with the digest warning, 'Reset slide from PowerPoint'),
  `PptxReport.tsx` (the import report and the re-import dialog), `pptxJobs.ts` (follow and take over).
  Tests: `apps/hub/test/pptx-reimport.test.ts`, `apps/operator/test/pptxCard.test.ts`,
  `e2e/editor-reimport.spec.ts`.
- **As built, item G (stage):** the notes region (`apps/stage/src/model.ts` `notesRegion`, `defaultNotes`,
  `clearOf`, `cutNotes`, `notesText`; `StageView.notes`; `App.tsx` `NotesRegion`): `style['notes']` or a box
  under the next-slide band, cut clear of the current lyrics, the notes cut to 4,000 characters and to the
  box, never shrunk. Stage direction: the current, next, notes and message text drawn paragraph by
  paragraph with `dir="auto"` and `unicode-bidi: plaintext` (`Paragraphs`, `stageParagraphs`), readable
  text with its automatic numbers. The look editor's 'Stage screen' card (`StageNotesOptions.tsx`): 'Notes',
  the box and the text style, the default shown until edited, an overlap banner. Tests:
  `apps/stage/src/model.test.ts` (a property: the notes never overlap the current lyrics), `App.test.ts`,
  `apps/operator/test/stageNotes.test.ts` (the editor's defaults are the stage's), `e2e/editor-stage.spec.ts`
  (8907). design/16 "Direction" and "Notes region", design/15 "Settings".
- **As built, item H (three-way merge on 409):** `views/editor/merge.ts` `mergeThreeWay` (and `prepareMerge`,
  which remembers what theirs changed for several drafts). JSON content is compared (key order and keys
  holding `undefined` do not count). A value only one side changed takes that side; both changed differently
  is a conflict. Presentation fields per field (`meta` and `source` inside, `meta.tags` as a set); sections
  by id (name, short name, chords); slides by id, whole when one side changed them, else per field (`pptx`
  inside, `overrides` as a set) and object by object, objects whole; a slide or object deleted on one side
  goes unless the other changed it, a slide one side put in a section the other deleted is a conflict;
  orders (sections, each section's slides, each slide's objects, arrangements) follow the side that
  reordered them, both reordering differently is a conflict, additions follow their neighbour (mine after
  theirs at one place); arrangements per field, their sections by diff3 (two sections added at once both
  stay), entries of deleted sections dropped; a lyric box that went is cleared; duplicate ids or a result
  the schema refuses are not merged. `editorStore.ts` `save()`: on 409 `adoptJobSaves` first (unchanged),
  else the 409 body's `current` (`theirsOf`) is merged with the draft, the draft becomes the merge on theirs'
  revision, its undo and redo steps move onto theirs too (`History.rebase`; a step that cannot move ends
  the stack there) and it saves again, up to three merges per save ('Saved together with the changes someone
  else saved meanwhile.'); a draft theirs already holds is not saved again. Conflicts open
  `ConflictDialog.tsx` with what overlaps by slide number ('Slide 2: both changed the text box
  “Potluck on Sunday 12 May”'), Cancel focused, 'Reload theirs (discard mine)' and 'Save mine anyway'
  (which never merges). Tests: `apps/operator/test/merge.test.ts` (rules and properties: a side that changed
  nothing takes the other whole, edits to different slides always merge, the merge is the same whichever
  side is mine), `mergeSave.test.ts` (the save flow against a fake hub, the dialog);
  `e2e/editor-merge.spec.ts` (two editor pages, port 8908).
- **As built, the integration** (`m4/integrate`): the eight items merged in the order A-H, the scaffold's
  stub expectations replaced by the items' own tests (`apps/operator/test/m4-scaffold.test.ts` keeps the
  wiring and the ops' identity when they change nothing), item E's re-crop tests run on item D's
  `replacePicture`, the 200-step undo test covers typing, formats, sizes, paragraph styles and group
  transforms, and the specs follow item B's fieldset sections. `window.__ordo.editor` (the scaffold's
  `inspect.ts`) is added to the diagnostics object rather than spread into a new one, which had frozen
  the `persistence` and `capabilities` getters (the iPad storage spec caught it). The golden case `edited-slide` (a slide as
  the editor leaves an imported church slide: a shape+text pair, a retyped bold red date in a box that keeps
  its stored fit, raised verse numbers, verses numbered from 17, a right-to-left Hebrew line, a turned
  caption, a cropped picture and a cropped, masked and mirrored one) is drawn by the thumbnail worker's
  `drawSlide2D`, by the outputs' `rasterSlide` with prepared pictures (`edited-slide-output`) and by the
  editor canvas's text rasters and node transforms (`edited-slide-editor`), all against one PNG
  (`SAME_AS`). Every exit item below is a Playwright spec ending in `saveAndReload`.
- **As built, the review round:** the editor's shortcuts follow the focus (`editorKeys.ts`: a dialog keeps
  every key, a button or radio its Enter, arrows and Delete, the canvas gets them all), and Ctrl+Z / Ctrl+Y
  in the text field are the editor's undo and redo (`e2e/editor-keys.spec.ts`, port 8909); taking a job's
  revision over moves the undo steps with the draft, a re-import's through the three-way merge; Find and
  replace changes only the part of each match that differs (typing's rule) and marks matches the screens
  do not show; the picture pickers of Replace and the background replace wait for a picture's size (and
  `replacePicture` covers instead of stretching without one); 'Use as background' needs a picture covering
  the whole frame; the slide ops stay within the schema's bounds. In the hub, "unedited" is the digest of
  the objects with an origin everywhere (`digest.ts`), a re-import keeps the chosen lyric box, keeps a
  made-editable slide whose box the volunteer corrected, and budgets the slides it builds with those it
  keeps.

**Files.** `apps/operator/src/views/editor/ops.ts`, `ObjectPanel.tsx`, `SlidePanel.tsx`, `SlidesPanel.tsx`, `PresentationPanel.tsx`, `SlideCanvas.tsx`, `EditorView.tsx`, `editorStore.ts`; `apps/operator/src/components/TextStyleEditor.tsx`, new `FormatBar.tsx`, `ParagraphStrip.tsx`, `CropControl.tsx`; `apps/hub/src/pptx/reimport.ts`, `routes.ts`; `apps/stage/src/model.ts`, `view.ts`; `packages/domain/src/schemas.ts` (`PropsRule.notes`); `packages/client/src/api.ts`.

**Exit.** Playwright e2e covers each of these, and after save and reload the presentation JSON is identical:
- fix a typo inside a bold coloured word, keeping its formatting and its text size;
- change an announcement date by find/replace;
- add a verse with a superscript number;
- number verses starting at 17;
- write an RTL Hebrew line;
- shrink to fit;
- crop a photo;
- replace the background on all slides with a photo of a different aspect, with no distortion;
- move and resize a shape+text pair as one, then edit one member with Alt-click;
- apply a theme to a scripture deck, keeping its verse superscripts;
- hide a slide (dimmed; skipped by Next; shown by click);
- re-import a legacy picture deck and a made-editable deck as editable, keeping slide ids, notes, arrangement and user objects as a new revision, with no doubled content.

Also:
- Editor, thumbnail and output pixels agree within golden tolerance.
- `editText`/`formatRange` property tests pass over 10,000 random edits.
- 200-step undo works across rich edits and group transforms.

**Parallel.**
- ∥ text ops and their property tests;
- ∥ group selection and group ops;
- ∥ format bar and paragraph strip UI;
- ∥ picture crop, mask, flip and replace UI;
- ∥ background, find/replace and hide ops with UI;
- ∥ PowerPoint card, import report and re-import job;
- ∥ stage notes region;
- ∥ three-way merge.

### M5: PowerPoint video and audio playable in place (about 3 weeks; parallel with M4)

**Scope.**
- **Domain and reducer:**
  - `ImageObject.play` (with `showWhenStopped`) and `Slide.audio`;
  - the Cue, MediaContent and AudioContent fields (no trim fields);
  - `expandCues`, with `untilCue` counted over shown slides;
  - the reducer slide branch: video, audio, `untilCue`, click start, `clear('slide')`, and no restart of a slide sound that is still playing;
  - optional play media in `resolvePlaylist` (degraded + poster); `referencedMediaIds`.
- **Renderer and output:**
  - planner `inSlide`; arming on every output with `render:false`; synchronous slot pick and immediate slide job; slot generations in `load` and `vframe`; `vclear` sender; `showWhenStopped`;
  - `SRC_SCENE`; 13 startup pipelines; the "video present" flag and placeholder VideoFrame; Canvas 2D scene;
  - mediaTime frame selection; uploads out of `draw()`.
- **Hub:**
  - clip and poster extraction;
  - `p:timing` mapping (rewind, showWhenStopped, fullScrn);
  - trims baked in the media job (`IngestOpts.trim`);
  - ASF/MPEG-PS/AIFF sniff; video loudness;
  - motion-background promotion;
  - transition sounds off by default.
- **Editor:** video and sound panels; 'Add video to slide'; picker accepts images only; SlideGrid tag.

**Files.**
- `packages/domain/src/schemas.ts`, `live.ts`, `cues.ts`, `resolve.ts`, `goLive.ts`.
- `packages/live-state/src/index.ts`, `invariants.ts`.
- `packages/renderer/src/stacks.ts`, `gpu.ts`, `canvas2d.ts`, `engine.ts`, `compositor.ts`, `messages.ts`, `plan.ts`, `scene.ts`, `clamp.ts`.
- `apps/output/src/link-core.ts`, `asset.worker.ts`, `render.worker.ts`, `media.ts`, `host.ts`, `host-protocol.ts`.
- `apps/hub/src/store.ts`, `media/service.ts`, `media/ffmpeg.ts`.
- `packages/pptx-scene/src/media.ts`, `timing.ts`.
- `apps/operator/src/views/editor/ObjectPanel.tsx`, `SlidePanel.tsx`, `views/live/SlideGrid.tsx`.
- `e2e/`.

**Exit.** A probe deck has a boxed autoplay mp4 under an overlapping title, a click-start video, a looping muted full-slide motion background and a `numSld=3` sound. A second probe is a 4-slide looping announcement deck with play-across music. They:
- import, go live and play the video in its box at the right z-order, with crop, rotation and rounded mask, on WebGPU and on Canvas 2D across 2 outputs (one of them not the audio master), within the design/23 skew bounds;
- F8 starts the click video, Shift+F8 restarts it;
- onEnd 'advance' works from the audio master;
- the sound stops after the third shown slide; the stage shows the remaining time;
- the next slide's clip is preloaded, paused on its first frame, on every output;
- the loop deck's music does not restart when the loop wraps;
- Clear media during an in-slide video, then arm the next slide's clip: the live slide shows its poster, never the next clip.

Also:
- A clip still transcoding goes live with a degraded note and its poster (a motion background still transcoding goes live without it: §8 "p:timing mapping", accepted gap).
- A failed clip leaves a `[warn]` line and the poster.
- A trimmed looping clip loops between its trim points.
- The compositor golden passes; hot-lint is green.
- A 30-minute 4K soak shows zero missed vsync on a reference venue GPU.

**Parallel.**
- ∥ domain, cues and reducer with tests;
- ∥ WebGPU scene pipelines with the compositor golden;
- ∥ Canvas 2D scene;
- ∥ planner, link arming and slot generations, asset-worker scene job;
- ∥ frame selection and upload queue;
- ∥ hub media extraction, trim baking, sniff and loudness;
- ∥ editor media panels.

### M6: Shapes, geometry, pictures and tables, tier T3 (about 3 weeks)

**Scope.**
- `tools/geom-gen` compiles POI 5.2.5 `presetShapeDefinitions.xml` with two fixes verified against LibreOffice: the pie text rect `t=it r=ir`, and star24/star32 ahXY `maxY=50000`. The output is op-code arrays plus `wd12/hd10/cd3/wd32`.
- Guide evaluator with POI semantics: 17 ops, divide by zero gives 0, `at2` in 60000ths, strict numeric tokens. arcTo with POI's visual-angle rule. Path fill modes (darken −40%, darkenLess −20%, lighten +40%, lightenLess +20%).
- ShapeObject `geom`, `gradient`, `dash`, `ends`, flips, shadow, glow, soft edge; picture masks from any geometry; gradient text.
- Full group affine; connectors.
- Tables:
  - cell TextObjects (shrink to fit) over locked grid shapes;
  - row height = max(stored h, text height measured with sfnt metrics);
  - merges;
  - built-in table styles (port of LibreOffice `predefined-table-styles.cxx` as a separate MPL-2.0 file);
  - tables past the slide's object budget stay residual (until fidelity round 2, any table over 60 cells did).
  - _As built (M6 wave 2, `packages/pptx-scene/src/tables.ts`, `tablestyles.ts`, `metrics.ts`; README "M6 wave
    2: tables"):_ cell fills, the table background and the lines are locked `ShapeObject`s of today's fields
    (role `grid`), each cell a rich `TextObject` (role `cell`; an empty cell an empty one), all in the table's
    `origin.group`. Style parts apply in `CT_TableStyle` order, lines by part region; a cell's own lines merge
    property by property and the wider of two neighbours' wins (LibreOffice's rules). The 74 built-in styles
    draw every line 1 pt and bold heads, as PowerPoint defines them (LibreOffice's table leaves most widths
    at 0 and makes only Light Style 1 bold). Diagonal lines are not drawn (noted). A table with vertical cell
    text stays residual (until M8), and so does a table that would take its slide past 150 objects
    (`budget:table`, the slide hybrid). Rows grow to their text measured with the faces' advances
    (`ParseOptions.fontFace`: the hub's library files, `apps/hub/src/pptx/faces.ts`; fontconfig's in the
    harness), estimated widths when a family has none (noted). A cell's lines are spaced by its face's line
    height (`hhea` ascender less descender), not the office model's 1.2: measured with a probe deck,
    LibreOffice 24.2 sets cell lines of Carlito 1.215-1.225 × the size apart (6-20 pt), of Liberation Sans
    1.115, and PowerPoint's new rows of 18 pt Calibri are 29.2 pt (22 pt of line and 7.2 pt of margins).
  - _Measured_ (`--engine native --lo-compat`, the 30 worship decks of the validation suite with the `tables`
    feature, 14 of them `tableMerge`, LibreOffice 24.2 pictures; deck means with LibreOffice's policies / ordo's):
    tables 0.605 / 0.602 (residual tables, the previous converter: 0.535 / 0.533; pptx-preview 0.51),
    tableMerge 0.431 / 0.431 (0.351; pptx-preview 0.36). 29 slides draw their tables natively, 13 are hybrid
    (7 decks of Bible-chart tables of 72-135 cells, and budget), 2 are picture class (their cells' text passes
    64 KB). The harness does not draw a hybrid slide's art; with LibreOffice's pixels pasted into each art
    box (an estimate of version 2) the means are 0.723 and 0.638, short of the exit's 0.75: the native tables
    of these decks are dense charts of 6-9 pt text, where a line wrapped one character apart or rows 1-2 %
    taller than LibreOffice's move every row below and the slide's SSIM falls to 0.15-0.48 though the drawing
    matches LibreOffice's to the eye.
  - _Fidelity round 1 (rows; `pptx-scene` `tables.ts` `LoLines`, `metrics.ts` kerning; README "Fidelity
    round 1"):_ the row measure now breaks as the renderer does, with the faces' pair kerning (`GPOS`
    PairPos of the 'kern' feature, else the legacy `kern` table; equal to Chromium's `measureText` but for
    ligatures), so a word that fits once kerned is never cut, and an empty cell is one line of its end
    mark. `MAX_TABLE_CELLS` (60) counts drawn cells, merges once; `MAX_TABLE_GRID` (4,096) bounds the grid
    read. For the harness's LibreOffice policy only (compat rule `cellRows`), the rows are LibreOffice
    24.2's, measured with a committed probe deck (`tools/pptx-fidelity/src/table-probe.ts`, 324 rows within
    0.16 pt): a row is its text in 1/100 mm, plus 1/100 mm, plus the margins, its lines at the face's ascent
    and descent at the 600 dpi reference device (pixel height rounded, then each rounded), or at 1.2 × the
    font height (font-independent line spacing, any face) once a text shape with its own `a:spAutoFit` and
    text came earlier on the slide, which leaves the shared outliner in that mode; LibreOffice still draws
    the lines at the face's height, so such text runs into the cell margins, each baseline at the face's
    ascent (ordo's office model puts it 0.07 × the size lower for Carlito), and its text at the font's
    whole-pixel size at the reference device (14 pt 0.27 % wider, 9.5 pt 0.17 % narrower: what decides a
    line that fits by a fraction of a point). PowerPoint's rows are not known to follow these, so the hub
    keeps the faces' line heights (PowerPoint's 18 pt row is 22 pt of line).
  - _Measured after round 1_ (the same 28 decks without embedded fonts; LibreOffice's policies / ordo's):
    tables 0.591 → 0.738 / 0.588 → 0.596, tableMerge 0.432 → 0.627 / 0.432 → 0.449. The single-slide charts
    that drifted (depression 0.228 → 0.859, jesus-and-stephen 0.149 → 0.894, what-does-a-seal 0.377 →
    0.839, ten-commandments 0.434 → 0.800) now match LibreOffice's rows within a pixel, and no deck falls
    (colossians would reach 0.490 without the pixel-size rule and gets 0.434 with it: 5 pt cells where
    LibreOffice is 0.35 % narrower than the rule). Worship shard 0: 0.843 → 0.863 (ordo's policies 0.840
    either way), 12 table slides up, none down; the sermon decks do not change (0.955). The charts of
    79 and 90 drawn cells stay residual: drawn natively they reach 0.46 and 0.82 but pass 64 KB of text
    formatting (picture class), so the cap waits until `fitTables` budgets text as well as objects.
  - _Fidelity round 2 (the cell cap; `pptx-scene` README "Fidelity round 2"):_ no fixed count of cells sends
    a table to the art any more: `MAX_TABLE_CELLS` is the slide's object budget (150), past which a table
    could never be native (each drawn cell is an object; it stays residual unmeasured, `budget:table`), and
    below it the object budget (`fitTables`) and the 64 KB of text formatting decide, as for other content.
    The two charts above are drawn natively in the harness (0.138 → 0.817, 0.348 → 0.462) and are picture
    class in the hub, where they were hybrid (their text formatting passes 64 KB); four Peace verses table
    slides and Coptic Plural's become native and editable (0.72-0.79 → 0.81-0.95), and the two Boletim
    tables of 87 and 96 cells stay in the art as `budget:table`. Tables 0.738 → 0.770, tableMerge 0.627 →
    0.686, the suite's table decks 0.934 → 0.937, worship shard 0 0.865 → 0.873 (3 slides up); no slide
    falls, and the sermon decks do not change.
  - _Fidelity round 2 (grid objects; `pptx-scene` `tables.ts` `gridObjects`, README "Fidelity round 2"):_ a
    table's lines are one locked `ShapeObject` per look (width, fill, dash; by direction too when there are
    several, so vertical lines stay over the horizontal ones they cross), each run an open sub-path of its
    `geom.paths` stroked with flat caps; its fills one object per fill of rect sub-paths; the background one
    rect. `TableElement.objects` counts them, so a chart table costs its cells and a few grid objects, not
    one per run (25-84). Paths stay within `ShapeGeom`'s bounds (`cont` chains, another object past 8
    paths). An older build draws a line look as the table's outline and a fill as its runs' bounding box.
    Drawn one run at a time a look's object is the legacy lines pixel for pixel; stroked as one path, edge
    pixels move by at most 12 of 255 (Chromium). _Measured_ (the 30 table decks): tables 0.749 → 0.766,
    tableMerge 0.627 → 0.643; moral-character 0.590 → 0.872, colossians 0.434 → 0.601, 1000-years 0.566 →
    0.631, no slide down; moral-character and 1000-years are now picture class in the hub for their cells'
    64 KB of text formatting (colossians already was). Worship shard 0: 0.865 → 0.871 (deck mean), none
    down; the sermon decks and the suite's tables decks do not change.
- SmartArt from its drawing cache as a locked group.
- Recolour and tile bakes.
- Editor shape fields.

**Files.** `third_party/poi-presets/*`; `tools/geom-gen/*`; `packages/renderer/src/geom/*`, `text2d.ts`, `clamp.ts`; `packages/domain/src/schemas.ts`; `packages/pptx-scene/src/geom.ts`, `tables.ts`, `smartart.ts`, `picture.ts`; `apps/operator/src/views/editor/ObjectPanel.tsx`; `packages/renderer/golden/*`.

**Exit.**
- All 187 presets reach SSIM ≥ 0.95 against LibreOffice, except listed ones, each with its reason.
- T1-T3 worship slides (87.6% by census) are native, and the T3 tier mean is ≥ corrected pptx-preview's.
- The tables and tableMerge feature means are ≥ 0.75 (pptx-preview: 0.51 and 0.36).
- No slide goes above 150 objects without becoming hybrid.
- Fuzz covers guide formulas and paths.

_As built (M6 wave 2, item D: SmartArt and baked pictures; `pptx-scene` `smartart.ts`, `bake.ts`, hub `bakes.ts`):_
- SmartArt with a drawing cache is a locked group (origin role 'diagram', the frame's group; text unlocked,
  never the lyric box), read through the ordinary shape walk, so it gets every preset, fill, line, effect and
  text rule the walk has; a drawing goes native or into the art whole, and over the 150-object budget it is
  the drawing that goes to the art. The render copy keeps the drawing with its frame. Per batch at most
  2,000,000 elements of drawings are read (a shared drawing named from every slide), the rest left residual.
  <!-- m9:base -->
  A drawing whose `dsp:spTree` holds no `dsp:sp` at any depth is no drawing (M9 base). PowerPoint writes
  such empty caches. LibreOffice counts top-level `dsp:sp` only (`DiagramShapeCounter`) and lays a diagram
  without them out itself; ordo also accepts grouped ones, as PowerPoint draws them. ordo used to class those
  frames native and draw nothing. They are residual now: 3 slides of shard 0 go native → hybrid.
  <!-- /m9:base -->
  <!-- m9:conv-seams -->
  An empty cache whose data model holds no text (`a:t` with visible characters) and no picture (`a:blip`) is
  native and blank (M9 wave 1, base review): PowerPoint and LibreOffice draw nothing for it either, so the
  slide is not sent to the art for nothing. No slide of E has one.
  <!-- /m9:conv-seams -->
- Recolour and tile bakes as §4 says; `pptx-bake` decodes nothing itself (ffmpeg does, at the bake's size)
  and is bounded at 8,192 px a side and 16 MP in and out, 60 s, and the import's decode budget. No schema
  field is added: a baked picture is an ordinary media item, so an older build draws it too.
- Measured with the native column against LibreOffice's cached pictures, each slide before and after
  (`--engine native`, the selected worship shard decks that have SmartArt, recolouring or tiles: 329
  slides). Shard 0 (203 slides): mean 0.810 → 0.840, 45 slides up and 2 down by more than 0.002 (by 0.007
  at most: two slides of one layout's grayscale picture with raised contrast at 20 % opacity, where
  LibreOffice's result differs slightly from the baked one).
  Shard 2 (126 slides): 0.870 → 0.875, 11 up, 1 down (−0.010: ribbon presets drawn as their rects until
  the converter's presets are merged; in a trial merge with them the slide scores 0.942). By feature on
  the slide itself: SmartArt 13 slides 0.750 → 0.835 (7 native, the rest hybrid for 3D bevels, drawn
  natively in version 1 until the art replaces them), recolouring 16 slides 0.726 → 0.900, tiles 34
  slides 0.695 → 0.779. On the 45 decks of the validation suite with any of the three (621 slides,
  LibreOffice rendering them fresh): 0.839 → 0.872, 98 slides up and 3 down; SmartArt 32 slides 0.839 →
  0.921 (native: 0 → 23), recolouring 74 slides 0.655 → 0.875, tiles 16 slides 0.665 → 0.800. The one
  large drop (0.868 → 0.787) is a library's test file whose drawing states its own offset of 0:
  LibreOffice then places the drawing at the slide's corner, where PowerPoint, and ordo, keep it in its
  frame. The 73 sermon slides do not change (0.953).

**Parallel.**
- ∥ geom-gen and evaluator (with POI-semantics unit tests);
- ∥ shape drawing (gradients, dashes, ends, effects);
- ∥ group affine and connectors;
- ∥ tables and table styles;
- ∥ SmartArt drawing cache;
- ∥ picture recolour, tile bakes and masks;
- ∥ editor shape fields;
- ∥ preset golden.

_As built (M6 wave 2, shape drawing):_
- **Schema** (`@ordo/domain`): `Gradient` (with `scaled`; radial `at` 0 is the focus, 1 the farthest corner, on an ellipse of the box's aspect; `center` in box fractions from the top-left, the centre when absent, which fillToRect l t r b gives as ((1 + l − r)/2, (1 + t − b)/2)), `ShapeGeom`, `LineDash` (the ten prstDash presets, `lg…` named `long…`), `ArrowEnd` = `{ type, w?, len? }` (OOXML sm/med/lg; `.catch` on each), the ShapeObject fields of §3.1, `ImageObject.flipH`/`flipV`/`mask`, `TextStyle.paint`. Path strings are re-tokenised by `cleanPathData` (`pathdata.ts`, pure, shared by `sanitizePresentation`, the render clamp and the converter): absolute M L Q C Z with plain decimals, parsing stops at the first token that does not fit, ≤ 4,096 points, coordinates ±1e9, ≤ 40,000 characters of whole commands. The drawers build Path2Ds from `parsePathData`, never from the string.
- **Shapes** (`renderer/src/shape.ts`): a shape with any M6 field is drawn through the geometry engine (stored preset or paths, else the legacy rect, roundRect, ellipse or line as a geometry); every other shape keeps `drawShape`'s legacy path, pixel for pixel. Box space is flipped about the box's centre, then rotated about it. A gradient over `fill` (shaded per path brightness, as LibreOffice shades each stop); miter joins limit 8, flat caps; dashes are LibreOffice's `lclConvertPresetDash` lengths × the line width (dot 1:3, dash 4:3, dashDot 4:3:1:3, lgDash 8:3, sysDot 1:1, sysDash 3:1, …). Arrowheads (`geom/ends.ts`) follow oox `lclPushMarkerProperties` and `PolygonStrokeArrowPrimitive2D`: width and length 2/3/5 × max(line, 0.7 mm) (2.5/3.5/5.5 wide and 2.5/3.5/6 long for the open arrow), LibreOffice's marker polygons, the tip on the end point (oval and diamond centred), pointing from the point one consumed length back along the line, the shaft cut back by the consumed length less width/15; on every open sub-path, never on closed ones.
- **Effects** (`renderer/src/effects.ts`): LibreOffice's ShadowPrimitive2D, GlowPrimitive2D and SoftEdgePrimitive2D (`ProcessAndBlurAlphaMask`: a stack blur, σ = r/√6): shadow = the shape's alpha blurred by `blur`, offset; glow = the silhouette grown by radius/2 and blurred by radius/2; soft edge = the alpha times the silhouette shrunk by `softEdge` and blurred by it; stacked shadow, glow, shape. Blurs are Canvas shadows of a copy drawn outside a sprite, made at 1/k resolution (k = σ/2, at most 8) and enlarged into one full-resolution sprite of the shape and its layers, cached by the shape's JSON (no id or origin) and the device transform within 64 MiB (LRU) and copied 1:1. Raster bench (`bench/raster.ts`, a slide with a full-width shadowed panel, a glowing star, a soft-edged block and a dashed arrow over the sermon text): first raster 25 ms at 1920 and 92 ms at 3840 (sprites made), then p50 6.5 ms and 25 ms (copied).
- **Pictures**: the mask and flips are part of `pictureTarget` (its key gains the flips and a digest of the clamped mask; a masked picture with round corners is prepared, the mask replacing the radius), so `preparePicture` bakes them and the asset worker and the harness copy masked pictures 1:1. A mask cuts by an anti-aliased 'destination-in' fill of `geomFillPath2D`, never a clip (a 2D clip on an OffscreenCanvas is not anti-aliased in Chromium 153). `geomFillPath2D` is now the union of the filled paths under the non-zero rule (`GEOM_CLIP_RULE`): each closed sub-path is turned to wind positively at an even nesting depth and negatively at an odd one, so each path keeps its even-odd holes while overlapping paths (smileyFace's eyes over its face) add up instead of cancelling. A rotated masked picture is prepared too, over the turned box's bounds (the mask cuts it anti-aliased where the box turns; an unmasked rotated picture keeps the source path): a test deck's slide of four large turned photos in custGeom masks drew in 297 ms at 3840 from the source through frame-sized sprites, and draws in 26 ms prepared. Without a prepared bitmap (the editor) a masked picture is drawn from its source into a sprite of its device bounds and cut there.
- **Smoke run with the converter** (M6 wave 2 item B merged in a scratch worktree; one conflict, in `purity.test.ts`): on 8 suite decks chosen for custGeom, gradients, gradient text, line ends, picture geometry, glow, soft edge and flips (79 slides), the native mean against LibreOffice rose from 0.816 to 0.849 and T3 from 0.906 to 0.940; one slide fell by 0.03 (a custGeom), the rest by under 0.01. Raster p95 rose from 9.7 to 15.8 ms at 1920 and from 42.6 to 70.5 ms at 3840 before turned masked pictures were prepared (on the two slowest decks afterwards: 11.0 and 49.7 ms; full-frame gradient fills and large custGeom fills are what remains, for M7).
- **Gradient text**: the rich engine's fill pass paints glyphs of runs without their own colour with one gradient over the box (a radial one as a circle to the farthest corner); shadows, outlines, decorations and bullets keep their colours. `paint` is a rich style key.
- **Goldens** (`golden/shape-cases.ts`): shape-presets, shape-gradients, shape-lines, shape-effects, image-mask (from the source) and image-mask-prepared (the asset worker's prepared bitmaps), rich-gradient-text; the legacy cases are byte-identical. `geom/geom.fuzz.test.ts`: random guide lists (every operator, cycles, shadowed built-ins, `__proto__`, huge and non-numeric tokens), paths, stored path strings and garbage geometries, all bounded, about 1.5 s.

_As merged (M6 wave 2, all five items on one branch):_
- **Between the items.** Connectors are not glued to a table (its rows grow when drawn) or to a SmartArt drawing (its elements carry the frame's id): an end glued to either keeps its stored geometry. A picture fill's recolouring is read in the fill's own colour context, so a theme background's duotone in `phClr` (Office 2007's paper texture, a tile duotoned in `bg1`) is baked white, not as its black and white source; two shard decks of such textures average 0.83 and 0.85 with it (0.35 and 0.52 without; 0.64 and 0.52 before M6, when the texture was drawn stretched). Classification sends tables to the art before whole SmartArt drawings.
- **Exit, measured** (`--engine native --lo-compat` against LibreOffice 24.2 pictures, per slide, the worship shards 0 and 2 against M2 wave 2's last round):
  - Presets: 186 of 187 at SSIM ≥ 0.95 (mean 0.9959); funnel 0.928 is listed (LibreOffice reads `2da` as 2). Met.
  - T1-T3: 81.8 % of the 2,713 shown worship slides of shards 0-2 (census); 2,120 of their 2,220 are native (95.5 %). The rest: 43 picture class (most over 150 objects, below), 39 hybrid T3 slides (custom geometry past the bounds, sheared group children), 14 hybrid for `anchorCtr` text, 4 picture class for 64 KB of text or 12 pictures. Not all native.
  - T3 mean 0.842 → 0.908 (493 slides); on the 418 with corrected pptx-preview scores 0.912 against pptx-preview's 0.760. Met. T1 0.940 → 0.947 and T2 0.880 → 0.889: no regression; all 1,822 slides 0.867 → 0.900, 658 up and 9 down (5 by more than 0.02: three picture-class slides of one template, which the hub draws with LibreOffice, one dense table, one flipped Designer freeform LibreOffice does not show). The sermon decks stay 0.955 (pptx-preview 0.927).
  - Tables: the 30 worship decks with tables 0.612, tableMerge (14) 0.432 (pptx-preview 0.51 and 0.36). Not met; see the tables note above. After fidelity round 1 (rows as LibreOffice sizes them): 0.738 and 0.627 on the 28 decks without embedded fonts (before: 0.591, 0.432); both still short of 0.75. The suite's tables-charts-smartart decks (35, LibreOffice rendering them fresh) average 0.932: tables (20 decks) 0.952, tableMerge (5) 0.950, SmartArt (5) 0.913, charts (14) 0.919.
  - Objects: no native slide has more than 150 objects (at most 125). Tables and SmartArt over the budget go to the art; 42 slides of plain shapes over it (150-730 objects, mostly traced decorations) are still picture class, not hybrid, as they were before M6 (45). Not met.
    - _Fidelity round 1:_ met. Shapes of one look are merged and plain shapes and pictures go to the art over the budget (§5 "picture"): of the 44 such slides 10 are native, 33 hybrid, and one is a picture for its 64 KB of text formatting.
  - Fuzz: guide formulas, presets, paths and stored path strings (`geom/geom.fuzz.test.ts`), hostile custom geometry, font files and SmartArt drawings in the converter's tests. Met.

_Round 1 (M6 wave 2, traced decorations and turned group children):_
- **Long custom paths in pieces.** A Google-Slides-traced decoration is one outline holding 40-300 holes, 4,200-8,300 points in 7-digit EMU (100-140 KB of path text); every sub-path nests in the outline, so neither the bounding-box split nor any containment split brings a path under 4,096 points, and its outline alone can pass 40,000 characters. Such a path is now a chain (`ShapeGeom.paths[].cont`): pieces of at most 4,096 points and 40,000 characters, cut where a sub-path starts, or between two commands of a sub-path longer than a piece; the renderer (`stored.ts`) joins a `cont` path to the one before it, so the pieces fill as the one even-odd path they were cut from and stroke together. A geometry keeps at most 8 stored paths; a chain that needs more is over the bounds as before. `traceUnionPath` (masks, effect silhouettes) works out the nesting of up to 2,048 sub-paths, testing a point only against the sub-paths whose bounding boxes hold it, within 4M edges. An M6 build without `cont` fills each piece on its own (holes filled where a piece has no outline); a pre-M6 build draws the legacy rect.
- **Turned children of scaled groups** (`walk.ts` `boxAffine`): a child turned by 45° up to 135°, or 225° up to 315°, scales its width by the group's vertical scale and its height by the horizontal one (LibreOffice's `lcl_doSpecialMSOWidthHeightToggle`). A probe deck of turned rects, stars, arrows and a custGeom in groups scaled 2.5:1 and 1:3, rotated, mirrored and nested scores 0.9987-0.9996 against LibreOffice 24.2 (0.886-0.931 before). Children the composed affine would shear are approx (`shear`), no longer residual.
- **Measured** (`--engine native --lo-compat`, LibreOffice 24.2 pictures, per slide against the merged wave):
  - The three evidence decks (worship templates of shard 0 and 2; 69 slides): 0.871 → 0.940, 41 up and none down; 32 slides hybrid → native, 2 hybrid → picture class for the 150-object budget (their art no longer absorbs the decorations). The template whose layouts carry 4,200- and 6,600-point decorations 0.912 → 0.968 (of its 13 `art:custGeom` slides, 12 native, 1 picture class; two keep a warp); the one whose 8,300-point silhouette is turned in scaled groups 0.758 → 0.923 (18 slides native, one stays hybrid for a warp); the one with a turned border in scaled groups 0.926 → 0.932 (its three sheared slides 0.939 → 0.960, 0.936 → 0.970, 0.668 → 0.750).
  - Shard 0 (918 slides scored both times): 0.899 → 0.904, deck mean 0.842 → 0.845, 36 up and none down; 32 hybrid → native, 1 hybrid → picture. The sermon decks do not move (0.955). The other decks with turned children in scaled groups: 5 slides hybrid → native within ±0.001, and one slide hybrid → picture for the object budget (0.763 → 0.770).
  - Raster p95 at 3840 on the evidence decks 34.8 → 44.0 ms (the decorations are drawn now); converting the silhouette template takes 7 % longer.
- **Not solved: the slide JSON budget.** The converter does not count path text against §3.4's 64 KB (only text formatting), and the hub's `planImportSizes` makes a slide over it a compact LibreOffice picture. A traced decoration is 100-140 KB of path text on its own, and a layout repeats it on every slide that shows it: these slides are native in the converter and compact pictures in the hub (the first template's slides were over 64 KB before this round too; the silhouette template's were 26-65 KB as hybrid slides and are 160-1,000 KB now). Solved in round 2 (geometry files, below).

_As merged after round 1 (the budget split, the table rows, the traced outlines and turned group children, and `anchorCtr` on one branch):_
- **Between the items.** Shapes merged into one object past the budget keep a traced outline's chain: the merged paths carry `cont` on a chain's later pieces, so the renderer joins them into the one path they were cut from, and a piece counts as open only where the chain is open, not where it was cut.
- **Exit, measured** (`--engine native --lo-compat` against LibreOffice 24.2 pictures, per slide; the merged wave's numbers above, then this round's):
  - Presets: 186 of 187 at SSIM ≥ 0.95 (mean 0.9959); funnel 0.928 is listed. Met.
  - T1-T3: 2,187 of the 2,220 T1-T3 slides of shards 0-2 are native (95.5 % → 98.5 %; census, 81.8 % of the 2,713 shown worship slides). The 33 left: 27 T3 slides hybrid with `art:budget:shapes`, and 6 picture class for 64 KB of text formatting or 12 pictures. No slide is hybrid for `anchorCtr` (14 before). Counting the hub's 64 KB slide budget, which these slides' path text can pass (above), 2,117 stay native there (94.6 % → 95.4 %). Not all native.
  - T3 0.908 → 0.918 (493 slides; M2 wave 2's last round 0.842); on the 418 with corrected pptx-preview scores 0.924 against pptx-preview's 0.760. Met. T1 0.947 and T2 0.889 do not move (0.940 and 0.880 in M2 wave 2's round): no regression. All 1,822 slides 0.900 → 0.904 (72 up, 6 down; the 5 down by more than 0.02 are picture-class slides that are now hybrid, or picture class with their shapes in the art, for the object budget, whose art the harness does not draw). The sermon decks stay 0.955 (pptx-preview 0.927).
  - Tables: the 30 worship decks with tables 0.612 → 0.749, tableMerge (14) 0.432 → 0.627 (pptx-preview 0.51 and 0.36); with ordo's own rows (the hub's) 0.609 → 0.617 and 0.432 → 0.449. Not met. The suite's tables-charts-smartart decks: tables (20) 0.952 → 0.956, tableMerge (5) 0.950 → 0.951.
  - Objects: no slide over 150 objects is native or picture class (44 picture-class slides before); the most a native slide has is 149. Two hybrid slides draw 171 and 225 objects in version 1 (their 3D and warped residuals are drawn approx until the art comes). Met.
  - Fuzz: chains are fuzzed too (cut anywhere, drawn as the one path; 8 full pieces bounded). Met.

_Round 2 (M6 wave 2, geometry files: the slide JSON budget):_
- **Mechanism.** A geometry's paths are written in its own space, so the traced decorations of Google-Slides-made worship templates (one outline of 4,200-8,300 points, 100-150 KB of path text in 3-4 chained pieces) were repeated in full on every object of a slide that draws them, at whatever size, and on every slide of the layout: slides of 140 KB to 1 MB, 60-98 % path text (one slide 1,022 KB with 11 distinct path strings). The converter counted only text formatting toward 64 KB, so the census called 70 such T1-T3 slides native while the hub's `planImportSizes`, which measures the whole slide, made them compact LibreOffice pictures. Integer coordinates, deduplication within a slide and simplification still left the worst at 72-78 KB: the path text has to leave the slide.
- **Geometry files** (`ShapeGeom.ref`, `GeomFile`; design/11). The converter (`emit.ts`) writes a geometry whose paths take more than 2,048 characters of its slide (its JSON times the times the slide draws it), then the largest others while the slide as stored passes 60 KB (room for what the hub adds), once as a geometry file (placeholder `pptxgeom:<n>`, `EmitResult.geoms`), and classes a slide still over 64 KB as stored (`storedSlideBytes`, never under the hub's own measure) picture, as the hub would. The hub (`apps/hub/src/pptx/geoms.ts`) names each file by the SHA-256 of its re-tokenised JSON before the budgets, stores the kept slides' files in the content store once (`application/json`; at most 32 MB an import, a slide needing more is compact), and goLive lists them in the manifest (outputs cache them with the pictures) and in `ResolvedPlaylist.geoms` (the live process serves them while the library is down); a slide whose file the library lacks is a `degraded` note. Drawers read the files a slide names (`drawnGeomRefs`) before they draw it, as they decode its pictures: the output's asset worker (a file not cached yet is reported with the missing images and the slide drawn again once it is), the operator's thumbnail worker and editor canvas, the harness's page; the renderer (`geom/stored.ts`) builds a file's paths once per file and box size, and nothing drawn from the fallback is cached under the file's key. An older build strips `ref` and draws the legacy shape, as a pre-M6 build draws every custom geometry; a coarse inline outline beside the ref was not kept, since at 2 px it would still cost the templates' slides 10-30 KB. One outline in two decks or two imports is one file; a presentation's JSON, its library snapshot and its revisions no longer carry the path text.
- **Measured** (census over worship shards 0-2 and the sermon decks; hub terms: `planImportSizes` over `storedSlideBytes`): native T1-T3 slides 2,187 in the converter and 2,113 in the hub's terms before (2,117 counting the slides' raw JSON), 2,186 in both after (98.5 %; the one slide fewer is a text-heavy slide the hub made a picture already). In the hub's terms 73 T3 slides go from compact picture to native, and 10 T3 and 26 fallback slides from compact picture to hybrid. 1,702 geometry files, 2.75 MB, in 25 decks (at most 409 files and 549 KB a deck); none in the sermon decks. The drawing does not change (`--engine native --lo-compat`, LibreOffice 24.2 pictures, slide by slide): shard 0's 924 slides 0.906 before and after, the sermon decks 0.955, the evidence decks of shard 2 (54 slides) 0.926; no slide moved.
- **Not in this round.** The operator PC resolving a goLive itself (design/17) has no file index and lists no geometry files (outputs draw what they cached); previews read them through the hub. A geometry file outlives the presentations that named it until the store's cleanup learns to look for it (the library keeps it, as it keeps pictures). 'Re-import from PowerPoint' (M4, on its own branch) must name and store the files of the slides it builds, as the native job's step 2b and 3b do.

_As merged after round 2 (LibreOffice's table layouter, the cell cap, grid objects and geometry files on one branch):_
- **Between the items** (`pptx-scene` README "Fidelity round 2, as merged"). With the cell cap and grid objects together a table costs its cells, its background and a few grid objects, and no count of cells applies below the 150 objects: Boletim's 87-cell reading plan (146 objects) and Matthew 16v18's tables (0.348 → 0.737; 0.462 with the cap alone) are native now; the 96-cell Boletim table (153) stays in the art. Under loCompat the grid objects sit on LibreOffice's columns like the cells. A table's grid geometry over 2,048 characters goes to a geometry file like any other (5 files in shards 0-2). The cap's test of a table past the budget by its own objects gives every cell its own fill, since one object per fill makes a two-fill checkerboard 92 objects.
- **Exit, measured** (`--engine native --lo-compat` against LibreOffice 24.2 pictures, per slide; round 1's numbers, then this round's):
  - Presets: 186 of 187 at SSIM ≥ 0.95 (mean 0.9959); funnel 0.928 is listed. Met.
  - T1-T3: 2,186 of the 2,220 T1-T3 slides of shards 0-2 are native, in the converter's terms and now in the hub's too (round 1: 2,187 in the converter, 2,113 in the hub's terms; 95.2 % → 98.5 % as the hub imports them). The 34 left: 22 T3 slides hybrid with `art:budget:shapes`, 6 more of them picture class for 64 KB as stored or of text formatting, 3 for 12 pictures, 3 T2 slides for 64 KB. Not all native.
  - T3 0.918 (493 slides), on the 418 with corrected pptx-preview scores 0.924 against pptx-preview's 0.760. Met. T1 0.947 and T2 0.889 do not move (M2 wave 2's round: 0.940, 0.880): no regression. All 1,822 slides 0.904 → 0.906, 12 up and none down (all table slides). The sermon decks do not change (0.955; pptx-preview 0.927).
  - Tables: the 30 worship decks with tables 0.749 → 0.823 (the 28 without embedded fonts 0.738 → 0.818), tableMerge (14) 0.627 → 0.756 (pptx-preview 0.51 and 0.36); 13 slides up, none down. Met. With ordo's own rows (the hub's) 0.617 → 0.623 and 0.449 → 0.453; colossians' third table, native now, is drawn in ordo's rows (0.409 → 0.368 in that policy; the harness's gate against M2 wave 2 notes it as it notes jesus-and-stephen), a slide the hub shows as a picture. The suite's tables-charts-smartart decks: tables (20) 0.956 → 0.960, tableMerge (5) 0.951, one slide 0.739 → 0.963 and one 0.781 → 0.775 (a 133-object table drawn natively, picture class for its text).
  - Objects: both slides over 150 objects in the census go hybrid by the object budget (171 and 225 objects); the 225-object one is then picture class for its 99 KB as stored, as the hub already made it a compact picture. The most a native slide has is 149. Met for objects.
  - Fuzz: guide formulas, presets, paths, chains and stored geometry files (`geom/geom.fuzz.test.ts`, `geom/stored.test.ts`). Met.
- **Not solved: tables and the 64 KB of text formatting.** `fitTables` weighs objects only, so a slide whose tables are all native now can pass 64 KB of text formatting: five charts of the table decks and one suite table that were hybrid (their table in the art) are picture class, which the hub shows as LibreOffice's picture (in the census, in the hub's terms, four slides go hybrid → picture; the rest were compact pictures there already). The harness draws them natively, which is where the table scores above come from. The next step is for `fitTables` to send the largest table to the art when the slide's text would pass 64 KB.

_Repair (M6 wave 2, after its review; `pptx-scene` README "M6 wave 2 repair"):_
- **Drawing cost** (the review's blocker). §12's counts did not bound how long a fill takes: a custGeom of 4,000 points zigzagging across its box stayed within them, was classed native and took 1.5 s to draw at 1920 and 4.6 s at 3840 (a 21,600-point chain 22.7 s), on the outputs' asset worker, the thumbnail worker and the editor's main thread. Renderer `geom/cost.ts` rates each filled path (its edges' length along their longer axis × (1 + the most edges active at once / 64), logical px; measured at most about 30 ns a unit at 4K over zigzags, bands, cross-hatches and converging spikes; side-by-side edges that never cross cost far less than rated); a geometry is at most 1.5M, a slide's geometries, weighted by the passes that draw them, at most 3M, and its stored paths at most 64k points. The converter sends what passes them to the art (`custGeom:complex`); `geombudget.ts` holds every drawer to them (later geometries draw as legacy shapes). No slide of the corpus reaches them (costliest geometry 0.64M, a traced 8,300-point silhouette; costliest slide 1.42M and 61,504 points).
- **Effects at 4K.** The soft edge's mask is reduced like every blur layer (a 1 px soft edge on a full-slide shape made four 8 MP canvases: 256 → 130 ms at 3840); a composite past 8 MiB is cached whole only until it thrashes the cache, then the shape caches its reduced layers and draws itself over them (three large shadowed panels at 3840: 150 ms a raster, the cache thrashing, → 30 ms; one, cached whole, 15 ms); a slide's effects are bounded by their layers' area (10 slide areas; the corpus's most effected slides use 7.7), past which they are left out (the converter notes it). Raster bench: two bounded cases checked at 50 ms (1920) and 120 ms (3840).
- **Hub.** Bakes: at most 500 an import, each charging the picture budget with its decode and output and its pool time against the import's. Geometry files: named in the pool task, at most 32 MB a batch, the import's 32 MB applied as batches arrive (a 20-slide deck of 281 KB of XML made 10.2 MB of files and 405 ms of event-loop hashing before); a slide whose file was dropped or not stored is a compact picture. Faces: metric tables copied out of their file and WOFF2 buffers, the face budget counting what is kept, subsets keeping line metrics and kerning, a kerning pair trying at most 64 subtables.
- **Fidelity.** `useBgFill` keeps a shape's own fill (a Designer panel 0.324 → 0.934); `lineJoin` and `lineCap` (schema, clamp, sanitize, silhouettes; round and square caps within a preset dash, as LibreOffice draws them: probe slide 0.990 → 0.998); fixed gradients on mirrored shapes mirrored by the element's own flips and not turned (probe 0.924 → 0.929); Korean breaks at spaces (17 slides of the Korean deck up, e.g. 0.507 → 0.603); right-to-left table cells; a 4:3 slide's gradient background laid over the slide inside the frame; the harness decodes pictures as stored (EXIF orientation removed: three phone-photo slides 0.37-0.40 → 0.75-0.80). Picture fills keep LibreOffice's placement whatever `rotWithShape` says (no PowerPoint render was at hand; noted in the README). LibreOffice's marker tables are in their own MPL-2.0 file (`geom/markers.ts`).
- **Exit, measured** (`--engine native --lo-compat` against LibreOffice 24.2 pictures, per slide, against round 2):
  - Presets: 186 of 187 at SSIM ≥ 0.95 (funnel 0.928 listed, LibreOffice reads `2da` as 2). Met.
  - T1-T3: 2,186 of the 2,220 T1-T3 slides of shards 0-2 native in the converter's and the hub's terms (98.5 %), as in round 2; the 34 left: 22 T3 hybrid for `art:budget:shapes`, 6 T3 picture class (5 for 64 KB as stored, 1 of text formatting), 3 for 12 pictures, 3 T2 picture class for 64 KB. Not all native.
  - T3 0.918 → 0.920 (493 slides; on the 418 with corrected pptx-preview scores 0.924 against pptx-preview's 0.760). Met. T1 0.947 and T2 0.889 unchanged (M2 wave 2's round: 0.940, 0.880). All 1,822 slides of shards 0 and 2 0.9059 → 0.9066, 8 up and none down. The sermon decks stay 0.955 (pptx-preview 0.927), no slide moved.
  - Tables: the 30 worship decks with tables 0.823 → 0.825, tableMerge (14) 0.756 → 0.759 (pptx-preview 0.51 and 0.36); 18 slides up, none down. Met. The suite's tables-charts-smartart decks: tables (20) 0.960, tableMerge (5) 0.951, unchanged.
  - Objects: both census slides over 150 objects are hybrid by the object budget (171; 225, then picture class for its 99 KB as stored); the most a native slide has is 149. Met.
  - Fuzz: guide formulas, presets, paths, chains, stored geometry files and now the drawing budget (`geom.fuzz.test.ts`: no built geometry over it; an 8-piece crossing chain rated under 1 s). Met.

_Finish (M6 wave 2, after its re-review; `pptx-scene` README "M6 wave 2 finish"):_
- **Outlines in the drawing cost** (the re-review's blocker). The repair's estimate rated fills only and counted an outline as two more passes of the same edges, so a tiny custGeom with a 400 px line (two shapes of 8 × 3,000 points: 3.9 s at 3840) or 12,000 open 1 px sub-paths with arrowheads (2.6 s) was classed native, on every drawer. `geom/cost.ts` now rates a shape as it is drawn (§12 drawing cost): fills, each outline as the polygon Canvas fills for it (offset edges, every join by its kind and miter limit, every open sub-path's caps, every dash, each arrowhead's fill and area; `geom/outline.ts` resolves width, joins, caps, dash and ends once for the drawer and the estimate), the effects' passes over the silhouette, and a charge per stored point (parsing, rating and tracing it). The slide's budget is 1.3M with the points (was 3M, weighted, without them), so a slide at it draws its geometry within design/27 §13's 50 ms at 4K cold. The converter rates each custom geometry, preset, picture mask and outline as it will emit it (`walk.ts` `slideCustom`, `chargeDrawing`, the mask filled and its outline stroked, their points counted twice) and runs the renderer's `slidePlan` on the emitted objects (`emit.ts` `fitDrawing`), so merged runs and table grids are charged too.
- **Minors.** A soft edge weighs 8 slide areas (was 2: past the composite cache its body is cut by its enlarged mask at full resolution on every raster, about 55 ms a slide area at 4K; the corpus's most soft-edged slide weighs 9.2 of the 10), its reduced mask is cached and the layered path no longer copies its body; a scene slide is planned once as a whole before it is split into base and over (`sceneSlides`); a dashed outline is drawn at least 0.5 px wide (`clamp.ts`: a sysDot rect at 0.01 px made 300,000 dashes); a clamped object is not clamped again (a slide's inline paths were clamped two or three times a raster), and path numbers are read without `Number` when they are plain decimals (`parsePathData`, the same values; about half the parse time).
- **Self-check** (three geometries made to defeat the estimate, M6 finish): (1) many tiny open sub-paths with round caps and arrowheads: open arrowheads are strokes of their own, about 10 µs each at 4K (19,200 small ones 207 ms, 46 ns a unit as rated), now `GEOM_COST.markerStroked`; zero-length dots and filled heads were within the bound. (2) A huge-width outline on a dense polyline: eight 2,400-point straight lines 500 px wide have no join and no slanted edge to rate, yet took 15 to 21 ms at 3840 (the stroker's walk of every leg and the 500 px band each covers), now `GEOM_COST.leg` a leg and the covered area; so did eight translucent full-box paths a shape (a few edges each, each path filled on its own: 80 of them 149 ms), now `GEOM_COST.area` for every fill past the widest. (3) Dashed spirals (round-capped dots, 0.5 px dashes, square-capped dashes): within the bound (5 to 21 ns a unit). After the fixes no arrangement measured exceeds about 30 ns a unit at 3840.
- **Measured** (Chromium 153, dedicated worker, willReadFrequently OffscreenCanvas, cold: every job a fresh copy; raster bench `--check` and the calibration slides): the re-review's slides at 3840, p95 (first job): two wide outlines on 8 × 2,000-point clouds (were 3.9 s) 35.6 ms (43.1); 12,000 arrowheaded sub-paths with 20 full-slide sysDot rects at 0.01 px (were 2.6 s and 627 ms) 29.9 ms (35.4); a sysDot spiral kept native within the budget 37.7 ms (39.8); six shapes of eight translucent full-slide paths 33.3 ms (36.6); the repair's zigzags at the budget 43.8 ms (49.5); at 1920 all within 25 ms: all within 50 ms. Calibration (scratch bench, every arrangement drawn without the budget, net of the 10 to 11 ms clear and copy): at most about 30 ns a unit at 3840 (fill zigzags 24, thin dashes 19 to 21, straight wide polylines 15 to 30, stacked paths 19 to 21; wide outlines on clouds 0.5, arrowheads 6 to 17, round and square caps about 1). Three full-slide soft edges (one kept, by its weight) 15.1 ms p95 at 3840 (two kept, at weight 5, 126 ms). Not met by the converter's real slides at the old budgets: one shard0 deck's full-slide traced decorations (27,000 to 61,500 stored points, 0.9M to 1.4M of fill) took 49 to 100 ms cold at 3840 for their geometry alone (its slides at 43 and 46 ms stay native).
- **Fidelity**: the sermon decks (73 slides) and the 30 table decks (215 slides) are unchanged, slide for slide (0.9548 and 0.8752 native, no class or reason changed). shard0 (924 slides) 0.9078 → 0.9075: the four slides of that deck over the budget keep their first decorations native and send the rest to the art (hybrid, `art:custGeom:complex`); the harness draws no art, so they score 0.77 to 0.93 here (were 0.94 to 0.95), where the hub shows LibreOffice's art. Every other shard0 slide is unchanged.

_Finish review (M6 wave 2, after the finish's review; `pptx-scene` README "M6 wave 2 finish review"):_
- **Effect layers sized by what is drawn** (blocker). The effect budget measured each shadow, glow and soft edge by the shape's box, but the drawers make every layer over what the shape draws: a custGeom's points past its box (kept, as PowerPoint and LibreOffice draw them) and an outline's reach (half its width × 8 for a miter join, plus arrowheads). Twenty 10 px custGeoms whose paths cover the slide, with shadows, weighed 0.009 slide areas and took 793 ms at 3840 cold; thirty 10 px rects with a 500 px outline and a shadow 415 ms. `geom/bounds.ts` `drawnBounds` (the geometry's points grown by the outline's sharpest miter within the limit, its caps and arrowheads) is now what `shape.ts` makes the layers over and what `effectArea` sizes them by, placed on the slide and cut to the canvas and the effect's reach as `effects.ts` cuts them, in the converter (`fitEffects`, `fitDrawing`), the renderer's budget and every drawer. A miter grows the bounds by the sharpest join present (a rect's √2 half widths), not 8 half widths.
- **The pixels a fill paints** (blocker). A fill was rated by its edges, and an area charge applied only past a geometry's widest path, so a full-slide translucent gradient (about 11.7 ms at 4K) rated 65 µs and 140 of them (1.3 s at 3840) were native, as were 200 gradients on legacy rects made in the editor (2.25 s). Each filled path is now charged its painted area, cut to the canvas, by paint (`areaWeight`: a colour 0.025 or 0.045 a logical px² opaque or translucent, a gradient 0.14 or 0.2), legacy shapes included; past the budget a gradient is drawn as its first stop. Every object's legacy copy is counted first (`slidePlan`), so what is drawn on top of the legacy copies fits; the converter charges the background first and emits nothing for a text-free shape it sends to the art for the drawing budget (`pastBudget`). Calibrated on the worship corpus: its most painted slide covers 7.1 slide areas (1.8 of gradients), the costliest estimate is 1.06M of 1.3M, and two slides of one deck of full-slide traced decorations go hybrid; nothing else moves.
- **Soft edge cold** (minor). A soft-edged shape alone in its sprite is drawn and cut in place (no full-resolution copy), and layers are enlarged bilinearly (`low`; `medium` differs by 2 levels at most and costs a third more at 4K): one full-slide soft edge 97 ms at 3840 cold (134 before; 118 p95 in the bench), 15 ms warm, a named exception in §13.
- **Measured** (Chromium 153, dedicated worker, 3840 x 2160 unless noted; cold: every job a fresh copy and an empty effect cache). The review's slides as the new converter writes them: the 140 gradients 35 ms (1,346 before), 140 translucent snip1Rects 38 ms (261), thirty wide-outlined rects with shadows 41 ms (436), the twenty out-of-box shadows 362 ms (793), glows 373 ms (811), five soft edges 107 ms (606). As the editor or the old converter wrote them, drawn by the renderer's budget: six translucent gradients 37.5 ms (78), six opaque 38 ms (55), thirty wide-outlined rects 18 ms (415), 200 gradients on legacy rects 256 ms (2.25 s: every one its legacy colour, the floor an older build draws), the twenty out-of-box shadows 376 ms. Raster bench `--check` (p95): six gradients 37.5 ms, the wide-outlined rects 21.8 ms, the earlier bounded geometry slides 33 to 42 ms, all within 50 ms; the out-of-box shadows 300 / 379 ms and one soft edge 41 / 118 ms (1920 / 3840), within the named exception; the 140-gradient stack as legacy colours 258 ms (reported). The 6-line lyric still misses its own budget (11.4 / 52 ms), as before.
- **Fidelity** (against the finish's summaries): the sermon decks (73 slides) unchanged, slide for slide; the 30 table decks (215 slides) 0.8752 unchanged, every slide within 0.0004; shard0 (924) 0.9075 → 0.9076: of the deck of full-slide traced decorations, two more slides go hybrid (0.952 → 0.937 in the harness, which draws no art) and four hybrid ones gain 0.006 to 0.107 now that the shapes sent to the art no longer emit legacy rects over their boxes; every other slide within 0.0005. shard2 (1,014): no class change, nothing down by more than 0.0004 against round 2.

_As merged with M4 and M7 (M6 wave 2 joins the main branch):_
- **Pictures.** M4 item D and M6 both added `ImageObject.flipH`, `flipV` and `mask`. The merged drawers use M6's: any geometry (preset, freeform paths, geometry file) cut by an anti-aliased 'destination-in' fill, masked and flipped pictures prepared like any other (`pictureTarget`), from the source through a sprite of the device bounds. M4's `pictureCut`, `isShapedPicture` and `clampMask` are gone (`clampGeom`); the video plane still cuts only ellipse and roundRect, which agree with the 2D cut. M7's band steps and crop-aware decode carry the mask, the flips and the turn (`paintTarget`, `pictureRegion`). The converter keeps M4's cut of a mirrored picture past the render bounds and writes M6's masks.
- **Converter.** M4's `origin` marks (pairs, roles, placeholders) and M6's emission (shape runs merged into one object, the drawing budget, SmartArt locked groups) share one loop; a table's cells and grid keep their own roles ('cell', 'grid'), SmartArt objects 'diagram'.
- **Hub.** M4's re-import (`buildNative`, `only`, `reserve`) and M6's geometry files, bakes and budgets share one job; `jobLimits` gives both the same limits.
- **Editor.** M6's shape fields sit in M4's Object panel, read-only through M4's lock (a locked object keeps only its box); a picture cut to a PowerPoint geometry M4's mask picker does not offer checks no choice and hides 'Corner radius'. The canvas draws what the slide's drawing budget draws, with M4's lock badges.
- **Outputs.** M7's sprite reach bounds M6's shapes and the lanes read and parse geometry files (§7.3, §7.5 "As merged with M6 wave 2").
- **Checks.** The M4 goldens `image-shape` and `edited-slide` were drawn again: their masked pictures are now cut anti-aliased (0.12 % and 0.08 % of their pixels had moved past the tolerance); the legacy cases are byte-identical. Fidelity (`--engine native --lo-compat`) on the sermon decks (73 slides) and the 30 table decks (215 slides) is identical to m6b/integrate's last run, slide for slide.

### M7: 4K performance pass (about 2 weeks; per-element art dropped for M9)

**Scope.**
- Tight sprites (bounding-box bitmap plus offset; GPU sub-rect copy; Canvas 2D equivalent).
- Interactive and bulk raster lanes.
- Crop-aware decode; opaque-first `copy`.
- Strip uploads with a per-frame budget.
- Health gains `rasterMs` p50/p95, `uploadMs` and font coverage misses, and an alarm when `gpuMB` (reported since M5) passes the budget (as built: `gpuMB` is shown against the budget without an alarm, which could not fire; item C below).
- Measurements on venue GPUs (Windows iGPU, discrete, macOS) at 1080p and 4K, recorded in design/14 (as built: the procedure and `bench:venue` are ready and this container's SwiftShader row is recorded; the venue rows wait for the venue machines).
- Per-element art fragments (dropped: M9 draws the residuals natively instead, so there is no art left to split).
- Refresh the stale design/14 sections and ADR 0004/0005/0013.

**Files.** `packages/renderer/src/stacks.ts`, `gpu.ts`, `canvas2d.ts`, `compositor.ts`, `engine.ts`, `health.ts`, `bitmap-cache.ts`, `sprite.ts`, `picture.ts`, `text2d.ts`, `text/coverage.ts`, `bench/*`; `apps/output/src/asset.worker.ts`, `link-core.ts`, `lanes.ts`, `decode.ts`, `opaque.ts`, `pictures.ts`, `perf-health.ts`; `apps/operator/src/views/live/DiagnosticsPanel.tsx`, `TopBar.tsx`; `docs/design/14-output-renderer.md`; `docs/adr/0004-text-rasterized-at-arm.md`, `0005-video-element-first.md`, `0013-implementation-adjustments.md`.

**Exit.** (Status after wave 1; the figures are in the as-built table below.)
- Slide raster p95 ≤ 10 ms at 1080p and ≤ 12 ms at 4K for text-over-photo slides. _Text over a photo: met at 1080p (p95 6.1 ms); not met at 4K in this container, pending the venue PC's `bench:venue` row and, if that is over too, M8's photo layer (the photo kept out of the slide's bitmap). Other slides at 1080p: the six-line lyric with a shadow is over the §13 10 ms (p95 13.0 ms) until the effect sprite cache (§7.5) is built._
- The props flip is never more than 1 frame late while a slide decodes. _Met._
- Uploads ≤ 4 ms per frame at 4K on the reference GPU. _Met on the render worker's CPU; the GPU time is pending the venue GPUs._
- The health metrics are visible in the operator. _Met._

**Parallel.**
- ∥ tight sprites (GPU and 2D);
- ∥ raster lanes and decode sizing;
- ∥ strip uploads and health metrics;
- ∥ venue GPU measurements;
- ∥ docs refresh.

**As built, wave 1 item C (health and measurement).**
- Health: `rasterMs` p50/p95/max of slide draws (the asset worker's `done.rasterMs`, the synchronous draw), `uploadMs` (the render worker's telemetry: budgeted strip frames of the last minute) and `wholeUploads` (uploads whole by design, apart), `budgets` for the output's size and `alarms` (`raster`, `upload`; the integration's repair dropped `gpuMemory`, which could not fire), and `fontCoverage` (§10). Budgets and alarms are computed by the output (`perfBudgets`, `perfAlarms` in `packages/renderer/src/health.ts`); an alarm that starts or ends is logged with its figures.
- Operator: an amber dot and a "things to check on the screens" tag for a performance alarm, each issue in plain words for volunteers with its figures for techs, fonts as notes for the tech (no amber dot during a service), and a "Performance and fonts" table in Diagnostics (design/14 "Health message").
- Measurement: `bench:slides` (sermon text over a photo, a lyric with a shadow, a table, a scene; p50/p95 per kind at 1080p and 4K; headless in CI, `--check` against the budgets) and `bench:venue` for the venue machines (machine, display, WebGPU adapter, a full-frame upload, five layers composed with timestamp queries, and the slide raster on that CPU), with the procedure and the results table in design/14 "Measuring on venue machines". In this container (software canvas, full-frame draws) text over a photo is 18.3 ms p50 at 4K, over the 12 ms exit; the GPU exits await the venue machines.

**As built, wave 1 integration (items A, B and C together).**
- The asset worker draws each job in the slice its lane gives it (B) as a tight sprite (A): the reach measured on the surface shrunk to 1x1, the draw, the take, the offset and opacity sent; health times that slice's draw (C, `done.rasterMs`). B's lane time is `busyMs` (every slice of the job, picture bands included, counting the slice running when the result is sent), so the two are not confused.
- `bench:venue` is the one venue command: the machine and adapter, the compositor as the render worker drives it (A's strips, sprites, replace path and live run, `gpu-venue.page.ts`) and the slide raster (C's `bench:slides`, now drawn as the worker draws: sprites where they save pixels, the same slides full-frame, and a blank full-frame job), with the budgets checked and a table row for design/14.
- `e2e/outputs.spec.ts` reads the output's performance row in the operator's Diagnostics, as the volunteer and the tech see it.
- Repair of the integration (review): a layout from the legacy memo carries its font (a memo hit drew in the context's default 10 px font on every output with a font resolver); a WebGPU retry whose first draw fails gives the stacks back to Canvas 2D ungated; the strip byte budget is absolute (8 MiB), so 1080p and smaller outputs flip late content on the frame it arrives; the layers of one GO flip together; `uploadMs` is a one-minute window of budgeted frames with the whole uploads apart, and the `gpuMemory` alarm is gone; fonts are notes for the tech, not an amber dot; decodes are bounded across chains and a warm job pauses at its next decode while interactive work runs; the coverage probe runs in slices of its own; text reaches are the laid-out lines plus 0.3 em; the venue compose times what it names (five layer draws a frame), the upload GPU figure is latency beside an empty submit, and the live run draws on a canvas the page shows, with a late flip.
- Second repair (re-review): text reaches hold the measured ink of every line and glyph run besides the lines plus 0.3 em (Vietnamese capitals with stacked tone marks at a line height of 0.7 and no padding lost their marks on the audience screen: a mark that never crosses the sprite's edge ring is never redrawn); a flip already due spends the upload time budget alone, so late content at 1920x1200 and 2560x1440 flips on the frame it arrives, as at 1080p; the venue live run reports late content that never flipped as such (no longer as "0 frames"), and on a shown window counts it, and a run that presented far fewer frames than its seconds at the display's refresh, as over budget.
- Exit, measured in this container (2026-11-07 after the repair, load average 3 to 6; design/14 "Measuring on venue machines" and "Asset worker: raster lanes and picture decoding"):

  | Exit                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                   |
  | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Slide raster p95 ≤ 10 ms at 1080p, ≤ 12 ms at 4K, text over a photo | Met at 1080p (p95 6.1 ms). Not met at 4K: p50 17.2, p95 24.8 ms (19 to 25 ms over the day's runs). The imported slide's photo reaches the whole frame, so it is drawn full-frame, and a blank full-frame 4K job alone costs 9.9 ms p50 here (a fresh 33 MB software bitmap); meeting it needs the photo kept out of the slide's bitmap (not built) or a CPU that pays less, which the venue PC's `bench:venue` row says. |
  | (§13 budgets, other slides)                                         | The six-line lyric with a shadow is over at 1080p (p95 13.0 against 10 ms) and at 4K (45.7 against 30 ms), the scene at 4K (34.6 against 30 ms): canvas shadows on the software canvas; the table is within budget at both sizes.                                                                                                                                                                                        |
  | Props flip never more than 1 frame late while a slide decodes       | Met: 0 of 7 late at 1080p and at 4K (props bitmap at most 8.9 and 20.3 ms after sending, against a 150 ms lead); the worker before M7: 4 and 6 of 7 late.                                                                                                                                                                                                                                                                |
  | Uploads ≤ 4 ms per frame at 4K                                      | CPU side met: a 4K full frame in the default strips costs the render worker at most 2.3 ms per frame (p50 1.9) over four frames, against 8.9 ms p50 (12.6 p95) in one copy. The GPU time needs the venue GPUs (`bench:venue` on them; SwiftShader here).                                                                                                                                                                 |
  | Health metrics visible in the operator                              | Met: Diagnostics "Performance and fonts" shows each output's slide drawing p50 / p95 against its budget, upload, GPU memory, fonts and issues (asserted by `e2e/outputs.spec.ts`).                                                                                                                                                                                                                                       |

### M9: Import without LibreOffice (about 4 weeks; replaces M7's art fragments)

LibreOffice becomes optional at run time. Every element that M3 to M6 leave residual is drawn natively, so a hub without `soffice` imports every deck, and the slides that were art become editable where they can be. LibreOffice stays the reference picture of the fidelity harness, a development tool only.

**Scope.**
- 3D: sp3d bevels and extrusions approximated in 2D (bevel as an inner gradient rim, extrusion as an offset, darkened copy of the outline along the camera direction; the camera presets of `scene3d` as an affine). Text with sp3d draws flat with the same rim.
- Tables as one compact object, `ShapeObject.table` (grid, merges, per-cell fill, borders, and a TextObject body per cell), drawn by the renderer and edited in place (cell text, add or remove a row). No cell cap. Older builds read the legacy rectangles that are still written next to it.
- Locked decorations: runs of non-text, non-picture shapes that a deck uses as ornament collapse into one locked `ShapeObject` with several paths, so a slide over the object budget stays native.
- WordArt warps: the 40 `prstTxWarp` presets (presetTextWarpDefinitions, Apache-2.0) as an envelope warp of the glyph outlines on the asset worker.
- `custGeom` limits raised (paths, points, nesting), with the evaluator's time bound unchanged.
- Shear: a skewed group or shape is drawn through the object's matrix instead of being residual.
- SmartArt without a drawing cache: fallback layouts for the common families (list, process, cycle, hierarchy) from the data model, as a locked group with editable text.
- `anchorCtr`, and vertical text (vert, vert270 by rotation, eaVert by stacked upright CJK; brought forward from M8).
- Metafiles: a native EMF/EMF+/WMF renderer in TypeScript for pictures and OLE fallback images (records to Canvas 2D paths, bounded record count and time).
- Charts: bar, column, line and pie from the chart part's cached values (`c:numCache`, `c:strCache`) as a locked group of native shapes and text; other chart types draw their fallback image.
- LibreOffice optional at run time: the hub detects `soffice`, hides options that need it, and keeps working without it; the Docker image takes a build argument to leave it out.

<!-- m9:lo-detect -->
_Built for M9 (wave 1, track `lo-detect`): LibreOffice optional at run time, without the budget ladder._
- **Detection** (hub `tools.ts`): `ORDO_LIBREOFFICE=auto|off|<path>`, an executable looked up on the PATH
  (no process started), then `soffice --version` through the hardened command in the background; states
  `checking`, `available`, `absent`, `off`, `broken`; a run that finds soffice gone (`ToolError.missing`) marks
  it absent. `GET /capabilities` (`HubCapabilities`) tells the operator. _Wave 1 repair:_ only `absent` and
  `off` mean no LibreOffice. A `broken` one (a probe that timed out on a slow cold start, a version command
  that failed once) is probed again by the jobs that need it (`HubTools.recheck`, at most once a minute): the
  native import still plans the art, the follow-up defers with backoff while it does not answer
  (`LO_PROBE_RETRIES`, about half an hour) and then marks the slides `failed` as after any LibreOffice
  failure, never `missing`; the routes answer 503 with `Retry-After` while it is `checking` after their 5 s
  wait or `broken`, and 501 only when it is absent or off.
- **Policy without LibreOffice** (decision 8): nothing is `pending` and no `pptx-lo` is queued; what the art
  or a metafile conversion would have drawn is listed in `Slide.pptx.missing` (class hybrid, no art object;
  a picture-class slide lists `slide` until the `ladder` track makes it native), the card, the editor and
  goLive name it. A follow-up left from when LibreOffice was there clears `pending`, sets `missing` from its
  plan (`PptxLoSlide.kinds`) and re-imports those slides with this converter. _Wave 1 repair:_ the converter
  plans no art on any slide without LibreOffice (a picture-class one included), says 'not drawn' where its
  notes named LibreOffice (`noteWithoutLibreOffice`), and records nothing for real 3-D past the object budget
  (`budget:3d`, `ResidualRow.drawn`): version 1 draws it flat, as approx 3-D is drawn, so a slide whose art holds
  only that is native without LibreOffice (and a follow-up plan records no kinds for it). A reference PDF is
  released only once no other queued or running reference job names it, and by a job given up after crashes.
- **'Show original' without LibreOffice**: the PDF PowerPoint exports, sent to `pptx-reference` as multipart;
  its pages (the shown slides, or every listed slide) become the reference pictures through pdftoppm.
- **Formats**: .ppsx, .potx and .pptm import natively (macros never read); .ppt, .pps, .odp and .key are
  refused with a save-as hint (converting them would hand an unsanitisable upload to LibreOffice).
<!-- /m9:lo-detect -->

<!-- m9:ladder -->
_Built for M9 (wave 2, track `ladder`): the budget ladder. No budget and no failure makes a picture slide
(plan decision 3); §3.4's "hard 64 KB, else picture class" and "the remaining slides use the compact picture
class" now read "fitted by the ladder" and "stored minimal"._
- **The converter** (`emit-budget.ts`): every rich text object is made lossless-compact before it is counted
  (`compactRuns`: run fields that say what the box style says dropped, never a run merged or removed, since
  the text engine cuts its pieces at run ends; `layoutRich` and the paint plan are identical, tested). The
  text budget is a memory guard now, 128 KB (`TEXT_BUDGET_BYTES`): past it the further text is written plain.
  A slide over 64 KB as stored (`storedSlideBytes`, its large geometries in files) keeps its class and is
  flagged `EmittedSlide.overBudget`. On E the converter's own runs carry nothing redundant (`richtext.ts`
  writes runs as what differs from the box), so `compactRuns` saves 0 bytes there.
- **`fitSlideBudget`** (`@ordo/domain` `size.ts`): `full` → `grid` (inline outlines on an integer grid of
  1/16 logical px of their box, no point moved more than 1/32 px; only past the budget; lo-dependencies'
  quarter pixel moved the anti-aliasing of thin full-width rules by up to 0.009 SSIM on three slides of E,
  over the exit's 0.002) → `plain` (runs and
  paragraph styles of text objects and tables dropped, the largest first, only as many as it takes) →
  `minimal` (shapes left out, the largest first, tables kept, then formatting; text, pictures and the
  background always stay, the background's own shapes too: origin role 'bg', the converter's solid or extended
  background and the hub's white under a picture with alpha, so a slide's text is not left on the output's
  black; `minimalSlide`, the presentation's tail, still leaves those out, about 200 bytes a slide). Pure, never throws; a property test holds it to "within the limit or minimal,
  schema-valid, every text and picture kept". `minimalSlide` is the smallest such form.
- **The hub** (`nativeJob.ts`, `ladder.ts`): a slide's size is measured as stored (`storedBytes`: sanitized,
  parsed, ULID ids and SHA-256 refs; the converter's estimate was about 10 % high on shape-heavy slides, which
  made nine slides of E pictures they were not); the tail past 3 MiB is stored minimal (`planImportSizes` with
  the minimal form as the compact size); an object naming an outline file past the import's budget, or one
  the store refused, is left out (a shape) or loses its mask (a picture); a slide the schema refuses is stored
  minimal, else as its text alone. What a level leaves out is `Slide.pptx.missing` ('decoration', 'chart'),
  with or without LibreOffice (LibreOffice draws no budget's art), and such a slide is hybrid but never
  `pending`. `PptxNativeResult.simplified` counts the slides changed; `compact` is 0.
- **Failures** (`nativeJob.ts` `convert`): a batch that fails is converted again slide by slide (30 s each);
  a slide that still fails, one the converter could not read, and the slides past the 15 minutes of pool time
  get the text rescue (`@ordo/pptx-scene` `rescueDeck`, pool task `pptx-scene` with `rescue: true`: the
  slide's own text bodies and table text as text objects in their boxes, no geometry read, groups to depth 4;
  2 s a slide, 2 minutes an import), class hybrid with `missing: ['slide']`. A slide nothing could read is
  empty and says so.
- **A scene parsed on the client** (`stepsFromClientScene`, see "Rebased onto main" below) follows the same
  rules: a slide past the client's bound on outline files keeps the placeholders of the files it was not
  given (`PptxClientScene.geomOver`), so the hub leaves out the objects naming them, and a slide the client
  could not read, or did not send, gets the text rescue from its parts in the stored deck.
- **Measured** (census over E, `census.ts --hub-budget --no-libreoffice`, against wave 1's): picture slides
  37 → 13, the 13 all `budget:pictures` (decor-conv's sheets); none made by bytes, the tail or a failure. Of
  the 24 budget pictures: 9 store within 64 KB as they are (the estimate), 4 drop text formatting (`plain`,
  native), 11 leave decorations out (`minimal`, hybrid); 5 of those (cells drawn as text objects, about 125
  each) are 65-88 KB even with only their text and pictures, kept whole (the table object of `tables-conv`
  makes them small). No slide reaches the tail; the sermon decks do not change. The grid alone, forced on
  every slide of E whose inline outlines it shortens (416 slides), changes none by more than 0.001 SSIM
  (lowest 0.99918; at a quarter pixel 3 of 479 fell to 0.9915-0.9959).
<!-- /m9:ladder -->

**Exit.**
- ≥ 99% of shown worship slides are native; the rest are hybrid with a reason, and none is a picture slide.
- Every slide that was hybrid or picture before M9 is at least as faithful to LibreOffice (SSIM) as before.
- The whole worship validation set imports with `soffice` absent.

<!-- m9:conv-seams -->
_Built for M9 (wave 1, track `conv-seams`): the converter's seams, so that each later area owns its files._
- **The emitter in parts.** `emit.ts` (the slide, backgrounds, shapes, pictures, origin, lyric box),
  `emit-ctx.ts` (`EmitCtx`, the M9 field gate, box and colour helpers), `emit-text.ts` (text bodies),
  `emit-budget.ts` (`storedSlideBytes`, `fitBytes`, the text budget `chargeText`) and `emit-table.ts`, moved
  verbatim (the strict goldens, the census and the fidelity of E are unchanged by the move). `emit.ts`
  re-exports every name it exported before.
- **Dispatch stubs**, each in the file of the area that fills it, each writing nothing yet:
  `emit-table.ts` `emitTableObject`, `chart.ts` `readChart` and `emitChart`, `decor.ts` `emitDecor` (runs of
  `ElementBase.decor`), `three3d.ts` `read3d` and `look3dOf`, `emit-text.ts` `warpOf` and `writingOf`, and
  `ole.ts` `readOle`; `walk.ts` asks `readChart` and `readOle` before a frame is left residual and `read3d`
  for every shape and picture.
- **Every M9 IR type** (`ir.ts`): `Look3dIR` on shapes, pictures and text bodies; `TextBody.warp` as
  `{ preset, adj }` (was the preset's name), `writing`, `rot`, `upright`; `ChartElement` in `Element` (one
  object in `slideCost`); `PictureFill.metafile`; `ElementBase.culled` and `.decor`; the table extras (`rtl`,
  `storedRows`, a cell's `vert` and diagonals).
- **The field gate.** `EmitOptions.m9Writes` (`M9_FIELDS`: table, chart, decor, decorFile, look3d, warp,
  writing, centerBlock, vectorFonts, adjWide, geomFile64; default every one) is consulted by each stub: without
  a field the converter writes what an older build draws for it (§3.2). The hub passes `M9_WRITES`
  (`apps/hub/src/pptx/shared.ts`, decisions.md 1) from `sceneTask.ts`, and `CONVERTER_VERSION` is 2. A field
  stays out of `M9_WRITES` until what reads it is in (the regroup's rollout rule): 'decorFile' (decoration
  files, `decor-conv`) until `decor-render` names them on the hub and the client.
- **Notes.** `log.ts` `addNote` keeps a slide's stored notes within `Slide.pptx.notes`' 16: 15 and
  'and N more'.
- **Text measured on the hub.** The sfnt reader and cmap are `@ordo/renderer/text/sfnt/{reader,cmap}.ts`
  (decision 12), which `metrics.ts` re-exports (the same functions, so `FaceMetrics` are byte-identical);
  `FaceSource.script(code)` (a script's fallback face, asked once per script), `advanceOf` (a line's advance
  in em through the family and its fallbacks, kerned, 0.55 em per character no face has) and `heightOf`
  (paragraphs' height at a size through `tables.ts` `Measure`) are the measurement seams of tables, warps
  and SmartArt.
<!-- /m9:conv-seams -->

<!-- m9:decor-conv -->
_Built for M9 (wave 2, track `decor-conv`): the slide budgets drawn natively (§5 "Slide class", as built)._
- `pptx-scene` `budget.ts` (`cullElements`, `fitBudgets`, `budgetCost`, `MAX_SLIDE_OBJECTS_TEXT` 190,
  `MAX_DRAWN_OBJECTS` 200), `decor.ts` (`decorable`, `decorRuns`, `emitDecor`, `decorFiles`, `platePlan`),
  `sheet.ts` (`pictureRuns`, `emitComposite`, `atlasParts`, `atlasSlide`), `bake.ts` (`SheetBake`, `SheetCell`,
  `SHEET_LIMITS`, `checkSheet`, `applySheet`); `classify.ts` culls first, then `fitBudgets`, the M6 budget halves
  behind `ParseOptions.budgetArt`; `slideCost` counts a table or a chart as one object.
- The job payload grows (not stored): `EmitResult.decors` (decoration files), `EmitResult.sheets` (each sheet's
  recipe once), `EmittedSlide.sheets` (each sheet's uses and the objects to put back), `EmittedSlide.plate`
  (the plate plan); `EmitOptions.decorId`, `sheetId`, `sheets` (false: no sheets, for an importer that cannot
  make them). The hub's storing of decoration files and sheets is `decor-render`'s (`geoms.ts`, `bakes.ts`
  `storeSheets`); until it lands an import leaves a sheet's objects out ('could not be imported'), and writes
  no decoration file: 'decorFile' (`M9_FIELDS`) is out of the hub's and the client's `M9_WRITES`, so a
  decoration keeps its parts in the slide and no `pptxdecor:<n>` placeholder can be stored (`decor-render`
  puts it back in when it names the files).
- Decisions.md "Slow-to-draw elements": the converter keeps every element and its full vector source, names
  the slide's plate candidates, and leaves "plate or live" to the drawers (`decor-render`).
<!-- /m9:decor-conv -->

**Parallel.**
- ∥ 3D and shear;
- ∥ table object and editor;
- ∥ warps;
- ∥ metafiles;
- ∥ charts and SmartArt layouts;
- ∥ vertical text and anchorCtr;
- ∥ optional LibreOffice in the hub and the image.

<!-- m9:render-seams -->
**Built for M9 wave 1: the renderer seams (render-seams track).** So that each area track owns its files, the
renderer's hot files gained registries, each empty (or today's behaviour) until a track registers into it; the
renderer, compositor, canvas-scene, late-font and preset goldens are byte-identical, and each seam's test pins its
calls by digest against the code before it:
- `shape.ts` `drawShapeObject`: `table` → `chart` → `decor` → geometry → legacy (plan decision 10), the drawers
  registered by kind (`registerShapeDrawer`; until then the legacy shape an older build draws), and a 3-D look
  resolver decorating the geometry path (`registerLook3d` → `EffectSource.look3d`, a type until three-rim).
- `text/paint.ts`: a glyph painter (`PLAIN_PAINTER`; upright and warp registered by kind, warp first) and a face
  target (`DIRECT_TARGET`; a face sprite registered by the 3-D look) chosen independently per object (decision 6);
  planned glyph runs and rectangles carry their layout line and segment for painters that place lines.
- `spritecache.ts`: one 64 MiB LRU with counted pins for every kind of sprite (decision 9); the effect layers
  and composites live in it.
- `picture.ts`: `PictureSource = CanvasImageSource | VectorPicture`, drawn by a registered source step wherever
  `drawImage` would (`ImageLookup` returns either); target extensions widen a target's key (or refuse to prepare
  it) and hand data to post steps, which run after the mask's cut before the bitmap is taken.
- `raster.ts` `jobFontFamilies` waits for the families of tables, charts and vector pictures
  (`extraFontFamilies`).
- `apps/output/src/prepare/index.ts`: the slide prepare steps of the asset worker (in its lane turns) and the
  thumbnail worker (at once), geometry files built in.
- `apps/operator/src/views/editor/objectSections.ts`: the Object panel's sections (design/15).
- `golden/areas.ts` and `bench/cases/index.ts`: one line per area's golden cases and bench slides.
<!-- /m9:render-seams -->

<!-- m9:rebase -->
_Rebased onto main 0.5.0 (d07fe12)._ Main parses a PowerPoint in the operator before the upload
(`@ordo/importers` `importPptxClient`, the `clientScene` part of `POST /import/document`), and the hub then
builds version 1 from that scene without its pool (`nativeJob.ts` `stepsFromClientScene`). That parse is M9's
too: the client's `CONVERTER_VERSION` is 2 and its `CLIENT_M9_WRITES` are the hub's `M9_WRITES` (a hub test
checks both); the operator parses for the LibreOffice the hub has (`hubHasLibreOffice`, the hub's own rule:
only absent or off means none; `PptxClientOptions.libreoffice`, recorded as `PptxClientScene.libreoffice`), and
the hub uses a scene only when it was parsed for what the hub has, else it parses the deck itself. Without
LibreOffice the client's own presentation (the pages demo's) lists `Slide.pptx.missing` and leaves nothing
`pending`, as the hub's import does. The client parse is given no font faces (`ParseOptions.fontFace`: the hub
passes its library's), so the text it measures (table rows, autofit, and M9's warps, vertical text and
SmartArt layouts) is measured with estimated widths: until the operator loads the hub's faces for it, a deck
the operator parsed can lay text out differently from one the hub parsed.
<!-- /m9:rebase -->

<!-- m9:tables-render -->
**Built for M9 wave 2: the table object drawn and edited by ordo (tables-render track).** `ShapeObject.table`
(the schema track's `TableData`) is laid out and drawn by the renderer, its cells edited by pure ops in the
domain; the converter writes it from the tables-conv track on (until then nothing writes one).
- **Model** (`domain/src/table.ts`): placement is implicit (row-major, each cell at the next slot no earlier
  cell covers, a span cut at a covered slot or the grid's edge, cells past the grid dropped: `placeCells`,
  O(grid)); a cell is drawn and edited as a rich text body (`cellRich`: `base` with its style entry over it,
  never shrinking, its runs expanded from the run palette). `setCell` compacts an edited body back into the
  palettes (the style's differences from `base`, each run's formatting), `setCellFill` fills cells, and
  `insertRow`/`deleteRow`/`insertCol`/`deleteCol` work on the grid made explicit: spans across the row or
  column grow or shrink, a new row or column copies its source's height or width, styles, fills and lines, no
  line is kept inside a merged cell, the table keeps its width (columns rescaled) and a row adds or removes its
  height to the box; every op removes palette entries nothing uses (`gcTable`) and refuses past `TABLE_LIMITS`
  or at the last row or column. A property test runs 10,000 random ops. Not built (decision 4): the legacy
  group, its digest (`tableShadows`) and 'Rebuild table from cells'.
- **Clamp** (`renderer/src/clamp/table.ts`, by hand, as the rest of the render clamp, so a slide sent to a
  worker again costs a fraction of a millisecond): palettes keep their indices (a malformed entry becomes an
  empty one), an index naming no entry falls back (the base style, no fill, no line, no run), one
  `FontBudget` for the whole table (16 families, 64 size scales), text ≤ 10,000 a cell and 60,000 a table
  (later cells emptied), runs ≤ 2,000 a cell and 8,000 a table, edges in the grid with `from < to`, rows past
  4,096 grid slots cut; a valid table comes out equal.
- **Layout** (`renderer/src/table/layout.ts`), table-local logical px: columns `cols × box.w / Σcols` (column
  0 on the right when `rtl`); rows at least `rows × box.h / Σrows`, grown to their single-row cells' needs
  (the text's height at the cell's width less its insets, plus its top and bottom insets; an empty cell one
  line of its style's size), then each merge's need beyond its rows added to its last row (LibreOffice's
  `TableLayouter`, PowerPoint's growth); `rowRule: 'fixed'` keeps the stored rows and lets text overflow as
  its anchor says. A cell's text is laid out once at the top of its cell and moved by its anchor (`dy`), as
  `layoutBox` anchors a box. Each cell's layout is kept in a bounded cache by its content (text, runs,
  paragraph styles, digests of its resolved style and of the run palette, width), and each whole table by its
  content and box size: editing one cell lays out that cell, a slide sent to a worker again lays out nothing,
  a master grid's 640 empty cells are one layout. Cells asking for vertical text are laid out horizontally
  until wave 3 (editor-table wires the writing engine).
- **Draw** (`table/draw.ts`, registered with the shape dispatch by importing the renderer): M6's order and
  primitives, so the object draws what the M6 group drew wherever their rows agree (golden `table-vs-group`:
  identical pixels): the background over the grown table, solid fills as one path of rects per fill (row
  neighbours joined, largest first), gradient fills per cell, one stroke per line style (per direction when
  there are several), each segment stretched by half the widest crossing line at its vertices (a per-vertex
  array, linear where M6 compared every pair), none inside a merge, at least 0.5 px, dashed, then diagonals,
  then each cell's text through `paintRich` at the device scale. Turned about the box's centre; drawn at its
  opacity. A table the clamp drops draws the shape's legacy rect.
- **Editor seams** (wave 3 builds the panel): `tableHit`/`tablePoint` (the cell under a slide point),
  `cellText` (a cell's view as a text object), `TableLayout.height` (the drawn height).
- **Preparation** (`apps/output/src/prepare/tables.ts`): the asset and thumbnail workers lay a slide's tables
  out in 8 ms slices of the job's turns before the synchronous draw, which then lays out nothing.
- **Measured** (`scratchpad m9/w2a/tables-render`, a shared 4-CPU machine; the converter writes no table yet,
  so the exit's raster figures come from the raster bench's table cases, each drawn as the object and as its
  M6 group, a fresh copy of the slide every job). Warm raster p50 / p95 ms at 1920 and 3840, object against
  group, last run: 96-cell bulletin 4.6 / 11.9 and 15.5 / 16.5 against 6.6 / 12.5 and 17.8 / 41.7; 640-cell
  master grid 4.1 / 6.3 and 16.2 / 21.2 against 4.2 / 6.8 and 16.7 / 18.7; 13,782-character chart 6.3 / 9.9
  and 18.8 / 28.2 against 9.9 / 21.6 and 22.0 / 32.5 (three runs: the object's p50 is at or below the group's
  in each). Preparation in Chromium, in words never measured before: the chart in one or two 8 ms slices
  (longest 5.7 to 9.9 ms; a cold layout in one call 9 to 41 ms), the bulletin and the master grid in one of 1
  to 11 ms; the prepared chart draws at 3840 in 24 to 32 ms: no task over 50 ms. The fuzz test of hostile
  tables runs in about 1.2 s.
<!-- /m9:tables-render -->

### M8: Long tail and retirement of pptx-preview (about 3 weeks)

**Scope.**
- Embedded fonts: TypeScript MTX/EOT decoder on the pool (`eot2ttf` stop-gap first), scoped Fonts (shipping and resolution honour `scope`), fsType/subset view-only warnings.
- Reflection, inner shadow and soft edge on pictures.
- 'Split reveal into slides' as an import option and an editor action.
- 'Convert to song' and 'Re-flow lyrics'; a bilingual band using `role:'translation'`.
- 4K text over a photo, if the venue PC's `bench:venue` row is over the M7 exit: the imported slide's full-frame photo is sent as its own layer bitmap (shared without a copy, as M5's scene stacks compose), with the rest of the slide as a tight sprite over it; and the effect sprite cache of §7.5 for shadowed lyric text.
- Retirement: once the gate holds, delete pptx-preview (`packages/pptx-render` `chromium.ts`, `page.ts`, `markers.ts`, the pptx-preview-only repairs in `annotate.ts`, the npm dependency, the `pptx-annotate` pool task, the harness column), `extractPptxText` and `pptxForRendering`. Move what remains of `pptx-render` into `pptx-scene`.

**Files.** `apps/hub/src/fonts/eot.ts`, `fonts/service.ts`, `cpu.worker.ts`, `pool.ts`; `packages/domain/src/schemas.ts` (`Font.scope`/`embed`, `TextPara.hidden`), `goLive.ts`; `packages/pptx-scene/src/text.ts`, `timing.ts`; `packages/renderer/src/text/*`; `apps/operator/src/views/editor/ops.ts`, `SlidesPanel.tsx`, `ImportTab.tsx`; `packages/pptx-render/**` (deleted); `packages/importers/src/pptx.ts`; `tools/pptx-fidelity/src/main.ts`; `docs/design/20-importers.md`, `docs/prd/03-editor.md`.

**Exit.**
- Native ≥ corrected pptx-preview on every worship feature row of the fidelity report.
- Native class covers ≥ 95% of shown worship slides; hybrid plus picture ≤ 4.2%, each with reasons.
- Embedded-font decks draw with their faces. A scoped face never appears in another presentation. The MTX decoder handles the 2,647 MTX parts of the corpus with no crash within its time and memory caps.
- The repository no longer depends on pptx-preview, and CI is green.
- Stored presentations with `source.renderer 'pptx-preview'` still validate and render.

**Parallel.**
- ∥ MTX decoder and scoped fonts;
- ∥ picture effects;
- ∥ split reveal, convert to song and the bilingual band;
- ∥ retirement and code moves once the gate passes.

## 16. Retired, kept and ported

**Retired** (M8, after the gate):
- the pptx-preview wrapper: `packages/pptx-render/src/chromium.ts`, `page.ts`, `markers.ts`, the headless-Chromium import step with its `--no-sandbox` launch, and the npm dependency;
- `annotate.ts`'s pptx-preview workarounds: `renameMedia`, `moveGroupOrigins`, run markers, picture re-encoding for the DOM, player removal;
- the `pptx-annotate` pool task;
- the ImportTab renderer select (`ordo.pptxRenderer`), replaced in M3 by 'Editable (recommended) / Pictures (LibreOffice)';
- `extractPptxText`, replaced by pptx-scene, which also supplies picture-class textBoxes and the legacy repair job;
- `pptxForRendering` (main thread, unbounded JSZip, quadratic regex), replaced by `rendercopy.ts` in M3;
- `makeEditable`'s theme-styled boxes over a picture that still contains the text, replaced by the native converter for that slide.

The `PptxRenderer` enum values stay forever, so stored presentations validate. A 'pptx-preview' request maps to native.

**Kept:**
- the LibreOffice tools: the hub's bounded `sofficeToPdf` (`pptx/fallback.ts`, with the executable `tools.ts` found; M9: optional), `pdfToPngs` (gains page ranges and 288 dpi), `fitPage`, `addReadyImage`, used for fallbacks, art, references and metafiles; the unbounded `pptxToPdf` moved to the fidelity harness in M9 (`tools/pptx-fidelity/src/libreoffice.ts`), its only user;
- the whole-deck LibreOffice path, for PDF and the 'Pictures (LibreOffice)' option, always through the worker-built render copy (it fails closed when the copy cannot be built);
- `tools/pptx-fidelity` (`ssim()`, corpus builder, report), extended;
- `extractZip` and its limits, `sanitizePresentation` (extended for runs and paras), `remapMediaIds` (generalised prefix), `mediaFor` (generalised: tags, names, hash index);
- the static-slide output path (`SRC_BITMAP`, the 7 existing pipelines, `LayerStack` flips and exact crossfades);
- `drawText` (plus per-paragraph direction for RTL text), `drawImageFit` and `drawShape` for objects without new fields;
- media ingest and transcode, the audio engine, live transport, LayerBar, the stage's remaining time and the audio-master rules.

**Ported, with defects fixed:**
- `pptx-render/src/xml.ts`, moved into `pptx-scene`;
- from `annotate.ts`: slide order and shown order (`placeSlides`), Strict-to-Transitional, group-transform completion, orphan placeholders, content-type repair, `readTheme`, placeholder lookup, `paraChain`/`inheritedOf` (with the defaultTextStyle fix), spacing, `bulletOf`/`autoNumber`, `bodyStyle`, `resolveFace` (plus cs), `runStyle`, `gradientOf`, background lookup with stretch/tile maths, `withPlaceholderColor`, `custPath` (generalised), `pictureSize` (tile dpi), clrMapOvr semantics, chart-title rules for a future native chart;
- from `page.ts`, into `renderer/src/text/office.ts` and picture drawing: the line model (202-353), the autofit search (355-402), baseline placement (404-426), bullets and indents (428-474), wrap none (538-565), anchor, insets and trailing `a:br` (567-621), gradient text (626-675), picture clips (677-700), background placement (757-828);
- `pptx-render/src/fonts.ts` (fc-match), kept for the harness and as the source of the substitution table.

## 17. Risks

- **LibreOffice is not PowerPoint.** It re-fits autofit, draws no run shadows, hollows coloured outlines, uses γ 2.3 tint/shade, and ignores embedded fonts. The host has 24.2; the Docker image (bookworm) has 7.4. Optimising SSIM against it could move ordo away from PowerPoint. Mitigations: `--lo-compat`, per-policy reporting, probe decks, and PowerPoint PDF exports as a second reference when available.
- **Fonts dominate fidelity.** Century Gothic, Aptos, Calibri Light, Gill Sans, Tahoma and Trebuchet have no metric substitute and will re-wrap. Mitigations: the import card asks for the real font; exact-family match picks it up when uploaded.
- **Text metrics can differ across operating systems** (DirectWrite, CoreText, FreeType). An editor on a Mac and outputs on Windows could break a line differently. Mitigations: every face shipped (script fallbacks included), layout at logical scale, a cross-OS golden; harfbuzzjs is the escape hatch.
- **Rewriting text risks regressions** in songs and authored slides. The legacy path stays byte-identical behind the goldens (RTL paragraphs excepted, which were wrong before), whose skip trap must be fixed first (M2).
- **Schema growth across versions.** After a rollback, the next save loses formatting, media and hidden flags. Mitigations: schema one release ahead of the importer, release notes, the compatibility test.
- **WebGPU on venue GPUs is unverified.** Only SwiftShader was tested here. Driver behaviour of `importExternalTexture` with the scene shader, 13-pipeline compile time, 4K upload cost and +66 MB for `over` on iGPUs are unknowns. Mitigations: Canvas 2D parity, the compositor golden, M7 measurements, and treating fallback adapters as Canvas 2D.
- **Media readiness on Sunday.** Clips transcode on the heavy queue behind other jobs. They show posters with a degraded note; including a clip that became ready later needs another Go live. One video and one sound per slide; extra clips become posters. A slide's autoplay sound replaces playlist music (a click-start one does so when F8 starts it). There is no drift correction for long boxed videos (only the 0.25 s start seek).
- **Reducer change.** A slide cue now starts media and audio, and hidden cues change what Next does. Every client ships the change together (ADR 0006).
- **Hybrid art is not editable.** Its z-range is flattened until M9 draws its residuals natively, but backgrounds, videos and everything outside the range stay native. Picture mode hides edits; it is guarded by the digest, but can confuse.
- **Hub hardware.** A NAS is several times slower than the dev container. LibreOffice at 288 dpi and picture preparation can take minutes on large decks. They run in jobs, off the live process, and never during a write to a live presentation.
- **Size growth.** Rich slides make presentations and library snapshots larger. The §3.4 budgets and health reporting bound it; summary-only library snapshots are the follow-up if venues outgrow them.
- **New attack surface:** XML, guide formulas, path data, colour maths, the render-copy writer, the art alpha task, the MTX decoder, sniffing of attacker-named parts, picture preparation through ffmpeg, soffice. Everything stays on the bounded pool or behind `tools.run`, with fuzz tests before native becomes the default.
- **Editor complexity.** Selection formatting in a plain textarea, run remapping and group transforms are bug-prone, and volunteers may expect on-canvas rich editing. Mitigations: property tests, 'Clear formatting', advanced controls behind 'More'.
- **Licensing.** POI geometry is Apache-2.0. Ports from LibreOffice (table styles, `pptx-scene` `tablestyles.ts`; line end markers, renderer `geom/markers.ts`) or libeot stay MPL-2.0 at file level. Bundled fonts are OFL or Apache. ordo itself has no declared licence yet, so compatibility must be confirmed before shipping data and fonts.
- **Scope creep.** PowerPoint has a long tail (anchorCtr, numCol, spcFirstLastPara, layout-level clrMapOvr). Per-feature harness gates keep the effort on what worship decks use.

## 18. Documents to update in the same changes (design/24)

- design/11 (model: the new fields, `Slide.pptx`, slide media, hidden cues, size budgets);
- design/12 (jobs: `pptx-native`, `pptx-lo`, `pptx-art`, text repair, lock deferral; revision sizes);
- design/14 (scene stack; arming and slot generations; uploads; and the stale "textures per object", "quad list", "vertex-shader scaling", "props small texture" and "mediaTime selection" statements);
- design/15 (editor extensions, group selection, MediaTab);
- design/16 (stage notes, direction, readable text);
- design/18 (loudness measured for video soundtracks; slide-owned sounds);
- design/20 (native import replaces the pptx-preview sections; LibreOffice roles; picture preparation);
- design/21 (soffice sandbox as enforced; part caps; log sanitisation);
- design/23 (compositor and fidelity gates);
- ADR 0004, ADR 0005 (the VideoSource interface that does not exist) and ADR 0013;
- prd/03 (deferred items closed).

## 19. Changes after the completeness review (2026-11-06)

- In-slide video gets its own arming rule. Every output arms the clip, with `render:false` and a synchronous slot pick, and slot generations prevent a reused slot from showing the wrong clip. A "video present" flag replaces the reliance on the placeholder frame's alpha (§7.2).
- Hybrid slides use a locked, transparent art ImageObject limited to the residual z-range, made by a white/black double render. Backgrounds and videos are never baked. Picture pages are stored unpadded (§5).
- Hidden slides become flagged cues that Next skips and a click shows (§9).
- Size budgets for slides, presentations, preview, resolved playlists and library snapshots (§3.4).
- A legacy textBoxes repair job, and a `textAligned` gate on text fallbacks (§11).
- Re-import rules for made-editable slides and pptx-preview page numbering (§11).
- Picture replace re-crops to the box instead of distorting (§11).
- Group selection and group ops for flattened groups and shape+text pairs (§11, M4).
- Picture preparation at import (§4).
- `Font.unicodeRange`; script fallbacks on every output; CJK shipping by text scan (§10).
- RTL in bands, stage and readable text with auto-numbers (§6, §7.4).
- Slide sounds that are still playing are never restarted; transition sounds are off by default (§8).
- Minor fixes:
  - trims are baked;
  - transition precedence is `item ?? slide ?? presentation`;
  - follow-up jobs defer while live-locked and are enqueued before clips;
  - sanitize cuts runs and paras;
  - `fitScale` is kept by edits;
  - `applyTheme` keeps structural runs;
  - part caps, an import time budget and log sanitisation;
  - showWhenStopped, rewind and fullScrn are mapped;
  - MediaTab hygiene;
  - NAS budgets;
  - scoped fonts;
  - 4:3 guides and the extend option;
  - the overflow indicator;
  - the M3 exit is made consistent with M2.
