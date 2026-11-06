import { type LayerStack, SRC_BITMAP, type Stack, type StackContent } from './stacks.ts';

/**
 * The video frame each slot presents this frame (chosen by the engine's FrameRing, frame-ring.ts, which owns
 * and closes them). `version[slot]` bumps whenever the presented frame changes.
 */
export type VideoFrames = {
  frames: (VideoFrame | null)[];
  version: Int32Array;
  /**
   * The link's slot generation each held frame was loaded under (-1 none; design/27 §7.2). A scene stack
   * shows its video only while `gen[slot] === stack.videoGen`, so a slot reloaded with another clip never
   * shows up in a slide that still holds the old generation (its poster shows instead).
   */
  gen: Int32Array;
};

/** Per-frame inputs the compositor reads. Pre-allocated by the engine and mutated in place. */
export type FrameInputs = {
  layers: LayerStack<ImageBitmap>[];
  video: VideoFrames;
  now: number;
  /** Premultiplied, opaque clear colour 0..1. */
  clear: Float32Array;
  /** RGB 0..255 of the test pixel, or r < 0 for none. */
  testPixel: Int32Array;
};

/** A compositor draws the two stacks of every layer, back to front, over the clear colour. */
export interface Compositor {
  readonly kind: 'webgpu' | '2d';
  readonly width: number;
  readonly height: number;
  draw(f: FrameInputs): void;
  /**
   * Upload the content of stacks that changed since their last upload, outside `draw` (design/27 §7.3).
   * `all` false: only what the next `draw` samples (each layer's live stack, and its outgoing stack while
   * fading); true: every stack, the armed ones too. The engine calls it with false before each draw and
   * with true after the draw's submit. Compositors that draw bitmaps directly (Canvas 2D) have none.
   */
  drainUploads?(f: FrameInputs, all: boolean): void;
  /**
   * Upload, within the frame's budget, the armed content of every flip due on this frame that is not ready
   * (design/27 §7.3), right after the layers tick: content that fits the budget then flips on time (the
   * engine ticks those layers again), larger content keeps the previous picture and flips once its last
   * strip is in. Returns true when it made any stack ready. A compositor without uploads has none.
   */
  uploadDue?(f: FrameInputs, now: number, frameMs: number): boolean;
  /** Forget uploaded textures (after a rebuild everything is re-uploaded from the stacks' bitmaps). */
  destroy(): void;
  /**
   * Called by the engine with every content offered to `layer`, before the layer stack takes it, and with
   * every stack the layers hold once the compositor is created or rebuilt: the place to allocate what the
   * content needs (WebGPU: a scene's `over` textures, design/27 §7.2), never on a flip or in `draw`.
   */
  prepare?(layer: number, c: StackContent<ImageBitmap>): void;
  /**
   * GPU memory the compositor holds for layer content (layer textures plus scene over textures), in bytes,
   * reported as health `gpuMB` (design/27 §13). Canvas 2D holds none.
   */
  gpuBytes?(): number;
  /**
   * The longest time one frame spent uploading over the last UploadMeter.FRAMES frames that uploaded
   * (ms of the render worker's CPU time in the copies, not GPU time), reported as telemetry `uploadMs`.
   */
  uploadMs?(): number;
}

/**
 * Where a frame's drawing starts (design/27 §7.1 opaque-first): the top-most of the first `n` layers whose
 * live content is a full-frame opaque bitmap (`Stack.opaque`) shown at full weight (not fading). It hides
 * every layer under it and the clear colour, so a compositor draws from it, without blending; 0 when there
 * is none.
 */
export function opaqueFrom(
  layers: LayerStack<ImageBitmap>[],
  n: number,
  width: number,
  height: number,
): number {
  /* @hot */
  for (let l = n - 1; l > 0; l--) if (opaqueLive(layers[l]!, width, height)) return l;
  return 0;
}

/** Whether a layer shows a full-frame opaque bitmap at full weight this frame (see `opaqueFrom`). */
export function opaqueLive(ls: LayerStack<ImageBitmap>, width: number, height: number): boolean {
  /* @hot */
  if (ls.fading) return false;
  const s = ls.stacks[ls.live]!;
  const b = s.bitmap;
  return (
    s.kind === SRC_BITMAP &&
    s.opaque &&
    b !== null &&
    s.x === 0 &&
    s.y === 0 &&
    b.width >= width &&
    b.height >= height
  );
}

/**
 * The CPU time a compositor spends uploading per frame (design/27 §13 `uploadMs`): the drain before the
 * draw and the one after its submit are one frame. Keeps the last FRAMES frames that uploaded anything.
 */
export class UploadMeter {
  static readonly FRAMES = 128;
  private readonly ring = new Float32Array(UploadMeter.FRAMES);
  private at = 0;
  private acc = 0;
  private t0 = 0;
  private running = false;
  /** Copies (or upload work) in this frame so far. */
  work = 0;

  begin(): void {
    /* @hot */
    this.acc = 0;
    this.work = 0;
    this.resume();
  }

  resume(): void {
    /* @hot */
    this.t0 = performance.now();
    this.running = true;
  }

  pause(): void {
    /* @hot */
    if (this.running) this.acc += performance.now() - this.t0;
    this.running = false;
  }

  /** Upload time of this frame so far, ms. */
  elapsed(): number {
    /* @hot */
    return this.running ? this.acc + performance.now() - this.t0 : this.acc;
  }

  /** Close the frame: it counts when it uploaded anything (`work`). */
  end(): void {
    /* @hot */
    this.pause();
    if (this.work > 0) {
      this.ring[this.at] = this.acc;
      this.at = (this.at + 1) % UploadMeter.FRAMES;
    }
    this.acc = 0;
    this.work = 0;
  }

  max(): number {
    let m = 0;
    for (let i = 0; i < this.ring.length; i++) if (this.ring[i]! > m) m = this.ring[i]!;
    return Math.round(m * 100) / 100;
  }
}

export const MAX_VIDEO_SLOTS = 4;

/**
 * Whether a scene stack draws its video this frame (design/27 §7.2): its slot holds a frame loaded under
 * the stack's generation. A stack without a known generation (videoGen < 0) never shows a frame, so a
 * reused slot cannot show another clip in the slide; its poster in the base shows instead.
 */
export function sceneVideoPresent(s: Stack<unknown>, v: VideoFrames): boolean {
  /* @hot */
  const slot = s.videoSlot;
  return (
    slot >= 0 &&
    slot < MAX_VIDEO_SLOTS &&
    s.videoGen >= 0 &&
    v.frames[slot] != null &&
    v.gen[slot] === s.videoGen
  );
}
