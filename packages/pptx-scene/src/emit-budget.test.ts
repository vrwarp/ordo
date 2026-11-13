/**
 * The converter's steps of the budget ladder (design/27 §3.4, M9 `ladder`): `compactRuns` is lossless (the
 * text engine lays out and paints the compacted object exactly as the original), and no budget makes a
 * slide picture class.
 */
import type { TextObject, TextRun, TextStyle } from '@ordo/domain';
import { LEGACY_FONT_ENV } from '@ordo/renderer/text/fonts.ts';
import { paintPlan } from '@ordo/renderer/text/paint.ts';
import { clampTextObject, layoutRich } from '@ordo/renderer/text/rich.ts';
import { testMeasurer } from '@ordo/renderer/text/test-util.ts';
import { describe, expect, it } from 'vitest';
import { compactRuns, TEXT_BUDGET_BYTES } from './emit-budget.ts';
import { emitSlides, parseDeck } from './index.ts';
import { body, buildDeck, para, run, solid, sp } from './test-util.ts';

/** A seeded generator (mulberry32). */
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

const WORDS = [
  'Amazing ',
  'grace, ',
  'how ',
  'sweet ',
  'the ',
  'sound\n',
  'that ',
  'saved ',
  'a ',
  'wretch ',
];
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const GOLD = { r: 200, g: 160, b: 60, a: 1 };

function boxStyle(r: () => number): TextStyle {
  return {
    fontFamily: 'Calibri',
    fontWeight: r() < 0.5 ? 400 : 700,
    fontStyle: r() < 0.5 ? 'normal' : 'italic',
    fontSizePx: 20 + Math.floor(r() * 30),
    color: r() < 0.5 ? BLACK : GOLD,
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    letterSpacing: r() < 0.5 ? 0 : 1.5,
    padding: 0,
    transform: r() < 0.3 ? 'uppercase' : 'none',
    lineModel: 'office',
    lang: 'en-US',
    ...(r() < 0.4 ? { outline: { width: 1, color: GOLD } } : {}),
    ...(r() < 0.4 ? { shadow: { dx: 2, dy: 2, blur: 3, color: BLACK } } : {}),
    ...(r() < 0.3 ? { underline: true } : {}),
  };
}

/** A run over [start, end): each field the box's own value, a real override, or absent. */
function runOf(r: () => number, st: TextStyle, start: number, end: number): TextRun {
  const pick = <T>(same: T, other: T): T | undefined => {
    const x = r();
    return x < 0.4 ? same : x < 0.6 ? other : undefined;
  };
  const run: TextRun = { start, end };
  const set = <K extends keyof TextRun>(k: K, v: TextRun[K] | undefined) => {
    if (v !== undefined) run[k] = v;
  };
  set('fontFamily', pick(st.fontFamily, 'Georgia'));
  set('fontWeight', pick(st.fontWeight, st.fontWeight === 700 ? 400 : 700));
  set('fontStyle', pick(st.fontStyle, st.fontStyle === 'italic' ? 'normal' : 'italic'));
  set('sizeScale', pick(1, 0.6));
  set('color', pick({ ...st.color }, { r: 0, g: 128, b: 255, a: 1 }));
  set('underline', pick(st.underline ?? false, !(st.underline ?? false)));
  set('strike', pick(false, true));
  set('baseline', pick(0, 0.3));
  set('letterSpacing', pick(st.letterSpacing, 4));
  set('caps', pick(st.transform === 'uppercase' ? 'all' : 'none', 'small'));
  set('outline', pick(st.outline ? { ...st.outline, color: { ...st.outline.color } } : null, null));
  set(
    'shadow',
    pick(st.shadow ? { ...st.shadow, color: { ...st.shadow.color } } : null, {
      dx: 1,
      dy: 1,
      blur: 0,
      color: GOLD,
    }),
  );
  set('lang', pick(st.lang ?? '', 'de-DE'));
  if (r() < 0.2) run.highlight = { r: 255, g: 255, b: 0, a: 1 };
  return run;
}

function textObject(r: () => number, k: number): TextObject {
  let text = '';
  const n = 5 + Math.floor(r() * 30);
  for (let i = 0; i < n; i++) text += WORDS[Math.floor(r() * WORDS.length)];
  const style = boxStyle(r);
  if (r() < 0.2)
    style.paint = {
      kind: 'linear',
      angle: 90,
      stops: [
        { at: 0, color: GOLD },
        { at: 1, color: BLACK },
      ],
    };
  const runs: TextRun[] = [];
  for (let at = 0; at < text.length; ) {
    const len = 1 + Math.floor(r() * 12);
    if (r() < 0.75) runs.push(runOf(r, style, at, Math.min(text.length, at + len)));
    at += len + (r() < 0.3 ? Math.floor(r() * 5) : 0);
  }
  return {
    id: `t${k}`,
    type: 'text',
    box: { x: 0, y: 0, w: 300 + r() * 600, h: 400, rotation: 0 },
    text,
    style,
    opacity: 1,
    runs,
    paras: [{ align: 'center' }, null, { spaceBeforePx: 6 }],
  };
}

describe('compactRuns (plan decision 14)', () => {
  it('compactRuns is lossless: layoutRich output identical', () => {
    const r = rng(14);
    let dropped = 0;
    let before = 0;
    for (let k = 0; k < 300; k++) {
      const o = textObject(r, k);
      const copy: TextObject = structuredClone(o);
      const out = compactRuns(copy);
      expect(out).toBe(copy);
      // Every run kept with its range: the engine cuts its pieces at run ends.
      expect(copy.runs!.map((x) => [x.start, x.end])).toEqual(o.runs!.map((x) => [x.start, x.end]));
      const a = clampTextObject(o);
      const b = clampTextObject(copy);
      // Letter spacing between the characters of a measured piece only: a moved cut would change widths.
      const m = () =>
        testMeasurer({ advance: (ch, px) => (ch === ' ' ? 0.25 : 0.5 + (ch.charCodeAt(0) % 7) / 20) * px });
      const la = layoutRich(m(), a, LEGACY_FONT_ENV);
      const lb = layoutRich(m(), b, LEGACY_FONT_ENV);
      expect(lb).toEqual(la);
      expect(paintPlan(b, lb)).toEqual(paintPlan(a, la));
      before += JSON.stringify(o.runs).length;
      dropped += JSON.stringify(o.runs).length - JSON.stringify(copy.runs).length;
    }
    // The generated runs carry the box's values often: a third or more of their JSON goes.
    expect(dropped / before).toBeGreaterThan(0.3);
  });

  it('keeps what is not the box style, and a gradient box keeps its runs colours', () => {
    const style: TextStyle = {
      fontFamily: 'Calibri',
      fontWeight: 400,
      fontStyle: 'normal',
      fontSizePx: 40,
      color: BLACK,
      align: 'left',
      valign: 'top',
      lineHeight: 1.2,
      letterSpacing: 0,
      padding: 0,
      transform: 'none',
      lang: 'en-GB',
    };
    const o: TextObject = {
      id: 't',
      type: 'text',
      box: { x: 0, y: 0, w: 500, h: 100, rotation: 0 },
      text: 'Holy holy holy',
      style,
      opacity: 1,
      runs: [
        {
          start: 0,
          end: 4,
          fontFamily: 'Calibri',
          color: { ...BLACK },
          lang: 'en-GB',
          outline: null,
          shadow: null,
        },
        { start: 5, end: 9, fontWeight: 950, color: GOLD, lang: 'fr-FR', outline: null },
        { start: 10, end: 14, sizeScale: 1, strike: false, baseline: 0, caps: 'none', underline: false },
      ],
    };
    compactRuns(o);
    expect(o.runs).toEqual([
      { start: 0, end: 4 },
      // A weight both clamps may move is kept; a real override is kept.
      { start: 5, end: 9, fontWeight: 950, color: GOLD, lang: 'fr-FR' },
      { start: 10, end: 14 },
    ]);
    const painted: TextObject = {
      ...o,
      style: {
        ...style,
        paint: {
          kind: 'linear',
          angle: 0,
          stops: [
            { at: 0, color: GOLD },
            { at: 1, color: BLACK },
          ],
        },
      },
      runs: [{ start: 0, end: 4, color: { ...BLACK } }],
    };
    compactRuns(painted);
    expect(painted.runs).toEqual([{ start: 0, end: 4, color: BLACK }]);
    // Nothing to do: no runs, or none at all.
    const bare: TextObject = { ...o, runs: undefined };
    expect(compactRuns(bare)).toBe(bare);
  });

  it("finds nothing to drop in the converter's own runs, which already say only what differs", () => {
    const runs = ['FF0000', '00FF00', '0000FF']
      .map((c, i) => run(`word${i} `, i === 1 ? 'b="1"' : '', solid(c)))
      .join('');
    const out = emitSlides(
      parseDeck(
        buildDeck({
          slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: 914_400, cy: 914_400, txBody: body(para(runs)) }) }],
        }),
      ),
    );
    const t = out.slides[0]!.slide.objects.find((o): o is TextObject => o.type === 'text')!;
    expect(t.runs?.length).toBeGreaterThan(0);
    const again = structuredClone(t);
    compactRuns(again);
    expect(again).toEqual(t);
  });
});

describe('the converter never makes a picture for a budget (M9)', () => {
  it('writes formatting up to the text budget, then plain text; the class stays and the slide is flagged', () => {
    const colors = ['FF0000', '00FF00'];
    const runs = Array.from({ length: 300 }, (_, i) => run(`w${i} `, '', solid(colors[i % 2]!))).join('');
    const box = (id: number) => sp({ id, x: 0, y: 0, cx: 914_400, cy: 914_400, txBody: body(para(runs)) });
    const boxes = Array.from({ length: 80 }, (_, i) => box(i + 2)).join('');
    const s = emitSlides(parseDeck(buildDeck({ slides: [{ shapes: boxes }] }))).slides[0]!;
    const texts = s.slide.objects.filter((o): o is TextObject => o.type === 'text');
    const formatted = texts.filter((t) => t.runs);
    // About TEXT_BUDGET_BYTES of formatted text, then the rest plain.
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted.length).toBeLessThan(texts.length);
    const formattedBytes = formatted.reduce((n, t) => n + JSON.stringify(t).length, 0);
    expect(formattedBytes).toBeGreaterThan(TEXT_BUDGET_BYTES - 20_000);
    expect(s.classification.class).not.toBe('picture');
    expect(s.classification.reasons.join(' ')).not.toMatch(/KB/);
    expect(s.overBudget).toBe(true);
  });
});
