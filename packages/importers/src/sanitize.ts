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
} as const;

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
  return out;
}

function clampObject(o: SlideObject): SlideObject {
  const box = clampBox(o.box);
  const opacity = finite(o.opacity, 1, 0, 1);
  if (o.type === 'text')
    return { ...o, box, opacity, text: clipText(o.text, IMPORT_LIMITS.text), style: clampStyle(o.style) };
  if (o.type === 'image') return { ...o, box, opacity, radius: finite(o.radius, 0, 0, 1000) };
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
