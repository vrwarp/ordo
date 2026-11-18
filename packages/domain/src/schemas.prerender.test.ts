import { describe, expect, it } from 'vitest';
import { slideContent } from './content.ts';
import { PRERENDER_LIMITS, Presentation, Slide, SlidePrerender } from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';
import * as prev05 from './schemas.prev05.test-util.ts';

/*
 * design/29 §1.2, §1.6: the stand-in's new fields (`Slide.prerender`, `Slide.draw`, `Slide.cut`) and the
 * presentation default (`Presentation.meta.draw`), as this build keeps them and as the older builds read them:
 * 0.8.1 (14f45b1, main's PR #30, the release before wave r2b, with 0.8.0's schema: 2a11dc9, PR #28) and 0.5.0
 * strip them and draw the stand-in; a save from them is valid here.
 */

const HEAD = 'a'.repeat(64);
const SHAPE_FILE = 'b'.repeat(64);

/** A stand-in: its background colour, the lyric box and a playing video kept whole, the rest plain. */
function standIn(): Record<string, unknown> {
  return {
    id: 'big',
    objects: [
      {
        id: 'bg',
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        shape: 'rect',
        fill: { r: 10, g: 20, b: 30, a: 1 },
        opacity: 1,
        radius: 0,
        origin: { src: 'pptx', role: 'bg' },
      },
      {
        id: 'clip',
        type: 'image',
        box: { x: 100, y: 100, w: 800, h: 450, rotation: 0 },
        mediaId: 'poster',
        play: { mediaId: 'video', start: 'auto' },
        fit: 'contain',
        opacity: 1,
        radius: 0,
      },
      {
        id: 'lyric',
        type: 'text',
        box: { x: 100, y: 700, w: 1720, h: 300, rotation: 0 },
        text: 'Amazing grace',
        style: {
          fontFamily: 'Inter',
          fontWeight: 700,
          fontStyle: 'normal',
          fontSizePx: 72,
          color: { r: 255, g: 255, b: 255, a: 1 },
          align: 'center',
          valign: 'middle',
          lineHeight: 1.2,
          letterSpacing: 0,
        },
        opacity: 1,
      },
    ],
    lyricObjectId: 'lyric',
    notes: 'speaker notes stay in the stand-in',
    durationMs: 8000,
    midiCues: [{ id: 'm1', channel: 1, type: 'noteOn', number: 60, value: 127 }],
    prerender: {
      why: ['bytes', 'count'],
      file: { ref: HEAD, bytes: 300_000 },
      live: ['clip', 'lyric'],
      uses: { media: ['photo-1', 'photo-2'], files: [SHAPE_FILE], fonts: ['Carlito', 'Inter'] },
    },
    draw: 'live',
    cut: ['a kept bound left 3 shapes out'],
  };
}

function presentation(meta: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'p',
    rev: 3,
    title: 'Big slides',
    kind: 'slides',
    meta: { tags: [], ...meta },
    sections: [{ id: 's', label: 'Slides', short: 'S', slides: [standIn()] }],
    arrangements: [],
    archived: false,
  };
}

describe('Slide.prerender, Slide.draw, Slide.cut and meta.draw (design/29 §1.2)', () => {
  it('are kept by this build as written', () => {
    const s = Slide.parse(standIn());
    expect(s.prerender).toEqual(standIn().prerender);
    expect(s.draw).toBe('live');
    expect(s.cut).toEqual(['a kept bound left 3 shapes out']);
    expect(Presentation.parse(presentation({ draw: 'live' })).meta.draw).toBe('live');
  });

  it('drops a reason this build does not know (a later release may add one), keeping the rest', () => {
    const raw = standIn();
    (raw.prerender as { why: string[] }).why = ['cost', 'bytes', 'shiny', 'bytes'];
    expect(Slide.parse(raw).prerender?.why).toEqual(['bytes']);
  });

  it('drops a damaged prerender, draw or cut instead of refusing the slide: the stand-in still draws', () => {
    for (const bad of [
      { prerender: { why: ['bytes'], live: Array.from({ length: 1001 }, (_, i) => `o${i}`) } },
      { prerender: { why: ['bytes'], live: [], file: { ref: 'not-a-hash', bytes: 1 } } },
      { prerender: { why: ['bytes'], live: [], uses: { media: [], files: [], fonts: Array(65).fill('F') } } },
      { draw: 'sometimes' },
      { cut: Array(17).fill('x') },
      { cut: ['y'.repeat(201)] },
    ]) {
      const r = Slide.safeParse({ ...standIn(), ...bad });
      expect(r.success, JSON.stringify(bad).slice(0, 80)).toBe(true);
      const key = Object.keys(bad)[0] as 'prerender' | 'draw' | 'cut';
      expect(r.data?.[key]).toBeUndefined();
      expect(r.data?.objects.map((o) => o.id)).toEqual(['bg', 'clip', 'lyric']);
    }
    const p = Presentation.parse(presentation({ draw: 'never' }));
    expect(p.meta.draw).toBeUndefined();
  });

  it('bounds each list at PRERENDER_LIMITS (the schema writes them out)', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
    const hash = (n: number) => Array.from({ length: n }, () => 'c'.repeat(64));
    const rec = (o: object) => SlidePrerender.safeParse({ why: ['bytes'], live: [], ...o }).success;
    const L = PRERENDER_LIMITS;
    expect([rec({ live: ids(L.live) }), rec({ live: ids(L.live + 1) })]).toEqual([true, false]);
    const uses = (u: object) => rec({ uses: { media: [], files: [], fonts: [], ...u } });
    expect([uses({ media: ids(L.media) }), uses({ media: ids(L.media + 1) })]).toEqual([true, false]);
    expect([uses({ files: hash(L.files) }), uses({ files: hash(L.files + 1) })]).toEqual([true, false]);
    expect([uses({ fonts: ids(L.fonts) }), uses({ fonts: ids(L.fonts + 1) })]).toEqual([true, false]);
    const cut = (c: string[]) => Slide.parse({ id: 's', objects: [], cut: c }).cut;
    expect(cut(Array(L.cut).fill('x'.repeat(L.cutChars)))).toHaveLength(L.cut);
    expect(cut(Array(L.cut + 1).fill('x'))).toBeUndefined();
    expect(cut(['x'.repeat(L.cutChars + 1)])).toBeUndefined();
  });

  for (const [name, old] of [
    ['0.8.0 and 0.8.1', prev],
    ['0.5.0', prev05],
  ] as const) {
    it(`the older build (${name}) strips them and draws the stand-in`, () => {
      const r = old.Slide.safeParse(standIn());
      expect(r.success).toBe(true);
      const s = r.data as Record<string, unknown>;
      for (const k of ['prerender', 'draw', 'cut']) expect(s).not.toHaveProperty(k);
      // What it draws is the stand-in: its background colour, the video in its box and the lyric box.
      const drawn = slideContent(s as unknown as Slide);
      expect(drawn.objects.map((o) => o.id)).toEqual(['bg', 'clip', 'lyric']);
      expect(s.lyricObjectId).toBe('lyric');
      expect(s.notes).toBe('speaker notes stay in the stand-in');
      // What it saves back is valid here (without the fields: a save there drops the link to the file).
      expect(Slide.safeParse(s).success).toBe(true);
    });

    it(`an older hub (${name}) accepts a PUT body with meta.draw, and would refuse a top-level key`, () => {
      // apps/hub/src/routes.ts:117 (62a1c3a, unchanged at 2a11dc9 and 14f45b1):
      // PresentationBody = Presentation.strict().
      const body = old.Presentation.strict();
      const r = body.safeParse(presentation({ draw: 'picture' }));
      expect(r.success).toBe(true);
      expect((r.data as { meta: Record<string, unknown> }).meta).not.toHaveProperty('draw');
      expect(body.safeParse({ ...presentation({}), draw: 'picture' }).success).toBe(false);
    });
  }
});
