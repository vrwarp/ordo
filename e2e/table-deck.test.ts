import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShapeObject, Slide } from '../packages/domain/src/index.ts';
import { slideBytes } from '../packages/domain/src/index.ts';
import { type Converted, ImportCore } from '../packages/importers/src/pptx-core.ts';
import { ImportLog } from '../packages/importers/src/pptx-report.ts';
import { extractZip } from '../packages/importers/src/zip-stream.ts';
import { storedSlideBytes } from '../packages/pptx-scene/src/emit-budget.ts';
import { convertDeck, M9_WRITES, PPTX_SHEETS } from '../packages/pptx-scene/src/index.ts';
import { describe, expect, it } from 'vitest';
import { PLAN, TABLE, tableDeck, VERTICAL_TABLE, verticalTableDeck } from './pptxdecks.ts';

const tableOf = (s: Slide) =>
  (s.objects as ShapeObject[]).find((o) => o.type === 'shape' && o.table !== undefined)?.table;
/** The kill switch (`m9Writes` without 'table'): tables written as their M6 group. */
const KILL = new Set([...M9_WRITES].filter((f) => f !== 'table'));

/**
 * The deck `pptx-tables.spec.ts` imports (`pptxdecks.ts` `tableDeck`) still tests what the spec is about: the
 * bulletin is past M6's cell cap, the reading plan within it but past 64 KB as its M6 group (what the kill switch
 * writes), and both are one table object on every hub (the owner: every table is the table object).
 */
describe('the table deck of the end-to-end spec', () => {
  it("puts the bulletin past M6's cell cap and the reading plan's group past 64 KB: table objects on both hubs", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ordo-table-deck-'));
    try {
      const zip = await extractZip(await tableDeck(dir), { dir: join(dir, 'x'), spill: () => false });
      for (const lo of [true, false]) {
        const r = convertDeck(zip.files, { m9Writes: M9_WRITES, sheets: PPTX_SHEETS, libreoffice: lo });
        const [bulletin, plan] = r.slides;
        const t1 = tableOf(bulletin!.slide)!;
        expect(t1.cells).toHaveLength(TABLE.rows * TABLE.cols.length - 1);
        expect(t1.cells.some((c) => c.colSpan === 2)).toBe(true);
        expect(bulletin!.classification.class).toBe('native');
        const t2 = tableOf(plan!.slide)!;
        expect(t2.cells).toHaveLength(PLAN.rows * PLAN.cols);
        expect(slideBytes(plan!.slide)).toBeLessThan(16 * 1024);
        // Through the import core's budgets: both slides native, the table object, on both kinds of hub.
        const log = new ImportLog();
        const core = new ImportCore({ lo, log, warn: () => {}, geomFileBytes: 1 << 20 });
        const converted = new Map<number, Converted>(r.slides.map((s) => [s.index, { s, media: new Map() }]));
        const scan = { pictures: [], picturesOver: 0, metafiles: [], notes: [], loop: false };
        const drafts = core.drafts(r.listed, converted, scan);
        core.budget(drafts);
        expect(drafts.map((d) => d.cls)).toEqual(['native', 'native']);
        expect(
          drafts.map((d) => d.slide.objects.filter((o) => tableOf({ ...d.slide, objects: [o] })).length),
        ).toEqual([1, 1]);
        for (const d of drafts) expect(d.notes.some((n) => /LibreOffice draws its page/.test(n))).toBe(false);
        expect(log.toString()).not.toMatch(/LibreOffice draws its page/);
        // No M6 group weighed on any hub (no second emission).
        for (const s of [bulletin!, plan!]) expect(s).not.toHaveProperty('tableGroupBytes');
        // The guard keeps its measure: with the kill switch the reading plan's slide (its M6 group, its grid
        // geometries in files as stored) is past 64 KB.
        const kill = convertDeck(zip.files, { m9Writes: KILL, sheets: PPTX_SHEETS, libreoffice: lo });
        expect(tableOf(kill.slides[1]!.slide)).toBeUndefined();
        expect(storedSlideBytes(kill.slides[1]!.slide, kill.slides[1]!.notes)).toBeGreaterThan(64 * 1024);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The vertical-cell deck `pptx-tables.spec.ts` imports (`verticalTableDeck`): one table with East Asian vertical
 * cells and a table outer shadow, which since sub-wave 1c (rule V) is one table object on both kinds of hub, the
 * cells' vert kept, the shadow noted and not stored (before: LibreOffice's art with it, missing without it).
 */
describe('the vertical-cell deck of the end-to-end spec', () => {
  it('is one table object on both kinds of hub, its eaVert cells kept, no stored shadow, the shadow noted', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ordo-vertical-deck-'));
    try {
      const zip = await extractZip(verticalTableDeck(dir), { dir: join(dir, 'x'), spill: () => false });
      for (const lo of [true, false]) {
        const r = convertDeck(zip.files, { m9Writes: M9_WRITES, sheets: PPTX_SHEETS, libreoffice: lo });
        expect(r.slides).toHaveLength(1);
        const s = r.slides[0]!;
        expect(s.classification.class).toBe('native');
        expect(s.classification.reasons.filter((x) => x.startsWith('art:'))).toEqual([]);
        expect(s.notes).toContain("a table's shadow is not drawn");
        expect(s.notes).not.toContain('a table with vertical cell text is drawn by LibreOffice (M8)');
        const objects = s.slide.objects as ShapeObject[];
        const tables = objects.filter((o) => o.type === 'shape' && o.table !== undefined);
        expect(tables).toHaveLength(1);
        expect(tables[0]!.shadow).toBeUndefined();
        const t = tables[0]!.table!;
        expect(t.cells).toHaveLength(VERTICAL_TABLE.rows * 2 + 2);
        for (const [text, i] of VERTICAL_TABLE.vertical) {
          expect(t.cells[i]!.text).toBe(text);
          expect(t.cells[i]!.rowSpan).toBe(4);
          expect(t.styles?.[t.cells[i]!.style!]?.vert).toBe('eaVert');
        }
        // The other cells are horizontal.
        const verts = t.cells.map((c) => (c.style === undefined ? undefined : t.styles?.[c.style]?.vert));
        expect(verts.filter((v) => v !== undefined)).toHaveLength(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
