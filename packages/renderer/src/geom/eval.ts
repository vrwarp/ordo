import {
  asciiTrim,
  builtinSlot,
  compileGeom,
  finiteValue,
  type GeomNotes,
  type GuidePairs,
  newGeomNotes,
  numberToken,
} from './compile.ts';
import {
  BUILTIN_COUNT,
  type CompiledGeom,
  GEOM_LIMITS,
  GUIDE_STRIDE,
  OP_ABS,
  OP_ADDDIV,
  OP_ADDSUB,
  OP_AT2,
  OP_CAT2,
  OP_COS,
  OP_IFELSE,
  OP_MAX,
  OP_MIN,
  OP_MOD,
  OP_MULDIV,
  OP_PIN,
  OP_SAT2,
  OP_SIN,
  OP_SQRT,
  OP_TAN,
  OP_VAL,
  slotCount,
} from './ops.ts';

/*
 * The guide evaluator (design/27 §1 geom/, §15 M6): a CompiledGeom (ops.ts) at a box → the value of every
 * slot. Semantics are Apache POI 5.2.5's (`GuideIf.evaluateGuide`, `BuiltInGuide`, `Context`):
 * - `*\/` and `+/` give 0 when they would divide by zero; nothing else is special-cased.
 * - Angles are 60000ths of a degree, clockwise: `at2 x y` = atan2(y, x) in those units; `sin x y`, `cos x y`
 *   and `tan x y` take y in them; `cat2 x y z` = x·cos(atan2(z, y)) and `sat2 x y z` = x·sin(atan2(z, y)).
 *   Degrees and radians convert as Java's `Math.toDegrees` / `toRadians` do, so values match POI's.
 * - `?: x y z` is y only when x > 0.
 * - Adjust values (avLst) come first; a shape's `adj` pair replaces the formula of the adjust value it names
 *   (the first pair of that name, as POI's `getAdjustValue`). Pairs naming no adjust value are ignored.
 * - The built-ins: w, h; l and t (the box origin), r = l + w, b = t + h, hc and vc its centre; ss = min(w, h),
 *   ls = max(w, h); hd*, wd*, ssd* the fractions; cd2 = 180°, cd3 = 120°, cd4 = 90°, cd8 = 45°, 3cd4, 3cd8,
 *   5cd8, 7cd8.
 * Bounded: one pass over at most GEOM_LIMITS.guides guides, each O(1); every value is finite and within
 * ±GEOM_LIMITS.value (NaN, from `sqrt` of a negative say, is 0). A slot index the guide may not read (its own
 * or a later one, or out of range: never produced by the compiler) reads 0.
 */

/** The box the guides are evaluated at, in the caller's units (the converter's EMU, the drawer's px). */
export interface GuideBox {
  readonly w: number;
  readonly h: number;
  /** The box origin (l and t); default 0. */
  readonly l?: number;
  readonly t?: number;
}

/** A shape's adjust values: [name, value] pairs (ShapeGeom.adj). */
export type AdjustPairs = readonly (readonly [string, number])[];

/** Pairs read for overrides; ShapeGeom.adj keeps 10. */
const ADJ_MAX = 64;
/** 60000ths of a degree per degree (POI `Formula.OOXML_DEGREE`). */
const OOXML_DEGREE = 60000;
/** Java's `Math.toRadians` and `Math.toDegrees` factors. */
const DEG_TO_RAD = 0.017453292519943295;
const RAD_TO_DEG = 57.29577951308232;

/** Writes the built-in guides of a box into slots 0..BUILTIN_COUNT-1 (BUILTIN_GUIDES order). */
export function writeBuiltins(out: Float64Array, box: GuideBox): void {
  const lim = GEOM_LIMITS.value;
  const w = Math.min(Math.max(finiteValue(box.w), 0), lim);
  const h = Math.min(Math.max(finiteValue(box.h), 0), lim);
  const l = finiteValue(box.l ?? 0);
  const t = finiteValue(box.t ?? 0);
  const ss = Math.min(w, h);
  const deg = OOXML_DEGREE;
  out[0] = w;
  out[1] = h;
  out[2] = l;
  out[3] = t;
  out[4] = finiteValue(l + w);
  out[5] = finiteValue(t + h);
  out[6] = finiteValue(l + w / 2);
  out[7] = finiteValue(t + h / 2);
  out[8] = ss;
  out[9] = Math.max(w, h);
  out[10] = h / 2;
  out[11] = h / 3;
  out[12] = h / 4;
  out[13] = h / 5;
  out[14] = h / 6;
  out[15] = h / 8;
  out[16] = h / 10;
  out[17] = w / 2;
  out[18] = w / 3;
  out[19] = w / 4;
  out[20] = w / 5;
  out[21] = w / 6;
  out[22] = w / 8;
  out[23] = w / 10;
  out[24] = w / 12;
  out[25] = w / 32;
  out[26] = ss / 2;
  out[27] = ss / 4;
  out[28] = ss / 6;
  out[29] = ss / 8;
  out[30] = ss / 16;
  out[31] = ss / 32;
  out[32] = 180 * deg;
  out[33] = 120 * deg;
  out[34] = 90 * deg;
  out[35] = 45 * deg;
  out[36] = 270 * deg;
  out[37] = 135 * deg;
  out[38] = 225 * deg;
  out[39] = 315 * deg;
}

/** One formula, POI's `GuideIf.evaluateGuide` (unclamped: the caller clamps). */
export function applyOp(op: number, x: number, y: number, z: number): number {
  switch (op) {
    case OP_MULDIV:
      return z === 0 ? 0 : (x * y) / z;
    case OP_ADDSUB:
      return x + y - z;
    case OP_ADDDIV:
      return z === 0 ? 0 : (x + y) / z;
    case OP_IFELSE:
      return x > 0 ? y : z;
    case OP_ABS:
      return Math.abs(x);
    case OP_AT2:
      return Math.atan2(y, x) * RAD_TO_DEG * OOXML_DEGREE;
    case OP_CAT2:
      return x * Math.cos(Math.atan2(z, y));
    case OP_COS:
      return x * Math.cos((y / OOXML_DEGREE) * DEG_TO_RAD);
    case OP_MAX:
      return Math.max(x, y);
    case OP_MIN:
      return Math.min(x, y);
    case OP_MOD:
      return Math.sqrt(x * x + y * y + z * z);
    case OP_PIN:
      return Math.max(x, Math.min(y, z));
    case OP_SAT2:
      return x * Math.sin(Math.atan2(z, y));
    case OP_SIN:
      return x * Math.sin((y / OOXML_DEGREE) * DEG_TO_RAD);
    case OP_SQRT:
      return Math.sqrt(x);
    case OP_TAN:
      return x * Math.tan((y / OOXML_DEGREE) * DEG_TO_RAD);
    case OP_VAL:
      return x;
    default:
      return 0;
  }
}

/** The value of the first pair named `name`, or undefined. */
function adjustOverride(adj: AdjustPairs | undefined, name: string): number | undefined {
  if (adj === undefined || name === '') return undefined;
  const n = Math.min(adj.length, ADJ_MAX);
  for (let i = 0; i < n; i++) {
    const pair = adj[i]!;
    if (pair[0] === name) return typeof pair[1] === 'number' ? finiteValue(pair[1]) : undefined;
  }
  return undefined;
}

/**
 * Evaluates a geometry at a box: returns every slot's value (built-ins, constants, then the adjust values and
 * guides in order). `out` is reused when it has room.
 */
export function evalGuides(
  geom: CompiledGeom,
  box: GuideBox,
  adj?: AdjustPairs,
  out?: Float64Array,
): Float64Array {
  const size = slotCount(geom);
  const vals = out !== undefined && out.length >= size ? out : new Float64Array(size);
  writeBuiltins(vals, box);
  const k = geom.k;
  for (let i = 0; i < k.length; i++) vals[BUILTIN_COUNT + i] = finiteValue(k[i]!);
  const base = BUILTIN_COUNT + k.length;
  const g = geom.g;
  const guides = Math.min(Math.floor(g.length / GUIDE_STRIDE), GEOM_LIMITS.guides);
  const adjusts = geom.a.length;
  for (let i = 0; i < guides; i++) {
    const self = base + i;
    if (i < adjusts) {
      const v = adjustOverride(adj, geom.a[i]!);
      if (v !== undefined) {
        vals[self] = v;
        continue;
      }
    }
    const at = i * GUIDE_STRIDE;
    const xs = g[at + 1]!;
    const ys = g[at + 2]!;
    const zs = g[at + 3]!;
    const x = xs >= 0 && xs < self ? vals[xs]! : 0;
    const y = ys >= 0 && ys < self ? vals[ys]! : 0;
    const z = zs >= 0 && zs < self ? vals[zs]! : 0;
    vals[self] = finiteValue(applyOp(g[at]!, x, y, z));
  }
  for (let i = base + guides; i < size; i++) vals[i] = 0;
  return vals;
}

/**
 * The slot a name refers to after every guide is evaluated (what a path, the text rect or a handle reads): the
 * last guide or adjust value of that name, else the built-in, else −1.
 */
export function guideSlot(geom: CompiledGeom, name: string): number {
  const base = BUILTIN_COUNT + geom.k.length;
  const n = geom.n.lastIndexOf(name);
  if (n >= 0 && name !== '') return base + geom.a.length + n;
  const a = geom.a.lastIndexOf(name);
  if (a >= 0 && name !== '') return base + a;
  return builtinSlot(name);
}

/** The value of a guide, adjust value or built-in by name (0 when the name is unknown). */
export function guideValue(geom: CompiledGeom, vals: Float64Array, name: string): number {
  const s = guideSlot(geom, name);
  return s >= 0 && s < vals.length ? vals[s]! : 0;
}

/** Every named guide and adjust value with its value (later definitions of a name win), for tests and tools. */
export function guideValues(geom: CompiledGeom, vals: Float64Array): Map<string, number> {
  const out = new Map<string, number>();
  const base = BUILTIN_COUNT + geom.k.length;
  geom.a.forEach((name, i) => {
    if (name !== '') out.set(name, vals[base + i] ?? 0);
  });
  geom.n.forEach((name, i) => {
    if (name !== '') out.set(name, vals[base + geom.a.length + i] ?? 0);
  });
  return out;
}

/** Values of evaluated guide lists, read the way a custGeom path or rect reads its operands. */
export interface GuideScope {
  /** The compiled lists (no paths). */
  readonly geom: CompiledGeom;
  /** Every slot's value. */
  readonly vals: Float64Array;
  /** What compiling replaced by 0 or dropped. */
  readonly notes: GeomNotes;
  /** An operand: a plain decimal number, else the latest guide or adjust value of that name, else a built-in, else 0. */
  value(token: string): number;
}

/**
 * Evaluates a custGeom's guide lists given as strings (a:avLst and a:gdLst [name, fmla] pairs) at a box, for
 * the converter. The lists are compiled with `compileGeom`, so the bounds and name rules are the presets'.
 */
export function evalGuideLists(
  lists: { readonly av?: GuidePairs; readonly gd?: GuidePairs },
  box: GuideBox,
): GuideScope {
  const notes = newGeomNotes();
  const geom = compileGeom({ av: lists.av ?? [], gd: lists.gd ?? [] }, notes);
  const vals = evalGuides(geom, box);
  return {
    geom,
    vals,
    notes,
    value(token: string): number {
      const t = asciiTrim(token);
      const n = numberToken(t);
      if (n !== undefined) return n;
      return guideValue(geom, vals, t);
    },
  };
}
