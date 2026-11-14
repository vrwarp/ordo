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
  loadIfEnabled,
  PAGES,
  preloadSet,
  REGULAR_PAGES,
  retryChunks,
  setState,
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
