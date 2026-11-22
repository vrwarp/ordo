/**
 * The bake plan (apps/operator/src/services/bakePlan.ts): what a computer wants to make, as a pure function of the
 * library and the hub's listing (design/29 section 1.4). No timers, no store, no network. The domain's own functions
 * (`pictureSource`, `prerenderKey`, `easyPlan`, `planRecord`) are the oracle: the plan calls them, never reimplements.
 */
import {
  DEFAULT_LYRIC_STYLE,
  type Font,
  type Media,
  type Playlist,
  type Presentation,
  type ShapeObject,
  type Slide,
  type TextObject,
} from '@ordo/domain';
import { easyPlan, pictureSource, planRecord, prerenderKey } from '@ordo/domain/prerender.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  BAKE_ATTEMPTS,
  BAKE_TRANSIENT_BACKOFF_MS,
  BAKE_UNKNOWN_BACKOFF_MS,
  BAKE_UPLOAD_ORDER,
} from '../src/services/bakeConsts.ts';
import {
  type BakeItem,
  classify,
  type Listing,
  localKey,
  missingPictures,
  orderPresentations,
  type PlanDeps,
  type PlanInput,
  planSweep,
  planSweepSteps,
  recordSlides,
  retryDelay,
  slideInputs,
  wantedItems,
} from '../src/services/bakePlan.ts';
import { describeFailure } from '../src/state/bake.ts';

// ---- fixtures ----

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });
const file = (hash: string, mime: string) => ({ hash, bytes: 10, mime, path: `files/${hash}` });

function rect(id: string, b = box(0, 0, 10, 10)): ShapeObject {
  return {
    id,
    type: 'shape',
    box: b,
    shape: 'rect',
    fill: { r: 200, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
  } as ShapeObject;
}
function text(id: string, t: string, fontFamily = 'Inter'): TextObject {
  return {
    id,
    type: 'text',
    box: box(0, 0, 400, 100),
    text: t,
    style: { ...DEFAULT_LYRIC_STYLE, fontFamily },
    opacity: 1,
  };
}
const image = (id: string, mediaId: string, extra: object = {}) =>
  ({
    id,
    type: 'image',
    box: box(0, 0, 100, 100),
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
    ...extra,
  }) as Slide['objects'][number];

/** A heavy slide: `n` rects, a text box and a picture, with the record the import writes. */
function heavy(id: string, n = 300, extra: Partial<Slide> = {}): Slide {
  return {
    id,
    objects: [
      ...Array.from({ length: n }, (_, i) =>
        rect(`r${i}`, box((i % 40) * 40, Math.floor(i / 40) * 40, 30, 30)),
      ),
      text('title', `Welcome ${id}`),
      image('pic', 'photo'),
    ],
    prerender: { why: ['count'], live: [] },
    ...extra,
  };
}
const plain = (id: string): Slide => ({ id, objects: [rect('a'), text('t', 'Hello')] });

const media = (id: string, m: Partial<Media>): Media => ({
  id,
  rev: 1,
  name: id,
  tags: [],
  kind: 'image',
  original: file(`${id}-orig`, 'image/png'),
  state: 'ready',
  loop: false,
  isBackground: false,
  ...m,
});
const photo = media('photo', {});
const clip = media('clip', {
  kind: 'video',
  original: file('clip-orig', 'video/quicktime'),
  delivery: file('clip-mp4', 'video/mp4'),
  poster: file('clip-jpg', 'image/jpeg'),
});
const raw = media('raw', { kind: 'video', original: file('raw-orig', 'video/mp4') });
const MEDIA: Media[] = [photo, clip, raw];
const FONTS = [
  { family: 'Inter', file: file('inter-regular', 'font/ttf') },
  { family: 'Liberation Sans', file: file('liberation-regular', 'font/ttf') },
] as unknown as Font[];

function deck(id: string, slides: Slide[], over: Partial<Presentation> = {}): Presentation {
  return {
    id,
    rev: 1,
    title: id,
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: `${id}-s`, name: 'Main', slides }],
    arrangements: [],
    archived: false,
    updatedAt: '2026-11-20T10:00:00Z',
    ...over,
  } as unknown as Presentation;
}

const inputs = () => slideInputs({ media: MEDIA, fonts: FONTS });
const ALL = [...BAKE_UPLOAD_ORDER];

function listing(rows: Partial<Listing['keys'][number]>[] = [], failures: Listing['failures'] = []): Listing {
  return {
    keys: rows.map((r, i) => ({ slideId: `s${i}`, key: `k${i}`, standbyId: `b${i}`, sizes: [], ...r })),
    failures,
    budget: { usedBytes: 0, limitBytes: 1 << 30 },
  };
}

// ---- P1 records ----

describe('record slides (P1)', () => {
  it('lists the slides that have a record, in section and slide order', () => {
    const p = deck('p', [heavy('a'), plain('b'), heavy('c')]);
    p.sections.push({
      id: 'two',
      name: 'Two',
      slides: [heavy('d')],
    } as unknown as Presentation['sections'][number]);
    expect(recordSlides(p).map((s) => s.id)).toEqual(['a', 'c', 'd']);
    expect(recordSlides(deck('q', [plain('x')]))).toEqual([]);
  });

  it('does not throw on a presentation whose sections, slides or records are not what they should be', () => {
    const hostile = [
      { id: 'h1', sections: 'nope' },
      { id: 'h2', sections: [null, 4, { slides: 'x' }, { slides: [null, 5, { id: 's', prerender: 3 }] }] },
      { id: 'h3' },
      null,
      undefined,
    ] as unknown as Presentation[];
    for (const h of hostile) expect(recordSlides(h)).toEqual([]);
  });
});

// ---- P2, P3 keys and inputs ----

describe('the local key (P2) and its inputs (P3)', () => {
  it('equals the domain key of the slide, its record live set and the inputs', () => {
    const s = heavy('s');
    const want = prerenderKey(pictureSource(s, [], inputs()));
    expect(localKey(s, inputs())).toBe(want);
    expect(want).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores ids, origins and locks, and follows the text, a drawn picture file and the slide font chain only', () => {
    const base = heavy('s');
    const k = localKey(base, inputs());
    const renamed: Slide = {
      ...base,
      objects: base.objects.map((o, i) => ({
        ...o,
        id: `new${i}`,
        locked: i % 2 === 0,
        origin: { src: 'pptx', role: 'shape' },
      })),
    } as Slide;
    expect(localKey(renamed, inputs())).toBe(k);
    // an edit of the text changes it
    const edited: Slide = {
      ...base,
      objects: base.objects.map((o) => (o.type === 'text' ? { ...o, text: 'Welcome all' } : o)),
    };
    expect(localKey(edited, inputs())).not.toBe(k);
    // a replaced picture file (the library's media row) changes it
    const replaced = slideInputs({
      media: [{ ...photo, original: file('photo-new', 'image/png') }, clip, raw],
      fonts: FONTS,
    });
    expect(localKey(base, replaced)).not.toBe(k);
    // a face added to a family of the slide's chain changes it, a face of an unrelated family does not
    const withFace = slideInputs({
      media: MEDIA,
      fonts: [...FONTS, { family: 'Inter', file: file('inter-bold', 'font/ttf') }] as unknown as Font[],
    });
    expect(localKey(base, withFace)).not.toBe(k);
    const unrelated = slideInputs({
      media: MEDIA,
      fonts: [...FONTS, { family: 'Unrelated Display', file: file('ud', 'font/ttf') }] as unknown as Font[],
    });
    expect(localKey(base, unrelated)).toBe(k);
  });

  it('a slide with a background picture or video: the key follows what the domain hashes (notes the cost if it does hash it)', () => {
    const base = heavy('s');
    const withBg: Slide = { ...base, backgroundMediaId: 'photo' };
    const other: Slide = { ...base, backgroundMediaId: 'clip' };
    // the own background is a layer of its own and not part of the picture (Q25.c.b): when only it changes the key does not
    expect(localKey(withBg, inputs())).toBe(localKey(other, inputs()));
    expect(localKey(withBg, inputs())).toBe(localKey(base, inputs()));
  });

  it('slideInputs: the still of an image, the poster of a video, nothing for a media the library lacks', () => {
    const i = inputs();
    expect(i.mediaFile('photo')).toBe('photo-orig');
    expect(i.mediaFile('clip')).toBe('clip-jpg');
    expect(i.mediaFile('raw')).toBeUndefined();
    expect(i.mediaFile('nope')).toBeUndefined();
    expect(i.kindOf('photo')).toBe('image');
    expect(i.kindOf('clip')).toBe('video');
    expect(i.kindOf('nope')).toBeUndefined();
    expect(i.fonts).toEqual([
      { family: 'Inter', file: { hash: 'inter-regular' } },
      { family: 'Liberation Sans', file: { hash: 'liberation-regular' } },
    ]);
    // a media the library lacks is null in the key's media map, as the hub's is
    const s = heavy('s', 250, { objects: [rect('a'), image('x', 'nope')] as Slide['objects'] });
    expect(pictureSource(s, [], i).media).toEqual({ nope: null });
  });
});

// ---- P4 classify, P5 pending ----

describe('classify: the hub listing against the local key (P4, P5)', () => {
  const s = heavy('s1');

  it('a key the hub does not list is queued, waiting for the hub to know it; no listing at all is the same, never failed', () => {
    expect(
      classify({ slide: s, key: 'k', listing: listing([{ slideId: 's1', key: 'other' }]) }),
    ).toMatchObject({
      state: 'queued',
      waiting: 'hub-key',
    });
    expect(classify({ slide: s, key: 'k', listing: undefined })).toMatchObject({
      state: 'queued',
      waiting: 'hub-key',
      sizes: [],
      missingSizes: ALL,
    });
  });

  it('1920 first, never a size the hub already holds; a key with 1920 and 3840 is ready without its 640', () => {
    const at = (sizes: number[]) =>
      classify({ slide: s, key: 'k', listing: listing([{ slideId: 's1', key: 'k', sizes }]) });
    expect(at([])).toMatchObject({ state: 'queued', missingSizes: [1920, 3840, 640] });
    expect(at([1920])).toMatchObject({ state: 'queued', missingSizes: [3840, 640] });
    expect(at([1920, 640])).toMatchObject({ state: 'queued', missingSizes: [3840] });
    expect(at([1920, 3840])).toMatchObject({ state: 'ready', missingSizes: [], sizes: [1920, 3840] });
    expect(at([640, 1920, 3840])).toMatchObject({ state: 'ready', missingSizes: [] });
  });

  it('a recorded failure without both sizes is failed with its parse; with both sizes the picture wins', () => {
    const failures = [{ key: 'k', reason: 'font: Foo Sans', madeBy: 'operator 0.10.0 operate Linux', at: 7 }];
    const failed = classify({
      slide: s,
      key: 'k',
      listing: listing([{ slideId: 's1', key: 'k' }], failures),
    });
    expect(failed).toMatchObject({ state: 'failed', code: 'font', fix: 'fix', reason: 'font: Foo Sans' });
    expect(describeFailure(failed.reason ?? '').code).toBe('font');
    const odd = classify({
      slide: s,
      key: 'k',
      listing: listing([{ slideId: 's1', key: 'k' }], [{ key: 'k', reason: 'what is this', at: 1 }]),
    });
    expect(odd).toMatchObject({ state: 'failed', code: 'unknown', fix: 'again' });
    // someone made it since
    const both = classify({
      slide: s,
      key: 'k',
      listing: listing([{ slideId: 's1', key: 'k', sizes: [1920, 3840] }], failures),
    });
    expect(both.state).toBe('ready');
    // a failure on ANOTHER key is not this key's
    expect(
      classify({
        slide: s,
        key: 'k',
        listing: listing([{ slideId: 's1', key: 'k' }], [{ key: 'z', reason: 'time', at: 1 }]),
      }),
    ).toMatchObject({ state: 'queued', missingSizes: ALL });
  });

  it('P5 a slide waiting for the LibreOffice follow-up is queued, waiting for it, and never an item', () => {
    const waiting: Slide = { ...s, pptx: { pending: true } } as unknown as Slide;
    const p = deck('p', [waiting]);
    const plan = planSweep({
      presentations: [p],
      library: { media: MEDIA, fonts: FONTS },
      listings: { p: listing([{ slideId: 's1', key: localKey(waiting, inputs()), sizes: [] }]) },
    });
    expect(plan.items).toEqual([]);
    expect(plan.statuses).toEqual([
      expect.objectContaining({ slideId: 's1', state: 'queued', waiting: 'pending' }),
    ]);
    expect(plan.needListing).toEqual([]);
  });
});

// ---- P6 eligibility ----

describe('eligibility: the baker is a caller of the plan like the writers (P6, P6b, H-W2)', () => {
  const deps = (over: Partial<PlanDeps> = {}): PlanDeps => ({
    easy: vi.fn(easyPlan),
    record: vi.fn(planRecord),
    ...over,
  });
  const run = (slides: Slide[], d: PlanDeps, extra: Partial<PlanInput> = {}) => {
    const p = deck('p', slides, { kind: 'slides' });
    const l = listing(slides.map((s) => ({ slideId: s.id, key: localKey(s, inputs()), sizes: [] })));
    return planSweep(
      { presentations: [p], library: { media: MEDIA, fonts: FONTS }, listings: { p: l }, ...extra },
      d,
    );
  };

  it('asks both functions, with isMotion and the presentation kind, and follows both ways', () => {
    const d = deps();
    const plan = run([heavy('a'), heavy('b', 300, { backgroundMediaId: 'clip' })], d);
    expect(plan.items.map((i) => i.slideId)).toEqual(['a']);
    expect(plan.statuses.find((s) => s.slideId === 'b')).toMatchObject({
      state: 'none',
      reason: 'not-eligible',
    });
    for (const m of [d.easy, d.record] as unknown as ReturnType<typeof vi.fn>[])
      for (const [, opts] of m.mock.calls) {
        expect(typeof opts.isMotion).toBe('function');
        expect(opts.kind).toBe('slides');
      }
    expect((d.easy as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a stubbed easyPlan that says "not eligible" skips the slide, a stubbed planRecord that drops the record too', () => {
    const noAnchor = run([heavy('a')], deps({ easy: () => ({ ...easyPlan(heavy('a')), eligible: false }) }));
    expect(noAnchor.items).toEqual([]);
    expect(noAnchor.statuses[0]).toMatchObject({ state: 'none', reason: 'not-eligible' });
    const dropped = run(
      [heavy('a')],
      deps({
        record: (s) => {
          const { prerender: _, ...rest } = s;
          return rest as Slide;
        },
      }),
    );
    expect(dropped.items).toEqual([]);
    expect(dropped.statuses[0]).toMatchObject({ state: 'none', reason: 'not-eligible' });
    // the plan that keeps or refreshes the record: made
    const kept = run(
      [heavy('a')],
      deps({ record: (s) => ({ ...s, prerender: { why: ['bytes', 'count'], live: [] } }) }),
    );
    expect(kept.items).toHaveLength(1);
  });

  it('a slide that gained a playing picture is skipped even though its record is still there', () => {
    const moving = heavy('m');
    moving.objects = [...moving.objects, image('v', 'clip', { play: { mediaId: 'clip' } })];
    const plan = run([moving], deps());
    expect(plan.items).toEqual([]);
    expect(plan.statuses[0]).toMatchObject({ state: 'none', reason: 'not-eligible' });
  });

  it('P6b only a video is a moving background: a picture is made, a video is not, an unknown media is not', () => {
    const plan = run(
      [
        heavy('pic', 300, { backgroundMediaId: 'photo' }),
        heavy('vid', 300, { backgroundMediaId: 'clip' }),
        heavy('unk', 300, { backgroundMediaId: 'gone' }),
      ],
      deps(),
    );
    expect(plan.items.map((i) => i.slideId)).toEqual(['pic']);
    expect(plan.statuses.filter((s) => s.state === 'none').map((s) => s.slideId)).toEqual(['vid', 'unk']);
    // the plan returns the same slide for the picture background
    expect(
      planRecord(heavy('pic', 300, { backgroundMediaId: 'photo' }), {
        isMotion: (id) => inputs().kindOf(id) === 'video',
      }),
    ).toMatchObject({
      prerender: { why: ['count'], live: [] },
    });
  });

  it('a changed media list changes the verdict (the cache keys on it)', () => {
    const cache = new Map();
    const s = heavy('s', 300, { backgroundMediaId: 'clip' });
    const p = deck('p', [s]);
    const l = { p: listing([{ slideId: 's', key: localKey(s, inputs()), sizes: [] }]) };
    const asVideo = planSweep({
      presentations: [p],
      library: { media: MEDIA, fonts: FONTS },
      listings: l,
      cache,
    });
    expect(asVideo.items).toEqual([]);
    const asPicture = planSweep({
      presentations: [p],
      library: { media: [photo, { ...clip, kind: 'image' }, raw], fonts: FONTS },
      listings: l,
      cache,
    });
    expect(asPicture.items).toHaveLength(1);
  });
});

// ---- P7 live, P8 item ----

describe('the item (P7, P8)', () => {
  it('P7 the record live set reaches the item and the key (H-W1)', () => {
    const s = heavy('s', 300, { prerender: { why: ['count'], live: ['title'] } });
    const key = prerenderKey(pictureSource(s, ['title'], inputs()));
    expect(key).not.toBe(prerenderKey(pictureSource(s, [], inputs())));
    const plan = planSweep({
      presentations: [deck('p', [s])],
      library: { media: MEDIA, fonts: FONTS },
      listings: { p: listing([{ slideId: 's', key, sizes: [] }]) },
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ live: ['title'], key });
    // a plan that passed [] would look the key up under the wrong id and find nothing
    expect(plan.statuses[0]?.waiting).toBeUndefined();
  });

  it('P8 the item names the slide, its key, the sizes to upload, the slide and the still of each drawn picture', () => {
    const s = heavy('s');
    const key = localKey(s, inputs());
    const [item] = planSweep({
      presentations: [deck('p', [s])],
      library: { media: MEDIA, fonts: FONTS },
      listings: { p: listing([{ slideId: 's', key, sizes: [1920] }]) },
    }).items as BakeItem[];
    expect(item).toMatchObject({
      kind: 'slide',
      presentationId: 'p',
      slideId: 's',
      key,
      live: [],
      missingSizes: [3840, 640],
      images: { photo: 'photo-orig' },
    });
    expect(item?.slide).toBe(s);
    expect(item?.file).toBeUndefined();
  });

  it('a video drawn as a picture is made from its poster', () => {
    const s = heavy('s', 300);
    s.objects = [...s.objects.filter((o) => o.type !== 'image'), image('v', 'clip')];
    const [item] = planSweep({
      presentations: [deck('p', [s])],
      library: { media: MEDIA, fonts: FONTS },
      listings: { p: listing([{ slideId: 's', key: localKey(s, inputs()), sizes: [] }]) },
    }).items;
    expect(item?.images).toEqual({ clip: 'clip-jpg' });
  });
});

// ---- P9 order ----

describe('the order presentations are made in (P9)', () => {
  const ps = [
    deck('old', [], { updatedAt: '2026-01-01T00:00:00Z' }),
    deck('new', [], { updatedAt: '2026-11-01T00:00:00Z' }),
    deck('mid', [], { updatedAt: '2026-06-01T00:00:00Z' }),
    deck('tie-b', [], { updatedAt: '2026-06-01T00:00:00Z' }),
    deck('tie-a', [], { updatedAt: '2026-06-01T00:00:00Z' }),
  ];
  const list = (focus: Parameters<typeof orderPresentations>[1]) =>
    orderPresentations(ps, focus).map((p) => p.id);
  const playlist = {
    id: 'pl',
    items: [
      { id: 'i1', kind: 'presentation', presentationId: 'mid' },
      { id: 'i2', kind: 'media', mediaId: 'm' },
      { id: 'i3', kind: 'presentation', presentationId: 'old' },
      { id: 'i4', kind: 'presentation', presentationId: 'mid' },
    ],
  } as unknown as Playlist;

  it('newest first, then by id, with nothing named', () => {
    expect(list({})).toEqual(['new', 'mid', 'tie-a', 'tie-b', 'old']);
  });

  it('the focus playlist first in its item order, then the open one, then the rest', () => {
    expect(list({ focus: { playlistId: 'pl' }, playlists: [playlist], openId: 'new' })).toEqual([
      'mid',
      'old',
      'new',
      'tie-a',
      'tie-b',
    ]);
    expect(list({ openId: 'tie-b' })).toEqual(['tie-b', 'new', 'mid', 'tie-a', 'old']);
    expect(list({ focus: { presentationId: 'old' } })).toEqual(['old', 'new', 'mid', 'tie-a', 'tie-b']);
  });

  it('a focus naming a missing playlist changes nothing; the order is stable', () => {
    expect(list({ focus: { playlistId: 'gone' }, playlists: [playlist] })).toEqual(list({}));
    expect(list({ openId: 'ghost' })).toEqual(list({}));
    expect(list({ focus: { playlistId: 'pl' }, playlists: [playlist] })).toEqual(
      list({ focus: { playlistId: 'pl' }, playlists: [playlist] }),
    );
  });
});

// ---- P10 backoff ----

describe('retries (P10)', () => {
  it('an unknown key is looked up again after 2, 5, 15, 60 and 120 s, then not again', () => {
    expect([...BAKE_UNKNOWN_BACKOFF_MS]).toEqual([2000, 5000, 15000, 60000, 120000]);
    const seen = [0, 1, 2, 3, 4, 5, 6].map((n) => retryDelay('unknown', n));
    expect(seen).toEqual([2000, 5000, 15000, 60000, 120000, undefined, undefined]);
  });

  it('a transient cause is tried after 10 s then 60 s, then it is posted (the third failure); a permanent one never', () => {
    expect([...BAKE_TRANSIENT_BACKOFF_MS]).toEqual([10000, 60000]);
    expect(BAKE_ATTEMPTS).toBe(3);
    expect([0, 1, 2, 3].map((n) => retryDelay('transient', n))).toEqual([10000, 60000, undefined, undefined]);
    expect([0, 1, 5].map((n) => retryDelay('permanent', n))).toEqual([undefined, undefined, undefined]);
    expect(retryDelay('unknown', -1)).toBeUndefined();
    expect(retryDelay('unknown', Number.NaN)).toBeUndefined();
  });
});

// ---- P11, P12 sweeps and the cache ----

describe('a sweep (P11, P12)', () => {
  const many = (n: number, prefix = 'p'): Presentation[] =>
    Array.from({ length: n }, (_, i) => deck(`${prefix}${i}`, [heavy(`${prefix}${i}-s`, 250)]));

  it('a library with no record is an empty plan and wants no listing', () => {
    const plan = planSweep({
      presentations: [deck('a', [plain('x')]), deck('b', [])],
      library: { media: MEDIA, fonts: FONTS },
      listings: {},
    });
    expect(plan).toEqual({ statuses: [], items: [], needListing: [] });
  });

  it('names the presentations that have records and no listing, and plans the others', () => {
    const a = deck('a', [heavy('a1')]);
    const b = deck('b', [heavy('b1')]);
    const plan = planSweep({
      presentations: [a, b],
      library: { media: MEDIA, fonts: FONTS },
      listings: { b: listing([{ slideId: 'b1', key: localKey(heavy('b1'), inputs()), sizes: [] }]) },
    });
    expect(plan.needListing).toEqual(['a']);
    expect(plan.items.map((i) => i.slideId)).toEqual(['b1']);
    expect(plan.statuses.find((s) => s.slideId === 'a1')).toMatchObject({
      state: 'queued',
      waiting: 'hub-key',
    });
  });

  it('a second call with the same inputs computes no key; a changed media or font list recomputes every presentation; a changed rev only that one', () => {
    const keyOf = vi.fn(localKey);
    const deps: PlanDeps = { keyOf };
    const cache = new Map();
    const ps = many(3);
    const lib = { media: MEDIA, fonts: FONTS };
    const run = (presentations: Presentation[], library = lib) =>
      planSweep({ presentations, library, listings: {}, cache }, deps);
    run(ps);
    expect(keyOf).toHaveBeenCalledTimes(3);
    keyOf.mockClear();
    run(ps);
    expect(keyOf).toHaveBeenCalledTimes(0);
    run(ps, { media: [...MEDIA], fonts: FONTS });
    expect(keyOf).toHaveBeenCalledTimes(3);
    keyOf.mockClear();
    run(ps, { media: [...MEDIA], fonts: [...FONTS] });
    expect(keyOf).toHaveBeenCalledTimes(3);
    // the lists stay the same now; only one presentation's object (and rev) changes: only it recomputes
    keyOf.mockClear();
    const lib2 = { media: [...MEDIA], fonts: [...FONTS] };
    run(ps, lib2);
    expect(keyOf).toHaveBeenCalledTimes(3);
    keyOf.mockClear();
    const edited = [ps[0] as Presentation, { ...(ps[1] as Presentation), rev: 2 }, ps[2] as Presentation];
    run(edited, lib2);
    expect(keyOf).toHaveBeenCalledTimes(1);
  });

  it('forgets a presentation that left the library', () => {
    const cache = new Map();
    const ps = many(2);
    planSweep({ presentations: ps, library: { media: MEDIA, fonts: FONTS }, listings: {}, cache });
    expect(cache.size).toBe(2);
    planSweep({
      presentations: [ps[0] as Presentation],
      library: { media: MEDIA, fonts: FONTS },
      listings: {},
      cache,
    });
    expect(cache.size).toBe(1);
  });

  it('P12 the sliced plan yields at least 20 times over 2,000 record slides, in slices of at most 8 ms, and ends with the same plan', () => {
    const big = deck(
      'big',
      Array.from({ length: 2000 }, (_, i) => heavy(`s${i}`, 1)),
    );
    let t = 0;
    const deps: PlanDeps = {
      now: () => (t += 1),
      keyOf: (s) => `key-${s.id}`,
      easy: () => ({
        eligible: true,
        record: true,
        anchors: [],
        why: ['count'],
        over: [],
        counts: {} as never,
      }),
      record: (s) => s,
    };
    const input: PlanInput = { presentations: [big], library: { media: MEDIA, fonts: FONTS }, listings: {} };
    const gen = planSweepSteps(input, deps);
    let yields = 0;
    let last: IteratorResult<void, ReturnType<typeof planSweep>>;
    for (;;) {
      last = gen.next();
      if (last.done) break;
      yields++;
    }
    expect(yields).toBeGreaterThanOrEqual(20);
    expect(yields).toBeLessThanOrEqual(2000);
    t = 0;
    expect(last.value).toEqual(planSweep(input, deps));
    expect((last.value as ReturnType<typeof planSweep>).statuses).toHaveLength(2000);
  });
});

// ---- P13 missing ----

describe('missingPictures (P13, C-BW2: unknown is not missing)', () => {
  it('lists the record slides with no picture and no recorded failure; with no listing it lists none and carries them as unknown', () => {
    const a = heavy('a');
    const b = heavy('b');
    const c = heavy('c');
    const d = heavy('d');
    const p = deck('p', [a, b, c, d, plain('e')]);
    const i = inputs();
    const l = listing(
      [
        { slideId: 'a', key: localKey(a, i), sizes: [1920, 3840] },
        { slideId: 'b', key: localKey(b, i), sizes: [] },
        { slideId: 'c', key: localKey(c, i), sizes: [] },
        // d: the hub has no key yet
      ],
      [{ key: localKey(c, i), reason: 'coverage: U+4E2D', at: 1 }],
    );
    const r = missingPictures(p, l, i);
    expect(r.missing.map((s) => s.id)).toEqual(['b']);
    expect(r.unknown.map((s) => s.id)).toEqual(['d']);
    const none = missingPictures(p, undefined, i);
    expect(none.missing).toEqual([]);
    expect(none.unknown.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ---- P14 hostile ----

describe('hostile inputs never throw (P14)', () => {
  it('a slide whose objects are not an array, a malformed record or a key function that throws is a failed slide; the rest is planned', () => {
    const ok = heavy('ok');
    const bad = { id: 'bad', objects: 'nope', prerender: { why: ['count'], live: [] } } as unknown as Slide;
    const boom = heavy('boom');
    const odd = { id: 'odd', objects: [], prerender: 'yes' } as unknown as Slide;
    const keyOf = (s: Slide, inp: Parameters<typeof localKey>[1]) => {
      if (s.id === 'boom') throw new Error('stubbed fault that quotes the slide text Welcome');
      return localKey(s, inp);
    };
    const plan = planSweep(
      {
        presentations: [deck('p', [ok, bad, boom, odd])],
        library: { media: MEDIA, fonts: FONTS },
        listings: { p: listing([{ slideId: 'ok', key: localKey(ok, inputs()), sizes: [] }]) },
      },
      { keyOf },
    );
    expect(plan.items.map((i) => i.slideId)).toEqual(['ok']);
    const failed = plan.statuses.filter((s) => s.state === 'failed');
    expect(failed.map((s) => s.slideId).sort()).toEqual(['boom']);
    expect(failed[0]).toMatchObject({ fix: 'ordo', code: 'unknown' });
    expect(failed[0]?.reason).toMatch(/^key: /);
    expect((failed[0]?.reason ?? '').length).toBeLessThanOrEqual(200);
    // never slide text, not even the words of a fault
    expect(failed[0]?.reason).not.toContain('Welcome');
    // `bad` has no objects to plan with: skipped, not thrown
    expect(plan.statuses.find((s) => s.slideId === 'bad')?.state).not.toBe('ready');
    expect(() =>
      planSweep({
        presentations: [null, undefined, 3] as never,
        library: { media: MEDIA, fonts: FONTS },
        listings: {},
      }),
    ).not.toThrow();
    expect(() =>
      slideInputs({ media: [null, undefined, {}] as never, fonts: [null, { family: 3 }] as never }),
    ).not.toThrow();
  });
});

// ---- P15 to P17: the file form (Q54) ----

describe('a slide kept in a slide file (P15-P17, Q54)', () => {
  const standIn = (id: string): Slide => ({
    id,
    objects: [rect('a'), text('t', 'stand-in')],
    prerender: { why: ['count'], live: [], file: { ref: 'f'.repeat(64), bytes: 120_000 } },
  });

  it('P15 is a file-form item and no key is computed on the main thread, however many there are', () => {
    const keyOf = vi.fn(localKey);
    const slides = Array.from({ length: 20 }, (_, i) => standIn(`f${i}`));
    const p = deck('p', slides);
    expect(recordSlides(p)).toHaveLength(20);
    const plan = planSweep(
      {
        presentations: [p],
        library: { media: MEDIA, fonts: FONTS },
        listings: { p: listing(slides.map((s) => ({ slideId: s.id, key: `hub-${s.id}`, sizes: [] }))) },
      },
      { keyOf },
    );
    expect(keyOf).not.toHaveBeenCalled();
    expect(plan.items).toHaveLength(20);
    expect(plan.items[0]).toMatchObject({
      key: 'hub-f0',
      file: { ref: 'f'.repeat(64), bytes: 120_000, listedKey: 'hub-f0' },
      missingSizes: ALL,
      images: {},
    });
  });

  it('P16 takes the hub-listed key of the slide, the newest first; with no listed key the item is unknown and nothing is made', () => {
    const s = standIn('f');
    const p = deck('p', [s]);
    const run = (l: Listing | undefined) =>
      planSweep({ presentations: [p], library: { media: MEDIA, fonts: FONTS }, listings: { p: l } });
    const two = run(
      listing([
        { slideId: 'f', key: 'newest', sizes: [] },
        { slideId: 'f', key: 'older', sizes: [1920, 3840] },
      ]),
    );
    expect(two.items[0]).toMatchObject({ key: 'newest', file: { listedKey: 'newest' } });
    const none = run(listing([{ slideId: 'other', key: 'x', sizes: [] }]));
    expect(none.items).toEqual([]);
    expect(none.statuses[0]).toMatchObject({ state: 'queued', waiting: 'hub-key' });
    expect(run(undefined).items).toEqual([]);
    expect(run(undefined).needListing).toEqual(['p']);
  });

  it('P17 missingPictures and wantedItems list it exactly like an inline slide', () => {
    const s = standIn('f');
    const inline = heavy('i');
    const p = deck('p', [s, inline]);
    const i = inputs();
    const l = listing([
      { slideId: 'f', key: 'hub-f', sizes: [] },
      { slideId: 'i', key: localKey(inline, i), sizes: [] },
    ]);
    const r = missingPictures(p, l, i);
    expect(r.missing.map((x) => x.id)).toEqual(['f', 'i']);
    expect(wantedItems(p, { inputs: i, listing: l }).items.map((x) => x.slideId)).toEqual(['f', 'i']);
    // ready the same way
    const ready = listing([
      { slideId: 'f', key: 'hub-f', sizes: [1920, 3840] },
      { slideId: 'i', key: localKey(inline, i), sizes: [1920, 3840] },
    ]);
    expect(missingPictures(p, ready, i).missing).toEqual([]);
    expect(wantedItems(p, { inputs: i, listing: ready }).statuses.map((x) => x.state)).toEqual([
      'ready',
      'ready',
    ]);
  });
});
