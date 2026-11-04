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
