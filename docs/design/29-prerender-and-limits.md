# Design 29: Pre-rendered slides and size limits

Packages and apps involved:
- `packages/domain`: the stand-in and slide-page schemas, the picture key and stand-by id, which slides get a
  picture (`pictureUnits`), `withFullSlide`, the goLive listing, the resolved copy by its hash.
- `packages/renderer`: the bake profile and bake font profile, the live frame, the raised text bounds, the
  worst-case object bench, the picture version's digest test.
- `packages/pptx-scene`, `packages/importers`: one plan step in place of the size ladder, the guard's left-outs
  and LibreOffice's page; the import sanitizer's raised bounds; a compact path parse and XML read on demand.
- `apps/hub`: slide pages, keys at save, the pictures table and its checks, collection with revisions and
  backups, the per-presentation budget, the free-space floor, going live prepared beside the running service,
  the running service and the hand-back by reference, library pokes; re-import, the LibreOffice follow-up,
  Make editable and the ProPresenter import through the full slide.
- `apps/operator`: the bake worker and its queue, slide files and every editor operation through the full
  slide, the Drawing card, the lines before Go live, the Go-live check, health and Setup lines, offline download.
- `apps/output`, `apps/stage`: picture, full slide a page at a time, or stand-in; the fill order; the fade; the
  service saved once.
- `apps/demo`: slide pages stored like shape files; no picture routes.
- `packages/protocol`, `packages/live-state`: `prerender.add`, `prerender.use`, `hello.resolvedId`, `live.state`
  without the resolved copy, `live.adopt` by reference, the prepare request, `library.poke` for every client.

Status: accepted, building in wave r2b (2026-11-15). Proposed 2026-11-14 and revised the same day after two
reviews (§8), from the owner's decisions of that day ("incorporate the pre-rendering idea", "I want the limits to be
removed where possible. add in a warning where it would be critical") and four sweeps of the code: storage and
transport, import, render and outputs, pre-render groundwork. The owner's defaults of §5 are applied as listed
there; the r2b plan's review revised this design in §9, and the tracks of §4 build it in four sub-waves behind one
switch, `PRERENDER_ON` (§4), which stays false until the last one. File and line references are to `1e70a19` (head
of vrwarp/ordo#27, wave r2a) unless they name another commit; wave r2b re-cited the ones its first sub-wave reads
at `62a1c3a` (main after #27), where they say the same, except `PresentationBody` (`apps/hub/src/routes.ts:117`
there). `add91d9` is decor-render's unmerged plate work. Figures marked "measured" were taken for this design on a shared, loaded 4-vCPU 2.1 GHz
container (headless Chrome 153 for pictures, Node 22 for JSON): read them as upper-ish, not as a venue PC's.

Earlier owner decisions this design keeps: never drop an effect; a GO never waits (a late part fades in, about
0.3 s); nothing is baked on a phone or a compact layout, and nothing while live except the go-live bake; 1 GiB of
plates per presentation, kept with its revisions; text shadows and glows stay live on ordinary slides; LibreOffice
is optional; editability first.

## Today

A presentation travels whole: in the message that starts a service, in the hub's snapshots and journal, in every
operator's and iPad's library, in each save and each old version, and in the copy each screen keeps. That is why
ordo has size limits, and each one costs content:
- A slide over 64 KB is simplified: its text loses its formatting (`plain`) or its decorations are left out
  (`minimal`) (`fitSlideBudget`, `packages/domain/src/size.ts:314-361`; `ImportCore.budget`,
  `packages/importers/src/pptx-core.ts:441-583`). On a hub with LibreOffice the slide becomes LibreOffice's page
  instead (`pageForBudget`, `pptx-core.ts:426-431`; never a slide holding a table object, since sub-wave 1b):
  empty until LibreOffice draws it, and without its in-slide video, motion background and lyric box. Worship set E after r2a (275 decks, 2,893 slides): 16 slides (12
  minimal, 4 plain; on hubs with LibreOffice 16 pages: 8 tables, 5 decorative, 3 plain text); 106 slides are over
  48 KB. Since r2b the 8 table slides are table objects within 64 KB (tables-conv) and the table object on every
  kind of hub (the owner's answer to the LibreOffice inventory's question 3, sub-wave 1b): 8 slides remain.
  Raw corpus: 132 + 36 slides over 64 KB in 39 / 21 decks.
- Past 3 MiB of presentation the remaining slides keep only text, pictures and background (`size.ts:37-43`,
  `planImportSizes` :157-198), and near 4 MiB their text is cut to 200 characters a box (`pptx-core.ts:90`,
  :543-576). No E deck reaches it (largest 1.47 MiB); two raw decks did before geometry files (5.7 and 7.8 MB).
- The converter's guard leaves the topmost elements out past 150 / 190 / 200 objects and 16 pictures
  (`packages/pptx-scene/src/budget.ts:69-77`, guard :518-572): LibreOffice's art on hubs with it, listed missing
  without. The screens' clamp silently leaves out objects past 200 and pictures past 16
  (`packages/renderer/src/clamp.ts:59-63`, applied :876-882), and characters past 10,000 in a box, though the
  schema and the editor keep 20,000 (`clamp.ts:48`; `packages/domain/src/schemas.ts:13`).
- Dense traced artwork does not import: of 7,072 distinct corpus decks (central directories read, measured), 2
  worship-design templates pass the 64 MiB XML total (72.4 and 70.6 MB) and fail whole; 3 decks have parts over
  the 8 MiB part bound (largest 22.3 MB); 4 have parts over 250,000 tags (up to 1,505,887), so their slides, or every
  slide on such a layout, keep only their text; 1 slide has 6,251 shapes (walk cap 5,000).
- A service over 15 MiB cannot be handed back to the hub after an outage (`adoptMax`, `size.ts:48-52`).

Several costs grow with a service and sit on the GO path, unmeasured on venue hardware but fine for today's small
services (measured here: `JSON.stringify` 2.7-5 ms/MiB, `JSON.parse` 3-5, `structuredClone` 9-12, the
`Presentation` schema check 8-25 ms/MiB; the GO lead is 33 ms, `apps/operator/src/core/engine.ts:49`):
- each screen's link worker structured-clones the whole service into IndexedDB on every change
  (`apps/output/src/link-core.ts:815-830`): past the GO lead from about 3 MiB;
- each reconnecting socket gets its own `JSON.stringify` of the whole state on the live event loop
  (`apps/hub/src/ws.ts:356-370`), and a hub restart reconnects every client at once;
- the live snapshot re-serialises and writes the whole service twice, synchronously, within 5 s of every GO
  (`apps/hub/src/live.ts:130`, :238-270);
- the operator core rewrites the whole library as one IndexedDB record 1 s after any change, in the worker that
  handles GO keys (`apps/operator/src/core/libraryStore.ts:255-263`);
- the goLive bundle fetch has 1.5 s for headers, body and parse together (`apps/hub/src/librarylink.ts:57`,
  :163-183), a hidden size limit;
- library deltas carry whole presentations to every socket with no backpressure (`ws.ts:539-563`).

Raising the limits without fixing these would make GOs late. Nothing in ordo makes a slide picture yet: the
converter's plate plan has no consumer (`EmittedSlide.plate`, `packages/pptx-scene/src/emit.ts:369-375`; dropped
by the hub, `apps/hub/src/pptx/clientScene.ts:16`), and decor-render's plate store is unmerged (`add91d9`).

## What this design does

- A slide that is big, or too crowded for a screen to draw at once, is kept whole and editable in a slide file on
  the hub, stored in small pages named by their content like today's shape files. The presentation keeps a small
  stand-in: its text, cues, notes, media, lyric box and everything that plays or changes.
- ordo's own renderer draws a 3840x2160 picture of the static part of that slide, with only the library's fonts,
  on a desktop computer after an import and after each save; the computer that goes live makes the missing ones.
  Screens show the picture with the moving parts drawn live above it. Until it exists they draw the full slide
  themselves, a page at a time, and the picture fades in when it arrives.
- Each slide has "Draw as: Pre-rendered | Live" (Live even if slow), with a presentation default. Every detailed
  slide gets a picture whatever its switch says, so the operator can use it for one service without a save.
- Every writer of slides (the editor's operations, re-import, the LibreOffice follow-up, every importer) changes
  the full slide, never only its stand-in.
- Every size and count limit was re-examined (§2): of 108, 4 are removed, 42 replaced by a
  mechanism, 11 raised and 51 kept; what is kept bounds hostile input, disk, memory or what one live
  raster may draw, set as high as measured safe. Pre-rendering adds 15 bounds of its own.
- Going live prepares the new service beside the running one, so no key press waits for it; after goLive the
  service travels by the hash of its content, so no copy of it is serialised on the live path again.
- A plain warning goes wherever a remaining limit, or a Live choice, could hurt a service (§3), and every critical
  one is also shown before Go live, where it can still be fixed.

## Decisions

1. **Big slides are pre-rendered, never simplified.** The 64 KB ladder's `plain` and `minimal` levels, the 3 MiB
   tail, the 200-character last resort and LibreOffice's page for big slides go. The lossless grid step stays for
   slides that then fit inline.
2. **Crowded slides use the same pictures** (owner question 1, default yes): a slide a live draw would cut (more
   than 200 objects or 16 pictures, and the other live counts of §1.1) is kept whole and pre-rendered. So the
   converter's guard and the screens' clamp stop leaving content out.
3. **One picture store.** Pre-rendered slides and, later, decoration plates (bake-on-save P3/P4) share one table,
   key format, upload route, collection and goLive listing, grown from `add91d9`'s plates, not forked.
4. **Only ordo draws pictures, only on a desktop.** A bake worker of the operator app on a desktop Chromium
   (fine pointer, not a compact layout); iPads only after a WebKit parity probe; never a phone, the hub, an output
   window or the Pages demo. While any service is live, only the go-live bake runs, on the computer that went
   live, throttled; every other computer waits until the service ends (the owner's rule of 2026-11-13).
5. **A picture is complete or it is not uploaded.** It is keyed by everything it depends on (slide, live set,
   media files, every font face of the resolution chain, renderer version) and drawn only with library and
   bundled fonts, so two computers make the same pixels for one key and a stale picture is never shown as current.
6. **The fallback chain never waits:** picture, then a stand-by picture (older renderer or older fonts), then the
   full slide drawn live from its pages (late parts fade in), then the stand-in with a degraded line.
7. **Limits: remove, replace, raise, keep.** A limit stays only to bound hostile input or what one live raster may
   draw in a 50 ms task; everything else gets a mechanism (out-of-line storage in pages, transport by reference,
   preparing beside the live service, slicing over frames, pre-rendering).
8. **The running service by reference** (`resolvedId`, the hash of its content) lands before any inline budget is
   raised, and **going live never holds the keys**: the playlist is prepared beside the running service and
   goLive applies only once it is ready.
9. **Warnings have three levels** (§3): blocking (the action does not happen), critical (something on the screens
   would be missing, late or wrong during a service: shown where it starts, again before Go live while it can be
   fixed, and in the Go-live check or the operator's health), advisory. Go live and GO are never blocked by a
   picture.
10. **Every writer goes through the full slide** (§1.8, §1.12): one domain helper loads the file, applies the
    change, writes new pages and rebuilds the stand-in and the key.

## 1. Pre-rendered slides

### 1.1 Which slides get a picture

One pure domain function, `pictureUnits(slide, cost?)` (`packages/domain/src/prerender.ts`, new), shared by every
writer of slides, judged at a fixed 3840x2160 reference so every view plans the same (the bake-on-save P1 rule).
It computes the pure count reasons itself (objects, pictures, bytes, characters, font families and sizes). The
cost reasons need the renderer's cost model (`GEOM_COST`, the unit split) and media pixel sizes, which
`@ordo/domain` cannot import (`packages/domain/package.json` depends on zod and ulid only), so the converter and
the editor pass them in from a renderer function, `costReasons(slide)`. The hub never recomputes reasons: it stores
what the writer sends and checks the counts. Its reasons, kept on the slide for the report:

| Reason   | When                                                                                                                                                                                                                                                                                                                                                                                                                  | Slide file        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `bytes`  | stored over 64 KiB (`SIZE_BUDGETS.slideMax`, `size.ts:36`) after the lossless grid step; includes slides past 128 KB of text formatting (`TEXT_BUDGET_BYTES`, `emit-budget.ts:38`)                                                                                                                                                                                                                                    | yes               |
| `tail`   | moved out of line because the presentation's inline part passed 3 MiB (`presentationCompact`, `size.ts:41`); largest slides first, so the fewest move. Drawn by the screens from its file; it gets a picture only when its live estimate at 4K passes 0.3 s (owner question 10)                                                                                                                                       | yes               |
| `count`  | drawn live it would pass a live-raster bound: over 200 objects or 16 distinct pictures (`clamp.ts:59`, :61), a box past 16 font families or 64 size scales (`clamp.ts:84-86`), over 65,536 stored path points (`geom.ts:70`), a box over about 4,000 characters other than the lyric box (§2.2 C4); from `costReasons`: prepared pictures over 192 MiB (:63), a geometry no single task can draw (`units.ts:233-252`) | yes               |
| `chosen` | Draw as: Pre-rendered on a slide that needs none                                                                                                                                                                                                                                                                                                                                                                      | no (inline whole) |

`cost` (slow but within every count) is reserved and not written in r2b: such slides draw from geometry units
(r2a) and effect units (r2b effect-units), and get stack and effect plates in r3 (bake-on-save P3/P4), so their text
stays live as decided for ordinary slides. The schema's `.catch` drops a reason it does not know.

Every writer runs the plan: the PowerPoint import on both paths, the ProPresenter, PDF, song and scripture imports
(today only the PowerPoint import and the editor's add refusal look at counts, so a ProPresenter slide with 20
pictures is cut silently by the screens' clamp), re-import, Reset slide, the LibreOffice follow-up, Make editable
and every editor operation (§1.8, §1.12).

### 1.2 Data model

**The stand-in** (inline, new optional `Slide` fields; an older build strips them):

```ts
prerender?: {
  why: ('bytes' | 'tail' | 'count' | 'chosen')[];   // .catch: unknown reasons dropped
  file?: { ref: Sha256; bytes: number };             // the slide file's head; absent for 'chosen' or when refused
  live: Id[];                                        // anchors drawn live above the picture, bottom first (§1.5)
  uses?: { media: Id[]; files: Sha256[]; fonts: string[] };  // what the file draws; ≤ 1,000 / 1,000 / 64
};
draw?: 'picture' | 'live';                           // Draw as; absent: the presentation's default
cut?: string[];                                      // what a kept bound left out (≤ 16 × 200); goLive lists it
```

- The stand-in's `objects` are the live objects in full form, then the simplified rest: text plain, tables as
  plain text, pictures as they are, the background as its colour (`minimalSlide`, `size.ts:374-392`, with the
  live objects kept whole), capped to the live-raster bounds (200 objects, 16 pictures: live first, then text,
  then pictures by area) so any drawer draws it whole. Text past one box's 20,000 characters (`schemas.ts:13`,
  :527) is split across plain boxes of at most 20,000 characters each within the 200-object cap; only past that
  is it cut, with W5.
- That one form is what an older build (0.8.1, main's PR #30, the release before wave r2b, with 0.8.0's schema, or
  0.5.0) draws after a rollback (today's simplified result, never a blank), what
  every reader reads (search, cue labels, Stage, lyric-only looks, Bottom-Third Stream, live translation) and what a
  screen draws when it has neither file nor picture.
- Everything not drawn stays in the stand-in, never in the file: notes, timing, transition, MIDI cues, sound,
  hidden, scripture, PowerPoint provenance. So editing speaker notes changes neither the file nor the picture.
- `cut` is written by any importer when a kept bound left something out (W5, W9-W14, W64) on a slide that is not
  from PowerPoint; a PowerPoint slide uses `Slide.pptx.missing`, which goLive already lists
  (`MISSING_SLIDE_REASON`, `goLive.ts:396`). Either way the Go-live check repeats the import's critical line.
- Rejected: shaping the stand-in as an older build's picture slide (`imported.imageMediaId`). The picture is not a media
  item, may not exist yet, and registering it would make every bake a save of a live-locked presentation.

**The presentation default** goes in `Presentation.meta.draw?: 'picture' | 'live'`, not at the top level:
`PresentationBody = Presentation.strict()` (`apps/hub/src/routes.ts:117` at `62a1c3a`) would make an older hub
(0.8.1, 0.5.0) refuse a save with a new top-level key, while `meta` strips unknown keys (`schemas.ts:1018-1026`). Resolved as
`slide.draw ?? meta.draw ?? 'picture'` on a slide with `prerender`, except that a `tail` slide without its own
switch draws live from its file unless its estimate passes 0.3 s (owner question 10); a slide without `prerender`
is live unless set to Pre-rendered.

**The slide file** is stored in pages, so that no reader ever parses a large one at once. An output reads a
geometry file in one prepare step (`packages/renderer/src/geom/stored.ts:166-173`) on the asset worker, the
thread that draws the live and armed cues, and nothing preempts a step once it runs
(`apps/output/src/lanes.ts:21-23`): one 16 MiB file would be 50-500 ms of `JSON.parse` and checking in one slice.
- A **head** `{ v: 1, pages: Sha256[], count, lyricObjectId?, imported? }` and **pages** `{ v: 1, objects }` of at
  most 256 KiB or 500 objects each (about 1 ms to parse), all `application/json` in the content store, each named
  by the SHA-256 of its canonical JSON after sanitising (geometry files' rule, `apps/hub/src/pptx/geoms.ts:1-17`),
  immutable and shared by revisions. `prerender.file.ref` is the head's hash; shape files by hash and media by id
  inside the pages.
- Bounds: 20,000 objects and 16 MiB of pages a slide (inline slides keep `objects.max(1000)`, `schemas.ts:940`),
  set from measure 3. A save uploads only the pages that changed.
- Checked at entry by the hub's pool (design/25); outputs clamp at use (`clampObject`) and do not run the schema
  again.

**The picture**: the whole 16:9 frame at 3840x2160, a 1920x1080 copy the baker downscales once with high
quality, and a 640x360 preview (lossy WebP, about 50-100 KB) for phones, thumbnails and the library grid. Opaque
when the slide has a backdrop (every PowerPoint import: the converter's `bg` shape); with alpha only without one (a
ProPresenter slide over a motion background) or for the no-backdrop variant (§1.5). PNG for any picture with alpha,
because WebP at quality 1 was up to 16 levels off on translucent pixels (measured); PNG or lossless WebP for opaque
ones, WebP only where its round trip was checked exact. Measured on synthetic worst cases at 3840: photo with text
17.8 MB PNG / 8.5 MB WebP (encode 0.42 s / 4.4 s), graphic 11.5 / 6.5 MB; the 1920 copies 4.3 / 2.3 and 2.1 / 1.2 MB.
Real slides are not measured yet (§1.13).

**The key** (computed at save, §1.3; never stored on the slide):

```
source    = canonicalJson({ kind: 'slide', frame: [3840, 2160],
              slide: sha256(canonicalJson(drawnPart(full, live))),  // §9 r2b.4: never the head's hash
              live: prerender.live, backdrops: true | false,
              media: { [mediaId]: fileHash | null },              // the file each drawn picture decodes
              fonts: { scope, faces: { [family]: [faceHash, ...] | null } },  // the whole resolution chain
              fallback: FALLBACK_FACES_DIGEST })
standbyId = sha256(canonicalJson({ slide, live, backdrops, media }))  // no fonts, no renderer version
key       = sha256(canonicalJson({ v: PRERENDER_VERSION, source }))
```

- **The slide part** is the SHA-256 of the full slide's drawn part (`drawnPart`: the slide's picture under its
  objects, `slideContent`, and the objects the picture draws, without the live set and without each object's id,
  origin and lock), from the slide file's pages or, for a `chosen` slide, inline. Not the head's hash: pages keep
  ids, origins and locks, which never change a pixel, so a paste, a duplicate or a re-import that draws the same
  keeps its picture. The pool records each head's drawn digest in its `slide_files` row when it checks the pages,
  so a font or media change recomputes keys without reading pages again (§1.3).
- **Fonts.** Live drawing of an ordinary slide names the raw family and a system chain in its CSS font string
  (`packages/renderer/src/text/fonts.ts:418-437`: the exact library face, `fallbackFonts`, script fallbacks, then
  the original family name, the default face and the legacy tail), so each browser falls back to fonts installed
  on its own computer. A picture, and an output drawing a pre-rendered slide's full file, use the **bake font
  profile** instead: font strings built only from loaded library and bundled faces, no raw family name, no system
  chain. The key lists every face of the chain: the family, the style's `fallbackFonts`, the script fallbacks,
  `DEFAULT_FONT` and the font scope (`familyKey(scope, family)`, :316). So a Windows laptop and a Mac make the same
  pixels for one key, and the picture fading in over a live draw never changes face or line breaks. A character no
  loaded face has is a coverage miss reported at bake (W30), never a system font.
- **Stand-bys.** `standbyId` finds a picture made by an older renderer or before a font upload: outputs use it while
  the new one is made, so a release or a font upload does not turn every detailed slide live at the next service;
  the goLive listing marks it (W39). It keeps the media file hashes: a replaced picture file never shows its old
  version (owner question 11).
- `PRERENDER_VERSION` and `FALLBACK_FACES_DIGEST` live in `@ordo/domain`, as `add91d9:packages/domain/src/plates.ts`
  keeps `PLATE_VERSION`: the key is computed by the editor, the bake worker and the hub's pool at save, and must not
  depend on drawing code (the hub reaches `@ordo/renderer` only through the converter, `packages/pptx-scene/package.json`).
  A digest test in the renderer over its drawing sources (`text/`, `geom/`, `shape.ts`, `effects.ts`, `picture*.ts`,
  `decor/`, `table/`, `text2d.ts`, `clamp*.ts`, `units.ts`) forces the decision, as
  `packages/protocol/src/version.test.ts:20-38` does for `APP_VERSION`: same pixels, record the digest; different
  pixels, bump.
- Not in the key: the output's size, the look (pictures are used only in the `authored` look; lyric-only, bands
  and hidden draw the stand-in's text live, `text2d.ts:741-760`), the Chromium build (as for live drawing).
- The same pure function (SHA-256 in JS, `packages/domain/src/sha256.ts` from `add91d9`, so a non-secure context
  computes it too) runs in the editor, the bake worker and the hub's pool. Outputs never compute keys: goLive and the live
  events tell them which file is which slide's picture.

### 1.3 Storage on the hub

**Slide files.** `PUT /files/slide/<hash>` (edit role; refused for capped phone sessions) takes a head or a page,
at most 256 KiB a page; pages first, then the head, whose check finds every page. Each is parsed and checked in the
pool worker (`apps/hub/src/pool.ts:74`, 512 MB heap), never on an event loop; the hub names a page by what it
stores after sanitising and refuses a name that differs. A `slide_files(hash, bytes, count, uses, drawn)` row per head
records what the slide draws (`drawn`: its drawn digest, the key's slide part, §1.2); on a presentation PUT the hub checks each `prerender.file.ref` exists (else 409 "upload
slide files first") and rewrites `uses` from its row (the hub is the authority). A save uploads only hashes the hub
lacks, then PUTs the small presentation. A slide whose full form the hub refuses (over 16 MiB of pages or 20,000
objects) keeps only its stand-in, `why: ['bytes']`, no file and no picture: the import says so (W18), the editor
refuses that save (W18).

_As built in r2b sub-wave 2 (prerender-store), where the build differs from the text below:_ the head's index is
`slide_heads(hash, bytes, objects, uses, created_at)` with `slide_head_pages(head, pos, page)` (no `slide_files`
table and no `drawn` column: the slide's drawn digest is in the key, and the hub rewrites `uses` and `file.bytes`
from the row it checked); a page is at most 500 objects and 256 KiB, a head at most 129 pages, 16 MiB and 20,000
objects (`SLIDE_FILE_LIMITS`, the clamp); the keys of a revision are computed in the pool **before** the save is
written and stored with a signature (`prerender_keys.sig`), so a presentation PUT adds one pool call only when a
pre-rendered slide changed; pictures are `prerenders` rows (first upload wins, the operator's replaces, a live
service pauses all but its own keys: 503 `paused_during_service`), and the goLive bundle lists them
(`slideHeads`, `prerenders`, `prerenderKeys`, design/12 "HTTP API").

**Keys computed at save.** The pool computes each pre-rendered slide's key and stand-by id when a presentation is
saved, into `prerender_keys(presentation_id, rev, slide_id, key, standby_id)`; a background job recomputes the rows
a font or media change affects (never while live). The upload check, the goLive listing and the live process's
check of `prerender.add` (membership in the key set the goLive bundle carries) are index lookups. Nothing parses
revisions to check an upload: the History list parses every kept revision whole today (`library.ts:414-425`), and an
import's bake uploads several pictures per detailed slide back to back while a Go live waits at most 1.5 s for the
library (`librarylink.ts:57`).

**Pictures.** `PUT /presentations/:id/prerenders/:key?size=3840|1920|640` (edit role), grown from
`add91d9:apps/hub/src/plates.ts`:
- the key must be in `prerender_keys` for the presentation (current or a kept revision: a bake of a version just
  overtaken still lands);
- PNG or WebP header (`pictureHeader`), not animated, exactly 3840x2160, 1920x1080 or 640x360, at most 32 MiB
  (`add91d9` `PLATE_LIMITS.bytes`);
- refused from capped (phone) sessions; the operator app never bakes on a compact layout (the hub cannot see one);
- the first upload wins (a second for the same key answers 200 and is dropped), except that an upload from an
  operate session (the venue PC) replaces one an edit session made when its pixels differ (§1.4 trigger 5), never
  while live; the Drawing card shows "Picture made on <device>, <date>" (`made_by`);
- while any service is live, accepted only for keys of the live service (the go-live bake); any other answers 503
  "paused during the service" and the baker retries after End service plus 2 minutes; the hub sends `prerender.add`
  for every accepted picture of the live service;
- "Make picture again" (edit role) deletes the row for its key first; on a live-locked presentation it waits until
  End service;
- counted in the presentation's budget (below); past it 507 with a reason;
- a failed bake is recorded, `prerender_failures(key, reason, made_by, at)`: bakers skip a key that failed with this
  `PRERENDER_VERSION` until "Make picture again", so each Go live and editor open does not spend another 60 s on the
  same hostile slide (W36).

Table `prerenders(presentation_id, slide_id, key, standby_id, version, kind, size, hash, mime, bytes, w, h, opaque,
made_by, last_rev, created_at, PRIMARY KEY (presentation_id, key, size))`; `GET /presentations/:id/prerenders`
lists keys and failures so a baker skips what exists. Picture rows never travel in library deltas (a picture upload
during a service would make the venue PC's core clone the whole library a second later, `libraryStore.ts:255-263`);
the editor reads bake status from the bake service's events and this listing. Trust is that of SVG stills
(`PUT /media/:id/still`, `routes.ts:873-884`; `checkRaster`, `apps/hub/src/media/service.ts:283-303`): the hub checks
shape, never pixels; the venue PC's re-bake bounds the rest.

**Collection with revisions** (storage mechanism M7). A slide page or head, picture or shape file is kept while any
of these names it: the current presentation, a kept revision (newest 50 or 30 days today, `library.ts:384-412`), a
live-locked presentation, a cached goLive bundle, a `live_resolved` row (§2.3 M2), or a backup manifest still
within the 30-day backup retention. Backups are the database plus the immutable files it names
(`apps/hub/src/backup.ts:156-163` lists every file row; `docs/design/12-hub.md:371-377`), so without the last rule
restoring a two-week-old backup would bring back slides whose files are gone. Collection runs only when it can read
the live process's references (bundles in `live.db`, `live_resolved`); while the live process restarts it keeps
everything. A restore reports slide files missing per presentation (W66). Today `fileReferenced` looks at current
rows only (`library.ts:530-536`) and geometry files are never released at all (`store.release` is called for
media, fonts, the LibreOffice PDF and the scene only). Revisions store the inline presentation, so they share files
by hash.

_As built in r2b sub-wave 2:_ collection runs in the library process only, nightly at 04:00 venue time and 10 minutes
after the start, in report mode by default (`ORDO_COLLECT`, OQ-PS2), over the `application/json` files only. What
names a file is the references index (`file_refs`: intervals of revisions per presentation, a head's pages and
`uses`, picture rows) plus the current rows and unfinished jobs; the rest of the list above is replaced, until
live-by-ref exists, by two rules: nothing runs while a service is live, and a file nothing names is kept **30 days**,
never less than the backups' retention, which makes every backup within retention list it without reading a
manifest. A file named again loses its mark; the last check and the delete are one synchronous transaction. A
pass has no way to delete a file the live process holds: it does not run then. See design/12 "Storage".

**Per-presentation budget**: the owner's 1 GiB, widened from plates to every file only this presentation's
revisions hold (pictures, slide pages, shape files), counted in unique bytes. Past it: older revisions' pictures
are dropped first, then the newest slides get no stored picture and are drawn by the screens (W29). On the
synthetic worst cases 1 GiB holds about 50 to 135 slides' 4K + 1920 pictures with their old versions; real pictures
are expected far smaller (text and decoration slides compress well) and must be measured (§1.13). Drawing `tail`
slides from their files by default (owner question 10) keeps the budget, W29 and the go-live bake scaling with
detailed slides, not with the length of a hymnal. Revision bodies have their own cap, 64 MiB a presentation
(design/28 P2, `28-mobile.md:715`): bodies are stand-ins; the files they name count in the 1 GiB.

**Free-space floor** (design/28 P2, `docs/design/28-mobile.md:721`, not built; prerender-store builds it and the
phones lane's P2 reuses it): max(5 GiB, 5 %) of the data volume, because `live.db` shares it with uploads and
pictures. Below it uploads, imports and picture uploads answer 507 and the hub reports it (W44).

### 1.4 Making pictures

**Where**: a bake worker (`apps/operator/src/workers/bake.worker.ts`, grown from
`add91d9:apps/operator/src/workers/plate.worker.ts`), only where `canBake()` holds: desktop Chromium, fine pointer
(`apps/operator/src/lib/capabilities.ts:57`), not a compact layout, not the Pages demo (no picture routes; it draws
live), not iPadOS until a WebKit parity probe passes. While any service is live (the hub's mode is live), only the
go-live bake runs, on the computer that went live; every other computer queues its bakes until End service plus
2 minutes (the pacing rule of phones P0, `apps/hub/src/pacing.ts` on `p0/integrate`), and the hub refuses their
uploads meanwhile (§1.3).

**How**:
- The outputs' renderer and prepare steps (tables, decoration, geometry files, slide pages), fonts through
  `FontResolver` as in the thumbnail worker (`thumb.worker.ts:117-127`) with the bake font profile (§1.2), the
  asset worker's 2D context options (`asset.worker.ts:253`), so the CPU raster path that draws live draws the
  picture.
- The **bake profile** instead of the live clamp: `drawSlide2D` clamps every slide to 200 objects and 16 pictures
  today (`text2d.ts:737` calls `clampSlide`, cut at `clamp.ts:876-882`); the bake passes an explicit profile that
  live-frame adds to `clampSlide`, so every object of the slide file is drawn, pictures decoded at full size one at a
  time and released, 256 font families and size scales a box (live: 16 and 64, `clamp.ts:84-86`), no drawing or
  effect budget, no unit area, no legacy copies. Each draw call stays within the per-call bound shared with the
  outputs (§2.3 R5).
- **Complete or nothing**: a page not readable, a font that failed to load or a part past the bake's bounds aborts
  that picture; nothing is uploaded and the failure is recorded on the hub (§1.3). A slide waiting for the
  LibreOffice follow-up (`pptx.pending`) is not baked until the follow-up has written its art.
- **Every slide with `prerender` gets a picture**, whatever its Draw as says, so a switch to Pre-rendered, or the
  operator's "Use the picture for this slide during this service" (§1.7), takes effect at once.
- **Bake bounds** (hostile input only): the slide file's bounds; one 3840 canvas (33 MB) plus effect layers within
  `EFFECT_MAX_PIXELS`; 60 s wall clock a picture, after which the worker is terminated (the import worker's
  deadline pattern, `apps/operator/src/services/pptxParse.ts:22`) and the slide stays drawn by the screens (W36).
- Encode in the worker (`convertToBlob`): the 3840 picture, the 1920 copy from it and the 640 preview; upload
  through the resumable path when large.

**Triggers**:
1. After an import, in the importing operator app once the job has ended and no slide is pending (the client path
   holds the deck; the hub path fetches the slide pages).
2. About 3 s after each save in the editor, for slides whose key changed (bake-on-save P3).
3. An input that changes keys without a save (a font uploaded or replaced, a picture's file replaced, a new
   `PRERENDER_VERSION`): re-bakes are queued at once on every online desktop with ordo open (never during a
   service), not only at the next editor open or Go live. Stand-bys cover fonts and versions meanwhile; a replaced
   picture file has none, so those slides are drawn by the screens until remade.
4. Go live on the venue PC: the playlist's missing keys, in cue order from the live cue.
5. Setup's "Prepare pictures for the next service", or an idle desktop with the library open: also re-bakes, on the
   venue PC, pictures other computers made and replaces those whose pixels differ (§1.3).
6. After a re-import, Reset slide or Make editable job ends, in the app that asked for it.

**Queue**: one picture at a time at idle priority; keys the hub has, or that failed, are skipped. The **go-live
bake** shares the venue PC with the output windows, and browsers give a worker no thread priority, so: PNG only
(a lossless WebP encode took 4.4 s at 3840, one call that cannot be split; a WebP re-encode, if kept at all, happens
later on an idle desktop), the 1920 copy made and uploaded first, one worker at about half a core between draw
steps that each stay within the per-call bound, a 2 s pause after every GO, a pause while any screen reports late
flips (`OutputHealth.lateFlips`, which reacts only after a GO was late); the hub announces each picture it accepts
with `prerender.add`.
It ships switched off on Setup ("Make missing pictures during the service", W45; owner question 13) until §1.13
measure 2 passes on a venue-class PC.

### 1.5 What stays live above the picture

- **Anchors**: the lyric box (`lyricObjectId`); text with build steps (`TextPara.hidden`, `schemas.ts:417`); every
  picture that plays (`ImageObject.play`, :561: in-slide video, a motion background inside the slide); the props
  layer (clock, countdown) is already a layer of its own.
- **Live set** = the anchors plus every object above an anchor that overlaps it, or overlaps an object already live,
  with shadows and glows in its reach: `splitScene`'s rule (`packages/renderer/src/scene.ts:441`), built and
  golden-tested for in-slide video. Everything else is in the picture, under the live set. That is exact for
  source-over drawing.
- **Only anchors count** toward the live-raster bounds. The static objects of the live set are drawn by the screens
  in the layer above the anchors, directly when they are within the live counts and in slices like a live frame
  (§2.3 R1) when they pass them, so none of them is left out. Past 200 anchors or 16 playing pictures (no real slide
  comes near), the excess step-by-step text goes into the picture and shows from the first step, and playing
  pictures past 16 show their still picture (W24).
- **One picture a slide** in r2b. Pictures of the static runs between anchors (at most 4 a slide) are left until a
  slide is measured where the static objects above its anchors are themselves costly to draw.
- **Static text is in the picture** (owner question 3, default yes), as it was in LibreOffice's page: at 4K it is
  the live drawing; on a 1080p screen the 1920 copy. "Text shadows and glows stay live" is read as the rule for
  ordinary slides, whose plates never hold text.
- **Background override** (`withoutBackdrops`, `content.ts:112-136`: a playlist item's background replaces the
  slide's own colour): that cue draws the variant `backdrops: false` (alpha, PNG), made at Go live for the items
  that have one (owner question 5). Only the go-live bake makes that variant, so it stays dormant until the
  go-live bake is switched on (§1.4, §1.13 measure 2): meanwhile such a cue draws the full slide live, and the
  Go-live check says so (golive-warnings).

### 1.6 The fallback chain

**Outputs.** The link worker chooses the form when it plans a job; the asset worker draws it.
1. **Picture** (the current key, else a stand-by with the same `standbyId`): a new picture-file form,
   `SlideDrawing.picture = { hash, w, h }`, which the link worker's plan picks from `resolved.prerenders` and
   `state.prerendered`. `slideContent` is pure and returns a media id (`packages/domain/src/content.ts:52-61`), and
   whether a picture file exists is known only to the link worker, so `slideContent` gains only the shape that draws
   the live set over a picture, and the media listers (`referencedMediaIds`, `slideImages`, `previewMedia`) skip it.
   The drawers keep one drawing path (`drawSlide2D`, `text2d.ts:736-760`).
2. **The full slide drawn live from its file**: a prepare step reads the head, then one page a lane turn (about
   1 ms each, under `SLICE_MS`), and swaps the stand-in for the file's objects. Past a live count the static objects
   are drawn into a **live frame** in slices (§2.3 R1), so nothing is cut, only late. A live frame has a time budget
   per slide (D12): past it the screen shows the stand-in with a health line (W46). When the stored picture arrives:
   a ~0.3 s fade if the slide is on screen, a silent swap if it is only armed.
3. **Stand-in**: neither file nor picture is on the screen: the stand-in, with a health line while they download
   (W46) or a degraded line when the hub lacks the file (W40).

A GO waits on none of these. A jump to a pre-rendered slide that is not armed or warmed decodes its picture off
the asset worker's thread (measured: 145-210 ms at 3840, 27-50 ms for the 1920 copy; a 1 ms ticker in the worker
kept running, longest gap 4-10 ms): the flip shows the slide's backdrop and live set at once and the picture fades
in, from the 1920 copy first on a 4K screen. To keep jumps inside a song or deck on time, the 1920 copies of the
live item's pre-rendered slides are decoded ahead in a share of the bitmap cache (`bitmap-cache.ts:11`, 256 MiB)
that is evicted first and shrinks under pressure, at most 64 MiB, sized by measure 3; the armed and warmed cues
hold their full-size picture as today, and the pictures ordinary cues and live sets decode keep the rest (a cue may
hold 192 MiB, `clamp.ts:63`).

**Editor**: edits the full slide from its file (§1.8); the slide grid and previews show the picture or the stand-in;
a missing file shows the stand-in read-only with W27.
**Thumbnails and the library grid** (desktop and iPad): the 640 preview, else the full slide (desktop), else the
stand-in; never a 1920 copy decoded small (`thumb.worker.ts:96` decodes at 640 from the whole file).
**Stage**: reads the stand-in's text; any slide picture it shows follows the outputs' rule.
**Phones**: the 640 preview only, never the 1920 or 3840 copies (a 1920 copy is 1-4 MB and an 8 MB bitmap: design/28
budgets a song open at 300 KB, `28-mobile.md:1096`, the phone cache at 150 MB, :866, and the heap at 300 MB, :1098).
The preview is on design/28 P1's view whitelist for `GET /files` (:709); slide pages are never served to view
sessions. A pre-rendered slide is read-only on a phone (W57; owner question 6).
**Older build (0.8.1 or 0.5.0 after a rollback)**: strips `prerender`, `draw`, `cut` and `meta.draw`, draws the
stand-in.
**Hub without its library process**: the live process serves the live service's slide pages and pictures from its
index (`apps/hub/src/liveproc.ts:227-237`).

### 1.7 Outputs: fetch, cache, fade, overrides

- goLive lists `ResolvedPlaylist.prerenders?: { presentationId, slideId, key, size, file, standby? }[]` (the newest
  picture per slide, variant and size; `standby` marks one found by `standbyId`, W39), carries the service's key set
  for the live process's checks, and puts slide heads and pages and every `uses` entry in `files` and the manifest,
  media of `uses.media` as optional like a reference picture (`goLive.ts:238-251`), so a missing one is a degraded
  line, never a refusal. Files are listed in cue order from the first cue; past 20,000 listed files
  (`GOLIVE_GEOM_FILES_MAX`, `goLive.ts:408`, which today skips the rest silently, :429) the rest are not listed and a
  critical line says so (W60).
- A screen fetches only the sizes it draws: up to 1920 wide the 1920 copy, wider both.
- Fill order (`link-core.ts:1692`, today fonts, images, then the rest): fonts, then pictures in cue order from the
  live cue, then the pages of slides that have no picture, then the rest (videos), then the pages of slides that
  have a picture (needed only if a picture fails, or for a background-override cue without its variant), which are
  left out of the readiness percentage the checklist waits for (`checklist.ts:27`, "Cache shows 100 %").
- During a service a picture the venue PC makes arrives as the live event `prerender.add { presentationId, slideId,
  key, size, file }`: the hub sends it for every accepted upload of the live service's keys (membership in the
  bundle's key set, §1.3), the reducer keeps it in `state.prerendered` (bounded like `geoms`), never in `resolved`,
  which stays immutable for the service (§2.3 M2); the live process adds it to the files it serves.
- **Use the picture during this service**: the live-only event `prerender.use { presentationId, slideId }` (operate
  role) makes a slide set to Live draw from its picture until End service. It changes nothing in the presentation
  (which is locked while live, `routes.ts:497-500`), is journaled, travels with the hand-back state, and is kept in
  `state.drawOverride` (bounded like `geoms`). W35 and W48 offer it.
- A late picture or slide page fades in (`rearmMissing`, `link-core.ts:1766-1799`, is a cut today), through the
  same fade r2b's effect-units builds for late units (`refreshFadeMs` 300, `stacks.ts:153`).
- Health gains `picturesMissing`, `picturesLate`, `liveSlow`, `frameOverBudget` and the storage estimate (§3).

### 1.8 Editor

- Opening a slide with `prerender.file` loads its head and pages (Cache API `ordo-files`, as thumbnails read
  files) and edits the full slide; the stand-in is rebuilt from it on save by the same domain function the import
  uses (`standInOf`).
- **Every slide writer goes through the full slide.** On a pre-rendered slide `slide.objects` is only the stand-in,
  so an operation that edited it would be thrown away at the next save of that slide, or shown on Stage and in
  search but never on the screens. One domain helper, `withFullSlide(full, fn) → { pages, standIn, key }`
  (prerender-model), and its operator loader (prerender-editor) load the file, apply the change to the full slide,
  write new pages and rebuild the stand-in and the key. Every operation that changes slide objects outside the
  canvas uses it: Find and replace (`ops/slides.ts:215`), replace background for one or all slides (:390, :411),
  apply style to similar (:590), new slide like this (:686), use as background (:745), reset to theme (`ops.ts:440`,
  from `SlidePanel.tsx:190` and `SongReflowEditor.tsx:463`), duplicate (`ops.ts:123`), split (:170, :215), the Lyric
  Script split (`songScript.ts:129`), and copy and paste of slides and objects (`ops/clipboard.ts`). Each has a test
  that fails before (replace the background of a deck with 3 big slides: the pages and keys change, and the screens
  show the new background). During development an operation not yet converted refuses on pre-rendered slides;
  `prerender` leaves `M9_HELD_BACK` only once all are converted (editor-slideops), so volunteers never see a refusal.
- Save (`editorStore.ts:243-302`): changed pages and heads first (`PUT /files/slide/<hash>`), then the presentation;
  then the bake trigger. A 409 merge of two edits of one big slide merges the two files' objects (`mergeThreeWay`)
  and writes new pages; the key follows.
- The add refusal at 200 objects / 16 pictures (`ops/slides.ts:31-58`) becomes a notice (W25): the add goes
  through and the slide becomes `count`. A paste is no longer cut at 200 objects (`CLIPBOARD_LIMITS.objects`,
  `ops/clipboard.ts:45-51`): it takes up to the slide file's 20,000 under the same rule.
- `saveSizeCheck`'s 4 MiB warning (`apps/operator/src/lib/sizes.ts:61-65`) goes: the save applies the import's rule
  (big slides and inline-budget overflow go out of line); W31 only if the stand-ins alone pass the budget.
- A **Drawing** card in the slide panel, beside "From PowerPoint" (`PptxSlideCard.tsx:187-250`), shown on a slide
  with `prerender` and under More for any slide: "Draw as: Pre-rendered (recommended) | Live" (W19), the status
  line (W20), the Live warnings (W21-W24), "Picture made on <device>, <date>", "Make picture again". The
  Presentation panel holds "Detailed slides: Pre-rendered (recommended) | Live" with the count of slides it applies
  to; switching it to Live shows how many are estimated over 0.3 s and over 3 s at 4K and asks for confirmation when
  any is over 3 s (W62). Until a screen has reported its speed (R4), estimates use a conservative venue-PC factor,
  not 1. A slide-grid badge marks Live detailed slides and slides without a picture.
- Saved on a device that cannot make pictures (phones, compact layouts, iPads, Safari, Firefox): W26, and W20 says
  where the picture will be made instead of "being made again".
- **Editing cost.** The canvas has one Konva node per object, each cached up to 8 MP (`NODE_CACHE_MAX_PX`,
  `SlideCanvas.tsx:350`), a memory risk on an iPad with a 6,000-object slide. Measured on slides of 340, 1,000 and
  6,251 objects on a desktop and an iPad (open, select, drag); past the measured bound the editor shows W63 and
  opens imported groups locked.
- Previewing an unsaved big slide on an idle screen uploads its pages first; the preview carries stand-ins and
  references (`previewSlice`, `size.ts:639-688`), never bodies.
- The editor canvas draws the full slide on a desktop (r2b leaf-editor's `wholeDraw.ts` rule); the bake
  profile is never used in the editor canvas.

### 1.9 Hubs with LibreOffice

`pageForBudget` and `toPicture` for size go (owner decision 2026-11-14, 2): a big slide is native with ordo's
picture on every kind of hub, and keeps its video, motion background and lyric box. The guard's left-outs that the
2026-11-13 decision gave to LibreOffice's art (`budget.ts:493`, `toArt`) are a count limit too, so those slides
become `count` slides (owner question 2, default yes). "Show original" (`Slide.pptx.refMediaId`, `show`) stays on
demand.
- **Tables were not decided here.** r2b tables-conv's interim rule kept LibreOffice's page for a table slide whose
  M6 group form passed 64 KB, until the LibreOffice inventory's question 3 (is a table slide native on a hub with
  LibreOffice?) was answered; ordo's picture cannot close a fidelity gap, since it has the pixels of ordo's live
  drawing. _Decided since:_ the owner answered question 3 on 2026-11-15 ("prioritize native tables"): every table
  is the table object on every kind of hub, the 8 dense slides included, and the gate becomes a fidelity target;
  sub-wave 1b (tables-flip) removed the interim rule and its second emission, so prerender-import finds no table
  rule.
- **The follow-up writes the full slide.** On hubs with LibreOffice the pptx-lo follow-up still draws charts,
  SmartArt, OLE objects and metafiles; `patchSlide` (`apps/hub/src/pptx/fallback.ts:347-427`) decides "unedited" by
  `digestMatches(slide.objects, …)` (:350) and patches inline objects. For a big slide it reads and writes the slide
  file in the pool (the digest covers the file's imported objects), and the bake waits for it (§1.4).
- **Make editable** on a stored 64 KB LibreOffice page (from before this design) routes to the native per-slide
  re-import, so it becomes a big slide; today `makeEditableNative` returns nothing for a slide with `pptx`
  (`apps/hub/src/imports.ts:751-757`) and `makeEditable` lays text boxes over LibreOffice's picture (:760-806),
  which leaves LibreOffice inventory item C4 open. A table page an older import stored becomes the table object
  on a re-import or Reset slide since sub-wave 1b (tables-flip); Make editable on it is tables-cells' (1b).
- No LibreOffice stand-by (owner question 12, default no): a big slide whose picture no computer has made yet is
  drawn by the screens themselves, not shown as LibreOffice's page meanwhile.

### 1.10 Import report

The report (`PptxReport.tsx`; `importReport`, `apps/operator/src/lib/pptxImport.ts:569`) and the import card
(`PptxImportCard.tsx:239-245`) say what was pre-rendered and why, with progress until "Pictures ready" (W1-W4),
critical lines at the top (W5, W8-W14, W18, W64), and migration (W6). The slide card (`Slide.pptx.notes`) repeats
the slide's own line. Each critical line also writes a slide note (`Slide.pptx.missing`, or `Slide.cut` for slides
not from PowerPoint) that the Go-live check repeats. The ProPresenter report gains W4 for its count slides, W64 and
W65. The texts that go: "slide n is over 64 KB: LibreOffice draws its page" (`pptx-core.ts:496`), "simplified to
fit the slide budget: … left out" (:528), the tail and 200-character notes (:537-576).

### 1.11 Protocol and version

New: `Slide.prerender`, `Slide.draw`, `Slide.cut`, `meta.draw`; `ResolvedPlaylist.prerenders` and its key set;
`state.prerendered`, `state.drawOverride`; `prerender.add`, `prerender.use`; `hello.resolvedId`, `live.state`
without `resolved` when the client holds it, `live.adopt` by reference (§2.3 M2-M3); the prepare request and its
progress (M8); `library.poke` for every client (M4); health fields (§3). One `APP_VERSION` bump in the PR that
carries them, digest re-recorded once by the integrator (design/24); stale tabs reload.

`prerender.add` is applied by the hub only. `LiveCommand`, what a client's `live.event` (`packages/protocol`) and
`POST /live/events` carry, is `GoLiveCommand` or a `LiveEvent` other than `prerender.add`, so no socket can send
one: the hub applies it through `LiveService.apply` for each accepted upload of the live service's keys
(prerender-store, bake-worker), and every client reduces it from `live.delta`. `prerender.use` is an ordinary
command of the operate role (outputs, Stage and edit sessions are refused as for every command).

**The one pre-render switch.** `PRERENDER_ON` (`packages/domain/src/prerender.ts`, false) is read by every
pre-render path: the import plan (`prerender` in `M9_HELD_BACK`, tied to the switch by a test), the editor's
Drawing card (hidden while off, so no slide gets `why: 'chosen'`), the bake triggers (§1.4), the outputs' picture
form (off: the slide is drawn live) and the operator's `prerender.use`. Each path is tested both ways in the track
that builds it; if the gate of §4 fails, they all stay off together. Converter fields stay out of
`M9_WRITES` until their drawers are merged (`packages/pptx-scene/src/version.ts:23-33`): prerender-import adds
`prerender` to `M9_HELD_BACK`; the integrator removes it only once prerender-outputs, prerender-editor,
editor-slideops, hub-writers, golive-warnings, golive-prepare and live-by-ref have merged, so pre-rendered slides
never ship without their Go-live check lines, their editor operations or the GO-path fixes. With it held back
imports keep today's ladder. `CONVERTER_VERSION` becomes 3 with the plan change (for migration).

### 1.12 Migration and rollback

- Stored presentations are unchanged: no `prerender`, drawn as today.
- Slides an older import simplified carry the ladder's note (`pptx-core.ts:528`), LibreOffice's page for size
  (:496) or the tail note. The PowerPoint report counts them (W6) and offers "Re-import from PowerPoint": the
  re-import job (`apps/hub/src/pptx/reimport.ts`) regenerates every unedited slide (its imported objects still match
  `Slide.pptx.digest`) with `CONVERTER_VERSION` 3, so it becomes a big slide; an edited slide is kept and named.
  It is a new revision History can restore, needs the stored deck (`source.fileId`) and is refused while
  live-locked, as today.
- **Hub-side writers use the full slide.** For a big slide, `Slide.pptx.digest` covers the imported objects of its
  slide file, not the stand-in, so re-import, Reset slide (`PptxSlideCard.tsx:91-96`) and `patchSlide` read and
  write slide files in the pool. The merged presentation is planned again (a merge can pass 3 MiB; today
  `reimport.ts:932-934` only logs), and the requesting app bakes the changed slides when the job ends.
- Rollback to 0.8.1 or 0.5.0: the stand-in draws; a save there drops the link to the file, which collection keeps while a
  revision names it, so restoring the version from before the rollback brings it back (design/27 §3.2 rule).

### 1.13 Tests and measures

Tests (each fails before its change):
- domain: keys (font, media and version changes give new keys; id, origin and lock do not), `standbyId` (fonts
  and version change the key, not the stand-by; a media file replace changes both), `pictureUnits` reasons at the
  3840 reference, `standInOf` (live objects whole, caps, notes untouched, 70 KB of text split into boxes of at most
  20,000 characters), slide pages (a 2,000-object slide is 4 pages; one changed object changes one page and the
  head), `withFullSlide` (an operation on a big slide changes its pages and key, never only its stand-in),
  `schemas.prev` (0.8.1, as 0.8.0, and 0.5.0 strip the fields and draw the stand-in; `meta.draw` does not make a
  save refuse);
- hub: a key not in `prerender_keys` is refused; wrong size, animation or over 32 MiB refused; first upload wins
  and an operate-session upload with different pixels replaces an edit-session one; during a service an upload for
  another presentation answers 503 and one for the live service is announced with `prerender.add`; a failed key is
  skipped until "Make picture again"; 507 past the budget and below the floor; collection keeps files named by
  kept revisions, bundles, live-locked presentations, `live_resolved` and backup manifests within 30 days, keeps
  everything while the live process is unreachable, and releases geometry files otherwise;
- live: GO during a slow mid-service Go live flips within the lead, and the old service keeps running until the new
  one is prepared; changing a clip's trim between two goLives of one playlist gives a new `resolvedId`, and a screen
  holding the old copy receives the new one;
- outputs: a 16 MiB slide file armed while GO is pressed: GO-to-flip within the lead, no step over `SLICE_MS`;
- renderer: one slide baked with and without a system font installed gives identical pixels;
- editor: each converted operation of §1.8 on a deck with big slides; the 201st object and a 300-object paste are
  kept and the slide becomes `count`;
- hub writers: a big hybrid slide on a hub with LibreOffice gets its art in its file; re-import regenerates an
  unedited big slide; a ProPresenter slide with 20 pictures is pre-rendered;
- e2e `prerender.spec.ts` on both kinds of hub: a synthetic deck with a slide over 64 KB, a 340-object slide and a
  video slide over 64 KB; import through the Import tab, "Pictures ready", Go live; the Audience screen matches the
  live drawing; a GO before the picture shows the slide live and the picture fades in within 1 s; the video plays
  above the picture; Live set in the editor draws live, and "Use the picture for this slide during this service"
  switches it without a save; on the LibreOffice hub no LibreOffice page is made for these slides; a phone shows
  the slide read-only and fetches only 640 previews (bytes recorded); the Pages demo draws a big slide whole.

Measures (gates in brackets):
1. **Fidelity on the 16 big slides of E**, each in the form it will have: the 5 decorative and 3 plain text slides
   as big slides, ordo's picture against LibreOffice's reference on a hub with LibreOffice [each ≥ LibreOffice's
   page − 0.02, mean ≥ − 0.005: M9 decision 2's gate]; the 8 table slides are not big slides (table objects within
   64 KB, native on every hub since sub-wave 1b; question 3's gate is their fidelity target, measured with the
   tables, not here); without LibreOffice against today's stored slide [up; today minimal 0.776,
   plain 0.345 by kind]. Pixel parity of the picture against the live full drawing at 3840 [≤ 1/255, alpha rounding
   aside] and the 1920 copy against live 1080p [SSIM ≥ 0.99 on text].
2. **GO timing** on a venue PC with 2 and 4 Audience windows: GO-to-flip p95 and `lateFlips` with and without the
   PNG-only go-live bake running [no change on armed cues: until it passes, the go-live bake stays off]; a jump to an
   unwarmed pre-rendered slide [flip on time; picture faded in within 0.1 s from the 1920 copy, 0.3 s at 4K].
3. **Memory**: asset-worker bitmap and unit cache peaks with live, armed and warmed 4K pictures and the 1920 share
   [within 256 and 192 MiB]; the bake worker's peak; the pool's parse, check and heap for 16 MiB of pages [the
   slide-file cap is set from it]; the output link worker's IndexedDB write after M2 [independent of service size].
4. Bake time per slide at 3840 (draw, decode, encode) on a laptop and a venue PC, for the big, crowded and 20 slow
   slides and the sermon decks as a control (counts only); the go-live bake at about half a core [time to fill a
   typical service's missing pictures].
5. Picture bytes on real slides by kind and per deck (sets the 1 GiB budget's reach, the screens' storage and the
   picture uploads' share of design/28's write budget).
6. Hub: save-time key computation and the upload check for a 2,000-slide presentation with 200 kept revisions; the
   go-live fill time of a typical service's pictures.
7. WebKit parity probe (filters, gradients, text) before iPads bake.
8. **Worst-case single object** at 3840 with every per-object clamp (C5, C16) at its hostile maximum: a full-frame
   shape with a 500 px glow composed from reduced layers, a 20,000-character box, 8 paths of 4,096 points with
   0.5 px dashes, 16-stop gradients [longest draw call ≤ 50 ms, target 10; the clamps are tightened until it
   passes]; a 20,000-object live frame [the per-slide frame budget D12 is set from it].
9. **Live-process lag** p99 during a service with picture uploads and downloads [design/28's 5 ms gate].
10. Every remaining bound has a measure that sets it: 20,000 objects a slide file (live-frame and bake benches at
    20,000 objects), the 30 s prepare ceiling and the 5 s offer (golive-prepare), the resolved-size ceiling
    (golive-prepare), 50,000 shapes a slide and 1 GiB of declared XML (xml-compact), 10,000 slides, 2 h of pool time
    and 512 MiB of shape files an import (import-scale), the 4 MiB and 128 MiB queue caps (library-light).
11. Editor: open, select and drag on slides of 340, 1,000 and 6,251 objects on a desktop and an iPad [sets W63].

## 2. Limits

### 2.1 How each limit was judged

Each limit was asked what it protects and what happens to a service or to content when it is hit. Verdicts:
**remove** (it protects nothing once a mechanism exists), **replace** (a mechanism does its job without cutting
content), **raise** (it stays a hostile-input bound, set from the largest real case with margin), **keep** (it
bounds hostile input, disk, memory or one live raster, and nothing real comes near it, or its hit is lossless).
Reach figures: E after r2a (275 decks, 2,893 slides), the golden census (112 decks, 1,071 slides), 7,072
distinct corpus decks (central directories read, nothing inflated), the LibreOffice inventory. Track names are §4's.
The Warning column names §3's entries; their words are there. "Crit." says whether that warning is critical.

### 2.2 Every limit

**A. Storage and transport**

| #   | Limit (value; where)                                                                                                                                           | When hit today                                                              | Verdict                     | New value or mechanism (track)                                                                                                                                                                                                                                                                                                                                 | Warning           | Crit. |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----- |
| A1  | Slide budget ladder, 64 KiB (`size.ts:32-36`; `fitSlideBudget` :314-361; `pptx-core.ts:441-583`; `pptx-ladder.ts:185-246`)                                     | formatting or decorations dropped                                           | replace                     | 64 KiB only decides "own slide file"; picture by default (`bytes`); grid step kept (prerender-import)                                                                                                                                                                                                                                                          | W1, W4            | no    |
| A2  | LibreOffice page for big slides (`pageForBudget` `pptx-core.ts:426-431`, `toPicture` :490)                                                                     | empty until drawn; video, motion background, lyric box lost                 | remove                      | ordo's picture; Show original on demand (prerender-import)                                                                                                                                                                                                                                                                                                     | W1                | no    |
| A3  | Presentation tail, 3 MiB / 4 MiB (`size.ts:37-43`; `planImportSizes` :157-198; `pptx-core.ts:537-542`)                                                         | later slides keep text, pictures, background                                | replace                     | largest slides out of line first (`tail`), kept whole in slide files and drawn by the screens from them; a picture only when one would be slow (owner question 10); 3 MiB stays the inline trigger until M2, then re-measured upward (prerender-import)                                                                                                        | W3                | no    |
| A4  | Last resort: 200 characters a box, page text boxes dropped (`pptx-core.ts:90`, :543-576; `size.ts:371-372`; `pptx-ladder.ts:195`, :206; `fallback.ts:776-783`) | text cut                                                                    | remove                      | text lives in slide files; only a stand-in's Stage/search text may shorten, past the inline budget (prerender-import)                                                                                                                                                                                                                                          | W5                | yes   |
| A5  | Editor save warning, 4 MiB (`apps/operator/src/lib/sizes.ts:61-65`)                                                                                            | warns, saves                                                                | replace                     | the save applies the import's rule (prerender-editor)                                                                                                                                                                                                                                                                                                          | W31               | no    |
| A6  | HTTP body `putMax` 32 MiB (`size.ts:55-56`; `http.ts:104`; refusal `sizes.ts:56-60`)                                                                           | save refused                                                                | keep                        | hostile bound for every JSON body (0.4-1 s of parse and check at 32 MiB, measured); M1 makes saves small; measure, then consider 16 MiB                                                                                                                                                                                                                        | W32               | no    |
| A7  | Slide file (new): 16 MiB and 20,000 objects a slide, in pages of 256 KiB or 500 objects (`PUT /files/slide/<hash>`; `pool.ts:74`)                              | —                                                                           | keep (new)                  | about 100× the largest real slide (101-155 KB); pages, so an output parses one at a time (`geom/stored.ts:166-173`, `lanes.ts:21-23`); set from measure 3 and a 3840 bench on a venue-class PC (prerender-model, prerender-store)                                                                                                                              | W18               | yes   |
| A8  | Stand-in text `ART_TEXT_MAX` 20,000 characters (`size.ts:120`, :218-230)                                                                                       | search text cut                                                             | keep                        | lossless now: the full text is in the file                                                                                                                                                                                                                                                                                                                     | —                 | no    |
| A9  | Preview: 1 MiB shaping, 15 MiB refusal (`size.ts:44-45`, `previewSlice` :639-688; `sizes.ts:28-48`; `PreviewControl.tsx:28-45`)                                | preview narrowed or refused                                                 | replace                     | stand-ins and references; an unsaved big slide uploaded first (prerender-editor)                                                                                                                                                                                                                                                                               | existing toast    | no    |
| A10 | Takeover warning `resolvedWarn` 12 MiB (`size.ts:46-47`, :697-704; `goLive.ts:284-286`)                                                                        | degraded line                                                               | replace                     | a goLive ceiling on the running service's size (D13), measured on a venue PC: the live process parses and checks every presentation at goLive (`goLive.ts:85`, run by `live.ts:287-296`) and every screen saves the copy once; above the ceiling Go live is refused, above the size that costs a screen more than the GO lead a critical line (golive-prepare) | W58, W59          | yes   |
| A11 | Hand-back `adoptMax` 15 MiB (`size.ts:48-52`; `liveCore.ts:527-567`; notice `engine.ts:1154-1165`)                                                             | service stays on the PC to End service                                      | replace                     | M3 hand-back by reference for services the hub started; a service the PC started is still held to End service (`17-offline-and-degraded.md:174-195`) (handback-ref)                                                                                                                                                                                            | — (toast removed) | no    |
| A12 | Operator large message 16 MiB (`size.ts:53-54`; `ws.ts:39`, :143, :255-256, :296-304)                                                                          | socket closed                                                               | keep, then lower            | after M2, M3 and preview by reference, measure the largest legitimate message; then about 1 MiB (handback-ref)                                                                                                                                                                                                                                                 | W51               | no    |
| A13 | Socket message 64 KiB (`ws.ts:38`, :255)                                                                                                                       | socket closed, reconnects                                                   | keep                        | hostile bound; nothing legitimate comes near                                                                                                                                                                                                                                                                                                                   | W51               | no    |
| A14 | Message rate 50 burst, 50/s (`ws.ts:40-41`, :287-294)                                                                                                          | socket closed                                                               | keep                        | a held key repeats about 30/s; MIDI on edges                                                                                                                                                                                                                                                                                                                   | W51               | no    |
| A15 | Full state per (re)connect (`ws.ts:356-370`, :423, :434)                                                                                                       | a `JSON.stringify` of the service per socket on the live loop               | replace                     | M2; first step one string per `seq` (live-by-ref)                                                                                                                                                                                                                                                                                                              | —                 | no    |
| A16 | Snapshots and journal copies (`live.ts:78-80`, :130, :238-270, :385-392; `config.ts:130`)                                                                      | whole service written twice within 5 s of a GO                              | replace                     | M2 `live_resolved` once per service; retention counts kept (live-by-ref)                                                                                                                                                                                                                                                                                       | —                 | no    |
| A17 | goLive bundle fetch 1.5 s, inside the command queue (`librarylink.ts:57`, :163-183, :200-230; `live.ts:365-379`: commands behind a goLive wait for it)         | large playlist live from an old copy, or refused; keys wait up to about 3 s | replace                     | M8: prepared beside the running service, fetched by progress under a 30 s ceiling, checked in a worker; goLive enters the queue only once prepared; while live, the saved copy offered after 5 s (golive-prepare)                                                                                                                                              | W41               | yes   |
| A18 | Cached bundles 8, one row (`librarylink.ts:60`, :220-223, :284-296)                                                                                            | 9th falls out; one-row write re-serialises all                              | keep count, replace storage | one `live_kv` row per bundle, written after goLive; files by reference (live-by-ref)                                                                                                                                                                                                                                                                           | —                 | no    |
| A19 | Library snapshot warn 32 MiB (`size.ts:57-63`; `libstats.ts:46-52`; `library.ts:633-646`)                                                                      | log line; every client loads every body                                     | replace                     | M6 summary-only for phones, iPads and edit sessions (phones P1 lane); venue PC full; gzip                                                                                                                                                                                                                                                                      | W55               | no    |
| A20 | Library deltas without backpressure (`ws.ts:539-563`; `routes.ts:573-584`)                                                                                     | a slow iPad grows live-process memory                                       | replace                     | M4 pokes for every client; queued bytes 4 MiB a socket (plus one resolved copy for clients from before the reload) and 128 MiB across sockets, largest queues closed first (library-light)                                                                                                                                                                     | W52               | no    |
| A21 | Operator offline library, one record (`engine.ts:53`, :174-175; `libraryStore.ts:255-263`)                                                                     | GO keys wait behind a whole-library clone                                   | replace                     | M5 one record per entity (library-light)                                                                                                                                                                                                                                                                                                                       | —                 | no    |
| A22 | Screens' saved live state (`link-core.ts:810`, :815-830; stage `link-core.ts:344-354`; `engine.ts:923`, :964-1018)                                             | each GO clones the whole service (past the GO lead from about 3 MiB)        | replace                     | M2: the resolved copy saved once per `resolvedId`, one record per presentation, after the first flip (live-by-ref)                                                                                                                                                                                                                                             | —                 | no    |
| A23 | Revisions 50 / 30 days, full copies, list parses all (`library.ts:384-412`, :414-425)                                                                          | disk grows                                                                  | replace + keep caps         | M7 shared files; design/28 P2 caps (≤ 200 revisions, 64 MiB of bodies) in unique bytes (prerender-store); summaries at save (library-light, for both lanes)                                                                                                                                                                                                    | W56               | no    |
| A24 | Per-presentation files, 1 GiB (owner 2026-11-13; new)                                                                                                          | —                                                                           | keep (widened)              | pictures, slide pages and shape files unique to its revisions; old pictures first, then drawn by the screens; `tail` slides drawn from their files by default (owner question 10) (prerender-store) **As built (r2b sub-wave 2, prerender-store):** `RefIndex.uniqueBytes` counts the files only the presentation's saved versions name (pages, heads, shape files, pictures, each once; a file two presentations name counts for neither) from the indexes; a picture first drops the oldest versions' pictures (never a current key or a current slide's stand-by), else 507 `budget`; slide files are never refused, they count (the constant is `PRERENDER_BUDGET_BYTES`). | W29               | yes   |
| A25 | Free-space floor max(5 GiB, 5 %) (`28-mobile.md:721`; new)                                                                                                     | —                                                                           | keep (build)                | 507 for uploads, imports, pictures (prerender-store) **As built:** `apps/hub/src/diskfloor.ts`, 507 `disk` on every storing route, `ORDO_MIN_FREE_GB`; the default floor is clamped to 5 to 25 GiB (OQ-PS1: 5 % of a 4 TB NAS volume would refuse every upload under 200 GB free); the live process is never refused. | W44               | yes   |
| A26 | Shape files an import, 32 MiB (`pptx-scan.ts:41-45`; `pptx-core.ts:258`, :446-470; `pptx-ladder.ts:252`)                                                       | shapes left out                                                             | raise                       | 512 MiB, counted in A24 (import-scale)                                                                                                                                                                                                                                                                                                                         | W11               | yes   |
| A27 | Shape files a batch / client scene, 32 MiB (`pptx-scan.ts:46-50`; `pptx-client.ts:435`; `sceneTask.ts:60`; `clientScene.ts:45`; `pptxParse.ts:28`)             | shapes left out                                                             | replace                     | shape files leave the pool message and the scene: own parts, each ≤ 2.6 MB (`schemas.ts:189`) (import-scale)                                                                                                                                                                                                                                                   | —                 | no    |
| A28 | Retention counters (`live.ts:78-80`; `library.ts:39-40`; `ws.ts:23`, :28)                                                                                      | full snapshot or state instead (lossless)                                   | keep                        | M2 makes the fallbacks cheap                                                                                                                                                                                                                                                                                                                                   | —                 | no    |
| A29 | Screens' and operator's file caches: browser quota (`link-core.ts:1823-1895`; `packages/cache/src/index.ts:14-130`)                                            | "storage full: n file(s) not cached"                                        | keep                        | Go-live check compares bytes needed per screen with `navigator.storage.estimate()`; cue-order fill (golive-warnings)                                                                                                                                                                                                                                           | W37, W50          | yes   |
| A30 | Phone limits (`28-mobile.md:464`, :707, :718, :864-867, :1098)                                                                                                 | read-only or refused, with text                                             | keep                        | re-based on the inline part; pre-rendered slides read-only                                                                                                                                                                                                                                                                                                     | W57               | no    |
| A31 | Files listed a service: 20,000 (`goLive.ts:408`; skipped silently, :429), `geoms` ≤ 100,000 (`live.ts:38`)                                                     | not listed, no line                                                         | keep                        | listed in cue order from the first cue; extended to slide pages and pictures; a critical line when it cuts (prerender-model)                                                                                                                                                                                                                                   | W60               | yes   |
| A32 | Offline resolve without a file index (`engine.ts:658-678`; `goLive.ts:46-50`, :414-419: no file index, no shape files)                                         | offline services omit shape files                                           | replace                     | the stand-in carries `file.bytes` and `uses`; the offline resolve lists slide pages and shape files from them (prerender-model); "Download for offline use" (`OfflineControl.tsx:8-57`) fetches them and the pictures `GET /presentations/:id/prerenders` lists (golive-warnings)                                                                              | W38               | yes   |
| A33 | Test and doc constants `slideTypical`, `librarySnapshotYear` (`size.ts:30-31`, :57-58)                                                                         | never at run time                                                           | keep                        | —                                                                                                                                                                                                                                                                                                                                                              | —                 | no    |
| A34 | Degraded entries 200 (`DEGRADED_MAX`, `goLive.ts:66`; a bad slide reported at every cue, :199-201)                                                             | later lines dropped                                                         | keep                        | picture lines one per presentation with counts; critical kinds sorted before the cap (golive-warnings)                                                                                                                                                                                                                                                         | W60               | yes   |
| A35 | Write budget while live: 8 MiB of bodies a minute, 50 uploads a day (design/28 P2, `28-mobile.md:718`; not built)                                              | —                                                                           | keep (exempt by kind)       | the go-live bake's pictures for the live service's keys, and an import's slide pages and pictures, exempt by kind; sized from measure 5 (prerender-store, with the phones lane)                                                                                                                                                                                | —                 | no    |
| A36 | Revision bodies 64 MiB a presentation (design/28 P2, `28-mobile.md:715`; not built)                                                                            | —                                                                           | keep                        | bodies are stand-ins; the files they name count in A24 (prerender-store builds both) **Status:** the files part (the 1 GiB of A24) is built; the revision caps (200 revisions, 64 MiB of bodies) and the summaries are deferred to library-light (OQ-PS4). | W56               | no    |
| A37 | Backups kept 30 days (`backup.ts:156-163`; `12-hub.md:371-377`)                                                                                                | —                                                                           | keep                        | collection keeps every file a backup manifest within retention lists; restore reports missing slide files (prerender-store) **As built:** the 30-day delay of a file nothing names is the backups' retention itself (`COLLECT_DELAY_DAYS = RETENTION_DAYS`), so no manifest is read and every backup that can be restored lists its files; the restore report (W66) is deferred, its need is in the notes for the integrator. | W66               | yes   |

**B. Import (the deck is untrusted)**

| #   | Limit (value; where)                                                                                                                                                                                                                                                          | When hit today                                                                             | Verdict     | New value or mechanism (track)                                                                                                                                                                                          | Warning       | Crit.        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| B1  | Text formatting 128 KB a slide (`emit-budget.ts:38`, :172-181)                                                                                                                                                                                                                | later text plain                                                                           | replace     | the slide is `bytes`; its file keeps every run (prerender-import)                                                                                                                                                       | W1            | no           |
| B2  | 1,000 objects a slide (`emit.ts:222`, :661-664; `schemas.ts:940`)                                                                                                                                                                                                             | topmost not drawn                                                                          | replace     | inline slides keep 1,000; slide files 20,000 within 16 MiB (prerender-import)                                                                                                                                           | W10           | yes          |
| B3  | 5,000 shapes a slide (`walk.ts:84`, :332-335)                                                                                                                                                                                                                                 | rest not drawn                                                                             | raise       | 50,000; tag and point bounds (B4) bound memory, pool time bounds work (xml-compact)                                                                                                                                     | W10           | yes          |
| B4  | 250,000 tags a part (`xml.ts:30`, :166-167; 300 B a node, `opc.ts:44`)                                                                                                                                                                                                        | slide (or a layout's slides) text only                                                     | replace     | `a:path` children packed as numbers while tokenizing; 500,000 other elements and 4,000,000 path points a part, fixed after measuring the 1.5M-tag slide; fuzz parity with the DOM reader (xml-compact)                  | W9            | yes          |
| B5  | 8 MiB a part (`opc.ts:29`; `pptx-scan.ts:29`; `pptx-client.ts:238-242`; `nativeJob.ts:760-762`)                                                                                                                                                                               | slide quarantined to text                                                                  | raise       | 32 MiB (largest real 22.3 MB) (xml-compact)                                                                                                                                                                             | W9            | yes          |
| B6  | 64 MiB of XML a deck (`pptx-scan.ts:31`; `pptx-client.ts:243-244`; `deckParts.ts:51`; `nativeJob.ts:752-756`)                                                                                                                                                                 | whole import fails                                                                         | replace     | parts read on demand (positioned reads on the hub, `Blob` slices in the browser), 64 MiB raw LRU beside the 256 MiB parse cache; 1 GiB declared-total bound (xml-compact)                                               | W17           | — (blocking) |
| B7  | Zip structure: 200k entries, 8 GiB expanded, 64 MiB directory, 256 MiB in memory; overlap, encryption, methods, `..` refused; inflate counted against declared sizes (`zip-path.ts:5-6`; `zip-bounded.ts:24`, :148-149; `zip-stream.ts:23`, :93, :166-167, :285)              | file refused                                                                               | keep        | the zip-bomb defence; real max 4,042 entries                                                                                                                                                                            | W16           | — (blocking) |
| B8  | Compression ratio (no rule)                                                                                                                                                                                                                                                   | —                                                                                          | keep (none) | real worship decks up to 39×, 99.9th percentile 267×, bomb fixtures 1,014-1,029× (measured): a ratio cap would refuse real decks; declared sizes already refuse bombs                                                   | —             | no           |
| B9  | 2,000 pictures a deck (`pptx-scan.ts:35`, :143-160; `nativeJob.ts:769-773`)                                                                                                                                                                                                   | rest not imported                                                                          | keep        | 8× the real max (236)                                                                                                                                                                                                   | W12           | yes          |
| B10 | 50 clips a deck (`pptx-scan.ts:36`; `clips.ts:157-166`)                                                                                                                                                                                                                       | rest show posters                                                                          | keep        | real max 23                                                                                                                                                                                                             | W12           | yes          |
| B11 | 1 GiB spilled a deck (`pptx-scan.ts:33`; `deckParts.ts:83`; `nativeJob.ts:782-786`, :809-813)                                                                                                                                                                                 | rest not imported                                                                          | keep        | real max 174 MB                                                                                                                                                                                                         | W12           | yes          |
| B12 | 20 font parts (`apps/hub/src/pptx/shared.ts:45`)                                                                                                                                                                                                                              | nothing visible (fonts unused)                                                             | raise       | 64 (`MAX_EMBEDDED_FONTS`, `deck.ts:27`) when embedded fonts land; 7 decks over 20, max 50                                                                                                                               | —             | no           |
| B13 | 2,000 slides a deck (`pptx-scan.ts:38`; `deck.ts:23`, :226-227)                                                                                                                                                                                                               | rest dropped                                                                               | replace     | read up to 10,000 (hostile bound) and split into presentations of at most 2,000 (import-scale; owner question 7)                                                                                                        | W7            | no           |
| B14 | Pool time: 150 slides / 2 min a batch, 15 min an import (`shared.ts:47-50`; `textRepair.ts:158-163`)                                                                                                                                                                          | rest text only                                                                             | replace     | version 1 saved with those slides rescued, then a low-priority "finish import" job while the hub is idle, paused while a playlist is live; 2 h absolute (import-scale)                                                  | W8, W42       | yes          |
| B15 | Browser parse deadline 90 s (`pptxParse.ts:22`, :126-144)                                                                                                                                                                                                                     | hub parses instead (lossless)                                                              | raise       | 90 s + 0.5 s a slide, at most 10 min (import-scale)                                                                                                                                                                     | —             | no           |
| B16 | 65,536 path points a slide (`geom.ts:70`; `walk.ts:673-677`)                                                                                                                                                                                                                  | LibreOffice's art, or legacy / missing                                                     | replace     | the slide is `count`; inline slides keep 64k (prerender-import)                                                                                                                                                         | W1            | no           |
| B17 | 150 drawn cells a table (`tables.ts:98`, :205-209)                                                                                                                                                                                                                            | table residual (absent on lite hubs)                                                       | remove      | r2b tables-conv's one `ShapeObject.table`; a table too heavy live makes the slide `count`                                                                                                                               | —             | no           |
| B18 | Table grid 4,096, `TABLE_LIMITS` (`tables.ts:103`; `schemas.ts:607-625`)                                                                                                                                                                                                      | table residual or text cut                                                                 | keep        | far above use (0 in E)                                                                                                                                                                                                  | W14           | yes          |
| B19 | SmartArt 2,000,000 elements a deck (`smartart.ts:101`, :388-392)                                                                                                                                                                                                              | further SmartArt to LibreOffice or missing                                                 | replace     | each distinct drawing charged once; 2,000,000 distinct elements kept (import-scale)                                                                                                                                     | W14           | yes          |
| B20 | Decoration caps: 256 parts, 64 paints, 16,384 points, 24 shadowed shapes (`decor.ts:74`; `schemas.ts:758-765`; `decor/clamp.ts:129`, :147; `decor/draw.ts:227`)                                                                                                               | converter starts a new decoration (lossless); only a file ordo did not write loses shadows | keep        | bounds one draw call; revisit with `drawDecorRange` slicing                                                                                                                                                             | —             | no           |
| B21 | Guard 150 / 190 / 200 objects (`classify.ts:694`; `budget.ts:70-72`, :518-572, `toArt` :493)                                                                                                                                                                                  | topmost left out (LibreOffice's art or missing)                                            | replace     | the slide is `count`; nothing left out; counts read from `CLAMP` in one place (prerender-import)                                                                                                                        | W1, W4        | no           |
| B22 | 12 / 16 pictures a slide and the atlas (`classify.ts:696`; `budget.ts:77`, :435-445, :579; `sheet.ts:312`)                                                                                                                                                                    | topmost pictures left out                                                                  | replace     | `count`; the atlas optional, kept only if measured cheaper (prerender-import)                                                                                                                                           | W1            | no           |
| B23 | Bakes: 500 an import; 8,192 px, 16 MP, 16 effects (`bake.ts:60-67`; `bakes.ts:55-58`; `pptx-client.ts:541`)                                                                                                                                                                   | colour effect dropped past 500                                                             | raise       | 2,000 (the picture cap) with pool time counted; the baking browser applies bakes too (`applyBake` is pure); pixel caps kept (import-scale)                                                                              | W13           | yes          |
| B24 | Picture decode bounds; 6,000 MP an import (`pptx-pictures.ts:18-45`; hub `pictures.ts:168-178`)                                                                                                                                                                               | per picture: downscaled; past 6,000 MP: not imported                                       | replace     | per-picture bounds kept; the import total becomes pool time (import-scale)                                                                                                                                              | W12           | yes          |
| B25 | Browser assembly 64 / 512 MiB (`pptx-client.ts:92-94`, :586-590; demo and harness only)                                                                                                                                                                                       | not imported                                                                               | replace     | each picture stored as read; only the per-picture bound remains (import-scale)                                                                                                                                          | existing note | no           |
| B26 | Text a box: 20,000 characters, 2,000 runs, 5,000 paragraph styles (`emit-text.ts:36`, :135-138; `richtext.ts:50-53`, :243-332; `schemas.ts:13`)                                                                                                                               | rest cut                                                                                   | keep        | schema bounds far above use; the import sanitizer's lower cut is B28                                                                                                                                                    | W14           | yes          |
| B27 | Speaker notes 1 MiB a presentation, 10,000 characters a slide (`pptx-core.ts:75`, :308-346; `notes.ts:19`)                                                                                                                                                                    | later notes cut to 200 characters                                                          | keep        | notes stay in the stand-in (Stage); raise with the inline budget                                                                                                                                                        | W15           | no           |
| B28 | Import sanitizer: 10,000 characters a box, 16 run families, 64 size scales (`IMPORT_LIMITS`, `sanitize.ts:33-57`; `cutText` :477-484 at :501; `fontBudget` :84-110; on every import, `pptx-core.ts:634`, `pptx-ladder.ts:93`, `pro7.ts:1658`, and on paste, `actions.ts:439`) | text and styles cut silently before anything is stored                                     | raise       | text 20,000 (the schema's); families and size scales 256 for objects that go into slide files, the live bounds for inline ones, and a box past those makes the slide `count`; a cut writes a slide note (render-bounds) | W14           | yes          |

**C. Drawing on the screens**

| #   | Limit (value; where)                                                                                                                                                             | When hit today                                          | Verdict     | New value or mechanism (track)                                                                                                                                                                                          | Warning        | Crit. |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----- |
| C1  | 200 objects a slide (`clamp.ts:59`, :876; editor `ops/slides.ts:44-58`)                                                                                                          | topmost not drawn, silently                             | replace     | `count` slides pre-rendered; Live or picture-less drawn into a live frame (live-frame); 200 stays the bound of one live raster                                                                                          | W21-W24, W34   | yes   |
| C2  | 16 distinct pictures (`clamp.ts:61`, :882; `apps/output/src/pictures.ts:72`, :175-176)                                                                                           | later pictures not drawn                                | replace     | as C1; 16 stays the bound for the live parts of one raster                                                                                                                                                              | W24, W34       | yes   |
| C3  | 192 MiB decoded pictures a cue (`clamp.ts:63`; `pictures.ts:73`, :151-176; `bitmap-cache.ts:11`)                                                                                 | pictures skipped, counted                               | keep        | memory bound; a slide past it at 3840 is `count`; a live frame decodes them one at a time; a skip remains only for hostile input                                                                                        | W34            | yes   |
| C4  | 10,000 characters drawn a box (`clamp.ts:48`, :105; schema 20,000, `schemas.ts:13`; editor `ops/slides.ts:25`)                                                                   | stored, editable, never shown                           | raise       | 20,000; long boxes laid out in the prepare step a few paragraphs a turn (10,000 characters cost about 125 ms cold today); a box over about 4,000 characters, not the lyric box, makes the slide `count` (render-bounds) | —              | no    |
| C5  | Per box: 1,000 paragraph styles, 16 families, 64 size scales, 2,000 runs, 8 fallbacks (`clamp.ts:76-86`, `FontBudget` :169-213)                                                  | later ones take the box's style                         | raise       | paragraphs 5,000 (layout in prepare); families and sizes 256 in the bake profile, and a box past 16 / 64 makes the slide `count`; runs and fallbacks kept (render-bounds)                                               | W23 (Live)     | no    |
| C6  | Path points: 4,096 a path, 8 paths; geometry files 64 paths, 2.6 MB (`pathdata.ts:14-26`; `geom/ops.ts:180-189`; `schemas.ts:181-189`)                                           | extra points cut                                        | keep        | per-object hostile bounds; large geometry already in files                                                                                                                                                              | —              | no    |
| C7  | Drawing budget 1.3M units, 65,536 points (`geom/cost.ts:99-103`, `slidePlan` :828-883; `geombudget.ts:169-194`, :313-316; converter `emit.ts:674-779`, `walk.ts:648-660`)        | legacy copies until a unit is made                      | replace     | decides when, not how: units or the live frame, fading in; the legacy copy only for older builds and the hostile one-call case (live-frame)                                                                             | W21, W48       | no    |
| C8  | One geometry past a task alone (`cost.ts:99`; `units.ts:233-252`, `slideUnitsLeft` :269-292)                                                                                     | thin line art draws nothing                             | replace     | the bake draws it whole; live: split by sub-path groups or `cont` pieces into steps; a per-call bound kept for a hostile sub-path (live-frame)                                                                          | W23            | yes   |
| C9  | Effect budget 10 slide areas (`cost.ts:906`, dropped :858; `emit.ts:709-734`)                                                                                                    | effects drawn without                                   | replace     | r2b effect-units (units in slices, never dropped); the picture holds static effects; 10 stays what one raster draws at once                                                                                             | —              | no    |
| C10 | Named exceptions to the 50 ms task (`27-pptx-native-renderer.md:1773-1780`; `decor/draw.ts:75-77`)                                                                               | slow first draw: a late jump                            | remove      | static content in a picture (a 10-14 ms copy, measured), live content in steps (effect units, `drawDecorRange`) (effect-units, live-frame)                                                                              | —              | no    |
| C11 | 50 ms task; raster p95 10 ms at 1080p, 30 ms at 4K (`27-pptx-native-renderer.md:1613-1645`; `health.ts:186-191`)                                                                 | raster alarm                                            | keep        | never raised: it is the live-service bound                                                                                                                                                                              | existing alarm | yes   |
| C12 | One frame of units a slide; 1 s of unit making a job (`units.ts:71`, :76, :322)                                                                                                  | legacy copies; a jump waits                             | replace     | a live frame per slide (one frame whatever the count); no job waits (effect-units item 5); 1 s stays a turn budget (live-frame)                                                                                         | W49            | no    |
| C13 | Unit cache 192 MiB, a unit at most half (`units.ts:64`, :246)                                                                                                                    | units made again (time only)                            | keep        | live frames live in it (three held 4K cues: 100 MB); measure                                                                                                                                                            | —              | no    |
| C14 | Sprite cache 64-128 MiB (`spritecache.ts:29-35`)                                                                                                                                 | drawn directly (time only)                              | keep        | —                                                                                                                                                                                                                       | —              | no    |
| C15 | Effect sprite 16 MP (`effects.ts:44`, :367)                                                                                                                                      | shape drawn without its effects on 4K screens           | replace     | past it composed directly from the reduced layers (each ≤ 1 MP), never dropped (render-bounds)                                                                                                                          | —              | no    |
| C16 | Numeric clamps: box ±2 canvases, fonts 2-1,000 px, effects 500 px, 16 stops, dashes ≥ 0.5 px, 16 MP prepared pictures (`clamp.ts:47`, :67, :73, :90, :124-137; `picture.ts:337`) | clamped (nothing real lost)                             | keep        | hostile bounds, tightened until the worst-case object bench passes (R5, D11) (render-bounds)                                                                                                                            | —              | no    |
| C17 | Heavy-slide rule and raster alarm (`health.ts:202`, :207, :312-326; `lib/health.ts:52-58`)                                                                                       | about a quarter of worship slides left out of the alarm | replace     | judged by measured over estimated time; a speed figure scales Live estimates (render-bounds)                                                                                                                            | W48            | no    |
| C18 | Editor add refusal 200 / 16 (`ops/slides.ts:31-58`)                                                                                                                              | nothing added                                           | replace     | the add goes through; the slide becomes `count` (prerender-editor)                                                                                                                                                      | W25            | no    |
| C19 | Warm-up reach: one cue past the armed one (`link-core.ts:966-1000`; `asset.worker.ts:684-692`)                                                                                   | a jump decodes cold                                     | keep, widen | file fill in cue order; 1920 copies of the live item's pre-rendered slides decoded ahead in a share of the bitmap cache that is evicted first (≤ 64 MiB) (prerender-outputs)                                            | —              | no    |
| C20 | Fill order: fonts, images, the rest (`link-core.ts:1692`, :1708)                                                                                                                 | slide and shape files wait behind videos                | replace     | pictures in cue order, then pages of picture-less slides, before videos; pages of slides with a picture last, outside "Cache 100 %" (prerender-outputs)                                                                 | W33            | yes   |
| C21 | Late file swap is a cut (`link-core.ts:1766-1799`)                                                                                                                               | a pop                                                   | replace     | ~0.3 s fade, shared with effect-units (prerender-outputs)                                                                                                                                                               | —              | no    |
| C22 | Thumbnail decode 640 px, 120 bitmaps (`thumb.worker.ts:96`, :101-107)                                                                                                            | —                                                       | keep        | the bake worker decodes full size                                                                                                                                                                                       | —              | no    |

**D. New bounds that pre-rendering brings**

| #   | Bound                                                        | Why                                                                                                              | Value                                                                                                                                                                                     | Warning                | Crit. |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----- |
| D1  | Draw as: Live on a detailed slide                            | the owner's choice (sharp text, own fonts)                                                                       | per slide, presentation default; the picture is made anyway                                                                                                                               | W21-W23, W35, W48, W62 | yes   |
| D2  | Anchors over a picture                                       | a slide with hundreds of moving parts cannot be played live in time                                              | 200 anchors, 16 playing pictures; the static objects above anchors are not counted (drawn in slices); past it, build text shows from the start and videos show their still                | W24                    | yes   |
| D3  | Bake bounds                                                  | the volunteer's browser and the venue PC against a hostile slide file                                            | slide-file bounds; one 3840 canvas; 60 s a picture; the per-call bound (D11); a failed key recorded and not retried until "Make picture again"                                            | W36, W30               | yes   |
| D4  | Go-live bake load                                            | the venue PC also runs the screens                                                                               | only on the computer that went live; one picture at a time, PNG only, 1920 copy first, about half a core, 2 s pause after a GO, paused on late flips; off on Setup until measure 2 passes | W45                    | yes   |
| D5  | Pictures a slide                                             | memory (33 MB a 4K picture) and copy time                                                                        | 1 in r2b; at most 4 when runs land                                                                                                                                                        | —                      | no    |
| D6  | Picture file                                                 | hub disk, screens' decode (hostile uploads)                                                                      | 3840x2160, 1920x1080 or 640x360 exactly, ≤ 32 MiB, PNG or WebP, not animated; not from phone sessions                                                                                     | W28                    | no    |
| D7  | Pictures a presentation (`add91d9` 4,096 plates, 64 a slide) | hub disk                                                                                                         | replaced by A24's bytes                                                                                                                                                                   | W29                    | yes   |
| D8  | `PRERENDER_VERSION` and font changes                         | a picture matches what live draws                                                                                | stand-bys by `standbyId` until remade                                                                                                                                                     | W39                    | no    |
| D9  | Picture format                                               | exact pixels; decode latency on 1080p screens                                                                    | PNG with alpha; WebP only where exact; 1920 copy; 640 preview for phones and thumbnails                                                                                                   | W47                    | yes   |
| D10 | Slide-file page                                              | an output parses at most one page in a lane turn                                                                 | 256 KiB or 500 objects a page                                                                                                                                                             | —                      | no    |
| D11 | One draw call at 3840                                        | a slice cannot be interrupted (`lanes.ts:21-23`), so one costly object delays the next GO                        | per-object clamps tightened until the worst-case object's longest call is ≤ 50 ms (target 10)                                                                                             | W23                    | yes   |
| D12 | Live frame time a slide                                      | a hostile slide file would keep the interactive lane busy for minutes, and bulk warm-ups wait (`lanes.ts:12-13`) | a measured budget per slide; past it the stand-in with a health line                                                                                                                      | W46                    | yes   |
| D13 | Running service at goLive                                    | the live process parses and checks it; every screen saves it once                                                | a ceiling from a venue-PC measurement (32 MiB to start); a critical line above the size whose save passes the GO lead                                                                     | W58, W59               | yes   |
| D14 | Queued bytes on the hub                                      | live-process memory with 80 phone sockets (`28-mobile.md:707`) plus screens and iPads on bad Wi-Fi               | 4 MiB a socket (plus one resolved copy for old clients), 128 MiB in all, largest queues closed first                                                                                      | W52                    | no    |
| D15 | Pictures made on other computers                             | a picture an edit session uploaded may differ from its slide                                                     | the venue PC re-bakes them when idle and replaces those whose pixels differ; never while live                                                                                             | W30                    | no    |

**E. ProPresenter and other imports (the file is untrusted)**

| #   | Limit (value; where)                                                                                                                             | When hit today                             | Verdict | New value or mechanism (track)                                                                | Warning          | Crit.        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------- | ---------------- | ------------ |
| E1  | Folder walk 200,000 files (`MAX_DIR_FILES`, `apps/hub/src/imports.ts:67`)                                                                        | rest not seen                              | keep    | hostile bound; real libraries far below                                                       | existing refusal | — (blocking) |
| E2  | Documents in memory 256 MiB a folder import (`MAX_IMPORT_MEMORY_BYTES`, `imports.ts:89`, :321-323)                                               | refused: "import it in parts"              | keep    | the pool's heap; the refusal in plain words (hub-writers)                                     | W65              | — (blocking) |
| E3  | Inline document bytes 64 MiB (`MAX_INLINE_BYTES`, `imports.ts:73`)                                                                               | larger documents read from disk (lossless) | keep    | —                                                                                             | —                | no           |
| E4  | Media walk beside a NAS document, 20,000 entries (`PRO7_BESIDE_MAX_ENTRIES`, `imports.ts:77`, stops silently at :268)                            | media past it not found, no line           | keep    | hostile bound; a report line names what was not found (hub-writers)                           | W64              | yes          |
| E5  | Documents a batch 500 (`PRO7_BATCH_DOCS`, `imports.ts:92-95`)                                                                                    | next batch (lossless)                      | keep    | heap bound                                                                                    | —                | no           |
| E6  | RTF text 64 KiB a box (`RTF_TEXT_MAX`, `packages/importers/src/rtf.ts:80`, :632)                                                                 | rest cut                                   | keep    | above the schema's 20,000 characters; the box is split as B28                                 | W14              | yes          |
| E7  | Playlist depth 32, 16 gradient stops, 2,048 points a path (`pro7.ts:33`, :334, :529)                                                             | deeper items, stops, points cut            | keep    | hostile bounds matching the renderer's (C6, C16)                                              | —                | no           |
| E8  | ProPresenter, PDF, song and scripture slides past the live counts (no plan today: only the PowerPoint import and the editor's add refusal count) | the screens' clamp cuts silently           | replace | the same plan in every import job: `pictureUnits`, then slide file and stand-in (hub-writers) | W4               | no           |

**F. Other caps found in review**

| #   | Limit (value; where)                                                                                                                  | When hit today                             | Verdict | New value or mechanism (track)                                                                         | Warning            | Crit. |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------ | ------------------ | ----- |
| F1  | PowerPoint slide notes 16 × 200 characters (`Slide.pptx.notes`, `schemas.ts:908`)                                                     | later notes not kept                       | keep    | the import report holds the full list; the slide card shows the first 16                               | —                  | no    |
| F2  | Missing-element list 16 × 40 (`MISSING_LIMITS`, `packages/domain/src/missing.ts:23`)                                                  | later entries not listed                   | keep    | display only; the import report lists all                                                              | —                  | no    |
| F3  | Stage notes 4,000 characters (`NOTES_MAX`, `apps/stage/src/model.ts:359`)                                                             | Stage shows the start only                 | keep    | the Stage's display bound; warned where the notes are written (golive-warnings)                        | W61                | yes   |
| F4  | Reader text 60,000 characters (`READER_TEXT_MAX`, `m9-readers.ts:20`)                                                                 | search and labels read the start           | keep    | readers only; drawing unaffected                                                                       | —                  | no    |
| F5  | Imported notes 10,000 characters a slide (`IMPORT_LIMITS.notes`, `sanitize.ts:40`, :556)                                              | notes cut                                  | raise   | 20,000 with B28 (render-bounds)                                                                        | W15                | no    |
| F6  | Find and replace lists 200, counts 10,000 (`FindReplaceDialog.tsx:17-19`)                                                             | the list stops; the count says "more than" | keep    | UI only                                                                                                | existing text      | no    |
| F7  | SVG drawn by a screen without its still, 2 MiB (`SVG_SCREEN_MAX_BYTES`, `packages/domain/src/svg.ts:49`; `apps/output/src/svg.ts:18`) | not drawn                                  | keep    | the output's main thread; on a pre-rendered slide the picture carries it                               | existing `svgNote` | yes   |
| F8  | "Pictures (LibreOffice)" import: 2,000 slides, 8 MiB a part, 64 MiB of XML (`packages/importers/src/pptx.ts:7-26`)                    | refused or cut                             | keep    | LibreOffice reads the whole file; the path retires at the lite flip (LibreOffice inventory question 8) | existing refusal   | no    |
| F9  | Shape and decoration files kept read: 4,096 and 2,048 files, 32 M characters each (`geom/stored.ts:30`, `decor/files.ts:22`)          | read again (time only)                     | keep    | a live frame reads them a page at a time; measured with 20,000 objects (live-frame)                    | —                  | no    |
| F10 | Live-path counts: pending commands 100 (`liveCore.ts:84`), media replays 64 (`apps/output/src/host.ts:78`)                            | oldest dropped (time-bounded)              | keep    | lossless or time-bounded                                                                               | —                  | no    |
| F11 | Re-import 4 MiB log line (`reimport.ts:932-934`)                                                                                      | a log line only                            | replace | the merged presentation is planned again (hub-writers)                                                 | —                  | no    |
| F12 | Clipboard 200 objects a paste (`CLIPBOARD_LIMITS.objects`, `ops/clipboard.ts:45-51`)                                                  | paste cut                                  | raise   | 20,000 (the slide-file bound); past the live counts the slide becomes `count` (editor-slideops)        | W25                | no    |
| F13 | Editor node cache 8 MP a node (`NODE_CACHE_MAX_PX`, `SlideCanvas.tsx:350`)                                                            | drawn without cache (time only)            | keep    | measured with crowded slides on a desktop and an iPad (prerender-editor)                               | W63                | no    |

Owned by r2b's planned tracks and only cross-referenced here: the converter's effect and drawing budgets as
classifier inputs (effect-units), the editor's whole-draw rule (leaf-editor), the table object (tables-conv,
editor-table).

### 2.3 Mechanisms to build

Storage and transport:
- **M1 Slide files in pages** with stand-ins (§1.2-1.3): removes A1-A4, A8's loss, A9. prerender-model,
  prerender-store, prerender-import, hub-writers, prerender-editor, editor-slideops.
- **M2 The running service by reference**: `resolvedId` is the SHA-256 of the resolved copy's canonical
  serialisation, hashed where it is serialised once at goLive (M8's worker). Today's `manifestId` digests the
  playlist and presentation revisions, file hashes and looks only (`goLive.ts:269-282`), not a clip's loop, trim or
  gain (`schemas.ts:1085-1115`) nor the degraded list, and a PC's offline copy uses an FNV digest
  (`engine.ts:676`), so it stays the file cache's name only. A `live_resolved(resolved_id, json)` row is written in
  the same transaction as the goLive journal row, before the goLive is acknowledged, and kept twice (two rows), each
  verified by its hash on read; snapshots, the two previous ones (`live.ts:76-80`) and the journal's goLive row store
  the state with `resolved` replaced by its `resolvedId`; a row is deleted when nothing names it; both copies
  missing at restore: M3's "need it" asks the operator PC, which holds the copy, to send it. `hello`
  (`packages/protocol/src/index.ts:109-116`) carries the `resolvedId` the client holds and `live.state`
  (`ws.ts:368-370`) leaves `resolved` out when it matches; a client without it fetches it once over HTTP from the
  buffer serialised at goLive. Output, stage and operator core persist the copy once per `resolvedId`, one
  IndexedDB record per presentation, written after the first flip (a structured clone of a large service on each
  link worker costs 9-12 ms/MiB, on the workers that handle the first GOs). First step without a protocol change:
  one state string per `seq`, shared by every socket. Fixes A15, A16, A22. live-by-ref.
- **M3 Hand-back by reference**: `live.adopt` (`liveCore.ts:527-567`) carries the state with `resolved` replaced by
  its `resolvedId`. A service the PC started is held to End service (design/17 "The hold",
  `17-offline-and-degraded.md:174-195`), so M3 covers services the hub started, whose copy the hub keeps in
  `live_resolved`. The upload `PUT /live/resolved/<resolvedId>` (operate role, resumable) stays only as the repair
  when the hub's copies are missing or fail their hash: bounded by the goLive ceiling (D13), parsed in the pool, the
  hash recomputed from the bytes. Removes A11, then lowers A12. handback-ref.
- **M4 Library pokes for every client** (`library.poke`, `docs/design/28-mobile.md:686-693`): the phones lane's P1
  builds them for capped sockets (`28-mobile.md:707`); library-light extends them to every client. Bodies through
  `GET /library/snapshot?since=` answered by the library process and streamed by the live process. Queued bytes: 4
  MiB a socket (pokes and live deltas; plus one resolved copy for clients from before the reload) and 128 MiB across
  all sockets, past which the largest queues are closed first and resync (W52): a room of 80 phones on bad Wi-Fi at
  32 MiB each would hold 2.5 GiB of a NAS-class hub. Picture rows never travel as library changes. A20.
  library-light.
- **M5 Offline library per entity** in the operator core: one IndexedDB record per presentation and rev, only the
  changed ones written. A21. library-light.
- **M6 Summary-only library snapshots** for phones, iPads and edit sessions; the venue PC keeps full bodies (it may
  go live without the hub). A19. Left to the phones lane's P1 (design/28 P1), which owns those clients.
- **M7 Revisions share files**; collection counts kept revisions, live locks, bundles, `live_resolved` and backup
  manifests within retention, and pauses while it cannot read the live process's references; revision summaries at
  save so the list stops parsing every revision (library-light owns the summaries for both lanes; design/28 P2's
  row then only reads them). A23, A24, A37. prerender-store, library-light. _Built (prerender-store, r2b sub-wave 2): the
references index, the 30-day mark and sweep, the 1 GiB budget; summaries and the revision caps stay with library-light;
the restore report W66 is deferred._
- **M8 Going live prepared beside the running service**: Go live first asks the hub to prepare the playlist (the
  live process fetches the bundle with 1.5 s to the response headers, then a progress timeout of 1.5 s without bytes,
  under a 30 s ceiling); a worker thread checks every presentation (`quarantinePresentation`, `goLive.ts:85`, today on
  the live loop through `live.ts:287-296`), resolves, serialises once and hashes (`resolvedId`). Meanwhile GO, Next
  and Clear keep applying to the running service: today every command behind a goLive waits for its fetch
  (`submitQueued`, `live.ts:365-379`), and "Go live again" during a service is a documented step
  (`apps/operator/src/lib/slideMedia.ts:16`). The operator shows progress (W41's toast) and the goLive enters the
  queue only once the hub reports it ready; it then applies at once (one parse of the prepared buffer, bounded by
  D13). While a service is live, after 5 s the toast offers "Go live from the saved copy". Bundles carry slide-page
  references and the key set; one `live_kv` row per bundle, written after the goLive is applied. A10, A17, A18.
  golive-prepare. (Review of sub-wave 1: a poll that continues a Go live gets the result of the prepare it
  watched, never a fresh prepare, so a prepare ending between two polls is not fetched again; End service
  cancels a goLive still being prepared, so it never applies after the service was ended; at most two prepares
  are in flight, a third refused with W67, and only the latest one's copy is kept ready. design/13 "Prepare
  before goLive".)

Import:
- **X1 Compact path parse**: path children packed into numbers while tokenizing, no node per point; separate bounds
  for other elements and for points. B3-B5. xml-compact.
- **X2 XML on demand**: parts read when needed with a raw LRU, so only the declared total is bounded. B6. xml-compact.
- **X3 Finish later**: version 1 with rescued slides, the rest converted when the hub is idle, never during a
  service; P0's pacing (`pacing.ts` on `p0/integrate`) is reused for "never during a service". B14, B24.
  import-scale.
- **X4 Split long decks** into presentations of at most 2,000 slides. B13. import-scale.
- **X5 Shape files as their own parts**, never inside the pool message or the scene. A26, A27. import-scale.
- **X6 One plan for every importer**: the ProPresenter, PDF, song and scripture imports and every hub writer run
  `pictureUnits` and write slide files and stand-ins as the PowerPoint import does. E8. hub-writers.

Drawing:
- **R1 The live frame**: on an output, the static objects of a slide drawn live (Live, or no picture yet) past a
  live count are drawn into one full-frame canvas on the asset worker's lanes, one draw call a step within D11, as
  units are made today (`units.ts:24-56`), kept in the unit cache and pinned while live, armed or warmed; the live
  parts drawn over it as usual. Whatever the object count, a cue holds one frame per layer (33 MB at 4K) and no
  step passes a task. A frame has a time budget per slide (D12); past it the stand-in shows with W46. The static
  objects above a slide's anchors use the same path when they pass a live count (§1.5). C1, C2, C7, C8, C12.
  live-frame.
- **R2 Long text laid out in the prepare step**, a few paragraphs a turn, as table layouts are. C4, C5.
  render-bounds.
- **R3 Effect composite without a full-size cache** past 16 MP. C15. render-bounds.
- **R4 Measured speed**: health's median of measured over estimated raster time, used by the heavy-slide rule and to
  scale Live estimates per screen; a conservative venue-PC factor until a screen has reported. C17, D1.
  render-bounds.
- **R5 Worst-case object bench**: once counts stop cutting content, what keeps each raster on time is the cost of
  the single most expensive object. Every per-object clamp (C5, C16) at its hostile maximum, at 3840; the clamps
  are tightened until the longest single draw call is at most 50 ms (target 10). The bake and the go-live bake use
  the same per-call bound. D11. render-bounds.

### 2.4 What stays, and how high

| Bound                           | Value                                                                                          | Protects                                     | Note                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Socket message                  | 64 KiB; 50 burst, 50/s                                                                         | the hub from hostile clients                 | unchanged                                                        |
| Operator large message          | 16 MiB, then about 1 MiB                                                                       | live-process memory and loop                 | lowered after M2, M3 and preview by reference, measured          |
| HTTP JSON body                  | 32 MiB                                                                                         | library process memory and loop              | 16 MiB considered after measuring real saves                     |
| Running service at goLive (new) | ceiling from a venue-PC measurement, 32 MiB to start                                           | live-process loop, every screen's first save | blocking above (W58); critical line above the GO-lead size (W59) |
| Slide file                      | 16 MiB and 20,000 objects a slide; pages of 256 KiB or 500 objects                             | the pool heap, editor and screens            | set from measure 3 and a 3840 bench                              |
| Picture file                    | 3840x2160 / 1920x1080 / 640x360, 32 MiB                                                        | hub disk, screens' decode                    |                                                                  |
| One draw call (new)             | ≤ 50 ms at 3840, target 10                                                                     | a GO is never late behind one object         | R5                                                               |
| Live frame (new)                | a measured time budget a slide                                                                 | the interactive lane                         | D12                                                              |
| Queued bytes (new)              | 4 MiB a socket, 128 MiB in all                                                                 | live-process memory                          | measured                                                         |
| Per presentation                | 1 GiB of unique files with revisions                                                           | hub disk                                     | owner figure, widened                                            |
| Free-space floor                | max(5 GiB, 5 %)                                                                                | `live.db`                                    | design/28 P2                                                     |
| Revisions                       | ≤ 200, 30 days, 64 MiB of bodies; files in the 1 GiB                                           | hub disk                                     | design/28 P2                                                     |
| Backups                         | files named by a manifest kept 30 days                                                         | restores                                     | A37                                                              |
| Degraded entries                | 200, critical kinds first                                                                      | the Go-live check                            | A34                                                              |
| Zip                             | as today (B7)                                                                                  | zip bombs                                    |                                                                  |
| XML                             | 32 MiB a part; 500,000 elements and 4,000,000 points a part; 1 GiB declared a deck             | parse memory                                 | measured before fixing                                           |
| Deck                            | 10,000 slides, 50,000 shapes a slide, 2,000 pictures, 50 clips, 1 GiB media, 2 h pool time     | hub CPU and rows                             | measure 10                                                       |
| ProPresenter                    | 200,000 files a folder, 256 MiB of documents in memory, 20,000 media entries beside a document | hub memory                                   | E1-E4                                                            |
| Live raster                     | 200 objects, 16 pictures, 192 MiB pictures a cue, 50 ms a task, p95 10 / 30 ms                 | a GO is never late                           | the content no longer depends on them                            |
| Bake                            | 60 s a picture, one canvas, one picture decoded at a time                                      | the baking computer                          | failures recorded                                                |
| Caches                          | unit 192 MiB, sprite 64-128 MiB, bitmap 256 MiB (1920 share ≤ 64 MiB, evicted first)           | asset-worker memory                          | measured with pictures                                           |
| Browser quota, phone budgets    | as design/28                                                                                   | devices                                      | Go-live check warns                                              |
| Retention counters              | as today (A28)                                                                                 | databases                                    | lossless fallbacks                                               |

### 2.5 What must land before a limit moves

- M2 before the 3 MiB inline trigger or any whole-presentation size is raised (A22 crosses the GO lead from about 3
  MiB of service). Pre-rendering itself makes inline presentations smaller (stand-ins replace big slides), so it
  does not wait for M2.
- M8 (golive-prepare) and M2 before `prerender` leaves `M9_HELD_BACK`, and before any whole-presentation size is
  raised.
- M2 and M3 before the operator's large message is lowered (A12).
- Slide pages (prerender-model) before any output reads a slide file.
- The live frame (R1) before the guard stops leaving objects out on hubs where pictures may be missing; until it
  lands a crowded slide without a picture is cut by the live clamp and W34 says "some of their shapes are missing".
- R5 before the 20,000-object slide file and the raised text bounds reach the outputs.
- effect-units (r2b) before the bake profile and the outputs' fade.
- X1 with its fuzz parity before B3-B5 are raised (the tokenizer is security-critical).
- If library-light slips to r3, the inline budgets it would allow raising (the 3 MiB trigger and the library
  snapshot sizes, A3, A19) stay where they are.

## 3. Warnings

Levels: **blocking** (the action does not happen), **critical** (something on the screens would be missing, late or
wrong during a service: shown where it starts, again **before Go live** in the playlist page's status line beside
"Download for offline use" (`OfflineControl.tsx`), where a save can still fix it, and in the Go-live check /
degraded list or the operator's health line while it applies), **advisory** (information, shown only where it
starts). Go live and GO are never blocked by a picture. Places: the import report and import card
(`PptxReport.tsx`, `PptxImportCard.tsx`); the slide card (`Slide.pptx.notes`); the editor's Drawing card and
slide-grid badge; the playlist page before Go live; the Go-live check, which is the degraded list once live
(`apps/operator/src/views/live/DegradedBanner.tsx`, `lib/degraded.ts`, new kind `picture`, one line per
presentation with counts, critical kinds first) with the progress in the top bar's cache summary
(`views/live/TopBar.tsx:51`) and on Setup; the operator's health (`apps/operator/src/lib/health.ts`, technical lines
in `DiagnosticsPanel.tsx`); Setup (`views/setup/DeviceSetupView.tsx`). Numbers and names in the wording are
examples. The interface writes "ordo" in lower case, at the start of a sentence too.

**Import report, import card, slide card**

| Id  | Trigger                                                              | Wording                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Level                                     |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| W1  | slides with a picture reason (`bytes`, `count`)                      | "12 slides are very detailed, so the screens show a picture of each that ordo makes on this computer. They stay fully editable. Making pictures: 5 of 12." Then: "Pictures ready." Closed early: "The rest are made the next time this presentation is opened on a computer, or when the service goes live."                                                                                                                                                          | advisory                                  |
| W2  | the same, imported on a device that cannot make pictures             | "The pictures of 3 detailed slides will be made when this presentation is opened on a computer with Chrome or Edge, or when the service goes live."                                                                                                                                                                                                                                                                                                                   | advisory                                  |
| W3  | `tail` slides                                                        | "This presentation is very large, so ordo stores slides 214 to 409 separately. Nothing was left out."                                                                                                                                                                                                                                                                                                                                                                 | advisory                                  |
| W4  | slide card of a `count` slide                                        | "Slide 7 has 340 shapes, more than a screen draws at once. The screens show a picture of it; nothing was left out."                                                                                                                                                                                                                                                                                                                                                   | advisory                                  |
| W5  | stand-in text shortened (A4; about 2,000-slide decks only)           | "This presentation is so large that the Stage display and search show only the start of the text on slides 1,400 and later. The slides themselves are complete."                                                                                                                                                                                                                                                                                                      | critical                                  |
| W6  | slides an older ordo simplified (§1.12)                              | "8 slides were simplified by an earlier version of ordo to fit its size limits. Re-import from PowerPoint to keep them whole; their pictures are then made on this computer."                                                                                                                                                                                                                                                                                         | advisory                                  |
| W7  | deck split (B13)                                                     | "This file has 2,350 slides. ordo imported it as 2 presentations: 'Hymnal (part 1 of 2)' and 'Hymnal (part 2 of 2)'."                                                                                                                                                                                                                                                                                                                                                 | advisory                                  |
| W8  | slides left for the finish-later job (B14)                           | "This file took a long time to read. Slides 1,201 to 1,581 show only their text for now; ordo finishes them when the hub is not busy (never during a service)."                                                                                                                                                                                                                                                                                                       | critical                                  |
| W9  | a part past the XML bounds (B4, B5)                                  | "Slide 89 has too much drawing detail for ordo to read, so only its text was imported. In PowerPoint, save the artwork as a picture and import again."                                                                                                                                                                                                                                                                                                                | critical                                  |
| W10 | past 50,000 shapes or 20,000 objects (B2, B3)                        | "Slide 35 has more shapes than ordo keeps on one slide, so the topmost shapes were left out."                                                                                                                                                                                                                                                                                                                                                                         | critical                                  |
| W11 | shape files past 512 MiB (A26)                                       | "Some drawings on slides 88 to 91 were too large to keep and were left out."                                                                                                                                                                                                                                                                                                                                                                                          | critical                                  |
| W12 | media past a kept bound (B9-B11, B24)                                | "This file has more than 2,000 pictures; the rest were not imported (slides 3, 7 and 9)." / "This file has 60 videos and sounds; the first 50 were imported, and the others show their still picture." / "This file's pictures and videos are larger than ordo imports at once (1 GB); 12 were left out." / "40 pictures could not be imported because they are larger than ordo can use (slides 3, 7 and 9). In PowerPoint, use Compress Pictures and import again." | critical                                  |
| W13 | colour effects past the bake bound (B23)                             | "Colour effects on 40 pictures could not be applied, so they show in their original colours."                                                                                                                                                                                                                                                                                                                                                                         | critical                                  |
| W14 | a table, diagram or text box past its bound (B18, B19, B26, B28, E6) | "The table on slide 6 is larger than ordo reads (more than 4,096 cells), so it is not shown." / "A diagram on slide 12 is larger than ordo reads, so it is not shown." / "A text box on slide 4 had more than 20,000 characters; the rest was left out."                                                                                                                                                                                                              | critical                                  |
| W15 | notes past their bound (B27, F5)                                     | "Speaker notes of 12 slides were shortened: this presentation has more notes than ordo keeps (1 MB)."                                                                                                                                                                                                                                                                                                                                                                 | advisory (W61 where the Stage shows them) |
| W16 | zip bounds (B7)                                                      | "This file is damaged or is not a PowerPoint file ordo can read. Nothing was imported."                                                                                                                                                                                                                                                                                                                                                                               | blocking                                  |
| W17 | XML past 1 GiB declared (B6)                                         | "ordo could not read this file: it holds more slide data than ordo reads (1 GB at most). Nothing was imported. In PowerPoint, save very detailed artwork as pictures and import again."                                                                                                                                                                                                                                                                               | blocking                                  |
| W18 | slide over the slide-file bound (A7)                                 | Import: "Slide 30 is too large to keep whole (18 MB; ordo keeps at most 16 MB a slide), so only a simpler version of it was imported." Editor: "This slide is too large to save (18 MB; a slide can be at most 16 MB). Remove some shapes or split it into two slides."                                                                                                                                                                                               | critical (import); blocking (editor save) |
| W64 | ProPresenter media not found within the walk bound (E4)              | "ordo looked through the first 20,000 files beside 'Easter.pro' for its pictures and videos; 3 were not found, so their slides show without them. Put the document and its media in a folder of their own and import again."                                                                                                                                                                                                                                          | critical                                  |
| W65 | ProPresenter folder past the memory bound (E2)                       | "This folder holds more than 256 MB of ProPresenter documents, more than ordo imports at once. Import it in smaller parts."                                                                                                                                                                                                                                                                                                                                           | blocking                                  |

Every critical line above also writes a slide note (`Slide.pptx.missing` or `Slide.cut`), so the playlist page and
the Go-live check repeat it: "Slide 35 of 'Sunday deck' was imported with parts left out: [the import's words]".

**Editor (Drawing card, slide-grid badge, Presentation panel)**

| Id  | Trigger                                                                                       | Wording                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Level                             |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| W19 | the switch and the default                                                                    | "Pre-rendered: the screens show a picture of this slide that ordo makes on a computer when you save. It appears at once and looks exactly like this." / "Live: each screen draws the slide itself. Text stays sharp at every size, but a detailed slide can take a moment to appear." Presentation panel: "Detailed slides: Pre-rendered (recommended) or Live. Live keeps text sharp at any size, but very detailed slides can appear late."                                                                         | advisory                          |
| W20 | picture status                                                                                | "Picture ready." / "Making the picture on this computer." / "Picture not made yet. It is made on a computer, or by the venue computer when the service goes live." / "Changed: the picture is being made again. Until it is ready, the screens draw the slide themselves." On a device that cannot make pictures: "Changed: the picture will be made on a computer with Chrome or Edge, or when the service goes live. Until then the screens draw the slide themselves." Always: "Picture made on <device>, <date>." | advisory                          |
| W21 | Live chosen, estimate 0.3-3 s at 4K (R4 scaled)                                               | "Drawing this slide live takes about 1.4 seconds on a 4K screen. If you show the slides in order, it will be ready in time. If you jump to it, parts may appear a moment late. Pre-rendered shows it at once."                                                                                                                                                                                                                                                                                                        | advisory here; W35 before Go live |
| W22 | Live chosen, estimate over 3 s                                                                | "Drawing this slide live takes about 12 seconds on a 4K screen. During the service it may still be appearing when you get to it. Use Pre-rendered."                                                                                                                                                                                                                                                                                                                                                                   | critical                          |
| W23 | Live chosen, a part no task can draw (C8, D11) or past the live text bounds (C5)              | "One part of this slide is too detailed for the screens to draw live, so they would show a simpler version of it. Use Pre-rendered."                                                                                                                                                                                                                                                                                                                                                                                  | critical                          |
| W24 | anchors past 200 or 16 playing pictures (D2)                                                  | "This slide has more moving parts than a screen can play at once, so some of its words appear from the start instead of one step at a time, and 2 videos show their still picture."                                                                                                                                                                                                                                                                                                                                   | critical                          |
| W25 | an add or paste past the live counts (C18, F12)                                               | "This slide now has more parts than the screens draw at once, so ordo will show it from a picture it makes when you save. You can still edit everything."                                                                                                                                                                                                                                                                                                                                                             | advisory                          |
| W26 | saved on a device that cannot make pictures (phones, compact layouts, iPads, Safari, Firefox) | "This slide's picture will be made on a computer with Chrome or Edge. Open ordo there, or the venue computer will make it when the service starts."                                                                                                                                                                                                                                                                                                                                                                   | advisory                          |
| W27 | slide file missing on the hub                                                                 | "The full copy of this slide is missing on the hub, so only its simplified version can be shown. Restore an earlier version from History."                                                                                                                                                                                                                                                                                                                                                                            | critical                          |
| W28 | picture refused as too large (D6)                                                             | "The picture of slide 12 is too large to store (40 MB), so the screens draw the slide themselves."                                                                                                                                                                                                                                                                                                                                                                                                                    | advisory (W36 before Go live)     |
| W29 | per-presentation budget (A24)                                                                 | "'Sunday deck' has more detailed slides than ordo keeps pictures for (1 GB), so 5 slides are drawn by the screens themselves, which can be slow. Split it into two presentations."                                                                                                                                                                                                                                                                                                                                    | critical                          |
| W30 | coverage miss at bake: a character no library font has                                        | "Some letters on slide 12 are not in any font ordo has, so they may not show on the screens. Upload a font that has them in Setup, Fonts."                                                                                                                                                                                                                                                                                                                                                                            | critical                          |
| W31 | stand-ins alone pass the inline budget (A5)                                                   | "This presentation has very many slides. It works, but splitting it makes iPads and phones open it faster."                                                                                                                                                                                                                                                                                                                                                                                                           | advisory                          |
| W32 | body past `putMax` (A6)                                                                       | existing: "This presentation is 40 MB, more than the hub accepts (32 MB). Split it into smaller presentations to save it."                                                                                                                                                                                                                                                                                                                                                                                            | blocking                          |
| W61 | notes past the Stage's 4,000 characters (F3), where the Stage look shows notes                | "The Stage display shows only the first 4,000 characters of the notes on slide 12."                                                                                                                                                                                                                                                                                                                                                                                                                                   | critical                          |
| W62 | the presentation default switched to Live                                                     | "12 detailed slides will be drawn by the screens themselves. 3 of them take more than 3 seconds on a 4K screen and may still be appearing when you get to them. Draw them live anyway?" [Draw live] [Keep pictures]                                                                                                                                                                                                                                                                                                   | advisory (asks)                   |
| W63 | a slide past the measured editing bound (measure 11), on that device                          | "This slide has 6,000 shapes, so editing it on this iPad may be slow. Its imported groups open locked; unlock one to change it."                                                                                                                                                                                                                                                                                                                                                                                      | advisory                          |

**Before Go live (playlist page) and the Go-live check (degraded list once live; progress in the top bar and on Setup)**

| Id  | Trigger                                                             | Wording                                                                                                                                                                                                                                                                                                                                                                                                           | Level                                 |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| W33 | pictures still being made or fetched                                | "Making pictures for 3 slides of 'Sunday deck' (2 of 3 done). Until a picture is ready, the screens draw the slide themselves, so it may appear a moment late." No device here can make them: "3 slides of 'Sunday deck' have no picture, and no computer here can make one, so the screens draw them themselves; detailed ones may appear late. Open ordo on a computer with Chrome or Edge before the service." | critical, never blocks                |
| W34 | `count` slides without a picture                                    | "2 slides of 'Sunday deck' have more shapes than a screen draws at once, and their pictures are not ready. If they are shown before then, they appear a moment late." Until R1 lands: "…they are shown with some of their shapes missing."                                                                                                                                                                        | critical                              |
| W35 | detailed slides set to Live, slow on these screens                  | Before Go live: "2 slides are set to draw live and are slow on your screens ('Easter', slides 12 and 14). If you jump to them, parts may appear late." Button "Use pictures for these" (saves Draw as: Pre-rendered). Once live: the same words, button "Use the pictures during this service" (`prerender.use`, no save).                                                                                        | critical                              |
| W36 | a picture could not be made (D3, D6)                                | "1 slide could not get its picture, so the screens draw it themselves. ordo will not try again until you press Make picture again. [Details]" For a `count` slide it adds: "It may take a while to appear on the screens."                                                                                                                                                                                        | critical                              |
| W37 | a screen's storage short of the service's bytes (A29)               | "The Lobby screen has no room for every picture of this service (needs 2.3 GB, 1.1 GB free). Slides without a stored picture are drawn by each screen itself, which can be slow. Free some space on that computer, or use a smaller screen size there."                                                                                                                                                           | critical                              |
| W38 | offline: files of the service not on this computer (A32)            | "3 slide pictures and 2 full slides of this service are not on this computer. Use 'Download for offline use' before the service."                                                                                                                                                                                                                                                                                 | critical                              |
| W39 | stand-by pictures (D8)                                              | "ordo was updated (or a font was added), so the pictures of 48 slides are being made again (12 of 48). Until then the screens use the previous pictures."                                                                                                                                                                                                                                                         | advisory                              |
| W40 | slide file missing (hub degraded line)                              | "Slide 12 of 'Sunday deck' is missing its full copy on the hub, so the screens show a simplified version (its text and pictures only)."                                                                                                                                                                                                                                                                           | critical                              |
| W41 | going live slowly, or from the saved copy (A17)                     | While preparing: "Getting 'Sunday service' ready to go live (40 %). The screens keep showing the current service until then." While live, after 5 s, a button: "Go live from the copy saved 3 days ago". Gone live from it: existing (`librarylink.ts:81-85`): "Went live from the copy of this playlist saved 3 days ago …"                                                                                      | critical; the progress toast advisory |
| W42 | an import still unfinished (B14)                                    | "'Hymnal' is still being imported: slides 1,201 to 1,581 show only their text until the hub finishes them. It never works on this during a service."                                                                                                                                                                                                                                                              | critical                              |
| W43 | budget reached (A24)                                                | W29's words                                                                                                                                                                                                                                                                                                                                                                                                       | critical                              |
| W44 | hub below the free-space floor (A25)                                | Setup and top bar: "The hub's disk is almost full (3.2 GB free). New uploads and pictures are paused so the service keeps running. Delete old media or presentations."                                                                                                                                                                                                                                            | critical; blocks uploads              |
| W58 | the running service past the goLive ceiling (D13)                   | "This service is too large to go live (40 MB). Split the longest presentations into smaller ones."                                                                                                                                                                                                                                                                                                                | blocking                              |
| W59 | the service past the size whose first save passes the GO lead (D13) | "Going live with this service takes a few seconds on the screens. Go live before the service starts."                                                                                                                                                                                                                                                                                                             | critical                              |
| W60 | the goLive listing cut (A31) or the degraded list full (A34)        | "Some slides near the end of this service are shown without their full detail: it has more files than ordo sends at once. Split the playlist into two services."                                                                                                                                                                                                                                                  | critical                              |
| W67 | Go live while two other services are getting ready (M8)             | "Another service is still getting ready to go live. Try Go live again in a moment."                                                                                                                                                                                                                                                                                                                               | blocking                              |

**Operator health**

| Id  | Trigger                                                                         | Wording                                                                                                                                                                                                                                                                                                             | Level           |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| W45 | the go-live bake runs during a service (D4)                                     | "This computer is making 2 slide pictures during the service. It pauses whenever you press GO." Setup, while the switch is off: "Make missing pictures during the service: off until this has been checked on a computer like yours."                                                                               | critical (note) |
| W46 | a screen shows a slide without its picture, or past the live frame budget (D12) | "Main screen: 1 slide shown without its picture yet (still downloading)." / "Main screen: slide 12 of 'Easter' was too slow to draw, so a simpler version of it is shown."                                                                                                                                          | critical        |
| W47 | a picture could not be decoded                                                  | "A slide picture could not be read on this screen, so the slide is drawn directly."                                                                                                                                                                                                                                 | critical        |
| W48 | `liveSlow`: a Live slide measured slow (R4)                                     | "Some slides set to draw live are slow on this screen, so parts of them may appear late." Detail: "Slide 12 of 'Easter' took 1.3 s to draw at 3840 x 2160 (estimate 1.1 s); 3 parts faded in late." Button: "Use the picture for this slide during this service". Then: "Set it to Pre-rendered after the service." | advisory (note) |
| W49 | late parts (decided 2026-11-13)                                                 | "Parts of 2 slides appeared a moment late on this screen."                                                                                                                                                                                                                                                          | advisory (note) |
| W50 | a screen's storage full (A29)                                                   | "The Lobby screen is out of storage, so 4 pictures are not kept on it and are fetched from the hub when shown."                                                                                                                                                                                                     | critical        |
| W51 | a socket closed by a limit (A12-A14; `limitClosures`, `ws.ts:100`)              | technical: "This computer's connection to the hub was reset because it sent too much at once. It reconnected by itself."                                                                                                                                                                                            | advisory        |
| W52 | a socket closed by the queued-bytes caps (A20, D14)                             | "The iPad 'Stage left' is on a slow connection; it was reconnected and is catching up."                                                                                                                                                                                                                             | advisory        |

**Setup, History, restore, phones**

| Id  | Trigger                                | Wording                                                                                                                                                                                                                                                | Level    |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| W53 | this device can or cannot bake         | "This computer makes the missing slide pictures when a service goes live." / "Making slide pictures needs Chrome or Edge on a computer. Detailed slides are drawn by the screens themselves until a computer makes their pictures, which can be slow." | advisory |
| W54 | Prepare pictures for the next service  | "Prepare pictures for the next service" → "Pictures for Sunday's service are ready (24 slides)."                                                                                                                                                       | advisory |
| W55 | library past 32 MiB (A19)              | "The library is 40 MB. Phones and iPads load a short list and fetch each presentation when it is opened."                                                                                                                                              | advisory |
| W56 | revision caps (A23)                    | History: "This presentation keeps its newest 200 versions; older ones are removed to save space."                                                                                                                                                      | advisory |
| W57 | phones (A30)                           | "This presentation is too large to open on a phone. Open it on a computer." / "This slide is shown as a picture. Edit it on a computer."                                                                                                               | advisory |
| W66 | restore with slide files missing (A37) (**deferred** in r2b sub-wave 2: with the 30-day rule a restore of a backup within retention never lacks a slide file, so the words wait for live-by-ref's longer holds) | "Restored. 2 slides of 'Easter' could not be restored whole (their full copies are no longer on the hub), so they show a simpler version." | critical |

Removed: "This service is … too large for an operator takeover" (A10, replaced by W58 and W59), the hand-back toast
(`engine.ts:1154-1165`), "over the 4 MiB budget" on save (A5), "slide n is over 64 KB: LibreOffice draws its
page", "simplified to fit the slide budget", "slide n and later keep only their text and pictures" and the
200-character cut (`pptx-core.ts:496`, :528, :537-576), and the add refusals (`ops/slides.ts:54-58`). Fixed: the
degraded list's "from PowerPoint … not fully drawn yet" title (`DegradedBanner.tsx:27`) names LibreOffice only on hubs
that have it (LibreOffice inventory §3).

## 4. Tracks for wave r2b

Seventeen tracks join the five already planned for r2b (leaf-editor, editor-table, tables-conv, effect-units,
warp-paint). Their files, briefs, tests and measures are in the wave's `tracks.json`. Sizes are agent-hours on the scale
of r2b's (3-9 h a track); about 128 h in all. Cited lines are at `1e70a19`; phones P0 (`p0/integrate`, `4785c05`)
merges into #27 before r2b's base and moves lines in `ws.ts`, `routes.ts`, `library.ts`, `store.ts`, `live.ts` and
`librarylink.ts`, so every brief says to re-cite against the P0-merged R2A first.

| Key               | Size h | Starts after                                                    | Shares files with                                                                                                                                                   |
| ----------------- | -----: | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prerender-model   |      9 | R2A                                                             | protocol (effect-units, live-by-ref: one-liners); `goLive.ts` (golive-prepare, live-by-ref, handback-ref: other hunks); domain `live.ts` (live-by-ref: other hunks) |
| xml-compact       |      8 | R2A                                                             | `nativeJob.ts` (tables-conv :587; prerender-import), `pptx-client.ts` (prerender-import, import-scale), `walk.ts` (prerender-import :673-677)                       |
| golive-prepare    |      5 | R2A                                                             | hub `live.ts` `submitQueued` and `resolve` (live-by-ref: snapshot hunks), `librarylink.ts`, `goLive.ts` :284-286                                                    |
| live-by-ref       |      8 | golive-prepare                                                  | output `link-core.ts` (effect-units, prerender-outputs: other hunks), `ws.ts` (library-light, handback-ref), `engine.ts`                                            |
| prerender-store   |      9 | prerender-model                                                 | `library.ts` (library-light: other hunks), `routes.ts` (registration lines), `store.ts` (the floor, reused by phones P2)                                            |
| live-frame        |      8 | effect-units                                                    | `units.ts`, `clamp.ts` (render-bounds: other hunks; the bake profile), `prepare/units.ts`                                                                           |
| render-bounds     |      7 | effect-units, warp-paint                                        | `clamp.ts` (live-frame), renderer `health.ts`, importers `sanitize.ts`; no hunks in `rich.ts`, `paint.ts`, `sprite.ts`                                              |
| bake-worker       |      9 | prerender-store, live-frame                                     | `capabilities.ts`, `engine.ts` (GO hook), `pptxImport.ts` (trigger), renderer `text/fonts.ts` (bake font profile)                                                   |
| prerender-outputs |      8 | prerender-store, live-frame, warp-paint                         | `link-core.ts`, `prepare/index.ts` (one line), `asset.worker.ts`                                                                                                    |
| prerender-import  |      8 | prerender-store, tables-conv, xml-compact                       | `pptx-core.ts`, `budget.ts` (tables-conv), `size.ts` (prerender-editor, golive-prepare: other hunks)                                                                |
| hub-writers       |      7 | prerender-import                                                | `reimport.ts`, `fallback.ts` :347-427, `imports.ts` :751-806, the ProPresenter job, `apps/demo/src/hub.ts`                                                          |
| prerender-editor  |      8 | editor-table, leaf-editor, bake-worker                          | `editorStore.ts`, `ops/slides.ts` (the guard only; editor-slideops converts), `size.ts` `previewSlice`                                                              |
| editor-slideops   |      6 | prerender-editor                                                | `ops/slides.ts`, `ops.ts`, `ops/clipboard.ts`, `songScript.ts`, `SongReflowEditor.tsx`                                                                              |
| golive-warnings   |      9 | prerender-outputs, bake-worker, render-bounds, prerender-editor | `degraded.ts`, `health.ts`, `TopBar.tsx`, `OfflineControl.tsx`, `engine.ts` offline check, protocol health                                                          |
| handback-ref      |      4 | live-by-ref                                                     | `liveCore.ts`, `engine.ts`, `ws.ts`                                                                                                                                 |
| library-light     |      7 | live-by-ref                                                     | `ws.ts` :539-563, `libraryStore.ts`, `library.ts`                                                                                                                   |
| import-scale      |      8 | prerender-import, xml-compact                                   | `pptx-scan.ts`, `pptx-client.ts`, `nativeJob.ts`                                                                                                                    |

Ordering with the planned tracks:
- **tables-conv**: its item 3 (keep LibreOffice's page for a table slide whose M6 group form passes 64 KB) was
  interim; the owner decided the LibreOffice inventory's question 3 on 2026-11-15 (native tables on every hub), and
  sub-wave 1b (tables-flip) removed that branch of `pageForBudget` before prerender-import, which removes the rest
  of `pageForBudget` and owns `pptx-core.ts` and `budget.ts` after it.
- **effect-units** owns `units.ts`, `clamp.ts`, `text2d.ts`, `asset.worker.ts`, `link-core.ts`, `stacks.ts` and the
  fade. `packages/domain/src/sha256.ts` is prerender-model's alone (the r2b plan, overlap 3): effect-units' unit
  keys never leave an asset worker this wave and stay in memory;
  live-frame, render-bounds, bake-worker and prerender-outputs start from its merge and reuse its `refreshFadeMs`
  and unit cache.
- **warp-paint** owns `prepare/index.ts` and the `rich.ts`, `paint.ts` and `sprite.ts` seams this wave:
  render-bounds' long-box layout split goes in a new file beside them; prerender-outputs adds one registry line.
- **editor-table** owns `SlideCanvas.tsx`, `editorStore.ts` and `ops/slides.ts`: prerender-editor starts from its
  merge and never touches `SlideCanvas.tsx` (the Drawing card is a panel section).
- **leaf-editor**'s `wholeDraw.ts` is how the editor draws a full big slide; prerender-editor reads it.
- **Phones lane** (one owner a row, stated in both lanes' briefs): capped-socket pokes (design/28 P1,
  `28-mobile.md:707`) are P1's, and library-light extends them to every client; M6 summary-only snapshots and the
  phone's read-only pre-rendered slide are P1's; the 640 preview goes on P1's view whitelist for `GET /files`
  (:709), and view sessions never get slide pages; the free-space floor (:721) and the revision caps (:715) are
  prerender-store's; revision summaries (:716) are library-light's; P2's write budget (:718) exempts the go-live
  bake's and an import's slide pages and pictures by kind. P0's `pacing.ts` is reused by import-scale's finish-later
  job and by the go-live rule of bake-worker.

Merge order: the five planned tracks as planned (1-5), then prerender-model, xml-compact, golive-prepare,
live-by-ref, prerender-store, live-frame, render-bounds, bake-worker, prerender-outputs, prerender-import,
hub-writers, prerender-editor, editor-slideops, golive-warnings, handback-ref, library-light, import-scale.
prerender-import keeps `prerender` in `M9_HELD_BACK`; the integrator lifts it only after prerender-outputs,
prerender-editor, editor-slideops, hub-writers, golive-warnings, golive-prepare and live-by-ref have merged.
bake-worker's and prerender-outputs' e2e seed big slides through the hub API (slide pages uploaded, then a
presentation PUT, with a scratch `M9_WRITES`), since prerender-import merges after them; prerender-import's e2e
covers the Import tab end to end. library-light and import-scale may move to r3 without blocking anything (their
verdicts then wait, and the inline budgets stay, §2.5). With three agents at once the wave, planned tracks
included, is about 55 h; the critical path is R2A → prerender-model → prerender-store → bake-worker →
prerender-editor → golive-warnings, about 44 h (effect-units and live-frame finish inside it).

Ports: each track has one `ORDO_E2E_PORT` (8646-8660, 8664, 8665; phones P0 holds 8661-8663) and one
`ORDO_E2E_PORT_BASE` block. Default bases are 16000-30999 (`e2e/ports.ts:11-14`, :146-148) and r2b's planned tracks
hold 11000-15999, so tracks that start from R2A take blocks outside both (31000, 9000, 10000, 2000); tracks that start
after a planned track merges reuse its block (live-frame 14000, render-bounds 15000, prerender-import 13000,
prerender-editor 11000, editor-slideops 12000); the rest take 3000, 4000, 6000 and 7000, never 5000-5999
(`tools/serve-demo.mjs:6` serves on 5173) or 8000-8999 (the shared ports); four reuse a dependency's block after it
merges (golive-warnings 3000, handback-ref 2000, library-light 10000, import-scale 9000). `e2e/ports.ts`'s comment
gains that an explicit base may sit below 16000.

## 5. Owner questions (defaults apply unless changed)

1. **Crowded slides pre-rendered too?** A slide with more shapes or pictures than a screen draws at once (over 200
   shapes, over 16 pictures, very long text) gets a picture like a big slide, so nothing is left out. Default: yes.
2. **Hubs with LibreOffice: ordo's picture also for the guard's left-outs?** On 2026-11-13 these few slides (3 in
   E) got LibreOffice's art for the left-out parts. Default: ordo's own picture instead, as for big slides.
3. **The words on a pre-rendered slide are part of the picture?** As they were in LibreOffice's page; the lyric box
   and words that appear step by step stay live. Default: yes. (Ordinary slides keep all text live.)
4. **Pictures kept exactly (lossless), or slightly compressed for photo slides?** Exact pictures are 2-18 MB at 4K
   in the worst cases; compressed ones would be several times smaller but not pixel-exact. Default: exact, plus a
   small 1080p copy and a tiny preview for phones; decide again once real slides are measured.
5. **A song item with its own background over a pre-rendered slide**: make a second picture without the slide's
   background at Go live (default), or always draw such slides live.
6. **Phones and pre-rendered slides**: read-only on a phone ("Edit it on a computer"), default; or allow typo fixes
   on phones, with the picture remade later by a computer or at Go live.
7. **Decks over 2,000 slides** (a whole hymnal): split into presentations of 2,000 ("part 1 of 3"), default; or one
   presentation up to 10,000 slides (slower on iPads and phones).
8. **When is a Live slide "slow"?** Default: a warning from 0.3 s of drawing at 4K, a strong warning from 3 s, to be
   checked on a venue PC.
9. **The 1 GB per presentation** now counts pictures, slide files and shape files with their old versions, not only
   plates. Default: yes, one budget.
10. **Very long presentations (the "tail")**: your decision of today pre-renders the slides that were simplified only
    because the whole presentation passed its size budget. They are ordinary slides the screens draw on time, and a
    long hymnal could need hundreds of pictures (2-18 MB each in the worst case), filling the 1 GB and keeping the
    venue computer busy at Go live. Default: keep them whole in separate files (never simplified) and let the screens
    draw them; a picture only for those that would be slow (over 0.3 s at 4K). Or: pictures for all of them, as
    decided.
11. **After a picture file is replaced** (a corrected photo), may the screens show the old picture until the new
    one is made? Default: no, they draw the slide themselves meanwhile. After a font upload or an ordo update the
    previous picture does stand in.
12. **Hubs with LibreOffice and no computer that makes pictures** (only iPads): show LibreOffice's page of a
    detailed slide until ordo's picture exists? Default: no; the screens draw the slide themselves, which can be
    slow, and Setup says so (W53).
13. **Making missing pictures during a service** on the venue computer: off until it has been measured not to delay
    a GO on a venue-class PC, then on. Default: yes, that order.
14. **How large may a service be?** Default: going live is refused above a size measured on a venue PC (about 32 MB
    to start), with a plain message; a warning above the size where going live takes the screens a few seconds.

Not decided here, and since decided by the owner (2026-11-15, "prioritize native tables"): the LibreOffice
inventory's question 3 (tables on hubs with LibreOffice, §1.9): the table object on every kind of hub; sub-wave 1b
(tables-flip) removed the interim rule.

**Applied in wave r2b** (the owner has not answered; the defaults): 1-4 yes; 5 yes, dormant until the go-live bake
is switched on (§1.5: such a cue draws the full slide live meanwhile); 6-9 yes; 10 tail slides kept whole in their
files and drawn live by the screens, a picture only for one whose estimate passes 0.3 s at 4K (`resolveDraw`); 11
no; 12 no; 13 yes, after measuring on a venue-class PC; 14 yes.

## 6. Risks

- **The go-live bake shares the venue PC with the screens.** PNG only, the 1920 copy first, the per-call bound, and
  off until §1.13 measure 2 passes.
- **One costly object** delays the next GO once counts stop cutting content: the worst-case object bench (R5) and the
  live frame's per-slide budget (D12) bound it; failed bakes are recorded so a hostile slide costs 60 s once.
- **Going live mid-service**: the new service is prepared beside the running one (M8); the old one keeps every key.
- **Trust**: an edit session can upload a picture for a key the hub computed, and it is first. The key check, the
  Drawing card's "Picture made on <device>" line, the venue PC's re-bake of pictures made elsewhere, and the refusal
  from phone sessions bound it, as for SVG stills.
- **Collection** must never delete a file named by a kept revision, a live lock, a bundle, `live_resolved` or a
  backup manifest within retention, and pauses when it cannot read the live process's references; its tests cover
  each (§1.13).
- **Fonts**: pictures and full-slide drawing of pre-rendered slides use library and bundled faces only, so the key
  covers what is drawn; a test bakes one slide with and without a system font installed and compares pixels.
- **Every writer through the full slide**: a writer that edits only the stand-in loses work silently; the list of
  writers in §1.8 and §1.12 is closed by tests, and `prerender` stays held back until all are converted.
- **Alpha**: a picture over live backdrops composes within 1/255 for source-over; PNG only for alpha.
- **The tokenizer** (X1) is security-critical: fuzz parity with the DOM reader before the bounds move.
- **Transport at Go live**: every pre-rendered slide adds a picture to every screen's download; cue-order fill, the
  1920-only fetch for 1080p screens and slide pages last for slides with a picture keep the first slides first;
  measured (§1.13 measure 6).
- **Rollback**: a save in an older build (0.8.1, 0.5.0) drops `prerender`; restoring the earlier version brings it
  back.
- **Volunteers may pick Live without reading**: every detailed slide has a picture anyway; the playlist page shows
  W22 and W35 before Go live with a one-press save, and during the service W35 and W48 offer "Use the pictures
  during this service" without a save.

## 7. Documents to update in the same changes (design/24)

design/27 §3.4 (its table still says "picture class" and "≤ 400 KB" geometry files, while `GEOM_FILE_MAX_BYTES` is
2.6 MB, `schemas.ts:189`), §5, §12 (raised XML and slide bounds), §13 (named exceptions removed; the live frame;
the per-call bound); design/12 (slide pages, pictures, keys at save, collection with revisions and backups, budget,
floor); design/13 (`hello.resolvedId`, `live.state`, `live.adopt`, `library.poke`, `prerender.add`, `prerender.use`,
the prepare request); design/14 (render-plan clamps, `design/14:672-675`; units; fill order; fade; the bake font
profile); design/15 (Drawing card, slide files, bake worker, every editor operation through the full slide);
design/17 "Hub returns" (hand-back by reference; the hold unchanged; the repair upload) and the goLive prepare;
design/20 (import report text, ProPresenter plan); design/23 (gates, ports); design/25 (bounds table, pages checked
at entry and clamped at use); design/28 §3.3-3.4, §3.10, P1 and P2 rows (phones' 640 previews, read-only
pre-rendered slides, pokes, summary snapshots, row owners).

## 8. Review

Two reviews of the first version (2026-11-14), 50 findings, each checked against `1e70a19`. Accepted means the claim
held in the code and the fix is in this version; partly means part of the claim or fix was wrong, and why. None was
rejected whole. R1 is the first review (28 findings), R2 the second (22).

| #     | Finding (severity)                                                                    | Checked against                                                                                                                                                                                                                                       | Verdict                       | Where now                                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1.1  | 16 MiB slide files parsed in one asset-worker slice (blocker)                         | `prepare/index.ts:13-16`, `lanes.ts:21-23`, `geom/stored.ts:166-173` (`await step(parse)`)                                                                                                                                                            | accepted                      | slide pages ≤ 256 KiB, one a lane turn, no schema check on outputs (clamp at use); 16 MiB GO test (§1.2, §1.6, §1.13, D10)                                                                                                     |
| R1.2  | M8's 30 s fetch holds every key behind a mid-service goLive (blocker)                 | `live.ts:365-379` ("Commands behind a goLive wait for it"), `librarylink.ts:176`, `slideMedia.ts:16`                                                                                                                                                  | accepted                      | M8 prepares beside the running service; goLive queued only when ready; check in a worker; saved copy offered after 5 s (§2.3 M8, W41)                                                                                          |
| R1.3  | nothing bounds one hostile object at 3840                                             | `lanes.ts:12-13`, :21-23                                                                                                                                                                                                                              | accepted                      | R5, D11, D12, failed bakes recorded (§1.3, §1.13 measure 8)                                                                                                                                                                    |
| R1.4  | `manifestId` is not a content hash                                                    | `goLive.ts:269-282`; `schemas.ts:1085-1115`; `engine.ts:676`                                                                                                                                                                                          | accepted                      | `resolvedId` = SHA-256 of the serialised copy; `manifestId` for the file cache only (M2, M3)                                                                                                                                   |
| R1.5  | live text falls back to system fonts, so pictures depend on the computer              | `fonts.ts:418-437` (raw family and legacy tail in the CSS string)                                                                                                                                                                                     | accepted                      | bake font profile, whole chain in the key, `made_by`, venue re-bake, pixel test (§1.2, §1.4)                                                                                                                                   |
| R1.6  | stand-bys do not cover font or media changes                                          | the design's own key                                                                                                                                                                                                                                  | accepted                      | `standbyId` without fonts and version; media kept (owner question 11); re-bakes on upload (§1.2, §1.4)                                                                                                                         |
| R1.7  | upload key checks recompute over revisions                                            | `library.ts:414-425`, `librarylink.ts:57`                                                                                                                                                                                                             | accepted                      | `prerender_keys` at save in the pool; membership checks (§1.3)                                                                                                                                                                 |
| R1.8  | W35's fix cannot save after goLive                                                    | `routes.ts:497-500`, `DegradedBanner.tsx:40-47`                                                                                                                                                                                                       | accepted                      | every detailed slide baked; `prerender.use`; lines before Go live; W62 (§1.4, §1.7, §3)                                                                                                                                        |
| R1.9  | no bound or warning on the running service's size                                     | `size.ts:46-52`, `goLive.ts:85`, `http.ts:104`                                                                                                                                                                                                        | accepted                      | D13, W58, W59; first save after the flip, per presentation (A10, M2)                                                                                                                                                           |
| R1.10 | 32 MiB a socket has no total                                                          | `ws.ts:23`; `28-mobile.md:707` (80 capped sockets)                                                                                                                                                                                                    | accepted                      | 4 MiB a socket, 128 MiB in all (M4, D14)                                                                                                                                                                                       |
| R1.11 | phones would decode 1920 copies                                                       | `28-mobile.md:866`, :1096, :1098                                                                                                                                                                                                                      | accepted                      | 640 preview; phones never fetch 1920/3840 (§1.2, §1.6)                                                                                                                                                                         |
| R1.12 | collection breaks restores from backups                                               | `backup.ts:156-163`; `12-hub.md:371-377`                                                                                                                                                                                                              | accepted                      | files named by manifests within 30 days kept; collection pauses; W66 (§1.3, A37)                                                                                                                                               |
| R1.13 | tail slides would fill the 1 GiB budget                                               | `size.ts:41`; the design's figures                                                                                                                                                                                                                    | accepted as an owner question | tail slides drawn from their files by default (owner question 10, which refines decision 3)                                                                                                                                    |
| R1.14 | picture rows in library deltas cost the GO worker                                     | `libraryStore.ts:255-263`                                                                                                                                                                                                                             | accepted                      | picture rows never in library changes (§1.3, M4)                                                                                                                                                                               |
| R1.15 | the M3 upload contradicts design/17's hold                                            | `17-offline-and-degraded.md:174-195`                                                                                                                                                                                                                  | partly                        | the hold wins; the upload stays only as the repair when the hub's copies are missing or bad (R1.26), bounded and parsed in the pool (M3)                                                                                       |
| R1.16 | the go-live throttle cannot split an encode                                           | the design's 4.4 s WebP encode                                                                                                                                                                                                                        | accepted                      | PNG only, 1920 first, per-call bound, off until measured (§1.4, owner question 13)                                                                                                                                             |
| R1.17 | the live set past 200 drops content                                                   | the design's W24                                                                                                                                                                                                                                      | accepted (with R2.12)         | only anchors count; static objects above drawn in slices; excess builds static, extra videos as stills (§1.5, D2, W24)                                                                                                         |
| R1.18 | a stand-in box over 20,000 characters fails the schema                                | `schemas.ts:13`, :527                                                                                                                                                                                                                                 | accepted                      | split into boxes of ≤ 20,000 (§1.2)                                                                                                                                                                                            |
| R1.19 | a refused slide file case is unspecified                                              | the design's §1.3 and W18                                                                                                                                                                                                                             | accepted                      | stand-in only, no file, no picture; W18 reworded (§1.3, §3)                                                                                                                                                                    |
| R1.20 | the 20,000-file listing cuts silently                                                 | `goLive.ts:429`                                                                                                                                                                                                                                       | accepted                      | cue order, W60 (§1.7, A31)                                                                                                                                                                                                     |
| R1.21 | the demo hub cannot store slide files                                                 | `apps/demo/src/hub.ts:506-508`, :651-670                                                                                                                                                                                                              | accepted (with R2.10)         | hub-writers stores pages in the demo, picture routes 404; Pages e2e (§1.13)                                                                                                                                                    |
| R1.22 | picture uploads from phones and edit sessions unbounded                               | the design's §1.3                                                                                                                                                                                                                                     | partly                        | phone sessions refused at the hub; a compact layout cannot be seen by the hub, so the app refuses itself; venue re-bake; "Make picture again" waits for End service (§1.3)                                                     |
| R1.23 | iPad-only churches on LibreOffice hubs lose LibreOffice's page                        | the design's §1.9                                                                                                                                                                                                                                     | accepted as an owner question | owner question 12 (default no); W53 reworded                                                                                                                                                                                   |
| R1.24 | seven wording faults (W5, W9-W14 without Go-live entry, W33, W36, W10, W21, W37, W48) | §3 of the first version                                                                                                                                                                                                                               | accepted                      | slide notes repeated at Go live; all seven reworded (§3)                                                                                                                                                                       |
| R1.25 | 1920 copies starve the bitmap cache; slide files double downloads                     | `bitmap-cache.ts:11`, `clamp.ts:63`, `link-core.ts:1692`                                                                                                                                                                                              | accepted                      | 1920 share evicted first; pages of slides with a picture last, outside "Cache 100 %" (§1.6, §1.7)                                                                                                                              |
| R1.26 | one `live_resolved` row is a single point of failure                                  | `live.ts:76-80`, :238-270                                                                                                                                                                                                                             | accepted                      | same transaction as the journal row, two copies, hash on read, "need it" (M2)                                                                                                                                                  |
| R1.27 | several bounds have no measure; uploads while live meet design/28's write budget      | `liveproc.ts:246`; `28-mobile.md:718`                                                                                                                                                                                                                 | accepted                      | measures 9-10; exemption by kind (A35)                                                                                                                                                                                         |
| R1.28 | lifting `prerender` early ships without Go-live lines                                 | the first version's §4                                                                                                                                                                                                                                | accepted                      | lifted after seven tracks (§1.11, §4)                                                                                                                                                                                          |
| R2.1  | every slide op outside the canvas edits only the stand-in (blocker)                   | `ops/slides.ts:215`, :390, :411, :590, :686, :745; `ops.ts:123`, :170, :440; `songScript.ts:129`; `ops/clipboard.ts`                                                                                                                                  | accepted                      | `withFullSlide`; new track editor-slideops; held back until converted (§1.8)                                                                                                                                                   |
| R2.2  | hub-side writers (re-import, follow-up, Make editable) use inline objects             | `fallback.ts:347-427` (`digestMatches(slide.objects…)` :350), `reimport.ts:932-934`, `imports.ts:751-806`                                                                                                                                             | accepted                      | new track hub-writers; digest over the file; bake waits for `pptx.pending` (§1.9, §1.12)                                                                                                                                       |
| R2.3  | the import sanitizer cuts text at 10,000 and families at 16                           | `sanitize.ts:33-57`, :477-484, :501                                                                                                                                                                                                                   | accepted                      | B28, F5 (render-bounds)                                                                                                                                                                                                        |
| R2.4  | the ProPresenter import was not examined                                              | `imports.ts:67-95`, :268, :321-323; `rtf.ts:80`; `pro7.ts:33`, :334, :529                                                                                                                                                                             | accepted                      | §2.2 E, X6, W64, W65                                                                                                                                                                                                           |
| R2.5  | W35 appears only after the lock (same as R1.8)                                        | `routes.ts:499`, `DegradedBanner.tsx`                                                                                                                                                                                                                 | accepted                      | as R1.8                                                                                                                                                                                                                        |
| R2.6  | other computers bake during a service                                                 | the owner's 2026-11-13 rule                                                                                                                                                                                                                           | accepted                      | only the computer that went live; others wait; hub refuses meanwhile (§1.3, §1.4)                                                                                                                                              |
| R2.7  | collisions with the phones lane's P1/P2 rows; P0 moves cited lines                    | `28-mobile.md:707-721`; `4785c05` touches `routes.ts`, `librarylink.ts`, `pacing.ts`                                                                                                                                                                  | accepted                      | one owner a row (§4); re-cite against the P0-merged base                                                                                                                                                                       |
| R2.8  | phones fetch 1920 copies (same as R1.11)                                              | as R1.11                                                                                                                                                                                                                                              | accepted                      | as R1.11                                                                                                                                                                                                                       |
| R2.9  | the bake goes through the live clamp; e2e order wrong                                 | `text2d.ts:737`, `clamp.ts:866-882`                                                                                                                                                                                                                   | accepted                      | bake profile from live-frame (bake-worker depends on it); e2e seeded through the hub API; import trigger in bake-worker (§1.4, §4)                                                                                             |
| R2.10 | offline download and the Pages demo drop slide files                                  | `OfflineControl.tsx:8-57`, `engine.ts:658-678`, `demo/src/hub.ts:506-520`                                                                                                                                                                             | accepted                      | golive-warnings (offline), hub-writers (demo) (A32)                                                                                                                                                                            |
| R2.11 | tables on LibreOffice hubs decided without the pending question                       | `inventory.md:277`                                                                                                                                                                                                                                    | partly                        | not decided here; the owner decided question 3 on 2026-11-15 (the table object on every hub, the gate a target). Rejected: "pre-render instead of LibreOffice's page", since ordo's picture cannot close a fidelity gap (§1.9) |
| R2.12 | the live set past 200 drops content; W24 misleads (same as R1.17)                     | as R1.17                                                                                                                                                                                                                                              | accepted                      | as R1.17                                                                                                                                                                                                                       |
| R2.13 | editing very large slides unmeasured; clipboard cut at 200; iPads                     | `SlideCanvas.tsx:350`, `ops/clipboard.ts:45-51`                                                                                                                                                                                                       | accepted                      | measure 11, W63, F12, W26 trigger widened (§1.8)                                                                                                                                                                               |
| R2.14 | `DEGRADED_MAX` and the listing cap hide critical lines                                | `goLive.ts:66`, :199-201, :408                                                                                                                                                                                                                        | accepted                      | one line per presentation, critical first, W60 (A34)                                                                                                                                                                           |
| R2.15 | warnings that cannot be acted on                                                      | `routes.ts:585-593` (no route deletes one revision); `DegradedBanner.tsx:27`                                                                                                                                                                          | partly                        | W29, W37, W53, W10, W21, W3, W18, W15, lower-case "ordo" and the stale title fixed; no "Remove older versions" action is added (W29's advice changed instead: old pictures already go first)                                   |
| R2.16 | e2e port blocks collide with default bases and 5173                                   | `e2e/ports.ts:11-14`, :146-148, :169; `serve-demo.mjs:6`                                                                                                                                                                                              | accepted                      | new blocks (§4)                                                                                                                                                                                                                |
| R2.17 | undeclared overlaps (warp-paint seams, `sha256.ts`, domain `live.ts`)                 | r2b plan: effect-units takes `sha256.ts`; warp-paint owns `rich.ts`, `paint.ts`, `sprite.ts`                                                                                                                                                          | accepted                      | owners stated (§4)                                                                                                                                                                                                             |
| R2.18 | `pictureUnits`' cost reasons need the renderer; wrong dependency sentence             | `packages/domain/package.json`; `packages/pptx-scene/package.json`                                                                                                                                                                                    | accepted                      | `costReasons` passed in; sentence corrected (§1.1, §1.2)                                                                                                                                                                       |
| R2.19 | stand-in text over 20,000 (same as R1.18)                                             | as R1.18                                                                                                                                                                                                                                              | accepted                      | as R1.18                                                                                                                                                                                                                       |
| R2.20 | `slideContent` returns a media id                                                     | `content.ts:52-61`                                                                                                                                                                                                                                    | accepted                      | a picture-file form chosen by the link worker (§1.6)                                                                                                                                                                           |
| R2.21 | a WebP encode at half a core takes about 9 s (same as R1.16)                          | as R1.16                                                                                                                                                                                                                                              | accepted                      | as R1.16                                                                                                                                                                                                                       |
| R2.22 | caps missing from the sweep                                                           | `schemas.ts:908`, `missing.ts:23`, `stage/src/model.ts:359`, `m9-readers.ts:20`, `sanitize.ts:40`, `FindReplaceDialog.tsx:17-19`, `svg.ts:49`, `pptx.ts:7-26`, `stored.ts:30`, `decor/files.ts:22`, `liveCore.ts:84`, `host.ts:78`, `reimport.ts:932` | accepted                      | §2.2 F; W61 for Stage notes                                                                                                                                                                                                    |

## 9. Revisions for wave r2b (2026-11-15)

The r2b plan (two critics against `62a1c3a`) changed this design where it is built:

- **r2b.1 One switch.** `PRERENDER_ON` covers every pre-render path (§1.11, §4); the tracks build each path behind
  it and test it both ways; sub-wave 4's integrator lifts it in one commit after the gate of §4.
- **r2b.2 Question 5 dormant.** The no-backdrop variant is made only by the go-live bake, which stays off until a
  venue PC measures it; meanwhile a cue with a background override draws its slide live (§1.5).
- **r2b.3 `prerender.add` from the hub only.** `LiveCommand` excludes it, so a client's `live.event` carrying it is
  refused by the protocol's parse (§1.11).
- **r2b.4 The key's slide part** is the drawn part's digest of the full slide, not the head's hash (§1.2): ids,
  origins and locks are in the pages but never change a pixel, so they never change a key; the head still names
  the file.
- **r2b.5 `sha256.ts`** is prerender-model's alone (§4).
- **r2b.6 Older builds.** The fixture of the older build is 0.8.0's schema (`2a11dc9`, main's PR #28; it replaced
  0.7.0's `62a1c3a` when main published 0.8.0 during sub-wave 1), unchanged in 0.8.1 (`14f45b1`, main's PR #30, the
  release before r2b), with 0.5.0 kept as a second (`schemas.prev05.test-util.ts`); both strip `prerender`, `draw`,
  `cut` and `meta.draw`, and 0.8.0 and 0.8.1 keep a stage look's `stagePreset` and `notesScale`
  (`schemas.look.test.ts`).
- **r2b.7 Owner defaults** applied as §5 lists them.
