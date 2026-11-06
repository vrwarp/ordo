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

Status: proposed (2026-11), revised 2026-11-06 after a completeness review (§19 lists what changed). The pptx-preview path of design/20 "PPTX and PDF" is retired once the M8 gates hold. LibreOffice stays (§5).

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

   | PowerPoint element | ordo object |
   |---|---|
   | Text | `TextObject` with sparse runs and paragraph styles |
   | Picture | `ImageObject` with crop, mask and flip |
   | Simple shape | `ShapeObject` |
   | Video | `ImageObject` (the deck's poster) with `play` |
   | Sound | `Slide.audio` |
   | Background | `backgroundMediaId` or a bottom object |
   | Notes, sections, hidden slides, transitions, timings | the existing ordo fields, plus `Slide.hidden` and `Slide.transition` |

   What cannot reasonably be edited becomes a **locked** object (move, resize, delete and z-order only). That is either a native drawing (SmartArt with a drawing cache, table grids) or a transparent LibreOffice art picture. Backgrounds and playing videos are never baked into a picture.
3. **The parser decides a class per slide.**
   - *native*: everything is ordo objects.
   - *hybrid*: one locked, transparent LibreOffice art `ImageObject` covering the z-range of the residual elements, with native objects below and above it.
   - *picture*: a whole-slide LibreOffice picture plus text boxes keyed by shown index. This is the last resort.
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
   - Enums inside *new* fields use `.catch(default)`, so a value added later degrades instead of failing `Slide.safeParse`.
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

| Design | Performance | Fidelity potential | Fit with ordo | Editability | Robustness/security | Delivery risk |
|---|---|---|---|---|---|---|
| raster-hybrid | 7 | 8 | 7 | 9 | 8 | 5 |
| gpu-native | 7 | 7 | 5 | 7 | 7 | 3 |
| **ordo-first-staged (chosen)** | **8** | 7 | **9** | 8 | 8 | **7** |

The chosen design changes the least for static slides, which keep today's one-bitmap path. Per-cue raster cost stays in the asset worker, off the frame path: 3.2 ms at 1080p and 14.4 ms at 4K, measured. Video inside a slide uses the cheapest exact compositing. Coverage is staged and measured against a census of shown worship slides:

| Tier | Shown worship slides covered (cumulative) |
|---|---|
| T1 | 30.9% |
| T1 + T2 | 73.3% |
| T1 to T3 | 87.6% |
| T1 to T4 | 92.5% |
| T1 to T5 | 95.8% |
| Fallback | 4.2% |

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
- Text layout today measures at *device* scale (`text2d.ts:84-101`), so line breaks can differ between 1080p, 4K and the editor. The ascent is a fixed 0.8 × size (`text2d.ts:179`).
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

| Module | Contents |
|---|---|
| `packages/pptx-scene` (new, `@ordo/pptx-scene`) | Pure TypeScript: no DOM, no JSZip, no fs. Input is a `PartSource` (`Map<string, Uint8Array>` from `extractZip`). Runs on the hub CPU pool (task `pptx-scene`) and in Node for the harness. |
| `pptx-scene/src/xml.ts` | Moved from `pptx-render/src/xml.ts` and made dependency-free (its own linear reader instead of fast-xml-parser). Bounded, order-preserving parse (depth 256, 250k tags, linear start-tag scan, indexed child lookup), plus: no DTD at all (`<!DOCTYPE` and every other declaration refused, only the five predefined entities and numeric references decoded, so nothing expands), `attrs` as null-prototype objects. |
| `opc.ts` | Content types (an override naming a missing part is ignored). Relationships resolved inside the package: percent-decode, normalise, case-insensitive (a duplicate that differs only by case keeps the first), matched by type URI, Strict→Transitional (port of `annotate.ts:1478-1539`). External targets are logged with their host only. |
| `deck.ts` | `presentation.xml`: `sldSz` (one default, 12192000x6858000), `sldIdLst` with a prefix-agnostic r:id, duplicates placed once, `show="0"/"false"` hidden flag and shown index (port of `annotate.ts:725-800`), `p14:sectionLst`, `defaultTextStyle`, `embeddedFontLst`. |
| `frame.ts` | EMU → logical px: `s = min(1920/cx, 1080/cy)`, `x0 = (1920 − cx·s)/2`, `y0 = (1080 − cy·s)/2`. The same mapping as `fitPage` (`ffmpeg.ts:332`). 1 pt = `12700·s` px, which is 2.0 px for both standard sizes. |
| `theme.ts`, `color.ts` | Theme fonts (major, minor, ea, cs, per-script `a:font`), clrScheme, master clrMap merged with the slide's clrMapOvr, fmtScheme fill/line/effect/bgFill lists, full prstClr table, colour modifiers (§4). |
| `inherit.ts` | Placeholder matching; xfrm/bodyPr chain; list-style chain (§4). |
| `text.ts`, `walk.ts`, `picture.ts`, `background.ts`, `media.ts`, `timing.ts`, `notes.ts` | Shape-tree walk, text bodies, pictures, backgrounds, embedded media, `p:timing`/transitions, notes. |
| `classify.ts` | Per-element `native / approx / residual`, slide class, art z-range, tier T1-T5 and reasons, size budgets (§3.4). |
| `emit.ts` | IR → ordo objects with `pptxmedia:<n>` placeholder ids (numbered in first-use order, the part of each listed in `EmitResult.media`, so a long part name never makes an id the schema refuses), plus a per-slide digest. |
| `rendercopy.ts` (M3) | The minimal deck for LibreOffice (§5). Replaces the main-thread `pptxForRendering`. |
| `index.ts` | `parseDeck(src, opts): DeckScene`; `emitSlides(scene, opts): EmitResult`. |
| `packages/domain/src/readable.ts`, `bullets.ts` (M2) | `readableText(o)`: `TextObject.text` with automatic numbers and bullets written as text, for the stage, bands, labels and search. `textScripts(text)` for the font scan. `bullets.ts`: `paraLabels(o)` and the number counter (port of `annotate.ts` `autoNumber`) that the renderer's bullets draw too, and the Wingdings/Symbol table (`symbolFontChar`) for the converter. |
| `packages/domain/src/size.ts` (M3) | JSON size estimates for slides, presentations and resolved playlists (§3.4). |
| `packages/renderer/src/text/` (M2) | `itemize.ts`, `breaks.ts` (UAX#14 via npm `linebreak` 1.1.0, MIT; 2.0.0 was days old when chosen; `Intl.Segmenter`), `bidi.ts` (npm `bidi-js` 1.1.0, MIT), `measure.ts`, `lines.ts`, `office.ts` (LibreOffice line model and autofit, ported from `pptx-render/src/page.ts:202-426`), `bullets.ts` (port of `annotate.ts` `autoNumber`), `paint.ts`, `rich.ts`, `fonts.ts` (the resolver, §10). |
| `packages/renderer/src/content.ts` (M3) | `slideContent()`, the one fallback rule (§5). |
| `packages/renderer/src/scene.ts` (M5) | Video split and the plane encoding (§7.2). |
| `packages/renderer/src/geom/` (M6) | `presets.gen.ts` (compiled from POI), `eval.ts` (guide evaluator), `arc.ts`, `path.ts`. |
| `third_party/poi-presets/`, `tools/geom-gen/` (M6) | Vendored POI 5.2.5 `presetShapeDefinitions.xml` (Apache-2.0) with two documented fixes, and the generator. |
| `apps/hub/src/pptx/` (M3) | `nativeJob.ts`; `mediaParts.ts` (generalised `mediaFor`); `pictures.ts` (picture preparation, §4); `fallback.ts` (LibreOffice follow-up); `art.ts` (pool task `pptx-art`: white/black alpha and bounding-box crop); `report.ts`; `textRepair.ts` (legacy textBoxes repair, §11); `reimport.ts` (M4). |
| `apps/hub/src/fonts/bundled.ts` (M3) | Registers the bundled substitutes and script fallbacks. |
| `tools/pptx-fidelity/src/native.ts`, `native-page.ts` (M1) | The native column of the harness. |

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
     pool 'pptx-render-copy' ─► soffice once (each art slide twice: forced white and forced black background;
     picture-class slides once) ─► pdftoppm -r 288 -f k -l k per needed page ─► pool 'pptx-art'
     (alpha = 1 − max(white − black)/255, colour = black/alpha, bounding-box crop) ─► PNG ─► addReadyPicture
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
  role: z.string().max(20).optional(),  // title|body|text|picture|shape|bg|deco|poster|cell|art (string: can grow)
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
  })).max(8).optional(),
});

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
  hidden: z.boolean().optional(),                        // M3: cue flagged hidden; Next/Prev/auto-advance skip it
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

### 3.2 Compatibility rules

- **`TextObject.text` stays canonical.** Runs and paragraph styles annotate it. `firstText`, cue labels, search, stage `slideText`, lyric-only looks, 'Make lyric box' and themes keep working. Readers that show text to people go through `readableText(o)`, which writes automatic numbers and bullets as text, so verse numbers survive on the stage and the stream.
- **The importer always writes the closest legacy values**, so an older build, which strips every new key, still draws something sensible:
  - text in its dominant run's style, with `padding` = the smallest inset;
  - pictures stretched and uncropped;
  - shapes as rect, ellipse or line with a solid fill (the first gradient stop);
  - video as its poster picture;
  - the art as an ordinary image.

  Hub and clients ship together, and the socket version check reloads clients. After a rollback, though, the next save of an imported presentation loses its formatting for good. The release notes say so. The schema ships one release before the importer starts writing the new fields.
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
  - every effective font size (`fontSizePx × sizeScale`, after autofit) is clamped to 4-1,000 px, the same bound as `IMPORT_LIMITS` (the parser's 1-4,000 pt clamp applies only before conversion).
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

| Unit | Budget | Enforced by |
|---|---|---|
| Slide JSON | typical ≤ 8 KB (measured 3.4 KB); hard 64 KB, else picture class | `classify.ts`, logged |
| Presentation JSON | ≤ 4 MiB at import. Once the running total passes 3 MiB, the remaining slides use the compact picture class; the import card says so. The editor warns above 4 MiB but saves (PUT allows 32 MiB). | importer, editor |
| Preview | only the previewed slide's section is sent, with the presentation-level fields (`previewSlice`), so it stays far below 16 MiB | `PreviewControl.tsx` |
| Resolved playlist | `resolvePlaylist` adds a `degraded` warning above 12 MiB ("too large for an operator takeover"). The operator checks the size before `live.adopt` and refuses locally above 15 MiB instead of tripping the cap. | `goLive.ts`, operator engine |
| Library snapshot | its size is reported in hub health; a test keeps a year of weekly 17-slide sermon decks under 6 MB. A summary-only snapshot (bodies fetched on open) is the follow-up if a venue passes 32 MB; it is not part of this design. | health, test |
| Revisions | unchanged policy (50 or 30 days); a 1 MB presentation edited often costs ≤ 50 MB, noted in design/12 | docs |

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
- Sizes: px = pt × 12700 × s, clamped to 1-4,000 pt in the parser and to 4-1,000 px when stored.
- Text outline: `a:ln w` → `outline.width = w/2`, because ordo strokes 2× under the fill. An outline without a solid fill is not drawn. Hollow text (noFill) becomes alpha 0 plus the outline.
- Run text shadows and coloured outlines are drawn as PowerPoint draws them.
- `cap="all"` → `caps` (applied at draw time, so offsets stay valid). Fields keep their stored `a:t` text (logged). Hyperlinks are dropped (logged).
- Body properties: insets (defaults 7.2/3.6 pt) → `insets`; anchor → `valign`; `wrap="none"` → `wrap:false`.
- Autofit: `normAutofit` → `autofit:'shrink'` plus `fitScale` from fontScale/lnSpcReduction. `spAutoFit` keeps the stored (already grown) xfrm; the editor warns when later edits overflow it (§11).
- Text in non-rect presets uses the preset's text rect from the POI table (M6). Before M6, rect/roundRect/ellipse text rects are computed directly; other presets are 'approx'.
- `vert ≠ horz`, `numCol > 1` and `anchorCtr` are residual until M8.

**Shapes with text.** A shape that has a fill or line *and* text becomes a `ShapeObject` plus a `TextObject` sharing `origin.group`. The editor selects, moves and transforms them as one group (§11).

**Pictures** (`p:pic`, and blipFill on shapes) → `ImageObject{fit:'stretch'}`:
- `crop` from srcRect (negative values allowed). fillRect insets fold into the box and the crop.
- `mask` from prstGeom/custGeom; flips; `alphaModFix` → opacity; `a:lum` → `adjust`.
- duotone, clrChange, grayscl and biLevel are baked at import into a derived PNG (a new deduplicated Media, still replaceable).
- `a14:imgProps/a14:imgLayer`: the blip is PowerPoint's already-corrected result (verified on 20 slides of real sermon decks), so it is drawn as is. `.wdp` layers are ignored.
- `svgBlip` uses its PNG fallback; raw SVG is never used.
- EMF/WMF are converted to PNG by LibreOffice in the follow-up job (the slide is `pending`).
- **Picture preparation** (`apps/hub/src/pptx/pictures.ts`), so no consumer decodes more than it shows:
  - The bytes are sniffed and the header is checked (PNG/JPEG/GIF/WebP; ≤ 8,192 px a side, ≤ 40 MP after preparation).
  - The display need is the widest use of the part in the deck: the box width at 3840 px ÷ the visible crop fraction, capped at 8,192 px.
  - A source more than 1.25× its need is downscaled by ffmpeg: JPEG q90 when opaque, PNG or lossless WebP with alpha. This is the same rule the hub already applies to uploaded images over 3840 px, which a ready-picture path would otherwise bypass.
  - TIFF and BMP become PNG. Animated GIF, APNG and animated WebP become a first-frame PNG (logged).
  - The original stays in the stored deck, so a re-import can use it.
  - Pictures are stored with alpha through `addReadyPicture` (ready, no job), deduplicated by SHA-256 of the prepared bytes plus the source part's hash.

**Simple shapes.** rect, roundRect, ellipse, line and straight connectors with a solid fill/line → `ShapeObject` with legacy fields only. Everything else is M6 (`geom`, `gradient`, `dash`, `ends`, effects).

**Groups** are flattened into absolute boxes with `origin.group`, using a composed full affine:
- child box → scaled chExt→ext and translated, then the group's rotation and flips about its centre;
- a missing off/chOff means the origin; ext and chExt substitute for each other;
- depth ≤ 32;
- a sheared child is residual.

**Master and layout decorations** are drawn under the slide's own shapes unless `showMasterSp="0"` (on the slide or the layout). They become objects with `role:'deco'`: unlocked, deletable per slide, and covered in bulk by 'Apply to similar'.

**Backgrounds.** Looked up on the slide, else the layout, else the master. `bgRef ≥ 1001` means `bgFillStyleLst[idx−1001]` with phClr.
- A picture background (stretched, aspect within 1% of the slide, no crop, tile, recolour or alpha) on a 16:9 deck → `Slide.backgroundMediaId`. The aspect must be known: a spilled picture's size is read from the first bytes of its file (`ParseOptions.pictureSize`), and a picture of unknown size stays a bottom image stretched over the slide on white. It is promoted to `Presentation.backgroundMediaId` when every slide shares it (the pro7 pattern, `pro7.ts:838-857`), so the existing pickers swap it.
- Any other picture background → a bottom `ImageObject{role:'bg'}`. The background layer is cover-fit while PowerPoint pillarboxes 4:3.
- Solid or gradient → a bottom rect `ShapeObject{role:'bg'}` over the slide area. With the import option 'Extend plain backgrounds to 16:9' (on by default), it covers the whole 1920x1080 frame instead.
- Tiled → pre-tiled into a picture at slide size.
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
- `lyricObjectId` = the body placeholder with the most characters; else the largest text by characters × area, excluding title, footer, date and slide number. The title is used only when it is the only text. On bilingual slides with one box per language, the first box in reading order is the lyric box. The other box gets `role:'translation'`, for a later bilingual band.
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
  - OLE;
  - maths;
  - ink;
  - sp3d with a non-zero bevel or extrusion (a no-op scene3d/sp3d is ignored);
  - a real `prstTxWarp` (not textNoShape);
  - vertical text (until M8);
  - tables (until M6);
  - a metafile that fails conversion.
- **Approx** (drawn natively, logged): reflection, inner shadow, soft edge on pictures before M8, kerning differences, unknown transitions.
- Everything else is native.

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

The budgets keep slides inside the render clamps (200 objects, 16 images, 192 MiB, `clamp.ts:22-38`), so nothing is silently dropped.

**One rule for every drawer.** `slideContent(slide): { pictureMediaId?: string; objects: SlideObject[] }` in `packages/renderer/src/content.ts`:
- `pptx.show === 'picture'` and `pptx.refMediaId`: the reference picture plus only the objects without `origin` (the operator's own additions);
- otherwise: `imported?.imageMediaId` plus all objects.

It is used by `drawSlide2D`, `slideVisible` (`plan.ts:138-144`), both `slideImages` copies, `SlideCanvas`, `previewMedia` and `referencedMediaIds`, where `refMediaId` is optional like holding slides and the logo. It replaces the unused `skipImported` hook (`text2d.ts:298, 322`). The picture is decoded only when shown, which matters for the 16-image and 192 MiB budgets.

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
  4. runs pool task `pptx-art`: for each art slide, from its white and black pages, alpha = 1 − max(white − black)/255 and colour = black/alpha, cropped to the art's bounding box. Picture-class pages are contain-fitted at the slide's aspect, 3840 px wide at 16:9;
  5. `addReadyPicture`;
  6. converts metafiles to PNG;
  7. patches only the slides whose objects still match `pptx.digest`: the art object replaces the art-range objects. A slide someone edited meanwhile gets the art as an extra locked object at the end, plus a note, and keeps the operator's objects.

**Render copy** (built in the worker, linear tag scans, part budgets):
- only the needed slides in `sldIdLst`; every art slide appears twice, once with its background forced to white and once to black (slide, layout and master backgrounds overridden, master shapes hidden);
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
export interface Measurer { width(font: string, dir: 'ltr' | 'rtl', lang: string, spacingPx: number, text: string): number }
export type Seg = { start: number; end: number; x: number; w: number; run: number; level: number; font: string; sizePx: number; shift: number };
export type LaidLine = { para: number; top: number; baseline: number; height: number; x: number; w: number; segs: Seg[];
  extraPerSpace: number; bullet?: { text: string; x: number; font: string; sizePx: number; color: Rgba } };
export type RichLayout = { lines: LaidLine[]; fontScale: number; spacingScale: number; overflow: boolean; ink: Box };
export interface FontEnv { font(req: FaceRequest): string; readonly generation: number }  // §10; a new generation re-lays out
// FaceRequest = { family, fallbacks, weight, italic, smallCaps, sizePx, script }; packages/renderer/src/text/README.md
export function layoutRich(m: Measurer, o: TextObject, env: FontEnv): RichLayout;       // logical px, pure, memoised
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
   - UAX#14 opportunities over the logical text. U+00A0, U+202F and U+2060 (also U+2007, U+2011 and U+FEFF) never break on either side, even after a space, which fixes the verified 'Dieu !' split.
   - SA scripts (Thai, Lao, Khmer, Myanmar) break at `Intl.Segmenter` word boundaries; CJK follows the ID/CL/NS classes.
   - Emergency breaks fall only between clusters: `Intl.Segmenter` graphemes joined across a conjunct-forming virama, so Tamil 'க்ஷி' stays whole. Graphemes alone do not keep it whole: UAX#29 GB9c joins conjuncts in six Indic scripts only, not Tamil, Kannada or Sinhala.
   - An emergency break costs what its line holds, never what is left of the word: the cut is found by galloping from the piece's start (1, 2, 4, ... clusters, then a bisection), cluster boundaries are found only that far (one list per piece serves every line and autofit step), and the rest of the word is carried unmeasured until it may fit. A 10,000-letter word in a narrow box is laid out in linear time (`rich.fuzz.test.ts`).
4. **Segments.** A segment is a maximal substring with one style run, one bidi level and no break opportunity inside. It is also cut between two scripts that need different fallback faces (Han and kana count as one), so each segment asks for one.
   - A style boundary *inside* a word of a joining script (Arabic, Syriac, N'Ko, Mongolian, Adlam) is drawn with U+200D on both sides of the cut when the letters on both sides join (by their ArabicShaping joining types: none after alef, dal or waw), which keeps medial and final forms. Widths are measured the same way.
   - Inside a cluster (an Indic syllable cluster, a letter with its marks, an emoji sequence), the cut moves to the cluster end (counted in `PreparedPara.movedCuts`).
5. **Measure.** `measureText` with `ctx.font` set to the resolved internal-name stack (§10), and `ctx.direction`, `ctx.lang` and `ctx.letterSpacing` set per segment. The trailing spacing Canvas adds after the last character is subtracted. Widths go into an LRU cache (20,000 entries, key `font|dir|lang|spacing|text`) for strings of at most 256 UTF-16 units, so a hostile word never leaves megabytes of keys in a worker. `measureText` and `fillText` always see the same string in the same state.
6. **Lines.** Greedy fill.
   - Available width = box − insets − marL − first-line indent; a hanging bullet sits in the negative indent and its box is at least −indent wide.
   - Trailing spaces hang.
   - `wrap:false` never wraps; a line grows from its alignment (centre both ways, right leftwards, left rightwards).
   - A right-to-left paragraph mirrors its start: indents and the bullet are on the right and its trailing space hangs on the left. `align` stays visual.
   - Then UAX#9 L2 visual reordering between segments. The browser orders glyphs within a segment.
7. **Line model `'office'`** (LibreOffice, measured in the pptx-render commits; `page.ts:202-353`).
   - F = the size of the paragraph's main run: its first run without a baseline shift, else its first run, else the end mark, after autofit. A larger unshifted run raises F for its own line (LibreOffice sizes each line by its portions), so lines never overlap.
   - Single spacing: pitch 1.2F, first baseline F below the line top.
   - Proportional p ≠ 1: h = 1.2F·p·k, where k is the autofit spacing scale. The baseline is F + (h − 1.2F) when p > 1, else min(F, 0.8h).
   - Exact spacing P: h = P·k.
   - spcBef/spcAft are scaled by k and not drawn before the first paragraph or after the last.
   - An empty paragraph takes its end-mark size; a trailing `a:br` adds a line.
   - Superscript and subscript are drawn at 0.58 × size (at least 4 px), shifted by baseline × size, without growing the line.
8. **Align.**
   - justify spreads extra space over the inter-segment spaces of non-last lines; distribute also justifies the last line;
   - there is no kashida (a known gap for Arabic);
   - RTL paragraphs start at the right.
9. **Anchor and insets.**
10. **Autofit `'shrink'`.**
    - Use `fitScale` while the text fits at that scale.
    - Otherwise run LibreOffice's search (`page.ts:355-402`): 10 bisection steps on the font %, quantised `floor(18·mid/100·10)/10/18·100`, spacing tries 100/90/80%, 0.5 mm slack, run size `max(1, round(round(pt)·font%))`. Because the text overflows at the stored scale, the result can only be smaller, so an edit never makes text jump larger.
    - During the search, widths scale linearly from one measure at the base size. Only the final size is re-measured.
    - Points are 2 logical px (both standard deck sizes). The `'ordo'` model scales run sizes exactly and has no spacing scale.
    - Text edits keep `fitScale`; only 'Re-fit text' clears it (§11).
11. **Bullets.**
    - Character bullets use their own font and size. Wingdings/Symbol PUA codes are mapped to Unicode at import (0x6C→●, 0x6E→■, 0xA7→▪, 0xD8→➢, 0xFC→✓, 0x71→❑, 0x76→❖, Symbol 0xB7→•; U+F0xx offset stripped).
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

**Not supported:** vertical text (residual until M8 emulates it), kashida, OpenType feature settings per call. harfbuzzjs (MIT) stays the escape hatch if browser-measured fitting proves non-deterministic across operating systems.

## 7. Drawing: Canvas 2D and WebGPU

### 7.1 Static slides

- **Unchanged path.** The asset worker draws `slideContent(slide)` with the shared drawers onto its CPU-backed (`willReadFrequently`) OffscreenCanvas at `scale = width/1920`, and transfers one full-frame `SRC_BITMAP`. The compositors do not change.
- **Rasterized at device resolution:** text, vectors, gradients, effects and pictures (crop via the 9-argument `drawImage`, mask via a clip path, flip via the transform, `adjust` via `ctx.filter`).
- **Decode target.** A picture is decoded at min(native size, displayed device size ÷ visible crop fraction, 16 MP). The decode cache is keyed by hash and target size. Today a picture is decoded just large enough to cover the output (`bitmap-cache.ts:18-28`), which blurs a tightly cropped photo at 4K. Import-time preparation (§4) already bounds the source.
- **Art and page pictures** are made at 3840 px density instead of 1920x1080, so they are no longer upscaled on 4K outputs.
- **Clear.** A first draw that is opaque and covers the frame uses `globalCompositeOperation = 'copy'`, which skips the clear (11.4 ms at 4K, measured).

### 7.2 Scene stack: video inside the slide (M5)

A slide whose playing `ImageObject` (`play`) is on the media layer becomes a **scene stack** on the slide layer. Static slides never pay for it.

- **base** (full-frame bitmap): objects 0..k, where k is the play object, drawn with its poster. The poster therefore shows whenever the slot has no frame: not loaded, onEnd 'black', or a slot taken by another clip. With `showWhenStopped: false`, or a play object below full opacity (the video is mixed over base at that opacity, so the poster would show through it), the poster is left out of base.
- **video plane:** an mdPair slot (2-3, below `MAX_VIDEO_SLOTS = 4`), placed at the play object's box and fitted with the clip's own size (`Media.width` x `height`, in `SlideDesc.video` and the job's `video.w`/`h`), not the poster's: a custom poster may have another aspect. A plane whose box is under 1e-3 logical px or that would hold a non-finite float is not encoded (the slide stays one bitmap).
- **over** (full-frame bitmap, usually absent): objects above k that *intersect* the video box, for example a title over a video. Upper objects that do not overlap the box go into base.
- **plane** (16 floats, pre-allocated and copied with `set()`):

  | Floats | Content |
  |---|---|
  | 0..5 | inverse affine, device px → box-local unit square (rotation and flips folded in) |
  | 6..9 | UV rect after crop (outside 0..1 is transparent) |
  | 10 | mask kind: 0 rect, 1 ellipse, 2 rounded rect |
  | 11, 12 | corner radius in box units x, y |
  | 13 | opacity |
  | 14 | AA width in box units (from the affine scale; no derivatives) |
  | 15 | flags: bit 0 hasOver; bit 1 video present (written per frame from the slot-ownership check below) |

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
- **Uniform.** `U` grows to `{rectA, rectB, p, color, planeA[4], planeB[4]}` = 192 B, which fits the existing 256 B slots (`UNIFORM_SIZE` 64 → 192).
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
- **M7:** the queue is tuned from venue measurements. Uploads go in strips (`copyExternalImageToTexture` with an origin; at most one quarter-frame, about 8 MB at 4K, per frame). A stack is not flippable before its upload completes; `LayerStack` already holds the previous content for late content (`stacks.ts:133-170`). Arming normally happens a full cue ahead.
- **M7 tight sprites:** the asset worker sends the bounding box of the drawn content plus its offset. The GPU clears the layer texture with a render pass and copies into the sub-rect. Canvas 2D draws at the offset. On 16:9 decks the photo is on the background layer, so the slide layer usually holds only text and this removes most of the clear, transfer and upload.

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
- the decoded-picture LRU (256 MiB, unchanged; keyed by hash and target size);
- the measure LRU;
- the layout memo per object identity, box and font generation;
- an effect sprite cache (large blurred shadows, glows; key fnv(object JSON) × scale, ≤ 64 MiB).
- **Two raster lanes (M7):** *interactive* (props, lower third) and *bulk* (slide, image), each its own promise chain gated on font loads. A 4K decode can no longer delay the once-a-second props flip (one chain today, `asset.worker.ts:57-60`). Slide jobs yield between objects, so no task exceeds 50 ms.

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
- An `ImageObject` whose `mediaId` is a *video* Media (Pro7 video fills, earlier editor picks) draws that Media's poster on outputs, as thumbnails and the editor already do: `slideImages` maps a video to `poster.hash`, which the manifest already ships. Today outputs draw nothing for it (`asset.worker.ts:199-203`, `link-core.ts:982-995`). It plays only once it has `play`; `play.mediaId` may be the same video.

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
- The asset worker reports text that no shipped face covers in `health.fontFallbacks`, with its script (M3, with the script fallbacks). `self.fonts.check` cannot do it: it says whether the matching faces have loaded, not whether one has the glyphs. The text is measured with the shipped stack before two different generic families instead; the widths differ where a glyph falls through.
- Remove `'inter'` from `FALLBACK_FAMILIES` (`raster.ts:139-148`) and bundle Inter, so the default font is shipped like any other.

*As built (M2, `packages/renderer/src/text/fonts.ts`):*
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

  | Substitute | For |
  |---|---|
  | Carlito | Calibri, Calibri Light (not metric) |
  | Caladea | Cambria |
  | Liberation Sans, Serif, Mono | Arial, Times New Roman, Courier New |
  | Noto Sans (Latin, Greek, Cyrillic), Noto Sans Hebrew, Noto Naskh Arabic, Noto Sans Devanagari, Tamil, Thai, Myanmar | script fallbacks |
  | Inter | ordo's default font |

- **Always on every output.** Inter and the script-fallback faces (a few MB in total) are added to the output-config fonts (`link-core.ts` `ensureFiles` already merges `config.fonts`). Every output therefore caches them in OPFS, whatever the playlist, and an offline output never falls back to the operating system per glyph.
- **CJK faces** (large) are shipped only when needed: `resolvePlaylist` scans the presentations' text (`textScripts`), and `referencedFontFamilies` adds the CJK families when Han, Kana or Hangul text is present.
- Gelasio (for Georgia) and Noto CJK come on demand through the Google job.
- URW base35 (AGPL with a font exception) and Wine's fonts (LGPL) are not shipped.
- `referencedFontFamilies` and `jobFontFamilies` include run fonts, bullet fonts and `fallbackFonts`, so goLive ships them by exact family and outputs pre-cache them in OPFS.
- Font loads that fail are retried with backoff instead of only being logged.

**Google Fonts.** `parseFontCss` (`google.ts:72-84`) keeps every unicode-range subset. Each subset is a Font row with `unicodeRange`, which the three drawers pass to `FontFace`. A bilingual deck's Hebrew or Arabic family therefore arrives with its script, and subsets of one family, weight and style no longer collide.

**Non-metric families.** Century Gothic, Tahoma, Aptos, Gill Sans and Trebuchet are named in the import card: "Upload Century Gothic for exact line breaks". Uploading the real font fixes it automatically, because the family stays first in the stack.

**Embedded fonts (M8).** They are EOT, 88% MTX-compressed.
- Decoded on the pool by a bounded TypeScript MTX/LZCOMP+CTF decoder written from the W3C MTX submission. `eot2ttf` via `tools.run` (timeout, SIGKILL, address-space cap, ≤32 MB in, ≤64 MB out) is the stop-gap.
- Validated with `fonts/sfnt.ts`.
- Stored as `Font{source:'upload', scope: presentationId, embed}` under the `p:embeddedFont` typeface and slot, not the font's own name table.
- Never upserted over a library face (`library.ts:467-480`).
- goLive ships a scoped face only with its own presentation (the family filter in `resolvePlaylist` checks `scope`). The resolver uses it only for objects of that presentation, so a deck's subset 'Calibri' never reaches another deck.
- fsType preview&print faces and subset faces are view-only: the editor warns before new characters are typed.

## 11. Editability and editor extensions

### Mapping

| PowerPoint | ordo | The operator can |
|---|---|---|
| Title, body or subtitle placeholder; text box; text in a shape | TextObject with runs, paras, insets, autofit, direction, fallbackFonts (+ ShapeObject in the same group) | edit text keeping formatting; format a selection; edit paragraphs; edit the box; move the shape and text together |
| Main body text | `lyricObjectId` | lower thirds, stream key, stage, cue labels and search show it (with verse numbers via `readableText`); 'Make lyric box' |
| Picture | ImageObject with crop, mask, flip, adjust | replace (re-cropped to the box, never distorted), crop, mask, flip, opacity, 'Use as background' |
| Full-slide picture background | `backgroundMediaId` (16:9) or bottom ImageObject `role:'bg'` | swap with the existing pickers; 'Replace on all slides' |
| Solid or gradient background | bottom ShapeObject `role:'bg'` | colour |
| Master/layout decoration (logo, bars) | objects `role:'deco'` | edit or delete per slide; 'Apply to similar' |
| rect, roundRect, ellipse, line, connector | ShapeObject | fully |
| Other presets, custom geometry (M6) | ShapeObject with `geom` (+ nearest legacy `shape`) | fill, stroke, dash, arrowheads, box; geometry locked until adjust handles exist |
| Group | flattened objects sharing `origin.group` | select, move and transform together; Alt-click one; Ungroup |
| Table (M6) | one TextObject per cell (shrink to fit) over locked grid shapes | cell text |
| SmartArt with a drawing cache (M6) | locked shapes plus editable text | text |
| Embedded video | ImageObject (poster) with `play` | replace clip, start auto/click, loop, at end, volume, show when stopped, box, crop, mask; 'Use poster only' |
| Embedded sound | `Slide.audio` | replace, start, loop, volume, 'continue for N slides' |
| Notes, sections, hidden slides, timings, transitions | `Slide.notes`, Sections + Default arrangement, `Slide.hidden`, `durationMs` / loop, `Slide.transition` | all |
| Chart, OLE, maths, 3D, WordArt warp, vertical text (v1), overflow | locked transparent art ImageObject (`role:'art'`) at its z | move, resize, delete, z-order; edit in PowerPoint and re-import |

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
   - It keeps `fitScale` while the edited text still fits at that scale. A one-character fix therefore never changes the text size; overflowing text shrinks (§6 step 10). 'Re-fit text' in TextStyleEditor clears `fitScale` on request.
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
17. **Optional (M4):** a three-way merge per slide on 409 (base = `ed.base`, mine = draft, theirs = the 409 body's `current` once `ApiFailure` keeps it, `packages/client/src/api.ts:35-39`), so two volunteers editing different slides, or a volunteer and the version-2 patch, do not overwrite each other.

**Locked objects** show 'From PowerPoint (not editable)'. The Transformer allows move and resize (aspect kept for art). Delete and z-order work; text and geometry fields are read-only.

**Themes.** `applyTheme` replaces the lyric object's box style. Unless they are overridden, it drops the runs' visual overrides (fontFamily, color, sizeScale, letterSpacing, outline, shadow, highlight). It keeps structural formatting (fontWeight, fontStyle, underline, strike, baseline, caps) and `paras`, so verse superscripts, emphasis and numbering survive a theme change.

**Not built:** animation timelines, chart/SmartArt/WordArt/3D editing, master and layout editing, table row and column editing, custom path editing, gradient editors, hyperlinks and actions, PPTX export (prd/05), real-time co-editing, on-canvas rich text editing.

### Round trip and migration

- **Round trip.** There is no PPTX export. The deck stays stored (`fileReferenced`, `library.ts:446-452`). Inheritance is frozen at import: a changed PowerPoint master means a re-import.
- **Re-import.** 'Re-import from PowerPoint' (a hub job on the stored deck; refused while the presentation is locked):
  - regenerates only slides whose objects still match `pptx.digest`;
  - keeps slide ids, sections, arrangements, notes, durations, per-slide backgrounds and the operator's own objects (those without `origin`, kept on top);
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
  - **made-editable slides** (no `imported`; in a pptx-sourced presentation; the bottom object is a full-frame ImageObject whose media is tagged 'document'): that page picture and every text object whose text equals an extracted box are replaced by the native slide. Other objects are kept on top. The dialog lists these slides, and the user can keep any of them unchanged;
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
- If the pool cannot start, use the whole-deck LibreOffice path. Never parse inline on the event loop (which `extractPptx` and `pptxForRendering` do today).

**Zip** (`extractZip` semantics)
- Trust the central directory only.
- Refuse encrypted entries and unknown methods; count inflated bytes against declared sizes.
- ≤ 200k entries; XML ≤ 8 MB per part and ≤ 64 MB in all; spilled media ≤ 1 GiB per import.
- At most 2,000 picture parts, 50 clips and 20 font parts per deck are extracted; the rest are logged and keep their posters or fallbacks. This bounds the Media rows and jobs one deck can create.
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
- slide side 1-51,206,400 EMU; logical coordinates ±100,000; box span ±2× the canvas; font 1-4,000 pt in the parser, 4-1,000 px stored;
- per text object at most 16 distinct run and bullet families and 64 distinct size scales (`FontBudget` in `clamp.ts`, the same in `sanitizePresentation`): later families take the box's, later scales the nearest kept one. Each new family name costs the browser a platform font lookup (about 1 ms in Chromium), so 2,000 runs with 2,000 families would cost seconds per object. Family names lose every control character (a form feed is a CSS newline that voids the whole `ctx.font` assignment);
- adj ±1e7; ≤ 256 guides per shape; ≤ 4,096 path points per path and 64k per slide; ≤ 16 gradient stops;
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

**External tools.** Only through `run()` (no shell, SIGKILL timeout, minimal env); ffmpeg keeps `-protocol_whitelist file,pipe`; soffice without network where possible and with an address-space cap (§5); `eot2ttf` with an address-space cap.

**Saving.** Everything goes through `sanitizePresentation` (which now cuts runs and paras with the text) and the validating `lib.savePresentation`.

**Rendering.** `clamp.ts` re-bounds every new field: runs ≤ 2,000 (sorted, in range, else dropped), paras ≤ 1,000, path strings re-tokenised, stops ≤ 16, effect sizes ≤ `maxEffectPx`, effective font sizes 4-1,000 px. Unknown values fall back to defaults; nothing throws.

## 13. Performance budgets

Measured today (renderer bench, 4-core container, CPU canvas):

| Measurement | 1080p | 4K |
|---|---|---|
| Full-frame authored slide | 3.2 ms | 14.4 ms (p95 22.3) |
| Clear | 2.8 ms | 11.4 ms |
| Tight text sprite | 0.1 ms | 1.3 ms |
| Layer textures | 82.9 MB | 331.8 MB |

The current JSZip text path takes 1.17 s per 100 slides.

**Reference hardware.** The hub runs on a Synology-class NAS (4-core x86 such as a Celeron J4125, `mem_limit: 4g`, `deploy/compose.yaml`). Hub budgets below are stated for that NAS. Until M3 measures one, they are taken as the container figures × 2.5. Output and editor budgets are for the venue's Windows 11 presentation PC (design/22).

| Budget | Target | Enforced by |
|---|---|---|
| Hub parse + emit | ≤ 30 ms per slide p95 in the container (≤ 75 ms on the NAS); ≤ 4 s per 200 slides on one pool worker (≤ 10 s NAS) | harness timings, suite run, NAS run (M3) |
| Pool worker heap | ≤ 256 MB over the 637-deck suite | suite run |
| 17-slide sermon deck (≤12 MB), version 1 saved | ≤ 5 s after job start in the container, ≤ 12 s on the NAS, before any soffice process | M3 e2e |
| Picture preparation | ≤ 1.5 s per 24 MP photo on the NAS; prepared pictures ≤ 8,192 px and ≤ 40 MP | M3 e2e |
| LibreOffice work | proportional to the slides that need it; one soffice run per import (art slides counted twice as pages) | job log |
| JSON sizes | per §3.4 | importer, tests |
| Asset worker slide raster p95 | ≤ 10 ms at 1080p, ≤ 30 ms at 4K; after M7 ≤ 12 ms at 4K for text over photo | bench, health `rasterMs` (today `done.ms` is unread, `messages.ts:136`) |
| Longest asset-worker task | ≤ 50 ms; props flip never > 1 frame late during a slide decode (M7) | health long tasks |
| Rich layout | ≤ 1 ms warm, ≤ 5 ms cold per 400 characters; autofit ≤ 12 layouts | unit bench |
| Render worker | zero missed vsync; no task ≥ 50 ms; nothing allocates or compiles on GO; static slides add 0 draws; in-slide video adds 1 external texture + 1 bind group per frame, same single pass per layer | hot-lint, soak, e2e |
| Uploads | ≤ 4 ms per frame at 4K on the reference venue GPU (M7) | health `uploadMs` |
| GPU memory at 4K | static slides +0; +66 MB only once a scene needs `over`; total ≤ 400 MB (5 layers: 331.8 MB of layer textures + 66.4 MB of over = 398.2 MB) | health `gpuMB` (reported since M5: layer and over textures; the alarm on the budget is M7) |
| GPU time per frame | ≤ 4 ms at 4K on a venue iGPU (timestamp-query where available) | M7 measurement |
| Editor | rich box re-layout + redraw ≤ 8 ms for 1,000 characters; thumbnail ≤ 15 ms at 640 px; opening a 17-slide sermon deck decodes no picture larger than its prepared size | unit bench, M4 e2e |
| Sync | in-slide video start skew within design/23 bounds (17 ms real GPU, 100 ms SwiftShader) | e2e |

## 14. Testing and fidelity measurement

1. **`tools/pptx-fidelity --engine native|ppv|both` (M1).**
   - `native.ts` reads the deck with `extractZip`, runs `parseDeck` and `emitSlides`, and writes `slides.json` plus the pictures.
   - `native-page.ts` is an esbuild bundle of `@ordo/renderer`, loaded in headless Chromium the way `golden/run.ts` loads its page.
     - It draws each shown slide with the real `drawSlide2D` (background cover-fit under it, like the thumbnail worker) at 1920x1080, then crops the slide rect, so 4:3 decks compare like for like.
     - It also renders at 3840 for raster timing.
   - Fonts: the host `fc-match` file of every requested family (`pptx-render/src/fonts.ts`), registered under internal names; the bundled substitutes once M3 lands.
   - Scoring uses the existing `ssim()` (greyscale, 960x540). Cached LibreOffice pictures are reused through `--out` (the local validation suite and the sermon decks are kept outside the repository).
   - `summary.json` gains, per slide: `nativeSsim`, tier, class, reasons, `convertMs`, `rasterMs` at 1920/3840. The report gains a native column and per-tier and per-feature (manifest `features`, worship-high first) means.
   - `--no-ppv` skips pptx-preview. `--baseline` gates regressions: no worship deck drops by more than 0.02.
   - `--lo-compat` (harness only) draws like LibreOffice where the policies differ: no run shadows, hollow outlined text, re-fit instead of the stored scale. Policy rules are reported separately, so progress is not hidden.
   - Decks with embedded fonts are excluded from means; LibreOffice 24.2 ignores them (it drew Inter).
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
   - New cases: runs, verse superscripts, justify, bullets and numbering, autofit, Hebrew and Arabic, mixed bidi, the Arabic ZWJ style split, a Tamil grapheme break, CJK, 'Dieu !' NBSP, crop with negative padding, mask, flip, a Hebrew lyric-only band (punctuation at the left end), presets (M6).
   - A line-break invariance test at 960/1920/3840.
   - **The skip trap is fixed:** `meta.fonts` is built from the files actually used, and CI fails on a skip (`run.ts:60-74`).
5. **Compositor golden (M5).** WebGPU under `--enable-unsafe-webgpu --use-angle=swiftshader` (the minimal set verified to import external textures in a worker) against the Canvas 2D compositor, pixel by pixel: scene stacks with a synthetic `VideoFrame` from a canvas, masks, crops, rotation, crossfade midpoints, a stale generation (poster shows), and no frame (poster shows, never black). Tolerance 40 per channel, ≤ 0.4%. Built as `golden/compositor-run.ts`; it also compares WebGPU with the `planeSample` reference within a tighter bound, and it adds `--use-vulkan=swiftshader --enable-features=Vulkan` (design/23), because with the ANGLE flags alone Chromium 1243 loses the device at its first pipeline.
6. **Preset golden (M6).** All 187 presets with default adjustments, `@ordo/renderer/geom` against LibreOffice (a probe deck through soffice); the evaluator is unit-tested against POI semantics.
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
12. **e2e.** Import → goLive → two outputs (slide pixels, in-slide video at its z, F8, onEnd advance, skew) → stage text and notes → lower-third and stream text → search and cue labels. Also: Clear media during an in-slide video and then arm the next slide's clip; the live slide shows its poster, never the next clip. The authored-slide half (no import) is `e2e/slide-media.spec.ts` (M5 wave 1).
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
- Native beats an all-black frame on ≥ 95% of slides.
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
- A clip still transcoding goes live with a degraded note and its poster.
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
  - tables over 60 cells stay residual.
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

**Parallel.**
- ∥ geom-gen and evaluator (with POI-semantics unit tests);
- ∥ shape drawing (gradients, dashes, ends, effects);
- ∥ group affine and connectors;
- ∥ tables and table styles;
- ∥ SmartArt drawing cache;
- ∥ picture recolour, tile bakes and masks;
- ∥ editor shape fields;
- ∥ preset golden.

### M7: 4K performance pass and per-element art (about 2 weeks)

**Scope.**
- Tight sprites (bounding-box bitmap plus offset; GPU sub-rect copy; Canvas 2D equivalent).
- Interactive and bulk raster lanes.
- Crop-aware decode; opaque-first `copy`.
- Strip uploads with a per-frame budget.
- Health gains `rasterMs` p50/p95, `uploadMs` and font coverage misses, and an alarm when `gpuMB` (reported since M5) passes the budget.
- Measurements on venue GPUs (Windows iGPU, discrete, macOS) at 1080p and 4K, recorded in design/14.
- Per-element art fragments: when the residuals of a hybrid slide are separable, the single art object of M3 (which spans the art z-range) is split into one locked fragment per residual at its own z, from the same white/black double render. Non-residual elements between residuals then become native, so chart slides keep editable pictures and text between their residuals.
- Refresh the stale design/14 sections and ADR 0004/0005/0013.

**Files.** `packages/renderer/src/stacks.ts`, `gpu.ts`, `canvas2d.ts`, `engine.ts`, `health.ts`, `bitmap-cache.ts`; `apps/output/src/asset.worker.ts`, `link-core.ts`; `apps/hub/src/pptx/fallback.ts`, `art.ts`; `packages/pptx-scene/src/rendercopy.ts`, `classify.ts`; `docs/design/14-output-renderer.md`; `docs/adr/0004-text-rasterized-at-arm.md`, `0005-video-element-first.md`, `0013-implementation-adjustments.md`.

**Exit.**
- Slide raster p95 ≤ 10 ms at 1080p and ≤ 12 ms at 4K for text-over-photo slides.
- The props flip is never more than 1 frame late while a slide decodes.
- Uploads ≤ 4 ms per frame at 4K on the reference GPU.
- The health metrics are visible in the operator.
- Fragment alpha reproduces LibreOffice over white and black within 2/255.
- Hybrid slides with separable residuals have one fragment per residual and native elements between them.

**Parallel.**
- ∥ tight sprites (GPU and 2D);
- ∥ raster lanes and decode sizing;
- ∥ strip uploads and health metrics;
- ∥ venue GPU measurements;
- ∥ art fragments;
- ∥ docs refresh.

### M8: Long tail and retirement of pptx-preview (about 3 weeks)

**Scope.**
- Embedded fonts: TypeScript MTX/EOT decoder on the pool (`eot2ttf` stop-gap first), scoped Fonts (shipping and resolution honour `scope`), fsType/subset view-only warnings.
- Vertical text emulation: vert/vert270 by rotation, eaVert by stacked upright CJK.
- Reflection, inner shadow and soft edge on pictures.
- 'Split reveal into slides' as an import option and an editor action.
- 'Convert to song' and 'Re-flow lyrics'; a bilingual band using `role:'translation'`.
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
- ∥ vertical text;
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
- the LibreOffice tools: `pptxToPdf`, `pdfToPngs` (gains page ranges and 288 dpi), `fitPage`, `addReadyImage`, used for fallbacks, art, references and metafiles;
- the whole-deck LibreOffice path, for PDF and as the safety net when the pool cannot start;
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
- **Hybrid art is not editable.** Its z-range is flattened until M7's per-residual fragments, but backgrounds, videos and everything outside the range stay native. Picture mode hides edits; it is guarded by the digest, but can confuse.
- **Hub hardware.** A NAS is several times slower than the dev container. LibreOffice at 288 dpi and picture preparation can take minutes on large decks. They run in jobs, off the live process, and never during a write to a live presentation.
- **Size growth.** Rich slides make presentations and library snapshots larger. The §3.4 budgets and health reporting bound it; summary-only library snapshots are the follow-up if venues outgrow them.
- **New attack surface:** XML, guide formulas, path data, colour maths, the render-copy writer, the art alpha task, the MTX decoder, sniffing of attacker-named parts, picture preparation through ffmpeg, soffice. Everything stays on the bounded pool or behind `tools.run`, with fuzz tests before native becomes the default.
- **Editor complexity.** Selection formatting in a plain textarea, run remapping and group transforms are bug-prone, and volunteers may expect on-canvas rich editing. Mitigations: property tests, 'Clear formatting', advanced controls behind 'More'.
- **Licensing.** POI geometry is Apache-2.0. Ports from LibreOffice (table styles) or libeot stay MPL-2.0 at file level. Bundled fonts are OFL or Apache. ordo itself has no declared licence yet, so compatibility must be confirmed before shipping data and fonts.
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