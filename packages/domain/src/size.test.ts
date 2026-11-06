import { describe, expect, it } from 'vitest';
import { jsonBytes, planImportSizes, SIZE_BUDGETS, slideBytes, utf8Bytes } from './size.ts';

describe('size estimates (design/27 §3.4)', () => {
  it('counts UTF-8 bytes of the JSON a socket carries', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('ש')).toBe(2);
    expect(utf8Bytes('漢')).toBe(3);
    expect(utf8Bytes('😀')).toBe(4);
    for (const v of [{ t: 'Amazing grace 😀 ש 漢' }, [1, 'x', null], 'lone \ud800 surrogate'])
      expect(jsonBytes(v)).toBe(new TextEncoder().encode(JSON.stringify(v)).length);
    expect(jsonBytes(undefined)).toBe(0);
    expect(slideBytes({ id: 's', objects: [] })).toBe('{"id":"s","objects":[]}'.length);
  });

  it('keeps a 2,000-slide import within 4 MiB, the tail compact', () => {
    const sizes = Array.from({ length: 2000 }, () => 6 * 1024);
    const plan = planImportSizes(sizes);
    expect(plan.total).toBeLessThanOrEqual(SIZE_BUDGETS.presentationMax);
    expect(plan.compact[0]).toBe(false);
    expect(plan.compact.at(-1)).toBe(true);
    const firstCompact = plan.compact.indexOf(true);
    expect(plan.compact.slice(firstCompact).every(Boolean)).toBe(true);
  });

  it('makes a slide over the hard budget compact on its own', () => {
    const plan = planImportSizes([3000, SIZE_BUDGETS.slideMax + 1, 3000, Number.NaN]);
    expect(plan.compact).toEqual([false, true, false, false]);
  });
});
