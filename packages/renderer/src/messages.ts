import type { Font, Look, Rgba, Slide } from '@ordo/domain';
import type { RenderTelemetry } from './health.ts';
import type { PropsModel } from './props.ts';

/**
 * Typed messages between the output's main thread, link worker, render worker and asset worker. They
 * carry transferables (OffscreenCanvas, ImageBitmap, VideoFrame, MessagePort), which is why they are plain
 * TypeScript unions rather than Zod schemas: every sender and receiver is in this repository and built
 * together.
 *
 * Topology (design/14, design/25): the main thread creates the three workers and three MessageChannels
 * (asset↔render, link↔render, link↔asset) and hands the ends over with a `ports` message, again after any
 * worker restart. Arming (jobs, content, flips) runs link → asset → render without the main thread; the
 * main thread sends the render worker only its canvas, video frames and the snapshot period.
 */

// ---- main/link -> render ----
export type RenderInit = {
  t: 'init';
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  /** Write the live slide cue index into the top-left pixel. */
  testPixel: boolean;
  /** Skip WebGPU (tests, diagnostics). */
  forceCanvas2d?: boolean;
  /** Port from the asset worker (bitmaps arrive here). Deprecated: ports now arrive with `ports`. */
  assetPort?: MessagePort;
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
  /** Main-thread watchdog tick (every 250 ms); the worker reports the longest gap as mainThreadStallMs. */
  | { t: 'tick' }
  /** A fresh canvas, sent in answer to `needCanvas`. */
  | { t: 'canvas'; canvas: OffscreenCanvas }
  /** (main → render) New channel ends after a (re)start: bitmaps from the asset worker, commands from the link. */
  | { t: 'ports'; asset: MessagePort; link: MessagePort };

// ---- asset -> render (via MessagePort) ----
export type AssetToRender = {
  t: 'content';
  layer: number;
  key: string;
  kind: number;
  bitmap: ImageBitmap;
  cueIndex?: number;
  /** A fresh copy of content the renderer may already show (a slide re-drawn with an image that arrived). */
  refresh?: boolean;
};

// ---- render -> main and render -> link (port) ----
export type HeldKeys = { live: string; armed: string; queued: string };
export type FromRender =
  | { t: 'ready'; compositor: 'webgpu' | '2d'; note?: string }
  | { t: 'telemetry'; tel: RenderTelemetry; mainThreadStallMs?: number }
  | { t: 'frames'; frames: number[] }
  | { t: 'held'; layers: HeldKeys[] }
  /** A downscaled frame copy and the slide cue it shows (-1 none). */
  | { t: 'snapshot'; bitmap: ImageBitmap; cue?: number }
  | { t: 'lost'; reason: string }
  | { t: 'restored'; compositor: 'webgpu' | '2d' }
  | { t: 'fatal'; error: string }
  /**
   * Switching between WebGPU and Canvas 2D needs a canvas never bound to the other context. The main
   * thread shows the new canvas on the next `ready` or `restored`, and drops it on `canvasUnused`.
   */
  | { t: 'needCanvas' }
  | { t: 'canvasUnused' };

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
      /** Re-draw of a key the renderer holds: it replaces the held copy in place (no flip). */
      refresh?: boolean;
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
  | { t: 'init'; port?: MessagePort; width: number; height: number; token: string; apiPrefix: string }
  /** (main → asset) New channel ends after a (re)start: bitmaps go to `render`, jobs arrive on `link`. */
  | { t: 'ports'; render: MessagePort; link: MessagePort }
  | { t: 'fonts'; fonts: FontLoad[] }
  | { t: 'job'; job: AssetJob }
  | { t: 'resize'; width: number; height: number }
  /** Drop cached image bitmaps not in `keep` (manifest changed). */
  | { t: 'prune'; keep: string[] };

// ---- asset -> link (port) ----
export type FromAsset =
  | {
      t: 'done';
      layer: number;
      key: string;
      ms: number;
      /** Font families the job asked for that are not loaded; drawn in the fallback font. */
      fontFallbacks?: string[];
      /** Images left out because the cue's decoded-bitmap budget was exhausted. */
      skippedImages?: number;
      /**
       * Hashes of the slide's images whose file could not be read (not cached, hub did not serve it): the
       * slide was drawn without them. The link re-plans the key once such a file arrives.
       */
      missingImages?: string[];
    }
  | {
      t: 'error';
      layer: number;
      key: string;
      error: string;
      /** The file that failed to decode and where it was read from (an OPFS copy may be corrupt). */
      hash?: string;
      source?: 'opfs' | 'network';
      /**
       * `unavailable`: a file could not be read (not cached yet and the hub did not serve it): retried
       * with backoff, never quarantined. `invalid` (default): the content itself failed (decode, raster).
       */
      /** `missing`: the hub answered 404/410 for the file (retried slowly, logged once). */
      cause?: 'unavailable' | 'invalid' | 'missing';
    }
  | {
      t: 'fonts';
      loaded: number;
      failed: string[];
      /**
       * Families (lower-case) whose faces became available with this message, after a font was added or a
       * failed load was retried: slides drawn in a fallback font for them are drawn again.
       */
      ready?: string[];
    };

export function fontLoads(fonts: Font[]): FontLoad[] {
  return fonts.map((f) => ({ family: f.family, weight: f.weight, style: f.style, hash: f.file.hash }));
}
