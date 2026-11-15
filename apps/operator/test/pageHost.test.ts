/**
 * A page's Try again on the venue PC (components/PageHost.tsx; design/28 §16 "A chunk that fails on the venue
 * PC"): Chromium keeps a failed import, so Try again can only bring a page back by reloading the window, which
 * it never does while a service runs from it (live, or the outputs running from it in fallback). Then it holds
 * back and says so: `retryPage` resolves true and the page's error shows why (review of P0 repair 1: before,
 * the card stayed exactly as it was, with no hint).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { reloadSafe, retryPage } from '../src/components/PageHost.tsx';
import { chunk } from '../src/pages.ts';
import { useLive } from '../src/state/live.ts';

const initial = useLive.getState();
const goLive = () => useLive.setState({ state: { ...initial.state, mode: 'live' } });

afterEach(() => useLive.setState({ state: initial.state, authority: initial.authority }));

describe('PageHost: Try again', () => {
  it('during a service it neither reloads nor stays silent; after it, it reloads', async () => {
    const gone = chunk('./gone.ts', async () => Promise.reject(new Error('connection reset')));
    await gone.load().catch(() => undefined);
    let reloads = 0;
    const deps = {
      reachable: async () => true,
      reload: () => {
        reloads++;
      },
      safe: reloadSafe,
    };

    goLive();
    expect(reloadSafe()).toBe(false);
    expect(await retryPage(gone, deps)).toBe(true);
    expect(reloads).toBe(0);
    expect(gone.state().status).toBe('failed');

    // The outputs running from this window without the hub: the same.
    useLive.setState({ state: initial.state, authority: 'fallback' });
    expect(reloadSafe()).toBe(false);
    expect(await retryPage(gone, deps)).toBe(true);
    expect(reloads).toBe(0);

    // The service has ended: Try again reloads the window (the hub answers), and says nothing more.
    useLive.setState({ authority: 'hub' });
    expect(reloadSafe()).toBe(true);
    expect(await retryPage(gone, deps)).toBe(false);
    expect(reloads).toBe(1);
  });

  it('a page that loads again needs no reload, live or not', async () => {
    let tries = 0;
    const flaky = chunk('./flaky.ts', async () => {
      tries++;
      if (tries < 2) throw new Error('reset');
      return 'ok';
    });
    await flaky.load().catch(() => undefined);
    let reloads = 0;
    goLive();
    expect(
      await retryPage(flaky, {
        reachable: async () => true,
        reload: () => {
          reloads++;
        },
        safe: reloadSafe,
      }),
    ).toBe(false);
    expect(flaky.get()).toBe('ok');
    expect(reloads).toBe(0);
  });
});
