/**
 * Shape geometry, gradients, line styles and connector placement for ordo's M6 fields (design/27 §3.1
 * `ShapeGeom`, `Gradient`, `ShapeObject` and `ImageObject.mask`; §4 "Simple shapes", "Groups"; §12 bounds).
 *
 * - **Presets** stay presets: `a:prstGeom prst` and its `a:avLst` pairs become `ShapeGeom { preset, adj }`,
 *   evaluated by the renderer at draw time, so a resize keeps the corners. A name the preset table does not
 *   know is drawn as its rectangle (noted).
 * - **Custom geometry** (`a:custGeom`) is read here as strings (bounded scans), compiled and built with the
 *   renderer's own geometry engine (`@ordo/renderer/geom`: POI 5.2.5 semantics, the same code that draws the
 *   presets) and written as `ShapeGeom.paths`: each path an `M L Q C Z` string in its own space, the deck's
 *   `w`/`h` when it has them (POI evaluates its guides there), else the shape's box in logical px. Arcs are
 *   cubic segments already. What the compiler replaced by 0 or dropped is noted; a geometry that lost guides,
 *   paths or points to the bounds, or whose strings pass the schema's 40,000 characters, is not drawn
 *   natively (`CustomPaths.over`: LibreOffice draws it).
 * - **Text rectangles** of every preset and custom geometry (`a:rect`), and **connection sites** (`a:cxnLst`),
 *   as fractions of the box.
 * - **Gradients** (`a:gradFill`): linear by angle (degrees clockwise in the box's own frame; `scaled="1"`
 *   taken in the unit square and scaled with the box, as PowerPoint draws it; `rotWithShape="0"` turned back
 *   by the shape's rotation), path gradients radial from the centre of their `a:fillToRect` (`rect` and
 *   `shape` paths noted as radial).
 * - **Lines**: `a:prstDash` to the nearest of ordo's dashes and `a:custDash` to the nearest by its lengths
 *   (noted), `a:headEnd`/`a:tailEnd` types (sizes other than medium noted).
 * - **Connectors** (`p:cxnSp`): an end glued to a shape (`a:stCxn`, `a:endCxn`) is moved to that shape's
 *   connection site, keeping the connector's rotation; an end that names no shape on the slide, or a site
 *   the shape does not have, keeps the stored geometry.
 *
 * Everything is pure and bounded: deck strings are cut before they reach the compiler (which bounds them
 * again), lists are scanned for at most a few times their bound, and each custom geometry node is compiled
 * once per deck (memoised).
 *
 * M6 wave 2, item B (converter-geom).
 */
import {
  compileGeom,
  type GeomSource,
  type GuidePairs,
  newGeomNotes,
  type PathCmdSource,
  type PathSource,
  type SiteSource,
} from '@ordo/renderer/geom/compile.ts';
import {
  CMD_CLOSE,
  CMD_CUBIC,
  CMD_LINE,
  CMD_MOVE,
  CMD_QUAD,
  type CompiledGeom,
  GEOM_LIMITS,
} from '@ordo/renderer/geom/ops.ts';
import {
  type BuiltGeom,
  buildGeom,
  type GeomPath,
  hasPreset,
  presetGeometry,
} from '@ordo/renderer/geom/path.ts';
import { apply, decompose, multiply, xfrmAffine } from './frame.ts';
import type { Affine, CustomPaths, Element, Fill, Line, Rgba } from './ir.ts';
import { clean } from './log.ts';
import { child, type XNode } from './xml.ts';

/** Longest path string the schema keeps (`ShapeGeom.paths[].d`). */
export const MAX_PATH_CHARS = 40_000;
/** Path points per slide (design/27 §12: 4,096 per path, 64k per slide). */
export const MAX_SLIDE_PATH_POINTS = 65_536;
/** `ShapeGeom.adj` pairs the schema keeps. */
const MAX_ADJ_PAIRS = 10;
/** Children of one list scanned at most, as a multiple of what the list may hold. */
const SCAN_FACTOR = 4;
/** Notes kept per custom geometry. */
const MAX_NOTES = 8;

// ── Reading a:custGeom ──────────────────────────────────────────────────────────────────────────────────

/**
 * An attribute as the compiler reads it, cut one character past the compiler's own bound so the bound still
 * applies (a name over `GEOM_LIMITS.name` binds nothing, a formula over `GEOM_LIMITS.formula` is 0) while a
 * deck's 7-million-character attribute costs nothing.
 */
const cut = (v: string | undefined, limit: number = GEOM_LIMITS.formula) =>
  v === undefined ? undefined : v.length > limit + 1 ? v.slice(0, limit + 1) : v;

function guideList(list: XNode | undefined): GuidePairs {
  const out: [string, string][] = [];
  const kids = list?.children ?? [];
  const scan = Math.min(kids.length, SCAN_FACTOR * GEOM_LIMITS.guides);
  for (let i = 0; i < scan && out.length <= GEOM_LIMITS.guides; i++) {
    const gd = kids[i]!;
    if (gd.name !== 'a:gd') continue;
    out.push([cut(gd.attrs.name, GEOM_LIMITS.name) ?? '', cut(gd.attrs.fmla) ?? '']);
  }
  return out;
}

/** Points a command costs (the compiler's count: an arcTo is the 12 points of four cubic segments). */
const COST: Readonly<Record<string, number>> = Object.assign(Object.create(null), {
  'a:moveTo': 1,
  'a:lnTo': 1,
  'a:close': 1,
  'a:quadBezTo': 2,
  'a:cubicBezTo': 3,
  'a:arcTo': 12,
});

function ptArgs(c: XNode, n: number): string[] {
  const args: string[] = [];
  for (const p of c.children) {
    if (p.name !== 'a:pt') continue;
    args.push(cut(p.attrs.x) ?? '0', cut(p.attrs.y) ?? '0');
    if (args.length >= 2 * n) break;
  }
  return args;
}

/** One command of an `a:path` as the compiler reads it, or undefined for another element. */
function readCmd(c: XNode): PathCmdSource | undefined {
  switch (c.name) {
    case 'a:moveTo':
    case 'a:lnTo':
      return { op: c.name.slice(2), args: ptArgs(c, 1) };
    case 'a:arcTo':
      return {
        op: 'arcTo',
        args: [
          cut(c.attrs.wR) ?? '0',
          cut(c.attrs.hR) ?? '0',
          cut(c.attrs.stAng) ?? '0',
          cut(c.attrs.swAng) ?? '0',
        ],
      };
    case 'a:quadBezTo':
      return { op: 'quadBezTo', args: ptArgs(c, 2) };
    case 'a:cubicBezTo':
      return { op: 'cubicBezTo', args: ptArgs(c, 3) };
    case 'a:close':
      return { op: 'close', args: [] };
    default:
      return undefined;
  }
}

/**
 * An `a:path` as one or more compiler paths: the compiler bounds a path's cost at `GEOM_LIMITS.points`,
 * counting each arcTo as the 12 points of a full turn, so a long path is cut into chunks at its sub-paths'
 * starts (moveTo) and built in pieces; `customPaths` joins the pieces back into one stored path when the
 * points it really has fit (holes keep their outlines' fill rule). A single sub-path over the bound stays one
 * chunk, which the compiler cuts (and notes). At most `budget` points of cost are read.
 */
function readPath(p: XNode, budget: number): PathSource[] {
  const chunks: PathCmdSource[][] = [[]];
  let chunkCost = 0;
  let total = 0;
  let sub: PathCmdSource[] = [];
  let subCost = 0;
  const flush = () => {
    if (!sub.length) return;
    if (chunkCost > 0 && chunkCost + subCost > GEOM_LIMITS.points) {
      chunks.push([]);
      chunkCost = 0;
    }
    chunks[chunks.length - 1]!.push(...sub);
    chunkCost += subCost;
    sub = [];
    subCost = 0;
  };
  const kids = p.children;
  const scan = Math.min(kids.length, SCAN_FACTOR * budget);
  // One command past the budget is read, so the compiler notes that points were dropped.
  for (let i = 0; i < scan && total <= budget; i++) {
    const c = kids[i]!;
    const cost = COST[c.name];
    if (cost === undefined) continue;
    const cmd = readCmd(c);
    if (!cmd) continue;
    if (cmd.op === 'moveTo') flush();
    total += cost;
    sub.push(cmd);
    subCost += cost;
  }
  flush();
  const a = p.attrs;
  const attr = (k: string) => cut(a[k], 64);
  return chunks.map((cmds) => {
    const out: { -readonly [K in keyof PathSource]: PathSource[K] } = { cmds };
    if (a.w !== undefined) out.w = attr('w');
    if (a.h !== undefined) out.h = attr('h');
    if (a.fill !== undefined) out.fill = attr('fill');
    if (a.stroke !== undefined) out.stroke = attr('stroke');
    if (a.extrusionOk !== undefined) out.extrusionOk = attr('extrusionOk');
    return out;
  });
}

/**
 * An `a:custGeom` as the strings `compileGeom` reads (handles are not read: nothing edits them here), with
 * the `a:path` each compiler path is a chunk of (`readPath`).
 */
export function readCustGeom(node: XNode): GeomSource & { of: number[] } {
  const paths: PathSource[] = [];
  const of: number[] = [];
  const pathKids = child(node, 'a:pathLst')?.children ?? [];
  const pathScan = Math.min(pathKids.length, SCAN_FACTOR * GEOM_LIMITS.paths);
  let deckPaths = 0;
  for (let i = 0; i < pathScan && paths.length <= GEOM_LIMITS.paths; i++) {
    if (pathKids[i]!.name !== 'a:path') continue;
    // Every path may cost up to the bound, and a geometry as much as all of its paths together.
    const left = (GEOM_LIMITS.paths - paths.length) * GEOM_LIMITS.points;
    for (const chunk of readPath(pathKids[i]!, Math.max(GEOM_LIMITS.points, left))) {
      paths.push(chunk);
      of.push(deckPaths);
    }
    deckPaths++;
  }
  const sites: SiteSource[] = [];
  const cxnKids = child(node, 'a:cxnLst')?.children ?? [];
  const cxnScan = Math.min(cxnKids.length, SCAN_FACTOR * GEOM_LIMITS.sites);
  for (let i = 0; i < cxnScan && sites.length <= GEOM_LIMITS.sites; i++) {
    const c = cxnKids[i]!;
    if (c.name !== 'a:cxn') continue;
    const pos = child(c, 'a:pos');
    sites.push({ ang: cut(c.attrs.ang) ?? '0', x: cut(pos?.attrs.x) ?? '0', y: cut(pos?.attrs.y) ?? '0' });
  }
  const r = child(node, 'a:rect')?.attrs;
  const out: { -readonly [K in keyof GeomSource]: GeomSource[K] } & { of: number[] } = {
    av: guideList(child(node, 'a:avLst')),
    gd: guideList(child(node, 'a:gdLst')),
    paths,
    sites,
    of,
  };
  if (r) out.rect = { l: cut(r.l), t: cut(r.t), r: cut(r.r), b: cut(r.b) };
  return out;
}

/**
 * Compiler notes that mean part of the drawing was dropped (it is then not drawn natively). Guides past the
 * bound are not among them: a path that reads one notes an unknown name, read as 0 like any other.
 */
const LOST = /paths over the limit|path points over the limit/;

interface Compiled {
  geom: CompiledGeom;
  /** The deck path each compiled path is a chunk of. */
  of: number[];
  notes: string[];
  lost: boolean;
}

/** Each `a:custGeom` compiled once per deck: an inherited one is used by every inheriting shape. */
const compiledCache = new WeakMap<XNode, Compiled>();

function compiledOf(node: XNode): Compiled {
  let c = compiledCache.get(node);
  if (c) return c;
  const notes = newGeomNotes();
  const src = readCustGeom(node);
  const geom = compileGeom(src, notes);
  const messages = notes.messages.slice(0, MAX_NOTES).map((m) => clean(m, 120));
  c = { geom, of: src.of, notes: messages, lost: notes.messages.some((m) => LOST.test(m)) };
  compiledCache.set(node, c);
  return c;
}

// ── Path strings ────────────────────────────────────────────────────────────────────────────────────────

/** A coordinate with `dec` decimals, no trailing zeros, never `-0`. */
function fmt(v: number, dec: number): string {
  const r = Number(v.toFixed(dec)) + 0;
  return Object.is(r, -0) ? '0' : String(r);
}

/** A built path as `M L Q C Z` with coordinates times (`kx`, `ky`). */
function pathString(p: GeomPath, kx: number, ky: number, dec: number): string {
  const out: string[] = [];
  let at = 0;
  for (const op of p.cmds) {
    const pairs = op === CMD_QUAD ? 2 : op === CMD_CUBIC ? 3 : op === CMD_CLOSE ? 0 : 1;
    const letter =
      op === CMD_MOVE ? 'M' : op === CMD_LINE ? 'L' : op === CMD_QUAD ? 'Q' : op === CMD_CUBIC ? 'C' : 'Z';
    let s = letter;
    for (let j = 0; j < pairs; j++, at += 2)
      s += ` ${fmt(p.pts[at]! * kx, dec)} ${fmt(p.pts[at + 1]! * ky, dec)}`;
    out.push(s);
  }
  return out.join(' ');
}

/** Decimals that keep a coordinate within about 1/20,000 of its space. */
function decimalsFor(w: number, h: number): number {
  const span = Math.max(w, h, 1e-9);
  return Math.max(0, Math.min(4, Math.ceil(Math.log10(20_000 / span))));
}

/** A path space side: positive and within the schema's bound. */
function spaceSide(v: number): number {
  return v > 0 && Number.isFinite(v) ? Math.min(v, 1e9) : 1;
}

/**
 * A custom geometry built for a box of `w` x `h` EMU (`s`: logical px per EMU): paths in their own spaces
 * (the deck's `w`/`h`, else the box in logical px), the text rectangle and sites as fractions of the box.
 */
export function customPaths(node: XNode, w: number, h: number, s: number): CustomPaths {
  const { geom, of, notes, lost } = compiledOf(node);
  const atBox = buildGeom(geom, w, h);
  const bw = atBox.w;
  const bh = atBox.h;
  const out: CustomPaths['paths'] = [];
  let points = 0;
  let over = lost;
  const built = new Map<string, BuiltGeom>();
  /** Each deck path joined from its chunks, built in its space. */
  const joined: { path: GeomPath; pw: number; ph: number }[] = [];
  for (let i = 0; i < geom.p.length && i < GEOM_LIMITS.paths; i++) {
    const cp = geom.p[i]!;
    const pw = cp.w !== undefined && cp.w > 0 ? cp.w : 0;
    const ph = cp.h !== undefined && cp.h > 0 ? cp.h : 0;
    let path: GeomPath | undefined;
    if (pw || ph) {
      // Built in its own space (POI evaluates the path's guides at a box of that size): scale 1.
      const key = `${pw || bw} ${ph || bh}`;
      let g = built.get(key);
      if (!g) built.set(key, (g = buildGeom(geom, pw || bw, ph || bh)));
      path = g.paths[i];
    } else path = atBox.paths[i];
    if (!path) continue;
    const prev = joined[joined.length - 1];
    if (i > 0 && of[i] !== undefined && of[i] === of[i - 1] && prev) {
      prev.path = {
        ...prev.path,
        cmds: [...prev.path.cmds, ...path.cmds],
        pts: [...prev.path.pts, ...path.pts],
      };
    } else joined.push({ path, pw, ph });
  }
  // A joined path past the render clamp's points is split at its sub-paths, when no sub-path of one part
  // overlaps one of another (filled apart, they draw what the even-odd rule draws together); else, or past
  // the paths a geometry keeps, it is not drawn natively.
  const parts: typeof joined = [];
  for (const j of joined) {
    if (pointCount(j.path) <= GEOM_LIMITS.points) parts.push(j);
    else {
      const split = splitPath(j.path);
      if (split) for (const path of split) parts.push({ ...j, path });
      else {
        over = true;
        parts.push(j);
      }
    }
  }
  if (parts.length > GEOM_LIMITS.paths) over = true;
  for (const { path, pw, ph } of parts.slice(0, GEOM_LIMITS.paths)) {
    // An axis in the box's own units is written in logical px (`s` px per EMU), with its space.
    const kx = pw ? 1 : s;
    const ky = ph ? 1 : s;
    const W = spaceSide(pw || bw * s);
    const H = spaceSide(ph || bh * s);
    let dec = decimalsFor(W, H);
    let d = pathString(path, kx, ky, dec);
    while (d.length > MAX_PATH_CHARS && dec > 0) d = pathString(path, kx, ky, --dec);
    if (d.length > MAX_PATH_CHARS) over = true;
    points += pointCount(path);
    out.push({
      d: d.length > MAX_PATH_CHARS ? '' : d,
      w: W,
      h: H,
      ...(path.fill !== 'norm' ? { fill: path.fill } : {}),
      ...(path.stroke ? {} : { stroke: false }),
    });
  }
  const fx = (x: number) => (bw > 0 ? x / bw : 0);
  const fy = (y: number) => (bh > 0 ? y / bh : 0);
  return {
    paths: out,
    points,
    text: [fx(atBox.text.l), fy(atBox.text.t), fx(atBox.text.r), fy(atBox.text.b)],
    sites: atBox.sites.map((p) => ({ x: fx(p.x), y: fy(p.y), angle: p.angle })),
    ...(over ? { over: true } : {}),
    notes,
  };
}

/** A built path's points as the render clamp counts them: each coordinate pair, and each close. */
export function pointCount(path: GeomPath): number {
  let n = path.pts.length / 2;
  for (const op of path.cmds) if (op === CMD_CLOSE) n++;
  return n;
}

/** Sub-path pairs compared at most when a path is split (`splitPath`). */
const MAX_SPLIT_PAIRS = 4_000_000;

/**
 * A built path cut at its sub-paths' starts into parts of at most `GEOM_LIMITS.points` points each, or
 * undefined when a sub-path alone is over that, or when a sub-path of one part overlaps (by bounding box)
 * a sub-path of another: even-odd holes stay with their outlines.
 */
export function splitPath(path: GeomPath): GeomPath[] | undefined {
  // Sub-paths: [first command, end command, first coordinate, end coordinate) and their bounding boxes.
  const subs: { c0: number; c1: number; p0: number; p1: number; box: [number, number, number, number] }[] =
    [];
  let at = 0;
  for (let i = 0; i < path.cmds.length; i++) {
    const op = path.cmds[i]!;
    if (op === CMD_MOVE || subs.length === 0)
      subs.push({ c0: i, c1: i, p0: at, p1: at, box: [Infinity, Infinity, -Infinity, -Infinity] });
    const sub = subs[subs.length - 1]!;
    const pairs = op === CMD_QUAD ? 2 : op === CMD_CUBIC ? 3 : op === CMD_CLOSE ? 0 : 1;
    for (let j = 0; j < pairs; j++, at += 2) {
      const x = path.pts[at]!;
      const y = path.pts[at + 1]!;
      sub.box = [
        Math.min(sub.box[0], x),
        Math.min(sub.box[1], y),
        Math.max(sub.box[2], x),
        Math.max(sub.box[3], y),
      ];
    }
    sub.c1 = i + 1;
    sub.p1 = at;
  }
  if (subs.length * subs.length > MAX_SPLIT_PAIRS) return undefined;
  const part: number[] = [];
  let k = 0;
  let points = 0;
  for (const sub of subs) {
    let n = (sub.p1 - sub.p0) / 2;
    for (let c = sub.c0; c < sub.c1; c++) if (path.cmds[c] === CMD_CLOSE) n++;
    if (n > GEOM_LIMITS.points) return undefined;
    if (points + n > GEOM_LIMITS.points) {
      k++;
      points = 0;
    }
    points += n;
    part.push(k);
  }
  const meets = (a: [number, number, number, number], b: [number, number, number, number]) =>
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  for (let i = 0; i < subs.length; i++)
    for (let j = i + 1; j < subs.length; j++)
      if (part[i] !== part[j] && meets(subs[i]!.box, subs[j]!.box)) return undefined;
  const out: GeomPath[] = [];
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i]!;
    let p = out[part[i]!];
    if (!p) out[part[i]!] = p = { cmds: [], pts: [], fill: path.fill, stroke: path.stroke };
    (p.cmds as number[]).push(...path.cmds.slice(sub.c0, sub.c1));
    (p.pts as number[]).push(...path.pts.slice(sub.p0, sub.p1));
  }
  return out;
}

// ── Presets ─────────────────────────────────────────────────────────────────────────────────────────────

/** Whether ordo's preset table draws `name` (one of the 187 presets of POI 5.2.5). */
export function knownPreset(name: string): boolean {
  return hasPreset(name);
}

/** A preset built at a box of `w` x `h` (any unit), or undefined for a name the table does not know. */
function preset(name: string, w: number, h: number, adj: readonly [string, number][] | undefined) {
  return presetGeometry(name, w, h, adj);
}

/**
 * The text rectangle of an element's geometry as fractions of its box (l, t, r, b): the preset's or the
 * custom geometry's `a:rect`, evaluated at the element's size; the whole box for a rect or an unknown
 * preset.
 */
export function textRectOf(e: Element): [number, number, number, number] {
  const whole: [number, number, number, number] = [0, 0, 1, 1];
  if (e.kind === 'residual') return whole;
  if (e.custom) return e.custom.text;
  if (e.geom === 'rect' || !hasPreset(e.geom)) return whole;
  const p = decompose(e.xf);
  const g = preset(e.geom, p.w, p.h, e.adj);
  if (!g || !(g.w > 0) || !(g.h > 0)) return whole;
  return [g.text.l / g.w, g.text.t / g.h, g.text.r / g.w, g.text.b / g.h];
}

/** The connection sites of an element's geometry, as fractions of its box. */
export function sitesOf(e: Element): { x: number; y: number; angle: number }[] {
  if (e.kind === 'residual') return [];
  if (e.custom) return e.custom.sites;
  const p = decompose(e.xf);
  const g = preset(e.geom, p.w, p.h, e.adj) ?? preset('rect', p.w, p.h, undefined);
  if (!g) return [];
  return g.sites.map((s) => ({ x: g.w > 0 ? s.x / g.w : 0, y: g.h > 0 ? s.y / g.h : 0, angle: s.angle }));
}

/**
 * The outline of a preset as points in slide EMU, one list per sub-path, with whether each is curved: for
 * connectors and lines, whose route is drawn as a path (`emit.ts`). Cubic and quadratic control points are
 * kept in order with their commands.
 */
export function presetRoute(
  name: string,
  adj: [string, number][] | undefined,
  xf: Affine,
): { cmds: number[]; pts: number[] }[] | undefined {
  const p = decompose(xf);
  const g = preset(name, p.w, p.h, adj);
  if (!g) return undefined;
  return g.paths
    .filter((path) => path.stroke)
    .map((path) => {
      const pts: number[] = [];
      for (let i = 0; i < path.pts.length; i += 2) {
        const [x, y] = apply(xf, g.w > 0 ? path.pts[i]! / g.w : 0, g.h > 0 ? path.pts[i + 1]! / g.h : 0);
        pts.push(x, y);
      }
      return { cmds: [...path.cmds], pts };
    });
}

/** The inverse of an affine, or undefined when it is singular. */
export function invert(m: Affine): Affine | undefined {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12 * (Math.abs(a * d) + Math.abs(b * c) + 1e-300))
    return undefined;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Where a shape's picture fill is drawn (as LibreOffice 24.2 draws it, verified with probe decks): never
 * mirrored, whatever flips the shape or its groups have, and square to the nearest quarter turn of the shape:
 * the mirror-free rotation ρ is drawn as ρ − 90k (k the nearest whole number of quarter turns), the box's sides
 * swapped when k is odd, so a shape turned 170° shows its picture upright, turned −10°, and one turned 90° shows
 * it upright in the tall box. `xf` is the picture's unit square on the slide; `t` takes the shape's unit square
 * into the picture's (the clip geometry's mirror and turn there).
 */
export function pictureFillPlacement(m: Affine): { xf: Affine; t: Affine } {
  const n = m[0] * m[3] - m[1] * m[2] < 0 ? multiply(m, [-1, 0, 0, 1, 1, 0]) : m;
  const p = decompose(n);
  const k = Math.round(p.rot / 90);
  const swap = Math.abs(k) % 2 === 1;
  const w = swap ? p.h : p.w;
  const h = swap ? p.w : p.h;
  const xf = xfrmAffine({
    x: p.cx - w / 2,
    y: p.cy - h / 2,
    cx: w,
    cy: h,
    rot: p.rot - 90 * k,
    flipH: false,
    flipV: false,
  });
  const inv = invert(xf);
  return { xf, t: inv ? multiply(inv, m) : [1, 0, 0, 1, 0, 0] };
}

/**
 * A stored geometry (`ShapeGeom`) as paths after the unit-square affine `t`, in a `w2` x `h2` box: a preset
 * built at its own box of `w` x `h` logical px, stored paths in their own spaces. Undefined when it has neither
 * (or a preset the table does not know).
 */
export function transformedPaths(
  g: { preset?: string; adj?: readonly (readonly [string, number])[]; paths?: CustomPaths['paths'] },
  w: number,
  h: number,
  t: Affine,
  w2: number,
  h2: number,
): CustomPaths['paths'] | undefined {
  const W = spaceSide(w2);
  const H = spaceSide(h2);
  const dec = decimalsFor(W, H);
  const map = (u: number, v: number): [number, number] => {
    const [x, y] = apply(t, u, v);
    return [x * W, y * H];
  };
  if (g.preset !== undefined) {
    const built = presetGeometry(g.preset, w, h, g.adj);
    if (!built) return undefined;
    return built.paths.map((p) => {
      const pts: number[] = [];
      for (let i = 0; i < p.pts.length; i += 2)
        pts.push(...map(built.w > 0 ? p.pts[i]! / built.w : 0, built.h > 0 ? p.pts[i + 1]! / built.h : 0));
      return {
        d: pathString({ ...p, pts }, 1, 1, dec),
        w: W,
        h: H,
        ...(p.fill !== 'norm' ? { fill: p.fill } : {}),
        ...(p.stroke ? {} : { stroke: false }),
      };
    });
  }
  if (!g.paths?.length) return undefined;
  return g.paths.map((p) => ({ ...p, d: transformPathData(p.d, p.w, p.h, map, dec), w: W, h: H }));
}

/** A path string (`M L Q C Z` and numbers, as `pathString` writes it) in a `w` x `h` space through `map`. */
function transformPathData(
  d: string,
  w: number,
  h: number,
  map: (u: number, v: number) => [number, number],
  dec: number,
): string {
  const out: string[] = [];
  let x: number | undefined;
  for (const t of d.split(' ')) {
    if (t === '') continue;
    if (/^[MLQCZ]$/.test(t)) {
      out.push(t);
      x = undefined;
      continue;
    }
    const v = Number.isFinite(Number(t)) ? Number(t) : 0;
    if (x === undefined) {
      x = v;
      continue;
    }
    const [X, Y] = map(w > 0 ? x / w : 0, h > 0 ? v / h : 0);
    out.push(fmt(X, dec), fmt(Y, dec));
    x = undefined;
  }
  return out.join(' ');
}

/** The `ShapeGeom.adj` pairs of an element: at most the schema's 10, values within ±1e7. */
export function adjPairs(adj: [string, number][] | undefined): [string, number][] | undefined {
  if (!adj?.length) return undefined;
  return adj
    .slice(0, MAX_ADJ_PAIRS)
    .map(([k, v]) => [k.slice(0, 16), Number.isFinite(v) ? Math.max(-1e7, Math.min(1e7, v)) : 0]);
}

// ── Gradients ───────────────────────────────────────────────────────────────────────────────────────────

/** An ordo `Gradient` (design/27 §3.1), as `@ordo/domain` declares it. */
export interface OrdoGradient {
  kind: 'linear' | 'radial';
  angle?: number;
  scaled?: boolean;
  stops: { at: number; color: Rgba }[];
  center?: { x: number; y: number };
}

const channel = (v: number) => (Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0);
const unit = (v: number, lo = 0, hi = 1) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/**
 * A gradient fill as an ordo `Gradient` for a box turned by `rotation` degrees, or undefined for any other
 * fill: a linear one keeps its angle (in the box's own frame; `scaled` as written, the drawer stretches it
 * with the box; `rotWithShape="0"` turned back by the box's rotation), a path one is radial from the centre
 * of its focus rectangle (`rect` and `shape` paths noted). `over` lays each stop on a colour (backgrounds
 * on white); `log` receives what is approximated.
 */
export function gradientOf(
  fill: Fill,
  rotation: number,
  log?: (msg: string) => void,
  over?: (c: Rgba) => Rgba,
): OrdoGradient | undefined {
  if (fill.kind !== 'gradient' || fill.stops.length < 2) return undefined;
  const stops = fill.stops.slice(0, 16).map((st) => {
    const c = over ? over(st.color) : st.color;
    return {
      at: unit(st.at),
      color: { r: channel(c.r), g: channel(c.g), b: channel(c.b), a: unit(c.a) },
    };
  });
  if (fill.path !== undefined) {
    if (fill.path !== 'circle')
      log?.(`a ${fill.path === 'rect' ? 'rectangular' : 'shape'} gradient is drawn radial`);
    const f = fill.focus ?? { l: 0.5, t: 0.5, r: 0.5, b: 0.5 };
    return {
      kind: 'radial',
      stops,
      center: { x: unit((1 + f.l - f.r) / 2, -1, 1), y: unit((1 + f.t - f.b) / 2, -1, 1) },
    };
  }
  let angle = fill.angle ?? 0;
  if (fill.fixed) angle -= rotation;
  angle = ((angle % 360) + 360) % 360;
  return {
    kind: 'linear',
    angle: Math.round(angle * 1e6) / 1e6,
    ...(fill.scaled ? { scaled: true } : {}),
    stops,
  };
}

// ── Lines ───────────────────────────────────────────────────────────────────────────────────────────────

/** ordo's dashes (`ShapeObject.dash`, OOXML's `prstDash` with `lg` written `long`). */
export type OrdoDash =
  | 'solid'
  | 'dot'
  | 'dash'
  | 'dashDot'
  | 'longDash'
  | 'longDashDot'
  | 'longDashDotDot'
  | 'sysDot'
  | 'sysDash'
  | 'sysDashDot'
  | 'sysDashDotDot';

/** `a:prstDash` → ordo's dash. */
const PRESET_DASH: ReadonlyMap<string, OrdoDash> = new Map([
  ['solid', 'solid'],
  ['dot', 'dot'],
  ['dash', 'dash'],
  ['lgDash', 'longDash'],
  ['dashDot', 'dashDot'],
  ['lgDashDot', 'longDashDot'],
  ['lgDashDotDot', 'longDashDotDot'],
  ['sysDash', 'sysDash'],
  ['sysDot', 'sysDot'],
  ['sysDashDot', 'sysDashDot'],
  ['sysDashDotDot', 'sysDashDotDot'],
]);

/** ordo's dashes as dash/space lengths in line widths (DrawingML's definitions). */
const DASH_PATTERNS: readonly [OrdoDash, readonly number[]][] = [
  ['dot', [1, 3]],
  ['dash', [4, 3]],
  ['longDash', [8, 3]],
  ['sysDot', [1, 1]],
  ['sysDash', [3, 1]],
  ['dashDot', [4, 3, 1, 3]],
  ['longDashDot', [8, 3, 1, 3]],
  ['sysDashDot', [3, 1, 1, 1]],
  ['longDashDotDot', [8, 3, 1, 3, 1, 3]],
  ['sysDashDotDot', [3, 1, 1, 1, 1, 1]],
];

/**
 * The ordo dash nearest to a custom dash (lengths in line widths, pairs flattened): among the patterns with
 * as many dashes (at most three), the nearest by the logarithms of the lengths.
 */
export function nearestDash(ds: readonly number[]): OrdoDash {
  const pairs = Math.min(3, Math.floor(ds.length / 2));
  if (!pairs) return 'solid';
  const v = ds.slice(0, 2 * pairs).map((x) => Math.log(Math.max(0.05, Number.isFinite(x) ? x : 1)));
  let best: OrdoDash = 'dash';
  let bestCost = Number.POSITIVE_INFINITY;
  for (const [name, p] of DASH_PATTERNS) {
    if (p.length !== 2 * pairs) continue;
    let cost = 0;
    for (let i = 0; i < p.length; i++) cost += (v[i]! - Math.log(p[i]!)) ** 2;
    if (cost < bestCost) {
      best = name;
      bestCost = cost;
    }
  }
  return best;
}

/** A line's ordo dash, or undefined for a solid line. */
export function dashOf(line: Line, log?: (msg: string) => void): OrdoDash | undefined {
  if (line.custDash?.length) {
    const d = nearestDash(line.custDash);
    log?.(`a custom dash is drawn as ${d}`);
    return d === 'solid' ? undefined : d;
  }
  if (!line.dash) return undefined;
  const m = PRESET_DASH.get(line.dash);
  if (!m) {
    log?.('an unknown dash is drawn as dash');
    return 'dash';
  }
  return m === 'solid' ? undefined : m;
}

/** An arrowhead (`ShapeObject.ends.head`/`tail`, as `@ordo/domain` `ArrowEnd` declares it). */
export interface OrdoArrowEnd {
  type: 'none' | 'triangle' | 'stealth' | 'arrow' | 'oval' | 'diamond';
  w?: 'sm' | 'med' | 'lg';
  len?: 'sm' | 'med' | 'lg';
}
const ARROW_TYPES: ReadonlySet<string> = new Set(['triangle', 'stealth', 'arrow', 'oval', 'diamond']);
const ARROW_SIZES: ReadonlySet<string> = new Set(['sm', 'med', 'lg']);

function arrowEnd(
  type: string | undefined,
  size: { w: string; len: string } | undefined,
): OrdoArrowEnd | undefined {
  if (!type || !ARROW_TYPES.has(type)) return undefined;
  const out: OrdoArrowEnd = { type: type as OrdoArrowEnd['type'] };
  if (size && ARROW_SIZES.has(size.w) && size.w !== 'med') out.w = size.w as 'sm' | 'lg';
  if (size && ARROW_SIZES.has(size.len) && size.len !== 'med') out.len = size.len as 'sm' | 'lg';
  return out;
}

/** A line's arrowheads (`ShapeObject.ends`: head at the outline's start, tail at its end), or undefined. */
export function endsOf(line: Line): { head?: OrdoArrowEnd; tail?: OrdoArrowEnd } | undefined {
  const head = arrowEnd(line.head, line.headSize);
  const tail = arrowEnd(line.tail, line.tailSize);
  if (!head && !tail) return undefined;
  return { ...(head ? { head } : {}), ...(tail ? { tail } : {}) };
}

// ── Connectors ──────────────────────────────────────────────────────────────────────────────────────────

/** Bound of a connector's site index (`a:stCxn idx`). */
const MAX_SITE_INDEX = GEOM_LIMITS.sites;

/** A connection reference (`a:stCxn`, `a:endCxn`), or undefined when it is not one. */
export function readCxnRef(n: XNode | undefined): { id: number; idx: number } | undefined {
  if (!n) return undefined;
  const id = Number(n.attrs.id);
  const idx = Number(n.attrs.idx ?? '0');
  if (!Number.isInteger(id) || id < 0 || id > 2_147_483_647) return undefined;
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_SITE_INDEX) return undefined;
  return { id, idx };
}

/** Where a site of an element lands on the slide (EMU), or undefined when it has no such site. */
function siteOnSlide(e: Element, idx: number): [number, number] | undefined {
  const site = sitesOf(e)[idx];
  return site ? apply(e.xf, site.x, site.y) : undefined;
}

/**
 * The affine of a connector whose ends move to `start` and `end` (slide EMU), keeping its rotation: the
 * stored affine's axes give the connector's frame, the new ends its signed extents (a negative one is a
 * flip). Undefined when the stored affine has no usable frame.
 */
export function replaceEnds(xf: Affine, start: [number, number], end: [number, number]): Affine | undefined {
  const [a, b, c, d] = xf;
  const lu = Math.hypot(a, b);
  const lv = Math.hypot(c, d);
  // The frame: unit axes along the stored columns; a degenerate column is the other turned a quarter.
  let u: [number, number];
  let v: [number, number];
  if (lu > 0 && lv > 0) {
    u = [a / lu, b / lu];
    v = [c / lv, d / lv];
  } else if (lv > 0) {
    v = [c / lv, d / lv];
    u = [v[1], -v[0]];
  } else if (lu > 0) {
    u = [a / lu, b / lu];
    v = [-u[1], u[0]];
  } else {
    u = [1, 0];
    v = [0, 1];
  }
  if (Math.abs(u[0] * v[0] + u[1] * v[1]) > 1e-6) return undefined; // sheared: keep the stored one
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const sx = dx * u[0] + dy * u[1];
  const sy = dx * v[0] + dy * v[1];
  return [u[0] * sx, u[1] * sx, v[0] * sy, v[1] * sy, start[0], start[1]];
}

/**
 * Glue the slide's connectors to their shapes (design/27 §4; M6): each end that names a shape of the same
 * part (by `cNvPr id`, the first such element) and one of its connection sites moves there. A connector whose
 * ends are where its stored geometry has them already (within 1 % of its length) is left exactly as stored:
 * PowerPoint keeps a routed elbow in a near-zero extent with a huge adjust value (a 1 EMU wide bentConnector3
 * at adj1 −24,700,009), which re-placing would flatten.
 */
export function placeConnectors(elements: Element[]): void {
  let byId: Map<string, Element> | undefined;
  for (const e of elements) {
    if (e.kind !== 'shape' || !e.cxn || (!e.cxn.start && !e.cxn.end)) continue;
    if (!byId) {
      byId = new Map();
      for (const t of elements) {
        const key = `${t.from} ${t.shapeId}`;
        if (t.kind !== 'residual' && !byId.has(key)) byId.set(key, t);
      }
    }
    const at = (ref: { id: number; idx: number } | undefined) => {
      const t = ref ? byId!.get(`${e.from} ${ref.id}`) : undefined;
      return t && t !== e ? siteOnSlide(t, ref!.idx) : undefined;
    };
    const s0 = apply(e.xf, 0, 0);
    const e0 = apply(e.xf, 1, 1);
    const s = at(e.cxn.start) ?? s0;
    const t = at(e.cxn.end) ?? e0;
    const tol = 0.01 * Math.hypot(e0[0] - s0[0], e0[1] - s0[1]) + 1;
    if (Math.hypot(s[0] - s0[0], s[1] - s0[1]) <= tol && Math.hypot(t[0] - e0[0], t[1] - e0[1]) <= tol)
      continue;
    const xf = replaceEnds(e.xf, s, t);
    if (xf) e.xf = xf;
  }
}
