/**
 * Which of a run's typefaces draws each character, and the families tried after it (design/27 §4 "Fonts",
 * §10).
 *
 * - **Script classes.** PowerPoint and LibreOffice draw every character of a run in one of three fonts: the
 *   Latin (`a:latin`), the East Asian (`a:ea`) or the complex-script one (`a:cs`), chosen by the
 *   character's script. `scriptClass` follows LibreOffice's table (i18npool `BreakIteratorImpl::
 *   getScriptClass`, by Unicode block): Basic Latin to the spacing modifiers, Greek, Cyrillic, Armenian,
 *   Georgian, Cherokee to Runic and the Latin and Greek extensions are Latin (digits and ASCII punctuation
 *   included); Hebrew to Myanmar, Ethiopic, Khmer, Mongolian and the Arabic presentation forms are complex;
 *   Hangul Jamo, the CJK blocks from the radicals to the Hangul syllables (kana, Bopomofo and Yi included),
 *   the compatibility ideographs and forms, the half- and full-width forms and the supplementary ideographs
 *   are East Asian. Space, no-break space, combining marks, general punctuation, symbols, arrows, the
 *   private-use area and everything else are weak: they take the script of the character before them in
 *   their paragraph, and at its start the script of the first strong character after them (editeng's
 *   `InitScriptTypes`).
 * - **Fallback families** (`TextStyle.fallbackFonts`, at most 8): the metric substitute of the box's
 *   family, the East Asian and complex-script families the text uses with their substitutes, the
 *   substitutes of the other run families, then ordo's bundled script fallback for every script present
 *   (`SCRIPT_FALLBACK_FONTS` of `@ordo/domain`, Han by the text's language). The family itself always stays
 *   the deck's own: a substitute is only ever tried after it.
 */
import { SCRIPT_FALLBACK_FONTS } from '@ordo/domain/defaults.ts';
import { textScripts } from '@ordo/domain/readable.ts';

export type ScriptClass = 'latin' | 'ea' | 'cs';
type Klass = ScriptClass | 'weak';

/** Families tried after a run's own family: at most this many (`TextStyle.fallbackFonts`). */
export const MAX_FALLBACK_FONTS = 8;

/** Unicode ranges [first, last, class] in code point order; anything not listed is weak. */
const RANGES: readonly (readonly [number, number, Klass])[] = [
  [0x0000, 0x02ff, 'latin'], // Basic Latin … Spacing Modifier Letters (weak exceptions below)
  [0x0300, 0x036f, 'weak'], // combining diacritical marks
  [0x0370, 0x058f, 'latin'], // Greek, Cyrillic, Cyrillic Supplement, Armenian
  [0x0590, 0x109f, 'cs'], // Hebrew … Myanmar
  [0x10a0, 0x10ff, 'latin'], // Georgian
  [0x1100, 0x11ff, 'ea'], // Hangul Jamo
  [0x1200, 0x139f, 'cs'], // Ethiopic (and its supplement)
  [0x13a0, 0x16ff, 'latin'], // Cherokee … Runic
  [0x1780, 0x18af, 'cs'], // Khmer, Mongolian
  [0x1e00, 0x1fff, 'latin'], // Latin Extended Additional, Greek Extended
  [0x2c80, 0x2ce3, 'latin'], // Coptic (LibreOffice's workaround)
  [0x2e80, 0xd7af, 'ea'], // CJK radicals … Hangul syllables (kana, Bopomofo, CJK, Yi)
  [0xf900, 0xfaff, 'ea'], // CJK compatibility ideographs
  [0xfb50, 0xfdff, 'cs'], // Arabic presentation forms A
  [0xfe30, 0xfe4f, 'ea'], // CJK compatibility forms
  [0xfe70, 0xfeff, 'cs'], // Arabic presentation forms B
  [0xff00, 0xffef, 'ea'], // half-width and full-width forms
  [0x20000, 0x2fa1f, 'ea'], // supplementary ideographs
];

/** LibreOffice's always-weak characters inside Latin blocks: space, no-break space, Bopomofo tone marks. */
const WEAK_LATIN = new Set([0x01, 0x02, 0x20, 0xa0, 0x2c7, 0x2ca, 0x2cb, 0x2d9]);

/** The script class of one code point ('weak': it takes its neighbours'). */
export function charClass(c: number): Klass {
  if (c < 0x300) return c < 0x20 || WEAK_LATIN.has(c) ? 'weak' : 'latin';
  let lo = 0;
  let hi = RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last, k] = RANGES[mid]!;
    if (c < first) hi = mid - 1;
    else if (c > last) lo = mid + 1;
    else return k;
  }
  return 'weak';
}

/**
 * The script class of every UTF-16 unit of `text` (a paragraph): weak characters take the class of the
 * strong character before them, leading ones the first strong class after them, and a paragraph without
 * any strong character is Latin.
 */
export function scriptClasses(text: string): ScriptClass[] {
  const out: (ScriptClass | undefined)[] = new Array(text.length);
  let prev: ScriptClass | undefined;
  let firstStrong: ScriptClass | undefined;
  for (let i = 0; i < text.length; ) {
    const c = text.codePointAt(i)!;
    const n = c > 0xffff ? 2 : 1;
    const k = charClass(c);
    const cls = k === 'weak' ? prev : k;
    if (k !== 'weak') {
      prev = k;
      firstStrong ??= k;
    }
    for (let j = 0; j < n; j++) out[i + j] = cls;
    i += n;
  }
  const lead = firstStrong ?? 'latin';
  for (let i = 0; i < out.length && out[i] === undefined; i++) out[i] = lead;
  return out as ScriptClass[];
}

/**
 * Metric-compatible (or nearest) open faces for common Office families (design/27 §10): bundled by the hub
 * (M3) or fetched on demand (Gelasio). Keys are lower case.
 */
const SUBSTITUTES: ReadonlyMap<string, string> = new Map([
  ['calibri', 'Carlito'],
  ['calibri light', 'Carlito'],
  ['cambria', 'Caladea'],
  ['arial', 'Liberation Sans'],
  ['helvetica', 'Liberation Sans'],
  ['arial narrow', 'Liberation Sans Narrow'],
  ['times new roman', 'Liberation Serif'],
  ['times', 'Liberation Serif'],
  ['courier new', 'Liberation Mono'],
  ['courier', 'Liberation Mono'],
  ['georgia', 'Gelasio'],
]);

/** The substitute face of a family, or undefined. */
export function substituteOf(family: string | undefined): string | undefined {
  return family ? SUBSTITUTES.get(family.trim().toLowerCase()) : undefined;
}

/** The bundled fallback families for the scripts of `text`, Han chosen by the text's language. */
export function scriptFallbacks(text: string, lang: string | undefined): string[] {
  const out: string[] = [];
  for (const code of textScripts(text)) {
    if (code === 'Hani') {
      out.push(hanFallback(lang));
      continue;
    }
    for (const f of SCRIPT_FALLBACK_FONTS[code] ?? []) out.push(f);
  }
  return out;
}

/** The Noto CJK family for Han text in `lang`: Japanese, Korean, traditional or simplified Chinese. */
function hanFallback(lang: string | undefined): string {
  const tags = (lang ?? '').toLowerCase().split(/[-_]/);
  const all = SCRIPT_FALLBACK_FONTS.Hani ?? [];
  const pick = (name: string) => all.find((f) => f.endsWith(name)) ?? all[0] ?? 'Noto Sans SC';
  if (tags[0] === 'ja') return pick(' JP');
  if (tags[0] === 'ko') return pick(' KR');
  if (tags.includes('hant') || tags.some((t) => t === 'tw' || t === 'hk' || t === 'mo')) return pick(' TC');
  return pick(' SC');
}

/**
 * `TextStyle.fallbackFonts` of a box: the box family's substitute, the East Asian and complex-script
 * families (`asian`, `complex`, most used first) each followed by its substitute, the substitutes of the
 * other run families (`others`, most used first), then the script fallbacks of `text`. Without
 * duplicates or the box family itself, case-insensitively; at most `MAX_FALLBACK_FONTS`.
 */
export function fallbackFonts(
  box: string,
  asian: readonly string[],
  complex: readonly string[],
  others: readonly string[],
  text: string,
  lang: string | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set([box.trim().toLowerCase()]);
  const add = (f: string | undefined) => {
    const k = f?.trim().toLowerCase();
    if (!f || !k || seen.has(k) || out.length >= MAX_FALLBACK_FONTS) return;
    seen.add(k);
    out.push(f.slice(0, 300));
  };
  add(substituteOf(box));
  for (const f of [...asian, ...complex]) {
    add(f);
    add(substituteOf(f));
  }
  for (const f of others) add(substituteOf(f));
  for (const f of scriptFallbacks(text, lang)) add(f);
  return out;
}
