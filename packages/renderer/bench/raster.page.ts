import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type Slide, type TextObject, type TextStyle } from '@ordo/domain';
import { rasterSlide } from '../src/raster.ts';
import { FontResolver, installFontEnv } from '../src/text/fonts.ts';
import { WidthCache, canvasMeasurer, measurerFor } from '../src/text/measure.ts';
import { paintRich } from '../src/text/paint.ts';
import { clampTextObject, layoutRich } from '../src/text/rich.ts';

/**
 * Browser side of the raster bench (design/27 §13, §14 item 13): runs in a dedicated worker, as the outputs'
 * asset worker does, with the font resolver installed and a software-backed OffscreenCanvas of the output's
 * size (`willReadFrequently`, as `surface()` in apps/output/src/asset.worker.ts). Each raster is what the
 * asset worker does per slide job: clear, `rasterSlide`, `transferToImageBitmap` (which makes Chromium
 * raster the recorded draw calls). Every job gets a structured clone of the slide, as a job message does,
 * so the layout memo never hits; the width cache stays warm across jobs, as it does in the worker.
 */

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const GOLD = { r: 255, g: 200, b: 60, a: 1 };

const base: TextStyle = {
  fontFamily: 'Bench',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSizePx: 56,
  color: WHITE,
  align: 'left',
  valign: 'top',
  lineHeight: 1.2,
  letterSpacing: 0,
  transform: 'none',
  padding: 0,
};

const VERSES =
  'John 10:11-14\n11 I am the good shepherd: the good shepherd giveth his life for the sheep. 12 But he that is an hireling, and not the shepherd, whose own the sheep are not, seeth the wolf coming, and leaveth the sheep, and fleeth. 14 I am the good shepherd, and know my sheep, and am known of mine.\nHe knows us by name\nHe lays down his life\nWe follow his voice';

function runOf(text: string, part: string, extra: Record<string, unknown>) {
  const start = text.indexOf(part);
  return { start, end: start + part.length, ...extra };
}

/** A sermon slide as the converter writes one: a title and a body with runs, verse numbers and bullets. */
export const SERMON: Slide = {
  id: 'sermon',
  objects: [
    {
      id: 'bg',
      type: 'shape',
      box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
      shape: 'rect',
      fill: { r: 20, g: 30, b: 50, a: 1 },
      opacity: 1,
      radius: 0,
    },
    {
      id: 'title',
      type: 'text',
      box: { x: 120, y: 60, w: 1680, h: 160, rotation: 0 },
      text: 'The Good Shepherd',
      style: {
        ...base,
        fontSizePx: 88,
        fontWeight: 700,
        lineModel: 'office',
        valign: 'middle',
        insets: { l: 14, t: 7, r: 14, b: 7 },
      },
      opacity: 1,
      runs: [{ start: 9, end: 17, color: GOLD }],
    },
    {
      id: 'body',
      type: 'text',
      box: { x: 120, y: 260, w: 1680, h: 760, rotation: 0 },
      text: VERSES,
      style: {
        ...base,
        fontSizePx: 56,
        lineModel: 'office',
        autofit: 'shrink',
        fitScale: { font: 0.925, spacing: 0.9 },
        insets: { l: 14, t: 7, r: 14, b: 7 },
      },
      opacity: 1,
      runs: [
        runOf(VERSES, 'John 10:11-14', { fontWeight: 700, color: GOLD }),
        runOf(VERSES, '11', { baseline: 0.3, color: GOLD }),
        runOf(VERSES, '12', { baseline: 0.3, color: GOLD }),
        runOf(VERSES, '14', { baseline: 0.3, color: GOLD }),
        runOf(VERSES, 'good shepherd', { fontStyle: 'italic' }),
      ],
      paras: [
        { spaceAfterPx: 12 },
        { spaceAfterPx: 18, lineSpacing: 0.9 },
        { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
        { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
        { bullet: { char: '•' }, indentPx: 54, firstLinePx: -54 },
      ],
    },
  ],
};

const LYRIC =
  'Amazing grace, how sweet the sound\nThat saved a wretch like me\nI once was lost, but now am found\nWas blind, but now I see\nTwas grace that taught my heart to fear\nAnd grace my fears relieved';

const lyricObject = (rich: boolean, effects: Partial<TextStyle> = {}): TextObject => ({
  id: 'lyric',
  type: 'text',
  box: { x: 160, y: 120, w: 1600, h: 840, rotation: 0 },
  text: LYRIC,
  style: {
    ...DEFAULT_LYRIC_STYLE,
    fontFamily: 'Bench',
    fontSizePx: 84,
    ...(rich ? { lineModel: 'office' } : {}),
    ...effects,
  },
  opacity: 1,
  ...(rich ? { runs: [{ start: 0, end: 13, color: GOLD }] } : {}),
});

/** A six-line lyric slide through the rich engine (office line model, one coloured run). */
export const LYRIC_RICH: Slide = { id: 'lyric-rich', objects: [lyricObject(true)], lyricObjectId: 'lyric' };
/** The same lyric slide as today's legacy object, for comparison. */
const HYMN =
  'Come, thou fount of every blessing, tune my heart to sing thy grace; streams of mercy, never ceasing, call for songs of loudest praise. Here I raise my Ebenezer; hither by thy help I come. Praise the mount, I am fixed upon it, mount of thy redeeming love.';

/** A box whose text overflows at full size and has no stored scale: LibreOffice's autofit search runs. */
export const AUTOFIT: Slide = {
  id: 'autofit',
  objects: [
    {
      id: 'fit',
      type: 'text',
      box: { x: 160, y: 120, w: 1600, h: 600, rotation: 0 },
      text: HYMN,
      style: { ...base, fontSizePx: 96, lineModel: 'office', autofit: 'shrink' },
      opacity: 1,
    },
  ],
};

/** The rich lyric slide without the default lyric style's shadow (outline kept), and without either. */
export const LYRIC_NO_SHADOW: Slide = {
  id: 'lyric-no-shadow',
  objects: [lyricObject(true, { shadow: undefined })],
  lyricObjectId: 'lyric',
};
export const LYRIC_PLAIN: Slide = {
  id: 'lyric-plain',
  objects: [lyricObject(true, { shadow: undefined, outline: undefined })],
  lyricObjectId: 'lyric',
};
export const LYRIC_LEGACY: Slide = {
  id: 'lyric-legacy',
  objects: [lyricObject(false)],
  lyricObjectId: 'lyric',
};

/**
 * A slide of PowerPoint shapes as the converter writes them (design/27 §15 M6): a gradient background, a
 * panel with a soft outer shadow under the sermon text, a glowing star, a soft-edged picture-like block,
 * arrows and dashes. Its first raster composes the effect sprites; later ones copy them from the cache.
 */
export const SHAPES: Slide = {
  id: 'shapes',
  objects: [
    {
      id: 'bg',
      type: 'shape',
      box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
      shape: 'rect',
      fill: { r: 20, g: 30, b: 50, a: 1 },
      opacity: 1,
      radius: 0,
      gradient: {
        kind: 'linear',
        angle: 90,
        stops: [
          { at: 0, color: { r: 20, g: 30, b: 50, a: 1 } },
          { at: 1, color: { r: 60, g: 20, b: 70, a: 1 } },
        ],
      },
    },
    {
      id: 'panel',
      type: 'shape',
      box: { x: 100, y: 120, w: 1720, h: 840, rotation: 0 },
      shape: 'rect',
      fill: { r: 255, g: 255, b: 255, a: 0.92 },
      opacity: 1,
      radius: 0,
      geom: { preset: 'roundRect', adj: [['adj', 6000]] },
      shadow: { dx: 0, dy: 12, blur: 40, color: { r: 0, g: 0, b: 0, a: 0.5 } },
    },
    {
      id: 'star',
      type: 'shape',
      box: { x: 1600, y: 40, w: 220, h: 220, rotation: 10 },
      shape: 'rect',
      fill: GOLD,
      opacity: 1,
      radius: 0,
      geom: { preset: 'star5' },
      glow: { radius: 30, color: { r: 255, g: 220, b: 80, a: 0.6 } },
    },
    {
      id: 'soft',
      type: 'shape',
      box: { x: 160, y: 640, w: 600, h: 280, rotation: 0 },
      shape: 'rect',
      fill: { r: 80, g: 140, b: 200, a: 1 },
      opacity: 1,
      radius: 0,
      softEdge: 24,
    },
    {
      id: 'arrow',
      type: 'shape',
      box: { x: 840, y: 700, w: 800, h: 160, rotation: 0 },
      shape: 'line',
      stroke: { width: 6, color: { r: 20, g: 30, b: 50, a: 1 } },
      opacity: 1,
      radius: 0,
      geom: { preset: 'curvedConnector3' },
      dash: 'dash',
      ends: { tail: { type: 'triangle', w: 'lg', len: 'lg' } },
    },
    ...SERMON.objects.filter((o) => o.type === 'text'),
  ],
};

/** A path zigzagging across a 2000 x 2000 space `points` times (37 turns round its centre). */
function zigzag(points: number): string {
  let d = 'M 1000 1000';
  for (let k = 1; k < points; k++) {
    const a = (k / points) * Math.PI * 2 * 37;
    const r = k % 2 ? 1000 : 50;
    d += ` L ${(1000 + r * Math.cos(a)).toFixed(1)} ${(1000 + r * Math.sin(a)).toFixed(1)}`;
  }
  return `${d} Z`;
}

/**
 * Hostile custom geometry (M6 repair, design/27 §12 drawing cost): a 4,000-point zigzag across the slide (the
 * review's, 4.6 s at 3840 before the budget; now its legacy rect), and two within the per-geometry budget,
 * the second past the slide's (its legacy shape). Bounded, not within the text budgets.
 */
export const HOSTILE_GEOMETRY: Slide = {
  id: 'hostile-geometry',
  objects: [4_000, 380, 380].map((n, i) => ({
    id: `z${i}`,
    type: 'shape' as const,
    box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    shape: 'rect' as const,
    fill: { r: 40, g: 90, b: 160, a: 0.5 },
    opacity: 1,
    radius: 0,
    geom: { paths: [{ d: zigzag(n), w: 2000, h: 2000 }] },
  })),
};

/** A deterministic PRNG (xorshift) for the hostile outlines. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const CENTRE = { x: 460, y: 40, w: 1000, h: 1000, rotation: 0 };

/** `n` points scattered within `r` of the centre of a 1000 x 1000 space (every turn a join). */
function cloud(seed: number, n: number, r: number): string {
  const rand = rng(seed);
  let d = 'M 500 500';
  for (let k = 1; k < n; k++) {
    const a = rand() * Math.PI * 2;
    const q = Math.sqrt(rand()) * r;
    d += ` L ${(500 + q * Math.cos(a)).toFixed(2)} ${(500 + q * Math.sin(a)).toFixed(2)}`;
  }
  return d;
}

/** `n` open sub-paths 1 unit long within 20 units of the centre of a 1000 x 1000 space. */
function bits(seed: number, n: number): string {
  const rand = rng(seed);
  let d = '';
  for (let k = 0; k < n; k++) {
    const x = 500 + (rand() - 0.5) * 20;
    const y = 500 + (rand() - 0.5) * 20;
    const a = rand() * Math.PI * 2;
    d += `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(x + Math.cos(a)).toFixed(1)} ${(y + Math.sin(a)).toFixed(1)} `;
  }
  return d.trim();
}

/**
 * The re-review's hostile outlines (M6 finish, design/27 §12 drawing cost): two shapes of eight 2,000-point
 * paths scattered within half a pixel, stroked 400 px wide with round joins (3.9 s at 3840 before), now
 * their legacy rects; within the geometry bound.
 */
export const WIDE_OUTLINES: Slide = {
  id: 'wide-outlines',
  objects: [1, 2].map((i) => ({
    id: `w${i}`,
    type: 'shape' as const,
    box: CENTRE,
    shape: 'rect' as const,
    fill: { r: 48, g: 96, b: 192, a: 1 },
    opacity: 1,
    radius: 0,
    geom: {
      paths: Array.from({ length: 8 }, (_, j) => ({ d: cloud(i * 10 + j, 2_000, 0.5), w: 1000, h: 1000 })),
    },
    stroke: { width: 400, color: BLACK },
    lineJoin: 'round' as const,
  })),
};

/**
 * Arrowheads on 8 x 1,500 open sub-paths of a 100 px line (24,000 marker fills, 2.6 s at 3840 before), and a
 * sysDot outline 0.01 px wide on 20 full-slide rects (each dash a sub-path of its own: drawn 0.5 px wide,
 * the dashes past the budget as plain rects).
 */
export const ENDS_AND_DASHES: Slide = {
  id: 'ends-and-dashes',
  objects: [
    {
      id: 'e',
      type: 'shape' as const,
      box: CENTRE,
      shape: 'rect' as const,
      opacity: 1,
      radius: 0,
      geom: {
        paths: Array.from({ length: 8 }, (_, j) => ({
          d: bits(j + 1, 1_500),
          w: 1000,
          h: 1000,
          fill: 'none' as const,
        })),
      },
      stroke: { width: 100, color: BLACK },
      ends: {
        head: { type: 'triangle' as const, w: 'lg' as const, len: 'lg' as const },
        tail: { type: 'triangle' as const, w: 'lg' as const, len: 'lg' as const },
      },
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      type: 'shape' as const,
      box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
      shape: 'rect' as const,
      opacity: 1,
      radius: 0,
      geom: { preset: 'rect' },
      stroke: { width: 0.01, color: BLACK },
      dash: 'sysDot' as const,
    })),
  ],
};

/**
 * A dashed spiral within the slide's budget (M6 finish: thin dashes are the closest the outline estimate
 * comes to what Chromium spends), drawn natively: 2,400 points, 40 turns, a 2 px sysDot line.
 */
export const DASHED_SPIRAL: Slide = {
  id: 'dashed-spiral',
  objects: [
    {
      id: 'sp',
      type: 'shape' as const,
      box: CENTRE,
      shape: 'rect' as const,
      opacity: 1,
      radius: 0,
      geom: {
        paths: [
          {
            d: Array.from({ length: 2_400 }, (_, k) => {
              const t = k / 2_399;
              const a = t * 40 * Math.PI * 2;
              const r = 480 - 460 * t;
              return `${k ? 'L' : 'M'} ${(500 + r * Math.cos(a)).toFixed(2)} ${(500 + r * Math.sin(a)).toFixed(2)}`;
            }).join(' '),
            w: 1000,
            h: 1000,
            fill: 'none' as const,
          },
        ],
      },
      stroke: { width: 2, color: BLACK },
      dash: 'sysDot' as const,
    },
  ],
};

/**
 * Six shapes of eight translucent full-slide paths each (M6 finish, the self-check: few edges, but each path
 * filled on its own over the whole box), within the budget by the area they cover: two drawn, the rest as
 * their legacy rects.
 */
export const STACKED_PATHS: Slide = {
  id: 'stacked-paths',
  objects: Array.from({ length: 6 }, (_, i) => ({
    id: `r${i}`,
    type: 'shape' as const,
    box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    shape: 'rect' as const,
    fill: { r: 40 + i * 30, g: 90, b: 160, a: 0.5 },
    opacity: 1,
    radius: 0,
    geom: {
      paths: Array.from({ length: 8 }, () => ({
        d: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
        w: 1000,
        h: 1000,
      })),
    },
  })),
};

/**
 * Three full-slide soft-edged panels (M6 finish: a soft edge weighs EFFECT_COST.softEdge slide areas, so one
 * fits the effect budget and the others are drawn without; its mask is cached, its body made each raster: at
 * 4K its full-resolution cut by the enlarged mask takes about 55 ms, which caching cannot avoid within the
 * effect cache's 32 MB a sprite).
 */
export const SOFT_EDGES: Slide = {
  id: 'soft-edges',
  objects: [0, 1, 2].map((i) => ({
    id: `s${i}`,
    type: 'shape' as const,
    box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    shape: 'rect' as const,
    fill: { r: 200 - i * 40, g: 120, b: 60 + i * 50, a: 1 },
    opacity: 1,
    radius: 0,
    softEdge: 1,
  })),
};

/**
 * Three large shadowed panels (M6 repair: the effect cache held about two 4K composites and rebuilt them on
 * every raster; now the reduced layers are cached and the panels drawn over them).
 */
export const SHADOWED_PANELS: Slide = {
  id: 'shadowed-panels',
  objects: [0, 1, 2].map((i) => ({
    id: `p${i}`,
    type: 'shape' as const,
    box: { x: 100 + i * 20, y: 80 + i * 10, w: 1600, h: 900, rotation: 0 },
    shape: 'rect' as const,
    fill: { r: 200 - i * 40, g: 120, b: 60 + i * 50, a: 1 },
    opacity: 1,
    radius: 0,
    geom: { preset: 'rect' },
    shadow: { dx: 6, dy: 6, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } },
  })),
};

export type Stats = { n: number; p50: number; p95: number; max: number; mean: number };
export type BenchReport = {
  context: string;
  slides: {
    name: string;
    chars: number;
    layoutColdMs: number;
    layoutWarmCache: Stats;
    raster: Record<string, { first: number; steady: Stats; paintOnly: Stats }>;
  }[];
};

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    n: s.length,
    p50: q(0.5),
    p95: q(0.95),
    max: s[s.length - 1]!,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

const clone = <T>(x: T): T => structuredClone(x);

function textObjects(s: Slide): TextObject[] {
  return s.objects.filter((o): o is TextObject => o.type === 'text');
}

export async function bench(
  set: FontFaceSet,
  font: ArrayBuffer,
  bold: ArrayBuffer,
  iterations: number,
  context: string,
): Promise<BenchReport> {
  const resolver = new FontResolver({ set, data: async (f) => (f.hash === 'bold' ? bold : font).slice(0) });
  await resolver.sync([
    { family: 'Bench', weight: 400, style: 'normal', hash: 'regular' },
    { family: 'Bench', weight: 700, style: 'normal', hash: 'bold' },
  ]);
  installFontEnv(resolver);
  // Warm-up: compile the engine on other text first, so the first slide's cold layout is not JIT time.
  {
    const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
    const other = {
      ...SERMON,
      objects: SERMON.objects.map((o) =>
        o.type === 'text' ? { ...o, text: o.text.split('').reverse().join('') } : o,
      ),
    };
    for (let i = 0; i < 20; i++)
      for (const o of textObjects(other))
        layoutRich(canvasMeasurer(probe, new WidthCache()), clampTextObject(clone(o)), resolver);
  }
  const report: BenchReport = { context, slides: [] };
  for (const [name, slide] of [
    ['sermon (rich)', SERMON],
    ['shapes with effects (M6)', SHAPES],
    ['hostile custom geometry (bounded geometry, M6 repair)', HOSTILE_GEOMETRY],
    ['wide outlines on tiny paths (bounded geometry, M6 finish)', WIDE_OUTLINES],
    ['arrowheads and thin dashes (bounded geometry, M6 finish)', ENDS_AND_DASHES],
    ['dashed spiral within the budget (bounded geometry, M6 finish)', DASHED_SPIRAL],
    ['stacked full-slide paths (bounded geometry, M6 finish)', STACKED_PATHS],
    ['three large shadowed panels (bounded, M6 repair)', SHADOWED_PANELS],
    ['three full-slide soft edges (bounded, M6 finish)', SOFT_EDGES],
    ['autofit search (rich)', AUTOFIT],
    ['6-line lyric (rich)', LYRIC_RICH],
    ['6-line lyric (legacy)', LYRIC_LEGACY],
    ['6-line lyric (rich, no shadow)', LYRIC_NO_SHADOW],
    ['6-line lyric (rich, no shadow or outline)', LYRIC_PLAIN],
  ] as const) {
    const objs = textObjects(slide);
    const chars = objs.reduce((n, o) => n + o.text.length, 0);
    // Layout with an empty width cache (every string measured: the median of 15 runs, the code already
    // compiled by a warm-up layout), then with the cache warm.
    const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
    const cold: number[] = [];
    let t = 0;
    for (let i = 0; i < 15; i++) {
      const copies = objs.map((o) => clampTextObject(clone(o)));
      const m = canvasMeasurer(probe, new WidthCache());
      t = performance.now();
      for (const c of copies) layoutRich(m, c, resolver);
      cold.push(performance.now() - t);
    }
    const layoutColdMs = stats(cold).p50;
    const warm: number[] = [];
    const shared = measurerFor(probe);
    for (const o of objs) layoutRich(shared, clampTextObject(clone(o)), resolver);
    for (let i = 0; i < iterations; i++) {
      const copies = objs.map((o) => clampTextObject(clone(o)));
      t = performance.now();
      for (const c of copies) layoutRich(shared, c, resolver);
      warm.push(performance.now() - t);
    }
    const raster: BenchReport['slides'][number]['raster'] = {};
    for (const width of [1920, 3840]) {
      const height = (width * 9) / 16;
      const scale = width / 1920;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const job = () => {
        const s = clone(slide);
        const t0 = performance.now();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        rasterSlide(ctx, s, LOOK_MAIN, scale, () => undefined, { isSong: true });
        canvas.transferToImageBitmap().close();
        return performance.now() - t0;
      };
      const first = job();
      for (let i = 0; i < 5; i++) job();
      const steady: number[] = [];
      for (let i = 0; i < iterations; i++) steady.push(job());
      // Painting alone (layouts memoised): what a repaint at another scale costs.
      const paint: number[] = [];
      const laid = objs.map((o) => {
        const c = clampTextObject(clone(o));
        return { c, l: layoutRich(shared, c, resolver) };
      });
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        for (const { c, l } of laid) paintRich(ctx, c, l, scale, resolver);
        canvas.transferToImageBitmap().close();
        paint.push(performance.now() - t0);
      }
      raster[String(width)] = { first, steady: stats(steady), paintOnly: stats(paint) };
    }
    report.slides.push({ name, chars, layoutColdMs, layoutWarmCache: stats(warm), raster });
  }
  resolver.dispose();
  return report;
}

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined';

if (inWorker) {
  const scope = self as unknown as { fonts: FontFaceSet; onmessage: unknown; postMessage(m: unknown): void };
  scope.onmessage = async (e: MessageEvent<{ font: ArrayBuffer; bold: ArrayBuffer; iterations: number }>) => {
    try {
      scope.postMessage({
        ok: true,
        report: await bench(scope.fonts, e.data.font, e.data.bold, e.data.iterations, 'worker'),
      });
    } catch (err) {
      scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  };
} else {
  const b64 = (s: string) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  (window as unknown as { __bench: unknown }).__bench = {
    worker: (source: string, font: string, bold: string, iterations: number) =>
      new Promise<BenchReport>((resolve, reject) => {
        const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        w.onmessage = (e: MessageEvent<{ ok: boolean; report?: BenchReport; error?: string }>) => {
          w.terminate();
          if (e.data.ok) resolve(e.data.report!);
          else reject(new Error(e.data.error));
        };
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage({ font: b64(font), bold: b64(bold), iterations });
      }),
  };
}
