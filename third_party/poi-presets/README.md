# DrawingML preset geometries (Apache POI 5.2.5)

`presetShapeDefinitions.xml` holds the 187 preset shapes of ECMA-376 Part 1 (Office Open XML DrawingML: `rect`,
`roundRect`, `star5`, `cloud`, ...), each as adjust values, guide formulas, paths, a text rectangle, adjust
handles and connection sites. ordo compiles it with `tools/geom-gen` into
`packages/renderer/src/geom/presets.gen.ts` (design/27 §1, §15 M6).

| File                         | From                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presetShapeDefinitions.xml` | Apache POI 5.2.5, `poi-5.2.5.jar` entry `org/apache/poi/sl/draw/geom/presetShapeDefinitions.xml` (in POI's sources: `poi/src/main/resources/org/apache/poi/sl/draw/geom/`, tag `REL_5_2_5`). Byte for byte, SHA-256 `a7dad593d27bd70536b41da9b761fa16409536cc0c25ef2b6c7a61c5d9b3e738` (`tools/geom-gen` checks it). |
| `LICENSE`, `NOTICE`          | The same jar's `META-INF/LICENSE` and `META-INF/NOTICE`, identical to POI's `legal/LICENSE` and `legal/NOTICE` at `REL_5_2_5`.                                                                                                                                                                                       |

Licence: Apache License 2.0 (`LICENSE`), with POI's `NOTICE`. The definitions themselves come from ECMA-376,
whose schemas and definitions POI's `LICENSE` describes as available to all interested parties without
restriction.

## What ordo changes

The file here is unchanged. `tools/geom-gen` applies two fixes when it compiles it (`FIXES` in
`tools/geom-gen/src/gen.ts`); each checks the exact original text first and fails the generator if it differs,
so an updated upstream file cannot be patched by accident. Both errors are in ECMA-376's own
`presetShapeDefinitions.xml`, which POI's file copies; LibreOffice draws both shapes with the fixed values
(verified).

1. **`pie`, text rectangle.** `<rect l="il" t="ir" r="it" b="ib"/>` becomes `t="it" r="ir"`. The text rectangle
   is the one inscribed in the ellipse at 45°: `il` and `ir` are x positions, `it` and `ib` y positions, so the
   original swaps the top and right edges (on a 2:1 pie its top lies below its bottom and its right edge left of
   its left edge).
2. **`star24` and `star32`, adjust handle.** `<ahXY gdRefY="adj" minY="0" maxY="ssd2">` becomes `maxY="50000"`.
   `adj` is a fraction (the guide `a = pin 0 adj 50000`), bounded at 50000 by every other star (star4 to star16);
   `ssd2` is a length, half the short side, so the original handle range grew with the shape.

The compiled form (op codes, slots, bounds) and what the generator requires of the file are described in
`tools/geom-gen/README.md`.
