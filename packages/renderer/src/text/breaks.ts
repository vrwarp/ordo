/// <reference path="./vendor.d.ts" />
import LineBreaker from 'linebreak';

/*
 * Stage 3, line-break opportunities (design/27 §6 step 3). Owner: breaks-bidi (A).
 *
 * - UAX#14 over the logical text of a paragraph with npm `linebreak` 1.1.0 (MIT). It already keeps CJK
 *   punctuation with its ideographs by the ID/CL/NS/OP classes (no break before 、。」ー or small kana, none
 *   after 「), breaks between ideographs and Hangul syllables, and never breaks inside a word of an
 *   alphabetic script, a combining sequence, an emoji sequence or a pair of regional indicators.
 * - No-break characters never break on either side: U+00A0, U+202F, U+2060, and also U+2007, U+2011 and
 *   U+FEFF. This is the verified 'Dieu !' split: French puts U+00A0 or U+202F before '!', '?', ':' and ';'.
 *   After a breaking space a line may still end before one (UAX#14 LB18 over LB12a), as LibreOffice and
 *   PowerPoint break it: text pasted with two spaces after a full stop stores ". \u00A0", and its lines
 *   break after the space, the no-break space starting the next line.
 * - SA scripts (Thai, Lao, Khmer, Myanmar) write words without spaces; UAX#14 resolves them to AL (no
 *   break), so their runs are split at `Intl.Segmenter` word boundaries (the ICU dictionaries, the same
 *   the browser uses). Never before a mark, a repetition mark (ๆ) or an abbreviation mark (ฯ).
 * - Korean breaks at spaces (CSS `word-break: keep-all` for Hangul, as LibreOffice and PowerPoint break it,
 *   M6 repair): no break between two letter units of a word when one of them is Hangul ('이야기를' stays
 *   whole), where UAX#14 would break between syllables; ideographs and kana still break between each other.
 *   A Korean word wider than the line still breaks, at its clusters (below).
 * - Emergency breaks, for a word wider than the line, fall only between clusters: extended grapheme
 *   clusters (`Intl.Segmenter`) joined across a conjunct-forming virama, so Tamil 'க்ஷி' and Kannada
 *   'ಕ್ಷಿ' stay whole whatever Unicode version the browser's segmenter has.
 *
 * Breaks never depend on the font or the device size: the same text breaks at the same offsets in every
 * drawer, and lines.ts only chooses among them by width.
 */

/** No-break characters: no line break on either side of them (U+00A0, U+2007, U+2011, U+202F, U+2060, U+FEFF). */
export function isGlue(c: number): boolean {
  return c === 0x00a0 || c === 0x202f || c === 0x2060 || c === 0x2007 || c === 0x2011 || c === 0xfeff;
}

/**
 * Whether a UTF-16 unit is whitespace a line may break after and which hangs at a line end: space, tab,
 * the ideographic space and the other breaking space separators (never U+00A0, U+2007 or U+202F).
 */
export function isBreakSpace(c: number): boolean {
  if (c === 0x20 || c === 0x09) return true;
  if (c < 0x1680) return false;
  return c === 0x3000 || c === 0x1680 || c === 0x205f || (c >= 0x2000 && c <= 0x200a && c !== 0x2007);
}

/**
 * Offsets b with start < b < end where a line may end before `text[b]`, ascending. The paragraph's end
 * is always a (mandatory) break and is not listed. A mandatory break inside the paragraph (U+2028, a lone
 * CR) is listed as an ordinary opportunity: paragraphs are the '\n' pieces of the text.
 */
export function breakOpportunities(text: string, start: number, end: number, lang: string): number[] {
  const out: number[] = [];
  if (end - start < 2) return out;
  const s = text.slice(start, end);
  const lb = new LineBreaker(s);
  const hangul = HANGUL.test(s);
  for (let b = lb.nextBreak(); b && b.position < s.length; b = lb.nextBreak()) {
    const p = b.position;
    const before = s.charCodeAt(p - 1);
    if (hangul && keepAll(s, p)) continue;
    if (p > 0 && !isGlue(before) && (!isGlue(s.charCodeAt(p)) || isBreakSpace(before))) out.push(start + p);
  }
  if (!SA_BLOCK.test(s)) return out;
  const sa = saBreaks(s, lang);
  if (!sa.length) return out;
  const merged: number[] = [];
  let i = 0;
  let j = 0;
  while (i < out.length || j < sa.length) {
    const a = out[i] ?? Number.POSITIVE_INFINITY;
    const b = start + (sa[j] ?? Number.POSITIVE_INFINITY);
    if (a <= b) {
      merged.push(a);
      i++;
      if (a === b) j++;
    } else {
      merged.push(b);
      j++;
    }
  }
  return merged;
}

// ---- Korean (keep-all) ----

/** Hangul syllables, jamo, compatibility jamo and the extended jamo blocks. */
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/;
/** A letter unit of a word: a letter, a mark or a digit. */
const WORD_UNIT = /[\p{L}\p{M}\p{N}]/u;

/** Whether the break before `s[p]` falls inside a Korean word (letter units on both sides, one Hangul). */
function keepAll(s: string, p: number): boolean {
  // The unit before p may be the low half of a surrogate pair: take the whole code point.
  const lo = s.charCodeAt(p - 1);
  const at = lo >= 0xdc00 && lo <= 0xdfff && p >= 2 ? p - 2 : p - 1;
  const prev = String.fromCodePoint(s.codePointAt(at) ?? 0);
  const next = String.fromCodePoint(s.codePointAt(p) ?? 0);
  return WORD_UNIT.test(prev) && WORD_UNIT.test(next) && (HANGUL.test(prev) || HANGUL.test(next));
}

// ---- SA scripts ----

/** The blocks of the SA scripts with a dictionary in ICU: Thai, Lao, Myanmar (and its extensions), Khmer. */
const SA_BLOCK =
  /[\u{0E00}-\u{0EFF}\u{1000}-\u{109F}\u{1780}-\u{17FF}\u{19E0}-\u{19FF}\u{A9E0}-\u{A9FF}\u{AA60}-\u{AA7F}]/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const MARK = /\p{M}/u;
/** Never at the start of a line: repetition marks (ๆ ໆ ៗ ꩰ ꧦ) and abbreviation marks (ฯ ຯ). */
const NO_BREAK_BEFORE = new Set([0x0e46, 0x0ec6, 0x17d7, 0xaa70, 0xa9e6, 0x0e2f, 0x0eaf]);

/** Whether the unit `ch` is a letter or mark of an SA script (UAX#14 class SA: no digits or punctuation). */
function isSa(ch: string): boolean {
  return SA_BLOCK.test(ch) && LETTER_OR_MARK.test(ch);
}

/** Word boundaries inside the SA runs of `s`, as offsets into `s`, ascending. */
function saBreaks(s: string, lang: string): number[] {
  const out: number[] = [];
  const seg = wordSegmenter(lang);
  if (!seg) return out;
  for (let i = 0; i < s.length; ) {
    if (!isSa(s[i]!)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < s.length && isSa(s[j]!)) j++;
    if (j - i > 1)
      for (const { index } of seg.segment(s.slice(i, j))) {
        const p = i + index;
        if (index === 0 || NO_BREAK_BEFORE.has(s.charCodeAt(p)) || MARK.test(s[p]!)) continue;
        out.push(p);
      }
    i = j;
  }
  return out;
}

const wordSegmenters = new Map<string, Intl.Segmenter | null>();

/** A word segmenter for `lang` (any valid BCP 47 tag; else the root locale), or null without Intl.Segmenter. */
function wordSegmenter(lang: string): Intl.Segmenter | null {
  const hit = wordSegmenters.get(lang);
  if (hit !== undefined) return hit;
  let seg: Intl.Segmenter | null = null;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      seg = new Intl.Segmenter(lang || undefined, { granularity: 'word' });
    } catch {
      seg = new Intl.Segmenter(undefined, { granularity: 'word' }); // a malformed tag (clampLang keeps [A-Za-z0-9-])
    }
  }
  if (wordSegmenters.size >= 32) wordSegmenters.clear();
  wordSegmenters.set(lang, seg);
  return seg;
}

// ---- Clusters ----

let graphemes: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (graphemes === undefined)
    graphemes =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  return graphemes;
}

/**
 * Viramas that form conjuncts with a following consonant (Brahmic scripts). Sinhala's al-lakuna only does
 * with a ZWJ after it; Tamil's pulli only in க்ஷ and ஸ்ர (`conjoins`).
 */
const VIRAMAS = new Set([
  0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d3b, 0x0d3c, 0x0d4d, 0x0dca, 0x1039,
  0x17d2, 0x1a60, 0x1b44, 0x1bab, 0xa8c4, 0xa9c0,
]);
const LETTER = /\p{L}/u;

/** Whether the cluster boundary at `b` falls inside a conjunct: a virama (+ ZWJ) before a consonant. */
function conjoins(text: string, b: number): boolean {
  let v = b - 1;
  const zwj = text.charCodeAt(v) === 0x200d;
  if (zwj) v--;
  const virama = text.charCodeAt(v);
  if (!VIRAMAS.has(virama)) return false;
  const next = text.charCodeAt(b);
  if (virama === 0x0bcd) {
    const base = text.charCodeAt(v - 1);
    return (base === 0x0b95 && next === 0x0bb7) || (base === 0x0bb8 && next === 0x0bb0);
  }
  if (virama === 0x0dca && !zwj) return false;
  return LETTER.test(String.fromCharCode(next));
}

/**
 * Offsets b with start < b < end between two clusters, ascending: where an emergency break may cut a
 * piece wider than the line, and where a style cut may fall (segments.ts moves one that does not). A
 * cluster is an extended grapheme cluster, joined across a conjunct-forming virama.
 */
export function graphemeBoundaries(text: string, start: number, end: number): number[] {
  const out: number[] = [];
  if (end - start < 2) return out;
  let simple = true;
  for (let i = start; i < end; i++)
    if (text.charCodeAt(i) >= 0x300) {
      simple = false;
      break;
    }
  if (simple) {
    // Latin-1 and the Latin extensions below the combining marks: every unit is a cluster.
    for (let i = start + 1; i < end; i++) out.push(i);
    return out;
  }
  const seg = graphemeSegmenter();
  if (seg) {
    for (const { index } of seg.segment(text.slice(start, end))) if (index > 0) out.push(start + index);
  } else codePointClusters(text, start, end, out);
  let k = 0;
  for (const b of out) if (!conjoins(text, b)) out[k++] = b;
  out.length = k;
  return out;
}

const EXTEND = /^(?:\p{M}|\p{Emoji_Modifier}|\u{200D}|[\u{E0020}-\u{E007F}])$/u;

/** Without Intl.Segmenter: code points, with marks, joiners, emoji modifiers and tags attached. */
function codePointClusters(text: string, start: number, end: number, out: number[]): void {
  let prev = -1;
  for (let i = start; i < end; ) {
    const cp = text.codePointAt(i)!;
    if (i > start && prev !== 0x200d && !EXTEND.test(String.fromCodePoint(cp))) out.push(i);
    prev = cp;
    i += cp > 0xffff ? 2 : 1;
  }
}
