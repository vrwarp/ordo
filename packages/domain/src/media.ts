/*
 * Media constants that are not schema (design/27 M9 "metafiles"). A vector picture (an EMF or WMF the hub
 * converted to ordo's own vector format, OVP) is an ordinary `Media` of kind 'image' whose `original.mime` is
 * `VECTOR_MIME`, tagged `pptx` and `vector`: the kind enum is not widened, so an older build keeps the item
 * and only fails to decode its file (the object is left out, the slide draws without it).
 */

/** The mime of an OVP file. Only the hub writes one; an upload never sniffs as it. */
export const VECTOR_MIME = 'application/vnd.ordo.vector';

/** The tag a vector picture's media item carries beside `pptx`. */
export const VECTOR_TAG = 'vector';

/** Whether a mime (a `FileRef.mime` or a manifest entry's) names a vector picture. */
export function isVectorMime(mime: unknown): boolean {
  return typeof mime === 'string' && mime.trim().toLowerCase() === VECTOR_MIME;
}
