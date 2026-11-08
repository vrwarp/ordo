import { isSymbolFont, paraLabels } from '@ordo/domain';
import type { TextObject } from '@ordo/domain';

import type { BulletSpec, Itemized } from './types.ts';

/*
 * Bullets and automatic numbers (design/27 §6 step 11). Owner: bullets-readable (C).
 *
 * The labels come from `paraLabels` (packages/domain/src/bullets.ts), the counter code that `readableText`
 * uses too, so the stage, bands, cue labels and search show what the outputs draw:
 * - automatic numbers keep a counter per level keyed by type:startAt (port of annotate.ts `bulletOf` and
 *   `autoNumber`): arabic, roman, alpha and circled ①-⑳ in Period, ParenR, ParenBoth, Plain and Minus
 *   forms, `(17)` for verse numbers; a shallower paragraph, or one of the same level without a number,
 *   ends a sequence;
 * - an empty paragraph has no bullet and does not advance the counter; a soft paragraph has none;
 * - character bullets are Unicode (Wingdings and Symbol codes are mapped at import, and again here by
 *   `paraLabels` for a symbol-font bullet stored unmapped).
 * This file adds what drawing needs: the font (the bullet's own family, else the paragraph's first run's;
 * a symbol font's mapped character is drawn in the run's family), the size (`sizePct` × the paragraph's
 * main size, applied by lines.ts) and the colour (its own, else the first run's). Weight, slant, language,
 * shadow and outline are the first run's, as PowerPoint draws them; the label is drawn in the paragraph's
 * direction, so a right-to-left number reads as its paragraph does.
 */

/** Each paragraph's bullet (index = paragraph index), or null. */
export function paraBullets(o: TextObject, it: Itemized): (BulletSpec | null)[] {
  const labels = paraLabels(o);
  return it.paras.map((p) => {
    const text = labels[p.index];
    const b = p.style.bullet;
    if (!text || !b) return null;
    const sr = p.runs[0]!;
    const first = sr.style;
    return {
      text,
      family: b.fontFamily && !isSymbolFont(b.fontFamily) ? b.fontFamily : first.family,
      fallbacks: first.fallbacks,
      weight: first.weight,
      italic: first.italic,
      sizePct: b.sizePct ?? 1,
      color: b.color ?? first.color,
      lang: first.lang,
      run: sr.run,
    };
  });
}
