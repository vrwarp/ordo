import type { Slide, SlideObject } from '@ordo/domain';
import { clampSlide } from '../src/clamp.ts';
import { FRAME_MAX_OBJECTS, frameStats, frameUnit, splitFrame, underFrame } from '../src/frame.ts';
import { picture, slideOf, square, textBox } from '../src/frame.test-util.ts';
import { drawSlide2D } from '../src/text2d.ts';
import { effectsSlide, panel } from '../src/units.effects.test-util.ts';
import { clearUnits, unitCache } from '../src/units.ts';

/*
 * Browser side of frame.ts (bench:frame, design 29 R1, M2 and M5): the underlay frame of a crowded slide made in
 * turns on a software canvas, each turn its own task, timed one by one, and the final raster (the frame copied under the
 * direct part) against the base's cut draw of the same slide. One case on one page: the runner starts a fresh page
 * for every run. The pictures are flat canvases standing for decoded files (decode and prepare run off the turns).
 */

export type FrameBenchCase = {
  name: string;
  width: number;
  objects: number;
  under: number;
  direct: number;
  frameBytes: number;
  /** Turn time summed (what `FRAME_BUDGET_MS` counts), ms. */
  turnsMs: number;
  /** Wall time from the first call to the frame in the cache, ms (each turn a macrotask of its own). */
  wallMs: number;
  turns: number;
  longestTurn: number;
  /** The longest single step (one object, one band of a unit), ms. */
  longestStep: number;
  made: boolean;
  /** The final raster: the direct part over the frame copied under it, ms (median of 7). */
  finalMs: number;
  /** The base's cut draw of the same slide (the first 200 objects), ms (median of 7). */
  cutMs: number;
  /** The direct part alone (what the first paint draws while the frame is late), ms (median of 7). */
  directMs: number;
};

function context(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('2D context unavailable');
  return c;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** A flat picture source of `w` x `h`, standing for a decoded file. */
function flat(w: number, h: number, i: number): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d')!;
  x.fillStyle = `rgb(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255})`;
  x.fillRect(0, 0, w, h);
  return c;
}

/** `n` squares on a grid of `cols`, in their own colours, 8 x 6 logical px apart: nothing in them is a unit. */
function flatShapes(n: number, cols: number): SlideObject[] {
  return Array.from({ length: n }, (_, i) =>
    square(i, {
      box: {
        x: 8 + (i % cols) * 11,
        y: 8 + Math.floor(i / cols) * 9,
        w: 8,
        h: 6,
        rotation: 0,
      },
    }),
  );
}

/** `n` text boxes of a short text of their own, on a grid. */
function boxes(n: number, cols: number, at: number): SlideObject[] {
  return Array.from({ length: n }, (_, i) =>
    textBox(`bt${at + i}`, `t${at + i}`, 8 + (i % cols) * 60, 700 + Math.floor(i / cols) * 24, 56, 20),
  );
}

/** `n` pictures of eight sizes over 64 files. */
function pictures(n: number): SlideObject[] {
  const sizes = [
    [64, 48],
    [96, 72],
    [128, 96],
    [160, 120],
    [200, 150],
    [240, 180],
    [320, 240],
    [400, 300],
  ] as const;
  return Array.from({ length: n }, (_, i) => {
    const [w, h] = sizes[i % 8]!;
    return picture(`bp${i}`, `file${i % 64}`, { x: 20 + ((i * 29) % 1700), y: 40 + ((i * 17) % 880), w, h });
  });
}

/** The builders of M2 and M5 (the renderer's, not the schema's: 20,000 objects is past what a hub stores). */
export const BUILDERS: Record<string, () => Slide> = {
  // The e2e deck's slide: 300 squares, 24 pictures, 16 text boxes on top.
  crowded340: () => slideOf([...flatShapes(300, 30), ...pictures(24), ...boxes(16, 8, 0)], 'crowded340'),
  // 1,000 objects: 800 flat shapes, 150 text boxes, 50 pictures.
  objects1000: () => slideOf([...flatShapes(800, 80), ...pictures(50), ...boxes(150, 16, 0)], 'objects1000'),
  // The frame's whole bound: 20,000 objects, 64 pictures of eight sizes (the rest flat shapes and text boxes).
  objects20000: () =>
    slideOf(
      [...flatShapes(17_500, 160), ...pictures(64), ...boxes(FRAME_MAX_OBJECTS - 17_564, 16, 0)],
      'objects20000',
    ),
  // 20 shadowed panels (effectsSlide's twelve large ones and eight more) past one frame of units on a soft-edged frame.
  shadows20: () => {
    const e = effectsSlide({ w: 1100, h: 700 });
    const more = Array.from({ length: 8 }, (_, i) =>
      panel(`q${i}`, 40 + (i % 4) * 440, 600 + Math.floor(i / 4) * 200, 420, 180, 12 + i),
    );
    return slideOf([...e.objects, ...more], 'shadows20');
  },
};

export async function runCase(name: string, width: number): Promise<FrameBenchCase> {
  const build = BUILDERS[name];
  if (!build) throw new Error(`no builder ${name}`);
  const slide = build();
  const scale = width / 1920;
  const height = Math.round(1080 * scale);
  clearUnits();
  const split = splitFrame(slide, scale);
  if (!split) throw new Error(`${name}: not split at ${width}`);
  const media: Record<string, OffscreenCanvas> = {};
  const lookup = (id: string) =>
    (media[id] ??= flat(64 + (id.length % 7) * 40, 48 + (id.length % 7) * 30, id.length));
  const unit = frameUnit(split, {
    pictures: { acquire: async () => ({ lookup: lookup as never, release: () => undefined }) } as never,
    budgetMs: Number.POSITIVE_INFINITY,
  });
  let turns = 0;
  let longestTurn = 0;
  let turnsMs = 0;
  const w0 = performance.now();
  await unit.make({
    slice: async (fn) => {
      // A task of its own, as the lanes run a turn.
      await new Promise<void>((r) => setTimeout(r, 0));
      const t = performance.now();
      const out = fn();
      const d = performance.now() - t;
      turns++;
      turnsMs += d;
      longestTurn = Math.max(longestTurn, d);
      return out;
    },
    check: () => undefined,
  });
  const wallMs = performance.now() - w0;
  const made = !!unitCache.get('unit', unit.key);
  const stats = frameStats();
  // The final raster against the base's cut draw.
  const under = underFrame(split);
  const images = lookup as never;
  const draw = (s: Slide, o: { under?: typeof under } = {}) => {
    const c = context(width, height);
    const t = performance.now();
    drawSlide2D(c as never, s, { scale, images, ...o });
    c.getImageData(0, 0, 1, 1);
    return performance.now() - t;
  };
  const final: number[] = [];
  const cut: number[] = [];
  const direct: number[] = [];
  draw(split.direct, { under });
  for (let i = 0; i < 7; i++) {
    final.push(draw(split.direct, { under }));
    direct.push(draw(split.direct));
    cut.push(draw(clampSlide(slide, 'live')));
  }
  return {
    name,
    width,
    objects: slide.objects.length,
    under: split.under.length,
    direct: split.direct.objects.length,
    frameBytes: split.bytes,
    turnsMs,
    wallMs,
    turns,
    longestTurn,
    longestStep: stats.longestStep,
    made,
    finalMs: median(final),
    cutMs: median(cut),
    directMs: median(direct),
  };
}

(globalThis as unknown as { __frameBench: typeof runCase }).__frameBench = runCase;
