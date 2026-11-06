/**
 * `--lo-compat` (design/27 §14.1, harness only): draw like LibreOffice where ordo's policy, which follows
 * PowerPoint, differs from it (design/20 "Fidelity", design/27 §17 "LibreOffice is not PowerPoint"). Each
 * rule is reported on its own (`policy` in the report), so a gain from drawing like LibreOffice is never
 * mistaken for progress of the converter or the engine.
 *
 * The converter writes the slides as LibreOffice draws them (`EmitOptions.loCompat` of `@ordo/pptx-scene`):
 * only the deck says whether a normAutofit is the shape's own and whether a text shadow is the run's or the
 * shape's. This module names the rules a slide's text bodies hit, from the same scene IR:
 *
 * - `runShadow`: LibreOffice draws no run's own text shadow (PowerPoint's "Text Shadow"). A shadow an
 *   unfilled shape casts on its text stays: it is the shape's (`ShapeElement.shadow`), not the run's.
 * - `textOutline`: an outline on filled text is not drawn. LibreOffice would hollow the letters; the
 *   harness's pictures are made from `pptxForRendering`'s copy, which removes such outlines first (as the
 *   hub's render copy does, design/27 §5), so the picture shows the fill alone. Hollow text (no fill) keeps
 *   its outline, in both.
 * - `refit`: LibreOffice ignores PowerPoint's stored `normAutofit` scale and fits the text again from full
 *   size; ordo keeps the stored scale while the text fits at it.
 * - `inheritedFit`: LibreOffice applies only a shape's own `normAutofit`; one inherited from a layout or
 *   master placeholder is ignored (measured with a probe deck), so such text is not shrunk at all.
 *
 * A rule counts only where it touches a body with visible text; the harness keeps the rules of a slide
 * only when its two drawings differ (`drawingKey`).
 */
import type { Slide } from '@ordo/domain';
import type { DeckScene, Para, RunStyle, TextBody } from '@ordo/pptx-scene';

export const COMPAT_RULES = ['runShadow', 'textOutline', 'refit', 'inheritedFit'] as const;
export type CompatRule = (typeof COMPAT_RULES)[number];

/** What each rule changes, for the report. */
export const COMPAT_RULE_TEXT: Readonly<Record<CompatRule, string>> = {
  runShadow: "no run's own text shadow (a shadow an unfilled shape casts stays)",
  textOutline: 'no outline on filled text (removed before LibreOffice draws; it would hollow the letters)',
  refit: 'the stored autofit scale ignored: text fitted again from full size',
  inheritedFit: 'a normAutofit inherited from a layout or master ignored: the text is not shrunk',
};

const visible = (p: Para) => p.runs.some((r) => r.kind !== 'break' && r.text.trim() !== '');

function styleRules(s: RunStyle, hit: Set<CompatRule>): void {
  if (s.shadow !== undefined) hit.add('runShadow');
  if (s.outline !== undefined && s.fill.kind !== 'none') hit.add('textOutline');
}

function bodyRules(t: TextBody, hit: Set<CompatRule>): void {
  let any = false;
  for (const p of t.paras) {
    if (!visible(p)) continue;
    any = true;
    // Only runs that draw something count; the end mark only sizes an empty paragraph.
    for (const r of p.runs) if (r.kind !== 'break' && r.text.trim()) styleRules(r.style, hit);
  }
  if (!any || t.autofit.kind !== 'shrink') return;
  if (!t.autofit.own) hit.add('inheritedFit');
  else if (t.autofit.fontScale < 1 || t.autofit.lnSpcReduction > 0) hit.add('refit');
}

/** Per slide index, the LibreOffice policy rules its text bodies hit (slides with none are left out). */
export function compatRules(scene: DeckScene): Map<number, Set<CompatRule>> {
  const hits = new Map<number, Set<CompatRule>>();
  for (const s of scene.slides) {
    const hit = new Set<CompatRule>();
    // Groups are flattened in the IR: every text body is a shape's.
    for (const e of s.elements) if (e.kind === 'shape' && e.text) bodyRules(e.text, hit);
    if (hit.size) hits.set(s.index, hit);
  }
  return hits;
}

/** Slide JSON without object ids (two emissions number objects alike only while their counts agree). */
export function drawingKey(slide: Slide): string {
  return JSON.stringify(slide, (k, v) => (k === 'id' || k.endsWith('ObjectId') ? undefined : v));
}
