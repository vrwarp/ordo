import type { Gradient, Rgba, ShapeObject } from '@ordo/domain';
import { drawGeomShape, shapeGeometry } from '../shape.ts';
import { compileGeom, type GeomSource, type PathCmdSource } from './compile.ts';
import { buildGeom } from './path.ts';
import { drawShapeWide } from './wide.ts';

/**
 * Browser side of wide.browser.test.ts: draws shapes WITHIN the stored limits twice on OffscreenCanvases in
 * headless Chromium, once by `drawGeomShape` (the screens' draw) and once by `drawShapeWide` (the page's), and
 * compares every channel of every pixel (RM-W3); then draws a 45,056-point outline whole and the same outline
 * cut at 4,096 points and compares their painted areas (RM-W4). No golden is written.
 */

export interface Equal {
  readonly what: string;
  /** The largest channel difference between the two canvases. */
  readonly maxDiff: number;
  /** Pixels that differ at all. */
  readonly differing: number;
  /** Pixels with any alpha in the screens' draw (a blank pair would prove nothing). */
  readonly painted: number;
}

export interface WideResult {
  readonly equal: Equal[];
  readonly wide: {
    readonly points: number;
    readonly paintedWhole: number;
    readonly paintedCut: number;
    readonly expected: number;
  };
}

const DENSITY = 2;
const W = 240;
const H = 180;

const red: Rgba = { r: 200, g: 60, b: 40, a: 1 };
const blue: Rgba = { r: 30, g: 60, b: 200, a: 1 };
const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };

function shape(over: Partial<ShapeObject>): ShapeObject {
  return {
    id: 'wide-test',
    type: 'shape',
    box: { x: 12.25, y: 9.5, w: W - 24.5, h: H - 19, rotation: 0 },
    shape: 'rect',
    fill: red,
    opacity: 1,
    radius: 0,
    ...over,
  } as ShapeObject;
}

/** A path d string: a polygon of the points, closed. */
function poly(points: [number, number][]): string {
  return `${points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')} Z`;
}

/** Outer square, hole, and a nested island (even-odd: ring, hole, filled island). */
const NESTED = [
  poly([
    [0, 0],
    [200, 0],
    [200, 150],
    [0, 150],
  ]),
  poly([
    [20, 20],
    [180, 20],
    [180, 130],
    [20, 130],
  ]),
  poly([
    [60, 50],
    [140, 50],
    [140, 100],
    [60, 100],
  ]),
].join(' ');

/** A blob with quadratic and cubic edges. */
const CURVES =
  'M 0 75 C 40 -20 160 -20 200 75 Q 100 200 0 75 Z M 70 70 C 90 40 120 40 130 70 Q 100 100 70 70 Z';

const stops = (n: number): Gradient['stops'] =>
  Array.from({ length: n }, (_, i) => ({
    at: i / (n - 1),
    color: { r: (i * 53) % 256, g: (i * 97 + 40) % 256, b: (i * 31 + 90) % 256, a: 1 },
  }));

function subjects(): { what: string; shape: ShapeObject }[] {
  const geom = (d: string) => ({ paths: [{ d, w: 200, h: 150 }] });
  return [
    { what: 'nested holes', shape: shape({ geom: geom(NESTED) }) },
    { what: 'curves and a hole', shape: shape({ geom: geom(CURVES) }) },
    { what: 'outline 1 px miter', shape: shape({ geom: geom(NESTED), stroke: { width: 1, color: black } }) },
    {
      what: 'outline 9 px round join, round cap',
      shape: shape({
        geom: geom(CURVES),
        stroke: { width: 9, color: blue },
        lineJoin: 'round',
        lineCap: 'round',
      }),
    },
    {
      what: 'outline 2 px bevel dashed',
      shape: shape({
        geom: geom(NESTED),
        stroke: { width: 2, color: black },
        lineJoin: 'bevel',
        dash: 'dash',
      }),
    },
    {
      what: 'linear gradient 2 stops',
      shape: shape({ geom: geom(CURVES), gradient: { kind: 'linear', angle: 30, stops: stops(2) } }),
    },
    {
      what: 'linear gradient 5 stops',
      shape: shape({ geom: geom(NESTED), gradient: { kind: 'linear', angle: 100, stops: stops(5) } }),
    },
    {
      what: 'radial gradient 16 stops',
      shape: shape({ geom: geom(CURVES), gradient: { kind: 'radial', stops: stops(16) } }),
    },
    {
      what: 'gradient with per-stop alpha',
      shape: shape({
        geom: geom(NESTED),
        gradient: {
          kind: 'linear',
          angle: 0,
          stops: [
            { at: 0, color: { r: 20, g: 20, b: 200, a: 1 } },
            { at: 1, color: { r: 20, g: 200, b: 20, a: 0.25 } },
          ],
        },
      }),
    },
    { what: '50 % alpha fill', shape: shape({ geom: geom(CURVES), fill: { ...red, a: 0.5 } }) },
    {
      what: 'opacity 0.5 with an outline',
      shape: shape({ geom: geom(NESTED), opacity: 0.5, stroke: { width: 3, color: blue } }),
    },
    {
      what: 'flipped and rotated',
      shape: shape({ geom: geom(CURVES), flipH: true, box: { x: 30, y: 20, w: 170, h: 120, rotation: 25 } }),
    },
    {
      what: 'shadow',
      shape: shape({
        geom: geom(NESTED),
        box: { x: 20, y: 14, w: 170, h: 120, rotation: 0 },
        shadow: { dx: 6, dy: 8, blur: 7, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      }),
    },
    {
      what: 'glow and soft edge',
      shape: shape({
        geom: geom(CURVES),
        box: { x: 30, y: 24, w: 160, h: 110, rotation: 0 },
        glow: { radius: 8, color: { r: 255, g: 220, b: 0, a: 0.6 } },
        softEdge: 4,
      }),
    },
  ];
}

function canvas(): { c: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const c = new OffscreenCanvas(W * DENSITY, H * DENSITY);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { c, ctx };
}

function compare(what: string, a: ImageData, b: ImageData): Equal {
  let maxDiff = 0;
  let differing = 0;
  let painted = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[i + k]! - b.data[i + k]!));
    if (d > 0) differing++;
    if (d > maxDiff) maxDiff = d;
    if (a.data[i + 3]! > 0) painted++;
  }
  return { what, maxDiff, differing, painted };
}

function equalSubjects(): Equal[] {
  const out: Equal[] = [];
  for (const s of subjects()) {
    const screens = canvas();
    drawGeomShape(screens.ctx, s.shape, DENSITY);
    // The page's draw: the same shape without its stored geometry, the geometry built by the caller.
    const built = shapeGeometry(s.shape);
    const { geom: _geom, ...bare } = s.shape;
    const wide = canvas();
    wide.ctx.scale(DENSITY, DENSITY);
    drawShapeWide(wide.ctx, bare as ShapeObject, built);
    const a = screens.ctx.getImageData(0, 0, screens.c.width, screens.c.height);
    const b = wide.ctx.getImageData(0, 0, wide.c.width, wide.c.height);
    out.push(compare(s.what, a, b));
  }
  return out;
}

/** An n-gon of radius r about (cx, cy) as a custGeom path of n points (one moveTo, n - 1 lnTo, a close). */
function ngon(n: number, r: number, cx: number, cy: number): PathCmdSource[] {
  const cmds: PathCmdSource[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    cmds.push({
      op: i === 0 ? 'moveTo' : 'lnTo',
      args: [(cx + r * Math.cos(a)).toFixed(4), (cy + r * Math.sin(a)).toFixed(4)],
    });
  }
  cmds.push({ op: 'close', args: [] });
  return cmds;
}

function wideOutline(): WideResult['wide'] {
  const n = 45_055; // plus the close = 45,056 points in the compiler's cost units
  const r = 400;
  const src = { paths: [{ w: '1000', h: '1000', cmds: ngon(n, r, 500, 500) }] } as unknown as GeomSource;
  const limits = { points: 262_144, paths: 64 };
  const whole = buildGeom(compileGeom(src, undefined, limits), 1000, 1000, undefined, undefined, limits);
  const cut = buildGeom(compileGeom(src), 1000, 1000);
  const box = { x: 0, y: 0, w: 1000, h: 1000, rotation: 0 };
  const bare = {
    id: 'wide-test',
    type: 'shape',
    box,
    shape: 'rect',
    fill: black,
    opacity: 1,
    radius: 0,
  } as ShapeObject;
  const area = (built: typeof whole): number => {
    const c = new OffscreenCanvas(1000, 1000);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    drawShapeWide(ctx, bare, built);
    const img = ctx.getImageData(0, 0, 1000, 1000);
    let sum = 0;
    for (let i = 3; i < img.data.length; i += 4) sum += img.data[i]! / 255;
    return sum;
  };
  return {
    points: whole.paths[0]!.cmds.length,
    paintedWhole: area(whole),
    paintedCut: area(cut),
    expected: Math.PI * r * r,
  };
}

(window as unknown as { __wideDraw: () => WideResult }).__wideDraw = () => ({
  equal: equalSubjects(),
  wide: wideOutline(),
});
