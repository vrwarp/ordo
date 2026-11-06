import { type Box, LOGICAL_HEIGHT, LOGICAL_WIDTH, type SlideObject } from '@ordo/domain';
import { Group, Rect } from 'react-konva';
import { type FitProbe, overflowingText } from './textFit.ts';

/** The deck's area in the 1920x1080 frame (`Presentation.source.native.slideRect`). */
export type SlideRect = { x: number; y: number; w: number; h: number };

/** The overflow indicator's colour: the design system's red (`.banner.red`'s border). */
export const OVERFLOW_STROKE = '#ef4444';
/** The shade over the bars outside a 4:3 deck's area. */
export const BAR_SHADE = 'rgba(0, 0, 0, 0.45)';
/** The outline of a 4:3 deck's area. */
export const FRAME_STROKE = 'rgba(255, 255, 255, 0.7)';

/** What the guides draw, in logical px (`guideMarks`). */
export type GuideMarks = {
  /** The text boxes whose text does not fit (their boxes, rotation included). */
  overflow: { id: string; box: Box }[];
  /** The deck's area, outlined; absent for a 16:9 deck (or none known). */
  frame?: SlideRect;
  /** The bars of the 1920x1080 frame outside `frame`, shaded. */
  bars: SlideRect[];
};

/** Logical px within which a slide rect counts as the whole frame. */
const FULL_TOLERANCE = 0.5;

/**
 * The deck's area kept inside the frame, or undefined when there is none to show: no rect, a degenerate
 * or non-finite one, or one that covers the whole 1920x1080 frame (a 16:9 deck).
 */
export function deckArea(r: SlideRect | undefined): SlideRect | undefined {
  if (!r) return undefined;
  const ok = [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v));
  if (!ok) return undefined;
  const x = Math.max(0, Math.min(LOGICAL_WIDTH, r.x));
  const y = Math.max(0, Math.min(LOGICAL_HEIGHT, r.y));
  const w = Math.max(0, Math.min(LOGICAL_WIDTH, r.x + r.w) - x);
  const h = Math.max(0, Math.min(LOGICAL_HEIGHT, r.y + r.h) - y);
  if (w < 1 || h < 1) return undefined;
  const full =
    x <= FULL_TOLERANCE &&
    y <= FULL_TOLERANCE &&
    w >= LOGICAL_WIDTH - FULL_TOLERANCE * 2 &&
    h >= LOGICAL_HEIGHT - FULL_TOLERANCE * 2;
  return full ? undefined : { x, y, w, h };
}

/** The parts of the frame outside `a`: left, right (full height), top and bottom (as wide as `a`). */
export function barsOutside(a: SlideRect): SlideRect[] {
  const bars: SlideRect[] = [];
  const right = a.x + a.w;
  const bottom = a.y + a.h;
  if (a.x > FULL_TOLERANCE) bars.push({ x: 0, y: 0, w: a.x, h: LOGICAL_HEIGHT });
  if (LOGICAL_WIDTH - right > FULL_TOLERANCE)
    bars.push({ x: right, y: 0, w: LOGICAL_WIDTH - right, h: LOGICAL_HEIGHT });
  if (a.y > FULL_TOLERANCE) bars.push({ x: a.x, y: 0, w: a.w, h: a.y });
  if (LOGICAL_HEIGHT - bottom > FULL_TOLERANCE)
    bars.push({ x: a.x, y: bottom, w: a.w, h: LOGICAL_HEIGHT - bottom });
  return bars;
}

/** What the guides draw over `objects` (the objects the canvas draws) for a deck of area `slideRect`. */
export function guideMarks(
  objects: readonly SlideObject[],
  slideRect?: SlideRect,
  probe?: FitProbe,
): GuideMarks {
  const frame = deckArea(slideRect);
  return {
    overflow: overflowingText(objects, probe).map((o) => ({ id: o.id, box: o.box })),
    frame,
    bars: frame ? barsOutside(frame) : [],
  };
}

/**
 * Guides the slide canvas draws over the objects (M4 item C; design/27 §11 item 4, §15 M4), inside its
 * scaled object layer, listening to nothing:
 * - the overflow indicator: a dashed red edge on every text box whose text does not fit (the rich engine's
 *   `layoutRich(...).overflow`, laid out as the drawers lay it out: `textFit.ts`; shrink-to-fit boxes
 *   overflow only past the engine's smallest fit). The Object panel says "Text does not fit: turn on
 *   Shrink text to fit or enlarge the box" for the selected one (`fitMessage`), which is what a screen
 *   reader gets: the edge is a picture only;
 * - the 4:3 slide-rect guide: for a deck that is not 16:9, the deck's area (`slideRect`) outlined and the
 *   bars outside it shaded, so a volunteer keeps text inside what PowerPoint showed.
 * Draws nothing (null) when there is nothing to show. Line widths stay 1.5-2 screen px at any zoom.
 */
export function CanvasGuides(props: {
  objects: readonly SlideObject[];
  slideRect?: SlideRect;
  /** Screen px per logical px (line widths stay 1-2 screen px). */
  scale: number;
}) {
  const g = guideMarks(props.objects, props.slideRect);
  if (!g.overflow.length && !g.frame) return null;
  const px = Number.isFinite(props.scale) && props.scale > 0 ? 1 / props.scale : 1;
  return (
    <Group name="canvas-guides" listening={false}>
      {g.bars.map((b) => (
        <Rect
          key={`bar${b.x},${b.y}`}
          name="deck-bar"
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          fill={BAR_SHADE}
          listening={false}
        />
      ))}
      {g.frame && (
        <Rect
          name="deck-area"
          x={g.frame.x}
          y={g.frame.y}
          width={g.frame.w}
          height={g.frame.h}
          stroke={FRAME_STROKE}
          strokeWidth={1.5 * px}
          dash={[10 * px, 6 * px]}
          listening={false}
        />
      )}
      {g.overflow.map(({ id, box }) => (
        <Rect
          key={id}
          name="text-overflow"
          x={box.x + box.w / 2}
          y={box.y + box.h / 2}
          width={box.w}
          height={box.h}
          offsetX={box.w / 2}
          offsetY={box.h / 2}
          rotation={box.rotation ?? 0}
          stroke={OVERFLOW_STROKE}
          strokeWidth={2 * px}
          dash={[8 * px, 5 * px]}
          listening={false}
        />
      ))}
    </Group>
  );
}
