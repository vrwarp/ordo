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
import { PLAN, TABLE, tableDeck } from './pptxdecks.ts';

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
