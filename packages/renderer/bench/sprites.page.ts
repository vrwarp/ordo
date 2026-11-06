import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  type Look,
  type Slide,
  type TextObject,
} from '@ordo/domain';
import { Canvas2DCompositor } from '../src/canvas2d.ts';
import type { FrameInputs } from '../src/compositor.ts';
import { rasterLowerThird, rasterSlide } from '../src/raster.ts';
import { type Reach, drawSprite, lowerThirdReach, slideReach, spriteRect } from '../src/sprite.ts';
import { LAYERS, LayerStack, SRC_BITMAP } from '../src/stacks.ts';
import { FontResolver, installFontEnv } from '../src/text/fonts.ts';
import type { Ctx2D } from '../src/text2d.ts';

/**
 * Browser side of the sprite bench (design/27 §7.3, §13; runner: sprites.ts). CPU-side costs only, in a
 * dedicated worker of headless Chromium, as the outputs' workers run them:
 * - raster: what the asset worker does per job for a layer drawn full-frame (size the surface, clear, draw,
 *   transferToImageBitmap) against the same layer as a tight sprite (its reach, the sprite's surface, the
 *   draw, the edge-ring check, the transfer), at 1920 and 3840;
 * - upload preparation: the bytes the render worker hands to `copyExternalImageToTexture` for each (the
 *   GPU's own time is measured on venue hardware by gpu-venue.ts);
 * - Canvas 2D compositing (the fallback compositor): one frame of five layers, full-frame transparent
 *   bitmaps against sprites, on a software canvas.
 */

const WHITE = { r: 255, g: 255, b: 255, a: 1 };

const LYRIC =
  'Amazing grace, how sweet the sound\nThat saved a wretch like me\nI once was lost, but now am found\nWas blind, but now I see';

const lyric = (rich: boolean): TextObject => ({
  id: 'lyric',
  type: 'text',
  box: { x: 160, y: 120, w: 1600, h: 840, rotation: 0 },
  text: LYRIC,
  style: {
    ...DEFAULT_LYRIC_STYLE,
    fontFamily: 'Bench',
    fontSizePx: 84,
    ...(rich ? { lineModel: 'office' } : {}),
  },
  opacity: 1,
  ...(rich ? { runs: [{ start: 0, end: 13, color: { r: 255, g: 200, b: 60, a: 1 } }] } : {}),
});

const bandLook: Look = {
  ...LOOK_LOWER_THIRD,
  layers: {
    ...LOOK_LOWER_THIRD.layers,
    slide: {
      mode: 'lyricOnly',
      style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Bench', fontSizePx: 64 },
      band: { x: 160, y: 760, w: 1600, h: 280, rotation: 0 },
      nonSong: 'none',
    },
  },
} as Look;

const titleSlide: Slide = {
  id: 'title',
  objects: [
    {
      id: 't',
      type: 'text',
      box: { x: 160, y: 380, w: 1600, h: 320, rotation: 0 },
      text: 'Welcome to our service\nPlease find a seat',
      style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Bench', fontSizePx: 88, lineModel: 'office' },
      opacity: 1,
    } as TextObject,
  ],
};

type Job = {
  name: string;
  reach: (c: Ctx2D, scale: number) => Reach;
  draw: (c: Ctx2D, scale: number) => void;
};

const JOBS: Job[] = [
  {
    name: 'lyric-only band (legacy text)',
    reach: (c, s) => slideReach(c, { id: 'a', objects: [lyric(false)] }, { scale: s, look: bandLook }),
    draw: (c, s) => rasterSlide(c, { id: 'a', objects: [lyric(false)] }, bandLook, s, () => undefined),
  },
  {
    name: 'lyric-only band (rich source)',
    reach: (c, s) => slideReach(c, { id: 'b', objects: [lyric(true)] }, { scale: s, look: bandLook }),
    draw: (c, s) => rasterSlide(c, { id: 'b', objects: [lyric(true)] }, bandLook, s, () => undefined),
  },
  {
    name: 'lower third',
    reach: (c, s) => lowerThirdReach(c, 'Pastor Anna Smith\nWelcome', LOOK_MAIN, s),
    draw: (c, s) => rasterLowerThird(c, 'Pastor Anna Smith\nWelcome', LOOK_MAIN, s),
  },
  {
    name: 'authored title (rich, middle of the frame)',
    reach: (c, s) => slideReach(c, titleSlide, { scale: s, look: LOOK_MAIN }),
    draw: (c, s) => rasterSlide(c, titleSlide, LOOK_MAIN, s, () => undefined),
  },
  {
    name: 'six-line authored lyric (rich, most of the frame)',
    reach: (c, s) => slideReach(c, { id: 'c', objects: [lyric(true)] }, { scale: s, look: LOOK_MAIN }),
    draw: (c, s) => rasterSlide(c, { id: 'c', objects: [lyric(true)] }, LOOK_MAIN, s, () => undefined),
  },
];

export type Stats = { p50: number; p95: number };
export type SpriteReport = {
  raster: {
    name: string;
    width: number;
    full: Stats;
    sprite: Stats;
    /** The sprite's share of the frame (1: drawn full-frame). */
    share: number;
    /** Bytes handed to the upload: full-frame, sprite. */
    bytes: [number, number];
    /** Parts of the sprite's time: the reach alone, and the tight draw and transfer without the ring check. */
    reach?: Stats;
    drawOnly?: Stats;
  }[];
  compose: { width: number; full: Stats; sprite: Stats }[];
};

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length / 2)]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! };
}

/** The asset worker's surface (asset.worker.ts `surface`): one CPU-backed canvas, sized per job. */
function surfaceOf(canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D) {
  return (w: number, h: number): Ctx2D => {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  };
}

export async function bench(set: FontFaceSet, font: ArrayBuffer, iterations: number): Promise<SpriteReport> {
  const resolver = new FontResolver({ set, data: async () => font.slice(0) });
  await resolver.sync([{ family: 'Bench', weight: 400, style: 'normal', hash: 'regular' }]);
  installFontEnv(resolver);
  const report: SpriteReport = { raster: [], compose: [] };
  for (const width of [1920, 3840]) {
    const height = (width * 9) / 16;
    const scale = width / 1920;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const surface = surfaceOf(canvas, ctx);
    const take = () => canvas.transferToImageBitmap();
    const sprites: { bitmap: ImageBitmap; x: number; y: number }[] = [];
    for (const job of JOBS) {
      const full: number[] = [];
      const tight: number[] = [];
      const parts = { reach: [] as number[], draw: [] as number[] };
      let share = 1;
      let bytes = 0;
      for (let i = 0; i < iterations + 5; i++) {
        let t = performance.now();
        const c = surface(width, height);
        job.draw(c, scale);
        take().close();
        const f = performance.now() - t;
        t = performance.now();
        // As the asset worker measures: on its surface shrunk to 1x1 (no full-frame backing for a sprite).
        canvas.width = 1;
        canvas.height = 1;
        const rect = spriteRect(job.reach(ctx, scale), scale, width, height);
        const tr = performance.now() - t;
        const d = drawSprite(surface, take, width, height, rect, (x) => job.draw(x, scale));
        const s = performance.now() - t;
        if (rect && i >= 5) {
          // Parts: the tight draw and transfer without the edge-ring check.
          const t2 = performance.now();
          const c2 = surface(rect.w, rect.h);
          c2.translate(-rect.x, -rect.y);
          job.draw(c2, scale);
          take().close();
          parts.reach.push(tr);
          parts.draw.push(performance.now() - t2);
        }
        share = (d.bitmap.width * d.bitmap.height) / (width * height);
        bytes = d.bitmap.width * d.bitmap.height * 4;
        if (i === iterations + 4 && width === 3840) sprites.push(d);
        else d.bitmap.close();
        if (i >= 5) {
          full.push(f);
          tight.push(s);
        }
      }
      report.raster.push({
        name: job.name,
        width,
        full: stats(full),
        sprite: stats(tight),
        share,
        bytes: [width * height * 4, bytes],
        reach: parts.reach.length ? stats(parts.reach) : undefined,
        drawOnly: parts.draw.length ? stats(parts.draw) : undefined,
      });
    }
    // Canvas 2D compositing of five layers: full-frame transparent bitmaps against the sprites above.
    const pick = JOBS.slice(0, LAYERS.length);
    const fullBitmaps: ImageBitmap[] = [];
    const spriteBitmaps: { bitmap: ImageBitmap; x: number; y: number }[] = [];
    for (const job of pick) {
      const c = surface(width, height);
      job.draw(c, scale);
      fullBitmaps.push(take());
      const d = drawSprite(
        surface,
        take,
        width,
        height,
        spriteRect(job.reach(ctx, scale), scale, width, height),
        (x) => job.draw(x, scale),
      );
      spriteBitmaps.push(d);
    }
    const out = new OffscreenCanvas(width, height);
    const comp = new Canvas2DCompositor(out, width, height);
    const inputs = (tightLayers: boolean): FrameInputs => {
      const layers = LAYERS.map(() => new LayerStack<ImageBitmap>());
      layers.forEach((ls, l) => {
        const b = tightLayers ? spriteBitmaps[l]! : { bitmap: fullBitmaps[l]!, x: 0, y: 0 };
        ls.offer({ key: `k${l}`, kind: SRC_BITMAP, bitmap: b.bitmap, x: b.x, y: b.y });
        ls.requestFlip(`k${l}`, 0, 0, 0);
        ls.tick(0, 16);
      });
      return {
        layers,
        video: {
          frames: [null, null, null, null],
          version: new Int32Array(4),
          gen: new Int32Array(4).fill(-1),
        },
        now: 0,
        clear: new Float32Array([0, 0, 0, 1]),
        testPixel: new Int32Array([-1, 0, 0]),
      };
    };
    const frame = (f: FrameInputs) => {
      const t = performance.now();
      comp.draw(f);
      // Make Chromium raster the recorded draws (what presenting the frame costs).
      out.getContext('2d')!.getImageData(0, 0, 1, 1);
      return performance.now() - t;
    };
    const fFull = inputs(false);
    const fSprite = inputs(true);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < Math.min(iterations, 40) + 3; i++) {
      const x = frame(fFull);
      const y = frame(fSprite);
      if (i >= 3) {
        a.push(x);
        b.push(y);
      }
    }
    report.compose.push({ width, full: stats(a), sprite: stats(b) });
    for (const x of fullBitmaps) x.close();
    for (const x of spriteBitmaps) x.bitmap.close();
    for (const x of sprites) x.bitmap.close();
  }
  resolver.dispose();
  return report;
}

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined';

if (inWorker) {
  const scope = self as unknown as { fonts: FontFaceSet; onmessage: unknown; postMessage(m: unknown): void };
  scope.onmessage = async (e: MessageEvent<{ font: ArrayBuffer; iterations: number }>) => {
    try {
      scope.postMessage({ ok: true, report: await bench(scope.fonts, e.data.font, e.data.iterations) });
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
  (window as unknown as { __sprites: unknown }).__sprites = (
    source: string,
    font: string,
    iterations: number,
  ) =>
    new Promise<SpriteReport>((resolve, reject) => {
      const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      w.onmessage = (e: MessageEvent<{ ok: boolean; report?: SpriteReport; error?: string }>) => {
        w.terminate();
        if (e.data.ok) resolve(e.data.report!);
        else reject(new Error(e.data.error));
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ font: b64(font), iterations });
    });
}
void WHITE;
