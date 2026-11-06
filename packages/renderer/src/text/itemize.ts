import type { TextObject, TextPara, TextRun, TextStyle } from '@ordo/domain';

import { runFontPx } from '../clamp.ts';
import type { ItemPara, Itemized, ParaStyle, RunStyle, StyleRun } from './types.ts';

/*
 * Stage 1, itemize (design/27 §6 step 1). Owner: breaks-bidi (A).
 *
 * Paragraphs are the '\n' pieces of the text. A `soft` paragraph (PowerPoint's a:br) continues the
 * previous one: it is the same PowerPoint paragraph, so it takes that paragraph's style (alignment,
 * indents, spacing, direction, level, hidden) and overrides only what its own `paras[i]` sets; lines.ts
 * gives it no bullet, no first-line indent and no space before, and segments.ts resolves an 'auto'
 * direction over the whole chain. Style runs are the object's runs intersected with each paragraph, with
 * the gaps between runs in the box style. Styles are resolved here once, so later stages never look at
 * TextStyle/TextRun/TextPara again.
 *
 * An empty paragraph has one empty style run carrying its end mark (PowerPoint's endParaRPr), whose size
 * makes the empty line's height: the run covering the '\n' that ends it; for the last paragraph, which
 * has none, the run covering the '\n' before it (the line typed Enter on, or the a:br of a trailing
 * break); else the box style.
 *
 * A known limit of that rule: when the line before an empty last paragraph is empty too (an empty
 * paragraph, or the empty line after a trailing a:br), one '\n' ends both, so both lines take one end mark
 * (the converter gives it the last paragraph's): text ending in two empty lines of different sizes draws
 * the first at the second's size. The schema has no field for the last paragraph's own end mark.
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

/**
 * Paragraph style `p` over `base`: the box defaults, or for a soft paragraph the style of the paragraph it
 * continues. Only the fields `p` sets override.
 */
export function resolveParaStyle(
  style: TextStyle,
  p: TextPara | null | undefined,
  base?: ParaStyle,
): ParaStyle {
  const b = base ?? {
    align: style.justify ? 'justify' : style.align,
    level: 0,
    indentPx: 0,
    firstLinePx: 0,
    spaceBeforePx: 0,
    spaceAfterPx: 0,
    lineSpacing: null,
    lineSpacingPx: null,
    bullet: undefined,
    dir: style.direction ?? 'auto',
    hidden: false,
  };
  return {
    align: p?.align ?? b.align,
    level: p?.level ?? b.level,
    indentPx: p?.indentPx ?? b.indentPx,
    firstLinePx: p?.firstLinePx ?? b.firstLinePx,
    spaceBeforePx: p?.spaceBeforePx ?? b.spaceBeforePx,
    spaceAfterPx: p?.spaceAfterPx ?? b.spaceAfterPx,
    lineSpacing: p?.lineSpacing ?? b.lineSpacing,
    lineSpacingPx: p?.lineSpacingPx ?? b.lineSpacingPx,
    bullet: p?.bullet !== undefined ? p.bullet : b.bullet,
    dir: p?.rtl === true ? 'rtl' : p?.rtl === false ? 'ltr' : b.dir,
    hidden: p?.hidden ?? b.hidden,
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
      const mark = endMark(runs, r, start, nl >= 0);
      out.push({ start, end: start, run: mark, style: styleOf(mark) });
    }
    const soft = index > 0 && p?.soft === true;
    paras.push({
      index,
      start,
      end,
      soft,
      style: resolveParaStyle(o.style, p, soft ? paras[index - 1]!.style : undefined),
      runs: out,
    });
    if (nl < 0) break;
    start = nl + 1;
  }
  return { text, paras };
}

/**
 * The run index of an empty paragraph's end mark at `at` (-1: the box style): the run covering the '\n'
 * at `at` when one ends the paragraph, else the run covering the '\n' before it. `r` is the first run
 * ending after `at`.
 */
function endMark(runs: readonly TextRun[], r: number, at: number, newline: boolean): number {
  if (newline) return r < runs.length && runs[r]!.start <= at ? r : -1;
  if (at === 0) return -1;
  const prev = r > 0 ? runs[r - 1] : undefined;
  return prev && prev.start < at && prev.end >= at ? r - 1 : -1;
}
