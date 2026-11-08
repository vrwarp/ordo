import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type TextObject, type TextStyle } from '@ordo/domain';
import { LEGACY_FONT_ENV } from './fonts.ts';
import { itemize } from './itemize.ts';
import { clampTextObject, layoutRich } from './rich.ts';
import { testMeasurer } from './test-util.ts';

function obj(text: string, extra: Partial<TextObject> = {}, style: Partial<TextStyle> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w: 400, h: 200, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      padding: 0,
      fontSizePx: 20,
      lineHeight: 1,
      align: 'center',
      lang: 'en',
      ...style,
    },
    opacity: 1,
    ...extra,
  });
}

describe('paragraphs', () => {
  it('are the newline pieces, with styles over the box defaults', () => {
    const it = itemize(
      obj('a\nb\n', { paras: [{ align: 'right', spaceBeforePx: 6 }, null] }, { justify: true }),
    );
    expect(it.paras.map((p) => [p.start, p.end, p.soft])).toEqual([
      [0, 1, false],
      [2, 3, false],
      [4, 4, false],
    ]);
    expect(it.paras.map((p) => p.style.align)).toEqual(['right', 'justify', 'justify']);
    expect(it.paras[0]!.style.spaceBeforePx).toBe(6);
    expect(it.paras[1]!.style.spaceBeforePx).toBe(0);
  });

  it('gives a soft paragraph the style of the paragraph it continues, with its own overrides', () => {
    const it = itemize(
      obj('one\ntwo\nthree\nfour', {
        paras: [
          { align: 'right', indentPx: 12, lineSpacing: 1.5, rtl: true, hidden: true, level: 2 },
          { soft: true },
          { soft: true, align: 'left' },
          { soft: true },
        ],
      }),
    );
    const s = it.paras.map((p) => p.style);
    expect(it.paras.map((p) => p.soft)).toEqual([false, true, true, true]);
    for (const k of [1, 2, 3]) {
      expect(s[k]!.indentPx).toBe(12);
      expect(s[k]!.lineSpacing).toBe(1.5);
      expect(s[k]!.dir).toBe('rtl');
      expect(s[k]!.hidden).toBe(true);
      expect(s[k]!.level).toBe(2);
    }
    expect(s.map((x) => x.align)).toEqual(['right', 'right', 'left', 'left']);
    // The first paragraph never continues anything.
    expect(itemize(obj('x', { paras: [{ soft: true }] })).paras[0]!.soft).toBe(false);
  });

  it('starts a new style at a paragraph that is not soft', () => {
    const it = itemize(obj('a\nb', { paras: [{ align: 'right' }, null] }));
    expect(it.paras[1]!.style.align).toBe('center');
  });
});

describe('end marks', () => {
  it('sizes an empty paragraph by the run covering its newline', () => {
    const it = itemize(obj('a\n\nb', { runs: [{ start: 2, end: 3, sizeScale: 2 }] }));
    expect(it.paras[1]!.runs).toEqual([expect.objectContaining({ start: 2, end: 2, run: 0 })]);
    expect(it.paras[1]!.runs[0]!.style.sizePx).toBe(40);
  });

  it('sizes a last empty paragraph by the run covering the newline before it, else the box style', () => {
    const covered = itemize(obj('Title\n', { runs: [{ start: 0, end: 6, sizeScale: 2 }] }));
    expect(covered.paras[1]!.runs[0]).toMatchObject({ start: 6, end: 6, run: 0 });
    const open = itemize(obj('Title\n', { runs: [{ start: 0, end: 5, sizeScale: 2 }] }));
    expect(open.paras[1]!.runs[0]).toMatchObject({ start: 6, end: 6, run: -1 });
    expect(itemize(obj('')).paras[0]!.runs[0]).toMatchObject({ start: 0, end: 0, run: -1 });
  });

  it('makes the empty line as tall as its end mark', () => {
    const o = obj('Title\n', { runs: [{ start: 0, end: 6, sizeScale: 2 }] });
    const l = layoutRich(testMeasurer(), o, LEGACY_FONT_ENV);
    expect(l.lines.map((line) => line.height)).toEqual([40, 40]);
  });
});
