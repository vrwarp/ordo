import type { Slide } from '@ordo/domain';
import { type BitmapCache, slidePictures } from '@ordo/renderer';
import type { FramePicture, FramePictures } from '@ordo/renderer/frame.ts';
import {
  type Bitmap,
  FRAME_PICTURE_LIMITS,
  type PictureDecoder,
  type PreloadSteps,
  preloadPictures,
} from '../pictures.ts';

/*
 * The pictures of an underlay frame (renderer `frame.ts` `FramePictures`; design 29 R1): a frame is made object by
 * object, and each picture is decoded and prepared at its size on its own (`preloadPictures` with
 * `FRAME_PICTURE_LIMITS`: one file, its one target), held for the draw call that copies it, and released, so a
 * frame of hundreds of pictures holds one decoded picture at a time. A repeated file and size is a hit in the
 * asset worker's bitmap cache (`BitmapCache`), never a second decode. A file that is not there yet (not cached, the
 * hub did not serve it) is reported by its hash: the object is drawn without it this time, and `arrived` says when
 * the frame is to be made again.
 */

/** What the provider reads from the asset worker. */
export interface FramePictureDeps<B extends Bitmap> {
  readonly cache: BitmapCache<B>;
  /** The job's decoder: its decodes inside the lanes' bound (`jobDecoder`). */
  readonly decoder: PictureDecoder<B>;
  /** Media id to file hash of the job's pictures (`AssetJob.images`). */
  readonly images: Readonly<Record<string, string>>;
  /** The output's size in device px. */
  readonly out: { w: number; h: number };
  /** The job's turns (`Steps`). */
  readonly steps: PreloadSteps;
  /** Whether a failed decode is a file that is not there yet (the worker's `UnavailableError`), not a bad file. */
  isMissing(error: unknown): boolean;
  /** Whether the file is cached (or can be read) now. */
  has(hash: string): Promise<boolean>;
}

/** The identity a picture without a file is reported by: the media id, which no hash names. */
const unknown = (mediaId: string) => `media:${mediaId}`;

/** The frame's pictures from the asset worker's cache and decoder (see the header). */
export function framePictures<B extends Bitmap>(deps: FramePictureDeps<B>): FramePictures {
  return {
    async acquire(o, scale): Promise<FramePicture> {
      const hash = deps.images[o.mediaId];
      // No file is known for the media (the job's map has none): it is waited for by its media id.
      if (!hash) return { lookup: () => undefined, release: () => undefined, missing: unknown(o.mediaId) };
      // What the draw of this one picture asks for (`slidePictures` of a slide of it: its prepared target).
      const uses = slidePictures({ id: 'frame-picture', objects: [o] } as Slide, { scale });
      const pre = await preloadPictures(
        deps.cache,
        deps.decoder,
        { [o.mediaId]: hash },
        uses,
        deps.out,
        FRAME_PICTURE_LIMITS,
        deps.steps,
      );
      const gone = pre.failed.find((f) => deps.isMissing(f.error));
      return {
        lookup: pre.lookup as FramePicture['lookup'],
        release: pre.release,
        ...(gone ? { missing: gone.hash } : {}),
      };
    },
    async arrived(missing) {
      for (const m of missing) {
        if (m.startsWith('media:')) {
          if (deps.images[m.slice('media:'.length)]) return true;
        } else if (await deps.has(m)) return true;
      }
      return false;
    },
  };
}
