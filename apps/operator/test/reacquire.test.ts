import type { Output } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installOutputWindows, type OutputWindows } from '../src/services/outputs.ts';
import { missingHandles, reacquireMissing, resetReacquire, RETRY_MS } from '../src/services/reacquire.ts';
import { useLibrary } from '../src/state/library.ts';
import { useLive } from '../src/state/live.ts';

/** The one enabled output these tests run with (the library starts with none). */
const OUTPUT: Output = {
  id: 'out-a',
  name: 'Audience',
  kind: 'output',
  hostIndex: 1,
  lookId: 'look-main',
  enabled: true,
  audioMaster: false,
  token: 'tok-a',
};

/** What the hub reports for an output window that is connected (somewhere, not necessarily here). */
function connected(outputId: string): OutputHealthEntry {
  return {
    outputId,
    connected: true,
    lastSeen: Date.now(),
    presented: 600,
    missed: 0,
    longTasks: 0,
    lateFlips: 0,
    cache: { ready: 1, total: 1 },
    gpuLost: 0,
    videoDropped: 0,
  };
}

function controller() {
  return {
    role: 'operate',
    hooks: {},
    core: { attachBroadcast: vi.fn(), attachWindow: vi.fn(), detachWindow: vi.fn() },
  };
}

describe('reacquire output windows', () => {
  const store = new Map<string, string>();
  const origWindow = (globalThis as unknown as { window?: unknown }).window;
  const origSessionStorage = (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  const library = useLibrary.getState();
  let ow: OutputWindows | undefined;

  beforeEach(() => {
    resetReacquire();
    store.clear();
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    (globalThis as unknown as { window: unknown }).window = {
      open: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    // One origin for every app (not domain mode), where windows answer the BroadcastChannel probe.
    vi.stubGlobal('location', new URL('http://127.0.0.1:8090/'));
    useLive.setState({ health: {} });
    useLibrary.setState({
      data: { ...library.data, settings: { ...library.data.settings, outputs: [OUTPUT] } },
    });
  });

  afterEach(() => {
    ow?.dispose();
    ow = undefined;
    useLibrary.setState(library, true);
    vi.unstubAllGlobals();
    (globalThis as unknown as { window: unknown }).window = origWindow;
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = origSessionStorage;
    store.clear();
  });

  it('missingHandles returns empty when no outputs are launched, connected, or confirmed local', () => {
    ow = installOutputWindows(controller() as never);
    const m = missingHandles();
    expect(m.ids).toEqual([]);
    expect(m.due).toEqual([]);
  });

  it('does not attempt window.open when probe finds no local windows', async () => {
    const openMock = vi.fn();
    (globalThis as unknown as { window: { open: unknown } }).window.open = openMock;
    ow = installOutputWindows(controller() as never);

    // An output the hub reports connected, but not open in this browser.
    useLive.setState({ health: { [OUTPUT.id]: connected(OUTPUT.id) } });

    const m = missingHandles();
    expect(m.due).toEqual([OUTPUT.id]);

    const n = await reacquireMissing();
    expect(n).toBe(0);
    // window.open is never called: the probe received no answer.
    expect(openMock).not.toHaveBeenCalled();
  });

  it('throttles attempts per RETRY_MS', async () => {
    ow = installOutputWindows(controller() as never);
    useLive.setState({ health: { [OUTPUT.id]: connected(OUTPUT.id) } });

    const t0 = 10 * RETRY_MS;
    const m1 = missingHandles(t0);
    expect(m1.due).toEqual([OUTPUT.id]);

    await reacquireMissing(false, t0);

    // Immediately after, not due
    const m2 = missingHandles(t0 + 1000);
    expect(m2.ids).toEqual([OUTPUT.id]);
    expect(m2.due).toEqual([]);

    // After RETRY_MS, due again
    const m3 = missingHandles(t0 + RETRY_MS + 1);
    expect(m3.due).toEqual([OUTPUT.id]);
  });

  it('re-acquires confirmed local window and attaches it', async () => {
    const openMock = vi.fn().mockReturnValue({
      location: { href: `http://localhost/out?output=${OUTPUT.id}` },
      close: vi.fn(),
      closed: false,
    });
    (globalThis as unknown as { window: { open: unknown } }).window.open = openMock;

    const ctl = controller();
    const { registerWindowProbe } = await import('@ordo/client');
    ow = installOutputWindows(ctl as never);

    // Register the local window probe
    const unreg = registerWindowProbe(OUTPUT.id, 'output');

    try {
      const found = await ow.probeLocal([OUTPUT.id], 50);
      expect(found.has(OUTPUT.id)).toBe(true);

      const n = ow.reacquire(found);
      expect(n).toBe(1);
      expect(openMock).toHaveBeenCalledWith('', `ordo-out-${OUTPUT.id}`);
      expect(ctl.core.attachWindow).toHaveBeenCalled();
    } finally {
      unreg();
    }
  });
});
