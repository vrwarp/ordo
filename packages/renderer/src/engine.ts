import type { Rgba } from '@ordo/domain';
import { Canvas2DCompositor } from './canvas2d.ts';
import { type Compositor, type FrameInputs, MAX_VIDEO_SLOTS, type VideoFrames } from './compositor.ts';
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
  setTimeout?: (fn: () => void, ms: number) => unknown;
};

export type EngineOptions = {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  testPixel: boolean;
  forceCanvas2d?: boolean;
  clear: Rgba;
  clockOffset: number;
  /**
   * After a fallback to Canvas 2D, try WebGPU again after this long (doubling up to GPU_RETRY_MAX_MS);
   * 0 disables the retry. Default 60 s.
   */
  gpuRetryMs?: number;
};

export const GPU_RETRY_MAX_MS = 15 * 60_000;
/** Snapshots (the hold image and the program view) are never taken more often than this. */
export const SNAP_MIN_MS = 140;
/** A new or rebuilt compositor is not copied before it has drawn this long. */
export const SNAP_SETTLE_MS = 1000;

export class RenderEngine {
  readonly layers: LayerStack<ImageBitmap>[] = LAYERS.map(
    () => new LayerStack<ImageBitmap>((b) => b.close()),
  );
  readonly video: VideoFrames = {
    frames: Array.from({ length: MAX_VIDEO_SLOTS }, () => null),
    version: new Int32Array(MAX_VIDEO_SLOTS),
  };
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

  constructor(
    private opts: EngineOptions,
    private host: EngineHost,
  ) {
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
   * Try WebGPU again on a fresh canvas while Canvas 2D keeps drawing (review item 27). The first frame
   * is drawn into the new compositor before the swap, so the main thread can show the new canvas
   * without a blank frame; on failure the 2D compositor is untouched and the canvas is given back.
   */
  private async retryGpu(): Promise<void> {
    if (!this.gpuRetryWanted()) return;
    this.gpuRetrying = true;
    this.gpuRetries++;
    let canvas: OffscreenCanvas | undefined;
    try {
      canvas = await this.host.requestCanvas!();
      const gpu = await (this.host.createGpu ?? createGpuCompositor)({
        canvas,
        width: this.opts.width,
        height: this.opts.height,
        layerCount: LAYERS.length,
        onLost: (reason) => void this.deviceLost(reason),
        onError: (message) => {
          this.error = `GPU: ${message}`;
        },
      });
      if (!this.running || this.rebuilding) {
        gpu.destroy();
        this.host.canvasUnused?.();
        return;
      }
      for (const ls of this.layers) {
        ls.stacks[0].version++;
        ls.stacks[1].version++;
      }
      gpu.draw(this.inputs);
      const old = this.compositor;
      this.compositor = gpu;
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
        });
        this.kind = 'webgpu';
        this.error = undefined;
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
    return { kind: '2d', note };
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
        const r = await this.createCompositor();
        // Force re-upload from the stacks' bitmaps.
        for (const ls of this.layers) {
          ls.stacks[0].version++;
          ls.stacks[1].version++;
        }
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
      return;
    }
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

  setVideoFrame(slot: number, frame: VideoFrame | null): void {
    if (slot < 0 || slot >= MAX_VIDEO_SLOTS) {
      frame?.close();
      return;
    }
    const prev = this.video.frames[slot];
    if (prev && prev !== frame) prev.close();
    this.video.frames[slot] = frame;
    this.video.version[slot]!++;
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
    };
  }

  stop(): void {
    this.running = false;
  }

  private onFrame(ts: number): void {
    /* @hot */
    if (!this.running) return;
    this.host.raf(this.frame);
    const now = this.hubNow();
    const frameMs = this.clock.frameMs;
    this.inputs.now = now;
    for (let i = 0; i < this.layers.length; i++) this.layers[i]!.tick(now, frameMs);
    if (
      this.markerPending &&
      flipDue(now, this.markerAt, frameMs) &&
      !this.layers[LAYER_INDEX.slide]!.flipPending
    ) {
      this.markerPending = false;
      this.markerLive = this.markerCue;
      this.markerFlipAt = now;
    }
    if (this.opts.testPixel) this.updateTestPixel();
    const c = this.compositor;
    if (!c) return; // rebuilding after device loss; the main thread shows the last frame copy
    try {
      c.draw(this.inputs);
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
