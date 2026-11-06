/**
 * The theme part: colour scheme, font scheme and format scheme (design/27 §1 `theme.ts`, §4 "Fonts").
 * Owned by work item B (theme-colour).
 *
 * - Colour scheme: each entry is any colour element (usually `a:srgbClr` or `a:sysClr`) read through
 *   `color.ts`; a missing or unreadable entry takes Office's default.
 * - Font scheme: major (headings) and minor (body) fonts, each with latin, ea and cs typefaces and the
 *   per-script `a:font` entries PowerPoint uses when the ea or cs typeface is empty.
 * - Format scheme: the fill, line, effect and background-fill style lists, kept raw because their `phClr`
 *   is resolved only when a style reference (`p:style`, `p:bgRef`) uses an entry (`color.ts` `styleEntry`).
 *
 * Deck strings are bounded: typefaces lose control characters and are cut to `MAX_TYPEFACE` characters
 * (`typefaceName`), at most `MAX_SCRIPT_FONTS` script entries are read per font collection, and every map
 * keyed by deck strings is a `Map`.
 */
import { type ColorCtx, colorIn, hexRgba, parseHex, styleEntry } from './color.ts';
import type { Rgba } from './ir.ts';
import { child, type XNode } from './xml.ts';

export { hexRgba, parseHex };

/** Longest typeface name kept (longer names are cut). */
export const MAX_TYPEFACE = 128;
/** `a:font script` entries read per font collection (Office's own themes have about 50). */
export const MAX_SCRIPT_FONTS = 96;

/** One font collection of the font scheme (`a:majorFont` or `a:minorFont`). */
export interface FontSet {
  latin: string;
  ea: string;
  cs: string;
  /** `a:font script typeface` entries, by script tag ('Jpan', 'Arab', …). */
  scripts: Map<string, string>;
}

export interface Theme {
  /** Scheme colours by name: dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink. */
  colors: Map<string, Rgba>;
  major: FontSet;
  minor: FontSet;
  /** `a:fmtScheme` lists, raw (they hold `phClr`, resolved when a style reference uses them). */
  fills: XNode[];
  lines: XNode[];
  effects: XNode[];
  bgFills: XNode[];
}

/** The scheme colour names of `a:clrScheme`, in order. */
export const SCHEME_COLORS = [
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
] as const;

/** Office's default theme (2013-2022), used for whatever a deck's theme leaves out. */
const OFFICE: Record<(typeof SCHEME_COLORS)[number], number> = {
  dk1: 0x000000,
  lt1: 0xffffff,
  dk2: 0x44546a,
  lt2: 0xe7e6e6,
  accent1: 0x4472c4,
  accent2: 0xed7d31,
  accent3: 0xa5a5a5,
  accent4: 0xffc000,
  accent5: 0x5b9bd5,
  accent6: 0x70ad47,
  hlink: 0x0563c1,
  folHlink: 0x954f72,
};

/**
 * Characters of a typeface attribute looked at: the rest is cut before anything else reads it. Generous, so
 * that a name padded with control characters or spaces still keeps its `MAX_TYPEFACE`, and small, so that a
 * deck string of millions of characters in a shared style node costs every run that inherits it nothing.
 */
export const TYPEFACE_SCAN = 1_024;
/** Distinct typefaces remembered by `typefaceName` before the memo starts over (real decks use a dozen). */
const TYPEFACE_MEMO = 4_096;
const typefaces = new Map<string, string>();

/**
 * A typeface as a deck string: cut to `TYPEFACE_SCAN` characters first, then C0 and C1 control characters
 * (a form feed is a CSS newline, which makes a Canvas font shorthand invalid) and line separators removed,
 * trimmed, cut to `MAX_TYPEFACE`. Memoised per (cut) string: every run asks for its typefaces again.
 */
export function typefaceName(v: string | undefined): string {
  if (!v) return '';
  const cut = v.length > TYPEFACE_SCAN ? v.slice(0, TYPEFACE_SCAN) : v;
  let out = typefaces.get(cut);
  if (out === undefined) {
    out = cut.replace(CONTROL, '').trim().slice(0, MAX_TYPEFACE);
    if (typefaces.size >= TYPEFACE_MEMO) typefaces.clear();
    typefaces.set(cut, out);
  }
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

const typeface = (n: XNode | undefined) => typefaceName(n?.attrs.typeface);

function fontSet(n: XNode | undefined, latin: string): FontSet {
  const scripts = new Map<string, string>();
  for (const f of n?.children ?? []) {
    if (f.name !== 'a:font') continue;
    if (scripts.size >= MAX_SCRIPT_FONTS) break;
    const script = f.attrs.script ?? '';
    const face = typeface(f);
    if (script.length > 0 && script.length <= 16 && face && !scripts.has(script)) scripts.set(script, face);
  }
  return {
    latin: typeface(child(n, 'a:latin')) || latin,
    ea: typeface(child(n, 'a:ea')),
    cs: typeface(child(n, 'a:cs')),
    scripts,
  };
}

const elements = (n: XNode | undefined) => (n ? n.children.filter((c) => c.name !== '#text') : []);

/** Themes read so far, by root: a theme is read for every slide that uses it. */
const themeCache = new WeakMap<XNode, Theme>();

/** Read a theme part's root (`a:theme`); a missing theme gives Office's defaults. Memoised per root. */
export function readTheme(root: XNode | undefined): Theme {
  if (!root) return readThemeOnce(undefined);
  let t = themeCache.get(root);
  if (!t) themeCache.set(root, (t = readThemeOnce(root)));
  return t;
}

function readThemeOnce(root: XNode | undefined): Theme {
  const el = child(root, 'a:themeElements');
  const scheme = child(el, 'a:clrScheme');
  const defaults = new Map<string, Rgba>(SCHEME_COLORS.map((n) => [n, hexRgba(OFFICE[n])]));
  // A scheme entry cannot refer to the scheme: a stray schemeClr resolves against Office's colours.
  const base: ColorCtx = { scheme: defaults, map: new Map() };
  const colors = new Map<string, Rgba>();
  for (const name of SCHEME_COLORS)
    colors.set(name, colorIn(child(scheme, `a:${name}`), base) ?? defaults.get(name)!);
  const fonts = child(el, 'a:fontScheme');
  const fmt = child(el, 'a:fmtScheme');
  return {
    colors,
    major: fontSet(child(fonts, 'a:majorFont'), 'Calibri Light'),
    minor: fontSet(child(fonts, 'a:minorFont'), 'Calibri'),
    fills: elements(child(fmt, 'a:fillStyleLst')),
    lines: elements(child(fmt, 'a:lnStyleLst')),
    effects: elements(child(fmt, 'a:effectStyleLst')),
    bgFills: elements(child(fmt, 'a:bgFillStyleLst')),
  };
}

/**
 * A typeface with theme references resolved: `+mj-lt`, `+mn-lt`, `+mj-ea`, `+mn-ea`, `+mj-cs`, `+mn-cs`.
 * An ea or cs reference whose typeface is empty takes the collection's `a:font` for `script` (see
 * `langScript`). Any other name is returned as it is, cut to `MAX_TYPEFACE`; an empty result is undefined.
 */
export function themeFont(theme: Theme, typeface: string | undefined, script?: string): string | undefined {
  if (!typeface) return undefined;
  if (typeface.length !== 6 || typeface[0] !== '+' || typeface[3] !== '-')
    return typefaceName(typeface) || undefined;
  const who = typeface.slice(1, 3);
  const kind = typeface.slice(4);
  if ((who !== 'mj' && who !== 'mn') || (kind !== 'lt' && kind !== 'ea' && kind !== 'cs'))
    return typefaceName(typeface) || undefined;
  const set = who === 'mj' ? theme.major : theme.minor;
  const face =
    kind === 'lt' ? set.latin : (kind === 'ea' ? set.ea : set.cs) || (script ? set.scripts.get(script) : '');
  return face || undefined;
}

/** OOXML theme script tags of languages written in an East Asian or complex script, by primary subtag. */
const LANG_SCRIPTS: ReadonlyMap<string, string> = new Map(
  (
    'ja:Jpan ko:Hang zh:Hans ar:Arab fa:Arab ur:Arab ps:Arab sd:Arab ckb:Arab ug:Uigh he:Hebr yi:Hebr ' +
    'th:Thai am:Ethi ti:Ethi bn:Beng as:Beng gu:Gujr km:Khmr kn:Knda pa:Guru iu:Cans chr:Cher ii:Yiii ' +
    'bo:Tibt dz:Tibt dv:Thaa hi:Deva mr:Deva ne:Deva sa:Deva kok:Deva te:Telu ta:Taml syr:Syrc or:Orya ' +
    'ml:Mlym lo:Laoo si:Sinh my:Mymr ka:Geor hy:Armn sat:Olck nqo:Nkoo zgh:Tfng'
  )
    .split(' ')
    .map((p): [string, string] => p.split(':') as [string, string]),
);

/**
 * The theme script tag (`a:font script`) for a run's language (`a:rPr lang`, BCP 47), when that language is
 * written with the ea or cs font: 'ja-JP' → 'Jpan', 'zh-TW' → 'Hant', 'ar-SA' → 'Arab'. Undefined for
 * languages the latin font covers.
 */
export function langScript(lang: string | undefined): string | undefined {
  if (!lang || lang.length > 35) return undefined;
  const parts = lang.split(/[-_]/);
  const primary = parts[0]!.toLowerCase();
  const rest = parts.slice(1).map((p) => p.toLowerCase());
  if (rest.includes('mong')) return 'Mong';
  if (primary === 'zh') {
    if (rest.includes('hant') || rest.some((p) => p === 'tw' || p === 'hk' || p === 'mo')) return 'Hant';
    return 'Hans';
  }
  return LANG_SCRIPTS.get(primary);
}

/**
 * The font a `p:style/a:fontRef` gives a shape's text: the theme's major or minor collection (`idx`
 * "major", "minor"; "none" gives no typeface) and the reference's own colour.
 */
export function styleFont(
  theme: Theme,
  ref: XNode | undefined,
  ctx: ColorCtx,
): { latin?: string; ea?: string; cs?: string; color?: Rgba } | undefined {
  if (!ref) return undefined;
  const idx = ref.attrs.idx;
  const set = idx === 'major' ? theme.major : idx === 'minor' ? theme.minor : undefined;
  const color = colorIn(ref, ctx);
  return {
    ...(set?.latin ? { latin: set.latin } : {}),
    ...(set?.ea ? { ea: set.ea } : {}),
    ...(set?.cs ? { cs: set.cs } : {}),
    ...(color ? { color } : {}),
  };
}

/** The theme line (`a:ln`) an `a:lnRef` names, and the context its `phClr` resolves in. */
export function styleLine(
  theme: Theme,
  ref: XNode | undefined,
  ctx: ColorCtx,
): { ln: XNode; ctx: ColorCtx } | undefined {
  const e = ref?.name === 'a:lnRef' ? styleEntry(theme, ref, ctx) : undefined;
  return e ? { ln: e.node, ctx: e.ctx } : undefined;
}

/** The theme effect style (`a:effectStyle`) an `a:effectRef` names, and the context its `phClr` resolves in. */
export function styleEffect(
  theme: Theme,
  ref: XNode | undefined,
  ctx: ColorCtx,
): { effect: XNode; ctx: ColorCtx } | undefined {
  const e = ref?.name === 'a:effectRef' ? styleEntry(theme, ref, ctx) : undefined;
  return e ? { effect: e.node, ctx: e.ctx } : undefined;
}
