import type { PxRect } from './probe.ts';

/*
 * The pure parts of the preset golden (run.ts does the drawing): which region of a cell a preset is scored on, and
 * the verdict of a run against the committed baseline and the listed exceptions.
 */

/** The design/27 §15 M6 exit bar: every preset at SSIM ≥ 0.95 against LibreOffice, except listed ones. */
export const MIN_SSIM = 0.95;
/** A preset whose score falls by more than this below its baseline fails the run (a regression). */
export const MAX_DROP = 0.01;
/** Margin around the drawn pixels, in px, so the outline's anti-aliased edge and some background are scored. */
export const REGION_MARGIN = 8;
/** A grey level below this is drawn (the background is white, 255). */
export const INK_BELOW = 250;

/** A greyscale picture: one byte per pixel, row by row. */
export interface GreyPicture {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
}

/** The bounding box of the drawn pixels of `pic` inside `cell`, or undefined when nothing is drawn there. */
export function inkBounds(pic: GreyPicture, cell: PxRect): PxRect | undefined {
  const x0 = Math.max(0, cell.x);
  const y0 = Math.max(0, cell.y);
  const x1 = Math.min(pic.w, cell.x + cell.w);
  const y1 = Math.min(pic.h, cell.y + cell.h);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = y0; y < y1; y++) {
    const row = y * pic.w;
    for (let x = x0; x < x1; x++) {
      if (pic.px[row + x]! >= INK_BELOW) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < minX ? undefined : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** The smallest rectangle holding every given one. */
export function union(rects: readonly (PxRect | undefined)[]): PxRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return x1 < x0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The region a preset is scored on: its box and whatever either drawing put in its cell (a callout's leader, a
 * wave's swing, a drawing that went wrong), grown by REGION_MARGIN and kept inside the cell.
 */
export function scoreRegion(
  cell: PxRect,
  box: PxRect,
  reference: GreyPicture,
  candidate: GreyPicture,
): PxRect {
  const u = union([box, inkBounds(reference, cell), inkBounds(candidate, cell)]);
  const x0 = Math.max(cell.x, u.x - REGION_MARGIN);
  const y0 = Math.max(cell.y, u.y - REGION_MARGIN);
  const x1 = Math.min(cell.x + cell.w, u.x + u.w + REGION_MARGIN);
  const y1 = Math.min(cell.y + cell.h, u.y + u.h + REGION_MARGIN);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The committed baseline: every preset's score when it was last recorded. */
export interface PresetBaseline {
  readonly minSsim: number;
  readonly maxDrop: number;
  readonly presets: Readonly<Record<string, number>>;
}

export interface Verdict {
  /** What fails the run: a drop, a preset under MIN_SSIM that is not listed, a preset not scored. */
  readonly failures: string[];
  /** What does not: a listed preset that now passes (its listing can go), a preset new to the baseline. */
  readonly notes: string[];
}

/**
 * A run's scores against the baseline and the exceptions (preset → reason). A preset fails when it is under
 * MIN_SSIM without being listed, or when it falls more than MAX_DROP below its baseline; every preset of the
 * baseline must be scored.
 */
export function verdict(
  scores: ReadonlyMap<string, number>,
  baseline: PresetBaseline | undefined,
  exceptions: Readonly<Record<string, string>>,
): Verdict {
  const failures: string[] = [];
  const notes: string[] = [];
  const has = (name: string) => Object.hasOwn(exceptions, name);
  for (const [name, s] of [...scores].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const base = baseline && Object.hasOwn(baseline.presets, name) ? baseline.presets[name] : undefined;
    if (!(s >= MIN_SSIM) && !has(name))
      failures.push(`${name}: SSIM ${s.toFixed(4)} is under ${MIN_SSIM} and not listed in exceptions.ts`);
    if (base !== undefined && !(s >= base - MAX_DROP))
      failures.push(`${name}: SSIM ${s.toFixed(4)} dropped from ${base.toFixed(4)} (more than ${MAX_DROP})`);
    if (s >= MIN_SSIM && has(name))
      notes.push(`${name}: SSIM ${s.toFixed(4)} now passes; its entry in exceptions.ts can go`);
    if (baseline && base === undefined) notes.push(`${name}: not in the baseline yet (${s.toFixed(4)})`);
  }
  if (baseline)
    for (const name of Object.keys(baseline.presets))
      if (!scores.has(name)) failures.push(`${name}: in the baseline but not scored`);
  for (const name of Object.keys(exceptions))
    if (!scores.has(name)) failures.push(`${name}: listed in exceptions.ts but not a scored preset`);
  return { failures, notes };
}

/** The baseline of a run's scores (4 decimals, by name), as written to baseline.json. */
export function baselineOf(scores: ReadonlyMap<string, number>): PresetBaseline {
  const presets: Record<string, number> = {};
  for (const name of [...scores.keys()].sort()) presets[name] = Math.round(scores.get(name)! * 1e4) / 1e4;
  return { minSsim: MIN_SSIM, maxDrop: MAX_DROP, presets };
}
