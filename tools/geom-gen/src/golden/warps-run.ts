import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../../../apps/hub/src/media/tools.ts';
import { TEXT_WARPS } from '../../../../packages/domain/src/schemas.ts';
import { warpAreaArcs, warpArcs } from '../../../../packages/renderer/src/geom/textwarp.ts';
import { grey, has, libreOfficePages, skip } from './lo.ts';
import { slideCount } from './probe.ts';
import { WARP_EXCEPTIONS } from './warp-exceptions.ts';
import { WARP_BOXES, WARP_TEXT, warpDeck, warpLayout } from './warps.ts';
import { inkBounds } from './score.ts';
import {
  cellClear,
  hullOf,
  type Ink,
  insideHull,
  inkRelative,
  WARP_TOLERANCE_PX,
  type WarpBaseline,
  type WarpCell,
  type WarpCells,
  verdictWarps,
} from './warps-score.ts';

/*
 * The warp probe golden, geometry leg (r2b sub-wave 2, warp-geom): LibreOffice's text of the 40 WordArt warps against
 * ordo's hulls of them. Three decks of ordo's own (warps.ts), one per box shape, each with one text box per warp at its
 * default adjust values ("WordArt Ag", Liberation Sans 40 pt, no fill and no outline, so only the text is drawn); LibreOffice
 * draws them as the fidelity harness draws decks (soffice to PDF, pdftoppm at 144 dpi); the ink of a cell is the bounding
 * box of its pixels below grey 250, in px relative to the box; the hull of a warp is the bounding box of its arcs'
 * points (`warpArcs` at the same box). No browser is needed: ordo's side is the pure geometry of textwarp.ts.
 *
 *   pnpm --filter @ordo/geom-gen golden:warps            compare with warp-baseline.json; exit 1 on a failure
 *   pnpm --filter @ordo/geom-gen golden:warps --update   rewrite warp-baseline.json from this run
 *   ... --out DIR       keep the three decks, LibreOffice's pages, report.json (ink, hull, first-area hull and verdict of
 *                       every cell) and geometry.json (the arcs of every warp at every box, for an overlay)
 *   ... --strict        a missing tool fails the run instead of skipping it (CI sets CI=true: always strict)
 *
 * The numbers are committed (warp-baseline.json) and judged against the live geometry by warps-baseline.test.ts
 * without LibreOffice, so CI checks the shapes against LibreOffice's text; this run only refreshes or verifies them
 * (it is not a CI step). Needs soffice (LibreOffice 24.2 made the baseline), pdftoppm and ffmpeg. A run takes about 15 s.
 */

const LABEL = 'warp probe golden';
const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, 'warp-baseline.json');

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const strict = argv.includes('--strict') || !!process.env.CI;
const outArg = argv.indexOf('--out');
const outDir = outArg >= 0 ? argv[outArg + 1] : undefined;

async function readBaseline(): Promise<WarpBaseline | undefined> {
  if (!existsSync(BASELINE)) return undefined;
  return JSON.parse(await readFile(BASELINE, 'utf8')) as WarpBaseline;
}

/** `{ "w": 360, "h": 240 }`: a flat object on one line, as the repository's formatter prints a short one. */
const flat = (o: Record<string, number>): string =>
  `{ ${Object.entries(o)
    .map(([k, v]) => `${JSON.stringify(k)}: ${v}`)
    .join(', ')} }`;

/** The baseline as text, in the form the repository's formatter keeps: one line a cell, so a change shows cell by cell. */
function baselineText(b: WarpBaseline): string {
  const boxes = Object.entries(b.boxes).map(([k, v]) => `    ${JSON.stringify(k)}: ${flat({ ...v })}`);
  const ink = Object.entries(b.ink).map(
    ([box, warps]) =>
      `    ${JSON.stringify(box)}: {\n${Object.entries(warps)
        .map(([name, v]) => `      ${JSON.stringify(name)}: [${v.join(', ')}]`)
        .join(',\n')}\n    }`,
  );
  return (
    '{\n' +
    `  "libreoffice": ${JSON.stringify(b.libreoffice)},\n` +
    `  "tolerancePx": ${b.tolerancePx},\n` +
    `  "text": ${JSON.stringify(b.text)},\n` +
    `  "boxes": {\n${boxes.join(',\n')}\n  },\n` +
    `  "ink": {\n${ink.join(',\n')}\n  }\n` +
    '}\n'
  );
}

async function main(): Promise<number> {
  for (const [cmd, args] of [
    ['soffice', ['--version']],
    ['pdftoppm', ['-v']],
    ['ffmpeg', ['-version']],
  ] as const)
    if (!(await has(cmd, [...args]))) return skip(LABEL, `${cmd} is not installed`, strict);

  const work = outDir ? resolve(outDir) : join(tmpdir(), `ordo-warp-golden-${process.pid}`);
  await mkdir(work, { recursive: true });
  try {
    const names = [...TEXT_WARPS].sort();
    const version = (await run('soffice', ['--version'], { timeoutMs: 30_000 })).stdout.trim();
    const cells: Record<string, Record<string, WarpCell>> = {};
    const geometry: Record<string, Record<string, unknown>> = {};
    for (const box of WARP_BOXES) {
      const shapes = warpLayout(names, box);
      const dir = join(work, box.key);
      await mkdir(dir, { recursive: true });
      const deck = join(dir, `warps-${box.key}.pptx`);
      await writeFile(deck, warpDeck(names, box));
      const pages = await libreOfficePages(deck, dir);
      if (pages.length !== slideCount(shapes))
        throw new Error(
          `${box.key}: LibreOffice drew ${pages.length} slides, the deck has ${slideCount(shapes)}`,
        );
      console.log(`${LABEL}: ${version} drew ${pages.length} slides of the ${box.key} deck`);
      cells[box.key] = {};
      geometry[box.key] = {};
      for (let i = 0; i < pages.length; i++) {
        const pic = await grey(pages[i]!, dir);
        for (const s of shapes.filter((x) => x.slide === i)) {
          const e = warpArcs(s.name, box.w, box.h)!;
          const ink = inkRelative(inkBounds(pic, s.cell), s.box);
          cells[box.key]![s.name] = {
            ink,
            hull: hullOf(e.arcs),
            first: hullOf(warpAreaArcs(e.arcs, 0)),
            clear: ink !== undefined && cellClear(ink, s.cell, s.box),
          };
          geometry[box.key]![s.name] = {
            mode: e.mode,
            areas: e.areas,
            arcs: e.arcs.map((a) => ({ xy: Array.from(a.xy), total: a.total, tol: a.tol })),
          };
        }
      }
    }

    const cellList = WARP_BOXES.flatMap((b) =>
      names.map((n) => ({ box: b.key, name: n, cell: cells[b.key]![n]! })),
    );
    for (const box of WARP_BOXES) {
      const inside = names.filter((n) => {
        const c = cells[box.key]![n]!;
        return c.ink !== undefined && insideHull(c.ink, c.hull);
      });
      const outside = names.filter((n) => !inside.includes(n));
      console.log(
        `${LABEL}: ${box.key}: ${inside.length} of ${names.length} warps inside their hull within ${WARP_TOLERANCE_PX} px` +
          (outside.length ? `; outside: ${outside.join(', ')}` : ''),
      );
    }
    const allInside = names.filter((n) =>
      WARP_BOXES.every((b) => {
        const c = cells[b.key]![n]!;
        return c.ink !== undefined && insideHull(c.ink, c.hull);
      }),
    );
    console.log(
      `${LABEL}: ${cellList.length} cells scored, ${allInside.length} of ${names.length} warps inside their hull at all ${WARP_BOXES.length} boxes; ` +
        `${Object.keys(WARP_EXCEPTIONS).length} listed in warp-exceptions.ts`,
    );

    await writeFile(
      join(work, 'report.json'),
      `${JSON.stringify({ version, text: WARP_TEXT, cells }, null, 2)}\n`,
    );
    await writeFile(join(work, 'geometry.json'), `${JSON.stringify(geometry)}\n`);

    if (update) {
      const ink: Record<string, Record<string, Ink>> = {};
      for (const box of WARP_BOXES) {
        ink[box.key] = {};
        for (const n of names) {
          const v = cells[box.key]![n]!.ink;
          if (v === undefined) throw new Error(`${n} at ${box.key}: no ink, the baseline cannot be written`);
          ink[box.key]![n] = v;
        }
      }
      const next: WarpBaseline = {
        libreoffice: version,
        tolerancePx: WARP_TOLERANCE_PX,
        text: WARP_TEXT,
        boxes: Object.fromEntries(
          WARP_BOXES.map((b) => [b.key, { w: b.w, h: b.h, cols: b.cols, rows: b.rows }]),
        ),
        ink,
      };
      await writeFile(BASELINE, baselineText(next));
      console.log(`${LABEL}: wrote ${BASELINE}`);
    }
    const baseline = update ? undefined : await readBaseline();
    const v = verdictWarps(cells as WarpCells, baseline, WARP_EXCEPTIONS, version);
    for (const n of v.notes) console.log(`  note: ${n}`);
    for (const f of v.failures) console.error(`  FAIL: ${f}`);
    if (v.failures.length) {
      console.error(
        `${LABEL}: ${v.failures.length} failure(s); rerun with --out DIR to keep the pages and report.json`,
      );
      return 1;
    }
    console.log(`${LABEL}: ok`);
    return 0;
  } finally {
    if (!outDir) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`${LABEL}: ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
