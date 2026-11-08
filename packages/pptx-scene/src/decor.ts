/**
 * Decorations (design/27 §15 M9, `budget-decorations.md` §3.3, plan decision 1; `decor-conv`): a z-run of
 * text-less shapes of one scope drawn as one locked `ShapeObject.decor`, so a slide past the object budget
 * keeps its decorations natively instead of sending them to LibreOffice's art. Written only when
 * `EmitOptions.m9Writes` has 'decor'; without it every member is emitted as before.
 *
 * - **Who joins** (`decorable`): a shown shape without visible text, native or approx (never real 3-D,
 *   plan decision 6, unless `flat3d`), not a line or connector route, whose geometry `shapePiece` builds
 *   (a preset at its adjust values, custom geometry within the bounds), filled with nothing, a colour (any
 *   alpha) or a gradient, outlined with nothing or a plain line (any dash; no arrowheads, round or bevel
 *   joins, round or square caps: `DecorPaint` has none), with no effect but an outer shadow, no 3-D look,
 *   inside the render clamp's bounds, and with paths a part can hold (`GEOM_LIMITS.points` a path).
 * - **Runs** (`decorRuns`): bottom up, z-adjacent decorable elements of one scope until a cap
 *   (`DECOR_LIMITS`: 256 parts, 64 paints, 16,384 points, 24 shadowed shapes) closes the run. The scope is
 *   a SmartArt drawing (always), else a top-level group or a layout's or master's decorations (the narrow
 *   scope), else (the wide scope, `wide`) the element's source, the slide's own ungrouped shapes included.
 *   A plain picture that overlaps no member of the open run does not end it (it is emitted after the
 *   decoration, and no later member may overlap it); hidden and culled elements are skipped; anything else
 *   ends it. A run of one element is not a run.
 * - **The object** (`emitDecor`): each member emitted as the single-shape emitter writes it (so a
 *   decoration draws exactly what the separate shapes draw), then its geometry built at its box as the
 *   renderer builds it (`@ordo/renderer` `presetGeometry`, `storedPath`, `legacyGeometry`), placed (flips,
 *   rotation) into the decoration's space, which is its box in logical px (`w` x `h` = the union of the
 *   members' boxes, unrotated). Each member's paths are parts in z-order, its first with `s: 1`; its look
 *   is a paint (fill, gradient, stroke, dash, shadow), equal paints shared (`@ordo/domain` `Palette`). A
 *   gradient keeps the member's own box as its frame (`DecorPart.frame`: x, y, w, h, rotation in the
 *   decoration's space; the gradient is laid over [0, w] x [0, h] of that box turned about its centre, as
 *   `drawGeomShape` lays a shape's), mirrored by the member's flips (a frame has none). A path too long for
 *   one part is a chain (`cont`). Legacy: `shape: 'line'`, no fill and no stroke (an older build draws
 *   nothing), `locked`, origin role 'decor' (a SmartArt drawing's is 'diagram').
 * - **Drawing contract** (`decor-render`): parts from one `s: 1` to the next are one source shape, built as
 *   one geometry (a `cont` part joined to the one before it) and drawn as `drawGeomShape` draws a shape:
 *   its shadow first (`drawEffected` with that shape's geometry and paint), then its fills and stroke
 *   (`drawGeom`, the parts' fill modes and stroke flags; miter joins, flat caps, a dashed outline at least
 *   0.5 px wide as `clamp.ts` draws one).
 * - **Files** (`decorFiles`): a decoration whose parts take more than `GEOM_FILE_CHARS` of the slide is
 *   written in a decoration file (`DecorData.ref`, placeholder `pptxdecor:<n>`, one per distinct file,
 *   `EmitResult.decors`), as geometry files are; its inline parts are then empty.
 * - **Plates** (`platePlan`, decisions.md "Slow-to-draw elements" and its edit-time amendment): what the
 *   client bakes into decoration plates: the slide's static decoration stack (its bottom objects up to its
 *   first text object, a video or an object that plays) and the objects above it whose effect layers go on
 *   their own effect plates. Pure: the same rule over a stored slide gives the same plan.
 *
 * Pure: IR and emitted objects in, objects out; deck strings are only compared, never used as object keys.
 */
import type {
  DecorData,
  DecorFile,
  DecorPaint,
  DecorPart,
  Gradient,
  ShapeObject,
  Slide,
  SlideObject,
} from '@ordo/domain';
import { Palette } from '@ordo/domain/palette.ts';
import { boxSide, legacyGeometry, storedPath } from '@ordo/renderer/geom/built.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD, GEOM_LIMITS } from '@ordo/renderer/geom/ops.ts';
import { type GeomPath, presetGeometry } from '@ordo/renderer/geom/path.ts';
import { boundsOf, overlaps, unionBox } from './classify.ts';
import { GEOM_FILE_CHARS } from './emit-budget.ts';
import { type EmitCtx, writes } from './emit-ctx.ts';
import { decompose } from './frame.ts';
import { endsOf, MAX_PATH_CHARS, shapePiece } from './geom.ts';
import type { Element, Fill, Frame, Line, RectEmu, ShapeElement } from './ir.ts';

/** The prefix of decoration files' placeholders (`DecorData.ref`, `EmitResult.decors`). */
export const DECOR_PREFIX = 'pptxdecor:';

/**
 * `@ordo/domain` `DECOR_LIMITS` (the schema's, a zod module this pure package does not load; `decor.test.ts`
 * pins the two): paints, parts, points of all parts and shadowed source shapes of one decoration.
 */
export const DECOR_LIMITS = { paints: 64, parts: 256, points: 16_384, shadowed: 24 } as const;

/**
 * Lines a decoration draws as their emitted objects draw them: a straight line or connector (a `line` object
 * along its box's midline, `emit.ts` `lineObject`) and a bent or curved connector's route (`routeObject`).
 */
const LINE_GEOMS = /^(line|straightConnector1|(bent|curved)Connector[2-5])$/;
/**
 * An outline at most this wide (logical px) joins a decoration with round or bevel joins and round or square
 * caps, which a decoration's paint does not carry (`DecorPaint` has none: drawn with miter joins and flat
 * caps, at most half this width from the shape's own at a corner or an end; most traced ornaments are 0.75
 * pt, 1 px). A wider one stays its own object. A later schema with `DecorPaint` joins and caps drops this.
 */
export const THIN_LINE_PX = 2;
/** The render clamp keeps box edges within ±2× the logical canvas (`@ordo/renderer` `CLAMP.boxFactor`). */
const CLAMP_W = 2 * 1_920;
const CLAMP_H = 2 * 1_080;
/** Reasons of real 3-D (`residual.ts`): never in a decoration (plan decision 6) unless drawn flat in it. */
const REAL_3D = (r: string) => r === '3d' || r === '3d:camera';

// ── Who joins ───────────────────────────────────────────────────────────────────────────────────────────

/** What a decorable shape brings to a run. */
export interface DecorMember {
  /** Its scope at the narrow step: its drawing, group or decoration source; undefined: the slide's own. */
  scope: string | undefined;
  /** Its scope at the wide step: its drawing, else its source. */
  wide: string;
  /** Its bounds in slide EMU (`boundsOf`). */
  box: RectEmu;
  /** Its parts (paths, a long one counted as its chain) and points as the render clamp counts them. */
  parts: number;
  points: number;
  shadowed: boolean;
  /** Its look, for the palette cap (`DECOR_LIMITS.paints`). */
  paint: string;
  /** Real 3-D drawn flat in the decoration (only with `flat3d`). */
  flat3d: boolean;
}

const members = new WeakMap<Element, DecorMember | null>();

/**
 * Whether a shape can be drawn as part of a decoration, and what it brings (see the header). Memoised per
 * element: what it reads does not change after the walk, but its `hidden`, `support` and reasons do (the
 * budget culls, the art takes), so those are checked on every call. `flat3d`: real 3-D may join, drawn flat.
 */
export function decorable(e: Element, frame: Frame, flat3d = false): DecorMember | undefined {
  if (e.kind !== 'shape' || e.hidden || e.support === 'residual') return undefined;
  const three = e.reasons?.some(REAL_3D) === true;
  if (three && !flat3d) return undefined;
  let m = members.get(e);
  if (m === undefined) {
    m = memberOf(e, frame) ?? null;
    members.set(e, m);
  }
  if (!m) return undefined;
  return three ? { ...m, flat3d: true } : m;
}

/**
 * A line the decoration's paint can carry: none, or a plain one (any dash; no arrowheads; default joins and
 * caps, or any when it is at most `THIN_LINE_PX` wide, `s` logical px per EMU).
 */
function plainLine(line: Line | undefined, s: number): boolean {
  if (!line || line.fill.kind === 'none') return true;
  if (endsOf(line)) return false;
  const styled =
    line.join === 'round' || line.join === 'bevel' || line.cap === 'round' || line.cap === 'square';
  if (styled && !(line.width * s <= THIN_LINE_PX)) return false;
  return line.fill.kind === 'solid' || line.fill.kind === 'gradient' || line.fill.kind === 'pattern';
}

/** A fill the decoration's paint can carry: none, a colour, a gradient or a pattern (its blended colour). */
const plainFill = (f: Fill) =>
  f.kind === 'none' || f.kind === 'solid' || f.kind === 'gradient' || f.kind === 'pattern';

/** Points of a path as the render clamp counts them: a pair each, 1 for a close. */
function pathPoints(cmds: string): number {
  let n = 0;
  for (const c of cmds) n += c === 'C' ? 3 : c === 'Q' ? 2 : 1;
  return n;
}

function memberOf(e: ShapeElement, frame: Frame): DecorMember | undefined {
  if (e.text || e.glow || e.softEdge || e.look3d) return undefined;
  if (!plainFill(e.fill) || !plainLine(e.line, frame.s)) return undefined;
  const line = e.line && e.line.fill.kind !== 'none' ? e.line : undefined;
  if (e.fill.kind === 'none' && !line) return undefined;
  // A line or a connector draws its outline only (a fill is never drawn for it).
  if (LINE_GEOMS.test(e.geom) && !line) return undefined;
  const piece = shapePiece(e, frame.s);
  if (!piece) return undefined;
  let points = 0;
  let parts = 0;
  for (const p of piece.paths) {
    const n = pathPoints(p.cmds);
    if (n > GEOM_LIMITS.points) return undefined;
    points += n;
    // About 16 characters a point once written in a slide-wide decoration: a longer path is a chain.
    parts += Math.max(1, Math.ceil((n * 16) / MAX_PATH_CHARS));
  }
  const box = boundsOf(e);
  const x0 = frame.x0 + box.x * frame.s;
  const y0 = frame.y0 + box.y * frame.s;
  const x1 = x0 + box.cx * frame.s;
  const y1 = y0 + box.cy * frame.s;
  if (!(x0 >= -CLAMP_W && x1 <= CLAMP_W && y0 >= -CLAMP_H && y1 <= CLAMP_H)) return undefined;
  if (!(box.cx > 0 || box.cy > 0)) return undefined;
  const drawing = e.diagram !== undefined ? `${e.from}:d${e.diagram}` : undefined;
  const scope =
    drawing ?? (e.group !== undefined ? `${e.from}:g${e.group}` : e.from !== 'slide' ? e.from : undefined);
  const flips = decompose(e.xf).flipH;
  return {
    scope,
    wide: drawing ?? e.from,
    box,
    parts,
    points,
    shadowed: !!e.shadow,
    paint: JSON.stringify([e.fill, line ?? null, e.shadow ?? null, e.fill.kind === 'gradient' && flips]),
    flat3d: false,
  };
}

/** A picture a run of decorations may skip over: shown, plain (no clip, no outline, no 3-D, no media). */
function skippable(e: Element): boolean {
  return e.kind === 'picture' && !e.hidden && !e.media && !e.line && !e.look3d && e.support !== 'residual';
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────

export interface DecorRunOptions {
  /** The wide scope (the source alone, the slide's own ungrouped shapes included). Default: the narrow one. */
  wide?: boolean;
  /** Elements that may not join (in the art, already in another run). */
  exclude?: ReadonlySet<number>;
  /** Real 3-D may join, drawn flat (`3d:flat-in-decoration`). */
  flat3d?: boolean;
}

/**
 * The decoration runs of a slide's elements (see the header): indexes, bottom first, each run at least two
 * members. Greedy and linear (each member is tested against at most the run's skipped pictures).
 */
export function decorRuns(
  elements: readonly Element[],
  frame: Frame,
  opts: DecorRunOptions = {},
): number[][] {
  const runs: number[][] = [];
  type Run = {
    scope: string;
    list: number[];
    boxes: RectEmu[];
    skipped: RectEmu[];
    parts: number;
    points: number;
    shadowed: number;
    paints: Set<string>;
  };
  let run: Run | undefined;
  const end = () => {
    if (run && run.list.length > 1) runs.push(run.list);
    run = undefined;
  };
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i]!;
    if (e.hidden) continue;
    const m = opts.exclude?.has(i) ? undefined : decorable(e, frame, opts.flat3d);
    const scope = m ? (opts.wide ? m.wide : m.scope) : undefined;
    if (!m || scope === undefined) {
      // A plain picture beside the run's members (sharing no area with them) is drawn after the
      // decoration; the members after it must stay clear of it as well.
      if (run && skippable(e) && !opts.exclude?.has(i)) {
        const b = boundsOf(e);
        if (run.skipped.length < DECOR_LIMITS.parts && !run.boxes.some((q) => overlaps(q, b))) {
          run.skipped.push(b);
          continue;
        }
      }
      end();
      continue;
    }
    const r = run;
    if (
      r &&
      r.scope === scope &&
      r.parts + m.parts <= DECOR_LIMITS.parts &&
      r.points + m.points <= DECOR_LIMITS.points &&
      r.shadowed + (m.shadowed ? 1 : 0) <= DECOR_LIMITS.shadowed &&
      (r.paints.has(m.paint) || r.paints.size < DECOR_LIMITS.paints) &&
      !r.skipped.some((q) => overlaps(q, m.box))
    ) {
      r.list.push(i);
      r.boxes.push(m.box);
      r.parts += m.parts;
      r.points += m.points;
      if (m.shadowed) r.shadowed++;
      r.paints.add(m.paint);
      continue;
    }
    end();
    run = {
      scope,
      list: [i],
      boxes: [m.box],
      skipped: [],
      parts: m.parts,
      points: m.points,
      shadowed: m.shadowed ? 1 : 0,
      paints: new Set([m.paint]),
    };
  }
  end();
  return runs;
}

// ── The object ──────────────────────────────────────────────────────────────────────────────────────────

/** Emits one element as the single-element emitter writes it (`emit.ts` `emitElement`) onto `out`. */
export type EmitOne = (e: Element, out: SlideObject[]) => void;

/** A member as it is drawn: its look and its paths in slide logical px. */
interface Drawn {
  paint: DecorPaint;
  paths: { cmds: readonly number[]; pts: number[]; fill: GeomPath['fill']; stroke: boolean; cont: boolean }[];
  /** Its box (rotation included) in slide logical px, and its bounds there. */
  box: ShapeObject['box'];
  bounds: { x0: number; y0: number; x1: number; y1: number };
  points: number;
}

/** Fields of a shape object a decoration's paint cannot carry. */
const NOT_IN_PAINT = ['ends', 'glow', 'softEdge', 'look3d', 'table', 'chart', 'decor'] as const;

/** A gradient as it lies in an unmirrored box: the box's mirrors folded into its angle or centre. */
function unmirrored(g: Gradient, flipH: boolean, flipV: boolean): Gradient {
  if (!flipH && !flipV) return g;
  if (g.kind === 'radial') {
    const c = g.center ?? { x: 0.5, y: 0.5 };
    return { ...g, center: { x: flipH ? 1 - c.x : c.x, y: flipV ? 1 - c.y : c.y } };
  }
  let a = g.angle ?? 0;
  if (flipH) a = 180 - a;
  if (flipV) a = -a;
  a = ((a % 360) + 360) % 360;
  return { ...g, angle: Math.round(a * 1e6) / 1e6 };
}

/** The shape object a member emitted, drawn: undefined when a decoration cannot draw it as it is drawn. */
function drawnOf(o: SlideObject): Drawn | undefined {
  if (o.type !== 'shape') return undefined;
  for (const k of NOT_IN_PAINT) if (o[k] !== undefined) return undefined;
  // Joins and caps a decoration draws as miter and flat: only on a thin outline (`THIN_LINE_PX`).
  if ((o.lineJoin !== undefined || o.lineCap !== undefined) && !(o.stroke && o.stroke.width <= THIN_LINE_PX))
    return undefined;
  if (o.opacity !== undefined && o.opacity !== 1) return undefined;
  if (!o.fill && !o.stroke) return undefined;
  const w = boxSide(o.box.w);
  const h = boxSide(o.box.h);
  let built: { path: GeomPath; cont: boolean }[];
  if (o.geom) {
    if (typeof o.geom.preset === 'string') {
      const g = presetGeometry(o.geom.preset, w, h, o.geom.adj as [string, number][] | undefined);
      if (!g) return undefined;
      built = g.paths.map((path) => ({ path, cont: false }));
    } else if (Array.isArray(o.geom.paths) && o.geom.paths.length && o.geom.ref === undefined) {
      built = o.geom.paths.map((p, k) => ({ path: storedPath(p, w, h), cont: k > 0 && p.cont === true }));
    } else return undefined;
  } else {
    // A straight line: along its box's midline, stroked only (`legacyGeometry` draws it as `drawShape` does).
    if (o.shape === 'line' && !o.stroke) return undefined;
    built = legacyGeometry(o.shape, o.radius ?? 0, w, h).paths.map((path) => ({ path, cont: false }));
  }
  if (!built.length) return undefined;
  // Placed as `placeBox` places the shape: mirrored about the box's centre, turned about it, moved to it.
  const a = ((o.box.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = o.box.x + w / 2;
  const cy = o.box.y + h / 2;
  const fh = o.flipH === true;
  const fv = o.flipV === true;
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (x: number, y: number) => {
    if (x < bounds.x0) bounds.x0 = x;
    if (x > bounds.x1) bounds.x1 = x;
    if (y < bounds.y0) bounds.y0 = y;
    if (y > bounds.y1) bounds.y1 = y;
  };
  let points = 0;
  const paths: Drawn['paths'] = [];
  for (const { path, cont } of built) {
    const pts: number[] = [];
    for (let i = 0; i + 1 < path.pts.length; i += 2) {
      const lx = (fh ? w - path.pts[i]! : path.pts[i]!) - w / 2;
      const ly = (fv ? h - path.pts[i + 1]! : path.pts[i + 1]!) - h / 2;
      pts.push(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
    }
    for (const op of path.cmds) points += op === CMD_CUBIC ? 3 : op === CMD_QUAD ? 2 : 1;
    paths.push({ cmds: path.cmds, pts, fill: path.fill, stroke: path.stroke, cont });
  }
  // The box's corners, turned: what the decoration's box is the union of.
  for (const [x, y] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ] as const) {
    const lx = x - w / 2;
    const ly = y - h / 2;
    grow(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
  }
  const paint: DecorPaint = {
    ...(o.fill ? { fill: o.fill } : {}),
    ...(o.gradient && o.fill ? { gradient: unmirrored(o.gradient, fh, fv) } : {}),
    ...(o.stroke ? { stroke: o.stroke } : {}),
    ...(o.stroke && o.dash && o.dash !== 'solid' ? { dash: o.dash } : {}),
    ...(o.shadow ? { shadow: o.shadow } : {}),
  };
  return { paint, paths, box: o.box, bounds, points };
}

/** A coordinate with `dec` decimals, no trailing zeros, never `-0`. */
function fmt(v: number, dec: number): string {
  const r = Number(v.toFixed(dec)) + 0;
  return Object.is(r, -0) ? '0' : String(r);
}

const LETTER: Readonly<Record<number, [string, number]>> = {
  [CMD_MOVE]: ['M', 1],
  [CMD_LINE]: ['L', 1],
  [CMD_QUAD]: ['Q', 2],
  [CMD_CUBIC]: ['C', 3],
  [CMD_CLOSE]: ['Z', 0],
};

/**
 * A path as part strings in the decoration's space (origin `x0`, `y0`): one string when it fits a part
 * (`MAX_PATH_CHARS`, `GEOM_LIMITS.points`), else a chain cut at its sub-paths' starts, with fewer decimals
 * if need be; undefined when a sub-path alone cannot fit.
 */
function partStrings(
  cmds: readonly number[],
  pts: readonly number[],
  x0: number,
  y0: number,
): string[] | undefined {
  for (let dec = 2; dec >= 0; dec--) {
    const out: string[] = [];
    let cur = '';
    let curPts = 0;
    let sub = '';
    let subPts = 0;
    let ok = true;
    const flushSub = () => {
      if (!sub) return;
      if (sub.length > MAX_PATH_CHARS || subPts > GEOM_LIMITS.points) {
        ok = false;
        return;
      }
      if (cur && (cur.length + 1 + sub.length > MAX_PATH_CHARS || curPts + subPts > GEOM_LIMITS.points)) {
        out.push(cur);
        cur = '';
        curPts = 0;
      }
      cur = cur ? `${cur} ${sub}` : sub;
      curPts += subPts;
      sub = '';
      subPts = 0;
    };
    let at = 0;
    for (const op of cmds) {
      const [letter, pairs] = LETTER[op] ?? ['Z', 0];
      if (letter === 'M') flushSub();
      if (!ok) break;
      let t = letter;
      for (let j = 0; j < pairs; j++, at += 2)
        t += ` ${fmt((pts[at] ?? 0) - x0, dec)} ${fmt((pts[at + 1] ?? 0) - y0, dec)}`;
      sub = sub ? `${sub} ${t}` : t;
      subPts += pairs || 1;
    }
    flushSub();
    if (!ok) continue;
    if (cur) out.push(cur);
    return out.length ? out : undefined;
  }
  return undefined;
}

/** One decoration being built from drawn members. */
class DecorBuilder {
  readonly paints = new Palette<DecorPaint>(DECOR_LIMITS.paints);
  readonly members: Drawn[] = [];
  parts = 0;
  points = 0;
  shadowed = 0;

  /** Whether `d` (as `n` parts) fits beside what the decoration holds. */
  fits(d: Drawn, n: number): boolean {
    if (this.parts + n > DECOR_LIMITS.parts || this.points + d.points > DECOR_LIMITS.points) return false;
    if (d.paint.shadow && this.shadowed + 1 > DECOR_LIMITS.shadowed) return false;
    return this.paints.indexOf(d.paint) !== undefined || this.paints.entries.length < DECOR_LIMITS.paints;
  }
}

/**
 * Write a run of elements (bottom first, `decorRuns`) as decorations on `out` and return true, or return
 * false, leaving `out` as it was, when it writes none: the field is off ('decor' not in
 * `EmitOptions.m9Writes`), or a member is not drawn as one shape a decoration can draw (the members are then
 * emitted one by one). `emitOne` emits a member as the single-element emitter does. A run whose members pass
 * a cap once emitted is written as consecutive decorations; a decoration of one member is that member's
 * own object.
 */
export function emitDecor(
  ctx: EmitCtx,
  run: readonly Element[],
  out: SlideObject[],
  emitOne?: EmitOne,
): boolean {
  if (!writes(ctx, 'decor') || !emitOne || run.length < 2) return false;
  const drawn: { d: Drawn; o: ShapeObject; strings: string[][] }[] = [];
  for (const e of run) {
    const sink: SlideObject[] = [];
    emitOne(e, sink);
    const o = sink[0];
    const d = sink.length === 1 && o ? drawnOf(o) : undefined;
    if (!d || o?.type !== 'shape') return false;
    drawn.push({ d, o, strings: [] });
  }
  // The union of the members' boxes: the decoration's box and space.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { d } of drawn) {
    x0 = Math.min(x0, d.bounds.x0);
    y0 = Math.min(y0, d.bounds.y0);
    x1 = Math.max(x1, d.bounds.x1);
    y1 = Math.max(y1, d.bounds.y1);
  }
  if (!(x1 > x0 && y1 > y0)) return false;
  for (const m of drawn)
    for (const p of m.d.paths) {
      const s = partStrings(p.cmds, p.pts, x0, y0);
      if (!s) return false;
      m.strings.push(s);
    }
  let group: DecorBuilder = new DecorBuilder();
  const groups: { b: DecorBuilder; list: typeof drawn }[] = [{ b: group, list: [] }];
  for (const m of drawn) {
    const n = m.strings.reduce((k, s) => k + s.length, 0);
    if (!group.fits(m.d, n)) {
      group = new DecorBuilder();
      groups.push({ b: group, list: [] });
    }
    group.paints.add(m.d.paint);
    group.parts += n;
    group.points += m.d.points;
    if (m.d.paint.shadow) group.shadowed++;
    groups[groups.length - 1]!.list.push(m);
  }
  const first = run[0]!;
  for (const { b, list } of groups) {
    if (list.length === 1) {
      out.push(list[0]!.o);
      continue;
    }
    // Each decoration's own box: the union of its members'.
    let gx0 = Infinity;
    let gy0 = Infinity;
    let gx1 = -Infinity;
    let gy1 = -Infinity;
    for (const { d } of list) {
      gx0 = Math.min(gx0, d.bounds.x0);
      gy0 = Math.min(gy0, d.bounds.y0);
      gx1 = Math.max(gx1, d.bounds.x1);
      gy1 = Math.max(gy1, d.bounds.y1);
    }
    const parts: DecorPart[] = [];
    for (const m of list) {
      const p = b.paints.indexOf(m.d.paint)!;
      const frame: DecorPart['frame'] = m.d.paint.gradient
        ? [
            round2(m.d.box.x - gx0),
            round2(m.d.box.y - gy0),
            round2(m.d.box.w),
            round2(m.d.box.h),
            m.d.box.rotation ?? 0,
          ]
        : undefined;
      let firstPart = true;
      m.d.paths.forEach((path, k) => {
        const strings =
          gx0 === x0 && gy0 === y0
            ? m.strings[k]!
            : (partStrings(path.cmds, path.pts, gx0, gy0) ?? m.strings[k]!);
        strings.forEach((d, j) => {
          parts.push({
            d,
            p,
            ...(firstPart ? { s: 1 as const } : {}),
            ...(path.fill !== 'norm' ? { fill: path.fill } : {}),
            ...(path.stroke ? {} : { stroke: false }),
            ...((path.cont || j > 0) && !firstPart ? { cont: true } : {}),
            ...(frame ? { frame } : {}),
          });
          firstPart = false;
        });
      });
    }
    const decor: DecorData = { w: round2(gx1 - gx0), h: round2(gy1 - gy0), paints: b.paints.entries, parts };
    const o: ShapeObject = {
      id: ctx.newId(),
      type: 'shape',
      box: { x: round2(gx0), y: round2(gy0), w: decor.w, h: decor.h, rotation: 0 },
      shape: 'line',
      opacity: 1,
      radius: 0,
      decor,
      locked: true,
      ...(ctx.rich
        ? {
            origin: {
              src: 'pptx',
              role: 'decor',
              ...(first.shapeId > 0 ? { shapeId: Math.min(2_147_483_647, first.shapeId) } : {}),
              ...(first.group !== undefined ? { group: Math.min(100_000, Math.max(0, first.group)) } : {}),
            },
          }
        : {}),
    };
    out.push(o);
  }
  return true;
}

const round2 = (v: number) => Math.round(v * 100) / 100 + 0;

// ── Files ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Moves each decoration of a slide whose parts take more than `GEOM_FILE_CHARS` (its JSON times the times
 * the slide draws it) into a decoration file (`DecorData.ref` through `decorRef`; none without it), its
 * inline parts left empty, as `fitBytes` moves geometries into geometry files.
 */
export function decorFiles(
  slide: Pick<Slide, 'objects'>,
  decorRef: ((json: string, file: DecorFile) => string) | undefined,
): void {
  if (!decorRef) return;
  const sites: { o: ShapeObject; json: string }[] = [];
  const times = new Map<string, number>();
  for (const o of slide.objects) {
    if (o.type !== 'shape' || !o.decor || o.decor.ref !== undefined || !o.decor.parts.length) continue;
    const json = JSON.stringify({ parts: o.decor.parts });
    sites.push({ o, json });
    times.set(json, (times.get(json) ?? 0) + 1);
  }
  for (const { o, json } of sites) {
    if (json.length * times.get(json)! <= GEOM_FILE_CHARS) continue;
    const decor = o.decor!;
    const ref = decorRef(json, { parts: decor.parts });
    o.decor = { ...decor, parts: [], ref };
  }
}

// ── Plates ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the client bakes into decoration plates for a slide (decisions.md "Slow-to-draw elements", edit-time
 * amendment; the plate itself, its key and its bake are `decor-render`'s). Object ids, bottom first.
 */
export interface PlatePlan {
  /**
   * The static decoration stack: the slide's bottom objects (its background included) up to, not
   * including, its first text object (a table or a chart, which hold text, too), a picture that plays a
   * clip, or an object of an unknown kind. They are drawn into one plate under the rest.
   */
  stack: string[];
  /**
   * The objects above the stack whose effect layers (shadow, glow, soft edge, 3-D look) go on their own
   * effect plates under them: the objects themselves stay live, and text always does.
   */
  effects: string[];
}

/** Whether an object ends the static decoration stack (see `PlatePlan.stack`). */
function endsStack(o: SlideObject): boolean {
  if (o.type === 'text') return true;
  if (o.type === 'image') return o.play !== undefined;
  if (o.type === 'shape') return o.table !== undefined || o.chart !== undefined;
  return true;
}

/** Whether an object above the stack has effect layers a plate holds (text never: it stays live). */
function hasEffectLayers(o: SlideObject): boolean {
  if (o.type === 'shape')
    return (
      o.shadow !== undefined ||
      o.glow !== undefined ||
      (typeof o.softEdge === 'number' && o.softEdge > 0) ||
      o.look3d !== undefined
    );
  if (o.type === 'image') return o.look3d !== undefined;
  return false;
}

/** The plate plan of a slide's objects (`PlatePlan`); the same for a stored slide as for an emitted one. */
export function platePlan(slide: Pick<Slide, 'objects'>): PlatePlan {
  const objects = Array.isArray(slide.objects) ? slide.objects : [];
  let k = 0;
  while (k < objects.length && !endsStack(objects[k]!)) k++;
  const stack = objects.slice(0, k).map((o) => o.id);
  const effects: string[] = [];
  for (let i = k; i < objects.length; i++) if (hasEffectLayers(objects[i]!)) effects.push(objects[i]!.id);
  return { stack, effects };
}

/** The union box of elements in slide EMU (exported for the budget). */
export function boundsOfAll(list: readonly Element[]): RectEmu | undefined {
  let box: RectEmu | undefined;
  for (const e of list) box = box ? unionBox(box, boundsOf(e)) : boundsOf(e);
  return box;
}
