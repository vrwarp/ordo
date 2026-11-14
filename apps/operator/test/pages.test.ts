/**
 * The page registry (src/pages.ts; design/28 §3.1 "Code split"): one memoized load per chunk, reset on a
 * failure, subscribers told of each change, no load while disabled, the preload sets by layout, capability
 * profile and phone, and each chunk's module string equal to its import() literal.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  chunk,
  COMPACT_PAGES,
  gateState,
  loadIfEnabled,
  OPERATE,
  PAGES,
  preloadSet,
  REGULAR_FULL,
  REGULAR_PAGES,
  retryChunks,
  retryOrReload,
  setState,
  VENUE_CRITICAL,
} from '../src/pages.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('chunk', () => {
  it('loads once, keeps the value and tells its subscribers', async () => {
    let calls = 0;
    const c = chunk('./x.ts', async () => {
      calls++;
      return 42;
    });
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.state().status));
    expect(c.get()).toBeUndefined();
    expect(c.state().status).toBe('idle');
    const [a, b] = await Promise.all([c.load(), c.load()]);
    expect([a, b, await c.load()]).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
    expect(c.get()).toBe(42);
    expect(seen).toEqual(['loading', 'loaded']);
  });

  it('a failed load clears its promise: the next load retries', async () => {
    let calls = 0;
    const c = chunk('./x.ts', async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      return 'ok';
    });
    await expect(c.load()).rejects.toThrow('offline');
    expect(c.state().status).toBe('failed');
    expect((c.error() as Error).message).toBe('offline');
    expect(setState([c])).toMatchObject({ ready: false });
    expect(setState([c]).error).toBeInstanceOf(Error);
    retryChunks([c]);
    await flush();
    await flush();
    expect(calls).toBe(2);
    expect(c.get()).toBe('ok');
    expect(c.error()).toBeUndefined();
    expect(setState([c])).toEqual({ ready: true });
  });

  it('a disabled hook never loads; an enabled one loads an idle chunk once', async () => {
    let calls = 0;
    const c = chunk('./x.ts', async () => ++calls);
    loadIfEnabled(c, false);
    await flush();
    expect(calls).toBe(0);
    expect(c.state().status).toBe('idle');
    loadIfEnabled(c, true);
    loadIfEnabled(c, true);
    await flush();
    expect(calls).toBe(1);
    expect(setState([c])).toEqual({ ready: true });
  });

  it('a failed chunk is not reloaded by the hook (only by Retry)', async () => {
    let calls = 0;
    const c = chunk('./x.ts', async () => {
      calls++;
      throw new Error('gone');
    });
    await c.load().catch(() => undefined);
    loadIfEnabled(c, true);
    await flush();
    expect(calls).toBe(1);
  });
});

/**
 * The venue PC's gate (review of P0): one failed Import tab fetch showed the error card instead of the live view,
 * and in Chromium Retry could never succeed (a failed dynamic import stays failed for the document).
 */
describe('the venue PC’s gate', () => {
  const loaded = (v = 1) => {
    const c = chunk('./ok.ts', async () => v);
    return c;
  };
  const failing = () => chunk('./bad.ts', async () => Promise.reject(new Error('connection reset')));

  it('waits for the live view and the operate services only; the rest only until they settle', async () => {
    expect(VENUE_CRITICAL).toEqual([PAGES.live, OPERATE]);
    for (const c of VENUE_CRITICAL) expect(REGULAR_FULL).toContain(c);
    const live = loaded();
    const ops = loaded();
    const tab = failing();
    const other = loaded();
    const all = [live, other, tab, ops];
    const critical = [live, ops];
    expect(gateState(all, critical)).toEqual({ ready: false });
    await Promise.allSettled(all.map((c) => c.load()));
    // Before: setState(all) answered the tab's error and the Shell never mounted.
    expect(setState(all).error).toBeInstanceOf(Error);
    expect(gateState(all, critical)).toEqual({ ready: true });
    // A critical chunk that fails is the gate's error.
    const badLive = failing();
    await badLive.load().catch(() => undefined);
    const g = gateState([badLive, other, ops], [badLive, ops]);
    expect(g.ready).toBe(false);
    expect(g.error).toBeInstanceOf(Error);
    // Still loading: not ready, no error.
    const slow = chunk('./slow.ts', () => new Promise<number>(() => undefined));
    void slow.load();
    expect(gateState([slow, ops], [ops])).toEqual({ ready: false });
  });

  it('Retry loads again; when that fails it reloads the page, only if the hub answers and it is safe', async () => {
    let tries = 0;
    const flaky = chunk('./flaky.ts', async () => {
      tries++;
      if (tries < 3) throw new Error('reset');
      return 'ok';
    });
    await flaky.load().catch(() => undefined);
    let reloads = 0;
    const reload = () => {
      reloads++;
    };
    // The hub does not answer: no reload (it would leave the browser's own error page).
    expect(await retryOrReload([flaky], { reachable: async () => false, reload })).toBe('failed');
    expect(reloads).toBe(0);
    expect(tries).toBe(2);
    // A service runs from this page: no reload.
    const gone = failing();
    await gone.load().catch(() => undefined);
    expect(await retryOrReload([gone], { reachable: async () => true, reload, safe: () => false })).toBe(
      'failed',
    );
    expect(reloads).toBe(0);
    // Chromium's case: the import fails again although the hub answers: reload.
    expect(await retryOrReload([gone], { reachable: async () => true, reload })).toBe('reloading');
    expect(reloads).toBe(1);
    // WebKit's case: the import works again: no reload.
    expect(flaky.state().status).toBe('failed');
    expect(await retryOrReload([flaky], { reachable: async () => true, reload })).toBe('loaded');
    expect(tries).toBe(3);
    expect(flaky.get()).toBe('ok');
    expect(reloads).toBe(1);
    // Nothing failed: nothing to do.
    expect(await retryOrReload([loaded()], { reachable: async () => true, reload })).toBe('loaded');
  });
});

describe('preload sets', () => {
  it('a phone (either layout) and the compact layout preload the compact set only', () => {
    expect(COMPACT_PAGES).toEqual(['compact']);
    for (const [layout, profile, phone] of [
      ['compact', 'edit', true],
      ['regular', 'edit', true],
      ['compact', 'edit', false],
    ] as const)
      expect(preloadSet(layout, profile, phone)).toEqual({ pages: COMPACT_PAGES, operate: false });
  });

  it('a regular device preloads what its capability profile can open; the operate services on full only', () => {
    expect(preloadSet('regular', 'full', false)).toEqual({ pages: REGULAR_PAGES.full, operate: true });
    expect(preloadSet('regular', 'edit', false)).toEqual({ pages: REGULAR_PAGES.edit, operate: false });
    // Every page but the compact chunk, which no regular device loads.
    expect([...REGULAR_PAGES.full].sort()).toEqual(
      Object.keys(PAGES)
        .filter((k) => k !== 'compact')
        .sort(),
    );
    expect(REGULAR_PAGES.edit).not.toContain('compact');
    // An iPad never opens the live view or Setup (allowedForRole on the edit profile).
    expect(REGULAR_PAGES.edit).not.toContain('live');
    expect(REGULAR_PAGES.edit).not.toContain('setup');
  });
});

describe('the registry source', () => {
  const src = readFileSync(new URL('../src/pages.ts', import.meta.url), 'utf8');

  it("each chunk's module string is its import() literal", () => {
    const found = [...src.matchAll(/chunk\(\s*'([^']+)',\s*\(\)\s*=>\s*import\('([^']+)'\)/g)];
    expect(found.length).toBeGreaterThanOrEqual(Object.keys(PAGES).length);
    for (const [, module, imported] of found) expect(module).toBe(imported);
    for (const c of Object.values(PAGES)) expect(found.map((m) => m[1])).toContain(c.module);
  });

  it('uses no React.lazy or Suspense (comments aside)', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\blazy\(|Suspense/);
  });
});
