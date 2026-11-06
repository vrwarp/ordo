import type { TextStyle } from '@ordo/domain';

import type { ParaStyle } from './types.ts';

/*
 * The LibreOffice line model and autofit (design/27 §6 steps 7 and 10), ported from
 * packages/pptx-render/src/page.ts (`layoutPara` and `fitBox`), whose numbers were measured against
 * LibreOffice 24.2 with probe decks (docs/design/20-importers.md, the pptx-render commits). Owner:
 * lines-office (B).
 *
 * Line model (`officeLine`):
 * - single spacing is 1.2 × F whatever the font, with the baseline F below the line's top;
 * - proportional spacing p ≠ 1 is 1.2·F·p·k high (k: the autofit spacing scale); above 100 % the extra
 *   goes above the line (baseline F + (h - 1.2F)), below it the ascent is capped at 80 % of the line;
 * - exact spacing P is P·k high and adds or removes space above the line;
 * - unset spacing and an explicit 100 % are single spacing, which k leaves alone (measured: a shrunk box
 *   draws them alike).
 * Space before and after (k-scaled), the main size F, raised runs and the single-spaced line of a trailing
 * a:br are applied by lines.ts.
 *
 * Autofit (`autofit`): ordo keeps the stored `fitScale` while the text fits at it, so an edit never makes
 * text jump in size (§11). The stored scale is PowerPoint's, computed with the box family's own widths: it
 * reaches `autofit` only while the box is drawn with that face or a metric-compatible one (rich.ts
 * `storedFitHolds`); a box drawn with another face (Aptos with Inter) comes without it and is fitted from
 * full size, as LibreOffice fits every box. When it does not fit, LibreOffice's search (`searchFit`,
 * SdrTextObj::autoFitTextForCompatibility) runs from full size: ten bisection steps on the font %,
 * quantised to tenths of the 18 pt object size, moved by whether the text fits at full spacing, trying
 * 100, 90 and 80 % spacing at each step and keeping the tightest fit, with 0.5 mm of slack. Run sizes are
 * rounded as editeng does (`officeFontPx`). The result is never larger than the stored font scale.
 * During the search widths scale linearly from the layout at the stored scale (lines.ts); only the final
 * scale is laid out with measured widths.
 */

/** Single spacing of the office model: 1.2 × F whatever the font. */
export const OFFICE_SINGLE = 1.2;
/** Raised and lowered runs are drawn at this share of their size (LibreOffice's 58 %). */
export const SCRIPT_SCALE = 0.58;
/**
 * Logical px per point. A PowerPoint deck of either standard size (13.333 × 7.5 in at 16:9, 10 × 7.5 in at
 * 4:3) maps one point to 2 px of the 1920x1080 slide (pptx-scene frame.ts); the rarer 10 × 5.625 in decks
 * map it to 2.67 px, where rounding to whole points and the slack are slightly off.
 */
export const PX_PER_PT = 2;
/** LibreOffice measures the text 0.5 mm short when it fits it to its box. */
export const FIT_SLACK_PX = (0.5 / 25.4) * 72 * PX_PER_PT;
/** Spacing scales LibreOffice tries at each step of the search, in %: the first must be 100. */
export const FIT_SPACINGS: readonly number[] = [100, 90, 80];
/** Steps of the bisection. */
const FIT_STEPS = 10;
/** The font scale is rounded to a tenth of a point of the shape's default size, 18 pt for PowerPoint. */
const FIT_OBJECT_PT = 18;
/** The smallest font scale the schema stores (`fitScale.font`). */
export const MIN_FONT_SCALE = 0.01;

/** Shrink-to-fit scales. */
export type FitScale = { font: number; spacing: number };

/** No shrinking. */
export const NO_FIT: FitScale = { font: 1, spacing: 1 };

/**
 * A paragraph's proportional line spacing as a multiple of single spacing (1.2 × F): its own
 * `lineSpacing`, else the box's `lineHeight` (a multiple of F) / 1.2. Zero, and anything within 1e-9 of 1,
 * is single spacing.
 */
export function lineProportion(para: ParaStyle, lineHeight: number): number {
  const p = para.lineSpacing ?? lineHeight / OFFICE_SINGLE;
  return p > 0 && Math.abs(p - 1) > 1e-9 ? p : 1;
}

/**
 * Height of one line and where its baseline sits below the line's top, in the office model. `F` is the
 * line's main size after autofit, `k` the autofit spacing scale, `lineHeight` the box's (`TextStyle`), used
 * when the paragraph sets no spacing of its own.
 */
export function officeLine(
  F: number,
  para: ParaStyle,
  k: number,
  lineHeight = OFFICE_SINGLE,
): { height: number; ascent: number } {
  const natural = OFFICE_SINGLE * F;
  if (para.lineSpacingPx !== null) {
    const h = para.lineSpacingPx * k;
    return { height: h, ascent: F + (h - natural) };
  }
  // Unset (and 100 %) spacing is single spacing, which the spacing scale leaves alone.
  const p = lineProportion(para, lineHeight);
  if (p === 1) return { height: natural, ascent: F };
  const h = natural * p * k;
  return { height: h, ascent: p < 1 ? Math.min(F, 0.8 * h) : F + (h - natural) };
}

/**
 * A run size under the font scale as LibreOffice's editeng sizes it: rounded to whole points before and
 * after scaling, at least 1 pt (`max(1, round(round(pt) × scale))`). Unscaled sizes are left alone.
 */
export function officeFontPx(px: number, fontScale: number): number {
  if (fontScale === 1) return px;
  return Math.max(1, Math.round(Math.round(px / PX_PER_PT) * fontScale)) * PX_PER_PT;
}

/**
 * How well text `height` tall fits an inner height: ≥ 1 fits. LibreOffice's measure, with its 0.5 mm of
 * slack (`fitBox` in page.ts).
 */
export function fitFactor(height: number, innerH: number): number {
  const content = height - FIT_SLACK_PX;
  return content > 0 ? innerH / content : Number.POSITIVE_INFINITY;
}

/**
 * LibreOffice's search for the font and spacing scales (page.ts `fitBox`, after its full-size check),
 * literally: `factorAt(font%, spacing%)` is `fitFactor` of the text laid out at those scales, `first` the
 * factor at full size. Returns the tightest fit found, or the best overflow when nothing fits.
 */
export function searchFit(
  factorAt: (fontPct: number, spacingPct: number) => number,
  first: number,
  spacings: readonly number[] = FIT_SPACINGS,
): FitScale {
  let lo = 0;
  let hi = 100;
  let best = { font: 0, spacing: 100, factor: first };
  for (let i = 0; i < FIT_STEPS; i++) {
    const mid = lo + (hi - lo) * 0.5;
    const font = (Math.floor(FIT_OBJECT_PT * (mid / 100) * 10) / 10 / FIT_OBJECT_PT) * 100;
    let factor = 0;
    for (const spacing of spacings) {
      if (factor >= 1) continue;
      factor = factorAt(font, spacing);
      if (spacing === 100) {
        if (factor > 1) lo = font;
        else hi = font;
      }
      if ((best.factor < 1 && factor > best.factor) || (factor >= 1 && factor < best.factor))
        best = { font, spacing, factor };
    }
  }
  return { font: best.font / 100, spacing: best.spacing / 100 };
}

/**
 * The autofit scales of a box (design/27 §6 step 10). `exactHeight(fit)` is the text's height laid out at
 * `fit` with measured widths; `linearHeight(fit, ref)` the same with widths scaled linearly from the layout
 * at `ref`. `spacings` are the spacing scales the search tries (the 'ordo' model has no spacing scale: 100
 * only).
 * - Not 'shrink': no scaling.
 * - The stored `fitScale` (else full size) while the text fits at it. The caller leaves out a stored scale
 *   that does not hold for the faces drawing the box (rich.ts `storedFitHolds`).
 * - Else LibreOffice's search from full size, never larger than the stored font scale: a larger result is
 *   brought down to the stored scale with the widest spacing that fits there.
 * - Never below `minFont` (look bands pass drawText's 0.5, so they shrink alike whatever the script).
 */
export function autofit(
  style: TextStyle,
  innerH: number,
  exactHeight: (fit: FitScale) => number,
  linearHeight: (fit: FitScale, ref: FitScale) => number,
  spacings: readonly number[] = FIT_SPACINGS,
  minFont = MIN_FONT_SCALE,
): FitScale {
  if (style.autofit !== 'shrink') return NO_FIT;
  const stored = style.fitScale
    ? { font: style.fitScale.font, spacing: style.fitScale.spacing }
    : { font: 1, spacing: 1 };
  const atStored = fitFactor(exactHeight(stored), innerH);
  if (atStored >= 1) return stored;
  const factorAt = (fontPct: number, spacingPct: number) =>
    fitFactor(linearHeight({ font: fontPct / 100, spacing: spacingPct / 100 }, stored), innerH);
  const first = stored.font === 1 && stored.spacing === 1 ? atStored : factorAt(100, 100);
  let found = searchFit(factorAt, first, spacings);
  if (found.font > stored.font) {
    let spacing = found.spacing;
    for (const s of spacings)
      if (factorAt(stored.font * 100, s) >= 1) {
        spacing = s / 100;
        break;
      }
    found = { font: stored.font, spacing };
  }
  return { font: Math.max(MIN_FONT_SCALE, minFont, found.font), spacing: found.spacing };
}
