/**
 * The census columns of the pictures of many-point shapes (Q53, C-SR11) and the threshold sweep's table. `convertDeck` with
 * `ConvertOptions.rasters` ('plan') asks the converter for the pictures of each slide without drawing any: a run is one picture and
 * its recipe is counted here (`rasterInfoOf`), never stored. The census (`census.ts`, `--rasters`, `--raster-points N`) writes
 * the columns below per slide; `sweepTable` reduces the rows of the runs at 64, 128, 256 and 512 points beside the census of today
 * (no `--rasters`) to one line each (M-SR2). Nothing here draws or stores a picture: the maker of the hub does that.
 */
import { pathToFileURL } from 'node:url';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { EmittedSlide } from '@ordo/pptx-scene';
import type { RegisteredRaster } from '@ordo/pptx-scene/raster-emit.ts';

/** What the planner and the emitter made of one slide's many-point shapes (`NativeSlide.rasters`). */
export type NativeRasters = {
  /** Many-point shapes the slide holds (the walk's marks on a slide that may take a picture). */
  candidates: number;
  /** Runs planned, and pictures written (a run the emitter could not write is `failed`). */
  runs: number;
  pictures: number;
  /** Shapes drawn into pictures (the candidates and the small ones between them). */
  shapes: number;
  /** Path commands in the recipes' members (one per point, an arc more): the work the page does. */
  points: number;
  /** Canonical bytes of the recipes of the slide (each recipe once, never stored). */
  bytes: number;
  /** Pictured shapes that carry words. */
  words: number;
  /** Candidates that stay as today, by why. */
  skipped: { text: number; effects: number; fill: number; anchored: number; other: number };
  /** Why runs were not written (named reasons), and the planner's named reasons. */
  failed: string[];
  reasons: string[];
};

/** The decoded size of a base64 string (RFC 4648 with padding): the commands of a path, one byte each. */
const decoded = (b64: string): number =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** A slide's counts from its emission (`EmittedSlide.rasterInfo`) and the recipes the call registered. */
export function rasterInfoOf(s: EmittedSlide, recipes: ReadonlyMap<string, RegisteredRaster>): NativeRasters {
  const info = s.rasterInfo!;
  let points = 0;
  let bytes = 0;
  const seen = new Set<string>();
  for (const r of s.rasters ?? []) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const reg = recipes.get(r.id);
    if (!reg) continue;
    bytes += reg.bytes;
    for (const m of reg.recipe.members) for (const p of m.geom.paths) points += decoded(p.cmds);
  }
  return {
    candidates: info.candidates,
    runs: info.runs,
    pictures: info.pictures,
    shapes: info.shapes,
    points,
    bytes,
    words: info.wordShapes,
    skipped: { ...info.skipped },
    failed: [...info.failed],
    reasons: [...info.reasons],
  };
}

/**
 * The columns a census row carries for one slide that has any many-point shape: `rasterCandidates`, `rasterRuns`, `rasterPictures`,
 * `rasterShapes`, `rasterPoints`, `rasterSkipped` (the candidates that stay as they are, in total; `rasterSkippedWhy` by reason),
 * `rasterBytes` (canonical recipe bytes), `rasterWords`, and `rasterFailed` / `rasterReasons` when there are any.
 */
export function rasterColumns(r: NativeRasters | undefined): Record<string, unknown> {
  if (!r || r.candidates === 0) return {};
  const left = r.skipped.text + r.skipped.effects + r.skipped.fill + r.skipped.anchored + r.skipped.other;
  return {
    rasterCandidates: r.candidates,
    rasterRuns: r.runs,
    rasterPictures: r.pictures,
    rasterShapes: r.shapes,
    rasterPoints: r.points,
    rasterSkipped: left,
    ...(left
      ? { rasterSkippedWhy: Object.fromEntries(Object.entries(r.skipped).filter(([, n]) => n > 0)) }
      : {}),
    rasterBytes: r.bytes,
    rasterWords: r.words,
    ...(r.failed.length ? { rasterFailed: r.failed } : {}),
    ...(r.reasons.length ? { rasterReasons: r.reasons } : {}),
  };
}

// ── The threshold sweep (M-SR2) ────────────────────────────────────────────────────────────────────────────

type CensusSlide = Record<string, unknown> & { objects?: number; class?: string; hub?: string };
type CensusDeck = { name?: string; slides?: CensusSlide[]; error?: string; unreadable?: string };

/** One line of the sweep: the census at a threshold (or today's, `points` undefined). */
export type SweepLine = {
  /** The threshold (`--raster-points`), or undefined for the census without rasters. */
  points: number | undefined;
  decks: number;
  /** Decks and slides with at least one picture. */
  decksWithRuns: number;
  slides: number;
  slidesWithRuns: number;
  candidates: number;
  runs: number;
  pictures: number;
  shapes: number;
  /** Candidates that stay as they are, and runs the emitter could not write. */
  skipped: number;
  failedRuns: number;
  words: number;
  recipePoints: number;
  recipeBytes: number;
  /** The most objects on a slide, slides past the screens' 200 objects, and slides not stored native. */
  maxObjects: number;
  over200: number;
  notNative: number;
  /** The most recipe bytes of one slide, and the most pictures of one slide. */
  maxSlideBytes: number;
  maxPictures: number;
};

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Reduce the rows of one census (JSON lines parsed) to a `SweepLine`. */
export function sweepLine(points: number | undefined, rows: readonly CensusDeck[]): SweepLine {
  const out: SweepLine = {
    points,
    decks: 0,
    decksWithRuns: 0,
    slides: 0,
    slidesWithRuns: 0,
    candidates: 0,
    runs: 0,
    pictures: 0,
    shapes: 0,
    skipped: 0,
    failedRuns: 0,
    words: 0,
    recipePoints: 0,
    recipeBytes: 0,
    maxObjects: 0,
    over200: 0,
    notNative: 0,
    maxSlideBytes: 0,
    maxPictures: 0,
  };
  for (const d of rows) {
    if (d.unreadable || d.error || !d.slides) continue;
    out.decks++;
    let any = false;
    for (const s of d.slides) {
      out.slides++;
      const objects = num(s.objects);
      out.maxObjects = Math.max(out.maxObjects, objects);
      if (objects > 200) out.over200++;
      if (s.class !== undefined && s.class !== 'native') out.notNative++;
      const runs = num(s.rasterRuns);
      out.candidates += num(s.rasterCandidates);
      if (num(s.rasterCandidates) === 0) continue;
      out.runs += runs;
      out.pictures += num(s.rasterPictures);
      out.shapes += num(s.rasterShapes);
      out.skipped += num(s.rasterSkipped);
      out.failedRuns += Array.isArray(s.rasterFailed) ? s.rasterFailed.length : 0;
      out.words += num(s.rasterWords);
      out.recipePoints += num(s.rasterPoints);
      out.recipeBytes += num(s.rasterBytes);
      out.maxSlideBytes = Math.max(out.maxSlideBytes, num(s.rasterBytes));
      out.maxPictures = Math.max(out.maxPictures, num(s.rasterPictures));
      if (num(s.rasterPictures) > 0) {
        out.slidesWithRuns++;
        any = true;
      }
    }
    if (any) out.decksWithRuns++;
  }
  return out;
}

/** The sweep as a Markdown table, one row per threshold (today's census first). */
export function sweepTable(lines: readonly SweepLine[]): string {
  const head = [
    'threshold',
    'decks',
    'with pictures',
    'slides',
    'with pictures',
    'candidates',
    'runs',
    'pictures',
    'shapes in them',
    'stay as they are',
    'runs not written',
    'words',
    'recipe points',
    'recipe bytes',
    'most objects',
    'slides over 200 objects',
    'slides not native',
    'most bytes a slide',
    'most pictures a slide',
  ];
  const rows = lines.map((l) => [
    l.points === undefined ? 'today (no pictures)' : String(l.points),
    l.decks,
    l.decksWithRuns,
    l.slides,
    l.slidesWithRuns,
    l.candidates,
    l.runs,
    l.pictures,
    l.shapes,
    l.skipped,
    l.failedRuns,
    l.words,
    l.recipePoints,
    l.recipeBytes,
    l.maxObjects,
    l.over200,
    l.notNative,
    l.maxSlideBytes,
    l.maxPictures,
  ]);
  const fmt = (r: readonly (string | number)[]) =>
    `| ${r.map((v) => (typeof v === 'number' ? v.toLocaleString('en') : v)).join(' | ')} |`;
  return [fmt(head), fmt(head.map(() => '---')), ...rows.map(fmt)].join('\n');
}

async function readRows(file: string): Promise<CensusDeck[]> {
  const rows: CensusDeck[] = [];
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line) as CensusDeck);
  return rows;
}

/**
 * `raster-census.ts sweep <today.jsonl> <points>=<census.jsonl>...`: the sweep table of censuses written by `census.ts` (today's
 * without `--rasters`, the others with `--raster-points <points>`).
 */
async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'sweep' || rest.length < 1)
    throw new Error('usage: raster-census.ts sweep <today.jsonl> [<points>=<census.jsonl>...]');
  const lines: SweepLine[] = [sweepLine(undefined, await readRows(rest[0]!))];
  for (const arg of rest.slice(1)) {
    const [p, file] = arg.split('=');
    if (!p || !file || !Number.isInteger(Number(p))) throw new Error(`expected <points>=<file>, got ${arg}`);
    lines.push(sweepLine(Number(p), await readRows(file)));
  }
  console.log(sweepTable(lines));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
