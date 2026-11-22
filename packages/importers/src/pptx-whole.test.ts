/**
 * Q24.b, the first pre-render release, in the import core: a heavy, eligible slide stays whole (the ladder stops at
 * 'full' or 'grid'), within 2 MiB of such slides a presentation, past it cut to what the screens draw; LibreOffice's
 * page no longer applies to it; and with the option off the ladder and the stored slides are the base's.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_LYRIC_STYLE,
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
  WHOLE_BACKGROUND_ANCHORS,
  WHOLE_OBJECTS_MAX,
  WHOLE_SHARE_BYTES,
  WHOLE_WITH_LIBREOFFICE,
  wholeSlidesFor,
} from './pptx-core.ts';
import { type LadderInput, planLadder, quickBytes, trimToCounts, wholeLevel } from './pptx-ladder.ts';
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
const slideOf = (i: number, objects: SlideObject[], extra: Partial<Slide> = {}): Slide => ({
  id: oid('L', i),
  objects,
  ...extra,
});
/** A slide of about `bytes` stored: `n` text boxes of the size that makes them. */
function textSlide(i: number, bytes: number, n = 4, runs = 0): Slide {
  const chars = Math.max(10, Math.floor(bytes / n) - 420 - runs * 60);
  return slideOf(i, textObjects(n, chars, i, runs));
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
    'b26b2f8397919799',
    '2dcfb87285121bfc',
    '08ebd99331563969',
    '7a872294c59a2472',
    '18394dd3c89b451f',
    '708417923bf6514f',
    '6de445695a5d6c2e',
    '1a0f4ab93341ec38',
    'd89b726554c2ccbe',
    '0cc32ff0ea990a7b',
    '3464e39e604a7cbf',
    '845d60628a717600',
    '2e42644153cc832d',
    'b26b2f8397919799',
    '8f56918a07f47398',
    '08ebd99331563969',
    '7a872294c59a2472',
    '2ec62c41faa8ff5b',
    '708417923bf6514f',
    '6de445695a5d6c2e',
    '1a0f4ab93341ec38',
    'd89b726554c2ccbe',
    '0cc32ff0ea990a7b',
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
    expect(formattedCount(draft(slide(), 0))).toBe(4);
    for (const lo of [false, true]) {
      const whole = budgeted([slide()], { lo, whole: true }).drafts[0]!;
      expect(formattedCount(whole), `lo ${lo}`).toBe(4);
      expect(whole.simplified).toBeFalsy();
      expect(whole.cls).toBe('native');
    }
    const base = budgeted([slide()], { lo: false, whole: false }).drafts[0]!;
    expect(formattedCount(base)).toBe(0);
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
    const one = slideOf(0, [...textObjects(300, 6_000), ...pictureObjects(60)]);
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
    ...Array.from({ length: 900 }, (_, i) => textSlide(i + 1, 8 * KiB)),
    slideOf(901, pictureObjects(900, 9)),
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
    const alone = budgeted(deck().slice(1, 901), { lo: false, whole: true });
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
