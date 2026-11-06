# apps/hub/src/pptx: native PowerPoint import (M3)

The hub's native import of [design/27](../../../../docs/design/27-pptx-native-renderer.md) (§2, §5, §11, §12,
§15 M3): an untrusted .pptx becomes an ordo presentation whose slides are **editable** ordo objects, with a
per-slide LibreOffice fallback only for what ordo cannot model (charts, SmartArt without a drawing, OLE, 3D,
WordArt warps, vertical text, tables until M6, metafiles until converted). The parser and converter are
`@ordo/pptx-scene` ([README](../../../../packages/pptx-scene/README.md)); this folder is the hub side: jobs,
pool tasks, pictures, LibreOffice and repair.

Every deck is untrusted input (design/27 §12): it is parsed only on the CPU pool, never on the event loop;
nothing in a deck is fetched, executed or used as a path; deck strings reach logs only through `logSafe`.

## Flow (design/27 §2)

```
POST /import/document  (423 while live, ≤ 1 GiB, zip + .pptx sniff, stored by SHA-256; renderer=native default) [H]
 └─ imports.pptx.queueNative ─► light job 'pptx-native' (nativeJob.ts)                                         [B]
     1 extractZip(store.abs(deck), skip filter): XML parts in memory (≤ 8 MB each, ≤ 64 MB), referenced media
       and fonts spilled under generated names (≤ 1 GiB; ≤ 2,000 pictures, 50 clips, 20 fonts); embeddings,
       vbaProject, customXml skipped; no nested zips                                                           [B]
     2 pool 'pptx-scene' (sceneTask.ts → convertDeck), batches ≤ 150 slides (slide parts transferred, shared
       parts copied), 2 min per batch, ≤ 15 min of pool time per import                                        [B, A]
     3 classification and size budgets (@ordo/domain planImportSizes): over budget → picture class (logged)    [B]
     4 any hybrid/picture/metafile slide: enqueue heavy 'pptx-lo' now, before any clip job                     [B]
     5 pictures ─► preparePicture ─► addReadyPicture; dedup through the media hash index; resume pairs        [C]
     6 remap placeholders, Slide.pptx/hidden/transition/notes, sections, sanitize, save ── version 1          [B]
 heavy job 'pptx-lo' (fallback.ts; deferred while live-locked)                                                 [D]
     pool 'pptx-render-copy' ─► soffice once ─► pdftoppm -r 288 -f k -l k ─► pool 'pptx-art'
     ─► addReadyPicture ─► patch slides whose digest is unchanged ── version 2
 heavy job 'pptx-reference' ('Show PowerPoint picture': every shown slide into Slide.pptx.refMediaId)          [D]
 light job 'pptx-text-repair' (legacy imported.textBoxes, once)                                                [G]
 goLive ─► resolvePlaylist: bundled and script-fallback fonts, CJK faces by text scan [E]; > 12 MiB warning [F]
 operator: ImportTab and import card [H]; previewSlice and the adopt check [F]; MediaTab and gated text [G]
```

Version 1 has native objects for every slide and is saved before any soffice process starts (≤ 5 s for a
17-slide sermon deck in the container). Hybrid slides show their non-residual elements natively and carry
`pptx.pending` until version 2 adds the art; residuals and unconverted metafiles are left out until then.
Picture-class slides (parse failure, budgets) are saved with no objects, `pptx.pending` and their text in
`pptx.artText` (search and labels); version 2 gives them `imported` (page picture, text boxes keyed by shown
index with the uniform contain mapping, `textAligned`). Nothing writes a live-locked presentation (ADR 0007).

## Module map

| File                | What                                                                                       | Owner  |
| ------------------- | ------------------------------------------------------------------------------------------ | ------ |
| `shared.ts`         | Job kinds, payloads, results, classes; pool task types; `PPTX_LIMITS`; `PptxDeps`; version | shared |
| `index.ts`          | `PptxImports`: registers the jobs, `queueNative`, `queueReference` (`imports.pptx`)        | shared |
| `nativeJob.ts`      | The light `pptx-native` job, steps 1-6                                                     | B      |
| `sceneTask.ts`      | Worker side of `pptx-scene`: one batch through `convertDeck` (working pass-through)        | B      |
| `report.ts`         | `PptxNativeResult` for the import card, `source.log`, `logSafe`                            | B      |
| `mediaParts.ts`     | `mediaForFile`: the generalised `mediaFor`, through the media hash index                   | C      |
| `pictures.ts`       | `pictureHeader`, `displayNeeds`, `preparePicture`, `addReadyPicture`, `PICTURE_LIMITS`     | C      |
| `fallback.ts`       | `pptx-lo` and `pptx-reference` jobs, `sofficeToPdf` (hardened)                             | D      |
| `renderCopyTask.ts` | Worker side of `pptx-render-copy`: `buildRenderCopy` + spilled media → .pptx               | D      |
| `art.ts`            | Worker side of `pptx-art`: white/black alpha and bounding-box crop                         | D      |
| `textRepair.ts`     | `pptx-text-repair` job, `pagesOf`                                                          | G      |
| `reimport.ts`       | 'Re-import from PowerPoint' (M4, not this wave)                                            | M4     |

Contracts already in place (the scaffold):
- `@ordo/domain`: `Slide.pptx` (`SlidePptx`: fileId, index, shown, class, version, digest, pending, notes,
  artText, refMediaId, show), `Slide.hidden`, `Slide.transition` (schema only: cues and navigation are a later
  wave), `Slide.imported.textAligned`, `Presentation.source.native` (`PptxNativeSource`), `Font.unicodeRange`;
  bounded by `sanitizePresentation` (`@ordo/importers`) and kept by `clampSlide` (`@ordo/renderer`:
  `clampPptx` keeps what drawers read, `clampTransition`). `size.ts`: `SIZE_BUDGETS`, `jsonBytes`,
  `slideBytes`, `presentationBytes`, `resolvedBytes`, `planImportSizes`. `PptxRenderer` is not widened:
  "native" exists only as a route field and in the payload; native imports set `source.native`.
  `Font.scope`/`embed` are M8 (they need `resolvePlaylist` and the resolver to honour the scope in the same
  change).
- `@ordo/pptx-scene`: `convertDeck(src, { range, pictureSize, newId, mediaId, extendBackgrounds, crop })`
  → `ConvertResult` (`EmitResult` + `frame`, `sections` by `SlideRef.index`, `listed`: every slide of the deck);
  `ParseOptions.range`; `ElementRef` and `ArtInfo` (`ir.ts`); `EmittedSlide.art?: ArtInfo`;
  `rendercopy.ts` (`RenderCopyPage`, `RenderCopyResult`, `buildRenderCopy`, a stub).
- Hub: the pool tasks `pptx-scene`, `pptx-render-copy`, `pptx-art` (`pool.ts` `CpuTasks`, timeouts
  2 min / 2 min / 60 s; `cpu.worker.ts`); the job kinds `pptx-native` (light), `pptx-lo` (heavy),
  `pptx-reference` (heavy), `pptx-text-repair` (light), registered by `PptxImports`, which `ImportService`
  owns as `imports.pptx` with the live-lock check (`locked(presentationId)`) from `hub.ts` / `libproc.ts`;
  `@ordo/pptx-scene` is a hub dependency. Stubs throw `notYet(item, what)`; `apps/hub/test/pptx-scaffold.test.ts`
  checks the wiring (replace its stub expectations as you implement).

## Rules for the parallel items

- **Own your files** (the tables here). Add exports freely; keep the signatures in `shared.ts` and the stubs.
  A different contract is a new function or an optional field next to the old one.
- **Shared files** (`shared.ts`, `index.ts`, `@ordo/pptx-scene` `ir.ts`/`index.ts`/`emit.ts`,
  `packages/domain/src/schemas.ts`, `cues.ts`, `resolve.ts`, `goLive.ts`, `packages/renderer/src/clamp.ts`,
  `packages/importers/src/sanitize.ts`, `apps/hub/src/routes.ts`, `imports.ts`, `db.ts`, `jobs.ts`): small
  additive changes only, at the end of their block, so the merges of M3's items with M2 (merged) and M5
  (in flight: `ImageObject.play`, `Slide.audio`, the reducer slide branch, `media/service.ts`,
  `pptx-scene` `media.ts`/`timing.ts`) stay mechanical.
- **Migrations** (`db.ts`): version 8 is reserved for C (`media-hashes`), 9 for D (job delays, if a table is
  needed), 10 for G (if needed). Integration merges them in number order.
- **Untrusted decks.** Tests build decks with `@ordo/pptx-scene/test-util.ts` (`buildDeck`, `sp`, `pic` …) or
  generators like `tools/pptx-fidelity` `corpus.ts`. No deck files, zips or text of real decks in the
  repository. Real decks (the local validation suite, the sermon decks) are read only through the code under
  test, or with `python3 -I` zipfile scripts kept outside their folders; never executed, copied or named in
  committed files. Rendered pictures are deleted when no longer needed; check `df -h /tmp` before big runs.
- **Checks** before each commit: `npx biome check --write <paths>`; `npx tsc --noEmit -p` every package you
  touched (domain, renderer, importers, pptx-scene, apps/hub, apps/operator, apps/stage); `npx vitest run`
  on those packages (from the repository root). No model identifiers anywhere in the repository.
- Docs move with the code (design/24): design/12 (jobs, lock deferral), design/20 (native import, LibreOffice
  roles, picture preparation), design/21 (soffice sandbox, part caps, log sanitisation), design/11 (fields).

## Items

### A: harden (M1 re-review)

Files: `packages/pptx-scene/src/theme.ts`, `opc.ts` (+ tests), `index.ts` (the internals of `parseDeck` and
`convertDeck`; their signatures stay), `walk.ts` (decoration sharing), `deck.ts`, `emit.ts` (the background
rule only), `tools/pptx-fidelity/src/native.ts`, `native.test.ts`, design/27 §15 M1. Fix both majors; the
minors where cheap.

- **(major) `theme.ts`**: work per run, per paragraph or per inheriting shape still grows with the length of a
  shared deck string or the size of a shared node. `typefaceName` runs a regular-expression replace over the
  whole attribute on every call (cut first, then clean; memoise per string), and shared lookups (theme fonts,
  per-script fonts, style references) repeat per run: memoise per part/string, bounded.
- **(major) `opc.ts`**: a regression of the M1 repair. The parse cache charges each tree by element count, and
  `XML_CACHE_BYTES` (192 MB) is sized for two parts at the tag limit: typical decks thrash, and a hostile deck
  evicts the shared layout/master on every slide. Size it for the working set (slide + its layout + master +
  theme), pin the shared parts of the current batch so a slide never evicts them, and add a test with a deck
  whose layouts are near the limits (parse counts per part stay at one).
- (minor) `index.ts` keeps every slide's IR until it returns and copies layout/master decorations per slide:
  emit each slide as it is parsed inside `convertDeck` (one slide's IR alive at a time) and share decoration
  elements per layout/master.
- (minor) `tools/pptx-fidelity/src/native.ts` `pictureSize` falls back to a caseless linear scan per picture
  (`findCaseless`): index the spilled names once.
- (minor) `native.test.ts`: the isolation test does not prove a timeout (`timeoutMs: 1` may fail otherwise):
  make the conversion provably hang or exceed the limit and assert the timeout note.
- (minor) `deck.ts` `slideParts` calls `relOfType` linearly per slide: index each part's relationships by type
  once.
- (minor) `emit.ts` promotes a 16:9 background picture with an alpha channel to `backgroundMediaId` (drawn
  cover-fit on black instead of on white): keep a picture with alpha as the bottom image on white.
- (minor) design/27 §15 M1 "Native beats an all-black frame" must say what `report.ts` `beatsBlack` measures:
  native SSIM higher than the black frame's, or a match at ≥ 0.999.

### B: pipeline

Files: `nativeJob.ts`, `sceneTask.ts`, `report.ts`; `packages/importers/src/zip-stream.ts` (skip filter,
part caps, spill budget, `nested: false`), `packages/importers/src/remap.ts` (placeholder prefix generalised:
`pptxmedia:` next to `pro7media:`); new `packages/pptx-scene/src/notes.ts` (notesSlide body → `Slide.notes`)
and `transition.ts` (not `timing.ts`, which M5 owns). The route is H's: B reads the options from the
payload (`PptxImportOptions`).

- `extractZip` with the §12 caps (`PPTX_LIMITS`), skip filter (only referenced media and font parts spill;
  embeddings, `vbaProject.bin`, `customXml` skipped) and no nesting; entry names never become paths.
- `pptx-scene` batches of ≤ 150 slides (`range`), shared parts copied and slide parts transferred, within the
  15-minute import budget; a batch that fails or times out makes its slides picture class, never the deck;
  "the pool cannot start" falls back to the whole-deck LibreOffice path (never inline parsing).
- Two-phase save: version 1 as described above; `Slide.pptx` from `EmittedSlide` (index, shown, class,
  version, notes ≤ 16, `artText` from `EmittedSlide.art.text`, `pending`), `digest` = pptx-scene `digestOf`
  over the objects exactly as stored (after remap, sanitize and `Slide.parse`); `Slide.hidden`; the deck's
  `source.log` (`logSafe`) and `source.native` (counts, `slideRect`).
- Classification with the §3.4 budgets: 64 KB per slide, `planImportSizes` for the 4 MiB total (the tail
  compact, logged and counted in the result).
- Placeholder remap (`EmitResult.media` per batch → parts → media ids from C); the `pptx-lo` payload
  (`PptxLoSlide` per slide that needs LibreOffice) enqueued before any clip job; resume pairs in
  `PptxNativeProgress` so a re-queued job never stores a picture twice or saves a second presentation.
- Notes, sections (`p14:sectionLst` → sections plus a Default arrangement in order), `lyricObjectId` (the
  emitted rule) and background promotion: a 16:9 picture background shared by every slide becomes
  `Presentation.backgroundMediaId`; the 'Extend plain backgrounds to 16:9' option (`extendBackgrounds`).
- Transitions → `Slide.transition` (fade/dissolve: crossfade, `p14:dur` else 700 ms; none: cut; others:
  crossfade, logged); `advTm` → `durationMs`; a looping show with every slide timed → kind `loop`.
- Tests: a synthetic deck through the job (createHub) with a hidden slide, notes, sections, a transition, a
  picture; resume after a crash between steps; a fuzz deck gives a clean failure or picture fallback.

### C: pictures

Files: `pictures.ts`, `mediaParts.ts`; `media/ffmpeg.ts` (prepare helpers), `media/service.ts`
(`addReadyPicture` may live here; M5 also edits this file: additive), `db.ts` migration 8 (`media-hashes`),
`imports.ts` (`mediaFor` of the ProPresenter import moves onto `mediaForFile`).

- `pictureHeader` (PNG, JPEG, GIF, WebP; BMP and TIFF recognised for conversion; animation detected),
  `displayNeeds` (widest box at 3840 ÷ visible crop fraction, ≤ 8,192), `preparePicture` (downscale above
  1.25× need: JPEG q90 opaque, PNG or lossless WebP with alpha; TIFF/BMP → PNG; animated → first frame,
  logged; ≤ 8,192 px a side, ≤ 40 MP), `addReadyPicture` (only checked headers; ready, no job; tag `pptx`).
- The SHA-256 media hash index (SQL table, not a scan of `lib.media.list()`): prepared bytes plus the source
  part's hash; resume pairs [part, media id] in the job payload. Clips go through `MediaService.ingest`
  (M5 extracts them; not this wave).
- Tests: a 48 MP synthetic photo is prepared to its need; dedup across two imports; a lying header is refused.

### D: LibreOffice

Files: `fallback.ts`, `renderCopyTask.ts`, `art.ts`; `packages/pptx-scene/src/rendercopy.ts` and a new
`hybrid.ts` (fills `EmittedSlide.art`: the art's `ElementRef`s, box, `at`, `replaces`, text; one hook line in
`emit.ts`); `media/ffmpeg.ts` (`pdftoppm` page ranges at 288 dpi); `jobs.ts` (a delayed start for the lock
deferral, migration 9 if it needs a table); the route for 'Show PowerPoint picture' (`queueReference`, 423
while locked).

- The heavy `pptx-lo` follow-up: render copy on the pool (white and black pages per art slide, picture-class
  slides once, External relationships, media payloads, `vbaProject.bin` and OLE binaries removed, the outline
  strip), soffice **once**, `pdftoppm -r 288 -f k -l k` per needed page, pool task `pptx-art`
  (alpha = 1 − max(white − black)/255, colour = black/alpha, bounding-box crop), metafiles → PNG,
  `addReadyPicture`, a digest-guarded patch (an edited slide gets the art on top plus a note), `pending`
  cleared, one revision. Deferred with backoff while the presentation is live-locked; never writes it then.
- The on-demand `pptx-reference` job.
- soffice hardening: `unshare -rn` where the container allows it, else proxy variables at a dead port;
  `prlimit --as`; `tools.run` timeouts with SIGKILL. The 'Pictures (LibreOffice)' import uses the same
  worker-built render copy instead of `pptxForRendering`.
- Tests: the alpha formula against synthetic white/black rasters (within 2/255); a chart slide over a photo
  background: only that slide hybrid, version 2 adds the transparent art, an edit made in between survives;
  page selection with a hidden slide; deferral while locked.

### E: fonts

Files: new `apps/hub/src/fonts/bundled.ts`, `fonts/google.ts`, `fonts/service.ts`; `Dockerfile`; licences
recorded (OFL/Apache texts with the bundled faces); `packages/domain/src/resolve.ts` (CJK families by text
scan, additive).

- Bundled metric-compatible substitutes and script fallbacks registered idempotently by hash as
  `Font{source:'bundled'}`: Carlito (Calibri, Calibri Light), Caladea (Cambria), Liberation Sans/Serif/Mono,
  Noto Sans (Latin, Greek, Cyrillic), Noto Sans Hebrew, Noto Naskh Arabic, Noto Sans Devanagari, Tamil,
  Thai, Myanmar, Inter. The Dockerfile adds `fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core`
  so LibreOffice's art uses the same metrics.
- Inter and the script fallbacks go to every output through the output-config fonts (`outputConfig` in
  `hub.ts`/`libproc.ts`), whatever the playlist; CJK faces only when `textScripts` finds Han, Kana or Hangul.
- Google Fonts: `parseFontCss` keeps every `unicode-range` subset; each subset is a Font row with
  `unicodeRange` (one family, weight and style no longer collide). The drawers pass it to `FontFace`
  (M2's resolver: a one-line additive change where faces are registered).

Done (`apps/hub/test/fonts-bundled.test.ts`, `fonts-google.test.ts`, domain `resolve.fonts.test.ts`):
- `fonts/bundled.ts`: `BUNDLED_FACES` (40 faces; family names as `SCRIPT_FALLBACK_FONTS` and the converter's
  substitutes name them), `SCRIPT_RANGES`, `bundledSubstitute(family)` (for the import card's missing-font
  note), `outputFonts(fonts, looks)`, `registerBundledFonts`. `FontService.bundled` is the start-up
  registration (`HubConfig.fontsDir`, `ORDO_FONTS_DIR`); bundled rows answer 409 to DELETE.
- `@ordo/domain`: `SCRIPT_FALLBACK_FONTS` (identical to M2's, so the merge is clean), `fallbackFontScripts`,
  `scriptFontFamilies` (added to `referencedFontFamilies`), `ON_DEMAND_FONT_SCRIPTS`, `isOnDemandFontFamily`.
  After M2 merges, `fallbackFontScripts` can become `textScripts`.
- `library.upsertFont` keys faces by family, weight, style and `unicodeRange`; `FontLoad.unicodeRange`
  (renderer `messages.ts`) carries it to the asset worker. The operator's resolver and thumbnail worker
  still map `Font` without it (M2's files: one field each).
- Licences: `fonts/LICENSES.md`, `fonts/OFL-1.1.txt`; the image keeps the font packages' copyright files.

### F: budgets

Files: `packages/domain/src/size.ts` (refine; add `previewSlice`), `goLive.ts` (a `degraded` warning above
`SIZE_BUDGETS.resolvedWarn`, additive), `apps/operator/src/views/editor/PreviewControl.tsx` (send
`previewSlice`), `apps/operator/src/core/engine.ts` (refuse `live.adopt` locally above `adoptMax`), the
library snapshot size in hub health.

- The importer's checks: B calls `planImportSizes` and `slideBytes`; F owns their definitions, any change
  to the compact-slide estimate, and the tests below.
- Tests: a 2,000-slide synthetic deck stays within 4 MiB (the tail compact, logged); preview of the largest
  slide's section < 1 MiB; a 13 MiB resolved playlist gets the warning and the operator refuses adopt; a year
  of weekly 17-slide decks keeps the library snapshot under 6 MB.

### G: repair and media hygiene

Files: `textRepair.ts`; `packages/domain/src/cues.ts` (`firstText`'s fallback only), `apps/stage/src/model.ts`
(`slideText`), `apps/operator/src/lib/search.ts`, `lib/preview.ts` (`previewMedia`),
`views/library/MediaTab.tsx`, `views/editor/SlideCanvas.tsx` and `ObjectPanel.tsx` (the M1 crop wiring),
`apps/hub/src/imports.ts` (the LibreOffice path's text boxes), media delete in `routes.ts`.

- The legacy repair job (`pagesOf` rule, uniform contain mapping, `textAligned`, one revision, locked ones
  retried after End service, decks gone skipped) and its one-shot trigger (`queueTextRepair` added to
  `index.ts`); native presentations (`source.native`) are never touched.
- The gated text fallback: `firstText`, stage `slideText` and the search haystack fall back to
  `imported.textBoxes` only with `textAligned`, and to `pptx.artText` on hybrid and picture slides.
- New picture-class text boxes (the 'Pictures (LibreOffice)' path) keyed by shown index, uniform mapping,
  `textAligned`; `previewMedia` includes the imported picture.
- MediaTab hides media tagged `pptx` or `document` unless 'Show presentation pictures' is ticked; deleting
  media that stored presentations reference asks for confirmation and names them.
- From §15 M3 "Wiring left from M1": the editor's image node passes `o.crop` to `drawImageFit`, and
  'Replace image' drops the old picture's crop.
- Tests: a legacy picture deck with a hidden slide: after the repair, stage text, labels and search match each
  slide.

### H: import UI and route

Files: `routes.ts` (`POST /import/document`: `renderer=native` the default; `extendBackgrounds`;
'libreoffice' keeps the picture path; 'pptx-preview' accepted until M8 retires it),
`apps/operator/src/views/library/ImportTab.tsx`, `packages/client` if the API helper changes.

- ImportTab offers 'Editable (recommended)' and 'Pictures (LibreOffice)' (replacing the `ordo.pptxRenderer`
  select) and 'Extend plain backgrounds to 16:9'.
- The import card shows `PptxNativeResult`: per-class counts, compact slides, pending LibreOffice work, notes
  and the missing fonts ("Upload Century Gothic for exact line breaks").

## Not in this wave

Waiting for M2's second wave and M5 to merge: rich text emission (runs and paragraphs) from the converter; clip extraction
(`pptx-scene` `media.ts`, `timing.ts`, `ImageObject.play`, `Slide.audio`); `slideContent()` in every drawer;
hidden-cue navigation in the reducer and `item ?? slide ?? presentation` in `expandCues`; video posters on
outputs. Hub budgets measured on a reference NAS. 'Re-import from PowerPoint' (M4).
