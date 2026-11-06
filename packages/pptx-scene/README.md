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
  whole when its real points fit 4,096; past that it is split into stored paths only where no sub-path of one
  part overlaps one of another (even-odd holes stay with their outlines). What the compiler replaced by 0 is
  noted (`custom geometry: …`) and still drawn. Native while within the bounds (8 paths, 4,096 points a path,
  64k points a slide); past them residual (`custGeom`, the LibreOffice art). A thin custom geometry's legacy
  is a `line`, which draws no fill, as M1 drew nothing for it.
- **Gradients** (`a:gradFill`): `gradient` with the stops (≤ 16, laid on white for backgrounds); linear with
  `angle` and `scaled` as written (`rotWithShape="0"`: turned back by the shape's rotation), path gradients
  radial from the centre of `a:fillToRect` (`rect` and `shape` paths noted as radial). Background gradients
  are drawn; gradient text paints the box (`TextStyle.paint`, `richtext.ts`), a run in another gradient
  keeps its first stop (noted). Pattern fills stay their blended colour (approx, noted).
- **Lines**: `dash` from `a:prstDash` (all eleven), `a:custDash` the nearest by its lengths (noted); `ends`
  from `a:headEnd`/`a:tailEnd` with their sizes. Joins (`a:round`/`a:bevel`/`a:miter`) and caps are read
  into the IR (`Line.join`, `Line.cap`); the schema has no field for them yet.
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
  are native (no reason); approx: unknown presets (`preset:<name>`, `mask:<name>`), pattern fills; residual:
  custom geometry past the bounds. Census tiers are unchanged (they count feature use, not support).

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


| File            | What                                                                                                              | Owner  |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| `xml.ts`        | Bounded XML reader (moved from pptx-render; no DTD: `<!DOCTYPE` refused, null-prototype `attrs`) and node helpers | A      |
| `opc.ts`        | `PartSource`, `openPackage`: part lookup, decoding, cached parsing, content types, relationships                  | A      |
| `markup.ts`     | Every part as one dialect: Strict → Transitional, the usual prefixes, one branch of `mc:AlternateContent`         | A      |
| `deck.ts`       | `readDeck`: slide size, order, hidden flags, shown index, defaultTextStyle, sections; `slideParts`                | A      |
| `frame.ts`      | EMU → 1920x1080 contain map, affine transforms, `boxPx`                                                           | A      |
| `theme.ts`      | `readTheme`: colour, font and format schemes; `themeFont`, `langScript`, style font/line/effect references        | B      |
| `color.ts`      | `ColorCtx`, colour maps, colour elements and modifiers, fills, `styleEntry`, `styleFill`                          | B      |
| `inherit.ts`    | Placeholder matching, xfrm/bodyPr chain, paragraph-property chain                                                 | C      |
| `walk.ts`       | Shape-tree walk: decorations, groups flattened, shapes                                                            | C      |
| `text.ts`       | Text bodies: paragraphs, runs, run styles through the chain                                                       | C      |
| `picture.ts`    | `p:pic` and every `a:blipFill`                                                                                    | C      |
| `background.ts` | Slide → layout → master background                                                                                | C      |
| `emit.ts`       | IR → ordo objects, media placeholders, digest                                                                     | C      |
| `richtext.ts`   | A text body as rich ordo text: runs, paragraph styles, office box fields (M2)                                     | C (M2) |
| `fontmap.ts`    | Script class of each character (Latin, East Asian, complex), substitutes and fallback families (M2)               | C (M2) |
| `classify.ts`   | Census tiers T1-T5, reasons, slide class                                                                          | F      |
| `geom.ts`       | Presets, custom geometry, text rectangles and sites, gradients, dashes, arrowheads, connector glue (M6)           | M6b B  |
| `notes.ts`      | `readNotes`: a slide's speaker notes (notesSlide body placeholders), bounded                                      | M3 B   |
| `transition.ts` | `readTransition`, `readSlideTransition` (a slide's tail only), `showLoops` (`p:showPr loop`)                      | M3 B   |
| `timing.ts`     | `readSlideTiming`: the `p:timing` mapping of clips, transition and animation sounds; `gainDbOf`                   | M3b A  |
| `media.ts`      | `readMediaRef` (a poster's clip, trim, kind), `emitMedia` (play, slide sound, motion background), `EmittedClip`   | M3b A  |
| `ir.ts`         | The scene IR (types only)                                                                                         | shared |
| `context.ts`    | `SlideCtx`, `slideContext`                                                                                        | shared |
| `log.ts`        | `clean`, `noteList`                                                                                               | shared |
| `index.ts`      | `parseDeck`, `emitSlides`, public types                                                                           | shared |
| `test-util.ts`  | Test decks as `PartSource` maps of XML strings                                                                    | shared |

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
  everything else, never otherStyle): size, fill, bold, italic, underline, strike, caps, spacing, baseline,
  Latin/EA/CS/sym typefaces through the theme (+mj for titles, +mn otherwise), outline (`a:ln`), outer
  shadow, highlight, lang. Paragraphs: algn, level, marL/indent, rtl, spcBef/spcAft/lnSpc, the nearest
  bullet setting (buNone wins). Bodies: insets, anchor, wrap, normAutofit/spAutoFit, vert, numCol,
  anchorCtr, warp.
- Walk: `showMasterSp` on the slide (both) and the layout (the master's); `mc:AlternateContent` through
  `chooseAlternate` (the branch `Package.xml` keeps: the first Choice of a14, p14 or p15, else Fallback); style references (fillRef, lnRef, effectRef with phClr);
  `useBgFill` with a solid background; `a:grpFill`; groups by offset, scale, rotation and flips, a child's
  own box scaled along the group's axes (`boxAffine`, no shear; a child the composed affine would shear is
  marked residual and still drawn); graphic frames residual; ≤ 32 group levels, ≤ 5,000 shapes.
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
  transparent), highlight, underline, strike, caps, letter spacing, `baseline`, outline and shadow (null
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
characters inside the text itself (`a:sym`), `origin` and the `role: 'translation'` of the second
language box (M3, with the rest of `ObjectOrigin`), vertical text (residual until M8).

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

**Support** per element (§5): the reader's verdict (walk: presets, fills; sheared children) merged with
residual (chart, table, SmartArt, OLE, other graphic frames, maths, a bevel with a size or an extrusion,
a warp other than `textNoShape`, text that is vertical, `numCol` > 1 or `anchorCtr` through the bodyPr
chain, `.wdp`/`.hdp` pictures) and approx (reflection, inner shadow, soft edge on a picture, EMF/WMF
waiting for conversion). The XML of an element is `ShapeElement.node` when the walk keeps it, else found
by source and `cNvPr id` (at most 4 candidates per kind, indexed once per part); each node's subtree is
rated once per deck (`marksOf`), so a huge layout shape sharing an id with thousands of elements costs one
walk.

**Class**: native without residual elements; hybrid with them: the art range [Rmin, Rmax] holds every
residual and every other element of the range that an art element above it overlaps (top down; hidden
elements and play videos never), with its bounding box; picture when the objects (a shape with fill or
line and text counts two, the background and the art one each) exceed 150 or the distinct pictures exceed
12 after the split. Reasons add `art:<residual reason>` and `budget:objects` / `budget:pictures`.

Measured (shown worship slides, cumulative T1 / T1-T2 / T1-T3 / T1-T4 / T1-T5): on the census's own 280
decks 31.9 / 73.2 / 87.7 / 92.5 / 95.8 % (census 30.9 / 73.3 / 87.6 / 92.5 / 95.8 %, n 4,922 against
4,897); on the 268 worship decks of `validate/scores.jsonl` 21.5 / 52.7 / 81.0 / 87.4 / 92.7 % (the census
script gives 20.3 / 52.7 / 81.0 / 87.4 / 92.7 % on the same decks: the set has more design templates).
After the M1 merge (one alternate-content branch, repeated listings shown as LibreOffice pages), the census
decks give 32.2 / 73.4 / 87.8 / 92.5 / 95.8 % over 4,941 shown slides.

Still to do: the 64 KB slide JSON budget and the 4,096 path points (§3.4, M3/M6, once emission measures
them); kerning and unknown transitions as approx (slide-level, M8); `artText` from `ArtRange.elements`
(emission, M3).
