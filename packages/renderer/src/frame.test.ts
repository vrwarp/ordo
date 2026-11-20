import { LOOK_LOWER_THIRD, LOOK_MAIN, type SlideObject } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLAMP, clampSlide } from './clamp.ts';
import {
  FRAME_DIRECT_BYTES,
  FRAME_DIRECT_IMAGES,
  FRAME_DIRECT_OBJECTS,
  FRAME_DIRECT_TARGETS,
  FRAME_MAX_OBJECTS,
  FRAME_WORK_MAX,
  frameSize,
  framesEnabled,
  setFrames,
  splitFrame,
} from './frame.ts';
import { picture, seeded, slideOf, square, squares, textBox, texts } from './frame.test-util.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { pictureTarget } from './picture.ts';
import { clearUnits, UNIT_SLIDE_AREAS, unitOf } from './units.ts';
import { panel } from './units.effects.test-util.ts';

/*
 * The pure split of the underlay frame (design 29 R1, frame.ts): the direct part is the longest top-down run of
 * objects within the counts, the rest is the frame under it.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => {
  clearUnits();
  setFrames(true);
});

const ids = (os: readonly SlideObject[]) => os.map((o) => o.id);

describe('the constants', () => {
  it("are the live clamp's counts and the output's prepared targets", () => {
    expect(FRAME_DIRECT_OBJECTS).toBe(CLAMP.maxObjects);
    expect(FRAME_DIRECT_IMAGES).toBe(CLAMP.maxImagesPerSlide);
    expect(FRAME_DIRECT_BYTES).toBe(CLAMP.maxCueBitmapBytes);
    expect(FRAME_DIRECT_TARGETS).toBe(32);
    expect(FRAME_MAX_OBJECTS).toBe(20_000);
    expect(FRAME_WORK_MAX).toBe(2);
    expect(UNIT_SLIDE_AREAS).toBe(1);
  });
});

describe('splitFrame by count (rule a)', () => {
  it('400 text boxes: the top 200 are direct, the bottom 200 the frame, in order, none twice', () => {
    const s = slideOf(texts(400));
    const f = splitFrame(s, 1)!;
    expect(f).toBeDefined();
    expect(f.direct.objects).toHaveLength(200);
    expect(f.under).toHaveLength(200);
    expect(ids(f.under)).toEqual(
      texts(400)
        .slice(0, 200)
        .map((o) => o.id),
    );
    expect(ids(f.direct.objects)).toEqual(
      texts(400)
        .slice(200)
        .map((o) => o.id),
    );
    expect(new Set([...ids(f.under), ...ids(f.direct.objects)]).size).toBe(400);
    expect(f.why.objects).toBe(true);
    expect(f.cut).toBe(0);
    // the direct slide is a clamped live slide: drawing it cuts nothing
    expect(clampSlide(f.direct)).toBe(f.direct);
    expect(f.rect).toEqual({ x: 0, y: 0, ...frameSize(1) });
    expect(f.bytes).toBe(1920 * 1080 * 4);
  });

  it('a slide of exactly 200 objects is not split', () => {
    expect(splitFrame(slideOf(texts(200)), 1)).toBeUndefined();
    expect(splitFrame(slideOf(texts(201)), 1)!.under).toHaveLength(1);
  });

  it('the same inputs give the same split (memoised), another scale another', () => {
    const s = slideOf(texts(300));
    expect(splitFrame(s, 2)).toBe(splitFrame(s, 2));
    expect(splitFrame(s, 1)).not.toBe(splitFrame(s, 2));
    expect(splitFrame(s, 2)!.rect.w).toBe(3840);
  });
});

describe('splitFrame by pictures (rules b, c, d)', () => {
  const grid = (i: number, n = 8) => ({
    x: 10 + (i % n) * 220,
    y: 10 + Math.floor(i / n) * 220,
    w: 200,
    h: 200,
  });

  it('24 distinct pictures: the direct part holds 16 of them', () => {
    const s = slideOf(Array.from({ length: 24 }, (_, i) => picture(`p${i}`, `m${i}`, grid(i))));
    const f = splitFrame(s, 2)!;
    expect(f.direct.objects).toHaveLength(16);
    expect(f.under).toHaveLength(8);
    expect(f.why.images).toBe(true);
    // 16 pictures stay direct whole
    expect(ids(f.direct.objects)).toEqual(Array.from({ length: 16 }, (_, i) => `p${i + 8}`));
  });

  it('60 pictures of distinct sizes of a few files at 3840: the direct part holds 32 targets', () => {
    const s = slideOf(
      Array.from({ length: 60 }, (_, i) =>
        picture(`p${i}`, `m${i % 10}`, {
          x: 10 + (i % 12) * 150,
          y: 10 + Math.floor(i / 12) * 150,
          w: 100 + i,
          h: 100 + i,
        }),
      ),
    );
    const f = splitFrame(s, 2)!;
    expect(f.why.targets).toBe(true);
    expect(f.direct.objects).toHaveLength(FRAME_DIRECT_TARGETS);
    const keys = new Set(
      f.direct.objects.map(
        (o) => `${(o as { mediaId: string }).mediaId}|${pictureTarget(o as never, 2)!.key}`,
      ),
    );
    expect(keys.size).toBe(FRAME_DIRECT_TARGETS);
  });

  it('a picture repeated at one size is one prepared draw', () => {
    const s = slideOf(
      Array.from({ length: 60 }, (_, i) =>
        picture(`p${i}`, 'm', { x: 10 + (i % 12) * 150, y: 10, w: 100, h: 100 }),
      ),
    );
    expect(splitFrame(s, 2)).toBeUndefined();
  });

  it('12 full-frame pictures at 3840: the prepared bytes bound holds the direct part to six', () => {
    const s = slideOf(
      Array.from({ length: 12 }, (_, i) => picture(`p${i}`, `m${i}`, { x: 0, y: 0, w: 1920, h: 1080 })),
    );
    const f = splitFrame(s, 2)!;
    expect(f.why.bytes).toBe(true);
    expect(f.direct.objects).toHaveLength(6);
    expect(f.direct.objects.length * 3840 * 2160 * 4).toBeLessThanOrEqual(FRAME_DIRECT_BYTES);
    expect(7 * 3840 * 2160 * 4).toBeGreaterThan(FRAME_DIRECT_BYTES);
  });

  it('a picture drawn from its source (turned, no mask) counts once per file', () => {
    const turned = (i: number, media: string) => ({
      ...picture(`p${i}`, media, { x: 10 + (i % 20) * 80, y: 10, w: 70, h: 70 }),
      box: { x: 10 + (i % 20) * 80, y: 10, w: 70, h: 70, rotation: 15 },
    });
    // 40 turned pictures of 3 files: three source draws, no frame
    const few = slideOf(Array.from({ length: 40 }, (_, i) => turned(i, `m${i % 3}`)));
    expect(splitFrame(few, 2)).toBeUndefined();
    // 16 files, still within every count
    const files = slideOf(Array.from({ length: 16 }, (_, i) => turned(i, `m${i}`)));
    expect(splitFrame(files, 2)).toBeUndefined();
  });
});

describe('splitFrame by effect area (rule e, r2a MUST c(2))', () => {
  it('20 shadowed panels of 0.12 frame each: the direct units add up to at most one frame', () => {
    const panels: SlideObject[] = [];
    for (let i = 0; i < 20; i++)
      panels.push(panel(`pa${i}`, 100 + (i % 5) * 300, 80 + Math.floor(i / 5) * 240, 640, 390, i));
    const s = slideOf(panels);
    const f = splitFrame(s, 2)!;
    expect(f).toBeDefined();
    expect(f.why.area).toBe(true);
    const frame = frameSize(2);
    const area = (os: readonly SlideObject[]) =>
      os.reduce((sum, o) => {
        const u = unitOf(o, 2, 'both');
        return sum + (u && u.bytes > 0 ? (u.rect.w * u.rect.h) / (frame.w * frame.h) : 0);
      }, 0);
    expect(area(f.direct.objects)).toBeLessThanOrEqual(UNIT_SLIDE_AREAS + 1e-9);
    expect(f.direct.objects.length).toBeGreaterThan(0);
    expect(f.under.length).toBeGreaterThan(0);
    expect(f.direct.objects.length + f.under.length).toBe(20);
    // the next object down would have passed the bound
    const next = f.under[f.under.length - 1]!;
    expect(area([next, ...f.direct.objects])).toBeGreaterThan(UNIT_SLIDE_AREAS);
  });
});

describe('splitFrame leaves an ordinary slide alone', () => {
  it("30 objects and 3 pictures: undefined, today's path", () => {
    const s = slideOf([
      ...squares(24),
      picture('p0', 'a', { x: 0, y: 0, w: 600, h: 400 }),
      picture('p1', 'b', { x: 700, y: 0, w: 600, h: 400 }),
      picture('p2', 'c', { x: 0, y: 500, w: 600, h: 400 }),
      textBox('t', 'Amazing grace'),
    ]);
    expect(splitFrame(s, 1)).toBeUndefined();
    expect(splitFrame(s, 2)).toBeUndefined();
  });

  it('a look that does not draw the slide as authored is not split', () => {
    const s = slideOf(texts(300));
    expect(splitFrame(s, 1, { look: LOOK_LOWER_THIRD })).toBeUndefined();
    expect(splitFrame(s, 1, { look: LOOK_MAIN })).toBeDefined();
  });

  it('is off with setFrames(false)', () => {
    const s = slideOf(texts(300));
    expect(framesEnabled()).toBe(true);
    setFrames(false);
    expect(framesEnabled()).toBe(false);
    expect(splitFrame(s, 1)).toBeUndefined();
    setFrames(true);
    expect(splitFrame(s, 1)).toBeDefined();
  });

  it('an empty slide and non-finite scales are not split', () => {
    expect(splitFrame(slideOf([]), 1)).toBeUndefined();
    expect(splitFrame(slideOf(texts(300)), Number.NaN)).toBeUndefined();
    expect(splitFrame(slideOf(texts(300)), 0)).toBeUndefined();
  });
});

describe('the anchors stay direct', () => {
  it('a playing image at index 40 of 400: the frame is the 40 below it, the rest above is cut by the live clamp as it always was', () => {
    const objs: SlideObject[] = texts(400);
    objs[40] = picture('play', 'vid', { x: 100, y: 100, w: 640, h: 360 });
    const f = splitFrame(slideOf(objs), 1, { video: { objectId: 'play' } })!;
    expect(f.under).toHaveLength(40);
    expect(ids(f.under)).toEqual(ids(objs.slice(0, 40)));
    expect(f.direct.objects[0]!.id).toBe('play');
    expect(f.direct.objects).toHaveLength(CLAMP.maxObjects);
    expect(f.cut).toBe(400 - 40 - CLAMP.maxObjects);
  });

  it('an anchor below the count boundary moves nothing', () => {
    const objs: SlideObject[] = texts(400);
    objs[350] = picture('play', 'vid', { x: 100, y: 100, w: 640, h: 360 });
    const f = splitFrame(slideOf(objs), 1, { video: { objectId: 'play' } })!;
    expect(f.under).toHaveLength(200);
    expect(f.cut).toBe(0);
    expect(f.direct.objects.map((o) => o.id)).toContain('play');
  });

  it('anchors given by id keep their object and everything above it direct', () => {
    const objs = texts(400);
    const f = splitFrame(slideOf(objs), 1, { anchors: [objs[10]!.id] })!;
    expect(f.under).toHaveLength(10);
  });
});

describe('the split is the smallest frame (seeded fuzz of 500 slides)', () => {
  /** An independent statement of the rules over a suffix of the objects. */
  function rules(objs: readonly SlideObject[], scale: number): string[] {
    const broken: string[] = [];
    if (objs.length > FRAME_DIRECT_OBJECTS) broken.push('objects');
    const media = new Set<string>();
    const targets = new Set<string>();
    let bytes = 0;
    let area = 0;
    const frame = frameSize(scale);
    for (const o of objs) {
      if (o.type === 'image') {
        media.add(o.mediaId);
        const t = pictureTarget(o, scale);
        const key = t ? `${o.mediaId}|${t.key}` : `${o.mediaId}|source`;
        if (!targets.has(key)) bytes += t ? t.w * t.h * 4 : 0;
        targets.add(key);
      }
      const u = unitOf(o, scale, 'both');
      if (u && u.bytes > 0) area += (u.rect.w * u.rect.h) / (frame.w * frame.h);
    }
    if (media.size > FRAME_DIRECT_IMAGES) broken.push('images');
    if (targets.size > FRAME_DIRECT_TARGETS) broken.push('targets');
    if (bytes > FRAME_DIRECT_BYTES) broken.push('bytes');
    if (area > UNIT_SLIDE_AREAS + 1e-9) broken.push('area');
    return broken;
  }

  it('every direct part satisfies the rules and one more object down would break one', () => {
    const rnd = seeded(20260820);
    let split = 0;
    for (let k = 0; k < 500; k++) {
      const n = 20 + Math.floor(rnd() * 380);
      const scale = rnd() < 0.5 ? 1 : 2;
      const objs: SlideObject[] = [];
      for (let i = 0; i < n; i++) {
        const r = rnd();
        if (r < 0.15)
          objs.push(
            picture(`p${i}`, `m${Math.floor(rnd() * 30)}`, {
              x: Math.floor(rnd() * 1500),
              y: Math.floor(rnd() * 800),
              w: 60 + Math.floor(rnd() * 900),
              h: 60 + Math.floor(rnd() * 600),
            }),
          );
        else if (r < 0.2)
          objs.push(
            square(i, {
              box: {
                x: Math.floor(rnd() * 800),
                y: Math.floor(rnd() * 400),
                w: 400 + Math.floor(rnd() * 900),
                h: 300 + Math.floor(rnd() * 600),
                rotation: 0,
              },
              shadow: { dx: 6, dy: 6, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } },
            }),
          );
        else if (r < 0.6) objs.push(square(i));
        else objs.push(textBox(`t${i}`, `L${i}`, 20 + (i % 10) * 180, 20 + Math.floor(i / 10) * 40, 170, 36));
      }
      const slide = slideOf(objs, `fz${k}`);
      const f = splitFrame(slide, scale);
      const bake = clampSlide(slide, 'bake').objects;
      if (!f) {
        expect(rules(bake, scale), `slide ${k} was not split`).toEqual([]);
        continue;
      }
      split++;
      expect([...f.under, ...f.direct.objects].map((o) => o.id)).toEqual(bake.map((o) => o.id));
      expect(rules(f.direct.objects, scale), `slide ${k} direct`).toEqual([]);
      const next = f.under[f.under.length - 1]!;
      expect(rules([next, ...f.direct.objects], scale).length, `slide ${k} minimal`).toBeGreaterThan(0);
    }
    // the generator makes both kinds of slide
    expect(split).toBeGreaterThan(100);
    expect(split).toBeLessThan(500);
  });
});

describe('a slide the frame cannot hold whole', () => {
  it('a slide past the slide-file bound is cut there', () => {
    const many = Array.from({ length: 20_050 }, (_, i) => textBox(`t${i}`, 'x', 0, 0, 10, 10));
    const f = splitFrame(slideOf(many), 1)!;
    expect(f.under.length + f.direct.objects.length).toBe(FRAME_MAX_OBJECTS);
  });
});
