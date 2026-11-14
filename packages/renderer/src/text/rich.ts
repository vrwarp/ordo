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
  'paint',
  'lineMask',
] as const satisfies readonly (keyof TextStyle)[];

/**
 * TextObject fields that only the rich engine draws (design/27 M9): the looks that live on the object, never
 * on its style (a WordArt warp, vertical writing, a centred block, 3-D). The legacy `drawText` draws none of
 * them, so an object with any of them goes through the rich engine.
 */
export const RICH_OBJECT_KEYS = [
  'warp',
  'writing',
  'centerBlock',
  'look3d',
] as const satisfies readonly (keyof TextObject)[];

/**
 * Whether a text object is drawn by the rich engine: it has `runs` or `paras` (even empty ones, so an
 * object never switches engines because its last run was cleared), a rich object field (`RICH_OBJECT_KEYS`)
 * or a style with a rich field. Objects without any of them are drawn by `drawText` exactly as before these
 * fields existed.
 */
export function isRichText(o: TextObject): boolean {
  if (o.runs !== undefined || o.paras !== undefined) return true;
  const x = o as Partial<Record<(typeof RICH_OBJECT_KEYS)[number], unknown>>;
  for (const k of RICH_OBJECT_KEYS) if (x[k] !== undefined) return true;
  return isRichStyle(o.style);
}

/** Whether a style has a field only the rich engine draws (a look's band style can, too). */
export function isRichStyle(style: TextStyle): boolean {
  const s = style as Partial<Record<(typeof RICH_STYLE_KEYS)[number], unknown>>;
  for (const k of RICH_STYLE_KEYS) if (s[k] !== undefined) return true;
  return false;
}

/** The smallest autofit font scale of a look band: drawText's `minScale`, so bands shrink alike in either engine. */
export const BAND_MIN_FONT_SCALE = 0.5;

/** Layout options: the autofit floor (`BAND_MIN_FONT_SCALE` for bands). */
export type RichLayoutOptions = { minFontScale?: number };

/**
 * The text object a look band lays out through the rich engine (design/27 §6 "Bands"): `text` (the source's
 * readable text) in the look's `style` and `band`, shrunk to fit as `drawText`'s bands are (lay it out with
 * `minFontScale: BAND_MIN_FONT_SCALE`), with the direction of each of the source object's paragraphs (its
 * `paras[i].rtl`, else its box `direction`), so a Hebrew verse stays right to left in a lyric-only band
 * whatever the look says. A soft line (a:br) stays soft, so it takes its paragraph's direction, resolved
 * over the whole paragraph as on the slide.
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
    const p = src.paras?.[i];
    if (i > 0 && p?.soft === true)
      paras.push(p.rtl === undefined ? { soft: true } : { soft: true, rtl: p.rtl });
    else {
      const rtl = p?.rtl ?? dflt;
      paras.push(rtl === undefined ? null : { rtl });
    }
  }
  while (paras.length && paras[paras.length - 1] === null) paras.pop();
  if (paras.length) o.paras = paras;
  return o;
}

const layouts = new WeakMap<
  TextObject,
  { m: Measurer; env: FontEnv; generation: number; min: number | undefined; layout: RichLayout }
>();

/**
 * Whether the stored autofit scale of `o` (`style.fitScale`, PowerPoint's) holds in `env` (design/27 §6
 * step 10): PowerPoint computed it with the box family's own widths, so it holds only while that family is
 * drawn with its own face or a metric-compatible one (`FontEnv.metricMatch`; an environment without it
 * keeps the scale). True when there is no stored scale.
 */
export function storedFitHolds(o: TextObject, env: FontEnv): boolean {
  const s = o.style;
  if (s.autofit !== 'shrink' || !s.fitScale || !env.metricMatch) return true;
  return env.metricMatch(s.fontFamily, s.fallbackFonts ?? []);
}

const refits = new WeakMap<TextObject, TextObject>();

/** `o` without its stored autofit scale, memoised by identity: the engine fits it again from full size. */
function withoutFitScale(o: TextObject): TextObject {
  let c = refits.get(o);
  if (!c) {
    const { fitScale: _, ...style } = o.style;
    c = { ...o, style };
    refits.set(o, c);
  }
  return c;
}

/**
 * Lay out a clamped text object (`clampObject` output) in logical px. Pure: the same object, measurer,
 * font generation and options give the same layout, memoised by object identity. A stored autofit scale
 * that does not hold for the faces drawing the box (`storedFitHolds`) is ignored: the box is fitted again
 * from full size, as LibreOffice fits every box.
 */
export function layoutRich(m: Measurer, o: TextObject, env: FontEnv, opts?: RichLayoutOptions): RichLayout {
  const min = opts?.minFontScale;
  const hit = layouts.get(o);
  if (hit && hit.m === m && hit.env === env && hit.generation === env.generation && hit.min === min)
    return hit.layout;
  const src = storedFitHolds(o, env) ? o : withoutFitScale(o);
  const it = itemize(src);
  const prepared = prepare(it);
  const bullets = paraBullets(src, it);
  const layout = layoutBox(m, src, prepared, bullets, env, min);
  layouts.set(o, { m, env, generation: env.generation, min, layout });
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
export function drawRichText(
  ctx: Ctx2D,
  o: TextObject,
  scale: number,
  env = currentFontEnv(),
  opts?: RichLayoutOptions,
): RichLayout {
  const c = clampTextObject(o);
  const layout = layoutRich(measurerFor(ctx), c, env, opts);
  paintRich(ctx, c, layout, num(scale, 0.01, 8, 1), env);
  return layout;
}
