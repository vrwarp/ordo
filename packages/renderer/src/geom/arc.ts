/*
 * DrawingML arcTo (ECMA-376-1 §20.1.9.4) as cubic Bézier segments, the way Apache POI 5.2.5 draws it
 * (`ArcToCommandIf.execute`, `ArcToCommand.convertOoxml2AwtAngle`, then java.awt.geom.Arc2D's path iterator).
 *
 * An arcTo continues the path from its current point along an ellipse of radii wR and hR, from the start angle
 * stAng through the sweep swAng (60000ths of a degree, clockwise: y grows down). The angles are visual: stAng is
 * the direction, seen from the ellipse's centre, of the current point, not the ellipse's parametric angle. So
 * each angle θ is converted to the parametric angle t of the point in that direction, tan t = (wR/hR)·tan θ, in
 * the quadrant of θ (POI's "unskew"); the centre is the current point minus (wR·cos t₀, hR·sin t₀); and the arc
 * runs from t₀ to t(stAng + swAng). The segments are Arc2D's: ⌈|sweep|/90°⌉ equal cubic segments, each with the
 * control-point factor 4/3·tan(¼·segment angle), so the points are POI's to rounding.
 *
 * Where POI misbehaves, this follows LibreOffice (svx EnhancedCustomShape2d, ARCANGLETO) or the limit:
 * - The sweep is clamped to ±360° (MSO does, LibreOffice tdf#122323; POI draws a full turn for any larger sweep,
 *   which is the same arc).
 * - Both radii 0 is a point: nothing is drawn (POI computes NaN points; LibreOffice adds the current point).
 * - One radius 0 is a flat ellipse, a segment: the angles convert as the limit of a thin ellipse, so a quarter
 *   turn from 0° ends at the segment's end (POI treats tan 90° as finite and turns back to the start).
 * - A negative radius draws nothing, as POI (Arc2D refuses a negative size).
 * - The start angle is reduced modulo 360° first, so a huge angle loses no precision in the sweep.
 * Bounded: at most 4 segments (12 points); a non-finite operand reads 0, so every number is finite.
 */

/** 60000ths of a degree per degree. */
const OOXML_DEGREE = 60000;
/** Java's `Math.toRadians` / `Math.toDegrees` factors (POI's arithmetic). */
const DEG_TO_RAD = 0.017453292519943295;
const RAD_TO_DEG = 57.29577951308232;
/** Arc2D's control-point factor for a quarter turn, btan(π/2). */
const QUARTER_CV = 0.5522847498307933;
/** The most cubic segments one arc becomes (a full turn), as GEOM_LIMITS.points counts it (12 points). */
export const ARC_MAX_SEGMENTS = 4;

/**
 * The parametric angle (degrees) of the point of an ellipse with radii rx, ry that lies in the direction θ
 * (degrees, clockwise) from its centre. POI's `convertOoxml2AwtAngle`, sign aside: θ is split into a multiple of
 * 180° and a remainder in (−90°, 90°), whose tangent is scaled by rx/ry. A multiple of 90° maps to itself.
 */
export function arcParamAngle(theta: number, rx: number, ry: number): number {
  if (theta % 90 === 0) return theta;
  const base = 180 * Math.round(theta / 180);
  const rest = (theta - base) * DEG_TO_RAD;
  return base + Math.atan2(rx * Math.sin(rest), ry * Math.cos(rest)) * RAD_TO_DEG;
}

/** Arc2D's `btan`: the control-point factor of a cubic segment spanning `increment` radians. */
function btan(increment: number): number {
  const half = increment / 2;
  return ((4 / 3) * Math.sin(half)) / (1 + Math.cos(half));
}

/**
 * Appends the cubic segments of an arcTo from the current point (x, y) to `out`, six numbers per segment (the two
 * control points and the end point), and returns how many (0 to ARC_MAX_SEGMENTS). The last end point is the
 * new current point; 0 segments leave it where it was. wR, hR, x and y are in one space (a path's own); stAng
 * and swAng are in 60000ths of a degree.
 */
export function arcToCubics(
  x: number,
  y: number,
  wR: number,
  hR: number,
  stAng: number,
  swAng: number,
  out: number[],
): number {
  const rx = Number.isFinite(wR) ? wR : 0;
  const ry = Number.isFinite(hR) ? hR : 0;
  if (rx < 0 || ry < 0 || (rx === 0 && ry === 0)) return 0;
  const st = Number.isFinite(stAng) ? (stAng / OOXML_DEGREE) % 360 : 0;
  const sw = Number.isFinite(swAng) ? Math.min(Math.max(swAng / OOXML_DEGREE, -360), 360) : 0;
  const px = Number.isFinite(x) ? x : 0;
  const py = Number.isFinite(y) ? y : 0;
  const t0 = arcParamAngle(st, rx, ry);
  const ext = arcParamAngle(st + sw, rx, ry) - t0;

  let segments: number;
  let increment: number;
  let cv: number;
  if (ext >= 360 || ext <= -360) {
    segments = ARC_MAX_SEGMENTS;
    increment = ext < 0 ? -Math.PI / 2 : Math.PI / 2;
    cv = ext < 0 ? -QUARTER_CV : QUARTER_CV;
  } else {
    segments = Math.ceil(Math.abs(ext) / 90);
    increment = (ext / segments) * DEG_TO_RAD;
    cv = btan(increment);
    if (cv === 0 || !Number.isFinite(cv)) segments = 0;
  }
  if (segments === 0) return 0;

  const start = t0 * DEG_TO_RAD;
  const cx = px - rx * Math.cos(start);
  const cy = py - ry * Math.sin(start);
  for (let i = 0; i < segments; i++) {
    let angle = start + increment * i;
    let relx = Math.cos(angle);
    let rely = Math.sin(angle);
    out.push(cx + (relx - cv * rely) * rx, cy + (rely + cv * relx) * ry);
    angle += increment;
    relx = Math.cos(angle);
    rely = Math.sin(angle);
    out.push(cx + (relx + cv * rely) * rx, cy + (rely - cv * relx) * ry, cx + relx * rx, cy + rely * ry);
  }
  return segments;
}
