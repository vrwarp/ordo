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
 * - `NativeRenderer` loads `native-page.ts` (bundled with esbuild) in headless Chromium, registers the host
 *   fonts fontconfig gives for every family the slides ask for (as `pptx-render/src/fonts.ts` and
 *   LibreOffice do) under internal names, and draws every shown slide with `drawSlide2D`: a 1920x1080
 *   picture cut to the slide area, and raster timings at 1920 and 3840 px.
 *
 * The deck is untrusted: the page fetches only from the harness's own origin, which answers from a fixed
 * table of generated names, and every other request is refused.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Slide } from '@ordo/domain';
import { extractZip } from '@ordo/importers/zip-stream.ts';
import { Worker } from 'node:worker_threads';
import {
  type EmitResult,
  emitSlides,
  parseDeck,
  pictureSize,
  type SlideClass,
  type Tier,
} from '@ordo/pptx-scene';
import type { Browser, Page } from '@playwright/test';
import { run } from '../../../apps/hub/src/media/tools.ts';
import type { NativePage, PageFont, PageMedia, RenderResult } from './native-page.ts';

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
  slide: Slide;
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
  notes: string[];
  /** The deck carries font files (`ppt/fonts/`); LibreOffice 24.2 ignores them (design/27 §14.1). */
  embeddedFonts: boolean;
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

/** The pixel size of a spilled picture from its header (64 KB, or up to 1 MB for a JPEG). */
export function spilledPictureSize(file: string | undefined): { w: number; h: number } | undefined {
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

/** How a deck is converted. */
export type ConvertOptions = {
  /**
   * `--lo-compat` (design/27 §14.1): text written with LibreOffice's policies where they differ from
   * PowerPoint's (`EmitOptions.loCompat` of `@ordo/pptx-scene`): shrink-to-fit only for a shape's own
   * normAutofit and re-fitted from full size, no run shadows, no outline on filled text.
   */
  loCompat?: boolean;
};

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
    notes: [],
    embeddedFonts: false,
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
    const scene = parseDeck(zip.files, {
      pictureSize: (part) => spilledPictureSize(zip.onDisk.get(part) ?? findCaseless(zip.onDisk, part)),
    });
    out.parseMs = performance.now() - t0;
    t0 = performance.now();
    const emitted: EmitResult = emitSlides(scene, opts.loCompat ? { loCompat: true } : {});
    out.emitMs = performance.now() - t0;
    out.slideRect = emitted.slideRect;
    for (const n of [...scene.notes, ...emitted.notes]) note(n);

    const sceneMs = new Map(scene.slides.map((s) => [s.index, s.ms]));
    out.slides = emitted.slides.map((s) => ({
      index: s.index,
      ...(s.shown !== undefined ? { shown: s.shown } : {}),
      hidden: s.hidden,
      tier: s.classification.tier,
      class: s.classification.class,
      reasons: s.classification.reasons,
      convertMs: (sceneMs.get(s.index) ?? 0) + s.ms,
      notes: s.notes,
      slide: s.slide,
    }));

    // The pictures the slides use, under generated names; anything Chromium is not asked to draw is
    // counted by its extension.
    const media = join(dir, 'media');
    await mkdir(media, { recursive: true });
    const skipped = new Map<string, number>();
    for (const [k, m] of emitted.media.entries()) {
      const entry: NativeMedia = { id: m.id, part: m.part };
      out.media.push(entry);
      const src = zip.onDisk.get(m.part) ?? findCaseless(zip.onDisk, m.part);
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

function spawnWorker(heapMb: number): Worker {
  const worker = new Worker(new URL('./convert-worker.ts', import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: heapMb },
  });
  worker.unref(); // an idle worker does not keep the run alive
  return worker;
}

/**
 * `convertDeck` in a worker thread with a heap limit and a timeout. Never throws: a deck whose conversion
 * runs out of memory or time, or whose worker fails, comes back with `error` and no slides (and its
 * `slides.json` says so); that worker is replaced for the next deck. The worker is kept between decks
 * otherwise, and loads its TypeScript through the loader the harness runs under (tsx, which workers
 * inherit).
 */
export function convertDeckIsolated(
  deckFile: string,
  dir: string,
  limits: { heapMb?: number; timeoutMs?: number } = {},
  opts: ConvertOptions = {},
): Promise<NativeDeck> {
  const run = queue.then(() => convertInWorker(deckFile, dir, limits, opts));
  queue = run.catch(() => undefined);
  return run;
}

async function convertInWorker(
  deckFile: string,
  dir: string,
  limits: { heapMb?: number; timeoutMs?: number },
  opts: ConvertOptions,
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
    worker.postMessage({ deckFile, dir, opts });
  });
  if (typeof result !== 'string') return result;
  await rm(join(dir, '.parts'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const out: NativeDeck = {
    slides: [],
    slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
    media: [],
    notes: [`converter failed: ${result}`],
    embeddedFonts: false,
    extractMs: 0,
    parseMs: 0,
    emitMs: 0,
    error: result,
  };
  await writeFile(join(dir, 'slides.json'), JSON.stringify(out));
  return out;
}

function findCaseless(m: Map<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of m) if (k.toLowerCase() === want) return v;
  return undefined;
}

// ── Fonts ────────────────────────────────────────────────────────────────────────────────────────────────

type FaceFile = { file: string; index: number; bold: boolean; italic: boolean };

const fcCache = new Map<string, FaceFile | undefined>();

/** The file fontconfig substitutes for `family` in one variant, as LibreOffice would draw it. */
async function fcMatch(family: string, bold: boolean, italic: boolean): Promise<FaceFile | undefined> {
  const key = `${family}\u0000${bold}\u0000${italic}`;
  if (fcCache.has(key)) return fcCache.get(key);
  // The pattern is one argv element (no shell); fontconfig parses `-`, `:` and `,` in it, so escape them.
  const pattern =
    family.replace(/[\\\-:,]/g, (c) => `\\${c}`) + (bold ? ':bold' : '') + (italic ? ':italic' : '');
  let got: FaceFile | undefined;
  try {
    const r = await run('fc-match', ['-f', '%{file}\t%{index}\t%{weight}\t%{slant}', pattern], {
      timeoutMs: 10_000,
      allowFail: true,
    });
    const [file, index, weight, slant] = r.stdout.split('\t');
    if (r.code === 0 && file)
      got = {
        file,
        index: Number(index) || 0,
        bold: Number(weight) >= 180, // fontconfig: semibold 180, bold 200
        italic: Number(slant) >= 100, // italic 100, oblique 110
      };
  } catch {
    /* fc-match missing: the page falls back to the generic families */
  }
  fcCache.set(key, got);
  return got;
}

/** Every font family the slides draw text with (any `fontFamily` value, so rich runs count too). */
export function familiesOf(slides: readonly Slide[]): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'fontFamily' && typeof x === 'string' && x.trim()) out.add(x.trim());
      else walk(x, depth + 1);
    }
  };
  for (const s of slides) walk(s, 0);
  return out;
}

/** The same slide with every `fontFamily` renamed through `names` (the page's internal family names). */
export function renameFamilies<T>(v: T, names: ReadonlyMap<string, string>): T {
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 12 || !x || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
    // fromEntries defines own properties: a key named "__proto__" stays a key.
    return Object.fromEntries(
      Object.entries(x).map(([k, y]) => [
        k,
        k === 'fontFamily' && typeof y === 'string' ? (names.get(y.trim()) ?? y) : walk(y, depth + 1),
      ]),
    );
  };
  return walk(v, 0) as T;
}

/**
 * The faces to register for `families`, each under an internal name the page has never resolved
 * (design/27 decision 6): fontconfig's regular face, plus its bold, italic and bold italic faces when they
 * are separate files of that weight and slope. Missing variants are synthesized by Chromium, as
 * LibreOffice synthesizes them.
 */
export async function fontFaces(
  families: Iterable<string>,
  internal: (family: string) => string,
): Promise<{ faces: (Omit<PageFont, 'url'> & { file: string })[]; notes: string[] }> {
  const faces: (Omit<PageFont, 'url'> & { file: string })[] = [];
  const notes: string[] = [];
  for (const family of [...families].slice(0, 200)) {
    const regular = await fcMatch(family, false, false);
    if (!regular) continue;
    const name = internal(family);
    const used = new Set([regular.file]);
    faces.push({ family: name, weight: 400, style: 'normal', file: regular.file });
    const variants: [boolean, boolean][] = [
      [true, false],
      [false, true],
      [true, true],
    ];
    for (const [bold, italic] of variants) {
      const f = await fcMatch(family, bold, italic);
      if (!f || used.has(f.file) || (bold && !f.bold) || (italic && !f.italic)) continue;
      used.add(f.file);
      faces.push({
        family: name,
        weight: bold ? 700 : 400,
        style: italic ? 'italic' : 'normal',
        file: f.file,
      });
    }
    if (regular.index > 0) notes.push(`font ${clean(family, 60)}: face ${regular.index} of a collection`);
  }
  return { faces, notes };
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
  /** The PNG, relative to the deck's native folder. */
  png?: string;
  width?: number;
  height?: number;
  rasterMs?: { '1920': number; '3840': number };
  error?: string;
};

export type RenderedDeck = { slides: RenderedSlide[]; notes: string[]; ms: number };

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
  private families = new Map<string, string>();

  private constructor(
    private browser: Browser,
    private script: string,
    readonly version: string,
  ) {}

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

  /** The internal family name of a deck's family (stable for the run). */
  private internal = (family: string): string => {
    let n = this.families.get(family);
    if (!n) {
      n = `ordo-native-${this.families.size + 1}`;
      this.families.set(family, n);
    }
    return n;
  };

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

  /** Draw every shown slide of a converted deck into `dir` (`slide-NNNN.png`, NNNN = shown + 1). */
  async renderDeck(deck: NativeDeck, dir: string, repeats = 3): Promise<RenderedDeck> {
    const t0 = performance.now();
    const notes: string[] = [];
    const shown = deck.slides
      .filter((s): s is NativeSlide & { shown: number } => s.shown !== undefined)
      .sort((a, b) => a.shown - b.shown);
    const files = new Map<string, string>();
    const media: PageMedia[] = [];
    const need = picturesNeeded(shown.map((s) => s.slide));
    for (const [k, m] of deck.media.entries()) {
      if (!m.file) continue;
      const path = `/media/${k + 1}`;
      files.set(path, join(dir, m.file));
      const n = need.get(m.id) ?? { w: 0, h: 0 };
      media.push({ id: m.id, url: path, needW: n.w, needH: n.h });
    }
    const { faces, notes: fontNotes } = await fontFaces(familiesOf(shown.map((s) => s.slide)), this.internal);
    notes.push(...fontNotes);
    const fonts: PageFont[] = faces.map((f, k) => {
      const path = `/font/${k + 1}`;
      files.set(path, f.file);
      return { family: f.family, weight: f.weight, style: f.style, url: path };
    });

    let page: Page | undefined;
    const open = async () => {
      page = await this.page(files, notes);
      const p = page;
      const got = await p.evaluate((list) => window.__native.fonts(list), fonts);
      if (got.failed.length) notes.push(`${got.failed.length} font file(s) could not be loaded`);
      await p.evaluate((list) => window.__native.media(list), media);
      return p;
    };
    const slides: RenderedSlide[] = [];
    const missing = new Set<string>();
    const offered = new Set(media.map((m) => m.id));
    try {
      for (const s of shown) {
        const out: RenderedSlide = { shown: s.shown };
        slides.push(out);
        try {
          const p = page ?? (await open());
          const job = { slide: renameFamilies(s.slide, this.families), rect: deck.slideRect, repeats };
          const r: RenderResult = await withTimeout(
            p.evaluate((j) => window.__native.render(j), job),
            SLIDE_TIMEOUT_MS,
            `slide ${s.shown + 1}`,
          );
          const name = `slide-${String(s.shown + 1).padStart(4, '0')}.png`;
          await writeFile(join(dir, name), Buffer.from(r.png, 'base64'));
          Object.assign(out, {
            png: name,
            width: r.width,
            height: r.height,
            rasterMs: { '1920': round2(r.ms1920), '3840': round2(r.ms3840) },
          });
          // Pictures never offered to the page (EMF, TIFF, …) are already counted by `convertDeck`.
          for (const id of r.missing) if (offered.has(id)) missing.add(id);
        } catch (e) {
          out.error = errorText(e);
          notes.push(`slide ${s.shown + 1} not drawn: ${out.error}`);
          // A crashed or stuck page is replaced for the next slide.
          await page?.close().catch(() => undefined);
          page = undefined;
        }
      }
    } finally {
      await page?.close().catch(() => undefined);
    }
    if (missing.size) notes.push(`${missing.size} picture(s) could not be decoded`);
    return { slides, notes, ms: performance.now() - t0 };
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

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
