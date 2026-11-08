/**
 * The editor's text ops (M4 item A; design/27 §11 items 1-4 and "Themes", §14 item 9): formatting a
 * selection, Size ±, the paragraph strip, what the format bar and the strip show, 'Re-fit text', a theme
 * keeping structural run formatting, and `editText` keeping the stored fit scale while the text fits
 * (proved through the rich engine's `layoutRich` with a fixed-width measurer). The random sequences are in
 * `textOps.fuzz.test.ts`.
 */
import { DEFAULT_THEME, type Presentation, type Slide, type TextObject, type TextStyle } from '@ordo/domain';
import { clampTextObject, FontResolver, LEGACY_FONT_ENV, layoutRich } from '@ordo/renderer';
import { testMeasurer } from '@ordo/renderer/text/test-util.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import * as actions from '../src/views/editor/actions.ts';
import { openPresentation, selectSlide, undo, useEditor } from '../src/views/editor/editorStore.ts';
import { applyTheme, getSlide } from '../src/views/editor/ops.ts';
import {
  CLEAR_FORMATTING,
  editText,
  formatRange,
  refitText,
  resizeRange,
  runOverrides,
  selectionParas,
  selectionStyle,
  setParas,
  textOnSlide,
  themedRuns,
  VISUAL_RUN_FIELDS,
} from '../src/views/editor/ops/text.ts';

const RED = { r: 200, g: 40, b: 40, a: 1 };
const BLUE = { r: 20, g: 60, b: 200, a: 1 };
const box = { x: 100, y: 100, w: 800, h: 300, rotation: 0 };

function text(t: string, extra: Partial<TextObject> = {}, style: Partial<TextStyle> = {}): TextObject {
  return {
    id: 't1',
    type: 'text',
    box,
    text: t,
    style: { ...DEFAULT_THEME.textBoxDefaults, ...style },
    opacity: 1,
    ...extra,
  };
}

/** "Potluck on Sunday 12 May\nBring a dish": the date bold and red, in a shrink-to-fit box. */
const announcement = () =>
  text(
    'Potluck on Sunday 12 May\nBring a dish',
    { runs: [{ start: 11, end: 24, fontWeight: 700, color: RED }], paras: [{ align: 'center' }] },
    { autofit: 'shrink', fitScale: { font: 0.9, spacing: 1 } },
  );

describe('formatRange', () => {
  it('formats a selection of a plain object, which becomes rich (runs, no paragraph styles)', () => {
    const o = text('Amazing grace');
    const b = formatRange(o, 0, 7, { fontWeight: 700 });
    expect(b.runs).toEqual([{ start: 0, end: 7, fontWeight: 700 }]);
    expect(b.paras).toBeUndefined();
    expect(b.style).toBe(o.style);
  });

  it('splits runs at the range, merges equal neighbours and drops runs that set nothing', () => {
    const o = text('Amazing grace how sweet');
    const a = formatRange(formatRange(o, 0, 7, { fontWeight: 700 }), 7, 13, { fontWeight: 700 });
    expect(a.runs).toEqual([{ start: 0, end: 13, fontWeight: 700 }]);
    // Un-bolding the middle of a bold run splits it in two.
    const split = formatRange(a, 3, 9, { fontWeight: undefined });
    expect(split.runs).toEqual([
      { start: 0, end: 3, fontWeight: 700 },
      { start: 9, end: 13, fontWeight: 700 },
    ]);
    // Colouring across a run edge: the run is cut, the coloured parts get the colour, the gap a new run.
    const c = formatRange(split, 1, 11, { color: RED });
    expect(c.runs).toEqual([
      { start: 0, end: 1, fontWeight: 700 },
      { start: 1, end: 3, fontWeight: 700, color: RED },
      { start: 3, end: 9, color: RED },
      { start: 9, end: 11, fontWeight: 700, color: RED },
      { start: 11, end: 13, fontWeight: 700 },
    ]);
    // Clear formatting over everything leaves no run, but keeps `runs` (the object stays rich).
    expect(formatRange(c, 0, c.text.length, CLEAR_FORMATTING).runs).toEqual([]);
  });

  it('leaves characters outside the range as they were', () => {
    const o = announcement();
    const ital = formatRange(o, 0, 7, { fontStyle: 'italic' });
    expect(ital.runs).toEqual([{ start: 0, end: 7, fontStyle: 'italic' }, o.runs![0]]);
    expect(ital.runs![1]).toBe(o.runs![0]);
    expect(ital.paras).toBe(o.paras);
  });

  it('raises verse numbers: superscript is baseline 0.3, subscript -0.25, and 0 removes it', () => {
    const o = text('16 For God so loved the world');
    const sup = formatRange(o, 0, 2, { baseline: 0.3 });
    expect(sup.runs).toEqual([{ start: 0, end: 2, baseline: 0.3 }]);
    expect(formatRange(sup, 0, 2, { baseline: -0.25 }).runs).toEqual([{ start: 0, end: 2, baseline: -0.25 }]);
    expect(formatRange(sup, 0, 2, { baseline: 0 }).runs).toEqual([]);
  });

  it('returns the object itself when nothing changes', () => {
    const o = announcement();
    expect(formatRange(o, 5, 5, { fontWeight: 700 })).toBe(o);
    expect(formatRange(o, 11, 24, { fontWeight: 700, color: { ...RED } })).toBe(o);
    expect(formatRange(o, 0, 11, { color: undefined, underline: undefined })).toBe(o);
    expect(formatRange(o, 0, 5, {})).toBe(o);
    // Values that are none (a zero size, a colour that is not RGBA, an unknown style) are left out.
    const bad = { sizeScale: 0, color: { r: 'x' }, fontStyle: 'oblique' } as never;
    expect(formatRange(o, 0, 5, bad)).toBe(o);
    const plain = text('abc');
    expect(formatRange(plain, 0, 3, CLEAR_FORMATTING)).toBe(plain);
  });

  it('bounds values as the schema does, and a box-sized scale removes the override', () => {
    const o = text('abcdef');
    const f = formatRange(o, 0, 3, {
      sizeScale: 80,
      baseline: 2,
      letterSpacing: -5000,
      color: { r: 300, g: -1, b: 10, a: 2 },
    });
    expect(f.runs).toEqual([
      {
        start: 0,
        end: 3,
        sizeScale: 50,
        baseline: 1,
        letterSpacing: -1000,
        color: { r: 255, g: 0, b: 10, a: 1 },
      },
    ]);
    expect(formatRange(f, 0, 3, { sizeScale: 1 }).runs![0]!.sizeScale).toBeUndefined();
    expect(formatRange(o, 0, 3, { fontFamily: '' })).toBe(o);
    expect(formatRange(o, 0, 3, { fontFamily: 'x'.repeat(301) })).toBe(o);
    expect(formatRange(o, 0, 3, { outline: null, shadow: null }).runs).toEqual([
      { start: 0, end: 3, outline: null, shadow: null },
    ]);
  });

  it('clamps the range to the text and never cuts a surrogate pair', () => {
    const o = text('a😀b');
    expect(formatRange(o, 2, 99, { strike: true }).runs).toEqual([{ start: 1, end: 4, strike: true }]);
    expect(formatRange(o, -5, 2, { strike: true }).runs).toEqual([{ start: 0, end: 3, strike: true }]);
    expect(formatRange(o, Number.NaN, 1, { strike: true }).runs).toEqual([
      { start: 0, end: 1, strike: true },
    ]);
  });

  it('refuses a change past 2,000 runs, and allows one that merges back to 2,000', () => {
    const crowded = text('x'.repeat(4001), {
      runs: Array.from({ length: 2000 }, (_, i) => ({ start: 2 * i, end: 2 * i + 1, strike: true })),
    });
    expect(formatRange(crowded, 4000, 4001, { strike: true })).toBe(crowded);
    const merged = formatRange(crowded, 3999, 4001, { strike: true });
    expect(merged.runs).toHaveLength(2000);
    expect(merged.runs!.at(-1)).toEqual({ start: 3998, end: 4001, strike: true });
  });
});

describe('resizeRange', () => {
  it('scales the selection relative to the box size and back exactly', () => {
    const o = text('Holy holy holy', {}, { fontSizePx: 40 });
    const up = resizeRange(o, 0, 4, 1.25);
    expect(up.runs).toEqual([{ start: 0, end: 4, sizeScale: 1.25 }]);
    const down = resizeRange(up, 0, 4, 1 / 1.25);
    expect(down.runs).toEqual([]);
    const tenth = (x: TextObject, f: number, n: number) => {
      let y = x;
      for (let i = 0; i < n; i++) y = resizeRange(y, 0, 4, f);
      return y;
    };
    expect(tenth(tenth(o, 1.1, 5), 1 / 1.1, 5).runs).toEqual([]);
  });

  it('multiplies each character’s own size, keeping its other formatting', () => {
    const o = text('16 For God', { runs: [{ start: 0, end: 2, baseline: 0.3, sizeScale: 0.5 }] });
    expect(resizeRange(o, 0, 6, 1.5).runs).toEqual([
      { start: 0, end: 2, baseline: 0.3, sizeScale: 0.75 },
      { start: 2, end: 6, sizeScale: 1.5 },
    ]);
  });

  it('keeps the effective size within 2-1,000 px and changes nothing at a bound', () => {
    const o = text('abc', {}, { fontSizePx: 40 });
    const big = resizeRange(o, 0, 3, 100);
    expect(big.runs![0]!.sizeScale).toBe(25);
    expect(resizeRange(big, 0, 3, 2)).toBe(big);
    const small = resizeRange(o, 0, 3, 0.0001);
    expect(small.runs![0]!.sizeScale).toBe(0.05);
    for (const f of [1, 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) expect(resizeRange(o, 0, 3, f)).toBe(o);
    expect(resizeRange(o, 2, 2, 1.25)).toBe(o);
  });
});

describe('selectionStyle', () => {
  it('reports what every character agrees on, with the box style where no run sets a field', () => {
    const o = announcement();
    const date = selectionStyle(o, 11, 24);
    expect(date.mixed).toEqual([]);
    expect(date.style).toMatchObject({
      fontWeight: 700,
      color: RED,
      fontFamily: o.style.fontFamily,
      fontStyle: 'normal',
      sizeScale: 1,
      baseline: 0,
      strike: false,
      underline: false,
      caps: 'none',
    });
    expect(date.style.highlight).toBeUndefined();
    const across = selectionStyle(o, 8, 15);
    expect(across.mixed).toEqual(['fontWeight', 'color']);
    expect(across.style.fontWeight).toBeUndefined();
    expect(across.style.fontFamily).toBe(o.style.fontFamily);
  });

  it('gives a caret the style typed text would take there', () => {
    const o = text('ab\n\ncd', {
      runs: [
        { start: 0, end: 1, fontWeight: 700 },
        { start: 3, end: 4, color: RED },
        { start: 4, end: 5, strike: true },
      ],
    });
    expect(selectionStyle(o, 0, 0).style.fontWeight).toBe(700); // a paragraph start: its first character
    expect(selectionStyle(o, 1, 1).style.fontWeight).toBe(700); // else the character before
    expect(selectionStyle(o, 2, 2).style.fontWeight).toBe(o.style.fontWeight);
    expect(selectionStyle(o, 3, 3).style.color).toEqual(RED); // an empty paragraph: its end mark
    expect(selectionStyle(o, 4, 4).style.strike).toBe(true);
    expect(selectionStyle(text(''), 0, 0).style.fontWeight).toBe(DEFAULT_THEME.textBoxDefaults.fontWeight);
  });

  it('leaves line breaks out of a selection that holds other characters', () => {
    const o = text('one\ntwo', {
      runs: [
        { start: 0, end: 3, fontWeight: 700 },
        { start: 4, end: 7, fontWeight: 700 },
      ],
    });
    expect(selectionStyle(o, 0, 7)).toMatchObject({ style: { fontWeight: 700 }, mixed: [] });
    expect(selectionStyle(o, 3, 4).style.fontWeight).toBe(o.style.fontWeight);
  });

  it('reports a highlight or a language only when every character has the same one', () => {
    const o = text('abcd', { runs: [{ start: 0, end: 2, highlight: BLUE, lang: 'he' }] });
    expect(selectionStyle(o, 0, 2).style).toMatchObject({ highlight: BLUE, lang: 'he' });
    expect(selectionStyle(o, 0, 4).mixed).toEqual(['highlight', 'lang']);
    expect('highlight' in selectionStyle(o, 2, 4).style).toBe(false);
    const caps = text('abc', {}, { transform: 'uppercase' });
    expect(selectionStyle(caps, 0, 3).style.caps).toBe('all');
  });
});

describe('setParas and selectionParas', () => {
  const verses = () => text('16 For God so loved\n17 For God sent\n18 He who believes', {});

  it('styles the paragraphs a selection touches, padding with nulls and trimming trailing ones', () => {
    const o = verses();
    const r = setParas(o, 22, 22, { align: 'right' });
    expect(r.paras).toEqual([null, { align: 'right' }]);
    const all = setParas(r, 0, o.text.length, { bullet: { auto: 'arabicPeriod', startAt: 17 } });
    expect(all.paras).toEqual([
      { bullet: { auto: 'arabicPeriod', startAt: 17 } },
      { align: 'right', bullet: { auto: 'arabicPeriod', startAt: 17 } },
      { bullet: { auto: 'arabicPeriod', startAt: 17 } },
    ]);
    // Removing the only field of an entry leaves null, and trailing nulls go.
    expect(setParas(r, 20, 20, { align: undefined }).paras).toEqual([]);
    // A selection ending just after a line break does not touch the next paragraph.
    expect(setParas(o, 0, 20, { rtl: true }).paras).toEqual([{ rtl: true }]);
  });

  it('returns the object itself when nothing changes; a plain object gets paragraph styles only when they set something', () => {
    const o = verses();
    expect(setParas(o, 0, 0, { align: undefined })).toBe(o);
    expect(setParas(o, 0, 0, {})).toBe(o);
    expect(setParas(o, 0, 0, { soft: true })).toBe(o);
    const r = setParas(o, 0, 0, { align: 'right' });
    expect(setParas(r, 0, 0, { align: 'right' })).toBe(r);
    // Trailing nulls in the stored entries are the box defaults too.
    const padded = { ...r, paras: [{ align: 'right' as const }, null, null] };
    expect(setParas(padded, 0, 0, { align: 'right' })).toBe(padded);
    expect(o.runs).toBeUndefined();
    expect(r.runs).toBeUndefined();
  });

  it('keeps soft lines with their paragraph: they keep `soft` and inherit the change', () => {
    const o = text('Amazing grace\nhow sweet the sound\nThat saved', {
      paras: [
        { align: 'left', spaceBeforePx: 10 },
        { soft: true, align: 'left' },
      ],
    });
    // A caret on the soft line touches the whole PowerPoint paragraph.
    const r = setParas(o, 20, 20, { align: 'center', spaceBeforePx: 20 });
    expect(r.paras).toEqual([{ align: 'center', spaceBeforePx: 20 }, { soft: true }]);
    expect(selectionParas(r, 20, 20)).toEqual({
      para: { align: 'center', level: 0, indentPx: 0, firstLinePx: 0, spaceBeforePx: 20, spaceAfterPx: 0 },
      mixed: [],
    });
  });

  it('treats exact and proportional line spacing as alternatives', () => {
    const o = text('a\nb', { paras: [{ lineSpacingPx: 60 }] });
    expect(setParas(o, 0, 0, { lineSpacing: 1.5 }).paras).toEqual([{ lineSpacing: 1.5 }]);
    expect(setParas(o, 0, 0, { lineSpacing: 1.5, lineSpacingPx: 40 }).paras).toEqual([
      { lineSpacing: 1.5, lineSpacingPx: 40 },
    ]);
  });

  it('bounds values as the schema does and leaves out what is not a value', () => {
    const o = text('a');
    expect(
      setParas(o, 0, 0, {
        level: 12.4,
        indentPx: -1e9,
        spaceAfterPx: -3,
        lineSpacing: 99,
        align: 'middle' as never,
      }).paras,
    ).toEqual([{ level: 8, indentPx: -100_000, spaceAfterPx: 0, lineSpacing: 13.2 }]);
    expect(setParas(o, 0, 0, { bullet: { startAt: 0.2, char: '' } })).toBe(o);
    expect(setParas(o, 0, 0, { bullet: { startAt: 0.2 } }).paras).toEqual([{ bullet: { startAt: 1 } }]);
    expect(setParas(o, 0, 0, { bullet: null }).paras).toEqual([{ bullet: null }]);
  });

  it('reports what the touched paragraphs agree on, with the box defaults for null entries', () => {
    const o = text(
      'a\nb\nc',
      { paras: [{ align: 'right', rtl: true }, null, { bullet: null }] },
      { align: 'center' },
    );
    expect(selectionParas(o, 0, 0).para).toEqual({
      align: 'right',
      rtl: true,
      level: 0,
      indentPx: 0,
      firstLinePx: 0,
      spaceBeforePx: 0,
      spaceAfterPx: 0,
    });
    const all = selectionParas(o, 0, 5);
    expect(all.mixed).toEqual(['align', 'rtl']);
    expect(all.para.align).toBeUndefined();
    // An explicit "no bullet" and no entry agree: neither has a bullet.
    expect(selectionParas(o, 2, 5)).toMatchObject({ para: { align: 'center' }, mixed: [] });
    expect(selectionParas(text('a', {}, { justify: true }), 0, 0).para.align).toBe('justify');
  });
});

describe('refitText', () => {
  it('clears the stored fit scale, and only that', () => {
    const o = announcement();
    const r = refitText(o);
    expect(r.style.fitScale).toBeUndefined();
    expect(r.style.autofit).toBe('shrink');
    expect({ ...r.style, fitScale: o.style.fitScale }).toEqual(o.style);
    expect(refitText(r)).toBe(r);
  });
});

// ---- editText keeps the stored fit while the text fits (§6 step 10) ----------------------------------

describe('editText and the stored fit scale', () => {
  /** An imported shrink-to-fit box: 40 px office-model text, PowerPoint's stored 80 % font scale. */
  const fitted = (t: string, family = 'Inter'): TextObject =>
    text(
      t,
      { runs: [{ start: 9, end: 22, fontWeight: 700, color: RED }], paras: [] },
      {
        fontFamily: family,
        fontSizePx: 40,
        lineModel: 'office',
        insets: { l: 0, t: 0, r: 0, b: 0 },
        autofit: 'shrink',
        fitScale: { font: 0.8, spacing: 1 },
        valign: 'top',
      },
    );
  const t0 = 'Potluck: Sunday 12 May in the hall\nBring a dish to share';
  const m = testMeasurer({ em: 0.5 });
  const lay = (o: TextObject, env = LEGACY_FONT_ENV) =>
    layoutRich(m, clampTextObject({ ...o, box: { ...box, w: 600, h: 200 } }), env);

  it('draws the stored scale before and after an edit that still fits, even where the text would fit larger', () => {
    const o = fitted(t0);
    expect(lay({ ...o, style: { ...o.style, fitScale: undefined } }).fontScale).toBe(1); // it fits at full size
    expect(lay(o).fontScale).toBe(0.8);
    // A typo fix inside the bold date: the date keeps its run, the box its scale and so its text size.
    const fixed = editText(o, t0.replace('12', '19'), 'Potluck: Sunday 19'.length);
    expect(fixed.runs).toEqual(o.runs);
    expect(fixed.style).toBe(o.style);
    expect(lay(fixed).fontScale).toBe(0.8);
    // A deletion never raises it.
    const shorter = editText(o, t0.replace(' in the hall', ''), 'Potluck: Sunday 12 May'.length);
    expect(shorter.style.fitScale).toEqual({ font: 0.8, spacing: 1 });
    expect(lay(shorter).fontScale).toBe(0.8);
  });

  it('fits smaller, never larger, when an edit overflows, and keeps the stored scale for when it fits again', () => {
    const o = fitted(t0);
    const verse = '\nAnd bring a friend, a neighbour, and everyone who would like to come along this Sunday';
    const longer = editText(o, `${t0}${verse}${verse}`, t0.length + 2 * verse.length);
    const l = lay(longer);
    expect(l.fontScale).toBeLessThan(0.8);
    expect(l.overflow).toBe(false);
    expect(longer.style.fitScale).toEqual({ font: 0.8, spacing: 1 });
    // Deleting the added lines brings the stored size back.
    const back = editText(longer, t0, t0.length);
    expect(back.text).toBe(t0);
    expect(lay(back).fontScale).toBe(0.8);
  });

  it('fits a box drawn with another face than PowerPoint’s from full size after an edit; the object keeps the scale', () => {
    const env = new FontResolver();
    env.loaded({ family: 'Inter', internal: 'o000aaaa' });
    const aptos = fitted(t0, 'Aptos');
    const fixed = editText(aptos, t0.replace('12', '19'), 'Potluck: Sunday 19'.length);
    expect(lay(fixed, env).fontScale).toBe(1);
    expect(fixed.style.fitScale).toEqual({ font: 0.8, spacing: 1 });
    // The family's own face (here: loaded) brings PowerPoint's scale back.
    env.loaded({ family: 'Aptos', internal: 'o000bbbb' });
    expect(lay(fixed, env).fontScale).toBe(0.8);
  });

  it('only Re-fit text clears the scale: the box is fitted again from full size', () => {
    const o = fitted(t0);
    expect(lay(refitText(o)).fontScale).toBe(1);
  });
});

// ---- themes (design/27 §11 "Themes") ----------------------------------------------------------------

/** John 3:16-17 as an import leaves it: raised verse numbers, the deck's face and colour on every run. */
function scripture(): TextObject {
  const t = '16 For God so loved the world\n17 For God sent not his Son';
  const deck = { fontFamily: 'Calibri', color: { r: 34, g: 34, b: 34, a: 1 } };
  return text(
    t,
    {
      id: 'lyric',
      runs: [
        { start: 0, end: 2, baseline: 0.3, ...deck },
        { start: 2, end: 7, ...deck },
        { start: 7, end: 10, ...deck, fontStyle: 'italic', underline: true },
        { start: 10, end: 30, ...deck },
        { start: 30, end: 32, baseline: 0.3, caps: 'small', ...deck },
        { start: 32, end: t.length, ...deck, strike: true, sizeScale: 0.9, highlight: BLUE },
      ],
      paras: [{ bullet: { auto: 'arabicPeriod', startAt: 16 } }, { align: 'left' }],
    },
    { fontFamily: 'Calibri', autofit: 'shrink', fitScale: { font: 0.7, spacing: 0.9 }, lineModel: 'office' },
  );
}

const scriptureDeck = (overrides?: string[]): Presentation => ({
  id: 'p1',
  rev: 1,
  title: 'John 3',
  kind: 'slides',
  meta: { tags: [] },
  sections: [
    {
      id: 'sec',
      label: 'Main',
      short: 'M',
      slides: [{ id: 's1', objects: [scripture()], lyricObjectId: 'lyric', overrides }],
    },
  ],
  arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
  archived: false,
});

describe('themedRuns and applyTheme', () => {
  it('keeps verse superscripts, emphasis, caps and paragraph styles; drops the deck’s faces, colours and sizes', () => {
    const themed = getSlide(applyTheme(scriptureDeck(), DEFAULT_THEME), 's1')!.objects[0] as TextObject;
    expect(themed.runs).toEqual([
      { start: 0, end: 2, baseline: 0.3 },
      { start: 7, end: 10, fontStyle: 'italic', underline: true },
      { start: 30, end: 32, baseline: 0.3, caps: 'small' },
      { start: 32, end: themed.text.length, strike: true },
    ]);
    expect(themed.paras).toEqual(scripture().paras);
    expect(themed.style.fontFamily).toBe(DEFAULT_THEME.text.fontFamily);
    // PowerPoint's fit was for the imported box: the theme's box is fitted again.
    expect(themed.style.fitScale).toBeUndefined();
    expect(themed.style.autofit).toBe('shrink');
  });

  it('keeps the visual fields the slide overrides: runs.<field>, or runs for all', () => {
    const o = scripture();
    const keep = themedRuns(o, ['runs.color', 'runs.highlight', 'style.fitScale']);
    expect(keep.style).toBe(o.style);
    expect(keep.runs!.every((r) => r.fontFamily === undefined && r.sizeScale === undefined)).toBe(true);
    expect(keep.runs!.every((r) => r.color !== undefined)).toBe(true);
    expect(keep.runs!.at(-1)!.highlight).toEqual(BLUE);
    expect(themedRuns(o, ['runs', 'style.fitScale'])).toBe(o);
    const themed = getSlide(applyTheme(scriptureDeck(['runs']), DEFAULT_THEME), 's1')!
      .objects[0] as TextObject;
    expect(themed.runs).toEqual(o.runs);
  });

  it('returns the object itself when there is nothing to drop', () => {
    const o = text('plain');
    expect(themedRuns(o, [])).toBe(o);
    const s = text('16 x', { runs: [{ start: 0, end: 2, baseline: 0.3 }] });
    expect(themedRuns(s, [])).toBe(s);
    expect(VISUAL_RUN_FIELDS.every((k) => runOverrides({ [k]: undefined }).length === 0)).toBe(true);
  });
});

describe('textOnSlide (the override paths a format marks)', () => {
  const slide = (): Slide => ({
    id: 's1',
    objects: [scripture(), { ...text('caption'), id: 'other' }],
    lyricObjectId: 'lyric',
  });

  it('marks runs.<field> on the lyric object only, once, and only when something changed', () => {
    const s = slide();
    const paths = runOverrides({ color: RED, fontWeight: 700, sizeScale: undefined });
    expect(paths).toEqual(['runs.color']);
    const a = textOnSlide(s, 'lyric', (o) => formatRange(o, 0, 2, { color: RED }), paths);
    expect(a.overrides).toEqual(['runs.color']);
    expect(textOnSlide(a, 'lyric', (o) => formatRange(o, 3, 6, { color: BLUE }), paths).overrides).toEqual([
      'runs.color',
    ]);
    expect(
      textOnSlide(s, 'other', (o) => formatRange(o, 0, 2, { color: RED }), paths).overrides,
    ).toBeUndefined();
    expect(textOnSlide(s, 'lyric', (o) => o, paths)).toBe(s);
    expect(textOnSlide(s, 'nope', (o) => formatRange(o, 0, 2, { color: RED }), paths)).toBe(s);
    const locked = { ...s, objects: [{ ...scripture(), locked: true }] };
    expect(textOnSlide(locked, 'lyric', (o) => formatRange(o, 0, 2, { color: RED }), paths)).toBe(locked);
  });
});

// ---- the actions (one undo step each, saved with the draft) -------------------------------------------

describe('the text actions', () => {
  beforeEach(() => {
    openPresentation({ ...scriptureDeck(), themeId: DEFAULT_THEME.id });
    selectSlide('s1');
  });
  const lyric = () => getSlide(useEditor.getState().draft!, 's1')!.objects[0] as TextObject;
  const slide = () => getSlide(useEditor.getState().draft!, 's1')!;

  it('formats a selection as one undo step, marking the theme override on a themed lyric object', () => {
    actions.formatSelection('lyric', 3, 6, { color: RED });
    expect(useEditor.getState().dirty).toBe(true);
    expect(selectionStyle(lyric(), 3, 6).style.color).toEqual(RED);
    expect(slide().overrides).toEqual(['runs.color']);
    // The next theme keeps the volunteer's colour (with every run colour of this slide: the path is the
    // slide's, as `style.color` is), while its faces and sizes go.
    const themed = getSlide(applyTheme(useEditor.getState().draft!, DEFAULT_THEME), 's1')!
      .objects[0] as TextObject;
    expect(selectionStyle(themed, 3, 6).style.color).toEqual(RED);
    expect(themed.runs!.every((r) => r.fontFamily === undefined)).toBe(true);
    undo();
    expect(lyric()).toEqual(scripture());
    expect(slide().overrides).toBeUndefined();
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('coalesces Size ± clicks into one step and marks runs.sizeScale', () => {
    actions.resizeSelection('lyric', 3, 6, 1.1);
    actions.resizeSelection('lyric', 3, 6, 1.1);
    expect(selectionStyle(lyric(), 3, 6).style.sizeScale).toBe(1.21);
    expect(slide().overrides).toEqual(['runs.sizeScale']);
    undo();
    expect(lyric()).toEqual(scripture());
  });

  it('styles paragraphs and re-fits, each one step; an op that changes nothing records nothing', () => {
    actions.setParagraphs('lyric', 31, 31, { bullet: { auto: 'arabicPeriod', startAt: 17 } });
    expect(lyric().paras![1]).toEqual({ align: 'left', bullet: { auto: 'arabicPeriod', startAt: 17 } });
    actions.refit('lyric');
    expect(lyric().style.fitScale).toBeUndefined();
    undo();
    expect(lyric().style.fitScale).toEqual({ font: 0.7, spacing: 0.9 });
    undo();
    expect(lyric()).toEqual(scripture());
    const before = useEditor.getState().draft;
    actions.formatSelection('lyric', 0, 2, { baseline: 0.3 });
    actions.formatSelection('lyric', 4, 4, { fontWeight: 700 });
    actions.resizeSelection('lyric', 0, 2, 1);
    actions.setParagraphs('lyric', 0, 0, { bullet: { auto: 'arabicPeriod', startAt: 16 } });
    expect(useEditor.getState().draft).toBe(before);
  });

  it('does not mark overrides without a theme', () => {
    openPresentation(scriptureDeck());
    selectSlide('s1');
    actions.formatSelection('lyric', 3, 6, { color: RED });
    expect(slide().overrides).toBeUndefined();
  });
});
