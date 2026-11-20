# geom-gen

Compiles the vendored DrawingML geometries into `packages/renderer/src/geom/`: the 187 presets
(`third_party/poi-presets/presetShapeDefinitions.xml`, Apache POI 5.2.5) into `presets.gen.ts` (design/27 §1, §15
M6), and the 40 WordArt text warps (`third_party/ooxml-textwarps/presetTextWarpDefinitions.xml`, docx4j-core
11.4.11) into `textwarps.gen.ts`.

```
pnpm --filter @ordo/geom-gen gen           # writes presets.gen.ts and textwarps.gen.ts
pnpm --filter @ordo/geom-gen gen --check   # exits 1 when either committed file is not the generator's output
```

`src/gen.test.ts` (in `pnpm test`) fails when a committed file differs from the generator's output, so a change
to an XML file, the fixes, the compiler or the compiled form needs a `gen` run in the same change.

## What it does

1. Reads every preset into strings, as written (`src/xml.ts` is a small reader for this one trusted file). Any
   element or attribute the compiler would not read fails the run, so a changed upstream file cannot lose geometry
   silently.
2. Applies the two fixes of `third_party/poi-presets/README.md` (`FIXES`), each after checking the original text.
3. Compiles each preset with the renderer's own `compileGeom` (`packages/renderer/src/geom/compile.ts`, imported
   by path), the same compiler the converter uses for a deck's custGeom, and requires that it notes nothing:
   every name resolves to an earlier definition or a built-in, every operator is known, nothing is over a bound.
4. Prints one line per preset, sorted by name, with numbers in JavaScript's shortest form. The same input always
   gives the same bytes.

The output (about 127 KB, 32 KB gzipped) is a `Map` from preset name to `CompiledGeom` (`geom/ops.ts`): constants
`k`, adjust value names `a`, the guide program `g` (an op code and three operand slots per guide), guide names `n`,
the text rectangle `r`, paths `p` (command codes and operand slots, the path's own `w`/`h`, fill mode, stroke),
adjust handles `h` and connection sites `c`. Every operand is a slot index: built-ins first, then the constants,
then the guides, so the evaluator and the path builder never look a name up.

## Text warps

The second input (`third_party/ooxml-textwarps/`, with its provenance and licence) goes through the same reader,
the same compiler and the same printer as the first; only what differs is written down here:

- the root element is `presetTextWarpDefinitions` (POI's file spells its root `presetShapeDefinitons`:
  `readPresets(xml, rootName)`; each generator refuses the other file with 'unexpected root');
- there are no fixes: the file is compiled as it is, and the output header says so;
- the file has no text rectangle (`r` is the whole box: slots 2..5), no connection sites and one or two adjust
  values per preset (`adj`, or `adj1` and `adj2`);
- the table is `TEXT_WARP_GEOMS` (40 presets; about 17 kB, 4 kB gzipped), which only `geom/textwarp.ts` imports,
  so a bundle that never builds a warp does not carry it (`apps/operator/src/pageSets.ts` also keeps it off a
  phone's first load).

`src/gen.test.ts` pins the vendored bytes (SHA-256), the committed output, the 40 names of the domain's
`TEXT_WARPS`, the path counts the geometry builder reads and the refusals.

## POI reference values

`poi/GuideDump.java` prints the guide values POI 5.2.5 itself computes; it produced
`packages/renderer/src/geom/poi-guides.json`, the reference of the evaluator's POI spot checks. `poi/PathDump.java`
prints the paths POI builds (java.awt.geom segments in box coordinates, the text rect and the connection sites) for
a preset at a box or for a moveTo followed by arcTo commands; it produced `packages/renderer/src/geom/poi-paths.json`,
the reference of the path builder's POI checks (the case lines are the `case` fields there). Neither is part of
any build. To run them (Java 11 or later, POI and log4j-api jars from Maven Central):

```
javac -cp poi-5.2.5.jar:log4j-api-2.21.1.jar -d /tmp/poidump tools/geom-gen/poi/GuideDump.java tools/geom-gen/poi/PathDump.java
echo 'star5 0 0 1828800 914400 adj=25000' | java -cp /tmp/poidump:poi-5.2.5.jar:log4j-api-2.21.1.jar \
  org.apache.poi.sl.draw.geom.GuideDump
printf 'preset can 300 200 adj=10000\narc 1000 1000 -1 -1 500 500 300 150 2700000 5400000\n' | \
  java -cp /tmp/poidump:poi-5.2.5.jar:log4j-api-2.21.1.jar org.apache.poi.sl.draw.geom.PathDump
```

When the evaluator was written, all 187 presets at three boxes (11,730 guide values) agreed with POI to within
3e-15 relative.

## Preset golden (design/27 §14 item 6)

```
pnpm --filter @ordo/geom-gen golden                 # compare with src/golden/baseline.json; exit 1 on a failure
pnpm --filter @ordo/geom-gen golden --update        # rewrite the baseline from this run
pnpm --filter @ordo/geom-gen golden --out DIR       # keep the deck, both drawings, report.json and compare/*.png
```

Every preset at its default adjust values, drawn by LibreOffice and by `drawGeom`, scored box by box:

1. `src/golden/probe.ts` writes the probe deck as XML (no generator library, so every byte of a shape is the
   probe's): six presets to a 16:9 slide, 32 slides, each preset in a 360x240 px box (3:2, so a formula that
   mixes up w, h, ss and ls shows) inside a 640x540 cell that holds the callouts' leader lines, each with its own
   solid fill and a 3 px dark outline with round joins and flat caps, stated explicitly. `probe.test.ts` reads
   the deck back with `@ordo/pptx-scene` and checks every preset's name, box, fill and outline.
2. LibreOffice draws it as the fidelity harness draws decks: `soffice --convert-to pdf`, then `pdftoppm -r 144`
   (1920x1080 px pages; slide px are EMU / 6350).
3. `src/golden/page.ts`, bundled with esbuild and run in headless Chromium (as `packages/renderer/golden/run.ts`
   runs its page), draws the same boxes with `presetGeometry` and `drawGeom` on a white OffscreenCanvas.
4. Each preset is scored with the harness's SSIM (`tools/pptx-fidelity/src/ssim.ts`: greyscale, at the scale a
   whole slide is scored at, 960 px wide) over its region: the box and whatever either drawing put in the cell,
   grown by 8 px (`src/golden/score.ts`).
5. The run fails when a preset is under 0.95 and not listed in `src/golden/exceptions.ts` with its reason, or
   falls more than 0.01 below `baseline.json`. `score.test.ts` (in `pnpm test`, no LibreOffice needed) checks
   that the baseline covers every preset and that the exceptions are exactly the presets under the bar.

Needs LibreOffice (24.2.7 made the baseline), poppler's `pdftoppm`, ffmpeg and Chromium (`ORDO_CHROMIUM`,
Playwright's, `ORDO_TEST_CHROMIUM`, or the system's: `tools/find-chromium.ts`); a missing tool skips the run,
or fails it under `--strict` or `CI`. A run takes about 30 s.

Results (LibreOffice 24.2.7.2, Chromium 1243): 186 of 187 presets at SSIM ≥ 0.95, mean 0.9959. When the baseline
was made, a pixel comparison allowing a 1 px shift found no other geometry difference; the rest of the gap is anti-aliasing and poppler's
stroke adjustment, which snaps axis-aligned outlines to whole pixels (rect 0.988, the action buttons and
flowchart boxes 0.968-0.99).

- **funnel** (0.928, listed): LibreOffice's own preset table reads the guide name `2da` as the number 2, so its
  rim arc ends above the rim's widest point; drawn with that misreading, the funnel scores 0.9987.

The golden found one drawing difference, fixed in `draw.ts`: LibreOffice strokes the open paths (chartX,
chartStar and chartPlus's lines, which come before their filled box) after every other path.

## Warp probe golden (r2b sub-wave 2, the geometry leg)

```
pnpm --filter @ordo/geom-gen golden:warps                 # compare with src/golden/warp-baseline.json; exit 1 on a failure
pnpm --filter @ordo/geom-gen golden:warps --update        # rewrite the baseline from this run
pnpm --filter @ordo/geom-gen golden:warps --out DIR       # keep the decks, the pages, report.json and geometry.json
```

LibreOffice's text of the 40 WordArt warps against the hulls of ordo's shapes (`geom/textwarp.ts`, compiled from
`third_party/ooxml-textwarps`):

1. `src/golden/warps.ts` writes three decks of ordo's own (no third-party deck), one per box shape: 360 x 240 px in a
   3 x 2 grid of 640 x 540 px cells, a wide 600 x 120 in a 2 x 3 grid of 960 x 360 and a tall 240 x 300 in a 3 x 2 grid.
   Each warp is a text box at its default adjust values holding "WordArt Ag" in Liberation Sans 40 pt (regular, black,
   one line, zero insets, middle-anchored, no autofit, no fill, no outline); the box is centred in its cell with whole
   pixels and the cell leaves at least 90 px beyond it (LibreOffice's ink overshot a box by at most 38 px). 40 warps are
   7 slides a deck. `probe.ts`'s deck writer takes the shape writer as a parameter, its default being the preset golden's
   (that deck's bytes did not change).
2. LibreOffice draws them as the preset golden's deck is drawn (`soffice --convert-to pdf`, `pdftoppm -r 144`, a private
   profile; `src/golden/lo.ts`, moved out of `run.ts` unchanged). The ink of a cell is the bounding box of its pixels
   below grey 250, in px relative to the box, the right and bottom edges exclusive. No browser is needed: ordo's side is
   pure geometry. The hull of a warp is the bounding box of the points of its arcs (`warpArcs` at the same box); its
   first-area hull is that of the first area's arcs (`warpAreaArcs`).
3. `src/golden/warps-score.ts` judges a run (pure, with `warps-score.test.ts`): an unlisted warp whose ink is outside its
   hull by more than 2 px fails; so does textPlain's ink not filling its hull, Button Pour, Deflate Inflate and Deflate
   Inflate Deflate outside their first area's hull, Button's ink not Arch Up's (or Button Pour's Arch Up Pour's) within
   1 px, ink within 8 px of a cell's edge, a baseline that lacks a warp at a box, and a listed warp that the baseline does
   not show outside its hull; an ink edge more than 2 px from the baseline fails for the unlisted warps, only when
   LibreOffice is the baseline's version.

Results (LibreOffice 24.2.7.2, Liberation Sans): 35 of the 40 warps are inside their hull within 2 px at all three boxes.
The five that are not, each listed in `src/golden/warp-exceptions.ts` with its reason, are not a fault of the shapes,
which follow ECMA-376 (what PowerPoint draws): LibreOffice puts the text of **Arch Up, Arch Down, Circle and Button** on
the outside of the curve (Button's one-line text is in its first area, so its ink is Arch Up's to the pixel), and its
text for **Inflate Top** reaches the top of the box where ECMA-376's top path peaks a fifth of the height below it.
Plain Text fills its hull to the pixel at all three boxes.

The ink numbers are committed (`src/golden/warp-baseline.json`) and `src/golden/warps-baseline.test.ts` (in `pnpm test`)
judges them against the live geometry with no LibreOffice, so CI checks the shapes against LibreOffice's text. The
LibreOffice run only refreshes or verifies them; like the preset golden it is not a CI step. Needs LibreOffice (24.2.7
made the baseline), poppler's `pdftoppm` and ffmpeg; a missing tool skips the run, or fails it under `--strict` or `CI`.
A run takes about 15 s. A different LibreOffice or Liberation Sans moves the ink of the four path warps (it sits on the
font's metrics), which is why only the 35 others are drift-checked.
