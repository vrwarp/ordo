/**
 * Q24.b, the first pre-render release: the converter keeps an ELIGIBLE slide whole (`budget.ts` `wholeSlide`):
 * with `BudgetOptions.whole` a slide with no anchor and at most `WHOLE_OBJECTS_MAX` planned objects skips the
 * guard and the picture limit, so nothing is left out for the screens' counts. Everything else is as before.
 */
import { createHash } from 'node:crypto';
import { PRERENDER_ANCHORED } from '@ordo/domain/prerender.ts';
import { describe, expect, it } from 'vitest';
import {
  type BudgetOptions,
  type BudgetPlan,
  budgetCost,
  fitBudgets,
  MAX_DRAWN_OBJECTS,
  sentToArt,
  WHOLE_ANCHORED,
  WHOLE_OBJECTS_MAX,
  wholeAnchorKinds,
  wholeSlide,
} from './budget.ts';
import { frameOf } from './frame.ts';
import { MAX_OBJECTS } from './emit.ts';
import { convertDeck, M9_FIELDS, type ParseOptions, parseDeck } from './index.ts';
import type { Background, Element, SlideScene } from './ir.ts';
import {
  body,
  buildDeck,
  CLRMAP_OVR,
  clipRels,
  grpSp,
  imageRel,
  mediaPic,
  para,
  pic,
  pngHeader,
  type RelSpec,
  run,
  solid,
  solidBg,
  sp,
  timingXml,
} from './test-util.ts';

const IN = 914_400;
const FRAME = frameOf(12_192_000, 6_858_000);
const NONE: Background = { fill: { kind: 'none' }, from: 'none' };
const log = () => {};
/** No sheets (what the hub and the client store until `decor-sheets`): every picture is its own object. */
const NO_SHEETS: ParseOptions = { sheets: false };
const NO_LO: ParseOptions = { libreoffice: false, sheets: false };
const WHOLE: ParseOptions = { wholeSlides: true, sheets: false };
const WHOLE_NO_LO: ParseOptions = { wholeSlides: true, libreoffice: false, sheets: false };

const TWO = ['336699', '993366'];
const textBox = (id: number, x = 0, y = 0) =>
  sp({ id, x: x * IN, y: y * IN, cx: IN, cy: IN / 4, txBox: true, txBody: body(para(run('Word'))) });
/** `n` squares 0.1 in wide in rows of 20 from (x, y) inches, of `colors` in turn, ids from `first`. */
function squares(n: number, first: number, colors = ['336699'], x = 0, y = 0, extra = '') {
  let out = '';
  for (let i = 0; i < n; i++)
    out += sp({
      id: first + i,
      x: (x + (i % 20) * 0.15) * IN,
      y: (y + Math.floor(i / 20) * 0.15) * IN,
      cx: 0.1 * IN,
      cy: 0.1 * IN,
      fill: solid(colors[i % colors.length]!) + extra,
    });
  return out;
}
const group = (id: number, inner: string) => grpSp({ id, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN }, inner);
const texts = (n: number, first = 10) => {
  let out = '';
  for (let i = 0; i < n; i++) out += textBox(first + i, (i % 10) * 1.2, Math.floor(i / 10) * 0.3);
  return out;
};
/** `n` small pictures, each of its own image file (`img<i>.png`), in rows from (0, 0). */
function pictures(n: number, first = 10): { shapes: string; rels: RelSpec[] } {
  let shapes = '';
  const rels: RelSpec[] = [];
  for (let i = 0; i < n; i++) {
    rels.push(imageRel(`rIdP${i}`, `img${i}.png`));
    shapes += pic({
      id: first + i,
      x: (i % 25) * 0.3 * IN,
      y: Math.floor(i / 25) * 0.3 * IN,
      cx: 0.25 * IN,
      cy: 0.25 * IN,
      rId: `rIdP${i}`,
    });
  }
  return { shapes, rels };
}
const deckOf = (shapes: string, rels: RelSpec[] = [], more: object = {}) =>
  buildDeck({ slides: [{ shapes, rels, ...more }] });

/** What a clip slide needs: a poster and a video file, `n` squares beside them. */
function videoDeck(o: {
  kind?: 'video' | 'audio';
  timing?: 'auto' | 'click';
  loop?: boolean;
  /** Text boxes beside the clip (nothing merges them: the guard's food). */
  texts?: number;
  /** A video over the whole slide, first (a motion background when it loops silently). */
  full?: boolean;
}) {
  const kind = o.kind ?? 'video';
  const media: Record<string, Uint8Array> = {
    'ppt/media/poster1.png': pngHeader(1920, 1080, true),
    'ppt/media/media1.mp4': new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
  };
  const rels: RelSpec[] = [
    imageRel('rIdP1', 'poster1.png'),
    ...clipRels(kind, 'media1.mp4', { embed: 'rIdE1', link: 'rIdL1' }),
  ];
  const box = o.full
    ? { x: 0, y: 0, cx: 12_192_000, cy: 6_858_000 }
    : { x: 2 * IN, y: IN, cx: 4 * IN, cy: 2.25 * IN };
  const shapes =
    mediaPic({ id: 4, kind, rId: 'rIdP1', embed: 'rIdE1', link: 'rIdL1', ...box }) + texts(o.texts ?? 0, 100);
  return buildDeck({
    slides: [
      {
        bg: solidBg('204060'),
        shapes,
        rels,
        after: `${CLRMAP_OVR}${timingXml([
          {
            spid: 4,
            kind,
            start: o.timing ?? 'auto',
            loop: o.loop ?? o.full ?? false,
            mute: true,
            rewind: false,
            showWhenStopped: false,
          },
        ])}`,
      },
    ],
    media,
  });
}

/** The marks the budgets leave on a scene's elements and its classification: what T1 pins. */
const marksOf = (s: SlideScene) => ({
  classification: s.classification,
  notes: s.notes,
  marks: s.elements.map((e) => [
    e.kind,
    (e as { merge?: number }).merge,
    e.decor,
    e.sheet,
    e.culled,
    e.hidden,
    e.support,
    e.reasons,
  ]),
});

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

describe('the option off is the base (T1)', () => {
  // Twelve slides of the base's own budget tests (merges, decorations, the guard with and without LibreOffice,
  // composites and the atlas off, no decorations): the plan and the marks as the base writes them.
  const fixtures: {
    name: string;
    deck: () => Map<string, Uint8Array>;
    opts: ParseOptions;
    recorded: string;
  }[] = [
    {
      name: 'one look in a group merges',
      deck: () => deckOf(group(2, squares(160, 10))),
      opts: NO_SHEETS,
      recorded: 'aec970ef482beceb',
    },
    {
      name: 'two looks in a group become decorations',
      deck: () => deckOf(group(2, squares(160, 10, TWO))),
      opts: NO_SHEETS,
      recorded: '8383100ec5995b8e',
    },
    {
      name: "the slide's own two looks, wide decorations",
      deck: () => deckOf(squares(160, 10, TWO)),
      opts: NO_SHEETS,
      recorded: '36bac256ee8845d1',
    },
    {
      name: 'a text slide past the guard, with LibreOffice',
      deck: () => deckOf(texts(208)),
      opts: NO_SHEETS,
      recorded: 'f9e9c77a6e7619d9',
    },
    {
      name: 'a text slide past the guard, without',
      deck: () => deckOf(texts(208)),
      opts: NO_LO,
      recorded: '242f5b0586706049',
    },
    {
      name: 'shapes then text past the guard, with LibreOffice',
      deck: () =>
        deckOf(
          texts(208) +
            squares(
              40,
              900,
              ['336699'],
              0,
              6.5,
              '<a:effectLst><a:glow rad="1"><a:srgbClr val="FF0000"/></a:glow></a:effectLst>',
            ),
        ),
      opts: NO_SHEETS,
      recorded: 'fce4a7c4bd955956',
    },
    {
      name: 'the same without LibreOffice',
      deck: () =>
        deckOf(
          texts(208) +
            squares(
              40,
              900,
              ['336699'],
              0,
              6.5,
              '<a:effectLst><a:glow rad="1"><a:srgbClr val="FF0000"/></a:glow></a:effectLst>',
            ),
        ),
      opts: NO_LO,
      recorded: '5191bad680361248',
    },
    {
      name: 'a layout of 160 squares under the slide text',
      deck: () =>
        buildDeck({ layouts: [{ shapes: squares(160, 10, TWO) }], slides: [{ shapes: textBox(2, 0, 5) }] }),
      opts: NO_SHEETS,
      recorded: '04cf7888e118e47d',
    },
    {
      name: '60 pictures of their own files, with LibreOffice',
      deck: () => {
        const p = pictures(60);
        return deckOf(p.shapes, p.rels);
      },
      opts: NO_SHEETS,
      recorded: '4f9884efaf20f840',
    },
    {
      name: '60 pictures without LibreOffice',
      deck: () => {
        const p = pictures(60);
        return deckOf(p.shapes, p.rels);
      },
      opts: NO_LO,
      recorded: '45ed5a7dd3986f46',
    },
    {
      name: 'no decorations: 220 squares, with LibreOffice',
      deck: () => deckOf(squares(220, 10, TWO)),
      opts: { ...NO_SHEETS, m9Writes: new Set(M9_FIELDS.filter((f) => f !== 'decor' && f !== 'decorFile')) },
      recorded: '14fb82af7f7bf7ac',
    },
    {
      name: 'a video slide with 205 text boxes, with LibreOffice',
      deck: () => videoDeck({ texts: 205 }),
      opts: NO_SHEETS,
      recorded: 'a7ab047690d5dc76',
    },
  ];

  it.each(fixtures)('$name: the plan, the marks and the emitted slide equal the recorded base', (f) => {
    const parts = f.deck();
    const parsed = parseDeck(parts, f.opts);
    const emitted = convertDeck(parts, f.opts).slides[0]!;
    // The off options (absent, false, 'motion') change nothing either.
    const off = parseDeck(f.deck(), { ...f.opts, wholeSlides: false, wholeAnchors: 'motion' });
    expect(marksOf(off.slides[0]!)).toEqual(marksOf(parsed.slides[0]!));
    const slide = {
      objects: emitted.slide.objects.map(({ id: _id, ...rest }) => rest),
      class: emitted.classification.class,
      reasons: emitted.classification.reasons,
      missing: emitted.missing,
      art: emitted.art?.elements.length,
      notes: emitted.notes,
    };
    expect(sha({ marks: marksOf(parsed.slides[0]!), slide })).toBe(f.recorded);
  });

  it('a plan without the option says it kept nothing whole and names no anchor', () => {
    const elements = rectsOf(300);
    const plan = fitBudgets({ frame: FRAME, log }, elements, NONE, {});
    expect(plan.whole).toBe(false);
    expect(plan.anchorKinds).toEqual([]);
  });
});

/** `n` plain squares as IR elements (no clip, no text), 0.1 in apart. */
function rectsOf(n: number, from: 'slide' | 'layout' = 'slide'): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < n; i++)
    out.push({
      kind: 'shape',
      shapeId: i + 1,
      name: '',
      xf: [IN / 10, 0, 0, IN / 10, (i % 100) * (IN / 8), Math.floor(i / 100) * (IN / 8)],
      from,
      support: 'native',
      geom: 'rect',
      fill: { kind: 'solid', color: { r: 10 + (i % 2) * 90, g: 20, b: 30, a: 1 } },
    } as unknown as Element);
  return out;
}
/** `n` pictures of `n` different parts, as IR elements. */
function picturesOf(n: number): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < n; i++)
    out.push({
      kind: 'picture',
      shapeId: i + 1,
      name: '',
      xf: [IN / 10, 0, 0, IN / 10, (i % 100) * (IN / 8), Math.floor(i / 100) * (IN / 8)],
      from: 'slide',
      support: 'native',
      geom: 'rect',
      picture: { part: `ppt/media/img${i}.png` },
    } as unknown as Element);
  return out;
}
/** A clip poster: a picture of a video (or a sound) with its part, from the slide, a layout or a master. */
function clip(
  media: { kind: 'video' | 'audio'; part?: string; external?: string },
  from: 'slide' | 'layout' | 'master' = 'slide',
  hidden = false,
): Element {
  return {
    kind: 'picture',
    shapeId: 9_999,
    name: '',
    xf: [IN, 0, 0, IN, 0, 0],
    from,
    support: 'native',
    geom: 'rect',
    picture: { part: 'ppt/media/poster.png' },
    media,
    ...(hidden ? { hidden: true } : {}),
  } as unknown as Element;
}
const plan = (elements: Element[], opts: BudgetOptions = {}, bg: Background = NONE): BudgetPlan =>
  fitBudgets({ frame: FRAME, log }, elements, bg, { sheets: false, ...opts });

describe('a crowded slide is kept whole (T2, T3)', () => {
  it('T2: 400 pictures of 400 files: nothing left out, nothing in the art, all 400 planned', () => {
    const e = picturesOf(400);
    const p = plan(e, { whole: true });
    expect(p.whole).toBe(true);
    expect(p.anchorKinds).toEqual([]);
    expect(p.left).toBe(0);
    expect(p.art).toBe(0);
    expect(p.pictures).toBe(400);
    expect(p.objects).toBe(400);
    expect(e.some((x) => x.culled === 'budget' || x.hidden || sentToArt(x))).toBe(false);
    expect(p.atlas).toEqual([]);
    // Without the option the same slide is cut to what the screens draw: the picture limit and the guard.
    const base = picturesOf(400);
    const b = plan(base, {});
    expect(b.whole).toBe(false);
    expect(b.art).toBeGreaterThan(300);
    expect(base.filter(sentToArt).length).toBe(b.art);
    // And without LibreOffice they are listed, not drawn.
    const nolo = picturesOf(400);
    const n = plan(nolo, { libreoffice: false });
    expect(n.left).toBeGreaterThan(300);
    const nw = picturesOf(400);
    expect(plan(nw, { libreoffice: false, whole: true })).toMatchObject({ whole: true, left: 0, art: 0 });
  });

  it('T3: 200 shapes without text and 210 text boxes are all kept, the text ceiling and the guard skipped', () => {
    const shapes = rectsOf(200).map(
      (x, i) =>
        ({
          ...x,
          xf: [IN / 10, 0, 0, IN / 10, (i % 50) * IN, 2 * IN + Math.floor(i / 50) * IN],
        }) as unknown as Element,
    );
    const text: Element[] = [];
    for (let i = 0; i < 210; i++)
      text.push({
        kind: 'shape',
        shapeId: 1_000 + i,
        name: '',
        xf: [IN, 0, 0, IN / 4, (i % 10) * IN, Math.floor(i / 10) * (IN / 3)],
        from: 'slide',
        support: 'native',
        geom: 'rect',
        fill: { kind: 'none' },
        text: { paras: [{ runs: [{ kind: 'text', text: 'Word' }] }] },
      } as unknown as Element);
    const e = [...shapes, ...text];
    const p = plan(e, { whole: true });
    expect(p).toMatchObject({ whole: true, left: 0, art: 0 });
    expect(p.objects).toBeGreaterThan(MAX_DRAWN_OBJECTS);
    expect(e.some((x) => x.hidden || sentToArt(x))).toBe(false);
    // The base cuts the same slide.
    const base = [...rectsOf(200), ...text.map((x) => structuredClone(x))];
    expect(plan(base, { libreoffice: false }).left).toBeGreaterThan(0);
    // The end to end of it: a real deck, every shape and every text box emitted.
    const out = convertDeck(deckOf(squares(200, 10, TWO) + texts(210, 500)), WHOLE_NO_LO).slides[0]!;
    expect(out.missing).toBeUndefined();
    expect(out.slide.objects.filter((o) => o.type === 'text')).toHaveLength(210);
    expect(out.slide.objects.length).toBeGreaterThan(MAX_DRAWN_OBJECTS);
  });
});

describe('the reliefs run as before (T4)', () => {
  it('300 shapes of one look merge by look exactly as without the option, and a 160-object slide is identical', () => {
    const parts = () => deckOf(group(2, squares(300, 10)));
    const base = parseDeck(parts(), NO_SHEETS).slides[0]!;
    const whole = parseDeck(parts(), WHOLE).slides[0]!;
    expect(marksOf(whole)).toEqual(marksOf(base));
    expect(whole.elements.every((e) => (e as { merge?: number }).merge !== undefined)).toBe(true);
    // 160 objects: past the 150 budget only by its first relief, identical either way.
    const small = () => deckOf(squares(160, 10, TWO));
    expect(marksOf(parseDeck(small(), WHOLE).slides[0]!)).toEqual(
      marksOf(parseDeck(small(), NO_SHEETS).slides[0]!),
    );
    // Within the budget nothing is touched either.
    const within = () => deckOf(squares(140, 10, TWO));
    expect(marksOf(parseDeck(within(), WHOLE).slides[0]!)).toEqual(
      marksOf(parseDeck(within(), NO_SHEETS).slides[0]!),
    );
    expect(emittedJson(within(), WHOLE)).toEqual(emittedJson(within(), NO_SHEETS));
  });
});
const emittedJson = (parts: Map<string, Uint8Array>, opts: ParseOptions) =>
  JSON.stringify(convertDeck(parts, opts).slides[0]!.slide.objects.map(({ id: _id, ...rest }) => rest));

describe('anchors keep a slide out (T5, T6, T8)', () => {
  const crowd = () => picturesOf(300);

  it('T5: a video with a part from the slide is an anchor; an audio clip, a linked or missing clip and a layout or master video are not', () => {
    const cases: [string, Element, boolean][] = [
      ['video with a part', clip({ kind: 'video', part: 'ppt/media/m.mp4' }), true],
      ['audio with a part', clip({ kind: 'audio', part: 'ppt/media/m.mp3' }), false],
      ['linked video', clip({ kind: 'video', external: 'example.test' }), false],
      ['missing video (no part)', clip({ kind: 'video' }), false],
      ['video of the layout', clip({ kind: 'video', part: 'ppt/media/m.mp4' }, 'layout'), false],
      ['video of the master', clip({ kind: 'video', part: 'ppt/media/m.mp4' }, 'master'), false],
      ['hidden video', clip({ kind: 'video', part: 'ppt/media/m.mp4' }, 'slide', true), false],
    ];
    for (const [name, e, anchor] of cases) {
      const els = [...crowd(), e];
      const p = plan(els, { whole: true });
      expect(p.whole, name).toBe(!anchor);
      expect(p.anchorKinds, name).toEqual(anchor ? ['clip'] : []);
      expect(wholeAnchorKinds(els, NONE, { whole: true }), name).toEqual(anchor ? ['clip'] : []);
    }
    // An anchored slide is planned as today, whole or not: LibreOffice's art draws what the guard leaves out.
    const anchored = [...crowd(), clip({ kind: 'video', part: 'ppt/media/m.mp4' })];
    const p = plan(anchored, { whole: true });
    expect(p.art).toBeGreaterThan(200);
    // End to end: a video with its timing keeps the slide's guard (a hybrid with the art, as today), an audio clip does not.
    const withVideo = convertDeck(videoDeck({ texts: 230 }), WHOLE).slides[0]!;
    const noWhole = convertDeck(videoDeck({ texts: 230 }), NO_SHEETS).slides[0]!;
    expect(JSON.stringify(withVideo.classification)).toBe(JSON.stringify(noWhole.classification));
    expect(withVideo.slide.objects.length).toBe(noWhole.slide.objects.length);
    const withAudio = convertDeck(videoDeck({ kind: 'audio', texts: 230 }), WHOLE).slides[0]!;
    expect(withAudio.slide.objects.length).toBeGreaterThan(noWhole.slide.objects.length);
  });

  it('T6: the default is "motion": a picture background is no anchor; "own" makes it one; a motion background is one under both', () => {
    const pictureBg: Background = {
      fill: { kind: 'picture', picture: { part: 'ppt/media/bg.png' } } as Background['fill'],
      from: 'slide',
    };
    const d = plan(crowd(), { whole: true }, pictureBg);
    expect(d).toMatchObject({ whole: true, anchorKinds: [] });
    expect(plan(crowd(), { whole: true, anchors: 'motion' }, pictureBg).whole).toBe(true);
    const own = plan(crowd(), { whole: true, anchors: 'own' }, pictureBg);
    expect(own.whole).toBe(false);
    expect(own.anchorKinds).toEqual(['background']);
    // 'own' keeps a slide out only for a picture; a plain colour is no background of its own.
    const solidBg2: Background = {
      fill: { kind: 'solid', color: { r: 1, g: 2, b: 3, a: 1 } },
      from: 'slide',
    };
    expect(plan(crowd(), { whole: true, anchors: 'own' }, solidBg2).whole).toBe(true);
    // A background from the layout or master is not the slide's own.
    const layoutBg: Background = { ...pictureBg, from: 'layout' };
    expect(plan(crowd(), { whole: true, anchors: 'own' }, layoutBg).whole).toBe(true);
    // A motion background (a video over the whole slide) is a clip: out under both arms.
    const motion = [...crowd(), clip({ kind: 'video', part: 'ppt/media/loop.mp4' })];
    for (const anchors of ['motion', 'own'] as const)
      expect(plan(motion, { whole: true, anchors }).anchorKinds, anchors).toEqual(['clip']);
    // Through the parse: a looping muted video over the whole slide, and a crowd, is the same slide as today.
    const loop = parseDeck(videoDeck({ full: true, texts: 230 }), { ...WHOLE, wholeAnchors: 'motion' })
      .slides[0]!;
    const base = parseDeck(videoDeck({ full: true, texts: 230 }), NO_SHEETS).slides[0]!;
    expect(marksOf(loop)).toEqual(marksOf(base));
  });

  it('T8: the gate "anchored" keeps a clip slide whole (the hook of Q24.a); the converter default is easy-plan\'s constant', () => {
    expect(WHOLE_ANCHORED).toBe(PRERENDER_ANCHORED);
    const e = [...crowd(), clip({ kind: 'video', part: 'ppt/media/m.mp4' })];
    expect(plan(e, { whole: true, anchored: true })).toMatchObject({
      whole: true,
      anchorKinds: [],
      left: 0,
      art: 0,
    });
    expect(wholeSlide(e, NONE, { whole: true, anchored: true })).toBe(true);
    expect(wholeSlide(e, NONE, { whole: true })).toBe(false);
    // The gate lifts a background anchor too.
    const bg: Background = {
      fill: { kind: 'picture', picture: { part: 'ppt/media/bg.png' } } as Background['fill'],
      from: 'slide',
    };
    expect(plan(crowd(), { whole: true, anchors: 'own', anchored: true }, bg).whole).toBe(true);
    // And without `whole` the gate does nothing.
    expect(plan([...crowd()], { anchored: true }).whole).toBe(false);
  });
});

describe('the bound (T7)', () => {
  it("the inline bound is the converter's MAX_OBJECTS", () => {
    expect(WHOLE_OBJECTS_MAX).toBe(MAX_OBJECTS);
    expect(WHOLE_OBJECTS_MAX).toBe(1_000);
  });

  it('1,000 planned objects are kept whole, 1,001 are planned as today: art with LibreOffice, listed without', () => {
    // Distinct pictures, so no relief merges any of them: the planned objects are the elements.
    const ok = picturesOf(1_000);
    expect(plan(ok, { whole: true })).toMatchObject({ whole: true, objects: 1_000, art: 0, left: 0 });
    expect(wholeSlide(picturesOf(1_000), NONE, { whole: true })).toBe(true);
    const over = picturesOf(1_001);
    const lo = plan(over, { whole: true });
    expect(lo.whole).toBe(false);
    expect(lo.anchorKinds).toEqual(['bound']);
    expect(lo.art).toBeGreaterThan(0);
    expect(lo.left).toBe(0);
    const base = plan(picturesOf(1_001), {});
    expect(lo.art).toBe(base.art);
    const nolo = plan(picturesOf(1_001), { whole: true, libreoffice: false });
    expect(nolo.whole).toBe(false);
    expect(nolo.anchorKinds).toEqual(['bound']);
    expect(nolo.left).toBeGreaterThan(0);
    expect(nolo.art).toBe(0);
    expect(nolo.left).toBe(plan(picturesOf(1_001), { libreoffice: false }).left);
    // An anchor and the bound together name both.
    const both = plan([...picturesOf(1_001), clip({ kind: 'video', part: 'ppt/media/m.mp4' })], {
      whole: true,
    });
    expect([...both.anchorKinds].sort()).toEqual(['bound', 'clip']);
  });

  it('the bound counts the plan after the reliefs, not the elements: 1,200 shapes of one look merge to a few objects and stay whole', () => {
    const e = rectsOf(1_200);
    const p = plan(e, { whole: true });
    expect(p.whole).toBe(true);
    expect(p.objects).toBeLessThan(150);
    expect(budgetCost(e, NONE, undefined, p.atlas).objects).toBe(p.objects);
  });
});

describe('an emitted whole slide (T9)', () => {
  it('a 400-picture slide: 400 image objects, class native, no art, nothing missing, no note about the budget', () => {
    const p = pictures(400);
    const parts = () => deckOf(p.shapes, p.rels);
    const whole = convertDeck(parts(), WHOLE).slides[0]!;
    expect(whole.classification.class).toBe('native');
    expect(whole.art).toBeUndefined();
    expect(whole.missing).toBeUndefined();
    expect(whole.slide.objects.filter((o) => o.type === 'image')).toHaveLength(400);
    expect(whole.notes.some((n) => /past the slide's budgets/.test(n))).toBe(false);
    // Without the option: the 16 the screens draw, the rest LibreOffice's art, or listed without it.
    const lo = convertDeck(parts(), NO_SHEETS).slides[0]!;
    expect(lo.slide.objects.filter((o) => o.type === 'image').length).toBeLessThanOrEqual(16);
    expect(lo.art?.elements.length ?? 0).toBeGreaterThan(300);
    const nolo = convertDeck(parts(), NO_LO).slides[0]!;
    expect(nolo.slide.objects.filter((o) => o.type === 'image').length).toBeLessThanOrEqual(16);
    expect(nolo.missing).toEqual(['decoration']);
    const wholeNoLo = convertDeck(parts(), WHOLE_NO_LO).slides[0]!;
    expect(wholeNoLo.slide.objects.filter((o) => o.type === 'image')).toHaveLength(400);
    expect(wholeNoLo.missing).toBeUndefined();
  });
});

describe('never throws (T10)', () => {
  it('wholeSlide and wholeAnchorKinds read junk elements without throwing (100 runs)', () => {
    // A positive control: a bare slide of squares is kept whole, so the junk below is what is tested.
    expect(wholeSlide(rectsOf(10), NONE, { whole: true })).toBe(true);
    let seed = 11;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 1_000_000) / 1_000_000;
    };
    const junk: unknown[] = [
      null,
      undefined,
      3,
      'x',
      [],
      {},
      { kind: 'picture' },
      { kind: 'picture', media: null },
      { kind: 'picture', media: { kind: 'video' } },
      { kind: 'shape', fill: null },
    ];
    for (let run = 0; run < 100; run++) {
      const n = Math.floor(rand() * 40);
      const els: Element[] = [];
      for (let i = 0; i < n; i++) {
        const r = rand();
        if (r < 0.5) els.push(junk[Math.floor(rand() * junk.length)] as Element);
        else if (r < 0.7)
          els.push(
            clip(
              { kind: rand() < 0.5 ? 'video' : 'audio', ...(rand() < 0.5 ? { part: 'p' } : {}) },
              rand() < 0.5 ? 'slide' : 'layout',
            ),
          );
        else els.push(...rectsOf(1 + Math.floor(rand() * 5)));
      }
      const bg = (rand() < 0.3 ? junk[Math.floor(rand() * junk.length)] : NONE) as Background;
      const opts: BudgetOptions = {
        whole: rand() < 0.8,
        anchors: rand() < 0.5 ? 'own' : 'motion',
        anchored: rand() < 0.2,
      };
      expect(() => wholeSlide(els, bg, opts)).not.toThrow();
      expect(() => wholeAnchorKinds(els, bg, opts)).not.toThrow();
      expect(typeof wholeSlide(els, bg, opts)).toBe('boolean');
    }
  });
});
