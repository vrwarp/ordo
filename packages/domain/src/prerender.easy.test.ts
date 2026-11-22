import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONTENT_CASES } from './content.test-util.ts';
import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import { canonicalJson } from './palette.ts';
import {
  drawnPart,
  type EasyOptions,
  easyPlan,
  liveSet,
  PRERENDER_ANCHORED,
  PRERENDER_REFUSED_MISSING,
  type PictureInputs,
  pictureSource,
  pictureUnits,
  planRecord,
  prerenderKey,
  standbyId,
} from './prerender.ts';
import * as prev from './schemas.prev.test-util.ts';
import * as prev05 from './schemas.prev05.test-util.ts';
import {
  type ImageObject,
  Presentation,
  type ShapeObject,
  Slide,
  SlidePrerender,
  type TextObject,
} from './schemas.ts';
import { sha256Text } from './sha256.ts';
import { jsonBytes, SIZE_BUDGETS } from './size.ts';

/*
 * design/29 §1.1, §1.5 (Q24.b, the first pre-render release): which slides get a picture (`easyPlan`) and the
 * helper that writes, refreshes or removes the record (`planRecord`). The builders below are copies of the
 * small ones of prerender.test.ts (test files do not import each other).
 */

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
    origin: { src: 'pptx', role: 'bg' },
  } as Partial<ShapeObject>);

const FONTS = [
  { family: 'Carlito', file: { hash: 'carlito-regular' } },
  { family: 'Inter', file: { hash: 'inter-regular' } },
  { family: 'Liberation Sans', file: { hash: 'liberation-regular' } },
];
function inputs(over: Partial<PictureInputs> = {}): PictureInputs {
  const files: Record<string, string> = { ref: 'ref-file', mine: 'mine-file', photo: 'photo-file' };
  return { mediaFile: (id) => files[id], fonts: FONTS, ...over };
}

/** A background rect, a title and 18 rects: 20 objects, nothing that moves, nothing that is the lyric box. */
function plainSlide(): Slide {
  return {
    id: 'plain',
    objects: [
      bg(),
      text('title', 'Welcome'),
      ...Array.from({ length: 18 }, (_, i) =>
        rect(`r${i}`, box((i % 6) * 60, Math.floor(i / 6) * 60, 50, 50)),
      ),
    ],
  };
}

/** A background, `n` rects at distinct boxes, a title and a lyric box (`lyricObjectId`). */
function crowdedSlide(n: number): Slide {
  return {
    id: `crowded${n}`,
    objects: [
      bg(),
      ...Array.from({ length: n }, (_, i) =>
        rect(`r${i}`, box((i % 40) * 40, Math.floor(i / 40) * 40, 30, 30)),
      ),
      text('title', 'Welcome', box(100, 20, 800, 80)),
      text('lyric', 'Amazing grace', box(100, 700, 1720, 300)),
    ],
    lyricObjectId: 'lyric',
  };
}

/**
 * The slide of content.test-util.ts "shows its PowerPoint picture (reference plus the operator objects)": it
 * draws the reference picture and the operator's own objects, and stores the imported ones. Its imported
 * picture plays, its imported text is the lyric box, and `extraImported` imported rects are added: none of them
 * is drawn.
 */
function referenceSlide(extraImported = 0): Slide {
  const found = CONTENT_CASES.find((c) => c.name.startsWith('shows its PowerPoint picture'));
  if (!found) throw new Error('the reference-picture case of content.test-util.ts moved');
  const s = structuredClone(found.slide);
  s.objects = s.objects.map((o) =>
    o.id === 'photo-o' && o.type === 'image' ? { ...o, play: { mediaId: 'clip' } } : o,
  );
  s.lyricObjectId = 'title';
  const extra = Array.from({ length: extraImported }, (_, i) =>
    rect(`imp${i}`, box((i % 40) * 40, Math.floor(i / 40) * 40, 30, 30), {
      origin: { src: 'pptx', role: 'shape' },
    } as Partial<ShapeObject>),
  );
  s.objects = [...s.objects.slice(0, 3), ...extra, ...s.objects.slice(3)];
  return s;
}

const pin = (s: Slide, live: string[]) => {
  const src = pictureSource(s, live, inputs());
  const part = drawnPart(s, live);
  return {
    key: prerenderKey(src),
    standby: standbyId(src),
    drawn: { objects: part.objects.length, picture: part.picture, digest: sha256Text(canonicalJson(part)) },
  };
};

describe('the keys do not move (easyPlan changes what gets a record, never what a picture is)', () => {
  // `live` is explicit on purpose: these pins must not depend on `liveSet`, which F6 changes (step 2).
  it('the keys of three fixture slides do not move (a moved key makes every stored picture stale)', () => {
    expect({
      plain: pin(plainSlide(), []),
      crowded: pin(crowdedSlide(300), ['lyric']),
      reference: pin(referenceSlide(), []),
    }).toEqual({
      plain: {
        key: 'b81f265c7353348ca2dc09cfe0442882c10831bb0d5d1765454ff17f6de9ead5',
        standby: '321418a87517f3c42fa27cc5ff7111c2230aef8d0d8b98593d7279204eca81da',
        drawn: {
          objects: 20,
          picture: undefined,
          digest: '4ef9a437aa6540a1bd7483276d818f42b143893b37edf9bebe4b3494169add03',
        },
      },
      crowded: {
        key: '2067db3f67e197307560b780ec91147b713dd59eb836de0b4834b5a411a04e9e',
        standby: '9074a773613130c925625fb8ab2e90ab9f71229274bb350cbc57dcbfdf1bbf13',
        drawn: {
          objects: 302,
          picture: undefined,
          digest: '2e3cefa4467681739e68fe956faa329888728221c97a010526b7af6285043c95',
        },
      },
      reference: {
        key: '26f1da118689a8989379565fe075c3089af04fb00c2cbab95877099601765b65',
        standby: '1578cf1b77874fd4084130868eaa221dc07dab5e4f37b94c3bbce09f56bc2cef',
        drawn: {
          objects: 2,
          picture: 'ref',
          digest: '6316cc23d5728999bd1c8229e590d4a7ac77bc5cf1a367ab3085b38ca23b5f8c',
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// easyPlan

/** `n` rects at distinct boxes. */
const many = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) =>
    rect(`r${from + i}`, box(((from + i) % 40) * 40, Math.floor((from + i) / 40) * 40, 30, 30)),
  );
const slideOf = (objects: Slide['objects'], extra: Partial<Slide> = {}): Slide => ({
  id: 's',
  objects,
  ...extra,
});
/** A slide of 9,000-character boxes (each within the drawn bound) and two padding boxes: exactly `target` bytes. */
function slideOfBytes(target: number, extra: Partial<Slide> = {}): Slide {
  const build = (boxes: number, filler: number) =>
    slideOf(
      [
        ...Array.from({ length: boxes }, (_, i) => text(`t${i}`, 'x'.repeat(9_000))),
        text('pad1', 'y'.repeat(Math.floor(filler / 2))),
        text('pad2', 'z'.repeat(filler - Math.floor(filler / 2))),
      ],
      extra,
    );
  for (let boxes = 8; boxes >= 0; boxes--) {
    const room = target - jsonBytes(build(boxes, 0));
    if (room < 0 || room > 19_000) continue;
    const s = build(boxes, room);
    expect(jsonBytes(s)).toBe(target);
    return s;
  }
  throw new Error(`no slide of ${target} bytes`);
}
/** A recursively frozen copy (a plan or a write that mutates its input throws). */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
const video = (id = 'video') => picture(id, 'poster', box(100, 100, 800, 450), { play: { mediaId: 'clip' } });

describe('easyPlan: which slides get a record (design/29 §1.1, Q24.b)', () => {
  it('T1 a plain slide of 20 objects needs nothing', () => {
    expect(easyPlan(plainSlide())).toMatchObject({
      eligible: true,
      record: false,
      anchors: [],
      why: [],
      over: [],
      counts: { objects: 20, pictures: 0 },
    });
  });

  it('T2 counts the drawn objects: 200 are within a screen, 201 are past it (count)', () => {
    expect(easyPlan(slideOf(many(200)))).toMatchObject({ why: [], over: [], record: false });
    const over = easyPlan(slideOf(many(201)));
    expect(over).toMatchObject({ why: ['count'], record: true, eligible: true });
    expect(over.over).toContain('objects');
    expect(over.counts.objects).toBe(201);
  });

  it('T3 counts distinct pictures: 17 are past a screen, 16 and a repeat are not', () => {
    const pics = (n: number) => Array.from({ length: n }, (_, i) => picture(`p${i}`, `m${i}`));
    const over = easyPlan(slideOf(pics(17)));
    expect(over).toMatchObject({ why: ['count'], record: true });
    expect(over.over).toContain('pictures');
    expect(easyPlan(slideOf([...pics(16), picture('again', 'm3')]))).toMatchObject({
      why: [],
      record: false,
    });
  });

  it('T4 stored over 64 KiB is `bytes`, with no count reason when every count is within', () => {
    // Eight boxes of 9,000 characters: each within the drawn bound, together past 64 KiB.
    const s = slideOf(Array.from({ length: 8 }, (_, i) => text(`t${i}`, 'x'.repeat(9_000))));
    expect(jsonBytes(s)).toBeGreaterThan(SIZE_BUDGETS.slideMax);
    expect(easyPlan(s)).toMatchObject({ why: ['bytes'], over: ['bytes'], record: true });
  });

  it('T5 the bound is exact and the slide is measured without its own record (no bistable band)', () => {
    const rec = { why: ['bytes' as const], live: [] };
    for (const [target, why] of [
      [SIZE_BUDGETS.slideMax, []],
      [SIZE_BUDGETS.slideMax + 1, ['bytes']],
    ] as const) {
      const bare = slideOfBytes(target);
      const without = easyPlan(bare);
      const withRecord = easyPlan({ ...bare, prerender: rec });
      expect(jsonBytes({ ...bare, prerender: rec })).toBeGreaterThan(target);
      expect(without.why).toEqual(why);
      expect(without.counts.bytes).toBe(target);
      // The record adds about 40 bytes to the slide it describes; it never counts toward its own size.
      expect(withRecord).toEqual(without);
    }
  });

  it('T6 the other bounds give no reason (a bake draws under the same per-object clamps), only `over`', () => {
    const runs = (n: number, f: (i: number) => object) =>
      Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1, ...f(i) }));
    const cases: [string, TextObject][] = [
      ['characters', text('long', 'a'.repeat(10_001))],
      [
        'families',
        text('f', 'x'.repeat(100), undefined, { runs: runs(17, (i) => ({ fontFamily: `F${i}` })) }),
      ],
      [
        'sizeScales',
        text('k', 'x'.repeat(100), undefined, { runs: runs(65, (i) => ({ sizeScale: 1 + i / 100 })) }),
      ],
    ];
    for (const [bound, t] of cases) {
      const plan = easyPlan(slideOf([t]));
      expect(plan.over).toEqual([bound]);
      expect(plan).toMatchObject({ why: [], record: false, eligible: true });
    }
  });

  it('T7 a playing picture among 300 shapes is an anchor: not eligible, the reasons still computed (H2)', () => {
    const objects = [...many(250), video(), ...many(49, 250)];
    expect(objects).toHaveLength(300);
    const plan = easyPlan(slideOf(objects));
    expect(plan.anchors).toEqual([{ id: 'video', kind: 'play' }]);
    expect(plan).toMatchObject({ eligible: false, why: ['count'], record: false });
    expect(plan.over).toContain('objects');
  });

  it('T8 step-by-step text is an anchor, a visible paragraph is not', () => {
    const steps = text('steps', 'one\ntwo', box(0, 0, 100, 100), { paras: [null, { hidden: true }] });
    const shown = text('shown', 'one', box(0, 0, 100, 100), { paras: [{ hidden: false }] });
    expect(easyPlan(slideOf([rect('a'), steps])).anchors).toEqual([{ id: 'steps', kind: 'steps' }]);
    expect(easyPlan(slideOf([rect('a'), shown])).anchors).toEqual([]);
    expect(easyPlan(slideOf([rect('a'), steps])).eligible).toBe(false);
  });

  it("T9 the lyric box is an anchor in a song only (Q25.a), unless the reading is 'any' (Q25.b)", () => {
    const s = slideOf([rect('a'), text('lyric', 'Amazing grace')], { lyricObjectId: 'lyric' });
    const lyric = [{ id: 'lyric', kind: 'lyric' }];
    expect(easyPlan(s, { kind: 'song' })).toMatchObject({ anchors: lyric, eligible: false });
    for (const kind of ['slides', 'loop', undefined] as const)
      expect(easyPlan(s, { kind })).toMatchObject({ anchors: [], eligible: true });
    expect(easyPlan(s, { kind: 'slides', lyric: 'any' })).toMatchObject({ anchors: lyric, eligible: false });
    // A lyric text with a hidden paragraph in a deck of slides is step-by-step text, not a lyric box.
    const stepped = slideOf(
      [text('lyric', 'a\nb', box(0, 0, 100, 100), { paras: [null, { hidden: true }] })],
      {
        lyricObjectId: 'lyric',
      },
    );
    expect(easyPlan(stepped, { kind: 'slides' }).anchors).toEqual([{ id: 'lyric', kind: 'steps' }]);
    // The lyric rule wins over the steps rule in a song (the precedence of `liveAnchors`).
    expect(easyPlan(stepped, { kind: 'song' }).anchors).toEqual([{ id: 'lyric', kind: 'lyric' }]);
  });

  it('T10 only a video counts as a moving background (Q25.c.b); the safe default keeps any other answer out', () => {
    const crowded = slideOf(many(300), { backgroundMediaId: 'm' });
    // A picture (the callback says it does not move): no anchor, the slide gets its record.
    expect(easyPlan(crowded, { isMotion: () => false })).toMatchObject({
      anchors: [],
      eligible: true,
      why: ['count'],
      record: true,
    });
    // A video: an anchor, the reasons still computed, no record.
    expect(easyPlan(crowded, { isMotion: (id) => id === 'm' })).toMatchObject({
      anchors: [{ id: 'm', kind: 'background' }],
      eligible: false,
      why: ['count'],
      record: false,
    });
    // No callback, an answer of undefined and a callback that throws: the safe default, an anchor.
    for (const isMotion of [
      undefined,
      () => undefined,
      () => {
        throw new Error('unknown media');
      },
    ])
      expect(easyPlan(crowded, { isMotion }).anchors).toEqual([{ id: 'm', kind: 'background' }]);
    // The anchors come in drawn order and the background is last.
    const both = slideOf([...many(3), video()], { backgroundMediaId: 'm' });
    expect(easyPlan(both, { isMotion: () => true }).anchors).toEqual([
      { id: 'video', kind: 'play' },
      { id: 'm', kind: 'background' },
    ]);
  });

  it("T10c the presentation's shared background is no slide's own: no anchor on any slide", () => {
    for (const backgroundMediaId of ['shared-video', 'shared-picture']) {
      const p = Presentation.parse({
        id: 'p',
        title: 'T',
        kind: 'slides',
        backgroundMediaId,
        sections: [{ id: 's', label: 'S', short: 'S', slides: [plainSlide(), crowdedSlide(300)] }],
      });
      const [plain, crowded] = p.sections.flatMap((sec) => sec.slides);
      expect(easyPlan(plain!, { kind: p.kind, isMotion: () => true })).toMatchObject({
        anchors: [],
        record: false,
      });
      // The heavy slide of that presentation still gets its record: the shared background keeps nothing out.
      expect(easyPlan(crowded!, { kind: p.kind, isMotion: () => true })).toMatchObject({
        anchors: [],
        why: ['count'],
        record: true,
      });
    }
  });

  it('T10d an object without an id is skipped, never an anchor', () => {
    const { id: _, ...noId } = video();
    expect(easyPlan(slideOf([...many(300), noId as unknown as ImageObject]))).toMatchObject({
      anchors: [],
      why: ['count'],
      record: true,
    });
  });

  it('T11 reads the drawn content (F6): the imported objects of a slide set to show its picture are not counted', () => {
    const s = referenceSlide(400);
    // The difference of D7 as an assertion: stored, the slide is over 64 KiB and has 405 objects, drawn it has two.
    expect(jsonBytes(s)).toBeGreaterThan(SIZE_BUDGETS.slideMax);
    expect(pictureUnits(s).why).toEqual(['bytes']);
    const plan = easyPlan(s);
    expect(plan).toMatchObject({ eligible: true, anchors: [], why: [], record: false });
    expect(plan.counts.objects).toBe(2);
    expect(plan.counts.bytes).toBeLessThan(SIZE_BUDGETS.slideMax);
    // The control: the operator's own playing picture on that slide IS an anchor.
    const own = referenceSlide(400);
    own.objects = own.objects.map((o) =>
      o.id === 'mine-o' && o.type === 'image' ? { ...o, play: { mediaId: 'c' } } : o,
    );
    expect(easyPlan(own).anchors).toEqual([{ id: 'mine-o', kind: 'play' }]);
  });

  it('T12 a page-picture slide counts its objects as pictureUnits does', () => {
    const found = CONTENT_CASES.find((c) => c.name.startsWith('picture class (page picture'));
    expect(found).toBeDefined();
    const s = structuredClone(found!.slide);
    expect(easyPlan(s).counts).toEqual(pictureUnits(s).counts);
    expect(easyPlan(s).counts.objects).toBe(1);
  });

  it("T13 `size` is the writer's measure of the stored form; a bad answer falls back to the JSON size", () => {
    const s = slideOfBytes(40_000);
    expect(easyPlan(s).why).toEqual([]);
    expect(easyPlan(s, { size: () => 70_000 })).toMatchObject({ why: ['bytes'], counts: { bytes: 70_000 } });
    const bad: [string, (s: Slide) => number][] = [
      ['NaN', () => Number.NaN],
      ['negative', () => -1],
      ['infinite', () => Number.POSITIVE_INFINITY],
      [
        'throwing',
        () => {
          throw new Error('no measure');
        },
      ],
    ];
    for (const [, size] of bad)
      expect(easyPlan(s, { size })).toMatchObject({ why: [], counts: { bytes: 40_000 } });
    // The measure is given the slide as drawn and without its record (the writer measures what it would store).
    const seen: Slide[] = [];
    easyPlan(referenceSlide(2), {
      size: (x) => {
        seen.push(x);
        return 1;
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prerender).toBeUndefined();
    expect(seen[0]!.objects.map((o) => o.id)).toEqual(['mine-o', 'added']);
  });

  it('T14 the gate: with it on an anchored slide is eligible, its anchors still listed; off is the default', () => {
    const s = slideOf([...many(250), video(), ...many(49, 250)]);
    expect(easyPlan(s, { anchored: true })).toMatchObject({
      eligible: true,
      record: true,
      why: ['count'],
      anchors: [{ id: 'video', kind: 'play' }],
    });
    expect(PRERENDER_ANCHORED).toBe(false);
    expect(easyPlan(s)).toEqual(easyPlan(s, { anchored: PRERENDER_ANCHORED }));
    expect(easyPlan(s, { anchored: false }).eligible).toBe(false);
  });

  it("T15 parity: on an anchor-free, record-free slide the counts and bounds are pictureUnits'", () => {
    const arb = fc
      .record({
        rects: fc.integer({ min: 0, max: 260 }),
        pics: fc.integer({ min: 0, max: 20 }),
        texts: fc.integer({ min: 0, max: 6 }),
        chars: fc.integer({ min: 0, max: 12_000 }),
        runs: fc.integer({ min: 0, max: 70 }),
        fams: fc.integer({ min: 1, max: 20 }),
      })
      .map((g) =>
        slideOf([
          ...many(g.rects),
          ...Array.from({ length: g.pics }, (_, i) => picture(`p${i}`, `m${i}`)),
          ...Array.from({ length: g.texts }, (_, i) =>
            text(`t${i}`, 'x'.repeat(g.chars), undefined, {
              runs: Array.from({ length: g.runs }, (_, k) => ({
                start: k,
                end: k + 1,
                sizeScale: 1 + k / 100,
                fontFamily: `F${k % g.fams}`,
              })),
            }),
          ),
        ]),
      );
    fc.assert(
      fc.property(arb, (s) => {
        const plan = easyPlan(s);
        const base = pictureUnits(s);
        expect(plan.counts).toEqual(base.counts);
        expect(plan.over).toEqual(base.over);
        // The reasons are cut down to what a picture can fix: bytes, and count only for objects and pictures.
        expect(plan.why).toEqual([
          ...(base.over.includes('bytes') ? ['bytes'] : []),
          ...(base.over.includes('objects') || base.over.includes('pictures') ? ['count'] : []),
        ]);
      }),
      { numRuns: 200 },
    );
  });

  it('T16 never throws: junk, cycles and BigInt give a plan, a cyclic slide the zero counts and no record', () => {
    const junk = fc.anything({
      withBigInt: true,
      withBoxedValues: true,
      withNullPrototype: true,
      withSparseArray: true,
    });
    const objectLike = fc.oneof(
      junk,
      fc.record(
        {
          id: junk,
          type: fc.oneof(fc.constantFrom('text', 'image', 'shape'), junk),
          play: junk,
          paras: junk,
          runs: junk,
          text: junk,
          mediaId: junk,
          box: junk,
          style: junk,
        },
        { requiredKeys: [] },
      ),
    );
    const slideLike = fc.oneof(
      junk,
      fc.record(
        {
          id: junk,
          objects: fc.oneof(junk, fc.array(objectLike, { maxLength: 8 })),
          lyricObjectId: junk,
          backgroundMediaId: junk,
          pptx: junk,
          imported: junk,
          prerender: junk,
        },
        { requiredKeys: [] },
      ),
    );
    const opts = fc.record(
      {
        kind: fc.constantFrom('song', 'slides', 'loop', undefined),
        isMotion: fc.constantFrom(
          undefined,
          () => true,
          () => false,
          () => undefined,
          () => {
            throw new Error('x');
          },
        ),
        size: fc.constantFrom(
          undefined,
          () => 1,
          () => Number.NaN,
          () => {
            throw new Error('x');
          },
        ),
        lyric: fc.constantFrom('song', 'any', undefined),
        anchored: fc.boolean(),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(slideLike, opts, (s, o) => {
        const plan = easyPlan(s as unknown as Slide, o as EasyOptions);
        expect(typeof plan.eligible).toBe('boolean');
        expect(typeof plan.record).toBe('boolean');
        expect(Array.isArray(plan.anchors)).toBe(true);
        expect(Array.isArray(plan.why)).toBe(true);
        expect(Array.isArray(plan.over)).toBe(true);
        expect(Object.keys(plan.counts).sort()).toEqual([
          'bytes',
          'characters',
          'families',
          'objects',
          'pictures',
          'sizeScales',
        ]);
      }),
      { numRuns: 400 },
    );
    const cyclic = slideOf(many(300));
    (cyclic as unknown as Record<string, unknown>).self = cyclic;
    expect(easyPlan(cyclic)).toMatchObject({
      record: false,
      why: [],
      counts: { objects: 0, pictures: 0, bytes: 0, characters: 0, families: 0, sizeScales: 0 },
    });
    // The control: the same slide without the cycle is planned.
    expect(easyPlan(slideOf(many(300)))).toMatchObject({ record: true, why: ['count'] });
    const big = slideOf([...many(300), { ...text('big', 'x'), n: 1n } as unknown as TextObject]);
    expect(easyPlan(big)).toMatchObject({ record: false, why: [] });
    for (const bad of [null, undefined, 3, 'a', [], () => 0])
      expect(easyPlan(bad as unknown as Slide)).toMatchObject({
        eligible: true,
        record: false,
        anchors: [],
        why: [],
      });
  });

  it('T17 does not mutate its input', () => {
    const s = deepFreeze(
      slideOf([...many(250), video(), ...many(60, 250)], { backgroundMediaId: 'm', lyricObjectId: 'r1' }),
    );
    const before = canonicalJson(s);
    const plan = easyPlan(s, { kind: 'song', isMotion: () => false, size: () => 70_000, anchored: true });
    // It read the slide (the lyric box and the playing picture, in drawn order) and changed nothing.
    expect(plan.anchors).toEqual([
      { id: 'r1', kind: 'lyric' },
      { id: 'video', kind: 'play' },
    ]);
    expect(plan).toMatchObject({ eligible: true, record: true, why: ['bytes', 'count'] });
    expect(canonicalJson(s)).toBe(before);
    const ref = deepFreeze(referenceSlide(5));
    expect(easyPlan(ref).counts.objects).toBe(2);
    expect(Object.isFrozen(ref)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// planRecord

const FILE = 'f'.repeat(64);
const pptxOf = (extra: Partial<NonNullable<Slide['pptx']>> = {}): NonNullable<Slide['pptx']> => ({
  fileId: FILE,
  index: 0,
  shown: 0,
  class: 'native',
  version: 1,
  ...extra,
});
const withRecord = (s: Slide, prerender: Slide['prerender']): Slide => ({ ...s, prerender });
/** A slide with more than 200 shapes and nothing that moves: the one that gets a record. */
const heavy = (): Slide => crowdedSlide(201);

describe('planRecord: add, refresh or remove the record (design/29 §1.1, Q24.b)', () => {
  it('T19 adds the record: a new object that shares the objects and changes nothing else', () => {
    const s = heavy();
    const before = canonicalJson(s);
    const out = planRecord(s);
    expect(out).not.toBe(s);
    expect(out.prerender).toEqual({ why: ['count'], live: [] });
    expect(out.objects).toBe(s.objects);
    expect({ ...out, prerender: undefined }).toEqual({ ...s, prerender: undefined });
    expect(canonicalJson(s)).toBe(before);
  });

  it('T20 returns the same object when nothing changes (callers compare by identity)', () => {
    const once = planRecord(heavy());
    expect(once.prerender).toBeDefined();
    expect(planRecord(once)).toBe(once);
    const plain = plainSlide();
    expect(planRecord(plain)).toBe(plain);
    // A slide that already carries exactly the right record, built by the schema.
    const parsed = Slide.parse({ ...crowdedSlide(300), prerender: { why: ['count'], live: [] } });
    expect(planRecord(parsed)).toBe(parsed);
  });

  it('T21 refreshes the reasons', () => {
    const count = { why: ['count' as const], live: [] };
    // The slide now also needs bytes: 300 shapes and a stored size past 64 KiB.
    const both = slideOf([
      ...many(300),
      ...Array.from({ length: 8 }, (_, i) => text(`t${i}`, 'x'.repeat(9_000))),
    ]);
    expect(planRecord(withRecord(both, count)).prerender?.why).toEqual(['bytes', 'count']);
    // Only bytes now: nine objects, past 64 KiB.
    const bytes = slideOfBytes(70_000);
    expect(planRecord(withRecord(bytes, count)).prerender?.why).toEqual(['bytes']);
  });

  it('T22 removes the record of a slide that shrank or gained an anchor; a background picture keeps it', () => {
    const rec = { why: ['count' as const], live: [] };
    const shrank = withRecord(plainSlide(), rec);
    const out = planRecord(shrank);
    expect('prerender' in out).toBe(false);
    expect(out.objects).toBe(shrank.objects);
    // An anchor: a playing picture, a hidden paragraph, a background video.
    const playing = withRecord(slideOf([...many(300), video()]), rec);
    const stepped = withRecord(
      slideOf([
        ...many(300),
        text('steps', 'a\nb', box(0, 0, 100, 100), { paras: [null, { hidden: true }] }),
      ]),
      rec,
    );
    const moving = withRecord(slideOf(many(300), { backgroundMediaId: 'm' }), rec);
    for (const s of [playing, stepped]) expect('prerender' in planRecord(s)).toBe(false);
    expect('prerender' in planRecord(moving, { isMotion: () => true })).toBe(false);
    // A background picture is no anchor: the record stays, and a heavy slide gets one.
    expect(planRecord(moving, { isMotion: () => false })).toBe(moving);
    const still = slideOf(many(300), { backgroundMediaId: 'm' });
    expect(planRecord(still, { isMotion: () => false }).prerender).toEqual({ why: ['count'], live: [] });
  });

  it("T23 never touches a record that is not this release's", () => {
    const objects = many(300);
    const records: [string, Slide['prerender']][] = [
      ['a slide file', { why: ['bytes'], file: { ref: 'a'.repeat(64), bytes: 1000 }, live: [] }],
      ['uses', { why: ['count'], live: [], uses: { media: [], files: [], fonts: [] } }],
      ['tail', { why: ['tail'], live: [] }],
      ['tail with bytes', { why: ['bytes', 'tail'], live: [] }],
      ['chosen', { why: ['chosen'], live: [] }],
      ['a live set while the gate is off', { why: ['count'], live: ['r1'] }],
    ];
    for (const [, rec] of records)
      for (const s of [slideOf(objects, { prerender: rec }), withRecord(plainSlide(), rec)])
        expect(planRecord(s)).toBe(s);
    // With the gate on, a record with a live set is this release's again and is refreshed to the live set.
    const withLive = slideOf([video(), ...many(300)], { prerender: { why: ['count'], live: ['stale'] } });
    expect(planRecord(withLive, { anchored: true }).prerender).toEqual({
      why: ['count'],
      live: liveSet(withLive),
    });
  });

  it('T24 the gate writes and refreshes the live set; with it off the same slide gets no record', () => {
    const s = slideOf([...many(250), video(), ...many(49, 250)]);
    const on = planRecord(s, { anchored: true });
    expect(on.prerender?.why).toEqual(['count']);
    expect(on.prerender?.live).toEqual(liveSet(s));
    expect(on.prerender?.live).toContain('video');
    // Moving the video changes what lies above it: the live set is computed again.
    const moved = {
      ...on,
      objects: on.objects.map((o) => (o.id === 'video' ? { ...o, box: box(1500, 800, 200, 100) } : o)),
    };
    const again = planRecord(moved, { anchored: true });
    expect(again.prerender?.live).toEqual(liveSet(moved));
    expect(again.prerender?.live).not.toEqual(on.prerender?.live);
    expect(planRecord(s)).toBe(s);
  });

  it('T25 the options reach the plan: kind, size and isMotion act as in easyPlan', () => {
    const lyric = crowdedSlide(300);
    expect(planRecord(lyric, { kind: 'song' })).toBe(lyric);
    expect(planRecord(lyric, { kind: 'slides' }).prerender?.why).toEqual(['count']);
    // `size` is the writer's measure of the stored form.
    const bytes = slideOfBytes(40_000);
    expect(planRecord(bytes)).toBe(bytes);
    expect(planRecord(bytes, { size: () => 70_000 }).prerender?.why).toEqual(['bytes']);
    const bg = slideOf(many(300), { backgroundMediaId: 'm' });
    expect(planRecord(bg)).toBe(bg);
    expect(planRecord(bg, { isMotion: () => false }).prerender?.why).toEqual(['count']);
  });

  it('T27 does not mutate its input: a recursively frozen slide goes in, a different object only when something changed', () => {
    const s = deepFreeze(heavy());
    const out = planRecord(s);
    expect(out).not.toBe(s);
    expect(s.prerender).toBeUndefined();
    const frozenOnce = deepFreeze(out);
    expect(planRecord(frozenOnce)).toBe(frozenOnce);
    const plain = deepFreeze(plainSlide());
    expect(planRecord(plain)).toBe(plain);
    const stale = deepFreeze(withRecord(plainSlide(), { why: ['count'], live: [] }));
    expect('prerender' in planRecord(stale)).toBe(false);
    expect(stale.prerender).toEqual({ why: ['count'], live: [] });
  });

  it('T28 older builds (0.8.x and 0.5.0) strip the record and draw every object', () => {
    const out = planRecord(crowdedSlide(300));
    expect(out.prerender).toBeDefined();
    for (const old of [prev, prev05]) {
      const r = old.Slide.safeParse(out);
      expect(r.success).toBe(true);
      const parsed = r.data as unknown as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('prerender');
      expect((parsed.objects as unknown[]).length).toBe(out.objects.length);
      expect(parsed.lyricObjectId).toBe('lyric');
    }
  });

  it('T29 a slide the slide file refused is not ours: no later save, re-import or follow-up gives it a record', () => {
    expect(PRERENDER_REFUSED_MISSING).toBe('slide:too-large');
    const refused = slideOf(many(300), { pptx: pptxOf({ missing: ['chart', PRERENDER_REFUSED_MISSING] }) });
    expect(planRecord(refused)).toBe(refused);
    // The entry as the only difference: the same slide without it gets its record.
    const without = slideOf(many(300), { pptx: pptxOf({ missing: ['chart'] }) });
    expect(planRecord(without).prerender).toEqual({ why: ['count'], live: [] });
    // A stale record on a refused slide is left alone too.
    const stale = withRecord(refused, { why: ['count'], live: [] });
    expect(planRecord(stale)).toBe(stale);
  });

  it('T30 a draft of 1,357 and of 20,000 objects is planned: count, a record, no throw, size honoured, no mutation', () => {
    for (const n of [1_357, 20_000]) {
      const s = deepFreeze(slideOf(many(n)));
      const out = planRecord(s, { size: () => 1_000 });
      expect(out.prerender).toEqual({ why: ['count'], live: [] });
      expect(out.objects).toBe(s.objects);
      // Without the writer's measure the JSON size of the draft is read: past 64 KiB it is `bytes` too.
      expect(planRecord(s).prerender?.why).toEqual(['bytes', 'count']);
      expect(easyPlan(s).counts.objects).toBe(n);
    }
  });
});

describe('planRecord: the property suite (idempotent, ours only, valid, the plan never changes)', () => {
  const SLIDE_MAX = SIZE_BUDGETS.slideMax;
  type Case = {
    rects: number;
    pics: number;
    anchor: 'none' | 'play' | 'steps' | 'lyric' | 'background';
    reference: boolean;
    bytes: number | undefined;
    record: 'none' | 'ours' | 'file' | 'uses' | 'live' | 'chosen' | 'tail' | 'junk' | 'refused';
    why: ('bytes' | 'count')[];
    kind: 'song' | 'slides' | 'loop' | undefined;
    motion: boolean | undefined;
    lyric: 'song' | 'any' | undefined;
    anchored: boolean;
  };
  const arb: fc.Arbitrary<Case> = fc.record({
    rects: fc.integer({ min: 0, max: 260 }),
    pics: fc.integer({ min: 0, max: 20 }),
    anchor: fc.constantFrom('none', 'play', 'steps', 'lyric', 'background'),
    reference: fc.boolean(),
    bytes: fc.constantFrom(
      undefined,
      20_000,
      SLIDE_MAX - 60,
      SLIDE_MAX - 1,
      SLIDE_MAX,
      SLIDE_MAX + 1,
      SLIDE_MAX + 60,
      90_000,
    ),
    record: fc.constantFrom('none', 'ours', 'file', 'uses', 'live', 'chosen', 'tail', 'junk', 'refused'),
    why: fc.constantFrom<('bytes' | 'count')[]>(['bytes'], ['count'], ['bytes', 'count'], []),
    kind: fc.constantFrom('song', 'slides', 'loop', undefined),
    motion: fc.constantFrom(true, false, undefined),
    lyric: fc.constantFrom('song', 'any', undefined),
    anchored: fc.boolean(),
  });

  /** The rule of ours, written again here as the oracle. */
  const isOurs = (pre: unknown, gateOn: boolean): boolean => {
    if (pre === undefined) return true;
    if (!pre || typeof pre !== 'object') return false;
    const r = pre as { why?: unknown; live?: unknown; file?: unknown; uses?: unknown };
    if (!Array.isArray(r.why) || !Array.isArray(r.live) || r.file !== undefined || r.uses !== undefined)
      return false;
    return r.why.every((w) => w === 'bytes' || w === 'count') && (r.live.length === 0 || gateOn);
  };

  function build(c: Case): { slide: Slide; opts: EasyOptions } {
    const objects: Slide['objects'] = [
      ...many(c.rects).map((r, i) =>
        c.reference && i % 3 === 0 ? ({ ...r, origin: { src: 'pptx', role: 'shape' } } as ShapeObject) : r,
      ),
      ...Array.from({ length: c.pics }, (_, i) => picture(`p${i}`, `m${i}`)),
    ];
    const extra: Partial<Slide> = {};
    if (c.anchor === 'play') objects.splice(Math.floor(objects.length / 2), 0, video());
    if (c.anchor === 'steps')
      objects.push(text('steps', 'a\nb', box(0, 0, 100, 100), { paras: [null, { hidden: true }] }));
    if (c.anchor === 'lyric') {
      objects.push(text('lyric', 'Amazing grace'));
      extra.lyricObjectId = 'lyric';
    }
    if (c.anchor === 'background') extra.backgroundMediaId = 'bgm';
    if (c.reference) extra.pptx = pptxOf({ show: 'picture', refMediaId: 'ref' });
    if (c.record === 'refused')
      extra.pptx = pptxOf({ ...(extra.pptx ?? {}), missing: [PRERENDER_REFUSED_MISSING] });
    if (c.bytes !== undefined) {
      // Pad with boxes of at most 9,000 characters to land the stored size at `bytes` (plus the record, if any).
      const room = c.bytes - jsonBytes(slideOf(objects, extra)) - 60;
      for (let n = 0, left = room; left > 200; n++, left -= 9_300)
        objects.push(text(`pad${n}`, 'p'.repeat(Math.max(1, Math.min(9_000, left - 200)))));
    }
    const records: Record<Case['record'], Slide['prerender']> = {
      none: undefined,
      refused: undefined,
      ours: { why: c.why, live: [] },
      live: { why: c.why, live: ['r1'] },
      file: { why: ['bytes'], file: { ref: 'a'.repeat(64), bytes: 9 }, live: [] },
      uses: { why: ['count'], live: [], uses: { media: [], files: [], fonts: [] } },
      chosen: { why: ['chosen'], live: [] },
      tail: { why: ['tail', ...c.why], live: [] },
      junk: { why: ['count'] } as unknown as Slide['prerender'],
    };
    const slide: Slide = {
      id: 's',
      objects,
      ...extra,
      ...(records[c.record] ? { prerender: records[c.record] } : {}),
    };
    const opts: EasyOptions = {
      kind: c.kind,
      lyric: c.lyric,
      anchored: c.anchored,
      ...(c.motion === undefined ? {} : { isMotion: () => c.motion }),
    };
    return { slide, opts };
  }

  it('T26 over generated slides: (a) idempotent, (b) not ours comes back untouched, (c) valid, (d) the record never changes the plan, (e) only `prerender` differs, (f) never throws', () => {
    fc.assert(
      fc.property(arb, (c) => {
        const { slide, opts } = build(c);
        const gateOn = opts.anchored === true;
        const out = planRecord(slide, opts);
        // (a)
        expect(planRecord(out, opts)).toBe(out);
        // (b)
        const refused = (slide.pptx?.missing ?? []).includes(PRERENDER_REFUSED_MISSING);
        if (refused || !isOurs(slide.prerender, gateOn)) expect(out).toBe(slide);
        // (c)
        // A record planRecord wrote parses (a record it left alone, a damaged one included, is not its to judge).
        if (out !== slide && out.prerender)
          expect(SlidePrerender.safeParse(out.prerender).success).toBe(true);
        if (Slide.safeParse(slide).success) expect(Slide.safeParse(out).success).toBe(true);
        // (d)
        expect(easyPlan(out, opts)).toEqual(easyPlan(slide, opts));
        // (e)
        expect(out.objects).toBe(slide.objects);
        expect({ ...out, prerender: undefined }).toEqual({ ...slide, prerender: undefined });
        // The record written is the plan's.
        const plan = easyPlan(slide, opts);
        if (!refused && isOurs(slide.prerender, gateOn))
          expect(out.prerender?.why).toEqual(plan.record ? plan.why : undefined);
      }),
      { numRuns: 400 },
    );
  });

  it('T26f never throws on junk slides and options', () => {
    fc.assert(
      fc.property(fc.anything({ withBigInt: true, withNullPrototype: true }), (junk) => {
        expect(() => planRecord(junk as unknown as Slide)).not.toThrow();
        const s = { id: 's', objects: many(300), prerender: junk } as unknown as Slide;
        expect(() => planRecord(s)).not.toThrow();
        expect(() => planRecord(s, junk as unknown as EasyOptions)).not.toThrow();
      }),
      { numRuns: 300 },
    );
    // A slide that cannot be measured (a cycle) is left as it is; the same slide without the cycle is planned.
    const cyclic = slideOf(many(300));
    (cyclic as unknown as Record<string, unknown>).self = cyclic;
    expect(planRecord(cyclic)).toBe(cyclic);
    expect(planRecord(slideOf(many(300))).prerender).toEqual({ why: ['count'], live: [] });
  });
});
