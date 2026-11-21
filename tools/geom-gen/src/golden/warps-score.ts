import { TEXT_WARPS } from '../../../../packages/domain/src/schemas.ts';
import type { PxRect } from './probe.ts';
import { WARP_BOXES } from './warps.ts';

/*
 * The pure parts of the warp probe golden (warps-run.ts does the LibreOffice side): where LibreOffice's text of a
 * warp falls against ordo's hull of that warp, and the verdict of a run against the committed baseline and the listed
 * exceptions, in the style of score.ts (the preset golden's). The measure is the geometry leg of r2b sub-wave 2's
 * warp-geom track: LibreOffice's ink of "WordArt Ag" against the bounding box of the warp's arcs (`warpArcs`), at three
 * boxes. Nothing here draws or reads a file.
 */

/** A rectangle as x0, y0, x1, y1 in px relative to a box; the right and bottom edges are exclusive. */
export type Ink = readonly [number, number, number, number];
/** The bounding box of a warp's arcs (or of some of them), in the same form. */
export type Hull = readonly [number, number, number, number];

/** How far LibreOffice's ink may lie outside a hull, in px (anti-aliasing and the font's side bearings). */
export const WARP_TOLERANCE_PX = 2;
/** The most an ink edge of an unlisted warp may drift from the baseline, in px. */
export const WARP_DRIFT_PX = 2;
/** How close two inks that must be equal are, in px (Button's text is Arch Up's, to the pixel). */
export const WARP_PAIR_PX = 1;
/** Ink within this many px of a cell's edge means the probe's cell was too small. */
export const WARP_EDGE_PX = 8;

/** The bounding box of every point of the arcs (their `xy` pairs); all 0 when there is no point. */
export function hullOf(arcs: readonly { readonly xy: ArrayLike<number> }[]): Hull {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const a of arcs)
    for (let i = 0; i + 1 < a.xy.length; i += 2) {
      const x = a.xy[i]!;
      const y = a.xy[i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return x1 < x0 ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** Whether ink lies inside a hull, each edge allowed `tol` px beyond it. */
export function insideHull(ink: Ink, hull: Hull, tol: number = WARP_TOLERANCE_PX): boolean {
  return (
    ink[0] >= hull[0] - tol && ink[1] >= hull[1] - tol && ink[2] <= hull[2] + tol && ink[3] <= hull[3] + tol
  );
}

/** Whether ink fills a hull: every edge of it within `tol` px of the hull's (textPlain does, to the pixel). */
export function fillsHull(ink: Ink, hull: Hull, tol: number = WARP_TOLERANCE_PX): boolean {
  return ink.every((v, i) => Math.abs(v - hull[i]!) <= tol);
}

/** The ink found in a page (absolute px: `inkBounds` of score.ts) as x0, y0, x1, y1 relative to a box. */
export function inkRelative(found: PxRect | undefined, box: PxRect): Ink | undefined {
  return found === undefined
    ? undefined
    : [found.x - box.x, found.y - box.y, found.x + found.w - box.x, found.y + found.h - box.y];
}

/** Whether ink (relative to `box`) keeps `margin` px from every edge of its cell: a cell that was too small clips it. */
export function cellClear(ink: Ink, cell: PxRect, box: PxRect, margin: number = WARP_EDGE_PX): boolean {
  return (
    box.x + ink[0] >= cell.x + margin &&
    box.y + ink[1] >= cell.y + margin &&
    box.x + ink[2] <= cell.x + cell.w - margin &&
    box.y + ink[3] <= cell.y + cell.h - margin
  );
}

/** One cell as measured: LibreOffice's ink (undefined: nothing drawn), ordo's hull and first-area hull, and whether the cell was big enough. */
export interface WarpCell {
  readonly ink: Ink | undefined;
  readonly hull: Hull;
  readonly first: Hull;
  readonly clear: boolean;
}

/** Cells by box key, then by warp name. */
export type WarpCells = Readonly<Record<string, Readonly<Record<string, WarpCell>>>>;

/** The committed baseline (warp-baseline.json): LibreOffice's ink for every warp at every box, and what drew it. */
export interface WarpBaseline {
  readonly libreoffice: string;
  readonly tolerancePx: number;
  readonly text: string;
  readonly boxes: Readonly<
    Record<string, { readonly w: number; readonly h: number; readonly cols: number; readonly rows: number }>
  >;
  readonly ink: Readonly<Record<string, Readonly<Record<string, Ink>>>>;
}

export interface WarpVerdict {
  /** What fails the run. */
  readonly failures: string[];
  /** What does not: a listed warp that is now inside its hull, a drift check that was not made. */
  readonly notes: string[];
}

/** The warps whose one line of text sits in the first of several areas: its ink must lie inside the first area's hull. */
const FIRST_AREA = new Set(['textButtonPour', 'textDeflateInflate', 'textDeflateInflateDeflate']);
/** Pairs whose ink must agree to the pixel: a one-line text on a preset with several areas sits in the first area. */
const SAME_INK: readonly (readonly [string, string])[] = [
  ['textButton', 'textArchUp'],
  ['textButtonPour', 'textArchUpPour'],
];

const fmt = (r: readonly number[]): string => `[${r.map((v) => Math.round(v * 10) / 10).join(', ')}]`;

/**
 * A run's cells against the baseline and the exceptions (warp name to reason). Fails: a cell not measured, one with
 * no ink or with ink within 8 px of its cell's edge; a warp outside its hull by more than 2 px that is not listed;
 * textPlain's ink not filling its hull; Button Pour, Deflate Inflate or Deflate Inflate Deflate outside their first
 * area's hull; Button's ink not Arch Up's (or Button Pour's not Arch Up Pour's) within 1 px; a baseline that lacks a
 * warp at a box; a listed name that is no warp or that the baseline does not show outside its hull; and, only when
 * `version` is the baseline's LibreOffice, an ink edge of an unlisted warp more than 2 px from the baseline (the
 * listed warps sit on the font's metrics and are not drift-checked). Notes a listed warp now inside its hull at every
 * box and a drift check that was not made.
 */
export function verdictWarps(
  cells: WarpCells,
  baseline: WarpBaseline | undefined,
  exceptions: Readonly<Record<string, string>>,
  version: string,
  scope: { readonly names: readonly string[]; readonly boxes: readonly string[] } = {
    names: [...TEXT_WARPS].sort(),
    boxes: WARP_BOXES.map((b) => b.key),
  },
): WarpVerdict {
  const failures: string[] = [];
  const notes: string[] = [];
  const listed = (name: string): boolean => Object.hasOwn(exceptions, name);
  const known = new Set(scope.names);
  const sameVersion = baseline !== undefined && baseline.libreoffice === version;
  if (baseline && !sameVersion)
    notes.push(`${version} is not the baseline's (${baseline.libreoffice}): ink drift not checked`);

  if (baseline)
    for (const box of scope.boxes) {
      const at = baseline.ink[box];
      if (at === undefined) failures.push(`baseline: no ink for box ${box}`);
      else
        for (const name of scope.names)
          if (at[name] === undefined) failures.push(`baseline: no ink for ${name} at ${box}`);
    }

  const insideEverywhere = new Map<string, boolean>();
  for (const box of scope.boxes)
    for (const name of scope.names) {
      const cell = cells[box]?.[name];
      if (cell === undefined) {
        failures.push(`${name} ${box}: not measured`);
        continue;
      }
      const ink = cell.ink;
      if (ink === undefined) {
        failures.push(`${name} ${box}: no ink`);
        continue;
      }
      if (!cell.clear)
        failures.push(
          `${name} ${box}: ink within ${WARP_EDGE_PX} px of the cell edge (the cell is too small)`,
        );
      const inside = insideHull(ink, cell.hull);
      insideEverywhere.set(name, (insideEverywhere.get(name) ?? true) && inside);
      if (!inside && !listed(name))
        failures.push(
          `${name} ${box}: ink ${fmt(ink)} is outside its hull ${fmt(cell.hull)} by more than ${WARP_TOLERANCE_PX} px and not listed in warp-exceptions.ts`,
        );
      if (name === 'textPlain' && !fillsHull(ink, cell.hull))
        failures.push(`${name} ${box}: the ink ${fmt(ink)} does not fill its hull ${fmt(cell.hull)}`);
      if (FIRST_AREA.has(name) && !insideHull(ink, cell.first))
        failures.push(
          `${name} ${box}: the ink ${fmt(ink)} is not inside its first area's hull ${fmt(cell.first)}`,
        );
      const base = baseline?.ink[box]?.[name];
      if (sameVersion && base !== undefined && !listed(name)) {
        const drift = Math.max(...ink.map((v, i) => Math.abs(v - base[i]!)));
        if (drift > WARP_DRIFT_PX)
          failures.push(
            `${name} ${box}: an ink edge drifted by ${drift} px from the baseline ${fmt(base)} (more than ${WARP_DRIFT_PX}): ${fmt(ink)}`,
          );
      }
    }

  for (const [a, b] of SAME_INK)
    if (known.has(a) && known.has(b))
      for (const box of scope.boxes) {
        const ia = cells[box]?.[a]?.ink;
        const ib = cells[box]?.[b]?.ink;
        if (ia && ib && ia.some((v, i) => Math.abs(v - ib[i]!) > WARP_PAIR_PX))
          failures.push(`${a} ${box}: its ink ${fmt(ia)} is not ${b}'s ${fmt(ib)} within ${WARP_PAIR_PX} px`);
      }

  for (const name of Object.keys(exceptions)) {
    if (!known.has(name)) {
      failures.push(`${name}: listed in warp-exceptions.ts but not a warp`);
      continue;
    }
    if (baseline)
      for (const box of scope.boxes) {
        const base = baseline.ink[box]?.[name];
        const hull = cells[box]?.[name]?.hull;
        if (base && hull && insideHull(base, hull))
          failures.push(
            `${name} ${box}: listed in warp-exceptions.ts but not outside its hull in the baseline`,
          );
      }
    if (insideEverywhere.get(name) === true)
      notes.push(`${name}: now inside its hull at every box; its entry in warp-exceptions.ts can go`);
  }
  return { failures, notes };
}
