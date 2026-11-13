/**
 * Client-side and isomorphic native PowerPoint (.pptx) importer.
 * Runs in browser, Web Worker, and Node.js without native C++ / headless LibreOffice dependencies.
 * Turns an untrusted .pptx file into native editable ordo slide objects.
 */
import {
  compactSlideBytes,
  drawnGeomRefs,
  IMPORT_RESERVE_BYTES,
  type ImageObject,
  MISSING_LIMITS,
  missingEntry,
  newId,
  planImportSizes,
  type Presentation,
  type Section,
  type ShapeObject,
  Slide,
  type SlideObject,
  type SlidePptx,
  slideBytes,
} from '@ordo/domain';
import {
  type ArtInfo,
  type ConvertResult,
  convertDeck,
  type EmittedClip,
  type EmittedSlide,
  MEDIA_PREFIX,
  type PictureHeader as ScenePictureHeader,
  pictureSize,
  type SectionInfo,
  type SlideClass,
  type SlideRef,
} from '@ordo/pptx-scene';
import type { PictureBake } from '@ordo/pptx-scene/bake.ts';
import { ALL_M9_FIELDS, type M9Field } from '@ordo/pptx-scene/emit-ctx.ts';
import { digestOf, SLIDE_BUDGET_NOTE, SLIDE_BYTES_NOTE } from '@ordo/pptx-scene/emit.ts';
import { clean } from '@ordo/pptx-scene/log.ts';
import { readNotes } from '@ordo/pptx-scene/notes.ts';
import { openPackage, type Package, relType } from '@ordo/pptx-scene/opc.ts';
import { extensionOf, METAFILE_EXTENSIONS } from '@ordo/pptx-scene/picture.ts';
import { readSlideTransition, showLoops } from '@ordo/pptx-scene/transition.ts';
import JSZip from 'jszip';
import { geomFileOf, type NamedGeomFile, nameGeoms } from './pptx-geoms.ts';
import { clearExifOrientation, type PictureHeader, pictureHeader } from './pptx-pictures.ts';
import { remapMediaIds } from './remap.ts';
import { sanitizePresentation } from './sanitize.ts';
import { sha256Hex } from './sha256.ts';
import { safeEntryPath } from './zip.ts';

/**
 * The converter version of a client-parsed scene (`PptxClientScene.version`), written to `Slide.pptx.version`
 * like the hub's: it must equal the hub's `CONVERTER_VERSION` (`apps/hub/src/pptx/shared.ts`), which uses a
 * client scene only from the same converter (a hub test checks both). 2 since M9 (design/27 §15 M9).
 */
export const CONVERTER_VERSION = 2;

/**
 * The stored M9 fields a client parse writes (`EmitOptions.m9Writes`): the hub's `M9_WRITES`, the per-field
 * kill switch of design/27 M9 (a hub test checks that both name the same fields).
 */
export const CLIENT_M9_WRITES: ReadonlySet<M9Field> = ALL_M9_FIELDS;

export const PPTX_CLIENT_LIMITS = {
  entries: 200_000,
  xmlPartBytes: 8 * 1024 * 1024,
  xmlTotalBytes: 64 * 1024 * 1024,
  pictures: 2_000,
  clips: 50,
  slides: 2_000,
  geomFileBytes: 32 * 1024 * 1024,
  batchGeomBytes: 32 * 1024 * 1024,
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
};

export type PptxLoSlide = {
  slideId: string;
  index: number;
  shown?: number;
  class: SlideClass;
  art?: ArtInfo;
  metafiles?: [string, string[]][];
  digest: string;
  metafileObjects?: { part: string; object: ImageObject; before?: string }[];
  replaced?: [string, string][];
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

export type PptxClientSceneScan = {
  pictures: string[];
  picturesOver: number;
  metafiles: [number, string[]][];
  notes: [number, string][];
  loop: boolean;
  clips?: string[];
  clipsOver?: number;
};

export type PptxClientSlideExtra = {
  index: number;
  transition?: Slide['transition'];
  advanceMs?: number;
  note?: string;
};

export type PptxClientScene = {
  version: number;
  oversized: string[];
  fonts: number;
  scan: PptxClientSceneScan;
  listed: SlideRef[];
  sections: SectionInfo[];
  slideRect: { x: number; y: number; w: number; h: number };
  notes: string[];
  slides: EmittedSlide[];
  media: { id: string; part: string; bake?: PictureBake }[];
  extras: PptxClientSlideExtra[];
  geomFiles: { hash: string; json: string }[];
  /**
   * The slides whose new outline files would pass `PPTX_CLIENT_LIMITS.geomFileBytes`: in `slides` they keep
   * the placeholders (`GEOM_PREFIX`) of the files they were not given, and the hub leaves out the objects
   * that name them (M9 `ladder.ts` `withoutFiles`).
   */
  geomOver?: number[];
  /**
   * M9: false when parsed without LibreOffice (`PptxClientOptions.libreoffice`); absent: with it. The hub
   * uses the scene only when this is what it has (`nativeJob.ts`), else it parses the deck itself.
   */
  libreoffice?: boolean;
};

export type PptxClientImportResult = {
  presentation: Presentation;
  deckHash: string;
  pictures: Map<string, PptxClientPicture>;
  geoms: NamedGeomFile[];
  clips: string[];
  loSlides: PptxLoSlide[];
  classes: ('native' | 'hybrid' | 'picture')[];
  compact: number;
  pending: number;
  missingFonts: string[];
  notes: string[];
  log: string[];
  clientScene: PptxClientScene;
};

const SKIPPED_PART =
  /^(customXml\/|docProps\/|ppt\/embeddings\/|ppt\/printerSettings\/|ppt\/vbaProject\.bin$)/i;
const XML_PART = /\.(xml|rels)$/i;
const FONT_PART = /^ppt\/fonts\//i;
const EMPTY = new Uint8Array(0);
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const ART_TEXT_CHARS = 20_000;
const NOTES_CUT_CHARS = 200;
const SLIDE_NOTES = 16;
const MAX_METAFILES_PER_SLIDE = 50;

const CLIP_TYPES: ReadonlyMap<string, number> = new Map([
  ['media', 0],
  ['video', 1],
  ['audio', 2],
]);

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
    case 'svg':
      return 'image/svg+xml';
    case 'emf':
      return 'image/x-emf';
    case 'wmf':
      return 'image/x-wmf';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}

function imported<T extends SlideObject>(o: T): T {
  return o.origin ? o : { ...o, origin: { src: 'pptx' } };
}

function backgroundOnWhite(
  mediaId: string,
  rect: { x: number; y: number; w: number; h: number },
): [ShapeObject, ImageObject] {
  const box = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, rotation: 0 };
  const origin = { src: 'pptx', role: 'bg' as const };
  return [
    { id: newId(), type: 'shape', box, shape: 'rect', fill: WHITE, opacity: 1, radius: 0, origin },
    { id: newId(), type: 'image', box: { ...box }, mediaId, fit: 'stretch', opacity: 1, radius: 0, origin },
  ];
}

function sectionsOf(drafts: readonly Draft[], info: readonly SectionInfo[]): Section[] {
  const of = new Map<number, number>();
  info.forEach((s, i) => {
    for (const idx of s.slides) if (!of.has(idx)) of.set(idx, i);
  });
  const out: Section[] = [];
  let cur: number | undefined | null = null;
  for (const d of drafts) {
    const s = of.get(d.ref.index);
    if (s !== cur || !out.length) {
      const label = s === undefined ? 'Slides' : clean(info[s]!.name, 60) || 'Slides';
      out.push({ id: newId(), label, short: '', slides: [] });
      cur = s;
    }
    out[out.length - 1]!.slides.push(d.slide);
  }
  return out;
}

function mostCommon(values: readonly number[]): number {
  const n = new Map<number, number>();
  let best = values[0] ?? 5_000;
  for (const v of values) {
    n.set(v, (n.get(v) ?? 0) + 1);
    if (n.get(v)! > (n.get(best) ?? 0)) best = v;
  }
  return Math.max(500, best);
}

function isLoop(drafts: readonly Draft[], loops: boolean): boolean {
  if (!loops) return false;
  const shown = drafts.filter((d) => !d.ref.hidden);
  return shown.length > 0 && shown.every((d) => (d.slide.durationMs ?? 0) > 0);
}

function textOfObjects(objects: readonly SlideObject[]): string {
  const out: string[] = [];
  let n = 0;
  for (const o of objects) {
    if (o.type !== 'text' || !o.text.trim()) continue;
    out.push(o.text);
    n += o.text.length + 1;
    if (n > ART_TEXT_CHARS) break;
  }
  return out.join('\n').slice(0, ART_TEXT_CHARS);
}

function toPicture(d: Draft): void {
  const text = textOfObjects(d.slide.objects);
  d.cls = 'picture';
  d.slide.objects = [];
  delete d.slide.lyricObjectId;
  delete d.art;
  delete d.metafiles;
  // The whole slide is what is missing now (`provenance`).
  delete d.missing;
  const all = [text, d.artText].filter(Boolean).join('\n').slice(0, ART_TEXT_CHARS);
  if (all) d.artText = all;
  else delete d.artText;
}

/**
 * `Slide.pptx` of a draft (without its digest), as the hub writes it (`nativeJob.ts` `provenance`): with
 * LibreOffice (`lo`) a hybrid or picture slide and one with metafile pictures waits for it (`pending`);
 * without it nothing waits, and what nothing draws is listed (`missing`: the converter's, or 'slide' for a
 * picture-class slide).
 */
function provenance(d: Draft, hash: string, lo: boolean): SlidePptx {
  const pending = lo && (d.cls !== 'native' || !!d.metafiles?.length);
  const missing = lo ? undefined : d.cls === 'picture' ? [missingEntry('slide')] : d.missing;
  return {
    fileId: hash,
    index: d.ref.index,
    ...(d.ref.shown !== undefined ? { shown: d.ref.shown } : {}),
    class: d.cls,
    version: CONVERTER_VERSION,
    ...(pending ? { pending: true } : {}),
    ...(missing?.length ? { missing: missing.slice(0, MISSING_LIMITS.entries) } : {}),
    ...(d.notes.length ? { notes: d.notes.slice(0, SLIDE_NOTES).map((n) => clean(n, 200)) } : {}),
    ...(d.artText ? { artText: d.artText } : {}),
  };
}

function record(d: Draft, digest: string, lo: boolean): Slide {
  return { ...d.slide, pptx: { ...provenance(d, 'x'.repeat(64), lo), digest } };
}

function fontFamilies(slides: readonly Slide[]): string[] {
  const out = new Set<string>();
  for (const s of slides) for (const o of s.objects) if (o.type === 'text') out.add(o.style.fontFamily);
  return [...out];
}

function missingFonts(used: Iterable<string>, library: Iterable<string>): string[] {
  const have = new Set<string>();
  for (const f of library) have.add(f.trim().toLowerCase());
  const GENERIC = new Set(['sans-serif', 'serif', 'monospace', 'system-ui']);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of used) {
    const f = clean(raw, 100);
    const k = f.toLowerCase();
    if (!f || seen.has(k)) continue;
    seen.add(k);
    if (have.has(k) || GENERIC.has(k)) continue;
    out.push(f);
    if (out.length >= 20) break;
  }
  return out;
}

function loSlides(drafts: readonly Draft[], slides: readonly Slide[]): PptxLoSlide[] {
  const byId = new Map(drafts.map((d) => [d.slide.id, d]));
  const out: PptxLoSlide[] = [];
  for (const sl of slides) {
    if (!sl.pptx?.pending) continue;
    const d = byId.get(sl.id);
    out.push({
      slideId: sl.id,
      index: sl.pptx.index,
      ...(sl.pptx.shown !== undefined ? { shown: sl.pptx.shown } : {}),
      class: sl.pptx.class,
      ...(d?.art && sl.pptx.class === 'hybrid' ? { art: d.art } : {}),
      ...(d?.metafiles?.length && sl.pptx.class !== 'picture' ? { metafileObjects: d.metafiles } : {}),
      digest: sl.pptx.digest ?? '',
      ...(d?.art && sl.pptx.class === 'hybrid'
        ? {
            replaced: sl.objects
              .filter((o) => new Set(d.art!.replaces).has(o.id))
              .map((o) => [o.id, digestOf([o])]),
          }
        : {}),
    });
  }
  return out;
}

type Draft = {
  ref: SlideRef;
  slide: Slide;
  media: Map<string, string>;
  cls: SlideClass;
  notes: string[];
  art?: ArtInfo;
  artText?: string;
  compact?: boolean;
  overBudget?: boolean;
  overGeoms?: boolean;
  metafiles?: { part: string; object: ImageObject; before?: string }[];
  clips?: EmittedClip[];
  /** M9, without LibreOffice: what nothing draws on the slide (`EmittedSlide.missing`). */
  missing?: string[];
};

type Images = { pictures: string[]; metafiles: string[] };

function clipParts(pkg: Package, listed: readonly SlideRef[]): { clips: string[]; over: number } {
  const best = new Map<string, number>();
  for (const ref of listed)
    for (const r of pkg.rels(ref.part)) {
      const rank = CLIP_TYPES.get(relType(r.type));
      if (rank === undefined || r.external || !pkg.has(r.target)) continue;
      const stored = pkg.find(r.target) ?? r.target;
      if (/\.(xml|rels)$/i.test(stored)) continue;
      const was = best.get(stored);
      if (was === undefined || rank < was) best.set(stored, rank);
    }
  const ranked = [...best].sort((a, b) => a[1] - b[1]).map(([part]) => part);
  return {
    clips: ranked.slice(0, PPTX_CLIENT_LIMITS.clips),
    over: Math.max(0, ranked.length - PPTX_CLIENT_LIMITS.clips),
  };
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

function sniffMediaKind(b: Uint8Array): 'video' | 'audio' | undefined {
  const at = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  const u = (o: number) => b[o] ?? -1;
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

function scanDeck(pkg: Package, listed: readonly SlideRef[]): PptxClientSceneScan {
  const images = new Map<string, Images>();
  const imagesOf = (part: string, drawings = true): Images => {
    let v = images.get(part);
    if (v) return v;
    v = { pictures: [], metafiles: [] };
    for (const r of pkg.rels(part)) {
      if (drawings && !r.external && relType(r.type) === 'diagramDrawing' && pkg.has(r.target)) {
        const d = imagesOf(pkg.find(r.target) ?? r.target, false);
        v.pictures.push(...d.pictures);
        v.metafiles.push(...d.metafiles);
        continue;
      }
      if (r.external || relType(r.type) !== 'image' || !pkg.has(r.target)) continue;
      const stored = pkg.find(r.target) ?? r.target;
      const ext = extensionOf(stored);
      if (METAFILE_EXTENSIONS.has(ext)) v.metafiles.push(stored);
      else if (ext !== 'svg') v.pictures.push(stored);
    }
    images.set(part, v);
    return v;
  };
  const pictures = new Set<string>();
  let picturesOver = 0;
  const over = new Set<string>();
  const metafiles: [number, string[]][] = [];
  const notes: [number, string][] = [];
  for (const ref of listed) {
    const layout = pkg.relOfType(ref.part, 'slideLayout')?.target;
    const master = layout === undefined ? undefined : pkg.relOfType(layout, 'slideMaster')?.target;
    const theme = master === undefined ? undefined : pkg.relOfType(master, 'theme')?.target;
    const shown = new Set<string>();
    for (const part of [ref.part, layout, master, theme]) {
      if (part === undefined) continue;
      const own = imagesOf(part);
      for (const p of own.pictures) {
        if (pictures.has(p) || over.has(p)) continue;
        if (pictures.size < PPTX_CLIENT_LIMITS.pictures) pictures.add(p);
        else if (over.size < PPTX_CLIENT_LIMITS.pictures) {
          over.add(p);
          picturesOver++;
        } else picturesOver++;
      }
      if (part !== theme)
        for (const m of own.metafiles) if (shown.size < MAX_METAFILES_PER_SLIDE) shown.add(m);
    }
    if (shown.size) metafiles.push([ref.index, [...shown]]);
    const text = readNotes(pkg, ref.part);
    if (text) notes.push([ref.index, text]);
  }
  const clips = clipParts(pkg, listed);
  return {
    pictures: [...pictures],
    picturesOver,
    metafiles,
    notes,
    loop: showLoops(pkg),
    ...(clips.clips.length ? { clips: clips.clips } : {}),
    ...(clips.over ? { clipsOver: clips.over } : {}),
  };
}

function extrasOf(pkg: Package, result: ConvertResult): Map<number, PptxClientSlideExtra> {
  const out = new Map<number, PptxClientSlideExtra>();
  for (const s of result.slides) {
    const part = result.listed[s.index]?.part;
    if (part === undefined) continue;
    const t = readSlideTransition(pkg, part);
    if (t.transition || t.advanceMs !== undefined || t.note) out.set(s.index, { index: s.index, ...t });
  }
  return out;
}

/**
 * Import and parse a PowerPoint deck (.pptx) entirely on the client.
 */
export async function importPptxClient(
  input: Blob | Uint8Array | ArrayBuffer,
  fileName: string,
  options: PptxClientOptions = {},
  onProgress?: (pct: number) => void,
): Promise<PptxClientImportResult> {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(await input.arrayBuffer());

  const deckHash = sha256Hex(bytes);
  const log: string[] = [];
  const addLog = (level: 'info' | 'warn', msg: string) => {
    log.push(`${level === 'warn' ? '[warn] ' : ''}${clean(msg, 400)}`);
  };

  onProgress?.(0.05);

  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  const parts = new Map<string, Uint8Array>();
  const oversized: string[] = [];
  let totalXmlBytes = 0;
  let embeddedFonts = 0;

  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const path = safeEntryPath(file.name);
    if (!path || SKIPPED_PART.test(path)) continue;

    if (FONT_PART.test(path)) {
      embeddedFonts++;
      parts.set(path, EMPTY);
      continue;
    }

    if (XML_PART.test(path)) {
      const declared = (file as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      if (declared > PPTX_CLIENT_LIMITS.xmlPartBytes) {
        oversized.push(path);
        parts.set(path, EMPTY);
        continue;
      }
      const data = await file.async('uint8array');
      totalXmlBytes += data.length;
      if (totalXmlBytes > PPTX_CLIENT_LIMITS.xmlTotalBytes) {
        throw new Error(
          `The deck holds more than ${PPTX_CLIENT_LIMITS.xmlTotalBytes / 1024 ** 2} MB of slide XML`,
        );
      }
      parts.set(path, data);
    } else {
      // Non-XML parts kept as empty placeholders so relationships resolve.
      parts.set(path, EMPTY);
    }
  }

  for (const p of oversized)
    addLog('warn', `${p} is over ${PPTX_CLIENT_LIMITS.xmlPartBytes / 1024 ** 2} MB: not read`);
  if (embeddedFonts)
    addLog('info', `${embeddedFonts} embedded font part(s) not used (embedded fonts come later)`);

  onProgress?.(0.15);

  const pkg = openPackage(parts);
  // M9: what the hub's converter is told (`sceneTask.ts`): its stored fields, and whether LibreOffice is there.
  const withLo = options.libreoffice !== false;
  const m9 = { m9Writes: CLIENT_M9_WRITES, ...(withLo ? {} : { libreoffice: false }) };
  const first = convertDeck(parts, {
    range: { from: 0, to: 0 },
    extendBackgrounds: options.extendBackgrounds ?? true,
    transitionSounds: options.transitionSounds ?? false,
    ...m9,
    newId,
  });

  const listed = first.listed;
  if (!listed.length) throw new Error('The deck has no slides');

  const scan = scanDeck(pkg, listed);
  for (const n of first.notes) addLog('info', n);
  addLog('info', `${listed.length} slide(s), ${scan.pictures.length} picture(s) referenced`);

  onProgress?.(0.25);

  // Read picture headers and sizes for referenced pictures
  const pictureHeaders = new Map<string, PictureHeader>();
  const sceneSizes = new Map<string, ScenePictureHeader>();
  for (const picPath of scan.pictures) {
    const f = zip.file(picPath);
    if (!f) continue;
    const headBytes = await f.async('uint8array');
    const header = pictureHeader(headBytes, { complete: true });
    if (header) pictureHeaders.set(picPath, header);
    const sz = pictureSize(headBytes);
    if (sz) sceneSizes.set(picPath, sz);
  }

  // Sniff clip kinds for referenced clips
  const mediaKinds = new Map<string, 'video' | 'audio'>();
  for (const clipPath of scan.clips ?? []) {
    const f = zip.file(clipPath);
    if (!f) continue;
    const clipBytes = await f.async('uint8array');
    const kind = sniffMediaKind(clipBytes.subarray(0, 4096));
    if (kind) mediaKinds.set(clipPath, kind);
  }

  onProgress?.(0.4);

  // Convert full deck
  const result = convertDeck(parts, {
    range: { from: 0, to: listed.length },
    pictureSize: (p) => sceneSizes.get(p),
    mediaKind: (p) => mediaKinds.get(p),
    extendBackgrounds: options.extendBackgrounds ?? true,
    transitionSounds: options.transitionSounds ?? false,
    ...m9,
    newId,
  });

  const extras = extrasOf(openPackage(parts), result);

  // Geometry files with budget check
  const geomById = new Map<string, NamedGeomFile | undefined>();
  for (const g of result.geoms ?? []) geomById.set(g.id, geomFileOf(g.file));
  const geomFiles = new Map<string, NamedGeomFile>();
  const geomNames = new Map<string, string>();
  const geomOver = new Set<number>();
  let geomBytes = 0;
  for (const s of result.slides) {
    const ids = drawnGeomRefs(s.slide).filter((id) => geomById.get(id) && !geomNames.has(id));
    const fresh = new Map<string, number>();
    for (const id of ids) {
      const f = geomById.get(id)!;
      if (!geomFiles.has(f.hash)) fresh.set(f.hash, f.bytes.length);
    }
    const add = [...fresh.values()].reduce((a, b) => a + b, 0);
    if (geomBytes + add > PPTX_CLIENT_LIMITS.geomFileBytes) {
      geomOver.add(s.index);
      continue;
    }
    geomBytes += add;
    for (const id of ids) {
      const f = geomById.get(id)!;
      geomNames.set(id, f.hash);
      geomFiles.set(f.hash, f);
    }
  }
  result.geoms = [];
  // The scene the hub builds from (`nativeJob.ts`): a slide past the bound keeps the placeholders of the
  // files it was not given, so the hub leaves out the objects that name them and says what they drew, as for
  // its own batches (M9 `ladder.ts` `withoutFiles`). This parse's own slides lose only the refs.
  const sceneSlides: EmittedSlide[] = [];
  for (const s of result.slides) {
    if (geomOver.has(s.index)) {
      const keep = new Map(geomNames);
      for (const id of drawnGeomRefs(s.slide)) if (!keep.has(id)) keep.set(id, id);
      sceneSlides.push(structuredClone({ ...s, slide: nameGeoms(s.slide, keep) }));
    }
    s.slide = nameGeoms(s.slide, geomNames);
    if (!geomOver.has(s.index)) sceneSlides.push(structuredClone(s));
  }

  const decoder = new TextDecoder();
  const clientScene: PptxClientScene = {
    version: CONVERTER_VERSION,
    oversized,
    fonts: embeddedFonts,
    scan,
    listed: [...listed],
    sections: [...first.sections],
    slideRect: first.slideRect,
    notes: [...first.notes],
    slides: sceneSlides,
    media: [...result.media],
    extras: [...extras.values()],
    geomFiles: [...geomFiles.values()].map((g) => ({ hash: g.hash, json: decoder.decode(g.bytes) })),
    ...(geomOver.size ? { geomOver: [...geomOver] } : {}),
    ...(withLo ? {} : { libreoffice: false }),
  };

  onProgress?.(0.6);

  // Draft slides
  const drafts: Draft[] = listed.map((ref) => {
    const s = result.slides.find((x) => x.index === ref.index);
    const label = `slide ${ref.index + 1}`;
    if (!s) {
      return {
        ref,
        slide: { id: newId(), objects: [] },
        media: new Map(),
        cls: 'picture',
        notes: ['not converted: a fallback picture is shown instead'],
      };
    }
    const own = s.notes.filter((n) => n !== SLIDE_BUDGET_NOTE && n !== SLIDE_BYTES_NOTE);
    for (const n of own) addLog('info', `${label}: ${n}`);
    const d: Draft = {
      ref,
      slide: { ...s.slide, objects: s.slide.objects.map(imported) },
      media: new Map(result.media.map((m) => [m.id, m.part])),
      cls: s.classification.class,
      notes: own,
      ...(s.art ? { art: s.art, artText: s.art.text } : {}),
      ...(s.overBudget ? { overBudget: true } : {}),
      ...(geomOver.has(s.index) ? { overGeoms: true } : {}),
      ...(s.clips?.length ? { clips: s.clips } : {}),
    };
    // M9, without LibreOffice: the converter planned no art and listed what is not drawn (its note is in
    // the slide's notes already); the art's text stays for search.
    if (!withLo) {
      const missing = (s.missing ?? []).filter((m) => typeof m === 'string').slice(0, MISSING_LIMITS.entries);
      if (missing.length) d.missing = missing;
      if (s.artText && !d.artText) d.artText = s.artText;
    }
    if (ref.hidden) d.slide.hidden = true;
    const noteText = scan.notes.find(([idx]) => idx === ref.index)?.[1];
    if (noteText) d.slide.notes = noteText.slice(0, NOTES_CUT_CHARS);
    const x = extras.get(ref.index);
    if (x?.transition) d.slide.transition = x.transition;
    if (x?.advanceMs !== undefined && x.advanceMs > 0) d.slide.durationMs = x.advanceMs;
    if (x?.note) d.notes.push(x.note);
    if (s.metafiles?.length && d.cls !== 'picture') {
      d.metafiles = s.metafiles.map((m) => ({ ...m, object: imported(m.object) }));
      d.notes.push(`${s.metafiles.length} metafile picture(s) wait for fallback`);
    }
    if (d.cls === 'picture') toPicture(d);
    return d;
  });

  onProgress?.(0.7);

  // Size budgets
  const stored = drafts.map((d) => record(d, 'x'.repeat(16), withLo));
  const sizes = stored.map((sl) => slideBytes(sl));
  const plan = planImportSizes(
    sizes,
    stored.map((sl) => compactSlideBytes(sl)),
    IMPORT_RESERVE_BYTES,
  );
  let compact = 0;
  drafts.forEach((d, i) => {
    const why = d.overBudget ? 'slide' : d.cls === 'picture' ? null : d.overGeoms ? 'geoms' : plan.reasons[i];
    if (!why) return;
    compact++;
    d.compact = true;
    toPicture(d);
  });

  onProgress?.(0.8);

  // Prepare pictures
  const usedMediaIds = new Set<string>();
  for (const d of drafts) {
    if (d.slide.backgroundMediaId?.startsWith(MEDIA_PREFIX)) usedMediaIds.add(d.slide.backgroundMediaId);
    for (const o of d.slide.objects) {
      if (o.type === 'image' && o.mediaId.startsWith(MEDIA_PREFIX)) usedMediaIds.add(o.mediaId);
    }
  }

  const storedPictures = new Map<string, PptxClientPicture>();
  const placeholderToKey = new Map<string, string>();
  let picIndex = 0;

  for (const m of result.media) {
    if (!usedMediaIds.has(m.id)) continue;
    const existing = storedPictures.get(m.part);
    if (existing) {
      placeholderToKey.set(m.id, existing.key);
      continue;
    }
    const f = zip.file(m.part);
    if (!f) continue;
    let picBytes = await f.async('uint8array');
    const header = pictureHeaders.get(m.part) ?? pictureHeader(picBytes, { complete: true });
    if (header) {
      picBytes = clearExifOrientation(picBytes, header);
    }
    const ext = extensionOf(m.part);
    const mime = mimeOfExtension(ext);
    const base = m.part.split('/').pop() ?? 'picture';
    const key = `${MEDIA_PREFIX}${picIndex++}`;
    storedPictures.set(m.part, {
      key,
      part: m.part,
      bytes: picBytes,
      mime,
      name: `${fileName.replace(/\.[^.]+$/, '')} – ${base}`,
      width: header?.width,
      height: header?.height,
      hasAlpha: header?.alpha,
    });
    placeholderToKey.set(m.id, key);
  }

  onProgress?.(0.9);

  // Remap placeholders & assemble presentation
  const slideRect = first.slideRect;
  for (const d of drafts) {
    const bgPh = d.slide.backgroundMediaId;
    const bgPart = bgPh ? d.media.get(bgPh) : undefined;
    const bgHasAlpha = bgPart ? pictureHeaders.get(bgPart)?.alpha : false;

    const map = new Map<string, string>();
    for (const [ph] of d.media) {
      const key = placeholderToKey.get(ph);
      if (key) map.set(ph, key);
    }
    d.slide = remapMediaIds(d.slide, map);
    const bg = d.slide.backgroundMediaId;
    if (bg && bgHasAlpha) {
      delete d.slide.backgroundMediaId;
      if (d.cls !== 'picture') d.slide.objects.unshift(...backgroundOnWhite(bg, slideRect));
      d.notes.push('a background picture with transparency is drawn on white');
    }
  }

  const kind = isLoop(drafts, scan.loop) ? 'loop' : 'slides';
  const presId = options.presentationId || newId();
  const title = fileName.replace(/\.[^.]+$/, '').slice(0, 200) || 'PowerPoint';

  const p: Presentation = {
    id: presId,
    rev: 1,
    title,
    kind,
    meta: { tags: [] },
    sections: [],
    arrangements: [],
    source: { kind: 'pptx', fileId: deckHash },
    archived: false,
  };

  if (kind === 'loop') {
    p.loop = {
      defaultSlideMs: mostCommon(drafts.map((d) => d.slide.durationMs ?? 0).filter((v) => v > 0)),
    };
  }

  const bgs = new Set(drafts.map((d) => d.slide.backgroundMediaId));
  const [onlyBg] = bgs;
  if (bgs.size === 1 && onlyBg) {
    p.backgroundMediaId = onlyBg;
    for (const d of drafts) delete d.slide.backgroundMediaId;
  }

  // Mark background pictures
  const bgKeys = new Set<string>();
  if (p.backgroundMediaId) bgKeys.add(p.backgroundMediaId);
  for (const d of drafts) {
    if (d.slide.backgroundMediaId) bgKeys.add(d.slide.backgroundMediaId);
  }
  for (const pic of storedPictures.values()) {
    if (bgKeys.has(pic.key)) pic.isBackground = true;
  }

  for (const d of drafts) d.slide.pptx = provenance(d, deckHash, withLo);
  p.sections = sectionsOf(drafts, first.sections);
  p.arrangements = [{ id: newId(), name: 'Default', sectionIds: p.sections.map((s) => s.id) }];
  sanitizePresentation(p);

  const byId = new Map(drafts.map((d) => [d.slide.id, d]));
  for (const sec of p.sections) {
    sec.slides = sec.slides.map((sl) => {
      const ok = Slide.safeParse(sl);
      if (ok.success) return ok.data;
      const d = byId.get(sl.id);
      if (!d) return Slide.parse({ id: sl.id, objects: [] });
      toPicture(d);
      d.notes.push('not storable natively: a fallback picture');
      d.slide.pptx = provenance(d, deckHash, withLo);
      const again = Slide.safeParse(d.slide);
      return again.success ? again.data : Slide.parse({ id: sl.id, objects: [], pptx: d.slide.pptx });
    });
  }

  const slides = p.sections.flatMap((s) => s.slides);
  for (const sl of slides) {
    if (sl.pptx) sl.pptx.digest = digestOf(sl.objects.filter((o) => o.origin));
  }

  const classes = slides.map((sl) => sl.pptx?.class ?? 'native');
  const counts = {
    native: classes.filter((c) => c === 'native').length,
    hybrid: classes.filter((c) => c === 'hybrid').length,
    picture: classes.filter((c) => c === 'picture').length,
  };

  p.source = {
    kind: 'pptx',
    fileId: deckHash,
    native: { version: CONVERTER_VERSION, slides: slides.length, ...counts, slideRect },
  };

  const lo = loSlides(drafts, slides);
  if (lo.length) addLog('info', `${lo.length} slide(s) require LibreOffice fallback`);

  const fonts = missingFonts(fontFamilies(slides), []);
  p.source.log = log.join('\n');

  onProgress?.(1.0);

  return {
    presentation: p,
    deckHash,
    pictures: storedPictures,
    geoms: [...geomFiles.values()],
    clips: scan.clips ?? [],
    loSlides: lo,
    classes,
    compact,
    pending: lo.length,
    missingFonts: fonts,
    notes: log.filter((l) => l.startsWith('[warn] ')).map((l) => l.slice(7)),
    log,
    clientScene,
  };
}
