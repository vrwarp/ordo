/**
 * Geometry: the slide → 1920x1080 mapping and affine transforms (design/27 §1 `frame.ts`, §4 "Groups").
 *
 * The slide is contain-fitted and centred with one scale, as `fitPage` (`apps/hub/src/media/ffmpeg.ts`)
 * places LibreOffice's pages: `s = min(1920/cx, 1080/cy)`, `x0 = (1920 − cx·s)/2`, `y0 = (1080 − cy·s)/2`.
 * One point (12,700 EMU) is `12700·s` px: 2 px for both standard sizes.
 *
 * Owned by work item A (reading).
 */
import { type Affine, EMU_PER_PT, type Emu, type Frame } from './ir.ts';

export const LOGICAL_W = 1920;
export const LOGICAL_H = 1080;
/** The default slide size (16:9, 13.333 x 7.5 in) when `p:sldSz` is missing or out of bounds. */
export const DEFAULT_SLIDE = { cx: 12_192_000, cy: 6_858_000 } as const;
/** Bounds of a slide side (design/27 §12). */
export const MIN_SIDE = 1;
export const MAX_SIDE = 51_206_400;

export function frameOf(cx: Emu, cy: Emu): Frame {
  if (!(cx >= MIN_SIDE && cx <= MAX_SIDE && cy >= MIN_SIDE && cy <= MAX_SIDE)) ({ cx, cy } = DEFAULT_SLIDE);
  const s = Math.min(LOGICAL_W / cx, LOGICAL_H / cy);
  return { cx, cy, s, x0: (LOGICAL_W - cx * s) / 2, y0: (LOGICAL_H - cy * s) / 2 };
}

/** A length in EMU as logical px. */
export function lenPx(f: Frame, emu: Emu): number {
  return emu * f.s;
}

/** A size in points as logical px. */
export function ptPx(f: Frame, pt: number): number {
  return pt * EMU_PER_PT * f.s;
}

/** The slide's area in logical px (`source.native.slideRect`). */
export function slideRect(f: Frame): { x: number; y: number; w: number; h: number } {
  return { x: f.x0, y: f.y0, w: f.cx * f.s, h: f.cy * f.s };
}

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m ∘ n`: apply `n` first, then `m`. */
export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** An `a:xfrm`'s values: EMU, rotation in degrees clockwise. */
export interface Xfrm {
  x: Emu;
  y: Emu;
  cx: Emu;
  cy: Emu;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/**
 * The affine that maps the unit square to an `a:xfrm`'s box: scaled to (cx, cy), flipped and rotated about
 * the box centre, the centre placed at (x + cx/2, y + cy/2).
 */
export function xfrmAffine(x: Xfrm): Affine {
  const r = (x.rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = x.flipH ? -x.cx : x.cx;
  const sy = x.flipV ? -x.cy : x.cy;
  // translate(centre) · rotate · scale(sx, sy) · translate(-0.5, -0.5)
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const cxm = x.x + x.cx / 2;
  const cym = x.y + x.cy / 2;
  return [a, b, c, d, cxm - (a + c) / 2, cym - (b + d) / 2];
}

/**
 * The map from a group's child space (`a:chOff`, `a:chExt`) to the slide, given the group's own unit-square
 * affine: child EMU → the group's unit square → slide. A zero child extent is taken as the group's extent
 * (callers substitute ext and chExt for each other before this).
 */
export function childSpace(groupXf: Affine, chOff: { x: Emu; y: Emu }, chExt: { cx: Emu; cy: Emu }): Affine {
  const sx = chExt.cx ? 1 / chExt.cx : 0;
  const sy = chExt.cy ? 1 / chExt.cy : 0;
  return multiply(groupXf, [sx, 0, 0, sy, -chOff.x * sx, -chOff.y * sy]);
}

/** An affine taken apart into an ordo-style box (centre, size, rotation, flips). */
export interface Placed {
  /** Box centre and size in the affine's output units. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Degrees clockwise, in (-180, 180]. */
  rot: number;
  flipH: boolean;
  flipV: boolean;
  /** The unit square maps to a parallelogram that is not a rectangle (a sheared group child). */
  sheared: boolean;
}

/** Decompose a unit-square affine. A single reflection is reported as `flipH`. */
export function decompose(m: Affine): Placed {
  const [a, b, c, d] = m;
  const w = Math.hypot(a, b);
  const h = Math.hypot(c, d);
  const flip = a * d - b * c < 0;
  // With flipH the x column points the other way: rotation is the angle of −u.
  const ux = flip ? -a : a;
  const uy = flip ? -b : b;
  let rot = w > 0 ? (Math.atan2(uy, ux) * 180) / Math.PI : h > 0 ? (Math.atan2(-c, d) * 180) / Math.PI : 0;
  if (rot <= -180) rot += 360;
  const sheared = w > 0 && h > 0 && Math.abs(a * c + b * d) > 1e-6 * w * h;
  const [cx, cy] = apply(m, 0.5, 0.5);
  return { cx, cy, w, h, rot, flipH: flip, flipV: false, sheared };
}

/** An ordo `Box` (logical px, rotation in degrees) for a unit-square affine in slide EMU. */
export function boxPx(f: Frame, m: Affine): { x: number; y: number; w: number; h: number; rotation: number } {
  const p = decompose(m);
  const w = p.w * f.s;
  const h = p.h * f.s;
  const cx = f.x0 + p.cx * f.s;
  const cy = f.y0 + p.cy * f.s;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rotation: Math.abs(p.rot) < 1e-9 ? 0 : p.rot };
}
