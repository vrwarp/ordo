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
