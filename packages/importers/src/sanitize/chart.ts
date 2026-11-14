import {
  CHART_LIMITS,
  type ChartAxis,
  type ChartBox,
  type ChartData,
  type ChartFill,
  type ChartGroup,
  type ChartLabels,
  type ChartLine,
  type ChartMarker,
  type ChartPoint,
  type ChartSeries,
  type ChartText,
  type ChartTitle,
  type TextRun,
} from '@ordo/domain';
import {
  type FontBudget,
  IMPORT_LIMITS,
  clampColor,
  clipText,
  cutParas,
  cutRuns,
  finite,
  fontBudget,
  sanitizeGradient,
} from '../sanitize.ts';

/*
 * `ShapeObject.chart` of an imported shape (design/27 M9) within the schema's bounds: every string cut
 * (names, categories and labels 255, titles 1,000 with their runs and paragraph styles, format codes 64),
 * every array bounded (`CHART_LIMITS`), values finite or null (no point), other numbers finite and within the
 * schema's ranges, palette indices naming an entry that exists. Enums are left to the schema's .catch. One
 * `FontBudget` serves the whole chart. Undefined when no group with a series or no text style is left.
 */

/** The schema's finite range of values and axis numbers. */
const BIG = 1e300;

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

/** Lengths of the chart's palettes, for its indices. */
type Palettes = { fills: number; lines: number; texts: number; fmts: number };

/** `o[k]`, when present, bounded to lo..hi (a non-finite value becomes `dflt`). */
function bound<T extends object>(o: T, k: keyof T, lo: number, hi: number, dflt: number): void {
  const v = o[k];
  if (v === undefined) return;
  (o as Record<keyof T, unknown>)[k] = finite(v, dflt, lo, hi);
}

/** `o[k]`, when present, kept as an index below `n`, else removed. */
function ix<T extends object>(o: T, k: keyof T, n: number): void {
  if (o[k] === undefined) return;
  const v = int(o[k], 0, n - 1);
  if (v === undefined) delete o[k];
  else (o as Record<keyof T, unknown>)[k] = v;
}

/** `o[k]` removed unless it is a finite number within ±1e300. */
function finiteOnly<T extends object>(o: T, k: keyof T): void {
  const v = o[k];
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > BIG) delete o[k];
}

const points = (v: unknown): (number | null)[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, CHART_LIMITS.points)
    .map((x) => (typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= BIG ? x : null));

function box(b: ChartBox | undefined, n: Palettes): ChartBox | undefined {
  if (!isObj(b)) return undefined;
  const out: ChartBox = { ...b };
  ix(out, 'fill', n.fills);
  ix(out, 'line', n.lines);
  return out;
}

function labels(l: ChartLabels | undefined, n: Palettes): ChartLabels | undefined {
  if (!isObj(l)) return undefined;
  const out: ChartLabels = { ...l, show: (Array.isArray(l.show) ? l.show : []).slice(0, 5) };
  if (l.sep !== undefined) out.sep = clipText(l.sep, 16);
  if (l.key !== undefined && typeof l.key !== 'boolean') delete out.key;
  ix(out, 'fmt', n.fmts);
  ix(out, 'text', n.texts);
  const b = box(l.box, n);
  if (b) out.box = b;
  else delete out.box;
  return out;
}

function marker(m: ChartMarker | undefined, n: Palettes): ChartMarker | undefined {
  if (!isObj(m)) return undefined;
  const out: ChartMarker = { ...m, size: Math.round(finite(m.size, 5, 2, 72)) };
  ix(out, 'fill', n.fills);
  ix(out, 'line', n.lines);
  return out;
}

function title(t: ChartTitle | undefined, n: Palettes, budget: FontBudget): ChartTitle | undefined {
  if (!isObj(t)) return undefined;
  const text = clipText(t.text, CHART_LIMITS.title);
  const out: ChartTitle = { ...t, text, style: int(t.style, 0, n.texts - 1) ?? 0 };
  if (Array.isArray(t.runs)) {
    // Entries that are not runs (null from a hostile deck or store) are dropped first: `cutRuns` reads each.
    const runs = cutRuns(t.runs.filter(isObj) as unknown as TextRun[], text.length, 64, budget).slice(0, 64);
    if (runs.length) out.runs = runs;
    else delete out.runs;
  }
  if (Array.isArray(t.paras)) {
    const paras = cutParas(t.paras.slice(0, 16), text, budget);
    if (paras.length) out.paras = paras;
    else delete out.paras;
  }
  const b = box(t.box, n);
  if (b) out.box = b;
  else delete out.box;
  if (t.at !== undefined)
    out.at = isObj(t.at) ? { x: finite(t.at.x, 0, -1, 2), y: finite(t.at.y, 0, -1, 2) } : undefined;
  if (out.at === undefined) delete out.at;
  return out;
}

function text(t: ChartText, budget: FontBudget): ChartText {
  const out: ChartText = {
    ...t,
    fontFamily: budget.family(clipText(t.fontFamily, IMPORT_LIMITS.fontFamily)) || 'Calibri',
    fontSizePx: finite(t.fontSizePx, 24, 1, 1_000),
    color: clampColor(t.color),
  };
  bound(out, 'fontWeight', 0, 1000, 400);
  bound(out, 'rot', -90, 90, 0);
  if (t.lang !== undefined) out.lang = clipText(t.lang, 35);
  if (t.fallbackFonts !== undefined)
    out.fallbackFonts = (Array.isArray(t.fallbackFonts) ? t.fallbackFonts : [])
      .slice(0, IMPORT_LIMITS.fallbackFonts)
      .map((f) => clipText(f, IMPORT_LIMITS.fontFamily))
      .filter((f) => f.trim() !== '');
  return out;
}

function fill(f: ChartFill): ChartFill {
  const out: ChartFill = { ...f, color: clampColor(f.color) };
  if (f.gradient) {
    const g = sanitizeGradient(f.gradient);
    if (g) out.gradient = g;
    else delete out.gradient;
  }
  return out;
}

function line(l: ChartLine): ChartLine {
  return { ...l, width: finite(l.width, 1, 0, 500), color: clampColor(l.color) };
}

function point(p: unknown, n: Palettes): ChartPoint | undefined {
  if (!Array.isArray(p) || p.length !== 2 || !isObj(p[1])) return undefined;
  const i = int(p[0], 0, CHART_LIMITS.points - 1);
  if (i === undefined) return undefined;
  const f = { ...(p[1] as ChartPoint[1]) };
  ix(f, 'fill', n.fills);
  ix(f, 'line', n.lines);
  bound(f, 'explode', 0, 4, 0);
  if (f.marker !== undefined) {
    const m = marker(f.marker, n);
    if (m) f.marker = m;
    else delete f.marker;
  }
  if (f.labels !== undefined && f.labels !== null) {
    const l = labels(f.labels, n);
    if (l) f.labels = l;
    else delete f.labels;
  }
  return [i, f];
}

function series(s: ChartSeries, n: Palettes): ChartSeries {
  const out: ChartSeries = { ...s, values: points(s.values) };
  if (s.name !== undefined) out.name = clipText(s.name, CHART_LIMITS.label);
  if (s.x !== undefined) out.x = points(s.x);
  if (s.size !== undefined) out.size = points(s.size);
  ix(out, 'fill', n.fills);
  ix(out, 'line', n.lines);
  ix(out, 'fmt', n.fmts);
  bound(out, 'explode', 0, 4, 0);
  if (s.set !== undefined) out.set = s.set === 1 ? 1 : 0;
  if (s.marker !== undefined) {
    const m = marker(s.marker, n);
    if (m) out.marker = m;
    else delete out.marker;
  }
  if (s.labels !== undefined) {
    const l = labels(s.labels, n);
    if (l) out.labels = l;
    else delete out.labels;
  }
  if (s.points !== undefined) {
    const kept: ChartPoint[] = [];
    for (const p of Array.isArray(s.points) ? s.points : []) {
      if (kept.length >= CHART_LIMITS.overrides) break;
      const q = point(p, n);
      if (q) kept.push(q);
    }
    out.points = kept;
  }
  return out;
}

function group(g: ChartGroup, n: Palettes): ChartGroup {
  const out: ChartGroup = {
    ...g,
    series: (Array.isArray(g.series) ? g.series : [])
      .filter(isObj)
      .slice(0, CHART_LIMITS.series)
      .map((s) => series(s as ChartSeries, n)),
  };
  bound(out, 'gap', 0, 500, 150);
  bound(out, 'overlap', -100, 100, 0);
  bound(out, 'hole', 0, 90, 50);
  bound(out, 'firstAngle', 0, 360, 0);
  bound(out, 'depth', 0, 2, 0);
  if (g.extras !== undefined) out.extras = (Array.isArray(g.extras) ? g.extras : []).slice(0, 3);
  if (g.labels !== undefined) {
    const l = labels(g.labels, n);
    if (l) out.labels = l;
    else delete out.labels;
  }
  return out;
}

function axis(a: ChartAxis, n: Palettes, budget: FontBudget): ChartAxis {
  const out: ChartAxis = { ...a };
  if (a.set !== undefined) out.set = a.set === 1 ? 1 : 0;
  for (const k of ['min', 'max', 'major', 'minor', 'crossesAt', 'units'] as const) finiteOnly(out, k);
  bound(out, 'log', 2, 1000, 10);
  if (a.skip !== undefined) out.skip = Math.round(finite(a.skip, 1, 1, 1000));
  ix(out, 'grid', n.lines);
  ix(out, 'minorGrid', n.lines);
  ix(out, 'line', n.lines);
  ix(out, 'text', n.texts);
  ix(out, 'fmt', n.fmts);
  if (a.title !== undefined) {
    const t = title(a.title, n, budget);
    if (t) out.title = t;
    else delete out.title;
  }
  return out;
}

const at = (v: unknown) => finite(v, 0, -1, 2);

export function sanitizeChart(c: ChartData): ChartData | undefined {
  if (!isObj(c)) return undefined;
  const budget = fontBudget();
  const texts = (Array.isArray(c.texts) ? c.texts : [])
    .filter(isObj)
    .slice(0, CHART_LIMITS.texts)
    .map((t) => text(t as ChartText, budget));
  if (!texts.length) return undefined;
  const fills = (Array.isArray(c.fills) ? c.fills : []).filter(isObj).slice(0, CHART_LIMITS.fills);
  const lines = (Array.isArray(c.lines) ? c.lines : []).filter(isObj).slice(0, CHART_LIMITS.lines);
  const fmts = Array.isArray(c.fmts)
    ? c.fmts.slice(0, CHART_LIMITS.fmts).map((f) => clipText(f, 64))
    : undefined;
  const n: Palettes = {
    fills: fills.length,
    lines: lines.length,
    texts: texts.length,
    fmts: fmts?.length ?? 0,
  };
  const groups = (Array.isArray(c.groups) ? c.groups : [])
    .filter(isObj)
    .slice(0, CHART_LIMITS.groups)
    .map((g) => group(g as ChartGroup, n))
    .filter((g) => g.series.length > 0);
  if (!groups.length) return undefined;
  const out: ChartData = {
    ...c,
    unit: finite(c.unit, 2, 0.01, 100),
    groups,
    texts,
    fills: fills.map((f) => fill(f as ChartFill)),
    lines: lines.map((l) => line(l as ChartLine)),
  };
  if (fmts) out.fmts = fmts;
  if (c.categories !== undefined)
    out.categories = (Array.isArray(c.categories) ? c.categories : [])
      .slice(0, CHART_LIMITS.points)
      .map((s) => clipText(s, CHART_LIMITS.label));
  if (c.outer !== undefined) {
    const outer: [number, string][] = [];
    for (const o of Array.isArray(c.outer) ? c.outer : []) {
      if (outer.length >= CHART_LIMITS.points) break;
      if (!Array.isArray(o) || o.length !== 2) continue;
      const i = int(o[0], 0, CHART_LIMITS.points - 1);
      if (i !== undefined) outer.push([i, clipText(o[1], CHART_LIMITS.label)]);
    }
    out.outer = outer;
  }
  if (c.axes !== undefined)
    out.axes = (Array.isArray(c.axes) ? c.axes : [])
      .filter(isObj)
      .slice(0, CHART_LIMITS.axes)
      .map((a) => axis(a as ChartAxis, n, budget));
  if (c.title !== undefined) {
    const t = title(c.title, n, budget);
    if (t) out.title = t;
    else delete out.title;
  }
  if (c.legend !== undefined) {
    if (isObj(c.legend)) {
      const l = { ...c.legend, text: int(c.legend.text, 0, n.texts - 1) ?? 0 };
      const b = box(c.legend.box, n);
      if (b) l.box = b;
      else delete l.box;
      if (l.at !== undefined) {
        if (isObj(l.at)) {
          const p = l.at;
          l.at = { x: at(p.x), y: at(p.y) };
          if (p.w !== undefined) l.at.w = at(p.w);
          if (p.h !== undefined) l.at.h = at(p.h);
        } else delete l.at;
      }
      out.legend = l;
    } else delete out.legend;
  }
  if (c.plot !== undefined) {
    if (isObj(c.plot)) {
      const p = { ...c.plot };
      const b = box(c.plot.box, n);
      if (b) p.box = b;
      else delete p.box;
      if (p.at !== undefined) {
        if (isObj(p.at)) {
          const a = p.at;
          p.at = { x: at(a.x), y: at(a.y), w: at(a.w), h: at(a.h), inner: a.inner === true };
        } else delete p.at;
      }
      out.plot = p;
    } else delete out.plot;
  }
  if (c.area !== undefined) {
    const b = box(c.area, n);
    if (b) out.area = b;
    else delete out.area;
  }
  if (c.lang !== undefined) out.lang = clipText(c.lang, 35);
  return out;
}
