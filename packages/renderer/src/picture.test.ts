import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOK_LOWER_THIRD, LOOK_MAIN, type Look, type Slide, type SlideObject } from '@ordo/domain';
import {
  MAX_PREPARED_PIXELS,
  type PictureTarget,
  pictureTarget,
  preparePicture,
  preparedKey,
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
    // The whole frame at 4K is 8.3 MP; twice the frame at 4K is 33 MP, over the 16 MP cap.
    expect(pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'stretch' }, 2)).toBeDefined();
    expect(pictureTarget({ box: box(-960, -540, 3840, 2160), fit: 'stretch' }, 2)).toBeUndefined();
    expect(3840 * 2160).toBeLessThanOrEqual(MAX_PREPARED_PIXELS);
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
        fc.boolean(),
        (s, look, scale, skipImported) => {
          const asked: { mediaId: string; target?: PictureTarget }[] = [];
          const r = recorder();
          drawSlide2D(r.ctx, s, {
            scale,
            look,
            skipImported,
            images: (mediaId, target) => {
              asked.push({ mediaId, target });
              return source(640, 480);
            },
          });
          expect(slidePictures(s, { scale, look, skipImported })).toEqual(asked);
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
    expect(slidePictures(s, { scale: 2, skipImported: true }).map((p) => p.mediaId)).toEqual([
      'photo',
      'logo',
    ]);
    expect(slidePictures(s, { scale: 2, look: lyricOnly })).toEqual([]);
    expect(slidePictures(s, { scale: 2, look: hidden })).toEqual([]);
  });
});
