import { describe, expect, it } from 'vitest';
import {
  apply,
  boxPx,
  childSpace,
  decompose,
  frameOf,
  multiply,
  ptPx,
  slideRect,
  xfrmAffine,
} from './frame.ts';

describe('frameOf', () => {
  it('maps a 16:9 slide onto the whole canvas, 2 px per point', () => {
    const f = frameOf(12_192_000, 6_858_000);
    expect(f.x0).toBeCloseTo(0);
    expect(f.y0).toBeCloseTo(0);
    expect(ptPx(f, 1)).toBeCloseTo(2);
    expect(slideRect(f)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('pillarboxes a 4:3 slide with 240 px bars, still 2 px per point', () => {
    const f = frameOf(9_144_000, 6_858_000);
    expect(f.x0).toBeCloseTo(240);
    expect(f.y0).toBeCloseTo(0);
    expect(ptPx(f, 1)).toBeCloseTo(2);
    const r = slideRect(f);
    expect(r.w).toBeCloseTo(1440);
    expect(r.h).toBeCloseTo(1080);
  });

  it('falls back to the default size for sizes out of bounds', () => {
    for (const [cx, cy] of [
      [0, 6_858_000],
      [Number.NaN, 1],
      [60_000_000, 6_858_000],
    ] as const)
      expect(frameOf(cx, cy).cx).toBe(12_192_000);
  });
});

describe('affine', () => {
  it('places an xfrm box and takes it apart again, rotation and flips included', () => {
    for (const [rot, flipH, flipV] of [
      [0, false, false],
      [30, false, false],
      [-90, true, false],
      [135, false, true],
    ] as const) {
      const m = xfrmAffine({ x: 100, y: 200, cx: 400, cy: 100, rot, flipH, flipV });
      const p = decompose(m);
      expect(p.cx).toBeCloseTo(300);
      expect(p.cy).toBeCloseTo(250);
      expect(p.w).toBeCloseTo(400);
      expect(p.h).toBeCloseTo(100);
      expect(p.sheared).toBe(false);
      expect(p.flipH).toBe(flipH !== flipV);
      // flipV is flipH turned half a turn
      const want = ((((rot + (flipV ? 180 : 0) + 180) % 360) + 360) % 360) - 180;
      expect(((p.rot - want + 540) % 360) - 180).toBeCloseTo(0);
    }
  });

  it('maps a group child through the group child space (offset and scale)', () => {
    const group = xfrmAffine({ x: 1000, y: 1000, cx: 2000, cy: 1000, rot: 0, flipH: false, flipV: false });
    const inner = childSpace(group, { x: 0, y: 0 }, { cx: 1000, cy: 1000 });
    const child = multiply(
      inner,
      xfrmAffine({ x: 500, y: 0, cx: 500, cy: 500, rot: 0, flipH: false, flipV: false }),
    );
    expect(apply(child, 0, 0)).toEqual([2000, 1000]);
    expect(apply(child, 1, 1)).toEqual([3000, 1500]);
  });

  it('reports a sheared child of a rotated, unevenly scaled group', () => {
    const group = xfrmAffine({ x: 0, y: 0, cx: 2000, cy: 1000, rot: 0, flipH: false, flipV: false });
    const inner = childSpace(group, { x: 0, y: 0 }, { cx: 1000, cy: 1000 });
    const child = multiply(
      inner,
      xfrmAffine({ x: 0, y: 0, cx: 100, cy: 100, rot: 45, flipH: false, flipV: false }),
    );
    expect(decompose(child).sheared).toBe(true);
  });

  it('gives an ordo box in logical px', () => {
    const f = frameOf(9_144_000, 6_858_000);
    const b = boxPx(
      f,
      xfrmAffine({ x: 0, y: 0, cx: 914_400, cy: 457_200, rot: 0, flipH: false, flipV: false }),
    );
    expect(b.x).toBeCloseTo(240);
    expect(b.y).toBeCloseTo(0);
    expect(b.w).toBeCloseTo(144);
    expect(b.h).toBeCloseTo(72);
    expect(b.rotation).toBe(0);
  });
});
