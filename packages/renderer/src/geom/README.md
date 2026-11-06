# DrawingML shape geometry

The preset and custom geometry engine of design/27 §1 (`geom/`), §3.1 (`ShapeGeom`) and §15 M6: what a
PowerPoint `a:prstGeom` or `a:custGeom` means, as numbers. Read design/27 §3.1, §12 (bounds) and §14 item 6 first.

Status: **M6 wave 1, self-contained.** The preset table, the compiler and the guide evaluator are built and
tested; nothing outside this folder uses them yet. The next wave adds `arc.ts` and `path.ts` (arcTo with POI's
visual-angle rule, the path builder, fill modes) and wires geometry into `ShapeObject` drawing, the schema, the
converter and the editor.

| File              | Contents                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops.ts`          | The compiled form (`CompiledGeom`, `CompiledPath`): the 17 operators and their op codes, the 40 built-in guides in slot order, path commands, fill modes, handle encoding and `GEOM_LIMITS`.        |
| `compile.ts`      | `compileGeom(GeomSource)`: geometry given as strings (a preset read by `tools/geom-gen`, a custGeom read by the converter) → `CompiledGeom`, with `GeomNotes` for what it replaced by 0 or dropped. |
| `eval.ts`         | `evalGuides(geom, box, adj)`: every slot's value at a box; `guideSlot`/`guideValue`/`guideValues` by name; `evalGuideLists` for a custGeom's avLst/gdLst given as `[name, fmla]` pairs.             |
| `presets.gen.ts`  | Generated (`pnpm --filter @ordo/geom-gen gen`, never edited): the 187 presets of `third_party/poi-presets` as `PRESET_GEOMS`, with the two fixes of its README.                                     |
| `poi-guides.json` | Reference values from POI 5.2.5 itself for the dozen presets of the spot checks (`tools/geom-gen/poi/GuideDump.java`).                                                                              |
| `index.ts`        | The public surface (`@ordo/renderer/geom/index.ts`; not yet re-exported by `@ordo/renderer`).                                                                                                       |

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
