import { type ShapeObject, slideBytes } from '@ordo/domain';
import { convertDeck } from '@ordo/pptx-scene';
import { denseTableDeck } from '@ordo/pptx-scene/test-util.ts';
import { PPTX_SHEETS } from '@ordo/pptx-scene/version.ts';
import { describe, expect, it } from 'vitest';
import {
  artKinds,
  bodyBoxes,
  bodyTexts,
  type Converted,
  type Draft,
  ImportCore,
  TABLE_PAGE_NOTE,
  toPicture,
} from './pptx-core.ts';
import { pictureGuardDeck } from './pptx-guard.test-util.ts';
import { ImportLog } from './pptx-report.ts';

const core = (lo: boolean) =>
  new ImportCore({ lo, log: new ImportLog(), warn: () => {}, geomFileBytes: 1 << 20 });

describe("ImportCore.budgetLeft: what the slide budgets' guard left out (M9, lo-forms)", () => {
  it('budgetLeft lists nothing when the guard sent its left-outs to the art', () => {
    const r = convertDeck(pictureGuardDeck(), { sheets: PPTX_SHEETS });
    const s = r.slides[0]!;
    // The converter planned LibreOffice's art for the topmost pictures and lists nothing.
    expect(s.art?.elements).toHaveLength(5);
    expect(s.missing).toBeUndefined();
    const d: Draft = {
      ref: r.listed[0]!,
      slide: s.slide,
      media: new Map(),
      cls: s.classification.class,
      notes: [],
      art: s.art,
    };
    core(true).budgetLeft(d, s);
    expect(d.dropped).toBeUndefined();
    expect(d.cls).toBe('hybrid');
    // If LibreOffice fails, the art's kinds say what the slide lacks.
    expect(artKinds(s.classification.reasons)).toEqual(['decoration']);
  });

  it('still lists what a scene says the guard left out (a converter that culled it)', () => {
    const r = convertDeck(pictureGuardDeck(), { sheets: PPTX_SHEETS, libreoffice: false });
    const s = r.slides[0]!;
    expect(s.missing).toEqual(['decoration']);
    const d: Draft = { ref: r.listed[0]!, slide: s.slide, media: new Map(), cls: 'native', notes: [] };
    core(true).budgetLeft(d, s);
    expect(d.dropped).toEqual(['decoration']);
    expect(d.cls).toBe('hybrid');
  });
});

/** A deck's drafts through the import core's budgets (step 3), as the hub's job and a client assembly run them. */
function budgeted(parts: ReturnType<typeof denseTableDeck>, lo: boolean) {
  const r = convertDeck(parts, { sheets: PPTX_SHEETS, libreoffice: lo });
  const log = new ImportLog();
  const c = new ImportCore({ lo, log, warn: () => {}, geomFileBytes: 1 << 20 });
  const converted = new Map<number, Converted>(r.slides.map((s) => [s.index, { s, media: new Map() }]));
  const scan = { pictures: [], picturesOver: 0, metafiles: [], notes: [], loop: false };
  const drafts = c.drafts(r.listed, converted, scan);
  const simplified = c.budget(drafts);
  return { d: drafts[0]!, simplified, log: log.toString(), emitted: r.slides[0]! };
}

const tableObjects = (d: Draft) =>
  d.slide.objects.filter((o) => o.type === 'shape' && (o as ShapeObject).table !== undefined);

describe('ImportCore.budget: a dense table (M9 tables-conv, the interim rule of question 3)', () => {
  it('no LibreOffice: native, one table object kept whole (before: the M6 group past 64 KB, stored minimal)', () => {
    // 140 cells: about 8 KB as the table object, about 95 KB as M6's group.
    const { d, simplified } = budgeted(denseTableDeck(28), false);
    expect(d.simplified).toBeFalsy();
    expect(simplified).toBe(0);
    expect(d.cls).toBe('native');
    expect(tableObjects(d)).toHaveLength(1);
    expect(d.dropped).toBeUndefined();
    expect(d.notes).not.toContain(TABLE_PAGE_NOTE);
    expect(d.tableGroupBytes).toBeUndefined();
    expect(slideBytes(d.slide)).toBeLessThan(16 * 1024);
  });

  it("with LibreOffice: a slide whose tables as their M6 group pass 64 KB keeps LibreOffice's page", () => {
    const { d, simplified, log, emitted } = budgeted(denseTableDeck(28), true);
    expect(d.cls).toBe('picture');
    expect(emitted.tableGroupBytes).toBeGreaterThan(64 * 1024);
    expect(d.slide.objects).toEqual([]);
    expect(d.notes).toContain(TABLE_PAGE_NOTE);
    expect(d.artText).toMatch(/^Day 1: Psalm 1, verses 1-9\nDay 1: Psalm 2/);
    expect(d.simplified).toBeFalsy();
    expect(simplified).toBe(0);
    expect(log).toMatch(
      /slide 1: its tables as shapes would be over 64 KB \(9\d KiB\): LibreOffice draws its page/,
    );
  });

  it('with LibreOffice: a table whose group stays within 64 KB, or that M6 never grouped (past 150 cells), stays native', () => {
    // 12 rows: about 40 KB as the group. 32 rows: 160 cells, M6 left it to LibreOffice's art unmeasured.
    for (const rows of [12, 32]) {
      const { d } = budgeted(denseTableDeck(rows), true);
      expect(d.cls, `${rows} rows`).toBe('native');
      expect(tableObjects(d), `${rows} rows`).toHaveLength(1);
      expect(d.notes).not.toContain(TABLE_PAGE_NOTE);
    }
  });
});

describe("a table object's cells are text bodies, as the M6 group's text objects were (M9 tables-conv)", () => {
  it("each cell at its place for a re-import's text match, and the slide's search text once it is a picture", () => {
    const { emitted, d } = budgeted(denseTableDeck(3), false);
    const t = (tableObjects(d)[0] as ShapeObject).table!;
    expect(t.cells).toHaveLength(15);
    const texts = bodyTexts(emitted);
    expect(texts).toHaveLength(15);
    expect(texts[0]).toBe('Day 1: Psalm 1, verses 1-9');
    expect(texts[14]).toBe('Day 3: Psalm 15, verses 5-13');
    const o = tableObjects(d)[0]!;
    const boxes = bodyBoxes(emitted);
    expect(boxes[0]!.box).toEqual({ x: o.box.x, y: o.box.y, w: t.cols[0], h: t.rows[0], rotation: 0 });
    expect(boxes[6]!.box).toMatchObject({ x: o.box.x + t.cols[0]!, y: o.box.y + t.rows[0]!, w: t.cols[1] });
    toPicture(d);
    expect(d.artText?.split('\n')).toEqual(texts);
  });
});
