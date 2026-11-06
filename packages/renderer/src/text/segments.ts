import { bidiParagraph } from './bidi.ts';
import { breakOpportunities, isBreakSpace } from './breaks.ts';
import type { Itemized, Piece, PreparedPara, RunStyle } from './types.ts';

/*
 * Stage 4, segments (design/27 §6 step 4). Owner: breaks-bidi (A).
 *
 * A piece is a maximal substring with one style run, one bidi level and no break opportunity inside. To
 * build:
 * - a style cut inside a word of a joining script (Arabic, Syriac, N'Ko, Mongolian) is drawn and measured
 *   with U+200D on both sides of the cut (`segText`), which keeps medial and final forms;
 * - inside an Indic syllable cluster the cut moves to the cluster end (logged);
 * - `Piece.script` names the script when it needs a fallback face (FaceRequest.script).
 *
 * Scaffold: pieces are cut at break opportunities and style runs; levels are the paragraph's.
 */

/** Each paragraph's bidi levels, break opportunities and pieces. */
export function prepare(it: Itemized): PreparedPara[] {
  const { text } = it;
  return it.paras.map((para) => {
    const bidi = bidiParagraph(text, para.start, para.end, para.style.dir);
    const lang = para.runs[0]?.style.lang ?? '';
    const breaks = breakOpportunities(text, para.start, para.end, lang);
    const pieces: Piece[] = [];
    let b = 0;
    para.runs.forEach((sr, k) => {
      let at = sr.start;
      while (at < sr.end) {
        while (b < breaks.length && breaks[b]! <= at) b++;
        const brk = b < breaks.length ? breaks[b]! : Number.POSITIVE_INFINITY;
        const end = Math.min(sr.end, brk);
        let trail = end;
        while (trail > at && isBreakSpace(text.charCodeAt(trail - 1))) trail--;
        const level = bidi.levels ? bidi.levels[at - para.start]! : bidi.level;
        pieces.push({ start: at, end, trail, sr: k, level, breakAfter: end === brk, script: '' });
        at = end;
      }
    });
    return { para, bidi, pieces };
  });
}

/**
 * The string drawn and measured for text[start, end) in a run with `caps`: case-mapped for 'all' (small
 * caps are the font string's `small-caps`), with U+200D added where the cut splits a joining-script word.
 * `measureText` and `fillText` always see this same string.
 */
export function segText(text: string, start: number, end: number, caps: RunStyle['caps']): string {
  const s = text.slice(start, end);
  return caps === 'all' ? s.toUpperCase() : s;
}
