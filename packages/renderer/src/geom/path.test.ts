import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileGeom, type PathCmdSource, type PathSource } from './compile.ts';
import {
  BUILTIN_COUNT,
  CMD_ARC,
  CMD_CLOSE,
  CMD_CUBIC,
  CMD_LINE,
  CMD_MOVE,
  CMD_QUAD,
  type CompiledGeom,
  GEOM_LIMITS,
} from './ops.ts';
import {
  type BuiltGeom,
  buildGeom,
  COORD_LIMIT,
  customGeometry,
  type GeomPath,
  hasPreset,
  pathData,
  pathPoints,
  presetGeometry,
} from './path.ts';
import { PRESET_GEOMS } from './presets.gen.ts';

/** A built path as segments: [cmd, coordinates...]. */
function segments(p: GeomPath): number[][] {
  const out: number[][] = [];
  let at = 0;
  for (const op of p.cmds) {
    const n = op === CMD_QUAD ? 4 : op === CMD_CUBIC ? 6 : op === CMD_CLOSE ? 0 : 2;
    out.push([op, ...p.pts.slice(at, at + n)]);
    at += n;
  }
  return out;
}

/** A custGeom path from a compact list: ['M', x, y], ['L', x, y], ['A', wR, hR, st, sw], ['Q', ...], ['C', ...], ['Z']. */
function path(cmds: (string | number)[][], attrs: Omit<PathSource, 'cmds'> = {}): PathSource {
  const ops: Record<string, string> = {
    M: 'moveTo',
    L: 'lnTo',
    A: 'arcTo',
    Q: 'quadBezTo',
    C: 'cubicBezTo',
    Z: 'close',
  };
  const list: PathCmdSource[] = cmds.map(([op, ...args]) => ({
    op: ops[op as string] ?? String(op),
    args: args.map(String),
  }));
  return { ...attrs, cmds: list };
}

function allFinite(b: BuiltGeom): boolean {
  const nums = [
    b.w,
    b.h,
    b.text.l,
    b.text.t,
    b.text.r,
    b.text.b,
    ...b.sites.flatMap((s) => [s.x, s.y, s.angle]),
  ];
  for (const p of b.paths) nums.push(...p.pts);
  return nums.every((v) => Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT);
}

describe('POI paths (tools/geom-gen/poi/PathDump.java)', () => {
  interface PoiPath {
    fill: string;
    stroke: boolean;
    segs: number[][];
  }
  interface PoiCase {
    case: string;
    paths: PoiPath[];
    rect?: number[];
    sites: number[][];
  }
  const data = JSON.parse(readFileSync(new URL('./poi-paths.json', import.meta.url), 'utf8')) as {
    cases: PoiCase[];
  };
  // java.awt.geom.PathIterator segment types → ours.
  const JAVA = [CMD_MOVE, CMD_LINE, CMD_QUAD, CMD_CUBIC, CMD_CLOSE];
  /**
   * Path2D.append(arc, true) adds a lineTo the arc's first point, which is the current point to rounding; ours
   * does not. Drop line segments of (near) zero length from both sides.
   */
  function normal(segs: number[][], eps: number): number[][] {
    const out: number[][] = [];
    let cx = Number.NaN;
    let cy = Number.NaN;
    for (const s of segs) {
      if (s[0] === CMD_LINE && Math.abs(s[1]! - cx) <= eps && Math.abs(s[2]! - cy) <= eps) continue;
      out.push(s);
      if (s.length > 1) {
        cx = s.at(-2)!;
        cy = s.at(-1)!;
      }
    }
    return out;
  }
  function build(c: string): BuiltGeom {
    const f = c.split(' ');
    if (f[0] === 'preset') {
      const adj = f.slice(4).map((kv) => {
        const [k, v] = kv.split('=');
        return [k!, Number(v)] as const;
      });
      return presetGeometry(f[1]!, Number(f[2]), Number(f[3]), adj)!;
    }
    const [, w, h, pw, ph, x0, y0, ...arcs] = f;
    const cmds: (string | number)[][] = [['M', x0!, y0!]];
    for (let i = 0; i + 3 < arcs.length; i += 4) cmds.push(['A', ...arcs.slice(i, i + 4)]);
    const src = path(cmds, { ...(pw === '-1' ? {} : { w: pw }), ...(ph === '-1' ? {} : { h: ph }) });
    return buildGeom(compileGeom({ paths: [src] }), Number(w), Number(h));
  }

  it('covers the dozen presets and arcs in every quadrant', () => {
    const presets = new Set(
      data.cases.filter((c) => c.case.startsWith('preset')).map((c) => c.case.split(' ')[1]),
    );
    expect([...presets].sort()).toEqual(
      [
        'arc',
        'can',
        'chevron',
        'cloud',
        'ellipse',
        'pie',
        'rect',
        'ribbon2',
        'rightArrow',
        'roundRect',
        'star5',
        'triangle',
      ].sort(),
    );
    expect(data.cases.filter((c) => c.case.startsWith('arc')).length).toBeGreaterThanOrEqual(15);
  });

  for (const c of data.cases) {
    it(c.case, () => {
      const b = build(c.case);
      const scale = Math.max(b.w, b.h);
      const eps = 1e-9 * scale;
      expect(b.paths.length).toBe(c.paths.length);
      c.paths.forEach((poi, i) => {
        const ours = b.paths[i]!;
        expect(ours.fill).toBe(
          {
            NORM: 'norm',
            NONE: 'none',
            LIGHTEN: 'lighten',
            LIGHTEN_LESS: 'lightenLess',
            DARKEN: 'darken',
            DARKEN_LESS: 'darkenLess',
          }[poi.fill],
        );
        expect(ours.stroke).toBe(poi.stroke);
        const want = normal(
          poi.segs.map(([t, ...xy]) => [JAVA[t!]!, ...xy]),
          eps,
        );
        const got = normal(segments(ours), eps);
        expect(got.map((s) => s[0])).toEqual(want.map((s) => s[0]));
        got.forEach((s, j) => {
          for (let k = 1; k < s.length; k++) expect(Math.abs(s[k]! - want[j]![k]!)).toBeLessThanOrEqual(eps);
        });
      });
      if (c.rect) {
        // POI's pie text rect is the uncorrected one (t='ir' r='it'); ours has third_party/poi-presets' fix.
        const [l, t, r, bt] = c.case.startsWith('preset pie ')
          ? [c.rect[0], c.rect[2], c.rect[1], c.rect[3]]
          : c.rect;
        for (const [got, want] of [
          [b.text.l, l],
          [b.text.t, t],
          [b.text.r, r],
          [b.text.b, bt],
        ])
          expect(Math.abs(got! - want!)).toBeLessThanOrEqual(eps);
      }
      expect(b.sites.length).toBe(c.sites.length);
      c.sites.forEach(([ang, x, y], i) => {
        expect(Math.abs(b.sites[i]!.x - x!)).toBeLessThanOrEqual(eps);
        expect(Math.abs(b.sites[i]!.y - y!)).toBeLessThanOrEqual(eps);
        expect(b.sites[i]!.angle).toBeCloseTo(ang! / 60000, 9);
      });
    });
  }
});

describe('preset point positions', () => {
  it('rect: the four corners, the box as text rect, the four edge midpoints as sites', () => {
    const b = presetGeometry('rect', 300, 200)!;
    expect(pathData(b.paths[0]!)).toBe('M 0 0 L 300 0 L 300 200 L 0 200 Z');
    expect(b.text).toEqual({ l: 0, t: 0, r: 300, b: 200 });
    expect(b.sites).toEqual([
      { x: 150, y: 0, angle: 270 },
      { x: 0, y: 100, angle: 180 },
      { x: 150, y: 200, angle: 90 },
      { x: 300, y: 100, angle: 0 },
    ]);
  });

  it('triangle: the apex moves with adj along the top edge', () => {
    expect(pathData(presetGeometry('triangle', 300, 200)!.paths[0]!)).toBe('M 0 200 L 150 0 L 300 200 Z');
    expect(pathData(presetGeometry('triangle', 300, 200, [['adj', 0]])!.paths[0]!)).toBe(
      'M 0 200 L 0 0 L 300 200 Z',
    );
    expect(pathData(presetGeometry('triangle', 300, 200, [['adj', 100000]])!.paths[0]!)).toBe(
      'M 0 200 L 300 0 L 300 200 Z',
    );
    // adj is pinned to 0..100000.
    expect(pathData(presetGeometry('triangle', 300, 200, [['adj', 250000]])!.paths[0]!)).toBe(
      'M 0 200 L 300 0 L 300 200 Z',
    );
  });

  it('rightArrow and chevron: corners from their guides', () => {
    // dy1 = ss·a1/200000 = 50, dx1 = ss·a2/100000 = 100.
    expect(pathData(presetGeometry('rightArrow', 300, 200)!.paths[0]!)).toBe(
      'M 0 50 L 200 50 L 200 0 L 300 100 L 200 200 L 200 150 L 0 150 Z',
    );
    // x1 = ss·a/100000 = 100, x2 = r − x1.
    expect(pathData(presetGeometry('chevron', 300, 200)!.paths[0]!)).toBe(
      'M 0 0 L 200 0 L 300 100 L 200 200 L 0 200 L 100 100 Z',
    );
  });

  it('ellipse: four quarter arcs through the edge midpoints, control points at 0.5523 of the radii', () => {
    const p = presetGeometry('ellipse', 300, 200)!.paths[0]!;
    expect(p.cmds).toEqual([CMD_MOVE, CMD_CUBIC, CMD_CUBIC, CMD_CUBIC, CMD_CUBIC, CMD_CLOSE]);
    expect(pathData(p, 2)).toBe(
      'M 0 100 C 0 44.77 67.16 0 150 0 C 232.84 0 300 44.77 300 100 C 300 155.23 232.84 200 150 200 C 67.16 200 0 155.23 0 100 Z',
    );
  });

  it('roundRect: corners of radius ss·adj/100000, the text rect inset by 29.3 % of it', () => {
    const b = presetGeometry('roundRect', 300, 200, [['adj', 25000]])!;
    expect(pathData(b.paths[0]!, 2)).toBe(
      'M 0 50 C 0 22.39 22.39 0 50 0 L 250 0 C 277.61 0 300 22.39 300 50 L 300 150 C 300 177.61 277.61 200 250 200 L 50 200 C 22.39 200 0 177.61 0 150 Z',
    );
    expect(b.text.l).toBeCloseTo(50 * (1 - Math.SQRT1_2), 3);
    expect(b.text.b).toBeCloseTo(200 - 50 * (1 - Math.SQRT1_2), 3);
  });

  it('roundRect with adj 0: square corners, the zero-radius arcs drawn as nothing (POI computes NaN)', () => {
    const b = presetGeometry('roundRect', 300, 200, [['adj', 0]])!;
    expect(pathData(b.paths[0]!)).toBe('M 0 0 L 300 0 L 300 200 L 0 200 Z');
  });

  it('pie: from stAng round to enAng, then to the centre; the corrected text rect', () => {
    const b = presetGeometry('pie', 300, 200)!;
    const s = segments(b.paths[0]!);
    expect(s[0]).toEqual([CMD_MOVE, 300, 100]);
    // 0° → 270° clockwise: three quarter turns, ending at the top.
    expect(s.slice(1, 4).every((x) => x[0] === CMD_CUBIC)).toBe(true);
    expect(s[3]![5]).toBeCloseTo(150, 9);
    expect(s[3]![6]).toBeCloseTo(0, 9);
    expect(s[4]).toEqual([CMD_LINE, 150, 100]);
    expect(s[5]).toEqual([CMD_CLOSE]);
    // ir − il and ib − it are the same fraction of w and h: the rect is centred.
    expect(b.text.l + b.text.r).toBeCloseTo(300, 9);
    expect(b.text.t + b.text.b).toBeCloseTo(200, 9);
    expect(b.text.t).toBeLessThan(b.text.b);
  });

  it('star5: ten vertices, the top one at (hc, t), symmetric about hc', () => {
    const p = presetGeometry('star5', 300, 200)!.paths[0]!;
    expect(p.cmds).toEqual([CMD_MOVE, ...Array(9).fill(CMD_LINE), CMD_CLOSE]);
    const xs = p.pts.filter((_, i) => i % 2 === 0);
    const ys = p.pts.filter((_, i) => i % 2 === 1);
    const top = ys.indexOf(Math.min(...ys));
    expect(xs[top]).toBeCloseTo(150, 9);
    expect(ys[top]).toBeCloseTo(0, 9);
    const mirrored = xs.map((x, i) => [300 - x, ys[i]!]);
    for (const [x, y] of mirrored)
      expect(xs.some((x2, j) => Math.abs(x2 - x!) < 1e-9 && Math.abs(ys[j]! - y!) < 1e-9)).toBe(true);
  });
});

describe('path spaces (a:path w and h)', () => {
  it('scales a path space to the box, each axis on its own', () => {
    const b = buildGeom(
      compileGeom({
        paths: [
          path(
            [
              ['M', 10, 10],
              ['L', 100, 50],
            ],
            { w: '100', h: '50' },
          ),
        ],
      }),
      300,
      200,
    );
    expect(pathData(b.paths[0]!)).toBe('M 30 40 L 300 200');
    const onlyW = buildGeom(
      compileGeom({
        paths: [
          path(
            [
              ['M', 10, 10],
              ['L', 100, 50],
            ],
            { w: '100' },
          ),
        ],
      }),
      300,
      200,
    );
    expect(pathData(onlyW.paths[0]!)).toBe('M 30 10 L 300 50');
  });

  it("evaluates a path's guides at its own space (POI computeOutlines), the text rect at the box", () => {
    const src = {
      rect: { l: 'wd4', t: 'hd4', r: 'w', b: 'h' },
      paths: [
        path(
          [
            ['M', 'wd2', 'hd2'],
            ['L', 'w', 'h'],
          ],
          { w: '100', h: '50' },
        ),
      ],
    };
    const b = buildGeom(compileGeom(src), 300, 200);
    // wd2 = 50 and hd2 = 25 in the 100 x 50 space: the box centre.
    expect(pathData(b.paths[0]!)).toBe('M 150 100 L 300 200');
    expect(b.text).toEqual({ l: 75, t: 50, r: 300, b: 200 });
  });

  it('scales arcs with the space: an ellipse drawn in a square space fills a wide box', () => {
    const circle = path([['M', 0, 50], ['A', 50, 50, 10800000, 21600000], ['Z']], { w: '100', h: '100' });
    const b = buildGeom(compileGeom({ paths: [circle] }), 400, 200);
    const s = segments(b.paths[0]!);
    expect(s.length).toBe(6);
    for (const seg of s.slice(1, 5)) {
      const [x, y] = [seg[5]!, seg[6]!];
      expect(((x - 200) / 200) ** 2 + ((y - 100) / 100) ** 2).toBeCloseTo(1, 12);
    }
  });

  it('cloud: its 43200 space scaled to the box, the text rect from guides at the box', () => {
    const b = presetGeometry('cloud', 300, 200)!;
    const first = segments(b.paths[0]!)[0]!;
    expect(first[1]).toBeCloseTo((3900 * 300) / 43200, 12);
    expect(first[2]).toBeCloseTo((14370 * 200) / 43200, 12);
    expect(b.text.l).toBeCloseTo((300 * 2977) / 21600, 9);
  });

  it('reads a path space over GEOM_LIMITS.pathSpace, zero or not a number as the box', () => {
    for (const w of ['1e12', '0', '-5', 'NaN', 'wd2']) {
      const b = buildGeom(
        compileGeom({
          paths: [
            path(
              [
                ['M', 0, 0],
                ['L', 'w', 'h'],
              ],
              { w, h: w },
            ),
          ],
        }),
        300,
        200,
      );
      expect(pathData(b.paths[0]!)).toBe('M 0 0 L 300 200');
    }
  });
});

describe('fill modes and stroke flags', () => {
  it("keeps each preset path's fill mode and stroke flag", () => {
    const can = presetGeometry('can', 300, 200)!;
    expect(can.paths.map((p) => [p.fill, p.stroke])).toEqual([
      ['norm', false],
      ['lighten', false],
      ['none', true],
    ]);
    const ribbon2 = presetGeometry('ribbon2', 300, 200)!;
    expect(ribbon2.paths.map((p) => p.fill)).toEqual(['norm', 'darkenLess', 'none']);
    expect(presetGeometry('arc', 300, 200)!.paths.map((p) => [p.fill, p.stroke])).toEqual([
      ['norm', false],
      ['none', true],
    ]);
  });

  it('reads every custGeom fill mode and stroke flag, an unknown fill as norm', () => {
    const fills = ['norm', 'none', 'lighten', 'lightenLess', 'darken', 'darkenLess', 'sparkle'];
    const g = customGeometry(
      {
        paths: fills.map((fill, i) =>
          path(
            [
              ['M', 0, 0],
              ['L', 1, 1],
            ],
            { fill, stroke: i % 2 ? 'false' : 'true' },
          ),
        ),
      },
      10,
      10,
    );
    expect(g.paths.map((p) => p.fill)).toEqual([
      'norm',
      'none',
      'lighten',
      'lightenLess',
      'darken',
      'darkenLess',
      'norm',
    ]);
    expect(g.paths.map((p) => p.stroke)).toEqual([true, false, true, false, true, false, true]);
    expect(g.notes.messages.some((m) => m.includes('sparkle'))).toBe(true);
  });
});

describe('path commands', () => {
  const build = (cmds: (string | number)[][]) => customGeometry({ paths: [path(cmds)] }, 100, 100).paths[0]!;

  it('keeps the second of two moveTos (Java Path2D), drops a close with nothing open or after a close', () => {
    expect(pathData(build([['M', 1, 1], ['M', 2, 2], ['L', 3, 3], ['Z'], ['Z']]))).toBe('M 2 2 L 3 3 Z');
    expect(pathData(build([['Z'], ['M', 1, 1], ['L', 3, 3]]))).toBe('M 1 1 L 3 3');
  });

  it('continues after a close from the sub-path start (an arc there starts at that point)', () => {
    const p = build([['M', 50, 0], ['L', 100, 0], ['Z'], ['A', 50, 50, 16200000, 5400000]]);
    const s = segments(p);
    expect(s[3]![0]).toBe(CMD_CUBIC);
    // From (50, 0) at the top of a circle centred (50, 50), a quarter turn clockwise ends at (100, 50).
    expect(s[3]![5]).toBeCloseTo(100, 9);
    expect(s[3]![6]).toBeCloseTo(50, 9);
  });

  it('starts a sub-path where Canvas would when the path does not start with moveTo', () => {
    expect(
      pathData(
        build([
          ['L', 5, 6],
          ['L', 7, 8],
        ]),
      ),
    ).toBe('M 5 6 L 7 8');
    expect(pathData(build([['Q', 1, 2, 3, 4]]))).toBe('M 1 2 Q 1 2 3 4');
    expect(pathData(build([['C', 1, 2, 3, 4, 5, 6]]))).toBe('M 1 2 C 1 2 3 4 5 6');
    // An arcTo has no point of its own: with no current point it is skipped (LibreOffice).
    expect(
      pathData(
        build([
          ['A', 10, 10, 0, 5400000],
          ['L', 7, 8],
        ]),
      ),
    ).toBe('M 7 8');
  });

  it('passes quadBezTo and cubicBezTo through', () => {
    expect(
      pathData(
        build([
          ['M', 0, 0],
          ['Q', 10, 0, 10, 10],
          ['C', 10, 20, 20, 20, 20, 10],
        ]),
      ),
    ).toBe('M 0 0 Q 10 0 10 10 C 10 20 20 20 20 10');
  });

  it('chains arcs, each from the end of the last', () => {
    const p = build([
      ['M', 100, 50],
      ['A', 50, 50, 0, 5400000],
      ['A', 50, 50, 5400000, 5400000],
      ['L', 50, 50],
    ]);
    const s = segments(p);
    expect(s.map((x) => x[0])).toEqual([CMD_MOVE, CMD_CUBIC, CMD_CUBIC, CMD_LINE]);
    expect(s[1]!.slice(5).map((v) => Number(v.toFixed(9)))).toEqual([50, 100]);
    expect(s[2]!.slice(5).map((v) => Number(v.toFixed(9)))).toEqual([0, 50]);
  });
});

describe('degenerate boxes', () => {
  it('builds every preset at an empty, a zero-width and a zero-height box: finite, an empty box collapsed', () => {
    for (const [name] of PRESET_GEOMS)
      for (const [w, h] of [
        [0, 0],
        [0, 100],
        [100, 0],
      ]) {
        const b = presetGeometry(name, w!, h!)!;
        expect(allFinite(b), `${name} ${w}x${h}`).toBe(true);
        // At 0 x 0 every guide is 0. (At 0 x 100 some presets still reach sideways: cornerTabs sizes its tabs
        // by the diagonal.)
        if (w === 0 && h === 0)
          for (const p of b.paths)
            expect(
              p.pts.every((v) => v === 0),
              name,
            ).toBe(true);
      }
    for (const name of ['rect', 'ellipse', 'roundRect', 'star5', 'cloud', 'can'])
      for (const p of presetGeometry(name, 0, 100)!.paths)
        for (let i = 0; i < p.pts.length; i += 2) expect(p.pts[i], name).toBe(0);
  });

  it('reads a box that is negative, not finite or huge as clamped', () => {
    for (const [w, h] of [
      [-10, 50],
      [Number.NaN, 50],
      [Number.POSITIVE_INFINITY, 50],
      [1e300, 1e300],
    ]) {
      const b = presetGeometry('ellipse', w!, h!)!;
      expect(b.w).toBe(w! > 0 ? COORD_LIMIT : 0);
      expect(allFinite(b)).toBe(true);
    }
  });

  it('draws a zero-width ellipse as a vertical segment through the box height', () => {
    const p = presetGeometry('ellipse', 0, 100)!.paths[0]!;
    const ys = p.pts.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 9);
    expect(Math.max(...ys)).toBeCloseTo(100, 9);
  });
});

describe('every preset', () => {
  it('builds finite paths within the bounds at several boxes, each starting with a moveTo', () => {
    for (const [name] of PRESET_GEOMS)
      for (const [w, h] of [
        [300, 200],
        [37, 900],
        [1920, 1080],
        [1e8, 3],
      ]) {
        const b = presetGeometry(name, w!, h!)!;
        expect(allFinite(b), name).toBe(true);
        expect(b.paths.length).toBeGreaterThan(0);
        expect(b.paths.length).toBeLessThanOrEqual(GEOM_LIMITS.paths);
        for (const p of b.paths) {
          expect(p.cmds[0], name).toBe(CMD_MOVE);
          expect(pathPoints(p)).toBeLessThanOrEqual(GEOM_LIMITS.points);
          expect(p.cmds.includes(CMD_ARC)).toBe(false);
        }
      }
  });

  it('knows the 187 names and nothing else', () => {
    expect(PRESET_GEOMS.size).toBe(187);
    expect(hasPreset('star5')).toBe(true);
    for (const name of ['', 'Star5', '__proto__', 'constructor', 'toString', 'rect '])
      expect(presetGeometry(name, 10, 10)).toBeUndefined();
  });

  it('follows adjust values: a later build at another box keeps the corners (resize)', () => {
    const small = presetGeometry('roundRect', 100, 100, [['adj', 50000]])!;
    const wide = presetGeometry('roundRect', 400, 100, [['adj', 50000]])!;
    // The corner radius is ss·adj: 50 in both, so the wide box has straight top edges of 300.
    expect(segments(small.paths[0]!)[2]).toEqual([CMD_LINE, 50, 0]);
    expect(segments(wide.paths[0]!)[2]).toEqual([CMD_LINE, 350, 0]);
  });
});

describe('hostile custGeom (design/27 §12)', () => {
  it('reads a cycle as 0 at its first forward reference: no recursion', () => {
    const g = customGeometry(
      {
        gd: [
          ['x', '+- y 1 0'],
          ['y', '+- x 1 0'],
        ],
        paths: [
          path([
            ['M', 'x', 'y'],
            ['L', 'y', 'x'],
          ]),
        ],
      },
      100,
      100,
    );
    expect(pathData(g.paths[0]!)).toBe('M 1 2 L 2 1');
    expect(g.notes.count).toBeGreaterThan(0);
  });

  it('drops guides, paths and points over the bounds, with notes', () => {
    const gd = Array.from(
      { length: 10_000 },
      (_, i) => [`g${i}`, i === 0 ? 'val 1' : `+- g${i - 1} 1 0`] as const,
    );
    const lines = Array.from({ length: 100_000 }, (_, i) => ['L', i % 100, 'g255']);
    const many = Array.from({ length: 1000 }, () => path([['M', 0, 0], ...lines.slice(0, 10)]));
    const t0 = performance.now();
    const g = customGeometry({ gd, paths: [path([['M', 0, 0], ...lines]), ...many] }, 100, 100);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(g.paths.length).toBe(GEOM_LIMITS.paths);
    expect(pathPoints(g.paths[0]!)).toBe(GEOM_LIMITS.points);
    // g255, the last guide kept, is 256; g256 onwards are dropped.
    expect(g.paths[0]!.pts[3]).toBe(256);
    expect(g.notes.messages.some((m) => m.includes('guides over the limit'))).toBe(true);
    expect(g.notes.messages.some((m) => m.includes('paths over the limit'))).toBe(true);
    expect(g.notes.messages.some((m) => m.includes('points over the limit'))).toBe(true);
  });

  it('bounds arcs: at most 4,096 points however many arcTo there are', () => {
    const arcs = Array.from({ length: 5000 }, () => ['A', 10, 20, 1000000, 21600000]);
    const g = customGeometry({ paths: [path([['M', 50, 50], ...arcs])] }, 100, 100);
    const p = g.paths[0]!;
    expect(pathPoints(p)).toBeLessThanOrEqual(GEOM_LIMITS.points);
    expect(pathPoints(p)).toBeGreaterThan(GEOM_LIMITS.points - 13);
    expect(allFinite(g)).toBe(true);
  });

  it('keeps every number finite and bounded: NaN, Infinity, huge values, huge spaces and angles', () => {
    const g = customGeometry(
      {
        gd: [
          ['big', '*/ 1e60 1e60 1'],
          ['nan', 'sqrt -1'],
          ['tiny', 'val 1e-300'],
        ],
        paths: [
          path([
            ['M', 'NaN', 'Infinity'],
            ['L', '1e400', '-1e308'],
            ['L', 'big', 'nan'],
            ['A', 'big', 'big', 'big', 'big'],
            ['Z'],
          ]),
          path(
            [
              ['M', 1, 1],
              ['L', 'big', 2],
              ['A', 5, 5, 0, 5400000],
            ],
            { w: '1e-300', h: '1e-300' },
          ),
          path([
            ['M', 'tiny', 'tiny'],
            ['A', 'tiny', 'big', 'big', '-1e60'],
            ['C', 'big', 0, 0, 'big', 'nan', 'nan'],
          ]),
        ],
        rect: { l: 'big', t: '-1e308', r: 'NaN', b: 'nan' },
        sites: [{ ang: 'big', x: 'big', y: '-1e70' }],
      },
      1920,
      1080,
    );
    expect(allFinite(g)).toBe(true);
    expect(g.paths[0]!.pts.slice(0, 4)).toEqual([0, 0, 0, -COORD_LIMIT]);
    expect(g.text).toEqual({ l: COORD_LIMIT, t: -COORD_LIMIT, r: 0, b: 0 });
  });

  it('checks a CompiledGeom that did not come from compileGeom: slots, op codes, counts', () => {
    const k = [5, 7];
    const kSlot = BUILTIN_COUNT;
    const lots = Array.from({ length: 20_000 }, () => [CMD_LINE, kSlot, kSlot + 1]).flat();
    const geom: CompiledGeom = {
      k,
      a: [],
      g: [],
      n: [],
      r: [-1, 99999, 1.5, Number.NaN],
      p: [
        {
          c: [
            CMD_MOVE,
            kSlot,
            kSlot + 1,
            CMD_LINE,
            -5,
            1e9,
            CMD_LINE,
            1.5,
            Number.NaN,
            42,
            0,
            0,
            CMD_LINE,
            kSlot,
            kSlot,
          ],
        },
        { c: [CMD_MOVE, kSlot, kSlot, CMD_CUBIC, kSlot] },
        { c: [CMD_MOVE, kSlot, kSlot, ...lots] },
        ...Array.from({ length: 20 }, () => ({ c: [CMD_MOVE, kSlot, kSlot] })),
      ],
      c: [kSlot, kSlot, kSlot, 1, 2],
    };
    const notes = { messages: [] as string[], count: 0 };
    const b = buildGeom(geom, 100, 100, undefined, notes);
    // Out-of-range and non-integer slots read 0; the unknown op code 42 ends the path.
    expect(pathData(b.paths[0]!)).toBe('M 5 7 L 0 0 L 0 0');
    // A command with too few operands ends its path.
    expect(pathData(b.paths[1]!)).toBe('M 5 5');
    expect(pathPoints(b.paths[2]!)).toBe(GEOM_LIMITS.points);
    expect(b.paths.length).toBe(GEOM_LIMITS.paths);
    expect(b.text).toEqual({ l: 0, t: 0, r: 0, b: 0 });
    expect(b.sites).toEqual([{ x: 5, y: 5, angle: 5 / 60000 }]);
    expect(notes.messages.length).toBeGreaterThan(0);
  });

  it('treats prototype-like guide names as names', () => {
    const g = customGeometry(
      {
        gd: [
          ['__proto__', 'val 3'],
          ['constructor', 'val 4'],
        ],
        paths: [path([['M', '__proto__', 'constructor']])],
      },
      10,
      10,
    );
    expect(pathData(g.paths[0]!)).toBe('M 3 4');
  });
});
