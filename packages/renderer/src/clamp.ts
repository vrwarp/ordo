import {
  type Box,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  LOOK_MAIN,
  type Look,
  type Rgba,
  type Slide,
  type SlideObject,
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

export function clampStyle(s: unknown, dflt: TextStyle = DEFAULT_STYLE): TextStyle {
  if (!s || typeof s !== 'object') return dflt;
  const x = s as Partial<TextStyle>;
  const family =
    typeof x.fontFamily === 'string' && x.fontFamily.trim()
      ? x.fontFamily.slice(0, FONT_FAMILY_MAX).replace(/["\\\n\r]/g, '')
      : dflt.fontFamily;
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
  if (x.outline && typeof x.outline === 'object')
    out.outline = {
      width: num(x.outline.width, 0, CLAMP.maxEffectPx, 0),
      color: clampColor(x.outline.color, { r: 0, g: 0, b: 0, a: 1 }),
    };
  if (x.shadow && typeof x.shadow === 'object')
    out.shadow = {
      dx: num(x.shadow.dx, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0),
      dy: num(x.shadow.dy, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0),
      blur: num(x.shadow.blur, 0, CLAMP.maxEffectPx, 0),
      color: clampColor(x.shadow.color, { r: 0, g: 0, b: 0, a: 1 }),
    };
  if (x.fill && typeof x.fill === 'object')
    out.fill = {
      color: clampColor(x.fill.color, { r: 0, g: 0, b: 0, a: 1 }),
      radius: num(x.fill.radius, 0, CLAMP.maxRadius, 0),
    };
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

export function clampObject(o: unknown): SlideObject | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const x = o as Partial<SlideObject> & { type?: unknown };
  const id = str(x.id) || 'obj';
  const box = clampBox(x.box);
  const opacity = num((x as { opacity?: unknown }).opacity, 0, 1, 1);
  if (x.type === 'text') {
    const t = x as Partial<Extract<SlideObject, { type: 'text' }>>;
    return { id, type: 'text', box, text: clampText(t.text), style: clampStyle(t.style), opacity };
  }
  if (x.type === 'image') {
    const i = x as Partial<Extract<SlideObject, { type: 'image' }>>;
    const mediaId = str(i.mediaId);
    if (!mediaId) return undefined;
    const fit = i.fit === 'cover' || i.fit === 'stretch' ? i.fit : 'contain';
    return { id, type: 'image', box, mediaId, fit, opacity, radius: num(i.radius, 0, CLAMP.maxRadius, 0) };
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
    return out;
  }
  return undefined;
}

const slideMemo = new WeakMap<object, Slide>();

/**
 * A drawable copy of `slide`: at most 200 objects, each clamped; unknown objects dropped; at most
 * `maxImagesPerSlide` distinct images (further image objects are dropped). Never throws.
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
    const o = clampObject(src[i]);
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
