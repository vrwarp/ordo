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
import { parsePathData } from '@ordo/domain/pathdata.ts';
import { type DrawnGeom, type DrawSpec, geomCost } from '@ordo/renderer/geom/cost.ts';
import { type OutlineFields, outlineOf } from '@ordo/renderer/geom/outline.ts';
import { apply, boxPx, decompose, multiply, xfrmAffine } from './frame.ts';
import type { Affine, CustomPaths, Element, Fill, Frame, Line, RectEmu, Rgba, ShapeElement } from './ir.ts';
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

/** The letter and coordinate pairs of a built command. */
function cmdShape(op: number): { letter: string; pairs: number } {
  if (op === CMD_MOVE) return { letter: 'M', pairs: 1 };
  if (op === CMD_LINE) return { letter: 'L', pairs: 1 };
  if (op === CMD_QUAD) return { letter: 'Q', pairs: 2 };
  if (op === CMD_CUBIC) return { letter: 'C', pairs: 3 };
  return { letter: 'Z', pairs: 0 };
}

/**
 * Each command of a built path as `M L Q C Z` text with coordinates times (`kx`, `ky`) at `dec` decimals, and
 * its points as the render clamp counts them (a pair each, 1 for a close).
 */
function commandStrings(p: GeomPath, kx: number, ky: number, dec: number): { s: string; n: number }[] {
  const out: { s: string; n: number }[] = [];
  let at = 0;
  for (const op of p.cmds) {
    const { letter, pairs } = cmdShape(op);
    let s = letter;
    for (let j = 0; j < pairs; j++, at += 2)
      s += ` ${fmt(p.pts[at]! * kx, dec)} ${fmt(p.pts[at + 1]! * ky, dec)}`;
    out.push({ s, n: pairs || 1 });
  }
  return out;
}

/** A built path as `M L Q C Z` with coordinates times (`kx`, `ky`). */
function pathString(p: GeomPath, kx: number, ky: number, dec: number): string {
  return commandStrings(p, kx, ky, dec)
    .map((c) => c.s)
    .join(' ');
}

/**
 * A built path as a chain of path strings (`ShapeGeom.paths[].cont`: the pieces are drawn as the one path
 * they were cut from), each at most `GEOM_LIMITS.points` points and `MAX_PATH_CHARS` characters, at `dec`
 * decimals. Pieces are cut where a sub-path starts, so that each holds whole sub-paths; a sub-path longer
 * than a piece is cut between two of its commands, and the next piece goes on from where it stopped (its
 * first command is not a moveTo). Undefined when it takes more than `room` pieces.
 */
function chainStrings(p: GeomPath, kx: number, ky: number, dec: number, room: number): string[] | undefined {
  const out: string[] = [];
  let piece: string[] = [];
  let chars = 0;
  let points = 0;
  const fits = (n: number, len: number) =>
    points + n <= GEOM_LIMITS.points && chars + (piece.length ? 1 : 0) + len <= MAX_PATH_CHARS;
  const flush = () => {
    if (piece.length) out.push(piece.join(' '));
    piece = [];
    chars = 0;
    points = 0;
  };
  const cmds = commandStrings(p, kx, ky, dec);
  for (let i = 0; i < cmds.length; ) {
    // The sub-path from command i: its points and length.
    let j = i + 1;
    while (j < cmds.length && p.cmds[j] !== CMD_MOVE) j++;
    let n = 0;
    let len = -1;
    for (let k = i; k < j; k++) {
      n += cmds[k]!.n;
      len += cmds[k]!.s.length + 1;
    }
    // A sub-path that fits a piece of its own starts one when it does not fit this one.
    const whole = n <= GEOM_LIMITS.points && len <= MAX_PATH_CHARS;
    if (whole && !fits(n, len)) flush();
    for (let k = i; k < j; k++) {
      const c = cmds[k]!;
      if (!fits(c.n, c.s.length)) flush();
      if (out.length >= room) return undefined;
      chars += (piece.length ? 1 : 0) + c.s.length;
      points += c.n;
      piece.push(c.s);
    }
    i = j;
  }
  flush();
  return out.length <= room ? out : undefined;
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
 * A deck path is stored as one path when it fits the schema (at most `GEOM_LIMITS.points` points and
 * `MAX_PATH_CHARS` characters, with fewer decimals if need be: every build draws it so). Past that it is
 * cut at its sub-paths' starts: into parts whose bounding boxes are disjoint when it can be (each filled on
 * its own draws what the even-odd rule draws together, in every build), else, as a traced outline holding
 * all its holes must be, into a chain of pieces drawn as one path (`cont`; `chainStrings`). Past the paths
 * a geometry keeps, it is over the bounds.
 */
export function customPaths(
  node: XNode,
  w: number,
  h: number,
  s: number,
  rate: (g: DrawnGeom) => number = (g) => geomCost(g.paths),
): CustomPaths {
  const { geom, of, notes, lost } = compiledOf(node);
  const atBox = buildGeom(geom, w, h);
  const bw = atBox.w;
  const bh = atBox.h;
  const out: CustomPaths['paths'] = [];
  let points = 0;
  let over = lost;
  /** Each part in box space (logical px), as the renderer builds the stored paths, for the estimates. */
  const drawn: GeomPath[] = [];
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
  // A joined path past the render clamp's points is split at its sub-paths when no sub-path of one part
  // overlaps one of another (filled apart, they draw what the even-odd rule draws together); else it is
  // stored as a chain below.
  const parts: typeof joined = [];
  for (const j of joined) {
    const split = pointCount(j.path) > GEOM_LIMITS.points ? splitPath(j.path) : undefined;
    if (split) for (const path of split) parts.push({ ...j, path });
    else parts.push(j);
  }
  for (let k = 0; k < parts.length; k++) {
    const { path, pw, ph } = parts[k]!;
    // Every part after this one needs a path of its own.
    const room = GEOM_LIMITS.paths - out.length - (parts.length - k - 1);
    if (room < 1) {
      over = true;
      break;
    }
    // An axis in the box's own units is written in logical px (`s` px per EMU), with its space.
    const kx = pw ? 1 : s;
    const ky = ph ? 1 : s;
    const W = spaceSide(pw || bw * s);
    const H = spaceSide(ph || bh * s);
    const dec0 = decimalsFor(W, H);
    let pieces: string[] | undefined;
    if (pointCount(path) <= GEOM_LIMITS.points) {
      let dec = dec0;
      let d = pathString(path, kx, ky, dec);
      while (d.length > MAX_PATH_CHARS && dec > 0) d = pathString(path, kx, ky, --dec);
      if (d.length <= MAX_PATH_CHARS) pieces = [d];
    }
    for (let dec = dec0; !pieces && dec >= 0; dec--) pieces = chainStrings(path, kx, ky, dec, room);
    if (!pieces) {
      over = true;
      pieces = [''];
    }
    points += pointCount(path);
    // In logical px, as the renderer draws it (renderer geom/cost.ts): each part is one path, as the renderer
    // draws a stored path or a chain of pieces.
    const sx = pw ? (bw * s) / pw : s;
    const sy = ph ? (bh * s) / ph : s;
    drawn.push({ ...path, pts: path.pts.map((v, i) => v * (i % 2 ? sy : sx)) });
    for (let i = 0; i < pieces.length; i++)
      out.push({
        d: pieces[i]!,
        w: W,
        h: H,
        ...(path.fill !== 'norm' ? { fill: path.fill } : {}),
        ...(path.stroke ? {} : { stroke: false }),
        ...(i > 0 ? { cont: true } : {}),
      });
  }
  const fx = (x: number) => (bw > 0 ? x / bw : 0);
  const fy = (y: number) => (bh > 0 ? y / bh : 0);
  const g = { w: bw * s, h: bh * s, paths: drawn };
  return {
    paths: out,
    points,
    fillCost: geomCost(drawn),
    cost: rate(g),
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
    const pairs = cmdShape(op).pairs;
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
 * The geometry an element of a preset draws at a box of `w` x `h` logical px, for its drawing estimate: the
 * preset with its adjust values (as emitted), a rect for one the table does not know.
 */
export function presetDrawn(name: string, adj: [string, number][] | undefined, w: number, h: number) {
  return preset(knownPreset(name) ? name : 'rect', w, h, adjPairs(adj)) ?? preset('rect', w, h, undefined)!;
}

/**
 * The text rectangle of an element's geometry as fractions of its box (l, t, r, b): the preset's or the
 * custom geometry's `a:rect`, evaluated at the element's size; the whole box for a rect or an unknown
 * preset.
 */
export function textRectOf(e: Element): [number, number, number, number] {
  const whole: [number, number, number, number] = [0, 0, 1, 1];
  if (e.kind === 'residual' || e.kind === 'table') return whole;
  if (e.custom) return e.custom.text;
  if (e.geom === 'rect' || !hasPreset(e.geom)) return whole;
  const p = decompose(e.xf);
  const g = preset(e.geom, p.w, p.h, e.adj);
  if (!g || !(g.w > 0) || !(g.h > 0)) return whole;
  return [g.text.l / g.w, g.text.t / g.h, g.text.r / g.w, g.text.b / g.h];
}

/** The connection sites of an element's geometry, as fractions of its box. */
export function sitesOf(e: Element): { x: number; y: number; angle: number }[] {
  if (e.kind === 'residual' || e.kind === 'table') return [];
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
 * built at its own box of `w` x `h` logical px, stored paths in their own spaces (a chain's pieces stay
 * pieces, `cont` kept). Undefined when it has neither (or a preset the table does not know), or when a stored
 * path's string would pass `MAX_PATH_CHARS` at every precision.
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
  const out: CustomPaths['paths'] = [];
  for (const p of g.paths) {
    // Within the schema's characters as `customPaths` writes them: fewer decimals if need be, else none.
    let k = dec;
    let d = transformPathData(p.d, p.w, p.h, map, k);
    while (d.length > MAX_PATH_CHARS && k > 0) d = transformPathData(p.d, p.w, p.h, map, --k);
    if (d.length > MAX_PATH_CHARS) return undefined;
    out.push({ ...p, d, w: W, h: H });
  }
  return out;
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

// ── Merged shapes ───────────────────────────────────────────────────────────────────────────────────────

/** One path of a shape's geometry in the shape's unit square (0..1 x 0..1 is its box), as ordo draws it. */
interface UnitPath {
  /** One letter per command: M, L, Q, C or Z. */
  cmds: string;
  /** Coordinates in the unit square, x y pairs in command order. */
  pts: number[];
  fill: GeomPath['fill'];
  stroke: boolean;
  /** It continues the path before it (a chain's later piece, `ShapeGeom.paths[].cont`). */
  cont?: boolean;
}

/** Coordinate pairs each path command takes. */
const PAIRS: Readonly<Record<string, number>> = Object.assign(Object.create(null), {
  M: 1,
  L: 1,
  Q: 2,
  C: 3,
  Z: 0,
});

/**
 * A shape's geometry as one piece of a merged object (M6, `classify.ts` `shapeRuns`): its paths in its unit
 * square, the most commands and coordinates one of them has (what bounds its string, `mergedChars`), whether
 * a stroked sub-path is left open, and the bounding box of its points in slide EMU.
 */
export interface ShapePiece {
  paths: UnitPath[];
  cmds: number;
  coords: number;
  /**
   * A stroked sub-path is not closed by Z: LibreOffice, and `drawGeom`, stroke such an outline after every
   * other path of the geometry, so in one object it would move above the fill of the pieces over it.
   */
  open: boolean;
  /** The bounding box of its points (control points included) in slide EMU. */
  extent: RectEmu;
}

const pieces = new WeakMap<ShapeElement, ShapePiece | null>();

/**
 * A shape's geometry as ordo draws it, as a `ShapePiece` (`s`: logical px per EMU): a custom geometry's stored
 * paths, else its preset (rect and ellipse included) built at its box in logical px with its adjust values,
 * as the renderer evaluates a stored preset. Undefined for a preset the table does not know, a custom
 * geometry past the bounds, or no path. Memoised per element (one deck has one frame).
 */
export function shapePiece(e: ShapeElement, s: number): ShapePiece | undefined {
  const hit = pieces.get(e);
  if (hit !== undefined) return hit ?? undefined;
  const out = buildPiece(e, s);
  pieces.set(e, out ?? null);
  return out;
}

function buildPiece(e: ShapeElement, s: number): ShapePiece | undefined {
  const paths: UnitPath[] = [];
  if (e.custom) {
    if (e.custom.over) return undefined;
    for (const p of e.custom.paths) {
      const parsed = parsePathData(p.d, GEOM_LIMITS.points);
      const kx = p.w > 0 ? 1 / p.w : 0;
      const ky = p.h > 0 ? 1 / p.h : 0;
      const pts = parsed.pts.map((v, i) => v * (i % 2 === 0 ? kx : ky));
      paths.push({
        cmds: parsed.cmds,
        pts,
        fill: p.fill ?? 'norm',
        stroke: p.stroke !== false,
        ...(p.cont && paths.length ? { cont: true } : {}),
      });
    }
  } else {
    if (e.geom === 'custom' || !hasPreset(e.geom)) return undefined;
    const d = decompose(e.xf);
    // As the renderer draws the stored preset: at the box in logical px, with the stored adjust pairs.
    const g = preset(e.geom, d.w * s, d.h * s, adjPairs(e.adj));
    if (!g) return undefined;
    const kx = g.w > 0 ? 1 / g.w : 0;
    const ky = g.h > 0 ? 1 / g.h : 0;
    for (const p of g.paths) {
      let cmds = '';
      for (const op of p.cmds)
        cmds +=
          op === CMD_MOVE
            ? 'M'
            : op === CMD_LINE
              ? 'L'
              : op === CMD_QUAD
                ? 'Q'
                : op === CMD_CUBIC
                  ? 'C'
                  : 'Z';
      const pts = p.pts.map((v, i) => v * (i % 2 === 0 ? kx : ky));
      paths.push({ cmds, pts, fill: p.fill, stroke: p.stroke });
    }
  }
  if (!paths.length || paths.length > GEOM_LIMITS.paths) return undefined;
  let cmds = 0;
  let coords = 0;
  let open = false;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  // A sub-path with a segment that no Z closes (one ending at its start counts as open: stricter than
  // the drawer's tolerance, which depends on the box). A chain's pieces are one path: a sub-path cut
  // between two pieces goes on in the next one, and the chain is stroked with its first piece's flag.
  let segments = 0;
  let stroke = false;
  for (let k = 0; k < paths.length; k++) {
    const p = paths[k]!;
    cmds = Math.max(cmds, p.cmds.length);
    coords = Math.max(coords, p.pts.length);
    if (!p.cont) stroke = p.stroke;
    for (const c of p.cmds) {
      if (c === 'M') {
        if (segments > 0 && stroke) open = true;
        segments = 0;
      } else if (c === 'Z') segments = 0;
      else segments++;
    }
    if (!paths[k + 1]?.cont) {
      if (segments > 0 && stroke) open = true;
      segments = 0;
    }
    for (let i = 0; i + 1 < p.pts.length; i += 2) {
      const [x, y] = apply(e.xf, p.pts[i]!, p.pts[i + 1]!);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!(x1 >= x0) || !(y1 >= y0)) return undefined;
  return { paths, cmds, coords, open, extent: { x: x0, y: y0, cx: x1 - x0, cy: y1 - y0 } };
}

/**
 * The longest a path string of a merged object can be (`mergedPaths`): its box in slide EMU (`s` logical px
 * per EMU), the bounding box of its pieces' points, and the most commands and coordinates of one path. Each
 * coordinate is written in logical px from the box's corner with the decimals of the box (`decimalsFor`), so
 * it takes at most a sign, the digits of the farthest point and its decimals.
 */
export function mergedChars(box: RectEmu, extent: RectEmu, cmds: number, coords: number, s: number): number {
  const dec = decimalsFor(spaceSide(box.cx * s), spaceSide(box.cy * s));
  const far =
    Math.max(
      Math.abs(extent.x - box.x),
      Math.abs(extent.x + extent.cx - box.x),
      Math.abs(extent.y - box.y),
      Math.abs(extent.y + extent.cy - box.y),
    ) * s;
  if (!Number.isFinite(far) || far > 1e9) return Number.POSITIVE_INFINITY;
  // Rounding can carry into one more digit (999.996 → 1000): count the digits of the next whole number.
  const coord = 1 + String(Math.floor(far) + 1).length + (dec > 0 ? dec + 1 : 0);
  return 2 * cmds + coords * (coord + 1);
}

/**
 * The paths of one object drawing several shapes (M6, `classify.ts` `shapeRuns`): each piece's paths in
 * order, its unit square mapped through its affine `xf` to slide EMU and from there into `box` (slide EMU,
 * unrotated: the object's box), written in that box's logical px (`s` px per EMU) as `ShapeGeom.paths`.
 * The pieces' rotations and flips are in their points, so the object is neither turned nor mirrored.
 */
export function mergedPaths(
  list: readonly { xf: Affine; piece: ShapePiece }[],
  box: RectEmu,
  s: number,
): CustomPaths['paths'] {
  const W = spaceSide(box.cx * s);
  const H = spaceSide(box.cy * s);
  const dec = decimalsFor(W, H);
  const out: CustomPaths['paths'] = [];
  for (const { xf, piece } of list)
    for (const p of piece.paths) {
      const parts: string[] = [];
      let at = 0;
      for (const c of p.cmds) {
        let t = c;
        for (let j = 0; j < (PAIRS[c] ?? 0); j++, at += 2) {
          const [x, y] = apply(xf, p.pts[at] ?? 0, p.pts[at + 1] ?? 0);
          t += ` ${fmt((x - box.x) * s, dec)} ${fmt((y - box.y) * s, dec)}`;
        }
        parts.push(t);
      }
      out.push({
        d: parts.join(' '),
        w: W,
        h: H,
        ...(p.fill !== 'norm' ? { fill: p.fill } : {}),
        ...(p.stroke ? {} : { stroke: false }),
        ...(p.cont ? { cont: true } : {}),
      });
    }
  return out;
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
 *
 * A `rotWithShape="0"` gradient (`fill.fixed`) is turned back so that it lands where LibreOffice draws it
 * (oox `FillProperties::pushToPropMap`): mirrored by the element's own flips (flipH: 180 − θ, flipV: −θ)
 * and not turned. `mirrored`: the box is drawn mirrored (`ShapeObject.flipH`, the element's affine a
 * reflection), whose drawer paints a box-space angle θb at 180 − θb + rotation on the slide (θb + rotation
 * otherwise); `flips`: the element's own `a:xfrm` flips (`ownFlipH`, `ownFlipV`).
 */
export function gradientOf(
  fill: Fill,
  rotation: number,
  log?: (msg: string) => void,
  over?: (c: Rgba) => Rgba,
  mirrored = false,
  flips: { h?: boolean; v?: boolean } = {},
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
  if (fill.fixed) {
    // Where LibreOffice draws it on the slide, then that angle in the box as the drawer places it.
    let page = angle;
    if (flips.h) page = 180 - page;
    if (flips.v) page = -page;
    angle = mirrored ? 180 - page + rotation : page - rotation;
  }
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

// ── What a shape draws, for its drawing estimate ─────────────────────────────────────────────────────────

/** A length in EMU as logical px within 0..500 (the bound `emit.ts` writes widths and effect radii with). */
function px500(f: Frame, emu: number): number {
  const v = emu * f.s;
  return Number.isFinite(v) ? Math.min(500, Math.max(0, v)) : 0;
}

/** A line width in logical px as emitted: PowerPoint draws a zero-width line one device pixel wide. */
export function lineWidthPx(f: Frame, w: number): number {
  const v = Math.max(w * f.s, 0.5);
  return Number.isFinite(v) ? Math.min(500, v) : 0.5;
}

/** The outline fields an element's line is emitted with (`emit.ts`: width, dash, joins, caps, arrowheads). */
export function outlineFields(f: Frame, line: Line | undefined): OutlineFields {
  if (!line) return {};
  const dash = dashOf(line);
  const ends = endsOf(line);
  return {
    stroke: { width: lineWidthPx(f, line.width) },
    ...(dash ? { dash } : {}),
    ...(line.join === 'round' || line.join === 'bevel' ? { lineJoin: line.join } : {}),
    ...(line.cap === 'round' || line.cap === 'square' ? { lineCap: line.cap } : {}),
    ...(ends ? { ends } : {}),
  };
}

/**
 * What an element's shape object draws (renderer `geom/cost.ts` `DrawSpec`), as `emit.ts` emits it: a fill
 * when it has one a colour or gradient can draw, its outline, and its effects in logical px.
 */
export function drawSpecOf(
  f: Frame,
  e: { fill?: Fill; line?: Line; shadow?: { blur: number }; glow?: { radius: number }; softEdge?: number },
  xf?: Affine,
): DrawSpec {
  const glow = e.glow ? px500(f, e.glow.radius) : 0;
  const soft = e.softEdge ? px500(f, e.softEdge) : 0;
  const fill = e.fill;
  const filled = !!fill && fill.kind !== 'none' && fill.kind !== 'picture' && fill.kind !== 'group';
  // How the emitted fill paints (`emit.ts`: a gradient, else its colour; a pattern as its blended colour).
  const paint =
    fill?.kind === 'gradient'
      ? { gradient: true, translucent: !fill.stops.length || fill.stops.some((s) => !(s.color.a >= 1)) }
      : fill?.kind === 'solid'
        ? { translucent: !(fill.color.a >= 1) }
        : fill?.kind === 'pattern'
          ? { translucent: !(fill.fg.a >= 1 && fill.bg.a >= 1) }
          : undefined;
  return {
    fill: filled,
    ...(paint ? { paint } : {}),
    // Where it lands on the slide, as emitted (`boxPx`; a flip is the x axis turned, `decompose`): painted
    // areas are cut to the canvas as the drawers' estimate cuts them.
    ...(xf ? { place: { box: boxPx(f, xf), flipH: decompose(xf).flipH } } : {}),
    outline: outlineOf(outlineFields(f, e.line)),
    ...(e.shadow ? { shadow: true, shadowBlur: px500(f, e.shadow.blur) } : {}),
    ...(glow > 0 ? { glow } : {}),
    ...(soft > 0 ? { softEdge: soft } : {}),
  };
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
 * at adj1 −24,700,009), which re-placing would flatten. SmartArt drawings (`smartart.ts`) and tables
 * (`tables.ts`) are no glue targets, and a drawing's own connectors stay as drawn: their elements carry their
 * graphic frame's id, not a shape's of their own, and a table's rows grow to their text when drawn, so an end
 * glued to either keeps its stored geometry, as it did while both were residual.
 */
export function placeConnectors(elements: Element[]): void {
  let byId: Map<string, Element> | undefined;
  for (const e of elements) {
    if (e.kind !== 'shape' || !e.cxn || (!e.cxn.start && !e.cxn.end) || e.diagram !== undefined) continue;
    if (!byId) {
      byId = new Map();
      for (const t of elements) {
        const key = `${t.from} ${t.shapeId}`;
        if (t.kind === 'residual' || t.kind === 'table' || t.diagram !== undefined || byId.has(key)) continue;
        byId.set(key, t);
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
