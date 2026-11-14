import { describe, expect, it } from 'vitest';
import { CHART_LIMITS } from './chart.ts';
import { m9Chart, m9Decor, m9Slide, m9Table } from './m9.test-util.ts';
import {
  ChartData,
  DECOR_LIMITS,
  DecorData,
  DecorFile,
  GEOM_FILE_MAX_BYTES,
  GeomFile,
  ImageObject,
  Look3d,
  ShapeGeom,
  ShapeObject,
  Slide,
  TABLE_LIMITS,
  TEXT_WARPS,
  TableData,
  TextObject,
  TextWarp,
  Writing,
} from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';
import { SIZE_BUDGETS, slideBytes } from './size.ts';
import { CAMERA_PRESETS, LIGHT_RIGS, MATERIALS } from './three-names.ts';

/**
 * The M9 stored fields (design/27 M9, plan §3): each parsed and kept by the current schema; a malformed one
 * dropped by its own `.catch(undefined)` without failing the slide, the object keeping the legacy fields an
 * older build draws; enums degrading to their defaults; every array, string and number bounded; and the
 * previous release's schema (main's 0.5.0) stripping them all while keeping what it knew (geometry, provenance,
 * picture shadow and soft edge, midiCues, bottomThirdText, line masks).
 */

type Obj = Record<string, unknown>;
const byId = (s: Slide, id: string) => s.objects.find((o) => o.id === id) as unknown as Obj;

/** The slide with object `id`'s field at `path` (dot separated) set to `value`. */
function withField(id: string, path: string, value: unknown): Slide {
  const s = m9Slide() as unknown as { objects: Obj[] };
  const o = s.objects.find((x) => x.id === id)!;
  const keys = path.split('.');
  let at: Obj = o;
  for (const k of keys.slice(0, -1)) at = at[k] as Obj;
  at[keys[keys.length - 1]!] = value;
  return s as unknown as Slide;
}

describe('the M9 fields', () => {
  it('the current schema keeps every M9 field', () => {
    const s = m9Slide();
    expect(Slide.parse(s)).toEqual(s);
  });

  it('a slide carrying every M9 field stays under 64 KB', () => {
    const bytes = slideBytes(Slide.parse(m9Slide()));
    expect(bytes).toBeLessThan(SIZE_BUDGETS.slideMax);
    // About 11 KB: a table, a chart of 36 points and a 41-part decoration fit a typical slide budget twice.
    expect(bytes).toBeLessThan(2 * SIZE_BUDGETS.slideTypical);
  });

  // One case per field of plan §3: the object (id), the field and a malformed value. Each is dropped by its
  // own .catch(undefined); the object and the slide still parse, with the legacy fields beside it.
  const malformed: [string, string, unknown][] = [
    ['table', 'table', { ...m9Table(), cells: Array(TABLE_LIMITS.grid + 1).fill({}) }],
    ['chart', 'chart', { ...m9Chart(), groups: [] }],
    ['decor', 'decor', { ...m9Decor(), paints: [] }],
    ['pie', 'look3d', { depth: -1 }],
    ['emf', 'look3d', { bevel: { prst: 'circle', w: 'wide', h: 1 } }],
    ['title', 'look3d', 'gold'],
    ['title', 'warp', { preset: 'textArchUp', adj: Array(5).fill(['adj', 1]) }],
    ['vertical', 'writing', 'vertical'],
    ['centred', 'centerBlock', 'yes'],
    ['emf', 'vectorFonts', Array(9).fill('Arial')],
    ['pie', 'geom.adjWide', [['adj2', 3e7]]],
  ];
  it.each(malformed)(
    'each M9 field parses, and a malformed value becomes undefined without failing Slide.safeParse (%s.%s)',
    (id, path, value) => {
      const r = Slide.safeParse(withField(id, path, value));
      expect(r.success).toBe(true);
      const o = byId(r.data!, id);
      const keys = path.split('.');
      const holder = keys.length > 1 ? (o[keys[0]!] as Obj) : o;
      expect(holder).toBeDefined();
      expect(holder[keys[keys.length - 1]!]).toBeUndefined();
      // The rest of the object is kept: what an older build draws.
      const good = byId(Slide.parse(m9Slide()), id);
      expect(o.box).toEqual(good.box);
      if (o.type === 'shape') expect(o.shape).toBe(good.shape);
      if (o.type === 'text') expect(o.text).toBe(good.text);
      if (o.type === 'image') expect(o.mediaId).toBe(good.mediaId);
    },
  );

  it('a malformed missing list is dropped from the slide record, which is kept', () => {
    for (const bad of [['x'.repeat(41)], Array(17).fill('ole'), 'ole', [3]]) {
      const s = m9Slide();
      (s.pptx as Obj).missing = bad;
      const r = Slide.safeParse(s);
      expect(r.success).toBe(true);
      expect(r.data!.pptx!.missing).toBeUndefined();
      expect(r.data!.pptx!.class).toBe('hybrid');
    }
    expect(Slide.parse(m9Slide()).pptx!.missing).toEqual(['chart:surface', 'ole']);
  });

  it('a decoration ref that is not a string of 1-100 characters is dropped, not the decoration', () => {
    for (const bad of [7, '', 'x'.repeat(101)]) {
      const d = DecorData.parse({ ...m9Decor(), ref: bad });
      expect(d.ref).toBeUndefined();
      expect(d.parts).toHaveLength(41);
    }
    expect(DecorData.parse({ ...m9Decor(), ref: 'pptxdecor:1' }).ref).toBe('pptxdecor:1');
  });

  it('enums inside the M9 fields degrade to their defaults', () => {
    const look = Look3d.parse({
      bevel: { prst: 'spiky', w: 1, h: 1 },
      material: 'chrome',
      light: { rig: 'disco', dir: 'up' },
      camera: { prst: 'fisheye' },
    });
    expect(look).toEqual({
      bevel: { prst: 'circle', w: 1, h: 1 },
      material: 'warmMatte',
      light: { rig: 'threePt', dir: 't' },
      camera: { prst: 'orthographicFront' },
    });
    expect(TextWarp.parse({ preset: 'textSpiral' })).toEqual({ preset: 'textPlain' });
    expect(Writing.parse({ upright: 'some' })).toEqual({ upright: 'cjk' });
    const t = m9Table();
    const odd = {
      ...t,
      rowRule: 'elastic',
      styles: [{ vert: 'diagonal', valign: 'baseline', align: 'distribute', fontStyle: 'oblique' }],
      lineStyles: [{ width: 1, color: t.base.color, dash: 'wavy' }],
    };
    const table = TableData.parse(odd);
    expect(table.rowRule).toBe('grow');
    expect(table.styles![0]).toEqual({ vert: 'horz', valign: 'top', align: 'left', fontStyle: 'normal' });
    expect(table.lineStyles![0]!.dash).toBe('solid');
    const c = m9Chart();
    const chart = ChartData.parse({
      ...c,
      groups: [{ ...c.groups[0]!, kind: 'surface', grouping: 'fancy' }],
      legend: { pos: 'centre', text: 0 },
      axes: [{ dim: 'z', kind: 'series', pos: 'front' }],
      blanks: 'interpolate',
    });
    expect(chart.groups[0]).toMatchObject({ kind: 'bar', grouping: 'standard' });
    expect(chart.legend!.pos).toBe('r');
    expect(chart.axes![0]).toMatchObject({ dim: 'y', kind: 'val', pos: 'l' });
    expect(chart.blanks).toBe('gap');
    const d = DecorData.parse({
      ...m9Decor(),
      paints: [{ dash: 'zigzag' }],
      parts: [{ d: 'M 0 0', p: 0, fill: 'glow' }],
    });
    expect(d.paints[0]!.dash).toBe('solid');
    expect(d.parts[0]!.fill).toBe('norm');
  });

  it('refuses unbounded M9 data at the boundary', () => {
    const t = m9Table();
    expect(TableData.safeParse({ ...t, cols: Array(TABLE_LIMITS.cols + 1).fill(10) }).success).toBe(false);
    expect(TableData.safeParse({ ...t, rows: Array(TABLE_LIMITS.rows + 1).fill(10) }).success).toBe(false);
    expect(TableData.safeParse({ ...t, cols: [] }).success).toBe(false);
    expect(TableData.safeParse({ ...t, cells: [{ text: 'x'.repeat(10_001) }] }).success).toBe(false);
    expect(TableData.safeParse({ ...t, cells: [{ runs: [[0, 1, 256]] }] }).success).toBe(false);
    expect(TableData.safeParse({ ...t, cells: [{ style: 64 }] }).success).toBe(false);
    expect(TableData.safeParse({ ...t, h: [[257, 0, 1, 0]] }).success).toBe(false);
    expect(TableData.safeParse({ ...t, fills: Array(65).fill({ color: t.base.color }) }).success).toBe(false);
    const c = m9Chart();
    const s0 = c.groups[0]!.series[0]!;
    const group = (series: unknown[]) => ({ ...c, groups: [{ ...c.groups[0]!, series }] });
    expect(ChartData.safeParse(group(Array(CHART_LIMITS.series + 1).fill(s0))).success).toBe(false);
    expect(
      ChartData.safeParse(group([{ ...s0, values: Array(CHART_LIMITS.points + 1).fill(1) }])).success,
    ).toBe(false);
    expect(ChartData.safeParse(group([{ ...s0, values: [Number.NaN] }])).success).toBe(false);
    expect(ChartData.safeParse(group([{ ...s0, name: 'x'.repeat(256) }])).success).toBe(false);
    expect(ChartData.safeParse({ ...c, texts: [] }).success).toBe(false);
    expect(ChartData.safeParse({ ...c, title: { text: 'x'.repeat(1_001), style: 0 } }).success).toBe(false);
    const d = m9Decor();
    expect(DecorData.safeParse({ ...d, parts: Array(DECOR_LIMITS.parts + 1).fill(d.parts[0]) }).success).toBe(
      false,
    );
    expect(DecorData.safeParse({ ...d, parts: [{ d: 'M'.repeat(40_001), p: 0 }] }).success).toBe(false);
    expect(DecorData.safeParse({ ...d, parts: [{ d: 'M 0 0', p: 64 }] }).success).toBe(false);
    expect(Look3d.safeParse({ depth: 1_001 }).success).toBe(false);
    expect(
      Look3d.safeParse({ camera: { prst: 'perspectiveFront', rot: [0, 0, Number.POSITIVE_INFINITY] } })
        .success,
    ).toBe(false);
    expect(TextWarp.safeParse({ preset: 'textWave1', adj: [['adj1', 3e7]] }).success).toBe(false);
    expect(ShapeGeom.parse({ preset: 'pie', adjWide: Array(11).fill(['adj', 1]) }).adjWide).toBeUndefined();
  });

  it('names the closed lists in full (ECMA-376)', () => {
    expect(CAMERA_PRESETS).toHaveLength(62);
    expect(LIGHT_RIGS).toHaveLength(27);
    expect(MATERIALS).toHaveLength(15);
    expect(TEXT_WARPS).toHaveLength(40);
    expect(TEXT_WARPS).not.toContain('textNoShape');
    for (const list of [CAMERA_PRESETS, LIGHT_RIGS, MATERIALS, TEXT_WARPS])
      expect(new Set<string>(list).size).toBe(list.length);
  });

  it('the previous schema strips every M9 field and the slide still parses', () => {
    const r = prev.Slide.safeParse(m9Slide());
    expect(r.success).toBe(true);
    const old = r.data! as unknown as Slide;
    const M9_KEYS = ['table', 'chart', 'decor', 'look3d', 'warp', 'writing', 'centerBlock', 'vectorFonts'];
    for (const o of old.objects) for (const k of M9_KEYS) expect(o).not.toHaveProperty(k);
    // 0.5.0 knows geometry and provenance (M6, M3): it keeps them without M9's adjWide and missing list.
    expect((byId(old, 'pie').geom as Obj) ?? {}).not.toHaveProperty('adjWide');
    expect(old.pptx).toBeDefined();
    expect(old.pptx).not.toHaveProperty('missing');
    // What an older build draws: the table's background, the chart area, nothing for the decoration, the
    // pie's preset at the clamped angle, the picture flat, the text unwarped and horizontal.
    expect(byId(old, 'table')).toMatchObject({ type: 'shape', shape: 'rect', fill: { r: 255 } });
    expect(byId(old, 'chart')).toMatchObject({ type: 'shape', shape: 'rect', fill: { r: 255 } });
    const decor = byId(old, 'decor');
    expect(decor).toMatchObject({ type: 'shape', shape: 'line' });
    expect(decor).not.toHaveProperty('stroke');
    expect(byId(old, 'pie')).toMatchObject({
      shape: 'ellipse',
      fill: { r: 240 },
      geom: { preset: 'pie', adj: [['adj2', 10_000_000]] },
    });
    expect(byId(old, 'emf')).toMatchObject({ type: 'image', mediaId: 'vector-media' });
    expect(byId(old, 'title')).toMatchObject({ text: 'He is risen!', style: { fontSizePx: 102 } });
    expect(byId(old, 'vertical')).toMatchObject({ box: { rotation: 90 }, text: '主は私の羊飼い' });
    // What an older build saves back is valid for the current schema too.
    expect(Slide.safeParse(old).success).toBe(true);
  });

  it('keeps adjWide beside the clamped adj', () => {
    const pie = ShapeObject.parse(byId(m9Slide(), 'pie'));
    expect(pie.geom).toEqual({
      preset: 'pie',
      adj: [['adj2', 10_000_000]],
      adjWide: [['adj2', 16_200_000]],
    });
    expect(ShapeGeom.safeParse({ adj: [['adj2', 16_200_000]] }).success).toBe(false);
  });

  it('keeps the text looks on the object, never on its style', () => {
    const title = TextObject.parse(byId(m9Slide(), 'title'));
    expect(title.warp).toEqual({ preset: 'textArchUp', adj: [['adj', 10_800_000]] });
    expect(title.look3d!.flat).toBe(true);
    expect(title.style).not.toHaveProperty('warp');
    const picture = ImageObject.parse(byId(m9Slide(), 'emf'));
    expect(picture.vectorFonts).toEqual(['Arial', 'Symbol']);
  });
});

describe('geometry and decoration files (M9: 64 paths)', () => {
  const path = { d: 'M 0 0 L 1 1', w: 1, h: 1 };

  it('GeomFile with 64 paths parses and a 65th is refused', () => {
    expect(GeomFile.parse({ paths: Array(64).fill(path) }).paths).toHaveLength(64);
    expect(GeomFile.safeParse({ paths: Array(65).fill(path) }).success).toBe(false);
    expect(GeomFile.safeParse({ paths: [] }).success).toBe(false);
    // Inline paths keep their 8: a widened inline geometry would fail an older build's Slide.safeParse.
    expect(ShapeGeom.safeParse({ paths: Array(9).fill(path) }).success).toBe(false);
  });

  it('the file bound holds 64 paths of 40,000 characters', () => {
    expect(GEOM_FILE_MAX_BYTES).toBe(2_600_000);
    expect(GEOM_FILE_MAX_BYTES).toBeGreaterThan(64 * 40_000);
  });

  it('a DecorFile holds 1-256 parts', () => {
    const part = { d: 'M 0 0 L 1 1', p: 0 };
    expect(DecorFile.parse({ parts: Array(256).fill(part) }).parts).toHaveLength(256);
    expect(DecorFile.safeParse({ parts: Array(257).fill(part) }).success).toBe(false);
    expect(DecorFile.safeParse({ parts: [] }).success).toBe(false);
  });
});
