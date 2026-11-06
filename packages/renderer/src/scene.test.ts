import type { Box, SlideObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  MASK_ELLIPSE,
  MASK_RECT,
  MASK_ROUND,
  MIN_PLANE_BOX,
  PLANE_AA,
  PLANE_FLAGS,
  PLANE_FLOATS,
  PLANE_HAS_OVER,
  PLANE_MASK,
  PLANE_OPACITY,
  PLANE_RADII,
  PLANE_UV,
  type PlaneSource,
  encodePlane,
  objectBounds,
  planeForward,
  planeSample,
  rotatedBounds,
  splitScene,
} from './scene.ts';

const box = (x: number, y: number, w: number, h: number, rotation = 0): Box => ({ x, y, w, h, rotation });

function plane(src: PlaneSource, scale = 1, srcW = 0, srcH = 0, hasOver = false) {
  const out = new Float32Array(PLANE_FLOATS);
  const ok = encodePlane(src, scale, srcW, srcH, out, hasOver);
  return { p: out, ok };
}

/** Frame coordinates of device point (x, y). */
function frameAt(p: Float32Array, x: number, y: number): [number, number] {
  return [p[0]! * x + p[2]! * y + p[4]!, p[1]! * x + p[3]! * y + p[5]!];
}

/** Device point of frame coordinates (u, v), through planeForward. */
function deviceAt(p: Float32Array, u: number, v: number): [number, number] {
  const m = new Float64Array(6);
  expect(planeForward(p, m)).toBe(true);
  return [m[0]! * u + m[2]! * v + m[4]!, m[1]! * u + m[3]! * v + m[5]!];
}

function sample(p: Float32Array, x: number, y: number): { u: number; v: number; w: number } {
  const o = new Float64Array(3);
  planeSample(p, x, y, o);
  return { u: o[0]!, v: o[1]!, w: o[2]! };
}

function close(a: readonly number[], b: readonly number[], digits = 4): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i]!, digits);
}

describe('encodePlane', () => {
  it('maps an axis-aligned box onto the unit square at the output scale', () => {
    const { p, ok } = plane({ box: box(100, 200, 400, 300), fit: 'stretch' }, 2);
    expect(ok).toBe(true);
    close(frameAt(p, 200, 400), [0, 0]);
    close(frameAt(p, 1000, 1000), [1, 1]);
    close(frameAt(p, 600, 700), [0.5, 0.5]);
    close([...p.slice(PLANE_UV, PLANE_UV + 4)], [0, 0, 1, 1]);
    expect(p[PLANE_MASK]).toBe(MASK_RECT);
    expect(p[PLANE_OPACITY]).toBe(1);
    expect(p[PLANE_AA]).toBe(1);
    expect(p[PLANE_FLAGS]).toBe(0);
  });

  it('folds rotation about the box centre into the affine (clockwise, as the Canvas 2D drawers)', () => {
    const { p } = plane({ box: box(0, 0, 200, 100, 90), fit: 'stretch' });
    // Top-left, top-right and bottom-left corners after a quarter turn clockwise about (100, 50).
    close(deviceAt(p, 0, 0), [150, -50]);
    close(deviceAt(p, 1, 0), [150, 150]);
    close(deviceAt(p, 0, 1), [50, -50]);
    close(frameAt(p, 150, -50), [0, 0]);
    close(frameAt(p, 100, 50), [0.5, 0.5]);
  });

  it('folds flips into the affine: the picture is mirrored inside its box', () => {
    const h = plane({ box: box(0, 0, 100, 100), fit: 'stretch', flipH: true }).p;
    close(frameAt(h, 0, 50), [1, 0.5]);
    close(frameAt(h, 100, 50), [0, 0.5]);
    const v = plane({ box: box(0, 0, 100, 100), fit: 'stretch', flipV: true }).p;
    close(frameAt(v, 50, 0), [0.5, 1]);
    close(frameAt(v, 50, 100), [0.5, 0]);
  });

  it('round-trips planeForward through the inverse affine with rotation, flips and scale', () => {
    const { p } = plane(
      { box: box(310, -40, 777, 333, -37.5), fit: 'stretch', flipH: true, flipV: true },
      2.5,
    );
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [0.3, 0.9],
      [1, 1],
    ] as const) {
      const [x, y] = deviceAt(p, u, v);
      close(frameAt(p, x, y), [u, v], 3);
    }
  });

  it('writes the crop as the UV rect of a stretched picture', () => {
    const { p } = plane({ box: box(0, 0, 100, 100), fit: 'stretch', crop: { l: 0.1, t: 0.2, r: 0.3, b: 0 } });
    close([...p.slice(PLANE_UV, PLANE_UV + 4)], [0.1, 0.2, 0.7, 1]);
  });

  it('folds contain and cover into the UV rect from the source size', () => {
    // A square clip in a 4:1 box: contain leaves the sides transparent (UV outside 0..1)…
    const contain = plane({ box: box(0, 0, 400, 100), fit: 'contain' }, 1, 100, 100).p;
    close([...contain.slice(PLANE_UV, PLANE_UV + 4)], [-1.5, 0, 2.5, 1]);
    expect(sample(contain, 200, 50).w).toBe(1);
    expect(sample(contain, 80, 50).w).toBe(0);
    // …and cover samples the middle band.
    const cover = plane({ box: box(0, 0, 400, 100), fit: 'cover' }, 1, 100, 100).p;
    close([...cover.slice(PLANE_UV, PLANE_UV + 4)], [0, 0.375, 1, 0.625]);
    // An unknown source size draws as stretch.
    const unknown = plane({ box: box(0, 0, 400, 100), fit: 'contain' }).p;
    close([...unknown.slice(PLANE_UV, PLANE_UV + 4)], [0, 0, 1, 1]);
  });

  it('pads a negative crop with transparency', () => {
    const { p } = plane({ box: box(0, 0, 150, 100), fit: 'stretch', crop: { l: -0.5, t: 0, r: 0, b: 0 } });
    close([...p.slice(PLANE_UV, PLANE_UV + 4)], [-0.5, 0, 1, 1]);
    expect(sample(p, 30, 50).w).toBe(0);
    expect(sample(p, 100, 50).w).toBe(1);
  });

  it('shrinks the frame to the fitted picture for contain with a positive crop, hiding the cut margin', () => {
    const src: PlaneSource = {
      box: box(0, 0, 400, 100),
      fit: 'contain',
      crop: { l: 0.2, t: 0, r: 0.2, b: 0 },
    };
    const { p } = plane(src, 1, 100, 100);
    close([...p.slice(PLANE_UV, PLANE_UV + 4)], [0.2, 0, 0.8, 1]);
    // The 60x100 cropped clip lands at x 170..230.
    close(frameAt(p, 170, 0), [0, 0]);
    close(frameAt(p, 230, 100), [1, 1]);
    expect(sample(p, 168.5, 50).w).toBe(0);
    expect(sample(p, 200, 50).w).toBe(1);
    expect(sample(p, 231.5, 50).w).toBe(0);
  });

  it('turns ImageObject.radius into rounded-rect radii in frame units, capped like Canvas roundRect', () => {
    const a = plane({ box: box(0, 0, 200, 100), fit: 'stretch', radius: 20 }).p;
    expect(a[PLANE_MASK]).toBe(MASK_ROUND);
    close([a[PLANE_RADII]!, a[PLANE_RADII + 1]!], [0.1, 0.2]);
    const b = plane({ box: box(0, 0, 200, 100), fit: 'stretch', radius: 500 }).p;
    close([b[PLANE_RADII]!, b[PLANE_RADII + 1]!], [0.25, 0.5]);
  });

  it('reads ellipse and roundRect masks (ShapeGeom) and draws other presets as rects', () => {
    expect(plane({ box: box(0, 0, 200, 100), mask: { preset: 'ellipse' } }).p[PLANE_MASK]).toBe(MASK_ELLIPSE);
    const r = plane({ box: box(0, 0, 200, 100), mask: { preset: 'roundRect', adj: [['adj', 50_000]] } }).p;
    expect(r[PLANE_MASK]).toBe(MASK_ROUND);
    close([r[PLANE_RADII]!, r[PLANE_RADII + 1]!], [0.25, 0.5]);
    const d = plane({ box: box(0, 0, 200, 100), mask: { preset: 'roundRect' } }).p;
    close([d[PLANE_RADII]!, d[PLANE_RADII + 1]!], [(100 * 0.16667) / 200, 0.16667]);
    const t = plane({ box: box(0, 0, 200, 100), radius: 30, mask: { preset: 'triangle' } }).p;
    expect(t[PLANE_MASK]).toBe(MASK_RECT);
  });

  it('carries opacity and the over flag', () => {
    const { p } = plane({ box: box(0, 0, 10, 10), opacity: 0.4 }, 1, 0, 0, true);
    expect(p[PLANE_OPACITY]).toBeCloseTo(0.4, 6);
    expect(p[PLANE_FLAGS]).toBe(PLANE_HAS_OVER);
    expect(sample(p, 5, 5).w).toBeCloseTo(0.4, 6);
  });

  it('draws nothing for an empty box or a crop that leaves nothing', () => {
    for (const src of [
      { box: box(0, 0, 0, 100) },
      { box: box(0, 0, 100, Number.NaN) },
      { box: box(0, 0, 100, 100), crop: { l: 0.6, t: 0, r: 0.5, b: 0 } },
    ]) {
      const { p, ok } = plane(src);
      expect(ok).toBe(false);
      expect(p[PLANE_OPACITY]).toBe(0);
      expect(sample(p, 50, 50).w).toBe(0);
    }
  });

  it('never writes a non-finite float: a tiny box or scale from untrusted data draws nothing', () => {
    for (const [src, scale] of [
      [{ box: box(900, 300, 1e-300, 300) }, 1],
      [{ box: box(900, 300, 300, 1e-37), radius: 4 }, 1],
      [{ box: box(900, 300, MIN_PLANE_BOX / 2, 300) }, 1],
      [{ box: box(900, 300, 300, 300) }, 1e-300],
    ] as const) {
      const { p, ok } = plane(src, scale, 0, 0, true);
      expect(ok).toBe(false);
      expect([...p].every(Number.isFinite)).toBe(true);
      expect(p[PLANE_OPACITY]).toBe(0);
      expect(p[PLANE_FLAGS]).toBe(PLANE_HAS_OVER);
    }
    // The smallest box it encodes is finite.
    const { p, ok } = plane({ box: box(1e6, -1e6, MIN_PLANE_BOX, MIN_PLANE_BOX, 45), radius: 1 }, 1e-3);
    expect(ok).toBe(true);
    expect([...p].every(Number.isFinite)).toBe(true);
  });
});

describe('planeSample', () => {
  it('anti-aliases rect edges over one device pixel', () => {
    const { p } = plane({ box: box(0, 0, 100, 100), fit: 'stretch' });
    expect(sample(p, 0.5, 50).w).toBe(1);
    expect(sample(p, 0, 50).w).toBeCloseTo(0.5, 5);
    expect(sample(p, -0.5, 50).w).toBe(0);
    close([sample(p, 25, 75).u, sample(p, 25, 75).v], [0.25, 0.75]);
  });

  it('masks an ellipse and rounded corners', () => {
    const e = plane({ box: box(0, 0, 200, 100), mask: { preset: 'ellipse' } }).p;
    expect(sample(e, 100, 50).w).toBe(1);
    expect(sample(e, 5, 5).w).toBe(0);
    expect(sample(e, 1, 50).w).toBeGreaterThan(0.4);
    const r = plane({ box: box(0, 0, 200, 100), radius: 25 }).p;
    expect(sample(r, 2, 2).w).toBe(0);
    expect(sample(r, 100, 2).w).toBe(1);
    expect(sample(r, 25, 25).w).toBe(1);
  });

  it('keeps a rotated plane inside its rotated box', () => {
    const { p } = plane({ box: box(0, 0, 200, 100, 90), fit: 'stretch' });
    expect(sample(p, 100, 50).w).toBe(1);
    // Outside the rotated footprint (x 50..150, y -50..150), inside the unrotated box.
    expect(sample(p, 20, 50).w).toBe(0);
    expect(sample(p, 100, 140).w).toBe(1);
  });
});

const text = (id: string, b: Box, shadow?: { dx: number; dy: number; blur: number }): SlideObject => ({
  id,
  type: 'text',
  box: b,
  text: id,
  opacity: 1,
  style: {
    fontFamily: 'Inter',
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: 40,
    color: { r: 255, g: 255, b: 255, a: 1 },
    align: 'center',
    valign: 'middle',
    lineHeight: 1.2,
    letterSpacing: 0,
    padding: 0,
    transform: 'none',
    ...(shadow ? { shadow: { ...shadow, color: { r: 0, g: 0, b: 0, a: 1 } } } : {}),
  },
});
const shape = (id: string, b: Box): SlideObject => ({
  id,
  type: 'shape',
  box: b,
  shape: 'rect',
  opacity: 1,
  radius: 0,
});
const image = (id: string, b: Box): SlideObject => ({
  id,
  type: 'image',
  box: b,
  mediaId: `${id}-poster`,
  play: { mediaId: `${id}-clip` },
  fit: 'stretch',
  opacity: 1,
  radius: 0,
});

describe('splitScene', () => {
  const objects = [
    shape('bg', box(0, 0, 1920, 1080)),
    image('video', box(500, 300, 800, 450)),
    text('title', box(600, 650, 600, 200)), // overlaps the video's bottom
    shape('logo', box(1700, 900, 150, 150)), // clear of everything
    shape('badge', box(1150, 820, 120, 60)), // overlaps the title only
    shape('corner', box(20, 20, 100, 100)), // clear of everything
  ];
  const ids = (os: SlideObject[]) => os.map((o) => o.id);

  it('puts the objects up to the video, with its poster, and the clear upper objects in base', () => {
    const s = splitScene(objects, 1);
    expect(ids(s.base)).toEqual(['bg', 'video', 'logo', 'corner']);
    expect(ids(s.over)).toEqual(['title', 'badge']);
  });

  it('leaves the poster out when the video hides while stopped', () => {
    expect(ids(splitScene(objects, 1, { showWhenStopped: false }).base)).toEqual(['bg', 'logo', 'corner']);
  });

  it('tests rotated bounds and effect reach, and takes measured bounds when given', () => {
    const v = image('video', box(500, 300, 800, 450));
    // A tall bar whose unrotated box ends 10 px left of the video, but its rotated bounds reach it.
    const bar = shape('bar', box(470, 400, 20, 200, 45));
    // A caption 10 px below the video whose shadow reaches back up into it.
    const shadowed = text('shadowed', box(500, 760, 800, 100), { dx: 0, dy: -20, blur: 4 });
    const plain = text('plain', box(500, 900, 800, 100));
    const s = splitScene([v, bar, shadowed, plain], 0);
    expect(ids(s.over)).toEqual(['bar', 'shadowed']);
    expect(ids(s.base)).toEqual(['video', 'plain']);
    // Measured text bounds (the asset worker's layout) that overflow into the video.
    const m = splitScene([v, plain], 0, {
      bounds: (o) => (o.id === 'plain' ? { x: 500, y: 700, w: 800, h: 200 } : objectBounds(o)),
    });
    expect(ids(m.over)).toEqual(['plain']);
  });

  it('keeps everything in base when the play index is unknown', () => {
    const s = splitScene(objects, 42);
    expect(ids(s.base)).toEqual(ids(objects));
    expect(s.over).toEqual([]);
  });
});

describe('bounds', () => {
  it('rotates a box about its centre', () => {
    const r = rotatedBounds(box(0, 0, 200, 100, 90));
    close([r.x, r.y, r.w, r.h], [50, -50, 100, 200]);
  });
});
