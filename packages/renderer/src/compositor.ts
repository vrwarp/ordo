import type { LayerStack, Stack, StackContent } from './stacks.ts';

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
  /** Forget uploaded textures (after a rebuild everything is re-uploaded from the stacks' bitmaps). */
  destroy(): void;
  /**
   * Called by the engine with every content offered to `layer`, before the layer stack takes it, and with
   * every stack the layers hold once the compositor is created or rebuilt: the place to allocate what the
   * content needs (WebGPU: a scene's `over` textures, design/27 §7.2), never on a flip or in `draw`.
   */
  prepare?(layer: number, c: StackContent<ImageBitmap>): void;
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
