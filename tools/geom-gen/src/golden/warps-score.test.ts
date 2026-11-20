import { describe, expect, it } from 'vitest';
import {
  cellClear,
  fillsHull,
  type Hull,
  hullOf,
  type Ink,
  insideHull,
  inkRelative,
  type WarpBaseline,
  type WarpCell,
  type WarpCells,
  verdictWarps,
} from './warps-score.ts';

/*
 * The pure parts of the warp probe golden (warps-run.ts does the LibreOffice side): the hull of a warp's arcs, whether
 * LibreOffice's ink lies inside it within a tolerance, and the verdict of a run against the committed baseline and the
 * listed exceptions, in the style of score.test.ts.
 */

const VERSION = 'LibreOffice 24.2.7.2 420(Build:2)';
const BOX = { x: 100, y: 200, w: 360, h: 240 };

describe('hullOf, insideHull and fillsHull', () => {
  const arc = (...xy: number[]) => ({ xy: new Float64Array(xy) });

  it('is the bounding box of every point of the arcs it is given', () => {
    expect(hullOf([arc(0, 120, 180, 0, 360, 120)])).toEqual([0, 0, 360, 120]);
    expect(hullOf([arc(10, 20, 30, 40), arc(-5, 50, 7, 8)])).toEqual([-5, 8, 30, 50]);
    expect(hullOf([arc(3, 4)])).toEqual([3, 4, 3, 4]);
    expect(hullOf([])).toEqual([0, 0, 0, 0]);
    expect(hullOf([arc()])).toEqual([0, 0, 0, 0]);
  });

  it('puts ink inside a hull within the tolerance, 2 px unless told otherwise', () => {
    const hull: Hull = [0, 0, 360, 120];
    expect(insideHull([0, 0, 360, 120], hull)).toBe(true);
    expect(insideHull([-2, -2, 362, 122], hull)).toBe(true);
    expect(insideHull([-2.01, 0, 360, 120], hull)).toBe(false);
    expect(insideHull([0, -2.01, 360, 120], hull)).toBe(false);
    expect(insideHull([0, 0, 362.01, 120], hull)).toBe(false);
    expect(insideHull([0, 0, 360, 122.01], hull)).toBe(false);
    expect(insideHull([-18, -37, 371, 101], hull)).toBe(false);
    expect(insideHull([-5, 0, 360, 120], hull, 5)).toBe(true);
    expect(insideHull([10, 10, 20, 20], hull)).toBe(true);
  });

  it('fills a hull when all four edges are within the tolerance of it', () => {
    const hull: Hull = [0, 0, 360, 240];
    expect(fillsHull([-1, 0, 360, 240], hull)).toBe(true);
    expect(fillsHull([0, 2, 358, 238], hull)).toBe(true);
    expect(fillsHull([3, 0, 360, 240], hull)).toBe(false);
    expect(fillsHull([0, 0, 360, 100], hull)).toBe(false);
    expect(fillsHull([-3, 0, 360, 240], hull)).toBe(false);
  });
});

describe('inkRelative and cellClear', () => {
  it('turns a found rectangle into x0, y0, x1, y1 relative to the box, the far edges exclusive', () => {
    expect(inkRelative({ x: 103, y: 330, w: 374, h: 131 }, BOX)).toEqual([3, 130, 377, 261]);
    expect(inkRelative({ x: 82, y: 163, w: 389, h: 138 }, BOX)).toEqual([-18, -37, 371, 101]);
    expect(inkRelative(undefined, BOX)).toBeUndefined();
  });

  it('is clear when the ink keeps its distance from the cell’s edges', () => {
    const cell = { x: 0, y: 150, w: 640, h: 540 };
    const box = { x: 140, y: 300, w: 360, h: 240 };
    expect(cellClear([-18, -37, 371, 101], cell, box)).toBe(true);
    expect(cellClear([-132, 0, 360, 240], cell, box)).toBe(true);
    expect(cellClear([-133, 0, 360, 240], cell, box)).toBe(false);
    expect(cellClear([0, -142, 360, 240], cell, box)).toBe(true);
    expect(cellClear([0, -143, 360, 240], cell, box)).toBe(false);
    expect(cellClear([0, 0, 492, 240], cell, box)).toBe(true);
    expect(cellClear([0, 0, 493, 240], cell, box)).toBe(false);
    expect(cellClear([0, 0, 360, 392], cell, box)).toBe(true);
    expect(cellClear([0, 0, 360, 393], cell, box)).toBe(false);
    expect(cellClear([-9, 0, 360, 240], cell, box, 0)).toBe(true);
  });
});

/** A world of two warps at one box: one that fills its hull, one listed as outside it. */
const NAMES = ['textInside', 'textOutside'];
const KEYS = ['box'];
const hull = (): Hull => [0, 0, 100, 50];
const cell = (ink: Ink | undefined, over: Partial<WarpCell> = {}): WarpCell => ({
  ink,
  hull: hull(),
  first: hull(),
  clear: true,
  ...over,
});
const cells = (inside: WarpCell, outside: WarpCell): WarpCells => ({
  box: { textInside: inside, textOutside: outside },
});
const baseline = (inside: Ink, outside: Ink, over: Partial<WarpBaseline> = {}): WarpBaseline => ({
  libreoffice: VERSION,
  tolerancePx: 2,
  text: 'WordArt Ag',
  boxes: { box: { w: 100, h: 50, cols: 3, rows: 2 } },
  ink: { box: { textInside: inside, textOutside: outside } },
  ...over,
});
const EXC = { textOutside: 'the text rides on the outside of the curve' };
const world = { names: NAMES, boxes: KEYS };
const IN: Ink = [0, 0, 100, 50];
const IN2: Ink = [0, 0, 100, 40];
const OUT: Ink = [-20, -30, 120, 40];

describe('verdictWarps', () => {
  it('passes a run whose unlisted cells are inside their hulls and whose listed cell is outside', () => {
    const v = verdictWarps(cells(cell(IN), cell(OUT)), baseline(IN, OUT), EXC, VERSION, world);
    expect(v.failures).toEqual([]);
    expect(v.notes).toEqual([]);
  });

  it('fails a cell outside its hull that is not listed, naming the preset and the box', () => {
    const v = verdictWarps(cells(cell([-9, 0, 100, 50]), cell(OUT)), baseline(IN, OUT), EXC, VERSION, world);
    expect(v.failures.length).toBe(1);
    expect(v.failures[0]).toMatch(/textInside.*box.*outside/);
  });

  it('notes a listed warp that is inside its hull now, and fails nothing for it', () => {
    const v = verdictWarps(cells(cell(IN), cell(IN)), baseline(IN, OUT), EXC, VERSION, world);
    expect(v.failures).toEqual([]);
    expect(v.notes.length).toBe(1);
    expect(v.notes[0]).toMatch(/textOutside.*now inside.*warp-exceptions\.ts/);
  });

  it('fails a baseline that does not cover every warp at every box', () => {
    const missingWarp = baseline(IN, OUT);
    const oneWarp = { ...missingWarp, ink: { box: { textInside: IN } } };
    expect(
      verdictWarps(cells(cell(IN), cell(OUT)), oneWarp, EXC, VERSION, world).failures.join('\n'),
    ).toMatch(/baseline.*textOutside.*box/);
    const noBox = { ...missingWarp, ink: {} };
    expect(verdictWarps(cells(cell(IN), cell(OUT)), noBox, EXC, VERSION, world).failures.join('\n')).toMatch(
      /baseline.*box/,
    );
    // Without a baseline the run is judged on its own, as the preset golden's verdict is.
    expect(verdictWarps(cells(cell(IN), cell(OUT)), undefined, EXC, VERSION, world).failures).toEqual([]);
  });

  it('fails a run that did not measure a cell, or found no ink in one', () => {
    const partial: WarpCells = { box: { textInside: cell(IN) } };
    expect(verdictWarps(partial, baseline(IN, OUT), EXC, VERSION, world).failures.join('\n')).toMatch(
      /textOutside.*box.*not measured/,
    );
    const none = cells(cell(undefined), cell(OUT));
    expect(verdictWarps(none, baseline(IN, OUT), EXC, VERSION, world).failures.join('\n')).toMatch(
      /textInside.*box.*no ink/,
    );
  });

  it('fails a listed warp that the baseline has inside its hull, and a listed name that is no warp', () => {
    const v = verdictWarps(cells(cell(IN), cell(OUT)), baseline(IN, IN), EXC, VERSION, world);
    expect(v.failures.join('\n')).toMatch(
      /textOutside.*listed in warp-exceptions\.ts.*not outside.*baseline/,
    );
    const stray = verdictWarps(
      cells(cell(IN), cell(OUT)),
      baseline(IN, OUT),
      { ...EXC, textMissing: 'x' },
      VERSION,
      world,
    );
    expect(stray.failures.join('\n')).toMatch(/textMissing.*listed in warp-exceptions\.ts.*not a warp/);
  });

  it('fails an ink edge that drifted more than 2 px from the baseline, for unlisted warps only', () => {
    const drift = cells(cell([0, 0, 100, 43]), cell([-26, -30, 120, 40]));
    const v = verdictWarps(drift, baseline(IN2, OUT), EXC, VERSION, world);
    expect(v.failures.length).toBe(1);
    expect(v.failures[0]).toMatch(/textInside.*box.*drifted.*3/);
    // The listed warp sits on font metrics: its ink may move (here by 6 px) without failing the run.
    const metrics = verdictWarps(
      cells(cell(IN2), cell([-26, -30, 120, 40])),
      baseline(IN2, OUT),
      EXC,
      VERSION,
      world,
    );
    expect(metrics.failures).toEqual([]);
    // Two px is within the drift.
    const near = verdictWarps(
      cells(cell([0, 0, 100, 42]), cell(OUT)),
      baseline(IN2, OUT),
      EXC,
      VERSION,
      world,
    );
    expect(near.failures).toEqual([]);
  });

  it('checks the drift only when LibreOffice is the baseline’s version', () => {
    const drift = cells(cell([0, 0, 100, 43]), cell(OUT));
    const v = verdictWarps(drift, baseline(IN2, OUT), EXC, 'LibreOffice 25.2.0.0', world);
    expect(v.failures).toEqual([]);
    expect(v.notes.join('\n')).toMatch(/LibreOffice 25\.2\.0\.0.*not the baseline's.*drift.*not checked/);
  });

  it('fails the facts of the measure: textPlain fills its hull, the first area holds the ink, a cell is clear', () => {
    const plain = verdictWarps(
      { box: { textPlain: cell([0, 0, 100, 40]), textOutside: cell(OUT) } },
      baseline(IN, OUT, { ink: { box: { textPlain: [0, 0, 100, 40], textOutside: OUT } } }),
      EXC,
      VERSION,
      { names: ['textPlain', 'textOutside'], boxes: KEYS },
    );
    expect(plain.failures.join('\n')).toMatch(/textPlain.*box.*fill its hull/);
    const first = verdictWarps(
      { box: { textButtonPour: cell([0, 0, 100, 50], { first: [0, 0, 100, 20] }), textOutside: cell(OUT) } },
      baseline(IN, OUT, { ink: { box: { textButtonPour: IN, textOutside: OUT } } }),
      EXC,
      VERSION,
      { names: ['textButtonPour', 'textOutside'], boxes: KEYS },
    );
    expect(first.failures.join('\n')).toMatch(/textButtonPour.*box.*first area/);
    const clipped = verdictWarps(
      cells(cell(IN, { clear: false }), cell(OUT)),
      baseline(IN, OUT),
      EXC,
      VERSION,
      world,
    );
    expect(clipped.failures.join('\n')).toMatch(/textInside.*box.*cell edge/);
  });

  it('fails a Button that is not where Arch Up is, and a Button Pour that is not where Arch Up Pour is', () => {
    const arcs = { textArchUp: [-18, -37, 371, 101], textButton: [-18, -37, 371, 101] } as const;
    const ok = verdictWarps(
      { box: { textArchUp: cell(arcs.textArchUp), textButton: cell(arcs.textButton) } },
      undefined,
      { textArchUp: 'x', textButton: 'x' },
      VERSION,
      { names: ['textArchUp', 'textButton'], boxes: KEYS },
    );
    expect(ok.failures).toEqual([]);
    const apart = verdictWarps(
      { box: { textArchUp: cell(arcs.textArchUp), textButton: cell([-18, -37, 373, 101]) } },
      undefined,
      { textArchUp: 'x', textButton: 'x' },
      VERSION,
      { names: ['textArchUp', 'textButton'], boxes: KEYS },
    );
    expect(apart.failures.join('\n')).toMatch(/textButton.*box.*textArchUp/);
    const pour = verdictWarps(
      { box: { textArchUpPour: cell([3, 0, 341, 120]), textButtonPour: cell([3, 0, 345, 120]) } },
      undefined,
      {},
      VERSION,
      { names: ['textArchUpPour', 'textButtonPour'], boxes: KEYS },
    );
    expect(pour.failures.join('\n')).toMatch(/textButtonPour.*box.*textArchUpPour/);
  });
});
