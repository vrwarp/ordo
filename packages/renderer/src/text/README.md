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
  font, fill and transform in effect). Add helpers; do not change existing behaviour.
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

### A. breaks-bidi: `itemize.ts`, `breaks.ts`, `bidi.ts`, `segments.ts`

Steps 1-4 of §6.
- `itemize(o)`: done for paragraphs and runs ∩ paragraphs; refine the end-mark style of empty paragraphs
  (PowerPoint's endParaRPr: the run covering the '\n'), `soft` handling.
- `breakOpportunities(text, start, end, lang)`: UAX#14 with npm `linebreak` 1.1.0 (add a `vendor.d.ts`
  module declaration for it and for `bidi-js`); U+00A0, U+202F and U+2060 never break ('Dieu !'); SA scripts
  (Thai, Lao, Khmer, Myanmar) at `Intl.Segmenter` word boundaries for `lang`; CJK by ID/CL/NS.
- `graphemeBoundaries(text, start, end)`: `Intl.Segmenter` graphemes, so Tamil 'க்ஷி' stays whole.
- `bidiParagraph(text, start, end, dir)`: UAX#9 with npm `bidi-js` 1.1.0, only when the paragraph has a
  strong RTL character or `dir` is 'ltr'/'rtl'; base direction `paras[i].rtl`, else `style.direction`, else
  the first strong character. Return `levels: null` on the all-LTR fast path. `hasStrongRtl` and
  `firstStrong` get the exact Bidi_Class R/AL ranges (D's legacy direction rule uses them).
- `prepare(it)`: pieces = maximal substrings with one style run, one level, no break opportunity inside;
  `trail`, `breakAfter` and `script` (the ISO 15924 code when a script fallback face is needed, matching
  `textScripts` in the domain).
- `segText(text, start, end, caps)`: U+200D on both sides of a style cut inside a joining-script word
  (Arabic, Syriac, N'Ko, Mongolian); the Indic cluster rule (move the cut to the cluster end, logged).
- Tests: the 'Dieu !' NBSP, Thai and CJK breaks, the Tamil grapheme, the Arabic ZWJ split (the measured
  string has the joiners), mixed-direction levels, `visualOrder`.

### B. lines-office: `measure.ts`, `lines.ts`, `office.ts`

Steps 5-10 of §6.
- `canvasMeasurer`/`measurerFor`: done (LRU of 20,000, trailing spacing subtracted); check `ctx.lang` and
  `letterSpacing` support and what Chromium returns for spaced text.
- `layoutBox`: hanging bullets (the bullet box at least -indent wide, text at marL), justify and distribute
  (`extraPerSpace` over inter-piece spaces of non-last lines; distribute also the last), right-to-left
  paragraphs starting at the right and the trailing space hanging on the visual left, `wrap: false` growth
  from the alignment, the 'ordo' meaning of `lineSpacing`/`lineSpacingPx` (scaffold: `× lineHeight × F` and
  exact pitch), soft paragraphs.
- `office.ts`: `officeLine` has page.ts's formulas; port `fitBox` into `autofit`: keep `fitScale` while
  the text fits at it, else LibreOffice's search (10 bisection steps, `floor(18·mid/100·10)/10/18·100`,
  spacing 100/90/80 %, 0.5 mm slack, run sizes `max(1, round(round(pt)·font%))`), linear widths during the
  search and one re-measure at the end; the result is never larger than the stored scale. Space before and
  after are scaled by `k` and not drawn before the first or after the last paragraph.
- Tests: page.ts parity cases (line spacing, autofit sizes, superscript), autofit never growing past the
  stored scale, edits keeping `fitScale` while the text still fits.

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

Paint passes and the dispatch of §6.
- `paintRich`: passes 1 (fill box and highlight), 2 (shadows, run else box), 3 (glow: `shadowBlur`, zero
  offset), 4 (outline, 2× width, round joins), 5 (fill), 6 (underline and strike: F/18 thick, underline at
  baseline + 0.1F), 7 (bullets); hidden paragraphs laid out, not painted; caches. Canvas shadows ignore the
  transform: multiply offsets and blur by `scale`.
- The legacy `ctx.direction` rule in `drawText`: per paragraph, only when it has a strong RTL character
  (first strong wins), so LTR text and every golden stay unchanged.
- Bands (`drawSlide2D` lyric-only and next-slide bands, `rasterLowerThird`): when the source object is rich
  or the text has strong RTL characters, lay out `readableText` (C) through `layoutRich` with the look's
  style and the object's `paras` directions.
- `apps/operator/src/views/editor/SlideCanvas.tsx`: already calls `drawTextObject`; draw rich text at
  scale × devicePixelRatio into the cached canvas, keyed by the font generation.
- Tests: paint order on `recordingCtx`, hidden paragraphs, bands with Hebrew.

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
