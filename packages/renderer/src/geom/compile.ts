import {
  BUILTIN_COUNT,
  BUILTIN_GUIDES,
  CMD_ARC,
  CMD_CUBIC,
  CMD_QUAD,
  type CompiledGeom,
  type CompiledPath,
  GEOM_LIMITS,
  GUIDE_OP_ARITY,
  GUIDE_STRIDE,
  GUIDE_OPS,
  HANDLE_POLAR,
  HANDLE_STRIDE,
  HANDLE_XY,
  OP_VAL,
  PATH_FILLS,
  PATH_OP_ARITY,
  PATH_OPS,
  SLOT_B,
  SLOT_L,
  SLOT_R,
  SLOT_T,
} from './ops.ts';

/*
 * The geometry compiler: DrawingML geometry given as strings (a preset read by tools/geom-gen, or a deck's
 * a:custGeom read by the converter) → a CompiledGeom (ops.ts). The generator and the converter share it, so
 * a preset and a custGeom mean the same thing.
 *
 * Name resolution follows POI's `Context.getValue` (ECMA-376-1 §20.1.9.11), with two deliberate changes:
 * - A token is a number only when it is a plain decimal: an optional sign, digits with an optional point (or
 *   a point and digits), an optional exponent. POI also takes Java's `NaN`, `Infinity`, hex floats and an
 *   `f`/`d` suffix; here those are names, so a deck cannot inject a NaN.
 * - What POI refuses with an exception (an unknown name, a reference to a later guide, an unknown operator)
 *   is the value 0 here, noted in `GeomNotes`, so one bad guide never loses the whole shape.
 * Otherwise: the adjust values (avLst) are evaluated first, then the guides (gdLst), in document order; a
 * formula sees the names defined before it, the latest definition of a name wins, and a defined name shadows
 * a built-in of the same name. Paths, the text rect, handles and connection sites see every name.
 *
 * Bounds (GEOM_LIMITS): at most 256 adjust values and guides, 8 paths, 4,096 points per path, 32 handles and
 * 64 connection sites; names over 256 characters bind nothing; formulas over 1,024 characters are 0. Every
 * constant is finite and within ±GEOM_LIMITS.value. Nothing here recurses, and no guide can read a later one,
 * so a cycle cannot form: `a = b + 1, b = a + 1` reads 0 for the first b.
 */

/** [name, formula] pairs, as in a:gd name="…" fmla="…". */
export type GuidePairs = readonly (readonly [string, string])[];

/** One path command: its element name (moveTo, lnTo, arcTo, quadBezTo, cubicBezTo, close) and operands. */
export interface PathCmdSource {
  readonly op: string;
  /**
   * moveTo and lnTo: x y of its pt; arcTo: wR hR stAng swAng; quadBezTo: x1 y1 x2 y2; cubicBezTo: x1 y1 x2 y2
   * x3 y3; close: none. A missing operand is 0.
   */
  readonly args: readonly string[];
}

/** One a:path, with its attributes as written. */
export interface PathSource {
  readonly w?: string;
  readonly h?: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly extrusionOk?: string;
  readonly cmds: readonly PathCmdSource[];
}

/** An a:ahXY or a:ahPolar, with its attributes as written and its pos. */
export type HandleSource =
  | {
      readonly kind: 'xy';
      readonly gdRefX?: string;
      readonly minX?: string;
      readonly maxX?: string;
      readonly gdRefY?: string;
      readonly minY?: string;
      readonly maxY?: string;
      readonly x: string;
      readonly y: string;
    }
  | {
      readonly kind: 'polar';
      readonly gdRefR?: string;
      readonly minR?: string;
      readonly maxR?: string;
      readonly gdRefAng?: string;
      readonly minAng?: string;
      readonly maxAng?: string;
      readonly x: string;
      readonly y: string;
    };

/** An a:cxn: its angle and pos. */
export interface SiteSource {
  readonly ang: string;
  readonly x: string;
  readonly y: string;
}

/** A geometry as strings: what a:prstGeom's definition or a:custGeom holds. */
export interface GeomSource {
  readonly av?: GuidePairs;
  readonly gd?: GuidePairs;
  /** a:rect; an absent edge is the box edge (and an absent rect the whole box). */
  readonly rect?: { readonly l?: string; readonly t?: string; readonly r?: string; readonly b?: string };
  readonly paths?: readonly PathSource[];
  readonly handles?: readonly HandleSource[];
  readonly sites?: readonly SiteSource[];
}

/** What the compiler replaced or dropped. The generator requires none; the converter logs them. */
export interface GeomNotes {
  /** Distinct messages, at most NOTES_MAX, deck names cut to 40 printable characters. */
  readonly messages: string[];
  /** Total count, including messages past the cap. */
  count: number;
}

const NOTES_MAX = 32;
/** A provisional reference to nothing (an absent handle bound). */
const ABSENT = Number.MIN_SAFE_INTEGER;

export function newGeomNotes(): GeomNotes {
  return { messages: [], count: 0 };
}

/** A deck-derived name, safe for a note: printable ASCII only, at most 40 characters. */
function printable(s: string): string {
  let out = '';
  for (let i = 0; i < s.length && out.length < 40; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x20 && c < 0x7f ? s[i] : '?';
  }
  return s.length > 40 ? `${out}…` : out;
}

function note(notes: GeomNotes | undefined, msg: string): void {
  if (!notes) return;
  notes.count++;
  if (notes.messages.length < NOTES_MAX && !notes.messages.includes(msg)) notes.messages.push(msg);
}

/** A plain decimal: sign, digits, optional point and fraction (or point and digits), optional exponent. */
const NUMBER_TOKEN = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
/** Formula separators: POI's `\s` (ASCII whitespace only). */
const TOKEN = /[^ \t\n\v\f\r]+/g;

/** Whether a UTF-16 unit is ASCII whitespace (space, tab, LF, VT, FF, CR). */
function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}

/**
 * An attribute value or operand without surrounding ASCII whitespace (a deck may write x=" 5"). A scan, not a
 * regular expression: `\s+$` backtracks quadratically over a long run of inner spaces.
 */
export function asciiTrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s.charCodeAt(a))) a++;
  while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** A finite value within ±GEOM_LIMITS.value: NaN and ±Infinity are 0, −0 is 0. */
export function finiteValue(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const lim = GEOM_LIMITS.value;
  if (v > lim) return lim;
  if (v < -lim) return -lim;
  return v === 0 ? 0 : v;
}

/** The number a token spells, or undefined when it is a name (see NUMBER_TOKEN). */
export function numberToken(token: string): number | undefined {
  if (token.length > 64 || !NUMBER_TOKEN.test(token)) return undefined;
  return finiteValue(Number(token));
}

/** The tokens of a formula (at most `max`), split at ASCII whitespace as POI splits them. */
export function formulaTokens(fmla: string, max = 4): string[] {
  const out: string[] = [];
  if (fmla.length > GEOM_LIMITS.formula) return out;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(fmla); m !== null && out.length < max; m = TOKEN.exec(fmla)) out.push(m[0]);
  return out;
}

const BUILTIN_SLOT: ReadonlyMap<string, number> = new Map(BUILTIN_GUIDES.map((name, i) => [name, i]));

/** The slot of a built-in guide, or −1. */
export function builtinSlot(name: string): number {
  return BUILTIN_SLOT.get(name) ?? -1;
}

/** xsd:boolean, else the default. */
function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return dflt;
}

/** A path's coordinate space: a non-negative number within GEOM_LIMITS.pathSpace, else 0 (the box). */
function pathSpace(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = numberToken(asciiTrim(v));
  if (n === undefined || n <= 0) return 0;
  return Math.min(n, GEOM_LIMITS.pathSpace);
}

/** Points a command counts against GEOM_LIMITS.points. */
function pointCost(op: number): number {
  if (op === CMD_ARC) return 12;
  if (op === CMD_CUBIC) return 3;
  if (op === CMD_QUAD) return 2;
  return 1;
}

/**
 * Compiles a geometry. `notes`, when given, collects what was replaced by 0 or dropped (the generator passes
 * one and requires it to stay empty).
 */
export function compileGeom(src: GeomSource, notes?: GeomNotes): CompiledGeom {
  const k: number[] = [];
  const kIndex = new Map<number, number>();
  // Slots are numbered once the constants are known; operands hold provisional references until then: a
  // constant c as −1 − c, a guide i as BUILTIN_COUNT + i, a built-in as its slot, an absent bound as ABSENT.
  const constRef = (v: number): number => {
    const value = finiteValue(v);
    let i = kIndex.get(value);
    if (i === undefined) {
      i = k.length;
      k.push(value);
      kIndex.set(value, i);
    }
    return -1 - i;
  };
  const zero = (): number => constRef(0);

  const bindings = new Map<string, number>();
  const resolve = (token: string | undefined, where: string): number => {
    if (token === undefined) return zero();
    const t = asciiTrim(token);
    const n = numberToken(t);
    if (n !== undefined) return constRef(n);
    const g = bindings.get(t);
    if (g !== undefined) return BUILTIN_COUNT + g;
    const b = BUILTIN_SLOT.get(t);
    if (b !== undefined) return b;
    note(notes, `unknown name '${printable(t)}' in ${where}`);
    return zero();
  };

  const a: string[] = [];
  const n: string[] = [];
  const prog: number[] = [];
  const av = src.av ?? [];
  const gd = src.gd ?? [];
  const total = av.length + gd.length;
  if (total > GEOM_LIMITS.guides) note(notes, `${total - GEOM_LIMITS.guides} guides over the limit dropped`);
  const count = Math.min(total, GEOM_LIMITS.guides);
  for (let i = 0; i < count; i++) {
    const isAdj = i < av.length;
    const pair = isAdj ? av[i]! : gd[i - av.length]!;
    const name = pair[0].length <= GEOM_LIMITS.name ? pair[0] : '';
    if (name === '' && pair[0] !== '') note(notes, 'a guide name over the limit binds nothing');
    const where = `guide '${printable(name)}'`;
    const tokens = formulaTokens(pair[1]);
    const op = tokens.length > 0 ? GUIDE_OPS.indexOf(tokens[0] as (typeof GUIDE_OPS)[number]) : -1;
    if (op < 0) {
      note(
        notes,
        tokens.length > 0
          ? `unknown operator '${printable(tokens[0]!)}' in ${where}`
          : `empty or over-long formula in ${where}`,
      );
      prog.push(OP_VAL, zero(), 0, 0);
    } else {
      const arity = GUIDE_OP_ARITY[op]!;
      prog.push(op);
      for (let j = 1; j < GUIDE_STRIDE; j++) prog.push(j <= arity ? resolve(tokens[j], where) : 0);
    }
    if (isAdj) a.push(name);
    else n.push(name);
    if (name !== '') bindings.set(name, i);
  }

  const r = [
    src.rect?.l === undefined ? SLOT_L : resolve(src.rect.l, 'the text rect'),
    src.rect?.t === undefined ? SLOT_T : resolve(src.rect.t, 'the text rect'),
    src.rect?.r === undefined ? SLOT_R : resolve(src.rect.r, 'the text rect'),
    src.rect?.b === undefined ? SLOT_B : resolve(src.rect.b, 'the text rect'),
  ];

  const pathsIn = src.paths ?? [];
  if (pathsIn.length > GEOM_LIMITS.paths)
    note(notes, `${pathsIn.length - GEOM_LIMITS.paths} paths over the limit dropped`);
  const paths: { w: number; h: number; f: number; s: boolean; e: boolean; c: number[] }[] = [];
  for (const ps of pathsIn.slice(0, GEOM_LIMITS.paths)) {
    const fill = ps.fill === undefined ? 0 : PATH_FILLS.indexOf(ps.fill as (typeof PATH_FILLS)[number]);
    if (fill < 0) note(notes, `unknown path fill '${printable(ps.fill!)}' read as norm`);
    const c: number[] = [];
    let points = 0;
    for (const cmd of ps.cmds) {
      const op = PATH_OPS.indexOf(cmd.op as (typeof PATH_OPS)[number]);
      points += op < 0 ? 1 : pointCost(op);
      if (points > GEOM_LIMITS.points) {
        note(notes, 'path points over the limit dropped');
        break;
      }
      if (op < 0) {
        note(notes, `unknown path command '${printable(cmd.op)}' dropped`);
        continue;
      }
      c.push(op);
      for (let j = 0; j < PATH_OP_ARITY[op]!; j++) c.push(resolve(cmd.args[j], `a ${cmd.op} of a path`));
    }
    paths.push({
      w: pathSpace(ps.w),
      h: pathSpace(ps.h),
      f: Math.max(0, fill),
      s: bool(ps.stroke, true),
      e: bool(ps.extrusionOk, true),
      c,
    });
  }

  const adjIndex = (name: string | undefined): number => {
    const t = name === undefined ? '' : asciiTrim(name);
    if (t === '') return -1;
    const i = a.lastIndexOf(t);
    if (i < 0) note(notes, `handle reference '${printable(t)}' is not an adjust value`);
    return i;
  };
  const bound = (v: string | undefined): number => (v === undefined ? ABSENT : resolve(v, 'a handle'));
  const handlesIn = src.handles ?? [];
  if (handlesIn.length > GEOM_LIMITS.handles)
    note(notes, `${handlesIn.length - GEOM_LIMITS.handles} handles over the limit dropped`);
  const h: number[] = [];
  for (const hs of handlesIn.slice(0, GEOM_LIMITS.handles)) {
    if (hs.kind === 'xy') {
      h.push(HANDLE_XY, adjIndex(hs.gdRefX), bound(hs.minX), bound(hs.maxX));
      h.push(adjIndex(hs.gdRefY), bound(hs.minY), bound(hs.maxY));
    } else {
      h.push(HANDLE_POLAR, adjIndex(hs.gdRefR), bound(hs.minR), bound(hs.maxR));
      h.push(adjIndex(hs.gdRefAng), bound(hs.minAng), bound(hs.maxAng));
    }
    h.push(resolve(hs.x, 'a handle'), resolve(hs.y, 'a handle'));
  }

  const sitesIn = src.sites ?? [];
  if (sitesIn.length > GEOM_LIMITS.sites)
    note(notes, `${sitesIn.length - GEOM_LIMITS.sites} connection sites over the limit dropped`);
  const sites: number[] = [];
  for (const site of sitesIn.slice(0, GEOM_LIMITS.sites)) {
    const where = 'a connection site';
    sites.push(resolve(site.ang, where), resolve(site.x, where), resolve(site.y, where));
  }

  // Final slots: the built-ins, then k, then the guides; an absent handle bound is −1.
  const slot = (ref: number): number => {
    if (ref === ABSENT) return -1;
    if (ref < 0) return BUILTIN_COUNT + (-1 - ref);
    return ref < BUILTIN_COUNT ? ref : ref + k.length;
  };
  // Operands past an op's arity were pushed as 0, the slot of w, and stay 0.
  const g = prog.map((v, i) => (i % GUIDE_STRIDE === 0 ? v : slot(v)));
  const p: CompiledPath[] = paths.map((ps) => {
    const out: { w?: number; h?: number; f?: number; s?: 0; e?: 0; c: number[] } = { c: [] };
    if (ps.w > 0) out.w = ps.w;
    if (ps.h > 0) out.h = ps.h;
    if (ps.f !== 0) out.f = ps.f;
    if (!ps.s) out.s = 0;
    if (!ps.e) out.e = 0;
    for (let i = 0; i < ps.c.length; ) {
      const op = ps.c[i]!;
      out.c.push(op);
      const arity = PATH_OP_ARITY[op]!;
      for (let j = 1; j <= arity; j++) out.c.push(slot(ps.c[i + j]!));
      i += 1 + arity;
    }
    return out;
  });
  const hOut = h.map((v, i) => {
    const at = i % HANDLE_STRIDE;
    return at === 0 || at === 1 || at === 4 ? v : slot(v);
  });

  const geom: {
    k: number[];
    a: string[];
    g: number[];
    n: string[];
    r: number[];
    p: CompiledPath[];
    h?: number[];
    c?: number[];
  } = { k, a, g, n, r: r.map(slot), p };
  if (hOut.length > 0) geom.h = hOut;
  if (sites.length > 0) geom.c = sites.map(slot);
  return geom;
}
