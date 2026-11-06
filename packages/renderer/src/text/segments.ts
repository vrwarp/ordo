import { FALLBACK_SCRIPTS } from '@ordo/domain';

import { bidiParagraph, firstStrong } from './bidi.ts';
import { breakOpportunities, graphemeBoundaries, isBreakSpace } from './breaks.ts';
import type { BidiPara, ItemPara, Itemized, Piece, PreparedPara, RunStyle } from './types.ts';

/*
 * Stage 4, segments (design/27 §6 step 4). Owner: breaks-bidi (A).
 *
 * A piece is a maximal substring with one style run, one bidi level and no break opportunity inside (and
 * one script among those that need a fallback face, so each piece asks for one: `Piece.script`).
 * - A style cut must fall between clusters (breaks.ts `graphemeBoundaries`): one inside a cluster (an
 *   Indic conjunct such as Tamil 'க்ஷி', a letter and its combining marks, an emoji sequence) moves to the
 *   cluster's end, so the whole cluster takes the earlier run's style; `PreparedPara.movedCuts` counts
 *   them. Without this the browser would draw a broken cluster with a dotted circle.
 * - A cut inside a word of a joining script (Arabic, Syriac, N'Ko, Mongolian, Adlam), where the letters on
 *   both sides join, is drawn and measured with U+200D on both sides (`segText`), which keeps their medial
 *   and final forms. The joiners exist only in the drawn string, never in offsets.
 * - 'auto' paragraphs take the direction of the first strong character of their whole soft-break chain
 *   (one PowerPoint paragraph), so a soft line continues its paragraph's direction.
 */

/** Each paragraph's bidi levels, break opportunities and pieces. */
export function prepare(it: Itemized): PreparedPara[] {
  const { text, paras } = it;
  const out: PreparedPara[] = [];
  let chain: 'ltr' | 'rtl' | null = null; // the 'auto' direction of the current soft-break chain
  for (let i = 0; i < paras.length; i++) {
    const para = paras[i]!;
    if (!para.soft) chain = null;
    let dir = para.style.dir;
    if (dir === 'auto') {
      chain ??= chainDirection(it, i);
      dir = chain;
    }
    const bidi = bidiParagraph(text, para.start, para.end, dir);
    out.push(cutPieces(text, para, bidi));
  }
  return out;
}

/** The first strong direction of the soft-break chain holding paragraph `i` ('ltr' when it has none). */
function chainDirection(it: Itemized, i: number): 'ltr' | 'rtl' {
  let h = i;
  while (h > 0 && it.paras[h]!.soft) h--;
  for (let k = h; k < it.paras.length && (k === h || it.paras[k]!.soft); k++) {
    const p = it.paras[k]!;
    const d = firstStrong(it.text, p.start, p.end);
    if (d) return d;
  }
  return 'ltr';
}

type Span = { start: number; end: number; sr: number };

function cutPieces(text: string, para: ItemPara, bidi: BidiPara): PreparedPara {
  const pieces: Piece[] = [];
  if (para.end <= para.start) return { para, bidi, pieces };
  const { spans, moved } = styleSpans(text, para);
  const breaks = breakOpportunities(text, para.start, para.end, para.runs[0]?.style.lang ?? '');
  const levels = bidi.levels;
  const ps = para.start;
  let b = 0;
  // The end of the run of equal levels holding `at`: found once per run, not once per piece (a run cut
  // into one-letter pieces by alternating scripts would be scanned again for every piece).
  let levelEnd = ps;
  for (const sp of spans) {
    let at = sp.start;
    while (at < sp.end) {
      while (b < breaks.length && breaks[b]! <= at) b++;
      const brk = b < breaks.length ? breaks[b]! : Number.POSITIVE_INFINITY;
      let end = Math.min(sp.end, brk);
      const level = levels ? levels[at - ps]! : bidi.level;
      if (levels) {
        if (at >= levelEnd) {
          levelEnd = at + 1;
          while (levelEnd < para.end && levels[levelEnd - ps] === level) levelEnd++;
        }
        end = Math.min(end, levelEnd);
      }
      const sc = scriptCut(text, at, end);
      end = sc.end;
      let trail = end;
      while (trail > at && isBreakSpace(text.charCodeAt(trail - 1))) trail--;
      pieces.push({ start: at, end, trail, sr: sp.sr, level, breakAfter: end === brk, script: sc.script });
      at = end;
    }
  }
  const out: PreparedPara = { para, bidi, pieces };
  if (moved) out.movedCuts = moved;
  return out;
}

/** The paragraph's style runs as spans whose cuts fall between clusters (a cut inside one moves to its end). */
function styleSpans(text: string, para: ItemPara): { spans: Span[]; moved: number } {
  const spans: Span[] = [];
  let moved = 0;
  let pos = para.start;
  let bounds: number[] | null = null;
  para.runs.forEach((sr, k) => {
    let e = Math.min(sr.end, para.end);
    if (e < para.end && !clusterSafe(text, e)) {
      bounds ??= graphemeBoundaries(text, para.start, para.end);
      const snapped = boundaryAtOrAfter(bounds, e, para.end);
      if (snapped !== e) moved++;
      e = snapped;
    }
    if (e > pos) {
      spans.push({ start: pos, end: e, sr: k });
      pos = e;
    }
  });
  return { spans, moved };
}

/** A cut at `at` is certainly between clusters: both sides are below the combining marks (U+0300). */
function clusterSafe(text: string, at: number): boolean {
  return text.charCodeAt(at) < 0x300 && text.charCodeAt(at - 1) < 0x300;
}

/** The first of the ascending `bounds` at or after `at`, else `end`. */
function boundaryAtOrAfter(bounds: readonly number[], at: number, end: number): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  return lo < bounds.length ? bounds[lo]! : end;
}

// ---- Scripts that need a fallback face ----

/**
 * The scripts that need a fallback face: the domain's `FALLBACK_SCRIPTS`, the codes `textScripts` reports
 * and `SCRIPT_FALLBACK_FONTS` is keyed by, so a piece asks the font resolver for the face the goLive font
 * scan shipped. Every one of them starts at U+0370 (Greek) or later.
 */
const SCRIPT_CODES = FALLBACK_SCRIPTS.map(([code]) => code);
const SCRIPT_RE = new RegExp(FALLBACK_SCRIPTS.map(([, re]) => `(${re.source})`).join('|'), 'u');
/** Below this code unit no character belongs to a fallback script. */
const FIRST_SCRIPT_UNIT = 0x0370;
/** `scriptOf` by code point: text repeats its letters, and the alternation above is long. */
const scriptCache = new Map<number, string>();

/** The fallback script of one character ('' for every other script, Common and Inherited). */
export function scriptOf(ch: string): string {
  if (ch.charCodeAt(0) < FIRST_SCRIPT_UNIT) return '';
  const cp = ch.codePointAt(0)!;
  let s = scriptCache.get(cp);
  if (s === undefined) {
    s = '';
    const m = SCRIPT_RE.exec(String.fromCodePoint(cp));
    if (m) for (let g = 1; g < m.length; g++) if (m[g] !== undefined) s = SCRIPT_CODES[g - 1]!;
    if (scriptCache.size >= 4096) scriptCache.clear();
    scriptCache.set(cp, s);
  }
  return s;
}

/** Han, Hiragana and Katakana share one face (Noto CJK): never cut between them. */
const CJK = new Set(['Hani', 'Hira', 'Kana']);

/**
 * The piece text[at, end) cut where it changes from one fallback script to another, and its script: the
 * first fallback script in it, or ''.
 */
function scriptCut(text: string, at: number, end: number): { end: number; script: string } {
  let script = '';
  for (let i = at; i < end; ) {
    const c = text.charCodeAt(i);
    if (c < FIRST_SCRIPT_UNIT) {
      i++;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const s = scriptOf(String.fromCodePoint(cp));
    if (s) {
      if (!script) script = s;
      else if (s !== script && !(CJK.has(s) && CJK.has(script))) return { end: i, script };
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return { end, script };
}

// ---- Drawn strings ----

const ZWJ = '\u{200D}';

/**
 * The string drawn and measured for text[start, end) in a run with `caps`: case-mapped for 'all' (small
 * caps are the font string's `small-caps`), with U+200D added on a side where the cut splits two joining
 * letters. `measureText` and `fillText` always see this same string.
 */
export function segText(text: string, start: number, end: number, caps: RunStyle['caps']): string {
  if (end <= start) return '';
  let s = text.slice(start, end);
  if (caps === 'all') s = s.toUpperCase();
  if (start > 0 && joinsAcross(text, start)) s = ZWJ + s;
  if (end < text.length && joinsAcross(text, end)) s += ZWJ;
  return s;
}

/**
 * Whether the letters on both sides of a cut at `at` join (the joining types of ArabicShaping.txt): the
 * last non-transparent character before it joins forward (D, L or C) and the first after it joins
 * backward (D, R or C). A cut after alef, dal or waw (right-joining) or next to a hamza gets no joiner.
 */
export function joinsAcross(text: string, at: number): boolean {
  if (!mayJoin(text.charCodeAt(at)) && !mayJoin(text.charCodeAt(at - 1))) return false;
  let after: JoiningType = 'U';
  for (let j = at; j < text.length && j - at < 32; ) {
    const cp = text.codePointAt(j)!;
    const t = joiningType(cp);
    if (t !== 'T') {
      after = t;
      break;
    }
    j += cp > 0xffff ? 2 : 1;
  }
  if (after !== 'D' && after !== 'R' && after !== 'C') return false;
  for (let i = at; i > 0 && at - i < 32; ) {
    let cp = text.charCodeAt(i - 1);
    i--;
    if (cp >= 0xdc00 && cp <= 0xdfff && i > 0) {
      const hi = text.charCodeAt(i - 1);
      if (hi >= 0xd800 && hi <= 0xdbff) {
        cp = (hi - 0xd800) * 0x400 + (cp - 0xdc00) + 0x10000;
        i--;
      }
    }
    const t = joiningType(cp);
    if (t !== 'T') return t === 'D' || t === 'L' || t === 'C';
  }
  return false;
}

/** A unit that may belong to a joining character (a fast filter for `joinsAcross`). */
function mayJoin(c: number): boolean {
  return (
    (c >= 0x0600 && c <= 0x08ff) || (c >= 0x1800 && c <= 0x18af) || c === 0x200d || c === 0xd83a // Adlam
  );
}

/** ArabicShaping.txt joining types: Dual, Right, Left, join-Causing, Transparent, Unjoined. */
type JoiningType = 'D' | 'R' | 'L' | 'C' | 'T' | 'U';

// Exceptions to "a letter of a joining script is dual-joining" (ArabicShaping.txt, Unicode 15).
const JT_R: readonly (readonly [number, number])[] = [
  [0x0622, 0x0625],
  [0x0627, 0x0627],
  [0x0629, 0x0629],
  [0x062f, 0x0632],
  [0x0648, 0x0648],
  [0x0671, 0x0673],
  [0x0675, 0x0677],
  [0x0688, 0x0699],
  [0x06c0, 0x06c0],
  [0x06c3, 0x06cb],
  [0x06cd, 0x06cd],
  [0x06cf, 0x06cf],
  [0x06d2, 0x06d3],
  [0x06d5, 0x06d5],
  [0x06ee, 0x06ef],
  [0x0710, 0x0710],
  [0x0715, 0x0719],
  [0x071e, 0x071e],
  [0x0728, 0x0728],
  [0x072a, 0x072a],
  [0x072c, 0x072c],
  [0x072f, 0x072f],
  [0x074d, 0x074d],
  [0x0759, 0x075b],
  [0x076b, 0x076c],
  [0x0771, 0x0771],
  [0x0773, 0x0774],
  [0x0778, 0x0779],
  [0x0867, 0x0867],
  [0x0869, 0x086a],
  [0x0870, 0x0882],
  [0x088e, 0x088e],
  [0x08aa, 0x08ac],
  [0x08ae, 0x08ae],
  [0x08b1, 0x08b2],
  [0x08b9, 0x08b9],
];
const JT_U: readonly (readonly [number, number])[] = [
  [0x0600, 0x0605],
  [0x0621, 0x0621],
  [0x0674, 0x0674],
  [0x06dd, 0x06dd],
  [0x0861, 0x0861],
  [0x0866, 0x0866],
  [0x0890, 0x0891],
  [0x08ad, 0x08ad],
  [0x08e2, 0x08e2],
  [0x1880, 0x1884],
];
const JT_C: readonly (readonly [number, number])[] = [
  [0x0640, 0x0640],
  [0x07fa, 0x07fa],
  [0x0883, 0x0885],
  [0x180a, 0x180a],
];

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [a, b] of ranges) if (cp >= a && cp <= b) return true;
  return false;
}

const TRANSPARENT = /[\p{Mn}\p{Me}\p{Cf}]/u;
const LETTER = /\p{L}/u;

/** `joiningType` by code point: every measured string of a cut asks for it, and text repeats its letters. */
const joiningCache = new Map<number, JoiningType>();

/** The joining type of a code point, for Arabic, Syriac, N'Ko, Mongolian and Adlam (other scripts: U or T). */
export function joiningType(cp: number): JoiningType {
  let t = joiningCache.get(cp);
  if (t === undefined) {
    t = joiningTypeOf(cp);
    if (joiningCache.size >= 4096) joiningCache.clear();
    joiningCache.set(cp, t);
  }
  return t;
}

function joiningTypeOf(cp: number): JoiningType {
  if (cp === 0x200d) return 'C';
  if (cp === 0x200c) return 'U';
  const joining =
    (cp >= 0x0600 && cp <= 0x077f) || // Arabic, Syriac, Arabic Supplement
    (cp >= 0x07c0 && cp <= 0x07ff) || // N'Ko
    (cp >= 0x0860 && cp <= 0x08ff) || // Syriac Supplement, Arabic Extended-B and -A
    (cp >= 0x1800 && cp <= 0x18af) || // Mongolian
    (cp >= 0x1e900 && cp <= 0x1e95f); // Adlam
  if (joining && inRanges(cp, JT_U)) return 'U';
  const ch = String.fromCodePoint(cp);
  if (TRANSPARENT.test(ch) || cp === 0x1e94b) return 'T';
  if (!joining) return 'U';
  if (inRanges(cp, JT_R)) return 'R';
  if (inRanges(cp, JT_C)) return 'C';
  return LETTER.test(ch) || cp === 0x1807 ? 'D' : 'U';
}
