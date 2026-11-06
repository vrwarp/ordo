import type { Box, SlideObject } from '@ordo/domain';

/**
 * Scene stack: a video playing inside its slide (design/27 §7.2; work split in ../SCENE.md).
 *
 * A slide whose playing ImageObject (`play`) is on the media layer is drawn as an SRC_SCENE stack on the
 * slide layer instead of one bitmap:
 * - **base**: a full-frame bitmap of the objects up to the playing one, with its poster, plus the upper
 *   objects that do not overlap the video (`splitScene`). The poster therefore shows whenever the slot has
 *   no frame of the right generation. With `showWhenStopped: false` the poster is left out.
 * - **video**: the media slot's frame, drawn through the **plane** (`encodePlane`) at the object's box.
 * - **over**: a full-frame bitmap of the objects above the playing one that overlap the video (usually
 *   none, then null).
 *
 * The compositors draw `base`, then the video where the plane covers it (only while the slot's frame
 * generation equals the stack's `videoGen`), then `over`. `planeSample` is the reference for what the
 * WebGPU shader and the Canvas 2D path draw at a device pixel; the compositor golden compares both.
 *
 * Plane (PLANE_FLOATS floats, pre-allocated in each Stack and copied with set()):
 *
 * | Floats | Content |
 * |---|---|
 * | 0..5  | inverse affine a, b, c, d, e, f: frame u = a·x + c·y + e, v = b·x + d·y + f, from device px (x, y) to the frame's unit square, rotation and flips folded in |
 * | 6..9  | u0, v0, u1, v1: texture UV at frame (0, 0) and (1, 1), linear between (crop and fit folded in); UV outside 0..1 is transparent |
 * | 10    | mask kind: 0 rect, 1 ellipse, 2 rounded rect (MASK_*) |
 * | 11, 12| corner radii of the rounded rect, in frame units x, y |
 * | 13    | opacity |
 * | 14    | AA width in device px (1); per-axis widths in frame units come from the affine: aa·hypot(a, c), aa·hypot(b, d), no derivatives |
 * | 15    | flags: bit 0 PLANE_HAS_OVER (set here); bit 1 PLANE_VIDEO (video present, written per frame by the compositor into its own copy) |
 *
 * The frame is the object's box, except in one case: fit 'contain' with a positive crop on the letterboxed
 * axis, where the frame shrinks to the fitted picture on that axis so that the cropped-away margin is not
 * shown (exact for rect masks; the rounded rect's radii are approximated; an ellipse keeps the box frame).
 * Not handled: a clip with an alpha channel shows the poster in base through its transparent parts.
 */

export const PLANE_FLOATS = 16;
/** Offsets into a plane. */
export const PLANE_AFFINE = 0;
export const PLANE_UV = 6;
export const PLANE_MASK = 10;
export const PLANE_RADII = 11;
export const PLANE_OPACITY = 13;
export const PLANE_AA = 14;
export const PLANE_FLAGS = 15;

export const MASK_RECT = 0;
export const MASK_ELLIPSE = 1;
export const MASK_ROUND = 2;

/** Flag bits of PLANE_FLAGS (stored as a small integer in a float). */
export const PLANE_HAS_OVER = 1;
export const PLANE_VIDEO = 2;

/** OOXML roundRect's default `adj` (design/27 §3.1 ShapeGeom). */
const ROUND_RECT_ADJ = 16_667;

export type PlaneFit = 'contain' | 'cover' | 'stretch';

/**
 * The geometry a plane is made from: the playing ImageObject. Structural, so the fields other milestones
 * add to ImageObject (`crop` M1, `flipH`/`flipV`/`mask` M3) are read when present.
 */
export type PlaneSource = {
  /** Logical px (1920x1080), rotation in degrees clockwise about the centre. */
  box: Box;
  fit?: PlaneFit;
  opacity?: number;
  /** Rounded corners in logical px (ImageObject.radius), used when there is no `mask`. */
  radius?: number;
  /** Share cut from each side of the source before `fit`; negative pads transparent (ImageObject.crop). */
  crop?: { l: number; t: number; r: number; b: number };
  flipH?: boolean;
  flipV?: boolean;
  /** ShapeGeom: 'ellipse' and 'roundRect' (its `adj`) are masks here; any other preset is drawn as a rect. */
  mask?: { preset?: string; adj?: readonly (readonly [string, number])[] };
};

function fin(v: unknown, lo: number, hi: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Write the plane of `src` drawn at `scale` (device px per logical px) into `out` (PLANE_FLOATS floats).
 * `srcW` x `srcH` is the clip's size, or its poster's (same aspect), for fit 'contain' and 'cover'; 0 when
 * unknown, which draws as 'stretch'. Returns false, with a plane that draws nothing (opacity 0), when
 * nothing of the video can show (empty box, a crop that leaves nothing).
 */
export function encodePlane(
  src: PlaneSource,
  scale: number,
  srcW: number,
  srcH: number,
  out: Float32Array,
  hasOver = false,
): boolean {
  out.fill(0);
  if (hasOver) out[PLANE_FLAGS] = PLANE_HAS_OVER;
  const box = src.box;
  const w = fin(box?.w, 0, 1e6, 0);
  const h = fin(box?.h, 0, 1e6, 0);
  const s = fin(scale, 0, 1e3, 0);
  if (!(w > 0 && h > 0 && s > 0)) return false;
  const bx = fin(box.x, -1e6, 1e6, 0);
  const by = fin(box.y, -1e6, 1e6, 0);
  const c = src.crop;
  const l = fin(c?.l, -1, 1, 0);
  const t = fin(c?.t, -1, 1, 0);
  const r = fin(c?.r, -1, 1, 0);
  const b = fin(c?.b, -1, 1, 0);
  const cw = 1 - l - r;
  const ch = 1 - t - b;
  if (!(cw > 0 && ch > 0)) return false;

  // The fitted picture (the cropped source) in box units: [px0, px0 + pw] x [py0, py0 + ph].
  let px0 = 0;
  let py0 = 0;
  let pw = 1;
  let ph = 1;
  const fit = src.fit ?? 'contain';
  const sw = fin(srcW, 0, 1e6, 0) * cw;
  const sh = fin(srcH, 0, 1e6, 0) * ch;
  if (fit !== 'stretch' && sw > 0 && sh > 0) {
    const k = fit === 'contain' ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
    pw = (sw * k) / w;
    ph = (sh * k) / h;
    px0 = (1 - pw) / 2;
    py0 = (1 - ph) / 2;
  }

  // Mask in box units.
  let kind = MASK_RECT;
  let rx = 0;
  let ry = 0;
  const preset = src.mask?.preset;
  if (preset === 'ellipse') kind = MASK_ELLIPSE;
  else if (preset === 'roundRect') {
    let adj = ROUND_RECT_ADJ;
    for (const [name, v] of src.mask?.adj ?? []) if (name === 'adj') adj = fin(v, 0, 50_000, ROUND_RECT_ADJ);
    const rad = (Math.min(w, h) * adj) / 100_000;
    if (rad > 0) {
      kind = MASK_ROUND;
      rx = rad / w;
      ry = rad / h;
    }
  } else if (preset === undefined) {
    // Canvas roundRect scales an oversized radius down to half the shorter side.
    const rad = Math.min(fin(src.radius, 0, 1e6, 0), w / 2, h / 2);
    if (rad > 0) {
      kind = MASK_ROUND;
      rx = rad / w;
      ry = rad / h;
    }
  }

  // The frame in box units; the fitted picture on a letterboxed axis that has a positive crop.
  let fx0 = 0;
  let fw = 1;
  let fy0 = 0;
  let fh = 1;
  if (kind !== MASK_ELLIPSE && px0 > 1e-9 && (l > 0 || r > 0)) {
    fx0 = px0;
    fw = pw;
    if (kind === MASK_ROUND) [rx, ry] = shrinkCorner(rx, ry, px0, pw);
  }
  if (kind !== MASK_ELLIPSE && py0 > 1e-9 && (t > 0 || b > 0)) {
    fy0 = py0;
    fh = ph;
    if (kind === MASK_ROUND) [ry, rx] = shrinkCorner(ry, rx, py0, ph);
  }
  if (kind === MASK_ROUND && !(rx > 0 && ry > 0)) {
    kind = MASK_RECT;
    rx = 0;
    ry = 0;
  }

  // Inverse affine: device px -> logical -> unrotated about the box centre -> box units -> flipped ->
  // frame units.
  const theta = (fin(box.rotation, -36_000, 36_000, 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = bx + w / 2;
  const cy = by + h / 2;
  const sH = src.flipH ? -1 : 1;
  const sV = src.flipV ? -1 : 1;
  const ku = sH / (w * fw);
  const kv = sV / (h * fh);
  out[0] = (ku * cos) / s;
  out[1] = (-kv * sin) / s;
  out[2] = (ku * sin) / s;
  out[3] = (kv * cos) / s;
  out[4] = (0.5 - fx0) / fw - ku * (cos * cx + sin * cy);
  out[5] = (0.5 - fy0) / fh - kv * (-sin * cx + cos * cy);

  // UV at frame 0 and 1: frame -> box -> fitted picture -> cropped source.
  out[PLANE_UV] = l + ((fx0 - px0) / pw) * cw;
  out[PLANE_UV + 1] = t + ((fy0 - py0) / ph) * ch;
  out[PLANE_UV + 2] = l + ((fx0 + fw - px0) / pw) * cw;
  out[PLANE_UV + 3] = t + ((fy0 + fh - py0) / ph) * ch;
  out[PLANE_MASK] = kind;
  out[PLANE_RADII] = rx;
  out[PLANE_RADII + 1] = ry;
  out[PLANE_OPACITY] = fin(src.opacity, 0, 1, 1);
  out[PLANE_AA] = 1;
  return true;
}

/**
 * Corner radii after the frame shrinks along one axis to [gap, 1 - gap] (box units, the picture `size`
 * wide): the box's corner only reaches into the frame when the gap is narrower than its radius. The new
 * corner starts where the box's rounding meets the frame's edges (an approximation in between).
 */
function shrinkCorner(ra: number, rb: number, gap: number, size: number): [number, number] {
  if (gap >= ra) return [0, 0];
  const k = (ra - gap) / ra;
  return [(ra - gap) / size, rb * (1 - Math.sqrt(1 - k * k))];
}

/**
 * The forward transform of a plane (its frame's unit square to device px) as setTransform(a, b, c, d, e, f)
 * arguments, for the Canvas 2D compositor: draw the mask path and the cropped frame in unit coordinates.
 * Returns false when the plane is degenerate.
 */
export function planeForward(plane: Float32Array, out: { [i: number]: number }): boolean {
  const a = plane[0]!;
  const b = plane[1]!;
  const c = plane[2]!;
  const d = plane[3]!;
  const e = plane[4]!;
  const f = plane[5]!;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return false;
  out[0] = d / det;
  out[1] = -b / det;
  out[2] = -c / det;
  out[3] = a / det;
  out[4] = (c * f - d * e) / det;
  out[5] = (b * e - a * f) / det;
  return true;
}

/** Coverage of a signed distance `dist` (device px, positive inside) over an AA ramp `width` px wide. */
function ramp(dist: number, width: number): number {
  if (!(width > 0)) return dist >= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, dist / width + 0.5));
}

/** Coverage of the elliptical region |q| <= 1, q = (p - centre) / radii, at the frame point p. */
function ellipseCoverage(
  px: number,
  py: number,
  ox: number,
  oy: number,
  rx: number,
  ry: number,
  plane: Float32Array,
  aa: number,
): number {
  const qx = (px - ox) / rx;
  const qy = (py - oy) / ry;
  const g = Math.hypot(qx, qy);
  if (g < 1e-12) return 1;
  // d|q| per frame unit, then per device px through the affine (no derivatives).
  const gu = qx / (rx * g);
  const gv = qy / (ry * g);
  const dx = gu * plane[0]! + gv * plane[1]!;
  const dy = gu * plane[2]! + gv * plane[3]!;
  const grad = Math.hypot(dx, dy);
  return grad > 0 ? ramp((1 - g) / grad, aa) : g <= 1 ? 1 : 0;
}

/**
 * The reference of what a compositor draws at device point (x, y) (a pixel centre): out[0], out[1] = the
 * texture UV sampled there, out[2] = its weight 0..1, anti-aliased. The WebGPU shader and the Canvas 2D
 * path draw the same within the compositor golden's tolerance.
 *
 * The weight is the mask's coverage within the source (UV 0..1), times the opacity. Distances are in device
 * px: frame units over hypot(a, c) along u and hypot(b, d) along v. A rect mask and the source's edges
 * meet along the same axes, so each axis takes the nearer of its two edges and the axes multiply; a
 * rounded or elliptical mask takes the smaller of its coverage and the source's.
 */
export function planeSample(plane: Float32Array, x: number, y: number, out: { [i: number]: number }): void {
  const u = plane[0]! * x + plane[2]! * y + plane[4]!;
  const v = plane[1]! * x + plane[3]! * y + plane[5]!;
  const aa = plane[PLANE_AA]!;
  const du = Math.hypot(plane[0]!, plane[2]!);
  const dv = Math.hypot(plane[1]!, plane[3]!);
  const u0 = plane[PLANE_UV]!;
  const v0 = plane[PLANE_UV + 1]!;
  const su = plane[PLANE_UV + 2]! - u0;
  const sv = plane[PLANE_UV + 3]! - v0;
  const tu = u0 + u * su;
  const tv = v0 + v * sv;
  const gu = Math.abs(su) * du;
  const gv = Math.abs(sv) * dv;
  // Signed distances inside, device px (-1: degenerate, outside).
  const fu = du > 0 ? Math.min(u, 1 - u) / du : -1;
  const fv = dv > 0 ? Math.min(v, 1 - v) / dv : -1;
  const su0 = gu > 0 ? Math.min(tu, 1 - tu) / gu : -1;
  const sv0 = gv > 0 ? Math.min(tv, 1 - tv) / gv : -1;
  const kind = plane[PLANE_MASK]!;
  const rx = plane[PLANE_RADII]!;
  const ry = plane[PLANE_RADII + 1]!;
  let w: number;
  if (kind === MASK_ELLIPSE)
    w = Math.min(ellipseCoverage(u, v, 0.5, 0.5, 0.5, 0.5, plane, aa), ramp(su0, aa) * ramp(sv0, aa));
  else if (kind === MASK_ROUND && rx > 0 && ry > 0 && (u < rx || u > 1 - rx) && (v < ry || v > 1 - ry)) {
    const m = ellipseCoverage(u, v, u < rx ? rx : 1 - rx, v < ry ? ry : 1 - ry, rx, ry, plane, aa);
    w = Math.min(m, ramp(su0, aa) * ramp(sv0, aa));
  } else w = ramp(Math.min(fu, su0), aa) * ramp(Math.min(fv, sv0), aa);
  out[0] = tu;
  out[1] = tv;
  out[2] = w * plane[PLANE_OPACITY]!;
}

/** An axis-aligned rect in logical px. */
export type Rect = { x: number; y: number; w: number; h: number };

/** The axis-aligned bounds of a box rotated about its centre (logical px). */
export function rotatedBounds(box: Box): Rect {
  const w = fin(box.w, 0, 1e6, 0);
  const h = fin(box.h, 0, 1e6, 0);
  const cx = fin(box.x, -1e6, 1e6, 0) + w / 2;
  const cy = fin(box.y, -1e6, 1e6, 0) + h / 2;
  const th = (fin(box.rotation, -36_000, 36_000, 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(th));
  const s = Math.abs(Math.sin(th));
  const hw = (w * c + h * s) / 2;
  const hh = (w * s + h * c) / 2;
  return { x: cx - hw, y: cy - hh, w: 2 * hw, h: 2 * hh };
}

type Effects = {
  shadow?: { dx?: number; dy?: number; blur?: number } | null;
  outline?: { width?: number } | null;
  glow?: { radius?: number } | null;
  stroke?: { width?: number } | null;
};

/** How far an object's effects (shadow, outline, glow, stroke) can reach past its box, logical px. */
function effectMargin(o: SlideObject): number {
  const e = o as unknown as Effects;
  const style = o.type === 'text' ? (o.style as unknown as Effects) : undefined;
  let m = 0;
  for (const x of [e, style]) {
    if (!x) continue;
    if (x.shadow)
      m = Math.max(
        m,
        Math.max(Math.abs(fin(x.shadow.dx, -1e4, 1e4, 0)), Math.abs(fin(x.shadow.dy, -1e4, 1e4, 0))) +
          2 * fin(x.shadow.blur, 0, 1e4, 0),
      );
    if (x.outline) m = Math.max(m, fin(x.outline.width, 0, 1e4, 0));
    if (x.glow) m = Math.max(m, 2 * fin(x.glow.radius, 0, 1e4, 0));
    if (x.stroke) m = Math.max(m, fin(x.stroke.width, 0, 1e4, 0));
  }
  return m;
}

/**
 * Where an object can draw (logical px): its rotated box plus the reach of its effects. Text that
 * overflows its box draws past this; the asset worker passes measured bounds for text instead.
 */
export function objectBounds(o: SlideObject): Rect {
  const r = rotatedBounds(o.box);
  const m = effectMargin(o);
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export type SceneSplit<O> = { base: O[]; over: O[] };

/**
 * Split a slide's objects (z order, back to front) around the playing object at `playIndex`:
 * - base: the objects below it; the playing object itself (its poster), unless `showWhenStopped` is false;
 *   and the objects above it that overlap neither the video nor anything already in over;
 * - over: the objects above it that overlap the video's box, and those that overlap an object already in
 *   over (so z order holds where an over object and a later object meet outside the video).
 *
 * Overlap is tested on axis-aligned bounds (`bounds`, default `objectBounds`), so it is conservative: an
 * object may land in over without touching the video, never the reverse. The video's bounds are widened
 * by a pixel for its anti-aliased edge.
 */
export function splitScene<O extends SlideObject>(
  objects: readonly O[],
  playIndex: number,
  opts: { showWhenStopped?: boolean; bounds?: (o: O) => Rect } = {},
): SceneSplit<O> {
  const play = objects[playIndex];
  if (!play) return { base: objects.slice(), over: [] };
  const bounds = opts.bounds ?? objectBounds;
  const base: O[] = objects.slice(0, playIndex);
  if (opts.showWhenStopped !== false) base.push(play);
  const vb = rotatedBounds(play.box);
  const video: Rect = { x: vb.x - 1, y: vb.y - 1, w: vb.w + 2, h: vb.h + 2 };
  const over: O[] = [];
  const overRects: Rect[] = [];
  for (let i = playIndex + 1; i < objects.length; i++) {
    const o = objects[i]!;
    const r = bounds(o);
    if (overlaps(r, video) || overRects.some((x) => overlaps(r, x))) {
      over.push(o);
      overRects.push(r);
    } else base.push(o);
  }
  return { base, over };
}
