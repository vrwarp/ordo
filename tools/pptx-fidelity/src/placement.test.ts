import { describe, expect, it } from 'vitest';
import { colourBoxes, edgeDelta, PLACEMENT_COLOURS, rgbOf } from './placement.ts';

describe('placement check', () => {
  it('finds each colour box and ignores pixels of other colours and faint edges', () => {
    const w = 20;
    const h = 10;
    const px = new Uint8Array(w * h * 3).fill(255);
    const paint = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px.set(c, (y * w + x) * 3);
    };
    paint(2, 1, 5, 3, [255, 0, 0]);
    paint(6, 1, 6, 3, [255, 160, 160]); // a faint anti-aliased edge: not red
    paint(10, 4, 18, 8, [0, 0, 250]);
    const [red, blue, green] = colourBoxes(px, w, h, 3, [rgbOf('FF0000'), rgbOf('0000FF'), rgbOf('00C000')]);
    expect(red).toEqual({ x0: 2, y0: 1, x1: 5, y1: 3 });
    expect(blue).toEqual({ x0: 10, y0: 4, x1: 18, y1: 8 });
    expect(green).toBeUndefined();
  });

  it('measures edges as pixel boundaries, scaling the reference', () => {
    const a = { x0: 10, y0: 10, x1: 19, y1: 19 };
    expect(edgeDelta(a, { x0: 11, y0: 10, x1: 19, y1: 21 })).toBe(2);
    // 20 px at scale 2 are 40 px.
    expect(edgeDelta(a, { x0: 20, y0: 20, x1: 39, y1: 39 }, 2)).toBe(0);
  });

  it('gives every box its own colour', () => {
    const hex = Object.values(PLACEMENT_COLOURS);
    expect(new Set(hex).size).toBe(hex.length);
  });
});
