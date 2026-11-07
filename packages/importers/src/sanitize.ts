/**
 * Clamp what an importer produces to the bounds the editor and the render plan accept (design/25: "the
 * importer cannot write anything the editor could not"). Decoded files carry whatever their authors or a
 * corrupted byte wrote: NaN or infinite doubles, megabyte strings, negative sizes. Everything numeric is made
 * finite and bounded here; strings are cut; nothing is thrown.
 */
import {
  type Box,
  type ExtractedText,
  type Gradient,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  PATH_DATA_LIMITS,
  type Presentation,
  type Rgba,
  type ShapeGeom,
  type SlideObject,
  type TextLineMask,
  type TextObject,
  type TextPara,
  type TextRun,
  type TextStyle,
  cleanPathData,
  MISSING_LIMITS,
} from '@ordo/domain';
import { sanitizeChart } from './sanitize/chart.ts';
import { sanitizeDecor } from './sanitize/decor.ts';
import { sanitizeLook3d } from './sanitize/look3d.ts';
import { sanitizeTable } from './sanitize/table.ts';
import { sanitizeWarp } from './sanitize/warp.ts';
import { sanitizeCenterBlock, sanitizeWriting } from './sanitize/writing.ts';

export const IMPORT_LIMITS = {
  text: 10_000,
  title: 300,
  label: 60,
  short: 8,
  name: 200,
  meta: 300,
  notes: 10_000,
  fontFamily: 120,
  fontSizeMin: 4,
  fontSizeMax: 1000,
  /** A style run's size (`fontSizePx` × `sizeScale`): 1 pt, as the render plan keeps it (`minRunFontPx`). */
  runFontSizeMin: 2,
  /** Boxes stay within ±2× the canvas (the render plan's clamp). */
  boxSpan: 2,
  durationMinMs: 500,
  durationMaxMs: 3_600_000,
  /** Style runs and paragraph styles of one text object (the schema's bounds). */
  runs: 2000,
  paras: 5000,
  fallbackFonts: 8,
  /** Distinct run and bullet families, and run size scales, of one text object (the render plan's bounds). */
  runFamilies: 16,
  sizeScales: 64,
} as const;

/**
 * A family name as the render plan draws it (its `clampFamily`): without quotes, backslashes, C0 and C1
 * control characters and line or paragraph separators, and here without surrounding whitespace.
 */
function cleanFamily(f: string): string {
  let out = '';
  for (let i = 0; i < f.length; i++) {
    const c = f.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x22 || c === 0x5c || c === 0x2028 || c === 0x2029)
      continue;
    out += f[i];
  }
  return out.trim();
}

/**
 * The distinct fonts one text object may name, shared by its runs and bullets (the render plan's
 * `FontBudget`): families past `runFamilies` are dropped (the box's or the first run's is used), size scales
 * past `sizeScales` take the nearest one kept. Each new family or size costs a drawer a font lookup. A family
 * is keyed by its cleaned name (`cleanFamily`), lower-cased, as the render plan keys it, and is stored with
 * the spelling first kept: names that differ in case, surrounding spaces, quotes or control characters are
 * one family and one name.
 */
export type FontBudget = { family(f: string): string; scale(s: number): number };

export function fontBudget(): FontBudget {
  const families = new Map<string, string>();
  const scales = new Set<number>();
  return {
    family(f) {
      const name = cleanFamily(f);
      const k = name.toLowerCase();
      if (!k) return '';
      const kept = families.get(k);
      if (kept !== undefined) return kept;
      if (families.size >= IMPORT_LIMITS.runFamilies) return '';
      families.set(k, name);
      return name;
    },
    scale(v) {
      if (scales.has(v) || scales.size < IMPORT_LIMITS.sizeScales) {
        scales.add(v);
        return v;
      }
      let best = v;
      let d = Number.POSITIVE_INFINITY;
      for (const x of scales)
        if (Math.abs(x - v) < d) {
          d = Math.abs(x - v);
          best = x;
        }
      return best;
    },
  };
}

export function finite(v: unknown, def: number, lo = -Number.MAX_VALUE, hi = Number.MAX_VALUE): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.max(lo, Math.min(hi, n));
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Cut to `max` UTF-16 units without splitting a pair; lone surrogates become U+FFFD. */
export function clipText(s: unknown, max: number): string {
  let t = typeof s === 'string' ? s : '';
  if (t.length > max) {
    let end = max;
    const c = t.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
    t = t.slice(0, end);
  }
  return t.replace(LONE_SURROGATE, '�');
}

export function clampColor(c: Rgba | undefined, def: Rgba = { r: 255, g: 255, b: 255, a: 1 }): Rgba {
  if (!c) return def;
  const ch = (v: unknown) => Math.round(finite(v, 0, 0, 255));
  return { r: ch(c.r), g: ch(c.g), b: ch(c.b), a: finite(c.a, 1, 0, 1) };
}

export function clampBox(b: Box | undefined): Box {
  const W = LOGICAL_WIDTH * IMPORT_LIMITS.boxSpan;
  const H = LOGICAL_HEIGHT * IMPORT_LIMITS.boxSpan;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const rot = finite(b?.rotation, 0) % 360;
  return {
    x: r2(finite(b?.x, 0, -W, W)),
    y: r2(finite(b?.y, 0, -H, H)),
    w: r2(finite(b?.w, LOGICAL_WIDTH, 0, 2 * W)),
    h: r2(finite(b?.h, LOGICAL_HEIGHT, 0, 2 * H)),
    rotation: Object.is(rot, -0) ? 0 : rot,
  };
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

export function clampStyle(s: TextStyle): TextStyle {
  const out: TextStyle = {
    ...s,
    fontFamily: clipText(s.fontFamily, IMPORT_LIMITS.fontFamily) || 'Inter',
    fontWeight: WEIGHTS.includes(s.fontWeight)
      ? s.fontWeight
      : Math.round(finite(s.fontWeight, 400, 100, 900) / 100) * 100,
    fontSizePx: finite(s.fontSizePx, 64, IMPORT_LIMITS.fontSizeMin, IMPORT_LIMITS.fontSizeMax),
    color: clampColor(s.color),
    lineHeight: finite(s.lineHeight, 1.2, 0.5, 5),
    letterSpacing: finite(s.letterSpacing, 0, -100, 100),
    padding: finite(s.padding, 0, 0, 500),
  };
  if (s.outline)
    out.outline = { width: finite(s.outline.width, 0, 0, 100), color: clampColor(s.outline.color) };
  else delete out.outline;
  if (s.shadow)
    out.shadow = {
      dx: finite(s.shadow.dx, 0, -500, 500),
      dy: finite(s.shadow.dy, 0, -500, 500),
      blur: finite(s.shadow.blur, 0, 0, 500),
      color: clampColor(s.shadow.color),
    };
  else delete out.shadow;
  if (s.fill) out.fill = { color: clampColor(s.fill.color), radius: finite(s.fill.radius, 0, 0, 1000) };
  else delete out.fill;
  // Rich-text fields (design/27 §3): bounded when present. Enums are left to the schema's .catch.
  if (s.insets) {
    const side = (v: unknown) => finite(v, 0, 0, 500);
    out.insets = { l: side(s.insets.l), t: side(s.insets.t), r: side(s.insets.r), b: side(s.insets.b) };
  }
  if (s.fitScale)
    out.fitScale = {
      font: finite(s.fitScale.font, 1, 0.01, 1),
      spacing: finite(s.fitScale.spacing, 1, 0, 1),
    };
  if (s.lang !== undefined) out.lang = clipText(s.lang, 35);
  if (s.fallbackFonts)
    out.fallbackFonts = s.fallbackFonts
      .slice(0, IMPORT_LIMITS.fallbackFonts)
      .map((f) => clipText(f, IMPORT_LIMITS.fontFamily))
      .filter((f) => f.trim() !== '');
  if (s.glow) out.glow = { radius: finite(s.glow.radius, 0, 0, 500), color: clampColor(s.glow.color) };
  if (s.paint) {
    const paint = sanitizeGradient(s.paint);
    if (paint) out.paint = paint;
    else delete out.paint;
  }
  if (s.lineMask) {
    const lineMask = sanitizeLineMask(s.lineMask);
    if (lineMask) out.lineMask = lineMask;
    else delete out.lineMask;
  }
  return out;
}

/**
 * A ProPresenter line-fill mask within the schema's bounds: style default 'fullWidth', offsets bounded,
 * fill and gradient clamped, undefined when neither fill nor gradient is left.
 */
export function sanitizeLineMask(lm: TextLineMask | undefined): TextLineMask | undefined {
  if (!lm || typeof lm !== 'object') return undefined;
  const fill = lm.fill ? clampColor(lm.fill) : undefined;
  const gradient = lm.gradient ? sanitizeGradient(lm.gradient) : undefined;
  if (!fill && !gradient) return undefined;
  const style =
    lm.style === 'lineWidth' || lm.style === 'maxLineWidth' || lm.style === 'fullWidth'
      ? lm.style
      : 'fullWidth';
  const out: TextLineMask = { style };
  if (fill) out.fill = fill;
  if (gradient) out.gradient = gradient;
  if (lm.heightOffsetPx !== undefined) out.heightOffsetPx = finite(lm.heightOffsetPx, 0, -2000, 2000);
  if (lm.vOffsetPx !== undefined) out.vOffsetPx = finite(lm.vOffsetPx, 0, -2000, 2000);
  if (lm.widthOffsetPx !== undefined) out.widthOffsetPx = finite(lm.widthOffsetPx, 0, -4000, 4000);
  if (lm.hOffsetPx !== undefined) out.hOffsetPx = finite(lm.hOffsetPx, 0, -4000, 4000);
  return out;
}

/**
 * A gradient within the schema's bounds (design/27 §3.1): at most 16 stops sorted by position, each within
 * 0..1, the angle and centre bounded. Undefined with fewer than two stops (the solid colour beside it stays).
 * The kind is left to the schema's .catch.
 */
export function sanitizeGradient(g: Gradient): Gradient | undefined {
  if (!g || !Array.isArray(g.stops)) return undefined;
  const stops = g.stops
    .filter((st) => st && typeof st === 'object')
    .slice(0, 16)
    .map((st) => ({ at: finite(st.at, 0, 0, 1), color: clampColor(st.color) }))
    .sort((a, b) => a.at - b.at);
  if (stops.length < 2) return undefined;
  const out: Gradient = { ...g, stops };
  if (g.angle !== undefined) out.angle = finite(g.angle, 0, -36_000, 36_000);
  if (g.center) out.center = { x: finite(g.center.x, 0.5, -1, 1), y: finite(g.center.y, 0.5, -1, 1) };
  return out;
}

/**
 * A stored geometry within the schema's bounds (design/27 §3.1, §12): the preset name cut to 40, at most 10
 * finite adjust pairs (`adj` within ±1e7, M9's `adjWide` within ±21,600,000), at most 8 paths, each
 * re-tokenised to M L Q C Z and numbers (`cleanPathData`, at most 4,096 points) and dropped when nothing is
 * left of it, `cont` kept only when true, `ref` (a geometry file, M6 round 2) kept when it is a string of
 * 1-100 characters without control characters. Undefined when neither a preset, a path nor a ref is left.
 */
export function sanitizeGeom(g: ShapeGeom): ShapeGeom | undefined {
  if (!g || typeof g !== 'object') return undefined;
  const out: ShapeGeom = {};
  if (typeof g.preset === 'string' && g.preset) out.preset = clipText(g.preset, 40);
  const pairs = (list: unknown, max: number) =>
    (Array.isArray(list) ? list : [])
      .filter((p) => Array.isArray(p) && typeof p[0] === 'string' && Number.isFinite(p[1]))
      .slice(0, 10)
      .map(([n, v]): [string, number] => [clipText(n, 16), finite(v, 0, -max, max)]);
  if (Array.isArray(g.adj)) {
    const adj = pairs(g.adj, 1e7);
    if (adj.length) out.adj = adj;
  }
  if (Array.isArray(g.adjWide)) {
    const adjWide = pairs(g.adjWide, 21_600_000);
    if (adjWide.length) out.adjWide = adjWide;
  }
  if (Array.isArray(g.paths)) {
    const paths: NonNullable<ShapeGeom['paths']> = [];
    for (const p of g.paths) {
      if (paths.length >= PATH_DATA_LIMITS.paths) break;
      if (!p || typeof p !== 'object') continue;
      const d = cleanPathData(p.d);
      if (!d) continue;
      const { cont, ...rest } = p;
      paths.push({
        ...rest,
        d,
        w: finite(p.w, 0, 0, PATH_DATA_LIMITS.coord),
        h: finite(p.h, 0, 0, PATH_DATA_LIMITS.coord),
        ...(cont === true ? { cont: true } : {}),
      });
    }
    if (paths.length) out.paths = paths;
  }
  const ref = geomRef(g.ref);
  if (ref) out.ref = ref;
  return out.preset || out.paths || out.ref ? out : undefined;
}

/** A geometry file's name as stored (`ShapeGeom.ref`): 1-100 printable characters, else undefined. */
function geomRef(v: unknown): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  return typeof v === 'string' && v.length >= 1 && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v)
    ? v
    : undefined;
}

type ShapeObj = Extract<SlideObject, { type: 'shape' }>;

/**
 * A shape's M6 fields within the schema's bounds (design/27 §3.1); enums (`dash`, `lineJoin`, `lineCap`,
 * arrowheads) are left to the schema's .catch, and defaults are dropped.
 */
function sanitizeShape(o: ShapeObj): ShapeObj {
  const out: ShapeObj = { ...o };
  if (o.geom) {
    const geom = sanitizeGeom(o.geom);
    if (geom) out.geom = geom;
    else delete out.geom;
  }
  if (o.gradient) {
    const gradient = sanitizeGradient(o.gradient);
    if (gradient) out.gradient = gradient;
    else delete out.gradient;
  }
  if (o.shadow)
    out.shadow = {
      dx: finite(o.shadow.dx, 0, -500, 500),
      dy: finite(o.shadow.dy, 0, -500, 500),
      blur: finite(o.shadow.blur, 0, 0, 500),
      color: clampColor(o.shadow.color),
    };
  if (o.glow) out.glow = { radius: finite(o.glow.radius, 0, 0, 500), color: clampColor(o.glow.color) };
  if (o.softEdge !== undefined) out.softEdge = finite(o.softEdge, 0, 0, 500);
  if (out.lineJoin === 'miter') delete out.lineJoin;
  if (out.lineCap === 'flat') delete out.lineCap;
  // M9: what the shape draws instead of its geometry, and its 3-D look (sanitize/*.ts).
  keep(out, 'table', o.table, sanitizeTable);
  keep(out, 'chart', o.chart, sanitizeChart);
  keep(out, 'decor', o.decor, sanitizeDecor);
  keep(out, 'look3d', o.look3d, sanitizeLook3d);
  return out;
}

/** `out[k]` = `f(v)` when `v` is present and something is left of it, else no `k`. */
function keep<T extends object, K extends keyof T, V>(
  out: T,
  k: K,
  v: V | undefined,
  f: (v: V) => T[K] | undefined,
): void {
  if (v === undefined) return;
  const x = f(v);
  if (x === undefined) delete out[k];
  else out[k] = x;
}

/** A vector picture's families (`ImageObject.vectorFonts`, M9): at most 8, cleaned as run families, once each. */
function vectorFonts(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const budget = fontBudget();
  const out: string[] = [];
  for (const f of list.slice(0, 8)) {
    const name = typeof f === 'string' ? budget.family(clipText(f, IMPORT_LIMITS.fontFamily)) : '';
    if (name && !out.includes(name)) out.push(name);
  }
  return out.length ? out : undefined;
}

type TextObj = Extract<SlideObject, { type: 'text' }>;

/** A text object's M9 looks (sanitize/*.ts): its warp, vertical writing, centred block and 3-D look. */
function sanitizeTextLooks(o: TextObj, out: TextObj): TextObj {
  keep(out, 'warp', o.warp, sanitizeWarp);
  keep(out, 'writing', o.writing, sanitizeWriting);
  keep(out, 'centerBlock', o.centerBlock, sanitizeCenterBlock);
  keep(out, 'look3d', o.look3d, sanitizeLook3d);
  return out;
}

/**
 * Cut style runs to a text of `len` UTF-16 units, as the text was cut: a run whose start is at or past the
 * cut is dropped and its end is clamped. Runs that are empty, unsorted or overlap an earlier run are dropped
 * too, and numbers are bounded: `sizeScale` keeps the run's size (`fontSizePx` × it) within the import's
 * font size limits, and families and size scales stay within the object's `FontBudget`.
 */
export function cutRuns(
  runs: readonly TextRun[],
  len: number,
  fontSizePx = 64,
  budget: FontBudget = fontBudget(),
): TextRun[] {
  const fs = finite(fontSizePx, 64, IMPORT_LIMITS.fontSizeMin, IMPORT_LIMITS.fontSizeMax);
  const minScale = Math.max(0.01, IMPORT_LIMITS.runFontSizeMin / fs);
  const maxScale = Math.min(50, IMPORT_LIMITS.fontSizeMax / fs);
  const out: TextRun[] = [];
  let at = 0;
  for (const r of runs) {
    if (out.length >= IMPORT_LIMITS.runs) break;
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) continue;
    if (r.start < at || r.start >= len || r.end <= r.start) continue;
    const run: TextRun = { ...r, end: Math.min(r.end, len) };
    if (r.fontFamily !== undefined) {
      const family = budget.family(clipText(r.fontFamily, IMPORT_LIMITS.fontFamily));
      if (family) run.fontFamily = family;
      else delete run.fontFamily;
    }
    if (r.fontWeight !== undefined) run.fontWeight = finite(r.fontWeight, 400, 100, 900);
    if (r.sizeScale !== undefined) run.sizeScale = budget.scale(finite(r.sizeScale, 1, minScale, maxScale));
    if (r.color) run.color = clampColor(r.color);
    if (r.highlight) run.highlight = clampColor(r.highlight);
    if (r.baseline !== undefined) run.baseline = finite(r.baseline, 0, -1, 1);
    if (r.letterSpacing !== undefined) run.letterSpacing = finite(r.letterSpacing, 0, -100, 100);
    if (r.outline)
      run.outline = { width: finite(r.outline.width, 0, 0, 100), color: clampColor(r.outline.color) };
    if (r.shadow)
      run.shadow = {
        dx: finite(r.shadow.dx, 0, -500, 500),
        dy: finite(r.shadow.dy, 0, -500, 500),
        blur: finite(r.shadow.blur, 0, 0, 500),
        color: clampColor(r.shadow.color),
      };
    if (r.lang !== undefined) run.lang = clipText(r.lang, 35);
    out.push(run);
    at = run.end;
  }
  return out;
}

/**
 * Paragraph styles for `text`: at most one per paragraph (extra ones are dropped), numbers bounded, bullet
 * families within the object's `FontBudget`.
 */
export function cutParas(
  paras: readonly (TextPara | null)[],
  text: string,
  budget: FontBudget = fontBudget(),
): (TextPara | null)[] {
  let count = 1;
  for (let i = text.indexOf('\n'); i >= 0 && count < IMPORT_LIMITS.paras; i = text.indexOf('\n', i + 1))
    count++;
  return paras.slice(0, Math.min(count, IMPORT_LIMITS.paras)).map((p) => {
    if (!p) return null;
    const out: TextPara = { ...p };
    const indent = (v: unknown) => finite(v, 0, -LOGICAL_WIDTH, LOGICAL_WIDTH);
    const space = (v: unknown) => finite(v, 0, 0, LOGICAL_WIDTH);
    if (p.level !== undefined) out.level = Math.round(finite(p.level, 0, 0, 8));
    if (p.indentPx !== undefined) out.indentPx = indent(p.indentPx);
    if (p.firstLinePx !== undefined) out.firstLinePx = indent(p.firstLinePx);
    if (p.spaceBeforePx !== undefined) out.spaceBeforePx = space(p.spaceBeforePx);
    if (p.spaceAfterPx !== undefined) out.spaceAfterPx = space(p.spaceAfterPx);
    if (p.lineSpacing !== undefined) out.lineSpacing = finite(p.lineSpacing, 1, 0, 13.2);
    if (p.lineSpacingPx !== undefined) out.lineSpacingPx = space(p.lineSpacingPx);
    if (p.bullet) {
      const b = { ...p.bullet };
      if (b.char !== undefined) {
        b.char = clipText(b.char, 8);
        if (!b.char) delete b.char;
      }
      if (b.auto !== undefined) b.auto = clipText(b.auto, 40);
      if (b.startAt !== undefined) b.startAt = Math.round(finite(b.startAt, 1, 1, 32_767));
      if (b.fontFamily !== undefined) {
        const family = budget.family(clipText(b.fontFamily, IMPORT_LIMITS.fontFamily));
        if (family) b.fontFamily = family;
        else delete b.fontFamily;
      }
      if (b.color) b.color = clampColor(b.color);
      if (b.sizePct !== undefined) b.sizePct = finite(b.sizePct, 1, 0.1, 4);
      out.bullet = b;
    }
    return out;
  });
}

/** Cut a text object's text to `max` UTF-16 units, with its runs and paragraph styles. */
export function cutText(o: TextObject, max: number): TextObject {
  const text = clipText(o.text, max);
  const out: TextObject = { ...o, text };
  const budget = fontBudget();
  if (o.runs) out.runs = cutRuns(o.runs, text.length, o.style.fontSizePx, budget);
  if (o.paras) out.paras = cutParas(o.paras, text, budget);
  return out;
}

function clampObject(o: SlideObject): SlideObject {
  const box = clampBox(o.box);
  const opacity = finite(o.opacity, 1, 0, 1);
  if (o.type === 'text')
    return sanitizeTextLooks(o, {
      ...cutText({ ...o, style: clampStyle(o.style) }, IMPORT_LIMITS.text),
      box,
      opacity,
    });
  if (o.type === 'image') {
    const out = { ...o, box, opacity, radius: finite(o.radius, 0, 0, 1000) };
    if (o.crop && typeof o.crop === 'object') {
      const c = o.crop;
      out.crop = {
        l: finite(c.l, 0, -1, 1),
        t: finite(c.t, 0, -1, 1),
        r: finite(c.r, 0, -1, 1),
        b: finite(c.b, 0, -1, 1),
      };
    } else delete out.crop;
    if (o.mask) {
      const mask = sanitizeGeom(o.mask);
      if (mask) out.mask = mask;
      else delete out.mask;
    }
    if (o.shadow)
      out.shadow = {
        dx: finite(o.shadow.dx, 0, -500, 500),
        dy: finite(o.shadow.dy, 0, -500, 500),
        blur: finite(o.shadow.blur, 0, 0, 500),
        color: clampColor(o.shadow.color),
      };
    else delete out.shadow;
    if (o.softEdge !== undefined) {
      const se = finite(o.softEdge, 0, 0, 500);
      if (se > 0) out.softEdge = se;
      else delete out.softEdge;
    }
    keep(out, 'look3d', o.look3d, sanitizeLook3d);
    keep(out, 'vectorFonts', o.vectorFonts, vectorFonts);
    return out;
  }
  return { ...sanitizeShape(o), box, opacity, radius: finite(o.radius, 0, 0, 1000) };
}

/** Bound every field of an imported presentation in place and return it. */
export function sanitizePresentation(p: Presentation): Presentation {
  p.title = clipText(p.title, IMPORT_LIMITS.title).trim() || 'Untitled';
  const m = p.meta;
  for (const k of ['author', 'ccli', 'copyright', 'key'] as const) {
    if (m[k] !== undefined) m[k] = clipText(m[k], IMPORT_LIMITS.meta);
  }
  if (m.tempo !== undefined && !(Number.isFinite(m.tempo) && m.tempo > 0)) delete m.tempo;
  m.tags = m.tags.slice(0, 50).map((t) => clipText(t, IMPORT_LIMITS.label));
  for (const sec of p.sections) {
    sec.label = clipText(sec.label, IMPORT_LIMITS.label).trim() || 'Slides';
    sec.short = clipText(sec.short, IMPORT_LIMITS.short) || sec.label.slice(0, 1).toUpperCase();
    for (const sl of sec.slides) {
      sl.objects = sl.objects.map(clampObject);
      sanitizeSlideMedia(sl);
      if (sl.notes !== undefined) sl.notes = clipText(sl.notes, IMPORT_LIMITS.notes);
      if (sl.durationMs !== undefined) {
        if (Number.isFinite(sl.durationMs) && sl.durationMs > 0)
          sl.durationMs = Math.round(
            finite(
              sl.durationMs,
              IMPORT_LIMITS.durationMinMs,
              IMPORT_LIMITS.durationMinMs,
              IMPORT_LIMITS.durationMaxMs,
            ),
          );
        else delete sl.durationMs;
      }
      sanitizePptxSlide(sl);
    }
  }
  const ids = new Set(p.sections.map((s) => s.id));
  for (const a of p.arrangements) {
    a.name = clipText(a.name, IMPORT_LIMITS.name) || 'Arrangement';
    a.sectionIds = a.sectionIds.filter((id) => ids.has(id));
  }
  if (p.source?.native) p.source.native = sanitizeNativeSource(p.source.native);
  return p;
}

type PptxSlide = Presentation['sections'][number]['slides'][number];
type NativeSource = NonNullable<NonNullable<Presentation['source']>['native']>;

const int = (v: unknown, def: number, lo: number, hi: number) => Math.round(finite(v, def, lo, hi));
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** A deck-derived line (a note): control characters and line breaks become spaces, cut to `max`. */
const oneLine = (s: unknown, max: number) =>
  clipText((typeof s === 'string' ? s.slice(0, 4 * max) : '').replace(CONTROL, ' ').trim(), max);

/**
 * Bound a slide's PowerPoint fields in place (design/27 §3.1, §12): the provenance record (`pptx`), the
 * hidden flag, the slide transition and `imported.textAligned`. Unknown enum values become the defaults, as
 * the schema's `.catch` does.
 */
function sanitizePptxSlide(sl: PptxSlide): void {
  if (sl.hidden !== undefined && sl.hidden !== true) delete sl.hidden;
  if (sl.transition) {
    const t = sl.transition;
    if (t.kind === 'crossfade') sl.transition = { kind: 'crossfade', ms: int(t.ms, 700, 0, 10_000) };
    else if (t.kind === 'cut') sl.transition = { kind: 'cut' };
    else delete sl.transition;
  }
  if (sl.imported && sl.imported.textAligned !== undefined && sl.imported.textAligned !== true)
    delete sl.imported.textAligned;
  const x = sl.pptx;
  if (!x) return;
  const out: NonNullable<PptxSlide['pptx']> = {
    fileId: clipText(x.fileId, IMPORT_LIMITS.name),
    index: int(x.index, 0, 0, 100_000),
    class: x.class === 'hybrid' || x.class === 'picture' ? x.class : 'native',
    version: int(x.version, 1, 1, 1_000_000),
  };
  if (x.shown !== undefined) out.shown = int(x.shown, 0, 0, 100_000);
  if (x.digest !== undefined) out.digest = clipText(x.digest, 100);
  if (x.pending === true) out.pending = true;
  if (Array.isArray(x.notes)) {
    const notes = x.notes
      .slice(0, 16)
      .map((n) => oneLine(n, 200))
      .filter(Boolean);
    if (notes.length) out.notes = notes;
  }
  if (x.artText) out.artText = clipText(x.artText, IMPORT_LIMITS.text);
  if (x.refMediaId) out.refMediaId = clipText(x.refMediaId, IMPORT_LIMITS.name);
  if (x.show !== undefined) out.show = x.show === 'picture' ? 'picture' : 'objects';
  if (Array.isArray(x.missing)) {
    // M9: what nothing draws, '<kind>' or '<kind>:<subtype>' (MISSING_KINDS), once each.
    const missing: string[] = [];
    for (const m of x.missing.slice(0, 4 * MISSING_LIMITS.entries)) {
      const entry = oneLine(m, MISSING_LIMITS.chars);
      if (entry && !missing.includes(entry)) missing.push(entry);
      if (missing.length >= MISSING_LIMITS.entries) break;
    }
    if (missing.length) out.missing = missing;
  }
  sl.pptx = out;
}

/** Bound `Presentation.source.native` (counts and the deck's area in the 1920x1080 frame). */
function sanitizeNativeSource(n: NativeSource): NativeSource {
  const count = (v: unknown) => int(v, 0, 0, 100_000);
  const out: NativeSource = {
    version: int(n.version, 1, 1, 1_000_000),
    slides: count(n.slides),
    native: count(n.native),
    hybrid: count(n.hybrid),
    picture: count(n.picture),
  };
  if (n.slideRect) {
    const W = LOGICAL_WIDTH * IMPORT_LIMITS.boxSpan;
    const H = LOGICAL_HEIGHT * IMPORT_LIMITS.boxSpan;
    out.slideRect = {
      x: finite(n.slideRect.x, 0, -W, W),
      y: finite(n.slideRect.y, 0, -H, H),
      w: finite(n.slideRect.w, LOGICAL_WIDTH, 0, 2 * W),
      h: finite(n.slideRect.h, LOGICAL_HEIGHT, 0, 2 * H),
    };
  }
  return out;
}

/** Bound a text box extracted from a PowerPoint slide. */
export function sanitizeExtracted(t: ExtractedText): ExtractedText {
  const out: ExtractedText = { text: clipText(t.text, IMPORT_LIMITS.text), box: clampBox(t.box) };
  if (t.fontSizePx !== undefined && Number.isFinite(t.fontSizePx) && t.fontSizePx > 0)
    out.fontSizePx = finite(t.fontSizePx, 64, IMPORT_LIMITS.fontSizeMin, IMPORT_LIMITS.fontSizeMax);
  return out;
}

type ImportedSlide = Presentation['sections'][number]['slides'][number];

/**
 * Bound a slide's media in place (design/27 §3.1): the `play` of its image objects and its `audio`. Unknown
 * enum values are left to the schema's `.catch`; numbers are brought within the schema's bounds.
 */
function sanitizeSlideMedia(sl: ImportedSlide): void {
  for (const o of sl.objects) {
    if (o.type !== 'image' || !o.play) continue;
    o.play = { ...o.play, mediaId: clipText(o.play.mediaId, IMPORT_LIMITS.name) };
    if (o.play.gainDb !== undefined) o.play.gainDb = finite(o.play.gainDb, 0, -100, 100);
  }
  if (sl.audio) {
    const a = { ...sl.audio, mediaId: clipText(sl.audio.mediaId, IMPORT_LIMITS.name) };
    if (a.gainDb !== undefined) a.gainDb = finite(a.gainDb, 0, -100, 100);
    if (a.slides !== undefined) a.slides = Math.round(finite(a.slides, 1, 1, 999));
    sl.audio = a;
  }
}
