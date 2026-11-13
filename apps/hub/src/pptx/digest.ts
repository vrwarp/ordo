/**
 * The one definition of "unedited since the import" (design/27 §11 "Round trip and migration"): a slide's
 * `Slide.pptx.digest` is the digest of the objects the import wrote, the objects with an `origin`. Objects
 * added in ordo (no `origin`) are never part of it, so adding, moving, editing or deleting one never makes
 * the slide edited, before or after a re-import or a LibreOffice follow-up. The native import (the import
 * core, `@ordo/importers` `pptx-core.ts`, which the client's assembly shares), the re-import's rebuild and the
 * follow-up's patch all write it with `importDigest`, and test it with `digestMatches`, which also accepts a
 * digest over every object (what slides written before this rule stored: the native jobs wrote only objects
 * with an origin, so those digests are the same value).
 */
export { digestMatches, importDigest } from '@ordo/importers/pptx-core.ts';
