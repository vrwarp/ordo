import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RecPath } from './geom/path2d.test-util.ts';
import { paintShapedPicture, pictureShape, pictureTarget } from './picture.ts';
import { drawImageFit } from './text2d.ts';
import { recordingCtx } from './text/test-util.ts';

/**
 * Picture masks and flips (design/27 §3.1 ImageObject.mask, flipH, flipV; §7.1): part of the prepared target,
 * so a masked picture is prepared and copied 1:1; drawn from the source mirrored and cut to the mask.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());

const box = { x: 100, y: 100, w: 400, h: 300, rotation: 0 };
const img = { width: 800, height: 600 } as unknown as CanvasImageSource;

describe('pictureTarget with a mask or flips', () => {
  it('keeps the key of a picture without them', () => {
    const t = pictureTarget({ box, fit: 'stretch' }, 0.5)!;
    expect(t.key).toBe('200x150 0 0 200 150 stretch');
    expect(t).not.toHaveProperty('shape');
  });

  it('adds the mask and flips to the key and the target, keyed by the mask, not the object', () => {
    const a = pictureTarget({ box, fit: 'stretch', mask: { preset: 'ellipse' } }, 0.5)!;
    const b = pictureTarget({ box, fit: 'stretch', mask: { preset: 'ellipse' } }, 0.5)!;
    const c = pictureTarget({ box, fit: 'stretch', mask: { preset: 'star5' } }, 0.5)!;
    const h = pictureTarget({ box, fit: 'stretch', flipH: true }, 0.5)!;
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(h.key).toBe('200x150 0 0 200 150 stretch h');
    expect(a.shape).toEqual({ mask: { preset: 'ellipse' }, w: 400, h: 300 });
    expect(h.shape).toEqual({ flipH: true, w: 400, h: 300 });
  });

  it('prepares a masked picture with round corners (the mask replaces the radius), not an unmasked one', () => {
    expect(pictureTarget({ box, fit: 'stretch', radius: 20 }, 0.5)).toBeUndefined();
    expect(
      pictureTarget({ box, fit: 'stretch', radius: 20, mask: { preset: 'roundRect' } }, 0.5),
    ).toBeDefined();
  });

  it('prepares a rotated picture only with a mask: over the turned box, the rotation in its key', () => {
    const turned = { ...box, rotation: 90 };
    expect(pictureTarget({ box: turned, fit: 'stretch' }, 0.5)).toBeUndefined();
    expect(pictureTarget({ box: turned, fit: 'stretch', flipH: true }, 0.5)).toBeUndefined();
    const t = pictureTarget({ box: turned, fit: 'stretch', mask: { preset: 'ellipse' } }, 0.5)!;
    // The 200 x 150 device box turned a quarter about its centre (150, 125) covers 150 x 200 px.
    expect([t.x, t.y, t.w, t.h]).toEqual([75, 25, 150, 200]);
    expect([t.bx, t.by, t.bw, t.bh]).toEqual([-25, 25, 200, 150]);
    expect(t.rotation).toBe(90);
    expect(t.key).toContain(' r90 ');
  });

  it('clamps the mask: garbage is no mask', () => {
    expect(pictureShape({ mask: { preset: '' } })).toBeUndefined();
    expect(
      pictureShape({ mask: { paths: [{ d: 'M 0 0 L 1 0 L 1 1 Z', w: 1, h: 1 }] }, flipV: true }),
    ).toEqual({
      mask: { paths: [{ d: 'M 0 0 L 1 0 L 1 1 Z', w: 1, h: 1 }] },
      flipV: true,
    });
  });
});

describe('paintShapedPicture', () => {
  it('mirrors the picture about the box centre and cuts it with a destination-in fill of the mask', () => {
    const ctx = recordingCtx();
    paintShapedPicture(ctx, img, 10, 20, 200, 100, 'stretch', undefined, {
      mask: { preset: 'ellipse' },
      flipH: true,
      w: 400,
      h: 200,
    });
    const draw = ctx.ops.find((o) => o.op === 'drawImage')!;
    // Box space 400 x 200 at device (10, 20) scaled by 0.5, mirrored about x = 110.
    expect(draw.transform).toEqual([-0.5, 0, 0, 0.5, 210, 20]);
    expect(draw.args.slice(1)).toEqual([0, 0, 400, 200]);
    const cut = ctx.ops.find((o) => o.op === 'fill')!;
    expect(cut.args[1]).toBe('nonzero');
    expect(cut.args[0]).toBeInstanceOf(RecPath);
  });
});

describe('drawImageFit with a mask (no OffscreenCanvas: a clip)', () => {
  it('clips to the mask, not the box, and draws unmasked pictures exactly as before', () => {
    const ctx = recordingCtx();
    drawImageFit(ctx, img, box, 0.5, 'stretch', 1, 0, undefined, undefined, { mask: { preset: 'ellipse' } });
    const clip = ctx.ops.find((o) => o.op === 'clip')!;
    expect(clip.args[0]).toBeInstanceOf(RecPath);
    expect(clip.args[1]).toBe('nonzero');
    const plain = recordingCtx();
    drawImageFit(plain, img, box, 0.5, 'stretch', 1, 0, undefined, undefined, { flipH: false });
    expect(plain.ops.map((o) => o.op)).toEqual(['beginPath', 'rect', 'clip', 'drawImage']);
  });
});
