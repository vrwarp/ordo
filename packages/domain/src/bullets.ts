import type { TextPara } from './schemas.ts';

/*
 * Bullets and automatic numbers of text paragraphs (design/27 §6 step 11), shared by everything that shows
 * them: the renderer's bullets (packages/renderer/src/text/bullets.ts) draw these labels, and
 * `readableText` (readable.ts) writes them as text for the stage, bands, cue labels and search, so people
 * read what the outputs draw. The PowerPoint converter maps symbol-font bullets with `symbolFontChar`.
 *
 * The counting is a port of pptx-render's annotate.ts `bulletOf`/`autoNumber`, which matched PowerPoint
 * and LibreOffice on the validation decks:
 * - each level keeps its last number and that number's key, `type:startAt`; a paragraph continues the
 *   sequence when its level's key is unchanged, else it starts again at `startAt`;
 * - a paragraph ends the sequences of every deeper level, and a paragraph of the same level without a
 *   number (a character bullet, or none) ends that level's sequence too;
 * - an empty paragraph draws no bullet and neither counts nor ends anything; a soft paragraph (a:br) is a
 *   line of the paragraph before it, so it has no label of its own and its text counts for that paragraph.
 */

/** Wingdings code (U+F0xx offset stripped) → Unicode: the bullets PowerPoint offers and other common ones. */
export const WINGDINGS_TO_UNICODE: ReadonlyMap<number, string> = new Map([
  [0x6c, '\u{25cf}'], // black circle
  [0x6d, '\u{274d}'], // shadowed white circle
  [0x6e, '\u{25a0}'], // black square
  [0x6f, '\u{25a1}'], // white square
  [0x71, '\u{2751}'], // lower right shadowed white square ("hollow square bullets")
  [0x72, '\u{2752}'], // upper right shadowed white square
  [0x73, '\u{2b27}'], // black medium lozenge
  [0x74, '\u{29eb}'], // black lozenge
  [0x75, '\u{25c6}'], // black diamond
  [0x76, '\u{2756}'], // black diamond minus white x ("star bullets")
  [0x77, '\u{2b25}'], // black medium diamond
  [0x78, '\u{2327}'], // x in a rectangle box
  [0x7a, '\u{2318}'], // place of interest sign
  [0x9f, '\u{2022}'], // bullet
  [0xa1, '\u{25cb}'], // white circle
  [0xa4, '\u{25c9}'], // fisheye
  [0xa5, '\u{25ce}'], // bullseye
  [0xa7, '\u{25aa}'], // black small square ("filled square bullets")
  [0xa8, '\u{25fb}'], // white medium square
  [0xd8, '\u{27a2}'], // three-D top-lighted rightwards arrowhead ("arrow bullets")
  [0xe8, '\u{2794}'], // heavy wide-headed rightwards arrow
  [0xf0, '\u{21e8}'], // rightwards white arrow
  [0xfb, '\u{2717}'], // ballot x
  [0xfc, '\u{2713}'], // check mark ("checkmark bullets")
  [0xfd, '\u{2612}'], // ballot box with x
  [0xfe, '\u{2611}'], // ballot box with check
]);

/**
 * Symbol code (U+F0xx offset stripped) → Unicode: Adobe's Symbol encoding for the Greek letters, the
 * bullet and the common signs. Other codes below 0x7F are the ASCII character itself.
 */
export const SYMBOL_TO_UNICODE: ReadonlyMap<number, string> = new Map([
  [0x22, '\u{2200}'], // for all
  [0x24, '\u{2203}'], // there exists
  [0x27, '\u{220b}'], // contains as member
  [0x2a, '\u{2217}'], // asterisk operator
  [0x2d, '\u{2212}'], // minus sign
  [0x40, '\u{2245}'], // approximately equal to
  ...letters(0x41, 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ'),
  [0x5c, '\u{2234}'], // therefore
  [0x5e, '\u{22a5}'], // up tack
  ...letters(0x61, 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ'),
  [0x7e, '\u{223c}'], // tilde operator
  [0xa3, '\u{2264}'], // less-than or equal to
  [0xa5, '\u{221e}'], // infinity
  [0xa7, '\u{2663}'], // club suit
  [0xa8, '\u{2666}'], // diamond suit
  [0xa9, '\u{2665}'], // heart suit
  [0xaa, '\u{2660}'], // spade suit
  [0xab, '\u{2194}'], // left right arrow
  [0xac, '\u{2190}'], // leftwards arrow
  [0xad, '\u{2191}'], // upwards arrow
  [0xae, '\u{2192}'], // rightwards arrow
  [0xaf, '\u{2193}'], // downwards arrow
  [0xb0, '\u{b0}'], // degree sign
  [0xb1, '\u{b1}'], // plus-minus sign
  [0xb3, '\u{2265}'], // greater-than or equal to
  [0xb4, '\u{d7}'], // multiplication sign
  [0xb7, '\u{2022}'], // bullet ("filled round bullets" in a Symbol font)
  [0xb8, '\u{f7}'], // division sign
  [0xb9, '\u{2260}'], // not equal to
  [0xba, '\u{2261}'], // identical to
  [0xbb, '\u{2248}'], // almost equal to
  [0xbc, '\u{2026}'], // horizontal ellipsis
  [0xd7, '\u{22c5}'], // dot operator
  [0xe0, '\u{25ca}'], // lozenge
]);

function letters(first: number, chars: string): [number, string][] {
  return [...chars].map((ch, i) => [first + i, ch]);
}

/** The mapping table of a symbol font family ('Wingdings', 'Symbol', any case), else null. */
function symbolTable(fontFamily: string | undefined): ReadonlyMap<number, string> | null {
  const f = fontFamily?.trim().toLowerCase();
  return f === 'wingdings' ? WINGDINGS_TO_UNICODE : f === 'symbol' ? SYMBOL_TO_UNICODE : null;
}

/** Whether `fontFamily` is a symbol font whose codes `symbolFontChar` maps to Unicode. */
export function isSymbolFont(fontFamily: string | undefined): boolean {
  return symbolTable(fontFamily) !== null;
}

/**
 * A bullet character of a Wingdings or Symbol font as Unicode text (design/27 §6 step 11), or null when
 * `fontFamily` is neither. Private-use codes U+F020-U+F0FF lose their U+F000 offset first. A code the
 * table does not know becomes '•' (a Symbol code below 0x7F is its ASCII character); characters above
 * U+00FF are already Unicode and stay. The result is meant to be drawn in the text's font, not the
 * symbol font.
 */
export function symbolFontChar(fontFamily: string | undefined, char: string): string | null {
  const table = symbolTable(fontFamily);
  if (!table) return null;
  let out = '';
  for (const ch of char) {
    let c = ch.codePointAt(0)!;
    if (c >= 0xf020 && c <= 0xf0ff) c -= 0xf000;
    if (c > 0xff) out += ch;
    else if (c === 0x20) out += ' ';
    else if (c > 0x20) {
      const mapped = table.get(c);
      if (mapped) out += mapped;
      else out += table === SYMBOL_TO_UNICODE && c < 0x7f ? String.fromCharCode(c) : '\u{2022}';
    }
  }
  return out;
}

/** An automatic number's label: `n` in an OOXML `ST_TextAutonumberScheme` ('arabicPeriod', ...). */
export function autoNumberLabel(type: string, n: number): string {
  const m = SCHEME.exec(type);
  if (!m) {
    if (type === 'circleNumDbPlain' || type === 'circleNumWdWhitePlain')
      return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n); // circled 1-20
    if (type === 'circleNumWdBlackPlain') {
      if (n >= 1 && n <= 10) return String.fromCodePoint(0x2776 + n - 1); // negative circled 1-10
      return n >= 11 && n <= 20 ? String.fromCodePoint(0x24eb + n - 11) : String(n); // and 11-20
    }
    return `${n}.`; // an unknown scheme reads as arabicPeriod (schemas.ts TextPara.bullet.auto)
  }
  const kind = m[1]!;
  let v: string;
  if (kind === 'arabic') v = String(n);
  else if (kind === 'arabicDb') v = digits(n, 0xff10);
  else if (kind === 'thaiNum') v = digits(n, 0x0e50);
  else if (kind === 'hindiNum') v = digits(n, 0x0966);
  else if (kind.startsWith('roman')) {
    v = roman(n);
    if (kind === 'romanLc') v = v.toLowerCase();
  } else {
    // a..z, then aa..zz, then aaa...: the letter repeated, as PowerPoint and LibreOffice count. Past ten
    // letters (n > 260) the number is written in digits, which keeps labels short whatever startAt says.
    const times = Math.floor((n - 1) / 26) + 1;
    v = times > 10 ? String(n) : String.fromCharCode(97 + ((n - 1) % 26)).repeat(times);
    if (kind === 'alphaUc') v = v.toUpperCase();
  }
  switch (m[2]) {
    case 'Period':
      return kind === 'arabicDb' ? `${v}\u{ff0e}` : `${v}.`; // a full-width period with full-width digits
    case 'ParenR':
      return `${v})`;
    case 'ParenBoth':
      return `(${v})`;
    case 'Minus':
      return `- ${v} -`;
    default:
      return v;
  }
}

const SCHEME =
  /^(arabic|arabicDb|thaiNum|hindiNum|romanUc|romanLc|alphaUc|alphaLc)(Period|ParenR|ParenBoth|Plain|Minus)$/;

/** `n` in the decimal digits that start at `zero`. */
function digits(n: number, zero: number): string {
  let out = '';
  for (const d of String(n)) out += String.fromCharCode(zero + d.charCodeAt(0) - 48);
  return out;
}

const ROMAN: readonly [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function roman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  let out = '';
  for (const [v, s] of ROMAN)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}

/**
 * What never reaches a label, which is written into text people read: control characters, line and
 * paragraph separators, bidi marks, embeddings, overrides and isolates (an unclosed override would turn
 * the rest of the paragraph around), and lone surrogates.
 */
const UNSAFE =
  /[\p{Cc}\u{2028}\u{2029}\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{d800}-\u{dfff}]/gu;

/** A character bullet's label: mapped from a symbol font, without unsafe characters; null when blank. */
function charLabel(bullet: { char?: unknown; fontFamily?: unknown }): string | null {
  if (typeof bullet.char !== 'string') return null;
  const family = typeof bullet.fontFamily === 'string' ? bullet.fontFamily : undefined;
  const label = (symbolFontChar(family, bullet.char) ?? bullet.char).replace(UNSAFE, '').trim();
  return label || null;
}

/**
 * The automatic-number counters of one text box, one per level (port of annotate.ts `bulletOf`). Feed it
 * the box's paragraphs in order with `next`; soft paragraphs are not fed.
 */
export class NumberCounter {
  readonly #levels: ({ key: string; n: number } | undefined)[] = [];

  /**
   * The label of the next paragraph ('1.', '(17)', '•'), or null for none. `hasText`: whether the
   * paragraph (with its soft lines) has any text; an empty one neither counts nor ends a sequence. An
   * automatic number (`auto`) wins over a character (`char`).
   */
  next(level: number, bullet: TextPara['bullet'], hasText: boolean): string | null {
    if (!hasText) return null;
    const lvl = Number.isFinite(level) ? Math.max(0, Math.min(8, Math.round(level))) : 0;
    const levels = this.#levels;
    levels.length = Math.min(levels.length, lvl + 1);
    if (!bullet || typeof bullet !== 'object') {
      levels[lvl] = undefined;
      return null;
    }
    if (typeof bullet.auto !== 'string') {
      levels[lvl] = undefined;
      return charLabel(bullet);
    }
    const at = bullet.startAt;
    const start =
      typeof at === 'number' && Number.isFinite(at) ? Math.max(1, Math.min(32_767, Math.round(at))) : 1;
    const key = `${bullet.auto}:${start}`;
    const prev = levels[lvl];
    const n = prev && prev.key === key ? prev.n + 1 : start;
    levels[lvl] = { key, n };
    return autoNumberLabel(bullet.auto, n);
  }
}

/** What labels are computed from: a text and its paragraph styles (a TextObject will do). */
export type LabelSource = {
  text: string;
  paras?: readonly (TextPara | null | undefined)[] | null | undefined;
};

/**
 * The label drawn before each paragraph ('1.', '(17)', '•'), or null for none; index = paragraph index
 * (`text.split('\n')`, `paras`). Automatic numbers are counted per level (`NumberCounter`); a character
 * bullet is its character, mapped to Unicode from a Wingdings or Symbol `fontFamily`. Soft and empty
 * paragraphs have no label. Inputs need not be clamped.
 */
export function paraLabels(o: LabelSource): (string | null)[] {
  const parts = o.text.split('\n');
  const out: (string | null)[] = new Array(parts.length).fill(null);
  const paras = o.paras;
  if (!Array.isArray(paras) || !paras.length) return out;
  const soft = (i: number) => i > 0 && paras[i]?.soft === true;
  const counter = new NumberCounter();
  for (let i = 0; i < parts.length; i++) {
    if (soft(i)) continue;
    let hasText = parts[i]!.length > 0;
    for (let j = i + 1; !hasText && j < parts.length && soft(j); j++) hasText = parts[j]!.length > 0;
    const p = paras[i];
    out[i] = counter.next(typeof p?.level === 'number' ? p.level : 0, p?.bullet, hasText);
  }
  return out;
}
