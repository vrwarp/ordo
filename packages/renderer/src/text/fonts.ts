import type { FaceRequest, FontEnv } from './types.ts';

/*
 * The font resolver (design/27 §10). Owner: fonts (E).
 *
 * Each drawer (the outputs' asset worker, the operator's thumbnail worker and the editor) installs one
 * `FontEnv`. To build (`FontResolver`):
 * - every face is registered as FontFace('o' + hash8(scope + family + sorted face hashes), buffer,
 *   {weight, style, unicodeRange}); a changed face set gives a new, never-resolved name, so a late or
 *   retried font takes effect without a worker restart;
 * - a family enters font strings only once its faces have loaded, and `generation` changes then;
 * - font strings are built only from loaded internal names, in this order: the exact library face, the
 *   `fallbackFonts`, the bundled script fallback for `FaceRequest.script`, the original family name (last
 *   resort, reported), a generic family;
 * - the legacy `fontString` (text2d.ts) uses the installed resolver too.
 *
 * Scaffold: `LEGACY_FONT_ENV` builds today's chain from family names, and `FontResolver` maps loaded
 * families to internal names without any loading of its own.
 */

/** Today's fallback chain after the requested family (`fontString` in text2d.ts). */
export const LEGACY_FALLBACK = '"Inter", "Segoe UI", Arial, sans-serif';

/** A CSS family name, quoted. Callers pass clamped names (no quotes, backslashes or newlines). */
export function quoteFamily(family: string): string {
  return `"${family}"`;
}

/** The CSS font shorthand for `req` with this family list. */
export function cssFont(req: FaceRequest, families: string): string {
  const style = req.italic ? 'italic ' : '';
  const variant = req.smallCaps ? 'small-caps ' : '';
  return `${style}${variant}${req.weight} ${req.sizePx}px ${families}`;
}

/** Family names straight from the request, then today's chain: what drawers did before the resolver. */
export const LEGACY_FONT_ENV: FontEnv = {
  generation: 0,
  font(req) {
    const families = [req.family, ...req.fallbacks].filter((f) => f).map(quoteFamily);
    return cssFont(req, families.length ? `${families.join(', ')}, ${LEGACY_FALLBACK}` : LEGACY_FALLBACK);
  },
};

let installed: FontEnv = LEGACY_FONT_ENV;

/** Install the drawer's font environment (once per worker or page; the editor and both workers do). */
export function installFontEnv(env: FontEnv): void {
  installed = env;
}

/** The installed font environment (`LEGACY_FONT_ENV` until a drawer installs one). */
export function currentFontEnv(): FontEnv {
  return installed;
}

/** The internal name of one loaded family: what font strings use instead of the family's own name. */
export type LoadedFamily = { family: string; internal: string };

/**
 * The drawers' resolver. Scaffold: it only maps families marked loaded to their internal names; the
 * FontFace registration, script fallbacks, scoped faces, `fonts.check` reporting and retry are to build.
 */
export class FontResolver implements FontEnv {
  #generation = 0;
  readonly #loaded = new Map<string, string>();

  get generation(): number {
    return this.#generation;
  }

  /** Record that `family`'s faces have loaded under `internal`; layouts drawn before are stale. */
  loaded(f: LoadedFamily): void {
    this.#loaded.set(f.family.toLowerCase(), f.internal);
    this.#generation++;
  }

  font(req: FaceRequest): string {
    const out: string[] = [];
    for (const family of [req.family, ...req.fallbacks]) {
      const internal = this.#loaded.get(family.toLowerCase());
      if (internal) out.push(quoteFamily(internal));
    }
    if (req.family) out.push(quoteFamily(req.family));
    return cssFont(req, `${out.join(', ')}${out.length ? ', ' : ''}sans-serif`);
  }
}
