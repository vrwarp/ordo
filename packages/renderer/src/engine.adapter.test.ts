import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Compositor, FrameInputs } from './compositor.ts';
import { RenderEngine, isFallbackAdapter } from './engine.ts';

/**
 * A software adapter (`isFallbackAdapter`, SwiftShader) gets the Canvas 2D compositor (design/27 §7.2):
 * probed before the canvas is bound, probed again by the slow WebGPU retry, and overridden by
 * `allowFallbackAdapter` (`?renderer=webgpu`, tests).
 */

class FakeCanvas {
  public width: number;
  public height: number;
  constructor(width = 1920, height = 1080) {
    this.width = width;
    this.height = height;
  }
  getContext(): unknown {
    return new Proxy({}, { get: () => () => undefined, set: () => true });
  }
}

class FakeGpu implements Compositor {
  readonly kind = 'webgpu' as const;
  readonly width = 1920;
  readonly height = 1080;
  draw(_f: FrameInputs): void {}
  destroy(): void {}
}

const SOFTWARE = { info: { vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true } };
const HARDWARE = { info: { vendor: 'intel', architecture: 'gen-12lp', isFallbackAdapter: false } };

function makeEngine(adapters: unknown[], allowFallbackAdapter?: boolean) {
  const timers: (() => void)[] = [];
  const events: string[] = [];
  let probes = 0;
  const engine = new RenderEngine(
    {
      canvas: new FakeCanvas() as unknown as OffscreenCanvas,
      width: 1920,
      height: 1080,
      testPixel: false,
      clear: { r: 0, g: 0, b: 0, a: 1 },
      clockOffset: 0,
      gpuRetryMs: 1000,
      allowFallbackAdapter,
    },
    {
      raf: () => 0,
      wallNow: () => Date.now(),
      onRestored: (k) => events.push(`restored:${k}`),
      requestCanvas: async () => {
        events.push('needCanvas');
        return new FakeCanvas() as unknown as OffscreenCanvas;
      },
      canvasUnused: () => events.push('canvasUnused'),
      probeAdapter: async () => adapters[Math.min(probes++, adapters.length - 1)],
      createGpu: async (init) => {
        events.push('createGpu');
        init.onContext?.();
        return new FakeGpu();
      },
      setTimeout: (fn) => {
        timers.push(fn);
        return 0;
      },
    },
  );
  const fire = async () => {
    timers.shift()!();
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { engine, events, timers, fire, probes: () => probes };
}

describe('RenderEngine on a software adapter', () => {
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognises a fallback adapter by its info, or by the older flag', () => {
    expect(isFallbackAdapter(SOFTWARE)).toBe(true);
    expect(isFallbackAdapter({ isFallbackAdapter: true })).toBe(true);
    expect(isFallbackAdapter(HARDWARE)).toBe(false);
    expect(isFallbackAdapter({})).toBe(false);
    expect(isFallbackAdapter(null)).toBe(false);
  });

  it('uses Canvas 2D on the same canvas, without creating the WebGPU compositor', async () => {
    const { engine, events } = makeEngine([SOFTWARE]);
    const r = await engine.start();
    expect(r.kind).toBe('2d');
    expect(r.note).toMatch(/software fallback/);
    expect(engine.telemetry().compositor).toBe('2d');
    expect(events).toEqual([]);
  });

  it('uses WebGPU on a hardware adapter, and on a software one when allowed', async () => {
    expect((await makeEngine([HARDWARE]).engine.start()).kind).toBe('webgpu');
    const allowed = makeEngine([SOFTWARE], true);
    expect((await allowed.engine.start()).kind).toBe('webgpu');
    expect(allowed.probes()).toBe(0);
  });

  it('probes again on the slow retry before asking for a canvas, and moves to WebGPU once it is hardware', async () => {
    const { engine, events, timers, fire } = makeEngine([SOFTWARE, SOFTWARE, HARDWARE]);
    await engine.start();
    expect(timers).toHaveLength(1);
    await fire();
    // Still software: no canvas asked for, still Canvas 2D, retried later.
    expect(events).toEqual([]);
    expect(engine.kind).toBe('2d');
    expect(engine.error).toMatch(/software fallback/);
    expect(timers).toHaveLength(1);
    await fire();
    expect(events).toEqual(['needCanvas', 'createGpu', 'restored:webgpu']);
    expect(engine.kind).toBe('webgpu');
  });
});
