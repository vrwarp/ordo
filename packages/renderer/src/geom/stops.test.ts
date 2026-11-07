import { describe, expect, it } from 'vitest';
import { drawnStops, stopAt } from './stops.ts';

/** The stops a gradient is drawn with (M6 merge review): sorted, end stops repeating a neighbour's colour dropped. */

const c = (r: number, a = 1) => ({ r, g: 0, b: 0, a });

describe('drawnStops', () => {
  it("drops end stops whose neighbour repeats their colour: a decoration's held centre and edge", () => {
    // PowerPoint's radial decoration: the centre colour from 0 to 15 %, the edge colour from 97 to 100 %.
    const stops = [
      { at: 0, color: c(78) },
      { at: 0.15, color: c(78) },
      { at: 0.97, color: c(0) },
      { at: 1, color: c(0) },
    ];
    expect(drawnStops(stops)).toEqual(stops.slice(1, 3));
    // Equal colours in the middle are kept (they bound a band of their own), and two are always kept.
    const mid = [
      { at: 0, color: c(10) },
      { at: 0.4, color: c(200) },
      { at: 0.6, color: c(200) },
      { at: 1, color: c(10) },
    ];
    expect(drawnStops(mid)).toBe(mid);
    const flat = [
      { at: 0, color: c(5) },
      { at: 0.5, color: c(5) },
      { at: 1, color: c(5) },
    ];
    expect(drawnStops(flat)).toEqual(flat.slice(1));
    // A colour that differs in alpha only is another colour.
    const alpha = [
      { at: 0, color: c(5, 0.5) },
      { at: 0.5, color: c(5) },
      { at: 1, color: c(9) },
    ];
    expect(drawnStops(alpha)).toBe(alpha);
  });

  it('sorts by position as the clamp does, stably, and reads a position as the clamp reads it', () => {
    const a = { at: 0.8, color: c(1) };
    const b = { at: 0.2, color: c(2) };
    const d = { at: 0.2, color: c(3) };
    expect(drawnStops([a, b, d])).toEqual([b, d, a]);
    expect(stopAt({ at: Number.NaN })).toBe(0);
    expect(stopAt({ at: 4 })).toBe(1);
    expect(stopAt(undefined)).toBe(0);
  });
});
