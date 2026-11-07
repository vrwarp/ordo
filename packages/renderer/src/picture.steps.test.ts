import type { ImageObject } from '@ordo/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RecPath } from './geom/path2d.test-util.ts';
import {
  isVectorPicture,
  paintPicture,
  type PictureDraw,
  type PictureFrom,
  type PictureSourceStep,
  pictureTarget,
  preparedKey,
  preparePicture,
  preparePictureSteps,
  registerPicturePost,
  registerPictureSource,
  registerPictureTarget,
  sourceSize,
  type VectorPicture,
} from './picture.ts';
import { drawImageFit } from './text2d.ts';
import { type TraceCtx, traceCtx, traceDigest } from './trace.test-util.ts';

/*
 * The picture pipeline's seams (design/27 M9 render-seams): a picture is prepared from a source step (a canvas
 * image as today, or a source a step draws, such as a vector picture), then post steps, with keys that target
 * extensions can widen. With nothing registered, `preparePicture` must make the bitmap it made before the
 * seam: each case logs every call and assignment on the preparation's canvas and pins the log's digest,
 * recorded on the code before the seam.
 */

/** Canvases the preparations made, newest last; each one's context logs what is drawn on it. */
const made: { canvas: FakeCanvas; ctx: TraceCtx }[] = [];

class FakeCanvas {
  ctx: TraceCtx;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.ctx = traceCtx(width, height);
    made.push({ canvas: this, ctx: this.ctx });
  }
  getContext(_kind: string, opts?: unknown) {
    this.ctx.trace.push(['call', 'getContext', JSON.stringify(opts ?? null)]);
    return this.ctx;
  }
  transferToImageBitmap() {
    this.ctx.trace.push(['call', 'transferToImageBitmap']);
    return { width: this.width, height: this.height, close() {} };
  }
}

beforeAll(() => {
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('Path2D', RecPath);
});
afterAll(() => vi.unstubAllGlobals());

const photo = { width: 1600, height: 1000, id: 'photo' } as unknown as CanvasImageSource;
const picture = (o: Partial<ImageObject>): PictureDraw =>
  ({
    box: { x: 200, y: 100, w: 800, h: 450, rotation: 0 },
    fit: 'cover',
    radius: 0,
    ...o,
  }) as PictureDraw;

const CASES: Record<string, { o: PictureDraw; scale: number; from?: PictureFrom; step?: number }> = {
  cover: { o: picture({}), scale: 1 },
  'contain 4k': { o: picture({ fit: 'contain' }), scale: 2 },
  'crop and stretch': {
    o: picture({ fit: 'stretch', crop: { l: 0.1, t: -0.05, r: 0.2, b: 0.1 } }),
    scale: 1.5,
  },
  'off the frame': { o: picture({ box: { x: 1500, y: 800, w: 900, h: 600, rotation: 0 } }), scale: 1 },
  'masked and flipped': {
    o: picture({ mask: { preset: 'ellipse' }, flipH: true, radius: 20 }),
    scale: 1,
  },
  'turned in a mask': {
    o: picture({ mask: { preset: 'star5' }, box: { x: 300, y: 200, w: 600, h: 400, rotation: 30 } }),
    scale: 2,
  },
  'banded with a mask': {
    o: picture({ mask: { preset: 'roundRect' }, flipV: true }),
    scale: 2,
    step: 300_000,
  },
  'banded crop-aware': {
    o: picture({ crop: { l: 0.2, t: 0.1, r: 0.1, b: 0.2 } }),
    scale: 2,
    from: { iw: 6000, ih: 4000, x: 1000, y: 300, w: 4500, h: 3000 },
    step: 500_000,
  },
};

/** The digests of each case's log on the code before the seam, recorded then. */
const BEFORE: Record<string, string> = {
  'banded crop-aware': '1600x900 0 0 1600 900 cover 0.2 0.1 0.1 0.2 8d37d38f1aa1cc39',
  'banded with a mask': '1600x900 0 0 1600 900 cover vm1p6mhye6onskdm d41f60d14fa72772',
  'contain 4k': '1600x900 0 0 1600 900 contain d90306be4630b707',
  cover: '800x450 0 0 800 450 cover d777fe87d5f5c927',
  'crop and stretch': '1200x675 0 0 1200 675 stretch 0.1 -0.05 0.2 0.1 4e9e1a9596fdc26c',
  'masked and flipped': '800x450 0 0 800 450 cover hmc02kn61qmfxn7k 59e7b07e0c48c4d7',
  'off the frame': '420x280 0 0 900 600 cover 12d7e4f4acdc0e0d',
  'turned in a mask': '1440x1294 120 247 1200 800 cover r30 m1wvka2n1nmahrni 2c5a94c1c3069a03',
};

function prepare(c: (typeof CASES)[string]): { digest: string; key?: string } {
  made.length = 0;
  const t = pictureTarget(c.o, c.scale);
  if (!t) return { digest: 'no target' };
  const bmp =
    c.step === undefined
      ? preparePicture(photo, t, c.from)
      : (() => {
          const g = preparePictureSteps(photo, t, c.from, c.step);
          for (;;) {
            const r = g.next();
            if (r.done) return r.value;
          }
        })();
  const trace = made.flatMap((m) => [
    ['call', 'canvas', m.canvas.width, m.canvas.height] as const,
    ...m.ctx.trace,
  ]);
  return { digest: `${t.key} ${traceDigest(trace)}`, key: bmp ? preparedKey(bmp) : undefined };
}

describe('picture steps (M9 render-seams)', () => {
  it('no steps registered = today’s prepared bitmap', () => {
    const got: Record<string, string> = {};
    for (const [name, c] of Object.entries(CASES)) {
      const r = prepare(c);
      got[name] = r.digest;
      expect(r.key).toBe(r.digest.slice(0, r.digest.lastIndexOf(' ')));
    }
    expect(got).toEqual(BEFORE);
  });

  const vector: VectorPicture = { kind: 'vector', width: 1600, height: 1000, bytes: 4096, close() {} };

  it('draws a vector picture through the source step that accepts it, where drawImage draws a bitmap', () => {
    expect(isVectorPicture(vector)).toBe(true);
    expect(isVectorPicture(photo)).toBe(false);
    expect(sourceSize(vector)).toEqual([1600, 1000]);
    const drawn: number[][] = [];
    const step: PictureSourceStep = {
      name: 'vector',
      accepts: isVectorPicture,
      draw: (_ctx, src, ...rect) => {
        expect(src).toBe(vector);
        drawn.push(rect.map((v) => Math.round(v * 1e9) / 1e9)); // as the trace logs numbers
      },
    };
    // With no step a vector picture draws nothing (no decoder hands one out without its step).
    const none = traceCtx(1920, 1080);
    paintPicture(none, vector, 0, 0, 800, 500, 'cover', undefined);
    expect(none.trace.filter((e) => e[1] === 'drawImage')).toEqual([]);
    const off = registerPictureSource(step);
    try {
      for (const crop of [undefined, { l: 0.1, t: 0.2, r: 0, b: 0.1 }]) {
        drawn.length = 0;
        const bitmap = traceCtx(1920, 1080);
        paintPicture(bitmap, photo, 10, 20, 800, 500, 'contain', crop);
        const vec = traceCtx(1920, 1080);
        paintPicture(vec, vector, 10, 20, 800, 500, 'contain', crop);
        expect(vec.trace.filter((e) => e[1] === 'drawImage')).toEqual([]);
        // The 9-argument rectangles a bitmap of the same size is drawn with (the 5-argument call: its whole).
        const call = bitmap.trace.find((e) => e[1] === 'drawImage')!.slice(3) as number[];
        expect(drawn).toEqual([call.length === 4 ? [0, 0, 1600, 1000, ...call] : call]);
      }
      // A prepared vector picture is played into the bitmap at its device size, then copied 1:1.
      drawn.length = 0;
      const t = pictureTarget(picture({}), 2)!;
      const bmp = preparePicture(vector, t)!;
      expect(preparedKey(bmp)).toBe(t.key);
      expect(drawn).toEqual([[0, 0, 1600, 1000, 0, -50, 1600, 1000]]);
      const out = traceCtx(3840, 2160);
      drawImageFit(out, bmp, picture({}).box, 2, 'cover', 1, 0, undefined, t);
      expect(out.trace.filter((e) => e[1] === 'drawImage')).toEqual([
        ['call', 'drawImage', { image: [1600, 900, ''] }, 400, 200],
      ]);
    } finally {
      off();
    }
  });

  it('a target extension widens the key and hands its data on, or refuses to prepare', () => {
    const o = { ...picture({}), look3d: { bevel: { w: 6 } } } as PictureDraw & { look3d?: unknown };
    const plain = pictureTarget(o, 1)!;
    const off = registerPictureTarget({
      name: 'look3d',
      extend: (p) => {
        const look = (p as { look3d?: { bevel?: { w: number } } }).look3d;
        if (!look) return undefined;
        return look.bevel?.w === 0 ? false : { key: `b${look.bevel?.w}`, data: look };
      },
    });
    try {
      const t = pictureTarget(o, 1)!;
      expect(t.key).toBe(`${plain.key} look3d:b6`);
      expect(t.ext).toEqual({ look3d: o.look3d });
      expect({ ...t, key: plain.key, ext: undefined }).toEqual({ ...plain, ext: undefined });
      // Nothing to add: the same target as before.
      expect(pictureTarget(picture({}), 1)).toEqual(plain);
      expect(pictureTarget({ ...o, look3d: { bevel: { w: 0 } } } as PictureDraw, 1)).toBeUndefined();
    } finally {
      off();
    }
    expect(pictureTarget(o, 1)).toEqual(plain);
  });

  it('post steps run over the finished pixels, after the mask’s cut, in a step of their own', () => {
    const seen: string[] = [];
    const off = registerPicturePost({
      name: 'rim',
      applies: (t) => !!t.shape?.mask,
      run: (ctx, t, src) => {
        expect(src).toBe(photo);
        seen.push(t.key);
        ctx.fillRect(0, 0, 1, 1);
      },
    });
    try {
      const masked = pictureTarget(picture({ mask: { preset: 'ellipse' } }), 2)!;
      made.length = 0;
      const g = preparePictureSteps(photo, masked, undefined, 300_000);
      let steps = 0;
      for (;;) {
        const r = g.next();
        if (r.done) break;
        steps++;
      }
      expect(seen).toEqual([masked.key]);
      const trace = made[0]!.ctx.trace;
      const cut = trace.findIndex((e) => e[0] === 'set' && e[1] === 'globalCompositeOperation');
      const post = trace.findIndex((e) => e[1] === 'fillRect');
      const taken = trace.findIndex((e) => e[1] === 'transferToImageBitmap');
      expect(cut).toBeGreaterThan(0);
      expect(post).toBeGreaterThan(cut);
      expect(taken).toBeGreaterThan(post);
      // One more step than without it (the bands, the cut, then the post step).
      const plainSteps = [
        ...(function* () {
          const h = preparePictureSteps(photo, masked, undefined, 300_000);
          for (;;) {
            const r = h.next();
            if (r.done) return;
            yield 1;
          }
        })(),
      ].length;
      expect(steps).toBe(plainSteps);
      // A target it does not apply to: today's bitmap.
      expect(prepare(CASES.cover!).digest).toBe(BEFORE.cover);
    } finally {
      off();
    }
  });
});
