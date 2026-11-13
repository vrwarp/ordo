import { type ShapeObject, Slide } from '@ordo/domain';
import { geomSlide } from '@ordo/domain/geom.test-util.ts';
import * as prev from '@ordo/domain/schemas.prev.test-util.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { effectCacheBytes } from './effects.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { clearGeomFiles, putGeomFile } from './geom/stored.ts';
import { objectBounds } from './scene.ts';
import {
  cappedDash,
  DASH_PATTERNS,
  drawGeomShape,
  hasShapeExtras,
  lineStyleOf,
  shapeGeometry,
  shapeReach,
} from './shape.ts';
import { drawShape, drawSlide2D } from './text2d.ts';
import { type RecordedGradient, recordingCtx } from './text/test-util.ts';

/**
 * PowerPoint shapes (design/27 §3.1, §15 M6): which path draws a shape, where its box space lands, its paint,
 * dashes and ends, and the compatibility rule (§14.7): a stripped M6 slide draws its legacy shapes.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());

const white = { r: 255, g: 255, b: 255, a: 1 };
const red = { r: 255, g: 0, b: 0, a: 1 };
const base: ShapeObject = {
  id: 's',
  type: 'shape',
  box: { x: 100, y: 200, w: 400, h: 200, rotation: 0 },
  shape: 'rect',
  fill: red,
  opacity: 1,
  radius: 0,
};

const ops = (o: ShapeObject, scale = 0.5) => {
  const ctx = recordingCtx();
  drawShape(ctx, o, scale);
  return ctx.ops;
};

describe('joins and caps (lineJoin, lineCap)', () => {
  it('maps them to Canvas, defaults miter and butt, and draws a shape with either through its geometry', () => {
    expect(lineStyleOf({})).toEqual({ join: 'miter', cap: 'butt' });
    expect(lineStyleOf({ lineJoin: 'round', lineCap: 'round' })).toEqual({ join: 'round', cap: 'round' });
    expect(lineStyleOf({ lineJoin: 'bevel', lineCap: 'square' })).toEqual({ join: 'bevel', cap: 'square' });
    expect(hasShapeExtras({ lineJoin: 'round' })).toBe(true);
    expect(hasShapeExtras({ lineCap: 'square' })).toBe(true);
    expect(hasShapeExtras({ lineJoin: 'miter', lineCap: 'flat' })).toBe(false);
  });

  it('draws round and square caps within a preset dash, as Office does (LibreOffice: −0.99 and +0.99 widths)', () => {
    expect(cappedDash(DASH_PATTERNS.sysDot, 'round').map((v) => Math.round(v * 100) / 100)).toEqual([
      0.01, 1.99,
    ]);
    expect(cappedDash(DASH_PATTERNS.dashDot, 'square').map((v) => Math.round(v * 100) / 100)).toEqual([
      3.01, 3.99, 0.01, 3.99,
    ]);
    expect(cappedDash(DASH_PATTERNS.dash, 'flat')).toEqual([4, 3]);
    expect(cappedDash(DASH_PATTERNS.dash, undefined)).toEqual([4, 3]);
    expect(cappedDash([0.5, 1], 'round')).toEqual([0.5, 1]);
  });

  it('strokes with the joins, caps and capped dash given', () => {
    const rec = recordingCtx();
    const caps: unknown[] = [];
    const ctx = new Proxy(rec, {
      set(t, k, v) {
        if (k === 'lineCap') caps.push(v);
        return Reflect.set(t, k, v);
      },
    });
    drawGeomShape(
      ctx,
      {
        ...base,
        geom: { preset: 'star5' },
        stroke: { width: 10, color: white },
        lineJoin: 'round',
        lineCap: 'round',
        dash: 'sysDot',
      },
      1,
    );
    const stroke = rec.ops.find((x) => x.op === 'stroke');
    expect(stroke?.state.lineJoin).toBe('round');
    expect(caps).toContain('round');
    const dash = (rec.ops.find((x) => x.op === 'setLineDash')?.args[0] ?? []) as number[];
    expect(dash.map((v) => Math.round(v * 100) / 100)).toEqual([0.1, 19.9]);
  });
});

describe('drawShape dispatch', () => {
  it('draws a legacy shape exactly as before (roundRect, fill, stroke under the scale)', () => {
    const o = ops({ ...base, stroke: { width: 4, color: white }, radius: 10 });
    expect(o.map((x) => x.op)).toEqual(['beginPath', 'beginPath', 'roundRect', 'fill', 'stroke']);
    expect(o[2]!.args).toEqual([50, 100, 200, 100, 5]);
  });

  it('draws a shape with any M6 field through its geometry', () => {
    for (const extra of [
      { geom: { preset: 'star5' } },
      {
        gradient: {
          kind: 'linear' as const,
          stops: [
            { at: 0, color: red },
            { at: 1, color: white },
          ],
        },
      },
      { dash: 'dot' as const },
      { ends: { tail: { type: 'triangle' as const } } },
      { flipH: true },
      { flipV: true },
      { shadow: { dx: 1, dy: 1, blur: 1, color: red } },
      { glow: { radius: 2, color: red } },
      { softEdge: 3 },
    ]) {
      expect(hasShapeExtras({ ...base, ...extra })).toBe(true);
      const o = ops({ ...base, ...extra });
      expect(o.some((x) => x.op === 'roundRect')).toBe(false);
      expect(o.some((x) => x.op === 'fill' && x.args[0] instanceof RecPath)).toBe(true);
    }
    expect(hasShapeExtras(base)).toBe(false);
    expect(hasShapeExtras({ ...base, flipH: false })).toBe(false);
  });
});

describe('drawGeomShape', () => {
  it('maps box space to the device: translated, rotated about the centre, scaled and flipped', () => {
    const fill = (o: ShapeObject) => ops(o).find((x) => x.op === 'fill')!;
    expect(fill({ ...base, flipH: true }).transform).toEqual([-0.5, 0, 0, 0.5, 250, 100]);
    expect(fill({ ...base, flipV: true }).transform).toEqual([0.5, 0, 0, -0.5, 50, 200]);
    const t = fill({ ...base, flipH: true, box: { ...base.box, rotation: 90 } }).transform;
    // Rotated 90° about the centre (150, 150 device px), mirrored: box x runs up the page from (200, 250).
    expect(t.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, -0.5, -0.5, 0, 200, 250]);
  });

  it('fills a gradient built over the box, every path from one gradient', () => {
    const o = ops({
      ...base,
      geom: { preset: 'can' },
      gradient: {
        kind: 'linear',
        angle: 0,
        stops: [
          { at: 0, color: red },
          { at: 1, color: white },
        ],
      },
    });
    const fills = o.filter((x) => x.op === 'fill');
    expect(fills).toHaveLength(2);
    const g0 = fills[0]!.fillStyle as RecordedGradient;
    expect(g0.args).toEqual([0, 100, 400, 100]);
    // The lightened top of the can: the same gradient with its stops shaded.
    const g1 = fills[1]!.fillStyle as RecordedGradient;
    expect(g1.args).toEqual(g0.args);
    expect(g1.stops[0]![1]).toBe('rgba(255,102,102,1)');
  });

  it('strokes with the dash pattern scaled by the line width and fills arrowheads in the line colour', () => {
    const o = ops({
      ...base,
      geom: { preset: 'line' },
      fill: undefined,
      stroke: { width: 4, color: white },
      dash: 'dashDot',
      ends: { head: { type: 'triangle' }, tail: { type: 'oval', w: 'lg', len: 'lg' } },
    });
    const dash = o.find((x) => x.op === 'setLineDash')!;
    expect(dash.args[0]).toEqual(DASH_PATTERNS.dashDot.map((v) => v * 4));
    expect(o.filter((x) => x.op === 'stroke')).toHaveLength(1);
    const markers = o.filter((x) => x.op === 'fill');
    expect(markers).toHaveLength(2);
    expect(markers.every((m) => m.fillStyle === 'rgba(255,255,255,1)')).toBe(true);
    expect(o.find((x) => x.op === 'stroke')!.state.lineJoin).toBe('miter');
  });

  it('fills nothing for a legacy line and draws nothing at opacity 0', () => {
    expect(
      ops({ ...base, shape: 'line', flipH: true, stroke: { width: 2, color: white } }).filter(
        (x) => x.op === 'fill',
      ),
    ).toEqual([]);
    expect(ops({ ...base, flipH: true, opacity: 0 }).filter((x) => x.op === 'fill')).toEqual([]);
  });

  it('draws effects without sprites where there is no OffscreenCanvas (Node): the shape itself, at its opacity', () => {
    const o = ops({ ...base, opacity: 0.5, shadow: { dx: 4, dy: 4, blur: 8, color: red } });
    const f = o.find((x) => x.op === 'fill')!;
    expect(f.state.globalAlpha).toBe(0.5);
    expect(effectCacheBytes()).toBe(0);
  });

  it('measures a callout tail and arrowheads past the box for the scene split', () => {
    const callout: ShapeObject = { ...base, geom: { preset: 'wedgeRectCallout', adj: [['adj2', 100_000]] } };
    expect(shapeReach(callout, shapeGeometry(callout))).toBeGreaterThan(40);
    expect(shapeReach(base, shapeGeometry(base))).toBe(0);
    const arrow: ShapeObject = {
      ...base,
      stroke: { width: 10, color: red },
      ends: { tail: { type: 'triangle', w: 'lg' } },
    };
    expect(shapeReach(arrow, shapeGeometry(arrow))).toBeCloseTo(Math.hypot(25, 30), 9);
    // The scene split (design/27 §7.2) sees the tail: the bounds reach below the box.
    const b = objectBounds(callout);
    expect(b.y + b.h).toBeGreaterThan(base.box.y + base.box.h + 40);
  });

  it('draws with no Path2D-unsafe input: garbage geometry falls back to the legacy shape', () => {
    const o = ops({ ...base, geom: { paths: [{ d: 'not a path', w: 1, h: 1 }] } as ShapeObject['geom'] });
    expect(o.some((x) => x.op === 'fill')).toBe(true);
  });
});

describe('M6 compatibility (design/27 §14.7)', () => {
  const img = { width: 160, height: 90 } as unknown as CanvasImageSource;
  const drawn = (slide: Slide) => {
    const ctx = recordingCtx();
    drawSlide2D(ctx, slide, { scale: 0.5, images: () => img });
    return ctx.ops;
  };

  it('the previous release (0.5.0) keeps the M6 fields: the slide draws as this build draws it', () => {
    // Compared as recorded (each draw builds its own path and gradient objects).
    const json = (slide: Slide) => JSON.stringify(drawn(slide));
    expect(json(prev.Slide.parse(geomSlide()) as Slide)).toBe(json(Slide.parse(geomSlide())));
  });

  it('without the M6 fields, the legacy shapes, picture and text beside them still draw', () => {
    // What a build before design/27's M6 kept of it (the legacy fields are still written beside M6's).
    const legacy = geomSlide();
    for (const o of legacy.objects as unknown as Record<string, unknown>[]) {
      for (const k of [
        'geom',
        'gradient',
        'dash',
        'ends',
        'flipH',
        'flipV',
        'shadow',
        'glow',
        'softEdge',
        'mask',
      ])
        delete o[k];
      const style = o.style as Record<string, unknown> | undefined;
      if (style) delete style.paint;
    }
    const o = drawn(legacy);
    expect(o.some((x) => x.op === 'rect')).toBe(true);
    expect(o.some((x) => x.op === 'moveTo')).toBe(true); // the line
    expect(o.some((x) => x.op === 'drawImage')).toBe(true);
    expect(o.some((x) => x.op === 'fillText')).toBe(true);
  });

  it('the M6 slide draws through the geometry engine and the rich text engine', () => {
    const o = drawn(geomSlide());
    expect(o.filter((x) => x.op === 'fill' && x.args[0] instanceof RecPath).length).toBeGreaterThan(1);
    expect(o.some((x) => x.op === 'drawImage')).toBe(true);
    const text = o.filter((x) => x.op === 'fillText');
    expect(text.length).toBeGreaterThan(0);
    // The shadow pass casts in the solid colour; the fill pass paints the gradient over the box.
    expect(text.some((x) => (x.fillStyle as RecordedGradient).kind === 'radial')).toBe(true);
    expect(text.some((x) => typeof x.fillStyle === 'string')).toBe(true);
  });
});

describe('drawGeomShape on an unclamped object', () => {
  it('clamps first (the editor draws stored objects as they are)', () => {
    const ctx = recordingCtx();
    drawGeomShape(ctx, { ...base, flipH: true, stroke: { width: 1e9, color: white } }, Number.NaN);
    const s = ctx.ops.find((x) => x.op === 'stroke')!;
    expect(s.state.lineWidth).toBe(500);
  });
});

describe('geometry files (ShapeGeom.ref, M6 round 2)', () => {
  const ref = 'c'.repeat(64);
  const paths = [{ d: 'M 0 0 L 100 0 L 50 100 Z', w: 100, h: 100 }];
  const pathsOf = (o: ReturnType<typeof ops>) =>
    o.filter((x) => x.op === 'fill' && x.args[0] instanceof RecPath).map((x) => JSON.stringify(x.args[0]));

  it('draws nothing until the file is read (not a filled rect over the box), then the paths (same object)', () => {
    clearGeomFiles();
    const o: ShapeObject = { ...base, geom: { ref } };
    expect(ops(o)).toEqual([]);
    // A geometry with a preset beside its ref draws the preset meanwhile.
    expect(pathsOf(ops({ ...base, geom: { ref, preset: 'ellipse' } }))).toEqual(
      pathsOf(ops({ ...base, geom: { preset: 'ellipse' } })),
    );
    putGeomFile(ref, { paths });
    expect(pathsOf(ops(o))).toEqual(pathsOf(ops({ ...base, geom: { paths } })));
  });

  it("the previous release (0.5.0) keeps the ref and draws the file's paths once read", () => {
    clearGeomFiles();
    const slide = { id: 'x', objects: [{ ...base, geom: { ref } }] };
    const parsed = prev.Slide.parse(slide) as Slide;
    expect((parsed.objects[0] as ShapeObject).geom?.ref).toBe(ref);
    putGeomFile(ref, { paths });
    const ctx = recordingCtx();
    drawSlide2D(ctx, parsed, { scale: 0.5 });
    expect(ctx.ops.filter((x) => x.op === 'fill').length).toBeGreaterThan(0);
  });
});
