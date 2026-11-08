import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type TextObject, type TextStyle } from '@ordo/domain';
import { layoutText } from '../text2d.ts';
import { visualOrder } from './bidi.ts';
import { FontResolver, LEGACY_FONT_ENV } from './fonts.ts';
import { itemize } from './itemize.ts';
import { WidthCache, canvasMeasurer } from './measure.ts';
import { officeLine } from './office.ts';
import { clampTextObject, drawRichText, isRichText, layoutRich, storedFitHolds } from './rich.ts';
import { recordingCtx, testMeasurer } from './test-util.ts';
import type { ParaStyle, RichLayout } from './types.ts';

/** A rich text object (`lang` set, so it goes through the rich engine) in a 200x100 box at the origin. */
function obj(text: string, style: Partial<TextStyle> = {}, extra: Partial<TextObject> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
    text,
    style: { ...DEFAULT_LYRIC_STYLE, padding: 0, fontSizePx: 20, lineHeight: 1, lang: 'en', ...style },
    opacity: 1,
    ...extra,
  });
}

/** The text of each line, from its segments (logical order is visual order for LTR text). */
function lineTexts(o: TextObject, l: RichLayout): string[] {
  return l.lines.map((line) => line.segs.map((s) => o.text.slice(s.start, s.end)).join(''));
}

// Every character is 0.5 em: 10 px at the 20 px size used here.
const m = () => testMeasurer({ em: 0.5 });

describe('dispatch rule', () => {
  it('sends only objects with a rich field to the rich engine', () => {
    const legacy: TextObject = {
      id: 't',
      type: 'text',
      box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
      text: 'x',
      style: DEFAULT_LYRIC_STYLE,
      opacity: 1,
    };
    expect(isRichText(legacy)).toBe(false);
    expect(isRichText(clampTextObject(legacy))).toBe(false);
    expect(isRichText({ ...legacy, runs: [] })).toBe(true);
    expect(isRichText({ ...legacy, paras: [null] })).toBe(true);
    expect(isRichText({ ...legacy, style: { ...legacy.style, wrap: false } })).toBe(true);
    expect(
      isRichText({ ...legacy, style: { ...legacy.style, glow: { radius: 1, color: legacy.style.color } } }),
    ).toBe(true);
  });
});

describe('itemize', () => {
  it('cuts paragraphs and intersects runs with them, the gaps in the box style', () => {
    const o = obj('ab\ncd', {}, { runs: [{ start: 1, end: 4, fontWeight: 300 }] });
    const it = itemize(o);
    expect(it.paras.map((p) => [p.start, p.end])).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(it.paras[0]!.runs.map((r) => [r.start, r.end, r.run, r.style.weight])).toEqual([
      [0, 1, -1, 700],
      [1, 2, 0, 300],
    ]);
    expect(it.paras[1]!.runs.map((r) => [r.start, r.end, r.run])).toEqual([
      [3, 4, 0],
      [4, 5, -1],
    ]);
  });

  it('gives an empty paragraph one empty run with its end-mark style', () => {
    const o = obj('a\n\nb', {}, { runs: [{ start: 2, end: 3, sizeScale: 2 }] });
    const p = itemize(o).paras[1]!;
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]).toMatchObject({ start: 2, end: 2, run: 0 });
    expect(p.runs[0]!.style.sizePx).toBe(40);
  });
});

describe("the 'ordo' line model", () => {
  it('reproduces drawText line positions and baselines', () => {
    const cases: [string, Partial<TextStyle>][] = [
      ['one two three four five six', {}],
      ['aaa bbb ccc\nddd', { valign: 'top', align: 'left', lineHeight: 1.3, padding: 8 }],
      ['x\n\ny', { valign: 'bottom', align: 'right', lineHeight: 0.9 }],
      ['centred', { fontSizePx: 37, lineHeight: 1.15 }],
    ];
    for (const [text, style] of cases) {
      const o = obj(text, style);
      const rich = layoutRich(m(), o, LEGACY_FONT_ENV);
      const legacy = layoutText(recordingCtx(0.5), text, o.style, o.box, 1);
      expect(lineTexts(o, rich).map((t) => t.trimEnd())).toEqual(legacy.lines.map((l) => l.text));
      const S = o.style.fontSizePx;
      const offsetY = (legacy.lineHeightPx - S) / 2 + 0.8 * S;
      rich.lines.forEach((line, i) => {
        const l = legacy.lines[i]!;
        expect(line.top).toBeCloseTo(l.y, 9);
        expect(line.baseline).toBeCloseTo(l.y + offsetY, 9);
        expect(line.height).toBeCloseTo(legacy.lineHeightPx, 9);
        expect(line.x).toBeCloseTo(l.x, 9);
      });
    }
  });

  it('wraps greedily, breaks a long word between graphemes, keeps empty paragraphs', () => {
    const wrap = (text: string, w: number) => {
      const o = obj(text, {}, { box: box(w) });
      return lineTexts(o, layoutRich(m(), o, LEGACY_FONT_ENV));
    };
    expect(wrap('aaa bbb ccc', 75)).toEqual(['aaa bbb ', 'ccc']);
    expect(wrap('abcdefghij', 40)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap('one\n\ntwo', 100)).toEqual(['one', '', 'two']);
  });

  it('never breaks at a no-break space', () => {
    const o = obj('Le Dieu !', {}, { box: box(75) });
    expect(lineTexts(o, layoutRich(m(), o, LEGACY_FONT_ENV))).toEqual(['Le ', 'Dieu !']);
  });

  it('flags overflow and never wraps with wrap: false', () => {
    const o = obj('aaa bbb ccc', { wrap: false, align: 'center' }, { box: box(60) });
    const l = layoutRich(m(), o, LEGACY_FONT_ENV);
    expect(l.lines).toHaveLength(1);
    expect(l.overflow).toBe(true);
    expect(l.lines[0]!.x).toBeCloseTo((60 - 110) / 2, 9); // grows both ways from the centre
  });

  it('sizes runs from the box size and raises superscripts without growing the line', () => {
    const o = obj(
      '17 For God',
      {},
      {
        runs: [
          { start: 0, end: 2, baseline: 0.3 },
          { start: 7, end: 10, sizeScale: 1.5 },
        ],
      },
    );
    const l = layoutRich(m(), o, LEGACY_FONT_ENV);
    const segs = l.lines[0]!.segs;
    expect(segs.map((s) => [o.text.slice(s.start, s.end), s.run, s.sizePx])).toEqual([
      ['17', 0, 20 * 0.58],
      [' ', -1, 20],
      ['For ', -1, 20],
      ['God', 1, 30],
    ]);
    expect(segs[0]!.shift).toBeCloseTo(-6, 9);
    // F: the paragraph's main run, raised by a larger unshifted run on the line ('God'), never by a
    // raised or lowered one.
    expect(l.lines[0]!.height).toBe(30);
    const raised = obj('17 For', {}, { runs: [{ start: 0, end: 2, baseline: 0.3, sizeScale: 3 }] });
    expect(layoutRich(m(), raised, LEGACY_FONT_ENV).lines[0]!.height).toBe(20);
  });
});

describe('office line model', () => {
  const para = (p: Partial<ParaStyle> = {}): ParaStyle => ({
    align: 'left',
    level: 0,
    indentPx: 0,
    firstLinePx: 0,
    spaceBeforePx: 0,
    spaceAfterPx: 0,
    lineSpacing: null,
    lineSpacingPx: null,
    bullet: undefined,
    dir: 'auto',
    hidden: false,
    ...p,
  });
  it('has single spacing 1.2F with the baseline F below the top', () => {
    expect(officeLine(40, para(), 1)).toEqual({ height: 48, ascent: 40 });
    expect(officeLine(40, para({ lineSpacing: 1.5 }), 1)).toEqual({ height: 72, ascent: 64 });
    expect(officeLine(40, para({ lineSpacing: 0.8 }), 1).ascent).toBeCloseTo(Math.min(40, 0.8 * 38.4), 9);
    expect(officeLine(40, para({ lineSpacingPx: 60 }), 0.9)).toEqual({ height: 54, ascent: 40 + 54 - 48 });
  });
});

describe("PowerPoint's stored autofit scale and the face drawing the box", () => {
  // Fits at full size (one 20 px line in a 200x100 box); PowerPoint stored 50 % for its own face's widths.
  const stored = (family: string, fallbackFonts?: string[]) =>
    obj('aaa bbb', {
      fontFamily: family,
      autofit: 'shrink',
      fitScale: { font: 0.5, spacing: 1 },
      ...(fallbackFonts ? { fallbackFonts } : {}),
    });
  /** The drawn size of every line's segments. */
  const sizes = (l: RichLayout) => l.lines.map((line) => [...new Set(line.segs.map((seg) => seg.sizePx))]);

  it('keeps the scale while the box is drawn with its own face or a metric-compatible one', () => {
    const env = new FontResolver();
    env.loaded({ family: 'Aptos', internal: 'o000aaaa' });
    env.loaded({ family: 'Carlito', internal: 'o000bbbb' });
    for (const o of [stored('Aptos'), stored('Calibri', ['Carlito'])]) {
      expect(storedFitHolds(o, env)).toBe(true);
      const l = layoutRich(m(), o, env);
      expect([l.fontScale, l.spacingScale]).toEqual([0.5, 1]);
      expect(sizes(l)).toEqual([[10]]);
    }
    // An environment that cannot tell (no metricMatch) keeps it too.
    expect(layoutRich(m(), stored('Aptos'), LEGACY_FONT_ENV).fontScale).toBe(0.5);
  });

  it('fits the box again from full size, as LibreOffice does, when another face draws it', () => {
    const env = new FontResolver();
    env.loaded({ family: 'Carlito', internal: 'o000bbbb' });
    env.loaded({ family: 'Corbel', internal: 'o000cccc', substitute: true });
    // Aptos not loaded (ordo's default face draws), Calibri Light drawn with its nearest face, Corbel
    // drawn with a stand-in registered under its name.
    for (const o of [stored('Aptos'), stored('Calibri Light', ['Carlito']), stored('Corbel')]) {
      expect(storedFitHolds(o, env)).toBe(false);
      const l = layoutRich(m(), o, env);
      expect([l.fontScale, l.spacingScale]).toEqual([1, 1]);
      expect(sizes(l)).toEqual([[20]]);
      // The object itself keeps the stored scale: uploading the family brings it back.
      expect(o.style.fitScale).toEqual({ font: 0.5, spacing: 1 });
    }
  });

  it('may end above the stored scale, and shrinks like LibreOffice when the text does not fit', () => {
    const env = new FontResolver();
    // 20 px per character at full size: two words a line, four 48 px lines in a 100 px box. PowerPoint's
    // 10 % fits too, but LibreOffice's search ends far above it.
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh';
    const style = { fontFamily: 'Aptos', fontSizePx: 40, autofit: 'shrink', lineModel: 'office' } as const;
    const o = obj(text, { ...style, fitScale: { font: 0.1, spacing: 1 } });
    const fresh = obj(text, style);
    const l = layoutRich(m(), o, env);
    expect(l.fontScale).toBeGreaterThan(0.1);
    expect(l.fontScale).toBeLessThan(1);
    expect(l.overflow).toBe(false);
    // Exactly what a box without a stored scale gets.
    const f = layoutRich(m(), fresh, env);
    expect([l.fontScale, l.spacingScale]).toEqual([f.fontScale, f.spacingScale]);
    expect(lineTexts(o, l)).toEqual(lineTexts(fresh, f));
    expect(layoutRich(m(), o, LEGACY_FONT_ENV).fontScale).toBe(0.1);
  });

  it('follows the font generation: the family loading brings the stored scale back', () => {
    const env = new FontResolver();
    const o = stored('Aptos');
    const mm = m();
    const before = layoutRich(mm, o, env);
    expect(before.fontScale).toBe(1);
    expect(layoutRich(mm, o, env)).toBe(before);
    env.loaded({ family: 'Aptos', internal: 'o000dddd' });
    const after = layoutRich(mm, o, env);
    expect(after.fontScale).toBe(0.5);
    // Drawing paints the layout it lays out, at the refitted size.
    const ctx = recordingCtx(0.5);
    const other = new FontResolver();
    const drawn = drawRichText(ctx, o, 1, other);
    expect(drawn.fontScale).toBe(1);
    const fonts = ctx.ops.filter((op) => op.op === 'fillText').map((op) => op.font);
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) expect(f).toContain(' 20px ');
  });
});

describe('bidi L2', () => {
  it('reverses runs from the highest level down to the lowest odd one', () => {
    expect(visualOrder([0, 0, 0])).toEqual([0, 1, 2]);
    expect(visualOrder([1, 1, 1])).toEqual([2, 1, 0]);
    expect(visualOrder([0, 1, 1, 0])).toEqual([0, 2, 1, 3]);
    expect(visualOrder([1, 2, 2, 1])).toEqual([3, 1, 2, 0]);
  });
});

describe('memo and measuring', () => {
  it('memoises by object, measurer and font generation', () => {
    const o = obj('memo me');
    const mm = m();
    const env = new FontResolver();
    const a = layoutRich(mm, o, env);
    const calls = mm.calls;
    expect(layoutRich(mm, o, env)).toBe(a);
    expect(mm.calls).toBe(calls);
    env.loaded({ family: 'Inter', internal: 'o1234abcd' });
    const b = layoutRich(mm, o, env);
    expect(b).not.toBe(a);
    expect(b.lines[0]!.segs[0]!.font).toContain('"o1234abcd"');
  });

  it('caches canvas widths and subtracts the trailing letter spacing', () => {
    const ctx = recordingCtx(0.5);
    const cache = new WidthCache(2);
    const cm = canvasMeasurer(ctx, cache);
    expect(cm.width('20px X', 'ltr', '', 0, 'abcd')).toBe(40);
    expect(cm.width('20px X', 'ltr', '', 3, 'abcd')).toBe(49); // 40 + 4 × 3, less the 3 after the 'd'
    cm.width('20px X', 'ltr', '', 0, 'zz');
    expect(cache.size).toBe(2);
  });
});

function box(w: number) {
  return { x: 0, y: 0, w, h: 100, rotation: 0 };
}
