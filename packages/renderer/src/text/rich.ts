import type { Box, TextObject, TextPara, TextStyle } from '@ordo/domain';

import { CLAMP, clampObject, num } from '../clamp.ts';
import type { Ctx2D } from '../ctx.ts';
import { paraBullets } from './bullets.ts';
import { currentFontEnv } from './fonts.ts';
import { itemize } from './itemize.ts';
import { layoutBox } from './lines.ts';
import { measurerFor } from './measure.ts';
import { paintRich } from './paint.ts';
import { prepare } from './segments.ts';
import type { FontEnv, Measurer, RichLayout } from './types.ts';

/*
 * The rich text engine's entry points and the dispatch rule (design/27 §6). Owner: paint-dispatch (D).
 *
 * Pipeline: itemize (itemize.ts) → bidi, breaks and pieces (segments.ts with bidi.ts and breaks.ts) →
 * bullets (bullets.ts) → measure, lines, line model, autofit, align and anchor (lines.ts with measure.ts
 * and office.ts) → paint (paint.ts). Each stage keeps its signature; README.md has the contracts.
 */

/** TextStyle fields that only the rich engine draws: a style with any of them goes through it. */
export const RICH_STYLE_KEYS = [
  'lineModel',
  'insets',
  'wrap',
  'autofit',
  'fitScale',
  'justify',
  'direction',
  'lang',
  'fallbackFonts',
  'underline',
  'glow',
] as const satisfies readonly (keyof TextStyle)[];

/**
 * Whether a text object is drawn by the rich engine: it has `runs` or `paras` (even empty ones, so an
 * object never switches engines because its last run was cleared), or a style with a rich field. Objects
 * without any of them are drawn by `drawText` exactly as before these fields existed.
 */
export function isRichText(o: TextObject): boolean {
  return o.runs !== undefined || o.paras !== undefined || isRichStyle(o.style);
}

/** Whether a style has a field only the rich engine draws (a look's band style can, too). */
export function isRichStyle(style: TextStyle): boolean {
  const s = style as Partial<Record<(typeof RICH_STYLE_KEYS)[number], unknown>>;
  for (const k of RICH_STYLE_KEYS) if (s[k] !== undefined) return true;
  return false;
}

/**
 * The text object a look band lays out through the rich engine (design/27 §6 "Bands"): `text` (the source's
 * readable text) in the look's `style` and `band`, shrunk to fit as `drawText`'s bands are, with the
 * direction of each of the source object's paragraphs (its `paras[i].rtl`, else its box `direction`), so a
 * Hebrew verse stays right to left in a lyric-only band whatever the look says.
 */
export function bandObject(text: string, style: TextStyle, band: Box, src?: TextObject): TextObject {
  const o: TextObject = {
    id: 'band',
    type: 'text',
    box: band,
    text,
    style: { ...style, autofit: style.autofit ?? 'shrink' },
    opacity: 1,
  };
  if (!src) return o;
  const dflt = src.style.direction === 'rtl' ? true : src.style.direction === 'ltr' ? false : undefined;
  const paras: (TextPara | null)[] = [];
  let count = 1;
  for (let i = text.indexOf('\n'); i >= 0 && count < CLAMP.maxParas; i = text.indexOf('\n', i + 1)) count++;
  for (let i = 0; i < count; i++) {
    const rtl = src.paras?.[i]?.rtl ?? dflt;
    paras.push(rtl === undefined ? null : { rtl });
  }
  while (paras.length && paras[paras.length - 1] === null) paras.pop();
  if (paras.length) o.paras = paras;
  return o;
}

const layouts = new WeakMap<
  TextObject,
  { m: Measurer; env: FontEnv; generation: number; layout: RichLayout }
>();

/**
 * Lay out a clamped text object (`clampObject` output) in logical px. Pure: the same object, measurer and
 * font generation give the same layout, memoised by object identity.
 */
export function layoutRich(m: Measurer, o: TextObject, env: FontEnv): RichLayout {
  const hit = layouts.get(o);
  if (hit && hit.m === m && hit.env === env && hit.generation === env.generation) return hit.layout;
  const it = itemize(o);
  const prepared = prepare(it);
  const bullets = paraBullets(o, it);
  const layout = layoutBox(m, o, prepared, bullets, env);
  layouts.set(o, { m, env, generation: env.generation, layout });
  return layout;
}

const clamped = new WeakMap<TextObject, TextObject>();

/** `clampObject` of a text object, memoised by identity (a clamped object maps to itself). */
export function clampTextObject(o: TextObject): TextObject {
  const hit = clamped.get(o);
  if (hit) return hit;
  const out = clampObject({ ...o, type: 'text' }) as TextObject; // a 'text' object always clamps to one
  clamped.set(o, out);
  clamped.set(out, out);
  return out;
}

/** Draw a text object through the rich engine at `scale` device px per logical px. */
export function drawRichText(ctx: Ctx2D, o: TextObject, scale: number, env = currentFontEnv()): RichLayout {
  const c = clampTextObject(o);
  const layout = layoutRich(measurerFor(ctx), c, env);
  paintRich(ctx, c, layout, num(scale, 0.01, 8, 1), env);
  return layout;
}
