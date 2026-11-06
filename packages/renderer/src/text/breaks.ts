/*
 * Stage 3, line-break opportunities (design/27 §6 step 3). Owner: breaks-bidi (A).
 *
 * Scaffold: a line may break after a run of spaces or tabs, and an emergency break may fall between any two
 * code points. To build:
 * - UAX#14 over the logical text with npm `linebreak` 1.1.0 (MIT); U+00A0, U+202F and U+2060 never break
 *   (the verified 'Dieu !' split);
 * - SA scripts (Thai, Lao, Khmer, Myanmar) at `Intl.Segmenter` word boundaries, keyed by `lang`;
 * - CJK by the ID/CL/NS classes;
 * - emergency breaks only on grapheme boundaries (`Intl.Segmenter` grapheme), so Tamil 'க்ஷி' stays whole.
 */

/** Whether a UTF-16 unit is whitespace a line may break after (never U+00A0, U+202F or U+2060). */
export function isBreakSpace(c: number): boolean {
  return c === 0x20 || c === 0x09;
}

/**
 * Offsets b with start < b < end where a line may end before `text[b]`, ascending. The paragraph's end
 * is always a (mandatory) break and is not listed.
 */
export function breakOpportunities(text: string, start: number, end: number, _lang: string): number[] {
  const out: number[] = [];
  for (let i = start + 1; i < end; i++)
    if (isBreakSpace(text.charCodeAt(i - 1)) && !isBreakSpace(text.charCodeAt(i))) out.push(i);
  return out;
}

/**
 * Offsets b with start < b < end where an emergency break may cut a piece that is wider than the line,
 * ascending: grapheme cluster boundaries.
 */
export function graphemeBoundaries(text: string, start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; ) {
    const cp = text.codePointAt(i) ?? 0;
    i += cp > 0xffff ? 2 : 1;
    if (i < end) out.push(i);
  }
  return out;
}
