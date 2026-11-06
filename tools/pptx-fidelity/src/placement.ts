/**
 * Placement check of design/27 §15 M1: "a synthetic 4:3 deck places its boxes within 2 px of LibreOffice's
 * page". The corpus deck `placement-4x3` (src/corpus.ts) draws solid boxes, each in its own colour; this
 * finds each colour's bounding box on LibreOffice's page and on the native page (both are the slide area at
 * 1080 px high) and reports how far each edge moved.
 *
 *   npx tsx tools/pptx-fidelity/src/placement.ts <out>/corpus-placement-4x3 [--max 2]
 *
 * Reads `libreoffice/slide-NNNN.png` and `native/slide-NNNN.png` of a fidelity run, writes `placement.json`
 * next to them, and exits 1 when an edge is off by more than `--max` px (default 2) or a box is missing.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export type Rgb = [number, number, number];
/** Inclusive pixel bounds. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** The colours of the placement deck's boxes, by name (hex as pptxgenjs takes it). */
export const PLACEMENT_COLOURS: Readonly<Record<string, string>> = {
  red: 'FF0000',
  green: '00C000',
  blue: '0000FF',
  magenta: 'FF00FF',
  cyan: '00FFFF',
  yellow: 'FFFF00',
  orange: 'FF8000',
  navy: '203864',
};

export const rgbOf = (hex: string): Rgb => [
  Number.parseInt(hex.slice(0, 2), 16),
  Number.parseInt(hex.slice(2, 4), 16),
  Number.parseInt(hex.slice(4, 6), 16),
];

/**
 * The bounding box of the pixels within `tol` of each colour on every channel (undefined when none), in an
 * RGB or RGBA buffer of `w` x `h` pixels. Anti-aliased edges count only where they are mostly the colour,
 * on both pages alike.
 */
export function colourBoxes(
  px: Uint8Array,
  w: number,
  h: number,
  channels: 3 | 4,
  colours: readonly Rgb[],
  tol = 48,
): (Box | undefined)[] {
  const out: (Box | undefined)[] = colours.map(() => undefined);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * channels;
      const r = px[o]!;
      const g = px[o + 1]!;
      const b = px[o + 2]!;
      for (let i = 0; i < colours.length; i++) {
        const c = colours[i]!;
        if (Math.abs(r - c[0]) > tol || Math.abs(g - c[1]) > tol || Math.abs(b - c[2]) > tol) continue;
        const box = out[i];
        if (!box) out[i] = { x0: x, y0: y, x1: x, y1: y };
        else {
          if (x < box.x0) box.x0 = x;
          if (x > box.x1) box.x1 = x;
          if (y < box.y0) box.y0 = y;
          if (y > box.y1) box.y1 = y;
        }
        break;
      }
    }
  }
  return out;
}

/** The largest distance between matching edges, with `a` scaled by `k` (a's pixels → b's pixels). */
export function edgeDelta(a: Box, b: Box, k = 1): number {
  // Edges are pixel boundaries: x0 is the left edge, x1 + 1 the right edge.
  return Math.max(
    Math.abs(a.x0 * k - b.x0),
    Math.abs((a.x1 + 1) * k - (b.x1 + 1)),
    Math.abs(a.y0 * k - b.y0),
    Math.abs((a.y1 + 1) * k - (b.y1 + 1)),
  );
}

/** Width and height from a PNG's IHDR. */
function pngSize(b: Uint8Array): { w: number; h: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

/** A PNG (one of the harness's own pictures) as packed RGB, decoded by ffmpeg. */
async function rgbOfPng(file: string): Promise<{ px: Uint8Array; w: number; h: number }> {
  const { w, h } = pngSize(await readFile(file));
  const { stdout } = await promisify(execFile)(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: w * h * 3 + 1024, timeout: 60_000 },
  );
  return { px: new Uint8Array(stdout), w, h };
}

export type PlacementRow = {
  slide: number;
  colour: string;
  libreoffice?: Box;
  native?: Box;
  /** Largest edge distance in native px (the slide area at 1080 px high). */
  delta?: number;
};

/** Compare every slide of a run's deck folder. */
export async function comparePlacement(deckDir: string): Promise<PlacementRow[]> {
  const names = Object.keys(PLACEMENT_COLOURS);
  const colours = names.map((n) => rgbOf(PLACEMENT_COLOURS[n]!));
  const pages = (await readdir(join(deckDir, 'libreoffice')))
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort();
  const rows: PlacementRow[] = [];
  for (const page of pages) {
    const slide = Number(page.slice(6, 10));
    const lo = await rgbOfPng(join(deckDir, 'libreoffice', page));
    const nat = await rgbOfPng(join(deckDir, 'native', page)).catch(() => undefined);
    const loBoxes = colourBoxes(lo.px, lo.w, lo.h, 3, colours);
    const natBoxes = nat ? colourBoxes(nat.px, nat.w, nat.h, 3, colours) : [];
    const k = nat ? nat.h / lo.h : 1;
    for (let i = 0; i < names.length; i++) {
      const l = loBoxes[i];
      const n = natBoxes[i];
      if (!l && !n) continue;
      rows.push({
        slide,
        colour: names[i]!,
        ...(l ? { libreoffice: l } : {}),
        ...(n ? { native: n } : {}),
        ...(l && n ? { delta: Math.round(edgeDelta(l, n, k) * 100) / 100 } : {}),
      });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let max = 2;
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max') max = Number(args[++i]);
    else dirs.push(args[i]!);
  }
  if (dirs.length !== 1) throw new Error('usage: placement.ts <out>/corpus-placement-4x3 [--max 2]');
  const dir = resolve(dirs[0]!);
  const rows = await comparePlacement(dir);
  let worst = 0;
  let missing = 0;
  for (const r of rows) {
    if (r.delta === undefined) missing++;
    else worst = Math.max(worst, r.delta);
    console.log(
      `slide ${r.slide} ${r.colour.padEnd(8)} ${r.delta === undefined ? 'missing' : `${r.delta.toFixed(2)} px`}`,
    );
  }
  await writeFile(join(dir, 'placement.json'), JSON.stringify({ max, worst, missing, rows }, null, 1));
  console.log(
    `worst edge ${worst.toFixed(2)} px over ${rows.length} boxes; ${missing} missing (limit ${max} px)`,
  );
  if (worst > max || missing) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
