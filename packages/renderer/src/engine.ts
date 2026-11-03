import type { Rgba } from '@ordo/domain';
import { Canvas2DCompositor } from './canvas2d.ts';
import { type Compositor, type FrameInputs, MAX_VIDEO_SLOTS, type VideoFrames } from './compositor.ts';
import { createGpuCompositor } from './gpu.ts';
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
  onSnapshot?: (bitmap: ImageBitmap) => void;
  onLost?: (reason: string) => void;
  onRestored?: (kind: 'webgpu' | '2d') => void;
  /** A fresh canvas from the main thread (needed to switch from WebGPU to Canvas 2D). */
  requestCanvas?: () => Promise<OffscreenCanvas>;
};

export type EngineOptions = {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  testPixel: boolean;
  forceCanvas2d?: boolean;
  clear: Rgba;
  clockOffset: number;
};

export class RenderEngine {
  readonly layers: LayerStack<ImageBitmap>[] = LAYERS.map(() => new LayerStack<ImageBitmap>((b) => b.close()));
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
  gpuLost = 0;
  longTasks = 0;
  error?: string;
  kind: 'webgpu' | '2d' | 'none' = 'none';
  // Test pixel marker: the slide cue to show when the slide layer itself draws nothing.
  private markerPending = false;
  private markerCue = -1;
  private markerAt = 0;
  private markerLive = -1;
  // Snapshots
  private snapEvery = 1000;
  private snapLast = 0;
  private snapBusy = false;
  private snapOpts: ImageBitmapOptions = { resizeWidth: 640, resizeHeight: 360, resizeQuality: 'low' };
  private readonly onSnapDone = (b: ImageBitmap) => {
    this.snapBusy = false;
    if (this.host.onSnapshot) this.host.onSnapshot(b);
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
    return r;
  }

  private async createCompositor(): Promise<{ kind: 'webgpu' | '2d'; note?: string }> {
    let note: string | undefined;
    if (!this.opts.forceCanvas2d && !this.gpuDisabled) {
      try {
        this.compositor = await createGpuCompositor({
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
        this.rebuilding = false;
        this.host.onRestored?.(r.kind);
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
      longTasks: this.longTasks,
      gpuLost: this.gpuLost,
      fps: this.clock.fps(),
      frameMs: this.clock.frameMs,
      compositor: this.kind,
      error: this.error,
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
    if (this.snapEvery > 0 && !this.snapBusy && now - this.snapLast >= this.snapEvery) {
      // Rare path (at most a few times per second): an async GPU copy, not per-frame work.
      this.snapLast = now;
      this.snapBusy = true;
      createImageBitmap(this.opts.canvas, this.snapOpts).then(this.onSnapDone, this.onSnapFail);
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
