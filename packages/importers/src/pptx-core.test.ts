import { type ShapeObject, slideBytes } from '@ordo/domain';
import { type ConvertOptions, convertDeck } from '@ordo/pptx-scene';
import { storedSlideBytes } from '@ordo/pptx-scene/emit-budget.ts';
import { M9_FIELDS } from '@ordo/pptx-scene/emit-ctx.ts';
import { denseTableDeck, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { PPTX_SHEETS } from '@ordo/pptx-scene/version.ts';
import { describe, expect, it } from 'vitest';
import {
  artKinds,
  bodyBoxes,
  bodyTexts,
  type Converted,
  type Draft,
  ImportCore,
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
function budgeted(parts: ReturnType<typeof denseTableDeck>, lo: boolean, opts: ConvertOptions = {}) {
  const r = convertDeck(parts, { sheets: PPTX_SHEETS, libreoffice: lo, ...opts });
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
/** The kill switch (`m9Writes` without 'table'): tables are written as their M6 group. */
const NO_TABLE = { m9Writes: new Set(M9_FIELDS.filter((f) => f !== 'table')) };
/** The words of a slide that keeps LibreOffice's page for its size (`ImportCore.pageForBudget`). */
const PAGE = /LibreOffice draws its page/;

/** `denseTableDeck(rows)` with a decoration shape under the table, which a slide past 64 KB may leave out. */
function withDecoration(rows: number): ReturnType<typeof denseTableDeck> {
  const parts = denseTableDeck(rows);
  const name = 'ppt/slides/slide1.xml';
  const xml = new TextDecoder().decode(parts.get(name));
  const deco = sp({ id: 3, x: 0, y: 0, cx: 914_400, cy: 914_400, fill: solid('FFCC00') });
  parts.set(name, new TextEncoder().encode(xml.replace('<p:graphicFrame>', `${deco}<p:graphicFrame>`)));
  return parts;
}

describe('ImportCore.budget: a dense table is the table object on every hub (M9, the owner: every table)', () => {
  it('no LibreOffice: native, one table object kept whole (before: the M6 group past 64 KB, stored minimal)', () => {
    // 140 cells: about 8 KB as the table object, about 95 KB as M6's group.
    const { d, simplified } = budgeted(denseTableDeck(28), false);
    expect(d.simplified).toBeFalsy();
    expect(simplified).toBe(0);
    expect(d.cls).toBe('native');
    expect(tableObjects(d)).toHaveLength(1);
    expect(d.dropped).toBeUndefined();
    expect(d.notes.filter((n) => PAGE.test(n))).toEqual([]);
    expect(d).not.toHaveProperty('tableGroupBytes');
    expect(slideBytes(d.slide)).toBeLessThan(16 * 1024);
  });

  it('with LibreOffice, a slide whose tables as their M6 group would pass 64 KB is the table object', () => {
    // The kill switch's slide (the M6 group) as stored: past 64 KB, as the interim rule weighed it.
    const group = budgeted(denseTableDeck(28), true, NO_TABLE).emitted;
    expect(storedSlideBytes(group.slide, [])).toBeGreaterThan(64 * 1024);
    const { d, simplified, log, emitted } = budgeted(denseTableDeck(28), true);
    expect(d.cls).toBe('native');
    expect(tableObjects(d)).toHaveLength(1);
    expect((tableObjects(d)[0] as ShapeObject).table!.cells).toHaveLength(140);
    expect(d.notes.filter((n) => PAGE.test(n))).toEqual([]);
    expect(log).not.toMatch(PAGE);
    expect(d.artText).toBeUndefined();
    expect(d.simplified).toBeFalsy();
    expect(simplified).toBe(0);
    // No second emission: the converter weighs no M6 group, and the draft carries none.
    expect(emitted).not.toHaveProperty('tableGroupBytes');
    expect(d).not.toHaveProperty('tableGroupBytes');
    // As a hub without LibreOffice stores it.
    const nolo = budgeted(denseTableDeck(28), false).d;
    expect(d.slide).toEqual({ ...nolo.slide, id: d.slide.id });
    expect(d.notes).toEqual(nolo.notes);
  });

  it('with LibreOffice: a table whose group stays within 64 KB, or that M6 never grouped (past 150 cells), stays native', () => {
    // 12 rows: about 40 KB as the group. 32 rows: 160 cells, M6 left it to LibreOffice's art unmeasured.
    for (const rows of [12, 32]) {
      const { d } = budgeted(denseTableDeck(rows), true);
      expect(d.cls, `${rows} rows`).toBe('native');
      expect(tableObjects(d), `${rows} rows`).toHaveLength(1);
      expect(d.notes.filter((n) => PAGE.test(n))).toEqual([]);
    }
  });

  it("the kill switch on a hub with LibreOffice: the M6 group past 64 KB is LibreOffice's page by the generic rule", () => {
    const { d, log, emitted } = budgeted(denseTableDeck(28), true, NO_TABLE);
    expect(storedSlideBytes(emitted.slide, [])).toBeGreaterThan(64 * 1024);
    expect(d.cls).toBe('picture');
    expect(d.slide.objects).toEqual([]);
    expect(d.notes).toContain('over 64 KB: LibreOffice draws its page');
    expect(d.artText).toMatch(/^Day 1: Psalm 1, verses 1-9\nDay 1: Psalm 2/);
    expect(log).toMatch(
      /slide 1 is over 64 KB: LibreOffice draws its page \(fitted, it would leave out its decorations\)/,
    );
  });

  it("a table object past 64 KB stays the table object with LibreOffice, at the ladder's level (never LibreOffice's page)", () => {
    // 250 rows, 1,250 cells: about 69 KB as the table object. The table alone has nothing the ladder may leave
    // out: stored whole on both hubs, over the budget (its text).
    for (const lo of [true, false]) {
      const { d } = budgeted(denseTableDeck(250), lo);
      expect(d.cls, `lo ${lo}`).toBe('native');
      expect((tableObjects(d)[0] as ShapeObject).table!.cells).toHaveLength(1_250);
      expect(slideBytes(d.slide)).toBeGreaterThan(64 * 1024);
    }
    // With a decoration the ladder leaves out ('minimal'): before the owner's 'every table', LibreOffice's page
    // on a hub with LibreOffice (the generic rule); now the table object, the decoration listed missing, as on a
    // hub without LibreOffice.
    const nolo = budgeted(withDecoration(250), false);
    for (const { d, log } of [budgeted(withDecoration(250), true), nolo]) {
      expect(d.cls).toBe('hybrid');
      expect(tableObjects(d)).toHaveLength(1);
      expect((tableObjects(d)[0] as ShapeObject).table!.cells).toHaveLength(1_250);
      // The decoration (shape 3) is what the ladder left out; the page's background stays.
      expect(d.slide.objects.some((o) => o.origin?.shapeId === 3)).toBe(false);
      expect(d.dropped).toEqual(['decoration']);
      expect(d.simplified).toBe(true);
      expect(d.notes).toContain('simplified to fit the slide budget: 1 decoration shape(s) left out');
      expect(d.notes.filter((n) => PAGE.test(n))).toEqual([]);
      expect(log).not.toMatch(PAGE);
      expect(d.notes).toEqual(nolo.d.notes);
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
