import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOK_LOWER_THIRD, LOOK_MAIN, type Look, type Slide, type SlideObject } from '@ordo/domain';
import {
  MAX_PREPARED_PIXELS,
  type PictureFrom,
  type PictureTarget,
  decodePlan,
  paintPicture,
  paintPictureFrom,
  pictureRegion,
  pictureTarget,
  preparePicture,
  preparePictureSteps,
  preparedKey,
  sourceSize,
} from './picture.ts';
import { drawImageFit, drawObject, drawSlide2D, slidePictures } from './text2d.ts';

/** A 2D context that records every call with its numeric arguments and the image drawn. */
function recorder() {
  const calls: { op: string; args: number[]; img?: unknown }[] = [];
  const state = { globalAlpha: 1, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' };
  const rec =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({
        op,
        args: args.filter((a): a is number => typeof a === 'number'),
        img: op === 'drawImage' ? args[0] : undefined,
      });
    };
  const ctx = {
    ...state,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    rect: rec('rect'),
    roundRect: rec('roundRect'),
    clip: rec('clip'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    drawImage: rec('drawImage'),
    ellipse: rec('ellipse'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    measureText: () => ({ width: 10 }),
  };
  const draws = () => calls.filter((c) => c.op === 'drawImage');
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, draws, state: ctx };
}

const source = (width: number, height: number) => ({ width, height }) as unknown as CanvasImageSource;

/** An OffscreenCanvas stand-in for preparePicture: records its context and hands back a bitmap stub. */
function stubOffscreen() {
  const made: { w: number; h: number; opts: unknown; rec: ReturnType<typeof recorder>; bmp: object }[] = [];
  class FakeOffscreen {
    private readonly entry: (typeof made)[number];
    constructor(w: number, h: number) {
      this.entry = { w, h, opts: undefined, rec: recorder(), bmp: { width: w, height: h, close() {} } };
      made.push(this.entry);
    }
    getContext(_kind: string, opts: unknown) {
      this.entry.opts = opts;
      return this.entry.rec.ctx;
    }
    transferToImageBitmap() {
      return this.entry.bmp;
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
  return made;
}

afterEach(() => vi.unstubAllGlobals());

const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });

describe('pictureTarget: the device pixels a picture is prepared for (design/27 §7.1)', () => {
  it('covers the box with whole device pixels and keeps its exact position inside them', () => {
    const t = pictureTarget({ box: box(46.961, 0, 1826.078, 1080), fit: 'stretch' }, 1)!;
    expect([t.x, t.y, t.w, t.h]).toEqual([46, 0, 1828, 1080]);
    expect(t.bx).toBeCloseTo(0.961, 9);
    expect(t.bw).toBeCloseTo(1826.078, 9);
    expect([t.by, t.bh]).toEqual([0, 1080]);
    const t2 = pictureTarget({ box: box(46.961, 0, 1826.078, 1080), fit: 'stretch' }, 2)!;
    expect([t2.x, t2.y, t2.w, t2.h]).toEqual([93, 0, 3654, 2160]);
    expect(t2.bx).toBeCloseTo(0.922, 9);
    expect(t2.bw).toBeCloseTo(3652.156, 9);
    // A box on whole pixels is its own rectangle, also through float noise.
    const whole = pictureTarget({ box: box(0.1 + 0.2, 0.7, 100, 50), fit: 'stretch' }, 10)!;
    expect([whole.x, whole.y, whole.w, whole.h, whole.bx, whole.by]).toEqual([3, 7, 1000, 500, 0, 0]);
    const full = pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 2)!;
    expect([full.x, full.y, full.w, full.h, full.bx, full.by, full.bw, full.bh]).toEqual([
      0, 0, 3840, 2160, 0, 0, 3840, 2160,
    ]);
  });

  it('keys the pixels by size, sub-pixel offset, fit and crop, not by whole-pixel position', () => {
    const at = (x: number, extra: Partial<Parameters<typeof pictureTarget>[0]> = {}) =>
      pictureTarget({ box: box(x, 10, 400, 300), fit: 'cover', ...extra }, 1)!.key;
    expect(at(10)).toBe(at(500));
    expect(at(10.25)).toBe(at(500.25));
    expect(at(10.25)).not.toBe(at(10));
    expect(at(10)).not.toBe(at(10, { fit: 'contain' }));
    expect(at(10, { crop: { l: 0.1, t: 0, r: 0, b: 0 } })).not.toBe(at(10));
    expect(at(10, { crop: { l: 0.1, t: 0, r: 0, b: 0 } })).not.toBe(
      at(10, { crop: { l: 0, t: 0.1, r: 0, b: 0 } }),
    );
    // A crop that cuts nothing is no crop.
    expect(at(10, { crop: { l: 0, t: 0, r: 0, b: 0 } })).toBe(at(10));
    expect(pictureTarget({ box: box(0, 0, 400, 300), fit: 'cover' }, 1)!.key).not.toBe(
      pictureTarget({ box: box(0, 0, 400, 301), fit: 'cover' }, 1)!.key,
    );
  });

  it('applies the fit and the clamped crop drawImageFit applies', () => {
    const t = pictureTarget(
      { box: box(0, 0, 10, 10), fit: 'tile' as never, crop: { l: Number.NaN, t: -5, r: 0.25, b: 0 } },
      1,
    )!;
    expect(t.fit).toBe('cover');
    expect(t.crop).toEqual({ l: 0, t: -1, r: 0.25, b: 0 });
  });

  it('leaves rotated, round-cornered, empty and oversized pictures to the source path', () => {
    expect(pictureTarget({ box: box(0, 0, 400, 300, 15), fit: 'stretch' }, 1)).toBeUndefined();
    expect(pictureTarget({ box: box(0, 0, 400, 300), fit: 'stretch', radius: 12 }, 1)).toBeUndefined();
    expect(pictureTarget({ box: box(10.2, 0, 0, 300), fit: 'stretch' }, 1)).toBeUndefined();
    expect(pictureTarget({ box: box(0, 0, 400, 300), fit: 'stretch' }, Number.NaN)).toBeUndefined();
    // The whole frame at 4K is 8.3 MP, under the 16 MP cap.
    expect(pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'stretch' }, 2)).toBeDefined();
    expect(3840 * 2160).toBeLessThanOrEqual(MAX_PREPARED_PIXELS);
    // Entirely off the canvas: nothing to prepare.
    expect(pictureTarget({ box: box(1920, 0, 400, 300), fit: 'stretch' }, 1)).toBeUndefined();
    expect(pictureTarget({ box: box(-400, -300, 400, 300), fit: 'stretch' }, 1)).toBeUndefined();
  });

  it('prepares only the part of the box on the canvas, keeping the box where it is', () => {
    // A full-bleed photo overflowing the slide on every side: at most the output's pixels (8.3 MB at 1920),
    // not its 3920x2280 box (35.8 MB).
    const t = pictureTarget({ box: box(-1000, -600, 3920, 2280), fit: 'cover' }, 1)!;
    expect([t.x, t.y, t.w, t.h]).toEqual([0, 0, 1920, 1080]);
    expect([t.bx, t.by, t.bw, t.bh]).toEqual([-1000, -600, 3920, 2280]);
    const t2 = pictureTarget({ box: box(-960, -540, 3840, 2160), fit: 'stretch' }, 2)!;
    expect([t2.x, t2.y, t2.w, t2.h, t2.bx, t2.by]).toEqual([0, 0, 3840, 2160, -1920, -1080]);
    // A box over the right edge: cut there, its sub-pixel offset kept.
    const r = pictureTarget({ box: box(1800.5, 100, 400, 300), fit: 'cover' }, 1)!;
    expect([r.x, r.y, r.w, r.h, r.bx, r.bw]).toEqual([1800, 100, 120, 300, 0.5, 400]);
    // The cut is part of the key: the same box elsewhere is other pixels.
    expect(r.key).not.toBe(pictureTarget({ box: box(800.5, 100, 400, 300), fit: 'cover' }, 1)!.key);
  });

  it('draws the visible part of an overflowing picture where the unprepared path draws it', () => {
    const made = stubOffscreen();
    const t = pictureTarget({ box: box(-100, -50, 400, 300), fit: 'stretch' }, 1)!;
    expect([t.x, t.y, t.w, t.h]).toEqual([0, 0, 300, 250]);
    preparePicture(source(400, 300), t);
    expect([made[0]!.w, made[0]!.h]).toEqual([300, 250]);
    const calls = made[0]!.rec.calls;
    expect(calls.find((o) => o.op === 'rect')?.args).toEqual([-100, -50, 400, 300]);
    expect(calls.find((o) => o.op === 'drawImage')?.args).toEqual([-100, -50, 400, 300]);
  });
});

describe('preparePicture', () => {
  it('resamples once, with mipmapped smoothing on an sRGB CPU canvas of the target size', () => {
    const made = stubOffscreen();
    const t = pictureTarget({ box: box(46.961, 0, 1826.078, 1080), fit: 'stretch' }, 2)!;
    const src = source(957, 566);
    const bmp = preparePicture(src, t)!;
    expect(made).toHaveLength(1);
    const c = made[0]!;
    expect([c.w, c.h]).toEqual([3654, 2160]);
    expect(c.opts).toEqual({ willReadFrequently: true, colorSpace: 'srgb' });
    expect(c.rec.state.imageSmoothingEnabled).toBe(true);
    expect(c.rec.state.imageSmoothingQuality).toBe('medium');
    // The whole picture stretched over the box at its sub-pixel offset, clipped to it: upscaled once, here.
    const clip = c.rec.calls.find((k) => k.op === 'rect')!.args;
    const draw = c.rec.draws()[0]!.args;
    for (const [i, v] of [0.922, 0, 3652.156, 2160].entries()) {
      expect(clip[i]).toBeCloseTo(v, 9);
      expect(draw[i]).toBeCloseTo(v, 9);
    }
    expect(bmp).toBe(c.bmp);
    expect(preparedKey(bmp)).toBe(t.key);
    expect(preparedKey(src)).toBeUndefined();
    // The prepared bitmap is the box's size; what it is fitted with is still its source's.
    expect([bmp.width, bmp.height]).toEqual([3654, 2160]);
    expect(sourceSize(bmp)).toEqual([957, 566]);
    expect(sourceSize(src)).toEqual([957, 566]);
    const video = { width: 0, height: 0, videoWidth: 1280, videoHeight: 720 } as unknown as CanvasImageSource;
    expect(sourceSize(video)).toEqual([1280, 720]);
    expect(sourceSize(preparePicture(video, t)!)).toEqual([1280, 720]);
    expect(sourceSize({} as CanvasImageSource)).toEqual([0, 0]);
  });

  it('puts every picture pixel where drawImageFit puts it from the source', () => {
    const crops = [
      undefined,
      { l: 0.25, t: 0.1, r: 0, b: 0.2 },
      { l: -0.25, t: -0.2, r: -0.25, b: 0 },
      { l: -0.5, t: 0.25, r: 0.25, b: 0.25 },
      { l: 0.6, t: 0, r: 0.5, b: 0 },
    ];
    for (const scale of [1, 1.5, 2])
      for (const fit of ['contain', 'cover', 'stretch'] as const)
        for (const crop of crops) {
          const made = stubOffscreen();
          const o = { box: box(100.3, 50.6, 400.2, 300.1), fit, crop };
          const t = pictureTarget(o, scale)!;
          preparePicture(source(800, 600), t);
          const want = recorder();
          drawImageFit(want.ctx, source(800, 600), o.box, scale, fit, 1, 0, crop);
          // The same source rect, landing at the same device position once the bitmap sits at (x, y).
          const got = made[0]!.rec.draws().map((d) => {
            const a = [...d.args];
            const n = a.length;
            a[n - 4]! += t.x;
            a[n - 3]! += t.y;
            return a;
          });
          const exp = want.draws().map((d) => d.args);
          expect(got.length).toBe(exp.length);
          for (let i = 0; i < exp.length; i++)
            for (let k = 0; k < exp[i]!.length; k++) expect(got[i]![k]).toBeCloseTo(exp[i]![k]!, 9);
        }
  });

  it('gives nothing without an OffscreenCanvas (the caller draws the source)', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const t = pictureTarget({ box: box(0, 0, 10, 10), fit: 'stretch' }, 1)!;
    expect(preparePicture(source(10, 10), t)).toBeUndefined();
  });
});

describe('crop-aware decode: the part of a picture a target shows (design/27 §7.5)', () => {
  it('is the visible crop of a covering photo, at the scale it is shown at', () => {
    // A 4:3 photo covering the 16:9 frame at 1080p: 375 rows are cut above and below.
    const t = pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 1)!;
    const r = pictureRegion(t, 4000, 3000)!;
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(375, 9);
    expect(r.w).toBeCloseTo(4000, 9);
    expect(r.h).toBeCloseTo(2250, 9);
    expect(r.scale).toBeCloseTo(0.48, 9);
    // At 4K the same part, twice the scale.
    expect(
      pictureRegion(pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 2)!, 4000, 3000)!.scale,
    ).toBeCloseTo(0.96, 9);
    // A crop share and a box overflowing the slide narrow the part further.
    const cropped = pictureTarget(
      { box: box(-960, 0, 1920, 1080), fit: 'stretch', crop: { l: 0.5, t: 0, r: 0, b: 0 } },
      1,
    )!;
    const c = pictureRegion(cropped, 4000, 3000)!;
    expect(c.x).toBeCloseTo(3000, 9); // the right half of the crop is on the slide
    expect(c.w).toBeCloseTo(1000, 9);
    expect(c.h).toBeCloseTo(3000, 9);
    expect(c.scale).toBeCloseTo(0.96, 9); // 1920 px for 2000 picture px across
    // A crop that leaves nothing, and an empty picture, show nothing.
    expect(
      pictureRegion(
        pictureTarget({ box: box(0, 0, 100, 100), fit: 'stretch', crop: { l: 0.6, t: 0, r: 0.5, b: 0 } }, 1)!,
        100,
        100,
      ),
    ).toBeUndefined();
    expect(pictureRegion(t, 0, 10)).toBeUndefined();
  });

  it('plans one decode for every target of a file: the union of their parts at the largest scale', () => {
    const big = pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 1)!;
    const small = pictureTarget(
      { box: box(100, 100, 200, 100), fit: 'stretch', crop: { l: 0, t: 0, r: 0.9, b: 0.9 } },
      1,
    )!;
    const p = decodePlan([big, small], 4000, 3000)!;
    expect(p.y).toBeCloseTo(0, 9); // the small one shows the top tenth
    expect(p.h).toBeCloseTo(2625, 9);
    expect(p.scale).toBeCloseTo(0.5, 9); // 200 px for 400 picture px
    expect(decodePlan([], 4000, 3000)).toBeUndefined();
  });

  it('draws every visible pixel from a decoded crop where it lands from the whole picture', () => {
    const fits = ['contain', 'cover', 'stretch'] as const;
    const share = fc.double({ min: -0.4, max: 0.45, noNaN: true });
    fc.assert(
      fc.property(
        fc.record({
          x: fc.double({ min: -400, max: 1800, noNaN: true }),
          y: fc.double({ min: -300, max: 1000, noNaN: true }),
          w: fc.double({ min: 20, max: 2400, noNaN: true }),
          h: fc.double({ min: 20, max: 1400, noNaN: true }),
          fit: fc.constantFrom(...fits),
          crop: fc.option(fc.record({ l: share, t: share, r: share, b: share }), { nil: undefined }),
          scale: fc.constantFrom(0.5, 1, 2),
          iw: fc.integer({ min: 50, max: 6000 }),
          ih: fc.integer({ min: 50, max: 4000 }),
          k: fc.constantFrom(1, 0.5, 0.25),
        }),
        (g) => {
          const t = pictureTarget({ box: box(g.x, g.y, g.w, g.h), fit: g.fit, crop: g.crop }, g.scale);
          if (!t) return;
          const plan = decodePlan([t], g.iw, g.ih);
          const whole = recorder();
          whole.ctx.beginPath();
          paintPicture(whole.ctx, source(g.iw, g.ih), t.bx, t.by, t.bw, t.bh, t.fit, t.crop);
          if (!plan) {
            // Nothing visible: whatever the whole picture draws lies outside the box or the canvas.
            for (const d of whole.draws()) {
              const [dx, dy, dw, dh] = d.args.slice(-4) as [number, number, number, number];
              const ix = Math.min(dx + dw, t.bx + t.bw, t.w) - Math.max(dx, t.bx, 0);
              const iy = Math.min(dy + dh, t.by + t.bh, t.h) - Math.max(dy, t.by, 0);
              expect(ix <= 1e-6 || iy <= 1e-6).toBe(true);
            }
            return;
          }
          // The decoded part: the plan padded by two picture pixels, at k of the picture's size.
          const fx = Math.max(0, Math.floor(plan.x) - 2);
          const fy = Math.max(0, Math.floor(plan.y) - 2);
          const from: PictureFrom = {
            iw: g.iw,
            ih: g.ih,
            x: fx,
            y: fy,
            w: Math.min(g.iw, Math.ceil(plan.x + plan.w) + 2) - fx,
            h: Math.min(g.ih, Math.ceil(plan.y + plan.h) + 2) - fy,
          };
          const part = recorder();
          paintPictureFrom(
            part.ctx,
            source(from.w * g.k, from.h * g.k),
            from,
            t.bx,
            t.by,
            t.bw,
            t.bh,
            t.fit,
            t.crop,
          );
          const a = whole.draws()[0]!.args;
          const b = part.draws()[0]!.args;
          // The whole picture's mapping from picture pixels to device pixels.
          const [sx, sy, sw, sh] = a.length === 8 ? a.slice(0, 4) : [0, 0, g.iw, g.ih];
          const [dx, dy, dw, dh] = a.slice(-4) as [number, number, number, number];
          // The part maps the same picture pixels to the same device pixels...
          const px = from.x + b[0]! / g.k;
          const py = from.y + b[1]! / g.k;
          expect(b[4]!).toBeCloseTo(dx + ((px - sx!) * dw) / sw!, 6);
          expect(b[5]!).toBeCloseTo(dy + ((py - sy!) * dh) / sh!, 6);
          expect(b[6]! / (b[2]! / g.k)).toBeCloseTo(dw / sw!, 6);
          expect(b[7]! / (b[3]! / g.k)).toBeCloseTo(dh / sh!, 6);
          // ...and covers everything the whole picture puts inside the box on the canvas.
          const vis = (r: number[]) => {
            const [x, y, w, h] = r.slice(-4) as [number, number, number, number];
            return [
              Math.max(x, t.bx, 0),
              Math.max(y, t.by, 0),
              Math.min(x + w, t.bx + t.bw, t.w),
              Math.min(y + h, t.by + t.bh, t.h),
            ];
          };
          const va = vis(a);
          const vb = vis(b);
          for (let i = 0; i < 4; i++) expect(vb[i]!).toBeCloseTo(va[i]!, 6);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('records the picture size, not the decoded part, as the source size of what it prepares', () => {
    stubOffscreen();
    const t = pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 1)!;
    const from: PictureFrom = { iw: 4000, ih: 3000, x: 0, y: 373, w: 4000, h: 2254 };
    const bmp = preparePicture(source(2000, 1127), t, from)!;
    expect(sourceSize(bmp)).toEqual([4000, 3000]);
    expect(preparedKey(bmp)).toBe(t.key);
  });
});

describe('preparePictureSteps: a large target in bands (design/27 §7.5)', () => {
  it('draws a 4K target in four bands of whole rows, then takes the bitmap', () => {
    const made = stubOffscreen();
    const t = pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 2)!;
    const steps = preparePictureSteps(source(6000, 4000), t);
    let n = 0;
    let r = steps.next();
    while (!r.done) {
      n++;
      r = steps.next();
    }
    expect(n).toBe(3); // four bands: three yields between them
    expect(r.value).toBe(made[0]!.bmp);
    const rects = made[0]!.rec.calls.filter((c) => c.op === 'rect').map((c) => c.args);
    expect(rects).toEqual([
      [0, 0, 3840, 2160],
      [0, 0, 3840, 546],
      [0, 0, 3840, 2160],
      [0, 546, 3840, 546],
      [0, 0, 3840, 2160],
      [0, 1092, 3840, 546],
      [0, 0, 3840, 2160],
      [0, 1638, 3840, 522],
    ]);
    expect(made[0]!.rec.draws()).toHaveLength(4);
    expect(preparedKey(r.value!)).toBe(t.key);
  });

  it('is one step, the very calls of preparePicture, for a target up to the step size', () => {
    const made = stubOffscreen();
    const t = pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 1)!;
    const r = preparePictureSteps(source(6000, 4000), t).next();
    expect(r.done).toBe(true);
    preparePicture(source(6000, 4000), t);
    expect(made[0]!.rec.calls).toEqual(made[1]!.rec.calls);
    expect(made[0]!.rec.calls.map((c) => c.op)).toEqual(['beginPath', 'rect', 'clip', 'drawImage']);
  });
});

describe('drawImageFit with a prepared picture', () => {
  const o: Extract<SlideObject, { type: 'image' }> = {
    id: 'i',
    type: 'image',
    box: box(100.4, 50.6, 400.2, 300),
    mediaId: 'm',
    fit: 'stretch',
    opacity: 0.5,
    radius: 0,
    crop: { l: 0.25, t: 0, r: 0, b: 0 },
  };

  it('copies the bitmap made for the target 1:1 at its whole-pixel origin, with no clip', () => {
    stubOffscreen();
    const seen: (PictureTarget | undefined)[] = [];
    const ready = preparePicture(source(800, 600), pictureTarget(o, 2)!)!;
    const r = recorder();
    drawObject(r.ctx, o, 2, (_id, target) => {
      seen.push(target);
      return ready;
    });
    expect(seen[0]).toEqual(pictureTarget(o, 2));
    const ops = r.calls.map((c) => c.op);
    expect(ops).toEqual(['save', 'drawImage', 'restore']);
    expect(r.draws()[0]!.args).toEqual([200, 101]);
    expect(r.state.globalAlpha).toBe(0.5);
  });

  it('draws a source of the same size the usual way, crop included', () => {
    const t = pictureTarget(o, 1)!;
    const r = recorder();
    // A source that happens to be exactly the target's size is still a source.
    drawObject(r.ctx, o, 1, () => source(t.w, t.h));
    expect(r.calls.map((c) => c.op)).toContain('clip');
    expect(r.draws()[0]!.args).toHaveLength(8);
  });

  it('draws a bitmap prepared for another target as a source', () => {
    stubOffscreen();
    const other = preparePicture(source(800, 600), pictureTarget({ ...o, crop: undefined }, 1)!)!;
    const r = recorder();
    drawObject(r.ctx, o, 1, () => other);
    expect(r.draws()[0]!.args).toHaveLength(8);
  });

  it('asks for no target for a rotated or round-cornered picture, and clips it as before', () => {
    for (const p of [
      { ...o, box: { ...o.box, rotation: 10 } },
      { ...o, radius: 8 },
    ]) {
      const seen: unknown[] = [];
      const r = recorder();
      drawObject(r.ctx, p, 1, (_id, target) => {
        seen.push(target);
        return source(800, 600);
      });
      expect(seen).toEqual([undefined]);
      expect(r.calls.map((c) => c.op)).toContain('clip');
    }
  });
});

// ── slidePictures lists exactly what drawSlide2D asks the image lookup for ───────────────────────────────

const num = fc.oneof(
  { weight: 4, arbitrary: fc.double({ min: -500, max: 2500, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 0.5, 1919.5, Number.NaN, 1e9) },
);
const crop = fc.option(
  fc.record({
    l: fc.double({ min: -1, max: 1, noNaN: true }),
    t: fc.double({ min: -1, max: 1, noNaN: true }),
    r: fc.double({ min: -1, max: 1, noNaN: true }),
    b: fc.double({ min: -1, max: 1, noNaN: true }),
  }),
  { nil: undefined },
);
const image = fc.record({
  id: fc.string({ maxLength: 3 }),
  type: fc.constant('image' as const),
  box: fc.record({ x: num, y: num, w: num, h: num, rotation: fc.constantFrom(0, 0, 0, 30, -90, 360) }),
  mediaId: fc.constantFrom('a', 'b', 'c', ''),
  fit: fc.constantFrom('contain', 'cover', 'stretch'),
  opacity: fc.constantFrom(1, 0.5),
  radius: fc.constantFrom(0, 0, 12),
  crop,
  origin: fc.option(fc.constant({ src: 'pptx' }), { nil: undefined }),
});
const shape = fc.constant({
  id: 's',
  type: 'shape' as const,
  box: box(0, 0, 100, 100),
  shape: 'rect' as const,
  fill: { r: 1, g: 2, b: 3, a: 1 },
  opacity: 1,
  radius: 0,
});
const slide = fc.record({
  id: fc.constant('s'),
  objects: fc.array(fc.oneof(image, shape), { maxLength: 24 }),
  imported: fc.option(fc.record({ imageMediaId: fc.constantFrom('page', 'a') }), { nil: undefined }),
  // Every way slideContent can choose (design/27 §5): objects, or the reference picture over the operator's own.
  pptx: fc.option(
    fc.record({
      fileId: fc.constant('f'.repeat(64)),
      index: fc.constant(0),
      shown: fc.constant(0),
      class: fc.constantFrom('native', 'hybrid', 'picture'),
      version: fc.constant(1),
      refMediaId: fc.option(fc.constantFrom('ref', 'b'), { nil: undefined }),
      show: fc.option(fc.constantFrom('objects', 'picture'), { nil: undefined }),
    }),
    { nil: undefined },
  ),
}) as fc.Arbitrary<Slide>;
const lyricOnly = LOOK_LOWER_THIRD;
const hidden: Look = { ...LOOK_MAIN, layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } as never } };

describe('slidePictures', () => {
  it('lists what drawSlide2D asks for, in order, for any slide, look and scale', () => {
    fc.assert(
      fc.property(
        slide,
        fc.constantFrom<Look | undefined>(undefined, LOOK_MAIN, lyricOnly, hidden),
        fc.constantFrom(0.5, 1, 2, 1 / 3),
        (s, look, scale) => {
          const asked: { mediaId: string; target?: PictureTarget }[] = [];
          const r = recorder();
          drawSlide2D(r.ctx, s, {
            scale,
            look,
            images: (mediaId, target) => {
              asked.push({ mediaId, target });
              return source(640, 480);
            },
          });
          expect(slidePictures(s, { scale, look })).toEqual(asked);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('lists the imported page and every image object, nothing in lyric-only and hidden looks', () => {
    const s: Slide = {
      id: 's',
      objects: [
        {
          id: 'p',
          type: 'image',
          box: box(0, 0, 1920, 1080),
          mediaId: 'photo',
          fit: 'cover',
          opacity: 1,
          radius: 0,
        },
        {
          id: 'r',
          type: 'image',
          box: box(0, 0, 100, 100, 5),
          mediaId: 'logo',
          fit: 'contain',
          opacity: 1,
          radius: 0,
        },
      ],
      imported: { imageMediaId: 'page' },
    } as Slide;
    const got = slidePictures(s, { scale: 2 });
    expect(got.map((p) => p.mediaId)).toEqual(['page', 'photo', 'logo']);
    expect(got[0]!.target).toMatchObject({ x: 0, y: 0, w: 3840, h: 2160, fit: 'contain' });
    expect(got[1]!.target).toMatchObject({ x: 0, y: 0, w: 3840, h: 2160, fit: 'cover' });
    expect(got[2]!.target).toBeUndefined();
    expect(slidePictures(s, { scale: 2, look: lyricOnly })).toEqual([]);
    expect(slidePictures(s, { scale: 2, look: hidden })).toEqual([]);
  });

  it("follows slideContent: a reference picture over only the operator's own pictures", () => {
    const pptx = { fileId: 'f'.repeat(64), index: 0, shown: 0, class: 'native' as const, version: 1 };
    const s = {
      id: 's',
      objects: [
        {
          id: 'p',
          type: 'image',
          box: box(0, 0, 1920, 1080),
          mediaId: 'photo',
          fit: 'cover',
          opacity: 1,
          radius: 0,
          origin: { src: 'pptx', role: 'picture' },
        },
        {
          id: 'm',
          type: 'image',
          box: box(10, 10, 300, 200),
          mediaId: 'mine',
          fit: 'contain',
          opacity: 1,
          radius: 0,
        },
      ],
      pptx: { ...pptx, refMediaId: 'ref', show: 'picture' },
    } as Slide;
    const got = slidePictures(s, { scale: 2 });
    expect(got.map((p) => p.mediaId)).toEqual(['ref', 'mine']);
    expect(got[0]!.target).toMatchObject({ x: 0, y: 0, w: 3840, h: 2160, fit: 'contain' });
    // Set back to objects, the same slide lists its imported picture and the reference is not asked for.
    const objects = { ...s, pptx: { ...pptx, refMediaId: 'ref', show: 'objects' as const } };
    expect(slidePictures(objects, { scale: 2 }).map((p) => p.mediaId)).toEqual(['photo', 'mine']);
  });
});
