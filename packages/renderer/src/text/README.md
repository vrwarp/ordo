# ordo's text engine

The rich text engine of design/27 §6, used by every drawer: the outputs' asset worker, the operator's
thumbnail worker and Konva editor, look bands and the stage's readable text. Read design/27 Decisions 5-6,
§3 (stored model), §6 (this engine), §10 (fonts), §11 (what editing needs) and §14 items 4, 7 and 9 first.

Status: **scaffold** (M2 wave 1). The pipeline runs end to end for plain left-to-right text: greedy word wrap,
both line models, one style or many, emergency breaks, valign and left/centre/right alignment. Every stage
has its final signature and a minimal body; the sections below say who builds what.

## Pipeline

```
TextObject (clamped)                                         rich.ts  layoutRich(m, o, env)  memo: object, m, env.generation
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
`RICH_STYLE_KEYS`, the font environment (`LEGACY_FONT_ENV`, `FontResolver`, `installFontEnv`,
`currentFontEnv`) and the measurers (`canvasMeasurer`, `measurerFor`, `WidthCache`).

## Rules every stage keeps

- **Logical px only.** Layout never sees the device scale. Widths are measured at the logical font size and
  positions are logical, so 960, 1920 and 3840 wide outputs, the editor and thumbnails break identically.
  Painting draws under `ctx.scale(scale)` composed with the caller's transform (thumbnails translate first,
  the editor will add devicePixelRatio), not `setTransform`.
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
  U+00A0, U+202F, U+2060, U+2007, U+2011, U+FEFF (`isGlue`), even after a space; SA runs (Thai, Lao, Khmer,
  Myanmar) at `Intl.Segmenter` word boundaries, never before a mark, ๆ or ฯ; CJK by UAX#14's classes.
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
  `Piece.script` is the first fallback script in the piece, as `textScripts` names it. A style cut inside a
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
  bullets in a box at least -indent wide, trailing whitespace hanging, emergency breaks between graphemes,
  `wrap: false` growing from its alignment; justify and distribute (`extraPerSpace` per trailing whitespace
  unit of every piece but a line's last); right-to-left paragraphs mirrored (indents and bullet on the right,
  pieces from the right, hanging whitespace on the left); valign over the box less its insets; `overflow`
  by the fit test below or by a line outside the inner width; `ink` includes bullets.
- `office.ts`: `officeLine` (page.ts's measured formulas), `officeFontPx` (editeng's rounding to whole
  points), `fitFactor` (0.5 mm slack), `searchFit` (page.ts `fitBox`'s search, literally) and `autofit`:
  the stored `fitScale` while the text fits at it, else the search from full size with widths scaled
  linearly from the layout at the stored scale, never above the stored font scale.

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
  the editor's paragraph strip edits the paragraph a soft one continues. Item A: `prepare` should give a soft
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
  run's), weight and slant of the first run.
- Uses: `firstText` (cue labels, lyric-only and next-slide bands through `lyricTextFor`, editor previews,
  slide thumbnails), the stage's `slideText`, operator search.
- Open for B: lines.ts draws a bullet only when the paragraph's first piece list is non-empty, so a paragraph
  whose first line is empty and whose soft line has text gets its label in `readableText` but no drawn bullet
  (PowerPoint draws it on the empty first line).

### D. paint-dispatch: `paint.ts`, `rich.ts`, the `text2d.ts` dispatch, bands, the editor

Paint passes and the dispatch of §6. **Done** (wave 1):
- `paintRich`: passes 1 (fill box, run highlights 0.9F above to 0.3F below the baseline), 2 (shadows, run
  else box, underlines and strikes cast them too), 3 (glow: the glyphs in the glow colour with `shadowBlur`
  = radius, zero offset), 4 (outline, 2× width, round joins), 5 (fill), 6 (underline centred 0.1F below,
  strike 0.25F above the baseline, F/18 thick, F the segment's drawn size, merged across neighbouring
  segments and stopped at the hanging whitespace: `[line.x, line.x + line.w]`), 7 (bullets, left to
  right). Hidden paragraphs are laid out, not painted. Canvas shadows ignore the transform, so offsets and
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
  the font generation (`apps/operator/src/views/editor/textRaster.ts`); legacy text stays at 1:1. Plain
  text edits go through `editText` (`packages/domain/src/textEdit.ts`, with `replaceText` and `joinText`
  for slide split and merge).
- To do: the M6 gradient over the box; an effect sprite cache for large blurs (§7.5) once the raster
  bench shows the need. Until B's autofit search lands, bands through the engine keep their full size.

### E. fonts: `fonts.ts` and the three drawers

§10 resolver.
- `FontResolver`: register faces as `FontFace('o' + hash8(scope + family + sorted face hashes), buffer,
  {weight, style, unicodeRange})`; a family enters font strings only once loaded and bumps `generation`;
  order: exact face, `fallbackFonts`, the bundled script fallback for `FaceRequest.script`, the original
  name (reported), a generic family. The legacy `fontString` (text2d.ts) uses the installed resolver.
- Install it in `apps/output/src/asset.worker.ts`, `apps/operator/src/workers/thumb.worker.ts` and the
  editor (`apps/operator/src/services/fonts.ts`); retry failed loads with backoff (`link-core.ts`
  `fontsSig` path); report uncovered text per script through `self.fonts.check` in `health.fontFallbacks`;
  take `'inter'` out of `FALLBACK_FAMILIES` once Inter is bundled.
- `referencedFontFamilies` (`packages/domain/src/resolve.ts`) and `jobFontFamilies` (`raster.ts`) cover run
  fonts, bullet fonts and `fallbackFonts`.
- Until a resolver is installed, `LEGACY_FONT_ENV` builds font strings from family names and its generation
  never changes: a font that loads after a rich object was first laid out is not picked up by the layout
  memo or the width cache (keyed by the font string). The internal names and generations fix both.
- Tests: a late-loaded font takes effect (new generation, new internal name) without a restart; families
  from runs, bullets and fallbacks are referenced.
