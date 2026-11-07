import type { FrameInputs } from '../src/compositor.ts';
import { RenderEngine } from '../src/engine.ts';
import { GpuCompositor, UPLOAD_BUDGET_BYTES, UPLOAD_BUDGET_MS } from '../src/gpu.ts';
import { LAYERS, LAYER_INDEX, LayerStack, SRC_BITMAP, type StackContent } from '../src/stacks.ts';

/**
 * Browser side of the venue GPU measurement (design/27 §13, §15 M7; runner and procedure: gpu-venue.ts).
 * Runs in a dedicated worker, as the render worker does, on the machine's real GPU:
 * - uploads: a CPU-backed full-frame bitmap (what the asset worker sends) and a lyric-band sprite, uploaded
 *   by the WebGPU compositor at once (budget 0, the M5 behaviour) and in strips (the default budget and an
 *   eighth of a frame): per frame, the render worker's CPU time in the copies, and the latency until the
 *   queue reports them done (`onSubmittedWorkDone` from the submit: GPU time plus the IPC and fence round
 *   trip), beside the same round trip of an empty submit (`emptyMs`), so done minus empty bounds the
 *   copies' GPU time;
 * - compositing: one frame of five layers, full-frame transparent bitmaps against the same layers as
 *   sprites (scissored), and an opaque background (replace pipeline): GPU time of the render pass from
 *   timestamp queries when the adapter has 'timestamp-query', else the queue's completion time. Every
 *   layer is live before the timing starts and each frame must encode five layer draws (it throws
 *   otherwise: a composition that draws nothing would time a cleared pass);
 * - a live run: the real engine on requestAnimationFrame for a few seconds, drawing on a canvas the page
 *   transferred (`transferControlToOffscreen`, as the output does, so frames are presented on the display
 *   and paced by it), a new full-frame slide armed every second and flipped half a second later, and a
 *   late one (its flip due before its content arrives, as a GO to a cue that was not armed), with the
 *   default budget and without strips: frames presented and missed, late flips, frames from the late
 *   content's arrival to its flip, rAF interval p95 and max, and telemetry `uploadMs`.
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
      /** Submit to `onSubmittedWorkDone` after the copies: latency, not GPU time alone. */
      doneMs: Stats;
      /** The same round trip of an empty submit, measured beside it. */
      emptyMs: Stats;
    }[];
    compose: { name: string; gpuMs: Stats; source: 'timestamp' | 'queue' }[];
    live: {
      budget: string;
      seconds: number;
      presented: number;
      missed: number;
      lateFlips: number;
      /** Late flips asked (one a second): late content that flipped is `lateContentFrames.n` of them. */
      lateAsked: number;
      /** Late content (flip due before it arrived): frames from its arrival to its flip. */
      lateContentFrames: Stats;
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
): Promise<{ frames: number; cpu: number[]; done: number[]; empty: number[] }> {
  const cpu: number[] = [];
  const done: number[] = [];
  const empty: number[] = [];
  let frames = 0;
  // One set of layers for every round, as the engine keeps (stack versions only grow).
  const f = inputs();
  const ls = f.layers[LAYER_INDEX.slide]!;
  for (let r = 0; r < rounds; r++) {
    const content: StackContent<ImageBitmap> = { key: `k${r}`, kind: SRC_BITMAP, bitmap: make(), ...at };
    ls.offer(content);
    for (let i = 0; i < 64 && !ls.armedStack.ready; i++) {
      // The round trip of an empty submit first (the queue is idle), then the frame's copies.
      const e0 = performance.now();
      device.queue.submit([]);
      await device.queue.onSubmittedWorkDone();
      empty.push(performance.now() - e0);
      const t0 = performance.now();
      c.drainUploads(f, true);
      const t1 = performance.now();
      device.queue.submit([]);
      await device.queue.onSubmittedWorkDone();
      cpu.push(t1 - t0);
      done.push(performance.now() - t1);
      frames++;
    }
  }
  ls.reset();
  return { frames: frames / rounds, cpu, done, empty };
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
  // What is timed must be what is named: every layer live and uploaded, five layer draws per frame.
  f.layers.forEach((ls, l) => {
    if (ls.liveStack.key === '' || ls.flipPending || !ls.liveStack.ready)
      throw new Error(`compose: layer ${l} is not live (key '${ls.liveStack.key}')`);
  });
  for (let i = 0; i < frames + 3; i++) {
    const t0 = performance.now();
    const before = c.layerDraws;
    c.draw(f);
    if (c.layerDraws - before !== f.layers.length)
      throw new Error(`compose: ${c.layerDraws - before} layer draws, expected ${f.layers.length}`);
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

/**
 * The engine on requestAnimationFrame, drawing on `canvas` (transferred from a canvas shown on the page):
 * every second a new full-frame slide armed and flipped 500 ms later, and a late one, its flip due before
 * its content arrives two frames later (a GO to a cue that was not armed).
 */
async function live(
  canvas: OffscreenCanvas,
  w: number,
  h: number,
  seconds: number,
  budget: number | undefined,
): Promise<VenueReport['sizes'][number]['live'][number]> {
  const raf = (cb: (t: number) => void) =>
    (self as unknown as { requestAnimationFrame(cb: (t: number) => void): number }).requestAnimationFrame(cb);
  const intervals: number[] = [];
  const lateFrames: number[] = [];
  let last = 0;
  let frameNo = 0;
  let lateKey = '';
  let lateFrom = 0;
  const slide = () => e.layers[LAYER_INDEX.slide]!;
  const e: RenderEngine = new RenderEngine(
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
          frameNo++;
          cb(t);
          if (lateKey && slide().liveStack.key === lateKey) {
            lateFrames.push(frameNo - lateFrom);
            lateKey = '';
          }
        }),
      wallNow: () => performance.timeOrigin + performance.now(),
    },
  );
  await e.start();
  e.setSnapshot(0, 1, 1);
  const bg = bitmap(w, h, 'opaque', 0);
  e.offer(LAYER_INDEX.background, { key: 'bg', kind: SRC_BITMAP, bitmap: bg, opaque: true });
  e.flip(LAYER_INDEX.background, 'bg', e.hubNow(), 0);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let s = 0; s < seconds; s++) {
    const key = `s${s}`;
    e.offer(LAYER_INDEX.slide, { key, kind: SRC_BITMAP, bitmap: bitmap(w, h, 'layer', s + 1) });
    e.flip(LAYER_INDEX.slide, key, e.hubNow() + 500, 300);
    await wait(700);
    // Late content: the flip is due now, the content arrives two frames later.
    const late = `late${s}`;
    const content = bitmap(w, h, 'layer', 100 + s);
    e.flip(LAYER_INDEX.slide, late, e.hubNow(), 0);
    await wait(33);
    lateFrom = frameNo;
    lateKey = late;
    e.offer(LAYER_INDEX.slide, { key: late, kind: SRC_BITMAP, bitmap: content });
    await wait(267);
  }
  const t = e.telemetry();
  e.stop();
  return {
    budget: budget === 0 ? 'none (one copy, M5)' : 'default strips',
    seconds,
    presented: t.presented,
    missed: t.missed,
    lateFlips: t.lateFlips,
    lateAsked: seconds,
    lateContentFrames: stats(lateFrames),
    intervalMs: stats(intervals.slice(10)),
    uploadMs: t.uploadMs ?? 0,
  };
}

export async function run(opts: {
  liveSeconds: number;
  canvases?: OffscreenCanvas[];
  /** Called before each live run with its index (the page brings that run's canvas to the front). */
  onLive?: (i: number) => void;
}): Promise<VenueReport> {
  let liveRun = 0;
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
      budget: `${UPLOAD_BUDGET_BYTES} bytes, ${UPLOAD_BUDGET_MS} ms`,
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
        doneMs: stats(full.done),
        emptyMs: stats(full.empty),
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
        doneMs: stats(sp.done),
        emptyMs: stats(sp.empty),
      });
      release(device, c);
    }
    // Compositing: five full-frame layers, the same as sprites, and an opaque background under sprites.
    // Each case on a compositor of its own (its upload bookkeeping is by stack version), its stacks not
    // gated so the flips happen at once; compose() uploads them all before timing.
    const layered = (tight: boolean, opaqueBg: boolean) => {
      const f = inputs();
      f.layers.forEach((ls, l) => {
        ls.gated = false;
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
    for (const [name, tight, opaqueBg] of [
      ['five full-frame layers', false, false],
      ['four sprites over a full-frame layer', true, false],
      ['four sprites over an opaque background (replace)', true, true],
    ] as const) {
      const c = await compositor(device, w, h, 0);
      const f = layered(tight, opaqueBg);
      size.compose.push({
        name,
        gpuMs: stats(await compose(device, c, f, 30, ts)),
        source: ts ? 'timestamp' : 'queue',
      });
      for (const ls of f.layers) ls.reset();
      release(device, c);
    }
    if (opts.liveSeconds > 0) {
      // A canvas the page transferred for each live run (`canvases`, in order), else a worker-made one.
      const canvas = () => {
        opts.onLive?.(liveRun++);
        return opts.canvases?.shift() ?? new OffscreenCanvas(w, h);
      };
      size.live.push(await live(canvas(), w, h, opts.liveSeconds, 0));
      size.live.push(await live(canvas(), w, h, opts.liveSeconds, undefined));
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
  scope.onmessage = async (e: MessageEvent<{ liveSeconds: number; canvases?: OffscreenCanvas[] }>) => {
    try {
      const onLive = (i: number) => scope.postMessage({ live: i });
      scope.postMessage({ ok: true, report: await run({ ...e.data, onLive }) });
    } catch (err) {
      scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  };
} else {
  (window as unknown as { __venue: unknown }).__venue = (source: string, liveSeconds: number) =>
    new Promise<VenueReport>((resolve, reject) => {
      const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      const shown: HTMLCanvasElement[] = [];
      w.onmessage = (
        e: MessageEvent<{ ok: boolean; report?: VenueReport; error?: string; live?: number }>,
      ) => {
        if (e.data.live !== undefined) {
          // The canvas of this live run in front of the others.
          shown.forEach((el, i) => {
            el.style.zIndex = i === e.data.live ? '2' : '1';
          });
          return;
        }
        w.terminate();
        for (const el of shown) el.remove();
        if (e.data.ok) resolve(e.data.report!);
        else reject(new Error(e.data.error));
      };
      w.onerror = (e) => reject(new Error(e.message));
      // A shown canvas per live run (1080p and 4K, without strips and with), transferred as the output
      // transfers its canvas to its render worker: the live frames are presented and paced by the display.
      const canvases: OffscreenCanvas[] = [];
      if (liveSeconds > 0)
        for (const [cw, ch] of [
          [1920, 1080],
          [1920, 1080],
          [3840, 2160],
          [3840, 2160],
        ] as const) {
          const el = document.createElement('canvas');
          el.width = cw;
          el.height = ch;
          el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;';
          document.body.appendChild(el);
          shown.push(el);
          canvases.push(el.transferControlToOffscreen());
        }
      w.postMessage({ liveSeconds, canvases }, canvases);
    });
}
