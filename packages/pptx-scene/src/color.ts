/**
 * Colours and fills (design/27 §1 `theme.ts`/`color.ts`, §4 "Colours").
 *
 * Owned by work item B (theme-colour). The scaffold reads srgbClr, schemeClr through the clrMap, sysClr,
 * a few prstClr names, and the alpha/lumMod/lumOff modifiers. Still to do: the full prstClr table, scrgbClr
 * (gamma-encoded) and hslClr, tint/shade on linear values with γ 2.3 (black + tint 95% = #454545),
 * satMod/satOff/hueMod/hueOff and the rest of the modifiers in document order, gradients and patterns, and
 * clamping every result (NaN → 0).
 */
import type { Fill, PictureFill, Rgba } from './ir.ts';
import { parseHex, type Theme } from './theme.ts';
import { child, num, type XNode } from './xml.ts';

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

/** The colour map PowerPoint uses when a master has none. */
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

/**
 * The colour context of a slide: the master's `p:clrMap`, overridden attribute by attribute by the slide's
 * `p:clrMapOvr/a:overrideClrMapping` (which applies to inherited layout and master shapes too).
 */
export function colorContext(theme: Theme, clrMap: XNode | undefined, clrMapOvr?: XNode): ColorCtx {
  const map = new Map<string, string>(DEFAULT_MAP);
  for (const [k, v] of Object.entries(clrMap?.attrs ?? {})) if (map.has(k)) map.set(k, v);
  const ovr = child(clrMapOvr, 'a:overrideClrMapping');
  for (const [k, v] of Object.entries(ovr?.attrs ?? {})) if (map.has(k)) map.set(k, v);
  return { scheme: theme.colors, map };
}

/** The same context with `phClr` standing for `color`. */
export function withPhClr(ctx: ColorCtx, color: Rgba | undefined): ColorCtx {
  return color ? { ...ctx, phClr: color } : ctx;
}

/** Preset colour names (`a:prstClr val`). Work item B completes the table (ECMA-376 §20.1.10.47). */
export const PRESET_COLORS: ReadonlyMap<string, number> = new Map([
  ['black', 0x000000],
  ['white', 0xffffff],
  ['red', 0xff0000],
  ['green', 0x008000],
  ['blue', 0x0000ff],
  ['yellow', 0xffff00],
  ['gray', 0x808080],
]);

const COLOR_ELEMENTS = new Set([
  'a:srgbClr',
  'a:schemeClr',
  'a:sysClr',
  'a:prstClr',
  'a:scrgbClr',
  'a:hslClr',
]);

/** The first colour element inside `parent` (e.g. an `a:solidFill`) resolved, or undefined. */
export function colorIn(parent: XNode | undefined, ctx: ColorCtx): Rgba | undefined {
  for (const c of parent?.children ?? []) if (COLOR_ELEMENTS.has(c.name)) return readColor(c, ctx);
  return undefined;
}

/** One colour element (`a:srgbClr`, `a:schemeClr`, …) with its modifiers applied. */
export function readColor(el: XNode, ctx: ColorCtx): Rgba | undefined {
  let base: Rgba | undefined;
  switch (el.name) {
    case 'a:srgbClr':
      base = parseHex(el.attrs.val);
      break;
    case 'a:schemeClr': {
      const v = el.attrs.val ?? '';
      if (v === 'phClr') base = ctx.phClr;
      else base = ctx.scheme.get(ctx.map.get(v) ?? v);
      break;
    }
    case 'a:sysClr':
      base =
        parseHex(el.attrs.lastClr) ?? (el.attrs.val === 'window' ? parseHex('FFFFFF') : parseHex('000000'));
      break;
    case 'a:prstClr': {
      const hex = PRESET_COLORS.get(el.attrs.val ?? '');
      base = hex === undefined ? undefined : parseHex(hex.toString(16).padStart(6, '0'));
      break;
    }
    default:
      return undefined;
  }
  return base ? applyModifiers(base, el) : undefined;
}

/** The colour modifiers of a colour element, in document order (scaffold: alpha, lumMod, lumOff). */
export function applyModifiers(c: Rgba, el: XNode): Rgba {
  let out = { ...c };
  for (const m of el.children) {
    const v = (num(m.attrs.val) ?? 0) / 100_000;
    switch (m.name) {
      case 'a:alpha':
        out.a = clamp01(v);
        break;
      case 'a:lumMod':
      case 'a:lumOff': {
        const [h, s, l] = toHsl(out);
        out = { ...fromHsl(h, s, clamp01(m.name === 'a:lumMod' ? l * v : l + v)), a: out.a };
        break;
      }
    }
  }
  return out;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** RGB 0-255 → HSL, each 0-1. */
export function toHsl(c: Rgba): [number, number, number] {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

/** HSL, each 0-1 → RGB 0-255 (alpha 1). */
export function fromHsl(h: number, s: number, l: number): Rgba {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v, a: 1 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    return Math.round(v * 255);
  };
  return { r: ch(h + 1 / 3), g: ch(h), b: ch(h - 1 / 3), a: 1 };
}

const FILL_ELEMENTS = new Set([
  'a:noFill',
  'a:solidFill',
  'a:gradFill',
  'a:blipFill',
  'a:pattFill',
  'a:grpFill',
]);

/**
 * The fill set directly inside `parent` (an `p:spPr`, `p:bgPr`, `a:rPr`, `a:tcPr`, a style-matrix entry),
 * or undefined when it sets none (inherit). Picture fills go through `blip`.
 */
export function readFill(parent: XNode | undefined, ctx: ColorCtx, blip?: BlipReader): Fill | undefined {
  for (const c of parent?.children ?? []) {
    if (!FILL_ELEMENTS.has(c.name)) continue;
    return fillOf(c, ctx, blip);
  }
  return undefined;
}

/** One fill element. Unsupported kinds come back as the nearest supported fill (scaffold: none). */
export function fillOf(el: XNode, ctx: ColorCtx, blip?: BlipReader): Fill {
  switch (el.name) {
    case 'a:solidFill': {
      const color = colorIn(el, ctx);
      return color ? { kind: 'solid', color } : { kind: 'none' };
    }
    case 'a:blipFill': {
      const picture = blip?.(el);
      return picture ? { kind: 'picture', picture } : { kind: 'none' };
    }
    case 'a:grpFill':
      return { kind: 'group' };
    default:
      // a:noFill; gradients and patterns: work item B.
      return { kind: 'none' };
  }
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
  const idx = num(ref?.attrs.idx);
  if (!ref || idx === undefined || idx <= 0) return undefined;
  const entry = idx >= 1001 ? theme.bgFills[idx - 1001] : theme.fills[idx - 1];
  if (!entry) return undefined;
  return fillOf(entry, withPhClr(ctx, colorIn(ref, ctx)), blip);
}
