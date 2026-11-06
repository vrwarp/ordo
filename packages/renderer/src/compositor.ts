import type { LayerStack } from './stacks.ts';

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
}

export const MAX_VIDEO_SLOTS = 4;
