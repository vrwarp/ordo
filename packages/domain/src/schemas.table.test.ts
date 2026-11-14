import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import { m9Table } from './m9.test-util.ts';
import { type ShapeObject, Slide, TABLE_LIMITS, TableData } from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';
import { slideBytes } from './size.ts';
import { placeCells } from './table.ts';

/*
 * The table object's stored form (design/27 M9, tables-object.md §6 schema tests): enums degrade, a malformed
 * table leaves the shape a parseable rect, the previous release strips the table and keeps the rect, and the
 * corpus's largest grid (a template's 20 × 32 master grid of 640 empty cells) parses within the limits.
 */

const white = { r: 255, g: 255, b: 255, a: 1 };

function tableShape(table: unknown): unknown {
  return {
    id: 'tbl',
    type: 'shape',
    box: { x: 80, y: 120, w: 1320, h: 410, rotation: 0 },
    shape: 'rect',
    fill: white,
    opacity: 1,
    radius: 0,
    table,
    origin: { src: 'pptx', role: 'table' },
  };
}

function slide(objects: unknown[]): unknown {
  return { id: 's1', objects };
}

/** The template's master grid: 20 rows × 32 columns of empty cells under thin lines. */
function masterGrid(): TableData {
  const R = 20;
  const C = 32;
  const h: [number, number, number, number][] = [];
  const v: [number, number, number, number][] = [];
  for (let k = 0; k <= R; k++) h.push([k, 0, C, 0]);
  for (let k = 0; k <= C; k++) v.push([k, 0, R, 0]);
  return {
    cols: Array(C).fill(60),
    rows: Array(R).fill(54),
    cells: [...Array(R * C)].map(() => ({})),
    base: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Calibri', fontSizePx: 24, lineModel: 'office' },
    lineStyles: [{ width: 1, color: { r: 200, g: 200, b: 200, a: 1 } }],
    h,
    v,
  };
}

describe('the table object (stored)', () => {
  it('.catch enums degrade (vert, rowRule, dash, valign)', () => {
    const t = TableData.parse({
      ...m9Table(),
      rowRule: 'elastic',
      styles: [{ vert: 'wordArtVert', valign: 'baseline', align: 'distribute', direction: 'ttb' }],
      lineStyles: [{ width: 1, color: white, dash: 'squiggle' }],
    });
    expect(t.rowRule).toBe('grow');
    expect(t.styles![0]).toEqual({ vert: 'horz', valign: 'top', align: 'left', direction: 'auto' });
    expect(t.lineStyles![0]!.dash).toBe('solid');
  });

  it('a malformed table leaves a parseable rect', () => {
    for (const bad of [
      { ...m9Table(), cols: [] },
      { ...m9Table(), cells: 'all' },
      { ...m9Table(), rows: Array(TABLE_LIMITS.rows + 1).fill(1) },
      { ...m9Table(), cells: [{ style: 64 }] },
      { ...m9Table(), h: [[0, 0, 4, 32]] },
      'table',
    ]) {
      const r = Slide.safeParse(slide([tableShape(bad)]));
      expect(r.success).toBe(true);
      const o = r.data!.objects[0] as ShapeObject;
      expect(o.table).toBeUndefined();
      expect(o).toMatchObject({ type: 'shape', shape: 'rect', fill: white });
    }
  });

  it('the previous release strips table and draws the legacy rect', () => {
    const r = prev.Slide.safeParse(slide([tableShape(m9Table())]));
    expect(r.success).toBe(true);
    const o = r.data!.objects[0] as unknown as Record<string, unknown>;
    expect(o).not.toHaveProperty('table');
    expect(o).toMatchObject({ type: 'shape', shape: 'rect', fill: white, box: { w: 1320, h: 410 } });
    // What it saves back still parses today (a rect, without the table).
    expect(Slide.safeParse(r.data).success).toBe(true);
  });

  it('the 640-cell master grid parses within the limits', () => {
    const grid = masterGrid();
    const r = Slide.safeParse(slide([tableShape(grid)]));
    expect(r.success).toBe(true);
    const t = (r.data!.objects[0] as ShapeObject).table!;
    expect(t.cells).toHaveLength(640);
    expect(placeCells(t).slots.every((s) => s >= 0)).toBe(true);
    // One object of about 8 KB, against 640 cell text objects and 53 lines in the M6 group.
    expect(slideBytes(r.data!)).toBeLessThan(12_000);
  });
});
