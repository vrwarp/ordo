import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShapeObject, Slide } from '../packages/domain/src/index.ts';
import { slideBytes } from '../packages/domain/src/index.ts';
import { type Converted, ImportCore, TABLE_PAGE_NOTE } from '../packages/importers/src/pptx-core.ts';
import { ImportLog } from '../packages/importers/src/pptx-report.ts';
import { extractZip } from '../packages/importers/src/zip-stream.ts';
import { convertDeck, M9_WRITES, PPTX_SHEETS } from '../packages/pptx-scene/src/index.ts';
import { describe, expect, it } from 'vitest';
import { PLAN, TABLE, tableDeck } from './pptxdecks.ts';

const tableOf = (s: Slide) =>
  (s.objects as ShapeObject[]).find((o) => o.type === 'shape' && o.table !== undefined)?.table;

/**
 * The deck `pptx-tables.spec.ts` imports (`pptxdecks.ts` `tableDeck`) still tests what the spec is about: the
 * bulletin is past M6's cell cap (one table object on every hub, no group weighed), the reading plan within
 * it but past 64 KB as its M6 group (LibreOffice's page on a hub with it, the table object on one without).
 */
describe('the table deck of the end-to-end spec', () => {
  it("puts the bulletin past M6's cell cap and the reading plan's group past 64 KB", async () => {
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
        expect(bulletin!.tableGroupBytes).toBeUndefined();
        const t2 = tableOf(plan!.slide)!;
        expect(t2.cells).toHaveLength(PLAN.rows * PLAN.cols);
        expect(slideBytes(plan!.slide)).toBeLessThan(16 * 1024);
        if (lo) expect(slideBytes(plan!.slide) + plan!.tableGroupBytes!).toBeGreaterThan(64 * 1024);
        else expect(plan!.tableGroupBytes).toBeUndefined();
        // Through the import core's budgets: LibreOffice's page for the plan on a hub with it, else native.
        const log = new ImportLog();
        const core = new ImportCore({ lo, log, warn: () => {}, geomFileBytes: 1 << 20 });
        const converted = new Map<number, Converted>(r.slides.map((s) => [s.index, { s, media: new Map() }]));
        const scan = { pictures: [], picturesOver: 0, metafiles: [], notes: [], loop: false };
        const drafts = core.drafts(r.listed, converted, scan);
        core.budget(drafts);
        expect(drafts.map((d) => d.cls)).toEqual(lo ? ['native', 'picture'] : ['native', 'native']);
        expect(drafts[1]!.notes.includes(TABLE_PAGE_NOTE)).toBe(lo);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
