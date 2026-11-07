/**
 * The longest single object of a slide's draw (`maxObjectMs`, design/27 §13's 50 ms task): `native-page.ts`
 * draws the slide's objects one at a time and times each draw with its flush, since Chromium records canvas
 * commands and only rasterizes them on a read. Kept apart from the page so it can be tested in Node.
 */

export type ObjectTimes = {
  /** Each item's time (draw and flush), in ms, in drawing order. */
  ms: number[];
  /** The largest of them (0 for none). */
  max: number;
  /** The index of the largest (-1 for none). */
  at: number;
};

/** Draw each item, flush, and time the two together with `now`. */
export function timeEach<T>(
  items: readonly T[],
  draw: (item: T) => void,
  flush: () => void,
  now: () => number,
): ObjectTimes {
  const ms: number[] = [];
  let max = 0;
  let at = -1;
  for (const item of items) {
    const t0 = now();
    draw(item);
    flush();
    const t = Math.max(0, now() - t0);
    if (at < 0 || t > max) {
      max = t;
      at = ms.length;
    }
    ms.push(t);
  }
  return { ms, max, at };
}
