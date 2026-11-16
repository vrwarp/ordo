import { LOOK_MAIN, type ShapeObject, type Slide } from '@ordo/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AREA_BENCH_CASES } from '../bench/cases/index.ts';
import './decor/index.ts';
import { digest } from './digest.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { drawSlide2D } from './text2d.ts';
import { traceCtx } from './trace.test-util.ts';
import { lineArtSlide } from './units.test-util.ts';
import { clearUnits, setEffectUnits, unitsOfSlide } from './units.ts';

/*
 * The venue troubleshooting switch (r2b effect units, C6): `setEffectUnits(false)` (an output's `?effects=base`,
 * set by the asset worker's `applyDrawing`) draws as 62a1c3a drew. Each slide below (the raster bench's area cases, the line
 * art, effects past the budget and past one frame of units, gradients past it) is drawn at 3840 with nothing
 * cached, and its draw calls (a trace) and its planned units are digested: FIXTURE holds the digests 62a1c3a gave
 * (recorded by bundling this very drawing against the r2b-before checkout at 62a1c3a).
 */

const FIXTURE: readonly (readonly [name: string, trace: string, plan: string])[] = [
  ['table: 96-cell bulletin (M9 object)', '1ap2yfv1szb1571brg', 'w7k42t4e2jux2'],
  ['table: 96-cell bulletin (M6 group)', '1sfbu331rkjhre1796', 'w7k42t4e2jux2'],
  ['table: 640-cell master grid (M9 object)', 'eh49yd11l8dm636w', 'w7k42t4e2jux2'],
  ['table: 640-cell master grid (M6 group)', 'gx2e3j14t2e6k2am', 'w7k42t4e2jux2'],
  // Re-pinned by text-lines (sub-wave 1b): the table drawer paints cell text on device pixels (baselines on
  // the device row, run starts on the quarter column), which moves this chart's runs at 3840; 62a1c3a's digest
  // was 1domlvkpgezcw4k5a. The other two tables' runs already sit on device pixels at 3840.
  ['table: 13,782-character chart (M9 object)', 'm4diaq1extefw4lq9', 'w7k42t4e2jux2'],
  ['table: 13,782-character chart (M6 group)', 'wkhqjo14lb7jq47nb', 'w7k42t4e2jux2'],
  ['line art past the slide budget (units)', 'u9qitd1a0qu38fpi7', 'dwfdm3xona5y11'],
  [
    'a decoration at its caps: 16,384 points, 24 shadows in one task, cold (M9 decor-render)',
    '16vyeiv3tddrsac7o',
    'w7k42t4e2jux2',
  ],
  [
    'a decoration at its caps: 16,384 points, 24 shadows, warm (M9 decor-render)',
    '16vyeiv3tddrsac7o',
    'w7k42t4e2jux2',
  ],
  [
    '60 shapes with 12 shadows as one decoration (decoration vs shapes: showcase, M9 decor-render)',
    'z5eu4k9gyi9y1s7y',
    'w7k42t4e2jux2',
  ],
  [
    'the same 60 shapes one by one (shapes vs decoration: showcase, M9 decor-render)',
    '1aefaai3jfrff1bt0',
    'w7k42t4e2jux2',
  ],
  [
    '60 shapes with 12 shadows as one decoration, cold (decoration vs shapes: showcase cold, M9 decor-render)',
    'z5eu4k9gyi9y1s7y',
    'w7k42t4e2jux2',
  ],
  [
    'the same 60 shapes one by one, cold (shapes vs decoration: showcase cold, M9 decor-render)',
    '1aefaai3jfrff1bt0',
    'w7k42t4e2jux2',
  ],
  [
    'four large decorations of 24 shadows among 124 shadowed shapes (warm task) (decoration vs shapes: four large, r2a repair)',
    '1q6yv8v114hfmt4oib',
    'w7k42t4e2jux2',
  ],
  [
    'the same 220 shadowed shapes one by one (shapes vs decoration: four large, r2a repair)',
    '1eo39aq1hh5gvr49in',
    'w7k42t4e2jux2',
  ],
  ['line art', '1jsox5vhi8u55hm0r', 'limrnidk4mav20'],
  ['effects', '1h4aihl1j115k76gj', 'w7k42t4e2jux2'],
  ['effects past a frame', 'brwerr5vq11y6da', 'w7k42t4e2jux2'],
  ['gradients', 'o246qo1d6pexfd6', 'w7k42t4e2jux2'],
];

const black = { r: 0, g: 0, b: 0, a: 0.55 };
const panel = (i: number, w: number, h: number): ShapeObject => ({
  id: `p${i}`,
  type: 'shape',
  box: { x: 40 + (i % 4) * 340, y: 40 + Math.floor(i / 4) * 230, w, h, rotation: 0 },
  shape: 'rect',
  fill: { r: 40 + i * 9, g: 120, b: 200, a: 1 },
  opacity: 1,
  radius: 0,
  geom: { preset: 'roundRect' },
  shadow: { dx: 6, dy: 6, blur: 12, color: black },
});
const soft: ShapeObject = {
  id: 'soft',
  type: 'shape',
  box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
  shape: 'rect',
  fill: { r: 250, g: 236, b: 200, a: 1 },
  opacity: 1,
  radius: 0,
  geom: { preset: 'rect' },
  softEdge: 60,
};
const radial = (id: string, x: number): ShapeObject => ({
  id,
  type: 'shape',
  box: { x, y: 0, w: 1920, h: 1080, rotation: 0 },
  shape: 'rect',
  fill: { r: 255, g: 255, b: 255, a: 1 },
  opacity: 1,
  radius: 0,
  gradient: {
    kind: 'radial',
    stops: [
      { at: 0, color: { r: 255, g: 255, b: 255, a: 1 } },
      { at: 0.4, color: { r: 200, g: 40, b: 40, a: 1 } },
      { at: 1, color: { r: 20, g: 20, b: 120, a: 1 } },
    ],
  },
});

/** The slides (the bench's area cases 62a1c3a had: later rows draw the same slides). */
function slides(): [string, Slide][] {
  const named = new Set(FIXTURE.map((f) => f[0]));
  return [
    ...AREA_BENCH_CASES.filter(([name]) => named.has(name)).map(
      ([name, slide]) => [name, slide] as [string, Slide],
    ),
    ['line art', lineArtSlide()],
    [
      'effects',
      { id: 'effects', objects: [soft, ...Array.from({ length: 12 }, (_, i) => panel(i, 800, 480))] },
    ],
    [
      'effects past a frame',
      { id: 'effects2', objects: [soft, ...Array.from({ length: 12 }, (_, i) => panel(i, 1100, 700))] },
    ],
    ['gradients', { id: 'gradients', objects: [radial('a', 0), radial('b', 200)] }],
  ];
}

/** The slide drawn at 3840 with nothing cached, and its planned units, digested. */
function drawn(slide: Slide): { trace: string; plan: string } {
  const s = structuredClone(slide);
  clearUnits();
  const t = traceCtx(3840, 2160);
  drawSlide2D(t, s, { scale: 2, look: LOOK_MAIN, images: () => ({ width: 640, height: 360 }) as never });
  const plan = unitsOfSlide(s, 2, LOOK_MAIN).map((u) => [
    u.object.id,
    u.rect.x,
    u.rect.y,
    u.rect.w,
    u.rect.h,
    !!(u.drawn as ShapeObject).shadow,
  ]);
  return { trace: digest(JSON.stringify(t.trace)), plan: digest(JSON.stringify(plan)) };
}

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => setEffectUnits(true));
afterAll(() => clearUnits());

describe('setEffectUnits(false): the drawing of 62a1c3a', () => {
  it('draws every bench slide as 62a1c3a did: the same draw calls and the same units', () => {
    setEffectUnits(false);
    const got = slides().map(([name, s]) => {
      const d = drawn(s);
      return [name, d.trace, d.plan];
    });
    expect(got).toEqual(FIXTURE);
  });

  it('on (the default), effect units plan units where 62a1c3a left out effects or paint', () => {
    const changed = slides().filter(([name, s]) => drawn(s).plan !== FIXTURE.find((f) => f[0] === name)![2]);
    expect(changed.map(([n]) => n)).toEqual(
      expect.arrayContaining(['effects', 'effects past a frame', 'gradients']),
    );
  });
});
