/**
 * The one definition of "unedited since the import" (design/27 §11 "Round trip and migration"): a slide's
 * `Slide.pptx.digest` is the digest of the objects the import wrote, the objects with an `origin`. Objects
 * added in ordo (no `origin`) are never part of it, so adding, moving, editing or deleting one never makes
 * the slide edited, before or after a re-import or a LibreOffice follow-up. The native import, the
 * re-import's rebuild and the follow-up's patch all write it with `importDigest`, and test it with
 * `digestMatches`, which also accepts a digest over every object (what slides written before this rule
 * stored: the native jobs wrote only objects with an origin, so those digests are the same value).
 */
import type { SlideObject } from '@ordo/domain';
import { digestOf } from '@ordo/pptx-scene/emit.ts';

/** The digest of the import's objects of a slide: those with an `origin`, in their order. */
export function importDigest(objects: readonly SlideObject[]): string {
  return digestOf(objects.filter((o) => o.origin));
}

/** Whether `digest` (a stored `Slide.pptx.digest` or a follow-up's) still matches the slide's objects. */
export function digestMatches(objects: readonly SlideObject[], digest: string | undefined): boolean {
  if (!digest) return false;
  return importDigest(objects) === digest || digestOf(objects) === digest;
}
