import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  type Look,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextStyle,
} from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { PLANE_FLAGS, PLANE_FLOATS, PLANE_HAS_OVER, PLANE_OPACITY, PLANE_UV, planeSample } from './scene.ts';
import { rasterScene, sceneSlides, textBounds } from './scene-raster.ts';
import type { Ctx2D } from './text2d.ts';

/**
 * A 2D context that records what is drawn: every glyph is 10 device px wide at any font (enough for the
 * layout maths), fillText and drawImage are logged with their text and picture tag.
 */
function fakeCtx(): Ctx2D & { ops: string[] } {
  const ops: string[] = [];
  const state: Record<string | symbol, unknown> = { font: '10px x', letterSpacing: '0px', globalAlpha: 1 };
  return new Proxy(state, {
    get(t, k) {
      if (k === 'ops') return ops;
      if (k === 'measureText') return (s: string) => ({ width: s.length * 10 });
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        if (k === 'fillText') ops.push(`text:${args[0]}`);
        else if (k === 'drawImage') ops.push(`image:${(args[0] as { tag?: string }).tag}`);
        else if (k === 'fill') ops.push('fill');
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
    has: () => true,
  }) as unknown as Ctx2D & { ops: string[] };
}

const SCALE = 0.5;
const style = (s: Partial<TextStyle> = {}): TextStyle => ({
  ...DEFAULT_LYRIC_STYLE,
  fontSizePx: 60,
  padding: 0,
  align: 'left',
  valign: 'top',
  outline: undefined,
  shadow: undefined,
  ...s,
});
const box = (x: number, y: number, w: number, h: number, rotation = 0) => ({ x, y, w, h, rotation });
const text = (id: string, t: string, b = box(0, 0, 100, 100), s: Partial<TextStyle> = {}): TextObject => ({
  id,
  type: 'text',
  box: b,
  text: t,
  style: style(s),
  opacity: 1,
});
const shape = (id: string, b = box(0, 0, 100, 100)): SlideObject => ({
  id,
  type: 'shape',
  box: b,
  shape: 'rect',
  fill: { r: 10, g: 20, b: 30, a: 1 },
  opacity: 1,
  radius: 0,
});

/** A 4:3 poster in a 16:9 box (letterboxed by 'contain'), at (400, 300)..(1200, 750). */
const video = (play: Record<string, unknown> = {}, fit: 'contain' | 'cover' | 'stretch' = 'contain') =>
  ({
    id: 'vid',
    type: 'image',
    box: box(400, 300, 800, 450),
    mediaId: 'poster',
    fit,
    opacity: 1,
    radius: 0,
    play: { mediaId: 'clip', ...play },
  }) as SlideObject;

const slide = (objects: SlideObject[], extra: Partial<Slide> = {}): Slide => ({ id: 's', objects, ...extra });
const pictures: Record<string, { width: number; height: number; tag: string }> = {
  poster: { width: 400, height: 300, tag: 'poster' },
  page: { width: 1920, height: 1080, tag: 'page' },
};
const images = (id: string) => pictures[id] as unknown as CanvasImageSource | undefined;
const ids = (s: Slide | null | undefined) => s?.objects.map((o) => o.id);

function sample(plane: Float32Array, x: number, y: number) {
  const o = [0, 0, 0];
  planeSample(plane, x, y, o);
  return { u: o[0]!, v: o[1]!, w: o[2]! };
}

describe('textBounds', () => {
  it('is the laid-out block united with the box, widened by an em', () => {
    // 'Hi' at 60 px: one line 20 device px wide and 36 high (60 · 0.5 · 1.2), at the box's top left.
    const b = textBounds(fakeCtx(), text('t', 'Hi', box(400, 100, 800, 100)), SCALE);
    expect(b).toEqual({ x: 340, y: 40, w: 860, h: 192 });
  });

  it('covers text that overflows its box', () => {
    // 40 words of 'word ' wrap 8 to a 400 device px line: 5 lines, 360 logical px from y = 100.
    const t = text('t', Array(40).fill('word').join(' '), box(400, 100, 800, 100));
    const b = textBounds(fakeCtx(), t, SCALE);
    expect(b.y + b.h).toBeCloseTo(100 + 360 + 60, 6);
  });

  it('turns with its box and adds the reach of its effects', () => {
    const t = text('t', 'Hi', box(400, 100, 800, 100, 90));
    const b = textBounds(fakeCtx(), t, SCALE);
    // The unturned bounds 340..1200 x 40..232 turned a quarter clockwise about the box centre (800, 150).
    expect(b.x).toBeCloseTo(718, 6);
    expect(b.w).toBeCloseTo(192, 6);
    expect(b.y).toBeCloseTo(-310, 6);
    expect(b.h).toBeCloseTo(860, 6);
    const shadowed = text('t', 'Hi', box(400, 100, 800, 100), {
      shadow: { dx: 0, dy: 10, blur: 5, color: { r: 0, g: 0, b: 0, a: 1 } },
    });
    // dy 10 plus twice the blur.
    expect(textBounds(fakeCtx(), shadowed, SCALE)).toEqual({ x: 320, y: 20, w: 900, h: 232 });
  });

  it('is the box for empty text, and the whole frame for rich text it does not lay out', () => {
    expect(textBounds(fakeCtx(), text('t', '  ', box(10, 20, 30, 40)), SCALE)).toEqual({
      x: 10,
      y: 20,
      w: 30,
      h: 40,
    });
    const at = box(10, 20, 30, 40);
    const rich = { ...text('t', 'Hi', at), runs: [{ start: 0, end: 2, sizeScale: 3 }] } as TextObject;
    expect(textBounds(fakeCtx(), rich, SCALE)).toEqual({ x: -3840, y: -2160, w: 7680, h: 4320 });
    const unwrapped = text('t', 'Hi', at, { wrap: false } as unknown as Partial<TextStyle>);
    expect(textBounds(fakeCtx(), unwrapped, SCALE).w).toBe(7680);
    // Fields that only draw less, or empty lists, are measured as usual.
    const shrunk = text('t', 'Hi', at, { autofit: 'shrink', wrap: true } as unknown as Partial<TextStyle>);
    expect(textBounds(fakeCtx(), shrunk, SCALE).w).toBeLessThan(7680);
    expect(textBounds(fakeCtx(), { ...text('t', 'Hi', at), runs: [] } as TextObject, SCALE).w).toBeLessThan(
      7680,
    );
  });
});

describe('sceneSlides', () => {
  const objects = [
    shape('bg', box(0, 0, 1920, 1080)),
    video(),
    text('title', 'Title', box(500, 250, 600, 120)),
    text('footer', 'Footer', box(100, 900, 400, 100)),
    shape('badge', box(1300, 200, 200, 100)),
  ];

  it('splits around the playing object: the overlapping title goes over, the rest stays in base', () => {
    const s = sceneSlides(fakeCtx(), slide(objects), LOOK_MAIN, SCALE, images, 'vid')!;
    expect(ids(s.base)).toEqual(['bg', 'vid', 'footer', 'badge']);
    expect(ids(s.over)).toEqual(['title']);
    expect(s.plane).toHaveLength(PLANE_FLOATS);
    expect(s.plane[PLANE_FLAGS]).toBe(PLANE_HAS_OVER);
  });

  it('places the plane on the poster: box at the output scale, fitted with the poster size', () => {
    const s = sceneSlides(fakeCtx(), slide(objects), LOOK_MAIN, SCALE, images, 'vid')!;
    // Box centre (800, 525) logical = (400, 262.5) device: the middle of the clip.
    const c = sample(s.plane, 400, 262.5);
    expect(c.u).toBeCloseTo(0.5, 5);
    expect(c.v).toBeCloseTo(0.5, 5);
    expect(c.w).toBe(1);
    // 'contain' of 4:3 in 16:9: the picture spans the middle 75 % of the box width.
    expect(s.plane[PLANE_UV]).toBeCloseTo(-1 / 6, 5);
    expect(s.plane[PLANE_UV + 2]).toBeCloseTo(7 / 6, 5);
    expect(sample(s.plane, 0.5 * 450, 262.5).w).toBe(0);
    expect(sample(s.plane, 0.5 * 520, 262.5).w).toBe(1);
  });

  it('stretches the clip over the box while both its size and its poster are unknown', () => {
    const s = sceneSlides(fakeCtx(), slide(objects), LOOK_MAIN, SCALE, () => undefined, 'vid')!;
    expect([...s.plane.slice(PLANE_UV, PLANE_UV + 4)]).toEqual([0, 0, 1, 1]);
  });

  it("fits the video with the clip's own size, not a poster of another aspect", () => {
    // The 4:3 poster stands for a custom poster on a 16:9 clip in a 16:9 box: the clip fills the box.
    const s = sceneSlides(fakeCtx(), slide(objects), LOOK_MAIN, SCALE, images, 'vid', { w: 1920, h: 1080 })!;
    expect([...s.plane.slice(PLANE_UV, PLANE_UV + 4)].map((x) => +x.toFixed(6))).toEqual([0, 0, 1, 1]);
    const left = sample(s.plane, 0.5 * 410, 262.5);
    expect(left.w).toBe(1);
    expect(left.u).toBeCloseTo(10 / 800, 5);
    // A 4:3 clip in the same box is pillarboxed whatever the poster: 'contain' keeps its aspect.
    const narrow = sceneSlides(fakeCtx(), slide(objects), LOOK_MAIN, SCALE, () => undefined, 'vid', {
      w: 640,
      h: 480,
    })!;
    expect(narrow.plane[PLANE_UV]).toBeCloseTo(-1 / 6, 5);
    expect(narrow.plane[PLANE_UV + 2]).toBeCloseTo(7 / 6, 5);
    // With no poster at all the clip's size still fits it, never stretched over the box.
    const bare = sceneSlides(fakeCtx(), slide(objects), LOOK_MAIN, SCALE, () => undefined, 'vid', {
      w: 1920,
      h: 1080,
    })!;
    expect([...bare.plane]).toEqual([...s.plane]);
    // An unusable size falls back to the poster's.
    const bad = sceneSlides(fakeCtx(), slide(objects), LOOK_MAIN, SCALE, images, 'vid', {
      w: Number.NaN,
      h: 0,
    })!;
    expect(bad.plane[PLANE_UV]).toBeCloseTo(-1 / 6, 5);
  });

  it('leaves the poster out of base when the playing object is translucent', () => {
    const o = [...objects];
    o[1] = { ...(video() as Extract<SlideObject, { type: 'image' }>), opacity: 0.5 };
    const s = sceneSlides(fakeCtx(), slide(o), LOOK_MAIN, SCALE, images, 'vid')!;
    expect(ids(s.base)).toEqual(['bg', 'footer', 'badge']);
    expect(s.plane[PLANE_OPACITY]).toBeCloseTo(0.5, 6);
    // Mixed over base at its opacity, the video shows over what is under the object, no poster through it.
    expect(sample(s.plane, 400, 262.5).w).toBeCloseTo(0.5, 6);
  });

  it('leaves the poster out of base when the clip is hidden while stopped', () => {
    const o = [...objects];
    o[1] = video({ showWhenStopped: false });
    const s = sceneSlides(fakeCtx(), slide(o), LOOK_MAIN, SCALE, images, 'vid')!;
    expect(ids(s.base)).toEqual(['bg', 'footer', 'badge']);
  });

  it('puts text that overflows into the video over it, and has no over when nothing touches it', () => {
    const long = text('long', Array(40).fill('word').join(' '), box(400, 100, 800, 100));
    const short = text('short', 'Hi', box(400, 100, 800, 100));
    expect(
      ids(sceneSlides(fakeCtx(), slide([video(), long]), LOOK_MAIN, SCALE, images, 'vid')!.over),
    ).toEqual(['long']);
    const s = sceneSlides(fakeCtx(), slide([video(), short]), LOOK_MAIN, SCALE, images, 'vid')!;
    expect(s.over).toBeNull();
    expect(ids(s.base)).toEqual(['vid', 'short']);
    expect(s.plane[PLANE_FLAGS]).toBe(0);
  });

  it('keeps the page picture in base only', () => {
    const imported = { fileId: 'f', page: 0, imageMediaId: 'page' };
    const s = sceneSlides(fakeCtx(), slide(objects, { imported }), LOOK_MAIN, SCALE, images, 'vid')!;
    expect(s.base.imported).toEqual(imported);
    expect(s.over?.imported).toBeUndefined();
  });

  it('is no scene for a look that does not draw the slide as authored, a missing object or an empty box', () => {
    const hidden: Look = { ...LOOK_MAIN, layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } } };
    const sl = slide(objects);
    expect(sceneSlides(fakeCtx(), sl, LOOK_LOWER_THIRD, SCALE, images, 'vid')).toBeUndefined();
    expect(sceneSlides(fakeCtx(), sl, hidden, SCALE, images, 'vid')).toBeUndefined();
    expect(sceneSlides(fakeCtx(), sl, LOOK_MAIN, SCALE, images, 'gone')).toBeUndefined();
    expect(sceneSlides(fakeCtx(), sl, LOOK_MAIN, SCALE, images, 'title')).toBeUndefined();
    const empty = { ...video(), box: box(400, 300, 0, 450) } as SlideObject;
    expect(sceneSlides(fakeCtx(), slide([empty]), LOOK_MAIN, SCALE, images, 'vid')).toBeUndefined();
    // Without a look the slide is drawn as authored, as drawSlide2D does.
    expect(sceneSlides(fakeCtx(), sl, undefined, SCALE, images, 'vid')).toBeDefined();
  });
});

describe('rasterScene', () => {
  const objects = [
    video(),
    text('title', 'Title', box(500, 250, 600, 120)),
    text('footer', 'Footer', box(100, 900, 400, 100)),
  ];
  const imported = { fileId: 'f', page: 0, imageMediaId: 'page' };

  it('draws base, takes it, then draws over on the same surface and takes that', () => {
    const ctx = fakeCtx();
    const take = () => ctx.ops.splice(0);
    const s = rasterScene(ctx, take, slide(objects, { imported }), LOOK_MAIN, SCALE, images, 'vid')!;
    expect(s.base).toEqual(['image:page', 'image:poster', 'text:Footer']);
    expect(s.over).toEqual(['text:Title']);
    expect(s.plane[PLANE_FLAGS]).toBe(PLANE_HAS_OVER);
  });

  it('takes one picture when nothing is over the video', () => {
    const ctx = fakeCtx();
    let takes = 0;
    const take = () => {
      takes++;
      return ctx.ops.splice(0);
    };
    const s = rasterScene(ctx, take, slide([objects[0]!, objects[2]!]), LOOK_MAIN, SCALE, images, 'vid')!;
    expect(s.base).toEqual(['image:poster', 'text:Footer']);
    expect(s.over).toBeNull();
    expect(takes).toBe(1);
  });

  it('draws nothing when the slide is not a scene', () => {
    const ctx = fakeCtx();
    const take = () => {
      throw new Error('nothing to take');
    };
    expect(rasterScene(ctx, take, slide(objects), LOOK_LOWER_THIRD, SCALE, images, 'vid')).toBeUndefined();
    expect(rasterScene(ctx, take, slide(objects), LOOK_MAIN, SCALE, images, 'gone')).toBeUndefined();
    expect(ctx.ops).toEqual([]);
  });
});
