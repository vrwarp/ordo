/**
 * The canvas's cached object nodes (`nodeCacheRect`, design/15 "Canvas drawing"): a non-text object is drawn
 * once into a bitmap over what its drawer can reach (its box, its stroke, its shadow past the box) and its
 * hit area, so redrawing the objects layer (a keystroke, a drag) copies it. Text is never cached here (its
 * raster is), an object whose reach the renderer does not know is drawn live, and a huge one is too.
 */
import { DEFAULT_THEME, type SlideObject } from '@ordo/domain';
import { recordingCtx } from '@ordo/renderer/text/test-util.ts';
import { describe, expect, it } from 'vitest';
import { NODE_CACHE_MAX_PX, nodeCacheRect } from '../src/views/editor/SlideCanvas.tsx';

const ctx = recordingCtx();
const box = { x: 700, y: 400, w: 300, h: 100, rotation: 30 };
const shape = (extra: Record<string, unknown> = {}) =>
  ({ id: 's', type: 'shape', shape: 'rect', box, opacity: 1, radius: 0, ...extra }) as SlideObject;

describe('nodeCacheRect', () => {
  it('covers the box at the node origin, unrotated, with a margin', () => {
    const r = nodeCacheRect(shape(), undefined, 2, ctx)!;
    expect(r.x).toBeLessThanOrEqual(-2);
    expect(r.y).toBeLessThanOrEqual(-2);
    expect(r.x + r.width).toBeGreaterThanOrEqual(302);
    expect(r.y + r.height).toBeGreaterThanOrEqual(102);
    // Unrotated: the turn is the node's, the cache is in its own frame.
    expect(r.width).toBeLessThan(320);
  });

  it('grows with a stroke and a shadow past the box, and a thin box keeps its 12 px hit height', () => {
    const plain = nodeCacheRect(shape(), undefined, 1, ctx)!;
    const stroked = nodeCacheRect(
      shape({ stroke: { width: 20, color: { r: 0, g: 0, b: 0, a: 1 } } }),
      undefined,
      1,
      ctx,
    )!;
    expect(stroked.x).toBeLessThan(plain.x);
    expect(stroked.width).toBeGreaterThan(plain.width);
    const shadowed = nodeCacheRect(
      shape({ shadow: { dx: 40, dy: 40, blur: 10, color: { r: 0, g: 0, b: 0, a: 0.6 } }, dash: 'dash' }),
      undefined,
      1,
      ctx,
    )!;
    expect(shadowed.x + shadowed.width).toBeGreaterThan(340);
    expect(shadowed.y + shadowed.height).toBeGreaterThan(140);
    const line = nodeCacheRect(shape({ box: { ...box, h: 0 } }), undefined, 1, ctx)!;
    expect(line.y + line.height).toBeGreaterThanOrEqual(12);
  });

  it('leaves text, unknown fields, a bad density and a huge node to be drawn live', () => {
    const text = {
      id: 't',
      type: 'text',
      box,
      text: 'Hello',
      style: { ...DEFAULT_THEME.textBoxDefaults },
      opacity: 1,
    } as SlideObject;
    expect(nodeCacheRect(text, undefined, 2, ctx)).toBeUndefined();
    expect(nodeCacheRect(shape({ futureField: 1 }), undefined, 2, ctx)).toBeUndefined();
    expect(nodeCacheRect(shape(), undefined, 0, ctx)).toBeUndefined();
    expect(nodeCacheRect(shape(), undefined, Number.NaN, ctx)).toBeUndefined();
    const huge = shape({ box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 } });
    expect(nodeCacheRect(huge, undefined, 1, ctx)).toBeDefined();
    expect(1920 * 1080 * 4 * 4).toBeGreaterThan(NODE_CACHE_MAX_PX);
    expect(nodeCacheRect(huge, undefined, 4, ctx)).toBeUndefined();
  });

  it('caches what the slide budget draws instead (drawAs)', () => {
    const fancy = shape({ shadow: { dx: 60, dy: 0, blur: 0, color: { r: 0, g: 0, b: 0, a: 1 } } });
    const legacy = shape();
    expect(nodeCacheRect(fancy, legacy, 1, ctx)).toEqual(nodeCacheRect(legacy, undefined, 1, ctx));
  });
});
