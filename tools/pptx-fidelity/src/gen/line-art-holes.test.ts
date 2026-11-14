import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ShapeObject } from '@ordo/domain';
import { extractZip } from '@ordo/importers/zip-stream.ts';
import { emitSlides, M9_WRITES, PPTX_SHEETS, parseDeck } from '@ordo/pptx-scene';
import type { ShapeElement } from '@ordo/pptx-scene/ir.ts';
import { lineArtPoints } from '@ordo/pptx-scene/test-util.ts';
import { GEOM_COST } from '@ordo/renderer/geom/cost.ts';
import { clearGeomFiles, putGeomFile } from '@ordo/renderer/geom/stored.ts';
import { drawnCost, slideBudget } from '@ordo/renderer/geombudget.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { LINE_ART_HOLES_PATH, lineArtHolesDeck } from './line-art-holes.ts';

/**
 * The golden-pptx guard deck (`line-art-holes.ts`): committed exactly as the generator writes it, listed in the
 * manifest with its generator, and still what it guards: three line-art paths past the slide's drawing budget
 * whose legacy shape is a line.
 */
const root = resolve(import.meta.dirname, '../../../..');
const file = join(root, LINE_ART_HOLES_PATH);

describe('line-art-holes.pptx (the golden-pptx guard deck)', () => {
  afterAll(() => clearGeomFiles());

  it('is committed byte for byte as the generator writes it, stored, every entry dated 1980-01-01', () => {
    const bytes = lineArtHolesDeck();
    expect(lineArtHolesDeck().equals(bytes)).toBe(true);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    // Each local header: stored (method 0), time 00:00, date 1980-01-01.
    let at = 0;
    let entries = 0;
    while (bytes.readUInt32LE(at) === 0x04034b50) {
      expect(bytes.readUInt16LE(at + 8)).toBe(0);
      expect(bytes.readUInt16LE(at + 10)).toBe(0);
      expect(bytes.readUInt16LE(at + 12)).toBe((1 << 5) | 1);
      at += 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt32LE(at + 18);
      entries++;
    }
    expect(entries).toBeGreaterThan(8);
  });

  it('is in the manifest with its generator instead of a source URL', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'golden-pptx/manifest.json'), 'utf8')) as {
      rel_path: string;
      generator?: string;
      source_url?: string;
      slide_count: number;
      file_size_bytes: number;
    }[];
    const entry = manifest.find((e) => `golden-pptx/${e.rel_path}` === LINE_ART_HOLES_PATH);
    expect(entry).toMatchObject({
      generator: 'tools/pptx-fidelity/src/gen/line-art-holes.ts',
      slide_count: 1,
      file_size_bytes: readFileSync(file).length,
    });
    expect(entry).not.toHaveProperty('source_url');
    expect(readFileSync(join(root, 'golden-pptx/README.md'), 'utf8')).toContain(
      '| [`line-art-holes.pptx`](challenging-features/custom-geometry/line-art-holes.pptx) |',
    );
  });

  it('holds three line-art paths past the slide budget, each within the geometry budget, drawn as lines past it', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ordo-lineart-'));
    try {
      const zip = await extractZip(file, { dir, spill: () => false });
      const scene = parseDeck(zip.files, { m9Writes: M9_WRITES, sheets: PPTX_SHEETS });
      const els = scene.slides[0]!.elements as ShapeElement[];
      const arts = els.filter((e) => e.kind === 'shape' && e.geom === 'custom');
      expect(arts).toHaveLength(3);
      for (const e of arts) {
        expect(e.custom!.points).toBe(lineArtPoints(40, 8));
        expect(e.custom!.points).toBeGreaterThan(4_096);
        // Past what the read points' coverage reads (4,096): unknown, as the leaf template's.
        expect(e.coverage).toBeUndefined();
        expect(e.custom!.ink).toBeLessThan(0.3);
        expect(e.custom!.fillCost).toBeLessThan(GEOM_COST.geometry);
      }
      const out = emitSlides(scene, { m9Writes: M9_WRITES, sheets: PPTX_SHEETS });
      clearGeomFiles();
      for (const g of out.geoms) putGeomFile(g.id, g.file);
      const objects = out.slides[0]!.slide.objects;
      const shapes = objects.filter((o): o is ShapeObject => o.type === 'shape' && o.geom?.ref !== undefined);
      expect(shapes.map((o) => [o.shape, o.fill?.r, o.fill?.g, o.fill?.b])).toEqual([
        ['line', 255, 255, 255],
        ['line', 31, 56, 100],
        ['line', 0, 0, 0],
      ]);
      // Together past GEOM_COST.slide: the budget draws the black one on top as its legacy copy.
      const total = objects.reduce((a, o) => a + drawnCost(o).est + drawnCost(o).points * GEOM_COST.point, 0);
      expect(total).toBeGreaterThan(GEOM_COST.slide);
      const copies = [...slideBudget(objects)].filter(([, c]) => !('geom' in c));
      expect(copies.map(([o]) => o.id)).toEqual([shapes[2]!.id]);
      expect(copies[0]![1]).toMatchObject({ shape: 'line' });
      expect(out.slides[0]!.notes.join(' ')).toMatch(/drawn whole from a geometry unit on outputs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
