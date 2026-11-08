import { describe, expect, it } from 'vitest';
import { keepSet, keptBytes, mayPrune, rememberManifest } from './cache-policy.ts';

const DAY = 86_400_000;
const f = (hash: string, bytes = 100) => ({ hash, bytes });

describe('service cache keep policy (review item 8)', () => {
  it('never prunes on an idle manifest or after a partial fill', () => {
    expect(mayPrune(false, 0)).toBe(false);
    expect(mayPrune(true, 1)).toBe(false);
    expect(mayPrune(true, 0)).toBe(true);
  });

  it('keeps the current manifest and every remembered one', () => {
    const sunday = rememberManifest([], 'a,b,c', [f('a'), f('b'), f('c')], 0);
    const keep = keepSet([f('x'), f('a')], sunday);
    expect([...keep].sort()).toEqual(['a', 'b', 'c', 'x']);
  });

  it('End service then Go live again re-downloads nothing: the previous manifest stays kept', () => {
    // Live service filled a, b, c.
    let recent = rememberManifest([], 'a,b,c', [f('a'), f('b'), f('c')], 1000);
    // End service: idle manifest is fonts + logo only; the policy says do not prune (mayPrune false),
    // and even a prune against the keep set would keep the service files.
    const idle = [f('font'), f('logo')];
    expect(mayPrune(false, 0)).toBe(false);
    expect(keepSet(idle, recent).has('c')).toBe(true);
    // Next Go live with the same playlist: remembered once, newest time.
    recent = rememberManifest(recent, 'a,b,c', [f('a'), f('b'), f('c')], 5000);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.at).toBe(5000);
  });

  it('remembers newest first, drops entries past the age limit', () => {
    let recent = rememberManifest([], 'old', [f('o')], 0);
    recent = rememberManifest(recent, 'mid', [f('m')], 10 * DAY);
    recent = rememberManifest(recent, 'new', [f('n')], 20 * DAY);
    expect(recent.map((r) => r.sig)).toEqual(['new', 'mid']);
    expect(keepSet([], recent).has('o')).toBe(false);
  });

  it('stops keeping older manifests once the unique bytes exceed the budget', () => {
    let recent = rememberManifest([], 'a', [f('a', 400)], 1, { budgetBytes: 1000 });
    recent = rememberManifest(recent, 'b', [f('b', 400), f('a', 400)], 2, { budgetBytes: 1000 });
    // a is shared: 800 unique bytes, both kept.
    expect(recent.map((r) => r.sig)).toEqual(['b', 'a']);
    recent = rememberManifest(recent, 'c', [f('c', 500)], 3, { budgetBytes: 1000 });
    // c (500) + b (400 + 400 shared a = 800 extra) would exceed 1000: only c stays.
    expect(recent.map((r) => r.sig)).toEqual(['c']);
    expect(keptBytes(recent)).toBe(500);
  });

  it('bounds the number of remembered manifests', () => {
    let recent: ReturnType<typeof rememberManifest> = [];
    for (let i = 0; i < 20; i++)
      recent = rememberManifest(recent, `m${i}`, [f(`h${i}`)], i, { maxEntries: 3 });
    expect(recent.map((r) => r.sig)).toEqual(['m19', 'm18', 'm17']);
  });
});
