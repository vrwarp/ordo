import {
  DEFAULT_LYRIC_STYLE,
  type ImageObject,
  type ShapeObject,
  type Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';

/*
 * Crowded slides for the underlay frame's tests, the bench and the e2e deck (design 29 R1): squares and text boxes
 * on a grid, pictures of chosen sizes. Not shipped: vitest only runs *.test.ts files.
 */

/** A seeded generator (mulberry32), so a fuzz case is the same on every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A coloured square of the 20 x 17 grid, its own colour (units are keyed by what they draw). */
export function square(i: number, extra: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id: `sq${i}`,
    type: 'shape',
    box: { x: 20 + (i % 20) * 90, y: 20 + Math.floor(i / 20) * 60, w: 80, h: 50, rotation: 0 },
    shape: 'rect',
    fill: { r: i % 256, g: (i * 7) % 256, b: (i * 13) % 256, a: 1 },
    opacity: 1,
    radius: 0,
    ...extra,
  };
}

/** A text box. */
export function textBox(id: string, text: string, x = 100, y = 400, w = 1720, h = 200): TextObject {
  return {
    id,
    type: 'text',
    box: { x, y, w, h, rotation: 0 },
    text,
    style: DEFAULT_LYRIC_STYLE,
    opacity: 1,
  };
}

/** A picture of `mediaId` in a box. */
export function picture(
  id: string,
  mediaId: string,
  box: { x: number; y: number; w: number; h: number },
  extra: Partial<ImageObject> = {},
): ImageObject {
  return {
    id,
    type: 'image',
    box: { ...box, rotation: 0 },
    mediaId,
    fit: 'cover',
    opacity: 1,
    radius: 0,
    ...extra,
  };
}

/** A slide of `objects`. */
export const slideOf = (objects: SlideObject[], id = 'crowded'): Slide => ({ id, objects });

/** `n` squares, bottom first. */
export const squares = (n: number): ShapeObject[] => Array.from({ length: n }, (_, i) => square(i));

/** `n` text boxes of their own text. */
export const texts = (n: number): TextObject[] =>
  Array.from({ length: n }, (_, i) =>
    textBox(`tx${i}`, `Line ${i}`, 20 + (i % 10) * 180, 20 + Math.floor(i / 10) * 40, 170, 36),
  );
