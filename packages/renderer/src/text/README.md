# ordo's text engine

The rich text engine of design/27 §6, used by every drawer: the outputs' asset worker, the operator's
thumbnail worker and Konva editor, look bands and the stage's readable text. Read design/27 Decisions 5-6,
§3 (stored model), §6 (this engine), §10 (fonts), §11 (what editing needs) and §14 items 4, 7 and 9 first.

Status: **M2 wave 1 integrated.** Every stage below is built (items A-E) and runs end to end in every
drawer: UAX#14 breaks with the no-break-space rule, UAX#9 bidi, cluster-safe cuts and Arabic joiners,
both line models, autofit, bullets and numbering, the paint passes and the font resolver. The renderer
goldens (`pnpm --filter @ordo/renderer golden`) draw the rich cases of design/27 §14 item 4 through it and
check that line breaks are identical at 320, 960, 1920 and 3840 px wide; `pnpm --filter @ordo/renderer
bench` times layout and raster. The converter's rich emission (M2, `packages/pptx-scene`) is a later wave.

Integration decisions (wave 1):
- `Piece.script` uses the domain's `FALLBACK_SCRIPTS` (every code `textScripts` reports and
  `SCRIPT_FALLBACK_FONTS` is keyed by, Greek and Cyrillic included), so a piece asks the resolver for the
  same face the goLive font scan ships.
- A soft paragraph is hidden with the paragraph it continues in painting too (`hiddenParas`), as itemize
  resolves it.
- A paragraph whose first line is empty and whose soft lines have text draws its bullet on that first line,
  as PowerPoint does and as `readableText` labels it.
- Bands through the engine shrink with B's autofit search (`bandObject` sets `autofit: 'shrink'`), never
  below half size (`BAND_MIN_FONT_SCALE`, drawText's `minScale`, through `layoutRich`'s `minFontScale`), and
  keep soft lines soft, so a soft line takes its paragraph's direction as on the slide.

Bounds (review of wave 1; `rich.fuzz.test.ts` and `clamp.test.ts` keep them):
- An emergency break costs what its line holds (lines.ts header): galloping cut search, cluster boundaries
  found only as far as asked and shared by every line and autofit step of a piece, the rest of the word
  carried unmeasured (`Measured.lazy`) until it may fit (its trailing whitespace hangs there as on any line:
  a cut never lands in it), and the autofit search computing heights only.
  A 10,000-letter word in a 0-200 px box measures about n characters per layout, not n²/line.
- `WidthCache` keeps strings of at most 256 units; `memoMeasurer` (one layout) keys by state, then text.
- At most 16 distinct run and bullet families and 64 size scales per object (`FontBudget`, clamp.ts and
  sanitize.ts), so no object costs more platform font lookups than a slide of ordinary text; family names
  lose every C0 and C1 control character, and a family is keyed by its cleaned name (trimmed, lower-cased)
  and keeps the spelling first seen, so case, spaces, quotes and controls never make another font string.
- Bullets are drawn within 4-1,000 px; raised and lowered runs at no less than 4 px.

## Pipeline

```
TextObject (clamped)                                         rich.ts  layoutRich(m, o, env)  memo: object, m, env.generation
  (o without style.fitScale unless storedFitHolds(o, env))
  1 itemize(o)            → Itemized {paras: ItemPara[]}      itemize.ts   paragraphs, runs ∩ paragraphs, resolved styles
  2-4 prepare(it)         → PreparedPara[] {bidi, pieces}     segments.ts  bidi.ts (UAX#9), breaks.ts (UAX#14), pieces
  11 paraBullets(o, it)   → (BulletSpec | null)[]             bullets.ts   labels from @ordo/domain paraLabels
  5-10 layoutBox(...)     → RichLayout                        lines.ts     measure.ts, office.ts: widths, lines,
                                                                           line model, autofit, align, anchor
paintRich(ctx, o, l, scale, env)                              paint.ts     the paint passes
drawRichText(ctx, o, scale)                                   rich.ts      clamp (memo) → layoutRich → paintRich
```

Public surface (`index.ts`, re-exported by `@ordo/renderer`): `Measurer`, `Seg`, `LaidLine`, `RichLayout`,
`FontEnv`, `FaceRequest`, `layoutRich`, `paintRich`, `isRichText`, `drawRichText`, `clampTextObject`,
`RICH_STYLE_KEYS`, `storedFitHolds`, the font environment (`LEGACY_FONT_ENV`, `FontResolver` and its
`FontFile`, `FontHost`, `FontChange` and `FontSyncResult` types, `internalFamilyName`, `installFontEnv`,
`currentFontEnv`, `METRIC_FAMILIES`, `metricCompatible`) and the measurers (`canvasMeasurer`, `measurerFor`,
`WidthCache`).

## Rules every stage keeps

- **Logical px only.** Layout never sees the device scale. Widths are measured at the logical font size and
  positions are logical, so 960, 1920 and 3840 wide outputs, the editor and thumbnails break identically.
  Painting draws under `ctx.scale(scale)` composed with the caller's transform (thumbnails translate first;
  the editor passes stage scale × devicePixelRatio in `scale`, since canvas shadows ignore the transform),
  not `setTransform`.
- **Offsets are UTF-16 offsets into `TextObject.text`**, the canonical text. Case mapping and joiners are
  applied to the drawn string only (`segText`), never to offsets.
- **Inputs are clamped.** `layoutRich` and `paintRich` take `clampObject` output: runs sorted,
  non-overlapping and inside the text, at most 1,000 paragraph styles, sizes bounded. `drawRichText` clamps
  (memoised by identity). `Seg.run` indexes the clamped `runs`; -1 is the box style.
- **Absolute coordinates, rotation not applied.** `LaidLine`, `Seg` and `ink` are in slide coordinates of
  the unrotated box; `paintRich` rotates about the box centre (`withRotation`).
- **Pure and deterministic.** No `Date`, no randomness, no reading the canvas state. The same object,
  measurer and font generation give the same layout. Allocation is fine (layouts are memoised, nothing here
  is on the frame path).
- **Never throws, always bounded.** `rich.fuzz.test.ts` feeds hostile objects; keep it passing and extend
  its arbitraries when a stage reads a new field.
- **Legacy is unchanged.** Objects without `runs`, `paras` or any `RICH_STYLE_KEYS` field go through
  `drawText` byte for byte (the goldens guard it, all at max delta 0). `isRichText` counts presence, so
  `runs: []` stays rich: an object never switches engines because its last run was cleared.
- **The 'ordo' line model is drawText's vertical model.** `rich.test.ts` checks top, baseline, pitch and x
  against `layoutText` line by line; that test must keep passing.
- **measureText and fillText see the same string in the same state** (font, direction, lang, spacing).

## Shared files

- `types.ts`: every type that crosses a stage. Changes are additive (a new optional field, a new type);
  renaming or removing a field needs the other owners' agreement. Public types follow design/27 §6 exactly.
- `rich.ts`: the orchestration order above is fixed. A stage that needs more input gets it through its own
  signature from data already in the pipeline, not by reordering stages.
- `test-util.ts`: `testMeasurer({ em, advance })` (fixed advance per code point, joiners zero wide,
  `calls` and `texts` recorded) and `recordingCtx()` (a fake 2D context that records draw calls with the
  font, fill and transform in effect, and the rest of the state in `state`: direction, alignment, lang,
  spacing, alpha, shadow, stroke). Add helpers; do not change existing behaviour.
- `clamp.ts`, `packages/domain/src/schemas.ts`, `packages/importers/src/sanitize.ts`: the scaffold wired every
  M2 field. A stage that needs a different bound changes the clamp and its property test together.

## Contracts

`Measurer.width(font, dir, lang, spacingPx, text)` is the advance of `text` drawn in that state **without**
the letter spacing after its last character. A piece followed by another on the same line therefore
advances by `w + letterSpacing` (lines.ts `Measured.a`).

`FontEnv.font(req)` returns the CSS font string for `ctx.font` at `req.sizePx` (logical). `generation`
changes whenever the face set changes; layouts memoised under another generation are recomputed.

`FontEnv.metricMatch(family, fallbacks)` (optional) says whether text in `family` is drawn with the family's
own face or a metric-compatible one. **PowerPoint's stored autofit scale is kept only then** (design/27 §6
step 10): PowerPoint computed `fitScale` with the family's own widths, and a face of other widths breaks
the lines elsewhere. Aptos has no metric substitute, so a box PowerPoint shrank to 92.5 % at 90 % spacing
for Aptos is drawn with Inter; Inter is wider, the text still fits at that scale, but every line breaks
differently from PowerPoint and from LibreOffice, which fits again from full size (37 pt at 100 % spacing
instead of 41 pt at 90 %). So `layoutRich` lays out a box whose family is not matched without its stored
scale (`storedFitHolds`; the object keeps it), and office.ts fits it from full size as LibreOffice does.
Metric-compatible faces (Carlito for Calibri, Liberation for Arial, Times New Roman and Courier New,
Caladea for Cambria, Gelasio for Georgia: `METRIC_FAMILIES`) keep PowerPoint's scale, which is what
PowerPoint draws there. Uploading the real family brings the stored scale back (the generation changes).
An environment without `metricMatch` (`LEGACY_FONT_ENV`, tests) keeps the stored scale.

`Seg.shift` is positive downwards (a superscript is negative): `-baseline × size`, where size is the run's
size after autofit; the drawn `sizePx` of a raised or lowered run is `0.58 × size`, and it never grows the
line (§6 step 7). `LaidLine.x` excludes the bullet; `bullet.x` is the left edge of the bullet text.
`RichLayout.ink` is the union of the laid lines; the text fill box (`style.fill`) is `ink` grown by the
insets, as `drawText`'s block is grown by `padding`.

## Parallel items

Each item owns its files; edits elsewhere are listed with the item. Every item adds unit tests next to its
files with `testMeasurer` and keeps `rich.test.ts`, `rich.fuzz.test.ts`, the clamp, sanitize and compatibility
tests and the goldens passing.

### A. breaks-bidi: `itemize.ts`, `breaks.ts`, `bidi.ts`, `segments.ts`, `vendor.d.ts`

Steps 1-4 of §6. **Done** (M2 wave 1); tests in `itemize.test.ts`, `breaks.test.ts`, `bidi.test.ts`,
`segments.test.ts` and `vendor.test.ts` (the browser bundle).
- `itemize(o)`: a soft paragraph takes the style of the paragraph it continues and overrides only what its
  own `paras[i]` sets (`resolveParaStyle(style, p, base)`). An empty paragraph's end mark is the run covering
  its '\n'; the last paragraph, which has none, takes the run covering the '\n' before it.
- `breakOpportunities(text, start, end, lang)`: UAX#14 (`linebreak` 1.1.0, typed in `vendor.d.ts`, which
  `breaks.ts` references so every app that compiles the renderer gets it); no break on either side of
  U+00A0, U+202F, U+2060, U+2007, U+2011, U+FEFF (`isGlue`), except after a breaking space (UAX#14 LB18,
  as LibreOffice breaks ". \u00A0"); SA runs (Thai, Lao, Khmer, Myanmar) at `Intl.Segmenter` word
  boundaries, never before a mark, ๆ or ฯ; CJK by UAX#14's classes.
  `isBreakSpace` (the trailing whitespace that hangs) is space, tab and the breaking space separators
  (U+1680, U+2000-U+200A except U+2007, U+205F, U+3000).
- `graphemeBoundaries(text, start, end)`: clusters, i.e. `Intl.Segmenter` graphemes joined across a
  conjunct-forming virama. Graphemes alone split Tamil 'க்ஷி' (UAX#29 GB9c covers six Indic scripts only);
  Tamil's pulli joins only in க்ஷ and ஸ்ர, Sinhala's al-lakuna only before a ZWJ. Without `Intl.Segmenter`:
  code points with marks, joiners, emoji modifiers and tags attached, and no SA dictionary breaks.
- `bidiParagraph(text, start, end, dir)`: bidi-js 1.1.0 (its own types), only for a right-to-left base or a
  paragraph with R/AL or RLE/RLO/RLI; astral characters go in as two BMP characters of their class (bidi-js
  classifies UTF-16 units). `levels` is null when uniform. `hasStrongRtl` uses the exact R/AL classes
  (generated from bidi-js's data, unassigned defaults included); `firstStrong` follows UAX#9 P2 (isolates
  skipped).
- `prepare(it)`: resolves 'auto' over the whole soft-break chain, so `PreparedPara.bidi.level` is the
  paragraph's direction: **use it, not `ParaStyle.dir`, for where lines start (B)**. Pieces are cut at
  style runs, levels, break opportunities, and between two fallback scripts (Han and kana count as one);
  `Piece.script` is the first fallback script in the piece, as `textScripts` names it (`scriptOf` reads the
  domain's `FALLBACK_SCRIPTS`). A style cut inside a
  cluster moves to the cluster's end; `PreparedPara.movedCuts` counts them.
- `segText(text, start, end, caps)`: U+200D on a side where the cut splits two joining letters (Arabic,
  Syriac, N'Ko, Mongolian, Adlam, by ArabicShaping joining types: none after alef, dal or waw). It applies at
  any cut, an emergency break included, so a measured and a drawn string always agree.
- Known gaps: Mandaic, Manichaean, Psalter Pahlavi and Sogdian are not joined at cuts; a mandatory break
  inside a paragraph (U+2028, a lone CR) is an ordinary opportunity (`Piece` has no flag for it); `caps:
  'all'` maps case without the run's language (Turkish dotted i).

### B. lines-office: `measure.ts`, `lines.ts`, `office.ts`

Steps 5-10 of §6. Status: **done** (M2 wave 1); the rules are in each file's header comment.
- `measure.ts`: `canvasMeasurer` (LRU of 20,000, trailing letter spacing subtracted, a non-finite width is
  0), `memoMeasurer` (one layout measures each string once), `linearWidth`/`scaleWidth` (the autofit search).
  Chromium 153, probed: `letterSpacing` is added after every grapheme cluster, the last included; `ctx.lang`
  exists on DOM and Offscreen contexts; advances scale exactly with the size; kerning applies only within a
  measured string.
- `lines.ts` `layoutBox`: greedy lines (first line at marL + indent, others at marL, both ≥ 0), hanging
  bullets in a box at least -indent wide, trailing whitespace hanging at a wrap (aligned with the text at a
  paragraph end or an a:br, as LibreOffice and PowerPoint align it), emergency breaks between graphemes,
  `wrap: false` growing from its alignment; justify and distribute (`extraPerSpace` per trailing whitespace
  unit of every piece but a line's last); right-to-left paragraphs mirrored (indents and bullet on the right,
  pieces from the right, hanging whitespace on the left); valign over the box less its insets; `overflow`
  by the fit test below or by a line outside the inner width; `ink` includes bullets.
- `office.ts`: `officeLine` (page.ts's measured formulas), `officeFontPx` (editeng's rounding to whole
  points), `fitFactor` (0.5 mm slack), `searchFit` (page.ts `fitBox`'s search, literally) and `autofit`:
  the stored `fitScale` while the text fits at it, else the search from full size with widths scaled
  linearly from the layout at the stored scale, never above the stored font scale. A stored scale that
  does not hold for the face drawing the box never reaches it (`storedFitHolds` in rich.ts, Contracts).

Decisions the other items rely on:
- **Line spacing means the same in both models.** `paras[i].lineSpacing` is a multiple of single spacing
  (1.2 × F); `lineSpacingPx` is the exact pitch; a paragraph without either takes the box's `lineHeight`
  (a multiple of F: in the office model, proportion `lineHeight / 1.2`, single when that is 1). Zero is
  single. The converter writes a paragraph's spacing whenever it differs from the box's `lineHeight`.
- **F is per line**: the paragraph's main run (§6 step 7), raised by a larger unshifted run on the same
  line, as LibreOffice sizes each line by its own portions (and page.ts's CSS strut did); never by a raised
  or lowered run. An empty line takes the larger of F and its end mark.
- **Soft paragraphs continue the paragraph before them**: its alignment, indents, spacing, line spacing,
  main size and direction; no bullet, no space between them. The converter may write `{ soft: true }` only;
  the editor's paragraph strip edits the paragraph a soft one continues. `prepare` (A) gives a soft
  paragraph its paragraph's base direction.
- **`align` is visual** (left is left in a right-to-left paragraph); RTL changes the start edge: where
  indents and the bullet are, and where the last line of a justified paragraph goes.
- **Points**: 2 logical px per point (`PX_PER_PT`, both standard deck sizes).
- **Run sizes under autofit**: rounded to whole points in the office model, exact in 'ordo'; the 'ordo'
  model has no spacing scale (the search tries 100 % only and reports spacing 1).
- Tests: `lines.test.ts`, `office.test.ts` (page.ts parity: the line model numbers, the search on random
  heights and on laid-out text, the stored scale kept and never exceeded, linear widths), `measure.test.ts`.

### C. bullets-readable: `bullets.ts`, `packages/domain/src/bullets.ts`, `readable.ts` and their uses

Step 11 of §6 and `readableText` (§1, §3.2). **Done.**
- `paraLabels(o)` (domain `bullets.ts`): the port of annotate.ts `bulletOf`/`autoNumber` as `NumberCounter`
  (a counter per level keyed by type:startAt) and `autoNumberLabel` (arabic, roman, alpha, circled ①-⑳ and
  ❶-⓴, full-width, Thai and Devanagari digits; Period, ParenR, ParenBoth, Plain, Minus; `(17)` for verses;
  unknown schemes read as arabicPeriod). An empty paragraph has no label and neither counts nor ends a
  sequence; a soft paragraph has no label and its text counts for the paragraph before it; a shallower
  paragraph, or a same-level one without a number, ends a sequence; `auto` wins over `char`. Labels never
  contain a line break, a control character or a bidi override, and inputs need not be clamped.
- `WINGDINGS_TO_UNICODE`, `SYMBOL_TO_UNICODE` and `symbolFontChar(family, char)` (domain): the converter maps
  symbol-font bullets with them (U+F0xx offset stripped, unknown codes '•'); `paraLabels` maps a bullet stored
  unmapped too, and `paraBullets` then draws it in the run's family, never in the symbol font.
- `readableText(o)` (domain `readable.ts`): each label, a no-break space (`LABEL_GAP`), the paragraph. The '\n'
  count is unchanged, so `paras[i]` still describes line i (a drawer laying the result out drops `bullet`
  from them). `textScripts(text)` reports the `FALLBACK_SCRIPTS` codes (ISO 15924) present; `FaceRequest.script`
  should use the same table.
- `paraBullets(o, it)`: font (own family, else the first run's), `sizePct`, colour (own, else the first
  run's), weight, slant, language and run (for its shadow and outline) of the first run. lines.ts measures
  the label in the paragraph's direction, so a right-to-left number reads as `readableText` writes it.
- Uses: `firstText` (cue labels, lyric-only and next-slide bands through `lyricTextFor`, editor previews,
  slide thumbnails), the stage's `slideText`, operator search.
- A paragraph whose first line is empty and whose soft line has text gets its label in `readableText` and its
  bullet drawn on the empty first line (lines.ts, integration).

### D. paint-dispatch: `paint.ts`, `rich.ts`, the `text2d.ts` dispatch, bands, the editor

Paint passes and the dispatch of §6. **Done** (wave 1):
- `paintRich`: passes 1 (fill box, run highlights 0.9F above to 0.3F below the baseline), 2 (shadows, run
  else box, underlines and strikes cast them too), 3 (glow: the glyphs in the glow colour with `shadowBlur`
  = radius, zero offset), 4 (outline, 2× width, round joins), 5 (fill), 6 (underline centred 0.1F below,
  strike 0.25F above the baseline, F/18 thick, F the segment's drawn size, merged across neighbouring
  segments and stopped at the hanging whitespace: `[line.x, line.x + line.w]`), 7 (bullets, in their
  paragraph's direction; they take the first run's shadow, outline and glow in passes 2-4). Hidden paragraphs are laid out, not painted. Canvas shadows ignore the transform, so offsets and
  blur are multiplied by `scale`: `scale` is the whole device density, never folded into the context.
- Cache: `paintPlan(o, l)` (drawn strings, resolved styles, CSS colours, merged rectangles) memoised by
  layout identity; context state is assigned only when it changes.
- The legacy `ctx.direction` rule in `drawText` (`paragraphDirections`): only paragraphs with a strong RTL
  character are measured and drawn in their first strong direction, with `textAlign 'left'` for the whole
  block; LTR-only text assigns neither, and the goldens stay at max delta 0.
- Bands: `drawBandText` (lyric-only and next-slide bands in `drawSlide2D`, `rasterLowerThird`) and
  `bandObject` (rich.ts): when the source is rich, the text has a strong RTL character or the look's style
  has a rich field, `readableText(src)` goes through `layoutRich` in the look's style with
  `autofit: 'shrink'` and the source paragraphs' `rtl` (else its box `direction`).
- Editor: `SlideCanvas` draws rich text at stage scale × devicePixelRatio into the cached canvas, keyed by
  the font generation (`apps/operator/src/views/editor/textRaster.ts`); legacy text stays at 1:1. It draws
  the stored object itself under a translation (an unrotated copy kept per object), so a new density only
  paints again: the clamp and layout memos hold. Plain text edits go through `editText`
  (`packages/domain/src/textEdit.ts`, with `replaceText` and `joinText` for slide split and merge):
  retyped text keeps the style of what it replaces, text typed at a paragraph start the paragraph's (an
  empty one's end mark), and soft lines stay lines of their paragraph (design/27 §11 item 1).
- To do: the M6 gradient over the box; an effect sprite cache for large blurs (§7.5). The raster bench
  shows the need: the default lyric style's shadow (blur 12) costs about 7 ms of a 1920 raster and 20 ms
  of a 3840 one, in drawText and in the engine alike. A cache keyed by object and scale only speeds a
  repeated raster of the same object (the bench's per-job figure); a newly armed cue always misses it, so
  its first raster (about 12 ms at 1920, 8 ms without the shadow) needs a cheaper blur as well. A sprite of
  pass 2 also has to carry the caller's transform, the opacity and the font generation in its key.

### E. fonts: `fonts.ts` and the three drawers

§10 resolver. **Built** (M2 wave 1).
- `FontResolver(host)`: `sync(files)` registers each listed family's faces as `FontFace('o' +
  hash8(scope + family + sorted face keys), data, {weight, style, unicodeRange})`, all faces of a family
  under one name, and no name twice (a face set that comes back gets a salted name). A family enters font
  strings once its faces of that round have loaded and been added; `generation` changes then and
  `onChange` fires (`late` when a retry, not a sync, loaded it). A face that cannot be read or parsed is
  left out of its family's round and retried with backoff (2 s doubling to 5 min) and at once on the next
  `sync`; a retry loads the failed face alone first (one read), and only then the family again. Reads and
  parses time out (`FontHost.timeoutMs`, 15 s) and `sync` never waits for a background retry. Families a
  later list leaves out keep their faces but are no longer retried. `loaded({family,
  internal})` announces faces registered elsewhere.
- `metricMatch(family, fallbacks)`: the family's own faces when loaded, unless every one is a stand-in
  (`FontFile.substitute`: another family's face registered under its name, as the fidelity harness
  registers fontconfig's choice); else the first loaded fallback, when `metricCompatible` with the family
  (the converter lists the box family's metric substitute first); else false (ordo's default face draws).
  A stand-in is part of the face key, so a family whose flag changes loads again.
- `font(req)`: loaded internal names only, in order: the exact face, `fallbackFonts`, the script fallback
  for `FaceRequest.script` (`SCRIPT_FALLBACK_FONTS` in `@ordo/domain`), then the original family name while
  its faces have not loaded (the asset worker reports it), ordo's default face (Inter, once shipped) and
  today's generic chain `"Inter", "Segoe UI", Arial, sans-serif`. An object whose family has not loaded
  therefore draws exactly as before. The legacy `fontString` (text2d.ts) resolves through the installed
  resolver, with the first `textScripts` script of the text; with none installed it is byte for byte today's.
- Installed in `apps/output/src/asset.worker.ts`, `apps/operator/src/workers/thumb.worker.ts` and on the
  operator page (`apps/operator/src/services/fonts.ts`: the editor canvas and look previews, which redraw on
  `onFontsChanged` / `useFontGeneration`). When faces become available the asset worker posts their families
  as `ready`; the link (`link-core.ts`) draws again in place the held slides that fell back for them and,
  after a complete cache fill, asks for a retry of fonts that failed. The thumbnail worker posts late loads
  and its client drops cached thumbnails.
- `'inter'` is no longer in `FALLBACK_FAMILIES`: an output without a shipped Inter reports it.
- `referencedFontFamilies` (domain; goLive matches family names case-insensitively) and `jobFontFamilies`
  (`raster.ts`) cover run fonts, bullet fonts (not symbol fonts: their bullets are drawn mapped, in the run's
  family) and `fallbackFonts`; the asset worker reports at most 20 missing families per job.
- Tests: `fonts.test.ts` (names, stacks, retries, rounds, the layout memo following the generation), the
  domain's `resolve.test.ts`, the link's late-font refresh, and `pnpm --filter @ordo/renderer late-font`: in
  headless Chromium, in a worker and on a page, text drawn before its face loaded (after a failed read and a
  retry; through a later sync) is drawn with the face on the next draw, with the face's widths and pixels.
- Not built: the per-script coverage report. `FontFaceSet.check` says whether the matching faces have
  loaded, not whether one has the glyphs, so it cannot find text no shipped face covers; M3, which ships the
  script fallbacks, measures the text with the shipped stack before two different generic families instead
  (the widths differ where a glyph falls through).
