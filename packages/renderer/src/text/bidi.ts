import bidiFactory from 'bidi-js';

import type { BidiPara } from './types.ts';

/*
 * Stage 2, bidi (design/27 §6 steps 2 and 6). Owner: breaks-bidi (A).
 *
 * UAX#9 per paragraph with npm `bidi-js` 1.1.0 (MIT, Unicode 13, conformant to UAX#9 C1), run only when
 * the paragraph has a right-to-left character (strong R or AL, or an RLE, RLO or RLI) or its base
 * direction is right to left. The base direction is `paras[i].rtl`, else `style.direction`, else 'auto':
 * the first strong character (UAX#9 P2-P3), which segments.ts resolves over a whole soft-break chain (one
 * PowerPoint paragraph). Everything else takes the fast path: level 0, no levels array, no bidi-js call.
 *
 * Visual reordering between segments (UAX#9 L2) happens per line in lines.ts through `visualOrder`; the
 * browser orders and mirrors the glyphs within a segment (`ctx.direction` from the segment's level).
 */

/**
 * Bidi_Class R and AL (bidi-js's data: assigned characters and the code points that default to R or AL),
 * as a regex character class body. Generated from `getBidiCharTypeName` over every code point.
 */
const RTL_CLASS =
  '\u{0590}\u{05BE}\u{05C0}\u{05C3}\u{05C6}\u{05C8}-\u{05FF}\u{0608}\u{060B}\u{060D}' +
  '\u{061B}-\u{064A}\u{066D}-\u{066F}\u{0671}-\u{06D5}\u{06E5}-\u{06E6}\u{06EE}-\u{06EF}' +
  '\u{06FA}-\u{0710}\u{0712}-\u{072F}\u{074B}-\u{07A5}\u{07B1}-\u{07EA}\u{07F4}-\u{07F5}' +
  '\u{07FA}-\u{07FC}\u{07FE}-\u{0815}\u{081A}\u{0824}\u{0828}\u{082E}-\u{0858}\u{085C}-\u{08D2}' +
  '\u{200F}\u{FB1D}\u{FB1F}-\u{FB28}\u{FB2A}-\u{FD3D}\u{FD40}-\u{FDCF}\u{FDF0}-\u{FDFC}' +
  '\u{FDFE}-\u{FDFF}\u{FE70}-\u{FEFE}\u{10800}-\u{1091E}\u{10920}-\u{10A00}\u{10A04}' +
  '\u{10A07}-\u{10A0B}\u{10A10}-\u{10A37}\u{10A3B}-\u{10A3E}\u{10A40}-\u{10AE4}\u{10AE7}-\u{10B38}' +
  '\u{10B40}-\u{10D23}\u{10D28}-\u{10D2F}\u{10D3A}-\u{10E5F}\u{10E7F}-\u{10EAA}\u{10EAD}-\u{10F45}' +
  '\u{10F51}-\u{10FFF}\u{1E800}-\u{1E8CF}\u{1E8D7}-\u{1E943}\u{1E94B}-\u{1EEEF}\u{1EEF2}-\u{1EFFF}';

const STRONG_RTL = new RegExp(`[${RTL_CLASS}]`, 'u');
/** Characters that can make a paragraph's levels odd: strong R and AL, and RLE, RLO and RLI. */
const RTL_CONTENT = new RegExp(`[${RTL_CLASS}\\u{202B}\\u{202E}\\u{2067}]`, 'u');

/** Whether text[start, end) matches `re` (only scanned from the first unit at or above U+0590). */
function scan(re: RegExp, text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++)
    if (text.charCodeAt(i) >= 0x0590)
      return re.test(i === 0 && end === text.length ? text : text.slice(i, end));
  return false;
}

/** Whether text[start, end) has a strong right-to-left character (Bidi_Class R or AL, exactly). */
export function hasStrongRtl(text: string, start = 0, end = text.length): boolean {
  return scan(STRONG_RTL, text, start, end);
}

type Bidi = ReturnType<typeof bidiFactory>;
let engine: Bidi | undefined;

/** The bidi-js engine, made on first use (it parses its character data then). */
function bidi(): Bidi {
  engine ??= bidiFactory();
  return engine;
}

/**
 * The direction of the first strong character of text[start, end) (Bidi_Class L, R or AL, skipping the
 * contents of isolates as UAX#9 P2 does), or null when there is none.
 */
export function firstStrong(text: string, start = 0, end = text.length): 'ltr' | 'rtl' | null {
  let isolates = 0;
  for (let i = start; i < end; ) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    if (cp < 0x80) {
      const lower = cp | 0x20;
      if (!isolates && lower >= 0x61 && lower <= 0x7a) return 'ltr';
      continue;
    }
    if (cp >= 0x2066 && cp <= 0x2068) isolates++;
    else if (cp === 0x2069) isolates = Math.max(0, isolates - 1);
    else if (!isolates && (cp < 0xd800 || cp > 0xdfff)) {
      const ch = String.fromCodePoint(cp);
      if (STRONG_RTL.test(ch)) return 'rtl';
      if (bidi().getBidiCharTypeName(ch) === 'L') return 'ltr';
    }
  }
  return null;
}

/** A BMP character of each Bidi_Class an astral character can have (see `bmpProxy`). */
const PROXY: Partial<Record<string, string>> = {
  L: 'a',
  R: '\u{05D0}',
  AL: '\u{0627}',
  EN: '0',
  ES: '+',
  ET: '#',
  AN: '\u{0660}',
  CS: ',',
  ON: '!',
  NSM: '\u{0300}',
  BN: '\u{00AD}',
};

/**
 * `s` with each astral character replaced by two BMP characters of its Bidi_Class. bidi-js classifies
 * UTF-16 units, so a surrogate pair would otherwise read as two L characters: an emoji (ON) between two
 * Hebrew words would split them, and an Adlam or Hanifi Rohingya word (R, AL) would read as left to
 * right. Two characters of one class resolve like one, so the levels keep their meaning per unit.
 */
function bmpProxy(s: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff) continue;
    const d = s.charCodeAt(i + 1);
    if (!(d >= 0xdc00 && d <= 0xdfff)) continue;
    const ch = PROXY[bidi().getBidiCharTypeName(s.slice(i, i + 2))] ?? 'a';
    out += s.slice(from, i) + ch + ch;
    from = i + 2;
    i++;
  }
  return from ? out + s.slice(from) : s;
}

/**
 * UAX#9 levels of the paragraph text[start, end) with base direction `dir` ('auto': the first strong
 * character, else left to right). `levels` is null when every unit is at the paragraph level, always so
 * for a left-to-right paragraph without right-to-left characters.
 */
export function bidiParagraph(
  text: string,
  start: number,
  end: number,
  dir: 'ltr' | 'rtl' | 'auto',
): BidiPara {
  const level: 0 | 1 =
    dir === 'rtl' ? 1 : dir === 'ltr' ? 0 : firstStrong(text, start, end) === 'rtl' ? 1 : 0;
  if (end <= start || (!level && !scan(RTL_CONTENT, text, start, end))) return { level, levels: null };
  const s = bmpProxy(text.slice(start, end));
  const { levels } = bidi().getEmbeddingLevels(s, level ? 'rtl' : 'ltr');
  for (let i = 0; i < levels.length; i++) if (levels[i] !== level) return { level, levels };
  return { level, levels: null };
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
