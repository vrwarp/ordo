import { describe, expect, it } from 'vitest';
import { ARROW_MIN_BASE, arrowCentred, arrowFor, arrowReach, withEnds } from './ends.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE } from './ops.ts';
import type { GeomPath } from './path.ts';

/** Line ends as LibreOffice draws OOXML's headEnd and tailEnd (oox lineproperties.cxx, drawinglayer). */

const line = (x0: number, y0: number, x1: number, y1: number): GeomPath => ({
  cmds: [CMD_MOVE, CMD_LINE],
  pts: [x0, y0, x1, y1],
  fill: 'none',
  stroke: true,
});

describe('arrowFor', () => {
  it('sizes markers by max(line width, 0.7 mm): 2, 3 and 5 times (2.5, 3.5, 5.5 and 6 for the open arrow)', () => {
    expect(ARROW_MIN_BASE).toBeCloseTo(3.9685, 4);
    expect(arrowFor('triangle', 'med', 'med', 10)).toEqual({
      kind: 'triangle',
      width: 30,
      length: 30,
      line: 10,
    });
    expect(arrowFor('stealth', 'sm', 'lg', 10)).toMatchObject({ width: 20, length: 50 });
    expect(arrowFor('arrow', 'lg', 'lg', 10)).toMatchObject({ width: 55, length: 60 });
    expect(arrowFor('arrow', 'sm', 'med', 10)).toMatchObject({ width: 25, length: 35 });
    // A hairline is sized as a 0.7 mm line.
    expect(arrowFor('oval', 'med', 'med', 1)!.width).toBeCloseTo(3 * ARROW_MIN_BASE, 9);
  });

  it('is undefined for none or unknown types; unknown sizes are medium', () => {
    expect(arrowFor('none', 'med', 'med', 4)).toBeUndefined();
    expect(arrowFor('harpoon', 'med', 'med', 4)).toBeUndefined();
    expect(arrowFor(undefined, 'med', 'med', 4)).toBeUndefined();
    expect(arrowFor('diamond', 'xl', 7, 10)).toMatchObject({ width: 30, length: 30 });
    expect(arrowFor('triangle', 'med', 'med', 0, 0)).toBeUndefined();
  });

  it('centres oval and diamond on the end point', () => {
    expect(arrowCentred(arrowFor('oval', 'med', 'med', 4)!)).toBe(true);
    expect(arrowCentred(arrowFor('diamond', 'med', 'med', 4)!)).toBe(true);
    expect(arrowCentred(arrowFor('triangle', 'med', 'med', 4)!)).toBe(false);
  });
});

describe('withEnds', () => {
  const tri = arrowFor('triangle', 'med', 'med', 10)!; // 30 x 30
  const oval = arrowFor('oval', 'med', 'med', 10)!;

  it('puts the tip on the end point and cuts the shaft back by the length less width/15', () => {
    const e = withEnds(line(0, 50, 200, 50), { tail: tri });
    expect(e.markers).toHaveLength(1);
    const m = e.markers[0]!;
    expect(m.slice(0, 2)).toEqual([200, 50]); // the tip
    expect(m[2]).toBeCloseTo(170, 9); // the base corners 30 back, 15 either side
    expect([m[3], m[5]].sort()).toEqual([35, 65]);
    expect(e.shaft.pts[0]).toBe(0);
    expect(e.shaft.pts[2]).toBeCloseTo(200 - 30 + 30 / 15, 9);
  });

  it('points a head back along the line from its start', () => {
    const e = withEnds(line(100, 100, 100, 300), { head: tri });
    expect(e.markers[0]!.slice(0, 2)).toEqual([100, 100]);
    expect(e.markers[0]![3]).toBeCloseTo(130, 9);
    expect(e.shaft.pts[1]).toBeCloseTo(100 + 30 - 2, 9);
    expect(e.shaft.pts[3]).toBe(300);
  });

  it('centres an oval and consumes half its length', () => {
    const e = withEnds(line(0, 0, 100, 0), { tail: oval });
    const xs = e.markers[0]!.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs)).toBeCloseTo(115, 9);
    expect(Math.min(...xs)).toBeCloseTo(85, 9);
    expect(e.shaft.pts[2]).toBeCloseTo(100 - 15 + 2, 9);
  });

  it('cuts a curve at its arc length and keeps closed sub-paths whole', () => {
    const curve: GeomPath = {
      cmds: [CMD_MOVE, CMD_CUBIC, CMD_MOVE, CMD_LINE, CMD_LINE, CMD_CLOSE],
      pts: [0, 0, 100, 0, 200, 100, 200, 200, 300, 0, 400, 0, 350, 50],
      fill: 'none',
      stroke: true,
    };
    const e = withEnds(curve, { head: tri, tail: tri });
    expect(e.markers).toHaveLength(2); // only the open sub-path
    expect(e.shaft.cmds).toEqual([CMD_MOVE, CMD_CUBIC, CMD_MOVE, CMD_LINE, CMD_LINE, CMD_CLOSE]);
    // The cut curve starts about 28 units along the original one and ends short of (200, 200).
    expect(Math.hypot(e.shaft.pts[0]!, e.shaft.pts[1]!)).toBeCloseTo(28, 0);
    expect(e.shaft.pts[7]).toBeLessThan(200);
    expect(e.shaft.pts[7]).toBeGreaterThan(170);
    expect(e.shaft.pts.slice(8)).toEqual([300, 0, 400, 0, 350, 50]);
  });

  it('draws only the markers on a line shorter than them, and nothing for a point', () => {
    const e = withEnds(line(0, 0, 20, 0), { head: tri, tail: tri });
    expect(e.markers).toHaveLength(2);
    expect(e.shaft.cmds).toEqual([]);
    const dot = withEnds(line(5, 5, 5, 5), { head: tri });
    expect(dot.markers).toEqual([]);
  });

  it('reaches no further than the marker diagonal past the end', () => {
    expect(arrowReach(tri)).toBeCloseTo(Math.hypot(15, 30), 9);
    expect(arrowReach(undefined)).toBe(0);
  });
});
