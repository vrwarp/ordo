import { m9Table } from '@ordo/domain/m9.test-util.ts';
import { TABLE_LIMITS, type TableData } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { CLAMP } from './clamp.ts';
import { clampTable } from './clamp/table.ts';
import { BASE, gridTable } from './table/test-util.ts';

/*
 * The render clamp of `ShapeObject.table` (design/27 M9, tables-object.md §4.8): a valid table comes out as
 * it went in; palette indices that name no entry fall back (the base style, no fill, no line, no run); one
 * font budget serves the whole table; the table's text, runs and edges are bounded.
 */

describe('clampTable', () => {
  it('keeps a valid table as it is', () => {
    const t = m9Table();
    expect(clampTable(t)).toEqual(t);
    const g = gridTable(3, 3);
    expect(clampTable(g)).toEqual(g);
  });

  it('drops what is not a table: the shape draws its legacy rect', () => {
    for (const bad of [
      null,
      'table',
      [],
      { ...gridTable(1, 1), cols: [] },
      { ...gridTable(1, 1), cols: [0, 0] },
      { ...gridTable(1, 1), cells: 'all' },
      { ...gridTable(1, 1), base: null },
      { ...gridTable(1, 1), rows: [] },
    ])
      expect(clampTable(bad)).toBeUndefined();
  });

  it('palette indices out of range fall back', () => {
    const t = clampTable({
      ...gridTable(1, 3),
      cells: [
        { text: 'a', style: 5, fill: 2, runs: [[0, 1, 9]], diag: { down: 7 } },
        { text: 'b', style: 0, fill: 0, runs: [[0, 1, 0]], diag: { up: 0 } },
        { text: 'c', style: -1, fill: 1.5 },
      ],
      styles: [{ fontWeight: 700 }],
      runStyles: [{ fontStyle: 'italic' }],
      fills: [{ color: BASE.color }],
      background: 3,
      h: [
        [0, 0, 3, 4],
        [1, 0, 3, 0],
      ],
    })!;
    expect(t.cells[0]).toEqual({ text: 'a', runs: [] });
    expect(t.cells[1]).toEqual({ text: 'b', style: 0, fill: 0, runs: [[0, 1, 0]], diag: { up: 0 } });
    expect(t.cells[2]).toEqual({ text: 'c' });
    expect(t).not.toHaveProperty('background');
    expect(t.h).toEqual([[1, 0, 3, 0]]);
  });

  it('keeps a malformed palette entry in its place, empty', () => {
    const t = clampTable({
      ...gridTable(1, 2),
      cells: [{ style: 1 }, { fill: 1 }],
      styles: ['x', { fontWeight: 300 }],
      fills: [7, { color: BASE.color }],
      lineStyles: [null, { width: 2, color: BASE.color }],
    })!;
    expect(t.styles).toEqual([{}, { fontWeight: 300 }]);
    expect(t.fills![0]!.color.a).toBe(0);
    expect(t.fills![1]).toEqual({ color: BASE.color });
    expect(t.lineStyles![0]).toEqual({ width: 0, color: { r: 0, g: 0, b: 0, a: 0 } });
  });

  it('one font budget per table', () => {
    const families = [...Array(40)].map((_, i) => `Family ${i}`);
    const t = clampTable({
      ...gridTable(1, 1),
      styles: families.slice(0, 20).map((fontFamily) => ({ fontFamily })),
      runStyles: families.slice(20).map((fontFamily) => ({ fontFamily })),
    })!;
    const named = new Set<string>([BASE.fontFamily]);
    for (const s of t.styles!) if (s.fontFamily) named.add(s.fontFamily);
    for (const s of t.runStyles!) if (s.fontFamily) named.add(s.fontFamily);
    expect(named.size).toBe(CLAMP.maxRunFamilies);
    // Size scales too: at most 64 distinct ones over the table.
    const scales = clampTable({
      ...gridTable(1, 1),
      runStyles: [...Array(200)].map((_, i) => ({ sizeScale: 0.5 + i / 100 })),
    })!.runStyles!;
    expect(new Set(scales.map((s) => s.sizeScale)).size).toBe(CLAMP.maxSizeScales);
  });

  it('text past 60,000 characters leaves later cells empty, runs and paragraphs bounded', () => {
    const cells = [...Array(8)].map(() => ({
      text: 'x'.repeat(TABLE_LIMITS.cellText + 5),
      runs: [...Array(2_500)].map((_, i) => [i, i + 1, 0] as [number, number, number]),
      paras: [...Array(1_200)].map(() => ({ align: 'center' as const })),
    }));
    const t = clampTable({ ...gridTable(2, 4), cells, runStyles: [{ fontWeight: 700 }] })!;
    const lengths = t.cells.map((c) => c.text?.length ?? 0);
    expect(lengths).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 0, 0]);
    expect(t.cells[6]).not.toHaveProperty('text');
    expect(t.cells[0]!.runs).toHaveLength(TABLE_LIMITS.cellRuns);
    expect(t.cells.reduce((n, c) => n + (c.runs?.length ?? 0), 0)).toBe(TABLE_LIMITS.tableRuns);
    // One paragraph style per paragraph: the 10,000 x are one paragraph.
    expect(t.cells[0]!.paras).toHaveLength(1);
  });

  it('runs are sorted, inside their text and apart; spans and edges are integers in range', () => {
    const t = clampTable({
      ...gridTable(3, 2),
      cells: [
        {
          text: 'hello',
          runs: [
            [3, 9, 0],
            [1, 2, 0],
            [5, 6, 0],
            [0.5, 1, 0],
          ],
          colSpan: 2.5,
          rowSpan: 0,
        },
        { text: 'x', colSpan: 99, rowSpan: 2 },
      ],
      runStyles: [{ fontWeight: 700 }],
      h: [
        [3, 0, 2, 0],
        [4, 0, 2, 0],
        [1, 1, 1, 0],
        [1, 0, 99, 0],
        [Number.NaN, 0, 1, 0],
      ],
      // Past the grid: cut to it; past the schema's 256: dropped.
      v: [
        [2, 0, 200, 0],
        [1, 0, 300, 0],
      ],
    })!;
    expect(t.cells[0]).toEqual({ text: 'hello', runs: [[3, 5, 0]] });
    expect(t.cells[1]).toEqual({ text: 'x', rowSpan: 2 });
    expect(t.h).toEqual([
      [3, 0, 2, 0],
      [1, 0, 2, 0],
    ]);
    expect(t.v).toEqual([[2, 0, 3, 0]]);
  });

  it('cuts rows past 4,096 grid slots and bounds every number', () => {
    const t = clampTable({
      ...gridTable(1, 64),
      rows: Array(256).fill(1e12),
      cols: Array(64)
        .fill(-5)
        .map((v, i) => (i ? v : Number.POSITIVE_INFINITY)),
    });
    expect(t).toBeUndefined(); // the columns sum to 0
    const ok = clampTable({ ...gridTable(1, 64), rows: Array(256).fill(1e12) })! as TableData;
    expect(ok.rows).toHaveLength(64);
    expect(ok.rows[0]).toBe(100_000);
  });
});
