import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  type Look,
  type Slide,
} from '@ordo/domain';
import { CLAMP, clampLook, clampSlide } from './clamp.ts';
import { resolved, slideLive } from './fixtures.test-util.ts';
import { planFrame, planPreview } from './plan.ts';
import { jobFontFamilies, rasterLowerThird, rasterProps, rasterSlide } from './raster.ts';
import type { Ctx2D } from './text2d.ts';

/**
 * Fuzzing the render planner and rasterizer (design/25): random slides and looks, within and far beyond
 * the clamps (NaN, infinities, huge boxes and fonts, 300 objects, 20,000-character text, garbage objects).
 * The acceptance criterion: never throws, and everything handed on is within the bounds.
 */

const wild = fc.oneof(
  fc.double({ noNaN: false }),
  fc.integer({ min: -100_000, max: 100_000 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e308, -1e308, 0, -0),
  fc.constant(undefined),
  fc.string({ maxLength: 4 }),
);
const sane = fc.integer({ min: -100, max: 2000 });
const n = fc.oneof({ weight: 3, arbitrary: sane }, { weight: 1, arbitrary: wild });

const color = fc.oneof(
  fc.record({ r: n, g: n, b: n, a: n }),
  fc.constant(undefined),
  fc.constant('red' as unknown),
);
const box = fc.oneof(
  fc.record({ x: n, y: n, w: n, h: n, rotation: n }),
  fc.constant(undefined),
  fc.constant(null),
);
const family = fc.oneof(
  fc.constantFrom('Inter', 'Arial', 'Nonexistent Sans', '"; drop', ''),
  fc.string({ maxLength: 300 }),
);
const style = fc.oneof(
  fc.record(
    {
      fontFamily: family,
      fontWeight: n,
      fontStyle: fc.constantFrom('normal', 'italic', 'oblique'),
      fontSizePx: n,
      color,
      align: fc.constantFrom('left', 'center', 'right', 'justify'),
      valign: fc.constantFrom('top', 'middle', 'bottom', 'baseline'),
      lineHeight: n,
      letterSpacing: n,
      padding: n,
      outline: fc.option(fc.record({ width: n, color })),
      shadow: fc.option(fc.record({ dx: n, dy: n, blur: n, color })),
      fill: fc.option(fc.record({ color, radius: n })),
    },
    { requiredKeys: [] },
  ),
  fc.constant(undefined),
);
const longText = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.nat({ max: 20_000 }).map((k) => 'word '.repeat(Math.ceil(k / 5)).slice(0, k)),
  fc.nat({ max: 20_000 }).map((k) => 'x'.repeat(k)),
  fc.constant(undefined as unknown as string),
);
const object = fc.oneof(
  fc.record({ id: fc.string(), type: fc.constant('text'), box, text: longText, style, opacity: n }),
  fc.record({
    id: fc.string(),
    type: fc.constant('image'),
    box,
    mediaId: fc.constantFrom('bgi', 'hold', 'missing', ''),
    fit: fc.constantFrom('contain', 'cover', 'stretch', 'zoom'),
    opacity: n,
    radius: n,
  }),
  fc.record({
    id: fc.string(),
    type: fc.constant('shape'),
    box,
    shape: fc.constantFrom('rect', 'ellipse', 'line', 'star'),
    fill: fc.option(color),
    stroke: fc.option(fc.record({ width: n, color })),
    opacity: n,
    radius: n,
  }),
  fc.anything(),
);
const slide: fc.Arbitrary<Slide> = fc
  .record({
    id: fc.constantFrom('s1', 's2', 'x'),
    objects: fc.oneof(
      fc.array(object, { maxLength: 30 }),
      fc.array(object, { minLength: 190, maxLength: 320 }),
    ),
    lyricObjectId: fc.option(fc.string()),
  })
  .map((s) => s as unknown as Slide);

const look: fc.Arbitrary<Look> = fc
  .record({
    base: fc.constantFrom(LOOK_MAIN, LOOK_LOWER_THIRD),
    mode: fc.constantFrom('authored', 'lyricOnly', 'hidden', 'bogus'),
    style,
    band: box,
    next: fc.option(fc.record({ style, band: box })),
    nonSong: fc.constantFrom('text', 'none'),
    transition: fc.oneof(
      fc.record({ kind: fc.constant('crossfade'), ms: n }),
      fc.constant({ kind: 'cut' }),
      fc.constant(undefined),
    ),
    clearColor: color,
  })
  .map(
    (r) =>
      ({
        ...r.base,
        layers: {
          ...r.base.layers,
          slide: {
            mode: r.mode,
            style: r.style,
            band: r.band,
            nextSlide: r.next ?? undefined,
            nonSong: r.nonSong,
          },
        },
        transition: r.transition,
        clearColor: r.clearColor,
      }) as unknown as Look,
  );

function stateWith(s: Slide, cue: number) {
  const st = slideLive(cue);
  const song = resolved.presentations.song!;
  const presentations = {
    ...resolved.presentations,
    song: {
      ...song,
      sections: [
        {
          ...song.sections[0]!,
          slides: [
            { ...s, id: 's1' },
            { ...s, id: 's2' },
          ],
        },
      ],
    },
  };
  return { ...st, resolved: { ...resolved, presentations } };
}

function finite(x: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x);
}

function checkSlideBounds(s: Slide): void {
  expect(s.objects.length).toBeLessThanOrEqual(CLAMP.maxObjects);
  const images = new Set<string>();
  for (const o of s.objects) {
    const b = o.box;
    for (const v of [b.x, b.y, b.w, b.h, b.rotation]) expect(finite(v)).toBe(true);
    expect(b.w).toBeGreaterThanOrEqual(0);
    expect(b.h).toBeGreaterThanOrEqual(0);
    expect(b.x).toBeGreaterThanOrEqual(-2 * LOGICAL_WIDTH);
    expect(b.x + b.w).toBeLessThanOrEqual(2 * LOGICAL_WIDTH + 1e-6);
    expect(b.y).toBeGreaterThanOrEqual(-2 * LOGICAL_HEIGHT);
    expect(b.y + b.h).toBeLessThanOrEqual(2 * LOGICAL_HEIGHT + 1e-6);
    expect(o.opacity).toBeGreaterThanOrEqual(0);
    expect(o.opacity).toBeLessThanOrEqual(1);
    if (o.type === 'text') {
      expect(o.text.length).toBeLessThanOrEqual(CLAMP.maxTextChars);
      expect(o.style.fontSizePx).toBeGreaterThanOrEqual(CLAMP.minFontPx);
      expect(o.style.fontSizePx).toBeLessThanOrEqual(CLAMP.maxFontPx);
      for (const v of [o.style.lineHeight, o.style.letterSpacing, o.style.padding, o.style.fontWeight])
        expect(finite(v)).toBe(true);
    }
    if (o.type === 'image') images.add(o.mediaId);
  }
  expect(images.size).toBeLessThanOrEqual(CLAMP.maxImagesPerSlide);
}

/** A 2D context that records nothing but checks every coordinate and font it is given. */
function boundedCtx(scale: number) {
  const limit = 6 * LOGICAL_WIDTH * scale;
  const calls = { text: 0, maxChars: 0 };
  const coord = (...vs: number[]) => {
    for (const v of vs) {
      if (!Number.isFinite(v)) throw new Error(`non-finite coordinate ${v}`);
      if (Math.abs(v) > limit) throw new Error(`coordinate ${v} out of bounds`);
    }
  };
  let font = '';
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'round',
    miterLimit: 2,
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    letterSpacing: '0px',
    get font() {
      return font;
    },
    set font(f: string) {
      const m = /(\d+(?:\.\d+)?(?:e[+-]?\d+)?)px/.exec(f);
      if (!m) throw new Error(`font without a size: ${f}`);
      const px = Number(m[1]) / scale;
      if (px < CLAMP.minFontPx - 1e-6 || px > CLAMP.maxFontPx + 1e-6)
        throw new Error(`font size ${px} out of bounds`);
      font = f;
    },
    measureText: (s: string) => ({ width: s.length * 10 * scale }),
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    clip() {},
    fill() {},
    stroke() {},
    setTransform() {},
    clearRect: coord,
    fillRect: coord,
    rect: coord,
    roundRect: (x: number, y: number, w: number, h: number) => coord(x, y, w, h),
    ellipse: (x: number, y: number, rx: number, ry: number) => coord(x, y, rx, ry),
    moveTo: coord,
    lineTo: coord,
    translate: coord,
    rotate: (a: number) => coord(a),
    drawImage: (_img: unknown, ...xs: number[]) => coord(...xs),
    fillText: (t: string, x: number, y: number) => {
      coord(x, y);
      calls.text++;
      calls.maxChars = Math.max(calls.maxChars, t.length);
    },
    strokeText: (_t: string, x: number, y: number) => coord(x, y),
  };
  return { ctx: ctx as unknown as Ctx2D, calls };
}

const img = { width: 400, height: 300 } as unknown as CanvasImageSource;
const images = (id: string) => (id === 'missing' ? undefined : img);

describe('render planner and rasterizer fuzz', () => {
  it('clampSlide bounds any input and is idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(slide, fc.anything() as fc.Arbitrary<Slide>), (s) => {
        const c = clampSlide(s);
        checkSlideBounds(c);
        expect(clampSlide(c)).toBe(c);
      }),
      { numRuns: 150 },
    );
  });

  it('planFrame never throws and hands on clamped slides', () => {
    fc.assert(
      fc.property(slide, look, fc.constantFrom(0, 1), (s, l, cue) => {
        const p = planFrame(stateWith(s, cue), l);
        if (p.slide.desc) {
          checkSlideBounds(p.slide.desc.slide);
          if (p.slide.desc.nextSlide) checkSlideBounds(p.slide.desc.nextSlide);
        }
        expect(finite(p.slide.fadeMs)).toBe(true);
        expect(p.slide.fadeMs).toBeGreaterThanOrEqual(0);
        const cl = p.clearColor;
        for (const v of [cl.r, cl.g, cl.b, cl.a]) expect(finite(v)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('planPreview never throws on hostile presentations', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record({ id: fc.string(), rev: n, kind: fc.string(), sections: fc.anything() }),
          slide.map((s) => ({
            id: 'p',
            rev: 1,
            kind: 'song',
            sections: [{ id: 'x', slides: [s, null, 4] }],
          })),
        ),
        look,
        (pres, l) => {
          const p = planPreview(pres as never, undefined, l);
          if (p.slide.desc) checkSlideBounds(p.slide.desc.slide);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('the rasterizer draws any planned slide within bounds without throwing', () => {
    fc.assert(
      fc.property(slide, look, fc.constantFrom(0.25, 1, 2), (s, l, scale) => {
        const p = planFrame(stateWith(s, 0), l);
        const { ctx, calls } = boundedCtx(scale);
        const d = p.slide.desc;
        rasterSlide(ctx, d?.slide ?? s, l, scale, images, { nextSlide: d?.nextSlide, isSong: true });
        expect(calls.maxChars).toBeLessThanOrEqual(CLAMP.maxTextChars);
        rasterLowerThird(ctx, (s.objects[0] as { text?: string } | undefined)?.text ?? 'x', l, scale);
        jobFontFamilies({
          kind: 'slide',
          layer: 1,
          key: 'k',
          cueIndex: 0,
          slide: s,
          isSong: true,
          look: l,
          images: {},
        });
      }),
      { numRuns: 150 },
    );
  });

  it('props with hostile styles and boxes stay in bounds', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ text: longText, style, box }), { maxLength: 6 }),
        color,
        (items, clear) => {
          const { ctx } = boundedCtx(1);
          const model = {
            key: 'p',
            items: items.map((i) => ({ ...(i.style ?? {}), text: i.text, box: i.box, style: i.style })),
            logo: { mediaId: 'hold', box: { x: Number.NaN, y: 1e9, w: -5, h: 4, rotation: 0 } },
          };
          rasterProps(ctx, model as never, 1, images, clampLook({ clearColor: clear }).clearColor);
        },
      ),
      { numRuns: 150 },
    );
  });
});
