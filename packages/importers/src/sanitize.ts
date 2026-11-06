/**
 * Clamp what an importer produces to the bounds the editor and the render plan accept (design/25: "the
 * importer cannot write anything the editor could not"). Decoded files carry whatever their authors or a
 * corrupted byte wrote: NaN or infinite doubles, megabyte strings, negative sizes. Everything numeric is made
 * finite and bounded here; strings are cut; nothing is thrown.
 */
import {
  type Box,
  type ExtractedText,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Presentation,
  type Rgba,
  type SlideObject,
  type TextObject,
  type TextPara,
  type TextRun,
  type TextStyle,
} from '@ordo/domain';

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
 * The distinct fonts one text object may name, shared by its runs and bullets (the render plan's
 * `FontBudget`): families past `runFamilies` are dropped (the box's or the first run's is used), size scales
 * past `sizeScales` take the nearest one kept. Each new family or size costs a drawer a font lookup.
 */
export type FontBudget = { family(f: string): string; scale(s: number): number };

export function fontBudget(): FontBudget {
  const families = new Set<string>();
  const scales = new Set<number>();
  return {
    family(f) {
      const k = f.trim().toLowerCase();
      if (!k || families.has(k)) return f;
      if (families.size >= IMPORT_LIMITS.runFamilies) return '';
      families.add(k);
      return f;
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
  const minScale = Math.max(0.01, IMPORT_LIMITS.fontSizeMin / fs);
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
    return { ...cutText({ ...o, style: clampStyle(o.style) }, IMPORT_LIMITS.text), box, opacity };
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
    return out;
  }
  return { ...o, box, opacity, radius: finite(o.radius, 0, 0, 1000) };
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
    }
  }
  const ids = new Set(p.sections.map((s) => s.id));
  for (const a of p.arrangements) {
    a.name = clipText(a.name, IMPORT_LIMITS.name) || 'Arrangement';
    a.sectionIds = a.sectionIds.filter((id) => ids.has(id));
  }
  return p;
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
