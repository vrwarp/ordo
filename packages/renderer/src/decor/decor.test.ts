import { DECOR_LIMITS, type DecorData, drawnDecorRefs, type ShapeObject } from '@ordo/domain';
import { m9Decor } from '@ordo/domain/m9.test-util.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampDecorData as clampDecor } from './clamp.ts';
import { RecPath } from '../geom/path2d.test-util.ts';
import { shapeDrawKind } from '../shape.ts';
import { drawShape } from '../text2d.ts';
import { traceCtx } from '../trace.test-util.ts';
import { decorCost, decorShapes, drawDecor } from './draw.ts';
import { clearDecorFiles, decorFileParts, decorPending, putDecorFile, readDecorFiles } from './files.ts';
// Registers the drawer with the shape dispatch.
import './index.ts';

/*
 * Decorations (design/27 M9, decor-render): the clamp, the source shapes a decoration's parts make, the files,
 * the cost and the drawer's dispatch. Pixels are checked in headless Chromium (decor.browser.test.ts: a
 * decoration draws what its shapes drawn one by one draw, and its sprite is a 1:1 copy).
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());
afterEach(() => clearDecorFiles());

const red = { r: 200, g: 0, b: 0, a: 1 };
const tri = (x: number) => `M ${x} 0 L ${x + 10} 0 L ${x + 5} 10 Z`;
const shadow = { dx: 2, dy: 2, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.5 } };

function shape(decor: DecorData, extra: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id: 'd',
    type: 'shape',
    box: { x: 10, y: 20, w: decor.w, h: decor.h, rotation: 0 },
    shape: 'line',
    opacity: 1,
    radius: 0,
    decor,
    locked: true,
    ...extra,
  };
}

describe('clampDecor', () => {
  it('keeps a well-formed decoration as it is', () => {
    const d = m9Decor();
    const c = clampDecor(d)!;
    expect(c.w).toBe(d.w);
    expect(c.paints).toHaveLength(2);
    expect(c.parts).toHaveLength(d.parts.length);
    expect(c.parts[1]!.frame).toEqual(d.parts[1]!.frame);
  });

  it('drops what cannot be drawn and never throws', () => {
    expect(clampDecor(undefined)).toBeUndefined();
    expect(
      clampDecor({ w: 0, h: 10, paints: [{ fill: red }], parts: [{ d: tri(0), p: 0 }] }),
    ).toBeUndefined();
    expect(clampDecor({ w: 10, h: 10, paints: [], parts: [{ d: tri(0), p: 0 }] })).toBeUndefined();
    expect(clampDecor({ w: Number.NaN, h: 10, paints: [{}], parts: [] })).toBeUndefined();
    const hostile = {
      w: 100,
      h: 100,
      paints: [{ fill: red, stroke: { width: 1e9, color: red }, dash: 'wavy', shadow: { blur: -5 } }, 'x'],
      parts: [
        { d: tri(0), p: 0, s: 1, fill: 'glitter', frame: [0, 0, Number.NaN, 1, 0] },
        { d: tri(20), p: 2 }, // out of the palette
        { d: 'drop table', p: 0 }, // nothing usable
        { d: tri(40), p: 1.5 },
        { d: `${tri(60)} javascript:alert(1)`, p: 1, cont: true },
        null,
      ],
      ref: 'x\u0000y',
    };
    const c = clampDecor(hostile)!;
    expect(c.paints[0]!.stroke!.width).toBe(500);
    expect(c.paints[0]!.dash).toBeUndefined();
    expect(c.paints[0]!.shadow!.blur).toBe(0);
    expect(c.paints[1]).toEqual({});
    expect(c.parts.map((p) => p.d)).toEqual([tri(0).replace(/ /g, ' '), tri(60)]);
    expect(c.parts[0]!.fill).toBeUndefined();
    expect(c.parts[0]!.frame).toBeUndefined();
    expect(c.ref).toBeUndefined();
    const getter = {
      w: 10,
      h: 10,
      paints: [{}],
      get parts(): never {
        throw new Error('hostile');
      },
    };
    expect(clampDecor(getter)).toBeUndefined();
  });

  it('caps the points of all parts, dropping the shape that passes them and what follows', () => {
    // 3 shapes of 3,000 points each... in two parts of 1,500 (a chain), so the cap of 16,384 cuts the sixth.
    const piece = (n: number) => `M 0 0 ${'L 1 1 '.repeat(n - 2)}Z`;
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push({ d: piece(1500), p: 0, s: 1 as const });
      parts.push({ d: piece(1500), p: 0, cont: true });
    }
    const c = clampDecor({ w: 10, h: 10, paints: [{ fill: red }], parts })!;
    // 5 shapes of 3,000 points fit in 16,384; the sixth would pass it and is dropped whole.
    expect(c.parts).toHaveLength(10);
    expect(c.parts[c.parts.length - 1]!.cont).toBe(true);
    expect(decorShapes(c).points).toBe(15_000);
  });

  it('keeps at most 256 parts and 64 paints', () => {
    const parts = Array.from({ length: 400 }, (_, i) => ({ d: tri(i), p: i % 70, s: 1 as const }));
    const paints = Array.from({ length: 70 }, () => ({ fill: red }));
    const c = clampDecor({ w: 4000, h: 10, paints, parts })!;
    expect(c.paints).toHaveLength(DECOR_LIMITS.paints);
    expect(c.parts.length).toBeLessThanOrEqual(DECOR_LIMITS.parts);
    expect(c.parts.every((p) => p.p < 64)).toBe(true);
  });
});

describe('source shapes', () => {
  it('groups parts from one s:1 to the next, joins cont pieces and starts a shape on a new paint', () => {
    const d: DecorData = {
      w: 100,
      h: 100,
      paints: [{ fill: red }, { stroke: { width: 2, color: red } }],
      parts: [
        { d: tri(0), p: 0, s: 1 },
        { d: tri(20), p: 0, cont: true },
        { d: 'M 0 50 L 100 50', p: 0, fill: 'none' },
        { d: tri(40), p: 0, s: 1 },
        { d: tri(60), p: 1 },
      ],
    };
    const g = decorShapes(d);
    expect(g.shapes).toHaveLength(3);
    expect(g.shapes[0]!.built.paths).toHaveLength(2);
    expect(g.shapes[0]!.built.paths[0]!.cmds).toHaveLength(8);
    expect(g.shapes[0]!.built.paths[1]!.fill).toBe('none');
    expect(g.shapes[2]!.outline?.width).toBe(2);
    // Two triangles joined (4 + 4 points) and a line (2), then a triangle each.
    expect(g.points).toBe(8 + 2 + 4 + 4);
  });

  it('keeps the shadows of the first 24 shadowed shapes only', () => {
    const parts = Array.from({ length: 30 }, (_, i) => ({ d: tri(i * 12), p: 0, s: 1 as const }));
    const g = decorShapes(clampDecor({ w: 400, h: 10, paints: [{ fill: red, shadow }], parts })!);
    expect(g.shapes).toHaveLength(30);
    expect(g.shadowed).toBe(DECOR_LIMITS.shadowed);
    expect(g.shapes.filter((s) => s.shadow)).toHaveLength(24);
    expect(g.shapes[29]!.shadow).toBeUndefined();
  });

  it('a thin dashed outline is drawn 0.5 px wide', () => {
    const g = decorShapes({
      w: 10,
      h: 10,
      paints: [{ stroke: { width: 0.1, color: red }, dash: 'sysDot' }],
      parts: [{ d: tri(0), p: 0, s: 1 }],
    });
    expect(g.shapes[0]!.outline!.width).toBe(0.5);
    expect(g.shapes[0]!.outline!.dash).toEqual([0.5, 0.5]);
  });
});

describe('drawing', () => {
  it('is the drawer of the shape dispatch: each shape filled in z-order, its shadow through the effects', () => {
    const o = shape(m9Decor());
    expect(shapeDrawKind(o)).toBe('decor');
    const ctx = traceCtx(1920, 1080);
    drawShape(ctx, o, 1);
    const fills = ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'fill');
    // 40 triangles and the line (no fill: stroked only); without OffscreenCanvas (Node) the shadowed ones are
    // drawn without their shadows, as every effected shape is here.
    expect(fills).toHaveLength(40);
    expect(ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'stroke').length).toBeGreaterThanOrEqual(21);
    // The gradient of the odd triangles is built in each one's frame.
    expect(ctx.trace.some((e) => e[0] === 'call' && e[1] === 'createLinearGradient')).toBe(true);
  });

  it('draws nothing for an empty, transparent or unread decoration', () => {
    for (const o of [
      shape(m9Decor(), { opacity: 0 }),
      shape({ ...m9Decor(), parts: [], ref: 'f'.repeat(64) }),
      shape(m9Decor(), { box: { x: 0, y: 0, w: 0, h: 10, rotation: 0 } }),
    ]) {
      const ctx = traceCtx();
      drawShape(ctx, o, 1);
      expect(ctx.trace.filter((e) => e[1] === 'fill' || e[1] === 'stroke')).toEqual([]);
    }
    expect(drawDecor(traceCtx(), shape(m9Decor(), { decor: undefined }), 1)).toBe(false);
  });

  it('draws a read file’s parts in place of its own', async () => {
    const ref = 'a'.repeat(64);
    const o = shape({ ...m9Decor(), parts: [], ref });
    expect(decorPending(o.decor)).toBe(true);
    expect(drawnDecorRefs({ objects: [o] })).toEqual([ref]);
    const file = JSON.stringify({ parts: m9Decor().parts });
    const log: string[] = [];
    const read = async (r: string) => {
      log.push(r.slice(0, 1));
      return r === ref ? file : undefined;
    };
    const [a, b] = await Promise.all([
      readDecorFiles([ref, 'b'.repeat(64)], read),
      readDecorFiles([ref], read),
    ]);
    // One read of each file, shared; the missing one is not asked again within the retry time.
    expect(log).toEqual(['a', 'b']);
    expect(a.get('b'.repeat(64))).toBe('missing');
    expect(b.size).toBe(0);
    expect((await readDecorFiles(['b'.repeat(64)], read)).get('b'.repeat(64))).toBe('missing');
    expect(log).toEqual(['a', 'b']);
    expect(decorFileParts(ref)).toHaveLength(m9Decor().parts.length);
    const ctx = traceCtx();
    drawShape(ctx, o, 1);
    expect(ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'fill')).toHaveLength(40);
    // A file that is not a decoration is invalid.
    expect((await readDecorFiles(['c'.repeat(64)], async () => '{"paths":[]}')).get('c'.repeat(64))).toBe(
      'invalid',
    );
    expect(putDecorFile('d', { parts: [{ d: 'nonsense', p: 0 }] })).toBe(false);
  });
});

describe('cost', () => {
  it('rates a decoration as its shapes drawn one by one, shadows included', () => {
    const one = decorCost(shape(clampDecor(m9Decor())!));
    expect(one.est).toBeGreaterThan(0);
    expect(one.effects).toBeGreaterThan(0);
    const noShadow = clampDecor({
      ...m9Decor(),
      paints: m9Decor().paints.map(({ shadow: _s, ...p }) => p),
    })!;
    const plain = decorCost(shape(noShadow));
    expect(plain.est).toBeLessThan(one.est);
    expect(plain.effects).toBe(0);
  });
});
