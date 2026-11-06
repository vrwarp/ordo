/*
 * DrawingML shape geometry: the shared vocabulary of the compiled form (design/27 §1 geom/, §3.1 ShapeGeom).
 *
 * A geometry (a preset from `presets.gen.ts`, or a deck's custGeom compiled by `compile.ts`) is a small
 * program over numbered value slots:
 *
 *   slot 0 .. BUILTIN_COUNT-1            the built-in guides (w, h, l, t, ... in BUILTIN_GUIDES order)
 *   then one slot per constant           k[i]
 *   then one slot per guide              the adjust values (avLst) first, then gdLst, in document order
 *
 * Every operand anywhere (a formula argument, a path point, the text rect, a handle bound, a connection
 * site) is a slot index, so the evaluator (`eval.ts`) never looks a name up and paths read plain numbers.
 * A guide reads only slots below its own (references resolve to earlier definitions, as POI and LibreOffice
 * read a guide list in order), so there is no recursion and no cycle.
 *
 * The order of every table here is part of the compiled form: `presets.gen.ts` stores these indices, and its
 * test fails when the generator's output and the committed file differ.
 */

/**
 * The 17 guide formula operators of ECMA-376-1 §20.1.9.11, in op-code order. Angles are in 60000ths of a
 * degree, clockwise (y grows down).
 *
 * | op | formula | value |
 * |---|---|---|
 * | 0 | `*\/ x y z` | x·y/z (0 when z = 0) |
 * | 1 | `+- x y z` | x + y − z |
 * | 2 | `+/ x y z` | (x + y)/z (0 when z = 0) |
 * | 3 | `?: x y z` | y when x > 0, else z |
 * | 4 | `abs x` | \|x\| |
 * | 5 | `at2 x y` | atan2(y, x), in 60000ths of a degree |
 * | 6 | `cat2 x y z` | x·cos(atan2(z, y)) |
 * | 7 | `cos x y` | x·cos(y) |
 * | 8 | `max x y` | max(x, y) |
 * | 9 | `min x y` | min(x, y) |
 * | 10 | `mod x y z` | √(x² + y² + z²) |
 * | 11 | `pin x y z` | max(x, min(y, z)) |
 * | 12 | `sat2 x y z` | x·sin(atan2(z, y)) |
 * | 13 | `sin x y` | x·sin(y) |
 * | 14 | `sqrt x` | √x |
 * | 15 | `tan x y` | x·tan(y) |
 * | 16 | `val x` | x |
 */
export const GUIDE_OPS = [
  '*/',
  '+-',
  '+/',
  '?:',
  'abs',
  'at2',
  'cat2',
  'cos',
  'max',
  'min',
  'mod',
  'pin',
  'sat2',
  'sin',
  'sqrt',
  'tan',
  'val',
] as const;
export type GuideOp = (typeof GUIDE_OPS)[number];

/** Operands each op reads (POI reads x, y and z by position; a missing one is 0, extra ones are ignored). */
export const GUIDE_OP_ARITY: readonly number[] = [3, 3, 3, 3, 1, 2, 3, 2, 2, 2, 3, 3, 3, 2, 1, 2, 1];

export const OP_MULDIV = 0;
export const OP_ADDSUB = 1;
export const OP_ADDDIV = 2;
export const OP_IFELSE = 3;
export const OP_ABS = 4;
export const OP_AT2 = 5;
export const OP_CAT2 = 6;
export const OP_COS = 7;
export const OP_MAX = 8;
export const OP_MIN = 9;
export const OP_MOD = 10;
export const OP_PIN = 11;
export const OP_SAT2 = 12;
export const OP_SIN = 13;
export const OP_SQRT = 14;
export const OP_TAN = 15;
export const OP_VAL = 16;

/**
 * Built-in guides, in slot order: the box (POI `BuiltInGuide`: l and t are the box origin, r and b its far
 * edges, hc and vc its centre, ss and ls its short and long sides), its fractions, and the circle fractions in
 * 60000ths of a degree. ECMA-376 lists every name here except four that the presets use all the same
 * (LibreOffice knows them, POI 5.2.5 knows wd32 only): wd12 (rtTriangle), wd32 (the ribbons), hd10
 * (flowChartManualInput, flowChartPunchedTape) and cd3 (curvedLeftArrow).
 */
export const BUILTIN_GUIDES = [
  'w',
  'h',
  'l',
  't',
  'r',
  'b',
  'hc',
  'vc',
  'ss',
  'ls',
  'hd2',
  'hd3',
  'hd4',
  'hd5',
  'hd6',
  'hd8',
  'hd10',
  'wd2',
  'wd3',
  'wd4',
  'wd5',
  'wd6',
  'wd8',
  'wd10',
  'wd12',
  'wd32',
  'ssd2',
  'ssd4',
  'ssd6',
  'ssd8',
  'ssd16',
  'ssd32',
  'cd2',
  'cd3',
  'cd4',
  'cd8',
  '3cd4',
  '3cd8',
  '5cd8',
  '7cd8',
] as const;
export type BuiltinGuide = (typeof BUILTIN_GUIDES)[number];
export const BUILTIN_COUNT = BUILTIN_GUIDES.length;

/** Slots of the box edges, the default text rectangle. */
export const SLOT_L = 2;
export const SLOT_T = 3;
export const SLOT_R = 4;
export const SLOT_B = 5;

/**
 * Path commands, in op-code order, with the operand slots each takes:
 * moveTo x y; lnTo x y; arcTo wR hR stAng swAng (from the current point, POI's visual-angle rule, `arc.ts`);
 * quadBezTo x1 y1 x2 y2; cubicBezTo x1 y1 x2 y2 x3 y3; close.
 */
export const PATH_OPS = ['moveTo', 'lnTo', 'arcTo', 'quadBezTo', 'cubicBezTo', 'close'] as const;
export type PathOp = (typeof PATH_OPS)[number];
export const PATH_OP_ARITY: readonly number[] = [2, 2, 4, 4, 6, 0];
export const CMD_MOVE = 0;
export const CMD_LINE = 1;
export const CMD_ARC = 2;
export const CMD_QUAD = 3;
export const CMD_CUBIC = 4;
export const CMD_CLOSE = 5;

/**
 * Path fill modes, in code order. Code 0 (`norm`) is the default. The four shaded modes blend the shape's
 * fill as LibreOffice does: lighten +40 %, lightenLess +20 %, darken −40 %, darkenLess −20 %.
 */
export const PATH_FILLS = ['norm', 'none', 'lighten', 'lightenLess', 'darken', 'darkenLess'] as const;
export type PathFill = (typeof PATH_FILLS)[number];

/** Adjust handle kinds (the first of a handle's nine numbers). */
export const HANDLE_XY = 0;
export const HANDLE_POLAR = 1;
/** Numbers per handle in `CompiledGeom.h`. */
export const HANDLE_STRIDE = 9;
/** Numbers per guide in `CompiledGeom.g`. */
export const GUIDE_STRIDE = 4;
/** Numbers per connection site in `CompiledGeom.c`. */
export const SITE_STRIDE = 3;

/**
 * Bounds of one geometry (design/27 §12: the deck is untrusted). The compiler drops what is over them, so
 * the evaluator and the path builder never see more.
 */
export const GEOM_LIMITS = {
  /** Adjust values and guides together (the largest preset, gear9, has 244). */
  guides: 256,
  /** Paths (ShapeGeom.paths keeps at most 8; the most a preset has is 6, bevel). */
  paths: 8,
  /**
   * Points per path: moveTo, lnTo and close count 1, quadBezTo 2, cubicBezTo 3, and arcTo 12, the four cubic
   * segments a full turn becomes.
   */
  points: 4096,
  /** Adjust handles (uturnArrow has 5). */
  handles: 32,
  /** Connection sites (squareTabs has 16). */
  sites: 64,
  /** Longest guide name kept; a longer one names nothing (no reference can resolve to it). */
  name: 256,
  /** Longest formula read; a longer one is the value 0. */
  formula: 1024,
  /**
   * Largest magnitude of any slot value. Values are finite doubles: NaN and ±Infinity become 0 (design/27
   * §12), everything else is clamped to ±value. The bound sits far above what presets compute (circularArrow
   * multiplies squared lengths, q5 = rO²·dO², about 1e30 for a 1e8 EMU box), and a product of two bounded
   * values (1e120) is still finite, so no operator can overflow.
   */
  value: 1e60,
  /** Largest path coordinate space (ShapeGeom.paths w and h). */
  pathSpace: 1e9,
} as const;

/** One compiled path of a geometry. */
export interface CompiledPath {
  /** The path's own coordinate space, scaled to the box; absent or 0 means the box itself. */
  readonly w?: number;
  readonly h?: number;
  /** Fill mode, an index into PATH_FILLS; absent = 0 (`norm`). */
  readonly f?: number;
  /** 0 = not stroked; absent = stroked. */
  readonly s?: 0;
  /** 0 = extrusion not allowed; absent = allowed (only kept for completeness: ordo draws no 3D). */
  readonly e?: 0;
  /** Commands: a PATH_OPS code followed by its PATH_OP_ARITY operand slots, repeated. */
  readonly c: readonly number[];
}

/**
 * A compiled geometry: the form `presets.gen.ts` stores per preset and `compileGeom` makes from a custGeom.
 * Short keys keep the generated table small.
 */
export interface CompiledGeom {
  /** Constants: slot BUILTIN_COUNT + i holds k[i]. */
  readonly k: readonly number[];
  /**
   * Adjust value names (avLst order). Guide i < a.length is adjust value a[i]: a shape's `adj` pair of that
   * name replaces its formula.
   */
  readonly a: readonly string[];
  /**
   * The guide program, GUIDE_STRIDE numbers per guide: a GUIDE_OPS code and three operand slots (those past
   * the op's arity are 0 and unread). Guide i fills slot BUILTIN_COUNT + k.length + i.
   */
  readonly g: readonly number[];
  /** gdLst names in order (guide a.length + i is named n[i]); '' for a name over GEOM_LIMITS.name. */
  readonly n: readonly string[];
  /** Text rectangle slots: l, t, r, b. */
  readonly r: readonly number[];
  /** Paths, in drawing order. */
  readonly p: readonly CompiledPath[];
  /**
   * Adjust handles, HANDLE_STRIDE numbers each: kind, then ref1 min1 max1 ref2 min2 max2, then the pos x and
   * y slots. HANDLE_XY: ref1 = gdRefX, ref2 = gdRefY. HANDLE_POLAR: ref1 = gdRefR, ref2 = gdRefAng. A ref is
   * an index into `a` (−1 when absent or not an adjust value); a bound is a slot (−1 when absent).
   */
  readonly h?: readonly number[];
  /** Connection sites, SITE_STRIDE slots each: angle, x, y. */
  readonly c?: readonly number[];
}

/** Slots a geometry evaluates into. */
export function slotCount(geom: CompiledGeom): number {
  return BUILTIN_COUNT + geom.k.length + Math.floor(geom.g.length / GUIDE_STRIDE);
}

/** The slot of guide `i` (adjust values first, then gdLst). */
export function guideSlotOf(geom: CompiledGeom, i: number): number {
  return BUILTIN_COUNT + geom.k.length + i;
}
