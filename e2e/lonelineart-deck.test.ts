import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShapeObject } from '../packages/domain/src/index.ts';
import { extractZip } from '../packages/importers/src/zip-stream.ts';
import { emitSlides, M9_WRITES, PPTX_SHEETS, parseDeck } from '../packages/pptx-scene/src/index.ts';
import type { ShapeElement } from '../packages/pptx-scene/src/ir.ts';
import { charged, GEOM_COST } from '../packages/renderer/src/geom/cost.ts';
import { clearGeomFiles, putGeomFile } from '../packages/renderer/src/geom/stored.ts';
import { drawnCost, slideBudget } from '../packages/renderer/src/geombudget.ts';
import { slideUnitsLeft } from '../packages/renderer/src/units.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { LONE_CHAIN, loneLineArtDeck } from './pptxdecks.ts';

/**
 * The deck `effect-units.spec.ts` imports for its lone line art (`pptxdecks.ts` `loneLineArtDeck`): one thin
 * chain whose drawing alone passes the slide's drawing budget, which no single draw call within a task draws.
 * At 62a1c3a such a shape got no unit (`slideUnitsLeft` 'alone', the census's one failing case) and its legacy
 * copy, a line, drew nothing on the outputs.
 */
describe('the lone line-art deck of the effect-units spec', () => {
  afterAll(() => clearGeomFiles());

  it('holds one stored geometry past GEOM_COST.slide on its own', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ordo-lonelineart-deck-'));
    try {
      const zip = await extractZip(loneLineArtDeck(dir), { dir: join(dir, 'x'), spill: () => false });
      const scene = parseDeck(zip.files, { m9Writes: M9_WRITES, sheets: PPTX_SHEETS });
      const arts = (scene.slides[0]!.elements as ShapeElement[]).filter((e) => e.geom === 'custom');
      expect(arts.map((e) => e.name)).toEqual(['Lone chain']);
      expect(arts[0]!.custom!.fillCost ?? 0).toBeLessThan(GEOM_COST.geometry);

      const out = emitSlides(scene, { m9Writes: M9_WRITES, sheets: PPTX_SHEETS });
      clearGeomFiles();
      for (const g of out.geoms) putGeomFile(g.id, g.file);
      const objects = out.slides[0]!.slide.objects;
      const chain = objects.filter((o): o is ShapeObject => o.type === 'shape' && o.geom?.ref !== undefined);
      expect(chain).toHaveLength(1);
      const rated = drawnCost(chain[0]!);
      expect(rated.points).toBe(LONE_CHAIN.links * (LONE_CHAIN.sides + 1));
      // Past the slide's budget alone: no draw call within a task draws it at once.
      console.log(
        `lone chain: ${rated.points} points, charged ${Math.round(charged(rated))} (GEOM_COST.slide ${GEOM_COST.slide})`,
      );
      expect(charged(rated)).toBeGreaterThan(GEOM_COST.slide);
      const copies = [...slideBudget(objects)];
      expect(copies.map(([o]) => o.id)).toEqual([chain[0]!.id]);
      expect(copies[0]![1]).toMatchObject({ shape: 'line' });
      // 62a1c3a: no unit, its legacy copy (a line without a fill) draws nothing.
      expect(slideUnitsLeft(objects, 2)).toEqual(['alone']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
