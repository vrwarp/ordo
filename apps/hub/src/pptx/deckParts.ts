/**
 * The bounded reads of a stored, untrusted .pptx that every pptx job shares (design/27 §12 "Zip"): the native
 * import, the LibreOffice follow-up and reference pictures, the 'Pictures (LibreOffice)' import and the text
 * repair read a deck only through these.
 *
 * - `readDeckXml`: XML and relationship parts in memory (≤ 32 MB each); a larger XML part is
 *   left out and listed. Whole (the default: ≤ 256 MB in all, `PPTX_LIMITS.xmlWholeBytes`, for the steps that need every part at once)
 *   or 'deferred' (the native import: the structure whole, each slide to its first 64 KiB, the slides' own parts read later by
 *   `readSlideParts`, ≤ 1 GiB of XML in all, `PPTX_LIMITS.xmlTotalBytes`); a deck that declares more is refused from its directory; every other part (pictures, media, fonts) an empty placeholder, so relationships
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
import { SLIDE_HEAD_BYTES } from '@ordo/pptx-scene/deck.ts';
import { PPTX_LIMITS } from './shared.ts';

/** Parts never read: OLE payloads, macros, custom XML, document properties and printer settings (§12). */
export const SKIPPED_PART =
  /^(customXml\/|docProps\/|ppt\/embeddings\/|ppt\/printerSettings\/|ppt\/vbaProject\.bin$)/i;
/** XML and relationship parts, kept in memory within the caps. */
export const XML_PART = /\.(xml|rels)$/i;
/** Embedded fonts (M8: decoded on the pool; not read by this wave). */
export const FONT_PART = /^ppt\/fonts\//i;

const EMPTY = new Uint8Array(0);

/**
 * The parts read slide by slide in 'deferred' mode: the slides themselves (`ppt/slides/slide1.xml`, not their relationships). Everything
 * else that is XML is the deck's structure and is read whole.
 */
export const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/i;

/** What `readDeckXml` takes besides the deck. */
export type DeckXmlOptions = {
  /**
   * 'whole' (default): every XML part in memory, within `PPTX_LIMITS.xmlWholeBytes`. 'deferred': the structure whole and each slide to
   * its first `SLIDE_HEAD_BYTES` (all the slide list needs of it); the slides' sizes are in `DeckXml.deferred` and their parts are
   * read by `readSlideParts` when a call needs them.
   */
  slides?: 'whole' | 'deferred';
};

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
  /** The XML the deck's directory declares in all (`declaredXml`'s total). */
  declaredTotal: number;
  /**
   * 'deferred' mode: each slide part (within the part cap) with its declared size; `parts` holds only its head (at most
   * `SLIDE_HEAD_BYTES`). Undefined in whole mode.
   */
  deferred?: Map<string, number>;
};

/** Which bound refused a deck: the import's total, the import's structure, or a step that reads a deck whole. */
export type XmlBound = 'import' | 'structure' | 'whole';

const sayBytes = (n: number) => (n >= 1024 ** 3 ? `${n / 1024 ** 3} GB` : `${n / 1024 ** 2} MB`);

/**
 * A deck holds more XML than the hub reads (W17, design/29 section 3): thrown from the file's own directory, before any byte is
 * read. 'import': more slide data than an import reads (the volunteer's line of W17, with the number this hub enforces, 1 GB);
 * 'structure': the deck's designs, charts and drawings alone are over what an import keeps in memory; 'whole': a step that needs every
 * part at once (the render copy of the LibreOffice follow-up, the slide listing, the text repair) does not run for a deck this big.
 */
export class XmlTotalError extends Error {
  readonly bound: XmlBound;
  constructor(bound: XmlBound, limit: number, declared = 0) {
    super(
      bound === 'import'
        ? `ordo could not read this file: it holds more slide data than ordo reads (${sayBytes(limit)} at most). ` +
            'Nothing was imported. In PowerPoint, save very detailed artwork as pictures and import again.'
        : bound === 'structure'
          ? `ordo could not read this file: its designs, charts and drawings hold more data than ordo reads at once (${sayBytes(limit)} at most). ` +
            'Nothing was imported. In PowerPoint, save very detailed artwork as pictures and import again.'
          : `This deck holds ${Math.round(declared / 1024 ** 2)} MB of slide data, more than this step reads at once (${sayBytes(limit)} at most): it was not run, and what the import stored stays as it is.`,
    );
    this.name = 'XmlTotalError';
    this.bound = bound;
  }
}

/**
 * The XML a read of this deck would keep, as its central directory declares it (bytes): the XML and relationship parts within the
 * part cap, never the pictures, fonts, documents the read skips, or the parts it leaves out for their size; apart, the slides
 * (`SLIDE_PART`: read slide by slide in 'deferred' mode) with their sizes and the structure (everything else). Reads the directory
 * only: every entry is `skip`ped, so nothing is inflated and nothing is written.
 */
export async function declaredXml(
  deck: string,
  signal: AbortSignal,
): Promise<{ total: number; structure: number; slides: Map<string, number> }> {
  const slides = new Map<string, number>();
  let total = 0;
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
      ) {
        total += size;
        if (SLIDE_PART.test(path)) slides.set(path, size);
      }
      return true;
    },
  });
  let inSlides = 0;
  for (const v of slides.values()) inSlides += v;
  return { total, structure: total - inSlides, slides };
}

/** The XML a read would keep, in all (`declaredXml`). */
export async function declaredXmlBytes(deck: string, signal: AbortSignal): Promise<number> {
  return (await declaredXml(deck, signal)).total;
}

/**
 * The deck's XML parts within the caps; every other part an empty placeholder (see the module comment).
 *
 * Whole (the default): a deck whose directory declares more than `PPTX_LIMITS.xmlWholeBytes` of XML is refused first
 * (`XmlTotalError` 'whole'), before any part is read. 'deferred' (the native import): the deck's directory may declare
 * `PPTX_LIMITS.xmlTotalBytes` ('import': W17), of which the structure (everything but the slides) at most
 * `PPTX_LIMITS.xmlWholeBytes` ('structure'); each slide part is read to its first `SLIDE_HEAD_BYTES` only, and listed with its
 * declared size in `deferred`.
 */
export async function readDeckXml(
  deck: string,
  dir: string,
  signal: AbortSignal,
  opts: DeckXmlOptions = {},
): Promise<DeckXml> {
  const deferred = opts.slides === 'deferred';
  const declared = await declaredXml(deck, signal);
  if (deferred) {
    if (declared.total > PPTX_LIMITS.xmlTotalBytes)
      throw new XmlTotalError('import', PPTX_LIMITS.xmlTotalBytes, declared.total);
    if (declared.structure > PPTX_LIMITS.xmlWholeBytes)
      throw new XmlTotalError('structure', PPTX_LIMITS.xmlWholeBytes, declared.structure);
  } else if (declared.total > PPTX_LIMITS.xmlWholeBytes)
    throw new XmlTotalError('whole', PPTX_LIMITS.xmlWholeBytes, declared.total);
  const placeholders: string[] = [];
  let fonts = 0;
  const zip = await extractZip(deck, {
    dir,
    nested: false,
    distinct: true,
    spill: () => false,
    maxEntryBytes: PPTX_LIMITS.xmlPartBytes,
    // Whole: the XML. Deferred: the structure and the slides' heads, which together are bounded by the same number.
    maxInMemoryBytes: PPTX_LIMITS.xmlWholeBytes,
    signal,
    skip: (path) => {
      if (SKIPPED_PART.test(path)) return true;
      if (XML_PART.test(path) && !FONT_PART.test(path)) return false;
      if (FONT_PART.test(path)) fonts++;
      placeholders.push(path);
      return true;
    },
    ...(deferred ? { head: (path: string) => (SLIDE_PART.test(path) ? SLIDE_HEAD_BYTES : undefined) } : {}),
  });
  const parts = zip.files;
  // An XML part left out stays as an empty part: a slide that needs it is quarantined, never dropped.
  for (const s of zip.skipped) placeholders.push(s.path);
  for (const p of placeholders) if (!parts.has(p)) parts.set(p, EMPTY);
  return {
    parts,
    oversized: zip.skipped.map((s) => s.path),
    oversizedCount: zip.skippedCount,
    fonts,
    declaredTotal: declared.total,
    ...(deferred ? { deferred: declared.slides } : {}),
  };
}

/**
 * The slide parts of one pool call, read whole from the stored deck just before the call (the 'deferred' mode of `readDeckXml` read
 * only their heads): `names` are slide parts the deck lists, each at most `PPTX_LIMITS.xmlPartBytes`; a call carries at most
 * `PPTX_LIMITS.batchXmlBytes` of them (or one slide alone). Nothing else is read, nothing is written.
 */
export async function readSlideParts(
  deck: string,
  dir: string,
  signal: AbortSignal,
  names: Iterable<string>,
): Promise<Map<string, Uint8Array>> {
  const want = new Set(names);
  if (!want.size) return new Map();
  const zip = await extractZip(deck, {
    dir,
    nested: false,
    distinct: true,
    spill: () => false,
    maxEntryBytes: PPTX_LIMITS.xmlPartBytes,
    maxInMemoryBytes: PPTX_LIMITS.batchXmlBytes + PPTX_LIMITS.xmlPartBytes,
    signal,
    skip: (path) => !want.has(path),
  });
  return zip.files;
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
