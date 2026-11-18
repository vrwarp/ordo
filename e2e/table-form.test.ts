import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShapeObject, Slide } from '../packages/domain/src/index.ts';
import { extractZip } from '../packages/importers/src/zip-stream.ts';
import { convertDeck, M9_WRITES, PPTX_SHEETS } from '../packages/pptx-scene/src/index.ts';
import { describe, expect, it } from 'vitest';
import { tableDeck } from './pptxdecks.ts';

const tableObject = (s: Slide) =>
  (s.objects as ShapeObject[]).find((o) => o.type === 'shape' && o.table !== undefined);

/**
 * The deck `pptx-tables.spec.ts` and `pptx-table-edit.spec.ts` import (`pptxdecks.ts` `tableDeck`): every hub
 * stores its tables in LibreOffice's form (design/27 §15 "The stored form"), so the table objects the converter
 * writes are the same whether or not the harness's LibreOffice policies (`loCompat`) are asked for.
 */
describe("the table deck's table objects in LibreOffice's form", () => {
  it('are the same with and without loCompat: grid, fixed rows, sizes and insets', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ordo-table-form-'));
    try {
      const zip = await extractZip(await tableDeck(dir), { dir: join(dir, 'x'), spill: () => false });
      const opts = { m9Writes: M9_WRITES, sheets: PPTX_SHEETS, libreoffice: false };
      const own = convertDeck(zip.files, opts).slides;
      const lo = convertDeck(zip.files, { ...opts, loCompat: true }).slides;
      expect(own).toHaveLength(2);
      for (const [k, s] of own.entries()) {
        const a = tableObject(s.slide)!;
        const b = tableObject(lo[k]!.slide)!;
        expect(a.table!.rowRule, `slide ${k + 1}`).toBe('fixed');
        expect(a.box, `slide ${k + 1}`).toEqual(b.box);
        expect(a.table, `slide ${k + 1}`).toEqual(b.table);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
