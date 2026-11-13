import { describe, expect, it } from 'vitest';
import { resolvePlaylist } from './goLive.ts';
import { parsePathData } from './pathdata.ts';
import {
  type Presentation,
  Presentation as PresentationSchema,
  type ShapeObject,
  Slide,
  type SlideObject,
  type TextObject,
  type TextStyle,
} from './schemas.ts';
import {
  compactSlide,
  compactSlideBytes,
  fitSlideBudget,
  formatBytes,
  GRID_PX,
  gridSlide,
  jsonBytes,
  minimalSlide,
  planImportSizes,
  presentationBytes,
  previewSlice,
  resolvedSizeWarning,
  SIZE_BUDGETS,
  slideBytes,
  utf8Bytes,
} from './size.ts';

const KiB = 1024;
const MiB = 1024 * KiB;
const FILE = 'f'.repeat(64);
const VERSE =
  'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life. ';

const style = (fontSizePx: number, extra: Partial<TextStyle> = {}): TextStyle => ({
  fontFamily: 'Calibri',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSizePx,
  color: { r: 255, g: 255, b: 255, a: 1 },
  align: 'left',
  valign: 'top',
  lineHeight: 1.2,
  letterSpacing: 0,
  padding: 9.6,
  transform: 'none',
  outline: { width: 1.5, color: { r: 0, g: 0, b: 0, a: 0.6 } },
  shadow: { dx: 2, dy: 2, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.5 } },
  ...extra,
});
const id = (prefix: string, i: number) => `${prefix}${i.toString(36).toUpperCase().padStart(25, '0')}`;
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });

/**
 * A slide shaped like the native converter's output for a sermon or scripture slide (design/27 §3.4: about
 * 3.4 KB typical): a photo, an accent bar, a title, a body, a reference, speaker notes on every third slide,
 * and provenance. Real sermon slides carry 160 characters of text on average (p90 333) over 3.4 objects;
 * this one carries more of both.
 */
function importedSlide(i: number, bodyChars = 300): Slide {
  const body = VERSE.repeat(Math.ceil(bodyChars / VERSE.length)).slice(0, bodyChars);
  return {
    id: id('S', i),
    objects: [
      {
        id: id('A', i),
        type: 'image',
        box: box(0, 0, 1920, 1080),
        mediaId: id('M', i % 7),
        fit: 'cover',
        opacity: 1,
        radius: 0,
        crop: { l: 0.05, t: 0, r: 0.05, b: 0 },
      },
      {
        id: id('B', i),
        type: 'shape',
        box: box(96, 196, 1728, 6),
        shape: 'rect',
        fill: { r: 200, g: 160, b: 60, a: 1 },
        opacity: 1,
        radius: 0,
      },
      {
        id: id('T', i),
        type: 'text',
        box: box(96, 64, 1728, 120),
        text: `Week ${i}: the good news`,
        style: style(64, { fontWeight: 700 }),
        opacity: 1,
      },
      {
        id: id('X', i),
        type: 'text',
        box: box(96, 230, 1728, 700),
        text: body,
        style: style(40),
        opacity: 1,
      },
      {
        id: id('R', i),
        type: 'text',
        box: box(1200, 960, 624, 60),
        text: `John 3:${(i % 36) + 1}`,
        style: style(28, { align: 'right' }),
        opacity: 1,
      },
      {
        id: id('F', i),
        type: 'text',
        box: box(96, 1000, 900, 48),
        text: 'Sunday service',
        style: style(24, { fontStyle: 'italic' }),
        opacity: 0.8,
      },
      {
        id: id('L', i),
        type: 'image',
        box: box(1700, 40, 160, 160),
        mediaId: id('LOGO', 0),
        fit: 'contain',
        opacity: 1,
        radius: 0,
      },
      {
        id: id('C', i),
        type: 'shape',
        box: box(0, 1040, 1920, 40),
        shape: 'rect',
        fill: { r: 0, g: 0, b: 0, a: 0.5 },
        stroke: { width: 2, color: { r: 200, g: 160, b: 60, a: 1 } },
        opacity: 1,
        radius: 0,
      },
    ],
    lyricObjectId: id('X', i),
    ...(i % 3 === 0
      ? { notes: `Pause here and ask the congregation to read verse ${i} aloud. `.repeat(2) }
      : {}),
    pptx: { fileId: FILE, index: i, shown: i, class: 'native', version: 1, digest: 'd'.repeat(43) },
  };
}

/** An imported slide over `slideMax` on its own: 1,000 text objects. */
function hugeSlide(i: number): Slide {
  const s = importedSlide(i);
  const t = s.objects[3]!;
  return {
    ...s,
    objects: Array.from({ length: 1000 }, (_, k) => ({ ...t, id: id(`H${k}_`, i), text: VERSE })),
  };
}

function deck(slides: Slide[], sections = 1): Presentation {
  const per = Math.ceil(slides.length / sections);
  return PresentationSchema.parse({
    id: 'deck',
    title: 'A large deck',
    kind: 'slides',
    sections: Array.from({ length: sections }, (_, k) => ({
      id: `sec${k}`,
      label: `Section ${k + 1}`,
      short: '',
      slides: slides.slice(k * per, (k + 1) * per),
      chords: ['G D Em C'],
    })),
    arrangements: [
      { id: 'arr', name: 'Default', sectionIds: Array.from({ length: sections }, (_, k) => `sec${k}`) },
    ],
    source: { kind: 'pptx', fileId: FILE, log: 'x'.repeat(100_000) },
  });
}

describe('size estimates (design/27 §3.4)', () => {
  it('counts UTF-8 bytes of the JSON a socket carries', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('ש')).toBe(2);
    expect(utf8Bytes('漢')).toBe(3);
    expect(utf8Bytes('😀')).toBe(4);
    for (const v of [{ t: 'Amazing grace 😀 ש 漢' }, [1, 'x', null], 'lone \ud800 surrogate'])
      expect(jsonBytes(v)).toBe(new TextEncoder().encode(JSON.stringify(v)).length);
    expect(jsonBytes(undefined)).toBe(0);
    expect(slideBytes({ id: 's', objects: [] })).toBe('{"id":"s","objects":[]}'.length);
  });

  it('formats sizes for people', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(640 * KiB)).toBe('640 KiB');
    expect(formatBytes(13.26 * MiB)).toBe('13.2 MiB');
    expect(formatBytes(15 * MiB + 1)).toBe('15.0 MiB');
    expect(formatBytes(Number.NaN)).toBe('0 bytes');
  });

  it('the synthetic slide is a typical imported slide', () => {
    const b = slideBytes(Slide.parse(importedSlide(1)));
    expect(b).toBeGreaterThan(3 * KiB);
    expect(b).toBeLessThan(SIZE_BUDGETS.slideTypical);
    expect(slideBytes(Slide.parse(hugeSlide(1)))).toBeGreaterThan(SIZE_BUDGETS.slideMax);
  });
});

describe('planImportSizes', () => {
  it('keeps a 2,000-slide import within 4 MiB, the tail compact and contiguous', () => {
    const sizes = Array.from({ length: 2000 }, () => 6 * KiB);
    const plan = planImportSizes(sizes);
    expect(plan.total).toBeLessThanOrEqual(SIZE_BUDGETS.presentationMax);
    expect(plan.fits).toBe(true);
    expect(plan.compact[0]).toBe(false);
    expect(plan.compact.at(-1)).toBe(true);
    expect(plan.tailFrom).toBe(plan.compact.indexOf(true));
    expect(plan.compact.slice(plan.tailFrom).every(Boolean)).toBe(true);
    expect(plan.tail).toBe(2000 - plan.tailFrom);
    expect(plan.reasons[plan.tailFrom]).toBe('presentation');
    expect(plan.reasons[0]).toBeNull();
    expect(plan.oversized).toBe(0);
  });

  it('makes a slide over the hard budget compact on its own, without closing the presentation', () => {
    const plan = planImportSizes([3000, SIZE_BUDGETS.slideMax + 1, 3000, Number.NaN, 20 * MiB, 3000]);
    expect(plan.compact).toEqual([false, true, false, false, true, false]);
    expect(plan.reasons).toEqual([null, 'slide', null, null, 'slide', null]);
    expect(plan.oversized).toBe(2);
    expect(plan.tail).toBe(0);
    expect(plan.tailFrom).toBe(-1);
  });

  it('takes one compact size per slide, and reports a deck that cannot fit even all compact', () => {
    // The tail's own compact sizes decide where it starts: big compact slides start it earlier.
    const sizes = Array.from({ length: 2000 }, () => 4 * KiB);
    const small = planImportSizes(sizes, 300);
    const big = planImportSizes(
      sizes,
      sizes.map(() => 1.5 * KiB),
    );
    // Small compact slides: the 3 MiB mark closes the presentation (slide 769 passes it).
    expect(small.tailFrom).toBe(769);
    // Large ones: the room the tail needs closes it earlier.
    expect(big.tailFrom).toBeGreaterThan(300);
    expect(big.tailFrom).toBeLessThan(small.tailFrom);
    for (const plan of [small, big]) expect(plan.total).toBeLessThanOrEqual(SIZE_BUDGETS.presentationMax);
    const hopeless = planImportSizes(
      Array.from({ length: 10_000 }, () => 4 * KiB),
      512,
    );
    expect(hopeless.fits).toBe(false);
    expect(hopeless.compact.every(Boolean)).toBe(true);
  });

  it('a synthetic 2,000-slide deck imports within 4 MiB, even after the LibreOffice follow-up', () => {
    const slides = Array.from({ length: 2000 }, (_, i) =>
      Slide.parse(i === 10 || i === 1500 ? hugeSlide(i) : importedSlide(i)),
    );
    const plan = planImportSizes(
      slides.map(slideBytes),
      slides.map((s) => compactSlideBytes(s)),
    );
    expect(plan.fits).toBe(true);
    expect(plan.reasons[10]).toBe('slide');
    expect(plan.reasons[1500]).toBe('slide');
    expect(plan.oversized).toBe(2);
    // The deck is about 7 MB with its objects: the last part becomes the compact tail. Compact slides keep
    // their text twice after the follow-up (artText and the page's text boxes), so about 200 slides stay
    // editable here (real sermon slides carry half this text).
    expect(slides.reduce((n, s) => n + slideBytes(s), 0)).toBeGreaterThan(6 * MiB);
    expect(plan.tailFrom).toBeGreaterThan(150);
    expect(plan.tailFrom).toBeLessThan(1000);
    expect(plan.compact.slice(plan.tailFrom).every(Boolean)).toBe(true);
    // Version 1 as stored: every slide still passes the schema.
    const stored = slides.map((s, i) => Slide.parse(plan.compact[i] ? compactSlide(s) : s));
    const v1 = deck(stored);
    expect(presentationBytes(v1)).toBeLessThanOrEqual(SIZE_BUDGETS.presentationMax);
    // Version 2: every compact slide gains its page picture and text boxes, as estimated.
    const v2 = deck(
      stored.map((s, i) =>
        plan.compact[i]
          ? Slide.parse({
              ...s,
              imported: {
                fileId: FILE,
                page: i,
                imageMediaId: id('P', i),
                textBoxes: slides[i]!.objects.flatMap((o) =>
                  o.type === 'text' ? [{ text: o.text, box: o.box, fontSizePx: o.style.fontSizePx }] : [],
                ),
                textAligned: true,
              },
            })
          : s,
      ),
    );
    expect(presentationBytes(v2)).toBeLessThanOrEqual(SIZE_BUDGETS.presentationMax);
    expect(presentationBytes(v2)).toBeGreaterThan(SIZE_BUDGETS.presentationCompact);
  });
});

describe('compactSlide', () => {
  it('keeps provenance, notes and navigation, and moves the text into artText', () => {
    const s = Slide.parse({
      ...importedSlide(3),
      hidden: true,
      durationMs: 5000,
      transition: { kind: 'crossfade', ms: 700 },
      pptx: { ...importedSlide(3).pptx!, class: 'hybrid', artText: 'Chart: attendance' },
    });
    const c = Slide.parse(compactSlide(s));
    expect(c.objects).toEqual([]);
    expect(c.lyricObjectId).toBeUndefined();
    expect(s.notes).toBeTruthy();
    expect(c).toMatchObject({ id: s.id, hidden: true, durationMs: 5000, notes: s.notes });
    expect(c.transition).toEqual({ kind: 'crossfade', ms: 700 });
    expect(c.pptx).toMatchObject({ fileId: FILE, index: 3, shown: 3, class: 'picture', pending: true });
    expect(c.pptx!.artText!.split('\n')).toEqual([
      'Week 3: the good news',
      expect.any(String),
      'John 3:4',
      'Sunday service',
      'Chart: attendance',
    ]);
    expect(compactSlide(s, 'given').pptx!.artText!.endsWith('\ngiven')).toBe(true);
    expect(compactSlideBytes(s)).toBeGreaterThan(slideBytes(c));
  });

  it('bounds artText to the schema without splitting a surrogate pair', () => {
    const s = importedSlide(1);
    const t = s.objects[3]!;
    const long = { ...s, objects: [{ ...t, text: `${'a'.repeat(19_999)}😀😀` }] } as Slide;
    const c = compactSlide(long);
    expect(c.pptx!.artText!.length).toBe(19_999);
    expect(() => Slide.parse(c)).not.toThrow();
    // Without provenance there is nowhere to keep the text: only the objects go.
    expect(compactSlide({ id: 'x', objects: s.objects })).toEqual({ id: 'x', objects: [] });
  });
});

describe('previewSlice', () => {
  const slides = Array.from({ length: 2000 }, (_, i) =>
    Slide.parse(importedSlide(i, 400 + ((i * 37) % 900))),
  );
  const flat = (p: Presentation) => p.sections.flatMap((s) => s.slides.map((x) => x.id));

  it('sends less than 1 MiB for any slide of a 2,000-slide deck in one section', () => {
    const p = deck(slides);
    expect(presentationBytes(p)).toBeGreaterThan(5 * MiB);
    let largest = 0;
    for (let i = 1; i < slides.length; i++)
      if (slideBytes(slides[i]!) > slideBytes(slides[largest]!)) largest = i;
    for (const i of [0, largest, 1234, 1999, ...Array.from({ length: 20 }, (_, k) => k * 97)]) {
      const s = previewSlice(p, slides[i]!.id);
      expect(jsonBytes(s)).toBeLessThan(SIZE_BUDGETS.previewMax);
      const ids = flat(s);
      expect(ids[0]).toBe(slides[i]!.id);
      if (i < 1999) expect(ids[1]).toBe(slides[i + 1]!.id);
    }
    const s = previewSlice(p, slides[largest]!.id);
    // Presentation-level fields travel; arrangements, chords and the import log do not.
    expect(s).toMatchObject({
      id: 'deck',
      title: 'A large deck',
      kind: 'slides',
      source: { kind: 'pptx', fileId: FILE },
    });
    expect(s.source?.log).toBeUndefined();
    expect(s.arrangements).toEqual([]);
    expect(s.sections[0]!.chords).toBeUndefined();
    expect(PresentationSchema.safeParse(s).success).toBe(true);
  });

  it('sends the whole section when it fits, with the next section opening slide for the next-slide band', () => {
    const p = deck(slides.slice(0, 200), 10);
    const sec = p.sections[3]!;
    const mid = previewSlice(p, sec.slides[5]!.id);
    expect(mid.sections).toHaveLength(1);
    expect(flat(mid)).toEqual(sec.slides.map((x) => x.id));
    const last = previewSlice(p, sec.slides.at(-1)!.id);
    expect(flat(last)).toEqual([...sec.slides.map((x) => x.id), p.sections[4]!.slides[0]!.id]);
    expect(last.sections[1]!.id).toBe('sec4');
    // The last slide of the deck has no next slide.
    expect(flat(previewSlice(p, p.sections[9]!.slides.at(-1)!.id))).toEqual(
      p.sections[9]!.slides.map((x) => x.id),
    );
  });

  it('the next slide is the next shown one: hidden slides are skipped, as Next skips them (design/27 §9)', () => {
    const p = deck(slides.slice(0, 6), 3);
    const [a, h] = p.sections[0]!.slides as [Slide, Slide];
    const hide = (x: Slide): Slide => ({ ...x, hidden: true });
    // Sections [a, hidden] and [hidden, b]: the band shows b.
    const q: Presentation = {
      ...p,
      sections: [
        { ...p.sections[0]!, slides: [a, hide(h)] },
        { ...p.sections[1]!, slides: [hide(p.sections[1]!.slides[0]!), p.sections[1]!.slides[1]!] },
      ],
    };
    const s = previewSlice(q, a.id);
    expect(flat(s)).toEqual([a.id, h.id, p.sections[1]!.slides[1]!.id]);
    // Cut to the pair, the hidden slide in between is left out.
    const c = p.sections[2]!.slides[0]!;
    const r: Presentation = { ...q, sections: [{ ...q.sections[0]!, slides: [a, hide(h), c] }] };
    const pair = previewSlice(r, a.id, jsonBytes(previewSlice(r, a.id, 1)) + slideBytes(c) + 10);
    expect(flat(pair)).toEqual([a.id, c.id]);
  });

  it('previews the first slide without an id, nothing for an unknown id, and a giant slide alone', () => {
    const p = deck(slides.slice(0, 30), 3);
    expect(flat(previewSlice(p))[0]).toBe(slides[0]!.id);
    expect(previewSlice(p, 'nope').sections).toEqual([]);
    const giant = Slide.parse({
      ...importedSlide(0),
      objects: Array.from({ length: 80 }, (_, k) => ({
        ...importedSlide(0).objects[3]!,
        id: `g${k}`,
        text: 'x'.repeat(19_000),
      })),
    });
    const q = deck([giant, ...slides.slice(1, 10)]);
    const s = previewSlice(q, giant.id);
    expect(flat(s)).toEqual([giant.id]);
    expect(jsonBytes(s)).toBeGreaterThan(SIZE_BUDGETS.previewMax);
  });
});

describe('resolved playlist size (design/27 §14.10)', () => {
  /** A playlist of `n` presentations of `slides` slides of `chars` characters each. */
  function inputs(n: number, slides: number, chars: number) {
    const pres = Array.from({ length: n }, (_, k) =>
      deck(
        Array.from({ length: slides }, (_, i) => {
          const s = importedSlide(k * slides + i, 200);
          const objects = s.objects.filter((o) => o.type !== 'image');
          return {
            ...s,
            objects: [...objects, { ...s.objects[3]!, id: `${s.id}-long`, text: 'y'.repeat(chars) }],
          } as Slide;
        }),
      ),
    ).map((p, k) => ({ ...p, id: `p${k}` }));
    return {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'Sunday',
        items: pres.map((p, k) => ({ id: `i${k}`, kind: 'presentation', presentationId: p.id })),
      },
      presentation: (pid: string) => pres.find((p) => p.id === pid),
      media: () => undefined,
      fonts: () => [],
      looks: [],
      general: {},
    };
  }
  const digest = () => 'digest';

  it('a 13 MiB resolved playlist goes live with the degraded warning; a small one without', () => {
    const big = resolvePlaylist(inputs(4, 200, 13_800), 'pl', { digest });
    const bytes = jsonBytes({ ...big, degraded: undefined });
    expect(bytes).toBeGreaterThan(13 * MiB);
    expect(bytes).toBeLessThan(14 * MiB);
    const w = big.degraded?.find((d) => d.reason.includes('too large for an operator takeover'));
    expect(w).toMatchObject({ cueIndex: -1 });
    expect(w!.reason).toContain('13.');
    expect(w!.reason.length).toBeLessThanOrEqual(500);
    const small = resolvePlaylist(inputs(2, 20, 1000), 'pl', { digest });
    expect(small.degraded).toBeUndefined();
  });

  it('warns only above 12 MiB', () => {
    expect(resolvedSizeWarning(SIZE_BUDGETS.resolvedWarn)).toBeUndefined();
    expect(resolvedSizeWarning(Number.NaN)).toBeUndefined();
    expect(resolvedSizeWarning(SIZE_BUDGETS.resolvedWarn + 1)).toContain('12.0 MiB');
  });
});

// ── The budget ladder (M9 `ladder`) ──────────────────────────────────────────────────────────────────────

/** A seeded generator (mulberry32): the same slides on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A traced outline of `n` points in a `w × h` space with float coordinates (a converter's custGeom). */
function tracedPath(
  r: () => number,
  n: number,
  w = 21_600.123,
  h = 10_800.456,
): { d: string; w: number; h: number } {
  const pts: string[] = [];
  for (let i = 0; i < n; i++) pts.push(`${i ? 'L' : 'M'} ${(r() * w).toFixed(6)} ${(r() * h).toFixed(6)}`);
  return { d: `${pts.join(' ')} Z`, w, h };
}

const traced = (k: number, r: () => number, n = 400, b = box(100 + k, 100, 600, 300)): ShapeObject => ({
  id: id('G', k),
  type: 'shape',
  box: b,
  shape: 'rect',
  fill: { r: 10, g: 20, b: 30, a: 1 },
  opacity: 1,
  radius: 0,
  geom: { paths: [tracedPath(r, n)] },
});

/** A text object with `n` formatted runs over its text. */
function formatted(k: number, n: number, chars = n * 10): TextObject {
  const text = VERSE.repeat(Math.ceil(chars / VERSE.length)).slice(0, chars);
  const step = Math.max(1, Math.floor(chars / n));
  return {
    id: id('Q', k),
    type: 'text',
    box: box(96, 96 + k, 1728, 300),
    text,
    style: style(32),
    opacity: 1,
    runs: Array.from({ length: n }, (_, i) => ({
      start: i * step,
      end: Math.min(chars, i * step + Math.max(1, step - 1)),
      fontWeight: 700,
      color: { r: (i * 37) % 256, g: 200, b: 0, a: 1 },
    })).filter((x) => x.end > x.start),
    paras: [{ align: 'center', spaceBeforePx: 12 }],
  };
}

const textsOf = (s: Slide) => s.objects.flatMap((o) => (o.type === 'text' ? [[o.id, o.text]] : []));

describe('fitSlideBudget (design/27 §3.4, M9 ladder)', () => {
  it('keeps the first level that fits', () => {
    const r = rng(1);
    // Full: a typical slide is returned as it is.
    const typical = importedSlide(1);
    const full = fitSlideBudget(typical);
    expect(full).toMatchObject({ level: 'full', dropped: 0, plain: 0, missing: [] });
    expect(full.slide).toBe(typical);
    // Grid: outlines with long float coordinates fit once on the grid (`GRID_PX`).
    const outlines: Slide = { ...importedSlide(2), objects: [traced(1, r, 2_000), traced(2, r, 2_000)] };
    const before = slideBytes(outlines);
    const grid = fitSlideBudget(outlines, Math.round(before * 0.7));
    expect(grid.level).toBe('grid');
    expect(grid.bytes).toBeLessThanOrEqual(Math.round(before * 0.7));
    expect(grid.slide.objects).toHaveLength(2);
    // Plain: formatted text over the budget loses the largest formatting first, and only what it must.
    const rich: Slide = {
      ...importedSlide(3),
      objects: [formatted(1, 600), formatted(2, 40), formatted(3, 40)],
    };
    const plain = fitSlideBudget(rich, slideBytes(rich) - 10_000);
    expect(plain.level).toBe('plain');
    expect(plain.plain).toBe(1);
    const [big, small] = plain.slide.objects as [TextObject, TextObject];
    expect(big.runs).toBeUndefined();
    expect(big.paras).toBeUndefined();
    expect(small.runs).toHaveLength(40);
    expect(textsOf(plain.slide)).toEqual(textsOf(rich));
    // Minimal: shapes past the budget are left out, the largest first; text, pictures and formatting stay.
    const decorated: Slide = {
      ...importedSlide(4),
      objects: [...importedSlide(4).objects, traced(1, r, 3_000), traced(2, r, 200), formatted(5, 20)],
    };
    // Under the budget only without the larger outline, even on the grid.
    const max = slideBytes(gridSlide(decorated)) - 20_000;
    const minimal = fitSlideBudget(decorated, max);
    expect(minimal.level).toBe('minimal');
    expect(minimal.bytes).toBeLessThanOrEqual(max);
    expect(minimal.dropped).toBe(1);
    expect(minimal.missing).toEqual(['decoration']);
    expect(minimal.plain).toBe(0);
    const ids = minimal.slide.objects.map((o) => o.id);
    expect(ids).not.toContain(id('G', 1));
    expect(ids).toContain(id('G', 2));
    expect(textsOf(minimal.slide)).toEqual(textsOf(decorated));
    expect(minimal.slide.objects.filter((o) => o.type === 'image')).toHaveLength(2);
    expect((minimal.slide.objects.find((o) => o.id === id('Q', 5)) as TextObject).runs).toHaveLength(20);
    // A slide whose text alone passes the budget is minimal and over it: nothing of its text is cut.
    const words: Slide = { ...importedSlide(5), objects: [formatted(6, 10, 20_000)] };
    const over = fitSlideBudget(words, 4_000);
    expect(over.level).toBe('minimal');
    expect(over.bytes).toBeGreaterThan(4_000);
    expect(textsOf(over.slide)).toEqual(textsOf(words));
    // The input is never changed; the caller's measure decides.
    expect(slideBytes(gridSlide(decorated))).toBe(max + 20_000);
    expect(gridSlide(decorated)).not.toBe(decorated);
    expect(fitSlideBudget(typical, 64 * KiB, { size: () => 70 * KiB }).level).toBe('minimal');
    expect(fitSlideBudget(typical, 64 * KiB, { size: () => Number.NaN }).level).toBe('full');
  });

  it('grid moves no point more than 0.125 logical px', () => {
    const r = rng(7);
    let worst = 0;
    let points = 0;
    for (let k = 0; k < 60; k++) {
      const w = r() < 0.1 ? 0 : 1 + r() * 3_000;
      const h = r() < 0.1 ? 0.3 : 1 + r() * 2_000;
      const space = { w: 1 + r() * 1e7, h: 1 + r() * 1e7 };
      const p = tracedPath(r, 50 + Math.floor(r() * 300), space.w, space.h);
      const shape: ShapeObject = {
        ...traced(k, r),
        box: box(r() * 1000, r() * 500, w, h),
        geom: { paths: [p] },
      };
      const image = {
        id: id('I', k),
        type: 'image' as const,
        box: box(0, 0, w, h),
        mediaId: id('M', k),
        fit: 'cover' as const,
        opacity: 1,
        radius: 0,
        mask: { paths: [p] },
      };
      const out = gridSlide({ id: id('S', k), objects: [shape, image] });
      for (const [i, o] of out.objects.entries()) {
        const g = o.type === 'shape' ? o.geom! : (o as typeof image).mask;
        const q = g.paths![0]!;
        const a = parsePathData(p.d);
        const b = parsePathData(q.d);
        expect(b.cmds).toBe(a.cmds);
        if (q !== p) {
          expect(Number.isInteger(q.w) && Number.isInteger(q.h)).toBe(true);
          expect(q.w).toBe(Math.max(1, Math.ceil(w / GRID_PX)));
        }
        for (let j = 0; j < a.pts.length; j += 2) {
          const dx = Math.abs((a.pts[j]! * w) / p.w - (b.pts[j]! * w) / q.w);
          const dy = Math.abs((a.pts[j + 1]! * h) / p.h - (b.pts[j + 1]! * h) / q.h);
          worst = Math.max(worst, dx, dy);
          points++;
        }
        expect(i).toBeLessThan(2);
      }
    }
    expect(points).toBeGreaterThan(10_000);
    // At most half a grid cell: well within the plan's 0.125 logical px.
    expect(worst).toBeLessThanOrEqual(GRID_PX / 2 + 1e-9);
    expect(GRID_PX / 2).toBeLessThanOrEqual(0.125);
    // Integer paths already on a coarser grid stay as they are; objects without outlines are shared.
    const coarse: ShapeObject = {
      ...traced(1, r),
      geom: { paths: [{ d: 'M 0 0 L 4 0 L 4 2 Z', w: 4, h: 2 }] },
    };
    const text = importedSlide(1).objects[2]!;
    const same = gridSlide({ id: 's', objects: [coarse, text] });
    expect(same.objects[0]).toBe(coarse);
    expect(same.objects[1]).toBe(text);
  });

  it("keeps the slide's background drawn as a shape (origin role 'bg') at the minimal level", () => {
    const r = rng(11);
    // A white page under dark text, as the converter writes a solid background (and the hub the white under
    // a background picture with alpha): left out, the text would be drawn on the output's black.
    const page: ShapeObject = {
      id: id('BG', 2),
      type: 'shape',
      box: box(0, 0, 1920, 1080),
      shape: 'rect',
      fill: { r: 255, g: 255, b: 255, a: 1 },
      opacity: 1,
      radius: 0,
      origin: { src: 'pptx', role: 'bg' },
    };
    const words: Slide = {
      ...importedSlide(6),
      objects: [page, traced(1, r, 3_000), formatted(7, 10, 20_000)],
    };
    const over = fitSlideBudget(words, 4_000);
    expect(over.level).toBe('minimal');
    expect(over.dropped).toBe(1);
    expect(over.missing).toEqual(['decoration']);
    expect(over.slide.objects.map((o) => o.id)).toEqual([id('BG', 2), id('Q', 7)]);
    expect(over.slide.objects[0]).toBe(page);
    // The presentation's tail (`minimalSlide`) keeps it too, as the slide's background colour alone.
    expect(minimalSlide(words).objects.map((o) => o.id)).toEqual([id('BG', 2), id('Q', 7)]);
    expect(minimalSlide(words).objects[0]).toEqual(page);
  });

  it("minimal keeps a background shape as the slide's colour: a plain rect, the bottom one only", () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const navy = { r: 10, g: 20, b: 60, a: 1 };
    // A gradient page drawn as M6 writes it (geometry, gradient, effects), a second bg shape over it, and text.
    const page: ShapeObject = {
      id: id('BG', 3),
      type: 'shape',
      box: box(0, 0, 1920, 1080),
      shape: 'rect',
      opacity: 0.9,
      radius: 0,
      geom: { preset: 'rect' },
      gradient: {
        kind: 'linear',
        angle: 90,
        stops: [
          { at: 0, color: navy },
          { at: 1, color: white },
        ],
      },
      shadow: { dx: 0, dy: 0, blur: 4, color: navy },
      origin: { src: 'pptx', role: 'bg' },
      locked: true,
    };
    const inner: ShapeObject = { ...page, id: id('BG', 4), fill: white, gradient: undefined };
    const words: Slide = { ...importedSlide(6), objects: [page, inner, formatted(7, 3, 400)] };
    const m = minimalSlide(words);
    expect(m.objects.map((o) => o.id)).toEqual([id('BG', 3), id('Q', 7)]);
    expect(m.objects[0]).toEqual({
      id: id('BG', 3),
      type: 'shape',
      box: box(0, 0, 1920, 1080),
      shape: 'rect',
      fill: navy,
      opacity: 0.9,
      radius: 0,
      origin: { src: 'pptx', role: 'bg' },
      locked: true,
    });
    expect(jsonBytes(m.objects[0])).toBeLessThan(260);
    expect(Slide.safeParse(m).success).toBe(true);
    // A shape that paints nothing is no background colour.
    const none: ShapeObject = { ...page, gradient: undefined };
    expect(
      minimalSlide({ ...words, objects: [none, formatted(7, 3, 400)] }).objects.map((o) => o.id),
    ).toEqual([id('Q', 7)]);
  });

  it("minimal keeps every text object's text", () => {
    const r = rng(3);
    const table: ShapeObject = {
      id: id('TB', 1),
      type: 'shape',
      box: box(100, 600, 800, 200),
      shape: 'rect',
      opacity: 1,
      radius: 0,
      table: {
        cols: [400, 400],
        rows: [100, 100],
        cells: [
          { text: 'Hymn', runs: [[0, 4, 0]] },
          { text: '42' },
          { text: 'Psalm', paras: [{ align: 'right' }] },
          { text: '23' },
        ],
        base: style(24),
        runStyles: [{ fontWeight: 700 }],
      },
    };
    const s: Slide = {
      ...importedSlide(9),
      objects: [...importedSlide(9).objects, traced(1, r), formatted(2, 30), table],
      backgroundMediaId: id('BG', 1),
    };
    const m = minimalSlide(s);
    expect(textsOf(m)).toEqual(textsOf(s));
    for (const o of m.objects) if (o.type === 'text') expect(o.runs ?? o.paras).toBeUndefined();
    expect(m.objects.filter((o) => o.type === 'image')).toHaveLength(2);
    expect(m.objects.filter((o) => o.type === 'shape').map((o) => o.id)).toEqual([id('TB', 1)]);
    const t = (m.objects.find((o) => o.id === id('TB', 1)) as ShapeObject).table!;
    expect(t.cells.map((c) => c.text)).toEqual(['Hymn', '42', 'Psalm', '23']);
    expect(t.runStyles).toBeUndefined();
    expect(t.cells.some((c) => c.runs || c.paras)).toBe(false);
    expect(m.backgroundMediaId).toBe(id('BG', 1));
    expect(m.lyricObjectId).toBe(s.lyricObjectId);
    expect(Slide.safeParse(m).success).toBe(true);
  });

  it('property: within the limit or minimal, schema-valid, every text and picture kept', () => {
    const r = rng(2026);
    const levels = new Set<string>();
    for (let k = 0; k < 120; k++) {
      const objects: SlideObject[] = [];
      const n = 1 + Math.floor(r() * 40);
      for (let i = 0; i < n; i++) {
        const pick = r();
        if (pick < 0.35) objects.push(traced(i, r, 10 + Math.floor(r() * 800)));
        else if (pick < 0.75)
          objects.push({
            ...formatted(i, 1 + Math.floor(r() * 120), 50 + Math.floor(r() * 4_000)),
            id: id(`Q${k}_`, i),
          });
        else
          objects.push({
            id: id(`P${k}_`, i),
            type: 'image',
            box: box(r() * 1000, r() * 500, 10 + r() * 900, 10 + r() * 500),
            mediaId: id('M', i),
            fit: 'cover',
            opacity: 1,
            radius: 0,
            ...(r() < 0.3 ? { mask: { paths: [tracedPath(r, 100)] } } : {}),
          });
      }
      const slide = Slide.parse({ id: id('S', k), objects });
      const max = 2_000 + Math.floor(r() * 64 * KiB);
      const out = fitSlideBudget(slide, max);
      levels.add(out.level);
      expect(out.bytes).toBe(slideBytes(out.slide));
      if (out.level !== 'minimal') expect(out.bytes).toBeLessThanOrEqual(max);
      else if (out.bytes > max) {
        // Over the limit only when nothing more can go: no shape but tables, no formatting.
        expect(out.slide.objects.some((o) => o.type === 'shape' && !o.table)).toBe(false);
        expect(out.slide.objects.some((o) => o.type === 'text' && (o.runs || o.paras))).toBe(false);
      }
      expect(Slide.safeParse(out.slide).success).toBe(true);
      expect(textsOf(out.slide)).toEqual(textsOf(slide));
      const pictures = (s: Slide) => s.objects.filter((o) => o.type === 'image').map((o) => o.id);
      expect(pictures(out.slide)).toEqual(pictures(slide));
      expect(jsonBytes(slide)).toBe(slideBytes(Slide.parse(slide)));
    }
    expect([...levels].sort()).toEqual(['full', 'grid', 'minimal', 'plain']);
  });
});
