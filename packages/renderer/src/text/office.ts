import type { TextStyle } from '@ordo/domain';

import type { ParaStyle } from './types.ts';

/*
 * The LibreOffice line model and autofit (design/27 §6 steps 7 and 10), ported from
 * packages/pptx-render/src/page.ts (`layoutPara` and `fitBox`). Owner: lines-office (B).
 *
 * Scaffold: `officeLine` has the measured formulas of page.ts; `autofit` returns the stored `fitScale`
 * (or 1 and 1) without searching. To build: the 10-step bisection on the font % quantised to tenths of
 * 18 pt, spacing 100/90/80 %, 0.5 mm slack, run sizes `max(1, round(round(pt) × font%))`, linear widths
 * during the search, and "keep fitScale while the text fits at it, else search (only ever smaller)".
 */

/** Single spacing of the office model: 1.2 × F whatever the font. */
export const OFFICE_SINGLE = 1.2;
/** Raised and lowered runs are drawn at this share of their size (LibreOffice's 58 %). */
export const SCRIPT_SCALE = 0.58;

/**
 * Height of one line and where its baseline sits below the line's top, in the office model. `F` is the
 * paragraph's main size after autofit, `k` the autofit spacing scale.
 */
export function officeLine(F: number, para: ParaStyle, k: number): { height: number; ascent: number } {
  const natural = OFFICE_SINGLE * F;
  if (para.lineSpacingPx !== null) {
    const h = para.lineSpacingPx * k;
    return { height: h, ascent: F + (h - natural) };
  }
  // Unset (and 100 %) spacing is single spacing, which the spacing scale leaves alone.
  const p = para.lineSpacing ?? 1;
  if (p === 1 || p === 0) return { height: natural, ascent: F };
  const h = natural * p * k;
  return { height: h, ascent: p < 1 ? Math.min(F, 0.8 * h) : F + (h - natural) };
}

/** Shrink-to-fit scales. */
export type FitScale = { font: number; spacing: number };

/**
 * The autofit scales for a box whose text, laid out at `fit`, is `heightAt(fit)` tall, in an inner height
 * of `innerH`. Text that fits at full size is never shrunk.
 */
export function autofit(style: TextStyle, _heightAt: (fit: FitScale) => number, _innerH: number): FitScale {
  if (style.autofit !== 'shrink') return { font: 1, spacing: 1 };
  return style.fitScale
    ? { font: style.fitScale.font, spacing: style.fitScale.spacing }
    : { font: 1, spacing: 1 };
}
