import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cleanPathData,
  formatPathData,
  PATH_DATA_LIMITS,
  type PathData,
  parsePathData,
  pathDataPoints,
} from './pathdata.ts';

/** The parser as it was before its fast path (M6 finish), the oracle of the differential property below. */
const REF_ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const REF_POINTS: Readonly<Record<string, number>> = { M: 1, L: 1, Q: 2, C: 3, Z: 1 };

function refIsDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function refIsSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44;
}

/** The end of the number starting at `i`, or -1 when none starts there. */
function refNumberEnd(d: string, i: number): number {
  let j = i;
  const c0 = d.charCodeAt(j);
  if (c0 === 43 || c0 === 45) j++;
  let digits = 0;
  while (refIsDigit(d.charCodeAt(j))) {
    j++;
    digits++;
  }
  if (d.charCodeAt(j) === 46) {
    j++;
    while (refIsDigit(d.charCodeAt(j))) {
      j++;
      digits++;
    }
  }
  if (digits === 0) return -1;
  const e = d.charCodeAt(j);
  if (e === 101 || e === 69) {
    let k = j + 1;
    const s = d.charCodeAt(k);
    if (s === 43 || s === 45) k++;
    if (refIsDigit(d.charCodeAt(k))) {
      while (refIsDigit(d.charCodeAt(k))) k++;
      j = k;
    }
  }
  return j;
}

function refCoordOf(v: number): number {
  const L = PATH_DATA_LIMITS.coord;
  if (!(v > -L)) return v <= -L ? -L : 0;
  return v > L ? L : v + 0;
}

/**
 * Parse path data (any value: a non-string is an empty path) into commands and coordinates, at most
 * `maxPoints` points (a command that would pass it ends the path). Never throws; linear in the input.
 */
function referenceParse(d: unknown, maxPoints: number = PATH_DATA_LIMITS.points): PathData {
  let cmds = '';
  const pts: number[] = [];
  if (typeof d !== 'string') return { cmds, pts };
  const s = d.length > PATH_DATA_LIMITS.chars * 4 ? d.slice(0, PATH_DATA_LIMITS.chars * 4) : d;
  const limit = Math.max(0, Math.min(Math.floor(maxPoints) || 0, PATH_DATA_LIMITS.points));
  let points = 0;
  let cmd = '';
  const args: number[] = [];
  let i = 0;
  const n = s.length;
  /** Emit `cmd` with `args` when complete; false when the point budget is spent. */
  const emit = (): boolean => {
    const p = REF_POINTS[cmd]!;
    if (points + p > limit) return false;
    points += p;
    cmds += cmd;
    for (const a of args) pts.push(a);
    args.length = 0;
    if (cmd === 'M') cmd = 'L';
    return true;
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (refIsSpace(c)) {
      i++;
      continue;
    }
    const ch = s[i]!;
    if (REF_ARITY[ch] !== undefined) {
      if (args.length) break; // a command with too few numbers: stop here
      cmd = ch;
      i++;
      if (cmd === 'Z' && !emit()) break;
      continue;
    }
    const end = refNumberEnd(s, i);
    if (end < 0 || cmd === '' || cmd === 'Z') break;
    args.push(refCoordOf(Number(s.slice(i, end))));
    i = end;
    if (args.length === REF_ARITY[cmd] && !emit()) {
      args.length = 0;
      break;
    }
  }
  return { cmds, pts };
}

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

  it('reads every number exactly as Number does (its fast path for plain decimals included)', () => {
    const num = fc
      .tuple(
        fc.constantFrom('', '-', '+'),
        fc.stringMatching(/^[0-9]{0,18}$/),
        fc.option(fc.stringMatching(/^[0-9]{0,18}$/), { nil: undefined }),
        fc.option(fc.stringMatching(/^[eE][+-]?[0-9]{1,3}$/), { nil: undefined }),
      )
      .filter(([, a, b]) => a.length > 0 || (b ?? '').length > 0)
      .map(([sign, a, b, e]) => `${sign}${a}${b === undefined ? '' : `.${b}`}${e ?? ''}`);
    fc.assert(
      fc.property(num, num, (x, y) => {
        const L = PATH_DATA_LIMITS.coord;
        const want = [x, y].map((t) => {
          const v = Number(t);
          return v > L ? L : v < -L ? -L : v + 0;
        });
        expect(parsePathData(`M ${x} ${y}`).pts).toEqual(want);
      }),
      { numRuns: 2_000, seed: 12 },
    );
    for (const t of [
      '0.1',
      '500.12',
      '-0.000001',
      '0.123456789012345',
      '0.1234567890123456',
      '900719925.4740993',
      '.5',
      '5.',
    ])
      expect(parsePathData(`M ${t} 0`).pts[0]).toBe(Number(t) + 0);
  });

  it('reads every string as the earlier parser did (differential, fast-check)', () => {
    const token = fc.oneof(
      fc.constantFrom(
        'M',
        'L',
        'Q',
        'C',
        'Z',
        'A',
        'm',
        ' ',
        ',',
        '\t',
        '\n',
        '-',
        '+',
        '.',
        'e',
        'E',
        '1e400',
        'NaN',
      ),
      fc.double({ noNaN: true, min: -1e12, max: 1e12 }).map(String),
      fc.integer({ min: -100_000, max: 100_000 }).map(String),
      fc.stringMatching(/^-?[0-9]{1,20}(\.[0-9]{0,20})?$/),
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 200 }), fc.integer({ min: -2, max: 5_000 }), (parts, max) => {
        const d = parts.join(fc.sample(fc.constantFrom(' ', ''), { seed: parts.length, numRuns: 1 })[0]!);
        expect(parsePathData(d, max)).toEqual(referenceParse(d, max));
        expect(parsePathData(`M 0 0 ${d}`)).toEqual(referenceParse(`M 0 0 ${d}`));
      }),
      { numRuns: 3_000, seed: 2026 },
    );
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
