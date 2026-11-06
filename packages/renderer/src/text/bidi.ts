import type { BidiPara } from './types.ts';

/*
 * Stage 2, bidi (design/27 §6 steps 2 and 6). Owner: breaks-bidi (A).
 *
 * UAX#9 per paragraph with npm `bidi-js` 1.1.0 (MIT), run only when the paragraph has a strong RTL
 * character or a direction is set (`ParaStyle.dir` 'ltr' or 'rtl'). The base direction is `paras[i].rtl`,
 * else `style.direction`, else 'auto': the first strong character. Visual reordering between segments
 * (UAX#9 L2) happens per line in lines.ts through `visualOrder`; the browser orders glyphs within a
 * segment.
 *
 * Scaffold: every paragraph is left to right at level 0 (no levels array); `visualOrder` is the real L2.
 */

/** Characters of right-to-left scripts (strong R and AL). Scaffold approximation; A owns the exact classes. */
const STRONG_RTL =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;

/** Whether text[start, end) has a strong right-to-left character. */
export function hasStrongRtl(text: string, start = 0, end = text.length): boolean {
  return STRONG_RTL.test(start === 0 && end === text.length ? text : text.slice(start, end));
}

/** The direction of the first strong character of text[start, end), or null when there is none. */
export function firstStrong(text: string, start = 0, end = text.length): 'ltr' | 'rtl' | null {
  for (let i = start; i < end; ) {
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (STRONG_RTL.test(ch)) return 'rtl';
    if (/\p{L}/u.test(ch)) return 'ltr';
    i += cp > 0xffff ? 2 : 1;
  }
  return null;
}

/** UAX#9 levels of the paragraph text[start, end) with base direction `dir`. */
export function bidiParagraph(
  _text: string,
  _start: number,
  _end: number,
  _dir: 'ltr' | 'rtl' | 'auto',
): BidiPara {
  return { level: 0, levels: null };
}

/**
 * UAX#9 rule L2: the visual order (left to right) of items with these embedding levels, as indices into
 * `levels`. From the highest level down to the lowest odd level, every maximal run at that level or higher
 * is reversed.
 */
export function visualOrder(levels: ArrayLike<number>): number[] {
  const n = levels.length;
  const order = Array.from({ length: n }, (_, i) => i);
  let max = 0;
  let minOdd = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const l = levels[i]!;
    if (l > max) max = l;
    if (l % 2 === 1 && l < minOdd) minOdd = l;
  }
  for (let level = max; level >= minOdd; level--) {
    for (let i = 0; i < n; ) {
      if (levels[order[i]!]! < level) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && levels[order[j]!]! >= level) j++;
      for (let a = i, b = j - 1; a < b; a++, b--) [order[a], order[b]] = [order[b]!, order[a]!];
      i = j;
    }
  }
  return order;
}
