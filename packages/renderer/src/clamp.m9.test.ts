import { LOOK_MAIN, type ShapeObject, type Slide, type TextObject } from '@ordo/domain';
import { m9Chart, m9Decor, m9Slide, m9Table } from '@ordo/domain/m9.test-util.ts';
import * as prev from '@ordo/domain/schemas.prev.test-util.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampGeom, clampObject, clampSlide } from './clamp.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { isRichText } from './text/rich.ts';
import { recordingCtx } from './text/test-util.ts';
import { drawSlide2D } from './text2d.ts';

/**
 * The render plan's clamps of the M9 fields (design/27 M9, plan §2 decision 10): each field re-validated by
 * its area's file in `clamp/` and kept, a malformed one dropped, at most one of table, chart and decoration
 * on a shape (in that order) and no 3-D on any of them.
 */

const byId = (s: Slide, id: string) => s.objects.find((o) => o.id === id)!;
const clamped = () => clampSlide(m9Slide());
const shapeOf = (fields: Partial<ShapeObject>): ShapeObject =>
  clampObject({
    id: 's',
    type: 'shape',
    box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    shape: 'rect',
    ...fields,
  }) as ShapeObject;
const look3d = { bevel: { prst: 'circle', w: 6, h: 6 } } as const;

describe('clampObject and the M9 fields', () => {
  it('keeps every M9 field of a valid slide', () => {
    const s = clamped();
    const src = m9Slide();
    for (const [id, keys] of [
      ['table', ['table']],
      ['chart', ['chart']],
      ['decor', ['decor']],
      ['pie', ['look3d']],
      ['emf', ['look3d', 'vectorFonts']],
      ['title', ['warp', 'look3d']],
      ['vertical', ['writing']],
      ['centred', ['centerBlock']],
    ] as const)
      for (const k of keys)
        expect((byId(s, id) as Record<string, unknown>)[k]).toEqual(
          (byId(src, id) as Record<string, unknown>)[k],
        );
    expect((byId(s, 'pie') as ShapeObject).geom!.adjWide).toEqual([['adj2', 16_200_000]]);
  });

  it('clampObject keeps one of table/chart/decor by precedence and drops look3d on them', () => {
    const table = m9Table();
    const chart = m9Chart();
    const decor = m9Decor();
    const all = shapeOf({ table, chart, decor, look3d });
    expect(all.table).toEqual(table);
    expect(all).not.toHaveProperty('chart');
    expect(all).not.toHaveProperty('decor');
    expect(all).not.toHaveProperty('look3d');
    const noTable = shapeOf({ chart, decor, look3d });
    expect(noTable.chart).toEqual(chart);
    expect(noTable).not.toHaveProperty('decor');
    expect(noTable).not.toHaveProperty('look3d');
    const decorOnly = shapeOf({ decor, look3d });
    expect(decorOnly.decor).toEqual(decor);
    expect(decorOnly).not.toHaveProperty('look3d');
    expect(shapeOf({ look3d }).look3d).toEqual(look3d);
    // A malformed table gives way to the next usable kind.
    const bad = shapeOf({ table: { ...table, cols: [] }, chart, look3d });
    expect(bad).not.toHaveProperty('table');
    expect(bad.chart).toEqual(chart);
    // Nothing usable: the shape's legacy fields, and its 3-D look.
    const none = shapeOf({ table: 'x' as never, chart: 7 as never, decor: null as never, look3d });
    expect(none).toMatchObject({ shape: 'rect', look3d });
    for (const k of ['table', 'chart', 'decor']) expect(none).not.toHaveProperty(k);
  });

  it('drops a malformed M9 field and keeps the object', () => {
    const s = m9Slide();
    const set = (id: string, k: string, v: unknown) => {
      (byId(s, id) as Record<string, unknown>)[k] = v;
    };
    set('table', 'table', { ...m9Table(), cells: 'all' });
    set('chart', 'chart', { ...m9Chart(), texts: [] });
    set('decor', 'decor', { ...m9Decor(), paints: [] });
    set('pie', 'look3d', { depth: Number.NaN });
    set('emf', 'vectorFonts', 'Arial');
    set('title', 'warp', { preset: 'textArchUp', adj: 'up' });
    set('vertical', 'writing', ['cjk']);
    set('centred', 'centerBlock', 'true');
    const out = clampSlide(s);
    expect(out.objects).toHaveLength(m9Slide().objects.length);
    const fields: [string, string][] = [
      ['table', 'table'],
      ['chart', 'chart'],
      ['decor', 'decor'],
      ['pie', 'look3d'],
      ['emf', 'vectorFonts'],
      ['title', 'warp'],
      ['vertical', 'writing'],
      ['centred', 'centerBlock'],
    ];
    for (const [id, k] of fields) expect(byId(out, id)).not.toHaveProperty(k);
    expect(byId(out, 'table')).toMatchObject({ shape: 'rect', fill: { r: 255 } });
    expect((byId(out, 'title') as TextObject).look3d).toBeDefined();
  });

  it('degrades unknown names to their defaults, as the schema does', () => {
    const t = clampObject({
      ...byId(m9Slide(), 'title'),
      warp: { preset: 'textSpiral' },
      look3d: { camera: { prst: 'fisheye' }, material: 'chrome' },
    }) as TextObject;
    expect(t.warp).toEqual({ preset: 'textPlain' });
    expect(t.look3d).toEqual({ camera: { prst: 'orthographicFront' }, material: 'warmMatte' });
    const v = clampObject({ ...byId(m9Slide(), 'vertical'), writing: { upright: 'sideways' } }) as TextObject;
    expect(v.writing).toEqual({ upright: 'cjk' });
  });

  it("re-tokenises a decoration's path strings and drops parts with nothing left", () => {
    const d = m9Decor();
    const s = shapeOf({
      decor: {
        ...d,
        parts: [
          { d: 'M 0 0 L 10 0 A 1 1 0 0 1 5 5', p: 0 },
          { d: 'garbage', p: 0 },
          { d: 'M0,0 L 1 1', p: 1, s: 1 },
        ],
      },
    });
    expect(s.decor!.parts).toEqual([
      { d: 'M 0 0 L 10 0', p: 0 },
      { d: 'M 0 0 L 1 1', p: 1, s: 1 },
    ]);
  });

  it('keeps at most 8 vector picture families, cleaned and once each', () => {
    const img = (vectorFonts: unknown) =>
      clampObject({ ...byId(m9Slide(), 'emf'), vectorFonts }) as Extract<
        Slide['objects'][number],
        { type: 'image' }
      >;
    expect(img(['Arial', ' arial ', 'Sym"bol', '', 7, 'Wingdings']).vectorFonts).toEqual([
      'Arial',
      'Symbol',
      'Wingdings',
    ]);
    expect(img([...Array(20)].map((_, i) => `F${i}`)).vectorFonts).toHaveLength(8);
    expect(img([])).not.toHaveProperty('vectorFonts');
  });

  it('keeps adjWide pairs within ±21,600,000 and adj within ±1e7', () => {
    expect(
      clampGeom({
        preset: 'pie',
        adj: [['adj2', 16_200_000]],
        adjWide: [['adj2', 16_200_000], ['adj1', 9e9], ['x', Number.NaN], 'y'],
      }),
    ).toEqual({
      preset: 'pie',
      adj: [['adj2', 1e7]],
      adjWide: [
        ['adj2', 16_200_000],
        ['adj1', 21_600_000],
      ],
    });
  });

  it('never throws on hostile M9 values', () => {
    // JSON can carry an object whose `length` has no callable valueOf or toString: zod 4 throws on it.
    const evil = JSON.parse('{"length":{"valueOf":0,"toString":0}}');
    const hostile = [
      evil,
      { preset: 'textPlain', adj: evil },
      { parts: evil },
      { paints: evil, parts: [] },
      { cols: evil, rows: [1], cells: [] },
      { groups: evil },
      { bevelT: evil },
      { upright: 'cjk', dir: evil },
      null,
      7,
      'x',
      [],
      { cells: { length: 1e9 } },
      { __proto__: { cols: [1] } },
      { cols: [1], rows: [1], cells: [], base: { fontFamily: 'A', fontSizePx: 1e300 } },
      { groups: [{ series: [{ values: [Number.POSITIVE_INFINITY] }] }] },
      { paints: [{}], parts: [{ d: 'M 1e999 0', p: 0 }], w: -1, h: 1 },
    ];
    for (const v of hostile)
      for (const k of ['table', 'chart', 'decor', 'look3d'])
        expect(() => shapeOf({ [k]: v } as Partial<ShapeObject>)).not.toThrow();
    for (const v of hostile)
      for (const k of ['warp', 'writing', 'centerBlock', 'look3d'])
        expect(() => clampObject({ ...byId(m9Slide(), 'title'), [k]: v })).not.toThrow();
  });
});

describe('clampSlide and mutated M9 slides (fuzz)', () => {
  // mulberry32: deterministic, so a failure reproduces.
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
    -1e300,
    1e12,
    -1,
    '',
    '__proto__',
    [],
    {},
    [null],
    true,
  ];
  function mutate(v: unknown, r: () => number, depth = 0): unknown {
    if (r() < 0.08 || depth > 6) return ODD[Math.floor(r() * ODD.length)];
    if (Array.isArray(v)) {
      if (!v.length) return v;
      const out = v.slice();
      const i = Math.floor(r() * out.length);
      out[i] = mutate(out[i], r, depth + 1);
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

  it('never throws, keeps every object and keeps the precedence rule', () => {
    const r = rng(27);
    for (let i = 0; i < 400; i++) {
      const s = m9Slide();
      for (const o of s.objects as unknown as Record<string, unknown>[]) {
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
        if (o.type === 'shape' && r() < 0.2) Object.assign(o, { table: m9Table(), chart: m9Chart(), look3d });
      }
      const out = clampSlide(s);
      expect(out.objects).toHaveLength(s.objects.length);
      for (const o of out.objects) {
        if (o.type !== 'shape') continue;
        const kinds = ['table', 'chart', 'decor'].filter(
          (k) => (o as Record<string, unknown>)[k] !== undefined,
        );
        expect(kinds.length).toBeLessThanOrEqual(1);
        if (kinds.length) expect(o.look3d).toBeUndefined();
      }
    }
  });
});

describe('text objects with M9 looks are drawn by the rich engine', () => {
  it('isRichText is true for warp, writing, centerBlock and look3d', () => {
    const plain = { ...(byId(m9Slide(), 'vertical') as TextObject) };
    delete plain.writing;
    plain.style = { ...plain.style };
    delete plain.style.lang;
    expect(isRichText(plain)).toBe(false);
    expect(isRichText({ ...plain, warp: { preset: 'textPlain' } })).toBe(true);
    expect(isRichText({ ...plain, writing: { upright: 'none' } })).toBe(true);
    expect(isRichText({ ...plain, centerBlock: true })).toBe(true);
    expect(isRichText({ ...plain, look3d: {} })).toBe(true);
  });
});

describe('an older build and this build draw the M9 slide', () => {
  beforeAll(() => vi.stubGlobal('Path2D', RecPath));
  afterAll(() => vi.unstubAllGlobals());
  const img = { width: 160, height: 90 } as unknown as CanvasImageSource;
  const draw = (slide: Slide) => {
    const ctx = recordingCtx();
    drawSlide2D(ctx, slide, { scale: 0.5, look: LOOK_MAIN, images: () => img });
    return ctx.ops;
  };

  it('the previous schema strips every M9 field and the slide draws its legacy shapes and text', () => {
    const stripped = prev.Slide.parse(m9Slide()) as Slide;
    const ops = draw(stripped);
    const text = ops
      .filter((o) => o.op === 'fillText')
      .map((o) => o.args[0] as string)
      .join('');
    expect(text).toContain('He is risen!');
    expect(ops.some((o) => o.op === 'fillRect' || o.op === 'fill')).toBe(true);
    expect(ops.some((o) => o.op === 'drawImage')).toBe(true);
  });

  it('this build draws it too (the drawers of the new fields come in their own tracks)', () => {
    const ops = draw(m9Slide());
    const text = ops
      .filter((o) => o.op === 'fillText')
      .map((o) => o.args[0] as string)
      .join('');
    expect(text).toContain('risen');
  });
});
