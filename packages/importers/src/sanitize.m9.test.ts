import { describe, expect, it } from 'vitest';
import {
  type ChartData,
  type DecorData,
  Presentation,
  type ShapeObject,
  type Slide,
  type TableData,
  TABLE_LIMITS,
  type TextObject,
} from '@ordo/domain';
import { m9Chart, m9Decor, m9Slide, m9Table } from '@ordo/domain/m9.test-util.ts';
import { sanitizePresentation } from './sanitize.ts';
import { sanitizeChart } from './sanitize/chart.ts';
import { sanitizeTable } from './sanitize/table.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

/**
 * sanitizePresentation and the M9 fields (design/27 M9, §12 "Saving"): tables, charts, decorations, 3-D,
 * warps, vertical text, vector picture families, wide adjust values and missing elements are bounded, strings
 * cut with the runs and paragraph styles over them, so the saved presentation validates with every field kept.
 */

function deck(slide: Slide): Presentation {
  return Presentation.parse({
    id: 'p',
    title: 'Deck',
    kind: 'slides',
    sections: [{ id: 's', label: 'Slides', short: 'S', slides: [slide] }],
  });
}
/** A presentation holding `slide` as a raw importer hands it over: not parsed, so nothing is dropped yet. */
function rawDeck(slide: Slide): Presentation {
  return {
    ...deck({ id: 'x', objects: [] }),
    sections: [{ id: 's', label: 'S', short: 'S', slides: [slide] }],
  };
}
const slideOf = (p: Presentation) => p.sections[0]!.slides[0]!;
const byId = (s: Slide, id: string) =>
  s.objects.find((o) => o.id === id)! as unknown as Record<string, unknown>;

describe('sanitizePresentation and the M9 fields', () => {
  it('carries a valid M9 slide through unchanged', () => {
    const p = sanitizePresentation(deck(m9Slide()));
    expect(slideOf(p)).toEqual(slideOf(deck(m9Slide())));
    expect(Presentation.safeParse(p).success).toBe(true);
  });

  it('table and chart strings are cut and runs stay inside their text', () => {
    const t = m9Table();
    const long = 'x'.repeat(12_000);
    t.cells = [
      {
        text: long,
        runs: [
          [0, 5, 0],
          [9_990, 11_000, 1],
          [10_000, 10_500, 0],
        ],
      },
      {
        text: 'Short',
        runs: [
          [0, 9, 1],
          [1, 3, 0],
          [3, 4, 300 as never],
          [2, 2, 0],
        ],
      },
      // Six more cells of 10,000: the table's 60,000 characters run out in the sixth.
      ...[...Array(6)].map(() => ({ text: long, runs: [[0, 10_000, 0]] as [number, number, number][] })),
    ];
    const out = sanitizeTable(t)!;
    expect(out.cells[0]!.text).toHaveLength(10_000);
    expect(out.cells[0]!.runs).toEqual([
      [0, 5, 0],
      [9_990, 10_000, 1],
    ]);
    // Sorted, not overlapping, naming a run style that exists, never empty.
    expect(out.cells[1]!.runs).toEqual([[0, 5, 1]]);
    const lengths = out.cells.map((c) => c.text?.length ?? 0);
    expect(lengths).toEqual([10_000, 5, 10_000, 10_000, 10_000, 10_000, 9_995, 0]);
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(TABLE_LIMITS.tableText);
    expect(out.cells[7]).not.toHaveProperty('runs');
    for (const c of out.cells) for (const r of c.runs ?? []) expect(r[1]).toBeLessThanOrEqual(c.text!.length);

    const c = m9Chart();
    c.title = {
      text: 'T'.repeat(1_500),
      runs: [
        { start: 0, end: 1_400, fontWeight: 700 },
        { start: 1_200, end: 1_300 },
      ],
      paras: Array(30).fill(null),
      style: 9,
    };
    c.categories = ['c'.repeat(300), 'ok'];
    c.groups[0]!.series[0]!.name = 'n'.repeat(400);
    c.fmts = ['0'.repeat(100)];
    const chart = sanitizeChart(c)!;
    expect(chart.title!.text).toHaveLength(1_000);
    expect(chart.title!.runs).toEqual([{ start: 0, end: 1_000, fontWeight: 700 }]);
    expect(chart.title!.paras).toHaveLength(1);
    expect(chart.title!.style).toBe(0);
    expect(chart.categories!.map((s) => s.length)).toEqual([255, 2]);
    expect(chart.groups[0]!.series[0]!.name).toHaveLength(255);
    expect(chart.fmts![0]).toHaveLength(64);
    // The whole slide validates with both kept.
    const s = m9Slide();
    byId(s, 'table').table = t;
    byId(s, 'chart').chart = c;
    const p = sanitizePresentation(rawDeck(s));
    const parsed = Presentation.parse(p);
    expect((byId(slideOf(parsed), 'table') as unknown as ShapeObject).table).toBeDefined();
    expect((byId(slideOf(parsed), 'chart') as unknown as ShapeObject).chart).toBeDefined();
  });

  it('bounds table numbers, palettes and indices so the table survives the schema', () => {
    const t = m9Table() as unknown as Record<string, unknown>;
    t.cols = [...Array(80)].map(() => Number.NaN);
    t.rows = [1e12, -5];
    t.fills = [...Array(70)].map(() => ({ color: { r: 999, g: -1, b: 0.5, a: 3 } }));
    t.lineStyles = [{ width: 1e9, color: { r: 0, g: 0, b: 0, a: 1 } }];
    t.h = [[0, 0, 4, 0], [0, 3, 1, 0], [300, 0, 1, 0], [0, 0, 1, 5], 'x'];
    t.background = 99;
    const cells = (t.cells as Record<string, unknown>[]).slice(0, 3);
    cells[0] = { ...cells[0], style: 70, fill: 3, colSpan: 0, rowSpan: 1e6, diag: { down: 40, up: 0 } };
    t.cells = cells;
    const out = sanitizeTable(t as unknown as TableData)!;
    expect(out.cols).toHaveLength(64);
    expect(out.rows).toEqual([100_000, 0]);
    expect(out.fills).toHaveLength(64);
    expect(out.fills![0]!.color).toEqual({ r: 255, g: 0, b: 1, a: 1 });
    expect(out.lineStyles![0]!.width).toBe(500);
    expect(out.h).toEqual([[0, 0, 4, 0]]);
    expect(out).not.toHaveProperty('background');
    expect(out.cells[0]).toMatchObject({ fill: 3, diag: { up: 0 } });
    for (const k of ['style', 'colSpan', 'rowSpan']) expect(out.cells[0]).not.toHaveProperty(k);
    const s = m9Slide();
    byId(s, 'table').table = t;
    const parsed = Presentation.parse(sanitizePresentation(rawDeck(s)));
    expect((byId(slideOf(parsed), 'table') as unknown as ShapeObject).table!.cols).toHaveLength(64);
  });

  it('bounds decorations, 3-D, warps, vertical text and vector picture families', () => {
    const s = m9Slide();
    const d = m9Decor() as unknown as Record<string, unknown>;
    d.paints = [...Array(70)].map(() => ({ fill: { r: 300, g: 0, b: 0, a: 1 } }));
    d.parts = [
      { d: 'M 0 0 L 1e999 2 A 1 1 0 0 0 3 3', p: 0, s: 1, cont: 'yes', frame: [0, 0, -1, 1, 720] },
      { d: 'nothing', p: 0 },
      { d: 'M 0 0 L 1 1', p: 64 },
      ...[...Array(300)].map(() => ({ d: 'M 0 0 L 1 1', p: 1 })),
    ];
    d.ref = 'x'.repeat(200);
    byId(s, 'decor').decor = d;
    byId(s, 'pie').look3d = {
      bevel: { prst: 'circle', w: 1e9, h: Number.NaN },
      depth: -4,
      lift: 1e6,
      contour: { width: 600, color: { r: 0, g: 0, b: 0, a: 9 } },
      camera: { prst: 'perspectiveFront', fov: 400, rot: [0, Number.POSITIVE_INFINITY, 0], zoom: 0 },
      light: { rig: 'threePt', rot: [1, 2] },
    };
    byId(s, 'title').warp = {
      preset: 'textArchUp',
      adj: [...Array(6)].map((_, i) => [`adj${'x'.repeat(i * 9)}`, 9e9]),
    };
    byId(s, 'vertical').writing = { upright: 'cjk', reverse: 'yes' };
    byId(s, 'centred').centerBlock = false;
    byId(s, 'emf').vectorFonts = [
      'Arial',
      ' arial',
      'Sym\u0007bol',
      'x'.repeat(400),
      ...Array(10).fill('Times'),
    ];
    const pie = byId(s, 'pie') as unknown as ShapeObject;
    pie.geom = { ...pie.geom!, adjWide: [['adj2', 9e9], ['adj1', Number.NaN] as never] };
    s.pptx = {
      ...s.pptx!,
      missing: ['chart:surface', 'chart:surface', 'ole\u0000x', 'x'.repeat(60), ...Array(40).fill('ink')],
    };
    const p = sanitizePresentation(rawDeck(s));
    const r = Presentation.safeParse(p);
    expect(r.success).toBe(true);
    const out = slideOf(r.data!);
    const decor = (byId(out, 'decor') as unknown as ShapeObject).decor!;
    expect(decor.paints).toHaveLength(64);
    expect(decor.parts).toHaveLength(256);
    // Re-tokenised: the arc is not a stored command, and coordinates are bounded.
    expect(decor.parts[0]).toEqual({ d: 'M 0 0 L 1000000000 2', p: 0, s: 1, frame: [0, 0, 0, 1, 360] });
    expect(decor).not.toHaveProperty('ref');
    const look = (byId(out, 'pie') as unknown as ShapeObject).look3d!;
    expect(look).toMatchObject({
      bevel: { w: 1_000, h: 12 },
      depth: 0,
      lift: 1_000,
      contour: { width: 500 },
    });
    expect(look.camera).toEqual({ prst: 'perspectiveFront', fov: 180, zoom: 0.01 });
    expect(look.light).toEqual({ rig: 'threePt' });
    expect((byId(out, 'pie') as unknown as ShapeObject).geom!.adjWide).toEqual([['adj2', 21_600_000]]);
    const warp = (byId(out, 'title') as unknown as TextObject).warp!;
    expect(warp.adj).toHaveLength(4);
    expect(warp.adj!.every(([n, v]) => n.length <= 16 && v === 21_600_000)).toBe(true);
    expect((byId(out, 'vertical') as unknown as TextObject).writing).toEqual({ upright: 'cjk' });
    expect(byId(out, 'centred').centerBlock).toBeUndefined();
    expect(byId(out, 'emf').vectorFonts).toEqual(['Arial', 'Symbol', 'x'.repeat(120), 'Times']);
    expect(out.pptx!.missing).toEqual(['chart:surface', 'ole x', 'x'.repeat(40), 'ink']);
  });
});

describe('the M9 sanitizers never throw on hostile input (fuzz)', () => {
  // A small deterministic PRNG (mulberry32), so a failure reproduces.
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const ODD: unknown[] = [
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1e300,
    1e12,
    -1,
    0,
    0.5,
    '',
    '__proto__',
    'x'.repeat(50_000),
    [],
    {},
    [null],
    [null, null],
    { length: 1e9 },
    true,
  ];

  /** `v` with one leaf, array or object somewhere replaced by an odd value. */
  function mutate(v: unknown, r: () => number, depth = 0): unknown {
    if (r() < 0.08 || depth > 6) return ODD[Math.floor(r() * ODD.length)];
    if (Array.isArray(v)) {
      if (!v.length) return v;
      const out = v.slice();
      const i = Math.floor(r() * out.length);
      out[i] = mutate(out[i], r, depth + 1);
      if (r() < 0.1) out.push(...out.slice(0, 50));
      return out;
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return v;
      const k = keys[Math.floor(r() * keys.length)]!;
      return {
        ...(v as Record<string, unknown>),
        [k]: mutate((v as Record<string, unknown>)[k], r, depth + 1),
      };
    }
    return ODD[Math.floor(r() * ODD.length)];
  }

  it('sanitizes 800 mutated M9 slides without throwing, within 2 s, and the result validates', () => {
    const r = rng(9);
    const t0 = performance.now();
    let kept = 0;
    for (let i = 0; i < 800; i++) {
      const s = m9Slide();
      for (const o of s.objects as unknown as Record<string, unknown>[])
        for (const k of [
          'table',
          'chart',
          'decor',
          'look3d',
          'warp',
          'writing',
          'centerBlock',
          'vectorFonts',
        ])
          if (k in o && r() < 0.5) o[k] = mutate(o[k], r);
      if (r() < 0.3) (s.pptx as Record<string, unknown>).missing = mutate(s.pptx!.missing, r);
      // A raw importer hands over anything: no schema parse before sanitizing.
      const p = rawDeck(s);
      expect(() => sanitizePresentation(p)).not.toThrow();
      const parsed = Presentation.safeParse(p);
      expect(parsed.success).toBe(true);
      if ((byId(slideOf(parsed.data!), 'table') as unknown as ShapeObject).table) kept++;
    }
    expect(performance.now() - t0).toBeLessThan(budgetMs(2_000));
    // Most mutated tables still survive as tables.
    expect(kept).toBeGreaterThan(400);
    for (const v of ODD) {
      expect(() => sanitizeTable(v as never)).not.toThrow();
      expect(() => sanitizeChart(v as never)).not.toThrow();
    }
  });

  it('a chart title or axis title with a run that is not one (null) is sanitized, not thrown on', () => {
    for (const where of ['title', 'axis'] as const) {
      const s = m9Slide();
      const chart = byId(s, 'chart').chart as unknown as Record<string, unknown> & {
        title: Record<string, unknown>;
        axes: Record<string, unknown>[];
      };
      if (where === 'title') chart.title.runs = [null, 5, { start: 0, end: 2, fontWeight: 700 }];
      else chart.axes[0]!.title = { text: 'Weeks', style: 0, runs: [null] };
      const p = rawDeck(s);
      expect(() => sanitizePresentation(p), where).not.toThrow();
      const parsed = Presentation.safeParse(p);
      expect(parsed.success, where).toBe(true);
      const out = (byId(slideOf(parsed.data!), 'chart') as unknown as ShapeObject).chart!;
      if (where === 'title') expect(out.title!.runs).toEqual([{ start: 0, end: 2, fontWeight: 700 }]);
      else expect(out.axes![0]!.title!.runs).toBeUndefined();
    }
  });

  it('a chart or decoration with nothing usable is left out, the shape kept', () => {
    const s = m9Slide();
    byId(s, 'chart').chart = { ...m9Chart(), groups: [{ kind: 'bar', series: [] }] } as unknown as ChartData;
    byId(s, 'decor').decor = { ...m9Decor(), paints: [] } as unknown as DecorData;
    byId(s, 'table').table = { ...m9Table(), cols: [] };
    const p = sanitizePresentation(rawDeck(s));
    const sanitized = slideOf(p);
    const out = slideOf(Presentation.parse(p));
    for (const [id, k] of [
      ['chart', 'chart'],
      ['decor', 'decor'],
      ['table', 'table'],
    ] as const) {
      expect(byId(sanitized, id)).not.toHaveProperty(k);
      expect(byId(out, id)[k]).toBeUndefined();
      expect(byId(out, id).type).toBe('shape');
    }
  });
});
