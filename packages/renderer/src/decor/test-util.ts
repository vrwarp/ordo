import type { DecorData, DecorPaint, DecorPart, Gradient, Rgba, ShapeObject, Slide } from '@ordo/domain';
import { boxSide, legacyGeometry, storedPath } from '../geom/built.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from '../geom/ops.ts';
import { type GeomPath, presetGeometry } from '../geom/path.ts';

/*
 * Test and golden support for decorations (design/27 M9, decor-render; not shipped: *.test-util.ts): separate
 * PowerPoint shapes written as one decoration the way the converter writes one (`@ordo/pptx-scene` `decor.ts`
 * `emitDecor`, decor-conv): each shape's geometry built at its box as the renderer builds it, placed into the
 * decoration's space (mirrored about its box's centre, turned about it, moved to it), its paths written as
 * parts in z-order (its first with `s: 1`), its look a paint (equal paints shared), a gradient's frame its box
 * with the mirrors folded into the gradient. The union of the boxes' turned corners is the decoration's box.
 * `digits`: decimals the part strings keep (the converter writes 2); undefined keeps every digit, so the
 * equivalence check compares the drawer and not the converter's rounding (a coordinate rounded by 1e-14 can
 * change how Skia classifies a path, and so its anti-aliasing, by up to 50 levels on a few edge pixels).
 *
 * Also `decorShowcase`: 60 shapes of every kind a decoration holds (presets with shaded paths, custom paths, a
 * path in pieces, colours and alpha, linear and radial gradients on turned and mirrored boxes, dashed and
 * plain outlines, shadows), the equivalence check's and the golden cases' subject.
 */

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

const LETTER: Readonly<Record<number, [string, number]>> = {
  [CMD_MOVE]: ['M', 1],
  [CMD_LINE]: ['L', 1],
  [CMD_QUAD]: ['Q', 2],
  [CMD_CUBIC]: ['C', 3],
  [CMD_CLOSE]: ['Z', 0],
};

function fmt(v: number, digits: number | undefined): string {
  const r = (digits === undefined ? v : Number(v.toFixed(digits))) + 0;
  return Object.is(r, -0) ? '0' : String(r);
}

/** A path in the decoration's space as one part string. */
function partString(
  cmds: readonly number[],
  pts: readonly number[],
  x0: number,
  y0: number,
  digits: number | undefined,
) {
  let at = 0;
  const out: string[] = [];
  for (const op of cmds) {
    const [letter, pairs] = LETTER[op] ?? ['Z', 0];
    let t = letter;
    for (let j = 0; j < pairs; j++, at += 2)
      t += ` ${fmt((pts[at] ?? 0) - x0, digits)} ${fmt((pts[at + 1] ?? 0) - y0, digits)}`;
    out.push(t);
  }
  return out.join(' ');
}

/** One decoration of `shapes` (bottom first; see the header). Throws for a shape a decoration cannot hold. */
export function decorOf(shapes: readonly ShapeObject[], digits?: number, id = 'decor'): ShapeObject {
  const members: {
    paint: DecorPaint;
    paths: { path: GeomPath; pts: number[]; cont: boolean }[];
    o: ShapeObject;
  }[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const o of shapes) {
    if (o.glow || o.softEdge || o.ends || o.look3d || (o.opacity ?? 1) !== 1)
      throw new Error(`${o.id}: not a decoration member`);
    const w = boxSide(o.box.w);
    const h = boxSide(o.box.h);
    let built: { path: GeomPath; cont: boolean }[];
    if (o.geom?.preset) {
      const g = presetGeometry(o.geom.preset, w, h, o.geom.adj as [string, number][] | undefined);
      if (!g) throw new Error(`${o.id}: unknown preset`);
      built = g.paths.map((path) => ({ path, cont: false }));
    } else if (o.geom?.paths?.length) {
      built = o.geom.paths.map((p, k) => ({ path: storedPath(p, w, h), cont: k > 0 && p.cont === true }));
    } else built = legacyGeometry(o.shape, o.radius ?? 0, w, h).paths.map((path) => ({ path, cont: false }));
    const a = ((o.box.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const cx = o.box.x + w / 2;
    const cy = o.box.y + h / 2;
    const fh = o.flipH === true;
    const fv = o.flipV === true;
    const paths = built.map(({ path, cont }) => {
      const pts: number[] = [];
      for (let i = 0; i + 1 < path.pts.length; i += 2) {
        const lx = (fh ? w - path.pts[i]! : path.pts[i]!) - w / 2;
        const ly = (fv ? h - path.pts[i + 1]! : path.pts[i + 1]!) - h / 2;
        pts.push(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
      }
      return { path, pts, cont };
    });
    for (const [x, y] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ] as const) {
      const X = cx + (x - w / 2) * cos - (y - h / 2) * sin;
      const Y = cy + (x - w / 2) * sin + (y - h / 2) * cos;
      x0 = Math.min(x0, X);
      y0 = Math.min(y0, Y);
      x1 = Math.max(x1, X);
      y1 = Math.max(y1, Y);
    }
    const paint: DecorPaint = {
      ...(o.fill ? { fill: o.fill } : {}),
      ...(o.gradient && o.fill ? { gradient: unmirrored(o.gradient, fh, fv) } : {}),
      ...(o.stroke ? { stroke: o.stroke } : {}),
      ...(o.stroke && o.dash && o.dash !== 'solid' ? { dash: o.dash } : {}),
      ...(o.shadow ? { shadow: o.shadow } : {}),
    };
    members.push({ paint, paths, o });
  }
  const r = (v: number) => Math.round(v * 1000) / 1000 + 0;
  const paints: DecorPaint[] = [];
  const index = new Map<string, number>();
  const parts: DecorPart[] = [];
  for (const m of members) {
    const key = JSON.stringify(m.paint);
    let p = index.get(key);
    if (p === undefined) {
      p = paints.length;
      paints.push(m.paint);
      index.set(key, p);
    }
    const frame: DecorPart['frame'] = m.paint.gradient
      ? [r(m.o.box.x - x0), r(m.o.box.y - y0), r(m.o.box.w), r(m.o.box.h), m.o.box.rotation ?? 0]
      : undefined;
    m.paths.forEach(({ path, pts, cont }, k) => {
      parts.push({
        d: partString(path.cmds, pts, x0, y0, digits),
        p: p!,
        ...(k === 0 ? { s: 1 as const } : {}),
        ...(path.fill !== 'norm' ? { fill: path.fill } : {}),
        ...(path.stroke ? {} : { stroke: false }),
        ...(cont && k > 0 ? { cont: true } : {}),
        ...(frame ? { frame } : {}),
      });
    });
  }
  const decor: DecorData = { w: r(x1 - x0), h: r(y1 - y0), paints, parts };
  return {
    id,
    type: 'shape',
    box: { x: r(x0), y: r(y0), w: decor.w, h: decor.h, rotation: 0 },
    shape: 'line',
    opacity: 1,
    radius: 0,
    decor,
    locked: true,
  };
}

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const NAVY = rgba(20, 40, 90);
const GOLD = rgba(240, 190, 40);
const RED = rgba(210, 60, 50);
const TEAL = rgba(30, 150, 140);
const WHITE = rgba(255, 255, 255);
const SHADOW = { dx: 4, dy: 5, blur: 8, color: rgba(0, 0, 0, 0.55) };

const PRESETS = [
  'star5',
  'heart',
  'can',
  'cube',
  'moon',
  'cloud',
  'sun',
  'smileyFace',
  'donut',
  'snip2SameRect',
];

/** A ring of `n` points (a closed polygon), centred at (cx, cy). */
function ring(cx: number, cy: number, r: number, n: number, phase = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    pts.push(`${i ? 'L' : 'M'} ${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `${pts.join(' ')} Z`;
}

/**
 * 60 decoration members over a 1920 x 1080 slide (see the header), bottom first. `shadows`: how many of them
 * cast one (at most the decoration's 24).
 */
export function decorShowcase(shadows = 12): ShapeObject[] {
  const out: ShapeObject[] = [];
  const linear: Gradient = {
    kind: 'linear',
    angle: 30,
    stops: [
      { at: 0, color: GOLD },
      { at: 0.5, color: RED },
      { at: 1, color: NAVY },
    ],
  };
  const radial: Gradient = {
    kind: 'radial',
    center: { x: 0.3, y: 0.4 },
    stops: [
      { at: 0, color: WHITE },
      { at: 1, color: rgba(30, 150, 140, 0.4) },
    ],
  };
  for (let i = 0; i < 60; i++) {
    const col = i % 10;
    const row = Math.floor(i / 10);
    const box = {
      x: 30 + col * 188,
      y: 30 + row * 172,
      w: 150 + (i % 3) * 12,
      h: 120 + (i % 4) * 8,
      rotation: 0,
    };
    if (i % 7 === 3) box.rotation = 15 + i;
    const o: ShapeObject = { id: `m${i}`, type: 'shape', box, shape: 'rect', opacity: 1, radius: 0 };
    const kind = i % 6;
    if (kind === 0) o.geom = { preset: PRESETS[i % PRESETS.length]! };
    else if (kind === 1) o.geom = { preset: 'roundRect', adj: [['adj', 30000 + i * 500]] };
    else if (kind === 2) o.geom = { paths: [{ d: ring(50, 50, 48, 7 + (i % 5), i / 9), w: 100, h: 100 }] };
    else if (kind === 3)
      // One outline with holes, stored in two pieces (`cont`).
      o.geom = {
        paths: [
          { d: ring(50, 50, 48, 24), w: 100, h: 100 },
          { d: `${ring(30, 50, 10, 12)} ${ring(70, 50, 10, 12)}`, w: 100, h: 100, cont: true },
        ],
      };
    // Every member has a geometry, as the converter's shapes do: drawn on its own it goes through
    // `drawGeomShape`, the drawing a decoration repeats (the legacy rect and ellipse are Canvas's own).
    else if (kind === 4) o.geom = { preset: 'ellipse' };
    else o.geom = { preset: 'rect' };
    if (i % 5 === 1) o.flipH = true;
    if (i % 9 === 4) o.flipV = true;
    o.fill = [GOLD, TEAL, rgba(210, 60, 50, 0.7), NAVY, WHITE][i % 5]!;
    if (i % 4 === 1) o.gradient = linear;
    if (i % 8 === 6) o.gradient = radial;
    if (i % 3 === 0) o.stroke = { width: 2 + (i % 4), color: i % 2 ? WHITE : NAVY };
    if (i % 12 === 9) {
      o.stroke = { width: 3, color: RED };
      o.dash = (['dash', 'sysDot', 'longDashDot'] as const)[i % 3]!;
    }
    out.push(o);
  }
  // The first `shadows` members whose index is even cast a shadow.
  let left = shadows;
  for (const o of out) {
    if (left <= 0) break;
    if (Number(o.id.slice(1)) % 2 === 0) {
      o.shadow = SHADOW;
      left--;
    }
  }
  return out;
}

/** A slide of the showcase over a backdrop: its members drawn separately, or as one decoration. */
export function showcaseSlide(as: 'shapes' | 'decor', shadows = 12): Slide {
  const shapes = decorShowcase(shadows);
  const backdrop: ShapeObject = {
    id: 'bg',
    type: 'shape',
    box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    shape: 'rect',
    opacity: 1,
    radius: 0,
    fill: rgba(235, 238, 245),
  };
  return { id: `showcase-${as}`, objects: [backdrop, ...(as === 'shapes' ? shapes : [decorOf(shapes)])] };
}
