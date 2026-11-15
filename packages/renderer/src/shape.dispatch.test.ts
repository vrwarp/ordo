import type { ShapeObject } from '@ordo/domain';
import { m9Chart, m9Decor, m9Table } from '@ordo/domain/m9.test-util.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RecPath } from './geom/path2d.test-util.ts';
import {
  drawShapeObject,
  type Look3dResolver,
  registerLook3d,
  registerShapeDrawer,
  type ShapeDrawKind,
  shapeDrawKind,
} from './shape.ts';
import { drawShape } from './text2d.ts';
import { traceCtx, traceDigest } from './trace.test-util.ts';

/*
 * The shape draw dispatch of M9 (plan decision 10): `table` → `chart` → `decor` → geometry → legacy. A kind
 * whose drawer is not registered yet (wave 1: none is) draws what an older build draws once it strips the
 * field (design/27 §3.2): the shape's legacy or geometry drawing, exactly.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());

const red = { r: 200, g: 0, b: 0, a: 1 };
const base: ShapeObject = {
  id: 's',
  type: 'shape',
  box: { x: 100, y: 200, w: 800, h: 400, rotation: 0 },
  shape: 'rect',
  fill: red,
  opacity: 1,
  radius: 0,
};
const table = m9Table();
const chart = m9Chart();
const decor = m9Decor();

/** The digest of what `drawShape` draws for `o` at scale 0.5. */
function drawn(o: ShapeObject): string {
  const ctx = traceCtx(960, 540);
  drawShape(ctx, o, 0.5);
  return traceDigest(ctx.trace);
}

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

/** Fake drawers of every kind, recording which one drew what; `draws` false: they leave it to the fallback. */
function fakes(draws = true) {
  const calls: [ShapeDrawKind, string, boolean][] = [];
  for (const kind of ['table', 'chart', 'decor'] as const)
    offs.push(
      registerShapeDrawer(kind, (ctx, o, scale) => {
        calls.push([kind, o.id, o[kind] !== undefined]);
        if (draws) ctx.fillRect(0, 0, o.box.w * scale, o.box.h * scale);
        return draws;
      }),
    );
  return calls;
}

describe('shape draw dispatch (M9 render-seams)', () => {
  it('precedence table > chart > decor > geom; stubs draw the legacy shape', () => {
    const all: ShapeObject = { ...base, table, chart, decor, geom: { preset: 'star5' } };
    expect(shapeDrawKind(all)).toBe('table');
    expect(shapeDrawKind({ ...base, chart, decor })).toBe('chart');
    expect(shapeDrawKind({ ...base, decor, geom: { preset: 'star5' } })).toBe('decor');
    expect(shapeDrawKind({ ...base, geom: { preset: 'star5' } })).toBeUndefined();
    // A malformed field is dropped by the clamp, and the next kind draws.
    expect(shapeDrawKind({ ...base, table: { cols: [] } as never, chart })).toBe('chart');

    // Stubs (no drawer registered): each draws exactly what the shape draws without the field, which is
    // what an older build draws (a table's background rect; a decoration's empty line).
    for (const [o, legacy] of [
      [{ ...base, table }, base],
      [{ ...base, chart, decor }, base],
      [
        { ...base, decor, shape: 'line', fill: undefined },
        { ...base, shape: 'line', fill: undefined },
      ],
      [
        { ...base, table, geom: { preset: 'star5' }, gradient: undefined },
        { ...base, geom: { preset: 'star5' } },
      ],
    ] as [ShapeObject, ShapeObject][])
      expect(drawn(o)).toBe(drawn(legacy));

    // Registered: the first kind present draws, given the clamped shape; the geometry is not drawn under it.
    const calls = fakes();
    const ctx = traceCtx(960, 540);
    drawShape(ctx, all, 0.5);
    expect(calls).toEqual([['table', 's', true]]);
    expect(ctx.trace.filter((e) => e[1] === 'fill')).toEqual([]);
    drawShape(traceCtx(), { ...base, chart, decor, geom: { preset: 'star5' } }, 1);
    drawShape(traceCtx(), { ...base, decor, geom: { preset: 'star5' } }, 1);
    expect(calls.map((c) => c[0])).toEqual(['table', 'chart', 'decor']);
    // A plain or M6 shape never reaches a drawer.
    drawShape(traceCtx(), base, 1);
    drawShape(traceCtx(), { ...base, geom: { preset: 'star5' } }, 1);
    expect(calls).toHaveLength(3);
  });

  it('a drawer that declines leaves the shape to its legacy drawing', () => {
    const calls = fakes(false);
    for (const [o, legacy] of [
      [{ ...base, table }, base],
      [
        { ...base, chart, geom: { preset: 'roundRect' } },
        { ...base, geom: { preset: 'roundRect' } },
      ],
    ] as [ShapeObject, ShapeObject][])
      expect(drawn(o)).toBe(drawn(legacy));
    expect(calls.map((c) => c[0])).toEqual(['table', 'chart']);
    // The dispatch reports whether it drew: false sends a plain shape to `drawShape`'s legacy path.
    expect(drawShapeObject(traceCtx(), base, 1)).toBe(false);
    expect(drawShapeObject(traceCtx(), { ...base, geom: { preset: 'star5' } }, 1)).toBe(true);
  });

  it('a registered 3-D look decorates the geometry path, and without one a 3-D shape draws flat', () => {
    const look3d = { bevel: { prst: 'circle' as const, w: 6, h: 6 } };
    const flat = drawn(base);
    expect(drawn({ ...base, look3d })).toBe(flat);
    const seen: { id: string; e: number }[] = [];
    const resolve: Look3dResolver = (o, m) => {
      seen.push({ id: o.id, e: m.e });
      return undefined; // drawn flat: the hook only resolves
    };
    offs.push(registerLook3d(resolve));
    const ctx = traceCtx(960, 540);
    drawShape(ctx, { ...base, look3d }, 0.5);
    // Through the geometry engine (a filled path), with the box's transform.
    expect(seen).toEqual([{ id: 's', e: (100 + 400) * 0.5 - 400 * 0.5 }]);
    expect(ctx.trace.some((e) => e[1] === 'fill')).toBe(true);
    // A shape without look3d never asks it.
    drawShape(traceCtx(), base, 0.5);
    expect(seen).toHaveLength(1);
  });

  // Last in this file: it loads and registers the real decoration drawer, which then stays registered.
  it('a decor shape draws its parts once its drawer loads', async () => {
    // The renderer's index registers each kind's loader (the decoration's: its own lazy module).
    const { loadShapeDrawers, shapeDrawerRegistered } = await import('./index.ts');
    const o: ShapeObject = { ...base, decor, shape: 'line', fill: undefined, locked: true };
    // Before: the legacy line without a stroke (nothing), as an older build draws it.
    expect(shapeDrawerRegistered('decor')).toBe(false);
    expect(drawn(o)).toBe(drawn({ ...base, shape: 'line', fill: undefined }));
    expect(await loadShapeDrawers([o])).toBe(true);
    expect(shapeDrawerRegistered('decor')).toBe(true);
    const ctx = traceCtx(960, 540);
    drawShape(ctx, o, 0.5);
    // Its 40 filled triangles (the stroked line fills nothing), in z-order.
    expect(ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'fill')).toHaveLength(40);
    // Loaded once: nothing more to load.
    expect(await loadShapeDrawers([o])).toBe(false);
  });
});
