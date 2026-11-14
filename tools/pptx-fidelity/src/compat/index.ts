/**
 * `--lo-compat` (design/27 §14.1, harness only): draw like LibreOffice where ordo's policy, which follows
 * PowerPoint, differs from it (design/20 "Fidelity", design/27 §17 "LibreOffice is not PowerPoint"). Each
 * rule is reported on its own (`policy` in the report), so a gain from drawing like LibreOffice is never
 * mistaken for progress of the converter or the engine.
 *
 * The converter writes the slides as LibreOffice draws them (`EmitOptions.loCompat` of `@ordo/pptx-scene`):
 * only the deck says whether a normAutofit is the shape's own and whether a text shadow is the run's or the
 * shape's. This registry names the rules a slide's scene IR hits. Each rule is a file of its own
 * (`rule.ts` `compatRule`), listed once in `COMPAT_REGISTRY` below, in report order: an M9 track adds its rule
 * with that file and one line here (plan §4).
 *
 * A rule counts only where it touches something it changes (a text body with visible text, a table LibreOffice
 * lays out); the harness keeps the rules of a slide only when its two drawings differ (`drawingKey`).
 */
import type { Slide } from '@ordo/domain';
import type { DeckScene } from '@ordo/pptx-scene';
import { cellRows } from './cellRows.ts';
import { escZero } from './escZero.ts';
import { inheritedFit } from './inheritedFit.ts';
import { refit } from './refit.ts';
import { runShadow } from './runShadow.ts';
import { textOutline } from './textOutline.ts';

/** Every rule, in report order. */
export const COMPAT_REGISTRY = [runShadow, textOutline, refit, inheritedFit, cellRows, escZero] as const;

export type CompatRule = (typeof COMPAT_REGISTRY)[number]['key'];
export type { CompatRuleDef } from './rule.ts';

export const COMPAT_RULES: readonly CompatRule[] = COMPAT_REGISTRY.map((r) => r.key);

/** What each rule changes, for the report. */
export const COMPAT_RULE_TEXT: Readonly<Record<CompatRule, string>> = Object.fromEntries(
  COMPAT_REGISTRY.map((r) => [r.key, r.text]),
) as Record<CompatRule, string>;

/** Per slide index, the LibreOffice policy rules its scene hits (slides with none are left out). */
export function compatRules(scene: DeckScene): Map<number, Set<CompatRule>> {
  const hits = new Map<number, Set<CompatRule>>();
  for (const s of scene.slides) {
    const hit = new Set<CompatRule>();
    for (const e of s.elements)
      for (const r of COMPAT_REGISTRY) if (!hit.has(r.key) && r.hits(e, s)) hit.add(r.key);
    if (hit.size) hits.set(s.index, hit);
  }
  return hits;
}

/** Slide JSON without object ids (two emissions number objects alike only while their counts agree). */
export function drawingKey(slide: Slide): string {
  return JSON.stringify(slide, (k, v) => (k === 'id' || k.endsWith('ObjectId') ? undefined : v));
}
