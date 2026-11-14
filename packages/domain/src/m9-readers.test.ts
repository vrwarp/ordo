import { describe, expect, it } from 'vitest';
import {
  chartFamilies,
  chartText,
  drawnDecorRefs,
  drawnShapeFileRefs,
  extraFontFamilies,
  objectSearchText,
  READER_TEXT_MAX,
  tableCellRows,
  tableFamilies,
  tableText,
} from './m9-readers.ts';
import { m9Chart, m9Slide, m9Table } from './m9.test-util.ts';
import { referencedFontFamilies, scriptFontFamilies } from './resolve.ts';
import { Presentation, type ShapeObject, type Slide, type SlideObject } from './schemas.ts';

/** The M9 readers (design/27 M9): search text, the font scan and the shape files a slide draws. */

function deck(slides: Slide[]): Presentation {
  return Presentation.parse({
    id: 'p',
    title: 'Deck',
    kind: 'slides',
    sections: [{ id: 's', label: 'Slides', short: 'S', slides }],
  });
}
const obj = (s: Slide, id: string) => s.objects.find((o) => o.id === id)!;

describe('font families', () => {
  it('referencedFontFamilies covers table, chart and vectorFonts families', () => {
    const fam = referencedFontFamilies([deck([m9Slide()])], []);
    // Table: base, cell styles with their fallbacks, run styles.
    for (const f of ['Calibri', 'Malgun Gothic', 'Noto Sans KR', 'Georgia']) expect(fam).toContain(f);
    // Chart: its text styles and their fallbacks.
    for (const f of ['Calibri Light', 'Carlito']) expect(fam).toContain(f);
    // A vector picture's families.
    for (const f of ['Arial', 'Symbol']) expect(fam).toContain(f);
  });

  it('names each source of a family once, and nothing for other objects', () => {
    expect(tableFamilies(m9Table()).sort()).toEqual(['Calibri', 'Georgia', 'Malgun Gothic', 'Noto Sans KR']);
    expect(chartFamilies(m9Chart()).sort()).toEqual(['Calibri', 'Calibri Light', 'Carlito']);
    const s = m9Slide();
    expect(extraFontFamilies(obj(s, 'emf'))).toEqual(['Arial', 'Symbol']);
    expect(extraFontFamilies(obj(s, 'decor'))).toEqual([]);
    expect(extraFontFamilies(obj(s, 'title'))).toEqual([]);
    expect(extraFontFamilies(undefined)).toEqual([]);
  });

  it('the script scan reads table cells and chart text', () => {
    const s = m9Slide();
    const tableOnly: Slide = { id: 't', objects: [obj(s, 'table')] };
    expect([...scriptFontFamilies([deck([tableOnly])])]).toEqual(['Noto Sans KR']);
    const chart = obj(s, 'chart') as ShapeObject;
    const greek: SlideObject = { ...chart, chart: { ...chart.chart!, categories: ['Ἀλληλούϊα'] } };
    expect([...scriptFontFamilies([deck([{ id: 'c', objects: [greek] }])])]).toEqual(['Noto Sans']);
  });
});

describe('search text', () => {
  it('search text includes table cells and chart titles', () => {
    const s = m9Slide();
    const table = objectSearchText(obj(s, 'table'));
    expect(table).toContain('Psalm 23');
    expect(table).toContain('찬양과 경배');
    // Automatic numbers are written as text, as readableText does for a text object.
    expect(table).toContain('1.\u{a0}Call to worship Opening hymn');
    const chart = objectSearchText(obj(s, 'chart'));
    for (const t of ['Our church in 2026', 'People', 'Giving', 'Visitors', 'Week 12'])
      expect(chart).toContain(t);
    expect(objectSearchText(obj(s, 'title'))).toBe('He is risen!');
    expect(objectSearchText(obj(s, 'decor'))).toBe('');
    expect(objectSearchText(obj(s, 'emf'))).toBe('');
  });

  it('tableText lays rows by newline and cells by tab, merged cells once', () => {
    expect(tableText(m9Table())).toBe(
      [
        'Time\tPart\tLeader',
        '10:00\t1.\u{a0}Call to worship Opening hymn\tPsalm 23\tPastor Kim',
        '10:15\t찬양과 경배\tWorship team',
        '10:40\tSermon: The Good Shepherd\tPastor Kim',
        '11:20\tBenediction',
      ].join('\n'),
    );
  });

  it('chartText is the title, the axis titles, the series names and the categories', () => {
    const lines = chartText(m9Chart()).split('\n');
    expect(lines.slice(0, 5)).toEqual(['Our church in 2026', 'People', 'Giving', 'Attendance', 'Visitors']);
    expect(lines.slice(5)).toEqual([...Array(12)].map((_, i) => `Week ${i + 1}`));
  });

  it('is bounded and never throws on malformed tables and charts', () => {
    const big = {
      ...m9Table(),
      cells: Array(4_096).fill({ text: 'x'.repeat(10_000) }),
      rows: Array(256).fill(1),
    };
    expect(tableText(big).length).toBe(READER_TEXT_MAX);
    const many = m9Chart();
    many.categories = Array(1_024).fill('y'.repeat(255));
    expect(chartText(many).length).toBe(READER_TEXT_MAX);
    for (const bad of [undefined, null, 7, 'x', [], { cells: 'x' }, { cells: [null, 3, { text: 5 }] }])
      expect(tableText(bad as never)).toBe('');
    for (const bad of [undefined, null, 7, { groups: [null, { series: 'x' }] }, { title: { text: 3 } }])
      expect(chartText(bad as never)).toBe('');
  });
});

describe('table placement', () => {
  it('places cells row-major at the next free slot and cuts a span at a covered slot or the edge', () => {
    // 2 × 2: (0,0) spans down; (0,1); then the next free slot is (1,1), where a colSpan of 2 is cut to 1;
    // the fourth cell is past the grid.
    const t = { cols: [1, 1], rows: [1, 1], cells: [{ rowSpan: 2 }, {}, { colSpan: 2 }, {}] };
    expect(tableCellRows(t)).toEqual([0, 0, 1, -1]);
    // A row span is cut where a cell placed earlier covers the slot below.
    const u = {
      cols: [1, 1, 1],
      rows: [1, 1, 1],
      cells: [{}, { rowSpan: 3 }, {}, { colSpan: 2, rowSpan: 2 }],
    };
    // (0,0) (0,1)↓↓ (0,2); then (1,0) wants 2 columns but (1,1) is covered: cut to 1 column, 2 rows.
    expect(tableCellRows(u)).toEqual([0, 0, 0, 1]);
    expect(tableCellRows({ cols: [], rows: [1], cells: [{}] })).toEqual([-1]);
  });
});

describe('drawnShapeFileRefs', () => {
  it('drawnShapeFileRefs lists geom.ref and decor.ref', () => {
    const s = m9Slide();
    const decor = obj(s, 'decor') as ShapeObject;
    decor.decor = { ...decor.decor!, ref: 'd'.repeat(64) };
    const pie = obj(s, 'pie') as ShapeObject;
    pie.geom = { ...pie.geom!, ref: 'g'.repeat(64) };
    s.objects.push({
      id: 'masked',
      type: 'image',
      box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
      mediaId: 'm',
      fit: 'contain',
      opacity: 1,
      radius: 0,
      mask: { ref: 'g'.repeat(64) },
    });
    // In drawing order, once each.
    expect(drawnShapeFileRefs(s)).toEqual(['d'.repeat(64), 'g'.repeat(64)]);
    // The decorations' refs alone: what a drawer reads into its decoration store.
    expect(drawnDecorRefs(s)).toEqual(['d'.repeat(64)]);
  });

  it('lists only what the slide draws: not the imported objects behind its PowerPoint picture', () => {
    const s = m9Slide();
    const decor = obj(s, 'decor') as ShapeObject;
    decor.decor = { ...decor.decor!, ref: 'pptxdecor:1' };
    expect(drawnShapeFileRefs(s)).toEqual(['pptxdecor:1']);
    expect(drawnDecorRefs(s)).toEqual(['pptxdecor:1']);
    s.pptx = { ...s.pptx!, show: 'picture', refMediaId: 'ref' };
    expect(drawnShapeFileRefs(s)).toEqual([]);
    expect(drawnDecorRefs(s)).toEqual([]);
  });
});
