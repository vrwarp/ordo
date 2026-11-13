import { type Box, LOGICAL_HEIGHT, LOGICAL_WIDTH, type Presentation, type SlideObject } from '@ordo/domain';
import { deckArea, type SlideRect } from './CanvasGuides.tsx';
import { markOverride, updateSlide } from './ops.ts';
import { groupBox, transformGroup, transformMember } from './ops/group.ts';

/*
 * 'Align to slide' and 'Screen placement' (the Object panel; design/15 "Object panel"): both act on the whole
 * selection as one block, as the box fields and the canvas's Transformer do, so a PowerPoint shape with its
 * text or a table's cells never come apart. The block is the selection's bounds as drawn (`groupBox`: each
 * member turned about its centre), so a turned box aligns by what the screens show, and keeps its turn. The
 * slide is the deck's own area on a 4:3 deck (`source.native.slideRect`, the canvas's guide), else the
 * 1920x1080 frame.
 */

/** The full frame. */
export const FRAME: SlideRect = { x: 0, y: 0, w: LOGICAL_WIDTH, h: LOGICAL_HEIGHT };

/** Where align and placement put things: a 4:3 deck's area (`slideRect`), else the frame. */
export function placementArea(p: Pick<Presentation, 'source'> | undefined): SlideRect {
  return deckArea(p?.source?.native?.slideRect) ?? FRAME;
}

export type AlignTo = 'left' | 'cx' | 'right' | 'top' | 'cy' | 'bottom';

/**
 * The block `from` (a group box, unrotated) aligned to `to` in `area`: a move only. Edges land exactly on
 * the area's; a centred block lands on a whole pixel.
 */
export function alignedBox(from: Box, area: SlideRect, to: AlignTo): Box {
  switch (to) {
    case 'left':
      return { ...from, x: area.x };
    case 'cx':
      return { ...from, x: Math.round(area.x + (area.w - from.w) / 2) };
    case 'right':
      return { ...from, x: area.x + area.w - from.w };
    case 'top':
      return { ...from, y: area.y };
    case 'cy':
      return { ...from, y: Math.round(area.y + (area.h - from.h) / 2) };
    case 'bottom':
      return { ...from, y: area.y + area.h - from.h };
  }
}

/**
 * A placement preset, written for the 1920x1080 frame, in `area`: scaled from the frame into it (a 4:3
 * deck's Lower Third sits at the bottom of its own area, not across the bars).
 */
export function presetIn(preset: Box, area: SlideRect): Box {
  const sx = area.w / LOGICAL_WIDTH;
  const sy = area.h / LOGICAL_HEIGHT;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    x: r(area.x + preset.x * sx),
    y: r(area.y + preset.y * sy),
    w: r(preset.w * sx),
    h: r(preset.h * sy),
    rotation: 0,
  };
}

/** Whether the block `b` is (about) at `preset` (the active placement card). */
export function nearBox(b: Box | undefined, preset: Box): boolean {
  return (
    !!b &&
    Math.abs(b.x - preset.x) < 20 &&
    Math.abs(b.y - preset.y) < 20 &&
    Math.abs(b.w - preset.w) < 30 &&
    Math.abs(b.h - preset.h) < 30
  );
}

/**
 * `ids` of slide `slideId` placed as one block: their group box moved and scaled to `target(groupBox)`
 * (`transformGroup`: centres follow, sizes scale along each member's own axes, turns kept; a locked picture
 * keeps its aspect). One object goes the same way (its own bounds are its block), so a turned text box
 * keeps its turn. When `lyricId` is placed on a themed presentation, the slide marks its `box` theme
 * override, as the box fields do. `p` itself when nothing moves.
 */
export function placeObjects(
  p: Presentation,
  slideId: string,
  objects: readonly SlideObject[],
  target: (from: Box) => Box,
  lyricId?: string,
): Presentation {
  const from = groupBox(objects);
  if (!from) return p;
  const to = target(from);
  const ids = objects.map((o) => o.id);
  let q =
    objects.length === 1
      ? updateSlideObject(p, slideId, objects[0]!, transformMember(objects[0]!, from, to))
      : transformGroup(p, slideId, ids, from, to);
  if (q !== p && p.themeId && lyricId && ids.includes(lyricId))
    q = updateSlide(q, slideId, (s) => markOverride(s, 'box'));
  return q;
}

function updateSlideObject(p: Presentation, slideId: string, o: SlideObject, box: Box): Presentation {
  const b = o.box;
  const same =
    b.x === box.x &&
    b.y === box.y &&
    b.w === box.w &&
    b.h === box.h &&
    (b.rotation ?? 0) === (box.rotation ?? 0);
  if (same) return p;
  return updateSlide(p, slideId, (s) => ({
    ...s,
    objects: s.objects.map((x) => (x.id === o.id ? ({ ...x, box } as SlideObject) : x)),
  }));
}
