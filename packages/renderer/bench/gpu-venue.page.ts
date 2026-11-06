import type { FrameInputs } from '../src/compositor.ts';
import { RenderEngine } from '../src/engine.ts';
import { GpuCompositor, UPLOAD_BUDGET_MS, UPLOAD_FRAME_SHARE } from '../src/gpu.ts';
import { LAYERS, LAYER_INDEX, LayerStack, SRC_BITMAP, type StackContent } from '../src/stacks.ts';

/**
 * Browser side of the venue GPU measurement (design/27 §13, §15 M7; runner and procedure: gpu-venue.ts).
 * Runs in a dedicated worker, as the render worker does, on the machine's real GPU:
 * - uploads: a CPU-backed full-frame bitmap (what the asset worker sends) and a lyric-band sprite, uploaded
 *   by the WebGPU compositor at once (budget 0, the M5 behaviour) and in strips (the default budget and an
 *   eighth of a frame): per frame, the render worker's CPU time in the copies and the GPU time until the
 *   queue has done them (`onSubmittedWorkDone`, from the submit);
 * - compositing: one frame of five layers, full-frame transparent bitmaps against the same layers as
 *   sprites (scissored), and an opaque background (replace pipeline): GPU time of the render pass from
 *   timestamp queries when the adapter has 'timestamp-query', else the queue's completion time;
 * - a live run: the real engine on requestAnimationFrame for a few seconds, a new full-frame slide armed
 *   every second and flipped half a second later, with the default budget and without strips: frames
 *   presented and missed, late flips, rAF interval p95 and max, and telemetry `uploadMs`.
 */

export type Stats = { n: number; p50: number; p95: number; max: number };
export type VenueReport = {
  adapter: Record<string, unknown>;
  timestamps: boolean;
  sizes: {
    width: number;
    height: number;
    uploads: {
      name: string;
      budget: string;
      frames: number;
      cpuMs: Stats;
      gpuMs: Stats;
    }[];
    compose: { name: string; gpuMs: Stats; source: 'timestamp' | 'queue' }[];
    live: {
      budget: string;
      seconds: number;
      presented: number;
      missed: number;
      lateFlips: number;
      intervalMs: Stats;
      uploadMs: number;
    }[];
  }[];
};

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return { n: 0, p50: 0, p95: 0, max: 0 };
  return {
    n: s.length,
    p50: s[Math.floor(s.length / 2)]!,
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!,
    max: s[s.length - 1]!,
  };
}

/** A CPU-backed bitmap, as the asset worker's surface makes them: a photo-like picture or a text band. */
function bitmap(w: number, h: number, kind: 'opaque' | 'band' | 'layer', seed: number): ImageBitmap {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  if (kind === 'opaque') {
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${seed * 47} 60% 30%)`);
    g.addColorStop(1, `hsl(${seed * 47 + 120} 60% 50%)`);
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
  }
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.font = `${Math.round(h / 12)}px sans-serif`;
  const lines = kind === 'band' ? 2 : 6;
  for (let i = 0; i < lines; i++)
    x.fillText(
      `Amazing grace ${seed} how sweet the sound`,
      w * 0.06,
      h * (kind === 'band' ? 0.4 : 0.15) + i * (h / 9),
    );
  return c.transferToImageBitmap();
}

function inputs(): FrameInputs {
  return {
    layers: LAYERS.map(() => {
      const ls = new LayerStack<ImageBitmap>((b) => b.close());
      ls.gated = true;
      return ls;
    }),
    video: { frames: [null, null, null, null], version: new Int32Array(4), gen: new Int32Array(4).fill(-1) },
    now: 0,
    clear: new Float32Array([0, 0, 0, 1]),
    testPixel: new Int32Array([-1, 0, 0]),
  };
}

async function compositor(device: GPUDevice, w: number, h: number, bytes?: number): Promise<GpuCompositor> {
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  // Budget 0 is the M5 behaviour: every upload one copy, whatever its size or time.
  const c = new GpuCompositor(device, context, format, w, h, LAYERS.length, {
    bytes,
    ms: bytes === 0 ? 0 : undefined,
  });
  await c.compile();
  return c;
}

/** Release a compositor's textures but keep the shared device (GpuCompositor.destroy ends its device). */
function release(device: GPUDevice, c: GpuCompositor): void {
  const d = device as unknown as { destroy(): void };
  const end = d.destroy;
  d.destroy = () => undefined;
  try {
    c.destroy();
  } finally {
    d.destroy = end;
  }
}

/** Upload `make()` into the slide layer's armed stack until ready, one compositor frame at a time. */
async function uploads(
  device: GPUDevice,
  c: GpuCompositor,
  make: () => ImageBitmap,
  at: { x: number; y: number },
  rounds: number,
): Promise<{ frames: number; cpu: number[]; gpu: number[] }> {
  const cpu: number[] = [];
  const gpu: number[] = [];
  let frames = 0;
  // One set of layers for every round, as the engine keeps (stack versions only grow).
  const f = inputs();
  const ls = f.layers[LAYER_INDEX.slide]!;
  for (let r = 0; r < rounds; r++) {
    const content: StackContent<ImageBitmap> = { key: `k${r}`, kind: SRC_BITMAP, bitmap: make(), ...at };
    ls.offer(content);
    for (let i = 0; i < 64 && !ls.armedStack.ready; i++) {
      const t0 = performance.now();
      c.drainUploads(f, true);
      const t1 = performance.now();
      device.queue.submit([]);
      await device.queue.onSubmittedWorkDone();
      cpu.push(t1 - t0);
      gpu.push(performance.now() - t1);
      frames++;
    }
  }
  ls.reset();
  return { frames: frames / rounds, cpu, gpu };
}

/** GPU time of draw(): timestamp queries around its render pass, or the queue's completion time. */
async function compose(
  device: GPUDevice,
  c: GpuCompositor,
  f: FrameInputs,
  frames: number,
  ts: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer } | null,
): Promise<number[]> {
  const out: number[] = [];
  const pass = (c as unknown as { passDesc: GPURenderPassDescriptor }).passDesc;
  if (ts) pass.timestampWrites = { querySet: ts.set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  c.drainUploads(f, false);
  c.drainUploads(f, true);
  await device.queue.onSubmittedWorkDone();
  for (let i = 0; i < frames + 3; i++) {
    const t0 = performance.now();
    c.draw(f);
    if (ts) {
      const enc = device.createCommandEncoder();
      enc.resolveQuerySet(ts.set, 0, 2, ts.resolve, 0);
      enc.copyBufferToBuffer(ts.resolve, 0, ts.read, 0, 16);
      device.queue.submit([enc.finish()]);
      await ts.read.mapAsync(GPUMapMode.READ);
      const v = new BigUint64Array(ts.read.getMappedRange().slice(0));
      ts.read.unmap();
      if (i >= 3) out.push(Number(v[1]! - v[0]!) / 1e6);
    } else {
      await device.queue.onSubmittedWorkDone();
      if (i >= 3) out.push(performance.now() - t0);
    }
  }
  if (ts) pass.timestampWrites = undefined;
  return out;
}

/** The engine on requestAnimationFrame: a new full-frame slide armed every second, flipped 500 ms later. */
async function live(
  w: number,
  h: number,
  seconds: number,
  budget: number | undefined,
): Promise<VenueReport['sizes'][number]['live'][number]> {
  const canvas = new OffscreenCanvas(w, h);
  const raf = (cb: (t: number) => void) =>
    (self as unknown as { requestAnimationFrame(cb: (t: number) => void): number }).requestAnimationFrame(cb);
  const intervals: number[] = [];
  let last = 0;
  const e = new RenderEngine(
    {
      canvas,
      width: w,
      height: h,
      testPixel: false,
      allowFallbackAdapter: true,
      clear: { r: 0, g: 0, b: 0, a: 1 },
      clockOffset: 0,
      gpuRetryMs: 0,
      uploadBudgetBytes: budget,
      uploadBudgetMs: budget === 0 ? 0 : undefined,
    },
    {
      raf: (cb) =>
        raf((t) => {
          if (last) intervals.push(t - last);
          last = t;
          cb(t);
        }),
      wallNow: () => performance.timeOrigin + performance.now(),
    },
  );
  await e.start();
  e.setSnapshot(0, 1, 1);
  const bg = bitmap(w, h, 'opaque', 0);
  e.offer(LAYER_INDEX.background, { key: 'bg', kind: SRC_BITMAP, bitmap: bg, opaque: true });
  e.flip(LAYER_INDEX.background, 'bg', e.hubNow(), 0);
  for (let s = 0; s < seconds; s++) {
    const key = `s${s}`;
    e.offer(LAYER_INDEX.slide, { key, kind: SRC_BITMAP, bitmap: bitmap(w, h, 'layer', s + 1) });
    e.flip(LAYER_INDEX.slide, key, e.hubNow() + 500, 300);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const t = e.telemetry();
  e.stop();
  return {
    budget: budget === 0 ? 'none (one copy, M5)' : 'default strips',
    seconds,
    presented: t.presented,
    missed: t.missed,
    lateFlips: t.lateFlips,
    intervalMs: stats(intervals.slice(10)),
    uploadMs: t.uploadMs ?? 0,
  };
}

export async function run(opts: { liveSeconds: number }): Promise<VenueReport> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
  const report: VenueReport = {
    adapter: {
      vendor: info?.vendor,
      architecture: info?.architecture,
      device: info?.device,
      description: info?.description,
      isFallbackAdapter: (info as unknown as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter,
      budget: `${UPLOAD_FRAME_SHARE} of a frame, ${UPLOAD_BUDGET_MS} ms`,
    },
    timestamps,
    sizes: [],
  };
  const ts = timestamps
    ? {
        set: device.createQuerySet({ type: 'timestamp', count: 2 }),
        resolve: device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        }),
        read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      }
    : null;
  for (const [w, h] of [
    [1920, 1080],
    [3840, 2160],
  ] as const) {
    const size: VenueReport['sizes'][number] = { width: w, height: h, uploads: [], compose: [], live: [] };
    const band = {
      w: Math.round(w * 0.86),
      h: Math.round(h * 0.3),
      x: Math.round(w * 0.07),
      y: Math.round(h * 0.66),
    };
    for (const [budgetName, bytes] of [
      ['none (one copy, M5)', 0],
      ['default strips', undefined],
      ['an eighth of a frame', Math.round((w * h * 4) / 8)],
    ] as const) {
      const c = await compositor(device, w, h, bytes);
      let n = 0;
      const full = await uploads(device, c, () => bitmap(w, h, 'layer', ++n), { x: 0, y: 0 }, 6);
      size.uploads.push({
        name: 'full-frame bitmap',
        budget: budgetName,
        frames: full.frames,
        cpuMs: stats(full.cpu),
        gpuMs: stats(full.gpu),
      });
      const sp = await uploads(
        device,
        c,
        () => bitmap(band.w, band.h, 'band', ++n),
        { x: band.x, y: band.y },
        6,
      );
      size.uploads.push({
        name: 'lyric-band sprite (26% of the frame)',
        budget: budgetName,
        frames: sp.frames,
        cpuMs: stats(sp.cpu),
        gpuMs: stats(sp.gpu),
      });
      release(device, c);
    }
    // Compositing: five full-frame layers, the same as sprites, and an opaque background under sprites.
    const c = await compositor(device, w, h, 0);
    const layered = (tight: boolean, opaqueBg: boolean) => {
      const f = inputs();
      f.layers.forEach((ls, l) => {
        const isBg = l === LAYER_INDEX.background;
        const sprite = tight && !isBg;
        const b =
          isBg && opaqueBg
            ? bitmap(w, h, 'opaque', 9)
            : sprite
              ? bitmap(band.w, band.h, 'band', l)
              : bitmap(w, h, 'layer', l);
        ls.offer({
          key: `l${l}`,
          kind: SRC_BITMAP,
          bitmap: b,
          ...(sprite ? { x: band.x, y: band.y } : {}),
          opaque: isBg && opaqueBg,
        });
        ls.requestFlip(`l${l}`, 0, 0, 0);
        ls.tick(0, 16);
      });
      return f;
    };
    for (const [name, f] of [
      ['five full-frame layers', layered(false, false)],
      ['four sprites over a full-frame layer', layered(true, false)],
      ['four sprites over an opaque background (replace)', layered(true, true)],
    ] as const) {
      // Upload everything first (unbudgeted compositor), then time the draws.
      for (const ls of f.layers) ls.stacks[ls.live]!.ready = false;
      size.compose.push({
        name,
        gpuMs: stats(await compose(device, c, f, 30, ts)),
        source: ts ? 'timestamp' : 'queue',
      });
      for (const ls of f.layers) ls.reset();
    }
    release(device, c);
    if (opts.liveSeconds > 0) {
      size.live.push(await live(w, h, opts.liveSeconds, 0));
      size.live.push(await live(w, h, opts.liveSeconds, undefined));
    }
    report.sizes.push(size);
  }
  device.destroy();
  return report;
}

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined';

if (inWorker) {
  const scope = self as unknown as { onmessage: unknown; postMessage(m: unknown): void };
  scope.onmessage = async (e: MessageEvent<{ liveSeconds: number }>) => {
    try {
      scope.postMessage({ ok: true, report: await run(e.data) });
    } catch (err) {
      scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  };
} else {
  (window as unknown as { __venue: unknown }).__venue = (source: string, liveSeconds: number) =>
    new Promise<VenueReport>((resolve, reject) => {
      const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      w.onmessage = (e: MessageEvent<{ ok: boolean; report?: VenueReport; error?: string }>) => {
        w.terminate();
        if (e.data.ok) resolve(e.data.report!);
        else reject(new Error(e.data.error));
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ liveSeconds });
    });
}
