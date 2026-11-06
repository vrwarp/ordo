import { describe, expect, it } from 'vitest';
import type { Box, ImageObject } from '@ordo/domain';
import { clampMask, clampObject } from './clamp.ts';
import { isShapedPicture, pictureCut, pictureTarget } from './picture.ts';
import { encodePlane, PLANE_FLOATS, PLANE_MASK, PLANE_RADII } from './scene.ts';
import { drawImageFit, drawObject, slidePictures } from './text2d.ts';

/** A 2D context that records the calls drawImageFit makes, with their number arguments. */
function recorder() {
  const calls: { op: string; args: number[] }[] = [];
  const rec =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({ op, args: args.filter((a): a is number => typeof a === 'number') });
  const ctx = {
    globalAlpha: 1,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    rect: rec('rect'),
    roundRect: rec('roundRect'),
    ellipse: rec('ellipse'),
    clip: rec('clip'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    scale: rec('scale'),
    drawImage: rec('drawImage'),
  } as unknown as CanvasRenderingContext2D;
  const ops = () => calls.map((c) => c.op);
  const of = (op: string) => calls.filter((c) => c.op === op).map((c) => c.args);
  return { ctx, calls, ops, of };
}

const img = { width: 800, height: 600 } as unknown as CanvasImageSource;
const box: Box = { x: 100, y: 50, w: 400, h: 300, rotation: 0 };
const picture = (extra: Partial<ImageObject> = {}): ImageObject => ({
  id: 'i',
  type: 'image',
  box,
  mediaId: 'm',
  fit: 'stretch',
  opacity: 1,
  radius: 0,
  ...extra,
});

describe('picture masks and flips (design/27 §3.1, M4 item D)', () => {
  it('draws an unshaped picture exactly as before: no mirror, the box with its radius', () => {
    const r = recorder();
    drawImageFit(r.ctx, img, box, 2, 'contain', 1, 12, undefined, undefined, {});
    expect(r.ops()).not.toContain('scale');
    expect(r.ops()).not.toContain('ellipse');
    expect(r.of('roundRect')).toEqual([[200, 100, 800, 600, 24]]);
  });

  it('mirrors about the box centre before drawing, inside the rotation', () => {
    const r = recorder();
    drawImageFit(r.ctx, img, { ...box, rotation: 30 }, 1, 'stretch', 1, 0, undefined, undefined, {
      flipH: true,
    });
    const ops = r.ops();
    expect(ops.indexOf('rotate')).toBeLessThan(ops.indexOf('scale'));
    expect(ops.indexOf('scale')).toBeLessThan(ops.indexOf('clip'));
    expect(r.of('scale')).toEqual([[-1, 1]]);
    // translate(centre), scale, translate(-centre) after the rotation's own translations.
    expect(r.of('translate').slice(2)).toEqual([
      [300, 200],
      [-300, -200],
    ]);
    const v = recorder();
    drawImageFit(v.ctx, img, box, 1, 'stretch', 1, 0, undefined, undefined, { flipV: true, flipH: true });
    expect(v.of('scale')).toEqual([[-1, -1]]);
  });

  it('cuts to an ellipse or a rounded rect, the mask winning over radius', () => {
    const e = recorder();
    drawImageFit(e.ctx, img, box, 2, 'stretch', 1, 40, undefined, undefined, { mask: { preset: 'ellipse' } });
    expect(e.of('ellipse')).toEqual([[600, 400, 400, 300, 0, 0, Math.PI * 2]]);
    expect(e.ops()).not.toContain('roundRect');
    const rr = recorder();
    drawImageFit(rr.ctx, img, box, 2, 'stretch', 1, 40, undefined, undefined, {
      mask: { preset: 'roundRect', adj: [['adj', 25_000]] },
    });
    // 25 % of the shorter side (300) is 75 logical px, 150 device px.
    expect(rr.of('roundRect')).toEqual([[200, 100, 800, 600, 150]]);
  });

  it('reads the cut as the video plane does', () => {
    expect(pictureCut({ radius: 9 }, 400, 300)).toEqual({ kind: 'rect', radius: 9 });
    expect(pictureCut({ radius: 9, mask: { preset: 'ellipse' } }, 400, 300)).toEqual({
      kind: 'ellipse',
      radius: 0,
    });
    expect(pictureCut({ mask: { preset: 'roundRect' } }, 400, 300).radius).toBeCloseTo(50, 1);
    expect(pictureCut({ mask: { preset: 'roundRect', adj: [['adj', 90_000]] } }, 400, 300).radius).toBe(150);
    expect(pictureCut({ mask: { preset: 'roundRect', adj: [['other', 1]] } }, 400, 300).radius).toBeCloseTo(
      50,
      1,
    );
    // Another preset is the box until M6; a mask without one keeps the radius.
    expect(pictureCut({ radius: 9, mask: { preset: 'star5' } }, 400, 300)).toEqual({
      kind: 'rect',
      radius: 0,
    });
    expect(pictureCut({ radius: 9, mask: { paths: [] } }, 400, 300)).toEqual({ kind: 'rect', radius: 9 });
    const plane = new Float32Array(PLANE_FLOATS);
    for (const [mask, kind] of [
      [{ preset: 'ellipse' }, 1],
      [{ preset: 'roundRect', adj: [['adj', 25_000]] as [string, number][] }, 2],
      [{ preset: 'star5' }, 0],
    ] as const) {
      encodePlane({ box, mask }, 1, 0, 0, plane);
      expect(plane[PLANE_MASK]).toBe(kind);
      if (kind === 2)
        expect(plane[PLANE_RADII]! * box.w).toBeCloseTo(pictureCut({ mask }, 400, 300).radius, 3);
    }
  });

  it('draws a masked or flipped picture from its source: it has no prepared target', () => {
    expect(pictureTarget(picture(), 1)).toBeDefined();
    for (const extra of [{ flipH: true }, { flipV: true }, { mask: { preset: 'ellipse' } }])
      expect(pictureTarget(picture(extra), 1)).toBeUndefined();
    expect(isShapedPicture({ flipH: false, mask: { paths: [] } })).toBe(false);
    expect(slidePictures({ id: 's', objects: [picture({ flipH: true })] }, { scale: 1 })).toEqual([
      { mediaId: 'm', target: undefined },
    ]);
    const r = recorder();
    drawObject(r.ctx, picture({ flipV: true, mask: { preset: 'ellipse' } }), 1, () => img);
    expect(r.of('scale')).toEqual([[1, -1]]);
    expect(r.ops()).toContain('ellipse');
  });
});

describe('the mask and flip clamps', () => {
  it('whitelists flips (true only) and a mask with a preset', () => {
    expect(clampObject(picture())).toEqual(picture());
    expect(clampObject(picture({ flipH: true, flipV: false }))).toEqual(picture({ flipH: true }));
    expect(clampObject({ ...picture(), flipV: 'yes' })).not.toHaveProperty('flipV');
    expect(clampObject(picture({ mask: { preset: 'ellipse' } }))).toEqual(
      picture({ mask: { preset: 'ellipse' } }),
    );
    expect(clampObject(picture({ mask: { paths: [{ d: 'M0 0', w: 1, h: 1 }] } }))).not.toHaveProperty('mask');
  });

  it('bounds the preset and adjust pairs', () => {
    expect(clampMask(undefined)).toBeUndefined();
    expect(clampMask({ preset: '' })).toBeUndefined();
    expect(clampMask({ preset: 7 })).toBeUndefined();
    const long = 'x'.repeat(100);
    const adj = [
      ['adj', 5e9],
      [long, 1],
      ['bad', Number.NaN],
      'no',
      [3, 4],
      ...Array.from({ length: 20 }, (_, i) => [`a${i}`, i]),
    ];
    const m = clampMask({ preset: long, adj })!;
    expect(m.preset).toHaveLength(40);
    expect(m.adj![0]).toEqual(['adj', 1e7]);
    expect(m.adj![1]![0]).toHaveLength(16);
    expect(m.adj!.length).toBeLessThanOrEqual(10);
    expect(clampMask({ preset: 'ellipse', adj: 'x' })).toEqual({ preset: 'ellipse' });
  });
});
