import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import { canonicalJson } from './palette.ts';
import {
  drawnPart,
  FALLBACK_FACES_DIGEST,
  fallbackFacesDigest,
  LIVE_PLAYING_MAX,
  liveAnchors,
  liveSet,
  objectReach,
  PICTURE_COUNTS,
  PRERENDER_FRAME,
  PRERENDER_ON,
  PRERENDER_VERSION,
  type PictureInputs,
  pictureSource,
  pictureUnits,
  prerenderKey,
  resolveDraw,
  slideUses,
  STAND_IN_TEXT_MAX,
  standbyId,
  standInOf,
  withFullSlide,
} from './prerender.ts';
import * as prev from './schemas.prev.test-util.ts';
import { type ImageObject, type ShapeObject, Slide, type SlideObject, type TextObject } from './schemas.ts';
import { sha256Text } from './sha256.ts';
import { SLIDE_FILE_LIMITS, slideFileOf } from './slidefile.ts';
import { jsonBytes } from './size.ts';

/* design/29 §1.1, §1.2, §1.5, §1.8: what every writer of a pre-rendered slide shares. */

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });

function rect(id: string, b = box(0, 0, 10, 10), extra: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id,
    type: 'shape',
    box: b,
    shape: 'rect',
    fill: { r: 200, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
    ...extra,
  } as ShapeObject;
}
function text(id: string, t: string, b = box(0, 0, 400, 100), extra: Partial<TextObject> = {}): TextObject {
  return { id, type: 'text', box: b, text: t, style: { ...DEFAULT_LYRIC_STYLE }, opacity: 1, ...extra };
}
function picture(id: string, mediaId: string, b = box(0, 0, 100, 100), extra: Partial<ImageObject> = {}) {
  return {
    id,
    type: 'image',
    box: b,
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
    ...extra,
  } as ImageObject;
}
const bg = (): ShapeObject =>
  rect('bg', box(0, 0, 1920, 1080), {
    fill: { r: 10, g: 20, b: 30, a: 1 },
    gradient: {
      kind: 'linear',
      angle: 90,
      stops: [
        { at: 0, color: { r: 10, g: 20, b: 30, a: 1 } },
        { at: 1, color: { r: 90, g: 90, b: 90, a: 1 } },
      ],
    },
    origin: { src: 'pptx', role: 'bg' },
  } as Partial<ShapeObject>);

/** A detailed slide: a background, a photo, a title in Carlito, a playing video and the lyric box above it. */
function detailed(): Slide {
  return {
    id: 'detailed',
    objects: [
      bg(),
      picture('photo', 'photo-media', box(1000, 100, 800, 600)),
      text('title', 'Welcome', box(100, 20, 800, 80), {
        style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Carlito', fallbackFonts: ['Liberation Sans'] },
      }),
      picture('clip', 'clip-poster', box(100, 150, 800, 450), { play: { mediaId: 'clip-video' } }),
      text('lyric', 'Amazing grace', box(100, 700, 1720, 300)),
    ],
    lyricObjectId: 'lyric',
    notes: 'notes',
  };
}

const FONTS = [
  { family: 'Carlito', file: { hash: 'carlito-regular' } },
  { family: 'Inter', file: { hash: 'inter-regular' } },
  { family: 'Liberation Sans', file: { hash: 'liberation-regular' } },
];
function inputs(over: Partial<PictureInputs> = {}): PictureInputs {
  const files: Record<string, string> = { 'photo-media': 'photo-file-1', 'clip-poster': 'poster-file' };
  return { mediaFile: (id) => files[id], fonts: FONTS, ...over };
}
const keyOf = (s: Slide, i: PictureInputs = inputs(), live = liveSet(s)) =>
  prerenderKey(pictureSource(s, live, i));
const standbyOf = (s: Slide, i: PictureInputs = inputs(), live = liveSet(s)) =>
  standbyId(pictureSource(s, live, i));

describe('PRERENDER_ON (design/29 §4: the one pre-render switch)', () => {
  it('is off until the gate of sub-wave 4 passes', () => {
    expect(PRERENDER_ON).toBe(false);
  });
});

describe('prerenderKey and standbyId (design/29 §1.2)', () => {
  it('is a SHA-256 of the version and the canonical source', () => {
    const src = pictureSource(detailed(), liveSet(detailed()), inputs());
    expect(prerenderKey(src)).toMatch(/^[0-9a-f]{64}$/);
    expect(prerenderKey(src)).toBe(sha256Text(canonicalJson({ v: PRERENDER_VERSION, source: src })));
    expect(src.frame).toEqual([3840, 2160]);
    expect(src.fallback).toBe(FALLBACK_FACES_DIGEST);
  });

  it('changes with a font face upload of a family the picture draws, never with an unrelated one', () => {
    const base = keyOf(detailed());
    const bold = { family: 'carlito ', file: { hash: 'carlito-bold' } };
    expect(keyOf(detailed(), inputs({ fonts: [...FONTS, bold] }))).not.toBe(base);
    // A fallback face of the chain (`fallbackFonts`) and the default face count too.
    expect(
      keyOf(detailed(), inputs({ fonts: [...FONTS, { family: 'Liberation Sans', file: { hash: 'lb' } }] })),
    ).not.toBe(base);
    expect(
      keyOf(detailed(), inputs({ fonts: [...FONTS, { family: 'Inter', file: { hash: 'inter-b' } }] })),
    ).not.toBe(base);
    expect(keyOf(detailed(), inputs({ fonts: [...FONTS, { family: 'Comic', file: { hash: 'c' } }] }))).toBe(
      base,
    );
    // The lyric box is live: its family is not the picture's.
    const s = detailed();
    (s.objects[4] as TextObject).style = { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Lyric Font' };
    expect(keyOf(s, inputs({ fonts: [...FONTS, { family: 'Lyric Font', file: { hash: 'lf' } }] }))).toBe(
      keyOf(s),
    );
  });

  it("lists a script fallback's faces only for text in that script", () => {
    const hebrew = { family: 'Noto Sans Hebrew', file: { hash: 'hebrew' } };
    expect(keyOf(detailed(), inputs({ fonts: [...FONTS, hebrew] }))).toBe(keyOf(detailed()));
    const s = detailed();
    (s.objects[2] as TextObject).text = 'Welcome שלום';
    expect(keyOf(s, inputs({ fonts: [...FONTS, hebrew] }))).not.toBe(keyOf(s));
    const src = pictureSource(s, liveSet(s), inputs());
    expect(src.fonts.faces['noto sans hebrew']).toBeNull();
    expect(src.fonts.faces.carlito).toEqual(['carlito-regular']);
    expect(src.fonts.faces.inter).toEqual(['inter-regular']);
  });

  it('changes with a media file replace, and so does the stand-by id', () => {
    const replaced = inputs({ mediaFile: (id) => (id === 'photo-media' ? 'photo-file-2' : 'poster-file') });
    expect(keyOf(detailed(), replaced)).not.toBe(keyOf(detailed()));
    expect(standbyOf(detailed(), replaced)).not.toBe(standbyOf(detailed()));
    // A picture the library lacks is named null, not left out.
    expect(
      pictureSource(detailed(), liveSet(detailed()), inputs({ mediaFile: () => undefined })).media,
    ).toEqual({
      'photo-media': null,
    });
  });

  it('changes with PRERENDER_VERSION; the stand-by id does not, nor with a font upload', () => {
    const src = pictureSource(detailed(), liveSet(detailed()), inputs());
    expect(prerenderKey(src, PRERENDER_VERSION + 1)).not.toBe(prerenderKey(src));
    const withFont = pictureSource(
      detailed(),
      liveSet(detailed()),
      inputs({ fonts: [...FONTS, { family: 'Carlito', file: { hash: 'carlito-bold' } }] }),
    );
    expect(prerenderKey(withFont)).not.toBe(prerenderKey(src));
    expect(standbyId(withFont)).toBe(standbyId(src));
  });

  it("does not change with an object's id, origin or lock, nor with notes, cues or timing", () => {
    const base = keyOf(detailed());
    const s = detailed();
    s.objects[1] = { ...s.objects[1]!, id: 'photo-renamed' } as SlideObject;
    s.objects = s.objects.map(
      (o) => ({ ...o, locked: true, origin: { src: 'pptx', shapeId: 99 } }) as SlideObject,
    );
    s.notes = 'other notes';
    s.durationMs = 1234;
    s.midiCues = [{ id: 'm', channel: 1, type: 'noteOn', number: 1, value: 1 }];
    expect(keyOf(s)).toBe(base);
    expect(standbyOf(s)).toBe(standbyOf(detailed()));
    // What the picture draws does change it.
    const moved = detailed();
    moved.objects[1] = { ...moved.objects[1]!, box: box(1001, 100, 800, 600) } as SlideObject;
    expect(keyOf(moved)).not.toBe(base);
  });

  it('keys the variant without backdrops apart (a background override, owner question 5)', () => {
    const src = pictureSource(detailed(), liveSet(detailed()), inputs({ backdrops: false }));
    expect(src.backdrops).toBe(false);
    expect(prerenderKey(src)).not.toBe(keyOf(detailed()));
    expect(standbyId(src)).not.toBe(standbyOf(detailed()));
  });

  it('names its fallback faces by a digest of the default face and the script fallbacks', () => {
    expect(FALLBACK_FACES_DIGEST).toBe(fallbackFacesDigest());
  });
});

describe('drawnPart (design/29 §1.2)', () => {
  it('is what the picture draws: the objects without the live set, ids, origins and locks', () => {
    const s = detailed();
    const part = drawnPart(s, liveSet(s));
    expect(part.objects).toHaveLength(3);
    for (const o of part.objects) {
      expect(o).not.toHaveProperty('id');
      expect(o).not.toHaveProperty('origin');
      expect(o).not.toHaveProperty('locked');
    }
    expect(part.picture).toBeUndefined();
  });
});

describe('pictureUnits (design/29 §1.1)', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => rect(`r${i}`));
  it('counts objects past the live bound', () => {
    expect(pictureUnits({ id: 's', objects: many(201) }).why).toEqual(['count']);
    expect(pictureUnits({ id: 's', objects: many(201) }).over).toContain('objects');
    expect(pictureUnits({ id: 's', objects: many(200) }).why).toEqual([]);
    expect(pictureUnits({ id: 's', objects: many(100) })).toMatchObject({ why: [], over: [] });
  });

  it('counts distinct pictures past 16', () => {
    const pics = (n: number) => Array.from({ length: n }, (_, i) => picture(`p${i}`, `m${i}`));
    expect(pictureUnits({ id: 's', objects: pics(17) }).why).toEqual(['count']);
    expect(pictureUnits({ id: 's', objects: pics(17) }).over).toEqual(['pictures']);
    // The same picture twice is one.
    expect(pictureUnits({ id: 's', objects: [...pics(16), picture('again', 'm3')] }).why).toEqual([]);
  });

  it('counts stored bytes past 64 KiB', () => {
    // Eight boxes of 9,000 characters: each within the drawn bound, together past 64 KiB.
    const s: Slide = {
      id: 's',
      objects: Array.from({ length: 8 }, (_, i) => text(`t${i}`, 'x'.repeat(9_000))),
    };
    expect(jsonBytes(s)).toBeGreaterThan(70_000);
    expect(pictureUnits(s)).toMatchObject({ why: ['bytes'], over: ['bytes'] });
  });

  it('counts a box past the drawn characters, families or size scales (not the lyric box)', () => {
    const long = text('long', 'a'.repeat(PICTURE_COUNTS.characters + 1));
    expect(pictureUnits({ id: 's', objects: [long] }).over).toContain('characters');
    expect(pictureUnits({ id: 's', objects: [long], lyricObjectId: 'long' }).over).not.toContain(
      'characters',
    );
    const runs = (n: number, f: (i: number) => object) =>
      Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1, ...f(i) }));
    const fams = text('f', 'x'.repeat(100), undefined, { runs: runs(17, (i) => ({ fontFamily: `F${i}` })) });
    expect(pictureUnits({ id: 's', objects: [fams] }).over).toEqual(['families']);
    const ok = text('f', 'x'.repeat(100), undefined, { runs: runs(16, (i) => ({ fontFamily: `F${i}` })) });
    expect(pictureUnits({ id: 's', objects: [ok] }).why).toEqual([]);
    const scales = text('k', 'x'.repeat(100), undefined, {
      runs: runs(65, (i) => ({ sizeScale: 1 + i / 100 })),
    });
    expect(pictureUnits({ id: 's', objects: [scales] }).over).toEqual(['sizeScales']);
  });

  it('judges cost at the fixed 3840 reference, so every view plans the same', () => {
    const scales: number[] = [];
    // A cost model whose verdict depends on the scale (a geometry no task can draw at 4K but can at 1080p).
    const cost = (_s: Slide, at: typeof PRERENDER_FRAME) => {
      scales.push(at.scale);
      return at.scale >= 2 ? ['geometry'] : [];
    };
    const plan = pictureUnits({ id: 's', objects: many(3) }, cost);
    expect(plan).toMatchObject({ why: ['count'], over: ['geometry'] });
    expect(scales).toEqual([2]);
    expect(PRERENDER_FRAME).toEqual({ width: 3840, height: 2160, scale: 2 });
  });
});

describe('liveSet (design/29 §1.5)', () => {
  const video = picture('video', 'poster', box(100, 100, 800, 450), { play: { mediaId: 'clip' } });
  it('is the anchors and what lies above them and overlaps them, bottom first', () => {
    const s: Slide = {
      id: 's',
      objects: [
        rect('under', box(0, 0, 1920, 1080)),
        video,
        rect('over', box(800, 500, 200, 200)),
        rect('beside', box(1500, 800, 100, 100)),
        rect('chained', box(950, 650, 300, 100)),
      ],
    };
    expect(liveSet(s)).toEqual(['video', 'over', 'chained']);
  });

  it("reaches as far as an object's shadow", () => {
    const shadowed = text('caption', 'Caption', box(950, 200, 300, 100), {
      style: {
        ...DEFAULT_LYRIC_STYLE,
        shadow: { dx: -100, dy: 0, blur: 10, color: { r: 0, g: 0, b: 0, a: 1 } },
      },
    });
    const s: Slide = { id: 's', objects: [video, shadowed] };
    expect(liveSet(s)).toEqual(['video', 'caption']);
    // A reach without effects sees the box only.
    const boxOnly = (o: SlideObject) => ({ x: o.box.x, y: o.box.y, w: o.box.w, h: o.box.h });
    expect(liveSet(s, boxOnly)).toEqual(['video']);
    expect(objectReach(shadowed).x).toBeLessThanOrEqual(950 - 100 - 20);
  });

  it('anchors the lyric box, text with build steps and playing pictures, at most 16 playing', () => {
    const steps = text('steps', 'one\ntwo', box(0, 0, 100, 100), { paras: [null, { hidden: true }] });
    const s: Slide = {
      id: 's',
      objects: [rect('a'), steps, text('lyric', 'L'), video],
      lyricObjectId: 'lyric',
    };
    expect(liveAnchors(s)).toEqual(['steps', 'lyric', 'video']);
    const videos = Array.from({ length: LIVE_PLAYING_MAX + 1 }, (_, i) =>
      picture(`v${i}`, `p${i}`, box(i * 100, 0, 50, 50), { play: { mediaId: `c${i}` } }),
    );
    expect(liveAnchors({ id: 's', objects: videos })).toHaveLength(LIVE_PLAYING_MAX);
  });
});

describe('standInOf (design/29 §1.2)', () => {
  it('keeps the lyric box and a playing video whole, the rest simplified, and every other field', () => {
    const s = detailed();
    (s.objects[4] as TextObject).runs = [{ start: 0, end: 7, fontWeight: 900 }];
    (s.objects[2] as TextObject).runs = [{ start: 0, end: 3, fontWeight: 300 }];
    s.midiCues = [{ id: 'm', channel: 1, type: 'noteOn', number: 1, value: 1 }];
    s.durationMs = 5000;
    const live = liveSet(s);
    const out = standInOf(s, live);
    expect(out.objects.map((o) => o.id)).toEqual(['bg', 'photo', 'title', 'clip', 'lyric']);
    expect(out.objects[4]).toEqual(s.objects[4]);
    expect(out.objects[3]).toEqual(s.objects[3]);
    expect((out.objects[2] as TextObject).runs).toBeUndefined();
    // The background is its colour alone (`minimalSlide`).
    expect((out.objects[0] as ShapeObject).gradient).toBeUndefined();
    expect(out.notes).toBe('notes');
    expect(out.midiCues).toEqual(s.midiCues);
    expect(out.durationMs).toBe(5000);
    expect(out.lyricObjectId).toBe('lyric');
    expect(out.prerender?.live).toEqual(live);
    expect(Slide.safeParse(out).success).toBe(true);
  });

  it('fits a 300-object slide into 200 objects and 16 pictures: live first, then text, then pictures by area', () => {
    const objects: SlideObject[] = [bg()];
    for (let i = 0; i < 120; i++) objects.push(rect(`deco${i}`, box(i, i, 5, 5)));
    for (let i = 0; i < 30; i++) objects.push(picture(`pic${i}`, `m${i}`, box(0, 0, 10 + i, 10 + i)));
    for (let i = 0; i < 147; i++) objects.push(text(`t${i}`, `line ${i}`, box(0, 1000, 10, 10)));
    objects.push(picture('clip', 'poster', box(100, 100, 50, 50), { play: { mediaId: 'video' } }));
    objects.push(text('lyric', 'L', box(1500, 0, 100, 100)));
    expect(objects).toHaveLength(300);
    const s: Slide = { id: 's', objects, lyricObjectId: 'lyric' };
    const out = standInOf(s, liveSet(s));
    expect(out.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
    const media = new Set(out.objects.flatMap((o) => (o.type === 'image' ? [o.mediaId] : [])));
    expect(media.size).toBeLessThanOrEqual(PICTURE_COUNTS.pictures);
    const ids = out.objects.map((o) => o.id);
    expect(ids).toContain('lyric');
    expect(ids).toContain('clip');
    expect(ids).toContain('bg');
    for (let i = 0; i < 147; i++) expect(ids).toContain(`t${i}`);
    // The largest pictures are the ones kept, in z order.
    const pics = ids.filter((id) => id.startsWith('pic'));
    expect(pics).toEqual(Array.from({ length: pics.length }, (_, k) => `pic${30 - pics.length + k}`));
    expect(ids.indexOf('bg')).toBe(0);
    expect(Slide.safeParse(out).success).toBe(true);
  });

  it('splits 70 KB of text into plain boxes of at most 20,000 characters within the 200-object cap', () => {
    const objects: SlideObject[] = [];
    for (let i = 0; i < 260; i++) objects.push(text(`t${i}`, `${i}:${'w'.repeat(280)}`, box(0, i, 900, 10)));
    const s: Slide = { id: 's', objects };
    const all = objects.map((o) => (o as TextObject).text).join('');
    expect(all.length).toBeGreaterThan(70_000);
    const out = standInOf(s, []);
    expect(out.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
    for (const o of out.objects) expect((o as TextObject).text.length).toBeLessThanOrEqual(STAND_IN_TEXT_MAX);
    // Every word is still there for search, Stage and the older builds.
    const kept = out.objects.map((o) => (o as TextObject).text).join('\n');
    for (let i = 0; i < 260; i++) expect(kept).toContain(`${i}:${'w'.repeat(280)}`);
    expect(Slide.safeParse(out).success).toBe(true);
    // Past one box's 20,000 characters the merged text is split, not one box the schema refuses.
    const longer: SlideObject[] = Array.from({ length: 400 }, (_, i) => text(`l${i}`, 'q'.repeat(250)));
    const out2 = standInOf({ id: 's2', objects: longer }, []);
    expect(out2.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
    expect(Math.max(...out2.objects.map((o) => (o as TextObject).text.length))).toBeLessThanOrEqual(
      STAND_IN_TEXT_MAX,
    );
    expect(
      out2.objects
        .map((o) => (o as TextObject).text)
        .join('')
        .replace(/\n/g, ''),
    ).toBe('q'.repeat(100_000));
    expect(Slide.safeParse(out2).success).toBe(true);
    expect(new Set(out2.objects.map((o) => o.id)).size).toBe(out2.objects.length);
  });

  it('parses and draws as the stand-in in the older build (0.8.0 and 0.8.1)', () => {
    const s = detailed();
    const out = standInOf(s, liveSet(s));
    const old = prev.Slide.safeParse({ ...out, prerender: { why: ['bytes'], live: out.prerender?.live } });
    expect(old.success).toBe(true);
    expect((old.data as { objects: { id: string }[] }).objects.map((o) => o.id)).toEqual(
      out.objects.map((o) => o.id),
    );
  });
});

describe('resolveDraw (design/29 §1.2, owner question 10)', () => {
  const pre = (why: string[], draw?: 'picture' | 'live'): Slide =>
    ({ id: 's', objects: [], prerender: { why, live: [] }, ...(draw ? { draw } : {}) }) as Slide;
  it('draws a pre-rendered slide from its picture unless it or its presentation says Live', () => {
    expect(resolveDraw(pre(['bytes']))).toBe('picture');
    expect(resolveDraw(pre(['count']), { draw: 'live' })).toBe('live');
    expect(resolveDraw(pre(['count'], 'picture'), { draw: 'live' })).toBe('picture');
    expect(resolveDraw(pre(['bytes'], 'live'))).toBe('live');
  });
  it('draws a tail slide live unless its estimate passes 0.3 s at 4K or its own switch says otherwise', () => {
    expect(resolveDraw(pre(['tail']))).toBe('live');
    expect(resolveDraw(pre(['tail']), undefined, { estimateMs: 300 })).toBe('live');
    expect(resolveDraw(pre(['tail']), undefined, { estimateMs: 301 })).toBe('picture');
    expect(resolveDraw(pre(['tail']), { draw: 'live' }, { estimateMs: 900 })).toBe('live');
    expect(resolveDraw(pre(['tail'], 'picture'))).toBe('picture');
    expect(resolveDraw(pre(['tail', 'count']))).toBe('picture');
  });
  it('draws a slide without a pre-render record live unless it is set to Pre-rendered', () => {
    expect(resolveDraw({ id: 's', objects: [] })).toBe('live');
    expect(resolveDraw({ id: 's', objects: [] }, { draw: 'picture' })).toBe('live');
    expect(resolveDraw({ id: 's', objects: [], draw: 'picture' })).toBe('picture');
  });
});

describe('withFullSlide (design/29 §1.8: every writer through the full slide)', () => {
  function big(): Slide {
    const objects: SlideObject[] = [bg()];
    for (let i = 0; i < 300; i++) objects.push(rect(`r${i}`, box(i * 6, 200, 5, 5)));
    objects.push(text('title', 'Old title', box(0, 0, 500, 100)));
    objects.push(text('lyric', 'Lyric', box(0, 900, 500, 100)));
    return { id: 'big', objects, lyricObjectId: 'lyric', notes: 'n' };
  }

  it('writes pages, the stand-in and the key of a big slide', () => {
    const r = withFullSlide(big(), (s) => s, inputs());
    expect(r.pages?.pages.length).toBe(1);
    expect(r.standIn.prerender).toMatchObject({ why: ['count'], live: ['lyric'] });
    expect(r.standIn.prerender?.file).toEqual({ ref: r.pages!.name, bytes: r.pages!.bytes });
    expect(r.standIn.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
    expect(r.key).toBe(prerenderKey(pictureSource(r.full, ['lyric'], inputs())));
    expect(r.standbyId).toBe(standbyId(pictureSource(r.full, ['lyric'], inputs())));
    expect(Slide.safeParse(r.standIn).success).toBe(true);
  });

  it('exports the uses it writes: slideUses of the full slide is the record withFullSlide stores (the hub checks heads with it)', () => {
    const slide = big();
    slide.objects.push(
      picture('photo', 'photo-media', box(0, 0, 100, 100)),
      text('serif', 'Hi', box(0, 0, 50, 50), { style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Carlito' } }),
    );
    const r = withFullSlide(slide, (s) => s, inputs());
    expect(r.standIn.prerender?.uses).toEqual(slideUses(r.full));
    expect(slideUses(r.full).media).toContain('photo-media');
    expect(slideUses(r.full).fonts).toContain('Carlito');
  });

  it('changes the pages and the key and rebuilds the stand-in when an operation changes the slide', () => {
    const a = withFullSlide(big(), (s) => s, inputs());
    const b = withFullSlide(
      big(),
      (s) => ({
        ...s,
        objects: s.objects.map((o) => (o.id === 'title' ? { ...o, text: 'New title' } : o)) as SlideObject[],
      }),
      inputs(),
    );
    expect(b.pages!.name).not.toBe(a.pages!.name);
    expect(b.key).not.toBe(a.key);
    expect((b.standIn.objects.find((o) => o.id === 'title') as TextObject).text).toBe('New title');
  });

  it('changes neither when only the notes change', () => {
    const a = withFullSlide(big(), (s) => s, inputs());
    const b = withFullSlide(big(), (s) => ({ ...s, notes: 'new notes' }), inputs());
    expect(b.pages!.name).toBe(a.pages!.name);
    expect(b.pages!.pages.map((p) => p.name)).toEqual(a.pages!.pages.map((p) => p.name));
    expect(b.key).toBe(a.key);
    expect(b.standIn.notes).toBe('new notes');
  });

  it('keeps an ordinary slide inline whole, and a slide set to Pre-rendered inline with a key', () => {
    const small: Slide = { id: 's', objects: [rect('a'), text('t', 'T')], notes: 'x' };
    const r = withFullSlide(small, (s) => s, inputs());
    expect(r.pages).toBeUndefined();
    expect(r.key).toBeUndefined();
    expect(r.standIn).toEqual(small);
    const chosen = withFullSlide(small, (s) => ({ ...s, draw: 'picture' as const }), inputs());
    expect(chosen.pages).toBeUndefined();
    expect(chosen.standIn.objects).toEqual(small.objects);
    expect(chosen.standIn.prerender).toEqual({ why: ['chosen'], live: [] });
    expect(chosen.key).toMatch(/^[0-9a-f]{64}$/);
    // A big slide made small again is stored inline, without its record.
    const shrunk = withFullSlide(big(), (s) => ({ ...s, objects: s.objects.slice(0, 5) }), inputs());
    expect(shrunk.standIn.prerender).toBeUndefined();
    expect(shrunk.pages).toBeUndefined();
  });

  it('keeps only the stand-in of a slide the content store cannot hold (W18), without a file or picture', () => {
    const huge: Slide = {
      id: 'huge',
      objects: Array.from({ length: SLIDE_FILE_LIMITS.objects + 1 }, (_, i) => rect(`h${i}`)),
    };
    const r = withFullSlide(huge, (s) => s, inputs());
    expect(r.pages).toBeUndefined();
    expect(r.key).toBeUndefined();
    expect(r.refused).toMatch(/20000 objects/);
    expect(r.standIn.prerender).toEqual({ why: ['bytes'], live: [] });
    expect(r.standIn.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
    expect(() => slideFileOf(huge)).toThrow();
  });
});
