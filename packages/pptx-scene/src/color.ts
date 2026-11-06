/**
 * Colours and fills (design/27 §1 `theme.ts`/`color.ts`, §4 "Colours"). Owned by work item B (theme-colour).
 *
 * Colour elements: `a:srgbClr`, `a:schemeClr` (through the colour map; `phClr` is the colour of the style
 * reference that uses the entry), `a:sysClr` (its `lastClr`), `a:prstClr` (ECMA-376's table), `a:scrgbClr`
 * (linear, gamma-encoded here) and `a:hslClr`.
 *
 * Modifiers apply in document order with LibreOffice's arithmetic (oox `Color::getColor`), so the native
 * slide and the LibreOffice reference agree to the bit. `color.test.ts` holds probe values read from
 * LibreOffice 24.2 (`ORDO_LO_PROBE=1` reads them again with soffice). A colour is kept as RGB (0-255),
 * linear RGB ("CRGB": 0-100,000 after a γ 2.3 decode) or HSL (hue in 60,000ths of a degree, saturation and
 * luminance 0-100,000), and converted only when a modifier needs another model:
 * - tint, shade, inv, gamma, invGamma and red/green/blue(Mod/Off) work on linear values (black + tint 95% =
 *   #454545);
 * - hue, sat and lum (with Mod and Off), and comp work in HSL;
 * - gray works on RGB;
 * - alpha, alphaMod and alphaOff work on the alpha alone.
 *
 * Four rules deliberately differ from LibreOffice, as design/27 §4 and ECMA-376 say: `sysClr` uses its
 * `lastClr` (LibreOffice uses a fixed palette), `prstClr` knows every ECMA-376 name (LibreOffice lacks the
 * long and "grey" spellings and has a wrong ltGoldenrodYellow), `phClr` keeps the reference's alpha
 * (LibreOffice drops it), and the slide's colour map applies to master shapes and the inherited background
 * (`colorContext`).
 *
 * Every number is bounded: values are clamped as LibreOffice clamps them, NaN and Infinity read as 0, at
 * most `MAX_MODIFIERS` modifiers per colour and `MAX_GRADIENT_STOPS` stops per gradient are read.
 */
import type { Fill, GradientStop, PictureFill, Rgba } from './ir.ts';
import type { Theme } from './theme.ts';
import { child, firstChild, num, type XNode } from './xml.ts';

/** What a colour element is resolved against. */
export interface ColorCtx {
  /** Scheme colours by name (dk1, lt1, …, accent6, hlink, folHlink). */
  scheme: Map<string, Rgba>;
  /** The colour map: bg1, tx1, bg2, tx2, accent1-6, hlink, folHlink → a scheme name. */
  map: Map<string, string>;
  /** The colour `phClr` stands for inside a style-matrix entry (fillRef, lnRef, effectRef, bgRef). */
  phClr?: Rgba;
}

/** Reads an `a:blipFill` into a picture fill; supplied by `picture.ts`, which knows the relationships. */
export type BlipReader = (blipFill: XNode) => PictureFill | undefined;

/** Modifiers read per colour element; real decks use up to four. Bounds the work a theme entry can cause. */
export const MAX_MODIFIERS = 32;
/** Gradient stops read per gradient (design/27 §12). */
export const MAX_GRADIENT_STOPS = 16;
/**
 * Children of an `a:gsLst` looked at for those stops (it holds only `a:gs`, and whitespace between them):
 * a shared gradient is read for every inheriting shape and run, and a deck can give its list any children.
 */
export const MAX_GRADIENT_SCAN = 4 * MAX_GRADIENT_STOPS;

export function hexRgba(hex: number, a = 1): Rgba {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff, a };
}

/** A 6-digit hex string as a colour, or undefined. */
export function parseHex(v: string | undefined): Rgba | undefined {
  return v !== undefined && v.length === 6 && /^[0-9a-fA-F]{6}$/.test(v)
    ? hexRgba(Number.parseInt(v, 16))
    : undefined;
}

// ── Colour maps ─────────────────────────────────────────────────────────────────────────────────────────

/** The scheme names a colour map may map to. */
const SCHEME_NAMES: ReadonlySet<string> = new Set([
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
]);

/** The colour map PowerPoint uses when a master has none; its keys are the names a map maps. */
const DEFAULT_MAP: ReadonlyArray<[string, string]> = [
  ['bg1', 'lt1'],
  ['tx1', 'dk1'],
  ['bg2', 'lt2'],
  ['tx2', 'dk2'],
  ['accent1', 'accent1'],
  ['accent2', 'accent2'],
  ['accent3', 'accent3'],
  ['accent4', 'accent4'],
  ['accent5', 'accent5'],
  ['accent6', 'accent6'],
  ['hlink', 'hlink'],
  ['folHlink', 'folHlink'],
];

/** Apply a colour mapping element's attributes (`p:clrMap`, `a:overrideClrMapping`) to `map`. */
function applyMapping(map: Map<string, string>, el: XNode | undefined): void {
  if (!el) return;
  // The map's own keys are looked up, not the element's attributes: a master's map is read for every slide,
  // and a deck can give it any number of attributes.
  for (const [k] of DEFAULT_MAP) {
    const v = el.attrs[k];
    if (v !== undefined && SCHEME_NAMES.has(v)) map.set(k, v);
  }
}

/**
 * The colour context of a slide: the master's `p:clrMap`, overridden attribute by attribute by the layout's
 * `p:clrMapOvr/a:overrideClrMapping`, then by the slide's. `a:masterClrMapping` keeps what is above it.
 *
 * design/27 §4: the result applies to everything drawn on the slide, inherited master and layout shapes
 * and the background included. (LibreOffice 24.2 applies the layout's override to the master's shapes and
 * background but the slide's only to the slide's own shapes; the probe table records it.)
 */
export function colorContext(
  theme: Theme,
  clrMap: XNode | undefined,
  clrMapOvr?: XNode,
  layoutClrMapOvr?: XNode,
): ColorCtx {
  const map = new Map<string, string>(DEFAULT_MAP);
  applyMapping(map, clrMap);
  applyMapping(map, child(layoutClrMapOvr, 'a:overrideClrMapping'));
  applyMapping(map, child(clrMapOvr, 'a:overrideClrMapping'));
  return { scheme: theme.colors, map };
}

/** The same context with `phClr` standing for `color`. */
export function withPhClr(ctx: ColorCtx, color: Rgba | undefined): ColorCtx {
  return color ? { ...ctx, phClr: color } : ctx;
}

// ── Colour elements ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The 140 colours of ECMA-376 `ST_PresetColorVal` with short names (the CSS colours); the long and "grey"
 * names derive from them.
 */
const PRESET_BASE =
  'aliceBlue:F0F8FF antiqueWhite:FAEBD7 aqua:00FFFF aquamarine:7FFFD4 azure:F0FFFF beige:F5F5DC ' +
  'bisque:FFE4C4 black:000000 blanchedAlmond:FFEBCD blue:0000FF blueViolet:8A2BE2 brown:A52A2A ' +
  'burlyWood:DEB887 cadetBlue:5F9EA0 chartreuse:7FFF00 chocolate:D2691E coral:FF7F50 ' +
  'cornflowerBlue:6495ED cornsilk:FFF8DC crimson:DC143C cyan:00FFFF deepPink:FF1493 ' +
  'deepSkyBlue:00BFFF dimGray:696969 dkBlue:00008B dkCyan:008B8B dkGoldenrod:B8860B dkGray:A9A9A9 ' +
  'dkGreen:006400 dkKhaki:BDB76B dkMagenta:8B008B dkOliveGreen:556B2F dkOrange:FF8C00 ' +
  'dkOrchid:9932CC dkRed:8B0000 dkSalmon:E9967A dkSeaGreen:8FBC8B dkSlateBlue:483D8B ' +
  'dkSlateGray:2F4F4F dkTurquoise:00CED1 dkViolet:9400D3 dodgerBlue:1E90FF firebrick:B22222 ' +
  'floralWhite:FFFAF0 forestGreen:228B22 fuchsia:FF00FF gainsboro:DCDCDC ghostWhite:F8F8FF ' +
  'gold:FFD700 goldenrod:DAA520 gray:808080 green:008000 greenYellow:ADFF2F honeydew:F0FFF0 ' +
  'hotPink:FF69B4 indianRed:CD5C5C indigo:4B0082 ivory:FFFFF0 khaki:F0E68C lavender:E6E6FA ' +
  'lavenderBlush:FFF0F5 lawnGreen:7CFC00 lemonChiffon:FFFACD lime:00FF00 limeGreen:32CD32 ' +
  'linen:FAF0E6 ltBlue:ADD8E6 ltCoral:F08080 ltCyan:E0FFFF ltGoldenrodYellow:FAFAD2 ltGray:D3D3D3 ' +
  'ltGreen:90EE90 ltPink:FFB6C1 ltSalmon:FFA07A ltSeaGreen:20B2AA ltSkyBlue:87CEFA ' +
  'ltSlateGray:778899 ltSteelBlue:B0C4DE ltYellow:FFFFE0 magenta:FF00FF maroon:800000 ' +
  'medAquamarine:66CDAA medBlue:0000CD medOrchid:BA55D3 medPurple:9370DB medSeaGreen:3CB371 ' +
  'medSlateBlue:7B68EE medSpringGreen:00FA9A medTurquoise:48D1CC medVioletRed:C71585 ' +
  'midnightBlue:191970 mintCream:F5FFFA mistyRose:FFE4E1 moccasin:FFE4B5 navajoWhite:FFDEAD ' +
  'navy:000080 oldLace:FDF5E6 olive:808000 oliveDrab:6B8E23 orange:FFA500 orangeRed:FF4500 ' +
  'orchid:DA70D6 paleGoldenrod:EEE8AA paleGreen:98FB98 paleTurquoise:AFEEEE paleVioletRed:DB7093 ' +
  'papayaWhip:FFEFD5 peachPuff:FFDAB9 peru:CD853F pink:FFC0CB plum:DDA0DD powderBlue:B0E0E6 ' +
  'purple:800080 red:FF0000 rosyBrown:BC8F8F royalBlue:4169E1 saddleBrown:8B4513 salmon:FA8072 ' +
  'sandyBrown:F4A460 seaGreen:2E8B57 seaShell:FFF5EE sienna:A0522D silver:C0C0C0 skyBlue:87CEEB ' +
  'slateBlue:6A5ACD slateGray:708090 snow:FFFAFA springGreen:00FF7F steelBlue:4682B4 tan:D2B48C ' +
  'teal:008080 thistle:D8BFD8 tomato:FF6347 turquoise:40E0D0 violet:EE82EE wheat:F5DEB3 ' +
  'white:FFFFFF whiteSmoke:F5F5F5 yellow:FFFF00 yellowGreen:9ACD32';

/**
 * Preset colour names (`a:prstClr val`), all 190 of ECMA-376 §20.1.10.48: the short names, their long forms
 * (dkBlue → darkBlue, lt → light, med → medium) and "grey" for every "gray".
 */
export const PRESET_COLORS: ReadonlyMap<string, number> = (() => {
  const out = new Map<string, number>();
  const long: ReadonlyArray<[string, string]> = [
    ['dk', 'dark'],
    ['lt', 'light'],
    ['med', 'medium'],
  ];
  for (const entry of PRESET_BASE.split(' ')) {
    const [name, hex] = entry.split(':') as [string, string];
    const names = [name];
    for (const [short, full] of long)
      if (name.startsWith(short) && /[A-Z]/.test(name[short.length] ?? ''))
        names.push(full + name.slice(short.length));
    for (const n of [...names])
      if (/gray/i.test(n)) names.push(n.replace('Gray', 'Grey').replace('gray', 'grey'));
    for (const n of names) out.set(n, Number.parseInt(hex, 16));
  }
  return out;
})();

/**
 * System colours (`a:sysClr val`) for an element without a usable `lastClr`: LibreOffice's fixed palette,
 * so such a colour matches the reference.
 */
const SYSTEM_COLORS: ReadonlyMap<string, number> = new Map([
  ['3dDkShadow', 0x716f64],
  ['3dLight', 0xf1efe2],
  ['activeBorder', 0xd4d0c8],
  ['activeCaption', 0x0054e3],
  ['appWorkspace', 0x808080],
  ['background', 0x004e98],
  ['btnFace', 0xece9d8],
  ['btnHighlight', 0xffffff],
  ['btnShadow', 0xaca899],
  ['btnText', 0x000000],
  ['captionText', 0xffffff],
  ['gradientActiveCaption', 0x3d95ff],
  ['gradientInactiveCaption', 0xd8e4f8],
  ['grayText', 0xaca899],
  ['highlight', 0x316ac5],
  ['highlightText', 0xffffff],
  ['hotLight', 0x000080],
  ['inactiveBorder', 0xd4d0c8],
  ['inactiveCaption', 0x7a96df],
  ['inactiveCaptionText', 0xd8e4f8],
  ['infoBk', 0xffffe1],
  ['infoText', 0x000000],
  ['menu', 0xffffff],
  ['menuBar', 0xece9d8],
  ['menuHighlight', 0x316ac5],
  ['menuText', 0x000000],
  ['scrollBar', 0xd4d0c8],
  ['window', 0xffffff],
  ['windowFrame', 0x000000],
  ['windowText', 0x000000],
]);

const COLOR_ELEMENTS = [
  'a:srgbClr',
  'a:schemeClr',
  'a:sysClr',
  'a:prstClr',
  'a:scrgbClr',
  'a:hslClr',
] as const;

/** The first colour element inside `parent` (e.g. an `a:solidFill`) resolved, or undefined. */
export function colorIn(parent: XNode | undefined, ctx: ColorCtx): Rgba | undefined {
  const el = firstChild(parent, COLOR_ELEMENTS);
  return el ? readColor(el, ctx) : undefined;
}

// ── LibreOffice's colour arithmetic ─────────────────────────────────────────────────────────────────────

const MAX = 100_000;
const MAX_DEGREE = 21_600_000;
const PER_DEGREE = 60_000;
const DEC_GAMMA = 2.3;
const INC_GAMMA = 1 / DEC_GAMMA;

const RGB = 0;
const CRGB = 1;
const HSL = 2;

/** A colour being modified: RGB (0-255), linear CRGB (0-100,000) or HSL, as LibreOffice keeps it. */
interface Work {
  mode: typeof RGB | typeof CRGB | typeof HSL;
  c1: number;
  c2: number;
  c3: number;
  /** 0-100,000. */
  alpha: number;
}

const trunc = Math.trunc;
const limit = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const gamma = (c: number, g: number) => trunc((c / MAX) ** g * MAX + 0.5);
const rgbToCrgb = (c: number) => gamma(trunc((c * MAX) / 255), DEC_GAMMA);
const crgbToRgb = (c: number) => trunc((gamma(c, INC_GAMMA) * 255) / MAX);

function toRgb(w: Work): void {
  if (w.mode === CRGB) {
    w.c1 = crgbToRgb(w.c1);
    w.c2 = crgbToRgb(w.c2);
    w.c3 = crgbToRgb(w.c3);
  } else if (w.mode === HSL) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (w.c2 === 0 || w.c3 === MAX) r = g = b = w.c3 / MAX;
    else if (w.c3 > 0) {
      const hue = (w.c1 / MAX_DEGREE) * 6; // [0, 6]
      if (hue <= 1) [r, g] = [1, hue];
      else if (hue <= 2) [r, g] = [2 - hue, 1];
      else if (hue <= 3) [g, b] = [1, hue - 2];
      else if (hue <= 4) [g, b] = [4 - hue, 1];
      else if (hue <= 5) [r, b] = [hue - 4, 1];
      else [r, b] = [1, 6 - hue];
      const sat = w.c2 / MAX;
      r = (r - 0.5) * sat + 0.5;
      g = (g - 0.5) * sat + 0.5;
      b = (b - 0.5) * sat + 0.5;
      const lum = (2 * w.c3) / MAX - 1; // [-1, 1]
      if (lum < 0) {
        const f = lum + 1;
        r *= f;
        g *= f;
        b *= f;
      } else if (lum > 0) {
        const f = 1 - lum;
        r = 1 - (1 - r) * f;
        g = 1 - (1 - g) * f;
        b = 1 - (1 - b) * f;
      }
    }
    w.c1 = trunc(r * 255 + 0.5);
    w.c2 = trunc(g * 255 + 0.5);
    w.c3 = trunc(b * 255 + 0.5);
  }
  w.mode = RGB;
}

function toCrgb(w: Work): void {
  if (w.mode === CRGB) return;
  toRgb(w);
  w.c1 = rgbToCrgb(w.c1);
  w.c2 = rgbToCrgb(w.c2);
  w.c3 = rgbToCrgb(w.c3);
  w.mode = CRGB;
}

function toHsl(w: Work): void {
  if (w.mode === HSL) return;
  toRgb(w);
  const r = w.c1 / 255;
  const g = w.c2 / 255;
  const b = w.c3 / 255;
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  const d = max - min;
  let h: number;
  if (d === 0) h = 0;
  else if (max === r) h = trunc((((g - b) / d) * 60 + 360) * PER_DEGREE + 0.5) % MAX_DEGREE;
  else if (max === g) h = trunc((((b - r) / d) * 60 + 120) * PER_DEGREE + 0.5);
  else h = trunc((((r - g) / d) * 60 + 240) * PER_DEGREE + 0.5);
  const l = trunc(((min + max) / 2) * MAX + 0.5);
  let s: number;
  if (l === 0 || l === MAX) s = 0;
  else if (l <= MAX / 2) s = trunc((d / (min + max)) * MAX + 0.5);
  else s = trunc((d / (2 - max - min)) * MAX + 0.5);
  w.c1 = h;
  w.c2 = s;
  w.c3 = l;
  w.mode = HSL;
}

type Channel = 'c1' | 'c2' | 'c3';
/** `lclSetValue`: out-of-range values are ignored. */
const setValue = (w: Work, k: Channel, v: number, max = MAX) => {
  if (v >= 0 && v <= max) w[k] = v;
};
/** `lclModValue`. */
const modValue = (w: Work, k: Channel, v: number, max = MAX) => {
  w[k] = trunc(limit((w[k] * v) / MAX, 0, max));
};
/** `lclOffValue`. */
const offValue = (w: Work, k: Channel, v: number, max = MAX) => {
  w[k] = limit(w[k] + v, 0, max);
};
/** After a luminance change, black and white lose their saturation. */
const grayAtEnds = (w: Work) => {
  if (w.c3 === 0 || w.c3 === MAX) w.c2 = 0;
};

/** An integer attribute value; a Strict percentage ("50%") reads as 50,000; anything unreadable is 0. */
function intOf(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = v.endsWith('%') ? (num(v.slice(0, -1)) ?? 0) * 1000 : (num(v) ?? 0);
  return trunc(limit(n, -2_147_483_648, 2_147_483_647));
}

const RGB_CHANNEL: Readonly<Record<string, Channel>> = { red: 'c1', green: 'c2', blue: 'c3' };

/** Apply one modifier element to `w` (LibreOffice's `Color::getColor` transformation loop). */
function modify(w: Work, local: string, v: number): void {
  switch (local) {
    case 'alpha':
      if (v >= 0 && v <= MAX) w.alpha = v;
      return;
    case 'alphaMod':
      w.alpha = trunc(limit((w.alpha * v) / MAX, 0, MAX));
      return;
    case 'alphaOff':
      w.alpha = limit(w.alpha + v, 0, MAX);
      return;
    case 'red':
    case 'green':
    case 'blue':
      toCrgb(w);
      setValue(w, RGB_CHANNEL[local]!, v);
      return;
    case 'redMod':
    case 'greenMod':
    case 'blueMod':
      toCrgb(w);
      modValue(w, RGB_CHANNEL[local.slice(0, -3)]!, v);
      return;
    case 'redOff':
    case 'greenOff':
    case 'blueOff':
      toCrgb(w);
      offValue(w, RGB_CHANNEL[local.slice(0, -3)]!, v);
      return;
    case 'hue':
      toHsl(w);
      setValue(w, 'c1', v, MAX_DEGREE);
      return;
    case 'hueMod':
      toHsl(w);
      modValue(w, 'c1', v, MAX_DEGREE);
      return;
    case 'hueOff':
      toHsl(w);
      offValue(w, 'c1', v, MAX_DEGREE);
      return;
    case 'sat':
      toHsl(w);
      setValue(w, 'c2', v);
      return;
    case 'satMod':
      toHsl(w);
      modValue(w, 'c2', v);
      return;
    case 'satOff':
      toHsl(w);
      offValue(w, 'c2', v);
      return;
    case 'lum':
      toHsl(w);
      setValue(w, 'c3', v);
      grayAtEnds(w);
      return;
    case 'lumMod':
      toHsl(w);
      modValue(w, 'c3', v);
      grayAtEnds(w);
      return;
    case 'lumOff':
      toHsl(w);
      offValue(w, 'c3', v);
      grayAtEnds(w);
      return;
    case 'shade':
      // 0% = black, 100% = the colour, in linear light.
      toCrgb(w);
      if (v >= 0 && v <= MAX) {
        const f = v / MAX;
        w.c1 = trunc(w.c1 * f);
        w.c2 = trunc(w.c2 * f);
        w.c3 = trunc(w.c3 * f);
      }
      return;
    case 'tint':
      // 0% = white, 100% = the colour, in linear light.
      toCrgb(w);
      if (v >= 0 && v <= MAX) {
        const f = v / MAX;
        w.c1 = trunc(MAX - (MAX - w.c1) * f);
        w.c2 = trunc(MAX - (MAX - w.c2) * f);
        w.c3 = trunc(MAX - (MAX - w.c3) * f);
      }
      return;
    case 'gray':
      // Weighted: 22% red, 72% green, 6% blue.
      toRgb(w);
      w.c1 = w.c2 = w.c3 = trunc((w.c1 * 22 + w.c2 * 72 + w.c3 * 6) / 100);
      return;
    case 'comp':
      toHsl(w);
      w.c1 = (w.c1 + 180 * PER_DEGREE) % MAX_DEGREE;
      return;
    case 'inv':
      toCrgb(w);
      w.c1 = MAX - w.c1;
      w.c2 = MAX - w.c2;
      w.c3 = MAX - w.c3;
      return;
    case 'gamma':
      toCrgb(w);
      w.c1 = gamma(w.c1, INC_GAMMA);
      w.c2 = gamma(w.c2, INC_GAMMA);
      w.c3 = gamma(w.c3, INC_GAMMA);
      return;
    case 'invGamma':
      toCrgb(w);
      w.c1 = gamma(w.c1, DEC_GAMMA);
      w.c2 = gamma(w.c2, DEC_GAMMA);
      w.c3 = gamma(w.c3, DEC_GAMMA);
      return;
  }
}

/** The base colour of an element, before its modifiers; undefined when it names nothing known. */
function baseOf(el: XNode, ctx: ColorCtx): Work | undefined {
  const a = el.attrs;
  const rgb = (c: Rgba | undefined): Work | undefined =>
    c && { mode: RGB, c1: c.r, c2: c.g, c3: c.b, alpha: trunc(limit(c.a, 0, 1) * MAX + 0.5) };
  switch (el.name) {
    case 'a:srgbClr':
      return rgb(parseHex(a.val));
    case 'a:schemeClr': {
      const v = a.val ?? '';
      return rgb(v === 'phClr' ? ctx.phClr : ctx.scheme.get(ctx.map.get(v) ?? v));
    }
    case 'a:sysClr': {
      const sys = SYSTEM_COLORS.get(a.val ?? '');
      return rgb(parseHex(a.lastClr) ?? (sys === undefined ? undefined : hexRgba(sys)));
    }
    case 'a:prstClr': {
      const v = PRESET_COLORS.get(a.val ?? '');
      return rgb(v === undefined ? undefined : hexRgba(v));
    }
    case 'a:scrgbClr':
      return {
        mode: CRGB,
        c1: limit(intOf(a.r), 0, MAX),
        c2: limit(intOf(a.g), 0, MAX),
        c3: limit(intOf(a.b), 0, MAX),
        alpha: MAX,
      };
    case 'a:hslClr':
      return {
        mode: HSL,
        c1: limit(intOf(a.hue), 0, MAX_DEGREE),
        c2: limit(intOf(a.sat), 0, MAX),
        c3: limit(intOf(a.lum), 0, MAX),
        alpha: MAX,
      };
    default:
      return undefined;
  }
}

const byte = (v: number) => (Number.isFinite(v) ? limit(Math.round(v), 0, 255) : 0);

/**
 * One colour element (`a:srgbClr`, `a:schemeClr`, …) with its modifiers applied in document order, or
 * undefined when it names no known colour (an unknown scheme or preset name, `phClr` outside a style).
 */
export function readColor(el: XNode, ctx: ColorCtx): Rgba | undefined {
  const w = baseOf(el, ctx);
  if (!w) return undefined;
  let n = 0;
  for (const m of el.children) {
    if (m.name === '#text') continue;
    if (++n > MAX_MODIFIERS) break;
    const colon = m.name.indexOf(':');
    modify(w, colon < 0 ? m.name : m.name.slice(colon + 1), intOf(m.attrs.val));
  }
  toRgb(w);
  return { r: byte(w.c1), g: byte(w.c2), b: byte(w.c3), a: limit(w.alpha / MAX, 0, 1) };
}

/** The colour modifiers of `el` applied to `c`, as if `c` were the element's own colour. */
export function applyModifiers(c: Rgba, el: XNode): Rgba {
  const ctx: ColorCtx = { scheme: new Map(), map: new Map(), phClr: c };
  return readColor({ ...el, name: 'a:schemeClr', attrs: { val: 'phClr' } }, ctx) ?? c;
}

// ── Fills ───────────────────────────────────────────────────────────────────────────────────────────────

const FILL_ELEMENTS = [
  'a:noFill',
  'a:solidFill',
  'a:gradFill',
  'a:blipFill',
  'a:pattFill',
  'a:grpFill',
] as const;

/**
 * The fill set directly inside `parent` (an `p:spPr`, `p:bgPr`, `a:rPr`, `a:tcPr`, `a:ln`, a style-matrix
 * entry), or undefined when it sets none (inherit). Picture fills go through `blip`.
 */
export function readFill(parent: XNode | undefined, ctx: ColorCtx, blip?: BlipReader): Fill | undefined {
  const el = firstChild(parent, FILL_ELEMENTS);
  return el ? fillOf(el, ctx, blip) : undefined;
}

/** `ST_PresetPatternVal`. */
const PATTERNS: ReadonlySet<string> = new Set(
  (
    'pct5 pct10 pct20 pct25 pct30 pct40 pct50 pct60 pct70 pct75 pct80 pct90 horz vert ltHorz ltVert dkHorz ' +
    'dkVert narHorz narVert dashHorz dashVert cross dnDiag upDiag ltDnDiag ltUpDiag dkDnDiag dkUpDiag ' +
    'wdDnDiag wdUpDiag dashDnDiag dashUpDiag diagCross smCheck lgCheck smGrid lgGrid dotGrid smConfetti ' +
    'lgConfetti horzBrick diagBrick solidDmnd openDmnd dotDmnd plaid sphere weave divot shingle wave trellis zigZag'
  ).split(' '),
);
const PATH_KINDS: ReadonlySet<string> = new Set(['circle', 'rect', 'shape']);
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** A fraction from a 100,000ths attribute, clamped to ±1. */
const frac = (v: string | undefined, lo = -1) => limit(intOf(v) / MAX, lo, 1);

/** `a:gradFill`: up to `MAX_GRADIENT_STOPS` stops sorted by position; one stop is a solid fill. */
function gradientOf(el: XNode, ctx: ColorCtx): Fill {
  const stops: GradientStop[] = [];
  const list = child(el, 'a:gsLst')?.children ?? [];
  for (let i = 0; i < list.length && i < MAX_GRADIENT_SCAN; i++) {
    const gs = list[i]!;
    if (gs.name !== 'a:gs') continue;
    if (stops.length >= MAX_GRADIENT_STOPS) break;
    const color = colorIn(gs, ctx);
    if (color) stops.push({ at: frac(gs.attrs.pos, 0), color });
  }
  stops.sort((a, b) => a.at - b.at);
  if (stops.length === 0) return { kind: 'none' };
  if (stops.length === 1) return { kind: 'solid', color: stops[0]!.color };
  const lin = child(el, 'a:lin');
  const path = child(el, 'a:path');
  if (path) {
    const r = child(path, 'a:fillToRect')?.attrs;
    const kind = path.attrs.path ?? '';
    return {
      kind: 'gradient',
      stops,
      path: PATH_KINDS.has(kind) ? kind : 'circle',
      ...(r ? { focus: { l: frac(r.l), t: frac(r.t), r: frac(r.r), b: frac(r.b) } } : {}),
    };
  }
  const ang = intOf(lin?.attrs.ang) / PER_DEGREE;
  return { kind: 'gradient', stops, angle: ((ang % 360) + 360) % 360 };
}

/** One fill element. A gradient without stops is no fill; a pattern keeps its two colours. */
export function fillOf(el: XNode, ctx: ColorCtx, blip?: BlipReader): Fill {
  switch (el.name) {
    case 'a:solidFill': {
      const color = colorIn(el, ctx);
      return color ? { kind: 'solid', color } : { kind: 'none' };
    }
    case 'a:gradFill':
      return gradientOf(el, ctx);
    case 'a:pattFill': {
      const prst = el.attrs.prst ?? '';
      return {
        kind: 'pattern',
        preset: PATTERNS.has(prst) ? prst : 'pct5',
        fg: colorIn(child(el, 'a:fgClr'), ctx) ?? BLACK,
        bg: colorIn(child(el, 'a:bgClr'), ctx) ?? WHITE,
      };
    }
    case 'a:blipFill': {
      const picture = blip?.(el);
      return picture ? { kind: 'picture', picture } : { kind: 'none' };
    }
    case 'a:grpFill':
      return { kind: 'group' };
    default:
      return { kind: 'none' };
  }
}

// ── Style references (`p:style`) ────────────────────────────────────────────────────────────────────────

/**
 * The style-matrix entry a reference names, with the colour context its `phClr` resolves in (the
 * reference's own colour, modifiers applied):
 * - `a:fillRef idx` 1-999 → fillStyleLst, ≥ 1001 → bgFillStyleLst (both 1-based; 0 = none);
 * - `a:bgRef idx` the same (backgrounds use ≥ 1001);
 * - `a:lnRef idx` → lnStyleLst; `a:effectRef idx` → effectStyleLst.
 */
export function styleEntry(
  theme: Theme,
  ref: XNode | undefined,
  ctx: ColorCtx,
): { node: XNode; ctx: ColorCtx } | undefined {
  const idx = num(ref?.attrs.idx);
  if (!ref || idx === undefined || idx < 1) return undefined;
  const i = trunc(idx);
  let node: XNode | undefined;
  if (ref.name === 'a:lnRef') node = theme.lines[i - 1];
  else if (ref.name === 'a:effectRef') node = theme.effects[i - 1];
  else node = i >= 1001 ? theme.bgFills[i - 1001] : i < 1000 ? theme.fills[i - 1] : undefined;
  return node ? { node, ctx: withPhClr(ctx, colorIn(ref, ctx)) } : undefined;
}

/**
 * A fill from the theme's style matrix: `a:fillRef idx` (1-based into fillStyleLst; 0 = no fill) or
 * `a:bgRef idx` (≥ 1001 into bgFillStyleLst), with `phClr` standing for the reference's own colour.
 */
export function styleFill(
  theme: Theme,
  ref: XNode | undefined,
  ctx: ColorCtx,
  blip?: BlipReader,
): Fill | undefined {
  const e = styleEntry(theme, ref, ctx);
  return e ? fillOf(e.node, e.ctx, blip) : undefined;
}
