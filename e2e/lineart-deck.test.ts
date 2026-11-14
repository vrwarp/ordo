import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShapeObject } from '../packages/domain/src/index.ts';
import { extractZip } from '../packages/importers/src/zip-stream.ts';
import { emitSlides, M9_WRITES, PPTX_SHEETS, parseDeck } from '../packages/pptx-scene/src/index.ts';
import type { ShapeElement } from '../packages/pptx-scene/src/ir.ts';
import { GEOM_COST } from '../packages/renderer/src/geom/cost.ts';
import { clearGeomFiles, putGeomFile } from '../packages/renderer/src/geom/stored.ts';
import { drawnCost, slideBudget } from '../packages/renderer/src/geombudget.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { lineArtDeck, lineArtInk } from './pptxdecks.ts';

/**
 * The deck `pptx-lineart.spec.ts` imports (`pptxdecks.ts` `lineArtDeck`, built with the same `lineArtPath` as the
 * golden-pptx guard deck) still tests what the spec is about: the black line art on top is the one the slide's
 * drawing budget sends to its legacy copy (a line), so only a geometry unit draws it whole; and the ink the
 * spec compares the screens with is the converter's own even-odd reading of it.
 */
describe('the line-art deck of the end-to-end spec', () => {
  afterAll(() => clearGeomFiles());

  it('puts the black line art past the slide budget, drawn as a line without its unit', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ordo-lineart-deck-'));
    try {
      const zip = await extractZip(lineArtDeck(dir), { dir: join(dir, 'x'), spill: () => false });
      const scene = parseDeck(zip.files, { m9Writes: M9_WRITES, sheets: PPTX_SHEETS });
      const arts = (scene.slides[0]!.elements as ShapeElement[]).filter((e) => e.geom === 'custom');
      expect(arts.map((e) => e.name)).toEqual(['White line art', 'Navy line art', 'Black line art']);
      for (const e of arts) expect(e.custom!.fillCost).toBeLessThan(GEOM_COST.geometry);
      expect(arts[2]!.custom!.ink).toBeCloseTo(lineArtInk(), 3);

      const out = emitSlides(scene, { m9Writes: M9_WRITES, sheets: PPTX_SHEETS });
      clearGeomFiles();
      for (const g of out.geoms) putGeomFile(g.id, g.file);
      const objects = out.slides[0]!.slide.objects;
      const shapes = objects.filter((o): o is ShapeObject => o.type === 'shape' && o.geom?.ref !== undefined);
      expect(shapes).toHaveLength(3);
      const total = objects.reduce((a, o) => a + drawnCost(o).est + drawnCost(o).points * GEOM_COST.point, 0);
      expect(total).toBeGreaterThan(GEOM_COST.slide);
      const copies = [...slideBudget(objects)].filter(([, c]) => !('geom' in c));
      expect(copies.map(([o]) => o.id)).toEqual([shapes[2]!.id]);
      expect(copies[0]![1]).toMatchObject({ shape: 'line' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
