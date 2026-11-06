import { type Ctx2D, setLang, setLetterSpacing } from '../ctx.ts';
import type { Measurer } from './types.ts';

/*
 * Stage 5, measuring (design/27 §6 step 5). Owner: lines-office (B).
 *
 * `measureText` at logical size with `ctx.font` set to the resolved font string and `ctx.direction`,
 * `ctx.lang` and `ctx.letterSpacing` set per segment; the trailing spacing Canvas adds after the last
 * character is subtracted. Widths go into an LRU of 20,000 entries keyed `font|dir|lang|spacing|text`.
 * To build: the linear widths of the autofit search (one measure at the base size, scaled; only the final
 * size is re-measured), and whatever the LibreOffice comparison shows about kerning across pieces.
 */

/** Entries of the width cache (design/27 §6). */
export const WIDTH_CACHE_SIZE = 20_000;

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
      const key = `${font}|${dir}|${lang}|${spacingPx}|${text}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      if (isolate) ctx.save?.();
      ctx.font = font;
      if ('direction' in ctx) ctx.direction = dir;
      setLang(ctx as Ctx2D, lang);
      setLetterSpacing(ctx as Ctx2D, spacingPx);
      let w = ctx.measureText(text).width;
      if (isolate) ctx.restore?.();
      if (spacingPx) w -= spacingPx;
      cache.set(key, w);
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
