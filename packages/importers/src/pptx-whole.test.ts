/**
 * Q24.b, the first pre-render release, in the import core: a heavy, eligible slide stays whole (the ladder stops at
 * 'full' or 'grid'), within 2 MiB of such slides a presentation, past it cut to what the screens draw; LibreOffice's
 * page no longer applies to it; and with the option off the ladder and the stored slides are the base's.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_LYRIC_STYLE,
  gridSlide,
  IMPORT_RESERVE_BYTES,
  type ImageObject,
  jsonBytes,
  SIZE_BUDGETS,
  type Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { easyPlan } from '@ordo/domain/prerender.ts';
import type { SlideClass, SlideRef } from '@ordo/pptx-scene';
import { MAX_DRAWN_OBJECTS, MAX_DRAWN_PICTURES } from '@ordo/pptx-scene/budget.ts';
import { MAX_OBJECTS } from '@ordo/pptx-scene/emit.ts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Draft,
  ImportCore,
  keptWholeLine,
  selectWhole,
  WHOLE_BACKGROUND_ANCHORS,
  WHOLE_OBJECTS_MAX,
  WHOLE_SHARE_BYTES,
  WHOLE_WITH_LIBREOFFICE,
  wholeSlidesFor,
} from './pptx-core.ts';
import {
  type LadderInput,
  planLadder,
  provenanceStandIn,
  quickBytes,
  trimToCounts,
  wholeLevel,
} from './pptx-ladder.ts';
import { ImportLog } from './pptx-report.ts';

const KiB = 1024;
const MiB = 1024 * KiB;
const MAX = SIZE_BUDGETS.slideMax;
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });
const oid = (p: string, i: number) => `${p}${i.toString(36).toUpperCase().padStart(25, '0')}`;
const WORDS =
  'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life. ';

/** `n` pictures of `n` different files (about 190 bytes each). */
function pictureObjects(n: number, seed = 0): ImageObject[] {
  return Array.from({ length: n }, (_, k) => ({
    id: oid('P', seed * 100_000 + k),
    type: 'image' as const,
    box: box((k % 50) * 30, Math.floor(k / 50) * 30, 25, 25),
    mediaId: `media-${seed}-${k}`,
    fit: 'stretch' as const,
    opacity: 1,
    radius: 0,
    origin: { src: 'pptx' },
  }));
}
/** `n` plain text boxes of `chars` characters each, with `runs` formatting when asked (what the 'plain' level drops). */
function textObjects(n: number, chars: number, seed = 0, runs = 0): TextObject[] {
  return Array.from({ length: n }, (_, k) => {
    const text = WORDS.repeat(Math.ceil(chars / WORDS.length)).slice(0, chars);
    const step = Math.max(1, Math.floor(chars / Math.max(1, runs)));
    return {
      id: oid('T', seed * 100_000 + k),
      type: 'text' as const,
      box: box(96, 20 + k * 2, 1728, 200),
      text,
      style: DEFAULT_LYRIC_STYLE,
      opacity: 1,
      origin: { src: 'pptx' },
      ...(runs
        ? {
            runs: Array.from({ length: runs }, (_, i) => ({
              start: i * step,
              end: Math.min(chars, i * step + Math.max(1, step - 1)),
              fontWeight: 700 as const,
              color: { r: (i * 37) % 256, g: 200, b: 0, a: 1 },
            })).filter((x) => x.end > x.start),
          }
        : {}),
    };
  });
}
/** `n` plain shapes (the decorations the 'minimal' level leaves out). */
function shapeObjects(n: number, seed = 0): SlideObject[] {
  return Array.from({ length: n }, (_, k) => ({
    id: oid('S', seed * 100_000 + k),
    type: 'shape' as const,
    box: box((k % 80) * 20, Math.floor(k / 80) * 20, 16, 16),
    shape: 'rect' as const,
    fill: { r: (k * 7) % 256, g: 30, b: 60, a: 1 },
    opacity: 1,
    radius: 0,
    origin: { src: 'pptx' },
  }));
}
/** `n` shapes with a traced outline of `points` float points each (a converter's custom geometry: `gridSlide` shortens it). */
function tracedObjects(n: number, points: number, seed = 0): SlideObject[] {
  let a = (seed + 1) >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: n }, (_, k) => {
    const pts: string[] = [];
    for (let i = 0; i < points; i++)
      pts.push(`${i ? 'L' : 'M'} ${(r() * 21_600.123).toFixed(6)} ${(r() * 10_800.456).toFixed(6)}`);
    return {
      id: oid('G', seed * 100_000 + k),
      type: 'shape' as const,
      box: box(100 + k, 100, 600, 300),
      shape: 'rect' as const,
      fill: { r: 10, g: 20, b: 30, a: 1 },
      opacity: 1,
      radius: 0,
      geom: { paths: [{ d: `${pts.join(' ')} Z`, w: 21_600.123, h: 10_800.456 }] },
      origin: { src: 'pptx' },
    };
  });
}
const slideOf = (i: number, objects: SlideObject[], extra: Partial<Slide> = {}): Slide => ({
  id: oid('L', i),
  objects,
  ...extra,
});
/**
 * A slide of about `bytes` stored: text boxes of at most 9,000 characters (the import cuts a box at 10,000, so a longer
 * one would be measured shorter than it is written), `n` of them or as many as the size needs.
 */
function textSlide(i: number, bytes: number, n = 4, runs = 0): Slide {
  const per = (k: number) => Math.floor(bytes / k) - 420 - runs * 60;
  let count = n;
  while (per(count) > 9_000) count++;
  return slideOf(i, textObjects(count, Math.max(10, per(count)), i, runs));
}

const ref = (index: number): SlideRef => ({ index, part: `ppt/slides/slide${index + 1}.xml`, hidden: false });
const draft = (slide: Slide, index: number, extra: Partial<Draft> = {}): Draft => ({
  ref: ref(index),
  slide,
  media: new Map(),
  cls: 'native' as SlideClass,
  notes: [],
  ...extra,
});
type Run = { drafts: Draft[]; core: ImportCore; log: string; warns: [string, string][]; simplified: number };
function budgeted(
  slides: readonly Slide[] | Draft[],
  o: { lo: boolean; whole?: boolean; heavyReserve?: number; reserve?: number },
): Run {
  const log = new ImportLog();
  const warns: [string, string][] = [];
  const core = new ImportCore({
    lo: o.lo,
    log,
    warn: (k, m) => warns.push([k, m]),
    geomFileBytes: 1 << 20,
    ...(o.whole !== undefined ? { whole: o.whole } : {}),
    ...(o.heavyReserve !== undefined ? { heavyReserve: o.heavyReserve } : {}),
    ...(o.reserve !== undefined ? { reserve: o.reserve } : {}),
  } as ConstructorParameters<typeof ImportCore>[0]);
  const drafts = slides.map((s, i) => ('ref' in s ? (s as Draft) : draft(s as Slide, i)));
  const simplified = core.budget(drafts);
  return { drafts, core, log: log.toString(), warns, simplified };
}
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const bytesOf = (s: Slide) => quickBytes(s);

describe('the constants and the one switch (step 3)', () => {
  it('wholeSlidesFor: the hub switch, and on a hub with LibreOffice the constant of Q27', () => {
    expect(WHOLE_WITH_LIBREOFFICE).toBe(true);
    expect(WHOLE_SHARE_BYTES).toBe(2 * MiB);
    expect(WHOLE_OBJECTS_MAX).toBe(1_000);
    expect(WHOLE_BACKGROUND_ANCHORS).toBe('motion');
    expect(wholeSlidesFor({ prerender: true, lo: false })).toBe(true);
    expect(wholeSlidesFor({ prerender: true, lo: true })).toBe(WHOLE_WITH_LIBREOFFICE);
    expect(wholeSlidesFor({ prerender: false, lo: false })).toBe(false);
    expect(wholeSlidesFor({ prerender: false, lo: true })).toBe(false);
  });

  it("the importer's inline bound is the converter's and the schema's", () => {
    expect(WHOLE_OBJECTS_MAX).toBe(MAX_OBJECTS);
    expect(MAX_DRAWN_OBJECTS).toBe(200);
    expect(MAX_DRAWN_PICTURES).toBe(16);
  });
});

describe('the option off is the base (T1)', () => {
  // Thirty decks of synthetic slides (every level of the ladder, the page for size, a presentation tail), planned by
  // the unchanged base: `ImportCore.budget` writes the same slides, notes, missing kinds, log and warnings.
  type Fixture = { name: string; lo: boolean; slides: () => Slide[]; recorded: string };
  const RECORDED = [
    '845d60628a717600',
    '3cad6c3a50e12ab3',
    '7e30fd6e09592f43',
    '2dcfb87285121bfc',
    '08ebd99331563969',
    'a96ff72c22a9e2c1',
    'fb4d478cb21ce465',
    '708417923bf6514f',
    '181ed475feecfea1',
    '1a0f4ab93341ec38',
    'd89b726554c2ccbe',
    '359e79a71c03cf38',
    '3464e39e604a7cbf',
    '845d60628a717600',
    '2e42644153cc832d',
    'c51074eab42eaaf1',
    '8f56918a07f47398',
    '08ebd99331563969',
    'a96ff72c22a9e2c1',
    '0b8f4f4a2cb39e32',
    '708417923bf6514f',
    '181ed475feecfea1',
    '1a0f4ab93341ec38',
    'd89b726554c2ccbe',
    '359e79a71c03cf38',
    '3464e39e604a7cbf',
    '7d80aefd3f1e4f49',
    '84e483c908290a65',
    'd25ed97869cf8c02',
    'd25ed97869cf8c02',
  ];

  const fixtures: Fixture[] = [];
  const add = (name: string, lo: boolean, slides: () => Slide[]) =>
    fixtures.push({ name, lo, slides, recorded: RECORDED[fixtures.length] ?? '' });
  for (const lo of [false, true]) {
    const l = lo ? 'LibreOffice' : 'no LibreOffice';
    add(`one small slide, ${l}`, lo, () => [textSlide(0, 4 * KiB)]);
    add(`a 70 KB formatted slide, ${l}`, lo, () => [slideOf(0, textObjects(6, 500, 1, 150))]);
    add(`a formatted slide of 100 KB, ${l}`, lo, () => [textSlide(0, 100 * KiB, 4, 200)]);
    add(`400 decorations and one text, ${l}`, lo, () => [
      slideOf(0, [...shapeObjects(400), ...textObjects(1, 300)]),
    ]);
    add(`800 pictures, ${l}`, lo, () => [slideOf(0, pictureObjects(800))]);
    add(`300 KB of text, ${l}`, lo, () => [textSlide(0, 300 * KiB, 30)]);
    add(`three kinds of heavy slide in turn, ${l}`, lo, () => [
      textSlide(0, 80 * KiB, 4, 150),
      slideOf(1, [...shapeObjects(300, 1), ...textObjects(2, 400, 1)]),
      slideOf(2, pictureObjects(700, 2)),
    ]);
    add(`600 slides of 12 KB (a tail), ${l}`, lo, () =>
      Array.from({ length: 600 }, (_, i) => textSlide(i, 12 * KiB)),
    );
    add(`450 slides of 20 KB and three heavy ones (a tail), ${l}`, lo, () =>
      Array.from({ length: 450 }, (_, i) =>
        i % 150 === 7 ? textSlide(i, 90 * KiB, 4, 120) : textSlide(i, 20 * KiB),
      ),
    );
    add(`a deck of 40 ordinary slides, ${l}`, lo, () =>
      Array.from({ length: 40 }, (_, i) => textSlide(i, 6 * KiB + i * 100)),
    );
    add(`a slide with a lyric and decorations, ${l}`, lo, () => {
      const objects = [...shapeObjects(250, 3), ...textObjects(3, 600, 3)];
      return [slideOf(0, objects, { lyricObjectId: objects[objects.length - 1]!.id })];
    });
    add(`two slides at the edge of 64 KiB, ${l}`, lo, () => [
      textSlide(0, MAX - 300),
      textSlide(1, MAX + 300),
    ]);
    add(`one slide with one hundred small runs, ${l}`, lo, () => [
      slideOf(0, textObjects(1, 20_000, 4, 400)),
    ]);
  }
  add('an empty deck', false, () => []);
  add('a slide without objects', true, () => [slideOf(0, [])]);
  add('thirty slides with decorations, no LibreOffice', false, () =>
    Array.from({ length: 30 }, (_, i) => slideOf(i, [...shapeObjects(120, i), ...textObjects(2, 200, i)])),
  );
  add('thirty slides with decorations, LibreOffice', true, () =>
    Array.from({ length: 30 }, (_, i) => slideOf(i, [...shapeObjects(120, i), ...textObjects(2, 200, i)])),
  );

  const outcome = (r: Run) => ({
    slides: r.drafts.map((d) => ({
      slide: d.slide,
      cls: d.cls,
      dropped: d.dropped,
      notes: d.notes,
      simplified: d.simplified,
      artText: d.artText,
    })),
    log: r.log,
    warns: r.warns,
    simplified: r.simplified,
  });

  it('has thirty fixtures', () => expect(fixtures.length).toBe(30));

  it.each(fixtures)('$name: planLadder and ImportCore.budget equal the recorded base', (f) => {
    const a = budgeted(f.slides(), { lo: f.lo });
    const b = budgeted(f.slides(), { lo: f.lo, whole: false });
    expect(outcome(b)).toEqual(outcome(a));
    expect(sha(outcome(a))).toBe(f.recorded);
  });

  it('planLadder takes no whole input into account when none is marked', () => {
    const inputs: LadderInput[] = Array.from({ length: 600 }, (_, i) => ({ slide: textSlide(i, 12 * KiB) }));
    const a = planLadder(inputs);
    expect(a.plan.tailFrom).toBeGreaterThan(0);
    expect(planLadder(inputs.map((x) => ({ ...x }))).plan).toEqual(a.plan);
  });
});

describe('a heavy slide stays whole: the ladder stops at full or grid (T2, T3)', () => {
  it.each([false, true])(
    'T2: 800 pictures (about 150 KB), lo %s: all of them, level grid, no simplification, no warning',
    (lo) => {
      const heavy = slideOf(0, pictureObjects(800));
      expect(bytesOf({ ...heavy, pptx: undefined })).toBeGreaterThan(MAX);
      const r = budgeted([heavy], { lo, whole: true });
      const d = r.drafts[0]!;
      expect(d.slide.objects).toHaveLength(800);
      expect(d.simplified).toBeFalsy();
      expect(r.simplified).toBe(0);
      expect(d.cls).toBe('native');
      expect(d.dropped).toBeUndefined();
      expect(d.notes.filter((n) => /simplified|page|budget/.test(n))).toEqual([]);
      expect(r.warns.filter(([k]) => k === 'budget')).toEqual([]);
      expect(r.log).not.toMatch(/simplified|LibreOffice draws its page|keeps them all/);
      // The base's reading of the same slide warns that it keeps them all (control: the option does change something).
      const base = budgeted([slideOf(0, pictureObjects(800))], { lo, whole: false });
      expect(base.warns.filter(([k]) => k === 'budget').length).toBe(1);
    },
  );

  it('T3: a 100 KB formatted text slide is kept whole with its formatting; the base leaves the formatting out', () => {
    const slide = () => textSlide(0, 100 * KiB, 4, 220);
    const formattedCount = (d: Draft) => d.slide.objects.filter((o) => o.type === 'text' && o.runs).length;
    const n = formattedCount(draft(slide(), 0));
    expect(n).toBeGreaterThanOrEqual(4);
    for (const lo of [false, true]) {
      const whole = budgeted([slide()], { lo, whole: true }).drafts[0]!;
      expect(formattedCount(whole), `lo ${lo}`).toBe(n);
      expect(whole.simplified).toBeFalsy();
      expect(whole.cls).toBe('native');
    }
    const base = budgeted([slide()], { lo: false, whole: false }).drafts[0]!;
    expect(formattedCount(base)).toBeLessThan(n);
    expect(base.simplified).toBe(true);
  });

  it('T3: in a deck of 900 ordinary slides the heavy one is whole before or after the 6 MiB mark, and the tail starts where it did', () => {
    const ordinary = (i: number): LadderInput => ({ slide: textSlide(i, 8 * KiB) });
    const alone = planLadder(Array.from({ length: 900 }, (_, i) => ordinary(i)));
    const k = alone.plan.tailFrom;
    expect(k).toBeGreaterThan(100);
    for (const p of [0, 5, k - 1, k + 40, 899]) {
      const inputs: LadderInput[] = Array.from({ length: 900 }, (_, i) => ordinary(i));
      inputs.splice(p, 0, { slide: textSlide(9_000, 100 * KiB, 4, 220), whole: true });
      const { slides, plan } = planLadder(inputs);
      expect(plan.tailFrom, `heavy at ${p}`).toBe(k + (p <= k ? 1 : 0));
      const h = slides[p]!;
      expect(h.tail).toBe(false);
      expect(['full', 'grid']).toContain(h.level);
      expect(h.dropped).toBe(0);
      expect(h.plain).toBe(0);
      expect(plan.reasons[p]).toBeNull();
      expect(plan.compact[p]).toBe(false);
      // The ordinary slides are planned as without it, shifted by the heavy slide's place.
      for (const j of [0, k - 1, k, k + 10, 900]) {
        if (j === p) continue;
        const o = j < p ? j : j - 1;
        expect(slides[j]!.tail, `heavy at ${p}, slide ${j}`).toBe(o >= k);
      }
    }
  });

  it('wholeLevel: full within 64 KiB, else the grid level with nothing left out', () => {
    const small = slideOf(0, textObjects(2, 300));
    expect(wholeLevel(small, MAX, bytesOf)).toMatchObject({ level: 'full', slide: small });
    const big = slideOf(1, pictureObjects(800));
    const r = wholeLevel(big, MAX, bytesOf);
    expect(r.level).toBe('grid');
    expect(r.slide.objects).toHaveLength(800);
    expect(r.bytes).toBeGreaterThan(MAX);
    // The grid level redraws the outlines on the 1/16 px grid (what a slide of line art over 64 KiB shrinks by), and
    // nothing is dropped, however far over the bound it stays.
    const art = slideOf(2, [...tracedObjects(12, 400, 5), ...textObjects(3, 300, 5)]);
    expect(bytesOf(art)).toBeGreaterThan(MAX);
    const g = wholeLevel(art, MAX, bytesOf);
    expect(g.level).toBe('grid');
    expect(g.slide).toEqual(gridSlide(art));
    expect(g.slide).not.toBe(art);
    expect(g.slide.objects).toHaveLength(15);
    expect(g.bytes).toBeLessThan(bytesOf(art));
    const budget = budgeted([slideOf(3, [...tracedObjects(12, 400, 6), ...textObjects(3, 300, 6)])], {
      lo: true,
      whole: true,
    });
    // Over 64 KiB at 'grid' as a slide of this kind stays: a record is written for it later (`bytes`).
    expect(budget.drafts[0]!.slide.objects).toHaveLength(15);
    expect(budget.drafts[0]!.simplified).toBeFalsy();
  });

  it('the heavy bytes are the presentation reserve for the plan of the others, never a reason to tail them early', () => {
    // 80 ordinary slides of 60 KB: 4.7 MB, under the 6 MiB mark. Two whole slides of 900 KB do not push them into the tail.
    const ordinary: LadderInput[] = Array.from({ length: 80 }, (_, i) => ({
      slide: textSlide(i, 60 * KiB, 6),
    }));
    expect(planLadder(ordinary).plan.tailFrom).toBe(-1);
    const heavy: LadderInput[] = [
      { slide: textSlide(9_001, 900 * KiB, 30), whole: true },
      ...ordinary,
      { slide: textSlide(9_002, 900 * KiB, 30), whole: true },
    ];
    const r = planLadder(heavy);
    expect(r.plan.tailFrom).toBe(-1);
    expect(r.slides.every((s) => !s.tail)).toBe(true);
    // ... but the 8 MiB bound counts them: they are not free.
    expect(r.plan.total).toBeGreaterThan(planLadder(ordinary).plan.total + 1.6 * MiB);
    // Where they and the ordinary slides together pass 8 MiB (their text cannot be left out), the others are tailed
    // by the presentation's bound: 100 slides of 60 KB (6.1 MB) alone fit, with 2.4 MB of whole slides they do not.
    const big: LadderInput[] = Array.from({ length: 100 }, (_, i) => ({ slide: textSlide(i, 60 * KiB, 6) }));
    expect(planLadder(big).plan.tailFrom).toBe(-1);
    const crowded = planLadder([
      ...big,
      { slide: textSlide(9_003, 1.2 * MiB, 30), whole: true },
      { slide: textSlide(9_004, 1.2 * MiB, 30), whole: true },
    ]);
    expect(crowded.plan.tailFrom).toBeGreaterThanOrEqual(0);
    expect(crowded.slides.slice(100).every((x) => !x.tail && x.whole === true)).toBe(true);
  });
});

describe('the 2 MiB share (T4)', () => {
  /** A slide of about 600 KB: 400 text boxes of 1,100 characters. */
  const big = (i: number) => slideOf(i, textObjects(400, 1_100, i));

  it('five heavy slides: the first three whole, the next two cut to 200 objects, named, listed, one report line', () => {
    expect(bytesOf(big(0))).toBeGreaterThan(500 * KiB);
    expect(bytesOf(big(0))).toBeLessThan(700 * KiB);
    const r = budgeted([0, 1, 2, 3, 4].map(big), { lo: false, whole: true });
    const [a, b, c, d, e] = r.drafts;
    for (const w of [a, b, c]) {
      expect(w!.slide.objects).toHaveLength(400);
      expect(w!.dropped).toBeUndefined();
      expect(w!.cls).toBe('native');
    }
    for (const cut of [d, e]) {
      expect(cut!.slide.objects.length).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
      expect(cut!.dropped).toContain('element');
      expect(cut!.cls).toBe('hybrid');
      expect(cut!.notes.some((n) => /2 MiB/.test(n))).toBe(true);
    }
    const lines = r.warns.filter(([, m]) => /past the 2 MiB of detailed slides/.test(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toMatch(/^2 slides past the 2 MiB of detailed slides a presentation keeps whole/);
    expect(lines[0]![1]).toMatch(/first 200 shapes/);
    expect(lines[0]![0]).toBe('budget');
  });

  it('with LibreOffice the over-share slide is listed, not given to the art', () => {
    const r = budgeted([0, 1, 2, 3].map(big), { lo: true, whole: true });
    const cut = r.drafts[3]!;
    expect(cut.dropped).toContain('element');
    expect(cut.art).toBeUndefined();
  });

  it('a single slide over the share is cut too; pictures are cut to 16', () => {
    const one = slideOf(0, [...textObjects(400, 6_000), ...pictureObjects(60)]);
    expect(bytesOf(one)).toBeGreaterThan(WHOLE_SHARE_BYTES);
    const r = budgeted([one], { lo: false, whole: true });
    const d = r.drafts[0]!;
    expect(d.slide.objects.length).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
    expect(
      new Set(d.slide.objects.flatMap((o) => (o.type === 'image' ? [o.mediaId] : []))).size,
    ).toBeLessThanOrEqual(MAX_DRAWN_PICTURES);
    expect(d.dropped).toEqual(expect.arrayContaining(['element']));
    expect(r.warns.filter(([, m]) => /past the 2 MiB/.test(m))).toHaveLength(1);
  });

  it('a re-import counts the kept heavy slides against the share (heavyReserve)', () => {
    const three = () => [0, 1, 2].map(big);
    const free = budgeted(three(), { lo: false, whole: true });
    expect(free.drafts.every((d) => d.slide.objects.length === 400)).toBe(true);
    const kept = budgeted(three(), { lo: false, whole: true, heavyReserve: 1.5 * MiB });
    // 0.5 MiB of the share is left: the first heavy slide (about 600 KB) does not fit it either.
    expect(kept.drafts.every((d) => d.slide.objects.length <= MAX_DRAWN_OBJECTS)).toBe(true);
    const some = budgeted(three(), { lo: false, whole: true, heavyReserve: 1.2 * MiB });
    expect(some.drafts[0]!.slide.objects).toHaveLength(400);
    expect(some.drafts[1]!.slide.objects.length).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
  });

  it('nothing is cut with the option off: the base plan (the share is not read)', () => {
    const r = budgeted([0, 1, 2, 3, 4].map(big), { lo: false });
    expect(r.warns.filter(([, m]) => /2 MiB of detailed/.test(m))).toEqual([]);
  });
});

describe('LibreOffice: the page for size no longer applies to a slide kept whole (T5)', () => {
  const formatted70 = () => slideOf(0, textObjects(6, 500, 1, 150));
  const PAGE = /LibreOffice draws its page/;

  it('a 70 KB formatted slide: whole (no picture class) when kept whole; the base gives LibreOffice its page', () => {
    expect(bytesOf(formatted70())).toBeGreaterThan(MAX);
    // The base: with LibreOffice the 'plain' level keeps LibreOffice's page instead.
    const base = budgeted([formatted70()], { lo: true });
    expect(base.drafts[0]!.cls).toBe('picture');
    expect(base.log).toMatch(PAGE);
    // Kept whole: ordo's own shapes, formatting kept, no page.
    const whole = budgeted([formatted70()], { lo: true, whole: true });
    const d = whole.drafts[0]!;
    expect(d.cls).toBe('native');
    expect(d.slide.objects).toHaveLength(6);
    expect(d.slide.objects.every((o) => o.type !== 'text' || o.runs !== undefined)).toBe(true);
    expect(whole.log).not.toMatch(PAGE);
    expect(whole.warns).toEqual([]);
    // Q27.b (the constant false makes `wholeSlidesFor` false, so the importer passes no option): the base.
    expect(wholeSlidesFor({ prerender: true, lo: true })).toBe(WHOLE_WITH_LIBREOFFICE);
    const q27b = budgeted([formatted70()], { lo: true, whole: false });
    expect(q27b.drafts[0]!.cls).toBe('picture');
  });

  it('an anchored slide (a playing video) keeps the base plan: the page for size as before', () => {
    const play: ImageObject = {
      ...pictureObjects(1, 7)[0]!,
      play: { mediaId: 'clip-1', start: 'auto', loop: false, muted: false },
    } as ImageObject;
    const anchored = () => slideOf(0, [...textObjects(6, 500, 1, 150), play]);
    const base = budgeted([anchored()], { lo: true });
    const whole = budgeted([anchored()], { lo: true, whole: true });
    expect(whole.drafts[0]!.cls).toBe(base.drafts[0]!.cls);
    expect(whole.drafts[0]!.slide.objects.map((o) => o.type === 'text' && o.runs !== undefined)).toEqual(
      base.drafts[0]!.slide.objects.map((o) => o.type === 'text' && o.runs !== undefined),
    );
    expect(easyPlan(anchored(), {}).record).toBe(false);
  });
});

describe('trimToCounts (T6)', () => {
  const images = (n: number, distinct: number): ImageObject[] =>
    pictureObjects(n).map((o, i) => ({ ...o, mediaId: `m${i % distinct}` }));

  it('keeps the first 200 objects and 16 distinct pictures from the bottom, and says what it left out', () => {
    const slide = slideOf(0, [...images(50, 30), ...textObjects(300, 20), ...shapeObjects(20)]);
    const r = trimToCounts(slide);
    expect(r.slide.objects.length).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
    const distinct = new Set(r.slide.objects.flatMap((o) => (o.type === 'image' ? [o.mediaId] : [])));
    expect(distinct.size).toBe(MAX_DRAWN_PICTURES);
    expect(r.left).toBe(slide.objects.length - r.slide.objects.length);
    expect(r.kinds).toEqual(expect.arrayContaining(['decoration', 'element']));
    // The bottom ones stay, in order.
    const ids = new Set(r.slide.objects.map((o) => o.id));
    expect(slide.objects.filter((o) => ids.has(o.id)).map((o) => o.id)).toEqual(
      r.slide.objects.map((o) => o.id),
    );
  });

  it('clears a lyric reference that is gone, never throws on junk, and leaves a slide within the counts as it is', () => {
    const objects = [...textObjects(250, 20)];
    const lyric = objects[objects.length - 1]!.id;
    const cut = trimToCounts(slideOf(0, objects, { lyricObjectId: lyric }));
    expect(cut.slide.lyricObjectId).toBeUndefined();
    const keepLyric = trimToCounts(slideOf(0, objects, { lyricObjectId: objects[3]!.id }));
    expect(keepLyric.slide.lyricObjectId).toBe(objects[3]!.id);
    const small = slideOf(1, textObjects(5, 20));
    expect(trimToCounts(small).slide).toBe(small);
    expect(trimToCounts(small).left).toBe(0);
    for (const junk of [null, undefined, {}, { objects: 3 }, { objects: [null, 1, 'x'] }]) {
      expect(() => trimToCounts(junk as unknown as Slide)).not.toThrow();
    }
  });

  it('is a function of the counts: order kept, at most 200 and 16, idempotent (property)', () => {
    const arb = fc.array(
      fc.oneof(
        fc.record({ t: fc.constant('text' as const) }),
        fc.record({ t: fc.constant('shape' as const) }),
        fc.record({ t: fc.constant('image' as const), m: fc.integer({ min: 0, max: 40 }) }),
      ),
      { minLength: 120, maxLength: 600 },
    );
    fc.assert(
      fc.property(arb, (spec) => {
        const objects: SlideObject[] = spec.map((s, i) =>
          s.t === 'text'
            ? textObjects(1, 5, i)[0]!
            : s.t === 'shape'
              ? shapeObjects(1, i)[0]!
              : { ...pictureObjects(1, i)[0]!, mediaId: `m${s.m}` },
        );
        const slide = slideOf(0, objects);
        const r = trimToCounts(slide);
        expect(r.slide.objects.length).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
        const imgs = new Set(r.slide.objects.flatMap((o) => (o.type === 'image' ? [o.mediaId] : [])));
        expect(imgs.size).toBeLessThanOrEqual(MAX_DRAWN_PICTURES);
        // The screens' rule, from the bottom: the first 200 objects that are not a 17th distinct picture.
        const want: SlideObject[] = [];
        const seen = new Set<string>();
        for (const o of objects) {
          if (want.length >= MAX_DRAWN_OBJECTS) break;
          if (o.type === 'image') {
            if (!seen.has(o.mediaId) && seen.size >= MAX_DRAWN_PICTURES) continue;
            seen.add(o.mediaId);
          }
          want.push(o);
        }
        expect(r.slide.objects.map((o) => o.id)).toEqual(want.map((o) => o.id));
        const again = trimToCounts(r.slide);
        expect(again.slide).toBe(r.slide);
        expect(r.left).toBe(objects.length - want.length);
      }),
      { numRuns: 150 },
    );
  });
});

describe('hostile decks (T7)', () => {
  it('100 slides of 1,000 pictures stay within the reserve, the share and what today keeps, inside a time bound', () => {
    const slides = Array.from({ length: 100 }, (_, i) => slideOf(i, pictureObjects(1_000, i)));
    const t0 = performance.now();
    const r = budgeted(slides, { lo: true, whole: true });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(budgetMs(30_000));
    const kept = r.drafts.filter((d) => d.slide.objects.length > MAX_DRAWN_OBJECTS);
    const keptBytes = kept.reduce((n, d) => n + bytesOf(d.slide), 0);
    expect(keptBytes).toBeLessThanOrEqual(WHOLE_SHARE_BYTES);
    expect(kept.length).toBeGreaterThan(5);
    const total = r.drafts.reduce((n, d) => n + bytesOf(d.slide), 0);
    expect(total).toBeLessThanOrEqual(SIZE_BUDGETS.presentationMax - IMPORT_RESERVE_BYTES);
    // Every other slide shows what the screens draw: 200 objects and 16 pictures at most.
    for (const d of r.drafts.filter((x) => !kept.includes(x))) {
      expect(d.slide.objects.length).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
      expect(d.dropped?.length ?? 0).toBeGreaterThan(0);
    }
    process.stdout.write(
      `T7: ${ms.toFixed(0)} ms, ${kept.length} kept whole, total ${(total / MiB).toFixed(2)} MiB\n`,
    );
  });
});

describe('determinism and the tail line (T8, T9)', () => {
  const deck = () => [
    textSlide(0, 100 * KiB, 4, 220),
    ...Array.from({ length: 820 }, (_, i) => textSlide(i + 1, 8 * KiB)),
    slideOf(821, pictureObjects(500, 9)),
  ];

  it('T8: the same drafts give the same decisions', () => {
    const a = budgeted(deck(), { lo: true, whole: true });
    const b = budgeted(deck(), { lo: true, whole: true });
    expect(JSON.stringify(b.drafts.map((d) => [d.slide, d.cls, d.dropped, d.notes]))).toBe(
      JSON.stringify(a.drafts.map((d) => [d.slide, d.cls, d.dropped, d.notes])),
    );
    expect(b.warns).toEqual(a.warns);
  });

  it('T9: the tail line names the first tailed ORDINARY slide, by its place in the deck', () => {
    const alone = budgeted(deck().slice(1, 821), { lo: false, whole: true });
    const aloneLine = alone.warns.find(([, m]) => /the presentation reached its size budget/.test(m))![1];
    const alonePlace = Number(/slide (\d+) and later/.exec(aloneLine)![1]);
    const r = budgeted(deck(), { lo: false, whole: true });
    const line = r.warns.find(([, m]) => /the presentation reached its size budget/.test(m))![1];
    expect(Number(/slide (\d+) and later/.exec(line)![1])).toBe(alonePlace + 1);
    // The heavy slide at the front and the one at the end are whole, the tail is ordinary slides.
    expect(r.drafts[0]!.slide.objects.some((o) => o.type === 'text' && o.runs)).toBe(true);
    expect(jsonBytes(r.drafts[0]!.slide)).toBeGreaterThan(MAX);
  });
});

describe('the record at assemble (step 4)', () => {
  const FILE = 'f'.repeat(64);
  const rec = (sl: Slide) =>
    (sl as Slide & { prerender?: { why: string[]; live: string[]; file?: string } }).prerender;
  /** Slides through the core's budgets and `assemble`, as the hub's job and the client assembly run them. */
  function assembled(
    slides: readonly (Slide | Draft)[],
    o: {
      lo?: boolean;
      whole?: boolean;
      anchors?: 'own' | 'motion';
      clipIds?: string[];
      shown?: boolean;
    } = {},
  ) {
    const log = new ImportLog();
    const warns: [string, string][] = [];
    const core = new ImportCore({
      lo: o.lo ?? false,
      log,
      warn: (k, m) => warns.push([k, m]),
      geomFileBytes: 1 << 20,
      ...(o.whole !== undefined ? { whole: o.whole } : {}),
      ...(o.anchors ? { wholeAnchors: o.anchors } : {}),
    } as ConstructorParameters<typeof ImportCore>[0]);
    const drafts = slides.map((s, i) => ('ref' in s ? (s as Draft) : draft(s as Slide, i)));
    core.budget(drafts);
    const out = core.assemble(drafts, new Map(), {
      id: oid('X', 1),
      title: 'Deck',
      hash: FILE,
      sections: [],
      slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
      scan: { loop: false },
      hasAlpha: () => false,
      clipIds: new Set(o.clipIds ?? []),
      libraryFamilies: [],
    });
    return {
      p: out.p,
      slides: out.p.sections.flatMap((s) => s.slides),
      log: out.p.source?.log ?? '',
      warns,
      core,
    };
  }
  const withText = (i: number, n: number, bytes: number, runs: number) => [
    ...pictureObjects(n, i),
    ...textObjects(Math.max(1, Math.ceil(bytes / 9_000)), 8_000, i, runs),
  ];
  const countSlide = (i: number) => slideOf(i, pictureObjects(210, i));
  const bytesSlide = () => slideOf(0, textObjects(6, 500, 1, 150));
  const bothSlide = () => slideOf(0, withText(3, 210, 40 * KiB, 100));
  const plainSlide = (i: number) => slideOf(i, textObjects(2, 200, i));
  const playSlide = (): Slide => {
    const play = {
      ...pictureObjects(1, 7)[0]!,
      play: { mediaId: 'clip-1', start: 'auto', loop: false, muted: false },
    } as ImageObject;
    return slideOf(5, [...pictureObjects(210, 5), play]);
  };

  it('T1: a heavy slide carries { why, live: [] } exactly, an ordinary, an animated and a picture-class slide carry none', () => {
    const r = assembled(
      [
        countSlide(0),
        bytesSlide(),
        bothSlide(),
        plainSlide(3),
        playSlide(),
        draft(slideOf(6, []), 6, { cls: 'picture' }),
      ],
      { whole: true },
    );
    const [count, bytes, both, plain, play, picture] = r.slides;
    expect(rec(count!)).toEqual({ why: ['count'], live: [] });
    expect(rec(bytes!)).toEqual({ why: ['bytes'], live: [] });
    expect(rec(both!)).toEqual({ why: ['bytes', 'count'], live: [] });
    expect(rec(plain!)).toBeUndefined();
    expect('prerender' in plain!).toBe(false);
    expect(rec(play!)).toBeUndefined();
    expect(rec(picture!)).toBeUndefined();
    // Never a file, a stand-in or a use: the whole form is inline only (PRERENDER_FILES stays off).
    for (const s of [count, bytes, both]) expect(Object.keys(rec(s!)!).sort()).toEqual(['live', 'why']);
    // The slides keep every object: nothing was cut for the record.
    expect(count!.objects).toHaveLength(210);
    expect(both!.pptx?.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('T2: with the option off no slide of the same decks carries a record', () => {
    const r = assembled([countSlide(0), bytesSlide(), bothSlide(), plainSlide(3)], { whole: false });
    for (const s of r.slides) expect(s).not.toHaveProperty('prerender');
    const none = assembled([countSlide(0), bytesSlide()], {});
    for (const s of none.slides) expect(s).not.toHaveProperty('prerender');
    expect(r.log).not.toMatch(/kept whole/);
  });

  describe('T3: Q25.c.b, only a video counts, through assemble', () => {
    const heavyWithBackground = (i: number, bg: string): Slide => ({
      ...slideOf(i, pictureObjects(210, i)),
      backgroundMediaId: bg,
    });

    it("a background picture every slide shares is the presentation's: heavy slides are recorded under both arms", () => {
      for (const anchors of ['motion', 'own'] as const) {
        const r = assembled([heavyWithBackground(0, 'bg-shared'), heavyWithBackground(1, 'bg-shared')], {
          whole: true,
          anchors,
        });
        expect(r.p.backgroundMediaId, anchors).toBe('bg-shared');
        for (const s of r.slides) expect(rec(s), anchors).toEqual({ why: ['count'], live: [] });
      }
    });

    it('a background picture of the slide\'s own: recorded by default; none under the arm "own"', () => {
      const slides = () => [heavyWithBackground(0, 'bg-a'), heavyWithBackground(1, 'bg-b')];
      const motion = assembled(slides(), { whole: true });
      expect(motion.slides.map((s) => s.backgroundMediaId)).toEqual(['bg-a', 'bg-b']);
      for (const s of motion.slides) expect(rec(s)).toEqual({ why: ['count'], live: [] });
      const own = assembled(slides(), { whole: true, anchors: 'own' });
      for (const s of own.slides) expect(rec(s)).toBeUndefined();
    });

    it('a background that is a video clip keeps a slide out under both arms', () => {
      for (const anchors of ['motion', 'own'] as const) {
        const r = assembled([heavyWithBackground(0, 'clip-bg'), heavyWithBackground(1, 'bg-b')], {
          whole: true,
          anchors,
          clipIds: ['clip-bg'],
        });
        expect(rec(r.slides[0]!), anchors).toBeUndefined();
        expect(rec(r.slides[1]!), anchors).toEqual(
          anchors === 'motion' ? { why: ['count'], live: [] } : undefined,
        );
      }
    });
  });

  it('T4: what assemble stores is what the editor would plan: planRecord(stored, { kind, isMotion }) is the same slide', async () => {
    const { planRecord } = await import('@ordo/domain/prerender.ts');
    const decks = [
      [countSlide(0), bytesSlide(), bothSlide(), plainSlide(3), playSlide()],
      [
        { ...countSlide(1), backgroundMediaId: 'bg-x' },
        { ...bytesSlide(), backgroundMediaId: 'bg-y' },
        plainSlide(4),
      ],
    ];
    let n = 0;
    for (const slides of decks) {
      const r = assembled(slides, { whole: true, clipIds: [] });
      for (const s of r.slides) {
        expect(planRecord(s, { kind: r.p.kind, isMotion: (id) => id === 'never' })).toBe(s);
        n++;
      }
    }
    expect(n).toBe(8);
  });

  it('T5: around 64 KiB the importer and the editor agree on bytes, a byte at a time', async () => {
    const { planRecord } = await import('@ordo/domain/prerender.ts');
    const withLength = (chars: number) =>
      assembled(
        [
          slideOf(0, [
            { ...textObjects(1, chars, 9)[0]!, id: oid('T', 1) },
            ...textObjects(8, 8_000, 9).slice(1),
          ]),
        ],
        {
          whole: true,
        },
      );
    // The text length at which the stored slide first passes 64 KiB (the record's `bytes`), found by bisection.
    let lo = 1_000;
    let hi = 8_000;
    expect(withLength(lo).slides[0]!.prerender).toBeUndefined();
    expect(withLength(hi).slides[0]!.prerender).toBeDefined();
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (withLength(mid).slides[0]!.prerender) hi = mid;
      else lo = mid;
    }
    const rows: [number, boolean][] = [];
    for (let chars = hi - 35; chars <= hi + 35; chars++) {
      const r = withLength(chars);
      const stored = r.slides[0]!;
      expect(planRecord(stored, { kind: r.p.kind }), `${chars} characters`).toBe(stored);
      rows.push([chars, stored.prerender !== undefined]);
    }
    expect(rows.slice(0, 35).every(([, has]) => !has)).toBe(true);
    expect(rows.slice(35).every(([, has]) => has)).toBe(true);
    process.stdout.write(`T5: the record starts at ${hi} characters of ${rows.length} measured\n`);
  });

  it('T7: the report line, singular and plural, none, and the wording for a device that cannot make pictures', () => {
    expect(keptWholeLine(0)).toBe('');
    expect(keptWholeLine(1)).toBe(
      '1 slide is very detailed and was kept whole; the screens show a picture of it, made on this computer',
    );
    expect(keptWholeLine(3)).toBe(
      '3 slides are very detailed and were kept whole; the screens show a picture of each, made on this computer',
    );
    expect(keptWholeLine(1, { deviceCanBake: false })).toBe(
      '1 slide is very detailed and was kept whole; its picture is made on a computer with Chrome or Edge',
    );
    expect(keptWholeLine(2, { deviceCanBake: false })).toBe(
      '2 slides are very detailed and were kept whole; their pictures are made on a computer with Chrome or Edge',
    );
    expect(keptWholeLine(2, { deviceCanBake: true })).toBe(keptWholeLine(2));
    expect(keptWholeLine(-1)).toBe('');
    expect(keptWholeLine(Number.NaN)).toBe('');
    // In the import log, once, from the slides that carry a record; nothing when there is none.
    const r = assembled([countSlide(0), bytesSlide(), plainSlide(3)], { whole: true });
    expect(r.log.split('\n').filter((l) => /very detailed and (was|were) kept whole/.test(l))).toHaveLength(
      1,
    );
    expect(r.log).toMatch(/2 slides are very detailed and were kept whole/);
    const none = assembled([plainSlide(0)], { whole: true });
    expect(none.log).not.toMatch(/kept whole/);
  });
});

describe('selectWhole: the one rule of the import core and the census model (step 8a)', () => {
  const big = (i: number) => slideOf(i, textObjects(400, 1_100, i));
  const items = (slides: Slide[], picture: number[] = []) =>
    slides.map((slide, i) => ({
      picture: picture.includes(i),
      slide,
      rec: { ...slide, pptx: provenanceStandIn({ index: i, cls: 'native', version: 3 }) },
    }));

  it('keeps the first three of five 600 KB slides and cuts the rest to the screens\u2019 counts, as the import core does', () => {
    const slides = [0, 1, 2, 3, 4].map(big);
    const sel = selectWhole(items(slides));
    expect([...sel.kept]).toEqual([0, 1, 2]);
    expect([...sel.cut.keys()]).toEqual([3, 4]);
    for (const c of sel.cut.values()) {
      expect(c.slide.objects.length).toBeLessThanOrEqual(MAX_DRAWN_OBJECTS);
      expect(c.kinds).toContain('element');
    }
    // The import core cuts exactly those slides.
    const r = budgeted(slides, { lo: false, whole: true });
    r.drafts.forEach((d, i) => {
      expect(d.dropped?.includes('element') === true, `slide ${i}`).toBe(sel.cut.has(i));
      if (sel.cut.has(i)) expect(d.slide.objects).toHaveLength(sel.cut.get(i)!.slide.objects.length);
    });
  });

  it('leaves a picture-class slide and a slide that is not heavy alone, and counts a re-import\u2019s kept bytes first', () => {
    const slides = [slideOf(0, textObjects(3, 100)), big(1), big(2)];
    const sel = selectWhole(items(slides, [2]));
    expect([...sel.kept]).toEqual([1]);
    expect(sel.cut.size).toBe(0);
    // With the share nearly used by the slides a re-import keeps, the first heavy slide is cut.
    const used = selectWhole(items([big(0)]), WHOLE_SHARE_BYTES - 10);
    expect(used.kept.size).toBe(0);
    expect(used.cut.has(0)).toBe(true);
  });

  it('never throws on what is not a slide', () => {
    expect(() => selectWhole(items([{ id: 'x' } as unknown as Slide]))).not.toThrow();
  });
});
