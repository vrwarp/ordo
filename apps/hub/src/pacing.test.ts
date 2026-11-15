import { describe, expect, it } from 'vitest';
import { JobPacing, MAX_TIMER_MS, PACE_EXEMPT } from './pacing.ts';

const heavy = (paced = false, kind = 'media') => ({ kind, class: 'heavy' as const, paced });
const light = (paced = false) => ({ kind: 'media', class: 'light' as const, paced });

describe('JobPacing (design/28 §5.3)', () => {
  it('holds heavy jobs while live and for the grace after End service, with Phones on', () => {
    let t = 1000;
    const p = new JobPacing({ graceMs: 200, enabled: true, now: () => t });
    expect(p.held(heavy())).toBe(false);
    p.onMode('live');
    expect(p.holding()).toBe(true);
    expect(p.held(heavy())).toBe(true);
    expect(p.held(light())).toBe(false);
    t = 5000;
    p.onMode('idle');
    expect(p.held(heavy())).toBe(true);
    expect(p.wakeAt()).toBe(5200);
    t = 5199;
    expect(p.held(heavy())).toBe(true);
    t = 5200;
    expect(p.held(heavy())).toBe(false);
    expect(p.wakeAt()).toBeUndefined();
  });

  it('with Phones off holds only jobs queued during a capped request', () => {
    const p = new JobPacing({ graceMs: 200, now: () => 0 });
    p.onMode('live');
    expect(p.held(heavy(false))).toBe(false);
    expect(p.held(heavy(true))).toBe(true);
    expect(p.held(light(true))).toBe(false);
    p.setEnabled(true);
    expect(p.held(heavy(false))).toBe(true);
  });

  it('never holds an exempt kind (none in P0)', () => {
    expect(PACE_EXEMPT.size).toBe(0);
    const p = new JobPacing({ graceMs: 200, enabled: true, now: () => 0, exempt: new Set(['bake']) });
    p.onMode('live');
    expect(p.held(heavy(true, 'bake'))).toBe(false);
    expect(p.held(heavy(true, 'media'))).toBe(true);
    expect(p.exemptKinds()).toEqual(['bake']);
  });

  it('wakes no timer while live, and never further than Node keeps a timer', () => {
    let t = 0;
    const p = new JobPacing({ graceMs: Number.MAX_SAFE_INTEGER, enabled: true, now: () => t });
    p.onMode('live');
    expect(p.wakeAt()).toBeUndefined();
    t = 10;
    p.onMode('idle');
    const w = p.wakeAt()!;
    expect(Number.isFinite(w)).toBe(true);
    expect(w - t).toBeLessThanOrEqual(MAX_TIMER_MS);
    const never = new JobPacing({ graceMs: 100, now: () => 0 });
    expect(never.wakeAt()).toBeUndefined();
  });

  it('a restart into a live service holds at once; idle at start holds nothing', () => {
    const p = new JobPacing({ graceMs: 200, enabled: true, now: () => 0 });
    expect(p.holding()).toBe(false);
    p.onMode('idle');
    expect(p.holding()).toBe(false);
    p.onMode('live');
    expect(p.holding()).toBe(true);
  });

  it('niceness 19 and one thread for light tools only while live with Phones on', () => {
    const p = new JobPacing({ graceMs: 200, now: () => 0 });
    expect([p.childNice(), p.lightThreads()]).toEqual([0, undefined]);
    p.onMode('live');
    expect([p.childNice(), p.lightThreads()]).toEqual([0, undefined]);
    p.setEnabled(true);
    expect([p.childNice(), p.lightThreads()]).toEqual([19, 1]);
    p.onMode('idle');
    expect([p.childNice(), p.lightThreads()]).toEqual([0, undefined]);
  });
});
