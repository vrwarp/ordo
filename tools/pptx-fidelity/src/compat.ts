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
 *   size; ordo keeps the stored scale while the text fits at it, where the box is drawn with the face
 *   PowerPoint fitted it with or a metric clone (design/27 §6 step 10). A box drawn with a stand-in (Aptos
 *   with Inter here) is fitted again in both drawings, so the rule changes nothing there.
 * - `inheritedFit`: LibreOffice applies only a shape's own `normAutofit`; one inherited from a layout or
 *   master placeholder is ignored (measured with a probe deck), so such text is not shrunk at all.
 * - `cellRows`: a table's rows are as tall as LibreOffice 24.2 makes them (`TableElement.lo`, measured with
 *   the table probe deck, `table-probe.ts`): its lines at the face's ascent and descent at a 600 dpi
 *   reference device, or at 1.2 × the font height (font-independent line spacing) once a text shape that
 *   grows to its text came before the table on the slide; text taller than such a row runs into the
 *   cell's margins, each line's baseline sits at the face's ascent, and the text is laid out and drawn at
 *   the font's whole-pixel size at that device (`loSizePt`). ordo sizes rows by the faces' line heights,
 *   as PowerPoint does.
 *
 * A rule counts only where it touches a body with visible text; the harness keeps the rules of a slide
 * only when its two drawings differ (`drawingKey`).
 */
import type { Slide } from '@ordo/domain';
import type { DeckScene, Para, RunStyle, TextBody } from '@ordo/pptx-scene';

export const COMPAT_RULES = ['runShadow', 'textOutline', 'refit', 'inheritedFit', 'cellRows'] as const;
export type CompatRule = (typeof COMPAT_RULES)[number];

/** What each rule changes, for the report. */
export const COMPAT_RULE_TEXT: Readonly<Record<CompatRule, string>> = {
  runShadow: "no run's own text shadow (a shadow an unfilled shape casts stays)",
  textOutline: 'no outline on filled text (removed before LibreOffice draws; it would hollow the letters)',
  refit: 'the stored autofit scale ignored: text fitted again from full size',
  inheritedFit: 'a normAutofit inherited from a layout or master ignored: the text is not shrunk',
  cellRows:
    'table rows as LibreOffice sizes them (its line heights, font-independent after an autogrow shape)',
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
    // Groups are flattened in the IR: every text body is a shape's or a table cell's.
    for (const e of s.elements) {
      if (e.kind === 'shape' && e.text) bodyRules(e.text, hit);
      else if (e.kind === 'table' && e.support !== 'residual' && e.lo) hit.add('cellRows');
    }
    if (hit.size) hits.set(s.index, hit);
  }
  return hits;
}

/** Slide JSON without object ids (two emissions number objects alike only while their counts agree). */
export function drawingKey(slide: Slide): string {
  return JSON.stringify(slide, (k, v) => (k === 'id' || k.endsWith('ObjectId') ? undefined : v));
}
