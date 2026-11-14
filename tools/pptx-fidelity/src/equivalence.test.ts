import { describe, expect, it } from 'vitest';
import { comparable, diffJson } from './equivalence.ts';

describe('hub-vs-client equivalence', () => {
  const files = new Map([
    ['m1', 'aaa'],
    ['m2', 'aaa'],
    ['m3', 'bbb'],
  ]);
  const of = (id: string) => files.get(id);
  const deck = (ids: [string, string, string], media: string, extra: Record<string, unknown> = {}) => ({
    id: ids[0],
    rev: 1,
    createdAt: 'now',
    source: { kind: 'pptx', log: 'parsed somewhere' },
    arrangements: [{ id: ids[2], sectionIds: [ids[1]] }],
    sections: [{ id: ids[1], slides: [{ id: 'x', objects: [{ id: 'o', type: 'image', mediaId: media }] }] }],
    ...extra,
  });

  it('takes out ids, media ids (by their file), times, revisions and the log', () => {
    const a = comparable(deck(['p1', 's1', 'a1'], 'm1'), of);
    const b = comparable({ ...deck(['p2', 's2', 'a2'], 'm2'), rev: 7, createdAt: 'later' }, of);
    expect(diffJson(a, b)).toEqual([]);
  });

  it('lists every other difference by its path', () => {
    const a = comparable(deck(['p1', 's1', 'a1'], 'm1', { title: 'A' }), of);
    const b = comparable(deck(['p2', 's2', 'a2'], 'm3', { title: 'B' }), of);
    expect(diffJson(a, b)).toEqual([
      { path: '$.sections[0].slides[0].objects[0].mediaId', hub: '"file:aaa"', client: '"file:bbb"' },
      { path: '$.title', hub: '"A"', client: '"B"' },
    ]);
    expect(diffJson([1, 2], [1], 10)).toEqual([{ path: '$.length', hub: '2', client: '1' }]);
  });
});
