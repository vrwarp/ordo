/**
 * LibreOffice's space between East Asian and other text (design/27 §15 "Korean and other scripts' cells",
 * sub-wave 1c rule G). LibreOffice 24.2 (editeng's Asian/Western spacing) puts a quarter of the size of the
 * character before it at every boundary between an East Asian portion of a paragraph and another, in table cells
 * and text boxes alike (probed: gaps-flip B.1, ko-cells probe 1, the lead probe; 6.0 pt at 24 pt, 3.0 at 12 pt,
 * 9.1 at 36 pt). Its portions (`@ordo/pptx-scene` `charClass`):
 * - a weak character (a space, a quotation mark, ⑥, ・, …) joins the portion before it ('가 a': the space is East
 *   Asian, the gap comes before 'a'; none in '가⑥가', '가・가', '가“나”');
 * - a LEADING weak character (or space, or several) forms its own portion, which is not East Asian: '“가', '⑥가',
 *   ' 가', '  가' get one gap, after it;
 * - a boundary is between an East Asian portion and any other (Latin, complex, the leading one); never across a
 *   line break.
 *
 * The rule is 0.25 em exactly. LibreOffice measured 6.04 pt with East Asian before the boundary, 5.69-5.81 with
 * Latin before it in cells, 5.63-5.78 in boxes and 5.95-6.06 after a leading weak character; the cause of that
 * spread (up to 0.37 pt under 0.25 em) is not established, so the model keeps the quarter.
 *
 * Used only in the converter's model of LibreOffice's cell layout (`tables.ts`: the `measured` bodies that give
 * LibreOffice's rows and baselines): ordo draws no such gap, so ordo's own model of its drawing (`spaced`) and the
 * stored text are untouched (owner question Q1c-3: the 1/4 em for row heights only). Pure.
 */
import { charClass } from './fontmap.ts';
import type { Para, Run } from './ir.ts';

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
 * `p` as LibreOffice's model of a cell measures it (rule G): each character before an East Asian/other boundary
 * (`asianGapsAt`) in a run of its own with `ASIAN_GAP_EM` of its size more letter spacing. A new paragraph when
 * there is a gap (`p` itself otherwise); `p` is never changed.
 */
export function loAsianGaps(p: Para): Para {
  let text = '';
  for (const r of p.runs) text += r.kind === 'break' ? '\n' : r.text;
  const at = new Set(asianGapsAt(text));
  if (!at.size) return p;
  const runs: Run[] = [];
  let offset = 0;
  for (const r of p.runs) {
    if (r.kind === 'break') {
      runs.push(r);
      offset += 1;
      continue;
    }
    let from = 0;
    for (let i = 0; i < r.text.length; i++) {
      if (!at.has(offset + i)) continue;
      const unit = r.text.charCodeAt(i);
      const start = i > 0 && unit >= 0xdc00 && unit <= 0xdfff ? i - 1 : i;
      if (start > from) runs.push({ ...r, text: r.text.slice(from, start) });
      runs.push({
        ...r,
        text: r.text.slice(start, i + 1),
        style: { ...r.style, spacingPt: r.style.spacingPt + ASIAN_GAP_EM * r.style.sizePt },
      });
      from = i + 1;
    }
    if (from < r.text.length) runs.push(from ? { ...r, text: r.text.slice(from) } : r);
    offset += r.text.length;
  }
  return { ...p, runs };
}
