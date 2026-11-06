import { describe, expect, it } from 'vitest';
import {
  cleanPathData,
  formatPathData,
  PATH_DATA_LIMITS,
  parsePathData,
  pathDataPoints,
} from './pathdata.ts';

/** design/27 §3.1 ShapeGeom.paths, §12: stored path strings are re-tokenised before anything draws them. */
describe('parsePathData', () => {
  it('reads M L Q C Z with their numbers, commas and any whitespace', () => {
    expect(parsePathData('M 0 0 L 10,0 Q 1 2 3 4\tC 1 2 3 4 5 6\nZ')).toEqual({
      cmds: 'MLQCZ',
      pts: [0, 0, 10, 0, 1, 2, 3, 4, 1, 2, 3, 4, 5, 6],
    });
  });

  it('repeats a command for more numbers (after M, lines), as SVG does', () => {
    expect(parsePathData('M 0 0 1 1 2 2 L 3 3 4 4')).toEqual({
      cmds: 'MLLLL',
      pts: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
    });
    expect(parsePathData('M0 0C1 1 2 2 3 3 4 4 5 5 6 6').cmds).toBe('MCC');
  });

  it('reads plain decimals only, clamped to the coordinate bound', () => {
    expect(parsePathData('M .5 5. L -.5e-3 +7e2').pts).toEqual([0.5, 5, -0.0005, 700]);
    expect(parsePathData('M 1e999 -1e999').pts).toEqual([PATH_DATA_LIMITS.coord, -PATH_DATA_LIMITS.coord]);
    expect(parsePathData('M -0 0').pts).toEqual([0, 0]);
    for (const bad of ['M NaN 0', 'M Infinity 0', 'M 0x10 0', 'M 1f 0'])
      expect(parsePathData(bad).cmds).toBe('');
  });

  it('stops at the first token that does not fit, keeping whole commands before it', () => {
    expect(parsePathData('M 0 0 L 1 1 l 2 2 L 3 3')).toEqual({ cmds: 'ML', pts: [0, 0, 1, 1] });
    expect(parsePathData('M 0 0 A 1 1 0 0 1 5 5').cmds).toBe('M');
    expect(parsePathData('M 0 0 L 1').cmds).toBe('M'); // a command missing numbers is dropped
    expect(parsePathData('M 0 0 L 1 L 2 2').cmds).toBe('M');
    expect(parsePathData('5 5 L 1 1').cmds).toBe(''); // numbers before any command
    expect(parsePathData('M 0 0 Z 5 5').cmds).toBe('MZ');
    expect(parsePathData('M 0 0 <script>').cmds).toBe('M');
  });

  it('reads anything that is not a string as an empty path', () => {
    for (const v of [undefined, null, 5, {}, ['M 0 0']])
      expect(parsePathData(v)).toEqual({ cmds: '', pts: [] });
  });

  it('keeps at most 4,096 points (M L Z 1, Q 2, C 3) and stops at the command that would pass them', () => {
    const lines = `M 0 0 ${'L 1 1 '.repeat(5000)}`;
    const p = parsePathData(lines);
    expect(pathDataPoints(p)).toBe(4096);
    const cubics = `M 0 0 ${'C 1 1 2 2 3 3 '.repeat(2000)}`;
    expect(pathDataPoints(parsePathData(cubics))).toBe(1 + 3 * 1365);
    expect(pathDataPoints(parsePathData(lines, 10))).toBe(10);
  });
});

describe('cleanPathData', () => {
  it('writes the parsed path back as M L Q C Z and shortest numbers, idempotently', () => {
    const d = cleanPathData('M0,0 L 10.50 0 Q1e1 2 3 4 Z garbage');
    expect(d).toBe('M 0 0 L 10.5 0 Q 10 2 3 4 Z');
    expect(cleanPathData(d)).toBe(d);
  });

  it('keeps whole commands within the character bound', () => {
    const p = parsePathData(`M 0 0 ${'L 123456.789 -98765.4321 '.repeat(4000)}`);
    const d = formatPathData(p);
    expect(d.length).toBeLessThanOrEqual(PATH_DATA_LIMITS.chars);
    expect(cleanPathData(d)).toBe(d);
    expect(formatPathData(p, 20)).toBe('M 0 0');
  });
});
