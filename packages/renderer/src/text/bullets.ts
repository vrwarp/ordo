import { paraLabels } from '@ordo/domain';
import type { TextObject } from '@ordo/domain';

import type { BulletSpec, Itemized } from './types.ts';

/*
 * Bullets and automatic numbers (design/27 §6 step 11). Owner: bullets-readable (C).
 *
 * The labels come from `paraLabels` in packages/domain/src/readable.ts, the same counter code that
 * `readableText` uses, so the stage, bands, cue labels and search show what the outputs draw. This file
 * adds what drawing needs: the bullet's font (its own family, else the paragraph's first run), size
 * (`sizePct` × the paragraph's main size) and colour (its own, else the first run's).
 * - Character bullets use their own font and size (Wingdings/Symbol codes are mapped to Unicode at import).
 * - Automatic numbers keep a counter per level keyed by type:startAt (port of annotate.ts `bulletOf` and
 *   `autoNumber`): arabic, roman, alpha and circled ①-⑳ in Period, ParenR, ParenBoth and Plain forms;
 *   `(17)` for verse numbers.
 * - An empty paragraph draws no bullet and does not advance the counter; a soft paragraph has none.
 *
 * Scaffold: `paraLabels` returns no label yet, so no paragraph has a bullet.
 */

/** Each paragraph's bullet (index = paragraph index), or null. */
export function paraBullets(o: TextObject, it: Itemized): (BulletSpec | null)[] {
  const labels = paraLabels(o);
  return it.paras.map((p) => {
    const text = labels[p.index];
    const b = p.style.bullet;
    if (!text || !b) return null;
    const first = p.runs[0]!.style;
    return {
      text,
      family: b.fontFamily ?? first.family,
      fallbacks: first.fallbacks,
      weight: first.weight,
      italic: first.italic,
      sizePct: b.sizePct ?? 1,
      color: b.color ?? first.color,
    };
  });
}
