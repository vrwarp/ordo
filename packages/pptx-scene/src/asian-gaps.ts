/**
 * LibreOffice's space between East Asian and other text (design/27 §15 "Korean and other scripts' cells",
 * sub-wave 1c rule G). LibreOffice 24.2 (editeng's Asian/Western script space) puts a space at every boundary
 * between an East Asian portion of a paragraph and another, in table cells and text boxes alike (probed: gaps-flip
 * B.1, ko-cells probe 1, the lead probe; 6.0 pt at 24 pt, 3.0 at 12 pt, 9.1 at 36 pt). Its portions
 * (`@ordo/pptx-scene` `charClass`):
 * - a weak character (a space, a quotation mark, ⑥, ・, …) joins the portion before it ('가 a': the space is East
 *   Asian, the gap comes before 'a'; none in '가⑥가', '가・가', '가“나”');
 * - a LEADING weak character (or space, or several) forms its own portion, which is not East Asian: '“가', '⑥가',
 *   ' 가', '  가' get one gap, after it;
 * - a boundary is between an East Asian portion and any other (Latin, complex, the leading one); never across a
 *   line break.
 *
 * The rule is 0.25 em of the size of the character before the boundary. LibreOffice's own gap is the height of the
 * face of the portion before the boundary (hhea ascent and descent) divided by 5, so the quarter is LibreOffice's
 * gap for a face about 1.25 em tall: WenQuanYi Zen Hei (1.2598 em: 6.05 pt at 24 pt, where LibreOffice measured
 * 5.92-6.06) and Inter (1.21 em: 5.81 pt, measured 5.69-5.81) are within 0.4 pt of it; after a Liberation Sans
 * (Arial) portion (1.117 em) the quarter is about 0.64 pt more than LibreOffice's 5.36 pt at 24 pt (the probe
 * hold-out deck, integrate-1c repair 1). The quarter reproduces LibreOffice's line count on every cell measured, so
 * the minimum needs no more (the owner's rule 4: `trunc(loLineHeight / 5)` is a follow-up).
 *
 * Used only in the converter's model of LibreOffice's cell layout (`tables.ts` `Measure.loLayout` with `gaps`: the
 * bodies that give LibreOffice's rows and baselines), where each gap is added to its character's advance inside
 * the character's own run, so the character keeps its portion's face (a run split at the gap would measure a weak
 * character alone in another face: integrate-1c repair 1). ordo draws no such gap, so ordo's own model of its
 * drawing (`spaced`) and the stored text are untouched (owner question Q1c-3: the 1/4 em for row heights only).
 * Pure.
 */
import { charClass } from './fontmap.ts';
import type { Para } from './ir.ts';

/** The share of the size of the character before a boundary that LibreOffice adds there. */
export const ASIAN_GAP_EM = 0.25;

type Portion = 'ea' | 'other' | 'lead' | 'break';

/**
 * The UTF-16 indexes of `text` (a paragraph's runs, a line break as '\n') whose character ends a portion at a
 * boundary between East Asian text and other text (see the module comment): the character that gets the gap; for
 * a surrogate pair, its low surrogate.
 */
export function asianGapsAt(text: string): number[] {
  const n = text.length;
  const k: Portion[] = new Array(n);
  let prev: Portion | undefined;
  for (let i = 0; i < n; ) {
    const c = text.codePointAt(i)!;
    const u = c > 0xffff ? 2 : 1;
    let p: Portion;
    if (c === 0x0a) p = 'break';
    else {
      const raw = charClass(c);
      // A weak character joins the portion before it; leading ones form their own (not East Asian).
      if (raw === 'weak') p = prev ?? 'lead';
      else p = prev = raw === 'ea' ? 'ea' : 'other';
    }
    for (let j = 0; j < u; j++) k[i + j] = p;
    i += u;
  }
  const out: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = k[i]!;
    const b = k[i + 1]!;
    if (a === 'break' || b === 'break' || a === b) continue;
    if ((a === 'ea') !== (b === 'ea')) out.push(i);
  }
  return out;
}

/**
 * The gaps rule G adds in `p` (see the module comment): for each character before an East Asian/other boundary
 * (`asianGapsAt`), keyed by the UTF-16 index of its last unit in the paragraph's text (its runs, a line break as
 * '\n'), `ASIAN_GAP_EM` of its run's size in pt. `p` is never changed.
 */
export function asianGapsOf(p: Para): Map<number, number> {
  let text = '';
  for (const r of p.runs) text += r.kind === 'break' ? '\n' : r.text;
  const gaps = new Map<number, number>();
  const at = asianGapsAt(text);
  if (!at.length) return gaps;
  let offset = 0;
  let k = 0;
  for (const r of p.runs) {
    const n = r.kind === 'break' ? 1 : r.text.length;
    while (k < at.length && at[k]! < offset + n) gaps.set(at[k++]!, ASIAN_GAP_EM * r.style.sizePt);
    offset += n;
  }
  return gaps;
}
