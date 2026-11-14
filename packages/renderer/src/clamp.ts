import {
  type ArrowEnd,
  type Box,
  type Glow,
  type Gradient,
  type ImageCrop,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  LOOK_MAIN,
  type LineDash,
  type Look,
  type ObjectOrigin,
  PATH_DATA_LIMITS,
  type PathFillMode,
  type Rgba,
  type ShapeGeom,
  type Slide,
  type SlideObject,
  type TextLineMask,
  type TextObject,
  type TextPara,
  type TextRun,
  type TextStyle,
  cleanPathData,
  fromImport,
  referencePicture,
} from '@ordo/domain';
import { clampChart } from './clamp/chart.ts';
import { clampDecor } from './clamp/decor.ts';
import { clampLook3d } from './clamp/look3d.ts';
import { clampTable } from './clamp/table.ts';
import { clampVectorFonts, MAX_VECTOR_FONTS } from './clamp/vector.ts';
import { clampWarp } from './clamp/warp.ts';
import { clampCenterBlock, clampWriting } from './clamp/writing.ts';

/**
 * Render-plan clamps (design/25 "validate at entry, clamp at use"). Whatever reaches the planner is treated
 * as hostile: every number is made finite and bounded, text is cut, object counts are capped, and anything
 * that is not a recognisable slide object is dropped. The result is always drawable in bounded time and
 * memory; the rasterizer re-applies the cheap clamps as a last line.
 *
 * Clamped slides are memoised by object identity, so planning the same state again costs one lookup.
 */

export const CLAMP = {
  /** Box edges lie within ±2× the logical canvas. */
  boxFactor: 2,
  maxTextChars: 10_000,
  /** Font sizes of boxes, legacy text and bands; raised and lowered runs and bullets are drawn no smaller. */
  minFontPx: 4,
  /**
   * The smallest effective size of a rich-text run (box size × `sizeScale` × autofit): 1 pt, PowerPoint's
   * smallest size, which both standard deck sizes map to 2 px. Dense decks separate list items with 1 pt
   * paragraphs, which PowerPoint and LibreOffice draw 1.2 × 2 = 2.4 px tall; `minFontPx` would make each
   * twice that and move everything below it.
   */
  minRunFontPx: 2,
  maxFontPx: 1000,
  maxObjects: 200,
  /** Distinct images one slide may draw (each is decoded and held while the slide rasterizes). */
  maxImagesPerSlide: 16,
  /** Decoded image bytes one cue's raster may hold (images beyond it are skipped and reported). */
  maxCueBitmapBytes: 192 * 1024 * 1024,
  maxLineHeight: 10,
  maxLetterSpacing: 500,
  maxPadding: LOGICAL_WIDTH,
  maxEffectPx: 500,
  /**
   * The thinnest dashed outline drawn (logical px; thinner ones are drawn this wide): a dash is a sub-path of
   * its own, so a sysDot outline at 0.01 px would cut a slide-sized shape into 300,000 dashes (design/27 §12
   * drawing cost). The converter writes no line thinner (PowerPoint's thinnest is one device pixel).
   */
  minDashedStrokePx: 0.5,
  maxRadius: LOGICAL_WIDTH,
  /** Style runs of one text object (the schema's bound). */
  maxRuns: 2000,
  /** Paragraph styles one text object draws (the schema allows 5,000; later paragraphs take the box's). */
  maxParas: 1000,
  maxFallbackFonts: 8,
  /**
   * Distinct run and bullet font families one text object draws in: the browser pays a platform font lookup
   * for each family name it has not seen (about 1 ms in Chromium), so later ones take the box family.
   */
  maxRunFamilies: 16,
  /** Distinct run size scales one text object draws in: later ones take the nearest of these. */
  maxSizeScales: 64,
  /** Paragraph indents and spacing, in logical px. */
  maxIndentPx: LOGICAL_WIDTH,
  /** Stops of one gradient (design/27 §12). */
  maxGradientStops: 16,
  /** Adjust value pairs of one stored geometry (the schema's bound). */
  maxGeomAdjust: 10,
} as const;

const W = LOGICAL_WIDTH;
const H = LOGICAL_HEIGHT;

export function num(v: unknown, lo: number, hi: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return v < lo ? lo : v > hi ? hi : v;
}

export function clampText(t: unknown): string {
  if (typeof t !== 'string') return '';
  return t.length > CLAMP.maxTextChars ? t.slice(0, CLAMP.maxTextChars) : t;
}

export function clampFontSize(v: unknown, dflt = 72): number {
  return num(v, CLAMP.minFontPx, CLAMP.maxFontPx, dflt);
}

export function clampColor(c: unknown, dflt: Rgba = { r: 255, g: 255, b: 255, a: 1 }): Rgba {
  if (!c || typeof c !== 'object') return dflt;
  const x = c as Partial<Rgba>;
  return {
    r: num(x.r, 0, 255, dflt.r),
    g: num(x.g, 0, 255, dflt.g),
    b: num(x.b, 0, 255, dflt.b),
    a: num(x.a, 0, 1, dflt.a),
  };
}

/** A box whose edges lie within ±2× the logical canvas; width and height are never negative. */
export function clampBox(b: unknown, dflt: Box = { x: 0, y: 0, w: W, h: H, rotation: 0 }): Box {
  if (!b || typeof b !== 'object') return dflt;
  const x0 = b as Partial<Box>;
  const lx = -CLAMP.boxFactor * W;
  const hx = CLAMP.boxFactor * W;
  const ly = -CLAMP.boxFactor * H;
  const hy = CLAMP.boxFactor * H;
  const x = num(x0.x, lx, hx, dflt.x);
  const y = num(x0.y, ly, hy, dflt.y);
  const w = num(x0.w, 0, hx - x, Math.min(dflt.w, hx - x));
  const h = num(x0.h, 0, hy - y, Math.min(dflt.h, hy - y));
  const r = typeof x0.rotation === 'number' && Number.isFinite(x0.rotation) ? x0.rotation % 360 : 0;
  return { x, y, w, h, rotation: r };
}

const FONT_FAMILY_MAX = 200;

/**
 * `v` without what would break a CSS font string: quotes, backslashes and every C0 and C1 control character
 * (a form feed is a CSS newline too: the browser would ignore the whole `ctx.font` assignment and keep the
 * previous font, so widths would depend on drawing order).
 */
function familyChars(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x22 || c === 0x5c || c === 0x2028 || c === 0x2029)
      continue;
    out += v[i];
  }
  return out;
}

/** A family name safe inside a CSS font string, or '' when there is none. */
export function clampFamily(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return '';
  const f = familyChars(v.slice(0, FONT_FAMILY_MAX));
  return f.trim() ? f : '';
}

/**
 * The distinct fonts one text object may ask for (`maxRunFamilies` families, `maxSizeScales` size scales),
 * shared by its runs and its bullets, so that no object costs more font lookups than a slide of ordinary
 * text: a schema-valid object of 2,000 runs could otherwise name 2,000 families.
 */
export class FontBudget {
  /** The spelling kept for each family, by key: the first one seen. */
  readonly #families = new Map<string, string>();
  readonly #scales = new Set<number>();
  readonly maxFamilies: number;
  readonly maxScales: number;

  constructor(maxFamilies: number = CLAMP.maxRunFamilies, maxScales: number = CLAMP.maxSizeScales) {
    this.maxFamilies = maxFamilies;
    this.maxScales = maxScales;
  }

  /**
   * The family `v` names, clamped (`clampFamily`), when it is within the budget, else '' (the run or bullet
   * takes the box's or run's family). A family is keyed by its clamped name, trimmed and lower-cased, and
   * every name with that key gets the spelling first kept: names differing in case, surrounding spaces,
   * quotes or control characters are one family and one CSS name, so they cannot multiply font lookups.
   */
  family(v: unknown): string {
    const f = clampFamily(v).trim();
    const k = f.toLowerCase();
    if (!k) return '';
    const kept = this.#families.get(k);
    if (kept !== undefined) return kept;
    if (this.#families.size >= this.maxFamilies) return '';
    this.#families.set(k, f);
    return f;
  }

  /** `scale` when it is within the budget, else the nearest scale already kept. */
  scale(scale: number): number {
    if (this.#scales.has(scale) || this.#scales.size < this.maxScales) {
      this.#scales.add(scale);
      return scale;
    }
    let best = scale;
    let d = Number.POSITIVE_INFINITY;
    for (const s of this.#scales)
      if (Math.abs(s - scale) < d) {
        d = Math.abs(s - scale);
        best = s;
      }
    return best;
  }
}

/** A BCP 47 language tag, or '' (only letters, digits and hyphens survive). */
export function clampLang(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 35).replace(/[^A-Za-z0-9-]/g, '') : '';
}

/** A shadow within the clamp bounds (offsets ±maxEffectPx, blur 0..maxEffectPx, a valid colour). */
export function clampShadow(v: Partial<NonNullable<TextStyle['shadow']>>): NonNullable<TextStyle['shadow']> {
  return {
    dx: num(v.dx, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0),
    dy: num(v.dy, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0),
    blur: num(v.blur, 0, CLAMP.maxEffectPx, 0),
    color: clampColor(v.color, { r: 0, g: 0, b: 0, a: 1 }),
  };
}

function clampOutline(v: Partial<NonNullable<TextStyle['outline']>>): NonNullable<TextStyle['outline']> {
  return {
    width: num(v.width, 0, CLAMP.maxEffectPx, 0),
    color: clampColor(v.color, { r: 0, g: 0, b: 0, a: 1 }),
  };
}

export function clampStyle(s: unknown, dflt: TextStyle = DEFAULT_STYLE): TextStyle {
  if (!s || typeof s !== 'object') return dflt;
  const x = s as Partial<TextStyle>;
  const family = clampFamily(x.fontFamily) || dflt.fontFamily;
  const out: TextStyle = {
    fontFamily: family,
    fontWeight: Math.round(num(x.fontWeight, 1, 1000, dflt.fontWeight)),
    fontStyle: x.fontStyle === 'italic' ? 'italic' : 'normal',
    transform: x.transform === 'uppercase' ? 'uppercase' : 'none',
    fontSizePx: clampFontSize(x.fontSizePx, dflt.fontSizePx),
    color: clampColor(x.color, dflt.color),
    align: x.align === 'left' || x.align === 'right' ? x.align : 'center',
    valign: x.valign === 'top' || x.valign === 'bottom' ? x.valign : 'middle',
    lineHeight: num(x.lineHeight, 0.1, CLAMP.maxLineHeight, dflt.lineHeight),
    letterSpacing: num(x.letterSpacing, -CLAMP.maxLetterSpacing, CLAMP.maxLetterSpacing, 0),
    padding: num(x.padding, 0, CLAMP.maxPadding, 0),
  };
  if (x.outline && typeof x.outline === 'object') out.outline = clampOutline(x.outline);
  if (x.shadow && typeof x.shadow === 'object') out.shadow = clampShadow(x.shadow);
  if (x.fill && typeof x.fill === 'object')
    out.fill = {
      color: clampColor(x.fill.color, { r: 0, g: 0, b: 0, a: 1 }),
      radius: num(x.fill.radius, 0, CLAMP.maxRadius, 0),
    };
  clampRichStyle(x, out);
  return out;
}

/**
 * The rich-text fields of a style (design/27 §3), each only when present, so a legacy style clamps to
 * exactly the fields it had (and draws through the legacy path). Enum values that are not known take the
 * schema's .catch default.
 */
function clampRichStyle(x: Partial<TextStyle>, out: TextStyle): void {
  if (x.lineModel !== undefined) out.lineModel = x.lineModel === 'office' ? 'office' : 'ordo';
  if (x.insets && typeof x.insets === 'object') {
    const i = x.insets;
    const side = (v: unknown) => num(v, 0, CLAMP.maxPadding, 0);
    out.insets = { l: side(i.l), t: side(i.t), r: side(i.r), b: side(i.b) };
  }
  if (typeof x.wrap === 'boolean') out.wrap = x.wrap;
  if (x.autofit !== undefined) out.autofit = x.autofit === 'shrink' ? 'shrink' : 'none';
  if (x.fitScale && typeof x.fitScale === 'object')
    out.fitScale = { font: num(x.fitScale.font, 0.01, 1, 1), spacing: num(x.fitScale.spacing, 0, 1, 1) };
  if (typeof x.justify === 'boolean') out.justify = x.justify;
  if (x.direction !== undefined)
    out.direction = x.direction === 'ltr' || x.direction === 'rtl' ? x.direction : 'auto';
  if (x.lang !== undefined) out.lang = clampLang(x.lang);
  if (Array.isArray(x.fallbackFonts))
    out.fallbackFonts = x.fallbackFonts
      .slice(0, CLAMP.maxFallbackFonts)
      .map(clampFamily)
      .filter((f) => f !== '');
  if (typeof x.underline === 'boolean') out.underline = x.underline;
  if (x.glow && typeof x.glow === 'object') out.glow = clampGlow(x.glow);
  const paint = clampGradient(x.paint);
  if (paint) out.paint = paint;
  if (x.lineMask && typeof x.lineMask === 'object') {
    const lm = clampLineMask(x.lineMask);
    if (lm) out.lineMask = lm;
  }
}

const RICH_STYLE_KEYS = [
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
] as const;

/** Whether a style has a field only the rich engine draws. */
export function isRichStyle(style: TextStyle): boolean {
  if (style.lineMask !== undefined) return true;
  const s = style as Partial<Record<(typeof RICH_STYLE_KEYS)[number], unknown>>;
  for (const k of RICH_STYLE_KEYS) if (s[k] !== undefined) return true;
  return false;
}

/**
 * A ProPresenter line-fill mask within the render plan bounds: style preserved ('fullWidth' | 'lineWidth' | 'maxLineWidth'),
 * bounded offsets, fill and gradient clamped, undefined when neither fill nor gradient is valid.
 */
export function clampLineMask(m: unknown): TextLineMask | undefined {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
  const x = m as Partial<TextLineMask>;
  const fill = x.fill && typeof x.fill === 'object' ? clampColor(x.fill) : undefined;
  const gradient = clampGradient(x.gradient);
  if (!fill && !gradient) return undefined;
  const style =
    x.style === 'lineWidth' || x.style === 'maxLineWidth' || x.style === 'fullWidth' ? x.style : 'fullWidth';
  const out: TextLineMask = { style };
  if (fill) out.fill = fill;
  if (gradient) out.gradient = gradient;
  if (x.heightOffsetPx !== undefined) out.heightOffsetPx = num(x.heightOffsetPx, -2000, 2000, 0);
  if (x.vOffsetPx !== undefined) out.vOffsetPx = num(x.vOffsetPx, -2000, 2000, 0);
  if (x.widthOffsetPx !== undefined) out.widthOffsetPx = num(x.widthOffsetPx, -4000, 4000, 0);
  if (x.hOffsetPx !== undefined) out.hOffsetPx = num(x.hOffsetPx, -4000, 4000, 0);
  return out;
}

function clampGlow(v: Partial<Glow>): Glow {
  return {
    radius: num(v.radius, 0, CLAMP.maxEffectPx, 0),
    color: clampColor(v.color, { r: 0, g: 0, b: 0, a: 1 }),
  };
}

/**
 * A gradient (design/27 §3.1 `Gradient`) with known kind, bounded angle and centre, and 2-16 stops sorted by
 * position (stable), each within 0..1. Undefined when absent or with fewer than two usable stops: the caller
 * then paints its solid colour.
 */
export function clampGradient(g: unknown): Gradient | undefined {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return undefined;
  const x = g as Partial<Record<keyof Gradient, unknown>>;
  if (!Array.isArray(x.stops)) return undefined;
  const stops: Gradient['stops'] = [];
  for (let i = 0; i < x.stops.length && stops.length < CLAMP.maxGradientStops; i++) {
    const s = x.stops[i] as { at?: unknown; color?: unknown } | null | undefined;
    if (!s || typeof s !== 'object') continue;
    stops.push({ at: num(s.at, 0, 1, 0), color: clampColor(s.color, { r: 0, g: 0, b: 0, a: 1 }) });
  }
  if (stops.length < 2) return undefined;
  stops.sort((a, b) => a.at - b.at);
  const out: Gradient = { kind: x.kind === 'radial' ? 'radial' : 'linear', stops };
  if (x.angle !== undefined) out.angle = num(x.angle, -36_000, 36_000, 0);
  if (typeof x.scaled === 'boolean') out.scaled = x.scaled;
  if (x.center && typeof x.center === 'object') {
    const c = x.center as { x?: unknown; y?: unknown };
    out.center = { x: num(c.x, -1, 1, 0.5), y: num(c.y, -1, 1, 0.5) };
  }
  return out;
}

const PATH_FILL_MODES: readonly PathFillMode[] = [
  'norm',
  'none',
  'lighten',
  'lightenLess',
  'darken',
  'darkenLess',
];

/**
 * A stored geometry (design/27 §3.1 `ShapeGeom`, §12): a preset name of letters and digits (at most 40), at
 * most 10 finite adjust pairs (`adj` within ±1e7; M9's `adjWide`, the angles past it, within ±21,600,000),
 * at most 8 paths, each path string re-tokenised (`cleanPathData`: only M L Q C Z
 * and numbers, at most 4,096 points) with its space within 0..1e9, `cont` kept when true (the stored pieces
 * of one path), `ref` (a geometry file, M6 round 2: `geom/stored.ts` draws its paths once read) kept when
 * it is 1-100 characters without control characters. Unknown fill modes are 'norm' (the schema's .catch).
 * Undefined when nothing usable is left.
 */
export function clampGeom(g: unknown): ShapeGeom | undefined {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return undefined;
  const x = g as Partial<Record<keyof ShapeGeom, unknown>>;
  const out: ShapeGeom = {};
  if (typeof x.preset === 'string') {
    const preset = x.preset.slice(0, 40).replace(/[^A-Za-z0-9]/g, '');
    if (preset) out.preset = preset;
  }
  const pairs = (list: unknown[], max: number): [string, number][] => {
    const adj: [string, number][] = [];
    for (let i = 0; i < list.length && adj.length < CLAMP.maxGeomAdjust; i++) {
      const p = list[i];
      if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'number') continue;
      if (!Number.isFinite(p[1])) continue;
      adj.push([p[0].slice(0, 16), num(p[1], -max, max, 0)]);
    }
    return adj;
  };
  if (Array.isArray(x.adj)) {
    const adj = pairs(x.adj, 1e7);
    if (adj.length) out.adj = adj;
  }
  if (Array.isArray(x.adjWide)) {
    const adjWide = pairs(x.adjWide, 21_600_000);
    if (adjWide.length) out.adjWide = adjWide;
  }
  if (Array.isArray(x.paths)) {
    const paths: NonNullable<ShapeGeom['paths']> = [];
    for (let i = 0; i < x.paths.length && paths.length < PATH_DATA_LIMITS.paths; i++) {
      const p = x.paths[i] as Partial<Record<string, unknown>> | null | undefined;
      if (!p || typeof p !== 'object') continue;
      const d = cleanPathData(p.d);
      if (!d) continue;
      const path: NonNullable<ShapeGeom['paths']>[number] = {
        d,
        w: num(p.w, 0, PATH_DATA_LIMITS.coord, 0),
        h: num(p.h, 0, PATH_DATA_LIMITS.coord, 0),
      };
      if (p.fill !== undefined)
        path.fill = PATH_FILL_MODES.includes(p.fill as PathFillMode) ? (p.fill as PathFillMode) : 'norm';
      if (typeof p.stroke === 'boolean') path.stroke = p.stroke;
      if (p.cont === true) path.cont = true;
      paths.push(path);
    }
    if (paths.length) out.paths = paths;
  }
  if (
    typeof x.ref === 'string' &&
    x.ref.length >= 1 &&
    x.ref.length <= 100 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    !/[\u0000-\u001f\u007f]/.test(x.ref)
  )
    out.ref = x.ref;
  return out.preset || out.paths || out.ref ? out : undefined;
}

const LINE_DASHES: readonly LineDash[] = [
  'solid',
  'dot',
  'dash',
  'dashDot',
  'longDash',
  'longDashDot',
  'longDashDotDot',
  'sysDot',
  'sysDash',
  'sysDashDot',
  'sysDashDotDot',
];
const ARROW_TYPES: readonly ArrowEnd['type'][] = ['none', 'triangle', 'stealth', 'arrow', 'oval', 'diamond'];
const ARROW_SIZES: readonly NonNullable<ArrowEnd['w']>[] = ['sm', 'med', 'lg'];

/** An arrowhead with known type and sizes (the schema's .catch defaults); undefined for none or garbage. */
function clampArrowEnd(v: unknown): ArrowEnd | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const x = v as Partial<Record<keyof ArrowEnd, unknown>>;
  const type = ARROW_TYPES.includes(x.type as ArrowEnd['type']) ? (x.type as ArrowEnd['type']) : 'none';
  if (type === 'none') return undefined;
  const out: ArrowEnd = { type };
  const size = (s: unknown) => (ARROW_SIZES.includes(s as 'med') ? (s as 'med') : 'med');
  if (x.w !== undefined) out.w = size(x.w);
  if (x.len !== undefined) out.len = size(x.len);
  return out;
}

type ShapeObj = Extract<SlideObject, { type: 'shape' }>;
type ImageObj = Extract<SlideObject, { type: 'image' }>;

/**
 * The M6 drawing fields of a shape (design/27 §3.1), each only when present and usable, so a legacy shape
 * clamps to exactly the fields it had and draws through the legacy path.
 */
function clampShapeExtras(s: Partial<ShapeObj>, out: ShapeObj): void {
  const geom = clampGeom(s.geom);
  if (geom) out.geom = geom;
  const gradient = clampGradient(s.gradient);
  if (gradient) out.gradient = gradient;
  if (s.dash !== undefined) {
    const dash = LINE_DASHES.includes(s.dash) ? s.dash : 'solid';
    if (dash !== 'solid') out.dash = dash;
  }
  // Joins and caps: unknown values are the defaults (the schema's .catch), which are left out.
  if (s.lineJoin === 'round' || s.lineJoin === 'bevel') out.lineJoin = s.lineJoin;
  if (s.lineCap === 'round' || s.lineCap === 'square') out.lineCap = s.lineCap;
  if (s.ends && typeof s.ends === 'object') {
    const head = clampArrowEnd(s.ends.head);
    const tail = clampArrowEnd(s.ends.tail);
    if (head || tail) out.ends = { ...(head ? { head } : {}), ...(tail ? { tail } : {}) };
  }
  if (s.flipH === true) out.flipH = true;
  if (s.flipV === true) out.flipV = true;
  if (s.shadow && typeof s.shadow === 'object') out.shadow = clampShadow(s.shadow);
  if (s.glow && typeof s.glow === 'object') {
    const glow = clampGlow(s.glow);
    if (glow.radius > 0) out.glow = glow;
  }
  if (s.softEdge !== undefined) {
    const soft = num(s.softEdge, 0, CLAMP.maxEffectPx, 0);
    if (soft > 0) out.softEdge = soft;
  }
  clampShapeKind(s, out);
}

/**
 * What a shape draws instead of its geometry (design/27 M9), clamped by its area's file in `clamp/`: at most
 * one of `table`, `chart` and `decor`, the first usable one in that order (the others are dropped), and its
 * `look3d` only without any of them (a table, a chart or a decoration is never drawn in 3-D).
 */
function clampShapeKind(s: Partial<ShapeObj>, out: ShapeObj): void {
  const table = s.table === undefined ? undefined : clampTable(s.table);
  const chart = table || s.chart === undefined ? undefined : clampChart(s.chart);
  const decor = table || chart || s.decor === undefined ? undefined : clampDecor(s.decor);
  if (table) out.table = table;
  else if (chart) out.chart = chart;
  else if (decor) out.decor = decor;
  else if (s.look3d !== undefined) {
    const look3d = clampLook3d(s.look3d);
    if (look3d) out.look3d = look3d;
  }
}

/**
 * A picture's mask, flips, shadow and soft edge (design/27 §3.1) and its M9 fields, each only when present
 * and usable.
 */
function clampImageExtras(i: Partial<ImageObj>, out: ImageObj): void {
  if (i.flipH === true) out.flipH = true;
  if (i.flipV === true) out.flipV = true;
  const mask = clampGeom(i.mask);
  if (mask) out.mask = mask;
  if (i.shadow && typeof i.shadow === 'object') out.shadow = clampShadow(i.shadow);
  if (i.softEdge !== undefined) {
    const soft = num(i.softEdge, 0, CLAMP.maxEffectPx, 0);
    if (soft > 0) out.softEdge = soft;
  }
  if (i.look3d !== undefined) {
    const look3d = clampLook3d(i.look3d);
    if (look3d) out.look3d = look3d;
  }
  if (i.vectorFonts !== undefined) {
    const budget = new FontBudget(MAX_VECTOR_FONTS);
    const fonts = clampVectorFonts(i.vectorFonts, (f) => budget.family(f));
    if (fonts) out.vectorFonts = fonts;
  }
}

/**
 * The M9 looks of a text object (design/27 M9: they live on the object, never on its style), each only when
 * present and usable: its warp, its vertical writing, its centred block and its 3-D look.
 */
function clampTextExtras(t: Partial<TextObject>, out: TextObject): void {
  if (t.warp !== undefined) {
    const warp = clampWarp(t.warp);
    if (warp) out.warp = warp;
  }
  if (t.writing !== undefined) {
    const writing = clampWriting(t.writing);
    if (writing) out.writing = writing;
  }
  if (clampCenterBlock(t.centerBlock)) out.centerBlock = true;
  if (t.look3d !== undefined) {
    const look3d = clampLook3d(t.look3d);
    if (look3d) out.look3d = look3d;
  }
}

/**
 * Effective font size of a run: the box size × the run's scale × the fit scale, within 2-1,000 px
 * (`minRunFontPx`: a 1 pt run keeps its size).
 */
export function runFontPx(style: TextStyle, run: Pick<TextRun, 'sizeScale'> | undefined, fit = 1): number {
  return num(
    style.fontSizePx * (run?.sizeScale ?? 1) * fit,
    CLAMP.minRunFontPx,
    CLAMP.maxFontPx,
    style.fontSizePx,
  );
}

/**
 * Style runs over a text of `len` UTF-16 units: a run must start at or after the previous kept run's end
 * and before `len` (unsorted, overlapping, empty and out-of-range runs are dropped); its end is clamped to
 * `len`. Sizes are bounded so the box size × `sizeScale` stays within 2-1,000 px (`minRunFontPx`). Families
 * and size scales beyond the object's `FontBudget` take the box family and the nearest kept scale.
 */
export function clampRuns(
  runs: unknown,
  len: number,
  fontSizePx: number,
  budget: FontBudget = new FontBudget(),
): TextRun[] {
  if (!Array.isArray(runs)) return [];
  const out: TextRun[] = [];
  let at = 0;
  for (let i = 0; i < runs.length && out.length < CLAMP.maxRuns; i++) {
    const r = runs[i] as Partial<TextRun> | null | undefined;
    if (!r || typeof r !== 'object') continue;
    const { start } = r;
    if (typeof start !== 'number' || typeof r.end !== 'number' || !Number.isInteger(start)) continue;
    if (!Number.isInteger(r.end) || start < at || start >= len || r.end <= start) continue;
    const end = Math.min(r.end, len);
    const run: TextRun = { start, end };
    const family = budget.family(r.fontFamily);
    if (family) run.fontFamily = family;
    if (r.fontWeight !== undefined) run.fontWeight = Math.round(num(r.fontWeight, 1, 1000, 400));
    if (r.fontStyle !== undefined) run.fontStyle = r.fontStyle === 'italic' ? 'italic' : 'normal';
    if (r.sizeScale !== undefined) {
      const fs = clampFontSize(fontSizePx);
      run.sizeScale = budget.scale(
        num(r.sizeScale, Math.max(0.01, CLAMP.minRunFontPx / fs), Math.min(50, CLAMP.maxFontPx / fs), 1),
      );
    }
    if (r.color !== undefined) run.color = clampColor(r.color);
    if (r.highlight !== undefined) run.highlight = clampColor(r.highlight, { r: 255, g: 255, b: 0, a: 1 });
    if (typeof r.underline === 'boolean') run.underline = r.underline;
    if (typeof r.strike === 'boolean') run.strike = r.strike;
    if (r.baseline !== undefined) run.baseline = num(r.baseline, -1, 1, 0);
    if (r.letterSpacing !== undefined)
      run.letterSpacing = num(r.letterSpacing, -CLAMP.maxLetterSpacing, CLAMP.maxLetterSpacing, 0);
    if (r.caps !== undefined) run.caps = r.caps === 'all' || r.caps === 'small' ? r.caps : 'none';
    if (r.outline === null) run.outline = null;
    else if (r.outline && typeof r.outline === 'object') run.outline = clampOutline(r.outline);
    if (r.shadow === null) run.shadow = null;
    else if (r.shadow && typeof r.shadow === 'object') run.shadow = clampShadow(r.shadow);
    if (r.lang !== undefined) run.lang = clampLang(r.lang);
    out.push(run);
    at = end;
  }
  return out;
}

const PARA_ALIGN: readonly NonNullable<TextPara['align']>[] = [
  'left',
  'center',
  'right',
  'justify',
  'distribute',
];

function clampPara(v: unknown, budget: FontBudget): TextPara | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Partial<TextPara>;
  const out: TextPara = {};
  if (p.align !== undefined) out.align = PARA_ALIGN.includes(p.align) ? p.align : 'left';
  if (typeof p.soft === 'boolean') out.soft = p.soft;
  if (p.level !== undefined) out.level = Math.round(num(p.level, 0, 8, 0));
  const indent = (x: unknown) => num(x, -CLAMP.maxIndentPx, CLAMP.maxIndentPx, 0);
  const space = (x: unknown) => num(x, 0, CLAMP.maxIndentPx, 0);
  if (p.indentPx !== undefined) out.indentPx = indent(p.indentPx);
  if (p.firstLinePx !== undefined) out.firstLinePx = indent(p.firstLinePx);
  if (p.spaceBeforePx !== undefined) out.spaceBeforePx = space(p.spaceBeforePx);
  if (p.spaceAfterPx !== undefined) out.spaceAfterPx = space(p.spaceAfterPx);
  if (p.lineSpacing !== undefined) out.lineSpacing = num(p.lineSpacing, 0, 13.2, 1);
  if (p.lineSpacingPx !== undefined) out.lineSpacingPx = space(p.lineSpacingPx);
  if (p.bullet === null) out.bullet = null;
  else if (p.bullet && typeof p.bullet === 'object') {
    const b = p.bullet;
    const bullet: NonNullable<TextPara['bullet']> = {};
    if (typeof b.char === 'string') {
      // At most 8 UTF-16 units, without control characters; an empty one is no bullet character.
      let ch = '';
      for (const c of b.char.slice(0, 8)) if (c >= ' ' && c !== '\u007f') ch += c;
      if (ch) bullet.char = ch;
    }
    if (typeof b.auto === 'string') bullet.auto = b.auto.slice(0, 40).replace(/[^A-Za-z]/g, '');
    if (b.startAt !== undefined) bullet.startAt = Math.round(num(b.startAt, 1, 32_767, 1));
    const family = budget.family(b.fontFamily);
    if (family) bullet.fontFamily = family;
    if (b.color !== undefined) bullet.color = clampColor(b.color);
    if (b.sizePct !== undefined) bullet.sizePct = num(b.sizePct, 0.1, 4, 1);
    out.bullet = bullet;
  }
  if (typeof p.rtl === 'boolean') out.rtl = p.rtl;
  if (typeof p.hidden === 'boolean') out.hidden = p.hidden;
  return out;
}

/**
 * Paragraph styles of `text`: at most one per paragraph and at most `maxParas`; garbage entries become null.
 * Bullet families beyond the object's `FontBudget` are dropped (the bullet takes its first run's family).
 */
export function clampParas(
  paras: unknown,
  text: string,
  budget: FontBudget = new FontBudget(),
): (TextPara | null)[] {
  if (!Array.isArray(paras)) return [];
  let count = 1;
  for (let i = text.indexOf('\n'); i >= 0 && count < CLAMP.maxParas; i = text.indexOf('\n', i + 1)) count++;
  const n = Math.min(paras.length, count, CLAMP.maxParas);
  const out: (TextPara | null)[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = clampPara(paras[i], budget);
  return out;
}

function clampOrigin(v: unknown): ObjectOrigin | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Partial<ObjectOrigin>;
  const out: ObjectOrigin = { src: str(o.src, 16) };
  if (o.shapeId !== undefined) out.shapeId = Math.round(num(o.shapeId, 0, 2_147_483_647, 0));
  if (typeof o.ph === 'string') out.ph = o.ph.slice(0, 40);
  if (typeof o.role === 'string') out.role = o.role.slice(0, 20);
  if (o.group !== undefined) out.group = Math.round(num(o.group, 0, 100_000, 0));
  return out;
}

/** The fields every object has (origin, locked), copied when present. */
function clampCommon<T extends SlideObject>(x: Partial<SlideObject>, out: T): T {
  const origin = clampOrigin(x.origin);
  if (origin) out.origin = origin;
  if (x.locked === true) out.locked = true;
  return out;
}

const DEFAULT_STYLE: TextStyle = {
  fontFamily: 'Inter',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSizePx: 72,
  color: { r: 255, g: 255, b: 255, a: 1 },
  align: 'center',
  valign: 'middle',
  lineHeight: 1.2,
  letterSpacing: 0,
  padding: 0,
  transform: 'none',
};

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * `ImageObject.crop` with every share finite and within -1..1 (a malformed share counts as 0). Undefined
 * when absent, not an object, or cutting nothing. A crop that leaves nothing visible is kept: it draws
 * nothing (`drawImageFit`).
 */
export function clampCrop(c: unknown): ImageCrop | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const x = c as Partial<ImageCrop>;
  const out: ImageCrop = {
    l: num(x.l, -1, 1, 0),
    t: num(x.t, -1, 1, 0),
    r: num(x.r, -1, 1, 0),
    b: num(x.b, -1, 1, 0),
  };
  return out.l || out.t || out.r || out.b ? out : undefined;
}

/** Objects `clampObject` made (a clamped object clamps to an equal one: the drawers need not clamp it again). */
const CLAMPED = new WeakSet<object>();

/** Whether `o` is an object `clampObject` made. */
export function isClamped(o: unknown): boolean {
  return !!o && typeof o === 'object' && CLAMPED.has(o);
}

/**
 * Marks `o`, a copy of a clamped object with optional fields left out (geombudget.ts `legacyCopy`), as clamped:
 * clamping it again would only copy it, and `clampSlide` keeps it as it is, so a part of a slide
 * (`sceneSlides`) holds the very copies the slide's drawing budget made.
 */
export function keepClamped<T extends object>(o: T): T {
  CLAMPED.add(o);
  return o;
}

export function clampObject(o: unknown): SlideObject | undefined {
  const out = clampObjectOf(o);
  if (out) CLAMPED.add(out);
  return out;
}

function clampObjectOf(o: unknown): SlideObject | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const x = o as Partial<SlideObject> & { type?: unknown };
  const id = str(x.id) || 'obj';
  const box = clampBox(x.box);
  const opacity = num((x as { opacity?: unknown }).opacity, 0, 1, 1);
  if (x.type === 'text') {
    const t = x as Partial<TextObject>;
    const text = clampText(t.text);
    const style = clampStyle(t.style);
    const out: TextObject = { id, type: 'text', box, text, style, opacity };
    const budget = new FontBudget();
    if (Array.isArray(t.runs)) out.runs = clampRuns(t.runs, text.length, style.fontSizePx, budget);
    if (Array.isArray(t.paras)) out.paras = clampParas(t.paras, text, budget);
    clampTextExtras(t, out);
    return clampCommon(x, out);
  }
  if (x.type === 'image') {
    const i = x as Partial<Extract<SlideObject, { type: 'image' }>>;
    const mediaId = str(i.mediaId);
    if (!mediaId) return undefined;
    const fit = i.fit === 'cover' || i.fit === 'stretch' ? i.fit : 'contain';
    const radius = num(i.radius, 0, CLAMP.maxRadius, 0);
    const out: Extract<SlideObject, { type: 'image' }> = {
      id,
      type: 'image',
      box,
      mediaId,
      fit,
      opacity,
      radius,
    };
    const crop = clampCrop(i.crop);
    if (crop) out.crop = crop;
    clampImageExtras(i, out);
    return clampCommon(x, out);
  }
  if (x.type === 'shape') {
    const s = x as Partial<Extract<SlideObject, { type: 'shape' }>>;
    const shape = s.shape === 'ellipse' || s.shape === 'line' ? s.shape : 'rect';
    const out: Extract<SlideObject, { type: 'shape' }> = {
      id,
      type: 'shape',
      box,
      shape,
      opacity,
      radius: num(s.radius, 0, CLAMP.maxRadius, 0),
    };
    if (s.fill) out.fill = clampColor(s.fill);
    if (s.stroke && typeof s.stroke === 'object')
      out.stroke = { width: num(s.stroke.width, 0, CLAMP.maxEffectPx, 1), color: clampColor(s.stroke.color) };
    clampShapeExtras(s, out);
    if (
      out.dash &&
      out.dash !== 'solid' &&
      out.stroke &&
      out.stroke.width > 0 &&
      out.stroke.width < CLAMP.minDashedStrokePx
    )
      out.stroke = { ...out.stroke, width: CLAMP.minDashedStrokePx };
    return clampCommon(x, out);
  }
  return undefined;
}

const slideMemo = new WeakMap<object, Slide>();

/**
 * A drawable copy of `slide`: at most 200 objects, each clamped; unknown objects dropped; at most
 * `maxImagesPerSlide` distinct images drawn (further image objects are dropped). The imported image objects
 * of a slide set to show its PowerPoint picture are not drawn (`slideContent`, design/27 §5) and do not
 * count; they are kept, since lyric-only looks still read the slide's text. An image object keeps its
 * clamped `play`, and the slide its clamped `audio` (design/27 §3.1). Never throws.
 */
export function clampSlide(slide: unknown): Slide {
  if (slide && typeof slide === 'object') {
    const hit = slideMemo.get(slide);
    if (hit) return hit;
  }
  const s = (slide && typeof slide === 'object' ? slide : {}) as Partial<Slide>;
  const objects: SlideObject[] = [];
  const images = new Set<string>();
  const src = Array.isArray(s.objects) ? s.objects : [];
  const underPicture = !!referencePicture(s);
  for (let i = 0; i < src.length && objects.length < CLAMP.maxObjects; i++) {
    // An object clamped already (a part of a clamped slide, `sceneSlides`) is kept as it is.
    const raw = src[i];
    const o = isClamped(raw) ? (raw as SlideObject) : withPlay(clampObject(raw), raw);
    if (!o) continue;
    if (o.type === 'image' && !(underPicture && fromImport(o))) {
      if (!images.has(o.mediaId) && images.size >= CLAMP.maxImagesPerSlide) continue;
      images.add(o.mediaId);
    }
    objects.push(o);
  }
  const out: Slide = { id: str(s.id) || 'slide', objects };
  if (typeof s.lyricObjectId === 'string') out.lyricObjectId = s.lyricObjectId.slice(0, 200);
  if (typeof s.backgroundMediaId === 'string') out.backgroundMediaId = s.backgroundMediaId.slice(0, 200);
  if (s.clearBackground === true) out.clearBackground = true;
  if (typeof s.bottomThirdText === 'string') out.bottomThirdText = clampText(s.bottomThirdText);
  const audio = clampSlideSound(s.audio);
  if (audio) out.audio = audio;
  if (s.imported && typeof s.imported === 'object' && typeof s.imported.imageMediaId === 'string') {
    const imp = s.imported;
    out.imported = {
      fileId: str(imp.fileId),
      page: Math.round(num(imp.page, 0, 100_000, 0)),
      imageMediaId: imp.imageMediaId.slice(0, 200),
    };
    if (Array.isArray(imp.textBoxes))
      out.imported.textBoxes = imp.textBoxes.slice(0, CLAMP.maxObjects).map((t) => ({
        text: clampText(t?.text),
        box: clampBox(t?.box),
        fontSizePx: t?.fontSizePx === undefined ? undefined : clampFontSize(t.fontSizePx),
      }));
    if (imp.textAligned === true) out.imported.textAligned = true;
  }
  if (s.hidden === true) out.hidden = true;
  const transition = clampTransition(s.transition);
  if (transition) out.transition = transition;
  const pptx = clampPptx(s.pptx);
  if (pptx) out.pptx = pptx;
  if (slide && typeof slide === 'object') slideMemo.set(slide, out);
  slideMemo.set(out, out);
  return out;
}

type SlideTransition = NonNullable<Slide['transition']>;
type SlidePptx = NonNullable<Slide['pptx']>;

/** A slide's own transition (design/27 §9): a cut, or a crossfade of 0-10 s; undefined when unusable. */
export function clampTransition(t: unknown): SlideTransition | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const x = t as { kind?: unknown; ms?: unknown };
  if (x.kind === 'cut') return { kind: 'cut' };
  if (x.kind === 'crossfade') return { kind: 'crossfade', ms: num(x.ms, 0, 10_000, 300) };
  return undefined;
}

/**
 * What drawers read of `Slide.pptx` (design/27 §5 "One rule for every drawer": `show` and `refMediaId`),
 * with the required provenance bounded. Notes, `artText` and the digest are not drawn and are dropped;
 * unknown enum values fall back to the defaults, as the schema's `.catch` does. Undefined when absent.
 */
export function clampPptx(p: unknown): SlidePptx | undefined {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const x = p as Partial<Record<keyof SlidePptx, unknown>>;
  const out: SlidePptx = {
    fileId: str(x.fileId),
    index: Math.round(num(x.index, 0, 100_000, 0)),
    class: x.class === 'hybrid' || x.class === 'picture' ? x.class : 'native',
    version: Math.round(num(x.version, 1, 1_000_000, 1)),
  };
  if (x.shown !== undefined) out.shown = Math.round(num(x.shown, 0, 100_000, 0));
  if (x.pending === true) out.pending = true;
  const ref = str(x.refMediaId);
  if (ref) out.refMediaId = ref;
  if (x.show === 'picture') out.show = 'picture';
  return out;
}

/** Whether clamping changed anything that would be drawn (for reporting). */
export function slideWasClamped(raw: Slide, clamped: Slide): boolean {
  return !Array.isArray(raw?.objects) || raw.objects.length !== clamped.objects.length;
}

type Play = NonNullable<Extract<SlideObject, { type: 'image' }>['play']>;
type SlideSound = NonNullable<Slide['audio']>;

/** Mirrors the schema's `.catch('auto')`: a start that is present but unknown is 'auto'. */
function mediaStart(v: unknown): 'auto' | 'click' {
  return v === 'click' ? 'click' : 'auto';
}

/** `ImageObject.play` with known enums and bounded numbers (design/27 §3.1); undefined when unusable. */
export function clampPlay(p: unknown): Play | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const x = p as Partial<Record<keyof Play, unknown>>;
  const mediaId = str(x.mediaId);
  if (!mediaId) return undefined;
  const out: Play = { mediaId };
  if (x.start !== undefined) out.start = mediaStart(x.start);
  if (typeof x.loop === 'boolean') out.loop = x.loop;
  if (x.onEnd !== undefined) out.onEnd = x.onEnd === 'black' || x.onEnd === 'advance' ? x.onEnd : 'hold';
  if (x.gainDb !== undefined) out.gainDb = num(x.gainDb, -100, 100, 0);
  if (typeof x.muted === 'boolean') out.muted = x.muted;
  if (typeof x.showWhenStopped === 'boolean') out.showWhenStopped = x.showWhenStopped;
  return out;
}

/** `Slide.audio` with known enums and bounded numbers (design/27 §3.1); undefined when unusable. */
export function clampSlideSound(a: unknown): SlideSound | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const x = a as Partial<Record<keyof SlideSound, unknown>>;
  const mediaId = str(x.mediaId);
  if (!mediaId) return undefined;
  const out: SlideSound = { mediaId };
  if (x.start !== undefined) out.start = mediaStart(x.start);
  if (typeof x.loop === 'boolean') out.loop = x.loop;
  if (x.gainDb !== undefined) out.gainDb = num(x.gainDb, -100, 100, 0);
  if (typeof x.muted === 'boolean') out.muted = x.muted;
  if (x.slides !== undefined) out.slides = Math.round(num(x.slides, 1, 999, 1));
  return out;
}

/** A clamped image object with the clamped `play` of its raw source (other objects pass through). */
function withPlay(o: SlideObject | undefined, raw: unknown): SlideObject | undefined {
  if (o?.type !== 'image') return o;
  const play = clampPlay((raw as { play?: unknown }).play);
  if (play) o.play = play;
  return o;
}

const lookMemo = new WeakMap<object, Look>();
const LOOK_KINDS: readonly Look['kind'][] = ['main', 'stage', 'lowerThird', 'stream', 'custom'];

/**
 * A drawable copy of a look: missing parts come from the main look, styles and bands are clamped.
 * Never throws.
 */
export function clampLook(look: unknown): Look {
  if (look && typeof look === 'object') {
    const hit = lookMemo.get(look);
    if (hit) return hit;
  }
  const l = (look && typeof look === 'object' ? look : {}) as Partial<Look>;
  const base = LOOK_MAIN;
  const layers = (l.layers && typeof l.layers === 'object' ? l.layers : {}) as Partial<Look['layers']>;
  const vis = (r: unknown, d: { visible: boolean }) =>
    r && typeof r === 'object' && typeof (r as { visible?: unknown }).visible === 'boolean'
      ? { visible: (r as { visible: boolean }).visible }
      : d;
  let slide: Look['layers']['slide'] = base.layers.slide;
  const sr = layers.slide as Partial<Look['layers']['slide']> | undefined;
  if (sr && typeof sr === 'object') {
    if (sr.mode === 'hidden') slide = { mode: 'hidden' };
    else if (sr.mode === 'authored') slide = { mode: 'authored' };
    else if (sr.mode === 'lyricOnly') {
      const ly = sr as Extract<Look['layers']['slide'], { mode: 'lyricOnly' }>;
      slide = {
        mode: 'lyricOnly',
        style: clampStyle(ly.style),
        band: clampBox(ly.band),
        nonSong: ly.nonSong === 'none' ? 'none' : 'text',
      };
      if (ly.nextSlide && typeof ly.nextSlide === 'object')
        slide.nextSlide = { style: clampStyle(ly.nextSlide.style), band: clampBox(ly.nextSlide.band) };
    }
  }
  const pr = (
    layers.props && typeof layers.props === 'object' ? layers.props : base.layers.props
  ) as Look['layers']['props'];
  const style: Record<string, Look['layers']['props']['style'][string]> = {};
  if (pr.style && typeof pr.style === 'object')
    for (const [k, v] of Object.entries(pr.style).slice(0, 20))
      style[k] = { ...clampStyle(v), box: clampBox((v as { box?: unknown } | undefined)?.box) };
  const props: Look['layers']['props'] = {
    logo: pr.logo === true,
    countdown: pr.countdown === true,
    clock: pr.clock === true,
    messages: pr.messages === true,
    elapsed: pr.elapsed === true,
    style,
  };
  if (typeof pr.mediaRemaining === 'boolean') props.mediaRemaining = pr.mediaRemaining;
  if (typeof pr.notes === 'boolean') props.notes = pr.notes;
  const tr = l.transition as Look['transition'] | undefined;
  const transition: Look['transition'] =
    tr && typeof tr === 'object' && (tr.kind === 'cut' || tr.kind === 'crossfade')
      ? tr.kind === 'crossfade'
        ? { ...tr, kind: 'crossfade', ms: num((tr as { ms?: unknown }).ms, 0, 10_000, 300) }
        : { ...tr, kind: 'cut' }
      : base.transition;
  const out: Look = {
    id: str(l.id) || base.id,
    name: str(l.name) || base.name,
    kind: LOOK_KINDS.includes(l.kind as Look['kind']) ? (l.kind as Look['kind']) : 'custom',
    layers: {
      background: vis(layers.background, base.layers.background),
      slide,
      lowerThird: vis(layers.lowerThird, base.layers.lowerThird),
      media: vis(layers.media, base.layers.media),
      props,
    },
    clearColor: clampColor(l.clearColor, { r: 0, g: 0, b: 0, a: 1 }),
    transition,
  };
  if (typeof l.holdingMediaId === 'string') out.holdingMediaId = l.holdingMediaId.slice(0, 200);
  if (look && typeof look === 'object') lookMemo.set(look, out);
  lookMemo.set(out, out);
  return out;
}
