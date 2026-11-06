import type { Rgba } from '@ordo/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx2D } from '../ctx.ts';
import {
  CLOSED_TOLERANCE,
  drawGeom,
  FILL_BRIGHTNESS,
  GEOM_FILL_RULE,
  geomFillPath2D,
  geomPath2D,
  geomPathOpen,
  type PathSink,
  shadeRgba,
  traceGeomPath,
} from './draw.ts';
import { PATH_FILLS } from './ops.ts';
import { type BuiltGeom, customGeometry, presetGeometry } from './path.ts';

/** A Path2D that records what is traced into it (Node has none). */
class RecPath implements PathSink {
  readonly ops: string[] = [];
  moveTo(x: number, y: number): void {
    this.ops.push(`M ${x} ${y}`);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(`L ${x} ${y}`);
  }
  quadraticCurveTo(a: number, b: number, x: number, y: number): void {
    this.ops.push(`Q ${a} ${b} ${x} ${y}`);
  }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
    this.ops.push(`C ${a} ${b} ${c} ${d} ${x} ${y}`);
  }
  closePath(): void {
    this.ops.push('Z');
  }
}

/** A 2D context that records fills and strokes with the style they used. */
function recCtx() {
  const calls: { kind: 'fill' | 'stroke'; style: unknown; rule?: string; width?: number; path: RecPath }[] =
    [];
  const ctx = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    fill(path: RecPath, rule?: string) {
      calls.push({ kind: 'fill', style: this.fillStyle, rule, path });
    },
    stroke(path: RecPath) {
      calls.push({ kind: 'stroke', style: this.strokeStyle, width: this.lineWidth, path });
    },
  };
  return { ctx: ctx as unknown as Ctx2D, calls };
}

const red: Rgba = { r: 200, g: 100, b: 50, a: 0.5 };

beforeAll(() => {
  vi.stubGlobal('Path2D', RecPath);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('shadeRgba (LibreOffice GetColorData)', () => {
  it('blends towards white for lighten and towards black for darken, truncating, keeping alpha', () => {
    // lighten: c·0.6 + 102; lightenLess: c·0.8 + 51; darken: c·0.6; darkenLess: c·0.8.
    expect(shadeRgba(red, FILL_BRIGHTNESS.lighten)).toEqual({ r: 222, g: 162, b: 132, a: 0.5 });
    expect(shadeRgba(red, FILL_BRIGHTNESS.lightenLess)).toEqual({ r: 211, g: 131, b: 91, a: 0.5 });
    expect(shadeRgba(red, FILL_BRIGHTNESS.darken)).toEqual({ r: 120, g: 60, b: 30, a: 0.5 });
    expect(shadeRgba(red, FILL_BRIGHTNESS.darkenLess)).toEqual({ r: 160, g: 80, b: 40, a: 0.5 });
    expect(shadeRgba({ r: 255, g: 255, b: 255, a: 1 }, -0.4)).toEqual({ r: 153, g: 153, b: 153, a: 1 });
    expect(shadeRgba({ r: 0, g: 0, b: 0, a: 1 }, 0.4)).toEqual({ r: 102, g: 102, b: 102, a: 1 });
    // Truncation, not rounding: 1·0.8 = 0.8 → 0; 99·0.6 + 102 = 161.4 → 161.
    expect(shadeRgba({ r: 1, g: 99, b: 254, a: 1 }, -0.2)).toEqual({ r: 0, g: 79, b: 203, a: 1 });
    expect(shadeRgba({ r: 1, g: 99, b: 254, a: 1 }, 0.4).g).toBe(161);
  });

  it('returns the colour itself for norm and none, and clamps a bad colour or brightness', () => {
    expect(shadeRgba(red, FILL_BRIGHTNESS.norm)).toBe(red);
    expect(shadeRgba(red, FILL_BRIGHTNESS.none)).toBe(red);
    expect(shadeRgba(red, Number.NaN)).toBe(red);
    expect(shadeRgba({ r: 300, g: -5, b: Number.NaN, a: 1 }, -0.2)).toEqual({ r: 204, g: 0, b: 0, a: 1 });
    expect(shadeRgba(red, 7)).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
    expect(shadeRgba(red, -7)).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });

  it('has a brightness for every fill mode', () => {
    expect(Object.keys(FILL_BRIGHTNESS).sort()).toEqual([...PATH_FILLS].sort());
  });
});

describe('traceGeomPath', () => {
  it('traces every command with its coordinates', () => {
    const g = customGeometry(
      {
        paths: [
          {
            cmds: [
              { op: 'moveTo', args: ['1', '2'] },
              { op: 'lnTo', args: ['3', '4'] },
              { op: 'quadBezTo', args: ['5', '6', '7', '8'] },
              { op: 'cubicBezTo', args: ['9', '10', '11', '12', '13', '14'] },
              { op: 'close', args: [] },
            ],
          },
        ],
      },
      100,
      100,
    );
    const rec = new RecPath();
    traceGeomPath(rec, g.paths[0]!);
    expect(rec.ops).toEqual(['M 1 2', 'L 3 4', 'Q 5 6 7 8', 'C 9 10 11 12 13 14', 'Z']);
  });
});

describe('drawGeom', () => {
  const can = presetGeometry('can', 300, 200)!;

  it('fills and strokes each path in order: norm and lighten filled, the outline stroked', () => {
    const { ctx, calls } = recCtx();
    drawGeom(ctx, can, red, { color: { r: 0, g: 0, b: 0, a: 1 }, width: 3 });
    expect(calls.map((c) => c.kind)).toEqual(['fill', 'fill', 'stroke']);
    expect(calls[0]!.style).toBe('rgba(200,100,50,0.5)');
    expect(calls[1]!.style).toBe('rgba(222,162,132,0.5)');
    expect(calls[2]!.style).toBe('rgba(0,0,0,1)');
    expect(calls[2]!.width).toBe(3);
    for (const c of calls.filter((x) => x.kind === 'fill')) expect(c.rule).toBe(GEOM_FILL_RULE);
    expect(GEOM_FILL_RULE).toBe('evenodd');
    expect(calls[2]!.path.ops[0]).toMatch(/^M /);
  });

  const tri = (x: number, close: boolean) => [
    { op: 'moveTo', args: [String(x), '0'] },
    { op: 'lnTo', args: [String(x + 5), '10'] },
    { op: 'lnTo', args: [String(x), '10'] },
    ...(close ? [{ op: 'close', args: [] }] : []),
  ];

  it('draws a closed path filled and stroked as fill then stroke before the next path (LibreOffice order)', () => {
    const g = customGeometry(
      { paths: [{ cmds: tri(0, true) }, { fill: 'darken', cmds: tri(5, true) }] },
      10,
      10,
    );
    const { ctx, calls } = recCtx();
    drawGeom(ctx, g, red, { color: red, width: 1 });
    expect(calls.map((c) => `${c.kind} ${c.style}`)).toEqual([
      'fill rgba(200,100,50,0.5)',
      'stroke rgba(200,100,50,0.5)',
      'fill rgba(120,60,30,0.5)',
      'stroke rgba(200,100,50,0.5)',
    ]);
  });

  it("strokes open paths after every path, in order (LibreOffice's line objects go last)", () => {
    const g = customGeometry(
      { paths: [{ cmds: tri(0, false) }, { fill: 'darken', cmds: tri(5, true) }, { cmds: tri(2, false) }] },
      10,
      10,
    );
    const { ctx, calls } = recCtx();
    drawGeom(ctx, g, red, { color: { r: 0, g: 0, b: 0, a: 1 }, width: 1 });
    expect(calls.map((c) => `${c.kind} ${c.path.ops[0]}`)).toEqual([
      'fill M 0 0',
      'fill M 5 0',
      'stroke M 5 0',
      'fill M 2 0',
      'stroke M 0 0',
      'stroke M 2 0',
    ]);
    // chartX: its lines (fill none, open) come before the filled box and are drawn over it.
    const chart = recCtx();
    drawGeom(chart.ctx, presetGeometry('chartX', 300, 200)!, red, {
      color: { r: 0, g: 0, b: 0, a: 1 },
      width: 2,
    });
    expect(chart.calls.map((c) => c.kind)).toEqual(['fill', 'stroke']);
    expect(chart.calls[1]!.path.ops.filter((op) => op.startsWith('M')).length).toBe(2);
  });

  it('counts a path as open when a sub-path is neither closed nor ends at its start', () => {
    const path = (cmds: ReturnType<typeof tri>) => customGeometry({ paths: [{ cmds }] }, 10, 10).paths[0]!;
    expect(geomPathOpen(path(tri(0, false)))).toBe(true);
    expect(geomPathOpen(path(tri(0, true)))).toBe(false);
    // Back at its start without a close: closed for LibreOffice (checkClosed), within the tolerance only.
    const back = (end: string) => [...tri(0, false), { op: 'lnTo', args: [end, '0'] }];
    expect(geomPathOpen(path(back('0')))).toBe(false);
    expect(geomPathOpen(path(back('0.001')))).toBe(true);
    expect(geomPathOpen(path(back('0.001')), 0.01)).toBe(false);
    // One open sub-path among closed ones; a lone moveTo or a moveTo and close is not a sub-path.
    expect(geomPathOpen(path([...tri(0, true), ...tri(2, false)]))).toBe(true);
    expect(geomPathOpen(path([...tri(2, false), ...tri(0, true)]))).toBe(true);
    expect(geomPathOpen(path([...tri(0, true), { op: 'moveTo', args: ['3', '3'] }]))).toBe(false);
    expect(
      geomPathOpen(
        path([
          { op: 'moveTo', args: ['3', '3'] },
          { op: 'close', args: [] },
        ]),
      ),
    ).toBe(false);
    // The presets' full ellipses end at their start up to rounding: smileyFace's eyes are not open.
    const smiley = presetGeometry('smileyFace', 300, 200)!;
    expect(smiley.paths.map((p) => geomPathOpen(p, CLOSED_TOLERANCE * 300))).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it('skips fills without a fill, strokes without a stroke or with no width, and empty paths', () => {
    const { ctx, calls } = recCtx();
    drawGeom(ctx, can, null, { color: red, width: 2 });
    expect(calls.map((c) => c.kind)).toEqual(['stroke']);
    const r2 = recCtx();
    drawGeom(r2.ctx, can, red);
    expect(r2.calls.map((c) => c.kind)).toEqual(['fill', 'fill']);
    const r3 = recCtx();
    drawGeom(r3.ctx, can, undefined, { color: red, width: 0 });
    drawGeom(r3.ctx, can, undefined, { color: red, width: Number.NaN });
    drawGeom(r3.ctx, presetGeometry('rect', 0, 0)!, null, null);
    const empty: BuiltGeom = { ...can, paths: [{ cmds: [], pts: [], fill: 'norm', stroke: true }] };
    drawGeom(r3.ctx, empty, red, { color: red, width: 1 });
    expect(r3.calls).toEqual([]);
  });

  it("asks a painter for each fill mode's brightness once, for gradients and pictures", () => {
    const asked: number[] = [];
    const painter = (b: number): string => {
      asked.push(b);
      return `paint ${b}`;
    };
    const ribbon = presetGeometry('ribbon2', 300, 200)!;
    const { ctx, calls } = recCtx();
    drawGeom(ctx, ribbon, painter);
    expect(asked).toEqual([0, -0.2]);
    expect(calls.map((c) => c.style)).toEqual(['paint 0', 'paint -0.2']);
  });

  it('takes a stroke paint that is a style string or gradient as it is', () => {
    const { ctx, calls } = recCtx();
    drawGeom(ctx, can, null, { color: '#123456', width: 1 });
    expect(calls[0]!.style).toBe('#123456');
  });

  it('builds one Path2D per built path and reuses it', () => {
    const p = can.paths[0]!;
    expect(geomPath2D(p)).toBe(geomPath2D(p));
    const all = geomFillPath2D(can) as unknown as RecPath;
    // The two filled paths (norm and lighten), not the outline (fill none).
    expect(all.ops.filter((op) => op.startsWith('M')).length).toBe(2);
  });
});
