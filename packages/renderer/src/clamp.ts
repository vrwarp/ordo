import {
  type Box,
  type ImageCrop,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  LOOK_MAIN,
  type Look,
  type ObjectOrigin,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextPara,
  type TextRun,
  type TextStyle,
} from '@ordo/domain';

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
  minFontPx: 4,
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
  readonly #families = new Set<string>();
  readonly #scales = new Set<number>();
  constructor(
    readonly maxFamilies: number = CLAMP.maxRunFamilies,
    readonly maxScales: number = CLAMP.maxSizeScales,
  ) {}

  /** `family` when it is within the budget, else '' (the run or bullet takes the box's or run's family). */
  family(family: string): string {
    const k = family.trim().toLowerCase();
    if (!k || this.#families.has(k)) return family;
    if (this.#families.size >= this.maxFamilies) return '';
    this.#families.add(k);
    return family;
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

function clampShadow(v: Partial<NonNullable<TextStyle['shadow']>>): NonNullable<TextStyle['shadow']> {
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
  if (x.glow && typeof x.glow === 'object')
    out.glow = {
      radius: num(x.glow.radius, 0, CLAMP.maxEffectPx, 0),
      color: clampColor(x.glow.color, { r: 0, g: 0, b: 0, a: 1 }),
    };
}

/** Effective font size of a run: the box size × the run's scale × the fit scale, within 4-1,000 px. */
export function runFontPx(style: TextStyle, run: Pick<TextRun, 'sizeScale'> | undefined, fit = 1): number {
  return clampFontSize(style.fontSizePx * (run?.sizeScale ?? 1) * fit, style.fontSizePx);
}

/**
 * Style runs over a text of `len` UTF-16 units: a run must start at or after the previous kept run's end
 * and before `len` (unsorted, overlapping, empty and out-of-range runs are dropped); its end is clamped to
 * `len`. Sizes are bounded so the box size × `sizeScale` stays within 4-1,000 px. Families and size scales
 * beyond the object's `FontBudget` take the box family and the nearest kept scale.
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
    const family = budget.family(clampFamily(r.fontFamily));
    if (family) run.fontFamily = family;
    if (r.fontWeight !== undefined) run.fontWeight = Math.round(num(r.fontWeight, 1, 1000, 400));
    if (r.fontStyle !== undefined) run.fontStyle = r.fontStyle === 'italic' ? 'italic' : 'normal';
    if (r.sizeScale !== undefined) {
      const fs = clampFontSize(fontSizePx);
      run.sizeScale = budget.scale(
        num(r.sizeScale, Math.max(0.01, CLAMP.minFontPx / fs), Math.min(50, CLAMP.maxFontPx / fs), 1),
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
    const family = budget.family(clampFamily(b.fontFamily));
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

export function clampObject(o: unknown): SlideObject | undefined {
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
    return clampCommon(x, out);
  }
  return undefined;
}

const slideMemo = new WeakMap<object, Slide>();

/**
 * A drawable copy of `slide`: at most 200 objects, each clamped; unknown objects dropped; at most
 * `maxImagesPerSlide` distinct images (further image objects are dropped). An image object keeps its
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
  for (let i = 0; i < src.length && objects.length < CLAMP.maxObjects; i++) {
    const o = withPlay(clampObject(src[i]), src[i]);
    if (!o) continue;
    if (o.type === 'image') {
      if (!images.has(o.mediaId) && images.size >= CLAMP.maxImagesPerSlide) continue;
      images.add(o.mediaId);
    }
    objects.push(o);
  }
  const out: Slide = { id: str(s.id) || 'slide', objects };
  if (typeof s.lyricObjectId === 'string') out.lyricObjectId = s.lyricObjectId.slice(0, 200);
  if (typeof s.backgroundMediaId === 'string') out.backgroundMediaId = s.backgroundMediaId.slice(0, 200);
  if (s.clearBackground === true) out.clearBackground = true;
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
  }
  if (slide && typeof slide === 'object') slideMemo.set(slide, out);
  slideMemo.set(out, out);
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
