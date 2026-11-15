/**
 * A table on the editor's canvas (design/15 "Table editing"): its node's hit area and cache rect cover the
 * height it is drawn at (its rows grow with their text past `box.h`), a height drag of the Transformer sets
 * `box.h` from that drawn height while a drag of the width alone keeps it, and tables do not turn there.
 */
import { m9Table } from '@ordo/domain/m9.test-util.ts';
import type { SlideObject } from '@ordo/domain';
import { recordingCtx } from '@ordo/renderer/text/test-util.ts';
import { describe, expect, it } from 'vitest';
import { isTable, nodeCacheRect, tableBoxAfterTransform } from '../src/views/editor/SlideCanvas.tsx';

const box = { x: 100, y: 200, w: 800, h: 300, rotation: 0 };
const table = {
  id: 't',
  type: 'shape',
  box,
  shape: 'rect',
  opacity: 1,
  radius: 0,
  table: m9Table(),
} as SlideObject;

describe('a table on the canvas', () => {
  it('is cached and hit over its drawn height', () => {
    const ctx = recordingCtx();
    const own = nodeCacheRect({ ...table, table: undefined } as SlideObject, undefined, 1, ctx)!;
    const grown = nodeCacheRect({ ...table, table: undefined } as SlideObject, undefined, 1, ctx, 520)!;
    expect(own.y + own.height).toBeLessThan(400);
    expect(grown.y + grown.height).toBeGreaterThanOrEqual(522);
    expect(isTable(table)).toBe(true);
    expect(isTable({ ...table, table: undefined } as SlideObject)).toBe(false);
  });

  it('a height drag sets box.h from the drawn height; the width alone keeps it; the turn stays', () => {
    // The node's pivot is the box's centre (500, 350); its drawn height is 420 (rows grown past 300).
    const tall = tableBoxAfterTransform(table, 420, { x: 500, y: 350 + 30, scaleX: 1, scaleY: 1.5 });
    expect(tall).toEqual({ x: 100, y: 155, w: 800, h: 630, rotation: 0 });
    const wide = tableBoxAfterTransform(table, 420, { x: 550, y: 350, scaleX: 1.25, scaleY: 1 });
    expect(wide).toEqual({ x: 50, y: 200, w: 1000, h: 300, rotation: 0 });
    const turned = tableBoxAfterTransform({ box: { ...box, rotation: 15 } }, 300, {
      x: 500,
      y: 350,
      scaleX: 1,
      scaleY: 0.5,
    });
    expect(turned.rotation).toBe(15);
    expect(turned.h).toBe(150);
  });
});
