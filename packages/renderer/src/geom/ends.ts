import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from './ops.ts';
import type { GeomPath } from './path.ts';

/*
 * Line ends (design/27 §3.1 `ShapeObject.ends`, §15 M6): arrowheads on open sub-paths as LibreOffice draws
 * the OOXML a:headEnd (at a sub-path's start) and a:tailEnd (at its end), from oox lineproperties.cxx
 * (`lclPushMarkerProperties`) and drawinglayer's `PolygonStrokeArrowPrimitive2D`:
 * - Sizes: width = fW × base and length = fL × base, base = max(line width, 0.7 mm); fW and fL are 2, 3 and 5
 *   for sm, med and lg (2.5, 3.5 and 5.5 for the open 'arrow', whose length is 2.5, 3.5 and 6).
 * - Shapes: LibreOffice's marker polygons in percent of width (x, across) and length (y, back from the
 *   tip): triangle, stealth (notched to 60 %), diamond, oval (12 points), and the open arrow, whose arms and
 *   stem are as thick as the line.
 * - Placement: the tip on the end point, or for oval and diamond the marker's centre, pointing from the
 *   point of the line that lies the marker's consumed length back (length, or half of it when centred) to the
 *   end point.
 * - The shaft is cut back by the consumed length less a fifteenth of the marker width (LibreOffice's overlap,
 *   so a pointed marker meets the shaft without a gap); a sub-path shorter than both ends together draws
 *   its markers only.
 * Closed sub-paths get no ends, as in LibreOffice and PowerPoint. Units are the path's (box space).
 */

export type ArrowKind = 'triangle' | 'stealth' | 'arrow' | 'oval' | 'diamond';
export type ArrowSize = 'sm' | 'med' | 'lg';

/** An arrowhead resolved to box units. */
export interface GeomArrow {
  readonly kind: ArrowKind;
  /** Across the line. */
  readonly width: number;
  /** Along the line. */
  readonly length: number;
  /** The line width it was sized for (the open arrow's arms are that thick). */
  readonly line: number;
}

export interface GeomEnds {
  /** At each open sub-path's start (OOXML headEnd). */
  readonly head?: GeomArrow;
  /** At each open sub-path's end (OOXML tailEnd). */
  readonly tail?: GeomArrow;
}

/** 0.7 mm in logical px (144 px per inch on both standard deck sizes): LibreOffice's smallest marker base. */
export const ARROW_MIN_BASE = (0.7 / 25.4) * 144;

const FACTOR: Readonly<Record<ArrowSize, number>> = { sm: 2, med: 3, lg: 5 };
const OPEN_WIDTH: Readonly<Record<ArrowSize, number>> = { sm: 2.5, med: 3.5, lg: 5.5 };
const OPEN_LENGTH: Readonly<Record<ArrowSize, number>> = { sm: 2.5, med: 3.5, lg: 6 };

function sizeOf(v: unknown): ArrowSize {
  return v === 'sm' || v === 'lg' ? v : 'med';
}

/**
 * An arrowhead for a line of `lineWidth` box units (`minBase`: LibreOffice's 0.7 mm in the same units), or
 * undefined for none. Unknown sizes are 'med'.
 */
export function arrowFor(
  kind: string | undefined,
  w: unknown,
  len: unknown,
  lineWidth: number,
  minBase: number = ARROW_MIN_BASE,
): GeomArrow | undefined {
  if (kind !== 'triangle' && kind !== 'stealth' && kind !== 'arrow' && kind !== 'oval' && kind !== 'diamond')
    return undefined;
  const line = Number.isFinite(lineWidth) && lineWidth > 0 ? lineWidth : 0;
  const base = Math.max(line, Number.isFinite(minBase) && minBase > 0 ? minBase : 0);
  if (!(base > 0)) return undefined;
  const open = kind === 'arrow';
  const fw = (open ? OPEN_WIDTH : FACTOR)[sizeOf(w)];
  const fl = (open ? OPEN_LENGTH : FACTOR)[sizeOf(len)];
  return { kind, width: fw * base, length: fl * base, line };
}

/** Whether an arrowhead is centred on the end point (oval and diamond) rather than ending at its tip. */
export function arrowCentred(a: GeomArrow): boolean {
  return a.kind === 'oval' || a.kind === 'diamond';
}

/** The marker polygon in percent: x across the width (0..100), y back from the tip (0..100). */
function markerPercent(a: GeomArrow): number[] {
  switch (a.kind) {
    case 'triangle':
      return [50, 0, 100, 100, 0, 100];
    case 'stealth':
      return [50, 0, 100, 100, 50, 60, 0, 100];
    case 'diamond':
      return [50, 0, 100, 50, 50, 100, 0, 50];
    case 'oval':
      return [50, 0, 75, 7, 93, 25, 100, 50, 93, 75, 75, 93, 50, 100, 25, 93, 7, 75, 0, 50, 7, 25, 25, 7];
    default: {
      // tdf#100491: the open arrow's arms and stem are as thick as the line.
      const h = Math.max((100 * 0.5 * a.line) / a.width, 1);
      return [
        50,
        0,
        100,
        100 - h * 1.5,
        100 - h * 1.5,
        100,
        50 + h,
        5.5 * h,
        50 + h,
        100,
        50 - h,
        100,
        50 - h,
        5.5 * h,
        h * 1.5,
        100,
        0,
        100 - h * 1.5,
      ];
    }
  }
}

/** One segment of a sub-path: its start, its control points (none, one or two) and its end. */
interface Segment {
  readonly kind: number;
  /** x y pairs: start, controls, end. */
  readonly p: number[];
}

/** A sub-path as segments, and whether it is closed (by a close command, or ending where it starts). */
interface SubPath {
  readonly segments: Segment[];
  readonly closed: boolean;
}

function subPaths(path: GeomPath): SubPath[] {
  const out: SubPath[] = [];
  const p = path.pts;
  let at = 0;
  let segs: Segment[] = [];
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  let started = false;
  const end = (closed: boolean): void => {
    if (segs.length) out.push({ segments: segs, closed });
    segs = [];
  };
  for (const op of path.cmds) {
    if (op === CMD_MOVE) {
      if (started) end(false);
      sx = cx = p[at]!;
      sy = cy = p[at + 1]!;
      at += 2;
      started = true;
    } else if (op === CMD_CLOSE) {
      end(true);
      cx = sx;
      cy = sy;
    } else {
      const n = op === CMD_LINE ? 2 : op === CMD_QUAD ? 4 : op === CMD_CUBIC ? 6 : 0;
      if (n === 0) continue;
      const pts = [cx, cy];
      for (let k = 0; k < n; k++) pts.push(p[at + k]!);
      at += n;
      segs.push({ kind: op, p: pts });
      cx = pts[pts.length - 2]!;
      cy = pts[pts.length - 1]!;
    }
  }
  end(false);
  return out;
}

/** The point of a segment at parameter t. */
function pointAt(s: Segment, t: number): [number, number] {
  const p = s.p;
  const u = 1 - t;
  if (s.kind === CMD_LINE) return [u * p[0]! + t * p[2]!, u * p[1]! + t * p[3]!];
  if (s.kind === CMD_QUAD)
    return [
      u * u * p[0]! + 2 * u * t * p[2]! + t * t * p[4]!,
      u * u * p[1]! + 2 * u * t * p[3]! + t * t * p[5]!,
    ];
  return [
    u * u * u * p[0]! + 3 * u * u * t * p[2]! + 3 * u * t * t * p[4]! + t * t * t * p[6]!,
    u * u * u * p[1]! + 3 * u * u * t * p[3]! + 3 * u * t * t * p[5]! + t * t * t * p[7]!,
  ];
}

const SAMPLES = 16;

/** Cumulative lengths of a segment at SAMPLES + 1 parameters (lines: 2). */
function lengths(s: Segment): number[] {
  const n = s.kind === CMD_LINE ? 1 : SAMPLES;
  const out = [0];
  let [px, py] = pointAt(s, 0);
  for (let i = 1; i <= n; i++) {
    const [x, y] = pointAt(s, i / n);
    out.push(out[i - 1]! + Math.hypot(x - px, y - py));
    px = x;
    py = y;
  }
  return out;
}

/** The parameter at which a segment's length from its start is `d` (interpolated between samples). */
function paramAt(cum: number[], d: number): number {
  const n = cum.length - 1;
  const total = cum[n]!;
  if (!(total > 0) || d <= 0) return 0;
  if (d >= total) return 1;
  let i = 1;
  while (i < n && cum[i]! < d) i++;
  const a = cum[i - 1]!;
  const b = cum[i]!;
  return (i - 1 + (b > a ? (d - a) / (b - a) : 0)) / n;
}

/** The part of a segment from t0 to t1 (de Casteljau). */
function slice(s: Segment, t0: number, t1: number): Segment {
  const p = s.p;
  const k = s.kind === CMD_LINE ? 2 : s.kind === CMD_QUAD ? 3 : 4;
  const pts: [number, number][] = [];
  for (let i = 0; i < k; i++) pts.push([p[2 * i]!, p[2 * i + 1]!]);
  const split = (ps: [number, number][], t: number): [[number, number][], [number, number][]] => {
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    let cur = ps;
    while (cur.length) {
      left.push(cur[0]!);
      right.unshift(cur[cur.length - 1]!);
      const next: [number, number][] = [];
      for (let i = 0; i + 1 < cur.length; i++)
        next.push([
          cur[i]![0] + (cur[i + 1]![0] - cur[i]![0]) * t,
          cur[i]![1] + (cur[i + 1]![1] - cur[i]![1]) * t,
        ]);
      cur = next;
    }
    return [left, right];
  };
  let part = pts;
  if (t1 < 1) part = split(part, t1)[0];
  if (t0 > 0) part = split(part, t1 > 0 ? t0 / t1 : 0)[1];
  return { kind: s.kind, p: part.flat() };
}

/** A sub-path's segments from length `from` to length `to` (0 ≤ from < to ≤ total). */
function snippet(segs: Segment[], cums: number[][], from: number, to: number): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  for (let i = 0; i < segs.length; i++) {
    const cum = cums[i]!;
    const len = cum[cum.length - 1]!;
    const end = start + len;
    if (end > from && start < to) {
      const t0 = from > start ? paramAt(cum, from - start) : 0;
      const t1 = to < end ? paramAt(cum, to - start) : 1;
      if (t1 > t0) out.push(t0 === 0 && t1 === 1 ? segs[i]! : slice(segs[i]!, t0, t1));
    }
    start = end;
  }
  return out;
}

/** The point at length `d` from a sub-path's start. */
function pointAtLength(segs: Segment[], cums: number[][], d: number): [number, number] {
  let start = 0;
  for (let i = 0; i < segs.length; i++) {
    const cum = cums[i]!;
    const len = cum[cum.length - 1]!;
    if (d <= start + len || i === segs.length - 1) return pointAt(segs[i]!, paramAt(cum, d - start));
    start += len;
  }
  return [0, 0];
}

/** A marker polygon (x y pairs, box space) at `end`, pointing from `from` towards it. */
function marker(a: GeomArrow, end: [number, number], from: [number, number]): number[] | undefined {
  let dx = end[0] - from[0];
  let dy = end[1] - from[1];
  const d = Math.hypot(dx, dy);
  if (!(d > 0)) return undefined;
  dx /= d;
  dy /= d;
  // Tip position: the end point, or half a length further for a centred marker.
  const shift = arrowCentred(a) ? a.length / 2 : 0;
  const tx = end[0] + dx * shift;
  const ty = end[1] + dy * shift;
  const pct = markerPercent(a);
  const out: number[] = [];
  for (let i = 0; i < pct.length; i += 2) {
    const across = (pct[i]! / 100 - 0.5) * a.width;
    const back = (pct[i + 1]! / 100) * a.length;
    out.push(tx - dx * back - dy * across, ty - dy * back + dx * across);
  }
  return out;
}

/** What a stroked open path draws with ends: its cut shaft (box space) and the marker polygons. */
export interface EndedPath {
  /** The path with every open sub-path cut back for its markers (closed ones as they were). */
  readonly shaft: GeomPath;
  /** Filled in the line's colour, without dashes: x y pairs, one array per marker. */
  readonly markers: number[][];
}

function pushSegments(cmds: number[], pts: number[], segs: Segment[]): void {
  if (!segs.length) return;
  cmds.push(CMD_MOVE);
  pts.push(segs[0]!.p[0]!, segs[0]!.p[1]!);
  for (const s of segs) {
    cmds.push(s.kind);
    for (let k = 2; k < s.p.length; k++) pts.push(s.p[k]!);
  }
}

/**
 * The shaft and markers of a stroked path with line ends: every open sub-path gets `ends.head` at its start
 * and `ends.tail` at its end (a sub-path ending within `tolerance` of its start counts as closed).
 */
export function withEnds(path: GeomPath, ends: GeomEnds, tolerance = 0): EndedPath {
  const cmds: number[] = [];
  const pts: number[] = [];
  const markers: number[][] = [];
  for (const sp of subPaths(path)) {
    const segs = sp.segments;
    const first = segs[0]!.p;
    const last = segs[segs.length - 1]!.p;
    const ex = last[last.length - 2]!;
    const ey = last[last.length - 1]!;
    const closed =
      sp.closed || (Math.abs(ex - first[0]!) <= tolerance && Math.abs(ey - first[1]!) <= tolerance);
    if (closed || (!ends.head && !ends.tail)) {
      pushSegments(cmds, pts, segs);
      if (sp.closed) cmds.push(CMD_CLOSE);
      continue;
    }
    const cums = segs.map(lengths);
    const total = cums.reduce((n, c) => n + c[c.length - 1]!, 0);
    if (!(total > 0)) {
      pushSegments(cmds, pts, segs);
      continue;
    }
    let from = 0;
    let to = total;
    const consumed = (a: GeomArrow) => Math.min(total, a.length * (arrowCentred(a) ? 0.5 : 1));
    if (ends.head) {
      const c = consumed(ends.head);
      const m = marker(ends.head, [first[0]!, first[1]!], pointAtLength(segs, cums, c));
      if (m) markers.push(m);
      from = Math.max(0, c - ends.head.width / 15);
    }
    if (ends.tail) {
      const c = consumed(ends.tail);
      const m = marker(ends.tail, [ex, ey], pointAtLength(segs, cums, total - c));
      if (m) markers.push(m);
      to = Math.min(total, total - c + ends.tail.width / 15);
    }
    if (to > from) pushSegments(cmds, pts, snippet(segs, cums, from, to));
  }
  return { shaft: { cmds, pts, fill: path.fill, stroke: path.stroke }, markers };
}

/** The bounds (box space) a marker of `a` can reach past the line's end point. */
export function arrowReach(a: GeomArrow | undefined): number {
  return a ? Math.hypot(a.width / 2, a.length) : 0;
}
