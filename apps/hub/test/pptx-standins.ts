/**
 * Stand-ins for M3 item C's picture functions (`src/pptx/pictures.ts`) while those are stubs. A test file
 * mocks the module with `pictureStandIns`: each real function is called first, and its stand-in is used only
 * when it throws its "not implemented yet (M3 item C)" error, so once item C lands the tests run against the
 * real picture preparation unchanged. Imports nothing of the hub at run time (the mock factory loads it).
 */
import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Media, Slide } from '@ordo/domain';
import { pictureSize } from '@ordo/pptx-scene';
import type * as Pictures from '../src/pptx/pictures.ts';
import type { PreparedPicture } from '../src/pptx/pictures.ts';
import type { PptxDeps } from '../src/pptx/shared.ts';

/** The error of a stub that M3 item C replaces. */
export function isItemCStub(e: unknown): boolean {
  return e instanceof Error && /not implemented yet \(M3 item C\)/.test(e.message);
}

// ── Stand-ins for item C ────────────────────────────────────────────────────────────────────────────────

/** Calls of the stand-ins (tests check what was prepared). */
export const standIn = { prepared: [] as string[] };

/** Every used part at the widest output. */
export function displayNeedsStandIn(
  _slides: readonly Slide[],
  media: readonly { id: string; part: string }[],
): Map<string, number> {
  return new Map(media.map((m) => [m.part, 3840]));
}

/** Copies the picture (no resizing); format, size and alpha from its header. */
export async function preparePictureStandIn(
  src: string,
  _needPx: number,
  opts: { dir: string },
): Promise<PreparedPicture> {
  const fh = await open(src, 'r');
  const head = new Uint8Array(64 * 1024);
  const { bytesRead } = await fh.read(head, 0, head.length, 0);
  await fh.close();
  const b = head.subarray(0, bytesRead);
  const px = pictureSize(b);
  const png = b[0] === 0x89 && b[1] === 0x50;
  const jpeg = b[0] === 0xff && b[1] === 0xd8;
  if (!px || !(png || jpeg)) throw new Error('not a picture this stand-in accepts');
  standIn.prepared.push(src);
  const bytes = await readFile(src);
  const ext = png ? 'png' : 'jpg';
  const path = join(opts.dir, `prepared-${standIn.prepared.length}.${ext}`);
  await writeFile(path, bytes);
  return {
    path,
    ext,
    mime: png ? 'image/png' : 'image/jpeg',
    width: px.w,
    height: px.h,
    // PNG colour types 4 and 6 carry alpha.
    hasAlpha: png && (b[25] === 4 || b[25] === 6),
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    notes: [],
  };
}

/** Stores the picture as a ready image, reusing an item with the same bytes. */
export async function addReadyPictureStandIn(
  deps: PptxDeps,
  picture: PreparedPicture,
  opts: { name: string; tags: string[] },
): Promise<Media> {
  const hash = createHash('sha256')
    .update(await readFile(picture.path))
    .digest('hex');
  const existing = deps.lib.media.list().find((m) => m.original.hash === hash);
  if (existing) return existing;
  const m = await deps.media.addReadyImage(picture.path, opts.name, {
    width: picture.width,
    height: picture.height,
    tags: opts.tags,
  });
  return deps.lib.media.update(m.id, { ...m, hasAlpha: picture.hasAlpha });
}

/** The module with each stub falling back to its stand-in. */
export function pictureStandIns(real: typeof Pictures): typeof Pictures {
  const sync =
    <A extends unknown[], R>(f: (...a: A) => R, g: (...a: A) => R) =>
    (...a: A): R => {
      try {
        return f(...a);
      } catch (e) {
        if (isItemCStub(e)) return g(...a);
        throw e;
      }
    };
  const later =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>, g: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await f(...a);
      } catch (e) {
        if (isItemCStub(e)) return g(...a);
        throw e;
      }
    };
  return {
    ...real,
    displayNeeds: sync(real.displayNeeds, displayNeedsStandIn),
    preparePicture: later(real.preparePicture, preparePictureStandIn),
    addReadyPicture: later(real.addReadyPicture, addReadyPictureStandIn),
  };
}
