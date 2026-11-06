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

### A: reading (`xml.ts`, `opc.ts`, `deck.ts`, `frame.ts`)

Contracts:
- `xml.ts`: `XNode`, `parseXml(xml, part): XNode[]`, `rootOf`, `child`, `children`, `firstChild`, `path`,
  `textOf`, `num`, `startTags`, `countUpTo`, `decodeEntities`, `MAX_TAGS_PER_PART`, `XML_MAX_DEPTH`.
  `pptx-render/src/annotate.ts` imports it as `@ordo/pptx-scene/xml.ts`: keep its output for well-formed
  parts identical (it matched fast-xml-parser on 26,980 real parts, apart from top-level whitespace,
  merged CDATA and decoded numeric references).
- `openPackage(src, log?): Package` with `find`, `has`, `bytes`, `text`, `xml`, `rels`, `rel`, `relOfType`,
  `contentType`, `log`. `xml(name)` returns the cached root, undefined when the part is missing, and throws
  when it is over budget or malformed. `Rel.target` is resolved, normalised and the stored part name.
  `relType(uri)`, `relsPartOf`, `resolveTarget`, `externalHost`, `MAX_XML_PART_BYTES`.
- `readDeck(pkg): DeckInfo` (`size`, `slides: SlideRef[]` with `index`, `part`, `hidden`, `shown`,
  `defaultTextStyle`, `sections`, `embeddedFonts`); `slideParts(pkg, part): SlideParts`.
- `frame.ts`: `frameOf`, `lenPx`, `ptPx`, `slideRect`, `IDENTITY`, `multiply`, `apply`, `xfrmAffine`,
  `childSpace`, `decompose`, `boxPx`.

To do (design/27 §1, §4 "Order and identity", §12): Strict → Transitional (`annotate.ts` 1478-1539,
including `"90%"` percentages, before parsing), a prefix-agnostic `r:id`, slides by `slideN` number when
`p:sldIdLst` is empty, duplicates placed once and the shown index as `annotate.ts` `placeSlides`
(725-800), `p14:sectionLst`, `embeddedFontLst`, External targets logged with their host only, content-type
overrides naming missing parts ignored. Tests: the §14 fuzz list that concerns reading (DOCTYPE, billion
laughs, `a:__proto__`, depth, huge parts, cyclic rels, External targets, hidden-only decks, 10,000 media
parts, control characters in names), each under 5 s.

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
- `inherit.ts`: `PhRef`, `Chain`, `placeholderOf`, `nvOf`, `spPrOf`, `masterClass`, `isTitle`,
  `layoutPlaceholder`, `masterPlaceholder`, `chainOf`, `nodes`, `inheritedXfrm`, `bodyPrChain`, `listLevel`,
  `paraChain`, `firstAttr`, `firstChildOf`.
- `walkSlide(ctx): Element[]` bottom first (master decorations, layout decorations, own shapes), groups
  flattened with `group`; `walkTree`, `readXfrm`, `M1_PRESETS`, `MAX_GROUP_DEPTH`, `MAX_SHAPES_PER_SLIDE`.
- `readTextBody(ctx, chain): TextBody | undefined`, `runStyle`, `plainText`.
- `readBlipFill(ctx, blipFill, source)`, `readPicture(ctx, el, base)`, `blipReader(ctx, from)`, `readInsets`.
- `readBackground(ctx): Background`.
- `emitDeck(scene, opts): EmitResult` (`slides: EmittedSlide[]` with `slide` (an ordo `Slide` that
  `Slide.parse` returns unchanged), `index`, `shown`, `hidden`, `classification`, `digest`, `notes`, `ms`;
  `media: {id, part}[]`; `slideRect`; `notes`), `EmitOptions` (`newId`, `mediaId`, `extendBackgrounds`),
  `MEDIA_PREFIX`, `digestOf`. Only today's objects plus `ImageObject.crop` (after D).

M1 scope (design/27 §15 M1): placeholder xfrm/bodyPr inheritance; the first run's style through the chain
(`defaultTextStyle` for non-placeholders, not otherStyle): size, colour, bold, italic, Latin font through
the theme; algn → align; anchor → valign; insets → padding; outline w/2; outer shadow; lnSpcPct →
lineHeight; master/layout shapes with `showMasterSp`; solid and stretched-picture backgrounds;
rect/roundRect/ellipse/line; `p:pic` stretch; groups by offset and scale; `mc:AlternateContent` (first
understood Choice, else Fallback); placeholders without a position; empty placeholders not drawn. Write
`crop` from `PictureFill.crop` (srcRect fractions, negatives kept) once D's schema field exists; until then
the IR carries it. Legacy values per §3.2 (gradients as their first stop, etc.).

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
