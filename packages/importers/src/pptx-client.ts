/**
 * The native PowerPoint import in the uploading browser (design/27 §2, the regroup's import core): an
 * untrusted .pptx parsed in a Web Worker of the operator (or in Node: the fidelity harness, the hub's tests),
 * the same way the hub's pool parses it, so the hub stores what it would have made itself.
 *
 * - **`parsePptxScene`** (the operator's import worker): the deck read through `BoundedZip` (the central
 *   directory checked here, inflated bytes counted against the caps as they come, overlapping entries
 *   refused; pictures and clips only read for their first bytes), then the import core's steps the hub's
 *   pool runs: the deck facts and scan (`pptx-scan.ts`), the pictures' pixel sizes and the clips' kinds
 *   within the hub's spill budget, `convertDeck` with the library's faces (`PptxClientOptions.fontFace`) and
 *   the converter's stored fields (`M9_WRITES`), each slide's transition, and the shape files named and
 *   bounded (`pptx-geoms.ts`). The result is a `PptxClientScene`, which the operator uploads with the deck
 *   (`clientScene`); the hub checks it in its pool (`clientScene.ts`) and builds version 1 from it with the
 *   steps it runs for its own parse, or parses the deck itself when the scene is not of its converter, its
 *   fields or its LibreOffice.
 * - **`assemblePptxScene`** (the Pages demo, the harness, tests): version 1 from a scene with the import
 *   core (`pptx-core.ts`: drafts, the budget ladder, provenance, assembly), the pictures the slides use read
 *   whole within `PPTX_CLIENT_LIMITS` and stored by the caller, clips left out (their posters stay). No slide
 *   becomes a picture for a budget or a failure (M9 `ladder`): only the converter's picture class does.
 * - **`importPptxClient`**: both, for a caller that wants the presentation.
 *
 * Nothing here trusts the deck: every read is bounded, every string that reaches a log goes through
 * `logSafe`, and a failure throws (the operator then uploads the deck without a scene, and the hub parses it).
 */
import type { Presentation } from '@ordo/domain';
import { newId } from '@ordo/domain';
import {
  convertDeck,
  type EmittedSlide,
  type FaceSource,
  MEDIA_PREFIX,
  type PictureHeader as ScenePictureHeader,
  pictureSize,
  type SectionInfo,
  type SlideRef,
} from '@ordo/pptx-scene';
import type { PictureBake } from '@ordo/pptx-scene/bake.ts';
import type { M9Field } from '@ordo/pptx-scene/emit-ctx.ts';
import { openPackage } from '@ordo/pptx-scene/opc.ts';
import { extensionOf } from '@ordo/pptx-scene/picture.ts';
import { CONVERTER_VERSION, M9_WRITES, PPTX_SHEETS } from '@ordo/pptx-scene/version.ts';
import {
  type Converted,
  ImportCore,
  LOOP_IMPORT_NOTE,
  type PptxLoSlide,
  sweep,
  unplace,
  wanted,
} from './pptx-core.ts';
import {
  emittedShapeFiles,
  isShapeFilePlaceholder,
  type NamedGeomFile,
  nameGeoms,
  nameShapeFiles,
  storedShapeFileOf,
} from './pptx-geoms.ts';
import { withoutFiles } from './pptx-ladder.ts';
import { clearExifOrientation, pictureHeader } from './pptx-pictures.ts';
import { ImportLog, logSafe } from './pptx-report.ts';
import { extrasOf, PPTX_IMPORT_LIMITS, type SceneScan, type SceneSlideExtra, scanDeck } from './pptx-scan.ts';
import { sha256Blob } from './sha256.ts';
import { BoundedZip, zipSource } from './zip-bounded.ts';

export { CONVERTER_VERSION, LOOP_IMPORT_NOTE, M9_WRITES };
export type { PptxLoSlide };

/** The stored M9 fields a client parse writes: the converter's one list (`@ordo/pptx-scene` `M9_WRITES`). */
export const CLIENT_M9_WRITES: ReadonlySet<M9Field> = M9_WRITES;

/**
 * Whether a client parse draws pictures from sheets (`EmitOptions.sheets`): the converter's one switch
 * (`@ordo/pptx-scene` `PPTX_SHEETS`), false until `decor-sheets` stores sheets on both paths.
 */
export const CLIENT_SHEETS: boolean = PPTX_SHEETS;

const KiB = 1024;
const MiB = 1024 * KiB;

/** What a client parse may read (design/27 §12): the import's limits and the client reader's own. */
export const PPTX_CLIENT_LIMITS = {
  ...PPTX_IMPORT_LIMITS,
  /** A picture's first bytes read for its pixel size, as the hub reads a spilled picture's. */
  pictureHeadBytes: 64 * KiB,
  /** Read again for a JPEG whose frame header follows large metadata. */
  jpegHeadBytes: 1 * MiB,
  /** A clip's first bytes read for its kind, and an ASF header's at most (as the hub's `readHead`). */
  clipHeadBytes: 4_100,
  asfHeadBytes: 64 * KiB,
  /** One picture read whole by `assemblePptxScene` (the Pages demo stores it as it is). */
  pictureBytes: 64 * MiB,
  /** Pictures read whole by one `assemblePptxScene`. */
  picturesTotalBytes: 512 * MiB,
} as const;

export type PptxClientOptions = {
  extendBackgrounds?: boolean;
  transitionSounds?: boolean;
  presentationId?: string;
  /**
   * M9: false when the deck is parsed for a hub without LibreOffice (`HubCapabilities.libreoffice`, or the
   * pages demo): the converter plans no art and no metafile conversion and lists what they would have drawn
   * (`EmitOptions.libreoffice`), nothing is `pending` and `Slide.pptx.missing` says what is not drawn, as
   * the hub's own import does. Absent: true.
   */
  libreoffice?: boolean;
  /**
   * The library's faces (the operator's font service in the import worker, `fontFace.ts`; the harness's
   * library): table rows grow to their text measured as the hub measures it (`ParseOptions.fontFace`).
   * Absent: widths are estimated, as a hub with no font would.
   */
  fontFace?: FaceSource;
  /**
   * The faces for this deck, loaded once its XML is read (the operator's import worker fetches only the
   * families a deck with a table names, `pptx-faces.ts` `loadDeckFaces`); takes the place of `fontFace`. A
   * throw fails the parse (the deck then goes to the hub).
   */
  loadFaces?: (parts: ReadonlyMap<string, Uint8Array>) => Promise<FaceSource | undefined>;
  /** Stops the parse between its steps (the operator's deadline also terminates the worker). */
  signal?: AbortSignal;
};

/** What a client parse uploads beside the deck (`clientScene`), and what the hub checks it against. */
export type PptxClientScene = {
  /** `CONVERTER_VERSION`: the hub uses only a scene of its own converter. */
  version: number;
  /** The stored M9 fields the converter was told to write (`M9_WRITES`): the hub's must be the same. */
  m9Writes: string[];
  /** XML parts over `PPTX_IMPORT_LIMITS.xmlPartBytes`, left out (at most 1,000). */
  oversized: string[];
  /** Embedded font parts (not read). */
  fonts: number;
  scan: SceneScan;
  listed: SlideRef[];
  sections: SectionInfo[];
  slideRect: { x: number; y: number; w: number; h: number };
  notes: string[];
  slides: EmittedSlide[];
  media: { id: string; part: string; bake?: PictureBake }[];
  extras: SceneSlideExtra[];
  /**
   * The shape files the slides name (by SHA-256): geometry files and M9 decoration files, which the hub tells
   * apart by their JSON (`storedShapeFileOf`), re-checks and re-hashes.
   */
  geomFiles: { hash: string; json: string }[];
  /**
   * The slides whose new shape files would pass `PPTX_IMPORT_LIMITS.batchGeomBytes`: in `slides` they keep
   * the placeholders (`pptxgeom:`, `pptxdecor:`) of the files they were not given, and the hub leaves out the
   * objects that name them (`withoutFiles`).
   */
  geomOver?: number[];
  /**
   * M9: false when parsed without LibreOffice (`PptxClientOptions.libreoffice`); absent: with it. The hub
   * uses the scene only when this is what it has, else it parses the deck itself.
   */
  libreoffice?: boolean;
};

/** A client parse: the scene, and what the assembly reads beside it. */
export type PptxSceneParse = {
  scene: PptxClientScene;
  zip: BoundedZip;
  /** The pictures' pixel sizes read (the converter's `pictureSize`). */
  sizes: Map<string, ScenePictureHeader>;
  ms: number;
};

export type PptxClientPicture = {
  key: string;
  part: string;
  bytes: Uint8Array;
  mime: string;
  name: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  isBackground?: boolean;
};

export type PptxClientImportResult = {
  presentation: Presentation;
  deckHash: string;
  /** The pictures the slides use, by part, under their keys (`pptxmedia:<n>`) in `presentation`. */
  pictures: Map<string, PptxClientPicture>;
  geoms: NamedGeomFile[];
  /** The deck's clip parts: not imported by a client assembly (their posters stay). */
  clips: string[];
  loSlides: PptxLoSlide[];
  classes: ('native' | 'hybrid' | 'picture')[];
  /** 0: no slide is made a picture for a budget (M9). */
  compact: number;
  /** Slides the budget ladder simplified. */
  simplified: number;
  pending: number;
  missingFonts: string[];
  /** The import's warnings (the import card's notes). */
  notes: string[];
  log: string[];
  clientScene: PptxClientScene;
};

/** Parts never read: OLE payloads, macros, custom XML, document properties and printer settings (§12). */
const SKIPPED_PART =
  /^(customXml\/|docProps\/|ppt\/embeddings\/|ppt\/printerSettings\/|ppt\/vbaProject\.bin$)/i;
const XML_PART = /\.(xml|rels)$/i;
const FONT_PART = /^ppt\/fonts\//i;
const EMPTY = new Uint8Array(0);
/** XML parts left out for their size that a scene lists. */
const OVERSIZED_LISTED = 1_000;

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('the PowerPoint parse was stopped');
}

/**
 * The deck's XML and relationship parts within the caps (as the hub's `readDeckXml`): ≤ `xmlPartBytes` each
 * (a larger part is left out and listed), ≤ `xmlTotalBytes` in all (more fails the parse); every other part
 * an empty placeholder, so relationships resolve.
 */
async function readXml(
  zip: BoundedZip,
): Promise<{ parts: Map<string, Uint8Array>; oversized: string[]; fonts: number }> {
  const L = PPTX_CLIENT_LIMITS;
  const parts = new Map<string, Uint8Array>();
  const placeholders: string[] = [];
  const oversized: string[] = [];
  let fonts = 0;
  let inMemory = 0;
  for (const e of zip.entries.values()) {
    const path = e.path;
    if (SKIPPED_PART.test(path)) continue;
    if (!XML_PART.test(path) || FONT_PART.test(path)) {
      if (FONT_PART.test(path)) fonts++;
      placeholders.push(path);
      continue;
    }
    if (e.uncompressedSize > L.xmlPartBytes) {
      if (oversized.length < OVERSIZED_LISTED) oversized.push(path);
      placeholders.push(path);
      continue;
    }
    if (inMemory + e.uncompressedSize > L.xmlTotalBytes)
      throw new Error(`The deck holds more than ${L.xmlTotalBytes / MiB} MB of slide XML`);
    const bytes = await zip.read(path, L.xmlPartBytes);
    inMemory += bytes.length;
    parts.set(path, bytes);
  }
  for (const p of placeholders) if (!parts.has(p)) parts.set(p, EMPTY);
  return { parts, oversized, fonts };
}

/**
 * The parts of `wanted` the hub would spill (`spillDeckParts`): at most `maxParts` (in `wanted`'s order),
 * then in the zip's order while their declared sizes fit `maxBytes`. Their declared sizes are returned.
 */
function budgeted(
  zip: BoundedZip,
  wanted: readonly string[],
  maxParts: number,
  maxBytes: number,
): Map<string, number> {
  const want = new Set<string>();
  for (const p of wanted) {
    if (want.size >= maxParts) break;
    want.add(p);
  }
  const out = new Map<string, number>();
  let bytes = 0;
  for (const e of zip.entries.values()) {
    if (!want.has(e.path)) continue;
    if (bytes + e.uncompressedSize > maxBytes) continue;
    bytes += e.uncompressedSize;
    out.set(e.path, e.uncompressedSize);
  }
  return out;
}

/** A picture's pixel size from its first bytes, as the hub reads a spilled one (`spilledSize`). */
async function headSize(zip: BoundedZip, part: string): Promise<ScenePictureHeader | undefined> {
  const L = PPTX_CLIENT_LIMITS;
  try {
    const b = await zip.head(part, L.pictureHeadBytes);
    const px = pictureSize(b);
    if (px || b.length < L.pictureHeadBytes || b[0] !== 0xff || b[1] !== 0xd8) return px;
    return pictureSize(await zip.head(part, L.jpegHeadBytes));
  } catch {
    return undefined;
  }
}

const ASF_HEADER = [
  0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
];
const ASF_VIDEO = [
  0xc0, 0xef, 0x19, 0xbc, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b,
];
const ASF_AUDIO = [
  0x40, 0x9e, 0x69, 0xf8, 0x4d, 0x5b, 0xcf, 0x11, 0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b,
];

function containsBytes(b: Uint8Array, pat: readonly number[], from = 0): boolean {
  outer: for (let i = from; i + pat.length <= b.length; i++) {
    for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Whether a clip's first bytes are a video or a sound: the video and audio answers of the hub's `sniff`
 * (`apps/hub/src/store.ts`), which the hub gives its converter for a spilled clip.
 */
export function sniffMediaKind(b: Uint8Array): 'video' | 'audio' | undefined {
  const at = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  const u = (o: number) => b[o] ?? -1;
  if (u(0) === 0xff && u(1) === 0xd8 && u(2) === 0xff) return undefined;
  if (u(0) === 0x89 && at(1, 'PNG')) return undefined;
  if (at(0, 'GIF8')) return undefined;
  if (at(0, 'RIFF') && at(8, 'WEBP')) return undefined;
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio';
  if (at(0, 'RIFF') && at(8, 'AVI ')) return 'video';
  if (ASF_HEADER.every((x, i) => b[i] === x)) {
    if (containsBytes(b, ASF_VIDEO, 30)) return 'video';
    if (containsBytes(b, ASF_AUDIO, 30)) return 'audio';
    return 'video';
  }
  if (u(0) === 0 && u(1) === 0 && u(2) === 1 && u(3) === 0xba) return 'video';
  if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC'))) return 'audio';
  if (at(4, 'ftyp')) {
    const brand = String.fromCharCode(u(8), u(9), u(10), u(11));
    if (brand === 'qt  ') return 'video';
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'audio';
    if (brand === 'avif' || brand === 'avis' || brand === 'heic' || brand === 'mif1') return undefined;
    return 'video';
  }
  if (u(0) === 0x1a && u(1) === 0x45 && u(2) === 0xdf && u(3) === 0xa3) return 'video';
  if (at(0, 'fLaC') || at(0, 'OggS') || at(0, 'ID3')) return 'audio';
  if (u(0) === 0xff && (u(1) & 0xf6) === 0xf0) return 'audio';
  if (u(0) === 0xff && (u(1) & 0xe0) === 0xe0) return 'audio';
  return undefined;
}

/** A clip's head as the hub's `readHead` reads it: an ASF header object whole, up to `asfHeadBytes`. */
async function clipHead(zip: BoundedZip, part: string): Promise<Uint8Array> {
  const L = PPTX_CLIENT_LIMITS;
  const head = await zip.head(part, L.clipHeadBytes);
  if (head.length < 24 || head.length < L.clipHeadBytes || !ASF_HEADER.every((x, i) => head[i] === x))
    return head;
  const size = Math.min(
    L.asfHeadBytes,
    Number(new DataView(head.buffer, head.byteOffset, head.byteLength).getBigUint64(16, true)),
  );
  return size > head.length ? zip.head(part, size) : head;
}

/**
 * Parse a deck into the scene the hub builds version 1 from (see the module comment). Throws when the deck
 * cannot be read within the bounds: the caller uploads it without a scene and the hub parses it.
 */
export async function parsePptxScene(
  input: Blob | Uint8Array | ArrayBuffer,
  options: PptxClientOptions = {},
  onProgress?: (pct: number) => void,
): Promise<PptxSceneParse> {
  const t0 = performance.now();
  const L = PPTX_CLIENT_LIMITS;
  const { signal } = options;
  const zip = await BoundedZip.open(zipSource(input));
  checkAborted(signal);
  onProgress?.(0.05);

  // 1. XML parts in memory; every other part a placeholder.
  const xml = await readXml(zip);
  const parts = xml.parts;
  checkAborted(signal);
  onProgress?.(0.15);

  // 2a. The deck facts and the scan, as the hub's first pool call.
  const withLo = options.libreoffice !== false;
  const base = {
    extendBackgrounds: options.extendBackgrounds ?? true,
    transitionSounds: options.transitionSounds ?? false,
    m9Writes: M9_WRITES,
    sheets: PPTX_SHEETS,
    ...(withLo ? {} : { libreoffice: false }),
    newId,
  };
  const first = convertDeck(parts, { ...base, range: { from: 0, to: 0 } });
  const listed = first.listed;
  if (!listed.length) throw new Error('The deck has no slides');
  const scan = scanDeck(openPackage(parts), listed);
  checkAborted(signal);
  onProgress?.(0.25);

  // 2b. The pictures' pixel sizes and the clips' kinds, within the hub's spill budget.
  const sizes = new Map<string, ScenePictureHeader>();
  let spilled = 0;
  for (const [part, bytes] of budgeted(zip, scan.pictures, L.pictures, L.spillBytes)) {
    const px = await headSize(zip, part);
    if (px) sizes.set(part, px);
    spilled += bytes;
    checkAborted(signal);
  }
  const kinds = new Map<string, 'video' | 'audio'>();
  for (const part of budgeted(zip, scan.clips ?? [], L.clips, L.spillBytes - spilled).keys()) {
    try {
      const kind = sniffMediaKind(await clipHead(zip, part));
      if (kind) kinds.set(part, kind);
    } catch {
      // unreadable: the hub's ingest says so
    }
  }
  checkAborted(signal);
  onProgress?.(0.4);

  // 2c. Every slide, with the library's faces.
  const fontFace = options.loadFaces ? await options.loadFaces(parts) : options.fontFace;
  checkAborted(signal);
  const result = convertDeck(parts, {
    ...base,
    range: { from: 0, to: listed.length },
    pictureSize: (p) => sizes.get(p),
    mediaKind: (p) => kinds.get(p),
    ...(fontFace ? { fontFace } : {}),
  });
  const extras = extrasOf(openPackage(parts), result);
  parts.clear();
  checkAborted(signal);
  onProgress?.(0.85);

  // Shape files (geometry and decoration files) named and bounded as a batch's (`sceneTask.ts`): a slide past
  // the bound keeps the placeholders of the files it was not given; the hub leaves out the objects that name
  // them.
  const named = nameShapeFiles(result.slides, emittedShapeFiles(result), L.batchGeomBytes);
  const names = new Map(named.files.map((f) => [f.id, f.hash]));
  const over = new Set(named.over);
  const slides = result.slides.map((s) => {
    if (!over.has(s.index)) return { ...s, slide: nameGeoms(s.slide, names) };
    const keep = new Map(names);
    for (const o of s.slide.objects) {
      const refs = o.type === 'shape' ? [o.geom?.ref, o.decor?.ref] : o.type === 'image' ? [o.mask?.ref] : [];
      for (const ref of refs) if (ref && isShapeFilePlaceholder(ref) && !keep.has(ref)) keep.set(ref, ref);
    }
    return { ...s, slide: nameGeoms(s.slide, keep) };
  });
  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  for (const f of named.files) if (!files.has(f.hash)) files.set(f.hash, decoder.decode(f.bytes));
  const scene: PptxClientScene = {
    version: CONVERTER_VERSION,
    m9Writes: [...M9_WRITES],
    oversized: xml.oversized,
    fonts: xml.fonts,
    scan,
    listed: [...listed],
    sections: [...first.sections],
    slideRect: first.slideRect,
    notes: [...first.notes],
    slides,
    media: [...result.media],
    extras,
    geomFiles: [...files].map(([hash, json]) => ({ hash, json })),
    ...(over.size ? { geomOver: [...over] } : {}),
    ...(withLo ? {} : { libreoffice: false }),
  };
  onProgress?.(1);
  return { scene, zip, sizes, ms: performance.now() - t0 };
}

function mimeOfExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

/** What `assemblePptxScene` needs besides the scene. */
export type AssembleOptions = {
  fileName: string;
  presentationId?: string;
  /** The deck's SHA-256 (`Slide.pptx.fileId`); computed from `input` when absent. */
  deckHash?: string;
  /** The families the library covers (the demo's, the harness's); absent: none. */
  libraryFamilies?: Iterable<string>;
};

/**
 * Version 1 from a client scene, with the import core (see the module comment): the same drafts, budgets,
 * provenance and assembly as the hub's; the pictures the kept slides use are read whole (bounded) and keyed
 * `pptxmedia:<n>` for the caller to store; clips are left out (their posters stay); bakes show their source.
 */
export async function assemblePptxScene(
  parse: Pick<PptxSceneParse, 'scene' | 'zip'>,
  input: Blob | Uint8Array | ArrayBuffer,
  o: AssembleOptions,
): Promise<PptxClientImportResult> {
  const { scene, zip } = parse;
  const L = PPTX_CLIENT_LIMITS;
  const lo = scene.libreoffice !== false;
  const log = new ImportLog();
  const core = new ImportCore({
    lo,
    log,
    warn: (_kind, msg) => log.add('warn', msg),
    geomFileBytes: L.geomFileBytes,
  });
  for (const p of scene.oversized)
    core.warn('part', `${logSafe(p)} is over ${L.xmlPartBytes / MiB} MB: not read`);
  if (scene.fonts)
    log.add('info', `${scene.fonts} embedded font part(s) not used (embedded fonts come later)`);
  for (const n of scene.notes) log.add('info', n);
  // Shape files as the hub admits a client's: each checked and re-hashed by its kind (`storedShapeFileOf`).
  const names = new Map<string, string>();
  for (const g of scene.geomFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(g.json);
    } catch {
      continue;
    }
    const f = storedShapeFileOf(parsed);
    if (!f) continue;
    names.set(g.hash, f.hash);
    core.addGeomFile(f);
  }
  // A baked picture shows its source here (the hub bakes it, `bakes.ts`).
  const media = new Map(scene.media.map((m) => [m.id, m.part]));
  const extras = new Map(scene.extras.map((e) => [e.index, e]));
  const over = new Set(scene.geomOver ?? []);
  const converted = new Map<number, Converted>();
  for (const s0 of scene.slides) {
    let s = s0;
    let geomLeft: Converted['geomLeft'];
    if (over.has(s.index)) {
      const left = withoutFiles(s.slide, (ref) => !isShapeFilePlaceholder(ref));
      s = { ...s, slide: left.slide };
      geomLeft = { dropped: left.dropped, unmasked: left.unmasked, missing: left.missing };
    }
    // Names re-checked: a file whose JSON is not what its name says is dropped (its objects too).
    s = { ...s, slide: nameGeoms(s.slide, new Map([...names].filter(([a, b]) => a === b))) };
    converted.set(s.index, { s, media, extra: extras.get(s.index), ...(geomLeft ? { geomLeft } : {}) });
  }
  const drafts = core.drafts(scene.listed, converted, scene.scan);
  const simplified = core.budget(drafts);
  // Clips: not imported by a client assembly (the hub ingests them): each use left out, its poster kept.
  for (const d of drafts) {
    for (const c of d.clips ?? [])
      if (wanted(c, d.cls === 'picture')) unplace({ slide: d.slide, picture: d.cls === 'picture' }, c);
    sweep(d.slide);
  }
  // The pictures the kept slides use, read whole within the bounds, keyed by part.
  const used = new Set<string>();
  for (const d of drafts) {
    if (d.slide.backgroundMediaId?.startsWith(MEDIA_PREFIX)) used.add(d.slide.backgroundMediaId);
    for (const ob of d.slide.objects)
      if (ob.type === 'image' && ob.mediaId.startsWith(MEDIA_PREFIX)) used.add(ob.mediaId);
  }
  const title = logSafe(o.fileName.replace(/\.[^.]+$/, ''), 300) || 'PowerPoint';
  const pictures = new Map<string, PptxClientPicture>();
  const stored = new Map<string, string>();
  let total = 0;
  let n = 0;
  for (const id of used) {
    const part = media.get(id);
    if (part === undefined || stored.has(part)) continue;
    if (!zip.has(part)) {
      core.warn('picture', `a picture is missing from the deck (${logSafe(part)})`);
      continue;
    }
    const declared = zip.declared(part);
    if (declared > L.pictureBytes || total + declared > L.picturesTotalBytes) {
      core.warn('picture', `${logSafe(part)} is past what the browser import reads: not imported`);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await zip.read(part, L.pictureBytes);
    } catch {
      core.warn('picture', `a picture could not be read (${logSafe(part)})`);
      continue;
    }
    total += bytes.length;
    const header = pictureHeader(bytes, { complete: true });
    if (!header || header.format === 'other') {
      core.warn('picture', `a picture could not be imported: ${logSafe(part)} is not a picture ordo reads`);
      continue;
    }
    const key = `${MEDIA_PREFIX}${n++}`;
    const base = part.slice(part.lastIndexOf('/') + 1);
    pictures.set(part, {
      key,
      part,
      bytes: clearExifOrientation(bytes, header),
      mime: mimeOfExtension(header.format === 'jpeg' ? 'jpg' : header.format || extensionOf(part)),
      name: `${title} – ${logSafe(base, 100)}`.slice(0, 200),
      ...(header.width ? { width: header.width, height: header.height } : {}),
      ...(header.alpha ? { hasAlpha: true } : {}),
    });
    stored.set(part, key);
  }
  const byKey = new Map([...pictures.values()].map((p) => [p.key, p]));
  const deckHash =
    o.deckHash ?? (await sha256Blob(input instanceof ArrayBuffer ? new Uint8Array(input) : input));
  const built = core.assemble(drafts, stored, {
    id: o.presentationId ?? newId(),
    title,
    hash: deckHash,
    sections: scene.sections,
    slideRect: scene.slideRect,
    scan: scene.scan,
    hasAlpha: (key) => !!byKey.get(key)?.hasAlpha,
    clipIds: new Set(),
    libraryFamilies: o.libraryFamilies ?? [],
  });
  const p = built.p;
  const bg = new Set<string>();
  if (p.backgroundMediaId) bg.add(p.backgroundMediaId);
  for (const sec of p.sections)
    for (const sl of sec.slides) if (sl.backgroundMediaId) bg.add(sl.backgroundMediaId);
  for (const pic of pictures.values()) if (bg.has(pic.key)) pic.isBackground = true;
  const slides = p.sections.flatMap((s) => s.slides);
  const classes = slides.map((sl) => sl.pptx?.class ?? 'native');
  const lines = log.toString().split('\n').filter(Boolean);
  return {
    presentation: p,
    deckHash,
    pictures,
    geoms: [...core.geomFiles.values()],
    clips: scene.scan.clips ?? [],
    loSlides: built.lo,
    classes,
    compact: 0,
    simplified,
    pending: built.lo.length,
    missingFonts: built.missingFonts,
    notes: log.warnings(),
    log: lines,
    clientScene: scene,
  };
}

/** Parse and assemble a deck on the client (`parsePptxScene`, then `assemblePptxScene`). */
export async function importPptxClient(
  input: Blob | Uint8Array | ArrayBuffer,
  fileName: string,
  options: PptxClientOptions = {},
  onProgress?: (pct: number) => void,
): Promise<PptxClientImportResult> {
  const parse = await parsePptxScene(input, options, (p) => onProgress?.(p * 0.8));
  const out = await assemblePptxScene(parse, input, {
    fileName,
    ...(options.presentationId ? { presentationId: options.presentationId } : {}),
  });
  onProgress?.(1);
  return out;
}
