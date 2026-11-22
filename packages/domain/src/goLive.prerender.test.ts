import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERAL, DEFAULT_LOOKS, DEFAULT_LYRIC_STYLE } from './defaults.ts';
import {
  DEGRADED_MAX,
  degradedKind,
  GOLIVE_GEOM_FILES_MAX,
  type GoLiveInputs,
  localDigest,
  type PrerenderRow,
  resolvePlaylist,
} from './goLive.ts';
import { ResolvedPlaylist } from './live.ts';
import { type FileRef, type Media, type Presentation, type Slide, Slide as SlideSchema } from './schemas.ts';
import type { SlideFileHead } from './slidefile.ts';
import { GOLIVE_SLOW_BYTES, resolvedBytes } from './size.ts';
import { GOLIVE_SLIDE_PAGES } from './goLive.ts';

/*
 * design/29 §1.7: goLive lists each pre-rendered slide's picture rows and the service's key set, puts slide heads
 * and pages and what they use into `files` in cue order from the first cue, marks what cannot be listed, and the
 * offline resolve (the operator PC, no file index) lists slide pages and shape files from the stand-ins.
 */

const h = (c: string) => c.repeat(64).slice(0, 64);
const HEAD = h('1');
const PAGE_A = h('2');
const PAGE_B = h('3');
const SHAPE = h('4');
const PIC_4K = h('5');
const PIC_1080 = h('6');
const KEY = h('7');
const OLD_KEY = h('8');
const GEOM = h('9');

const fileRef = (hash: string, bytes = 100): FileRef => ({
  hash,
  bytes,
  mime: 'application/json',
  path: `media/${hash.slice(0, 2)}/${hash}.json`,
});

const media = (id: string, state: Media['state'] = 'ready'): Media =>
  ({
    id,
    name: `Media ${id}`,
    kind: 'image',
    state,
    original: { hash: h(id.slice(-1) === 'x' ? 'e' : 'f'), bytes: 10, mime: 'image/png', path: 'x' },
    tags: [],
  }) as unknown as Media;

/** A pre-rendered slide's stand-in: its lyric box live, its full form in the head HEAD. */
function standIn(id: string, extra: Partial<Slide> = {}): Slide {
  return SlideSchema.parse({
    id,
    objects: [
      {
        id: `${id}-lyric`,
        type: 'text',
        box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        text: 'Lyric',
        style: DEFAULT_LYRIC_STYLE,
      },
    ],
    lyricObjectId: `${id}-lyric`,
    prerender: {
      why: ['count'],
      file: { ref: HEAD, bytes: 500 },
      live: [`${id}-lyric`],
      uses: { media: ['photo'], files: [SHAPE], fonts: ['Carlito'] },
    },
    ...extra,
  });
}

/** An ordinary slide drawing a geometry file. */
function geomSlide(id: string, ref = GEOM): Slide {
  return SlideSchema.parse({
    id,
    objects: [
      {
        id: `${id}-s`,
        type: 'shape',
        box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
        shape: 'rect',
        geom: { ref },
      },
    ],
  });
}

function pres(id: string, title: string, slides: Slide[]): Presentation {
  return {
    id,
    rev: 1,
    title,
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: `${id}-s`, label: 'Slides', short: 'S', slides }],
    arrangements: [],
    archived: false,
  } as Presentation;
}

const HEADS: Record<string, SlideFileHead> = { [HEAD]: { v: 1, pages: [PAGE_A, PAGE_B], count: 700 } };
const FILES = new Map([HEAD, PAGE_A, PAGE_B, SHAPE, GEOM, PIC_4K, PIC_1080].map((x) => [x, fileRef(x)]));

function inputs(presentations: Presentation[], over: Partial<GoLiveInputs> = {}): GoLiveInputs {
  const byId = new Map(presentations.map((p) => [p.id, p]));
  return {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: presentations.map((p, i) => ({ id: `i${i}`, kind: 'presentation', presentationId: p.id })),
    },
    presentation: (id) => byId.get(id),
    media: (id) => (id === 'photo' ? media('photo') : undefined),
    fonts: () => [
      {
        id: 'f',
        family: 'Carlito',
        weight: 400,
        style: 'normal',
        source: 'bundled',
        file: { ...fileRef(h('c')), mime: 'font/ttf' },
      },
    ],
    looks: DEFAULT_LOOKS,
    general: DEFAULT_GENERAL,
    file: (x) => FILES.get(x),
    slideHead: (ref) => HEADS[ref],
    ...over,
  };
}
const go = (
  i: GoLiveInputs,
  opts: { prerenderOn?: boolean; pictures?: boolean; slidePages?: boolean } = {},
) => resolvePlaylist(i, 'pl', { digest: localDigest, ...opts });

const rows = (slideId: string): PrerenderRow[] => [
  { slideId, key: KEY, size: 3840, file: fileRef(PIC_4K, 9_000_000) },
  { slideId, key: KEY, size: 1920, file: fileRef(PIC_1080, 2_000_000) },
];

describe('goLive: pre-rendered slides (design/29 §1.7)', () => {
  it('lists the picture rows of the key set and carries the key set, and parses as a resolved playlist', () => {
    const p = pres('p', 'Big deck', [standIn('a'), geomSlide('b')]);
    const r = go(
      inputs([p], {
        prerenders: () => [...rows('a'), { slideId: 'gone', key: KEY, size: 3840, file: fileRef(PIC_4K) }],
        prerenderKeys: () => [KEY],
      }),
    );
    expect(r.prerenders).toEqual([
      { presentationId: 'p', slideId: 'a', key: KEY, size: 3840, file: PIC_4K },
      { presentationId: 'p', slideId: 'a', key: KEY, size: 1920, file: PIC_1080 },
    ]);
    expect(r.prerenderKeys).toEqual([KEY]);
    // A stand-by row (a picture made before a font upload or an update) is listed and marked, W39.
    const r2 = go(
      inputs([p], {
        prerenders: () => [
          { slideId: 'a', key: OLD_KEY, size: 3840, file: fileRef(PIC_4K), standby: true },
          { slideId: 'a', key: OLD_KEY, size: 1920, file: fileRef(PIC_1080) },
        ],
        prerenderKeys: () => [KEY],
      }),
    );
    expect(r2.prerenders).toEqual([
      { presentationId: 'p', slideId: 'a', key: OLD_KEY, size: 3840, file: PIC_4K, standby: true },
    ]);
    expect(ResolvedPlaylist.safeParse(r).success).toBe(true);
  });

  // CHANGED EXPECTATION (store-2 step 3b, SU6): the pages of a slide file are listed only while GOLIVE_SLIDE_PAGES is on (it is
  // off: no screen reads a page). This case keeps today's expectation (pages listed) with the option on; the next one pins the new rule.
  it('puts pictures, the head, its pages and the shape files it uses into files in cue order (the pages listed: slidePages on)', () => {
    const first = pres('first', 'First', [geomSlide('g1')]);
    const big = pres('big', 'Big deck', [standIn('a')]);
    const r = go(inputs([first, big], { prerenders: () => rows('a'), prerenderKeys: () => [KEY] }), {
      slidePages: true,
    });
    const hashes = r.files.map((f) => f.hash);
    const listed = [GEOM, PIC_4K, PIC_1080, HEAD, PAGE_A, PAGE_B, SHAPE];
    expect(hashes.filter((x) => listed.includes(x))).toEqual(listed);
    // The fonts and media the slide file uses come too: Carlito's face, the photo (optional, like a reference
    // picture).
    expect(hashes).toContain(h('c'));
    expect(Object.keys(r.media)).toContain('photo');
    // The live process serves every one of them from the bundle while the library is down.
    expect(r.geoms?.map((g) => g.hash)).toEqual(listed);
    expect(r.degraded).toBeUndefined();
  });

  it('lists no slide pages while GOLIVE_SLIDE_PAGES is off, and everything else as before (SU6)', () => {
    expect(GOLIVE_SLIDE_PAGES).toBe(false);
    const first = pres('first', 'First', [geomSlide('g1')]);
    const big = pres('big', 'Big deck', [standIn('a')]);
    const i = () => inputs([first, big], { prerenders: () => rows('a'), prerenderKeys: () => [KEY] });
    const r = go(i());
    expect(
      r.files
        .map((f) => f.hash)
        .filter((x) => [GEOM, PIC_4K, PIC_1080, HEAD, SHAPE, PAGE_A, PAGE_B].includes(x)),
    ).toEqual([GEOM, PIC_4K, PIC_1080, HEAD, SHAPE]);
    expect(r.geoms?.map((g) => g.hash)).toEqual([GEOM, PIC_4K, PIC_1080, HEAD, SHAPE]);
    expect(r.degraded).toBeUndefined();
    // the same service with the pages on lists exactly those two more, between the head and the shape file
    const on = go(i(), { slidePages: true });
    expect(on.files.map((f) => f.hash).filter((x) => [PAGE_A, PAGE_B].includes(x))).toEqual([PAGE_A, PAGE_B]);
    expect(on.files.length).toBe(r.files.length + 2);
  });

  it('notes a missing use instead of refusing the service', () => {
    const p = pres('p', 'Big deck', [standIn('a')]);
    const r = go(inputs([p], { media: (id) => (id === 'photo' ? media('photo', 'failed') : undefined) }));
    expect(Object.keys(r.media)).not.toContain('photo');
    const lost = go(inputs([p], { file: (x) => (x === SHAPE ? undefined : FILES.get(x)) }));
    const reasons = [...(r.degraded ?? []), ...(lost.degraded ?? [])].map((d) => d.reason);
    expect(reasons).toHaveLength(2);
    expect(degradedKind(reasons[0]!)).toBe('media');
    expect(reasons[1]).toMatch(/shape outline/);
  });

  it('marks a missing slide file once per presentation (W40), and pictures not ready while the switch is on', () => {
    const p = pres('p', 'Sunday deck', [standIn('a'), standIn('b'), geomSlide('c')]);
    const r = go(inputs([p], { file: (x) => (x === HEAD ? undefined : FILES.get(x)) }));
    const lines = (r.degraded ?? []).map((d) => d.reason);
    expect(lines).toEqual([
      "2 slides of 'Sunday deck' are missing their full copy on the hub, so the screens show a simplified version (their text and pictures only).",
    ]);
    expect(degradedKind(lines[0]!)).toBe('slideFile');
    const one = go(
      inputs([pres('q', 'Q', [geomSlide('x'), standIn('a')])], {
        file: (x) => (x === HEAD ? undefined : FILES.get(x)),
      }),
    );
    expect(one.degraded?.map((d) => d.reason)).toEqual([
      "Slide 2 of 'Q' is missing its full copy on the hub, so the screens show a simplified version (its text and pictures only).",
    ]);
    expect(one.degraded?.[0]?.slideId).toBe('a');
    // Pictures: a line only while the switch is on (the screens draw every slide live while it is off).
    const pics = inputs([p], { prerenders: () => rows('a'), prerenderKeys: () => [KEY] });
    expect(go(pics).degraded).toBeUndefined();
    const on = go(pics, { prerenderOn: true }).degraded?.map((d) => d.reason) ?? [];
    expect(on).toEqual([
      '1 slide of "Sunday deck" has no picture yet. Until a picture is ready, the screens draw the slide themselves, so it may appear a moment late.',
    ]);
    expect(degradedKind(on[0]!)).toBe('picture');
  });

  it('says so past the file cap (W60) instead of leaving the rest out silently', () => {
    // 21 slides of 1,000 shapes, each with a geometry file of its own: 21,000 files past the 20,000 listed.
    const slides: Slide[] = [];
    const files = new Map<string, FileRef>();
    let n = 0;
    for (let s = 0; s < 21; s++) {
      const objects = [];
      for (let o = 0; o < 1000; o++) {
        const ref = (n++).toString(16).padStart(64, '0');
        files.set(ref, fileRef(ref));
        objects.push({
          id: `o${o}`,
          type: 'shape',
          box: { x: 0, y: 0, w: 1, h: 1, rotation: 0 },
          shape: 'rect',
          opacity: 1,
          radius: 0,
          geom: { ref },
        });
      }
      slides.push({ id: `s${s}`, objects } as Slide);
    }
    const r = go(inputs([pres('p', 'Line art', slides)], { file: (x) => files.get(x) }));
    expect(r.files).toHaveLength(GOLIVE_GEOM_FILES_MAX);
    // 21,000 shapes also pass the GO-lead size (golive-prepare's W59), which follows the cap's line.
    expect(resolvedBytes(r)).toBeGreaterThan(GOLIVE_SLOW_BYTES);
    expect(r.degraded?.map((d) => d.reason)).toEqual([
      'Some slides near the end of this service are shown without their full detail: it has more files than ordo sends at once. Split the playlist into two services.',
      'Going live with this service takes a few seconds on the screens. Go live before the service starts.',
    ]);
    expect(r.degraded?.[0]?.cueIndex).toBe(-1);
    expect(DEGRADED_MAX).toBeGreaterThan(1);
  });

  it('lists the cut lines of a slide not from PowerPoint (Slide.cut)', () => {
    const cut = SlideSchema.parse({
      id: 'c',
      objects: [],
      cut: ['Slide 4: the topmost 3 shapes were left out.'],
    });
    const r = go(inputs([pres('p', 'Song', [cut])]));
    expect(r.degraded).toEqual([
      {
        cueIndex: 0,
        presentationId: 'p',
        slideId: 'c',
        reason: 'Slide 4: the topmost 3 shapes were left out.',
      },
    ]);
  });

  it('lists slide pages and shape files from the stand-ins when resolving offline (no file index)', () => {
    const p = pres('p', 'Big deck', [geomSlide('g'), standIn('a')]);
    // CHANGED EXPECTATION (SU6): with GOLIVE_SLIDE_PAGES off the pages are not listed; the option on is today's list.
    const r = go(inputs([p], { file: undefined }), { slidePages: true });
    expect(r.files.filter((f) => f.mime === 'application/json')).toEqual(
      [GEOM, HEAD, PAGE_A, PAGE_B, SHAPE].map((hash) => ({ hash, bytes: 0, mime: 'application/json' })),
    );
    const none = go(inputs([p], { file: undefined }));
    expect(none.files.filter((f) => f.mime === 'application/json').map((f) => f.hash)).toEqual([
      GEOM,
      HEAD,
      SHAPE,
    ]);
    // Without a head at hand the head is still listed, so the operator's download fetches it.
    const noHead = go(inputs([p], { file: undefined, slideHead: undefined }));
    expect(noHead.files.map((f) => f.hash)).toEqual(expect.arrayContaining([GEOM, HEAD, SHAPE]));
    expect(noHead.files.map((f) => f.hash)).not.toContain(PAGE_A);
    expect(r).not.toHaveProperty('geoms');
    expect(r.degraded).toBeUndefined();
  });
});

describe('goLive: a hub that keeps no pictures (ResolveOptions.pictures: false, store-2 PS7)', () => {
  const withPics = () =>
    inputs([pres('p', 'Big deck', [standIn('a'), geomSlide('b')])], {
      prerenders: () => rows('a'),
      prerenderKeys: () => [KEY],
    });

  it('lists no rows, no key set and no picture line, even with the switch on', () => {
    const r = go(withPics(), { pictures: false, prerenderOn: true });
    expect(r.prerenders).toBeUndefined();
    expect(r.prerenderKeys).toBeUndefined();
    expect((r.degraded ?? []).map((d) => degradedKind(d.reason))).not.toContain('picture');
    // the files the pictures would have added are not in the manifest either
    expect(r.files.map((f) => f.hash)).not.toContain(PIC_4K);
    expect(r.files.map((f) => f.hash)).not.toContain(PIC_1080);
    expect(ResolvedPlaylist.safeParse(r).success).toBe(true);
  });

  it('is only an explicit false: not given, or true, is as before', () => {
    for (const opts of [{}, { pictures: true }, { pictures: undefined }]) {
      const r = go(withPics(), { ...opts, prerenderOn: true });
      expect(r.prerenderKeys).toEqual([KEY]);
      expect(r.prerenders?.length).toBe(2);
    }
    // without prerenderOn the picture line is off, rows are listed (the 0.10.0 hub)
    const r = go(withPics());
    expect(r.prerenders?.length).toBe(2);
    expect(r.degraded).toBeUndefined();
  });

  it('keeps everything else of the service: the slides, the head and its pages, the shape files', () => {
    const on = go(withPics(), { prerenderOn: true });
    const off = go(withPics(), { pictures: false, prerenderOn: true });
    const keep = (r: ReturnType<typeof go>) =>
      r.files.map((f) => f.hash).filter((h) => h !== PIC_4K && h !== PIC_1080);
    expect(keep(off)).toEqual(keep(on));
  });
});
