import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEXT_WARPS } from '../../../../packages/domain/src/schemas.ts';
import { warpAreaArcs, warpArcs } from '../../../../packages/renderer/src/geom/textwarp.ts';
import { WARP_EXCEPTIONS } from './warp-exceptions.ts';
import { WARP_BOXES, WARP_TEXT, warpLayout } from './warps.ts';
import {
  cellClear,
  fillsHull,
  hullOf,
  type Ink,
  insideHull,
  type WarpBaseline,
  type WarpCells,
  verdictWarps,
} from './warps-score.ts';

/*
 * LibreOffice's text of the 40 WordArt warps, committed (warp-baseline.json: the ink of "WordArt Ag" in Liberation Sans
 * 40 pt for every warp at three boxes, measured by `pnpm --filter @ordo/geom-gen golden:warps`), judged against the live
 * geometry of the warps (textwarp.ts) with no LibreOffice, no browser and no tool: this runs in CI, so a change to the
 * shapes fails here when LibreOffice's text no longer fits them. The facts are the measure of r2b sub-wave 2's warp-geom
 * track (LibreOffice 24.2.7.2): 35 of the 40 warps hold their hull within 2 px at all three boxes, the other 5 are listed
 * in warp-exceptions.ts with their reasons.
 */

const baseline = JSON.parse(
  readFileSync(new URL('./warp-baseline.json', import.meta.url), 'utf8'),
) as WarpBaseline;
const names = [...TEXT_WARPS].sort();
const EXCEPTIONS = ['textArchDown', 'textArchUp', 'textButton', 'textCircle', 'textInflateTop'];

const inkOf = (box: string, name: string): Ink => baseline.ink[box]![name]!;

/** The baseline's cells with ordo's hulls built live: the all-arcs hull and the first area's. */
function liveCells(): WarpCells {
  const out: Record<string, Record<string, WarpCells[string][string]>> = {};
  for (const box of WARP_BOXES) {
    out[box.key] = {};
    const layout = new Map(warpLayout(names, box).map((s) => [s.name, s]));
    for (const name of names) {
      const e = warpArcs(name, box.w, box.h)!;
      const s = layout.get(name)!;
      out[box.key]![name] = {
        ink: inkOf(box.key, name),
        hull: hullOf(e.arcs),
        first: hullOf(warpAreaArcs(e.arcs, 0)),
        clear: cellClear(inkOf(box.key, name), s.cell, s.box),
      };
    }
  }
  return out;
}

describe('the committed LibreOffice numbers of the warp probe', () => {
  it('say what they are: the LibreOffice that drew them, the text, the tolerance and the three boxes', () => {
    expect(baseline.libreoffice).toMatch(/^LibreOffice 24\.2\./);
    expect(baseline.text).toBe(WARP_TEXT);
    expect(baseline.tolerancePx).toBe(2);
    expect(baseline.boxes).toEqual(
      Object.fromEntries(WARP_BOXES.map((b) => [b.key, { w: b.w, h: b.h, cols: b.cols, rows: b.rows }])),
    );
  });

  it('cover all 40 warps at all three boxes with ink that is a rectangle of whole pixels', () => {
    expect(Object.keys(baseline.ink).sort()).toEqual(WARP_BOXES.map((b) => b.key).sort());
    for (const box of WARP_BOXES) {
      expect(Object.keys(baseline.ink[box.key]!).sort(), box.key).toEqual(names);
      for (const name of names) {
        const [x0, y0, x1, y1] = inkOf(box.key, name);
        for (const v of [x0, y0, x1, y1]) expect(Number.isInteger(v), `${name} ${box.key}`).toBe(true);
        expect(x1, `${name} ${box.key}`).toBeGreaterThan(x0);
        expect(y1, `${name} ${box.key}`).toBeGreaterThan(y0);
      }
    }
  });

  it('keep 35 of the 40 warps inside their hull within 2 px at all three boxes, and the other 5 outside at all three', () => {
    const outside = new Map<string, number>();
    for (const box of WARP_BOXES)
      for (const name of names) {
        const hull = hullOf(warpArcs(name, box.w, box.h)!.arcs);
        if (!insideHull(inkOf(box.key, name), hull)) outside.set(name, (outside.get(name) ?? 0) + 1);
      }
    expect([...outside.keys()].sort()).toEqual(EXCEPTIONS);
    for (const name of EXCEPTIONS) expect(outside.get(name), name).toBe(3);
    expect(names.length - outside.size).toBe(35);
  });

  it('are listed with their reasons in warp-exceptions.ts, exactly the cells that are outside their hull', () => {
    expect(Object.keys(WARP_EXCEPTIONS).sort()).toEqual(EXCEPTIONS);
    for (const [name, reason] of Object.entries(WARP_EXCEPTIONS)) {
      expect(reason.length, name).toBeGreaterThan(60);
      expect(reason, name).not.toMatch(/WordArt Ag/);
    }
    expect(WARP_EXCEPTIONS.textArchUp).toMatch(/outside of the curve/);
    expect(WARP_EXCEPTIONS.textInflateTop).toMatch(/top of the box/);
  });

  it('have textPlain’s ink within 2 px of its hull on all four sides at all three boxes', () => {
    for (const box of WARP_BOXES) {
      const hull = hullOf(warpArcs('textPlain', box.w, box.h)!.arcs);
      expect(hull).toEqual([0, 0, box.w, box.h]);
      expect(fillsHull(inkOf(box.key, 'textPlain'), hull), box.key).toBe(true);
    }
  });

  it('put a one-line text in the first area: Deflate Inflate, Deflate Inflate Deflate and Button Pour hold it in the first area’s hull', () => {
    for (const box of WARP_BOXES)
      for (const name of ['textButtonPour', 'textDeflateInflate', 'textDeflateInflateDeflate']) {
        const e = warpArcs(name, box.w, box.h)!;
        expect(e.areas, name).toBeGreaterThan(1);
        const first = hullOf(warpAreaArcs(e.arcs, 0));
        expect(insideHull(inkOf(box.key, name), first), `${name} ${box.key}`).toBe(true);
      }
  });

  it('draw Button where Arch Up is, and Button Pour where Arch Up Pour is, to the pixel (within 1 px)', () => {
    for (const box of WARP_BOXES)
      for (const [a, b] of [
        ['textButton', 'textArchUp'],
        ['textButtonPour', 'textArchUpPour'],
      ] as const)
        inkOf(box.key, a).forEach((v, i) => {
          expect(Math.abs(v - inkOf(box.key, b)[i]!), `${a} ${box.key} [${i}]`).toBeLessThanOrEqual(1);
        });
  });

  it('show LibreOffice’s Inflate Top reaching the top of the box while ECMA’s top path peaks a fifth of the height down', () => {
    for (const box of WARP_BOXES) {
      const hull = hullOf(warpArcs('textInflateTop', box.w, box.h)!.arcs);
      // (40,000 / 100,000) / 2 of the height: 48 px at 240.
      expect(hull[1], box.key).toBeCloseTo(0.2 * box.h, 1);
      expect(inkOf(box.key, 'textInflateTop')[1], box.key).toBeLessThanOrEqual(1);
    }
  });

  it('keep every ink clear of its cell’s edges, so no probe cell clipped the text', () => {
    for (const box of WARP_BOXES) {
      const layout = new Map(warpLayout(names, box).map((s) => [s.name, s]));
      for (const name of names) {
        const s = layout.get(name)!;
        expect(cellClear(inkOf(box.key, name), s.cell, s.box), `${name} ${box.key}`).toBe(true);
      }
    }
  });

  it('pass the verdict against the live geometry: nothing fails and nothing is to be noted', () => {
    const v = verdictWarps(liveCells(), baseline, WARP_EXCEPTIONS, baseline.libreoffice);
    expect(v.failures).toEqual([]);
    expect(v.notes).toEqual([]);
  });
});
