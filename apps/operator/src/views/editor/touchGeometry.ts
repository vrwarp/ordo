import type { Box } from '@ordo/domain';

/**
 * Where the transformer's rotate handle goes on a touch screen (degrees around the box, 0 = above, as
 * Konva's rotateAnchorAngle). The stage clips anything outside the slide, so a handle `offset` screen px
 * above a box near the top edge could not be touched: it moves below the box, else to its right, else left.
 */
export function rotaterAngle(box: Box, scale: number, offset: number, slideW = 1920, slideH = 1080): number {
  // Konva puts the handle `offset` px past the box edge along the chosen direction, in the box's own
  // (rotated) frame: work out where each candidate lands on screen and take the first one on the slide.
  const margin = 16;
  const cx = (box.x + box.w / 2) * scale;
  const cy = (box.y + box.h / 2) * scale;
  const rot = ((box.rotation ?? 0) * Math.PI) / 180;
  for (const a of [0, 180, 90, 270]) {
    const rad = (a * Math.PI) / 180;
    const edge = (a % 180 === 0 ? box.h / 2 : box.w / 2) * scale;
    const lx = Math.sin(rad) * (edge + offset);
    const ly = -Math.cos(rad) * (edge + offset);
    const sx = cx + lx * Math.cos(rot) - ly * Math.sin(rot);
    const sy = cy + lx * Math.sin(rot) + ly * Math.cos(rot);
    if (sx >= margin && sx <= slideW * scale - margin && sy >= margin && sy <= slideH * scale - margin) {
      return a;
    }
  }
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

/**
 * Where the desktop/canvas-first contextual formatting bar goes (top-left, in `.canvasbox` px):
 * 1. Preferred: tethered directly above the selected box (and its Konva rotate handle when rotatable),
 *    horizontally centered on the box and clamped cleanly inside the stage/pane.
 * 2. Near-top compact/upper object (`above < 4` and rotated bottom <= 72% of slide height): tethered
 *    cleanly below the selected box (`8px` past its bottom resize anchors).
 * 3. Tall / full-slide frame (`above < 4` and spanning into the lower slide): docked cleanly inside the
 *    top edge of the frame (`max(8, boxTop + 14)`) so resize/rotate handles stay clear and the bar never
 *    floats disconnected at the bottom of the viewport (or `6px` in the top bezel during inline text edit).
 */
export function floatingBarSpot(
  box: Box,
  scale: number,
  stage: { x: number; y: number; w?: number; h?: number },
  pane: { w: number; h: number },
  bar: { w: number; h: number },
  opts?: {
    hasRotateHandle?: boolean;
    rotateOffset?: number;
    avoidInsideTop?: boolean;
    avoidTopRight?: { w: number; h: number };
  },
): { x: number; y: number } {
  const stageW = stage.w ?? 1920 * scale;
  const stageH = stage.h ?? 1080 * scale;
  const hasRotate = opts?.hasRotateHandle ?? true;
  const rotateOffset = opts?.rotateOffset ?? 50;

  const rad = ((box.rotation ?? 0) * Math.PI) / 180;
  const hh = (Math.abs(box.w * Math.sin(rad)) + Math.abs(box.h * Math.cos(rad))) / 2;
  const cx = stage.x + (box.x + box.w / 2) * scale;
  const cy = stage.y + (box.y + box.h / 2) * scale;
  const boxTop = cy - hh * scale;
  const boxBottom = cy + hh * scale;

  // Desktop Konva resize anchors are 10x10 (5px overhang); rotate handle sits `rotateOffset` out from top edge.
  const handleY = cy - ((box.h / 2) * scale + rotateOffset) * Math.cos(rad);
  const anchorTop = hasRotate ? Math.min(boxTop - 6, handleY - 6) : boxTop - 6;
  const anchorBottom = hasRotate ? Math.max(boxBottom + 6, handleY + 6) : boxBottom + 6;

  // Determine vertical tier first so horizontal clamping can respect any open top-right floating panel.
  let y: number;
  const above = anchorTop - 6 - bar.h;
  const below = anchorBottom + 8;
  const relBottom = stageH > 0 ? (boxBottom - stage.y) / stageH : 1;
  if (above >= 2) {
    // 1. Tethered cleanly above the object & its rotate handle.
    y = Math.round(above);
  } else if (relBottom <= 0.72 && below + bar.h <= pane.h - 6) {
    // 2. Near-top compact/upper object: tether right below the object.
    y = Math.round(below);
  } else if (opts?.avoidInsideTop) {
    // 3a. Inline-editing a full-height text box: keep in the top bezel.
    y = 6;
  } else {
    // 3b. Tall / full-slide frame: dock cleanly inside the top edge, clear of resize & rotate handles.
    let dockY = Math.max(8, Math.round(boxTop + 14));
    if (hasRotate && handleY >= dockY - 6 && handleY <= dockY + bar.h + 6) {
      dockY = Math.round(handleY + 10);
    }
    y = Math.min(dockY, Math.max(8, pane.h - bar.h - 8));
  }

  // Horizontal position: centered on the object, clamped inside stage/pane and clear of any top-right dialog.
  const minX = stageW >= bar.w + 16 ? Math.max(8, stage.x + 8) : 8;
  let maxX =
    stageW >= bar.w + 16
      ? Math.max(minX, Math.min(pane.w - bar.w - 8, stage.x + stageW - bar.w - 8))
      : Math.max(8, pane.w - bar.w - 8);
  if (opts?.avoidTopRight && y < opts.avoidTopRight.h) {
    maxX = Math.max(minX, Math.min(maxX, pane.w - opts.avoidTopRight.w - bar.w - 12));
  }
  const x = Math.round(Math.min(Math.max(minX, cx - bar.w / 2), maxX));
  // Whatever the tier, the bar stays in the pane (an object dragged partly off the slide, a pane shorter
  // than the bar's rows): `bar` is its measured size, which styles.css caps at the pane's width less 16 px.
  y = Math.round(Math.min(Math.max(2, y), Math.max(2, pane.h - bar.h - 2)));

  return { x, y };
}
