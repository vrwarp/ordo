/**
 * Picture preparation (design/27 §4 "Pictures", §12 "Media"; M3 item C), so no consumer decodes more than
 * it shows:
 * - the bytes are sniffed and the header checked (PNG, JPEG, GIF, WebP; ≤ 8,192 px a side, ≤ 40 MP after
 *   preparation);
 * - the display need of a part is its widest use in the deck: the box width at 3840 px ÷ the visible crop
 *   fraction, capped at 8,192 px;
 * - a source more than 1.25× its need is downscaled by ffmpeg: JPEG q90 when opaque, PNG or lossless WebP
 *   with alpha; TIFF and BMP become PNG; animated GIF, APNG and animated WebP a first-frame PNG (logged);
 * - stored ready through `addReadyPicture` (no media job), deduplicated by SHA-256 of the prepared bytes
 *   plus the source part's hash. The original stays in the stored deck.
 */
import type { Media, Slide } from '@ordo/domain';
import type { PptxDeps } from './shared.ts';
import { notYet } from './shared.ts';

export const PICTURE_LIMITS = {
  /** Largest side of a prepared picture. */
  side: 8_192,
  /** Largest prepared picture, in megapixels. */
  megapixels: 40,
  /** The output width a display need is computed for. */
  displayWidth: 3_840,
  /** A source is downscaled when it is more than this many times its display need. */
  downscaleOver: 1.25,
} as const;

/** What a picture's first bytes say. */
export type PictureHeader = {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'other';
  width: number;
  height: number;
  animated: boolean;
  /** Known from the header (PNG colour type, WebP flags); undefined when only decoding can tell. */
  alpha?: boolean;
};

/** Read a picture header from its first bytes; undefined when it is not a picture ordo accepts. */
export function pictureHeader(head: Uint8Array): PictureHeader | undefined {
  void head;
  throw notYet('C', 'pictureHeader');
}

/**
 * The display need in px of every picture part the slides use (`media` maps their placeholder ids to parts,
 * `EmitResult.media`): its widest box at `displayWidth` ÷ the visible crop fraction, capped at `side`.
 */
export function displayNeeds(
  slides: readonly Slide[],
  media: readonly { id: string; part: string }[],
): Map<string, number> {
  void slides;
  void media;
  throw notYet('C', 'displayNeeds');
}

export type PreparedPicture = {
  /** The prepared file (a scratch file `addReadyPicture` moves into the store). */
  path: string;
  ext: 'png' | 'jpg' | 'gif' | 'webp';
  mime: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  /** SHA-256 of the source part: with the prepared bytes' hash, the dedup key. */
  sourceHash: string;
  /** What was changed (downscaled, converted, first frame), for the job log. */
  notes: string[];
};

/** Prepare the picture at `src` for a display need of `needPx` (ffmpeg through `tools.run`). */
export async function preparePicture(
  src: string,
  needPx: number,
  opts: { dir: string; timeoutMs: number; signal: AbortSignal },
): Promise<PreparedPicture> {
  void src;
  void needPx;
  void opts;
  throw notYet('C', 'preparePicture');
}

/** Store a prepared picture as a ready image media item (no job), or return the one already stored. */
export async function addReadyPicture(
  deps: PptxDeps,
  picture: PreparedPicture,
  opts: { name: string; tags: string[] },
): Promise<Media> {
  void deps;
  void picture;
  void opts;
  throw notYet('C', 'addReadyPicture');
}
