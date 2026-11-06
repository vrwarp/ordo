/**
 * The bounded reads of a stored, untrusted .pptx that every pptx job shares (design/27 §12 "Zip"): the native
 * import, the LibreOffice follow-up and reference pictures, the 'Pictures (LibreOffice)' import and the text
 * repair read a deck only through these.
 *
 * - `readDeckXml`: XML and relationship parts in memory (≤ 8 MB each, ≤ 64 MB in all); a larger XML part is
 *   left out and listed; every other part (pictures, media, fonts) an empty placeholder, so relationships
 *   still resolve; embeddings, `vbaProject.bin`, custom XML, document properties and printer settings never
 *   read. Nothing is written to disk.
 * - `spillDeckParts`: only the parts a caller names (the pictures a pool task found referenced), under
 *   generated names, within the spill budget (`PPTX_LIMITS.spillBytes`) and the picture count.
 *
 * Both refuse a zip whose entries' data overlap (`distinct`): a few KB could otherwise name one large
 * stream thousands of times. Entry names never become paths.
 */
import { extractZip } from '@ordo/importers/zip-stream.ts';
import { PPTX_LIMITS } from './shared.ts';

/** Parts never read: OLE payloads, macros, custom XML, document properties and printer settings (§12). */
export const SKIPPED_PART =
  /^(customXml\/|docProps\/|ppt\/embeddings\/|ppt\/printerSettings\/|ppt\/vbaProject\.bin$)/i;
/** XML and relationship parts, kept in memory within the caps. */
export const XML_PART = /\.(xml|rels)$/i;
/** Embedded fonts (M8: decoded on the pool; not read by this wave). */
export const FONT_PART = /^ppt\/fonts\//i;

const EMPTY = new Uint8Array(0);

/** A deck's XML as `readDeckXml` reads it. */
export type DeckXml = {
  /** XML and relationship parts; every other part (and every XML part left out) as an empty placeholder. */
  parts: Map<string, Uint8Array>;
  /** XML parts over `PPTX_LIMITS.xmlPartBytes`, left out (at most 1,000 listed). */
  oversized: string[];
  /** How many XML parts were left out for their size. */
  oversizedCount: number;
  /** Embedded font parts (placeholders). */
  fonts: number;
};

/** The deck's XML parts within the caps; every other part an empty placeholder (see the module comment). */
export async function readDeckXml(deck: string, dir: string, signal: AbortSignal): Promise<DeckXml> {
  const placeholders: string[] = [];
  let fonts = 0;
  const zip = await extractZip(deck, {
    dir,
    nested: false,
    distinct: true,
    spill: () => false,
    maxEntryBytes: PPTX_LIMITS.xmlPartBytes,
    maxInMemoryBytes: PPTX_LIMITS.xmlTotalBytes,
    signal,
    skip: (path) => {
      if (SKIPPED_PART.test(path)) return true;
      if (XML_PART.test(path) && !FONT_PART.test(path)) return false;
      if (FONT_PART.test(path)) fonts++;
      placeholders.push(path);
      return true;
    },
  });
  const parts = zip.files;
  // An XML part left out stays as an empty part: a slide that needs it is quarantined, never dropped.
  for (const s of zip.skipped) placeholders.push(s.path);
  for (const p of placeholders) if (!parts.has(p)) parts.set(p, EMPTY);
  return { parts, oversized: zip.skipped.map((s) => s.path), oversizedCount: zip.skippedCount, fonts };
}

/**
 * The parts of `wanted` (picture parts a pool task found referenced) spilled under generated names in `dir`,
 * at most `PPTX_LIMITS.pictures` of them and `PPTX_LIMITS.spillBytes` in all: [part, file] in `files`; parts
 * past the budget are counted in `skippedCount`.
 */
export async function spillDeckParts(
  deck: string,
  dir: string,
  wanted: Iterable<string>,
  signal: AbortSignal,
): Promise<{ files: Map<string, string>; skippedCount: number }> {
  const want = new Set<string>();
  let over = 0;
  for (const p of wanted) {
    if (want.has(p)) continue;
    if (want.size < PPTX_LIMITS.pictures) want.add(p);
    else over++;
  }
  if (!want.size) return { files: new Map(), skippedCount: over };
  const zip = await extractZip(deck, {
    dir,
    nested: false,
    distinct: true,
    spill: () => true,
    skip: (path) => !want.has(path),
    maxSpillBytes: PPTX_LIMITS.spillBytes,
    signal,
  });
  return { files: zip.onDisk, skippedCount: zip.skippedCount + over };
}
