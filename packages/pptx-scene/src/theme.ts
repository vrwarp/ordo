/**
 * The theme part: colour scheme, font scheme and format scheme (design/27 §1 `theme.ts`, §4 "Fonts").
 *
 * Owned by work item B (theme-colour). Still to do: per-script `a:font` entries, `+mj-cs`/`+mn-cs`, the
 * theme fallbacks when a scheme entry is missing, and reading colours of the scheme through `color.ts` (a
 * scheme entry can be an `a:sysClr`).
 */
import type { Rgba } from './ir.ts';
import { child, type XNode } from './xml.ts';

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

export function hexRgba(hex: number, a = 1): Rgba {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff, a };
}

/** A 6-digit hex string as a colour, or undefined. */
export function parseHex(v: string | undefined): Rgba | undefined {
  return v !== undefined && /^[0-9a-fA-F]{6}$/.test(v) ? hexRgba(Number.parseInt(v, 16)) : undefined;
}

function fontSet(n: XNode | undefined, latin: string): FontSet {
  return {
    latin: child(n, 'a:latin')?.attrs.typeface || latin,
    ea: child(n, 'a:ea')?.attrs.typeface ?? '',
    cs: child(n, 'a:cs')?.attrs.typeface ?? '',
    scripts: new Map(),
  };
}

const elements = (n: XNode | undefined) => (n ? n.children.filter((c) => c.name !== '#text') : []);

/** Read a theme part's root (`a:theme`); a missing theme gives Office's defaults. */
export function readTheme(root: XNode | undefined): Theme {
  const el = child(root, 'a:themeElements');
  const scheme = child(el, 'a:clrScheme');
  const colors = new Map<string, Rgba>();
  for (const name of SCHEME_COLORS) {
    const entry = child(scheme, `a:${name}`);
    const srgb = parseHex(child(entry, 'a:srgbClr')?.attrs.val);
    const sys = parseHex(child(entry, 'a:sysClr')?.attrs.lastClr);
    colors.set(name, srgb ?? sys ?? hexRgba(OFFICE[name]));
  }
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
 * Any other name is returned as it is; an empty result is undefined.
 */
export function themeFont(theme: Theme, typeface: string | undefined): string | undefined {
  if (!typeface) return undefined;
  const m = /^\+(mj|mn)-(lt|ea|cs)$/.exec(typeface);
  if (!m) return typeface;
  const set = m[1] === 'mj' ? theme.major : theme.minor;
  const face = m[2] === 'lt' ? set.latin : m[2] === 'ea' ? set.ea : set.cs;
  return face || undefined;
}
