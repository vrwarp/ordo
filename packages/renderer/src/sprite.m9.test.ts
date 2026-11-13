import type { ShapeObject, SlideObject, TextObject } from '@ordo/domain';
import { m9Slide, m9Table } from '@ordo/domain/m9.test-util.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RecPath } from './geom/path2d.test-util.ts';
import { registerPicturePost, registerPictureTarget } from './picture.ts';
import { registerLook3d, registerShapeDrawer, shapeDrawerReach } from './shape.ts';
import { objectReach, type Reach } from './sprite.ts';
import { PLAIN_PAINTER, registerFaceTarget, registerGlyphPainter } from './text/paint.ts';
import { recordingCtx } from './text/test-util.ts';
import { drawTable } from './table/draw.ts';
import { tableReach } from './table/index.ts';

/**
 * Tight sprites and the M9 fields (design/27 §7.3, M9): every M9 key is one `objectReach` knows, so an
 * imported slide with tables, charts, decorations, 3-D looks, warped or vertical text and vector pictures is
 * drawn as a tight sprite instead of falling to a full-frame layer. Each object reaches where what draws it
 * draws: its legacy shape or plain text while the field's drawer or painter is not registered, the
 * registered drawer's own reach (the table's grown rows), and the whole frame while a hook whose drawing the
 * plain plan cannot bound applies (a warp or upright painter, the 3-D face target, a picture's 3-D look, a
 * shape's 3-D resolver, a drawer registered without a reach). The pixels are checked in Chromium by
 * sprite.browser.test.ts (its M9 cases).
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());

const ctx = recordingCtx();
const objects = () => new Map(m9Slide().objects.map((o) => [o.id, o]));
const get = (id: string) => objects().get(id)!;
/** The object without some of its fields. */
function without(o: SlideObject, ...keys: string[]): SlideObject {
  const c = { ...o } as Record<string, unknown>;
  for (const k of keys) delete c[k];
  return c as unknown as SlideObject;
}
const contains = (outer: Reach, inner: Reach) =>
  !!outer &&
  !!inner &&
  outer.x <= inner.x + 1e-6 &&
  outer.y <= inner.y + 1e-6 &&
  outer.x + outer.w >= inner.x + inner.w - 1e-6 &&
  outer.y + outer.h >= inner.y + inner.h - 1e-6;

describe('objectReach knows every M9 field', () => {
  it('no object of the M9 slide reaches the whole frame while no M9 hook is registered', () => {
    for (const o of m9Slide().objects) expect(objectReach(ctx, o, 1), o.id).not.toBeNull();
  });

  it('text with a warp, vertical writing, a centred block or a 3-D look reaches as its plain text', () => {
    for (const id of ['title', 'vertical', 'centred']) {
      const o = get(id);
      expect(objectReach(ctx, o, 1), id).toEqual(
        objectReach(ctx, without(o, 'warp', 'writing', 'centerBlock', 'look3d'), 1),
      );
    }
  });

  it('a picture with a 3-D look or vector fonts reaches as its box', () => {
    const emf = get('emf');
    expect(objectReach(ctx, emf, 1)).toEqual(objectReach(ctx, without(emf, 'look3d', 'vectorFonts'), 1));
  });

  it('a chart or decoration without its drawer reaches as its legacy shape, a 3-D shape as its geometry', () => {
    for (const [id, key] of [
      ['chart', 'chart'],
      ['decor', 'decor'],
      ['pie', 'look3d'],
    ] as const) {
      const o = get(id);
      expect(objectReach(ctx, o, 1), id).toEqual(objectReach(ctx, without(o, key), 1));
    }
  });
});

describe('registered M9 hooks', () => {
  it('a warp or upright glyph painter, or the 3-D face target, makes its text reach the whole frame', () => {
    const title = get('title') as TextObject;
    const vertical = get('vertical') as TextObject;
    const off = registerGlyphPainter('warp', (o) => !!o.warp, { ...PLAIN_PAINTER, kind: 'warp' });
    expect(objectReach(ctx, title, 1)).toBeNull();
    expect(objectReach(ctx, vertical, 1)).not.toBeNull();
    off();
    const offUp = registerGlyphPainter('upright', (o) => !!o.writing, { ...PLAIN_PAINTER, kind: 'upright' });
    expect(objectReach(ctx, vertical, 1)).toBeNull();
    offUp();
    const offFace = registerFaceTarget((o) => !!o.look3d, { kind: 'sprite', draw() {} });
    expect(objectReach(ctx, title, 1)).toBeNull();
    expect(objectReach(ctx, get('centred'), 1)).not.toBeNull();
    offFace();
    expect(objectReach(ctx, title, 1)).not.toBeNull();
  });

  it("a picture's 3-D look reaches the whole frame once a target extension or post step is registered", () => {
    const emf = get('emf');
    const plain = without(emf, 'look3d');
    const off = registerPictureTarget({ name: 'look3d', extend: () => undefined });
    expect(objectReach(ctx, emf, 1)).toBeNull();
    expect(objectReach(ctx, plain, 1)).not.toBeNull();
    off();
    const offPost = registerPicturePost({ name: 'rim', applies: () => true, run() {} });
    expect(objectReach(ctx, emf, 1)).toBeNull();
    offPost();
    expect(objectReach(ctx, emf, 1)).not.toBeNull();
  });

  it("a shape's 3-D look reaches the whole frame once its resolver is registered", () => {
    const off = registerLook3d(() => undefined);
    expect(objectReach(ctx, get('pie'), 1)).toBeNull();
    off();
    expect(objectReach(ctx, get('pie'), 1)).not.toBeNull();
  });

  it('a chart or decoration drawer reaches where it says, or the whole frame when it says nothing', () => {
    const chart = get('chart') as ShapeObject;
    const legacy = objectReach(ctx, without(chart, 'chart'), 1);
    const offBare = registerShapeDrawer('chart', () => true);
    expect(objectReach(ctx, chart, 1)).toBeNull();
    offBare();
    expect(objectReach(ctx, chart, 1)).toEqual(legacy);
    const r = { x: 1, y: 2, w: 3, h: 4 };
    const off = registerShapeDrawer(
      'chart',
      () => true,
      () => r,
    );
    expect(objectReach(ctx, chart, 1)).toEqual(r);
    off();
    // A drawer that would not draw the shape (undefined) leaves it to its legacy shape.
    const offNone = registerShapeDrawer(
      'decor',
      () => false,
      () => undefined,
    );
    expect(objectReach(ctx, get('decor'), 1)).toEqual(objectReach(ctx, without(get('decor'), 'decor'), 1));
    offNone();
  });
});

describe('the table drawer reach', () => {
  const table = (h: number, rotation = 0): ShapeObject => ({
    id: 't',
    type: 'shape',
    box: { x: 200, y: 300, w: 1000, h, rotation },
    shape: 'rect',
    opacity: 1,
    radius: 0,
    table: m9Table(),
  });

  it('is registered with the table drawer and reaches the rows its text grows past the box', () => {
    const o = table(60);
    const r = shapeDrawerReach(ctx, o)!;
    expect(r).toEqual(tableReach(ctx, o));
    expect(objectReach(ctx, o, 1)).toEqual(r);
    // Five rows of text at 32 px cannot fit 60 px: the table grows downwards, never up.
    expect(r.y).toBeLessThanOrEqual(300);
    expect(r.y + r.h).toBeGreaterThan(300 + 60 + 100);
    expect(r.x).toBeLessThanOrEqual(200);
    expect(r.x + r.w).toBeGreaterThanOrEqual(1200);
  });

  it('holds every drawing operation of the table, turned with its box', () => {
    for (const rotation of [0, 8, 90]) {
      const o = table(300, rotation);
      const r = tableReach(ctx, o)!;
      const rec = recordingCtx();
      drawTable(rec, o, 1);
      // The text's pen positions and the lines' ends, in the frame (the recorder applies the transforms).
      const points = rec.ops
        .filter((op) => op.op === 'fillText' || op.op === 'fillRect')
        .map((op) => {
          const [a, b, c, d, e, f] = op.transform as number[];
          const x = Number(op.op === 'fillText' ? op.args[1] : op.args[0]);
          const y = Number(op.op === 'fillText' ? op.args[2] : op.args[1]);
          return [a! * x + c! * y + e!, b! * x + d! * y + f!] as const;
        });
      expect(points.length).toBeGreaterThan(10);
      for (const [x, y] of points) {
        expect(x, `rotation ${rotation}`).toBeGreaterThanOrEqual(r.x - 1e-6);
        expect(x).toBeLessThanOrEqual(r.x + r.w + 1e-6);
        expect(y).toBeGreaterThanOrEqual(r.y - 1e-6);
        expect(y).toBeLessThanOrEqual(r.y + r.h + 1e-6);
      }
      expect(contains(r, { x: 200, y: 300, w: 1000, h: 300 }) || rotation !== 0).toBe(true);
    }
  });

  it('reaches the whole frame when a cell is painted by a registered hook', () => {
    const off = registerGlyphPainter('upright', () => true, { ...PLAIN_PAINTER, kind: 'upright' });
    expect(tableReach(ctx, table(300))).toBeNull();
    off();
    expect(tableReach(ctx, table(300))).not.toBeNull();
  });
});
