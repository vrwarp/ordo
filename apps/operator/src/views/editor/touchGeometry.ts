import type { Box } from '@ordo/domain';

/**
 * Where the transformer's rotate handle goes on a touch screen (degrees around the box, 0 = above, as
 * Konva's rotateAnchorAngle). The stage clips anything outside the slide, so a handle `offset` screen px
 * above a box near the top edge could not be touched: it moves below the box, else to its right, else left.
 */
export function rotaterAngle(box: Box, scale: number, offset: number, slideW = 1920, slideH = 1080): number {
  const need = offset + 16;
  if (box.y * scale >= need) return 0;
  if ((slideH - (box.y + box.h)) * scale >= need) return 180;
  if ((slideW - (box.x + box.w)) * scale >= need) return 90;
  if (box.x * scale >= need) return 270;
  return 0;
}

/**
 * Where the floating object tools go on a touch screen (top-left, in the canvas pane's px): just above or
 * just below the selected box (its rotated bounds, the transformer's anchors and the rotate handle kept
 * clear), centred on it and kept inside the pane; when neither fits (a box filling the slide), at the
 * pane's top or bottom edge, whichever is farther from the box's centre.
 */
export function objectToolsSpot(
  box: Box,
  scale: number,
  stage: { x: number; y: number },
  pane: { w: number; h: number },
  bar: { w: number; h: number },
  rotater: { angle: number; reach: number },
  gap = 10,
): { x: number; y: number } {
  const rad = ((box.rotation ?? 0) * Math.PI) / 180;
  const hh = (Math.abs(box.w * Math.sin(rad)) + Math.abs(box.h * Math.cos(rad))) / 2;
  const cx = stage.x + (box.x + box.w / 2) * scale;
  const cy = stage.y + (box.y + box.h / 2) * scale;
  let top = cy - hh * scale - 24;
  let bottom = cy + hh * scale + 24;
  // The rotate handle sits `reach` px out on one side (angle 0 above, 180 below: touchGeometry rotaterAngle).
  if (rotater.angle === 0) top -= rotater.reach;
  if (rotater.angle === 180) bottom += rotater.reach;
  const x = Math.round(Math.min(Math.max(4, cx - bar.w / 2), Math.max(4, pane.w - bar.w - 4)));
  const above = top - gap - bar.h;
  if (above >= 4) return { x, y: Math.round(above) };
  const below = bottom + gap;
  if (below + bar.h <= pane.h - 4) return { x, y: Math.round(below) };
  return { x, y: cy > pane.h / 2 ? 4 : Math.round(Math.max(4, pane.h - bar.h - 4)) };
}
