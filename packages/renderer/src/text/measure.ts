import { type Ctx2D, setLang, setLetterSpacing } from '../ctx.ts';
import type { Measurer } from './types.ts';

/*
 * Stage 5, measuring (design/27 §6 step 5). Owner: lines-office (B).
 *
 * `measureText` at logical size with `ctx.font` set to the resolved font string and `ctx.direction`,
 * `ctx.lang` and `ctx.letterSpacing` set per segment, exactly the state paint.ts draws the same string in.
 * Widths go into an LRU of 20,000 entries keyed `font|dir|lang|spacing|text`, for strings of at most
 * `MAX_CACHED_TEXT` units: words and the prefixes of an emergency break, never the whole of a hostile
 * 10,000-letter word, whose keys would keep megabytes alive in a worker for the rest of the session.
 *
 * What Chromium (153, DOM and OffscreenCanvas contexts alike) does, probed with DejaVu Sans:
 * - `letterSpacing` is added after every grapheme cluster, the last one included ('abcd' at 5 px: +20;
 *   'e' + U+0301 at 10 px: +10), so one `spacingPx` is subtracted: the Measurer contract.
 * - `ctx.lang` exists (default 'inherit'); `setLang` sets it where it does.
 * - Advances scale exactly with the size (20 → 40 px: × 2.000), which the autofit search relies on
 *   (`linearWidth`).
 * - Kerning applies within a measured string ('AV' 52.17 px against 54.73 apart): pieces are measured and
 *   drawn apart, so kerning across a piece boundary (a space, a style change) is lost on both sides alike.
 */

/** Entries of the width cache (design/27 §6). */
export const WIDTH_CACHE_SIZE = 20_000;
/** Longest string (UTF-16 units) whose width the shared cache keeps: about 10 MB of keys at most. */
export const MAX_CACHED_TEXT = 256;

/** A least-recently-used map of measured widths. */
export class WidthCache {
  readonly #map = new Map<string, number>();
  constructor(readonly limit = WIDTH_CACHE_SIZE) {}

  get size(): number {
    return this.#map.size;
  }

  get(key: string): number | undefined {
    const w = this.#map.get(key);
    if (w !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, w);
    }
    return w;
  }

  set(key: string, w: number): void {
    this.#map.delete(key);
    this.#map.set(key, w);
    if (this.#map.size > this.limit) this.#map.delete(this.#map.keys().next().value!);
  }
}

/** The part of a 2D context measuring needs. */
export type MeasureCtx = Pick<Ctx2D, 'measureText'> & {
  font: string;
  direction?: CanvasDirection;
  save?: () => void;
  restore?: () => void;
};

/**
 * A measurer over `ctx`, cached. When `isolate` is set, the context's state is saved and restored around
 * each measure (for a context that also draws).
 */
export function canvasMeasurer(ctx: MeasureCtx, cache = new WidthCache(), isolate = false): Measurer {
  return {
    width(font, dir, lang, spacingPx, text) {
      if (!text) return 0;
      const key = text.length <= MAX_CACHED_TEXT ? `${font}|${dir}|${lang}|${spacingPx}|${text}` : '';
      const hit = key ? cache.get(key) : undefined;
      if (hit !== undefined) return hit;
      if (isolate) ctx.save?.();
      ctx.font = font;
      if ('direction' in ctx) ctx.direction = dir;
      setLang(ctx as Ctx2D, lang);
      setLetterSpacing(ctx as Ctx2D, spacingPx);
      let w = ctx.measureText(text).width;
      if (isolate) ctx.restore?.();
      if (spacingPx) w -= spacingPx;
      if (!Number.isFinite(w)) w = 0;
      if (key) cache.set(key, w);
      return w;
    },
  };
}

let shared: Measurer | null | undefined;
const perContext = new WeakMap<object, Measurer>();

/**
 * The measurer drawers use: one shared OffscreenCanvas context where the platform has one (workers and
 * browsers), so every drawer of a page or worker shares one cache and the layout memo; else (tests) one
 * over `ctx` itself, isolated.
 */
export function measurerFor(ctx: MeasureCtx): Measurer {
  if (shared === undefined) {
    const c = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d');
    shared = c ? canvasMeasurer(c) : null;
  }
  if (shared) return shared;
  let m = perContext.get(ctx);
  if (!m) {
    m = canvasMeasurer(ctx, new WidthCache(), true);
    perContext.set(ctx, m);
  }
  return m;
}

/**
 * A measurer that remembers every width it gave for the lifetime of one layout, so the autofit search
 * (lines.ts) measures each string once, whatever the shared cache evicts meanwhile.
 */
export function memoMeasurer(m: Measurer): Measurer {
  // Keyed by the state, then the text: no key string is built per call (an emergency break of a long word
  // asks for a width on every line of every autofit step).
  type ByLang = Map<string, Map<number, Map<string, number>>>;
  const memo = new Map<string, { ltr: ByLang; rtl: ByLang }>();
  return {
    width(font, dir, lang, spacingPx, text) {
      let byDir = memo.get(font);
      if (!byDir) memo.set(font, (byDir = { ltr: new Map(), rtl: new Map() }));
      const byLang = dir === 'rtl' ? byDir.rtl : byDir.ltr;
      let bySpacing = byLang.get(lang);
      if (!bySpacing) byLang.set(lang, (bySpacing = new Map()));
      let byText = bySpacing.get(spacingPx);
      if (!byText) bySpacing.set(spacingPx, (byText = new Map()));
      let w = byText.get(text);
      if (w === undefined) {
        w = m.width(font, dir, lang, spacingPx, text);
        byText.set(text, w);
      }
      return w;
    },
  };
}

/**
 * The width of `text` at `sizePx`, estimated from its measured width `w` at `refPx` (the autofit search's
 * linear widths): glyph advances scale with the size; letter spacing, which Canvas adds between characters
 * (code points here), does not.
 */
export function linearWidth(
  w: number,
  refPx: number,
  sizePx: number,
  spacingPx: number,
  text: string,
): number {
  return scaleWidth(w, refPx, sizePx, spacingPx ? spacingPx * spacingGaps(text) : 0);
}

/** The letter spacing gaps in `text`: one between each two code points. */
export function spacingGaps(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return Math.max(0, n - 1);
}

/** `linearWidth` with the text's total letter spacing (`spacingPx × spacingGaps(text)`) given. */
export function scaleWidth(w: number, refPx: number, sizePx: number, spacing: number): number {
  if (!(refPx > 0) || sizePx === refPx) return w;
  return (w - spacing) * (sizePx / refPx) + spacing;
}
