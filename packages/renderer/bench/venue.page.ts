/// <reference types="@webgpu/types" />

/**
 * Browser side of the venue measurement (bench/venue.ts): what the machine is, its display, and two GPU
 * figures of the output at 1920x1080 and 3840x2160 measured with WebGPU directly:
 * - **upload**: one full-frame `copyExternalImageToTexture` of a CPU-backed ImageBitmap, as the render worker
 *   uploads a slide: the CPU time of the call and the time until the GPU reports the copy done
 *   (`onSubmittedWorkDone`, so queue latency included);
 * - **compose**: five full-frame textured layers alpha-blended in one render pass, the frame of five layers
 *   design/27 §13 budgets, timed by the GPU itself (`timestamp-query`); not measured where the adapter has
 *   no timestamp queries.
 * The slide raster (the asset worker's CPU cost) runs separately (slides.page.ts).
 */

export type Stats = { n: number; p50: number; p95: number; max: number };
export type MachineInfo = {
  userAgent: string;
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  model?: string;
  cores: number;
  deviceMemoryGB?: number;
  screen: { width: number; height: number; devicePixelRatio: number; colorDepth: number };
  /** Median rAF interval over 120 frames, ms (the display's refresh while this page is visible). */
  frameMs?: number;
};
export type GpuInfo = {
  available: boolean;
  error?: string;
  adapter?: { vendor: string; architecture: string; device: string; description: string };
  isFallbackAdapter?: boolean;
  timestampQuery?: boolean;
  maxTextureDimension2D?: number;
  sizes: { width: number; height: number; uploadCpuMs: Stats; uploadDoneMs: Stats; composeGpuMs?: Stats }[];
};
export type VenuePageReport = { machine: MachineInfo; gpu: GpuInfo };

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? 0 };
}

async function machine(measureFrames: boolean): Promise<MachineInfo> {
  const uad = (
    navigator as unknown as {
      userAgentData?: { getHighEntropyValues(k: string[]): Promise<Record<string, string>> };
    }
  ).userAgentData;
  const hi = uad
    ? await uad
        .getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'model'])
        .catch(() => ({}))
    : {};
  let frameMs: number | undefined;
  if (measureFrames) {
    const gaps: number[] = [];
    let last = 0;
    await new Promise<void>((done) => {
      const step = (t: number) => {
        if (last) gaps.push(t - last);
        last = t;
        if (gaps.length >= 120) done();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setTimeout(done, 5000); // a hidden page has no frames
    });
    if (gaps.length >= 30) frameMs = stats(gaps).p50;
  }
  const h = hi as Record<string, string>;
  return {
    userAgent: navigator.userAgent,
    platform: h.platform,
    platformVersion: h.platformVersion,
    architecture: h.architecture,
    model: h.model || undefined,
    cores: navigator.hardwareConcurrency ?? 0,
    deviceMemoryGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    screen: {
      width: screen.width,
      height: screen.height,
      devicePixelRatio: devicePixelRatio,
      colorDepth: screen.colorDepth,
    },
    frameMs,
  };
}

const SHADER = /* wgsl */ `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}
@fragment fn fs(v: V) -> @location(0) vec4f {
  let c = textureSample(t, s, v.uv);
  return vec4f(c.rgb * 0.8, 0.8);
}`;

/** A full-frame bitmap like a slide's: CPU-backed (as the asset worker's), with some text and a gradient. */
function frameBitmap(w: number, h: number): ImageBitmap {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, 'rgba(30,60,120,1)');
  grad.addColorStop(1, 'rgba(200,120,40,0.6)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.font = `${Math.round(h / 12)}px sans-serif`;
  for (let i = 0; i < 6; i++) g.fillText('Amazing grace, how sweet the sound', w / 10, (h / 8) * (i + 1.5));
  return c.transferToImageBitmap();
}

async function gpu(sizes: readonly [number, number][], runs: number): Promise<GpuInfo> {
  const out: GpuInfo = { available: false, sizes: [] };
  const nav = navigator as Navigator & { gpu?: GPU };
  if (!nav.gpu)
    return { ...out, error: 'navigator.gpu is not available (WebGPU off, or not a secure context)' };
  const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { ...out, error: 'no WebGPU adapter' };
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  out.available = true;
  out.adapter = info
    ? {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
      }
    : undefined;
  out.isFallbackAdapter = (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
  out.timestampQuery = adapter.features.has('timestamp-query');
  out.maxTextureDimension2D = adapter.limits.maxTextureDimension2D;
  const device = await adapter.requestDevice({
    requiredFeatures: out.timestampQuery ? ['timestamp-query'] : [],
  });
  const module = device.createShaderModule({ code: SHADER });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  for (const [w, h] of sizes) {
    if (w > out.maxTextureDimension2D || h > out.maxTextureDimension2D) continue;
    const bitmap = frameBitmap(w, h);
    const usage =
      GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const tex = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage });
    const cpu: number[] = [];
    const done: number[] = [];
    for (let i = 0; i < runs + 2; i++) {
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: tex, premultipliedAlpha: true },
        [w, h],
      );
      const t1 = performance.now();
      await device.queue.onSubmittedWorkDone();
      const t2 = performance.now();
      if (i < 2) continue; // the first copies allocate
      cpu.push(t1 - t0);
      done.push(t2 - t0);
    }
    const row: GpuInfo['sizes'][number] = {
      width: w,
      height: h,
      uploadCpuMs: stats(cpu),
      uploadDoneMs: stats(done),
    };
    if (out.timestampQuery) {
      const target = device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format: 'rgba8unorm',
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
      });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: sampler },
        ],
      });
      const qs = device.createQuerySet({ type: 'timestamp', count: 2 });
      const resolve = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      const read = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      const gpuMs: number[] = [];
      for (let i = 0; i < runs + 2; i++) {
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [
            { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
          ],
          timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        for (let l = 0; l < 5; l++) pass.draw(3);
        pass.end();
        enc.resolveQuerySet(qs, 0, 2, resolve, 0);
        enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
        device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const t = new BigInt64Array(read.getMappedRange().slice(0));
        read.unmap();
        if (i >= 2) gpuMs.push(Number(t[1]! - t[0]!) / 1e6);
      }
      row.composeGpuMs = stats(gpuMs);
      target.destroy();
      qs.destroy();
    }
    out.sizes.push(row);
    tex.destroy();
    bitmap.close();
  }
  device.destroy();
  return out;
}

(window as unknown as { __venue: unknown }).__venue = async (measureFrames: boolean, runs: number) => {
  let g: GpuInfo;
  try {
    g = await gpu(
      [
        [1920, 1080],
        [3840, 2160],
      ],
      runs,
    );
  } catch (err) {
    g = { available: false, error: String((err as Error)?.message ?? err), sizes: [] };
  }
  return { machine: await machine(measureFrames), gpu: g } satisfies VenuePageReport;
};
