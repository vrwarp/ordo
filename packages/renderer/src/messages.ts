import type { Font, Look, Rgba, Slide } from '@ordo/domain';
import type { RenderTelemetry } from './health.ts';
import type { PropsModel } from './props.ts';

/**
 * Typed messages between the output's main thread, render worker and asset worker. They carry
 * transferables (OffscreenCanvas, ImageBitmap, VideoFrame, MessagePort), which is why they are plain
 * TypeScript unions rather than Zod schemas: every sender and receiver is in this repository and built
 * together.
 */

// ---- main -> render ----
export type RenderInit = {
  t: 'init';
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  /** Write the live slide cue index into the top-left pixel. */
  testPixel: boolean;
  /** Skip WebGPU (tests, diagnostics). */
  forceCanvas2d?: boolean;
  /** Port from the asset worker (bitmaps arrive here). */
  assetPort: MessagePort;
  clear: Rgba;
  clockOffset: number;
};

export type ToRender =
  | RenderInit
  | { t: 'clock'; offset: number }
  | { t: 'clear'; color: Rgba }
  /** Video or empty content for a layer stack (bitmaps come from the asset worker). */
  | {
      t: 'content';
      layer: number;
      key: string;
      kind: number;
      videoSlot?: number;
      fit?: number;
      cueIndex?: number;
    }
  | { t: 'flip'; layer: number; key: string; at: number; fadeMs: number; cueIndex?: number }
  | { t: 'vframe'; slot: number; frame: VideoFrame }
  | { t: 'vclear'; slot: number }
  /** Period of the small frame copies sent back to the main thread (0 disables). */
  | { t: 'snapshot'; everyMs: number; width: number; height: number }
  | { t: 'frames' }
  /** A fresh canvas, sent in answer to `needCanvas`. */
  | { t: 'canvas'; canvas: OffscreenCanvas };

// ---- asset -> render (via MessagePort) ----
export type AssetToRender = {
  t: 'content';
  layer: number;
  key: string;
  kind: number;
  bitmap: ImageBitmap;
  cueIndex?: number;
};

// ---- render -> main ----
export type HeldKeys = { live: string; armed: string; queued: string };
export type FromRender =
  | { t: 'ready'; compositor: 'webgpu' | '2d'; note?: string }
  | { t: 'telemetry'; tel: RenderTelemetry }
  | { t: 'frames'; frames: number[] }
  | { t: 'held'; layers: HeldKeys[] }
  | { t: 'snapshot'; bitmap: ImageBitmap }
  | { t: 'lost'; reason: string }
  | { t: 'restored'; compositor: 'webgpu' | '2d' }
  | { t: 'fatal'; error: string }
  /** Switching from WebGPU to Canvas 2D needs a canvas never bound to WebGPU. */
  | { t: 'needCanvas' };

// ---- main -> asset ----
export type FontLoad = { family: string; weight: number; style: 'normal' | 'italic'; hash: string };

export type AssetJob =
  | {
      kind: 'slide';
      layer: number;
      key: string;
      cueIndex: number;
      slide: Slide;
      nextSlide?: Slide;
      isSong: boolean;
      look: Look;
      /** mediaId -> file hash for every image the slide draws. */
      images: Record<string, string>;
    }
  | { kind: 'image'; layer: number; key: string; hash: string; fit: 'contain' | 'cover'; cueIndex?: number }
  | { kind: 'lowerThird'; layer: number; key: string; text: string; look: Look }
  | {
      kind: 'props';
      layer: number;
      key: string;
      model: PropsModel;
      look: Look;
      images: Record<string, string>;
    };

export type ToAsset =
  | { t: 'init'; port: MessagePort; width: number; height: number; token: string; apiPrefix: string }
  | { t: 'fonts'; fonts: FontLoad[] }
  | { t: 'job'; job: AssetJob }
  | { t: 'resize'; width: number; height: number }
  /** Drop cached image bitmaps not in `keep` (manifest changed). */
  | { t: 'prune'; keep: string[] };

// ---- asset -> main ----
export type FromAsset =
  | { t: 'done'; layer: number; key: string; ms: number }
  | { t: 'error'; layer: number; key: string; error: string }
  | { t: 'fonts'; loaded: number; failed: string[] };

export function fontLoads(fonts: Font[]): FontLoad[] {
  return fonts.map((f) => ({ family: f.family, weight: f.weight, style: f.style, hash: f.file.hash }));
}
