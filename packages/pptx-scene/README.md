# @ordo/pptx-scene

PowerPoint decks as ordinary ordo slides ([design/27](../../docs/design/27-pptx-native-renderer.md)).
The deck is untrusted input; this package reads it into a hub-internal scene IR and emits today's ordo
objects, which `@ordo/renderer` draws like any other slide.

```ts
import { emitSlides, parseDeck } from '@ordo/pptx-scene';

const scene = parseDeck(files, { pictureSize }); // Map<part name, bytes>, e.g. extractZip(...).files
const out = emitSlides(scene, { mediaId }); // ordo Slides; pictures as 'pptxmedia:<n>' unless mapped
```

- **Pure TypeScript.** No DOM, no zip, no fs and no runtime dependency: it runs on the hub's CPU pool (M3)
  and in Node for the fidelity harness. Code outside tests imports only its own modules, _types_ from
  `@ordo/domain`, a few pure domain tables and, since M6, the renderer's geometry engine without its drawer
  (`@ordo/renderer/geom/{compile,eval,arc,path,ops,presets.gen}.ts`; `purity.test.ts` enforces it). Media parts may be empty (spilled by `extractZip`): only
  their names are used, plus their pixel size when the caller gives `ParseOptions.pictureSize` (read from
  the spilled file's first bytes).
- **Never throws for one bad slide.** A slide that cannot be read gets `error` and class `'picture'`; the
  rest of the deck is read. `parseDeck` throws only when there is no presentation part.
- **Bounded** (design/27 §12): XML ≤ 8 MB and ≤ 250k tags per part, depth 256, ≤ 2,000 slides, ≤ 5,000
  shapes per slide, group depth ≤ 32, numbers finite and clamped, no `{}` keyed by deck strings (use `Map`
  or `Object.create(null)`), no regular expression over a whole part, deck strings through `clean()` before
  they reach a note (and every note and reason cleaned once more). Work per element or paragraph never
  scales with the size of a shared layout, master, theme or presentation node: children are found through
  the name index (`firstChild`, `firstOfAny`), loops over a node's children stop at their bound, and what is
  read from a shared node (support marks, path coverage, blip effects, themes, candidate shapes by id) is
  cached per node for the deck. Parsed trees are cached by estimated size (`XML_CACHE_BYTES`), slides not at all.
  What a run, paragraph or shape does with a deck string from a shared node is bounded too: numbers longer
  than `MAX_NUM_CHARS` are not numbers, typefaces are cut to `TYPEFACE_SCAN` before they are cleaned
  (memoised), a bullet keeps its first character.

## M3: the hub's entry point (`convertDeck`) and hardening

`convertDeck(src, { range, pictureSize, newId, mediaId, extendBackgrounds, crop })` is the hub's
`pptx-scene` pool task: the slides of one batch (`range`, by `SlideRef.index`) parsed and emitted, with the
deck facts a batch needs (`frame`, `sections`, `listed`). It gives exactly what `emitSlides(parseDeck(src,
opts), opts)` gives, but emits each slide as soon as it is read, so one slide's IR is alive at a time.

Hardening after the M1 re-review (M3 item A; each case a crafted deck under the §14.3 bound of 5 s,
`limits.test.ts`, `opc.test.ts`):
- **Shared strings.** A 7M-character typeface, bullet font or bullet character and a 7M-digit size in
  `defaultTextStyle` cost each of thousands of runs or paragraphs nothing: `typefaceName` cuts to
  `TYPEFACE_SCAN` (1,024) before its regular expression runs and memoises per string (4,096 entries), so
  `themeFont` and every run's typefaces are lookups; `num` refuses values over 64 characters; a bullet's
  character is its first code point.
- **Shared nodes.** A gradient's stop list is scanned for at most `MAX_GRADIENT_SCAN` (64) children, so an
  inherited gradient with 200,000 other children costs each shape and run nothing; a colour map is read by
  its 12 names, not by its attributes (a master `p:clrMap` with 600,000 attributes, read per slide).
- **Decorations** (`walk.ts`): the master's and layout's shapes are walked once per layout and colour map
  and shared by every slide that shows them (each slide gets shallow copies, which classification marks;
  their notes are logged on every slide); decorations that read the slide's own background (`useBgFill`)
  are walked per slide. A layout decoration of 60,000 runs under 300 slides is read once.
- **Cache** (`opc.ts`): `XML_CACHE_BYTES` is 256 MB, a slide's working set (its layout, master and theme
  each at the tag limit); `slideParts` pins the parts it finds (`Package.pin`), so nothing read for a
  slide evicts them; a slide's relationships are held only while it is read, and `.rels` and content-type
  trees are never kept (their lists are, charged `REL_BYTES` each). A deck whose layout, master and theme
  are each near the tag limit parses each once. Relationship lists are indexed by type once
  (`relOfType` no longer scans a layout's 150,000 relationships per slide).
- **Backgrounds.** `pictureSize` also tells whether a picture may be transparent (`PictureHeader.alpha`: a
  PNG alpha channel or `tRNS`, a GIF's transparent colour, a 32-bit BMP, WebP's alpha flag; JPEG never;
  undefined when the bytes end first), carried in `PictureFill.px.alpha` and asked of the caller through
  `ParseOptions.pictureSize`. Only a picture known to be opaque becomes `backgroundMediaId` (drawn
  cover-fit on black); one that may be transparent stays the bottom image on white, as PowerPoint draws it.

## M3 wave 2: clips (`media.ts`, `timing.ts`)

Embedded video and sound play in place (design/27 §4 "Media", §8 "p:timing mapping"):
- `readSlideTiming` runs before the shape tree (`SlideCtx.timing`), and `readMediaRef` (from `picture.ts`)
  gives each poster its `PictureElement.media`: the embedded part (`p14:media r:embed`, else an internal
  `r:link`), or a linked clip's host; `p14:trim` (`st`, `end`: PowerPoint's `end` is how much is cut from the
  end, verified on real decks); the kind: a sound when the caller's sniff says so (`ParseOptions.mediaKind`),
  else the element, else the timing node, else the sniff (a sniffed video never overrides a sound element:
  the hub's sniff calls what it cannot tell a video); the slide's timing (start auto/click, loop, rewind = the media node's
  `fill="remove"`, `vol`, `mute`, `showWhenStopped`, `numSld`, `fullScrn`).
- `emitMedia` (called by `emitSlide` once the slide's objects are emitted): the first slide video plays in its
  poster (`ImageObject.play`), the first slide sound is `Slide.audio`, a looping, muted (or volume 0),
  automatic full-slide video at the bottom of a 16:9 slide is its motion background (`backgroundMediaId`;
  what it covered is left out, its poster kept in `EmittedClip.poster`); audio icons are drawn only when shown
  while stopped and on the slide; transition sounds only with `EmitOptions.transitionSounds`; animation
  sounds never. Clip ids are placeholders `pptxmedia:clip<n>` (`CLIP_PREFIX`, one per part and trim,
  `clipKey`), listed in `EmittedSlide.clips` with linked and missing clips; objects left out keep the art's
  and the metafiles' places (`leaveOut` remaps the element spans).

## M6 wave 2: shape geometry on real slides (`geom.ts`)

Shapes, pictures and connectors draw as PowerPoint draws them (design/27 §3.1 `ShapeGeom`, `Gradient`, the
`ShapeObject` additions and `ImageObject.mask`; §4 "Simple shapes", "Groups"; §12), always beside the legacy
values an older build draws (§3.2: `shape` rect, ellipse or line, `fill` a gradient's first stop, `radius`):
- **Presets** stay presets: `geom: { preset, adj }` (the `a:avLst` pairs, at most 10), evaluated by the
  renderer at draw time; rect and ellipse need none. A name the table does not know is its rect (approx,
  noted). The text rectangle is the preset's (`a:rect` of POI's table), placed through the shape's affine,
  so it is mirrored with a flipped shape; the connection sites are the preset's.
- **Custom geometry** (`a:custGeom`) is read with bounded scans (`readCustGeom`; attributes cut one past the
  compiler's own bounds), compiled once per node with the renderer's compiler (POI semantics, the same code
  that draws presets) and built at the shape's size: `geom.paths`, each path an `M L Q C Z` string in its own
  space (the deck's `w`/`h`, else the shape's box in logical px; written with about 1/20,000 of the space
  as precision, coarser until it fits the schema's 40,000 characters), arcs already cubic. A long deck path
  is compiled in chunks at its sub-paths (the compiler counts an arc as a full turn's 12 points) and stored
  whole when its real points fit 4,096 and its string 40,000 characters; past that it is split into stored
  paths where no sub-path of one part overlaps one of another (even-odd holes stay with their outlines, and
  every build fills the parts apart as one), else stored as a chain (`ShapeGeom.paths[].cont`, M6 wave 2
  round 1): pieces of at most 4,096 points and 40,000 characters, cut where a sub-path starts, or between
  two commands of a sub-path longer than a piece, each later piece marked `cont`, which the renderer joins
  into the one path they were cut from (one even-odd fill). That is the traced decoration of Google Slides
  templates: one outline holding 40-300 holes, 4,200-8,300 points in 7-digit EMU, which no split can hold.
  An M6 build without `cont` fills each piece apart (holes filled), a pre-M6 build draws the legacy rect.
  What the compiler replaced by 0 is noted (`custom geometry: …`) and still drawn. Native while within the
  bounds (8 stored paths, 4,096 points a sub-path, 64k points a slide); past them residual (`custGeom`, the
  LibreOffice art). A thin custom geometry's legacy is a `line`, which draws no fill, as M1 drew nothing for
  it.
- **Gradients** (`a:gradFill`): `gradient` with the stops (≤ 16, laid on white for backgrounds); linear with
  `angle` and `scaled` as written (`rotWithShape="0"`: turned back by the shape's rotation), path gradients
  radial from the centre of `a:fillToRect` (`rect` and `shape` paths noted as radial). Background gradients
  are drawn; gradient text paints the box (`TextStyle.paint`, `richtext.ts`), a run in another gradient
  keeps its first stop (noted). Pattern fills stay their blended colour (approx, noted).
- **Lines**: `dash` from `a:prstDash` (all eleven), `a:custDash` the nearest by its lengths (noted); `ends`
  from `a:headEnd`/`a:tailEnd` with their sizes. Joins (`a:round`/`a:bevel`/`a:miter`) and caps (`cap`)
  become `lineJoin` and `lineCap` when they are not the defaults (miter, flat; M6 repair, below).
- **Effects**: `shadow`, `glow` and `softEdge` of a visible shape from the nearest `a:effectLst` along the
  chain, else the theme's effect style (`a:effectRef`, `phClr` its colour). An invisible shape's shadow still
  falls on its text.
- **Flips** (design/27 §4 "Groups"): the composed affine of every group level (offset, `chOff`/`chExt`
  scale, rotation, flips) is decomposed into a box, a rotation and `flipH` (a vertical flip is a horizontal
  one turned half a turn, exact for any shape, and PowerPoint's upside-down text with it), written on pictures
  and on shapes whose geometry or gradient it changes. Text is never mirrored.
- **Pictures**: `mask` from the clip geometry (every preset, custom paths; ellipse and roundRect keep their
  legacy `radius`), `flipH`, and the outline along the same geometry with its dash. A shape's picture fill
  is clipped to the shape's geometry but never mirrored, and drawn square to the nearest quarter turn of
  the shape (`pictureFillPlacement`): the mirror-free rotation ρ becomes ρ − 90k, the box's sides swapped
  when k is odd, so a shape turned 170° shows its picture turned −10° and one turned 90° shows it upright in
  the tall box. This is LibreOffice 24.2's drawing, measured with probe decks (flips, both flips, rot 30, 90,
  120, 170, 180, 200, flips in groups), and the reference the pictures are scored against; PowerPoint is
  known not to mirror a picture fill, and its turning past 45° was not verified. The clip geometry is
  carried into the picture's box (mirrored and turned there, as paths).
- **Connectors** (`p:cxnSp`): an end glued to a shape of the same part (`a:stCxn`/`a:endCxn`: its `cNvPr id`
  and site) moves to that site after the walk (`placeConnectors`), keeping the connector's frame (rotation;
  the signs of its extents become its flips); an end that names no shape, or a site the shape lacks, keeps
  the stored geometry, and so does a connector whose stored ends are at their sites already (within 1 % of
  its length): PowerPoint keeps a routed elbow in a 1 EMU extent with an adjust value of −24,700,009, which
  re-placing would flatten. Straight connectors and lines are one `line` object with `dash` and `ends`; bent and
  curved connectors one `line` object whose box's midline runs from the route's start to its end (an older
  build draws that straight line) with the preset's route in that box as `geom.paths` (fill none).
- **Classification**: every preset of the table, custom geometry within the bounds, gradients and line styles
  are native (no reason); approx: unknown presets (`preset:<name>`, `mask:<name>`), pattern fills, group
  children the composed affine would shear (`shear`); residual: custom geometry past the bounds. Census tiers
  are unchanged (they count feature use, not support).
- **Turned children of scaled groups** (`walk.ts` `boxAffine`): a child's box is scaled along the group's
  axes, then turned, so it is never sheared; a box turned by 45° up to 135° (or 225° up to 315°) takes the
  scales the other way round (its width the group's vertical scale), as LibreOffice imports it (oox
  `lcl_doSpecialMSOWidthHeightToggle`: "MSO acts strange in that case"). A probe deck (rect, star5,
  rightArrow and a custGeom, turned -40° to 145°, in groups scaled 2.5:1 and 1:3, rotated, mirrored either
  way and both, nested) scores 0.9987-0.9996 against LibreOffice 24.2 (0.886-0.931 with the scales never
  swapped). LibreOffice's newer source also turns a swapped box in a mirrored group a further half turn;
  24.2 does not, and neither does `boxAffine`. Such children are approx (`shear`), not residual: PowerPoint's
  own placement is LibreOffice's claim, not measured here.

Measured (the census over worship shards 0-2 of `validate/sample4`, 2,713 shown slides, and the five sermon
decks; tiers are features, so unchanged): T1 22.8 %, T1-T2 54.4 %, T1-T3 81.8 %, T1-T4 86.8 %, T1-T5 92.4 %.
Of the 2,220 T1-T3 slides 2,120 are native class (95.5 %; before 2,132, 96.0 %): 12 slides of one deck
became hybrid, its layout's traced decorations having paths of up to 6,532 overlapping points (LibreOffice
draws them now; before they were a rect or nothing), and one picture-class slide of the same deck became
hybrid (the art took its decorations under the object budget). 19,653 objects carry a geometry, 1,671 a gradient and 699 pictures a mask. The 73 sermon slides are
unchanged (72 native, one hybrid for its 3D).

Fidelity (`--engine native`, LibreOffice 24.2 pictures, per slide over the 1,000 slides of worship shard 2
scored both times): with this converter alone, whose renderer still ignores the new fields, 0.8616 →
0.8623; with M6 wave 2 item A's renderer, which draws them, 0.8616 → 0.8813 (335 slides up by more than
0.002, 6 down; the falls over 0.01 are four picture-class slides of one template, which the hub draws with
LibreOffice and whose extra objects pass the renderer's 200-object clamp in the harness, and one table slide
by 0.014). Tier means with both: T1 0.945, T2 0.846, T3 0.873. The sermon decks stay 0.953.

### Round 2: geometry files and the slide's JSON budget (`emit.ts` `fitBytes`, `storedSlideBytes`)

design/27 §3.1 `ShapeGeom.ref`, §3.4. A traced decoration is 100-150 KB of path text in its own space, and a
Google-Slides-made template draws it on several objects of a slide at different sizes and on every slide of a layout:
slides of 140 KB to 1 MB, of which path text was 60-98 %. The converter counted only text toward
`MAX_SLIDE_BYTES`, so it called them native while the hub's `planImportSizes`, which measures the whole
slide, made them compact LibreOffice pictures (70 of the census's 2,187 native T1-T3 worship slides).
- **Geometry files.** After a slide is emitted, every geometry (`ShapeObject.geom`, `ImageObject.mask`) whose
  paths take more than `GEOM_FILE_CHARS` (2,048) of the slide's JSON, its own JSON times the times the slide
  draws it, is written once as a geometry file: its object keeps `ref` (placeholder `pptxgeom:<n>`, one per
  distinct file over the deck, or over a `convertDeck` call: `EmitOptions.geomId`), the paths go to
  `EmitResult.geoms`. Paths are in their own space, so one outline at three sizes is one file. While the
  slide as stored is still over `MAX_SLIDE_BYTES` less 4 KB (room for what the hub adds: speaker notes,
  timing), the largest remaining geometries whose paths are longer than a ref go to files too.
  `EmitOptions.geomFiles: false` keeps every path inline (the release before the schema ships `ref`, §3.2).
- **The budget as the hub counts it.** `storedSlideBytes(slide, notes)` is the slide's JSON as the hub's
  native job stores it (ULID ids, files named by SHA-256, an origin on every object, the provenance with up to
  16 notes), a few hundred bytes over the hub's own measure and never under it (`emit.geomfiles.test.ts`); a
  slide over 64 KB that way, its large geometries in files, is picture class (`more than 64 KB as stored`,
  `SLIDE_BYTES_NOTE`, `EmittedSlide.overBudget`), as the hub would make it; the text-formatting budget is
  unchanged.
- **Older builds** strip `ref` and draw the shape's legacy form (a rect with the fill, or a line for a thin
  outline), as a pre-M6 build drew every custom geometry.
- Measured (the census over worship shards 0-2 of `validate/sample4` and the five sermon decks, with the
  hub's `planImportSizes` applied to `storedSlideBytes`; 2,220 T1-T3 slides): native 2,187 in the converter
  and 2,113 in the hub before; 2,186 in both after (the one slide fewer is the text-heavy slide the hub made
  a picture already). In the hub's terms 73 T3 slides go from compact picture to native, and 10 T3 and 26
  fallback slides from compact picture to hybrid. 1,702 geometry files, 2.75 MB in all, in 25 decks (at most
  409 files and 549 KB a deck; none in the sermon decks, whose 73 slides do not change). The drawing is the same: with
  LibreOffice 24.2's pictures (`--engine native --lo-compat`), the 924 slides of shard 0, the 73 sermon slides
  and the evidence decks of shard 2 score exactly as before, slide by slide.

## M6 wave 2: tables (`tables.ts`, `tablestyles.ts`, `metrics.ts`)

A table (`a:tbl` in a `p:graphicFrame`, design/27 §15 M6, §11 "Mapping") becomes one editable rich
`TextObject` per cell (role `cell`) over locked grid shapes (role `grid`: the table's background, the cell
fills, the lines), all sharing the table's `origin.group` (the top-level group's when the table is nested).
Fills are solid (a gradient's first stop) and lines solid (dashes noted). Since fidelity round 2 the fills
and lines are one geometry object per fill and per line look (below); the background is one rect. IR:
`TableElement` (`ir.ts`); the walk reads it through `readTable`, `emit.ts` writes it through `emitTable`.
- **Residual.** A table with vertical cell text stays a `ResidualElement` ('table'): LibreOffice draws it
  into the art; one of more than `MAX_TABLE_GRID` (4,096) grid cells is not read at all. No count of cells
  decides otherwise but the slide's object budget: a table of more drawn cells (a merge counts once, the
  cells it covers not at all; R1) than a slide may have objects (`MAX_TABLE_CELLS` = `MAX_SLIDE_OBJECTS`,
  150: each cell is an object, so it could never be drawn natively) stays residual unmeasured, reason
  `budget:table`; a native table that would take its slide past the 150 objects of design/27 §5 goes to the
  art too (`classify.ts` `fitTables`, the table with the most objects first, reason `budget:table`), so the
  slide becomes hybrid, not picture; the art's text then holds the table's cells (`hybrid.ts`). A table
  within the objects whose cells' text formatting takes the slide past its 64 KB (`emit.ts`
  `MAX_SLIDE_BYTES`) makes the slide picture class, as any text does (round 2, below).
- **Grid and merges.** Column widths from `a:tblGrid`, one `a:tc` per grid column; `gridSpan`/`rowSpan`
  merge (cut at the grid), the cells they cover (`hMerge`, `vMerge`) are not drawn; a short row's missing
  cells are empty cells.
- **Styles.** `a:tableStyleId` names a style of `ppt/tableStyles.xml` (indexed once per deck), else one of
  PowerPoint's 74 built-in styles (`tablestyles.ts`, a port of LibreOffice's
  `oox/source/drawingml/table/predefined-table-styles.cxx` under the MPL 2.0, kept in its own file with its
  header; it returns the `a:tblStyle` element PowerPoint would have written, so both are read by the same
  code). Two changes from LibreOffice's table, where it differs from PowerPoint's own definitions: every line
  is 1 pt (LibreOffice leaves most widths at 0, which draws nothing) and the first/last row and column are
  bold (LibreOffice: Light Style 1 only). Parts apply in `CT_TableStyle` order, later ones overriding: whole
  table, row bands (`bandRow`, from the first body row), column bands, last column, first column, last
  row, first row, corner cells. Fills (`a:fill`, `a:fillRef`), the text style (`a:tcTxStyle`: `b`, `i`, a
  colour, `a:font`/`a:fontRef` typefaces; in the cell text's chain after the cell's own list style, before
  `defaultTextStyle`: `readTextBody`'s new `styled` argument), and lines by region (a part's
  `left`/`right`/`top`/`bottom` are its region's outline, `insideH`/`insideV` the edges inside it). The table's
  own fill (`a:tblPr`), else the style's `a:tblBg`, is drawn behind the cells.
- **Lines.** A cell's `a:lnL`/`a:lnR`/`a:lnT`/`a:lnB` override the style's line property by property (as
  LibreOffice merges them); where two cells give a shared edge different lines the wider wins, the upper or
  left one on a tie, a line beats none (LibreOffice's `TableLayouter`). No line inside a merge. Consecutive
  pieces of one look are one run, stretched over the lines they meet so corners close. Diagonal lines are
  not drawn (noted, the table approx, reason `tableDiagonal`).
- **Cells.** Margins `marL`/`marR` (91,440) and `marT`/`marB` (45,720 EMU) become the text's `insets`,
  `anchor` its `valign`; the text wraps and shrinks to fit (`autofit: 'shrink'`, no stored scale) when the
  drawing finds it overflows. An empty cell is an empty text object (to type into) in its end mark's style.
- **Rows grow** to their text: a row is as tall as its stored `h` or its tallest cell's text plus margins,
  whichever is more (a merge's extra height goes to its last row; an empty cell is one line of its end
  mark). The text is measured in the office line model with the advances and pair kerning of the faces the
  fonts draw it with (`ParseOptions.fontFace`: the run's family, its metric substitute, its script's
  fallback, ordo's default face; `metrics.ts` reads `cmap`, `hmtx`, `hhea`, `head`, `OS/2` and `GPOS` or
  the legacy `kern` table from a TrueType/OpenType file or a collection's face, bounded), breaking as the
  renderer breaks: greedily at spaces and around East Asian characters, a word kerned between the
  characters of one run as the renderer measures a piece, cut only when it is still wider than the line
  kerned; a family with no face is measured with conservative estimated widths (noted). A cell's lines are spaced by its face's line height (`FaceMetrics.lineHeight`, `hhea`
  ascender less descender: Carlito 1.22, Liberation Sans 1.12 of the size), a proportional spacing scaled
  by it over the office model's 1.2: measured with a probe deck, LibreOffice 24.2 sets a cell's lines of
  Liberation Sans 1.115 apart and Carlito's 1.215-1.225 (6 to 20 pt), and PowerPoint's new rows of 18 pt
  Calibri are 29.2 pt (22 pt and the margins).
- **Callers.** The hub's `pptx-scene` task gets the library's face files (`apps/hub/src/pptx/faces.ts`,
  WOFF and WOFF2 through `fonts/sfnt.ts` `metricTables`, which leaves out an `OS/2`, `GPOS` or `kern` past
  its 4 MB table limit), read only when a table asks for a family; the
  fidelity harness gives fontconfig's file of each family (`tools/pptx-fidelity/src/faces.ts`), the face its
  page draws with.

Measured (`--engine native --lo-compat`, the validation suite's 30 worship decks with tables, LibreOffice
24.2 pictures; deck means with LibreOffice's policies / ordo's): tables 0.605 / 0.602 against 0.535 / 0.533
with tables residual (pptx-preview 0.51), tableMerge 0.431 / 0.431 against 0.351 (pptx-preview 0.36); with
LibreOffice's pixels pasted into each hybrid slide's art box (the harness draws no art) 0.723 and 0.638.
Most of the remaining gap is dense charts of 6-9 pt text, where a line wrapped one character apart or rows
1-2 % off move every row below: design/27 §15 M6 "As built".

Tests: `tables.test.ts` (grid and objects, groups, merges, the deck's and built-in styles, flags,
backgrounds, line precedence and merging, diagonals, row growth with a fixed-advance face, line heights,
paragraph spacing, estimated widths, the substitute chain, the residual and budget rules, the 74 built-in
styles), `metrics.test.ts` (crafted fonts: format 4 and 12 cmaps, collections, truncated and hostile files),
`apps/hub/test/pptx-faces.test.ts`.

### Fidelity round 1: rows as LibreOffice sizes them (`tables.ts` `LoLines`, `metrics.ts` kerning)

The converter's rows disagreed with both the drawing and LibreOffice's, and on dense 6-9 pt charts each
error moved every row below it (cells are mostly centred). Three changes:
- **Kerning in the measure.** `FaceMetrics.kern(left, right)`: `GPOS` PairPos formats 1 and 2 of the
  'kern' feature of the 'latn' (else 'DFLT') default language system, Extension lookups unwrapped, lookups
  in index order, a subtable that does not apply passing to the next (HarfBuzz's rules), else, in a font
  without `GPOS`, the legacy table's horizontal format 0 pairs. Checked against Chromium's `measureText`
  on Carlito, Liberation Sans and DejaVu Sans words: equal to 0.01 px at 100 px, but for ligatures (`ff`),
  which the measure does not model and which only narrow. `Measure` kerns within one run between break
  opportunities, as the renderer measures a piece, so an 18 pt bold word of 124.29 pt of advances (123.88
  kerned) in a 124.11 pt column stays on its line in the measure too.
- **LibreOffice's rows** (`TableElement.lo`, for the harness's `--lo-compat` only, compat rule
  `cellRows`; the hub keeps ordo's rows). LibreOffice 24.2 sizes a row (`Cell::getMinimumHeight`) by its
  cells' text height in 1/100 mm, plus 1/100 mm, plus the margins, with the draw outliner's line spacing,
  and measured with the table probe deck (`tools/pptx-fidelity/src/table-probe.ts`, `LO_PROBE_ROWS`) that
  spacing is one of two (`LoLines`): 'font', the face's ascent and descent at the 600 dpi reference device
  (the font's pixel height rounded, then ascent and descent rounded: Carlito 1.215-1.229 × the size), or
  'independent', 1.2 × the font height truncated (`ImplCalculateFontIndependentLineSpacing`), for any face.
  The second holds after a text shape that grew to its text (its own `a:spAutoFit`, with text) earlier on
  the same slide: that shape leaves the shared outliner in font-independent mode (a group's child counts; a
  title without its own `a:spAutoFit`, `a:normAutofit`, a shape after the table, a layout's shape, a
  picture or an empty box do not; the next slide starts afresh). The probe's 324 rows, both modes, three
  faces, 6-18 pt, spacers, space after, 107 % spacing and soft breaks, match within 0.16 pt (the PDF page
  is the slide at 0.99897). LibreOffice draws the cells' text with the face's line heights all the same,
  so text in an 'independent' row runs into the cell's margins (`spill`, written as smaller insets on the
  anchor's side), and it sets each line's baseline at the face's ascent, where ordo's office model puts it
  the size plus the extra spacing below the line's top (0.07 × the size lower for Carlito): `lift` moves
  the text up by the mean difference of the two layouts' baselines from the anchor. And LibreOffice lays
  text out at the font's whole-pixel size at its reference device (`loSizePt`: 14 pt is 117 px, 0.27 %
  wider; 9.5 pt 79 px, 0.17 % narrower; measured on one line at 4.5-18 pt, within 0.15 % but 0.35 % at
  5 pt), so under the policy the cells are measured and drawn at that size: a 14 pt header of 899.2 pt kerned
  in a 916 pt cell wraps there as in LibreOffice.
- **Drawn cells.** `MAX_TABLE_CELLS` counts the cells drawn, after merges (the 666 chart: 90 grid cells,
  24 drawn); `MAX_TABLE_GRID` bounds the grid read.

Measured (`--engine native --lo-compat`, the 28 decks of the validation suite's 30 table decks without
embedded fonts, LibreOffice 24.2 pictures; LibreOffice's policies / ordo's): tables 0.591 → 0.738 / 0.588
→ 0.596, tableMerge (14) 0.432 → 0.627 / 0.432 → 0.449. Single-slide charts: depression 0.228 → 0.859,
jesus-and-stephen 0.149 → 0.894, what-does-a-seal 0.377 → 0.839 (ordo's 0.624), ten-commandments 0.434 →
0.800, 2-corinthians 0.683 → 0.811, 666 0.259 → 0.476 (now native); no deck falls. The pixel-size rule
costs one deck what the rows gave it (colossians 0.409 → 0.490 without it, 0.434 with it: 5 pt cells where
LibreOffice is 0.35 % narrower than the rule says, so one line wraps that LibreOffice keeps). Worship shard
0 (924 slides): 0.843 → 0.863 / 0.840 → 0.840, 12 table slides up, none down; the sermon decks do not
change (0.955 / 0.953). Still residual: the
charts of 79 and 90 drawn cells (with a cap of 200 they draw natively at 0.46 and 0.82, but pass the 64 KB
of text formatting and become picture class, so the cap stays until `fitTables` budgets text too; round 2
lifts it, below).

Tests: `metrics.test.ts` (crafted `GPOS` format 1, format 2 and Extension kerning, scripts and features,
the legacy table, vertical metrics, every byte of a `GPOS` corrupted, truncations), `tables.test.ts`
(kerned words kept and cut, no kerning across runs, empty cells, LibreOffice's line heights and ascents,
both modes and what triggers them, proportional and exact spacing, the policy's boxes, margins and lift,
drawn cells, the grid bound), `tools/pptx-fidelity/src/table-probe.test.ts` (the probe deck, and the
converter's LibreOffice rows against `LO_PROBE_ROWS` when this machine has Carlito and Liberation Sans),
`apps/hub/test/pptx-faces.test.ts` (kerning and vertical metrics through TTF and WOFF, an oversized `GPOS`
left out).

### Fidelity round 2: LibreOffice's table layouter (`tables.ts` `loColumns`, `loGrowRows`)

For the harness's LibreOffice policy only (compat rule `cellRows`; the hub keeps the grid's widths and
ordo's rows), the grid is laid out as LibreOffice 24.2's svx `TableLayouter` lays out an imported table
(`LayoutTableWidth`, `LayoutTableHeight`, not fitted to the frame). Two of its rules were missing:
- **Column minimums.** Every column is at least as wide as the widest minimum of its single-column cells,
  `Cell::getMinimumWidth`: the left and right text distances and 1 mm, in 1/100 mm. The table grows to the
  right (`TableElement.lo.cols`, `lo.xf` at their width), and LibreOffice's rows are measured in these
  columns.
- **Merges from the first row or column.** A merge's minimum width or height is checked only at its last
  column or row, less the ones it spans before; the subtraction loop, `for (nM = n - span + 1; nM > 0 &&
  nM < n; ++nM)`, ends at once when the merge starts at index 0, so a cell merged from the first row puts
  its whole text height on its last row, and one merged from the first column its whole minimum width on its
  last column. ordo's own rows give a merge only its shortfall over all the rows it spans.

The probe deck's two layouter slides (`table-probe.ts` `LAYOUT_SLIDES`, `LO_PROBE_LAYOUT`) pin both against
LibreOffice 24.2.7: three lines merged over two one-line rows make row 1 the whole merge from row 0 (2,055/100
mm) and row 2 the merge less row 1 from row 1 (1,200); a 3 mm column under a merge of 1,116/100 mm minimum
from column 0 becomes 1,116, and from column 1, over two 3 mm columns, the first takes its own cell's 608 and
the second 1,116 less 608. Measured (`--engine native --lo-compat`, the 30 table decks): tables 0.749 →
0.765, tableMerge (14) 0.627 → 0.661 (ordo's policies unchanged, 0.617 and 0.449); the 666 chart 0.476 →
0.756 (a 16.8 px column under a merge from column 0: every edge after it moves 10.4 px right, to within a
pixel of LibreOffice's), ground-await 0.593 → 0.797 (a merge from row 0 over two rows: every row line
after it 21.5 px lower, within a pixel); no other deck changes. The sermon decks (0.955) and worship shard 0
(924 slides, 0.865) do not change, nor do the validation suite's tables-charts-smartart decks (194 slides,
0.934). Of the table decks, both worship shards, the suite and the sermon decks, the 666 chart is the only
one with a column under LibreOffice's minimum.

Tests: `tables.test.ts` (a merge from row 0 against one from row 1, a 3 mm column under a merge from
column 0 and from column 1, the boxes under loCompat, ordo's own grid and rows unchanged),
`tools/pptx-fidelity/src/table-probe.test.ts` (the layouter slides' columns against `LO_PROBE_LAYOUT`
always, their rows when this machine has Carlito and Liberation Sans; `pdfColWidths`).

### Fidelity round 2: no cell cap below the object budget (`tables.ts` `MAX_TABLE_CELLS`)

The fixed cap of 60 drawn cells sent dense tables to the art before `fitTables` had weighed them against
the slide's 150 objects: a Bible chart of 90 drawn cells is 146 objects drawn natively, within the budget,
yet the slide was hybrid ('art:table'), the harness left the art box black and the hub showed only
LibreOffice's picture of the table. `MAX_TABLE_CELLS` is now `MAX_SLIDE_OBJECTS`: a table of more drawn
cells could never be native (each cell is an object), so it stays residual unmeasured, reason
`budget:table` (`classify.ts` reports a residual element's budget reason, not its kind); below it the
object budget (`fitTables`) and the slide's 64 KB of text formatting decide, as for any other content.
`MAX_TABLE_GRID` still bounds the grid read, and the measure, linear in the cells, is bounded by the cap
(converting the 90-cell chart's slide takes 35 ms, from 10 ms).

Measured (`--engine native --lo-compat`, LibreOffice 24.2 pictures, against the round 1 merge): the
validation suite's 30 table decks (28 without embedded fonts, the feature tables) 0.738 → 0.770,
tableMerge (14) 0.627 → 0.686, ordo's policies 0.596 → 0.600; 7 slides up and none down. The
flesh-and-spirit chart goes 0.138 → 0.817 and matthew-16v18 0.348 → 0.462, both picture class now where
they were hybrid: their text formatting passes 64 KB (the slides are 102 and 107 KB), so the hub shows
them as LibreOffice pictures with its budget warning, while the harness draws them. The four Peace verses
table slides go 0.725 → 0.930 and 0.720 → 0.805 and Coptic Plural's 0.794 → 0.953, native and editable
(slides of 53-56 KB). The two Boletim slides of 87 and 96 cells stay in the art, now as 'budget:table'
over the object budget (the art's text then holds their cells). The suite's tables-charts-smartart decks
0.934 → 0.937 (one table slide 0.739 → 0.963, hybrid → native); worship shard 0 (924 slides) 0.865 →
0.873, its three slides of these tables up and none down; the sermon decks do not change (0.955).

Tests: `tables.test.ts` (a 90-cell table native within the budget and in the art past it, a table of more
cells than the budget left unmeasured, merges counted once against the cap).

### Fidelity round 2: one grid object per fill and per line look (`tables.ts` `gridObjects`)

Each line run and each fill run was a locked object of its own, 25 to 84 per chart table, and
`TableElement.objects` counted them all, so a slide of two or three chart tables passed the 150 objects of
design/27 §5 and `fitTables` sent its largest table to the art (`budget:table`), though its grid drew in
2-8 distinct looks. Now (`gridObjects`, shared by `readTable`'s count and `emitTable`):
- **Lines.** The runs of one look (width, fill, dash) are one locked `ShapeObject` whose `geom.paths` hold
  each run as an open `M x0 y0 L x1 y1` sub-path in the table box's own space (unturned, from its top
  left; three decimals), ends stretched by half the widest line they meet as before, `fill: 'none'`,
  stroked with the look's width and colour (flat caps, so each sub-path is the line it was). When a table's
  lines have more than one look they are also split by direction, horizontal ones first, so every vertical
  line is still drawn over the horizontal ones it crosses, as when they were drawn in that order one by one.
  Two collinear runs of different looks meeting over a crossing line overlap where both are stretched;
  there the look drawn later now covers the other (a few pixels; before, the lower or right run did).
- **Fills.** The fill runs of one fill (`fillRuns`: neighbours of a row joined) are one object of rect
  sub-paths (`stroke: false`), in the box of their bounds turned as the table is. Runs of one fill never
  overlap in a well-formed table; where spans of a malformed one do, the overlapping run goes in a path of
  its own, so the even-odd fill never cuts one out of the other. The table background stays one rect.
- **Bounds.** A stored path holds at most `GRID_LINES_PER_PATH` lines or `GRID_RECTS_PER_PATH` rects (the
  4,096 points and 40,000 characters of `ShapeGeom` at the widest coordinate written, ±999,999.999), the
  pieces of one group chained with `cont`; past 8 paths a group goes on in another object.
- **Cost.** `TableElement.objects` is the background, the fill objects, the line objects and the cells.
  The slide JSON shrinks too (the 2 Corinthians chart's slide: 117 objects and 60 KB → 54 and 45 KB).
- **Older builds** strip `geom` and draw the legacy shape: a line look as the table's outline rect in that
  line (no fill), a fill as the rect of its runs' bounds (the larger first, so headers and first columns
  stay over the bands).
- **Drawing.** Drawn one sub-path at a time a look's object is the legacy line objects pixel for pixel
  (`tables.browser.test.ts`, headless Chromium, flat and turned tables at 0.5, 1 and 2 × 1920). Stroked
  together as one path, Skia rasterises a path rather than each lone segment's rect: edge pixels move by at
  most 12 of 255 and the ink stays within 1 %; where runs of one object cross (a one-look table), an edge
  pixel both covered is no longer composited twice (up to a quarter less ink there).

Measured (`--engine native --lo-compat` against round 1's merge, LibreOffice 24.2 pictures; the 30 table
decks): tables 0.749 → 0.766, tableMerge (14) 0.627 → 0.643; three slides change by more than 0.002, all
up, none down: moral-character 0.590 → 0.872 (two 60-cell tables: 173 objects drawn natively before, 125
now), colossians 0.434 → 0.601 (three tables, 163 → 111), 1000-years 0.566 → 0.631 (four tables, 191 →
115); every other slide within 0.0003. Worship shard 0 (924 slides, the same three among them): 0.9062 →
0.9068, deck mean 0.865 → 0.871, none down. The sermon decks (0.955) and the suite's tables-charts-smartart
decks (0.936) do not change; one suite slide turns hybrid → native.
Moral-character and 1000-years are now picture class in the hub, as colossians already was: with every
table native their cells' text formatting passes 64 KB (the cap waits on `fitTables` budgeting text). The
two Boletim tables (87 and 96 cells) stay residual for `MAX_TABLE_CELLS`; with the cap lifted they would
cost 146 and 153 objects (63 and 69 grid objects before).

Tests: `tables.test.ts` (one object per look, its sub-paths read back by the renderer, the legacy outline,
looks split by direction, fills by fill and their legacy boxes, a turned table, two checkered chart
tables native, `gridObjects` bounds and chains, overlapping runs), `tables.browser.test.ts` (pixels).

### Fidelity round 2, as merged (the three table branches and geometry files together)

- **Cell cap and grid objects.** With both, a table costs the slide its cells, its background and its few
  grid objects, and no count of cells applies below the slide's 150 objects. Tables that needed both are
  native now: Boletim's 87-cell reading plan is 146 objects (0.741 → 0.866) and Matthew 16v18's tables fit
  the budget together (0.348 → 0.737; 0.462 with the cap alone). The 96-cell Boletim table, 153 objects,
  stays in the art (`budget:table`). The cap's test of a table past the budget by its own objects gives
  every cell a fill of its own, since a checkerboard of two fills is now 92 objects, not 180.
- **Layouter and grid objects.** Under loCompat the grid's sub-paths are placed on LibreOffice's columns
  (`TableElement.lo.cols`) like the cells; the 666 chart scores 0.756, as on the layouter's branch.
- **Grid geometries and geometry files.** A table's fill or line geometry is an ordinary `ShapeGeom`, so
  paths over `GEOM_FILE_CHARS` go to geometry files like a traced outline's (5 files, 2.3 KB, over worship
  shards 0-2); with them the biblical-mary chart's slide is 65,017 bytes as stored and native in the hub,
  where it was a compact picture.
- **The 64 KB of text formatting.** Native tables bring their cells' text formatting with them, and
  `fitTables` weighs objects only: five charts of the 30 table decks and one suite table that were
  hybrid, their table in the art, are picture class now, and the hub shows LibreOffice's picture of them
  (in the census, in the hub's own terms, four slides go hybrid → picture; the others were compact
  pictures there already). The harness draws them natively. Sending the largest table to the art when its
  text would pass 64 KB is left to `fitTables`.

## M6 wave 2, item D: SmartArt and baked pictures (`smartart.ts`, `bake.ts`)

design/27 §4 "Pictures", §5 "Element support", §15 M6 ("SmartArt from its drawing cache as a locked group",
"Recolour and tile bakes"):
- **SmartArt** (`smartart.ts`, called by the walk for a graphic frame of the diagram URI): the frame's
  `dgm:relIds r:dm` names the data model, whose `dgm:extLst` holds `dsp:dataModelExt relId`, a relationship of
  the part holding the frame to PowerPoint's drawing of it (`diagramDrawing`, `ppt/diagrams/drawingN.xml`).
  Without one the frame stays residual ('smartart'). The drawing's `dsp:` shape elements are PresentationML's
  vocabulary: a copy of its tree with them named `p:` (DrawingML children shared, made once per drawing)
  goes through `walkTree`, so geometry, fills, lines, effects, style references and text are read as any
  shape's, with the drawing part's relationships for picture fills. The coordinates are the frame's at scale
  1 (a `dsp:grpSpPr` child space maps them like a group's; its own offset is not used: LibreOffice places
  such a drawing at that offset on the slide, PowerPoint in its frame). A node's text goes in PowerPoint's own text
  rectangle (`dsp:txXfrm`): the shape is emitted without it and the text as a frameless rect there, turned
  by the shape's rotation plus the rectangle's; a shape showing nothing keeps casting its shadow on it. The
  colour of every `a:fontRef` is the colours part's `node0` text colour (the last of its `dgm:txFillClrLst`),
  as LibreOffice applies it (`PPTShapeGroupContext::applyFontRefColor`): drawing caches often name the node's
  fill colour there, white text on white nodes. Each element gets `ElementBase.diagram` (a number per frame),
  the frame's `cNvPr id` and the frame's flattened group, and keeps its renamed node (`ShapeElement.node`),
  so classification rates it by its own XML, never by a slide shape sharing its id (drawing shapes all have
  id 0). Bounded as any shape tree (5,000 shapes a slide, groups 32 deep), and per package: a drawing can be
  named from every slide, so past `DIAGRAM_NODE_BUDGET` (2,000,000) elements of drawings read in one batch,
  further SmartArt stays residual (noted).
- **Emission** (`lockDiagram`): every object of a drawing gets `origin { src: 'pptx', shapeId: <frame>, role:
  'diagram', group }` and all but text objects `locked` (move, resize, delete and z-order only); the text
  stays editable, and is never the lyric box.
- **Classification** (`classify.ts` `wholeDiagrams`, after `refineSupport`): a drawing is native or in the
  art as a whole. One with a residual element (a real 3D bevel, vertical text …), or one the art range takes
  an element of, goes to the art entirely ('art:smartart'); then, while the slide passes 150 objects, the
  native drawing with the most objects goes too ('art:budget:smartart'), so the slide is hybrid, not
  picture. The render copy names a drawing once, by its frame (`hybrid.ts` `elementRefs`), so LibreOffice
  prints the whole frame, and keeps the drawing's relationship the data model names (`rendercopy.ts`,
  `modelDrawingRelId`), so LibreOffice prints PowerPoint's drawing rather than laying the diagram out itself. The census tier is unchanged (SmartArt is still a fallback feature: the tier
  measures feature use).
- **Baked pictures** (`bake.ts`): a blip's duotone, clrChange, grayscl, biLevel and lum (PowerPoint's
  recolour presets are these) are read with their colours resolved (`PictureFill.recolor`; `picture.ts`) in
  the fill's own colour context (a theme fill's `phClr` is its reference's colour: Office 2007's paper
  texture is a tile duotoned in `bg1`), and such a picture is native (any other blip effect, a blur say, keeps it approx). A tiled picture fill
  (`a:tile`) of a shape or a background becomes one picture of the whole box: the tile grid as shares of the
  box (`tileBakeOf`: the picture's size at its header's resolution, `PictureHeader.dpi` from PNG `pHYs` or
  JPEG JFIF, else 96 dpi, times `sx`/`sy`, its corner by `algn` then `tx`/`ty`, every other tile mirrored by
  `flip`, `a:srcRect` the part one tile shows); a tile of unknown size stays stretched. `alphaModFix` stays
  the image's `opacity`. Each distinct part and recipe gets one placeholder `pptxmedia:bake<n>`
  (`BAKE_PREFIX`, numbered across a `convertDeck` call, `EmitOptions.bakeId`), listed in `EmitResult.media`
  with its `bake`; an importer that cannot bake one maps it to the source part's picture. Metafiles are not
  baked (LibreOffice converts them). An older build draws a baked picture as the ordinary picture it is.
- **Pixels** (`applyBake`, the hub's `pptx-bake` pool task and the harness): colour effects in document
  order with LibreOffice's arithmetic (luminance (76·R + 151·G + 29·B) / 256; biLevel's 50 % is 128;
  duotone linear from the first colour to the second; clrChange within a per-channel tolerance by the
  source's format, JPEG 15, PNG and TIFF 1, BMP 0, else 9, giving `clrTo`'s colour and alpha; lum as
  PowerPoint's brightness and contrast, half the brightness before the contrast and half after), then the
  tiles, nearest-sampled from a source decoded at the tile's size (`tileSourceSize`). Bounded: 8,192 px a
  side and 16 MP for the source and the output (`BAKE_LIMITS`).
- Tests: `smartart.test.ts` (crafted decks of `smartart.test-util.ts`: placement, text rectangles and their
  rotation, the node text colour, picture fills through the drawing part, residual without a drawing, the
  whole-drawing rule for a 3D shape and for an overlap inside the art range, the object budget, ids shared
  with slide shapes, a layout's SmartArt, hostile drawings: 6,000 shapes, 40 nested groups, one large
  drawing named from 40 slides, under 5 s), `bake.test.ts` (each effect's pixels, tile geometry, flips and
  offsets, limits, emitted placeholders for pictures, tiled shape fills and tiled backgrounds, numbering
  across slides), `picture.test.ts` (recolour reading, header resolutions).

## M6: the object budget (`classify.ts` `shapeRuns`, `fitShapes`; `emit.ts`; `geom.ts` `shapePiece`)

design/27 §5 "picture", §15 M6 ("no slide goes above 150 objects without becoming hybrid"). Traced
decorations and icon grids are hundreds of z-adjacent, text-less custom-geometry pieces of a few fills, and
the converter emits one object per shape, so such slides passed `MAX_SLIDE_OBJECTS` and were picture class:
only tables (`budget:table`) and SmartArt drawings (`budget:smartart`) were ever split off to the art.
- **Shapes of one look are one object** (`shapeRuns`, only on a slide that passes the budget with every
  shape apart; `slideCost(…, frame)` counts it so, and tables and drawings go to the art only when that is
  not enough). A run is consecutive shown shapes without text, of the slide's verdict native, in one
  top-level group or among one layout's or master's decorations (the slide's own ungrouped shapes stay
  apart), with the same opaque solid fill (or none) and the same opaque solid line (or none, not both),
  no arrowheads, no shadow, glow or soft edge, a known preset or custom geometry within the bounds, inside
  the render clamp's bounds, none in the art; at most 8 paths together (`GEOM_LIMITS.paths`), each path
  string within 40,000 characters once written in the run's box (`mergedChars`, a bound from the number
  of coordinates and the farthest point). The object (`emit.ts` `emitMerged`, at the run's first element,
  `ShapeElement.merge`) is a `ShapeObject` whose `geom.paths` are every piece's paths in z-order, each
  piece's rotation and flips in its points (`geom.ts` `shapePiece`, `mergedPaths`: a custom geometry's
  stored paths, else its preset built at its box), in the union of their boxes, unrotated. `drawGeom` fills
  and strokes path after path as separate shapes are drawn, and each path keeps its fill mode, so the
  object looks as the shapes do (in the harness, merged and apart differ in a few dozen anti-aliased edge
  pixels of a slide). The one order it changes is an open outline, which a geometry strokes after all its
  paths: a shape with a fill and a line merges only when every stroked sub-path is closed by Z. A traced
  outline stored as a chain (`cont`; see the long paths of the geometry section) stays a chain in the object,
  its later pieces marked `cont`, so the renderer joins them into the one path they were cut from; its open
  ends are worked out over the chain, not where it was cut. Its legacy shape is a `line` with the fill, as
  a thin custom geometry's: an older build draws no filled union rectangle, only the line's midline when
  the shapes have an outline.
- **Then elements without text go to the art** (`fitShapes`, reason `budget:shapes`, `art:budget:shapes`):
  shown pictures (not play videos) and shapes without text, not in a SmartArt drawing. First the fewest of
  the layout's and master's decorations, bottom first (a binary search: the art stays at the bottom and the
  slide's text native above it); then the costliest z-contiguous run of such elements in one top-level
  group, and once no group has one, of ungrouped elements (a run ends at any other shown element, one in
  the art, and where the source or group changes), costed with its shapes merged, several at a time while
  the estimate stays over the budget. A slide still over the budget with every such element in the art
  (checked first) keeps no mark and is a picture. The SmartArt rule runs again after it, so a drawing the
  art now overlaps goes whole. Such an element emits nothing in version 1, as a residual table does, so
  version 1 stays within the budget (and the render clamp's 200 objects) with the slide's text drawn; the
  render copy prints it into the art.
- Measured on the 44 shown worship slides of shards 0-2 that were picture class for `budget:objects` (the
  census, 12 decks; 150-784 objects): 10 native (their runs merged), 6 hybrid for residuals they already
  had (sheared group children, custom geometry past the bounds, a table) with their runs merged, 27 hybrid
  with `art:budget:shapes`, and one picture for its 64 KB of text formatting; every native and hybrid one
  within 150 objects in version 2 (at most 150), and its version 1 too unless residual shapes it already
  had are drawn there. Against LibreOffice 24.2 (`--engine native --lo-compat`, the native column): the 10
  native slides 0.964 → 0.981 (before, the renderer's 200-object clamp cut their top objects in the
  harness); the 33 hybrid ones 0.833 → 0.913 without the art, 0.989 with LibreOffice's pixels pasted into
  the art box (an estimate of version 2). The other 161 slides of those decks are unchanged, and so is every
  other slide of the shards and the sermon decks (the emitted objects' digests, ids and media numbers
  aside). The sermon decks stay 0.955; shard 0 goes 0.843 → 0.842, all of it the one picture slide, whose
  version 1 now leaves out what went to the art (the hub draws it with LibreOffice). Conversion time over
  the shards is unchanged (29.4 s).
- Tests: `classify.test.ts` (runs: what ends one, the path and string bounds; the decorations first, the
  costliest group first, nothing marked on a slide its text alone keeps over the budget), `emit.test.ts`
  (merged and apart put every point in the same place, the outline and dash kept, version 1 without the
  art's elements), `geom.test.ts` (the string bound against what is written, presets and open outlines).

## M6 wave 2 repair (review findings)

- **Drawing cost of custom geometry** (`geom.ts` `customPaths`, `walk.ts` `slideCustom`; renderer
  `geom/cost.ts`). A custGeom's paths are rated by the renderer's own estimate (`unitCost`: the edges' length
  along their longer axis, times 1 + the most edges active at once / 64), each stored path or `cont` chain a
  unit, in logical px at the shape's box. Past `GEOM_COST.geometry` (1.5M, 1.3M since the finish; the corpus's costliest, a traced
  8,300-point silhouette, is 0.64M) the geometry is residual with `custGeom:complex` and a note, LibreOffice
  drawing it into the art; a slide keeps its custom geometries native while their estimates, weighted by the
  passes that drew them, stay within 98 % of `GEOM_COST.slide`, the rest going to the art the same way (since
  the finish below, each shape is rated as it is drawn instead). A zigzag of 4,000 points
  across its box (1.5 s at 1920 and 4.6 s at 3840 in Chromium before) is now art. The renderer holds every
  drawn slide to the same budgets (`geombudget.ts`), so a saved or edited slide cannot pass them either.
- **Effect budget** (`emit.ts` `fitEffects`): shapes keep their shadow, glow and soft edge, bottom first,
  while their layers' area (`effectArea`, in slide areas; a soft edge counts twice) stays within 98 % of
  `EFFECT_COST.slide` (10; the corpus's most effected slides reach 7.7); later shapes lose them, noted.
- **`useBgFill`** (`walk.ts` `readShape`): the slide's background only where no `p:spPr` along the chain sets
  a fill (`a:noFill` or none; the style's `a:fillRef` does not count), as LibreOffice reads it
  (`pptshapegroupcontext.cxx` defaults the fill to none before `spPr` is read). A Designer layout's full-slide
  "decorative" rect with `useBgFill="1"` and a tx1 fill is the dark panel its light text sits on (suite slide
  0.324 → 0.934).
- **Joins and caps** (`emit.ts` `joinsOf`): `lineJoin` round or bevel and `lineCap` round or square on every
  stroked shape, connector, picture outline and merged run, from `Line.join` and `Line.cap`; the renderer
  draws a round or square cap within a preset dash's length (LibreOffice takes 0.99 of a line width off each
  dash and gives it to the gaps), so a round-capped sysDot is a row of round dots.
- **Fixed gradients on mirrored shapes** (`geom.ts` `gradientOf`): a `rotWithShape="0"` gradient lands where
  LibreOffice draws it, mirrored by the element's own flips (flipH 180 − θ, flipV −θ) and not turned
  (`ElementBase.ownFlipH`, `ownFlipV`); the angle stored is expressed in the box as the drawer mirrors and
  turns it.
- **Picture fills and `rotWithShape`** (a choice, not a change): a picture fill is placed as LibreOffice
  24.2 draws it, never mirrored and turned only by quarter turns, whatever `a:blipFill rotWithShape` says;
  OOXML's `rotWithShape="1"` (PowerPoint's 'Rotate with shape') would turn and mirror it with the shape. No
  PowerPoint render was at hand to check; the worship shards have 10 flipped picture-filled shapes in 4
  decks and none turned past 45°.
- **Right-to-left tables** (`tables.ts` `cellText`): `a:tblPr rtl="1"` makes the cells' paragraphs right to
  left, one without an alignment of its own starting at the right, as LibreOffice and PowerPoint draw them.
  The columns are not mirrored: PowerPoint mirrors their order, LibreOffice 24.2 (the fidelity reference)
  does not.
- **Backgrounds of slides of another aspect** (`emit.ts` `emitBackground`, `linearOverFrame`): extended to
  the 16:9 frame, a linear gradient's stops move to where the slide's edges fall on the frame's gradient line
  (its `scaled` angle taken at the slide's aspect), so inside the slide it is the slide's own gradient and
  the frame carries its end colours on; a radial one is drawn over the slide itself (an ellipse of the slide's
  aspect), on a frame rect of its outer stop's colour.
- **Merged runs' legacy** (`emitMerged`, design/27 §3.2): a run with an outline keeps its stroke (the M6
  drawing needs it), so an older build draws its legacy `line` along the union box's midline; a run without
  one draws nothing there.


## M6 wave 2 finish (re-review findings)

- **Outlines in the drawing cost** (`walk.ts` `readShape`, `slideCustom`, `chargeDrawing`; `geom.ts`
  `drawSpecOf`, `outlineFields`, `presetDrawn`; `emit.ts` `fitDrawing`; renderer `geom/cost.ts`,
  `geom/outline.ts`, `geom/built.ts`). The estimate rated fills only, so a tiny custGeom with a 400 px line
  (3.9 s at 3840 for two) or one of 12,000 short open sub-paths with arrowheads (2.6 s) was native. Each shape
  is now rated as `emit.ts` writes it and the renderer draws it (`drawCost`): its fill, its outline as the
  polygon Canvas fills (offset edges, every join, every open sub-path's caps, every dash, each arrowhead's
  fill and area), its effects' passes, and `GEOM_COST.point` a stored point. Custom geometries, presets
  (`geom:complex`), picture masks and the outlines along them (the mask filled, the outline stroked, the
  points stored twice) are charged against 98 % of `GEOM_COST.slide` (1.3M) and the slide's 64k points,
  the rest going to the art; points of a geometry sent to the art are no longer charged. `fitDrawing` runs
  the renderer's own `slidePlan` on the emitted objects (merged runs and table grids included), so a slide the
  converter keeps native is drawn natively by every drawer; what it still has to change is noted.
- **Self-check** (renderer `geom/cost.ts`): the shared estimate also charges the area each outline covers
  and each fill past a geometry's widest, the stroker's walk of every leg, and an open arrowhead's own
  stroke, so the converter rates stacked full-box paths, wide straight polylines and open arrowheads as the
  drawers spend on them.
- **Line widths** (`geom.ts` `lineWidthPx`): one function for the emitted width and its estimate (at least
  0.5 px; the renderer draws a dashed outline at least 0.5 px wide too).
- Tests: `geom.test.ts` (wide outlines and arrowheads to the art, thin dashes on presets past the budget,
  a masked picture with an outline charged as the renderer charges its two objects, within 5 %).

## M6 wave 2 finish review (painted area, effect layers)

- **The pixels a fill paints** (`geom.ts` `drawSpecOf`, `walk.ts` `readShape`, `backgroundCost`; renderer
  `geom/cost.ts` `areaWeight`, `spanArea`). A fill was rated by its edges, so a full-slide translucent
  gradient (about 11.7 ms at 4K) rated 65 µs and stacks of them were native (140: 1.3 s at 3840). Every
  filled path is now charged the span of its points cut to the canvas (its box placed on the slide, `place`),
  a logical px² `GEOM_COST.area` for a translucent colour, `opaqueArea` for an opaque one, `gradientArea` or
  `opaqueGradientArea` for a gradient (about five times a colour). The slide's background (a full-slide rect
  laid on white, opaque) is charged first; decorations cached for a layout keep their own share only.
- **Shapes the drawing budget sends to the art emit nothing when they have no text** (`emit.ts`
  `pastBudget`, as 'budget:shapes'): their legacy rect, which no budget refuses, cost what the budget held
  back (138 translucent full-slide rects: 300 ms at 3840) and covered the box where the geometry did not. One
  with text is emitted as its legacy shape under its text, and the walk charges that legacy shape.
- **Effect layers sized by what is drawn** (`emit.ts` `fitEffects`, `effectAreaOf`; renderer `geom/bounds.ts`
  `drawnBounds`, `geom/cost.ts` `effectArea`). The effect budget measured a shape's layers by its box, but
  the drawers make them over what it draws: a custGeom's points past its box (kept, as PowerPoint and
  LibreOffice draw them) and an outline's reach. Both now take the drawn bounds (the geometry's points grown
  by the outline's sharpest miter, caps and arrowheads), placed on the slide and cut to the canvas and the
  effect's reach as the drawer cuts them, so the converter, the renderer's budget and the drawers measure
  the same area. Twenty 10 px custGeoms whose paths cover the slide, with shadows, were native with 0.009
  slide areas (793 ms at 3840); each now weighs about 1.02.
- **Corpus** (worship shards and sermons, 2,927 slides): two slides of one deck of full-slide traced
  decorations go hybrid (their geometry plus their painted area pass the budget); no other class changes, no
  effect is dropped, and the renderer changes nothing the converter emits. The costliest slide's estimate
  is 1.06M.
- Tests: `geom.test.ts` (twelve out-of-box shadowed custGeoms: the effect budget keeps nine, with a note;
  thirty 10 px rects with 500 px outlines and shadows; the 140-gradient stack to the art with only what is
  drawn emitted; six gradients, as many as fit after the background).

<!-- m9:conv-seams -->
## M9 wave 1: the converter's seams (`conv-seams`)

The converter is split and given every seam the M9 areas fill (design/27 §15 M9, plan §4), so each of them
owns its files. Nothing of what a slide draws changes, except that real 3-D is drawn flat instead of left to
the art.

| File             | What                                                                                                                                                                    | Filled by        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `residual.ts`    | The decision table: per reason its decision (native, approx, residual, unread), census features, who rates it, its missing kind; `decisionOf`, `missingKindOf`, `rowOf` | each area's rows |
| `emit-ctx.ts`    | `EmitCtx`, `M9_FIELDS` and `writes` (the `EmitOptions.m9Writes` gate), box, colour and object helpers                                                                   | (frozen)         |
| `emit-text.ts`   | Text bodies (`textObject`, `richTextObject`, legacy text, `marginOf`); stubs `warpOf`, `writingOf`                                                                      | `text-conv`      |
| `emit-budget.ts` | `storedSlideBytes`, `fitBytes`, `chargeText`, `slideBudget` (was `overBudget`), `compactRuns`, `MAX_SLIDE_BYTES`, `TEXT_BUDGET_BYTES`                                   | `ladder`         |
| `emit-table.ts`  | The M6 table group; stub `emitTableObject`                                                                                                                              | `tables-conv`    |
| `chart.ts`       | Stubs `readChart`, `emitChart`                                                                                                                                          | `charts-conv`    |
| `decor.ts`       | Stub `emitDecor` (runs of `ElementBase.decor`)                                                                                                                          | `decor-conv`     |
| `three3d.ts`     | Stubs `read3d`, `look3dOf`                                                                                                                                              | `three-model`    |
| `ole.ts`         | Stub `readOle`                                                                                                                                                          | `metafile-a`     |

- **`emit.ts`** keeps the slide, backgrounds, shapes, pictures, origin and the lyric box, and re-exports every
  name it exported before. The parts were moved verbatim.
- **3-D** (`classify.ts`): a real bevel or extrusion is approx `3d` (`3d:camera` when its camera turns the
  face), drawn flat; a SmartArt drawing with bevels is native. On a slide past the object budget it goes to
  the art first (`budget:3d`), as before, so the budget's other steps choose as they did.
- **Without LibreOffice** (`EmitOptions.libreoffice: false`, `hybrid.ts` `withoutLibreOffice`): no art and no
  metafile conversion is planned; `EmittedSlide.missing` lists by kind what nothing draws, the slide is hybrid
  with `missing:<kind>` reasons, and `EmittedSlide.artText` keeps the art's text.
- **IR** (`ir.ts`): `Look3dIR`, `TextBody.warp` as `{ preset, adj }`, `writing`, `rot`, `upright`, `look3d`;
  `ChartElement`; `PictureFill.metafile`; `ElementBase.culled`, `.decor`; table `rtl`, `storedRows`, cell
  `vert` and `diag`.
- **Measurement** (`metrics.ts`): the sfnt reader and cmap moved to `@ordo/renderer/text/sfnt/{reader,cmap}.ts`
  and are re-exported; `FaceSource.script`, `advanceOf`, `heightOf` (through `tables.ts` `Measure`).
- **Notes** (`log.ts`): `addNote` keeps a slide's stored notes within the schema's 16 (15 and 'and N more').
- **SmartArt** (`smartart.ts`): an empty drawing cache whose data model holds no text and no picture is native
  and blank (LibreOffice counts top-level `dsp:sp` only; ordo also accepts grouped ones).
- Tests: `residual.test.ts`, `classify.test.ts` (3-D approx, past the budget, bevelled SmartArt),
  `hybrid.test.ts` (`libreoffice: false`), `log.test.ts`, `emit.m9writes.test.ts`, `metrics.m9.test.ts`,
  `smartart.test.ts` (empty caches), `purity.test.ts` (the sfnt modules and `@ordo/domain/missing.ts`).
<!-- /m9:conv-seams -->

<!-- m9:ladder -->
## M9 wave 2: the converter's part of the budget ladder (`emit-budget.ts`, `rescue.ts`)

No budget makes a slide picture class any more (design/27 M9, plan decision 3): the importer fits a slide
that is over (`@ordo/domain` `fitSlideBudget`).
- **`compactRuns`** (plan decision 14): before a rich text object is counted, its runs lose every field that
  says what the box style says (family, weight, slant, spacing, language, colour unless the box is a
  gradient, scale 1, underline, caps, outline, no strike, no baseline, no shadow where the box has none);
  a run is never merged or removed (the text engine cuts its pieces at run ends), so `layoutRich` and
  `paintPlan` give exactly the same output (`emit-budget.test.ts`). `richtext.ts` already writes runs as their
  difference from the box, so on its own output this finds nothing (0 bytes on the worship set).
- **The text budget** is a memory guard of 128 KB (`TEXT_BUDGET_BYTES`, twice `MAX_SLIDE_BYTES`): past it the
  slide's further text is written plain (`SLIDE_BUDGET_NOTE`), so the importer's ladder chooses which
  formatting a slide over 64 KB keeps (the largest goes first) and a deck that repeats thousands of formatted
  runs still never builds megabytes a slide.
- **`slideBudget`** (from `emit.ts`): the large geometries go to files whatever the text holds (`fitBytes`),
  and a slide still over 64 KB as stored, or past the text budget, keeps its class and is flagged
  `EmittedSlide.overBudget` (`SLIDE_BYTES_NOTE`); it was picture class.
- **`rescueDeck`** (`rescue.ts`, `index.ts`): a slide's own text bodies (shapes, placeholders placed by their
  layout or master, table cells' text as one object a table) as text objects in their boxes, with the
  dominant run's face, size, weight and colour; no geometry, picture, effect, SmartArt or chart is read,
  groups to depth 4 (`RESCUE_DEPTH`), at most 5,000 elements and 1,000 objects a slide; class hybrid,
  `missing: ['slide']`, `RESCUE_NOTE`. The hub's `pptx-scene` task runs it for slides whose conversion failed.
  Never throws for a slide (`rescue.test.ts`, with a mutation fuzz).
<!-- /m9:ladder -->

<!-- m9:decor-conv -->
## M9 wave 2: the slide budgets, natively (`budget.ts`, `decor.ts`, `sheet.ts`; `decor-conv`)

Nothing goes to LibreOffice's art for a budget any more, and nothing for being slow to draw (decisions.md
"Slow-to-draw elements"): a slide past its 150 objects or 12 distinct pictures is drawn natively, and the
drawing budgets only choose how an element is drawn (from the slide's decoration plate, or live), never
whether.

- **Culling, always** (`budget.ts` `cullElements`, before anything is counted): an element whose bounds, grown
  by its shadow, glow and half its outline, miss the slide area (the deck's, not the 1920 x 1080 frame), or a
  shape that shows nothing (no visible fill, line, text or effect), is `ElementBase.culled` and hidden: not
  emitted, counted, put in the art or its text. Clips, sounds and SmartArt drawings' elements are never
  culled; groups are culled per leaf. One note per slide ('N element(s) outside the slide are not imported').
- **The steps** (`fitBudgets`, each after the first only while the slide is over 150 objects, the runs that
  save most first, stopping as soon as it fits): a table or a chart is one object; shapes of one look merge
  as M6 merges them (`shapeRuns`); then **decorations** (`decor.ts`): z-runs of text-less shapes of one
  SmartArt drawing, top-level group or layout/master source, then of one source (the slide's own ungrouped
  shapes too), each one locked `ShapeObject.decor` (legacy: an empty line, which an older build draws as
  nothing); between them **composites** (`sheet.ts`): z-runs of plain pictures as one picture over their union
  box (`pptxmedia:sheet<n>`, `EmitResult.sheets`, `bake.ts` `SheetBake`, any rotation, cells at the 3840
  density); last, only for a slide still over, real 3-D shapes drawn flat in decorations
  (`3d:flat-in-decoration`, plan decision 6: otherwise 3-D never joins a decoration, and `shapeRuns` merges
  3-D shapes only with an equal 3-D XML digest, `classify.ts` `threeDigest`, and disjoint boxes). A slide whose
  objects left are text or unmergeable keeps up to 190 (`MAX_SLIDE_OBJECTS_TEXT`); past that the **guard**
  leaves the topmost elements without text out (then text) until 200, the render clamp
  (`Classification.missing`, class hybrid, `missing:<kind>`; never reached in the corpus). Past 12 distinct
  pictures an **atlas** packs the fewest smallest into one sheet, each object keeping its box and showing its
  cell through its crop (`Classification.atlas`, `sheet.ts` `atlasSlide`).
- **A decoration draws what the separate shapes draw** (`emitDecor`): each member is emitted by the
  single-shape emitter, then its geometry built at its box as the renderer builds it, placed (flips, rotation)
  into the decoration's space (its box in logical px); a member's parts start with `s: 1`; its look is a paint
  (fill, gradient laid on the member's own box as `DecorPart.frame`, mirrored by its flips; stroke, dash,
  shadow), shared through `@ordo/domain` `Palette`; a path too long for one part is a `cont` chain. Caps:
  256 parts, 64 paints, 16,384 points, 24 shadowed shapes. A decoration over `GEOM_FILE_CHARS` goes to a
  decoration file (`DecorData.ref`, `pptxdecor:<n>`, `EmitResult.decors`) when `EmitOptions.m9Writes` has
  'decorFile'. With 'decor' out of `EmitOptions.m9Writes` (the hub's and the client's `M9_WRITES` until
  `decor-render` draws decorations) no decoration is planned at all, and with `sheets: false` (theirs until it
  stores sheets) no composite or atlas: `ParseOptions.m9Writes` and `sheets` reach the budgets
  (`BudgetOptions`), every member and picture is its own object, and the guard leaves the topmost past 190
  objects or the render clamp's 16 pictures out and lists them.
- **Kept whole** (the wave 1 re-review): `emit.ts` `fitDrawing` and `fitEffects` no longer flatten an object
  past the slide's drawing or effect budget to its legacy copy (its gradient, geometry, dash, ends and effects
  stay, so the editor still edits it and a radial glow stays a glow); `walk.ts` no longer sends a shape past
  the drawing budget to the art (`custGeom:complex` and `geom:complex` are no longer written): it is charged
  as its legacy copy and kept. Every drawer draws such objects as its own budget allows (`geombudget.ts`)
  until the slide's decoration plate holds them.
- **Plates** (`decor.ts` `platePlan`, `EmittedSlide.plate`): the static decoration stack (the bottom objects up
  to the first text, table, chart or picture that plays) and the objects above it with effect layers, plus
  `pastBudget` (what the drawing budgets draw live past them): what the client bakes (`decor-render`).
- **The A/B** (`ParseOptions.budgetArt`, the harness only): M6's and M9 wave 1's budgets (`fitTables`,
  `wholeDiagrams`' budget step, `fit3d`, `fitShapes`, picture class past a budget), kept for comparison.
- Tests: `budget.test.ts` (culling by the slide area, reach, media and SmartArt kept, steps in order, nothing
  to the art, the text ceiling and the guard, a property test of 40 random slides of up to 2,000 elements,
  3-D merges and 3-D drawn flat in decorations), `decor.test.ts` (who joins, scopes, caps, skipped pictures,
  geometry and paint equal to the separate shapes', chains, files, plates), `sheet.test.ts` (composite runs and
  cells, turns, one recipe a deck, the atlas and its crops, `applySheet`, `checkSheet`), and the M6 budget
  tests behind `budgetArt` (`classify.test.ts`, `emit.test.ts`, `tables.test.ts`, `smartart.test.ts`,
  `hybrid.test.ts`).
<!-- /m9:decor-conv -->

## Module map

| File            | What                                                                                                                                 | Owner         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `xml.ts`        | Bounded XML reader (moved from pptx-render; no DTD: `<!DOCTYPE` refused, null-prototype `attrs`) and node helpers                    | A             |
| `opc.ts`        | `PartSource`, `openPackage`: part lookup, decoding, cached parsing, content types, relationships                                     | A             |
| `markup.ts`     | Every part as one dialect: Strict → Transitional, the usual prefixes, one branch of `mc:AlternateContent`                            | A             |
| `deck.ts`       | `readDeck`: slide size, order, hidden flags, shown index, defaultTextStyle, sections; `slideParts`                                   | A             |
| `frame.ts`      | EMU → 1920x1080 contain map, affine transforms, `boxPx`                                                                              | A             |
| `theme.ts`      | `readTheme`: colour, font and format schemes; `themeFont`, `langScript`, style font/line/effect references                           | B             |
| `color.ts`      | `ColorCtx`, colour maps, colour elements and modifiers, fills, `styleEntry`, `styleFill`                                             | B             |
| `inherit.ts`    | Placeholder matching, xfrm/bodyPr chain, paragraph-property chain                                                                    | C             |
| `walk.ts`       | Shape-tree walk: decorations, groups flattened, shapes                                                                               | C             |
| `text.ts`       | Text bodies: paragraphs, runs, run styles through the chain                                                                          | C             |
| `picture.ts`    | `p:pic` and every `a:blipFill`                                                                                                       | C             |
| `background.ts` | Slide → layout → master background                                                                                                   | C             |
| `emit.ts`       | IR → ordo objects, media placeholders, digest                                                                                        | C             |
| `richtext.ts`   | A text body as rich ordo text: runs, paragraph styles, office box fields (M2)                                                        | C (M2)        |
| `fontmap.ts`    | Script class of each character (Latin, East Asian, complex), substitutes and fallback families (M2)                                  | C (M2)        |
| `classify.ts`   | Census tiers T1-T5, reasons, slide class                                                                                             | F             |
| `geom.ts`       | Presets, custom geometry, text rectangles and sites, gradients, dashes, arrowheads, connector glue (M6)                              | M6b B         |
| `notes.ts`      | `readNotes`: a slide's speaker notes (notesSlide body placeholders), bounded                                                         | M3 B          |
| `transition.ts` | `readTransition`, `readSlideTransition` (a slide's tail only), `showLoops` (`p:showPr loop`)                                         | M3 B          |
| `timing.ts`     | `readSlideTiming`: the `p:timing` mapping of clips, transition and animation sounds; `gainDbOf`                                      | M3b A         |
| `media.ts`      | `readMediaRef` (a poster's clip, trim, kind), `emitMedia` (play, slide sound, motion background), `EmittedClip`                      | M3b A         |
| `tables.ts`     | `readTable`, `emitTable`, `Measure`: tables (M6); `tablestyles.ts`: the built-in styles (LibreOffice's, MPL 2.0)                     | M6b C         |
| `metrics.ts`    | `sfntMetrics`, `metricsOfTables`, `FaceSource`: advances, pair kerning, line heights from font files, bounded                        | M6b C         |
| `smartart.ts`   | SmartArt from its drawing cache: `readSmartArt` (the drawing's shapes through the walk), `lockDiagram`                               | M6b D         |
| `bake.ts`       | Baked pictures: `PictureBake` recipes (`bakeOf`, `tileBakeOf`), `applyBake` (recolour and tile pixels); M9 `SheetBake`, `applySheet` | M6b D         |
| `budget.ts`     | The slide budgets natively (M9): `cullElements`, `fitBudgets`, `budgetCost`, the text ceiling, the guard                             | M9 decor-conv |
| `decor.ts`      | Decorations (M9): `decorable`, `decorRuns`, `emitDecor`, `decorFiles`; the plate plan `platePlan`                                    | M9 decor-conv |
| `sheet.ts`      | Picture sheets (M9): composites (`pictureRuns`, `emitComposite`) and the atlas (`atlasParts`, `atlasSlide`)                          | M9 decor-conv |
| `ir.ts`         | The scene IR (types only)                                                                                                            | shared        |
| `context.ts`    | `SlideCtx`, `slideContext`                                                                                                           | shared        |
| `log.ts`        | `clean`, `noteList`                                                                                                                  | shared        |
| `index.ts`      | `parseDeck`, `emitSlides`, public types                                                                                              | shared        |
| `test-util.ts`  | Test decks as `PartSource` maps of XML strings                                                                                       | shared        |

Data flow: `parseDeck` → `openPackage` → `readDeck` → `frameOf` → per slide `slideContext` (→ `slideParts`,
`readTheme`, `colorContext`) → `walkSlide` → `readBackground` → `classifySlide`. `emitSlides` → `emitDeck`.

**Units.** Geometry in EMU (12,700 per point; `frame.ts` maps to logical px, 2 px per point on both standard
sizes). Font sizes in points, spacing in points or shares, angles in degrees clockwise, fractions 0-1,
colours as `Rgba` (channels 0-255, alpha 0-1, the shape of `@ordo/domain` `Rgba`), every one resolved.

## Rules for the parallel work items (M1)

- **Own your files.** Change only the files your item owns. Add new exported functions freely; keep the
  signatures listed below. If you need a different contract, add a new function next to the old one.
- **Shared files** (`ir.ts`, `context.ts`, `log.ts`, `index.ts`, `test-util.ts`): additive changes only, kept
  small. New IR fields are optional and go at the end of their interface, with a comment. New test helpers
  keep the existing helpers' output byte for byte.
- **Tests** sit next to the code, named after the module (`color.test.ts`, …), and build decks with
  `test-util.ts` (`buildDeck`, `sp`, `body`, `para`, `run`, `pic`, `grpSp`, `solidBg`, …). No deck files,
  no zips, no text of real decks in the repository. `index.test.ts` is the end-to-end test: add cases, do not
  rewrite others'.
- **Checks** before each commit: `npx tsc --noEmit -p packages/pptx-scene`, `npx vitest run
  packages/pptx-scene packages/pptx-render`, `npx biome check --write <changed paths>`.
- A worktree without `pnpm install` needs the `@ordo/*` links (`packages/pptx-render/node_modules/@ordo/
  pptx-scene → ../../../pptx-scene`, `tools/pptx-fidelity/node_modules/@ordo/pptx-scene →
  ../../../../packages/pptx-scene`, `packages/pptx-scene/node_modules/@ordo/domain → ../../../domain`,
  and since M6 `packages/pptx-scene/node_modules/@ordo/renderer → ../../../renderer`).

### A: reading (`xml.ts`, `opc.ts`, `markup.ts`, `deck.ts`, `frame.ts`)

Contracts:
- `xml.ts`: `XNode`, `parseXml(xml, part): XNode[]`, `rootOf`, `rootTag`, `child`, `children`, `firstChild`,
  `path`, `textOf`, `num`, `startTags`, `countUpTo`, `decodeEntities`, `MAX_TAGS_PER_PART`, `XML_MAX_DEPTH`.
  `pptx-render/src/annotate.ts` imports it as `@ordo/pptx-scene/xml.ts`: keep its output for well-formed
  parts identical (it matched fast-xml-parser on 26,980 real parts, apart from top-level whitespace,
  merged CDATA and decoded numeric references).
- `openPackage(src, log?, opts?): Package` with `find`, `has`, `bytes`, `text`, `xml`, `rels`, `rel`,
  `relOfType` (a short type name or a full URI, Strict or Transitional), `contentType`, `partsOfType`, `log`,
  `pin` (M3: the parts the slide being read inherits from, never evicted while pinned).
  `find` folds case: the first of names that differ only by case is the part, however a name is spelled.
  `xml(name, { keep }?)` returns the cached root, undefined when the part is missing, and throws when it is
  over budget or malformed; `keep: false` parses a part not cached yet without caching it (`slideParts`
  reads slides so). `PackageOptions.cacheBytes` (default `XML_CACHE_BYTES`). `Rel.target` is resolved, normalised and the stored part name; `Rel.type` is Transitional.
  `relType(uri)`, `relsPartOf`, `resolveTarget`, `externalHost`, `relIdOf`, `decodeText`,
  `MAX_XML_PART_BYTES`.
- **Every tree `Package.xml` returns is one dialect** (`markup.ts` `normalizePart`, run once per part):
  Strict URIs and `"90%"` percentages read as Transitional; elements and attributes of known namespaces under
  their usual prefixes (`p:`, `a:`, `r:`, `mc:`, `p14:` …, none for relationships and content types)
  whatever prefix or default namespace the deck declared; each `mc:AlternateContent` keeps its wrapper and
  only the branch to read (the first `mc:Choice` whose `Requires` namespaces are all in
  `UNDERSTOOD_NAMESPACES`, LibreOffice's a14/p14/p15, else the first `mc:Fallback`, else nothing). Readers
  match names like `'p:sld'` and `'r:embed'` literally, and walk an `mc:AlternateContent` through
  `chooseAlternate(el)` (which also applies the rule to a tree parsed some other way).
- `readDeck(pkg): DeckInfo` (`presentationPart`, `size`, `slides: SlideRef[]` with `index`, `part`,
  `hidden`, `shown`, `defaultTextStyle`, `sections`, `embeddedFonts`); `slideParts(pkg, part): SlideParts`
  (a related part with the wrong root, a cycle back to the slide included, is not used).
- `frame.ts`: `frameOf`, `lenPx`, `ptPx`, `slideRect`, `IDENTITY`, `multiply`, `apply`, `xfrmAffine`,
  `childSpace`, `decompose`, `boxPx`, `DEFAULT_SLIDE`, `MIN_SIDE`, `MAX_SIDE`.

Done (design/27 §1, §4 "Order and identity", "Alternate content", §12):
- **Package.** Parts found without case (first of a clash) and under percent-decoded names; text by BOM,
  else the declared encoding, else UTF-8; parsed trees cached within an estimated 256 MB (characters plus
  `XML_NODE_BYTES` = 300 per element, about what V8 retains; LRU; a slide's layout, master and theme at the
  tag limit fit, and are pinned while the slide is read), slide parts and their relationships never
  cached. Content-type
  overrides naming missing parts ignored. Relationship targets: fragment dropped, percent-decoded, `.`/`..`
  applied never above the root, leading `/` the root; a duplicate `Id` keeps the first; targets over 2,048
  characters, and internal ones resolving to part names over 512 (`MAX_PART_NAME_CHARS`, §12), ignored; `TargetMode="External"` never resolved or fetched, noted as `external <type> target
  (<host>) is not fetched` (host only, at most 20 notes).
- **Presentation.** The package's officeDocument, else a presentation content type, else
  `ppt/presentation.xml`. `p:sldSz` within 1-51,206,400 EMU, else the one default. `p:sldIdLst` order, the
  relationship id under any prefix; entries naming no slide part (missing, External, another kind of part)
  skipped and counted in a note; when it lists no slide, the slide relationships (else the content types'
  slide parts) by the number in their names. At most 2,000 slides. `show="0"`/`"false"` read from the
  root tag in the part's head (no whole-slide parse). A slide listed twice is read once at its first
  place, and each later listing of a shown slide still takes a shown index (the LibreOffice page, as
  `annotate.ts` `placeSlides`). `p14:sectionLst` (≤ 1,000; a slide in its first section only),
  `p:defaultTextStyle`, `p:embeddedFontLst` (≤ 64 typefaces, cleaned).
- **Tests** (`xml`, `opc`, `markup`, `deck`): crafted decks for each rule, and the §14 reading fuzz list,
  each under 5 s: DOCTYPE and billion laughs (the slide quarantined, never the deck), `__proto__` and
  `constructor` as part names, ids, types, prefixes and attributes, depth 20,000, a 9 MB part, cyclic
  relationships (slide → itself as layout, layout → itself as master …), 50 External targets, 2,001 slides
  plus 100,000 repeated listings, all-hidden decks, 10,000 media parts and relationships, control
  characters in part names, a Strict deck and decks with their own prefixes or default namespaces emitting
  exactly what their Transitional twins emit.

Not done: universal measures (a Strict coordinate written `"2.5cm"`) are not converted, so `num` reads them as
missing (Office writes EMU integers); `p:custShowLst` and `p:showPr` (loop, kiosk) are for later milestones.
The `v` (VML) Choice is not read, unlike LibreOffice: its Fallback is usually an OLE object with its preview picture.

### B: theme-colour (`theme.ts`, `color.ts`)

Contracts:
- `readTheme(root): Theme` (`colors`, `major`/`minor` `FontSet` with `scripts`, `fills`, `lines`, `effects`,
  `bgFills`), `themeFont(theme, typeface, script?)`, `langScript(lang)`, `styleFont(theme, fontRef, ctx)`,
  `styleLine(theme, lnRef, ctx)`, `styleEffect(theme, effectRef, ctx)`, `parseHex`, `hexRgba` (defined in
  `color.ts`, re-exported), `SCHEME_COLORS`, `MAX_TYPEFACE`, `MAX_SCRIPT_FONTS`, `typefaceName` (cut to
  `TYPEFACE_SCAN` first, then control characters removed: a form feed in a family breaks the Canvas font
  shorthand; memoised per string). `readTheme` is memoised per root.
- `colorContext(theme, clrMap, clrMapOvr?, layoutClrMapOvr?): ColorCtx` (master map, then the layout's
  override, then the slide's, attribute by attribute), `withPhClr`, `colorIn(parent, ctx)`,
  `readColor(el, ctx)`, `applyModifiers(c, el)`, `readFill(parent, ctx, blip?)`, `fillOf(el, ctx, blip?)`,
  `styleEntry(theme, ref, ctx)` (any `a:fillRef`/`a:bgRef`/`a:lnRef`/`a:effectRef` with its phClr context),
  `styleFill(theme, ref, ctx, blip?)`, `PRESET_COLORS`, `MAX_MODIFIERS`, `MAX_GRADIENT_STOPS`. `readFill`
  returns undefined when the parent sets no fill (inherit), `{ kind: 'none' }` for `a:noFill`. Picture fills
  go through the `BlipReader` callback.

Done (design/27 §4 "Colours", "Fonts"):
- Every colour element: srgbClr, schemeClr through the map (phClr = the reference's colour, its alpha kept),
  sysClr (`lastClr`, else LibreOffice's palette), prstClr (all 190 ECMA-376 names), scrgbClr (linear,
  gamma-encoded), hslClr.
- Every modifier in document order with LibreOffice's integer arithmetic: tint, shade, inv, gamma,
  invGamma and red/green/blue(Mod/Off) on linear values (γ 2.3: black + tint 95 % = #454545); hue, sat,
  lum (Mod/Off) and comp in HSL; gray; alpha, alphaMod, alphaOff. Values are clamped as LibreOffice clamps
  them (hueOff clamps at 0 and 360°, it does not wrap); NaN and Infinity read as 0; at most 32 modifiers.
- Gradients (stops sorted, ≤ 16, `angle` or `path` with `focus`; one stop is solid, none is no fill) and
  patterns (`preset` from `ST_PresetPatternVal`, fg/bg defaulting to black/white).
- Theme colours through `color.ts` (any element; a missing entry keeps Office's), per-script theme fonts,
  `+mj-cs`/`+mn-cs`, and the script font for an empty ea/cs typeface (`themeFont(…, langScript(lang))`).
- `color.test.ts` holds 122 probe values read from LibreOffice 24.2 and checks the parser against them
  through `parseDeck`; `ORDO_LO_PROBE=1 npx vitest run packages/pptx-scene/src/color.test.ts` renders the
  same probe deck with soffice and pdftoppm and checks the table. The parser differs from LibreOffice on
  purpose in four rules, listed in `DIFFERENT`: sysClr uses `lastClr`; prstClr has ECMA-376's names and
  values; phClr keeps the reference's alpha; the slide's clrMapOvr also colours master shapes and the
  inherited background (LibreOffice applies only the layout's override there).

To do: LibreOffice rounds alpha to whole percents (the parser does not); theme picture fills
(bgFillStyleLst `a:blipFill`) need the theme part's relationships (C's `background.ts`).

### C: inherit-emit (`inherit.ts`, `walk.ts`, `text.ts`, `picture.ts`, `background.ts`, `emit.ts`)

Contracts:
- `inherit.ts`: `PhRef`, `Chain`, `placeholderOf`, `nvOf`, `spPrOf`, `masterClass`, `isTitle`, `isFooter`,
  `FOOTER_TYPES`, `layoutPlaceholder`, `masterPlaceholder`, `chainOf`, `nodes`, `spPrChain`, `styleOf`,
  `geometryOf`, `inheritedXfrm`, `bodyPrChain`, `listLevel`, `paraChain`, `paraChainParts` (local list
  styles vs txStyles/defaultTextStyle, where a `p:style/a:fontRef` sits), `firstAttr`, `firstChildOf`,
  `firstOfAny` (indexed), `presetName` (a preset as letters and digits, else 'other').
- `walkSlide(ctx): Element[]` bottom first (master decorations, layout decorations, own shapes), groups
  flattened with `group`; `walkTree(ctx, tree, from, map, group, depth, st, inherit?)` (`GroupInherit`:
  `fill` for `a:grpFill`, `sheared`), `boxAffine`, `alternateBranch` (= `markup.ts` `chooseAlternate`),
  `pathCoverage`, `readXfrm`, `M1_PRESETS`, `MAX_GROUP_DEPTH`, `MAX_SHAPES_PER_SLIDE`.
- `readTextBody(ctx, chain): TextBody | undefined`, `runStyle`, `readShadow`, `plainText`, `textChars`.
- `readBlipFill(ctx, blipFill, source)`, `readPicture(ctx, el, base)` (a `PictureElement`, or a
  `ResidualElement` with approx support for a metafile), `blipReader(ctx, from)`, `blipReaderOf(ctx, part)`, `readInsets`,
  `pictureSize`, `extensionOf`.
- `readBackground(ctx): Background`.
- `emitDeck(scene, opts): EmitResult` (`slides: EmittedSlide[]` with `slide` (an ordo `Slide` that
  `Slide.parse` returns unchanged), `index`, `shown`, `hidden`, `classification`, `digest`, `notes`, `ms`;
  `media: {id, part}[]`; `slideRect`; `notes`), `EmitOptions` (`newId`, `mediaId`, `extendBackgrounds`,
  `crop`), `CroppedImage`, `MEDIA_PREFIX`, `digestOf`, `legacyColor`, `legacyText`, `dominant`,
  `placePicture`, `insetBox`, `marginOf`, `cutToClamp`. Media ids are `pptxmedia:<n>` (first-use order).
- Shared additions: `SlideCtx.themePart` (theme picture fills), `PictureFill.px` (header-sniffed pixel
  size and, since M3, `alpha`, or `SlideCtx.pictureSize` for a spilled part), `PictureElement.adj`, `ShapeElement.coverage`;
  `ParseOptions.pictureSize(part)` (asked once per part, checked) and `pictureSize` exported from the index.

Done (design/27 §4, §15 M1):
- Placeholders: layout by idx, else type (placeholders inside layout groups found); master by type class;
  xfrm, bodyPr and shape properties (geometry, fill, line, effects) own → layout → master; no position
  anywhere: footers not drawn, others the whole slide; empty slide placeholders (prompt text only) not drawn.
- Run style through the whole chain (own rPr, shape lstStyle, layout and master placeholder lstStyles,
  `p:style/a:fontRef` colour and major/minor font, master txStyles for placeholders, `defaultTextStyle` for
  everything else, never otherStyle): size, fill (the nearest decides; a picture or group fill gives the
  text colour tx1, as no fill does, marked `textFill` and noted once a slide), bold, italic, underline,
  strike, caps, spacing, baseline (the nearest, 0 included; a 0 under a farther non-zero one is
  `escZero`, which LibreOffice reads as unset: `loCompat` writes that shift, design/27 §4 "Baseline 0"),
  Latin/EA/CS/sym typefaces through the theme (+mj for titles, +mn otherwise), outline (`a:ln`), outer
  shadow, highlight, lang. Paragraphs: algn, level, marL/indent, rtl, spcBef/spcAft/lnSpc, the nearest
  bullet setting (buNone wins). Bodies: insets, anchor, wrap, normAutofit/spAutoFit, vert, numCol,
  anchorCtr, warp.
- Walk: `showMasterSp` on the slide (both) and the layout (the master's); `mc:AlternateContent` through
  `chooseAlternate` (the branch `Package.xml` keeps: the first Choice of a14, p14 or p15, else Fallback); style references (fillRef, lnRef, effectRef with phClr);
  `useBgFill` with a solid background (only where no `p:spPr` along the chain sets a fill of its own: an
  explicit fill wins, M6 repair); `a:grpFill`; groups by offset, scale, rotation and flips, a child's
  own box scaled along the group's axes (`boxAffine`, no shear; a child the composed affine would shear is
  marked residual and still drawn; since M6 wave 2 it is approx, placed as LibreOffice places it, below);
  graphic frames residual; ≤ 32 group levels, ≤ 5,000 shapes.
- Pictures: blip part through the holding part's relationships (theme parts too), srcRect, fillRect,
  tile, alphaModFix, recolour effects (an empty `a:lum` is not one), header-sniffed size, metafiles
  residual elements rated approx (not drawn before M3 converts them; design/27 §5), TIFF/WDP noted, linked pictures logged with their host only, video/audio posters recorded.
- Emission: legacy objects per §3.2 (text in its dominant run's style; padding the smallest inset with the
  rest folded into the box; ellipse/roundRect text rectangles; wrap="none" widened; vert turned a quarter;
  lineHeight 1.2 × lnSpcPct minus lnSpcReduction, or the exact pitch; stored fontScale applied; outline
  w/2; hollow text; run or unfilled-shape shadow; gradients as their first stop, patterns blended; lines and
  connectors as straight segments at any angle; roundRect radius from adj; ellipse and roundRect picture
  clips as `radius`; picture outlines as stroke-only shapes; custom geometry as its rect only when it fills
  half its box; the paragraphs' common start margin folded into the text box, since bullets are not drawn;
  an unrotated picture past ±2× the canvas cut there with the cut folded into its crop); backgrounds (16:9
  plain picture known to be opaque, of a known size and the slide's aspect → `backgroundMediaId`, other
  pictures, unknown sizes or alpha included, a bottom image on a white rect over the slide area, colours a bottom rect over the frame or the slide area
  composited on white, none white: PowerPoint lays every background on white);
  the lyric box of §4 "Church mappings" (not the bilingual rule); ≤ 1,000 objects.
- `crop`: written from srcRect (and fillRect clipping) by default, now that `ImageObject.crop` is in the
  schema; `EmitOptions.crop: false` writes the legacy uncropped picture and notes it.

Left for later milestones: shape text rectangles of other presets and custom paths (M6), picture
masks/flips/adjust (M3), arrowheads and dashes (M6), tiles pre-tiled (M3), media (M5). (M6 wave 2 has done the text
rectangles, picture masks and flips, arrowheads and dashes: see "M6 wave 2" above.)

### M2 wave 2: rich emission (`richtext.ts`, `fontmap.ts`; `text.ts`, `emit.ts`)

Contracts: `richText(body, { frame, shapeShadow?, log }): RichText | undefined` (`text`, `style`, `runs?`,
`paras?`); `EmitOptions.richText` (default true; false writes M1's legacy text, what the importer writes
while the schema ships one release ahead of it, design/27 §3.2); `EmitOptions.loCompat` (the harness's `--lo-compat` only: LibreOffice's text policies, `RichOptions.lo`);
`charClass`, `scriptClasses`, `substituteOf`, `scriptFallbacks`, `fallbackFonts`, `MAX_FALLBACK_FONTS`. IR
additions: `Para.bulletNone` (the nearest bullet setting is `a:buNone`), `Bullet.sizePt` (`a:buSzPts`),
`TextBody.autofit.own` (the shape's own `a:bodyPr` asks for shrink-to-fit); `runStyle` resolves an empty
theme ea/cs typeface through the theme's font for the run language's script.

Done (design/27 §3.1, §3.2, §4 "Text bodies", §6, §11 "Mapping"):
- **Text**: paragraphs joined by '\n', each `a:br` a '\n' starting a `{ soft: true }` paragraph; tabs and
  other control characters in `a:t` become spaces (one per UTF-16 unit, so `paras[i]` stays paragraph i);
  at most 20,000 characters, runs and paragraph styles cut with it.
- **Box style**: the dominant run (most visible characters) and the paragraph holding most of the text give
  the legacy values an older build draws (family, weight, slant, size, colour, letter spacing, outline,
  shadow, caps as uppercase, align, lineHeight, `padding` = the smallest inset); beside them `lineModel:
  'office'`, `insets`, `wrap: false`, `autofit: 'shrink'` with PowerPoint's stored `fitScale` (font =
  fontScale, spacing = 1 − lnSpcReduction, from the shape's own `a:bodyPr` only: a layout's or master's
  scale was fitted to their prompt text, so an inherited `normAutofit` shrinks from full size; sizes
  unscaled; the engine subtracts the reduction from every paragraph's proportional spacing as PowerPoint
  does), `direction` (PowerPoint paragraphs are left to
  right unless `rtl="1"`), `lang`, `underline` and `fallbackFonts`. The box is the shape's text rectangle:
  insets, margins and `wrap="none"` no longer fold into it.
- **Runs**: whatever differs from the box, merged while unchanged: family per script (a run's Latin,
  East Asian or complex-script typeface by LibreOffice's block table, weak characters taking the script
  before them), weight, slant, `sizeScale`, colour (gradient as its first stop until M6, hollow text
  transparent, picture-filled text in the text colour with its outline), highlight, underline, strike, caps, letter spacing, `baseline`, outline and shadow (null
  where only the box has one), language (primary subtag). The '\n' ending an empty paragraph carries its end
  mark; the a:br before an empty last line carries the paragraph's end mark. Known limit: when the line
  before an empty last paragraph is empty too, its '\n' ends both and carries the last paragraph's end mark
  (the schema has no field for it), so that line is sized by it rather than by its own.
- **Paragraphs**: align (justify, distribute) where it differs from the box, level, marL/indent, space
  before/after (points, or a share of the paragraph's largest run, as LibreOffice takes it), line spacing where it differs from the box's
  `lineHeight`, rtl where it differs from the box direction, and the nearest bullet: Wingdings, Wingdings
  2 and 3, Webdings and Symbol characters mapped with `@ordo/domain` `symbolFontChar` (drawn in the text's
  font; an unknown code, another symbol font's or any private-use character is '•'), other `buFont`s kept,
  automatic numbers with scheme and `startAt` (`(17)` verse numbers), `buClr`, `buSzPct`/`buSzPts`, a
  picture bullet as '•', `a:buNone` as null.
- **Fallback families** (`fontmap.ts`, at most 8): the box family's metric substitute (Carlito, Caladea,
  Liberation, Gelasio), the East Asian and complex-script families the text uses with theirs, the other run
  families' substitutes, then ordo's bundled script fallback for every script present (Han by language).
- **Lyric box**: on a bilingual slide (the two boxes with the most text in different languages, of
  comparable length) the first in reading order, as design/27 §4 says. Lengths weigh a Han, Kana or Hangul
  character as 2.5 Latin ones, so a Korean or Chinese line and its English translation compare; languages
  compare like with like (different script classes, or two different primary subtags when both boxes
  carry one).
- **Slide budget**: once a slide's rich text objects pass 64 KB of JSON (design/27 §3.4), its further text
  is written without runs and paragraph styles and the slide is classed picture (noted,
  `SLIDE_BUDGET_NOTE`), so layouts that repeat thousands of formatted runs on every slide never build
  megabytes the hub would discard. When the budget alone made the slide picture class, `overBudget` says
  so: the slide's JSON is over 64 KB too, and the hub counts and logs it as its own slide budget (one
  compact picture slide, one warning, the note dropped).
- The pure domain modules `bullets.ts`, `defaults.ts` and `readable.ts` are the only values imported from
  `@ordo/domain` (`purity.test.ts` checks that they import nothing else at run time); `@ordo/domain` is a
  dependency now.
- Tests: `richtext.test.ts` (crafted decks for each rule: verse superscripts, Wingdings and Symbol bullets,
  `(17)` numbering from startAt, mixed runs, Arabic right to left, a:br, end marks, normAutofit with a
  stored scale, scripts and fallbacks, the previous release's schema) and the lyric rules in `emit.test.ts`.

Measured (`--engine native --lo-compat`, LibreOffice 24.2 pictures, mean SSIM per deck; pptx-preview from
the validation suite's scores): the sermon decks 0.825 (M1) → 0.944, every deck above pptx-preview (0.927
mean); without `--lo-compat` 0.932, one deck 0.05 below where PowerPoint's stored shrink scale fits ordo's
box and LibreOffice re-fits smaller. Worship shard 0: 0.693 → 0.795 (pptx-preview 0.765), shard 2: 0.719 →
0.832 (0.765); on decks made only of T1 and T2 slides 0.840 and 0.831 against pptx-preview's 0.827 and
0.791. Shard 2's feature decks (pptx-preview on the same decks): lnSpcPct 0.782 (0.578), normAutofitScaled
0.780 (0.544), rtl 0.846 (0.835), rtlScriptText 0.889 (0.852), superSub 0.648 (0.558). Two decks of one
template lose 0.04 against M1: LibreOffice draws their (glowing) text at about 55 % of its size, which no
ordo rule explains yet.

Measured after the merge with the engine fixes and the harness's font resolver (the M2 exit of design/27
§15; `--lo-compat` runs, which draw each slide a policy rule changes both ways, so every number is given
drawn with LibreOffice's policies / with ordo's; pptx-preview with ordo's corrections, per slide):
- Sermon decks (73 slides): 0.944 / 0.932 against pptx-preview's 0.927. With LibreOffice's policies every
  deck is above pptx-preview; with ordo's, one deck is 0.040 below it, all of it on three slides whose
  body PowerPoint stored at a 92.5 % fit for a face this machine substitutes (ordo keeps the stored scale,
  LibreOffice fits again and wraps differently). 72 of 73 slides are native class (one hybrid: 3D).
- Worship shards 0 and 2 (179 decks): T1+T2 slides (1,014) 0.906 / 0.895 against 0.859 on the same slides
  (shard 0 0.918 / 0.913 against 0.883, shard 2 0.896 / 0.880 against 0.838).
- Text features, deck means as the targets were taken (pptx-preview on the same decks; target): superSub
  0.642 / 0.635 (0.616; 0.61), lnSpcPct 0.798 / 0.797 (0.743; 0.75), normAutofitScaled 0.849 / 0.838
  (0.762; 0.77), rtl 0.799 / 0.798 (0.685; 0.71), rtlScriptText 0.674 / 0.674 (0.645; 0.66). Per slide,
  native is above pptx-preview on the same slides for every feature; the normAutofitScaled slides alone
  are 0.758 / 0.714 (0.668).
- Raster p95 on the sermon slides, ordo's drawings, software raster on a shared 4-CPU machine: 10.2 ms at
  1920 and 45.4 ms at 3840 (M1: 9.1 and 45.4), over the budget of 8 and 30 ms. The slowest slides draw
  three or four full-slide pictures; then come slides with shadowed text (7.0 ms mean against 3.7 ms
  without), which the effect sprite cache of design/27 §7.5 is for.
- `--baseline` against M1's native scores flags one deck per shard (−0.044 each): the two decks of the
  template above.

Round 1, measured the same way after four renderer fixes were merged (PowerPoint's stored fit scale kept
only for the face it was fitted with, design/27 §6 step 10 and §10; the line of a trailing a:br single
spaced; pictures prepared once at their device size, §7.1; 1 pt runs kept at 2 px, §3.2). Every M2 exit
criterion of design/27 §15 is now met:
- Sermon decks: 0.955 / 0.953 (round 0: 0.944 / 0.932) against pptx-preview's 0.927, every deck above
  pptx-preview with both policies, by 0.012 to 0.063. The three slides whose face is substituted went
  from 0.734, 0.594 and 0.594 to 0.956, 0.899 and 0.899 with ordo's policies, and five slides of another
  deck that end paragraphs with a:br from 0.73-0.90 to 0.96-0.98. 72 of 73 slides native class (the 3D
  slide hybrid).
- Worship shards 0 and 2: T1+T2 slides (1,014; 1,003 native class, 11 hybrid for `anchorCtr` until
  M8) 0.908 / 0.897 (round 0: 0.906 / 0.895) against 0.859 on the same slides; shard 0 0.920 / 0.915
  against 0.883, shard 2 0.897 / 0.881 against 0.838. Shard means 0.802 / 0.799 and 0.834 / 0.827
  (round 0: 0.795 / 0.792 and 0.832 / 0.824). Of 1,999 slides compared with round 0, 283 rose by more
  than 0.002 and 10 fell, one by more than 0.01: a Tamil slide (0.638 → 0.597) whose face is
  substituted, so it is now fitted from full size as LibreOffice fits it, a drawing that scored 0.597 in
  round 0 as well (its `--lo-compat` picture), where PowerPoint's stored scale scored 0.638.
- Text features, deck means (pptx-preview; target): superSub 0.661 / 0.654 (0.616; 0.61), lnSpcPct 0.800 /
  0.799 (0.743; 0.75), normAutofitScaled 0.850 / 0.840 (0.762; 0.77), rtl 0.800 / 0.799 (0.685; 0.71),
  rtlScriptText 0.688 / 0.688 (0.645; 0.66).
- Raster p95 on the sermon slides, ordo's drawings (a run without `--lo-compat`, twice): 4.1 ms at 1920
  and 23.9-24.4 ms at 3840 (round 0: 10.2 and 45.4), within the budget of 8 and 30 ms. The slowest are
  slides with shadowed text (the effect sprite cache of design/27 §7.5), up to 29.7 ms at 3840; drawn as
  LibreOffice draws them, without run shadows, the p95 is 3.9 and 14.1 ms.
- The 25 lowest T1+T2 slides with ordo's policies (0.31-0.47) come from seven decks. Ten are two decks of
  one template whose theme background (`bgRef` 1002, a gradient) is drawn flat until M6 (pptx-preview
  0.42-0.63). Seven are one deck where ordo keeps PowerPoint's stored scale on a metric-compatible face
  and LibreOffice fits again (0.76-0.91 drawn with LibreOffice's policies), four a deck with an inherited
  stored scale. The rest: a Google Slides deck whose Arabic face is wider than LibreOffice's and one with
  embedded fonts, both within 0.01 of pptx-preview, and a page of very small verse references (0.464,
  pptx-preview 0.545).

Repair round, measured the same way after the review's fixes (PowerPoint's stored lnSpcReduction
subtracted from every paragraph's proportional spacing, single spacing included; a stored scale taken
from the shape's own `a:bodyPr` only; Wingdings 2, Wingdings 3 and Webdings bullets mapped; percentage
gaps sized by the paragraph's largest run; the bilingual rule weighing wide scripts; the 64 KB text
budget per slide; pictures cut to the canvas, decoded once per file and pinned while a cue draws them).
The M2 exit criteria stay met:
- Sermon decks: unchanged, 0.955 / 0.953 against pptx-preview's 0.927, every deck above it by 0.012 to
  0.063; 72 of 73 slides native class.
- Worship shards 0 and 2: T1+T2 slides 0.908 / 0.896 (round 1: 0.908 / 0.897) against 0.859; shard 0
  0.920 / 0.915 against 0.883, shard 2 0.897 / 0.880 against 0.838. Drawn as LibreOffice draws them, 7
  slides rose and 4 fell by more than 0.002; one fell by more than 0.01: a T2 slide of five columns of
  densely coloured runs (0.471 → 0.341), which passes the 64 KB budget (85 KB with three of its boxes
  formatted), so its last two boxes are written plain and it is classed picture, as the hub classes it.
  With ordo's policies, 12 rose and 40 fell: 29 slides whose PowerPoint scale is kept, which now fits
  single-spaced text with its line spacing reduced, as PowerPoint draws it, where LibreOffice fits again
  from full size and leaves single spacing alone (by up to 0.35, on slides where the reduced lines end
  well above LibreOffice's); seven where a layout's scale is no longer applied to the slide's text; four
  others by at most 0.13 (the slide above among them).
- Text features, deck means (pptx-preview; target): superSub 0.661 / 0.654 (0.616; 0.61), lnSpcPct 0.800 /
  0.800 (0.743; 0.75), normAutofitScaled 0.850 / 0.840 (0.762; 0.77), rtl 0.800 / 0.799 (0.685; 0.71),
  rtlScriptText 0.688 / 0.688 (0.645; 0.66). Per slide every feature stays above pptx-preview on the same
  slides; normAutofitScaled with ordo's policies 0.715 (round 1: 0.722; pptx-preview 0.668).
- Raster p95 on the sermon slides, ordo's drawings (two runs): 4.0-4.1 ms at 1920 and 23.3-24.1 ms at
  3840, within 8 and 30 ms. The harness now also reports the cold time, what an output pays on a slide
  change when its cache lacks the slide's pictures (decode and preparation plus the first draw): p95 67
  ms at 1920 and 137-144 ms at 3840 on the sermon slides, 73 / 109 ms and 86 / 112 ms on the shards.

Not done: hyperlink colours (PowerPoint draws linked runs in the theme's hlink colour), symbol-font
characters inside the text itself (`a:sym`), the `role: 'translation'` of the second language box, vertical
text (residual until M8). `ObjectOrigin` is written since the M4 scaffold (`emit.ts` `originOf`: shape id,
placeholder, role, and the group of a flattened group or of a shape and its text), except by the M1
emission (`richText: false`).

### D: image-crop (`packages/domain/src/schemas.ts`, `packages/renderer/src/clamp.ts`, `text2d.ts`, `golden/`)

Contract (design/27 §3.1): `ImageObject.crop: z.object({ l: frac, t: frac, r: frac, b: frac }).optional()`
with `frac = z.number().min(-1).max(1)`: the share of the source picture cut from each side (`a:srcRect`
/100,000), applied before `fit`; a negative value extends the source rect past the picture, which draws
transparent. `clampObject` keeps and re-bounds it (a crop that leaves nothing visible draws nothing);
`drawImageFit` gains an optional trailing `crop` parameter and draws with the 9-argument `drawImage`
(existing callers and every existing golden unchanged); one new golden case (crop with negative padding).
Nothing under `apps/` changes.

Done:
- `@ordo/domain`: `ImageCrop` (schema and type) and `ImageObject.crop: ImageCrop.optional()`; design/11 lists it.
- `@ordo/renderer`: `clampCrop(c): ImageCrop | undefined` (each share finite in -1..1, a malformed share
  reads as 0; undefined when absent or cutting nothing; a crop leaving nothing is kept and draws nothing).
  `clampObject` keeps it on images and adds no key to images without one. `drawImageFit(ctx, img, box,
  scale, fit, opacity?, radius?, crop?)`: the cropped rect is what `fit` places; only its part on the
  picture is drawn (9-argument `drawImage`), the rest stays transparent; without a crop the old 5-argument
  call is made unchanged. `drawObject` passes `o.crop`. Golden case `image-crop`; the 8 older goldens
  are unchanged (max delta 0).
- `@ordo/importers` `sanitizePresentation` bounds each share to -1..1 (NaN → 0) and drops a crop that is
  not an object, so an importer's crop never fails `lib.savePresentation`.
- Every copy of image objects in `apps/` spreads or `structuredClone`s them, so `crop` is carried through;
  both `slideImages` and `previewMedia` read only `mediaId`.

Left for M3 (when the hub first writes crops): the operator editor draws images with its own
`drawImageFit` call (`apps/operator/src/views/editor/SlideCanvas.tsx`) that does not pass `o.crop` yet, and
'Replace image' in `ObjectPanel.tsx` keeps the old picture's crop.

### E: harness (`tools/pptx-fidelity`: `native.ts`, `native-page.ts`, `main.ts`, `report.ts`, `package.json`)

Contracts (design/27 §14.1): `--engine native|ppv|both` and `--no-ppv`; `native.ts` reads a deck with
`extractZip` (media spilled, XML in memory), runs `parseDeck` and `emitSlides`, and writes `slides.json`
plus the pictures named by `EmitResult.media`; `native-page.ts` is an esbuild bundle of `@ordo/renderer`
(esbuild resolved as `packages/renderer/golden/run.ts` does, no new third-party dependency) drawing each
shown slide with `drawSlide2D` at 1920x1080 (`backgroundMediaId` cover-fit under it, like the thumbnail
worker) and at 3840 for timing, then cropping `slideRect`; fonts from `fc-match` (`pptx-render/src/fonts.ts`).
`summary.json` per slide: `nativeSsim`, `tier`, `class`, `reasons`, `convertMs` (`SlideScene.ms` +
`EmittedSlide.ms`), `rasterMs` at 1920 and 3840; the report gains a native column and per-tier and
per-feature means; cached LibreOffice pictures reused through `--out`; `native-baseline.json`. A deck the
converter cannot read is a note, never an abort. Uses only `@ordo/pptx-scene`'s public API (`index.ts`).

Done:
- **Run.** `pnpm --filter @ordo/pptx-fidelity start -- --engine native --out <dir> [--manifest
  manifest.json] [--baseline native-baseline.json] <decks or folders>`. The default engine stays `ppv`;
  `both` draws both columns, and `--no-ppv` removes pptx-preview from either.
- **Converting** (`convertDeck`, run by `convertDeckIsolated` in a worker thread with a 512 MB heap and a
  5-minute timeout per deck, kept warm between decks as the hub's pool workers are: a deck that exhausts
  either is a note, and the worker is replaced; the worker loads its TypeScript through tsx's loader, as
  the hub's pool does, so it converts under a test runner too). Spilled parts are found through an index of
  their names built once per deck. A deck link whose file is gone is skipped with a line in
  the log, not scored as a failed conversion. XML and `.rels` parts of 8 MB or less stay in
  memory, up to 64 MB in all; every other part is spilled, and `parseDeck` gets the pixel size of a spilled
  picture from its first bytes (`spilledPictureSize`). Only the pictures the slides use are kept, under generated names
  (`<deck>/native/media/<n>.<ext>`), at most 2,000 per deck. Pictures that are not PNG, JPEG, GIF, WebP or
  BMP by their bytes (EMF, WMF, TIFF, …) are counted in a note and not drawn. `slides.json` holds every
  slide (hidden ones too) with its tier, class, reasons, convert time, notes and ordo `Slide`.
- **Drawing** (`NativeRenderer`). One headless Chromium per run, a fresh page per deck. Every request
  except the page's own origin is refused, and host resolution is off. The page installs the renderer's
  `FontResolver` as its font environment, as the outputs' asset worker does, and the slides keep the
  deck's family names (`src/fonts.ts`): every family the slides ask for (runs, bullets, `fallbackFonts`)
  gets fontconfig's regular face, plus its bold, italic and bold italic faces when those are separate files
  of that family (missing variants are synthesized); ordo's default face, and the script fallbacks of the
  text's scripts that are installed here, with their script's `unicodeRange`. A script whose fallback family
  is missing falls back per glyph as LibreOffice's does (`--script-stand-ins` registers fontconfig's face
  for the script's language under the family's name instead). `summary.json` lists how each script
  fallback was served (`scriptFallbacks`). Pictures are decoded once per
  deck, scaled to the largest size the deck draws them at 3840 px (as the hub's picture preparation will),
  and kept in a bounded cache. `rasterMs` is the median of three draws (thumbnail-worker order: black,
  background cover, `drawSlide2D`) plus a one-pixel read-back, which makes Chromium rasterize.
- **Scoring.** `nativeSsim` uses the existing `ssim()` against `libreoffice/slide-NNNN.png` (page
  `shown + 1`). `blackSsim` is an all-black frame of the same size scored the same way: the "beats black"
  floor of the M1 exit (`beatsBlack`: higher than black, or a match at ≥ 0.999, so an all-black page drawn
  all black is not a loss). It is cached in `libreoffice/black-ssim.json`.
- **Reporting.** `summary.json` keeps the pptx-preview fields when that engine ran; per deck it adds
  `nativeSsim`, `nativeSlides`, `nativeMs`, `convertMs`, `embeddedFonts` (font parts present: left out of
  means), `nativeNotes`, and from `--manifest` `worship` and `features`. `report.html` adds tables per
  tier, class, classifier reason and manifest feature (worship decks first), each with the share of shown
  slides, mean native and pptx-preview SSIM and the share that beats black. It also gives p50/p95 convert
  and raster times and a native picture per slide.
- **Baseline.** `<out>/native-baseline.json` is written by every native run. `--baseline` takes it or a
  `summary.json`, prints the change per deck, and exits 1 when a worship deck (every deck without
  `--manifest`) loses more than `--max-drop` (default 0.02) of native SSIM.

- **Placement.** The corpus deck `placement-4x3` (solid boxes in their own colours on 4:3 slides) and
  `src/placement.ts <out>/corpus-placement-4x3`: each colour's bounding box on LibreOffice's page against
  the native page, written to `placement.json`, exit 1 above 2 px (the M1 exit).

- **Committed baseline.** `tools/pptx-fidelity/native-baseline.json` covers the synthetic corpus only
  (`--engine native --corpus`); real and third-party decks keep their baselines outside the repository.
  Check a change with `--engine native --corpus --baseline tools/pptx-fidelity/native-baseline.json`.

- **`--lo-compat`** (M2, design/27 §14.1): the native column drawn with LibreOffice 24.2's policies where
  ordo's follow PowerPoint. The converter writes them (`EmitOptions.loCompat`, emitted beside ordo's own
  slides by `convertDeck`): shrink-to-fit only for a shape's own `normAutofit` (LibreOffice ignores one
  inherited from a layout or master placeholder, measured) and re-fitted from full size instead of
  PowerPoint's stored scale; no run shadows (the shadow an unfilled shape casts stays); no outline on
  filled text (the copy LibreOffice draws has them stripped). `src/compat.ts` names the rules a slide hits
  (`runShadow`, `textOutline`, `refit`, `inheritedFit`), kept where the two drawings differ. Every run
  records them; `--lo-compat` draws those slides both ways (`slide-NNNN.policy.png`, `policySsim`,
  `nativePolicySsim`, `nativePolicyMean`), and `summary.json` and the report say `loCompat` and give the
  means both ways, overall and per rule; `--baseline` compares ordo's own drawings either way.
- **Text features and slide lists** (M2). Each slide gets the text features of its own XML
  (`src/features.ts`: the suite inventory's superSub, lnSpcPct, normAutofitScaled, rtl, rtlScriptText and
  bulletsAuto, and the census's mixedRuns). `summary.json` (`native.all`, `native.worship`) and the report
  give per feature the slide count and means, means per tier, the deck means and the M2 target.
  `--slides [DECK:]LIST` scores only some slides (repeatable; decks no list names are left out).

To do: the committed probe corpus with its CI gate (§14.2) belongs to a later milestone.

### F: classify (`classify.ts`)

Contracts: `tierOf(features): { tier, reasons }`, `slideFeatures(ctx): Set<string>`,
`featuresOf(root, prefix, out)`, `classifySlide(ctx, elements, background): Classification`,
`FALLBACK_FEATURES`, `TIER_BLOCKERS`; also `elementSupport(ctx, element, node)`, `refineSupport(ctx,
elements)`, `artRange(elements)`, `slideCost`, `boundsOf`, `overlaps`, `MAX_SLIDE_OBJECTS` (150) and
`MAX_SLIDE_PICTURES` (12). `Classification.art` (`ArtRange` in `ir.ts`) is set on hybrid slides.

**Tiers** (the census of design/27 "Why this design"). Feature names: group, table, chart, smartart, ole,
altcontent, connector, custGeom, gradFill, pattFill, video, vert, warp, 3d, glow, reflection, softEdge,
innerShdw, recolor, lum, artistic, bullet, rtl, superSub, tile, math, ink, mixedRuns, preset:other,
pic:&lt;ext&gt;, crop, shadow, outline. The slide's own shape tree gives all of them (since `Package.xml`
keeps one `mc:AlternateContent` branch, only the branch that is read counts; the wrapper still counts as
altcontent); the decorations it shows (non-placeholder layout shapes unless the slide has
`showMasterSp="0"`, master shapes unless the layout has it too) give the `featuresOf` ones as
`deco:<feature>` (cached per layout and master). Backgrounds are not part of the census. Tiers: fallback
when any of `FALLBACK_FEATURES`; else the first of T1-T4 whose `TIER_BLOCKERS` the slide avoids; else T5.
Reasons are the features that block the tier below; artistic, shadow and outline block nothing.

The rules follow the census script, except where its regular expressions missed their own rule: mixedRuns
compares the explicit run properties (attributes other than lang, altLang, dirty, err, noProof, smtClean,
kern, bmk, in any order, plus child elements) of runs that have text, so a run without `a:rPr` equals one
with neutral attributes only and whitespace inside the tag does not count; `crop` needs a non-zero side;
`outline` is an `a:ln` inside an `a:rPr`; slides whose relationship ids do not start with `rId` are counted.

**Support** per element (§5): the reader's verdict (walk: presets, fills, custom geometry past the bounds;
sheared children approx) merged with
residual (chart, table, SmartArt, OLE, other graphic frames, maths, a bevel with a size or an extrusion,
a warp other than `textNoShape`, text that is vertical, `numCol` > 1 or `anchorCtr` through the bodyPr
chain when it moves text (not when every paragraph that draws something is centred, `text.ts`),
`.wdp`/`.hdp` pictures) and approx (reflection, inner shadow, soft edge on a picture, EMF/WMF
waiting for conversion). The XML of an element is `ShapeElement.node` when the walk keeps it, else found
by source and `cNvPr id` (at most 4 candidates per kind, indexed once per part); each node's subtree is
rated once per deck (`marksOf`), so a huge layout shape sharing an id with thousands of elements costs one
walk.

**Class**: native without residual elements; hybrid with them: the art range [Rmin, Rmax] holds every
residual and every other element of the range that an art element above it overlaps (top down; hidden
elements and play videos never), with its bounding box; picture when the objects (a shape with fill or
line and text counts two, the background and the art one each) exceed 150 or the distinct pictures exceed
12 after the split. Reasons add `art:<residual reason>` and `budget:objects` / `budget:pictures`. Over 150
objects, shapes of one look are merged and tables, SmartArt drawings and elements without text go to the
art first (M6, "the object budget" above).

Measured (shown worship slides, cumulative T1 / T1-T2 / T1-T3 / T1-T4 / T1-T5): on the census's own 280
decks 31.9 / 73.2 / 87.7 / 92.5 / 95.8 % (census 30.9 / 73.3 / 87.6 / 92.5 / 95.8 %, n 4,922 against
4,897); on the 268 worship decks of `validate/scores.jsonl` 21.5 / 52.7 / 81.0 / 87.4 / 92.7 % (the census
script gives 20.3 / 52.7 / 81.0 / 87.4 / 92.7 % on the same decks: the set has more design templates).
After the M1 merge (one alternate-content branch, repeated listings shown as LibreOffice pages), the census
decks give 32.2 / 73.4 / 87.8 / 92.5 / 95.8 % over 4,941 shown slides.

Still to do: the 64 KB slide JSON budget for path data (§3.4: the converter counts text formatting only;
the hub's `planImportSizes` makes a slide whose stored paths pass it a compact picture, and a traced
decoration of 6,500 points in 7-digit EMU is 100 KB of path text on its own); kerning and unknown transitions as approx (slide-level, M8); `artText` from `ArtRange.elements`
(emission, M3).
