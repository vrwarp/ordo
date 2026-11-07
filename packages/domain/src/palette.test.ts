import { describe, expect, it } from 'vitest';
import { canonicalJson, Palette, paletteIndex } from './palette.ts';

/** The one palette helper of tables, charts and decorations (design/27 M9). */
describe('palette', () => {
  it('canonicalJson sorts keys and leaves out what JSON leaves out', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[1,null]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([Number.NaN, Number.POSITIVE_INFINITY, -0, () => 1])).toBe('[null,null,0,null]');
    expect(canonicalJson('__proto__')).toBe('"__proto__"');
    expect(canonicalJson({ __proto__: 1, constructor: 2 } as unknown)).toBe('{"constructor":2}');
  });

  it('never throws on deep or cyclic values', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(canonicalJson(cyclic)).toContain('"a":1');
    let deep: unknown = 1;
    for (let i = 0; i < 10_000; i++) deep = [deep];
    expect(canonicalJson(deep).length).toBeLessThan(100);
  });

  it('gives equal values one entry, up to its size', () => {
    const p = new Palette<{ color: string; w?: number }>(2);
    expect(p.add({ color: 'red', w: 1 })).toBe(0);
    expect(p.add({ w: 1, color: 'red' })).toBe(0);
    expect(p.add({ color: 'blue' })).toBe(1);
    expect(p.add({ color: 'green' })).toBeUndefined();
    expect(p.indexOf({ color: 'blue' })).toBe(1);
    expect(p.indexOf({ color: 'green' })).toBeUndefined();
    expect(p.entries).toEqual([{ color: 'red', w: 1 }, { color: 'blue' }]);
    expect(p.size).toBe(2);
  });

  it('paletteIndex keeps an index only when it names an entry', () => {
    expect(paletteIndex(0, 3)).toBe(0);
    expect(paletteIndex(2, 3)).toBe(2);
    for (const bad of [3, -1, 1.5, Number.NaN, '1', null, undefined])
      expect(paletteIndex(bad, 3)).toBeUndefined();
    expect(paletteIndex(0, 0)).toBeUndefined();
  });
});
