import type { Rgba } from '@ordo/domain';
import { drawGeom, geomFillPath2D, GEOM_FILL_RULE } from './draw.ts';
import { type BuiltGeom, customGeometry, presetGeometry } from './path.ts';

/**
 * Browser side of draw.browser.test.ts: draws built geometries with drawGeom on an OffscreenCanvas in headless
 * Chromium and reads pixels well inside each region (away from anti-aliased edges): the fill-mode shades, the
 * even-odd rule, stroke-only paths and the picture clip path.
 */

export interface Check {
  readonly what: string;
  readonly ok: boolean;
  readonly detail: string;
}

const RED: Rgba = { r: 200, g: 100, b: 50, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

function draw(b: BuiltGeom, fill: Rgba | null, stroke: { color: Rgba; width: number } | null) {
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(b.w)), Math.max(1, Math.ceil(b.h)));
  const ctx = canvas.getContext('2d')!;
  drawGeom(ctx, b, fill, stroke);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function pixel(img: ImageData, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

function expectPixel(
  checks: Check[],
  what: string,
  img: ImageData,
  x: number,
  y: number,
  want: number[],
): void {
  const got = pixel(img, x, y);
  const ok = got.every((v, i) => Math.abs(v - want[i]!) <= 1);
  checks.push({
    what: `${what} at (${x}, ${y})`,
    ok,
    detail: `got ${got.join(',')}, want ${want.join(',')}`,
  });
}

function run(): Check[] {
  const checks: Check[] = [];
  const none = [0, 0, 0, 0];

  // can: the body in the fill, the top ellipse lightened by 40 %, outside the rounded ends empty.
  const can = draw(presetGeometry('can', 300, 200)!, RED, null);
  expectPixel(checks, 'can body (norm)', can, 150, 120, [200, 100, 50, 255]);
  expectPixel(checks, 'can top (lighten)', can, 150, 25, [222, 162, 132, 255]);
  expectPixel(checks, 'can outside its bottom curve', can, 3, 197, none);

  // cube: front norm, right side darkenLess (−20 %), top lightenLess (+20 %).
  const cube = draw(presetGeometry('cube', 300, 200)!, RED, null);
  expectPixel(checks, 'cube front (norm)', cube, 120, 120, [200, 100, 50, 255]);
  expectPixel(checks, 'cube side (darkenLess)', cube, 275, 100, [160, 80, 40, 255]);
  expectPixel(checks, 'cube top (lightenLess)', cube, 150, 25, [211, 131, 91, 255]);

  // donut: a hole in the middle, the ring filled.
  const donut = draw(presetGeometry('donut', 300, 200)!, RED, null);
  expectPixel(checks, 'donut hole', donut, 150, 100, none);
  expectPixel(checks, 'donut ring', donut, 25, 100, [200, 100, 50, 255]);

  // Even-odd: two nested squares traced the same way round leave a hole (non-zero would not).
  const square = (a: number, b: number) => [
    { op: 'moveTo', args: [String(a), String(a)] },
    { op: 'lnTo', args: [String(b), String(a)] },
    { op: 'lnTo', args: [String(b), String(b)] },
    { op: 'lnTo', args: [String(a), String(b)] },
    { op: 'close', args: [] },
  ];
  const nested = customGeometry({ paths: [{ cmds: [...square(0, 100), ...square(25, 75)] }] }, 100, 100);
  const nestedImg = draw(nested, RED, null);
  checks.push({ what: 'fill rule', ok: GEOM_FILL_RULE === 'evenodd', detail: GEOM_FILL_RULE });
  expectPixel(checks, 'even-odd hole', nestedImg, 50, 50, none);
  expectPixel(checks, 'even-odd ring', nestedImg, 10, 50, [200, 100, 50, 255]);

  // arc with no fill: only its stroked path is drawn; its fill-only path (the pie) is not.
  const arc = draw(presetGeometry('arc', 300, 200)!, null, { color: BLACK, width: 6 });
  expectPixel(checks, 'arc outline at the top', arc, 150, 1, [0, 0, 0, 255]);
  expectPixel(checks, 'arc inside (fill-only path skipped)', arc, 200, 60, none);

  // can stroked: the outline path draws the rim between body and top.
  const rim = draw(presetGeometry('can', 300, 200)!, RED, { color: BLACK, width: 4 });
  expectPixel(checks, 'can rim stroked over the fills', rim, 150, 50, [0, 0, 0, 255]);

  // The picture clip of a donut keeps the hole.
  const canvas = new OffscreenCanvas(300, 200);
  const ctx = canvas.getContext('2d')!;
  ctx.clip(geomFillPath2D(presetGeometry('donut', 300, 200)!), GEOM_FILL_RULE);
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, 300, 200);
  const clipped = ctx.getImageData(0, 0, 300, 200);
  expectPixel(checks, 'donut clip hole', clipped, 150, 100, none);
  expectPixel(checks, 'donut clip ring', clipped, 25, 100, [0, 255, 0, 255]);
  expectPixel(checks, 'donut clip corner', clipped, 2, 2, none);
  return checks;
}

(window as unknown as { __geomDraw: () => Check[] }).__geomDraw = run;
