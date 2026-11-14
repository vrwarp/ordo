/**
 * The golden-pptx guard deck for line art past the slide's drawing budget (M9 leaf-legacy, design/27 §3.2
 * legacy values, design/23 "Fidelity ratchets"): `golden-pptx/challenging-features/custom-geometry/
 * line-art-holes.pptx`, written here, never downloaded (its manifest entry names this file instead of a
 * source URL).
 *
 *   pnpm --filter @ordo/pptx-fidelity gen:line-art-holes            write the deck
 *   pnpm --filter @ordo/pptx-fidelity gen:line-art-holes -- --check  exit 1 when the committed deck differs
 *
 * Slide 1 holds three line-art paths like the leaf template's (`@ordo/pptx-scene` `test-util.ts`
 * `lineArtPath`): one outline holding 320 holes, 9,605 points (4,164 commands with a point, past what
 * `walk.ts` `pathCoverage` reads), even-odd ink about 0.23 of its box; a white one, a navy one turned inside
 * an unevenly scaled group (placed sheared, as LibreOffice places it) and a black one on top. Each alone is
 * within `GEOM_COST.geometry`; together they pass `GEOM_COST.slide`, so every drawer without a geometry unit
 * draws the last one as its legacy shape, which must be a line (nothing) and never a black box of its fill.
 *
 * The bytes are the same on every machine and run: parts in a fixed order, stored (`table-probe.ts` `zipStore`:
 * not deflated, since a deflater's output may differ between zlib builds), every entry dated 1980-01-01 00:00. A test regenerates it and
 * compares (`line-art-holes.test.ts`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDeck, custGeom, grpSp, lineArtPath, solid, solidBg, sp } from '@ordo/pptx-scene/test-util.ts';
import { zipStore } from '../table-probe.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

/** Where the deck is committed, relative to the repository root (the manifest's `rel_path` below golden-pptx). */
export const LINE_ART_HOLES_PATH = 'golden-pptx/challenging-features/custom-geometry/line-art-holes.pptx';

const IN = 914_400;

/** A filled shape of one line-art path (custom geometry, no outline). */
function lineArt(
  id: number,
  name: string,
  box: { x: number; y: number; cx: number; cy: number; rot?: number },
  color: string,
  seed: number,
): string {
  return sp({
    id,
    name,
    ...box,
    geom: 'none',
    fill: custGeom({ paths: lineArtPath({ cols: 40, rows: 8, seed }) }) + solid(color),
  });
}

/** The deck's parts, in the order they are zipped. */
export function lineArtHolesParts(): Map<string, Uint8Array> {
  const busy =
    lineArt(2, 'White line art', { x: 5.5 * IN, y: 2.6 * IN, cx: 9 * IN, cy: 5.5 * IN }, 'FFFFFF', 1) +
    grpSp(
      { id: 10, x: 1 * IN, y: 3 * IN, cx: 6 * IN, cy: 3.5 * IN, chX: 0, chY: 0, chCx: 4 * IN, chCy: 4 * IN },
      lineArt(
        3,
        'Navy line art',
        { x: 0.2 * IN, y: 0.2 * IN, cx: 3.6 * IN, cy: 3.6 * IN, rot: -20 },
        '1F3864',
        2,
      ),
    ) +
    lineArt(
      4,
      'Black line art',
      { x: 0.3 * IN, y: 0.4 * IN, cx: 9 * IN, cy: 5.5 * IN, rot: 12 },
      '000000',
      0,
    );
  return buildDeck({ slides: [{ bg: solidBg('8FAADC'), shapes: busy }] });
}

/** The deck's bytes. */
export function lineArtHolesDeck(): Buffer {
  return Buffer.from(zipStore([...lineArtHolesParts()]));
}

function main(argv: readonly string[]): number {
  const file = join(root, LINE_ART_HOLES_PATH);
  const bytes = lineArtHolesDeck();
  if (argv.includes('--check')) {
    let same = false;
    try {
      same = readFileSync(file).equals(bytes);
    } catch {
      same = false;
    }
    console.log(
      same ? `${LINE_ART_HOLES_PATH}: as generated` : `${LINE_ART_HOLES_PATH}: differs, regenerate it`,
    );
    return same ? 0 : 1;
  }
  writeFileSync(file, bytes);
  console.log(`${LINE_ART_HOLES_PATH}: ${bytes.length} bytes`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
