import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDeck, custGeom, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs } from './args.ts';
import { censusRow, parseCensusArgs } from './census.ts';
import { convertDeck } from './native.ts';
import { rasterColumns, sweepLine, sweepTable } from './raster-census.ts';
import { zipStore } from './table-probe.ts';

/**
 * The census columns of the pictures of many-point shapes (Q53, C-SR11, M-SR2): a synthetic deck of outlines of 100, 200 and 300
 * points with small squares between them, read with the pictures planned (`ConvertOptions.rasters`) and counted, never drawn.
 */
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const IN = 914_400;
function poly(cost: number, phase: number): string {
  const n = cost - 2;
  const pt = (i: number) => {
    const a = (2 * Math.PI * i) / (n + 1) + phase * 0.01;
    return `<a:pt x="${Math.round(50_000 + 50_000 * Math.cos(a))}" y="${Math.round(50_000 + 50_000 * Math.sin(a))}"/>`;
  };
  let d = `<a:moveTo>${pt(0)}</a:moveTo>`;
  for (let i = 1; i <= n; i++) d += `<a:lnTo>${pt(i)}</a:lnTo>`;
  return `<a:path w="100000" h="100000">${d}<a:close/></a:path>`;
}
const outline = (id: number, cost: number, x: number) =>
  sp({
    id,
    x,
    y: IN,
    cx: IN,
    cy: IN,
    geom: 'none',
    fill: custGeom({ paths: poly(cost, id) }) + solid('3366AA'),
  });
const square = (id: number, x: number) =>
  sp({ id, x, y: 3 * IN, cx: 90_000, cy: 90_000, fill: solid('AA3366') });

async function deckFile(): Promise<{ file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ordo-raster-census-'));
  dirs.push(dir);
  const shapes =
    outline(2, 100, IN) +
    square(10, 2 * IN) +
    square(11, 2 * IN + 100_000) +
    outline(3, 200, 3 * IN) +
    outline(4, 300, 5 * IN);
  const file = join(dir, 'outlines.pptx');
  await writeFile(file, zipStore([...buildDeck({ slides: [{ shapes }] }).entries()]));
  return { file, dir };
}

describe('the census columns of the pictures of many-point shapes', () => {
  it('count the runs, shapes, points and recipe bytes of a slide; a deck read without the option has none', async () => {
    const { file, dir } = await deckFile();
    const plain = await convertDeck(file, join(dir, 'plain'));
    expect(plain.slides[0]!.rasters).toBeUndefined();
    expect(rasterColumns(plain.slides[0]!.rasters)).toEqual({});

    const planned = await convertDeck(file, join(dir, 'planned'), { rasters: {} });
    const r = planned.slides[0]!.rasters!;
    // 200 and 300 points are more than 128: two candidates and one run of the two (the 100-point outline and the squares before the
    // first of them are shapes; a run takes the small shapes BETWEEN candidates, Q53.e).
    expect(r).toMatchObject({ candidates: 2, runs: 1, pictures: 1, shapes: 2, words: 0 });
    expect(r.points).toBeGreaterThanOrEqual(500);
    expect(r.bytes).toBeGreaterThan(500);
    const cols = rasterColumns(r);
    expect(cols).toMatchObject({
      rasterCandidates: 2,
      rasterRuns: 1,
      rasterPictures: 1,
      rasterShapes: 2,
      rasterSkipped: 0,
      rasterWords: 0,
    });
    expect(cols.rasterPoints).toBe(r.points);
    expect(cols.rasterBytes).toBe(r.bytes);
    // The census row of the deck carries them per slide, and the slide counts one object for the picture.
    const row = censusRow(planned, { folder: dir, deck: 1, name: 'outlines.pptx', ms: 1 }) as {
      slides: Record<string, unknown>[];
    };
    expect(row.slides[0]).toMatchObject({ rasterRuns: 1, rasterShapes: 2, rasterPictures: 1 });
  });

  it('the threshold of the sweep moves what is a candidate: 64 takes the 100-point outline too, 512 takes none', async () => {
    const { file, dir } = await deckFile();
    const at = async (points: number) =>
      (await convertDeck(file, join(dir, `p${points}`), { rasters: { points } })).slides[0]!.rasters;
    expect(await at(64)).toMatchObject({ candidates: 3, shapes: 5 });
    expect(await at(128)).toMatchObject({ candidates: 2, shapes: 2 });
    expect(await at(256)).toMatchObject({ candidates: 1 });
    expect(await at(512)).toBeUndefined();
  });

  it('read the flags: --rasters, --raster-points N (implies --rasters) for the census and the harness', () => {
    expect(parseCensusArgs(['--out', 'c.jsonl', 'a'])).not.toHaveProperty('rasters');
    expect(parseCensusArgs(['--rasters', '--out', 'c.jsonl', 'a'])).toMatchObject({ rasters: {} });
    expect(parseCensusArgs(['--raster-points', '256', '--out', 'c.jsonl', 'a'])).toMatchObject({
      rasters: { points: 256 },
    });
    expect(() => parseCensusArgs(['--raster-points', 'x', '--out', 'c.jsonl', 'a'])).toThrow(/whole number/);
    expect(() => parseCensusArgs(['--raster-points', '0', '--out', 'c.jsonl', 'a'])).toThrow(/whole number/);
    expect(parseArgs(['d'])).toMatchObject({ rasters: false });
    expect(parseArgs(['d'])).not.toHaveProperty('rasterPoints');
    expect(parseArgs(['--rasters', 'd'])).toMatchObject({ rasters: true });
    expect(parseArgs(['--raster-points', '64', 'd'])).toMatchObject({ rasters: true, rasterPoints: 64 });
    expect(() => parseArgs(['--raster-points', '1.5', 'd'])).toThrow(/whole number/);
    expect(() => parseArgs(['--raster-points'])).toThrow(/needs a value/);
  });

  it('sweepLine and sweepTable reduce the rows of a census to one line a threshold', () => {
    const today = [
      {
        name: 'a',
        slides: [
          { objects: 400, class: 'picture' },
          { objects: 5, class: 'native' },
        ],
      },
      { name: 'b', error: 'unreadable' },
    ];
    const after = [
      {
        name: 'a',
        slides: [
          {
            objects: 20,
            class: 'native',
            rasterCandidates: 3,
            rasterRuns: 2,
            rasterPictures: 2,
            rasterShapes: 40,
            rasterSkipped: 1,
            rasterPoints: 900,
            rasterBytes: 5000,
            rasterWords: 1,
          },
          { objects: 5, class: 'native' },
        ],
      },
    ];
    const lines = [sweepLine(undefined, today), sweepLine(128, after)];
    expect(lines[0]).toMatchObject({
      decks: 1,
      slides: 2,
      over200: 1,
      notNative: 1,
      maxObjects: 400,
      runs: 0,
    });
    expect(lines[1]).toMatchObject({
      decks: 1,
      decksWithRuns: 1,
      slides: 2,
      slidesWithRuns: 1,
      candidates: 3,
      runs: 2,
      pictures: 2,
      shapes: 40,
      skipped: 1,
      words: 1,
      recipePoints: 900,
      recipeBytes: 5000,
      over200: 0,
      notNative: 0,
      maxSlideBytes: 5000,
      maxPictures: 2,
    });
    const table = sweepTable(lines).split('\n');
    expect(table).toHaveLength(4);
    expect(table[2]).toContain('today (no pictures)');
    expect(table[3]).toContain('| 128 |');
  });
});
