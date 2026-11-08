import { ARC_MAX_SEGMENTS, arcToCubics } from './arc.ts';
import { compileGeom, type GeomNotes, type GeomSource, newGeomNotes } from './compile.ts';
import { type AdjustPairs, evalGuides } from './eval.ts';
import {
  CMD_ARC,
  CMD_CLOSE,
  CMD_CUBIC,
  CMD_LINE,
  CMD_MOVE,
  CMD_QUAD,
  type CompiledGeom,
  GEOM_LIMITS,
  PATH_FILLS,
  PATH_OP_ARITY,
  type PathFill,
  SITE_STRIDE,
} from './ops.ts';
import { PRESET_GEOMS } from './presets.gen.ts';

/*
 * The path builder (design/27 §1 geom/, §3.1 ShapeGeom): a compiled geometry (a preset, or a deck's custGeom) at
 * a box → its sub-paths in box space, each with its fill mode and stroke flag, plus the text rectangle and the
 * connection sites. Semantics are Apache POI 5.2.5's (`DrawSimpleShape.computeOutlines`, the path commands):
 * - Each a:path is built in its own space: when it has w (or h), its guides are evaluated at a box of that width
 *   (height), so its built-ins w, h, wd2, ... are the path's, and its points are scaled by box/space. Without w/h
 *   the space is the box. (The presets' w/h paths read only constants and angles, so for them both readings agree;
 *   for a custGeom this is POI's.) The text rectangle and the sites are evaluated at the box.
 * - arcTo continues from the current point with POI's visual-angle rule and Arc2D's segments (arc.ts).
 * - Two moveTos in a row keep the second (Java's Path2D); a close with no open sub-path, or right after a close,
 *   is dropped; after a close the current point is the sub-path's start (Canvas, SVG and Java agree).
 * Where POI throws, this draws what Canvas would: a lnTo with no current point starts a sub-path there, a
 * quadBezTo or cubicBezTo starts one at its first control point; an arcTo with no current point is skipped (as
 * LibreOffice skips it).
 *
 * Units are the caller's (logical px for the drawers, EMU for the converter). The output is box space: x from 0
 * (left) to w, y from 0 (top) to h; the drawer translates to the box and applies rotation and flips.
 *
 * Bounds (the deck is untrusted): at most GEOM_LIMITS.paths paths and GEOM_LIMITS.points points per path after
 * arcs become cubic segments (an arcTo is at most 4 segments, 12 points: GEOM_LIMITS counts it so), checked here
 * again for a CompiledGeom that did not come from compileGeom; an operand slot out of range reads 0, an unknown
 * command ends its path. Every coordinate is finite and within ±COORD_LIMIT; the box is clamped to 0..COORD_LIMIT.
 */

/** Largest coordinate magnitude of a built path, and the largest box side (any unit: 1e9 px or EMU). */
export const COORD_LIMIT = 1e9;

/** One built sub-path: an a:path in box space. */
export interface GeomPath {
  /**
   * Commands in order: CMD_MOVE, CMD_LINE, CMD_QUAD, CMD_CUBIC or CMD_CLOSE (ops.ts; never CMD_ARC: arcs are
   * cubic segments).
   */
  readonly cmds: readonly number[];
  /** Coordinates, x y pairs in command order: one pair per move and line, two per quad, three per cubic, none per close. */
  readonly pts: readonly number[];
  /** Fill mode: 'none' is not filled; the shaded modes blend the fill (`fill.ts`). */
  readonly fill: PathFill;
  /** Whether the outline is stroked. */
  readonly stroke: boolean;
}

/** A rectangle in box space (the text rectangle: a:rect). */
export interface GeomRect {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

/** A connection site (a:cxn) in box space; angle in degrees, clockwise from +x (the direction a connector leaves). */
export interface GeomSite {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** A geometry built at a box. */
export interface BuiltGeom {
  /** The box, as clamped. */
  readonly w: number;
  readonly h: number;
  /** Sub-paths in drawing order. */
  readonly paths: readonly GeomPath[];
  /** The text rectangle (the box when the geometry names none). */
  readonly text: GeomRect;
  readonly sites: readonly GeomSite[];
}

/** A custGeom built at a box, with what compiling and building replaced by 0 or dropped. */
export interface CustomGeom extends BuiltGeom {
  readonly notes: GeomNotes;
}

/** A finite coordinate within ±COORD_LIMIT (NaN is 0, ±Infinity the bound). */
function coord(v: number): number {
  if (v > COORD_LIMIT) return COORD_LIMIT;
  if (v < -COORD_LIMIT) return -COORD_LIMIT;
  return Number.isNaN(v) ? 0 : v + 0;
}

/** A box side: finite, 0..COORD_LIMIT (NaN and negative are 0). */
function side(v: number): number {
  return v > 0 ? Math.min(v, COORD_LIMIT) : 0;
}

/** A path's own space: positive and finite within GEOM_LIMITS.pathSpace, else 0 (the box). */
function space(v: number | undefined): number {
  return typeof v === 'number' && v > 0 && v <= GEOM_LIMITS.pathSpace ? v : 0;
}

/** The value of a slot; 0 for a slot that is not an index of `vals` (negative, fractional, NaN, out of range). */
function slotValue(vals: Float64Array, slot: number | undefined): number {
  return slot === undefined ? 0 : (vals[slot] ?? 0);
}

function note(notes: GeomNotes | undefined, msg: string): void {
  if (!notes) return;
  notes.count++;
  if (notes.messages.length < 32 && !notes.messages.includes(msg)) notes.messages.push(msg);
}

/** Builds one compiled path from its evaluated slots; `sx`, `sy` scale its space to the box. */
function buildPath(
  c: readonly number[],
  vals: Float64Array,
  sx: number,
  sy: number,
  notes: GeomNotes | undefined,
): { cmds: number[]; pts: number[] } {
  const cmds: number[] = [];
  const pts: number[] = [];
  const arc: number[] = [];
  // The current point and the sub-path's start, in the path's own space (arcs are computed there).
  let open = false;
  let cx = 0;
  let cy = 0;
  let sx0 = 0;
  let sy0 = 0;
  let last = -1;
  let points = 0;
  const limit = GEOM_LIMITS.points;
  const push = (x: number, y: number): void => {
    pts.push(coord(x * sx), coord(y * sy));
  };
  const v = (i: number): number => slotValue(vals, c[i]);
  const moveTo = (x: number, y: number): void => {
    if (last === CMD_MOVE) pts.length -= 2;
    else {
      cmds.push(CMD_MOVE);
      points++;
    }
    push(x, y);
    last = CMD_MOVE;
    open = true;
    cx = sx0 = x;
    cy = sy0 = y;
  };

  for (let i = 0; i < c.length; ) {
    const op = c[i]!;
    const arity = PATH_OP_ARITY[op];
    if (!Number.isInteger(op) || arity === undefined || i + arity >= c.length) {
      note(notes, 'a malformed path command ends its path');
      break;
    }
    // Points this command adds at most: as compile.ts counts them, plus a curve's implicit moveTo.
    const cost =
      op === CMD_ARC
        ? 3 * ARC_MAX_SEGMENTS
        : op === CMD_CUBIC
          ? open
            ? 3
            : 4
          : op === CMD_QUAD
            ? open
              ? 2
              : 3
            : 1;
    if (points + cost > limit) {
      note(notes, 'path points over the limit dropped');
      break;
    }
    switch (op) {
      case CMD_MOVE:
        moveTo(v(i + 1), v(i + 2));
        break;
      case CMD_LINE: {
        const x = v(i + 1);
        const y = v(i + 2);
        if (!open) moveTo(x, y);
        else {
          cmds.push(CMD_LINE);
          push(x, y);
          points++;
          last = CMD_LINE;
          cx = x;
          cy = y;
        }
        break;
      }
      case CMD_QUAD:
      case CMD_CUBIC: {
        const n = op === CMD_QUAD ? 2 : 3;
        if (!open) moveTo(v(i + 1), v(i + 2));
        cmds.push(op);
        for (let j = 0; j < n; j++) push(v(i + 1 + 2 * j), v(i + 2 + 2 * j));
        points += n;
        last = op;
        cx = v(i + 2 * n - 1);
        cy = v(i + 2 * n);
        break;
      }
      case CMD_ARC: {
        if (!open) break;
        arc.length = 0;
        const segments = arcToCubics(cx, cy, v(i + 1), v(i + 2), v(i + 3), v(i + 4), arc);
        for (let s = 0; s < segments; s++) {
          cmds.push(CMD_CUBIC);
          for (let j = 0; j < 6; j += 2) push(arc[6 * s + j]!, arc[6 * s + j + 1]!);
        }
        if (segments > 0) {
          points += 3 * segments;
          last = CMD_CUBIC;
          cx = arc[6 * segments - 2]!;
          cy = arc[6 * segments - 1]!;
        }
        break;
      }
      case CMD_CLOSE:
        if (open && last !== CMD_CLOSE) {
          cmds.push(CMD_CLOSE);
          points++;
          last = CMD_CLOSE;
          cx = sx0;
          cy = sy0;
        }
        break;
    }
    i += 1 + arity;
  }
  return { cmds, pts };
}

/**
 * Builds a compiled geometry at a w x h box (the caller's units). `adj` overrides adjust values by name (a
 * shape's a:avLst, ShapeGeom.adj); `notes` collects what was dropped.
 */
export function buildGeom(
  geom: CompiledGeom,
  w: number,
  h: number,
  adj?: AdjustPairs,
  notes?: GeomNotes,
): BuiltGeom {
  const bw = side(w);
  const bh = side(h);
  const shapeVals = evalGuides(geom, { w: bw, h: bh }, adj);
  // Evaluations at path spaces other than the box, by space (a geometry has at most GEOM_LIMITS.paths).
  const spaces: { w: number; h: number; vals: Float64Array }[] = [];
  const valsAt = (pw: number, ph: number): Float64Array => {
    if (pw === bw && ph === bh) return shapeVals;
    for (const s of spaces) if (s.w === pw && s.h === ph) return s.vals;
    const vals = evalGuides(geom, { w: pw, h: ph }, adj);
    spaces.push({ w: pw, h: ph, vals });
    return vals;
  };

  const src = geom.p;
  if (src.length > GEOM_LIMITS.paths)
    note(notes, `${src.length - GEOM_LIMITS.paths} paths over the limit dropped`);
  const paths: GeomPath[] = [];
  for (let i = 0; i < Math.min(src.length, GEOM_LIMITS.paths); i++) {
    const p = src[i]!;
    const pw = space(p.w);
    const ph = space(p.h);
    const vals = valsAt(pw > 0 ? pw : bw, ph > 0 ? ph : bh);
    const built = buildPath(
      Array.isArray(p.c) ? p.c : [],
      vals,
      pw > 0 ? bw / pw : 1,
      ph > 0 ? bh / ph : 1,
      notes,
    );
    paths.push({
      cmds: built.cmds,
      pts: built.pts,
      fill: PATH_FILLS[p.f ?? 0] ?? 'norm',
      stroke: p.s !== 0,
    });
  }

  const r = geom.r;
  const text: GeomRect = {
    l: coord(slotValue(shapeVals, r[0])),
    t: coord(slotValue(shapeVals, r[1])),
    r: coord(slotValue(shapeVals, r[2])),
    b: coord(slotValue(shapeVals, r[3])),
  };
  const sites: GeomSite[] = [];
  const c = geom.c ?? [];
  const siteCount = Math.min(Math.floor(c.length / SITE_STRIDE), GEOM_LIMITS.sites);
  for (let i = 0; i < siteCount; i++) {
    const at = i * SITE_STRIDE;
    sites.push({
      x: coord(slotValue(shapeVals, c[at + 1])),
      y: coord(slotValue(shapeVals, c[at + 2])),
      angle: coord(slotValue(shapeVals, c[at]) / 60000),
    });
  }
  return { w: bw, h: bh, paths, text, sites };
}

/** Whether `name` is one of the 187 preset geometries (prstGeom prst). */
export function hasPreset(name: string): boolean {
  return PRESET_GEOMS.has(name);
}

/**
 * A preset geometry (a:prstGeom prst="name") built at a w x h box, with the shape's adjust values; undefined for
 * a name that is not a preset (the caller draws its rectangle).
 */
export function presetGeometry(name: string, w: number, h: number, adj?: AdjustPairs): BuiltGeom | undefined {
  const geom = typeof name === 'string' ? PRESET_GEOMS.get(name) : undefined;
  return geom === undefined ? undefined : buildGeom(geom, w, h, adj);
}

/**
 * A custom geometry (a:custGeom, as strings: compile.ts GeomSource) built at a w x h box. Compiled and built
 * under GEOM_LIMITS; `notes` says what was replaced by 0 or dropped. Callers that draw one geometry often
 * compile it once (`compileGeom`) and call `buildGeom`.
 */
export function customGeometry(src: GeomSource, w: number, h: number, adj?: AdjustPairs): CustomGeom {
  const notes = newGeomNotes();
  const geom = compileGeom(src, notes);
  return { ...buildGeom(geom, w, h, adj, notes), notes };
}

/** Points (coordinate pairs) of a built path. */
export function pathPoints(path: GeomPath): number {
  return path.pts.length / 2;
}

/** The commands of a built path as an SVG/Canvas path string (M L Q C Z), for tests and tools. */
export function pathData(path: GeomPath, digits = 3): string {
  const out: string[] = [];
  let at = 0;
  const n = (v: number): string => String(Number(v.toFixed(digits)) + 0);
  for (const op of path.cmds) {
    const pairs = op === CMD_QUAD ? 2 : op === CMD_CUBIC ? 3 : op === CMD_CLOSE ? 0 : 1;
    const letter =
      op === CMD_MOVE ? 'M' : op === CMD_LINE ? 'L' : op === CMD_QUAD ? 'Q' : op === CMD_CUBIC ? 'C' : 'Z';
    const parts = [letter];
    for (let j = 0; j < pairs; j++, at += 2) parts.push(n(path.pts[at]!), n(path.pts[at + 1]!));
    out.push(parts.join(' '));
  }
  return out.join(' ');
}
