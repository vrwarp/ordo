/**
 * The native column of the fidelity harness (design/27 §14.1, M1): a deck read by `@ordo/pptx-scene` and
 * drawn by `@ordo/renderer`, as the hub and the outputs will draw it.
 *
 * - `convertDeck` reads the deck with `extractZip` (XML in memory within the hub's budgets, everything else
 *   spilled to disk), runs `parseDeck` (picture sizes read from the spilled files' headers) and
 *   `emitSlides`, and writes `slides.json` plus the pictures the slides use, under generated names (a part
 *   name never becomes a path). It never throws: a deck the converter cannot read is a note.
 * - `convertDeckIsolated` runs it in a worker thread with a heap limit and a timeout, as the hub's CPU pool
 *   will (design/27 §12): a deck that exhausts either is a note, and the run goes on.
 * - Each slide also gets its features (`features/`, from its own XML and the parts it names) and the
 *   LibreOffice policy rules that change its drawing (`compat/`; the deck is emitted a second time with
 *   `EmitOptions.loCompat`); with `loCompat` the slide as LibreOffice draws it is kept too (`compatSlide`).
 * - With `noLibreOffice` (`--no-libreoffice`, M9) the deck is emitted once more as a hub without LibreOffice
 *   emits it (`EmitOptions.libreoffice: false`): the art and the metafile conversions are left out and listed
 *   in `missing`; the run draws that slide as the hub stores it (`hubStoredSlide`) for `noLoSsim`.
 * - `NativeRenderer` loads `native-page.ts` (bundled with esbuild) in headless Chromium, gives the page's
 *   font resolver the faces this machine has for every family the slides ask for, ordo's default face and
 *   the script fallbacks (`fonts.ts`, as LibreOffice and the outputs draw them), and draws every shown slide
 *   with `drawSlide2D`: a 1920x1080 picture cut to the slide area, and raster timings at 1920 and 3840 px;
 *   then, with the timings, each slide's objects drawn cold one at a time (`maxObjectMs`).
 *   A caller can give the page other faces instead (`RenderOptions.fonts`): an output's own, so the page
 *   and the output draw with the same files (e2e/pptx-native.spec.ts).
 *
 * The deck is untrusted: the page fetches only from the harness's own origin, which answers from a fixed
 * table of generated names, and every other request is refused.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type BudgetLevel, drawnGeomRefs, type GeomFile, type Slide } from '@ordo/domain';
import { extractZip } from '@ordo/importers/zip-stream.ts';
import { Worker } from 'node:worker_threads';
import {
  type EmitOptions,
  type EmitResult,
  type EmittedSlide,
  emitSlides,
  parseDeck,
  type PictureHeader,
  pictureSize,
  type SlideClass,
  type Tier,
} from '@ordo/pptx-scene';
import type { FaceRequest } from '@ordo/renderer/text/types.ts';
import { planLadder, provenanceStandIn, withoutFiles } from '../../../apps/hub/src/pptx/ladder.ts';
import { CONVERTER_VERSION, PPTX_LIMITS } from '../../../apps/hub/src/pptx/shared.ts';
import type { Browser, Page } from '@playwright/test';
import { bakePicture } from './bake.ts';
import { hostFace } from './faces.ts';
import { type CompatRule, compatRules, drawingKey } from './compat/index.ts';
import { deckFeatures, type Features, featureSource, partFeatures } from './features/index.ts';
import { type HarnessFont, hostFonts, type ScriptFace } from './fonts.ts';
import type { NativePage, ObjectsResult, PageFont, PageMedia, RenderResult } from './native-page.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

/** XML parts kept in memory: at most this much each, and in all (design/27 §2 step 1, §12). */
export const MAX_XML_PART_BYTES = 8 * 1024 * 1024;
export const MAX_XML_TOTAL_BYTES = 64 * 1024 * 1024;
/** Pictures written out per deck (design/27 §12); the rest are left out with a note. */
export const MAX_PICTURES = 2_000;
/** The harness's origin in the page; nothing else is reachable. */
const ORIGIN = 'https://ordo-native.invalid';
/** One slide's draw and timings may take this long before the page is replaced. */
const SLIDE_TIMEOUT_MS = 60_000;
/** One deck's conversion in its worker: heap and time (design/27 §12: the pool's 512 MB heap). */
export const CONVERT_HEAP_MB = 512;
export const CONVERT_TIMEOUT_MS = 300_000;
/** Bytes of a spilled picture read for its pixel size (a JPEG's frame header can follow large metadata). */
const SIZE_HEAD_BYTES = 64 * 1024;
const SIZE_HEAD_MAX_BYTES = 1024 * 1024;

export type NativeSlide = {
  index: number;
  /** Position among the shown slides (LibreOffice's page number − 1); undefined when hidden. */
  shown?: number;
  hidden: boolean;
  tier: Tier;
  class: SlideClass;
  reasons: string[];
  /** Reading and emitting this slide, in ms (`SlideScene.ms` + `EmittedSlide.ms`). */
  convertMs: number;
  notes: string[];
  /** The slide as ordo draws it. */
  slide: Slide;
  /** Text features of the slide's own XML (`features/text.ts`). */
  textFeatures: string[];
  /** The other registered families' features (`features/index.ts`; none before the M9 tracks add theirs). */
  xmlFeatures?: string[];
  /** LibreOffice policy rules that change how the slide is drawn (`compat/`). */
  compat: CompatRule[];
  /** With `loCompat`: the slide as LibreOffice draws it, when that differs from `slide`. */
  compatSlide?: Slide;
  /** Hybrid: the art's box in logical px (`EmittedSlide.art`), where the hub's version 2 draws LibreOffice. */
  art?: { x: number; y: number; w: number; h: number };
  /** The boxes of the metafile pictures left out of `slide` until LibreOffice converts them. */
  metafiles?: { x: number; y: number; w: number; h: number; rotation: number }[];
  /** Classed picture by the converter's slide budget alone (`EmittedSlide.overBudget`). */
  overBudget?: true;
  /**
   * With `noLibreOffice`: the slide as a hub without LibreOffice emits it (`EmitOptions.libreoffice: false`,
   * with the policies `slide` or `compatSlide` is drawn with), when that differs from the slide drawn.
   */
  noLoSlide?: Slide;
  /** With `noLibreOffice`: that emission's class where it differs (hybrid with `missing:<kind>` in M9). */
  noLoClass?: SlideClass;
  /** With `noLibreOffice`: what nothing draws without LibreOffice (`EmittedSlide.missing`: kinds). */
  missing?: string[];
  /**
   * Set by the run, not the converter: what `noLoSsim` is drawn from (the hub's stored form of the slide
   * without LibreOffice, `hubStoredSlide`), when it differs from the slide drawn; `renderDeck` draws it as
   * `slide-NNNN.nolo.png` with `RenderOptions.noLo`.
   */
  noLoDraw?: Slide;
};

/** What `convertDeck` is asked for besides the slides. */
export type ConvertOptions = {
  /** Keep each slide as LibreOffice draws it as well (`--lo-compat`). */
  loCompat?: boolean;
  /** Emit the deck as a hub without LibreOffice does as well (`--no-libreoffice`, `NativeSlide.noLoSlide`). */
  noLibreOffice?: boolean;
};

export type NativeMedia = {
  /** The placeholder media id the slides use (`pptxmedia:<part>`). */
  id: string;
  part: string;
  /** The picture under the deck's native folder (`media/<n>.<ext>`), when written. */
  file?: string;
  /** Sniffed type; only png, jpeg, gif, webp and bmp are drawn. */
  type?: string;
};

export type NativeDeck = {
  slides: NativeSlide[];
  /** The deck's slide area in logical px. */
  slideRect: { x: number; y: number; w: number; h: number };
  media: NativeMedia[];
  /**
   * The geometry files the slides name (`ShapeGeom.ref`, `EmitResult.geoms`; the slides as LibreOffice draws
   * them name the same placeholders), which the page reads before it draws, as an output does.
   */
  geoms?: { id: string; file: GeomFile }[];
  notes: string[];
  /** The deck carries font files (`ppt/fonts/`); LibreOffice 24.2 ignores them (design/27 §14.1). */
  embeddedFonts: boolean;
  /** Text features of every slide part and the presentation part (`deckFeatures`). */
  textFeatures: string[];
  /** The other registered families' features of the deck (`deckFeatures`). */
  xmlFeatures?: string[];
  /** Reading the zip, parsing and emitting the whole deck, in ms. */
  extractMs: number;
  parseMs: number;
  emitMs: number;
  /** Set when the converter could not read the deck at all. */
  error?: string;
};

/** A deck string made safe for a note: no control characters or newlines, at most `max` characters. */
export function clean(s: string, max = 200): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const errorText = (e: unknown) => clean(e instanceof Error ? e.message : String(e), 300);

/** Entries kept in memory: XML and relationship parts up to 8 MB; everything else is spilled to disk. */
export function spillPart(path: string, size: number): boolean {
  return !/\.(xml|rels)$/i.test(path) || size > MAX_XML_PART_BYTES;
}

/** The type of a picture from its first bytes, or undefined when Chromium is not asked to draw it. */
export function sniffPicture(head: Uint8Array): string | undefined {
  const at = (i: number, ...b: number[]) => b.every((v, k) => head[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (at(0, 0x42, 0x4d)) return 'bmp';
  return undefined;
}

async function head(file: string): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(16);
    const { bytesRead } = await fh.read(b, 0, 16, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** A part's XML text ('' when it is missing or was spilled). */
function xmlOf(files: ReadonlyMap<string, Uint8Array>, part: string): string {
  const b = files.get(part) ?? files.get(findCaselessKey(files, part) ?? '');
  return b?.length ? new TextDecoder().decode(b) : '';
}

const extOf = (part: string) => /\.([a-z0-9]{1,8})$/i.exec(part)?.[1]?.toLowerCase() ?? '';

/** The first `n` bytes of a file, synchronously (`parseDeck` asks for picture sizes while it runs). */
function headSync(file: string, n: number): Uint8Array {
  const fd = openSync(file, 'r');
  try {
    const b = new Uint8Array(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * The pixel size of a spilled picture from its header (64 KB, or up to 1 MB for a JPEG), and whether it may
 * be transparent (`PictureHeader.alpha`: a background that may be is laid on white, not cover-fitted).
 */
export function spilledPictureSize(file: string | undefined): PictureHeader | undefined {
  if (!file) return undefined;
  try {
    const b = headSync(file, SIZE_HEAD_BYTES);
    const px = pictureSize(b);
    if (px || b.length < SIZE_HEAD_BYTES || b[0] !== 0xff || b[1] !== 0xd8) return px;
    return pictureSize(headSync(file, SIZE_HEAD_MAX_BYTES));
  } catch {
    return undefined;
  }
}

/**
 * Convert one deck into `dir` (which must exist): `slides.json` and `media/`. Never throws; a deck that
 * cannot be read comes back with `error` and no slides.
 */
export async function convertDeck(
  deckFile: string,
  dir: string,
  opts: ConvertOptions = {},
): Promise<NativeDeck> {
  const out: NativeDeck = {
    slides: [],
    slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
    media: [],
    geoms: [],
    notes: [],
    embeddedFonts: false,
    textFeatures: [],
    extractMs: 0,
    parseMs: 0,
    emitMs: 0,
  };
  const note = (m: string) => {
    if (out.notes.length < 200) out.notes.push(m);
  };
  const parts = join(dir, '.parts');
  await mkdir(parts, { recursive: true });
  try {
    let t0 = performance.now();
    const zip = await extractZip(deckFile, {
      dir: parts,
      spill: spillPart,
      maxInMemoryBytes: MAX_XML_TOTAL_BYTES,
    });
    out.extractMs = performance.now() - t0;
    for (const [name, file] of zip.onDisk)
      if (/\.(xml|rels)$/i.test(name)) {
        note(`XML part over ${MAX_XML_PART_BYTES / 1024 ** 2} MB not read: ${clean(name)}`);
        zip.files.delete(name);
        await rm(file, { force: true });
      }
    out.embeddedFonts = [...zip.files.keys()].some((k) => k.toLowerCase().startsWith('ppt/fonts/'));

    t0 = performance.now();
    const spilled = caseless(zip.onDisk);
    const fileOf = (part: string) => zip.onDisk.get(part) ?? spilled.get(part.toLowerCase());
    const scene = parseDeck(zip.files, {
      pictureSize: (part) => spilledPictureSize(fileOf(part)),
      // Table rows grow to their text measured with the faces the page draws it with.
      fontFace: hostFace,
    });
    out.parseMs = performance.now() - t0;
    t0 = performance.now();
    // One placeholder per geometry file over both emissions (the slides as LibreOffice draws them below).
    const geomIds = new Map<string, string>();
    const geomId = (json: string) => {
      let id = geomIds.get(json);
      if (id === undefined) geomIds.set(json, (id = `pptxgeom:${geomIds.size + 1}`));
      return id;
    };
    const emitted: EmitResult = emitSlides(scene, { geomId });
    out.emitMs = performance.now() - t0;
    const geoms = new Map(emitted.geoms.map((g) => [g.id, g]));
    out.slideRect = emitted.slideRect;
    for (const n of [...scene.notes, ...emitted.notes]) note(n);

    const sceneMs = new Map(scene.slides.map((s) => [s.index, s.ms]));
    const read = (part: string) => xmlOf(zip.files, part);
    const features = new Map<number, Features>(
      scene.slides.map((s) => [s.index, partFeatures(featureSource(s.part, read))] as const),
    );
    const deck = deckFeatures(features.values(), partFeatures(featureSource('ppt/presentation.xml', read)));
    out.textFeatures = deck.textFeatures;
    if (deck.xmlFeatures.length) out.xmlFeatures = deck.xmlFeatures;
    // LibreOffice's policies: the converter writes them (`EmitOptions.loCompat`), compat.ts names them.
    const hits = compatRules(scene);
    let compatSlides: Map<number, Slide> | undefined;
    try {
      if (hits.size) {
        const lo = emitSlides(scene, { loCompat: true, geomId });
        for (const g of lo.geoms) if (!geoms.has(g.id)) geoms.set(g.id, g);
        compatSlides = new Map(lo.slides.map((s) => [s.index, still(s)] as const));
      }
    } catch (e) {
      note(`the slides as LibreOffice draws them could not be emitted: ${errorText(e)}`);
    }
    // A hub without LibreOffice (M9, `EmitOptions.libreoffice`), drawn with the same policies as the slides
    // above.
    let noLo: Map<number, EmittedSlide> | undefined;
    if (opts.noLibreOffice)
      try {
        const o: EmitOptions = {
          geomId,
          ...(opts.loCompat && hits.size ? { loCompat: true } : {}),
          libreoffice: false,
        };
        const r = emitSlides(scene, o);
        for (const g of r.geoms) if (!geoms.has(g.id)) geoms.set(g.id, g);
        noLo = new Map(r.slides.map((s) => [s.index, s] as const));
      } catch (e) {
        note(`the slides as a hub without LibreOffice emits them could not be emitted: ${errorText(e)}`);
      }
    out.geoms = [...geoms.values()];
    out.slides = emitted.slides.map((s) => {
      // Drawn as a still (a motion background as its poster), as LibreOffice draws the slide.
      const slide = still(s);
      const lo = compatSlides?.get(s.index);
      const differs = lo !== undefined && drawingKey(lo) !== drawingKey(slide);
      const rules: CompatRule[] = differs ? [...(hits.get(s.index) ?? [])].sort() : [];
      const nl = noLo?.get(s.index);
      const nlSlide = nl ? still(nl) : undefined;
      const drawn = opts.loCompat && differs ? lo : slide;
      const missing = nl?.missing;
      const f = features.get(s.index);
      return {
        index: s.index,
        ...(s.shown !== undefined ? { shown: s.shown } : {}),
        hidden: s.hidden,
        tier: s.classification.tier,
        class: s.classification.class,
        reasons: s.classification.reasons,
        convertMs: (sceneMs.get(s.index) ?? 0) + s.ms,
        notes: s.notes,
        slide,
        textFeatures: f?.textFeatures ?? [],
        xmlFeatures: f?.xmlFeatures ?? [],
        compat: rules,
        ...(opts.loCompat && differs ? { compatSlide: lo } : {}),
        ...(s.art ? { art: { ...s.art.box } } : {}),
        ...(s.metafiles?.length ? { metafiles: s.metafiles.map((m) => ({ ...m.object.box })) } : {}),
        ...(s.overBudget ? { overBudget: true as const } : {}),
        ...(nl && nlSlide && drawingKey(nlSlide) !== drawingKey(drawn) ? { noLoSlide: nlSlide } : {}),
        ...(nl && nl.classification.class !== s.classification.class
          ? { noLoClass: nl.classification.class }
          : {}),
        ...(missing?.length ? { missing: missing.slice(0, 16) } : {}),
      };
    });

    // The pictures the slides use, under generated names; anything Chromium is not asked to draw is
    // counted by its extension.
    const media = join(dir, 'media');
    await mkdir(media, { recursive: true });
    const skipped = new Map<string, number>();
    // Baked pictures first (M6, `bake.ts`): they read their source part before it is moved into place.
    const widest = new Map<string, number>();
    for (const s of out.slides)
      for (const o of s.slide.objects ?? [])
        if (o.type === 'image') widest.set(o.mediaId, Math.max(widest.get(o.mediaId) ?? 0, o.box.w));
    for (const [k, m] of emitted.media.entries()) {
      if (!m.bake) continue;
      const entry: NativeMedia = { id: m.id, part: m.part };
      out.media.push(entry);
      const src = fileOf(m.part);
      const type = src ? sniffPicture(await head(src)) : undefined;
      const size = src ? spilledPictureSize(src) : undefined;
      if (!src || !type || !size) {
        note(`a baked picture's source is missing or unreadable: ${clean(m.part)}`);
        continue;
      }
      const name = `media/${k + 1}.png`;
      try {
        const w = widest.get(m.id);
        await bakePicture(src, type, size, m.bake, w ? { w, h: 0 } : undefined, join(dir, name));
        entry.file = name;
        entry.type = 'png';
      } catch (e) {
        note(`a picture could not be baked (${clean(m.part)}): ${errorText(e)}`);
      }
    }
    for (const [k, m] of emitted.media.entries()) {
      if (m.bake) continue;
      const entry: NativeMedia = { id: m.id, part: m.part };
      out.media.push(entry);
      const src = fileOf(m.part);
      if (!src) {
        note(`picture part missing from the deck: ${clean(m.part)}`);
        continue;
      }
      if (k >= MAX_PICTURES) {
        skipped.set('over the limit', (skipped.get('over the limit') ?? 0) + 1);
        continue;
      }
      const type = sniffPicture(await head(src));
      if (!type) {
        const ext = extOf(m.part) || 'unknown';
        skipped.set(ext, (skipped.get(ext) ?? 0) + 1);
        continue;
      }
      const name = `media/${k + 1}.${type === 'jpeg' ? 'jpg' : type}`;
      await rename(src, join(dir, name)).catch(() => copyFile(src, join(dir, name)));
      entry.file = name;
      entry.type = type;
    }
    if (skipped.size)
      note(
        `pictures not drawn: ${[...skipped]
          .map(([ext, n]) => `${n} ${clean(ext, 20)}`)
          .sort()
          .join(', ')}`,
      );
  } catch (e) {
    out.error = errorText(e);
    note(`converter failed: ${out.error}`);
  } finally {
    await rm(parts, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await writeFile(join(dir, 'slides.json'), JSON.stringify(out));
  return out;
}

/** The conversion worker, kept between decks (warm, as the hub's pool workers are) until one fails. */
let pool: { worker: Worker; heapMb: number } | undefined;
/** Conversions run one at a time. */
let queue: Promise<unknown> = Promise.resolve();

/** The tsx ESM loader as a file URL: the worker runs from TypeScript source (as `apps/hub/src/pool.ts`'s). */
function tsxLoaderUrl(): string {
  const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
  return pathToFileURL(join(dirname(pkg), 'dist', 'loader.mjs')).href;
}

function spawnWorker(heapMb: number): Worker {
  const worker = new Worker(new URL('./convert-worker.ts', import.meta.url), {
    // Its own loader, not the parent's flags: under a test runner they do not load TypeScript.
    execArgv: ['--import', tsxLoaderUrl()],
    resourceLimits: { maxOldGenerationSizeMb: heapMb },
  });
  worker.unref(); // an idle worker does not keep the run alive
  return worker;
}

/**
 * `convertDeck` in a worker thread with a heap limit and a timeout. Never throws: a deck whose conversion
 * runs out of memory or time, or whose worker fails, comes back with `error` and no slides (and its
 * `slides.json` says so); that worker is replaced for the next deck. The worker is kept between decks
 * otherwise, and loads its TypeScript through tsx's loader.
 */
export function convertDeckIsolated(
  deckFile: string,
  dir: string,
  limits: { heapMb?: number; timeoutMs?: number } & ConvertOptions = {},
): Promise<NativeDeck> {
  const run = queue.then(() => convertInWorker(deckFile, dir, limits));
  queue = run.catch(() => undefined);
  return run;
}

async function convertInWorker(
  deckFile: string,
  dir: string,
  limits: { heapMb?: number; timeoutMs?: number } & ConvertOptions,
): Promise<NativeDeck> {
  const heapMb = limits.heapMb ?? CONVERT_HEAP_MB;
  const timeoutMs = limits.timeoutMs ?? CONVERT_TIMEOUT_MS;
  const result = await new Promise<NativeDeck | string>((settle) => {
    try {
      if (pool && pool.heapMb !== heapMb) {
        void pool.worker.terminate();
        pool = undefined;
      }
      pool ??= { worker: spawnWorker(heapMb), heapMb };
    } catch (e) {
      settle(errorText(e));
      return;
    }
    const { worker } = pool;
    let done = false;
    const finish = (v: NativeDeck | string, broken: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (broken) {
        if (pool?.worker === worker) pool = undefined;
        void worker.terminate();
      } else worker.unref();
      settle(v);
    };
    const onMessage = (m: NativeDeck) => finish(m, false);
    const onError = (e: Error) =>
      finish(
        (e as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out of memory' : errorText(e),
        true,
      );
    const onExit = (code: number) => finish(`the converter exited (${code})`, true);
    const timer = setTimeout(
      () => finish(`timed out after ${Math.round(timeoutMs / 1000)} s`, true),
      timeoutMs,
    );
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.ref();
    worker.postMessage({
      deckFile,
      dir,
      opts: { loCompat: limits.loCompat === true, noLibreOffice: limits.noLibreOffice === true },
    });
  });
  if (typeof result !== 'string') return result;
  await rm(join(dir, '.parts'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const out: NativeDeck = {
    slides: [],
    slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
    media: [],
    notes: [`converter failed: ${result}`],
    embeddedFonts: false,
    textFeatures: [],
    extractMs: 0,
    parseMs: 0,
    emitMs: 0,
    error: result,
  };
  await writeFile(join(dir, 'slides.json'), JSON.stringify(out));
  return out;
}

/**
 * Spilled files by lower-case part name, the first of a case clash winning (as `@ordo/pptx-scene` finds
 * parts): built once per deck, so a deck of thousands of pictures is not scanned once per picture.
 */
export function caseless(onDisk: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of onDisk) {
    const low = k.toLowerCase();
    if (!out.has(low)) out.set(low, v);
  }
  return out;
}

function findCaselessKey(m: ReadonlyMap<string, unknown>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const k of m.keys()) if (k.toLowerCase() === want) return k;
  return undefined;
}

// ── Chromium ─────────────────────────────────────────────────────────────────────────────────────────────

/** The part of esbuild's API the harness uses (esbuild is not a dependency, so its types are not either). */
type Esbuild = {
  build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

/** esbuild is not a dependency; vite (apps/output) depends on it, so resolve it through vite. */
async function loadEsbuild(): Promise<Esbuild> {
  let path: string;
  try {
    path = createRequire(import.meta.url).resolve('esbuild');
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    path = createRequire(fromOutput.resolve('vite')).resolve('esbuild');
  }
  const mod = (await import(pathToFileURL(path).href)) as Esbuild & { default?: Esbuild };
  return typeof mod.build === 'function' ? mod : mod.default!;
}

/** `native-page.ts` with `@ordo/renderer`, as one script. */
async function bundlePage(): Promise<string> {
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'native-page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  return built.outputFiles[0]!.text;
}

export type RenderedSlide = {
  shown: number;
  /** The PNG, relative to the deck's native folder: the slide as drawn (as LibreOffice would with `loCompat`). */
  png?: string;
  /** With `loCompat`, on a slide a policy rule changes: the slide as ordo draws it. */
  policyPng?: string;
  /** With `noLo`, on a slide whose `noLoDraw` is set: what a hub without LibreOffice shows. */
  noLoPng?: string;
  width?: number;
  height?: number;
  rasterMs?: { '1920': number; '3840': number };
  /** Preparing the pictures the cache lacks plus the first draw, in ms (`RenderResult.cold1920`). */
  coldMs?: { '1920': number; '3840': number };
  /** The largest single object's cold draw and flush, in ms (`NativePage.objects`). */
  maxObjectMs?: { '1920': number; '3840': number };
  /** The id of that object at 3840 px. */
  maxObjectId?: string;
  error?: string;
};

export type RenderedDeck = {
  slides: RenderedSlide[];
  notes: string[];
  ms: number;
  /** Faces the page's resolver loaded for the deck (`fonts.ts`). */
  fonts?: { offered: number; loaded: number };
  /** `RenderOptions.probe`: the CSS font each request resolves to on the page. */
  probes?: string[];
};

export type RenderOptions = {
  /** Timed draws per width (default 3). */
  repeats?: number;
  /** Draw only these shown slides (0-based); default every one. */
  only?: ReadonlySet<number>;
  /** Draw each slide as LibreOffice would (`compatSlide`), and as ordo does next to it (`policyPng`). */
  loCompat?: boolean;
  /** Font requests to resolve on the page once its faces are loaded (diagnostics, tests). */
  probe?: FaceRequest[];
  /** Register stand-ins for script fallback families this machine lacks (`fonts.ts`). */
  standIns?: boolean;
  /** Draw each slide's `noLoDraw` as well (`noLoPng`, untimed). */
  noLo?: boolean;
  /**
   * The faces the page's resolver registers, instead of fontconfig's for the slides (`hostFonts`; then
   * `standIns` does nothing). An output's faces (its config's library fonts) make the page draw with exactly
   * the files the output draws with, whatever this machine's fontconfig would pick: the comparison of an
   * output with the page is then like with like on any machine (e2e/pptx-native.spec.ts).
   */
  fonts?: readonly HarnessFont[];
};

declare global {
  interface Window {
    __native: NativePage;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Headless Chromium with the native page; one page per deck. */
export class NativeRenderer {
  /** How each script fallback family was served, over the run (by family). */
  private scriptFaces = new Map<string, ScriptFace>();

  private browser: Browser;
  private script: string;
  readonly version: string;

  private constructor(browser: Browser, script: string, version: string) {
    this.browser = browser;
    this.script = script;
    this.version = version;
  }

  static async start(executable: string): Promise<NativeRenderer> {
    const script = await bundlePage();
    const { chromium } = await import('@playwright/test');
    const args = [
      '--disable-gpu',
      '--force-color-profile=srgb',
      '--mute-audio',
      '--hide-scrollbars',
      // Nothing resolves: the page's own origin is answered by the route below, before any lookup.
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ];
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: true, executablePath: executable, args });
    } catch (e) {
      // The default (`chromium` on the PATH) is often missing where Chrome is installed.
      if (executable === '/usr/bin/google-chrome') throw e;
      browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args });
    }
    return new NativeRenderer(browser, script, browser.version());
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }

  /** The script fallbacks the run used, and the face this machine gave each. */
  scriptFallbacks(): ScriptFace[] {
    return [...this.scriptFaces.values()].sort((a, b) => a.family.localeCompare(b.family));
  }

  /** A fresh page serving `files` (URL path → file on disk) and the bundle; every other request fails. */
  private async page(files: ReadonlyMap<string, string>, notes: string[]): Promise<Page> {
    const page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => {
      if (notes.length < 50) notes.push(`page error: ${errorText(e)}`);
    });
    await page.route('**/*', async (r) => {
      const url = new URL(r.request().url());
      if (url.origin !== ORIGIN) return r.abort();
      if (url.pathname === '/')
        return r.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta charset="utf-8"><body><script src="/page.js"></script></body>',
        });
      if (url.pathname === '/page.js')
        return r.fulfill({ contentType: 'text/javascript', body: this.script });
      const file = files.get(url.pathname);
      return file ? r.fulfill({ path: file }) : r.fulfill({ status: 404, body: '' });
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => window.__native !== undefined, undefined, { timeout: 30_000 });
    return page;
  }

  /**
   * Draw the shown slides of a converted deck into `dir` (`slide-NNNN.png`, NNNN = shown + 1; with
   * `loCompat`, a slide a policy rule changes also as `slide-NNNN.policy.png`).
   */
  async renderDeck(deck: NativeDeck, dir: string, opts: RenderOptions = {}): Promise<RenderedDeck> {
    const t0 = performance.now();
    const repeats = opts.repeats ?? 3;
    const notes: string[] = [];
    const shown = deck.slides
      .filter((s): s is NativeSlide & { shown: number } => s.shown !== undefined)
      .filter((s) => !opts.only || opts.only.has(s.shown))
      .sort((a, b) => a.shown - b.shown);
    const drawn = shown.flatMap((s) => [
      s.slide,
      ...(opts.loCompat && s.compatSlide ? [s.compatSlide] : []),
      ...(opts.noLo && s.noLoDraw ? [s.noLoDraw] : []),
    ]);
    const files = new Map<string, string>();
    const media: PageMedia[] = [];
    const need = picturesNeeded(drawn);
    for (const [k, m] of deck.media.entries()) {
      if (!m.file) continue;
      const path = `/media/${k + 1}`;
      files.set(path, join(dir, m.file));
      const n = need.get(m.id) ?? { w: 0, h: 0 };
      media.push({ id: m.id, url: path, needW: n.w, needH: n.h });
    }
    const host = opts.fonts
      ? { fonts: opts.fonts, notes: [], scripts: [] }
      : await hostFonts(drawn, { standIns: opts.standIns === true });
    notes.push(...host.notes);
    for (const f of host.scripts) if (!this.scriptFaces.has(f.family)) this.scriptFaces.set(f.family, f);
    const urls = new Map<string, string>();
    const fonts: PageFont[] = host.fonts.map((f) => {
      let path = urls.get(f.hash);
      if (!path) {
        path = `/font/${urls.size + 1}`;
        urls.set(f.hash, path);
        files.set(path, f.file);
      }
      const { file: _, ...face } = f;
      return { ...face, url: path };
    });

    let page: Page | undefined;
    let loaded: RenderedDeck['fonts'];
    let probes: string[] | undefined;
    const open = async () => {
      page = await this.page(files, notes);
      const p = page;
      const got = await p.evaluate((list) => window.__native.fonts(list), fonts);
      if (got.failed.length) notes.push(`${got.failed.length} font face(s) could not be loaded`);
      loaded = { offered: fonts.length, loaded: got.loaded };
      if (opts.probe) probes = await p.evaluate((reqs) => window.__native.font(reqs), opts.probe);
      await p.evaluate((list) => window.__native.media(list), media);
      await p.evaluate((list) => window.__native.geoms(list), deck.geoms ?? []);
      return p;
    };
    const slides: RenderedSlide[] = [];
    const missing = new Set<string>();
    const offered = new Set(media.map((m) => m.id));
    const draw = async (slide: Slide, name: string, times: number) => {
      const p = page ?? (await open());
      const job = { slide, rect: deck.slideRect, repeats: times };
      const r: RenderResult = await withTimeout(
        p.evaluate((j) => window.__native.render(j), job),
        SLIDE_TIMEOUT_MS,
        name,
      );
      await writeFile(join(dir, name), Buffer.from(r.png, 'base64'));
      // Pictures never offered to the page (EMF, TIFF, …) are already counted by `convertDeck`.
      for (const id of r.missing) if (offered.has(id)) missing.add(id);
      return r;
    };
    try {
      for (const s of shown) {
        const out: RenderedSlide = { shown: s.shown };
        slides.push(out);
        const base = `slide-${String(s.shown + 1).padStart(4, '0')}`;
        try {
          const compat = opts.loCompat ? s.compatSlide : undefined;
          const r = await draw(compat ?? s.slide, `${base}.png`, repeats);
          Object.assign(out, {
            png: `${base}.png`,
            width: r.width,
            height: r.height,
            ...(repeats
              ? {
                  rasterMs: { '1920': round2(r.ms1920), '3840': round2(r.ms3840) },
                  coldMs: { '1920': round2(r.cold1920), '3840': round2(r.cold3840) },
                }
              : {}),
          });
          if (compat) {
            await draw(s.slide, `${base}.policy.png`, 0);
            out.policyPng = `${base}.policy.png`;
          }
          if (opts.noLo && s.noLoDraw) {
            await draw(s.noLoDraw, `${base}.nolo.png`, 0);
            out.noLoPng = `${base}.nolo.png`;
          }
        } catch (e) {
          out.error = errorText(e);
          notes.push(`slide ${s.shown + 1} not drawn: ${out.error}`);
          // A crashed or stuck page is replaced for the next slide.
          await page?.close().catch(() => undefined);
          page = undefined;
        }
      }
      // Each object on its own, once every slide's own draws are timed: the cold draws clear the page's
      // effect sprites, which would change the next slide's times.
      if (repeats)
        for (const [k, s] of shown.entries()) {
          const out = slides[k]!;
          if (out.error) continue;
          try {
            const p = page ?? (await open());
            const job = {
              slide: (opts.loCompat ? s.compatSlide : undefined) ?? s.slide,
              rect: deck.slideRect,
            };
            const r: ObjectsResult = await withTimeout(
              p.evaluate((j) => window.__native.objects(j), job),
              SLIDE_TIMEOUT_MS,
              `slide ${s.shown + 1}'s objects`,
            );
            out.maxObjectMs = { '1920': round2(r.ms1920), '3840': round2(r.ms3840) };
            if (r.id3840 !== undefined) out.maxObjectId = r.id3840;
          } catch (e) {
            notes.push(`slide ${s.shown + 1}'s objects not timed: ${errorText(e)}`);
            await page?.close().catch(() => undefined);
            page = undefined;
          }
        }
    } finally {
      await page?.close().catch(() => undefined);
    }
    if (missing.size) notes.push(`${missing.size} picture(s) could not be decoded`);
    return {
      slides,
      notes,
      ms: performance.now() - t0,
      ...(loaded ? { fonts: loaded } : {}),
      ...(probes ? { probes } : {}),
    };
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** A slide's class in the hub once its budgets ran (`census.ts` `HubSlide.hub`). */
export type HubClass = 'native' | 'hybrid' | 'picture';

/** Why the hub's budget ladder changed a slide: over 64 KB, the presentation's tail, its outline files. */
export type HubWhy = 'slide' | 'presentation' | 'geoms';

/** A slide as the hub stores it once its budgets ran (`hubLadder`). */
export type HubStored = {
  /** Its bytes as the hub stores it (`ladder.ts` `storedWithin`, its provenance included); 0 for a picture slide. */
  stored: number;
  /** Its class there: picture only when the converter said so (no budget makes a picture since M9). */
  hub: HubClass;
  /** Why the ladder changed it (null: stored as emitted, or only re-gridded). */
  why: HubWhy | null;
  /** The ladder's level (`fitSlideBudget`; 'minimal' for the tail). */
  level: BudgetLevel;
  /** What the ladder left out (`Slide.pptx.missing` kinds: 'decoration', 'chart'). */
  missing: string[];
  /** The slide as stored, without its provenance (a picture slide: no objects). */
  slide: Slide;
};

type HubInput = { class: SlideClass; slide: Slide; notes: readonly string[]; index?: number; shown?: number };

/**
 * The slides as the hub stores them (`apps/hub/src/pptx/nativeJob.ts` `budget`, M9's budget ladder), in deck
 * order, hidden ones included: the objects naming outline files past `PPTX_LIMITS.geomFileBytes` left out
 * (`ladder.ts` `withoutFiles`), then each slide fitted to 64 KB and the presentation's tail stored minimal
 * (`planLadder`, measured with a stand-in of the provenance the hub writes). A slide the converter classed
 * picture keeps no objects (`toPicture`). The census, `--hub-budget` and `--no-libreoffice` all read it.
 */
export function hubLadder(
  slides: readonly HubInput[],
  geoms: readonly { id: string; file: unknown }[] = [],
  geomBudget: number = PPTX_LIMITS.geomFileBytes,
): HubStored[] {
  const fileBytes = new Map(geoms.map((g) => [g.id, utf8Of(JSON.stringify(g.file))]));
  const admitted = new Set<string>();
  let spent = 0;
  const kept = slides.map((s) => {
    if (s.class === 'picture') return { slide: s.slide, missing: [] as string[], geoms: false };
    const keep = new Set<string>();
    for (const r of drawnGeomRefs(s.slide)) {
      const bytes = fileBytes.get(r);
      if (admitted.has(r) || bytes === undefined) {
        keep.add(r);
        continue;
      }
      if (spent + bytes > geomBudget) continue;
      admitted.add(r);
      keep.add(r);
      spent += bytes;
    }
    const left = withoutFiles(s.slide, (ref) => keep.has(ref));
    return { slide: left.slide, missing: left.missing as string[], geoms: left.slide !== s.slide };
  });
  const plan = planLadder(
    slides.map((s, k) => ({
      slide: {
        ...kept[k]!.slide,
        pptx: provenanceStandIn({
          index: s.index ?? k,
          ...(s.shown !== undefined ? { shown: s.shown } : {}),
          cls: s.class,
          version: CONVERTER_VERSION,
          notes: s.notes,
        }),
      },
      fixed: s.class === 'picture',
    })),
  );
  return slides.map((s, k): HubStored => {
    const r = plan.slides[k]!;
    // As emitted when the ladder kept it whole (the very slide, without the stand-in provenance).
    const { pptx: _, ...fitted } = r.slide;
    const slide = r.level === 'full' && !kept[k]!.geoms ? s.slide : fitted;
    if (s.class === 'picture') {
      const { lyricObjectId: _l, ...rest } = s.slide;
      return {
        stored: 0,
        hub: 'picture',
        why: null,
        level: 'full',
        missing: [],
        slide: { ...rest, objects: [] },
      };
    }
    const missing = [...kept[k]!.missing];
    for (const m of r.missing) if (!missing.includes(m)) missing.push(m);
    const changed = r.tail || r.dropped > 0 || r.plain > 0;
    const why: HubWhy | null = r.tail ? 'presentation' : changed ? 'slide' : kept[k]!.geoms ? 'geoms' : null;
    return {
      stored: r.bytes,
      hub: missing.length && s.class === 'native' ? 'hybrid' : s.class,
      why,
      level: r.level,
      missing,
      slide,
    };
  });
}

const utf8Of = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * The slide as the hub stores it (design/27 §3.4; `--hub-budget`, `--no-libreoffice`): its `hubLadder` form.
 * Given only a class (an older caller), a picture-class slide is the one `nativeJob.ts` `toPicture` makes (no
 * objects, its background kept) and any other slide is stored as emitted.
 */
export function hubStoredSlide(slide: Slide, hub: HubClass | Pick<HubStored, 'slide'>): Slide {
  if (typeof hub === 'object') return hub.slide;
  if (hub !== 'picture') return slide;
  const { lyricObjectId: _, ...rest } = slide;
  return { ...rest, objects: [] };
}

/**
 * `--hub-budget`: the deck with every slide (and its LibreOffice-policy and LibreOffice-less forms) as the hub
 * stores it (`hubLadder`, M9's budget ladder: re-gridded, simplified or minimal, never a picture for its
 * size). Slides keep their converter class and reasons; only what is drawn changes. `_hub` (each slide's class
 * there) is no longer needed: the ladder is run here on each form.
 */
export function withHubBudget(
  deck: NativeDeck,
  _hub?: readonly (HubClass | Pick<HubStored, 'slide'>)[],
): NativeDeck {
  const geoms = deck.geoms ?? [];
  const ladder = (pick: (s: NativeSlide) => Slide | undefined, cls: (s: NativeSlide) => SlideClass) => {
    const at = deck.slides.map((s, k) => [k, pick(s)] as const).filter(([, sl]) => sl !== undefined);
    const out = hubLadder(
      at.map(([k, sl]) => ({
        class: cls(deck.slides[k]!),
        slide: sl!,
        notes: deck.slides[k]!.notes,
        index: deck.slides[k]!.index,
      })),
      geoms,
    );
    return new Map(at.map(([k], i) => [k, out[i]!.slide]));
  };
  const main = ladder(
    (s) => s.slide,
    (s) => s.class,
  );
  const compat = ladder(
    (s) => s.compatSlide,
    (s) => s.class,
  );
  const noLo = ladder(
    (s) => s.noLoSlide,
    (s) => s.noLoClass ?? s.class,
  );
  return {
    ...deck,
    slides: deck.slides.map((s, k) => ({
      ...s,
      slide: main.get(k) ?? s.slide,
      ...(s.compatSlide ? { compatSlide: compat.get(k) ?? s.compatSlide } : {}),
      ...(s.noLoSlide ? { noLoSlide: noLo.get(k) ?? s.noLoSlide } : {}),
    })),
  };
}

/**
 * For each media id, the widest and tallest the slides draw it at 3840 px wide: image boxes (divided by
 * the visible share of a crop), and the full frame for backgrounds and page pictures.
 */
export function picturesNeeded(slides: readonly Slide[]): Map<string, { w: number; h: number }> {
  const out = new Map<string, { w: number; h: number }>();
  const use = (id: string, w: number, h: number) => {
    const n = out.get(id) ?? { w: 0, h: 0 };
    out.set(id, { w: Math.max(n.w, w), h: Math.max(n.h, h) });
  };
  const k = 3840 / 1920;
  for (const s of slides) {
    if (s.backgroundMediaId) use(s.backgroundMediaId, 3840, 2160);
    if (s.imported?.imageMediaId) use(s.imported.imageMediaId, 3840, 2160);
    for (const o of s.objects) {
      if (o.type !== 'image') continue;
      // `crop` arrives with design/27 M1 item D; read it without depending on the schema having it.
      const crop = (o as { crop?: { l?: number; t?: number; r?: number; b?: number } }).crop;
      const fw = crop ? Math.max(0.01, 1 - (crop.l ?? 0) - (crop.r ?? 0)) : 1;
      const fh = crop ? Math.max(0.01, 1 - (crop.t ?? 0) - (crop.b ?? 0)) : 1;
      const w = Math.min(8192, (Math.abs(o.box.w) * k) / fw);
      const h = Math.min(8192, (Math.abs(o.box.h) * k) / fh);
      use(o.mediaId, Number.isFinite(w) ? w : 0, Number.isFinite(h) ? h : 0);
    }
  }
  return out;
}

/**
 * The slide as a still: a motion background (a clip the hub ingests, `EmittedSlide.clips`) is drawn as its
 * poster, as an output shows it before the clip's first frame, and as LibreOffice draws the slide.
 */
export function still(s: EmittedSlide): Slide {
  const bg = s.clips?.find((c) => c.role === 'background' && c.id === s.slide.backgroundMediaId);
  if (!bg?.poster) return s.slide;
  const { backgroundMediaId: _, ...rest } = s.slide;
  return { ...rest, objects: [bg.poster, ...s.slide.objects] };
}
