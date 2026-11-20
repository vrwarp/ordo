import type { ShapeObject, Slide, SlideObject } from '@ordo/domain';
import { clearFrameWork, frameKey, frameUnit, setFrames, splitFrame } from './frame.ts';
import { picture, slideOf, squares, textBox } from './frame.test-util.ts';
import { drawObject } from './text2d.ts';
import { loneChain, panel } from './units.effects.test-util.ts';
import { clearUnits, SLICE_MS, unitCache } from './units.ts';

/*
 * Browser side of frame.browser.test.ts: crowded slides at 1920 and 3840 wide on software canvases as the asset
 * worker's (`willReadFrequently`): the frame made in turns (`frameUnit`, each turn its own task, timed) against
 * the same objects drawn one after the other onto a transparent canvas. Where no unit lies inside the frame the
 * two are the same pixels exactly.
 */

export type FrameCase = {
  slide: string;
  width: number;
  /** Objects in the frame. */
  under: number;
  /** Largest channel difference of the frame against its objects drawn directly (transparent canvas). */
  maxDiff: number;
  /** Pixels differing by more than 2. */
  overTwo: number;
  /** Pixels the direct drawing painted (the check would pass on an empty frame otherwise). */
  painted: number;
  turns: number;
  longestMs: number;
  /** The longest single turn's wall time, ms. */
  frameBytes: number;
};

function canvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('2D context unavailable');
  return c;
}

/** A picture source of a flat colour, standing for a decoded file. */
function flat(w: number, h: number, rgb: string): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d')!;
  x.fillStyle = rgb;
  x.fillRect(0, 0, w, h);
  x.fillStyle = 'rgb(255,255,255)';
  x.fillRect(0, 0, w / 4, h / 4);
  return c;
}

async function runCase(name: string, slide: Slide, width: number): Promise<FrameCase> {
  const scale = width / 1920;
  const height = Math.round(1080 * scale);
  clearUnits();
  clearFrameWork();
  const split = splitFrame(slide, scale);
  if (!split) throw new Error(`${name}: not split`);
  const media: Record<string, OffscreenCanvas> = {};
  const lookup = (id: string) => (media[id] ??= flat(200, 150, `rgb(${(id.length * 37) % 255},90,160)`));
  const pictures = {
    acquire: async () => ({ lookup: lookup as never, release: () => undefined }),
  };
  const unit = frameUnit(split, { pictures: pictures as never });
  // The reference: the frame's objects, one after the other, onto a transparent canvas, no budget.
  const whole = canvas(width, height);
  for (const o of split.under) drawObject(whole, o, scale, lookup as never);
  const wholePx = whole.getImageData(0, 0, width, height);
  let longestMs = 0;
  let turns = 0;
  await unit.make({
    slice: async (fn) => {
      await new Promise((r) => setTimeout(r, 0));
      const t = performance.now();
      const out = fn();
      longestMs = Math.max(longestMs, performance.now() - t);
      turns++;
      return out;
    },
    check: () => undefined,
  });
  const img = unitCache.get('unit', unit.key);
  if (!img) throw new Error(`${name}: the frame was not made`);
  const copy = canvas(width, height);
  copy.drawImage(img.source, 0, 0);
  const px = copy.getImageData(0, 0, width, height);
  let max = 0;
  let over = 0;
  let painted = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(px.data[i + k]! - wholePx.data[i + k]!));
    max = Math.max(max, m);
    if (m > 2) over++;
    if (wholePx.data[i + 3]! > 0) painted++;
  }
  return {
    slide: name,
    width,
    under: split.under.length,
    maxDiff: max,
    overTwo: over,
    painted,
    turns,
    longestMs,
    frameBytes: split.bytes,
  };
}

/** 340 squares under four text boxes and a picture grid: nothing in it is a unit. */
function plain(): Slide {
  const pics = Array.from({ length: 6 }, (_, i) =>
    picture(`pic${i}`, `photo${i}`, { x: 100 + i * 290, y: 700, w: 270, h: 200 }),
  );
  return slideOf(
    [
      ...squares(300),
      ...pics,
      textBox('a', 'Alpha', 100, 100),
      textBox('b', 'Beta', 100, 250),
      textBox('c', 'Gamma'),
      textBox('d', 'Delta'),
    ],
    'plain',
  );
}

/** Shadowed panels over a lone chain past the budget by itself: a unit lies inside the frame. */
function withUnits(): Slide {
  const panels: SlideObject[] = [];
  for (let i = 0; i < 4; i++) panels.push(panel(`pa${i}`, 100 + i * 330, 80 + (i % 2) * 40, 600, 380, i));
  const chain: ShapeObject = loneChain();
  return slideOf([chain, ...panels, ...squares(300)], 'units');
}

export async function runFrames(): Promise<{ cases: FrameCase[]; sliceMs: number }> {
  setFrames(true);
  const cases: FrameCase[] = [];
  for (const [name, slide] of [
    ['plain', plain()],
    ['units', withUnits()],
  ] as const)
    for (const width of [1920, 3840]) cases.push(await runCase(name, slide, width));
  return { cases, sliceMs: SLICE_MS };
}

(globalThis as unknown as { __frames: typeof runFrames }).__frames = runFrames;
// the key helper is part of the bundle so a page test may ask for it
(globalThis as unknown as { __frameKey: typeof frameKey }).__frameKey = frameKey;
