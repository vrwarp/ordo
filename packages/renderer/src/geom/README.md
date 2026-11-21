# DrawingML shape geometry

The preset and custom geometry engine of design/27 §1 (`geom/`), §3.1 (`ShapeGeom`) and §15 M6: what a
PowerPoint `a:prstGeom` or `a:custGeom` means, as numbers. Read design/27 §3.1, §12 (bounds) and §14 item 6 first.

Status: **M6 wave 2, and the geometry half of WordArt warps** (r2b sub-wave 2). The preset table, the compiler,
the guide evaluator, the path builder (arcTo with POI's visual-angle rule, path spaces, fill modes) and the Canvas
2D drawer are built and tested, and the preset golden compares them with LibreOffice (wave 1). Wave 2 draws real
slides with them: stored geometries (`ShapeObject.geom`, `ImageObject.mask`), gradients, dashes, line ends, the
shapes and their effects (`../shape.ts`, `../effects.ts`) and picture masks (`../picture.ts`); `@ordo/renderer`
re-exports all of it. The 40 WordArt warps are built here too (`textwarp.ts`); nothing draws with them yet (the
glyph painter that bends text along them is part 3's).

```ts
const g = presetGeometry('star5', w, h, [['adj', 25000]]); // undefined for an unknown name: draw the rect
ctx.translate(x, y); // box space: 0..w, 0..h (rotate and flip around it as the box says)
drawGeom(ctx, g, fill, { color, width }); // fill: an Rgba, or (brightness) => gradient for shaded paths
const deck = customGeometry(custGeomStrings, w, h); // a:custGeom; deck.notes says what was dropped
```

| File               | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops.ts`           | The compiled form (`CompiledGeom`, `CompiledPath`): the 17 operators and their op codes, the 40 built-in guides in slot order, path commands, fill modes, handle encoding and `GEOM_LIMITS`.                                                                                                                                                                                                                                                                |
| `compile.ts`       | `compileGeom(GeomSource)`: geometry given as strings (a preset read by `tools/geom-gen`, a custGeom read by the converter) → `CompiledGeom`, with `GeomNotes` for what it replaced by 0 or dropped.                                                                                                                                                                                                                                                         |
| `eval.ts`          | `evalGuides(geom, box, adj)`: every slot's value at a box; `guideSlot`/`guideValue`/`guideValues` by name; `evalGuideLists` for a custGeom's avLst/gdLst given as `[name, fmla]` pairs.                                                                                                                                                                                                                                                                     |
| `arc.ts`           | `arcToCubics`: an arcTo from the current point as at most four cubic segments (POI's visual-angle rule, Arc2D's segments); `arcParamAngle`, the visual-to-parametric angle.                                                                                                                                                                                                                                                                                 |
| `path.ts`          | `buildGeom(geom, w, h, adj)`: sub-paths in box space with fill mode and stroke flag, the text rect, the connection sites; `presetGeometry`, `customGeometry`, `pathData`.                                                                                                                                                                                                                                                                                   |
| `draw.ts`          | `drawGeom(ctx, built, fill, stroke)`: Canvas 2D, Path2D per path, LibreOffice's order, even-odd rule and shades (`shadeRgba`); `geomFillPath2D` for picture clips.                                                                                                                                                                                                                                                                                          |
| `nesting.ts`       | How a path's sub-paths nest (`unionSubs`, `nestingDepths`, within `UNION_NESTING_LIMIT` and `UNION_NESTING_WORK`) and the even-odd area that follows (`evenOddArea`): pure, shared by the union clip and the converter's legacy shape.                                                                                                                                                                                                                      |
| `ends.ts`          | Line ends: `arrowFor` (LibreOffice's marker sizes), `withEnds` (the shaft cut back and the marker polygons of every open sub-path).                                                                                                                                                                                                                                                                                                                         |
| `markers.ts`       | LibreOffice's marker polygons, size factors and smallest base (`lclPushMarkerProperties`), ported under the MPL 2.0 and kept in their own file with its header.                                                                                                                                                                                                                                                                                             |
| `cost.ts`          | The drawing estimate of a shape as drawn: fills with the pixels they paint (`unitCost`, `geomCost`, `areaWeight`; a gradient off Skia's two-stop fast path twice, `slowGradient`), outlines with their joins, caps, dashes and arrowheads (`strokeCost`), effect passes (`drawCost`), slide objects (`objectCost`); the budgets of one geometry and one slide (`GEOM_COST`, `slidePlan`, `charged`) and of a slide's effects (`EFFECT_COST`, `effectArea`). |
| `outline.ts`       | A shape's outline as drawn (`outlineOf`: width, joins, caps, dash pattern, arrowheads), shared by the drawer and the estimate.                                                                                                                                                                                                                                                                                                                              |
| `built.ts`         | Stored paths and legacy shapes built at a box (`geometryAt`, `legacyGeometry`), shared by the drawers and the converter's estimate.                                                                                                                                                                                                                                                                                                                         |
| `bounds.ts`        | What a shape covers: its geometry's points grown by its outline's sharpest miter and caps, and its arrowheads around the open sub-paths' end points (`drawnBounds`, `miterFactor`), placed on the slide and cut to the canvas (`placedBounds`, `canvasArea`); the effect layers' region and size, and the painted areas' cut.                                                                                                                               |
| `paint.ts`         | `gradientStyle`: a `Gradient` over a box (OOXML angle and `scaled`, radial focus to the farthest corner on an ellipse of the box), each stop shaded for a path's brightness; two stops inside 0..1 drawn as two at 0 and 1 over that part of the line (`fastStops`), Skia's fast path.                                                                                                                                                                      |
| `stops.ts`         | The stops a gradient is drawn with (`drawnStops`: sorted, end stops repeating a neighbour's colour dropped), which the drawer and the estimate (`slowGradient`) share.                                                                                                                                                                                                                                                                                      |
| `stored.ts`        | `storedGeometry`: a `ShapeGeom` at a box (its geometry file's paths, else a preset by name, else its re-tokenised paths); `readGeomFiles`/`putGeomFile`: geometry files; `legacyGeometry`: the legacy shapes.                                                                                                                                                                                                                                               |
| `presets.gen.ts`   | Generated (`pnpm --filter @ordo/geom-gen gen`, never edited): the 187 presets of `third_party/poi-presets` as `PRESET_GEOMS`, with the two fixes of its README.                                                                                                                                                                                                                                                                                             |
| `textwarps.gen.ts` | Generated (the same command, never edited): the 40 WordArt warps of `third_party/ooxml-textwarps` as `TEXT_WARP_GEOMS` (about 17 kB), imported by `textwarp.ts` only.                                                                                                                                                                                                                                                                                       |
| `textwarp.ts`      | The warps' geometry: `textWarpGeometry` (a warp built at a box through `buildGeom`), `warpFollowsPath`, `warpMode` (by the built geometry), `warpAreas`, `warpAdjustNames`; see Text warps below.                                                                                                                                                                                                                                                           |
| `poi-guides.json`  | Reference values from POI 5.2.5 itself for the dozen presets of the spot checks (`tools/geom-gen/poi/GuideDump.java`).                                                                                                                                                                                                                                                                                                                                      |
| `poi-paths.json`   | POI 5.2.5's own paths (segments, text rect, sites) for the dozen presets and for arcs in every quadrant and path spaces (`tools/geom-gen/poi/PathDump.java`).                                                                                                                                                                                                                                                                                               |
| `index.ts`         | The geometry surface (`@ordo/renderer/geom/index.ts`, for the converter and tools); `@ordo/renderer` re-exports its drawing API.                                                                                                                                                                                                                                                                                                                            |

## The compiled form

A geometry is a program over numbered slots: the 40 built-ins (w, h, l, t, r, b, hc, vc, ss, ls, the hd*, wd*,
ssd* fractions and the circle fractions cd2...7cd8), then one slot per distinct constant, then one per adjust
value and guide (avLst first, then gdLst). Every operand anywhere (formula arguments, path points, the text rect,
handle bounds, connection sites) is a slot index. A guide reads only slots below its own.

```
CompiledGeom { k: constants, a: adjust names, g: [op, x, y, z] per guide, n: guide names,
               r: [l, t, r, b] slots, p: paths { w?, h?, f?, s?, e?, c: [cmd, slots...] },
               h?: handles (9 numbers each), c?: connection sites [ang, x, y] }
```

## Semantics: Apache POI 5.2.5

`GuideIf.evaluateGuide`, `BuiltInGuide` and `Context`, checked value for value: `eval.test.ts` compares every
adjust value and guide of rect, roundRect, ellipse, triangle, rightArrow, chevron, star5, pie, arc, cloud, can and
ribbon2 (25 boxes and adjustments) with POI's own output, and when the evaluator was written all 187 presets at
three boxes (11,730 values) agreed with POI to within 3e-15 relative.

- `*/ x y z` = x·y/z and `+/ x y z` = (x + y)/z, both 0 when z = 0; `+- x y z` = x + y − z; `?: x y z` = y when
  x > 0, else z; `abs`, `max`, `min`, `sqrt`, `val`; `mod x y z` = √(x² + y² + z²); `pin x y z` = max(x, min(y, z)).
- Angles are 60000ths of a degree, clockwise (y down): `at2 x y` = atan2(y, x) in those units; `sin x y`,
  `cos x y`, `tan x y` = x·f(y); `cat2 x y z` = x·cos(atan2(z, y)); `sat2 x y z` = x·sin(atan2(z, y)). Degrees and
  radians convert with Java's `toDegrees`/`toRadians` factors.
- A missing operand is 0; extra ones are ignored.
- Adjust values come first; a shape's `adj` pair replaces the adjust value it names (the first pair of the name).
- A formula sees the names defined before it, the latest definition winning, and a defined name shadows a
  built-in. Paths, the text rect, handles and sites see every name.
- The built-ins beyond ECMA-376 that the presets use are known: wd12, wd32, hd10, cd3 (POI 5.2.5 knows only wd32).

Where POI throws, this engine gives 0 and notes it, so one bad guide never loses the shape: an unknown name, a
reference to a later guide (LibreOffice does not resolve those either), an unknown operator. Tokens are strict: a
number is a plain decimal (`[+-]digits[.digits][e[+-]digits]`), so `NaN`, `Infinity`, hex floats and Java's `f`/`d`
suffixes, which POI's number pattern accepts, are names here. An unknown `fill` reads as `norm` (POI: `none`), as
the schema's `.catch('norm')` does.

## Bounds (the deck is untrusted)

`GEOM_LIMITS`: at most 256 adjust values and guides per shape (design/27 §12; gear9, the largest preset, has 244),
8 paths, 4,096 points per path (an arcTo counts 12, the four cubic segments a full turn becomes; every command at
least 1), 32 handles, 64 connection sites; names over 256 characters bind nothing, formulas over 1,024 characters
are 0. The compiler drops what is over a bound and notes it (at most 32 distinct notes, deck names cut to 40
printable characters).

Evaluation is one pass, O(1) per guide, with no recursion: a reference resolves at compile time to an earlier
slot, so a cycle (`a = b + 1`, `b = a + 1`) cannot form; its first forward reference reads 0. Every value is a
finite double within ±1e60: NaN and ±Infinity become 0, larger magnitudes are clamped. The bound sits far above
what presets compute (circularArrow multiplies squared lengths, about 1e30 for a 1e8 EMU box), and a product of two
bounded values stays finite. Name maps are `Map`s, so `__proto__` and `constructor` are ordinary names.

Units are the caller's (the converter can evaluate in EMU, a drawer in px). The preset formulas scale with the
box, except where rounding decides a branch: circularArrow tests the sign of a value that is 0 in exact arithmetic
(`q13`, about 1e-9 at a 1000x600 box), so two box sizes of the same shape can take different branches, in POI too.

## Text warps

`textwarp.ts` builds the 40 preset text warps of ECMA-376 (`a:prstTxWarp`; `textwarps.gen.ts`, compiled by
`tools/geom-gen` from `third_party/ooxml-textwarps`) with the same compiler and builder as a shape:
`textWarpGeometry(name, w, h, adj?)` is `buildGeom` of the warp's compiled form, undefined for a name that is not
one of the 40 (a preset shape's name is not a warp). A warp is a pair of paths per text area, a top line and a
bottom line that are straight or curved, or, for four presets, one path the text follows. The file has no text
rectangle (the text takes the whole box) and no connection sites. Nothing draws with it yet: the glyph painter is
part 3's, and a text object still draws straight.

- **The mode is a property of the built geometry, not of the name.** `warpMode(geometry)` is `'path'` for an odd
  path count, `'affine'` when every pair is two straight lines whose direction vectors differ by at most
  `WARP_PARALLEL_EPS` (a millionth) of the larger box side, else `'envelope'`. The M9 warps design lists textPlain
  alone as affine and the slants, Cascade and Fade presets as envelopes; the built geometry says otherwise.
  textPlain, textSlantUp and textSlantDown are two parallel, equal lines at every adjust value (affine);
  textCascadeUp and textCascadeDown are envelopes at their defaults and affine at adj >= 100,000, the four Fade
  presets envelopes at their defaults and affine at adj <= 0, where the two lines become parallel and equal; a box
  with a zero side leaves the curved presets envelopes and textPlain affine. So a table of names to modes is
  wrong; the one fact about a name is `warpFollowsPath(name)`: true for exactly textArchUp, textArchDown, textCircle
  and textButton, the presets with an odd path count (path at every adjust value and box).
- **Areas.** `warpAreas(geometry)` is the path count when it is odd (Button has three areas, Arch Up one) and half of
  it when it is even (Deflate Inflate two, Deflate Inflate Deflate and Button Pour three, the other 33 presets one).
  Which of several areas a line of text goes to is the painter's.
- **Adjust values** are read by name (`warpAdjustNames(name)`: `adj`, or `adj1` and `adj2`); the preset's own `pin`
  guides bound every value, so a hostile deck's value gives finite numbers (`buildGeom` bounds the box and every
  coordinate). No clamp lives here: the document's warp clamp (`../clamp/warp.ts`) is the painter's.
- **Arc tables.** `flattenWarpPath(path, flatness = WARP_FLATNESS_PX)` flattens the first sub-path of a built path
  (no preset has a second) by adaptive subdivision to `{ xy, len, total, tol }`: the points, the cumulative arc length
  at each, the total and the tolerance used. A cubic is flat when 3/4 of the larger distance of its control points
  from its chord is within the flatness (the curve is a convex combination of its control points, so it strays from
  the chord by no more than that); quadratics are raised to cubics and the depth is at most 12. `arcAt(arc, u, out?)`
  is the point u of the way along the length (binary search; u below 0, NaN and -Infinity give the first point, u
  above 1 and Infinity the last; with `out` it allocates nothing).
  `warpArcs(name, w, h, adj?)` builds a warp at a box and flattens every path, memoised; `warpAreaArcs` deals the
  arcs out by area (one each for an odd path count, a pair each for an even one).
- **Bounds.** An arc has at most `WARP_MAX_POINTS` = 4,096 points (a built path holds at most that many). A path that
  would hold more, which only a hostile box does (at 1920 x 1080 the worst, Circle, is 513 points and all 40 warps
  12,049; at 8000 x 8000 at most 1,153 a path), is flattened again at twice the tolerance, at most 30 doublings, then
  with every curve in 16 equal parameter steps, then as its chords; `tol` says which (Infinity for the last two) and a
  path is never cut short. The memo holds at most `WARP_MEMO_MAX` = 256 entries and `WARP_MEMO_POINTS` = 400,000
  points (about 9.6 MB at 24 bytes a point): bounding the entries alone would let a deck of 256 distinct huge boxes
  fill about 150 MB of an asset worker (a 4,096-point arc is 98 kB and a warp has up to six). The least recently
  used entry goes first, a hit makes an entry the newest, and an entry over the whole points bound is returned but not
  kept. The key reads the box as `buildGeom` does and the first four adjust pairs by name and value only (a pair with a
  non-finite value or a name over 16 characters is neither keyed nor passed on), so one meaning has one entry.
- **Purity.** `textwarp.ts` and `textwarps.gen.ts` import only their pure sibling geometry modules and use no DOM,
  process or network, and module state is literals and a `Map` only, so a bundler leaves both out of every bundle
  that never builds a warp (the apps' initial chunks and a phone's first load are unchanged to the byte, and
  `apps/operator/src/pageSets.ts` keeps the table out of the compact path by name).

## Paths: POI's builder, LibreOffice's drawing

`path.ts` builds what POI's `DrawSimpleShape.computeOutlines` builds, checked segment by segment: `path.test.ts`
compares the dozen presets above (33 boxes and adjustments) and 17 arcs (every quadrant, both directions, sweeps
over a full turn, chained arcs, a non-uniform path space) with POI's own Path2D (`poi-paths.json`), within 1e-9 of
the box; when this was written all 187 presets at three boxes matched POI to 2e-15 of the box, apart from the
differences below.

- **Path spaces.** A path with `w`/`h` is built in that space and scaled to the box; its guides are evaluated at a
  box of that size (POI), so `wd2` in a 21600-wide path is 10800. The presets' w/h paths read only constants and
  angles. The text rect and the sites are evaluated at the box.
- **arcTo.** The current point is where the ellipse is at the _visual_ angle stAng; each angle becomes the
  parametric angle with tan t = (wR/hR)·tan θ in θ's quadrant, and the arc is ⌈|sweep|/90°⌉ cubic segments with
  Arc2D's control points (at most 4, 12 points). Unlike POI: a sweep is clamped to ±360° (MSO, LibreOffice
  tdf#122323; the same arc); a multiple of 90° converts exactly (POI rounds tan 90° and splits a quarter turn of an
  ellipse flatter than about 1:4 in two segments, within 1e-4 of the box of ours); two zero radii draw nothing
  (POI computes NaN: roundRect at adj 0, round2DiagRect); one zero radius draws the flat ellipse's segment; a
  negative radius draws nothing (as POI).
- **Commands.** Two moveTos in a row keep the second, a close with nothing open is dropped (Java's Path2D); a
  lnTo, quadBezTo or cubicBezTo with no current point starts a sub-path as Canvas does, an arcTo with none is
  skipped (LibreOffice), where POI throws.
- **Drawing** (`draw.ts`) follows LibreOffice, the fidelity reference: paths in order, each filled then stroked,
  except that the outlines of open paths (a sub-path neither closed nor ending at its start, `geomPathOpen`) are
  stroked after every path, because LibreOffice sorts its line objects behind the rest for every OOXML shape
  (chartX, chartStar and chartPlus list their lines before the filled box; POI fills all, then strokes all); the
  even-odd rule; fill="none" unfilled, stroke="false" unstroked; lighten,
  lightenLess, darken and darkenLess blend the fill per channel towards white or black by 40 % and 20 %, truncated
  (`GetColorData`), strokes unshaded. A gradient or picture fill is a painter called with each path's brightness.
  `draw.browser.test.ts` checks the shades, the even-odd hole, stroke-only paths, open outlines over the fill and
  the clip path with Chromium.

## Stored geometries, paint and line ends (M6 wave 2)

- **Stored geometry** (`stored.ts`, design/27 §3.1 `ShapeGeom`). A known preset is evaluated at the box with the
  stored adjust pairs, so a resized shape keeps its corners; else the paths, each `d` re-tokenised by
  `parsePathData` (`@ordo/domain` `pathdata.ts`: absolute M L Q C Z and plain decimals, ≤ 4,096 points) and
  scaled from its own w x h space to the box (a side of 0: the box's units); else nothing, and the caller draws
  the legacy shape. A path marked `cont` is appended to the one before it, so the pieces of one long path (a
  traced outline holding all its holes, stored in pieces of 4,096 points and 40,000 characters by the
  converter, cut at sub-paths or between two commands) are one built path again: one even-odd fill, holes
  and all, stroked together, in the first piece's fill mode and stroke flag (at most 8 x 4,096 points). Memoised
  per geometry object and box size (up to 8 sizes each).
- **Geometry files** (`stored.ts`, design/27 §3.1 `ShapeGeom.ref`, M6 wave 2 round 2). A large traced outline is
  stored once per library as a geometry file (`GeomFile`: `{ paths }`, JSON named by its SHA-256) and a
  geometry names it by `ref`. A drawer reads the files a slide names (`drawnGeomRefs`) before it draws it, as it
  decodes its pictures: `readGeomFiles(refs, read)` (reads of one ref shared, a failed one asked for again only
  after `GEOM_FILE_RETRY_MS`, a file over `GEOM_FILE_MAX_BYTES` or not a geometry refused) keeps each, clamped
  as inline paths are (`clampGeom`), in an LRU of at most `GEOM_FILES_MAX` files and `GEOM_FILES_CHARS` of path
  text. `storedGeometry` draws a read file's paths, built once per file and box size for every shape that names
  it; until then (or without the file) the geometry beside the ref, else the legacy shape. What is drawn from
  a fallback is not cached under the file's key: a shape's plan is made again once its file is read, its effect
  sprite is not kept, and a masked picture's prepared key tells a pending mask apart (`geomPending`). The
  readers: the output's asset worker (from the service cache or the hub; a file not there yet is reported with
  the missing images, so the link draws the slide again once it is cached), the operator's thumbnail worker and
  editor canvas, and the fidelity harness's page.
- **Union clip** (`draw.ts` `geomFillPath2D`, `traceUnionPath`). The filled paths of a geometry as one Path2D whose
  non-zero fill (`GEOM_CLIP_RULE`) is the union of each path's even-odd region: every closed sub-path is turned
  to wind positively when an even number of the path's other sub-paths contain its first point and negatively
  when an odd number do, so holes stay holes while overlapping paths (smileyFace's eyes over its face) add up
  instead of cancelling. Exact for sub-paths that cross neither themselves nor each other (every preset). A
  sub-path's first point is tested only against the sub-paths whose bounding boxes hold it; past
  `UNION_NESTING_LIMIT` (2,048) sub-paths in one path, or `UNION_NESTING_WORK` (4M) polygon edges tested,
  nesting is not worked out (every sub-path an outline). Made once per built geometry. The nesting is
  `nesting.ts`, pure: its `evenOddArea` (each sub-path's area added or taken away by the parity of its depth,
  unknown past the same bounds) is how the converter rates a custom geometry's legacy shape (`pptx-scene`
  `geom.ts` `inkOf`, design/27 §3.2: a line below half its box or unknown, so line art is never a box).
- **Strokes.** `GeomStroke` may carry a dash pattern (box units) and line ends: open paths are stroked cut back
  for their markers, which are filled in the stroke's paint without the dashes. Sizes, shapes and placement
  follow LibreOffice (oox `lclPushMarkerProperties`, drawinglayer `PolygonStrokeArrowPrimitive2D`; design/27
  §15 M6 "As built").
- **Paint** (`paint.ts`). A fill painter may return a `GeomSpacePaint`: a style defined in its own space and the
  affine to box space, so an elliptical radial gradient is a circle in a squeezed space; the path is mapped into
  that space for the fill (`Path2D.addPath`).

## Preset golden

`pnpm --filter @ordo/geom-gen golden` (`tools/geom-gen/README.md`) draws all 187 presets at their default adjust
values with LibreOffice (a probe deck through soffice) and with `drawGeom` in Chromium, and scores each box with the
fidelity harness's SSIM against the committed baseline: 186 at ≥ 0.95 (mean 0.9959). The one listed exception,
funnel (0.928), is LibreOffice's: its preset table reads the guide name `2da` as the number 2.

Bounds: at most 8 paths and 4,096 points per path after arcs become segments (the compiler counts an arcTo as 12),
checked again by the builder for a `CompiledGeom` from elsewhere (an operand slot out of range reads 0, an unknown
command ends its path). Every coordinate is finite within ±1e9 (`COORD_LIMIT`), the box is clamped to 0..1e9, and
nothing recurses; a geometry at the bounds builds in milliseconds.
