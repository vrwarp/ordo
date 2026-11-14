import { describe, expect, it } from 'vitest';
import { timeEach } from './objecttime.ts';

describe('timeEach', () => {
  it('maxObjectMs is the largest single drawObject time', () => {
    // A clock that the draws and flushes move: object b costs 7 + 1 ms, the others less.
    let clock = 100;
    const cost: Record<string, number> = { a: 2, b: 7, c: 5 };
    const drawn: string[] = [];
    const t = timeEach(
      ['a', 'b', 'c'],
      (o) => {
        drawn.push(o);
        clock += cost[o]!;
      },
      () => {
        clock += 1;
      },
      () => clock,
    );
    expect(drawn).toEqual(['a', 'b', 'c']);
    expect(t.ms).toEqual([3, 8, 6]);
    expect(t.max).toBe(8);
    expect(t.at).toBe(1);
  });

  it('gives 0 and no index for a slide without objects, and the first of equal times', () => {
    expect(
      timeEach(
        [],
        () => {},
        () => {},
        () => 0,
      ),
    ).toEqual({ ms: [], max: 0, at: -1 });
    let clock = 0;
    const t = timeEach(
      [1, 1],
      () => (clock += 1),
      () => {},
      () => clock,
    );
    expect(t).toEqual({ ms: [1, 1], max: 1, at: 0 });
  });
});
