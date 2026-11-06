import type { TextObject, TextPara, TextRun, TextStyle } from '@ordo/domain';

import { runFontPx } from '../clamp.ts';
import type { ItemPara, Itemized, ParaStyle, RunStyle, StyleRun } from './types.ts';

/*
 * Stage 1, itemize (design/27 §6 step 1). Owner: breaks-bidi (A).
 *
 * Paragraphs are the '\n' pieces of the text; `soft` continues the previous paragraph. Style runs are the
 * object's runs intersected with each paragraph, with the gaps between runs in the box style. Styles are
 * resolved here once, so later stages never look at TextStyle/TextRun/TextPara again.
 */

/** The style of `run` over the box style (`run` undefined: the box style itself). */
export function resolveRunStyle(style: TextStyle, run: TextRun | undefined): RunStyle {
  const outline = run?.outline === null ? null : (run?.outline ?? style.outline ?? null);
  const shadow = run?.shadow === null ? null : (run?.shadow ?? style.shadow ?? null);
  return {
    family: run?.fontFamily ?? style.fontFamily,
    fallbacks: style.fallbackFonts ?? [],
    weight: run?.fontWeight ?? style.fontWeight,
    italic: (run?.fontStyle ?? style.fontStyle) === 'italic',
    sizePx: runFontPx(style, run),
    color: run?.color ?? style.color,
    highlight: run?.highlight ?? null,
    underline: run?.underline ?? style.underline ?? false,
    strike: run?.strike ?? false,
    baseline: run?.baseline ?? 0,
    letterSpacing: run?.letterSpacing ?? style.letterSpacing,
    caps: run?.caps ?? (style.transform === 'uppercase' ? 'all' : 'none'),
    outline,
    shadow,
    lang: run?.lang ?? style.lang ?? '',
  };
}

/** Paragraph style `p` over the box defaults. */
export function resolveParaStyle(style: TextStyle, p: TextPara | null | undefined): ParaStyle {
  return {
    align: p?.align ?? (style.justify ? 'justify' : style.align),
    level: p?.level ?? 0,
    indentPx: p?.indentPx ?? 0,
    firstLinePx: p?.firstLinePx ?? 0,
    spaceBeforePx: p?.spaceBeforePx ?? 0,
    spaceAfterPx: p?.spaceAfterPx ?? 0,
    lineSpacing: p?.lineSpacing ?? null,
    lineSpacingPx: p?.lineSpacingPx ?? null,
    bullet: p?.bullet,
    dir: p?.rtl === true ? 'rtl' : p?.rtl === false ? 'ltr' : (style.direction ?? 'auto'),
    hidden: p?.hidden === true,
  };
}

/**
 * Paragraphs and style runs of a clamped text object (runs sorted, non-overlapping and in range, as
 * `clampRuns` leaves them).
 */
export function itemize(o: TextObject): Itemized {
  const text = o.text;
  const runs = o.runs ?? [];
  const styles = new Map<number, RunStyle>();
  const styleOf = (i: number): RunStyle => {
    let s = styles.get(i);
    if (!s) {
      s = resolveRunStyle(o.style, i < 0 ? undefined : runs[i]);
      styles.set(i, s);
    }
    return s;
  };
  const paras: ItemPara[] = [];
  let r = 0; // first run that may still overlap the current paragraph
  let start = 0;
  for (let index = 0; ; index++) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    const p = o.paras?.[index];
    const out: StyleRun[] = [];
    while (r < runs.length && runs[r]!.end <= start) r++;
    let at = start;
    for (let k = r; k < runs.length && runs[k]!.start < end; k++) {
      const run = runs[k]!;
      if (run.start > at) out.push({ start: at, end: run.start, run: -1, style: styleOf(-1) });
      const s = Math.max(run.start, start);
      const e = Math.min(run.end, end);
      if (e > s) out.push({ start: s, end: e, run: k, style: styleOf(k) });
      at = Math.max(at, e);
    }
    if (at < end) out.push({ start: at, end, run: -1, style: styleOf(-1) });
    if (!out.length) {
      // The end mark: the run that covers the '\n' ending this paragraph, else the box style.
      const mark = r < runs.length && runs[r]!.start <= end ? r : -1;
      out.push({ start, end: start, run: mark, style: styleOf(mark) });
    }
    paras.push({
      index,
      start,
      end,
      soft: index > 0 && p?.soft === true,
      style: resolveParaStyle(o.style, p),
      runs: out,
    });
    if (nl < 0) break;
    start = nl + 1;
  }
  return { text, paras };
}
