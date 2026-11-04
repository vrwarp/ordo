import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Compositor, FrameInputs } from './compositor.ts';
import { RenderEngine } from './engine.ts';

/**
 * The engine's compositor selection: WebGPU first, Canvas 2D on failure, and the slow retry of WebGPU
 * on a fresh canvas (review item 27). Canvas 2D runs on a stub OffscreenCanvas whose 2D context accepts
 * every call.
 */

function fakeCtx(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class FakeCanvas {
  constructor(
    public width = 1920,
    public height = 1080,
  ) {}
  getContext(): unknown {
    return fakeCtx();
  }
}

class FakeGpu implements Compositor {
  readonly kind = 'webgpu' as const;
  readonly width = 1920;
  readonly height = 1080;
  draws = 0;
  destroyed = false;
  draw(_f: FrameInputs): void {
    this.draws++;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const BLACK = { r: 0, g: 0, b: 0, a: 1 };

function makeEngine(gpuResults: (FakeGpu | Error)[], gpuRetryMs = 1000) {
  const timers: { fn: () => void; ms: number }[] = [];
  const events: string[] = [];
  const canvases: FakeCanvas[] = [];
  let created = 0;
  const engine = new RenderEngine(
    {
      canvas: new FakeCanvas() as unknown as OffscreenCanvas,
      width: 1920,
      height: 1080,
      testPixel: false,
      clear: BLACK,
      clockOffset: 0,
      gpuRetryMs,
    },
    {
      raf: () => 0,
      wallNow: () => Date.now(),
      onRestored: (k) => events.push(`restored:${k}`),
      onSnapshot: (b) => {
        events.push('snapshot');
        b.close();
      },
      requestCanvas: async () => {
        const c = new FakeCanvas();
        canvases.push(c);
        events.push('needCanvas');
        return c as unknown as OffscreenCanvas;
      },
      canvasUnused: () => events.push('canvasUnused'),
      createGpu: async () => {
        const r = gpuResults[Math.min(created++, gpuResults.length - 1)]!;
        if (r instanceof Error) throw r;
        return r;
      },
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return 0;
      },
    },
  );
  const fire = async () => {
    const t = timers.shift();
    if (!t) throw new Error('no timer scheduled');
    t.fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return t.ms;
  };
  return { engine, timers, events, canvases, fire };
}

describe('RenderEngine compositor selection', () => {
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses WebGPU when it is available and schedules no retry', async () => {
    const gpu = new FakeGpu();
    const { engine, timers } = makeEngine([gpu]);
    const r = await engine.start();
    expect(r.kind).toBe('webgpu');
    expect(engine.kind).toBe('webgpu');
    expect(timers).toHaveLength(0);
  });

  it('falls back to Canvas 2D and comes back to WebGPU on a fresh canvas when it works again', async () => {
    const gpu = new FakeGpu();
    const { engine, timers, events, canvases, fire } = makeEngine([
      new Error('no adapter'),
      new Error('still none'),
      gpu,
    ]);
    const r = await engine.start();
    expect(r.kind).toBe('2d');
    expect(r.note).toContain('no adapter');
    expect(engine.telemetry().error).toContain('no adapter');
    // One retry timer at the base delay.
    expect(timers.map((t) => t.ms)).toEqual([1000]);

    // First retry fails: the canvas is handed back, Canvas 2D keeps drawing, the delay doubles.
    await fire();
    expect(engine.kind).toBe('2d');
    expect(engine.gpuRetries).toBe(1);
    expect(events).toEqual(['needCanvas', 'canvasUnused']);
    expect(engine.telemetry().error).toContain('still none');
    expect(timers.map((t) => t.ms)).toEqual([2000]);

    // Second retry succeeds: one frame drawn into the new compositor before the swap, then restored.
    await fire();
    expect(engine.kind).toBe('webgpu');
    expect(gpu.draws).toBe(1);
    expect(events.slice(2)).toEqual(['needCanvas', 'restored:webgpu']);
    expect(engine.telemetry().error).toBeUndefined();
    expect(engine.telemetry().compositor).toBe('webgpu');
    expect(canvases).toHaveLength(2);
    expect(timers).toHaveLength(0);
  });

  it('never retries when Canvas 2D was forced or the retry is disabled', async () => {
    const a = makeEngine([new Error('x')], 0);
    expect((await a.engine.start()).kind).toBe('2d');
    expect(a.timers).toHaveLength(0);
  });

  it('copies the first Canvas 2D frame at once; a WebGPU frame only once it has settled (review F2)', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ close() {} }));
    const frame = (e: RenderEngine) => (e as unknown as { onFrame(ts: number): void }).onFrame(16);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const twoD = makeEngine([new Error('no gpu')]);
    expect((await twoD.engine.start()).kind).toBe('2d');
    twoD.engine.setSnapshot(100, 640, 360);
    frame(twoD.engine);
    await flush();
    expect(twoD.events).toContain('snapshot');
    const gpu = makeEngine([new FakeGpu()]);
    expect((await gpu.engine.start()).kind).toBe('webgpu');
    gpu.engine.setSnapshot(100, 640, 360);
    frame(gpu.engine);
    frame(gpu.engine);
    await flush();
    expect(gpu.events).not.toContain('snapshot');
  });

  it('counts rAF stalls as the worker long-task measure', async () => {
    const { engine } = makeEngine([new FakeGpu()]);
    await engine.start();
    let t = 0;
    for (let i = 0; i < 40; i++) engine.clock.tick((t += 16.667));
    engine.clock.tick((t += 200));
    expect(engine.telemetry().longTasks).toBe(1);
  });
});
