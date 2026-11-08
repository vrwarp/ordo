import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Box, ImageObject } from '@ordo/domain';
import { clampGeom, clampObject } from './clamp.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { storedGeometry } from './geom/stored.ts';
import { pictureShape, pictureTarget } from './picture.ts';
import { encodePlane, PLANE_FLOATS, PLANE_MASK, PLANE_RADII } from './scene.ts';
import { drawImageFit, drawObject, slidePictures } from './text2d.ts';
import { recordingCtx } from './text/test-util.ts';

/*
 * Picture masks and flips as the editor writes them (design/27 §3.1, M4 item D), drawn by M6's picture path
 * (`picture.mask.test.ts` covers the drawing itself): mirrored about the box's centre inside the rotation,
 * cut to the mask's geometry, prepared like any other picture.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());

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

/** The transform of the first drawImage `ctx` recorded. */
const drawn = (ctx: ReturnType<typeof recordingCtx>) => ctx.ops.find((o) => o.op === 'drawImage')!;

describe('picture masks and flips (design/27 §3.1, M4 item D)', () => {
  it('draws an unshaped picture exactly as before: no mirror, the box with its radius', () => {
    const r = recordingCtx();
    drawImageFit(r, img, box, 2, 'contain', 1, 12, undefined, undefined, {});
    expect(r.ops.map((o) => o.op)).toEqual(['beginPath', 'roundRect', 'clip', 'drawImage']);
    expect(r.ops[1]!.args).toEqual([200, 100, 800, 600, 24]);
  });

  it('mirrors about the box centre, inside the rotation', () => {
    const r = recordingCtx();
    drawImageFit(r, img, box, 1, 'stretch', 1, 0, undefined, undefined, { flipH: true });
    // The picture's box space, mirrored about x = 300 (the box's centre).
    expect(drawn(r).transform).toEqual([-1, 0, 0, 1, 500, 50]);
    const v = recordingCtx();
    drawImageFit(v, img, box, 1, 'stretch', 1, 0, undefined, undefined, { flipV: true, flipH: true });
    expect(drawn(v).transform).toEqual([-1, 0, 0, -1, 500, 350]);
    const t = recordingCtx();
    drawImageFit(t, img, { ...box, rotation: 90 }, 1, 'stretch', 1, 0, undefined, undefined, { flipH: true });
    // Turned a quarter about (300, 200), then mirrored in the box: x' = -y, y' = -x about the centre.
    const [a, b, c, d, e, f] = drawn(t).transform;
    expect([a, b, c, d].map((x) => Math.round(x!) || 0)).toEqual([0, -1, -1, 0]);
    expect([e, f].map((x) => Math.round(x!))).toEqual([450, 400]);
  });

  it('cuts to the mask, the mask winning over radius (no OffscreenCanvas here: a clip of its geometry)', () => {
    const e = recordingCtx();
    drawImageFit(e, img, box, 2, 'stretch', 1, 40, undefined, undefined, { mask: { preset: 'ellipse' } });
    const clip = e.ops.find((o) => o.op === 'clip')!;
    expect(clip.args[0]).toBeInstanceOf(RecPath);
    expect(e.ops.map((o) => o.op)).not.toContain('roundRect');
  });

  it('cuts a rounded rect as the video plane does: ellipse and roundRect agree, other presets are the box there', () => {
    // roundRect's corner: 'adj' of the shorter side (default 16,667), where its outline starts (POI's path).
    const corner = (mask: ImageObject['mask']) =>
      storedGeometry(clampGeom(mask), 400, 300)!.paths[0]!.pts[1]!;
    expect(corner({ preset: 'roundRect' })).toBeCloseTo(50, 1);
    expect(corner({ preset: 'roundRect', adj: [['adj', 25_000]] })).toBeCloseTo(75, 6);
    expect(corner({ preset: 'roundRect', adj: [['adj', 90_000]] })).toBeCloseTo(150, 6);
    const plane = new Float32Array(PLANE_FLOATS);
    for (const [mask, kind] of [
      [{ preset: 'ellipse' }, 1],
      [{ preset: 'roundRect', adj: [['adj', 25_000]] as [string, number][] }, 2],
      // The video plane cuts only the two presets the editor offers: another one plays in its box.
      [{ preset: 'star5' }, 0],
    ] as const) {
      encodePlane({ box, mask }, 1, 0, 0, plane);
      expect(plane[PLANE_MASK]).toBe(kind);
      if (kind === 2) expect(plane[PLANE_RADII]! * box.w).toBeCloseTo(corner(mask), 3);
    }
  });

  it('prepares a masked or flipped picture like any other: its target holds the cut and the mirror', () => {
    expect(pictureTarget(picture(), 1)).toBeDefined();
    for (const extra of [{ flipH: true }, { flipV: true }, { mask: { preset: 'ellipse' } }]) {
      const t = pictureTarget(picture(extra), 1)!;
      expect(t.shape).toMatchObject({ ...extra, w: 400, h: 300 });
    }
    expect(pictureShape({ flipH: false, mask: { paths: [] } })).toBeUndefined();
    const [use] = slidePictures({ id: 's', objects: [picture({ flipH: true })] }, { scale: 1 });
    expect(use!.target?.shape).toEqual({ flipH: true, w: 400, h: 300 });
    // From its source (no prepared bitmap): mirrored and cut to the mask.
    const r = recordingCtx();
    drawObject(r, picture({ flipV: true, mask: { preset: 'ellipse' } }), 1, () => img);
    expect(drawn(r).transform[3]).toBe(-1);
    expect(r.ops.find((o) => o.op === 'clip')!.args[0]).toBeInstanceOf(RecPath);
  });
});

describe('the mask and flip clamps', () => {
  it('whitelists flips (true only) and a mask with a geometry', () => {
    expect(clampObject(picture())).toEqual(picture());
    expect(clampObject(picture({ flipH: true, flipV: false }))).toEqual(picture({ flipH: true }));
    expect(clampObject({ ...picture(), flipV: 'yes' })).not.toHaveProperty('flipV');
    expect(clampObject(picture({ mask: { preset: 'ellipse' } }))).toEqual(
      picture({ mask: { preset: 'ellipse' } }),
    );
    // Freeform paths are a mask too since M6; a mask with nothing drawable is none.
    const paths = [{ d: 'M 0 0 L 1 0 L 1 1 Z', w: 1, h: 1 }];
    expect(clampObject(picture({ mask: { paths } }))).toEqual(picture({ mask: { paths } }));
    expect(clampObject(picture({ mask: { preset: '' } }))).not.toHaveProperty('mask');
  });

  it('bounds the preset and adjust pairs', () => {
    expect(clampGeom(undefined)).toBeUndefined();
    expect(clampGeom({ preset: 7 })).toBeUndefined();
    const long = 'x'.repeat(100);
    const adj = [
      ['adj', 5e9],
      [long, 1],
      ['bad', Number.NaN],
      'no',
      [3, 4],
      ...Array.from({ length: 20 }, (_, i) => [`a${i}`, i]),
    ];
    const m = clampGeom({ preset: long, adj })!;
    expect(m.preset).toHaveLength(40);
    expect(m.adj![0]).toEqual(['adj', 1e7]);
    expect(m.adj![1]![0]).toHaveLength(16);
    expect(m.adj!.length).toBeLessThanOrEqual(10);
    expect(clampGeom({ preset: 'ellipse', adj: 'x' })).toEqual({ preset: 'ellipse' });
  });
});
