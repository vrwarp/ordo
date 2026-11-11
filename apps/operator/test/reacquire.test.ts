import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { missingHandles, reacquireMissing, resetReacquire, RETRY_MS } from '../src/services/reacquire.ts';
import { useLive } from '../src/state/live.ts';
import { settings } from '../src/state/library.ts';

describe('reacquire output windows', () => {
  const store = new Map<string, string>();
  const origWindow = (globalThis as unknown as { window?: unknown }).window;
  const origSessionStorage = (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;

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
    useLive.setState({ health: {} });
  });

  afterEach(() => {
    (globalThis as unknown as { window: unknown }).window = origWindow;
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = origSessionStorage;
    store.clear();
  });

  it('missingHandles returns empty when no outputs are launched, connected, or confirmed local', () => {
    const m = missingHandles();
    expect(m.ids).toEqual([]);
    expect(m.due).toEqual([]);
  });

  it('does not attempt window.open when probe finds no local windows', async () => {
    const openMock = vi.fn();
    (globalThis as unknown as { window: { open: unknown } }).window.open = openMock;

    // Simulate an output reported connected by hub, but not local on this machine
    const firstOutput = settings().outputs[0];
    if (firstOutput) {
      useLive.setState({
        health: {
          [firstOutput.id]: {
            outputId: firstOutput.id,
            connected: true,
            latencyMs: 5,
            fps: 60,
            frameDrops: 0,
            clockSkewMs: 0,
            activeRenderer: 'canvas2d',
            mediaStalls: 0,
            gpuRestarts: 0,
            swFallback: false,
            assetLag: false,
            cachePct: 100,
            storagePersistent: true,
          },
        },
      });

      const m = missingHandles();
      expect(m.due).toContain(firstOutput.id);

      const n = await reacquireMissing();
      expect(n).toBe(0);
      // Window.open must NEVER be called because probe received no pong!
      expect(openMock).not.toHaveBeenCalled();
    }
  });

  it('throttles attempts per RETRY_MS', async () => {
    const firstOutput = settings().outputs[0];
    if (firstOutput) {
      useLive.setState({
        health: {
          [firstOutput.id]: {
            outputId: firstOutput.id,
            connected: true,
            latencyMs: 5,
            fps: 60,
            frameDrops: 0,
            clockSkewMs: 0,
            activeRenderer: 'canvas2d',
            mediaStalls: 0,
            gpuRestarts: 0,
            swFallback: false,
            assetLag: false,
            cachePct: 100,
            storagePersistent: true,
          },
        },
      });

      const t0 = 1000;
      const m1 = missingHandles(t0);
      expect(m1.due).toContain(firstOutput.id);

      await reacquireMissing(false, t0);

      // Immediately after, not due
      const m2 = missingHandles(t0 + 1000);
      expect(m2.due).not.toContain(firstOutput.id);

      // After RETRY_MS, due again
      const m3 = missingHandles(t0 + RETRY_MS + 1);
      expect(m3.due).toContain(firstOutput.id);
    }
  });

  it('re-acquires confirmed local window and attaches it', async () => {
    const firstOutput = settings().outputs[0];
    if (firstOutput) {
      const openMock = vi.fn().mockReturnValue({
        location: { href: `http://localhost/out?output=${firstOutput.id}` },
        close: vi.fn(),
        closed: false,
      });
      (globalThis as unknown as { window: { open: unknown } }).window.open = openMock;

      const dummyCtl = {
        role: 'operate',
        hooks: {},
        core: {
          attachBroadcast: vi.fn(),
          attachWindow: vi.fn(),
          detachWindow: vi.fn(),
        },
      };

      const { installOutputWindows } = await import('../src/services/outputs.ts');
      const { registerWindowProbe } = await import('@ordo/client');
      const ow = installOutputWindows(dummyCtl as never);

      // Register the local window probe
      const unreg = registerWindowProbe(firstOutput.id, 'output');

      try {
        const found = await ow.probeLocal([firstOutput.id], 50);
        expect(found.has(firstOutput.id)).toBe(true);

        const n = ow.reacquire(found);
        expect(n).toBe(1);
        expect(openMock).toHaveBeenCalledWith('', `ordo-out-${firstOutput.id}`);
        expect(dummyCtl.core.attachWindow).toHaveBeenCalled();
      } finally {
        unreg();
        ow.dispose();
      }
    }
  });
});
