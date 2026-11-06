# geom-gen

Compiles the vendored DrawingML preset geometries (`third_party/poi-presets/presetShapeDefinitions.xml`, Apache
POI 5.2.5) into `packages/renderer/src/geom/presets.gen.ts` (design/27 §1, §15 M6).

```
pnpm --filter @ordo/geom-gen gen           # writes presets.gen.ts
pnpm --filter @ordo/geom-gen gen --check   # exits 1 when the committed file is not the generator's output
```

`src/gen.test.ts` (in `pnpm test`) fails when the committed file differs from the generator's output, so a change
to the XML, the fixes, the compiler or the compiled form needs a `gen` run in the same change.

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

Needs LibreOffice (24.2.7 made the baseline), poppler's `pdftoppm`, ffmpeg and Chromium (Playwright's,
`ORDO_CHROMIUM`, or `/usr/bin/google-chrome`); a missing tool skips the run, or fails it under `--strict` or
`CI`. A run takes about 30 s.

Results (LibreOffice 24.2.7.2, Chromium 1243): 186 of 187 presets at SSIM ≥ 0.95, mean 0.9959. When the baseline
was made, a pixel comparison allowing a 1 px shift found no other geometry difference; the rest of the gap is anti-aliasing and poppler's
stroke adjustment, which snaps axis-aligned outlines to whole pixels (rect 0.988, the action buttons and
flowchart boxes 0.968-0.99).

- **funnel** (0.928, listed): LibreOffice's own preset table reads the guide name `2da` as the number 2, so its
  rim arc ends above the rim's widest point; drawn with that misreading, the funnel scores 0.9987.

The golden found one drawing difference, fixed in `draw.ts`: LibreOffice strokes the open paths (chartX,
chartStar and chartPlus's lines, which come before their filled box) after every other path.
