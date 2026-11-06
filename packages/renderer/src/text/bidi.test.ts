import { describe, expect, it } from 'vitest';
import { bidiParagraph, firstStrong, hasStrongRtl, visualOrder } from './bidi.ts';

/** Levels of the whole of `text` as a string of digits ('' on the fast path). */
function levels(text: string, dir: 'ltr' | 'rtl' | 'auto' = 'auto'): { level: number; levels: string } {
  const b = bidiParagraph(text, 0, text.length, dir);
  return { level: b.level, levels: b.levels ? Array.from(b.levels).join('') : '' };
}

/**
 * `text` in visual order, left to right, the way the drawers place it: runs of one level reordered by L2,
 * each run's characters reversed when its level is odd (the browser's job within a segment).
 */
function visual(text: string, dir: 'ltr' | 'rtl' | 'auto' = 'auto'): string {
  const b = bidiParagraph(text, 0, text.length, dir);
  const lv = b.levels ?? new Uint8Array(text.length).fill(b.level);
  const runs: { s: string; level: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.level === lv[i]) last.s += text[i];
    else runs.push({ s: text[i]!, level: lv[i]! });
  }
  return visualOrder(runs.map((r) => r.level))
    .map((i) => runs[i]!)
    .map((r) => (r.level % 2 ? [...r.s].reverse().join('') : r.s))
    .join('');
}

describe('strong right-to-left characters', () => {
  it('knows Bidi_Class R and AL exactly', () => {
    for (const s of ['שלום', 'مرحبا', 'ܫܠܡܐ', 'ހ', 'ߒߞߏ', '\u{200F}', '\u{FB1D}', '\u{FEFC}', '𞤀', '𐤀'])
      expect(hasStrongRtl(s)).toBe(true);
    // Arabic-Indic digits are AN, marks are NSM, the ALM-free Arabic comma is CS: not strong.
    for (const s of ['abc', '١٢٣', '\u{064E}', '\u{060C}', '123', '', '😀', '\u{202B}'])
      expect(hasStrongRtl(s)).toBe(false);
    expect(hasStrongRtl('abc שלום', 0, 4)).toBe(false);
    expect(hasStrongRtl('abc שלום', 4, 6)).toBe(true);
  });

  it('finds the first strong character, skipping isolates (UAX#9 P2)', () => {
    expect(firstStrong('123 שלום abc')).toBe('rtl');
    expect(firstStrong('“Hello” שלום')).toBe('ltr');
    expect(firstStrong('١٢٣ مرحبا')).toBe('rtl');
    expect(firstStrong('éa')).toBe('ltr');
    expect(firstStrong('ʹ ש')).toBe('rtl'); // U+02B9 is ON, not L, though a letter
    expect(firstStrong('\u{2067}abc\u{2069} ש')).toBe('rtl');
    expect(firstStrong('\u{2068}שלום\u{2069}x')).toBe('ltr');
    expect(firstStrong('123 !?')).toBe(null);
    expect(firstStrong('abc ש', 3)).toBe('rtl');
    expect(firstStrong('𞤀')).toBe('rtl');
    expect(firstStrong('𝐀 ש')).toBe('ltr');
  });
});

describe('UAX#9 levels per paragraph', () => {
  it('takes the fast path for left-to-right text', () => {
    expect(bidiParagraph('Amazing grace', 0, 13, 'auto')).toEqual({ level: 0, levels: null });
    expect(bidiParagraph('Amazing grace', 0, 13, 'ltr')).toEqual({ level: 0, levels: null });
    expect(bidiParagraph('', 0, 0, 'rtl')).toEqual({ level: 1, levels: null });
    expect(bidiParagraph('שלום', 0, 4, 'auto')).toEqual({ level: 1, levels: null });
  });

  it('resolves Hebrew and Arabic with numbers', () => {
    expect(levels('שלום 123 עולם')).toEqual({ level: 1, levels: '1111122211111' });
    expect(visual('שלום 123 עולם')).toBe('םלוע 123 םולש');
    expect(levels('Psalm 23 שלום')).toEqual({ level: 0, levels: '0000000001111' });
    expect(visual('Psalm 23 שלום')).toBe('Psalm 23 םולש');
    expect(visual('مرحبا ١٢٣ عالم')).toBe('ملاع ١٢٣ ابحرم');
    expect(visual('سفر 3:16')).toBe('3:16 رفس');
    expect(visual('he said שלום עולם today')).toBe('he said םלוע םולש today');
    expect(visual('אמר "hello world" לי')).toBe('יל "hello world" רמא');
  });

  it('honours an explicit direction', () => {
    expect(levels('Amen!', 'rtl')).toEqual({ level: 1, levels: '22221' });
    expect(visual('Amen!', 'rtl')).toBe('!Amen');
    expect(levels('שלום!', 'ltr')).toEqual({ level: 0, levels: '11110' });
    // One right-to-left run: the browser mirrors the brackets when it draws it, so it reads (שלום).
    expect(levels('(שלום)', 'rtl')).toEqual({ level: 1, levels: '' });
    expect(visual('(שלום)', 'rtl')).toBe(')םולש(');
  });

  it('works inside a larger text with offsets relative to the paragraph', () => {
    const text = 'abc\nאב 12\nxyz';
    const b = bidiParagraph(text, 4, 9, 'auto');
    expect(b.level).toBe(1);
    expect(Array.from(b.levels!)).toEqual([1, 1, 1, 2, 2]);
  });

  it('classifies astral characters as one character, not two L units', () => {
    // An emoji (ON) between Hebrew words in a left-to-right paragraph joins the right-to-left run.
    expect(levels('x אב 😀 גד', 'ltr').levels).toBe('0011111111');
    // Adlam is right to left.
    expect(bidiParagraph('𞤀𞤁', 0, 4, 'auto')).toEqual({ level: 1, levels: null });
    expect(levels('a 𞤀𞤁', 'ltr').levels).toBe('001111');
  });

  it('applies explicit embeddings and overrides', () => {
    // RLO … PDF: an override with no right-to-left letter still triggers UAX#9.
    expect(levels('a\u{202E}bc\u{202C}d')).toEqual({ level: 0, levels: '001110' });
    expect(visual('a\u{202E}bc\u{202C}d').replace(/[\u{202A}-\u{202E}]/gu, '')).toBe('acbd');
  });
});

describe('visual order (L2)', () => {
  it('reverses runs from the highest level down to the lowest odd one', () => {
    expect(visualOrder([])).toEqual([]);
    expect(visualOrder([0, 0, 0])).toEqual([0, 1, 2]);
    expect(visualOrder([1, 1, 1])).toEqual([2, 1, 0]);
    expect(visualOrder([0, 1, 1, 0])).toEqual([0, 2, 1, 3]);
    expect(visualOrder([1, 2, 2, 1])).toEqual([3, 1, 2, 0]);
    expect(visualOrder([2, 2])).toEqual([0, 1]);
    expect(visualOrder([0, 1, 2, 1, 0])).toEqual([0, 3, 2, 1, 4]);
  });
});
