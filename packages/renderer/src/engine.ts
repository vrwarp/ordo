import type { Rgba } from '@ordo/domain';
import { Canvas2DCompositor } from './canvas2d.ts';
import { type Compositor, type FrameInputs, MAX_VIDEO_SLOTS, type VideoFrames } from './compositor.ts';
import { FrameRing } from './frame-ring.ts';
import { type GpuInit, createGpuCompositor } from './gpu.ts';
import type { RenderTelemetry } from './health.ts';
import type { HeldKeys } from './messages.ts';
import { LAYERS, LAYER_INDEX, LayerStack, type StackContent } from './stacks.ts';
import { FrameClock, flipDue } from './timing.ts';

/**
 * The render worker's engine: two stacks per layer, the frame loop, flips against hub time, telemetry,
 * snapshots and device-loss recovery. The compositor (WebGPU, or Canvas 2D when WebGPU is unavailable)
 * only draws what the stacks hold.
 */

export type EngineHost = {
  raf: (cb: (ts: number) => void) => number;
  /** Wall clock in ms (Date.now-like, sub-ms where possible). */
  wallNow: () => number;
  onHeld?: (layers: HeldKeys[]) => void;
  /**
   * A downscaled copy of the frame just drawn, with the slide cue it shows (-1 none). The main thread
   * keeps its own copy of it as the hold image (a bitmap from this worker dies with the worker).
   */
  onSnapshot?: (bitmap: ImageBitmap, cue: number) => void;
  onLost?: (reason: string) => void;
  onRestored?: (kind: 'webgpu' | '2d') => void;
  /**
   * A fresh canvas from the main thread (needed to switch between WebGPU and Canvas 2D, since a canvas
   * keeps its first context kind). The main thread shows it only once `onRestored` (or the ready result)
   * says the engine draws on it; `canvasUnused` tells it the canvas was not adopted.
   */
  requestCanvas?: () => Promise<OffscreenCanvas>;
  canvasUnused?: () => void;
  /** Override of the WebGPU compositor factory (tests). */
  createGpu?: (init: GpuInit) => Promise<Compositor>;
  /** Override of the adapter probe that finds software adapters (tests); see `isFallbackAdapter`. */
  probeAdapter?: () => Promise<unknown>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
};

export type EngineOptions = {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  testPixel: boolean;
  forceCanvas2d?: boolean;
  /**
   * Use WebGPU even on a software adapter (`isFallbackAdapter`, SwiftShader), which otherwise gets Canvas 2D
   * (design/27 §7.2). For tests that exercise the WebGPU compositor in headless Chromium.
   */
  allowFallbackAdapter?: boolean;
  clear: Rgba;
  clockOffset: number;
  /**
   * After a fallback to Canvas 2D, try WebGPU again after this long (doubling up to GPU_RETRY_MAX_MS);
   * 0 disables the retry. Default 60 s.
   */
  gpuRetryMs?: number;
  /** WebGPU upload budget per frame (GpuInit; defaults in gpu.ts), for the venue measurements. */
  uploadBudgetBytes?: number;
  uploadBudgetMs?: number;
};

export const GPU_RETRY_MAX_MS = 15 * 60_000;
/** Snapshots (the hold image and the program view) are never taken more often than this. */
export const SNAP_MIN_MS = 140;
/** A new or rebuilt compositor is not copied before it has drawn this long. */
export const SNAP_SETTLE_MS = 1000;

/** Whether a WebGPU adapter is a software fallback (`GPUAdapterInfo.isFallbackAdapter`, or the older flag). */
export function isFallbackAdapter(adapter: unknown): boolean {
  if (!adapter || typeof adapter !== 'object') return false;
  const a = adapter as { isFallbackAdapter?: unknown; info?: { isFallbackAdapter?: unknown } };
  return a.info?.isFallbackAdapter === true || a.isFallbackAdapter === true;
}

/** The adapter createGpuCompositor would get, or null without WebGPU. Never binds a canvas. */
async function probeAdapter(): Promise<GPUAdapter | null> {
  const gpu = (globalThis.navigator as (Navigator & { gpu?: GPU }) | undefined)?.gpu;
  if (!gpu) return null;
  try {
    return await gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    return null;
  }
}

export class RenderEngine {
  readonly layers: LayerStack<ImageBitmap>[] = LAYERS.map(
    () => new LayerStack<ImageBitmap>((b) => b.close()),
  );
  readonly video: VideoFrames = {
    frames: Array.from({ length: MAX_VIDEO_SLOTS }, () => null),
    version: new Int32Array(MAX_VIDEO_SLOTS),
    gen: new Int32Array(MAX_VIDEO_SLOTS).fill(-1),
  };
  /** The two newest frames of each slot; presents one per slot into `video` before each draw. */
  readonly videoRing = new FrameRing(this.video);
  readonly clock = new FrameClock(600);
  private compositor: Compositor | null = null;
  private inputs: FrameInputs;
  private offset = 0;
  private running = false;
  private rebuilding = false;
  private gpuContextUsed = false;
  private gpuDisabled?: string;
  private lossTimes: number[] = [];
  private gpuRetryDelay = 0;
  private gpuRetrying = false;
  gpuLost = 0;
  /** WebGPU retries after a Canvas 2D fallback (attempted / succeeded), for diagnostics. */
  gpuRetries = 0;
  longTasks = 0;
  error?: string;
  kind: 'webgpu' | '2d' | 'none' = 'none';
  // Test pixel marker: the slide cue to show when the slide layer itself draws nothing.
  private markerPending = false;
  private markerCue = -1;
  private markerAt = 0;
  private markerLive = -1;
  /** Hub time of the frame that first drew `markerLive` (e2e: the outputs' flip skew). */
  private markerFlipAt = 0;
  // Snapshots
  private snapEvery = 1000;
  private snapLast = 0;
  private snapBusy = false;
  /** The slide cue shown in the frame being copied. */
  private snapCue = -1;
  /**
   * No snapshot before this (hub ms): a compositor just created or rebuilt is not copied for its first
   * SNAP_SETTLE_MS (a failing GPU presents garbage, white, before it reports the device lost).
   */
  private snapNotBefore = 0;
  /** Flips counted at the last snapshot: a settled flip takes a fresh one at once (the hold stays current). */
  private snapFlips = 0;
  private snapOpts: ImageBitmapOptions = { resizeWidth: 640, resizeHeight: 360, resizeQuality: 'low' };
  private readonly onSnapDone = (b: ImageBitmap) => {
    this.snapBusy = false;
    if (this.rebuilding || !this.compositor) {
      // Copied from a canvas whose device was lost meanwhile: its pixels are not the picture (white).
      b.close();
      return;
    }
    if (this.host.onSnapshot) this.host.onSnapshot(b, this.snapCue);
    else b.close();
  };
  private readonly onSnapFail = () => {
    this.snapBusy = false;
    this.snapEvery = 0; // the canvas cannot be copied on this platform; stop trying
  };
  private readonly frame = (ts: number) => this.onFrame(ts);
  /** Flip times of the layers waiting for an upload this frame (`tickLayers`). */
  private readonly waitingAt = new Float64Array(LAYERS.length);

  private opts: EngineOptions;
  private host: EngineHost;
  constructor(opts: EngineOptions, host: EngineHost) {
    this.opts = opts;
    this.host = host;
    this.offset = opts.clockOffset;
    this.inputs = {
      layers: this.layers,
      video: this.video,
      now: 0,
      clear: new Float32Array(4),
      testPixel: new Int32Array([opts.testPixel ? 0 : -1, 0, 0]),
    };
    this.setClear(opts.clear);
  }

  get width(): number {
    return this.opts.width;
  }
  get height(): number {
    return this.opts.height;
  }

  /** Create the compositor (WebGPU first) and start the frame loop. */
  async start(): Promise<{ kind: 'webgpu' | '2d'; note?: string }> {
    const r = await this.createCompositor();
    this.running = true;
    this.host.raf(this.frame);
    this.scheduleGpuRetry();
    return r;
  }

  /** Whether WebGPU is worth trying again: fell back to 2D without being told to stay there. */
  private gpuRetryWanted(): boolean {
    return (
      this.running &&
      this.kind === '2d' &&
      !this.opts.forceCanvas2d &&
      !this.gpuDisabled &&
      !this.rebuilding &&
      !this.gpuRetrying &&
      (this.opts.gpuRetryMs ?? 60_000) > 0 &&
      !!this.host.requestCanvas
    );
  }

  private scheduleGpuRetry(): void {
    if (!this.gpuRetryWanted()) return;
    const base = this.opts.gpuRetryMs ?? 60_000;
    this.gpuRetryDelay = this.gpuRetryDelay ? Math.min(GPU_RETRY_MAX_MS, this.gpuRetryDelay * 2) : base;
    (this.host.setTimeout ?? setTimeout)(() => void this.retryGpu(), this.gpuRetryDelay);
  }

  /**
   * A software adapter (`isFallbackAdapter`, SwiftShader) is treated as no WebGPU (design/27 §7.2): it runs
   * the WebGPU pipelines on the CPU, and in headless Chromium its device is lost several times right after
   * start (design/14). Probed before the canvas is bound, so Canvas 2D keeps the canvas; the slow retry
   * probes again. `allowFallbackAdapter` (`?renderer=webgpu`) uses it anyway.
   */
  private async refuseFallbackAdapter(): Promise<void> {
    if (this.opts.allowFallbackAdapter) return;
    const adapter = await (this.host.probeAdapter ?? probeAdapter)();
    if (isFallbackAdapter(adapter)) throw new Error('the adapter is a software fallback (isFallbackAdapter)');
  }

  /**
   * Try WebGPU again on a fresh canvas while Canvas 2D keeps drawing (review item 27). The first frame
   * is drawn into the new compositor before the swap, so the main thread can show the new canvas
   * without a blank frame; on failure the 2D compositor is untouched and the canvas is given back.
   */
  private async retryGpu(): Promise<void> {
    if (!this.gpuRetryWanted()) return;
    this.gpuRetrying = true;
    this.gpuRetries++;
    let canvas: OffscreenCanvas | undefined;
    let gpu: Compositor | undefined;
    let adopted = false;
    try {
      await this.refuseFallbackAdapter();
      canvas = await this.host.requestCanvas!();
      gpu = await (this.host.createGpu ?? createGpuCompositor)({
        canvas,
        width: this.opts.width,
        height: this.opts.height,
        layerCount: LAYERS.length,
        onLost: (reason) => void this.deviceLost(reason),
        onError: (message) => {
          this.error = `GPU: ${message}`;
        },
        uploadBudgetBytes: this.opts.uploadBudgetBytes,
        uploadBudgetMs: this.opts.uploadBudgetMs,
      });
      if (!this.running || this.rebuilding) {
        const unused = gpu;
        gpu = undefined;
        unused.destroy();
        this.host.canvasUnused?.();
        return;
      }
      // Synchronous from here to the swap: the 2D frame loop never sees the stacks gated for WebGPU, unless
      // the first draw throws (the catch gives them back to the compositor still drawing).
      adopted = true;
      this.adoptStacks(gpu);
      this.prepareHeld(gpu);
      this.drawFrame(gpu);
      const old = this.compositor;
      this.compositor = gpu;
      gpu = undefined;
      this.opts.canvas = canvas;
      this.gpuContextUsed = true;
      this.kind = 'webgpu';
      this.error = undefined;
      this.gpuRetryDelay = 0;
      try {
        old?.destroy();
      } catch {
        /* gone */
      }
      this.host.onRestored?.('webgpu');
    } catch (err) {
      // The stacks were gated for the new compositor (not ready until it uploads them): Canvas 2D, which
      // keeps drawing, never uploads, so give them back to it or no flip to a bitmap would ever happen.
      if (adopted && this.compositor) this.adoptStacks(this.compositor);
      if (gpu) {
        try {
          gpu.destroy();
        } catch {
          /* gone */
        }
      }
      if (canvas) this.host.canvasUnused?.();
      this.error = `WebGPU still unavailable, using Canvas 2D: ${(err as Error).message}`;
      this.gpuRetrying = false;
      this.scheduleGpuRetry();
      return;
    } finally {
      this.gpuRetrying = false;
    }
  }

  private async createCompositor(): Promise<{ kind: 'webgpu' | '2d'; note?: string }> {
    let note: string | undefined;
    if (!this.opts.forceCanvas2d && !this.gpuDisabled) {
      try {
        await this.refuseFallbackAdapter();
        this.compositor = await (this.host.createGpu ?? createGpuCompositor)({
          canvas: this.opts.canvas,
          width: this.opts.width,
          height: this.opts.height,
          layerCount: LAYERS.length,
          onContext: () => {
            this.gpuContextUsed = true;
          },
          onLost: (reason) => void this.deviceLost(reason),
          onError: (message) => {
            this.error = `GPU: ${message}`;
          },
          uploadBudgetBytes: this.opts.uploadBudgetBytes,
          uploadBudgetMs: this.opts.uploadBudgetMs,
        });
        this.kind = 'webgpu';
        this.error = undefined;
        this.adoptStacks(this.compositor);
        this.prepareHeld(this.compositor);
        return { kind: 'webgpu' };
      } catch (err) {
        note = `WebGPU unavailable, using Canvas 2D: ${(err as Error).message}`;
      }
    } else if (this.gpuDisabled) note = this.gpuDisabled;
    if (this.gpuContextUsed) {
      // A canvas bound to WebGPU cannot give a 2D context: ask the main thread for a fresh one.
      if (!this.host.requestCanvas) throw new Error('cannot switch to Canvas 2D without a fresh canvas');
      this.opts.canvas = await this.host.requestCanvas();
      this.gpuContextUsed = false;
    }
    this.compositor = new Canvas2DCompositor(this.opts.canvas, this.opts.width, this.opts.height);
    this.kind = '2d';
    if (note) this.error = note;
    this.adoptStacks(this.compositor);
    this.prepareHeld(this.compositor);
    return { kind: '2d', note };
  }

  /**
   * A new or rebuilt compositor uploads every held stack again; one that uploads (WebGPU) gates flips on
   * its uploads (`LayerStack.gated`, design/27 §7.3), so held content that is not on screen becomes ready
   * only once it is uploaded again. What is on screen is uploaded before the first draw.
   */
  private adoptStacks(c: Compositor): void {
    const gated = typeof c.drainUploads === 'function';
    for (const ls of this.layers) ls.resetUploads(gated);
  }

  /**
   * Hand a new or rebuilt compositor every stack the layers hold (`Compositor.prepare`), so what it
   * allocates per content (a scene's over textures) exists before the re-upload, as after an offer.
   */
  private prepareHeld(c: Compositor): void {
    if (!c.prepare) return;
    for (let l = 0; l < this.layers.length; l++) {
      const ls = this.layers[l]!;
      for (const s of ls.stacks) if (s.key !== '') c.prepare(l, s);
      if (ls.hasQueued && ls.queued.key !== '') c.prepare(l, ls.queued);
    }
  }

  /**
   * device.lost: rebuild the device and pipelines and re-upload every held bitmap; flips keep being
   * scheduled meanwhile. A device that keeps getting lost (3 times in a minute) is abandoned for the
   * Canvas 2D compositor so the screen stays up.
   */
  private async deviceLost(reason: string): Promise<void> {
    if (this.rebuilding) return;
    this.rebuilding = true;
    this.gpuLost++;
    const now = this.host.wallNow();
    this.lossTimes = this.lossTimes.filter((t) => now - t < 60_000);
    this.lossTimes.push(now);
    if (this.lossTimes.length >= 3)
      this.gpuDisabled = `WebGPU device lost ${this.lossTimes.length} times in a minute (${reason}); using Canvas 2D`;
    this.host.onLost?.(reason);
    const old = this.compositor;
    this.compositor = null;
    try {
      old?.destroy();
    } catch {
      /* lost already */
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 50 : 500));
        const r = await this.createCompositor(); // re-uploads every held stack (adoptStacks)
        this.snapEvery = this.snapEvery || 1000;
        // The rebuilt compositor is copied once it has drawn for SNAP_SETTLE_MS: the main thread
        // uncovers the screen on that copy.
        this.snapLast = 0;
        this.snapNotBefore = 0;
        this.rebuilding = false;
        this.host.onRestored?.(r.kind);
        this.scheduleGpuRetry();
        return;
      } catch (err) {
        this.error = `GPU rebuild failed: ${(err as Error).message}`;
        if (attempt >= 2) this.gpuDisabled = this.error;
      }
    }
    this.rebuilding = false;
  }

  hubNow(): number {
    return this.host.wallNow() + this.offset;
  }

  setClockOffset(offset: number): void {
    this.offset = offset;
  }

  setClear(c: Rgba): void {
    const a = c.a ?? 1;
    // Opaque output: premultiply over black.
    this.inputs.clear[0] = (c.r / 255) * a;
    this.inputs.clear[1] = (c.g / 255) * a;
    this.inputs.clear[2] = (c.b / 255) * a;
    this.inputs.clear[3] = 1;
  }

  offer(layer: number, c: StackContent<ImageBitmap>): void {
    const ls = this.layers[layer];
    if (!ls) {
      if (c.bitmap) c.bitmap.close();
      if (c.over) c.over.close();
      return;
    }
    this.compositor?.prepare?.(layer, c);
    ls.offer(c);
  }

  flip(layer: number, key: string, at: number, fadeMs: number, cueIndex?: number): void {
    const ls = this.layers[layer];
    if (!ls) return;
    ls.requestFlip(key, at, fadeMs, this.hubNow());
    if (layer === LAYER_INDEX.slide && cueIndex !== undefined) {
      this.markerPending = true;
      this.markerCue = cueIndex;
      this.markerAt = at;
    }
  }

  /**
   * A frame of a slot (`vframe`), tagged with the slot generation it was loaded under and, while its element
   * plays, the hub time of media time 0 (`startedAt`, NaN: none) and the clip length when it loops: the
   * slot keeps its two newest frames and presents the one due (frame-ring.ts). `null` clears the slot
   * (`vclear`). The engine owns the frame from here and closes it.
   */
  setVideoFrame(slot: number, frame: VideoFrame | null, gen = -1, startedAt = Number.NaN, loopMs = 0): void {
    if (frame) this.videoRing.push(slot, frame, gen, startedAt, loopMs, this.hubNow(), this.clock.frameMs);
    else this.videoRing.clear(slot);
  }

  setSnapshot(everyMs: number, width: number, height: number): void {
    this.snapEvery = everyMs;
    this.snapOpts = { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' };
  }

  heldKeys(): HeldKeys[] {
    return this.layers.map((l) => l.heldKeys());
  }

  /** Report held keys if any layer changed (called from a timer, not from the frame loop). */
  flushHeld(): void {
    let dirty = false;
    for (const l of this.layers) if (l.dirty) dirty = true;
    if (!dirty) return;
    for (const l of this.layers) l.dirty = false;
    this.host.onHeld?.(this.heldKeys());
  }

  telemetry(): RenderTelemetry {
    let late = 0;
    for (const l of this.layers) late += l.lateFlips;
    const gpuBytes = this.compositor?.gpuBytes?.();
    const uploadMs = this.compositor?.uploadMs?.();
    const whole = this.compositor?.wholeUploads?.();
    return {
      presented: this.clock.presented,
      missed: this.clock.missed,
      lateFlips: late,
      // Long tasks in a worker are not observable; rAF stalls (gaps of 50 ms or more) are the measure.
      longTasks: this.longTasks + this.clock.stalls,
      gpuLost: this.gpuLost,
      fps: this.clock.fps(),
      frameMs: this.clock.frameMs,
      compositor: this.kind,
      error: this.error,
      slideCue: this.markerLive,
      slideFlipAt: this.markerFlipAt,
      ...(gpuBytes !== undefined ? { gpuMB: Math.round(gpuBytes / 1e5) / 10 } : {}),
      ...(uploadMs !== undefined ? { uploadMs } : {}),
      ...(whole?.count ? { wholeUploads: whole } : {}),
    };
  }

  /** Stop the frame loop and close the video frames held. */
  stop(): void {
    this.running = false;
    this.videoRing.release();
  }

  private onFrame(ts: number): void {
    /* @hot */
    if (!this.running) return;
    this.host.raf(this.frame);
    const now = this.hubNow();
    const frameMs = this.clock.frameMs;
    this.inputs.now = now;
    this.tickLayers(now, frameMs, false);
    const c = this.compositor;
    // A flip held for its upload: what fits this frame's budget is uploaded now and flips on time.
    if (c?.uploadDue?.(this.inputs, now, frameMs)) this.tickLayers(now, frameMs, true);
    if (
      this.markerPending &&
      flipDue(now, this.markerAt, frameMs) &&
      !this.layers[LAYER_INDEX.slide]!.flipPending
    ) {
      this.markerPending = false;
      this.markerLive = this.markerCue;
      this.markerFlipAt = now;
    }
    this.videoRing.select(now, frameMs);
    if (this.opts.testPixel) this.updateTestPixel();
    if (!c) return; // rebuilding after device loss; the main thread shows the last frame copy
    try {
      this.drawFrame(c);
    } catch (err) {
      this.error = `draw failed: ${(err as Error).message}`; // alloc-ok (error path)
      return;
    }
    this.clock.tick(ts);
    // Canvas 2D never presents garbage: its first frame can be copied at once (review F2).
    if (this.snapNotBefore === 0) this.snapNotBefore = this.kind === '2d' ? now : now + SNAP_SETTLE_MS;
    if (this.snapEvery > 0 && !this.snapBusy && now >= this.snapNotBefore) {
      // A flip that has settled (no layer fading) is copied at once, else every snapEvery ms; never more
      // often than SNAP_MIN_MS. Rare path: an async GPU copy, not per-frame work.
      let flips = 0;
      let fading = false;
      for (let i = 0; i < this.layers.length; i++) {
        const l = this.layers[i]!;
        flips += l.flips;
        if (l.fading || l.flipPending) fading = true;
      }
      const since = now - this.snapLast;
      const settled = flips !== this.snapFlips && !fading;
      if (since >= this.snapEvery || (settled && since >= SNAP_MIN_MS)) {
        this.snapLast = now;
        this.snapBusy = true;
        if (!fading) this.snapFlips = flips;
        const live = this.layers[LAYER_INDEX.slide]!.liveStack;
        this.snapCue = live.key !== '' ? live.cueIndex : this.markerLive;
        createImageBitmap(this.opts.canvas, this.snapOpts).then(this.onSnapDone, this.onSnapFail);
      }
    }
  }

  /**
   * Tick every layer (`pending`: only those with a flip pending). The layers of one cue flip together
   * (design/27 §7.3): flips due at the same hub time `at` (one GO) wait while any of them is still
   * uploading its content (`LayerStack.uploadWaiting`), so a new background never shows with the old slide
   * for the frames the other layer's strips take. Content that has not arrived does not hold the others
   * (it flips late on its own, as before strips).
   */
  private tickLayers(now: number, frameMs: number, pending: boolean): void {
    /* @hot */
    const waits = this.waitingAt;
    let n = 0;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i]!;
      if (l.uploadWaiting(now, frameMs)) waits[n++] = l.flipAt;
    }
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i]!;
      if (pending && !l.flipPending) continue;
      let hold = false;
      for (let k = 0; k < n; k++) if (waits[k] === l.flipAt) hold = true;
      l.tick(now, frameMs, hold && l.flipPending);
    }
  }

  /**
   * Draw one frame on `c`. Texture uploads stay out of `draw` (design/27 §7.3): what this frame samples is
   * uploaded just before it, the rest (content armed for a coming flip) after its submit, off the frame's
   * critical path, in strips within the compositor's per-frame budget.
   */
  private drawFrame(c: Compositor): void {
    /* @hot */
    c.drainUploads?.(this.inputs, false);
    c.draw(this.inputs);
    c.drainUploads?.(this.inputs, true);
  }

  private updateTestPixel(): void {
    /* @hot */
    const live = this.layers[LAYER_INDEX.slide]!.liveStack;
    // The displayed slide's cue; when this look draws nothing for the slide, the cue whose flip time
    // has passed (a held flip keeps the previous marker until it really flips).
    const cue = live.key !== '' ? live.cueIndex : this.markerLive;
    const px = this.inputs.testPixel;
    if (cue < 0) {
      px[0] = 0;
      px[1] = 0;
      px[2] = 0;
    } else {
      px[0] = cue & 255;
      px[1] = (cue >> 8) & 255;
      px[2] = 255;
    }
  }
}
