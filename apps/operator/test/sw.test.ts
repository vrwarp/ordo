import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SW_NAV_TIMEOUT_MS, swSource } from '../src/sw/template.ts';

const ORIGIN = 'https://op.example.test';

type Listener = (e: {
  request: FakeRequest;
  respondWith: (p: Promise<unknown>) => void;
  waitUntil: (p: Promise<unknown>) => void;
}) => void;
type FakeRequest = { url: string; method: string; mode: string };
type FakeResponse = { ok: boolean; status: number; type: string; body: string; clone: () => FakeResponse };

function response(body: string, status = 200): FakeResponse {
  const r: FakeResponse = { ok: status >= 200 && status < 300, status, type: 'basic', body, clone: () => r };
  return r;
}

/** Runs the generated worker against a fake `self`, `caches` and `fetch`. */
function boot(
  fetchImpl: (req: FakeRequest) => Promise<FakeResponse>,
  cached: Record<string, FakeResponse> = {},
) {
  const listeners: Record<string, Listener[]> = {};
  const store = new Map<string, FakeResponse>(Object.entries(cached));
  const cache = {
    match: (key: string) => Promise.resolve(store.get(key)),
    put: (key: string, res: FakeResponse) => {
      store.set(key, res);
      return Promise.resolve();
    },
    addAll: () => Promise.resolve(),
  };
  const caches = {
    open: () => Promise.resolve(cache),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };
  const self = {
    location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    addEventListener: (k: string, fn: Listener) => {
      (listeners[k] ??= []).push(fn);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const src = swSource(['index.html', 'assets/app.js'], 'v-test');
  new Function('self', 'caches', 'fetch', 'setTimeout', 'clearTimeout', src)(
    self,
    caches,
    fetchImpl,
    setTimeout,
    clearTimeout,
  );
  const request = (url: string, mode = 'no-cors', method = 'GET') => {
    let responded: Promise<unknown> | undefined;
    for (const fn of listeners.fetch ?? [])
      fn({
        request: { url, mode, method },
        respondWith: (p) => {
          responded = p;
        },
        waitUntil: () => undefined,
      });
    return responded;
  };
  return { request, store };
}

describe('service worker (ADR 0013: network-first navigation, cache-first assets)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves a navigation from the network when it answers, and refreshes the cached shell', async () => {
    const shell = `${ORIGIN}/index.html`;
    const sw = boot(() => Promise.resolve(response('new shell')), { [shell]: response('old shell') });
    const res = (await sw.request(`${ORIGIN}/`, 'navigate')) as FakeResponse;
    expect(res.body).toBe('new shell');
    expect(sw.store.get(shell)?.body).toBe('new shell');
  });

  it('falls back to the cached shell when the network fails or answers 5xx', async () => {
    const shell = `${ORIGIN}/index.html`;
    const down = boot(() => Promise.reject(new Error('offline')), { [shell]: response('cached shell') });
    expect(((await down.request(`${ORIGIN}/`, 'navigate')) as FakeResponse).body).toBe('cached shell');
    const proxy = boot(() => Promise.resolve(response('bad gateway', 502)), {
      [shell]: response('cached shell'),
    });
    expect(((await proxy.request(`${ORIGIN}/index.html`, 'navigate')) as FakeResponse).body).toBe(
      'cached shell',
    );
  });

  it('falls back to the cached shell after the 4 s timeout', async () => {
    const shell = `${ORIGIN}/index.html`;
    let resolveNetwork: ((r: FakeResponse) => void) | undefined;
    const sw = boot(() => new Promise<FakeResponse>((r) => (resolveNetwork = r)), {
      [shell]: response('cached shell'),
    });
    const p = sw.request(`${ORIGIN}/`, 'navigate') as Promise<FakeResponse>;
    let settled: FakeResponse | undefined;
    void p.then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(SW_NAV_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled?.body).toBe('cached shell');
    resolveNetwork?.(response('late'));
  });

  it('with nothing cached, a failing navigation surfaces the network error', async () => {
    const sw = boot(() => Promise.reject(new Error('offline')));
    await expect(sw.request(`${ORIGIN}/`, 'navigate')).rejects.toThrow('offline');
  });

  it('serves precached assets cache-first', async () => {
    const asset = `${ORIGIN}/assets/app.js`;
    let fetched = 0;
    const sw = boot(
      () => {
        fetched++;
        return Promise.resolve(response('from network'));
      },
      { [asset]: response('from cache') },
    );
    expect(((await sw.request(asset)) as FakeResponse).body).toBe('from cache');
    expect(fetched).toBe(0);
    const miss = boot(() => Promise.resolve(response('from network')));
    expect(((await miss.request(asset)) as FakeResponse).body).toBe('from network');
    expect(miss.store.get(asset)?.body).toBe('from network');
  });

  it('never touches /api, /ws, other origins, POSTs or unknown paths', () => {
    const sw = boot(() => Promise.resolve(response('x')));
    expect(sw.request(`${ORIGIN}/api/v1/auth/me`)).toBeUndefined();
    expect(sw.request(`${ORIGIN}/ws`)).toBeUndefined();
    expect(sw.request('https://other.test/assets/app.js')).toBeUndefined();
    expect(sw.request(`${ORIGIN}/assets/app.js`, 'no-cors', 'POST')).toBeUndefined();
    expect(sw.request(`${ORIGIN}/output/`, 'navigate')).toBeUndefined();
  });
});
