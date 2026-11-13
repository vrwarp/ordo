import type { Output } from '@ordo/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installOutputWindows, type OutputWindows } from '../src/services/outputs.ts';
import { markLaunched, missingHandles, reacquireMissing, resetReacquire } from '../src/services/reacquire.ts';
import { EMPTY_SETTINGS } from '../src/core/libraryStore.ts';
import { useLibrary } from '../src/state/library.ts';
import { useLive } from '../src/state/live.ts';

/**
 * Output windows after an operator reload in domain mode (op./outN. hosts, the venue setup; review
 * 2026-11-13): the BroadcastChannel probe cannot cross the role origins, so windows are looked up by their
 * stable names on what is known instead (launched from this browser session, connected to the hub).
 */

const out = (id: string, hostIndex: number): Output => ({
  id,
  name: `Audience ${hostIndex}`,
  kind: 'output',
  hostIndex,
  lookId: 'look-main',
  enabled: true,
  audioMaster: false,
  token: `tok-${id}`,
});
const connected = (id: string) => ({
  outputId: id,
  connected: true,
  latencyMs: 5,
  fps: 60,
  frameDrops: 0,
  clockSkewMs: 0,
  activeRenderer: 'canvas2d' as const,
  mediaStalls: 0,
  gpuRestarts: 0,
  swFallback: false,
  assetLag: false,
  cachePct: 100,
  storagePersistent: true,
});

/** An existing output window on its own origin: reading its location throws, as cross-origin does. */
function outputWindow() {
  return {
    get location(): Location {
      throw new Error('cross-origin');
    },
    close: vi.fn(),
    closed: false,
  };
}
/** What window.open('', name) returns when no window has that name: a fresh blank one of our origin. */
function blankWindow() {
  return { location: { href: 'about:blank' }, close: vi.fn(), closed: false };
}

describe('re-acquiring output windows in domain mode', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, location: g.location, sessionStorage: g.sessionStorage };
  const store = new Map<string, string>();
  let ow: OutputWindows;
  let open: ReturnType<typeof vi.fn>;
  const ctl = {
    role: 'operate',
    hooks: {},
    core: { attachBroadcast: vi.fn(), attachWindow: vi.fn(), detachWindow: vi.fn() },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetReacquire();
    store.clear();
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };
    g.location = {
      hostname: 'op.church.example',
      search: '',
      protocol: 'https:',
      port: '',
      origin: 'https://op.church.example',
      pathname: '/',
    };
    open = vi.fn();
    g.window = {
      open,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      screen: { width: 1920, height: 1080 },
    };
    useLibrary.setState((s) => ({
      data: { ...s.data, settings: { ...EMPTY_SETTINGS, outputs: [out('o1', 1), out('o2', 2)] } },
    }));
    useLive.setState({ health: {} });
    ctl.core.attachWindow.mockClear();
    ow = installOutputWindows(ctl as never);
  });

  afterEach(() => {
    ow.dispose();
    vi.useRealTimers();
    g.window = saved.window;
    g.location = saved.location;
    g.sessionStorage = saved.sessionStorage;
    useLibrary.setState((s) => ({ data: { ...s.data, settings: EMPTY_SETTINGS } }));
  });

  it('has no probe there, so a window is never confirmed by one', () => {
    expect(ow.canProbe).toBe(false);
    expect(ow.isConfirmedLocal('o1')).toBe(false);
  });

  it('the fallback link re-acquires the windows this session launched, by their names', async () => {
    markLaunched(true);
    open.mockImplementation(() => outputWindow());
    expect(await reacquireMissing(true)).toBe(2);
    expect(open).toHaveBeenCalledWith('', 'ordo-out-o1');
    expect(open).toHaveBeenCalledWith('', 'ordo-out-o2');
    expect(ctl.core.attachWindow).toHaveBeenCalledTimes(2);
    expect(ow.missing()).toEqual([]);
    expect(missingHandles(Date.now(), true).ids).toEqual([]);
  });

  it('the fallback link and Diagnostics try the windows the hub reports connected, too', async () => {
    useLive.setState({ health: { o2: connected('o2') } });
    open.mockImplementation(() => outputWindow());
    expect(await reacquireMissing(true)).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('', 'ordo-out-o2');
    // Diagnostics' Re-acquire button (no ids): the same outputs.
    ow.closeOne('o2');
    open.mockClear();
    expect(ow.reacquire()).toBe(1);
    expect(open).toHaveBeenCalledWith('', 'ordo-out-o2');
  });

  it('closes the blank window a name opens when no output window has it, and keeps it missing', async () => {
    useLive.setState({ health: { o1: connected('o1') } });
    const blank = blankWindow();
    open.mockReturnValue(blank);
    expect(await reacquireMissing(true)).toBe(0);
    vi.runOnlyPendingTimers();
    expect(blank.close).toHaveBeenCalled();
    expect(ow.missing().map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(missingHandles(Date.now(), true).ids).toEqual(['o1']);
  });

  it('a gesture during the service only tries outputs launched here that the hub sees, once a minute', async () => {
    // Connected but not launched from this browser (another computer runs it): no blank window flashes.
    useLive.setState({ health: { o1: connected('o1') } });
    const t0 = 100_000;
    expect(missingHandles(t0).ids).toEqual([]);
    expect(await reacquireMissing(false, t0)).toBe(0);
    expect(open).not.toHaveBeenCalled();
    // Launched here and not connected (closed since): not tried either.
    markLaunched(true);
    useLive.setState({ health: {} });
    expect(missingHandles(t0).ids).toEqual([]);
    // Launched here and connected: re-acquired by name.
    useLive.setState({ health: { o1: connected('o1'), o2: connected('o2') } });
    open.mockImplementation(() => outputWindow());
    expect(await reacquireMissing(false, t0)).toBe(2);
    ow.closeOne('o1');
    open.mockClear();
    expect(await reacquireMissing(false, t0 + 1000)).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(await reacquireMissing(false, t0 + 61_000)).toBe(1);
  });

  it('Relaunch takes over the windows a reload lost before closing and reopening them', async () => {
    markLaunched(true);
    const old = [outputWindow(), outputWindow()];
    open.mockImplementation((url: string) => (url === '' ? old.shift() : outputWindow()));
    const done = ow.relaunch();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    const calls = open.mock.calls.map((c) => [c[0] === '' ? '' : 'url', c[1]]);
    expect(calls.slice(0, 2)).toEqual([
      ['', 'ordo-out-o1'],
      ['', 'ordo-out-o2'],
    ]);
    expect(open.mock.calls.slice(2).map((c) => c[1])).toEqual(['ordo-out-o1', 'ordo-out-o2']);
  });
});
