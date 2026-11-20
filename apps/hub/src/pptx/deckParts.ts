/**
 * The bounded reads of a stored, untrusted .pptx that every pptx job shares (design/27 §12 "Zip"): the native
 * import, the LibreOffice follow-up and reference pictures, the 'Pictures (LibreOffice)' import and the text
 * repair read a deck only through these.
 *
 * - `readDeckXml`: XML and relationship parts in memory (≤ 32 MB each, ≤ 256 MB in all, a deck that declares more refused from its directory); a larger XML part is
 *   left out and listed; every other part (pictures, media, fonts) an empty placeholder, so relationships
 *   still resolve; embeddings, `vbaProject.bin`, custom XML, document properties and printer settings never
 *   read. Nothing is written to disk.
 * - `spillDeckParts`: only the parts a caller names (the pictures a pool task found referenced), under
 *   generated names, within the spill budget (`PPTX_LIMITS.spillBytes`) and the picture count.
 *
 * Both refuse a zip whose entries' data overlap (`distinct`): a few KB could otherwise name one large
 * stream thousands of times. Entry names never become paths.
 */
import { tmpdir } from 'node:os';
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

/**
 * A deck holds more slide XML than the hub reads (W17, design/29 section 3): thrown by `readDeckXml` from the file's own directory,
 * before any byte is read. The message is the volunteer's line, with the number this hub enforces.
 */
export class XmlTotalError extends Error {
  constructor(total: number) {
    super(
      `ordo could not read this file: it holds more slide data than ordo reads (${total / 1024 ** 2} MB at most). ` +
        'Nothing was imported. In PowerPoint, save very detailed artwork as pictures and import again.',
    );
    this.name = 'XmlTotalError';
  }
}

/**
 * The XML a read of this deck would keep, as its central directory declares it (bytes): the XML and relationship parts within the
 * part cap, never the pictures, fonts, documents the read skips, or the parts it leaves out for their size. Reads the directory
 * only: every entry is `skip`ped, so nothing is inflated and nothing is written.
 */
export async function declaredXmlBytes(deck: string, signal: AbortSignal): Promise<number> {
  let bytes = 0;
  await extractZip(deck, {
    dir: tmpdir(),
    nested: false,
    distinct: true,
    spill: () => false,
    signal,
    skip: (path, size) => {
      if (
        !SKIPPED_PART.test(path) &&
        XML_PART.test(path) &&
        !FONT_PART.test(path) &&
        size <= PPTX_LIMITS.xmlPartBytes
      )
        bytes += size;
      return true;
    },
  });
  return bytes;
}

/**
 * The deck's XML parts within the caps; every other part an empty placeholder (see the module comment). A deck whose directory
 * declares more than `PPTX_LIMITS.xmlTotalBytes` of XML is refused first (`XmlTotalError`), before any part is read.
 */
export async function readDeckXml(deck: string, dir: string, signal: AbortSignal): Promise<DeckXml> {
  if ((await declaredXmlBytes(deck, signal)) > PPTX_LIMITS.xmlTotalBytes)
    throw new XmlTotalError(PPTX_LIMITS.xmlTotalBytes);
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
 * past the budget are counted in `skippedCount`. `limits` lowers both (the import's clips get what its
 * pictures left of the budget, at most `PPTX_LIMITS.clips` of them).
 */
export async function spillDeckParts(
  deck: string,
  dir: string,
  wanted: Iterable<string>,
  signal: AbortSignal,
  limits: { parts?: number; bytes?: number } = {},
): Promise<{ files: Map<string, string>; skippedCount: number }> {
  const want = new Set<string>();
  const maxParts = Math.min(limits.parts ?? PPTX_LIMITS.pictures, PPTX_LIMITS.pictures);
  const maxBytes = Math.max(0, Math.min(limits.bytes ?? PPTX_LIMITS.spillBytes, PPTX_LIMITS.spillBytes));
  let over = 0;
  for (const p of wanted) {
    if (want.has(p)) continue;
    if (want.size < maxParts) want.add(p);
    else over++;
  }
  if (!want.size) return { files: new Map(), skippedCount: over };
  const zip = await extractZip(deck, {
    dir,
    nested: false,
    distinct: true,
    spill: () => true,
    skip: (path) => !want.has(path),
    maxSpillBytes: maxBytes,
    signal,
  });
  return { files: zip.onDisk, skippedCount: zip.skippedCount + over };
}
