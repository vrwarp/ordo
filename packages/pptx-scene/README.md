# @ordo/pptx-scene

PowerPoint decks as ordinary ordo slides ([design/27](../../docs/design/27-pptx-native-renderer.md)).
The deck is untrusted input; this package reads it into a hub-internal scene IR and emits today's ordo
objects, which `@ordo/renderer` draws like any other slide.

```ts
import { emitSlides, parseDeck } from '@ordo/pptx-scene';

const scene = parseDeck(files); // Map<part name, bytes>, e.g. extractZip(...).files
const out = emitSlides(scene, { mediaId }); // ordo Slides; pictures as 'pptxmedia:<part>' unless mapped
```

- **Pure TypeScript.** No DOM, no zip, no fs and no runtime dependency: it runs on the hub's CPU pool (M3)
  and in Node for the fidelity harness. Code outside tests imports only its own modules and _types_ from
  `@ordo/domain` (`purity.test.ts` enforces it). Media parts may be empty (spilled by `extractZip`): only
  their names are used.
- **Never throws for one bad slide.** A slide that cannot be read gets `error` and class `'picture'`; the
  rest of the deck is read. `parseDeck` throws only when there is no presentation part.
- **Bounded** (design/27 §12): XML ≤ 8 MB and ≤ 250k tags per part, depth 256, ≤ 2,000 slides, ≤ 5,000
  shapes per slide, group depth ≤ 32, numbers finite and clamped, no `{}` keyed by deck strings (use `Map`
  or `Object.create(null)`), no regular expression over a whole part, deck strings through `clean()` before
  they reach a note.

## Module map

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
| `classify.ts`   | Census tiers T1-T5, reasons, slide class                                                                          | F      |
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
  ../../../../packages/pptx-scene`, `packages/pptx-scene/node_modules/@ordo/domain → ../../../domain`).

### A: reading (`xml.ts`, `opc.ts`, `markup.ts`, `deck.ts`, `frame.ts`)

Contracts:
- `xml.ts`: `XNode`, `parseXml(xml, part): XNode[]`, `rootOf`, `rootTag`, `child`, `children`, `firstChild`,
  `path`, `textOf`, `num`, `startTags`, `countUpTo`, `decodeEntities`, `MAX_TAGS_PER_PART`, `XML_MAX_DEPTH`.
  `pptx-render/src/annotate.ts` imports it as `@ordo/pptx-scene/xml.ts`: keep its output for well-formed
  parts identical (it matched fast-xml-parser on 26,980 real parts, apart from top-level whitespace,
  merged CDATA and decoded numeric references).
- `openPackage(src, log?, opts?): Package` with `find`, `has`, `bytes`, `text`, `xml`, `rels`, `rel`,
  `relOfType` (a short type name or a full URI, Strict or Transitional), `contentType`, `partsOfType`, `log`.
  `find` folds case: the first of names that differ only by case is the part, however a name is spelled.
  `xml(name)` returns the cached root, undefined when the part is missing, and throws when it is over budget
  or malformed. `Rel.target` is resolved, normalised and the stored part name; `Rel.type` is Transitional.
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
  else the declared encoding, else UTF-8; parsed trees cached within 16 M characters (LRU). Content-type
  overrides naming missing parts ignored. Relationship targets: fragment dropped, percent-decoded, `.`/`..`
  applied never above the root, leading `/` the root; a duplicate `Id` keeps the first; targets over 2,048
  characters ignored; `TargetMode="External"` never resolved or fetched, noted as `external <type> target
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
  `color.ts`, re-exported), `SCHEME_COLORS`, `MAX_TYPEFACE`, `MAX_SCRIPT_FONTS`.
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
  `firstOfAny`.
- `walkSlide(ctx): Element[]` bottom first (master decorations, layout decorations, own shapes), groups
  flattened with `group`; `walkTree(ctx, tree, from, map, group, depth, st, inherit?)` (`GroupInherit`:
  `fill` for `a:grpFill`, `sheared`), `boxAffine`, `alternateBranch`, `UNDERSTOOD_PREFIXES`, `pathCoverage`,
  `readXfrm`, `M1_PRESETS`, `MAX_GROUP_DEPTH`, `MAX_SHAPES_PER_SLIDE`.
- `readTextBody(ctx, chain): TextBody | undefined`, `runStyle`, `readShadow`, `plainText`, `textChars`.
- `readBlipFill(ctx, blipFill, source)`, `readPicture(ctx, el, base)` (a `PictureElement`, or a
  `ResidualElement` for a metafile), `blipReader(ctx, from)`, `blipReaderOf(ctx, part)`, `readInsets`,
  `pictureSize`, `extensionOf`.
- `readBackground(ctx): Background`.
- `emitDeck(scene, opts): EmitResult` (`slides: EmittedSlide[]` with `slide` (an ordo `Slide` that
  `Slide.parse` returns unchanged), `index`, `shown`, `hidden`, `classification`, `digest`, `notes`, `ms`;
  `media: {id, part}[]`; `slideRect`; `notes`), `EmitOptions` (`newId`, `mediaId`, `extendBackgrounds`,
  `crop`), `CroppedImage`, `MEDIA_PREFIX`, `digestOf`, `legacyColor`, `legacyText`, `dominant`,
  `placePicture`, `insetBox`.
- Shared additions: `SlideCtx.themePart` (theme picture fills), `PictureFill.px` (header-sniffed pixel
  size), `PictureElement.adj`, `ShapeElement.coverage`.

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
- Walk: `showMasterSp` on the slide (both) and the layout (the master's); `mc:AlternateContent` first
  understood Choice (p14, p15) else Fallback; style references (fillRef, lnRef, effectRef with phClr);
  `useBgFill` with a solid background; `a:grpFill`; groups by offset, scale, rotation and flips, a child's
  own box scaled along the group's axes (`boxAffine`, no shear; a child the composed affine would shear is
  marked residual and still drawn); graphic frames residual; ≤ 32 group levels, ≤ 5,000 shapes.
- Pictures: blip part through the holding part's relationships (theme parts too), srcRect, fillRect,
  tile, alphaModFix, recolour effects (an empty `a:lum` is not one), header-sniffed size, metafiles
  residual, TIFF/WDP noted, linked pictures logged with their host only, video/audio posters recorded.
- Emission: legacy objects per §3.2 (text in its dominant run's style; padding the smallest inset with the
  rest folded into the box; ellipse/roundRect text rectangles; wrap="none" widened; vert turned a quarter;
  lineHeight 1.2 × lnSpcPct minus lnSpcReduction, or the exact pitch; stored fontScale applied; outline
  w/2; hollow text; run or unfilled-shape shadow; gradients as their first stop, patterns blended; lines and
  connectors as straight segments at any angle; roundRect radius from adj; ellipse and roundRect picture
  clips as `radius`; picture outlines as stroke-only shapes; custom geometry as its rect only when it fills
  half its box); backgrounds (16:9 plain picture of the slide's aspect → `backgroundMediaId`, other pictures
  a bottom image over the slide area, colours a bottom rect over the frame or the slide area, none white);
  the lyric box of §4 "Church mappings" (not the bilingual rule); ≤ 1,000 objects.
- `crop`: written from srcRect (and fillRect clipping) when `EmitOptions.crop` is set. Off by default until
  work item D's schema field is merged: the integrator turns it on (default or in the harness).

Left for later milestones: rich runs and paragraphs (M2: dominant style only today), bullets and numbering
drawn (M2; read into the IR), shape text rectangles of other presets and custom paths (M6), the bilingual
lyric rule, picture masks/flips/adjust (M3), arrowheads and dashes (M6), tiles pre-tiled (M3), media (M5).

### D: image-crop (`packages/domain/src/schemas.ts`, `packages/renderer/src/clamp.ts`, `text2d.ts`, `golden/`)

Contract (design/27 §3.1): `ImageObject.crop: z.object({ l: frac, t: frac, r: frac, b: frac }).optional()`
with `frac = z.number().min(-1).max(1)`: the share of the source picture cut from each side (`a:srcRect`
/100,000), applied before `fit`; a negative value extends the source rect past the picture, which draws
transparent. `clampObject` keeps and re-bounds it (a crop that leaves nothing visible draws nothing);
`drawImageFit` gains an optional trailing `crop` parameter and draws with the 9-argument `drawImage`
(existing callers and every existing golden unchanged); one new golden case (crop with negative padding).
Nothing under `apps/` changes.

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

### F: classify (`classify.ts`)

Contracts: `tierOf(features): { tier, reasons }`, `slideFeatures(ctx): Set<string>`,
`featuresOf(root, prefix, out)`, `classifySlide(ctx, elements, background): Classification`,
`FALLBACK_FEATURES`, `TIER_BLOCKERS`. Feature names are the census's (design/27 "Why this design"):
group, table, chart, smartart, ole, altcontent, connector, custGeom, gradFill, pattFill, video, vert, warp,
3d, glow, reflection, softEdge, innerShdw, recolor, lum, artistic, bullet, rtl, superSub, tile, math, ink,
mixedRuns, preset:other, pic:&lt;ext&gt;, crop, shadow, outline; decorations as `deco:<feature>`. Tiers:
fallback when any of `FALLBACK_FEATURES`; else the first of T1-T4 whose `TIER_BLOCKERS` the slide avoids;
else T5. Reasons are the features that block the tier below.

To do: the attribute features (`vert` other than horz, a real `prstTxWarp`, `rtl="1"`, a non-zero
`baseline`, `a:srcRect` with a side set, a preset other than rect/roundRect/ellipse/line, `pic:<ext>` of
emf/wmf/tif/tiff/wdp/hdp/bmp blips through the relationships), mixedRuns (explicit `a:rPr` that differ
other than in lang, altLang, dirty, err, noProof, smtClean, kern, bmk), shadow (`a:outerShdw` in an
`a:effectLst`), outline (`a:ln` in an `a:rPr`); per-element support; the slide class (native, hybrid
with the art z-range, picture); size budgets (§3.4) later. Exit: the T1 share of shown worship slides is
within ±3 points of the census (30.9 %).
