/**
 * The LibreOffice follow-up (design/27 §2, §5 "Two-phase save", "Render copy", "Operator fallback", "soffice
 * hardening"; M3 item D). LibreOffice is never on the native critical path: these heavy jobs run after
 * version 1 is saved, and only on the slides that need it.
 *
 * `pptx-lo` (enqueued by the native job before any clip job of the deck):
 * 1. while the presentation is live-locked, defer with backoff and never write it (ADR 0007);
 * 2. pool task `pptx-render-copy`: every art slide twice, over a forced white background and over a forced
 *    second colour (yellow rather than the design's black, `SECOND`),
 *    picture-class slides once, each metafile part twice on a page of its own; External relationships and
 *    media payloads removed;
 * 3. soffice once (hardened, `sofficeToPdf`), then `pdftoppm -f k -l k` per needed page, at 2 px per
 *    logical px (3840 px wide at 16:9: 288 dpi for the standard sizes);
 * 4. pool task `pptx-art` per art slide and per metafile; picture-class pages at the slide's aspect,
 *    stored unpadded;
 * 5. `addReadyPicture`, then a patch of each slide whose objects still match its `Slide.pptx.digest`: the
 *    art replaces `ArtInfo.replaces` just under `ArtInfo.before`. A slide edited meanwhile gets the art as an
 *    extra locked object on top, with a note. `pending` is cleared; version 2 is one new revision.
 *
 * `pptx-reference` ('Show PowerPoint picture', refused by the route while the presentation is locked):
 * every shown slide once into `Slide.pptx.refMediaId`, and `show: 'picture'`.
 *
 * Resumable: every stored picture is a resume pair in the payload (`done`, `placed`), so a job re-queued by a
 * restart or a deferral never runs LibreOffice again for what it already has, and never stores a picture
 * twice.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ExtractedText,
  type ImageObject,
  jsonBytes,
  newId,
  type Presentation,
  presentationBytes,
  SIZE_BUDGETS,
  Slide,
  type SlideObject,
} from '@ordo/domain';
import { extractZip } from '@ordo/importers/zip-stream.ts';
import { digestOf } from '@ordo/pptx-scene/emit.ts';
import { PAGE_BACKGROUNDS, type PageBackground, type RenderCopyPage } from '@ordo/pptx-scene/rendercopy.ts';
import { errorMessage } from '../errors.ts';
import { JobDeferred, type JobCtx, type JobHandler } from '../jobs.ts';
import { pdfPage } from '../media/ffmpeg.ts';
import { run } from '../media/tools.ts';
import { cpuPool, transferables } from '../pool.ts';
import { readPpm } from './art.ts';
import { addReadyPicture, type PreparedPicture } from './pictures.ts';
import { logSafe } from './report.ts';
import {
  PPTX_LIMITS,
  type PptxDeps,
  type PptxLoPayload,
  type PptxLoSlide,
  type PptxReferencePayload,
  type RenderCopyTaskOutput,
} from './shared.ts';

/** soffice's address-space cap (`prlimit --as`), in MB: a large deck converts within 1 GiB in the container. */
export const SOFFICE_ADDRESS_SPACE_MB = 2_048;
/** The first wait of a job that finds its presentation live-locked, doubled per deferral up to the cap. */
export const DEFER_FIRST_MS = 30_000;
export const DEFER_MAX_MS = 15 * 60_000;
/** Logical px added around an art's box before it is cut from the page (shadows, glows, anti-aliasing). */
export const ART_MARGIN_PX = 24;
/** Page pixels per logical px: 3840 px for a 16:9 slide, what a 4K output shows. */
export const PAGE_SCALE = 2;
/**
 * The second background of art and metafile pages (the first is white): yellow, which LibreOffice's automatic
 * text colour treats like white, where black turns automatic black text white (`PAGE_BACKGROUNDS`).
 */
export const SECOND: PageBackground = 'yellow';
/** Notes kept on a slide (`SlidePptx.notes`). */
const SLIDE_NOTES = 16;

type Box = { x: number; y: number; w: number; h: number };

/** The wait before the n-th retry of a deferred job (n from 0). */
export function deferDelay(n: number): number {
  return Math.min(DEFER_MAX_MS, DEFER_FIRST_MS * 2 ** Math.max(0, Math.min(20, n)));
}

// ── soffice ─────────────────────────────────────────────────────────────────────────────────────────────

let unshareOk: Promise<boolean> | undefined;
let prlimitOk: Promise<boolean> | undefined;

/** Whether `unshare -rn` (a user and an empty network namespace) works here; asked once per process. */
export function canUnshare(): Promise<boolean> {
  unshareOk ??= run('unshare', ['-rn', '--', 'true'], { timeoutMs: 5_000 }).then(
    () => true,
    () => false,
  );
  return unshareOk;
}

function canPrlimit(): Promise<boolean> {
  prlimitOk ??= run('prlimit', ['--version'], { timeoutMs: 5_000 }).then(
    () => true,
    () => false,
  );
  return prlimitOk;
}

/** Proxy variables at a port nothing listens on: soffice without a network namespace still reaches nothing. */
const DEAD_PROXY = 'http://127.0.0.1:9';

/**
 * The command that runs soffice hardened: `prlimit --as` (when available), `unshare -rn` where the
 * container allows it; the environment is minimal, with proxies pointing at a dead port when there is no
 * namespace. Exported for tests.
 */
export async function sofficeCommand(
  args: string[],
  home: string,
  addressSpaceMb = SOFFICE_ADDRESS_SPACE_MB,
): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; sandboxed: boolean }> {
  const sandboxed = await canUnshare();
  const cap = (await canPrlimit())
    ? ['prlimit', `--as=${Math.round(addressSpaceMb) * 1024 * 1024}`, '--']
    : [];
  const ns = sandboxed ? ['unshare', '-rn', '--'] : [];
  const full = [...cap, ...ns, 'soffice', ...args];
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' };
  if (!sandboxed)
    for (const k of [
      'http_proxy',
      'https_proxy',
      'ftp_proxy',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'FTP_PROXY',
      'all_proxy',
    ])
      env[k] = DEAD_PROXY;
  return { cmd: full[0]!, args: full.slice(1), env, sandboxed };
}

/**
 * LibreOffice headless conversion to PDF, hardened (design/27 §5 "soffice hardening", design/21): External
 * relationships are already gone from its input (the primary control); it runs in an empty network
 * namespace (`unshare -rn`) where the container allows it, else with proxy variables pointing at a dead
 * port; under an address-space cap (`prlimit --as`); with `tools.run`'s timeout and SIGKILL of its whole
 * process group; with a throwaway profile in `outDir`.
 */
export async function sofficeToPdf(
  input: string,
  outDir: string,
  opts: { timeoutMs: number; signal: AbortSignal; addressSpaceMb?: number },
): Promise<string> {
  const profile = join(outDir, 'lo-profile');
  const c = await sofficeCommand(
    [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      input,
    ],
    outDir,
    opts.addressSpaceMb,
  );
  await run(c.cmd, c.args, { timeoutMs: opts.timeoutMs, signal: opts.signal, env: c.env, group: true });
  const base = input.slice(input.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  const pdf = (await readdir(outDir)).find((f) => f === `${base}.pdf`);
  if (!pdf) throw new Error('LibreOffice produced no PDF');
  return join(outDir, pdf);
}

// ── The stored deck ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The stored deck's parts for the render copy: XML and relationships in memory (≤ 8 MB each, ≤ 64 MB in
 * all), everything else spilled under generated names in `dir`.
 */
export async function extractDeck(
  file: string,
  dir: string,
  signal: AbortSignal,
): Promise<{ parts: Map<string, Uint8Array>; media: [string, string][] }> {
  await mkdir(dir, { recursive: true });
  const z = await extractZip(file, {
    dir,
    spill: (path, size) => !/\.(xml|rels)$/i.test(path) || size > PPTX_LIMITS.xmlPartBytes,
    maxInMemoryBytes: PPTX_LIMITS.xmlTotalBytes,
    signal,
  });
  return { parts: z.files, media: [...z.onDisk] };
}

/** The page size in px for a slide size in EMU: the slide contain-fitted in 1920x1080, times `PAGE_SCALE`. */
export function pageSize(slide: { cx: number; cy: number }): { width: number; height: number; s: number } {
  const s = Math.min(1920 / slide.cx, 1080 / slide.cy);
  return {
    width: Math.max(1, Math.round(slide.cx * s * PAGE_SCALE)),
    height: Math.max(1, Math.round(slide.cy * s * PAGE_SCALE)),
    s,
  };
}

/** The slide's area in logical px (the native import's `slideRect`). */
function slideArea(slide: { cx: number; cy: number }): Box {
  const s = Math.min(1920 / slide.cx, 1080 / slide.cy);
  return { x: (1920 - slide.cx * s) / 2, y: (1080 - slide.cy * s) / 2, w: slide.cx * s, h: slide.cy * s };
}

/** A box in logical px as page px (and back), for a page of `pageSize(slide)`. */
export function toPage(b: Box, slide: { cx: number; cy: number }, margin = 0): Box {
  const area = slideArea(slide);
  const page = pageSize(slide);
  const kx = page.width / area.w;
  const ky = page.height / area.h;
  return {
    x: (b.x - margin - area.x) * kx,
    y: (b.y - margin - area.y) * ky,
    w: (b.w + 2 * margin) * kx,
    h: (b.h + 2 * margin) * ky,
  };
}

export function fromPage(b: Box, slide: { cx: number; cy: number }): Box {
  const area = slideArea(slide);
  const page = pageSize(slide);
  const kx = area.w / page.width;
  const ky = area.h / page.height;
  return { x: area.x + b.x * kx, y: area.y + b.y * ky, w: b.w * kx, h: b.h * ky };
}

// ── The version-2 patch (pure) ──────────────────────────────────────────────────────────────────────────

/** What the follow-up made for one slide. */
export type SlideWork = {
  /** The art picture and its box (logical px); `null`: LibreOffice drew nothing for it. */
  art?: { mediaId: string; box: Box } | null;
  /** The page picture of a picture-class slide, and its text boxes. */
  page?: { mediaId: string; textBoxes?: ExtractedText[] };
  /** Converted metafile parts: part → media id. */
  metafiles?: Map<string, string>;
  /** What could not be done (a sentence each). */
  failed?: string[];
};

/** The locked art object (design/27 §5): an ordinary image to any drawer and to an older build. */
export function artObject(mediaId: string, box: Box): ImageObject {
  const clamp = (v: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
  const o = {
    id: newId(),
    type: 'image' as const,
    box: {
      x: clamp(box.x, -100_000, 100_000),
      y: clamp(box.y, -100_000, 100_000),
      w: clamp(box.w, 0, 100_000),
      h: clamp(box.h, 0, 100_000),
      rotation: 0,
    },
    mediaId,
    fit: 'stretch' as const,
    opacity: 1,
    radius: 0,
    // Kept by a schema that knows them (move, resize, delete and z-order only; design/27 §3.1).
    locked: true,
    origin: { src: 'pptx', role: 'art' },
  };
  return o as ImageObject;
}

/** `objects` with `add` inserted just under the object `before` names (on top when absent or gone). */
function insertUnder(
  objects: SlideObject[],
  add: SlideObject,
  before: string | undefined,
  fallback?: number,
): void {
  let i = before === undefined ? -1 : objects.findIndex((o) => o.id === before);
  if (i < 0)
    i =
      before === undefined
        ? objects.length
        : Math.min(objects.length, Math.max(0, fallback ?? objects.length));
  objects.splice(i, 0, add);
}

/**
 * Version 2 of one slide (pure): the art, the page picture and the converted metafiles added to the slide as
 * it is now. Objects are replaced only while the slide is unedited (its objects still match `lo.digest`); an
 * edited slide keeps every object and gets the art on top, with a note. `pending` is cleared.
 */
export function patchSlide(slide: Slide, lo: PptxLoSlide, work: SlideWork, hash: string): Slide {
  const unedited = !!lo.digest && digestOf(slide.objects) === lo.digest;
  let objects = [...slide.objects];
  const notes: string[] = [];
  let lyricObjectId = slide.lyricObjectId;
  if (work.art && lo.art) {
    const art = artObject(work.art.mediaId, work.art.box);
    if (unedited) {
      const gone = new Set(lo.art.replaces);
      let at = lo.art.before === undefined ? -1 : objects.findIndex((o) => o.id === lo.art!.before);
      if (at < 0) at = lo.art.before === undefined ? objects.length : Math.min(objects.length, lo.art.at);
      const below = objects.slice(0, at).filter((o) => !gone.has(o.id));
      const above = objects.slice(at).filter((o) => !gone.has(o.id));
      objects = [...below, art, ...above];
      if (lyricObjectId && gone.has(lyricObjectId)) lyricObjectId = undefined;
    } else {
      objects.push(art);
      notes.push('edited since the import: the PowerPoint art was added on top');
    }
  } else if (work.art === null && lo.art)
    notes.push('LibreOffice drew nothing for the art: the slide stays as it is');
  for (const m of lo.metafileObjects ?? []) {
    const id = work.metafiles?.get(m.part);
    if (!id) continue;
    const o = { ...m.object, id: m.object.id || newId(), mediaId: id };
    if (objects.some((x) => x.id === o.id)) o.id = newId();
    if (unedited) insertUnder(objects, o, m.before);
    else {
      objects.push(o);
      if (!notes.some((n) => n.startsWith('edited')))
        notes.push('edited since the import: a converted picture was added on top');
    }
  }
  for (const [part, ids] of lo.metafiles ?? []) {
    const id = work.metafiles?.get(part);
    if (!id || !ids.length) continue;
    const want = new Set(ids);
    objects = objects.map((o) => (o.type === 'image' && want.has(o.id) ? { ...o, mediaId: id } : o));
  }
  notes.push(...(work.failed ?? []));
  const next: Slide = { ...slide, objects };
  if (lyricObjectId) next.lyricObjectId = lyricObjectId;
  else delete next.lyricObjectId;
  if (work.page) {
    next.imported = {
      fileId: hash,
      page: (lo.shown ?? lo.index) + 1,
      imageMediaId: work.page.mediaId,
      ...(work.page.textBoxes?.length ? { textBoxes: work.page.textBoxes } : {}),
      textAligned: true,
    };
  }
  if (slide.pptx) {
    const pptx = { ...slide.pptx };
    delete pptx.pending;
    const all = [...(pptx.notes ?? []), ...notes.map((n) => logSafe(n))];
    if (all.length) pptx.notes = all.slice(-SLIDE_NOTES);
    next.pptx = pptx;
  }
  const parsed = Slide.parse(next);
  // An unedited slide stays unedited: its digest follows what the converter wrote.
  if (unedited && parsed.pptx) parsed.pptx.digest = digestOf(parsed.objects);
  return parsed;
}

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────────────

/** Defer a job while its presentation is live-locked (ADR 0007): back to the queue with backoff. */
function deferWhileLocked<P extends { deferrals?: number }>(ctx: JobCtx<P>, what: string): never {
  const n = ctx.payload.deferrals ?? 0;
  ctx.setPayload({ ...ctx.payload, deferrals: n + 1 });
  const ms = deferDelay(n);
  throw new JobDeferred(ms, `waiting: the presentation is live; ${what} again in ${Math.round(ms / 1000)} s`);
}

/** A picture this job made (a PNG under its scratch directory), stored ready with the `pptx` tag. */
async function store(
  deps: PptxDeps,
  file: string,
  info: { width: number; height: number; hasAlpha: boolean; key: string; name: string },
): Promise<string> {
  const picture: PreparedPicture = {
    path: file,
    ext: 'png',
    mime: 'image/png',
    width: info.width,
    height: info.height,
    hasAlpha: info.hasAlpha,
    sourceHash: createHash('sha256').update(info.key).digest('hex'),
    notes: [],
  };
  const m = await addReadyPicture(deps, picture, { name: info.name.slice(0, 200), tags: ['pptx'] });
  return m.id;
}

/** The pages to print, the plan of what each pair or page becomes. */
type Plan =
  | { kind: 'art'; slide: PptxLoSlide; white: number; black: number }
  | { kind: 'page'; slide: PptxLoSlide; page: number }
  | { kind: 'metafile'; part: string; slide: PptxLoSlide; white: number; black: number };

/** Run one render copy through soffice; `each` gets the PDF and the copy's answer. */
async function printCopy(
  deps: PptxDeps,
  ctx: JobCtx<unknown>,
  hash: string,
  pages: RenderCopyPage[],
  texts: number[],
  each: (pdf: string | undefined, copy: RenderCopyTaskOutput, dir: string) => Promise<void>,
): Promise<void> {
  const file = deps.lib.getFile(hash);
  if (!file) throw new Error('The PowerPoint file is no longer stored');
  const dir = await deps.store.tmpDir();
  try {
    const deck = await extractDeck(deps.store.abs(file.path), join(dir, 'deck'), ctx.signal);
    const copy = await cpuPool().run(
      'pptx-render-copy',
      {
        parts: deck.parts,
        media: deck.media,
        pages,
        out: join(dir, 'copy.pptx'),
        ...(texts.length ? { texts } : {}),
      },
      { signal: ctx.signal, transfer: transferables(deck.parts.values()) },
    );
    deck.parts.clear();
    for (const n of copy.notes.slice(0, 20)) ctx.log(`[warn] ${logSafe(n)}`);
    if (copy.outlines)
      ctx.log(`text outlines removed from ${copy.outlines} run(s): LibreOffice draws them as hollow letters`);
    let pdf: string | undefined;
    if (copy.pages.length) {
      ctx.log(`LibreOffice: ${copy.pages.length} page(s)`);
      await mkdir(join(dir, 'pdf'));
      pdf = await sofficeToPdf(join(dir, 'copy.pptx'), join(dir, 'pdf'), {
        timeoutMs: deps.cfg.timeouts.soffice,
        signal: ctx.signal,
      });
    }
    await rm(join(dir, 'deck'), { recursive: true, force: true });
    await each(pdf, copy, dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** The `pptx-lo` job. */
export function loJob(deps: PptxDeps): JobHandler<PptxLoPayload> {
  return async (ctx) => {
    const pl = ctx.payload;
    const done = new Map(pl.done ?? []);
    const placed = new Map(pl.placed ?? []);
    const save = () => ctx.setPayload({ ...ctx.payload, done: [...done], placed: [...placed] });
    const p0 = deps.lib.presentations.get(pl.presentationId);
    if (!p0) {
      ctx.log('the presentation was deleted: nothing to do');
      return { presentationId: pl.presentationId, deleted: true };
    }
    if (deps.locked(p0.id)) deferWhileLocked(ctx, 'LibreOffice will try');
    // Only slides that still wait: a re-run after the save (a crash, a restart) finds none and adds nothing twice.
    const waiting = new Set(
      p0.sections.flatMap((s) => s.slides.filter((sl) => sl.pptx?.pending).map((sl) => sl.id)),
    );
    const slides = pl.slides.filter((s) => waiting.has(s.slideId));
    const title = p0.title;

    // What is still to make: art pairs, page pictures, metafile pairs (each part once).
    const pages: RenderCopyPage[] = [];
    const plans: Plan[] = [];
    const parts = new Set<string>();
    for (const s of slides) {
      if (s.class === 'hybrid' && s.art?.elements.length && !done.has(`${s.slideId}:art`)) {
        const keep = s.art.elements;
        pages.push({ index: s.index, mode: 'art', background: 'white', keep });
        pages.push({ index: s.index, mode: 'art', background: SECOND, keep });
        plans.push({ kind: 'art', slide: s, white: pages.length - 2, black: pages.length - 1 });
      }
      if (s.class === 'picture' && !done.has(`${s.slideId}:page`)) {
        pages.push({ index: s.index, mode: 'whole' });
        plans.push({ kind: 'page', slide: s, page: pages.length - 1 });
      }
      for (const part of [
        ...(s.metafiles ?? []).map(([m]) => m),
        ...(s.metafileObjects ?? []).map((m) => m.part),
      ]) {
        if (parts.has(part) || done.has(`mf:${part}`)) continue;
        parts.add(part);
        pages.push({ index: s.index, mode: 'picture', part, background: 'white' });
        pages.push({ index: s.index, mode: 'picture', part, background: SECOND });
        plans.push({ kind: 'metafile', part, slide: s, white: pages.length - 2, black: pages.length - 1 });
      }
    }
    const texts = slides.filter((s) => s.class === 'picture').map((s) => s.index);
    const failed = new Map<string, string[]>();
    const fail = (slideId: string, why: string) => failed.set(slideId, [...(failed.get(slideId) ?? []), why]);
    let textBoxes = new Map<number, ExtractedText[]>();

    if (pages.length || texts.length) {
      try {
        await printCopy(deps, ctx as JobCtx<unknown>, pl.hash, pages, texts, async (pdf, copy, dir) => {
          textBoxes = new Map(copy.texts ?? []);
          const size = copy.slideSize ?? { cx: 12_192_000, cy: 6_858_000 };
          const page = pageSize(size);
          // Page k of the PDF is copy.pages[k - 1]; a page the copy could not write is missing there.
          const printed = new Map<RenderCopyPage, number>();
          let k = 0;
          for (const want of pages) {
            const got = copy.pages[k];
            if (got && got.index === want.index && got.mode === want.mode && samePage(got, want)) {
              printed.set(want, ++k);
            }
          }
          const raster = async (which: RenderCopyPage, format: 'ppm' | 'png') => {
            const n = printed.get(which);
            if (!pdf || n === undefined) return undefined;
            return pdfPage(pdf, n, join(dir, `page-${n}`), {
              ...page,
              format,
              timeoutMs: deps.cfg.timeouts.pdf,
              signal: ctx.signal,
            });
          };
          let i = 0;
          for (const plan of plans) {
            if (ctx.signal.aborted) throw new Error('cancelled');
            ctx.progress((0.9 * ++i) / plans.length);
            try {
              if (plan.kind === 'page') {
                const png = await raster(pages[plan.page]!, 'png');
                if (!png) {
                  fail(plan.slide.slideId, 'LibreOffice could not draw this slide');
                  continue;
                }
                const id = await store(deps, png, {
                  ...page,
                  hasAlpha: false,
                  key: `${pl.hash}:page:${plan.slide.index}`,
                  name: `${title} – ${(plan.slide.shown ?? plan.slide.index) + 1}`,
                });
                done.set(`${plan.slide.slideId}:page`, id);
                save();
                continue;
              }
              const white = await raster(pages[plan.white]!, 'ppm');
              const black = white ? await raster(pages[plan.black]!, 'ppm') : undefined;
              if (!white || !black) {
                fail(plan.slide.slideId, 'LibreOffice could not draw the art');
                continue;
              }
              let box: Box;
              if (plan.kind === 'art') box = toPage(plan.slide.art!.box, size, ART_MARGIN_PX);
              else {
                const r = copy.pages[printed.get(pages[plan.white]!)! - 1];
                const rect = r?.mode === 'picture' ? r.rect : undefined;
                if (!rect) {
                  fail(plan.slide.slideId, 'a converted picture has no place');
                  continue;
                }
                box = {
                  x: (rect.x / size.cx) * page.width,
                  y: (rect.y / size.cy) * page.height,
                  w: (rect.cx / size.cx) * page.width,
                  h: (rect.cy / size.cy) * page.height,
                };
              }
              const w = await readFile(white);
              const b = await readFile(black);
              await rm(white, { force: true });
              await rm(black, { force: true });
              const out = await cpuPool().run(
                'pptx-art',
                {
                  white: readPpm(w),
                  black: readPpm(b),
                  colors: { white: PAGE_BACKGROUNDS.white, black: PAGE_BACKGROUNDS[SECOND] },
                  box,
                  whole: plan.kind === 'metafile',
                  encode: true,
                },
                { signal: ctx.signal, transfer: transferables([w, b]) },
              );
              const key = plan.kind === 'art' ? `${plan.slide.slideId}:art` : `mf:${plan.part}`;
              if (out.empty || !out.png) {
                done.set(key, '');
                save();
                continue;
              }
              const file = join(dir, `${plan.kind}-${i}.png`);
              await writeFile(file, out.png);
              const id = await store(deps, file, {
                width: out.image.width,
                height: out.image.height,
                hasAlpha: true,
                key: `${pl.hash}:${key}`,
                name:
                  plan.kind === 'art'
                    ? `${title} – ${(plan.slide.shown ?? plan.slide.index) + 1} (art)`
                    : `${title} – picture`,
              });
              done.set(key, id);
              if (plan.kind === 'art')
                placed.set(key, fromPage({ ...out.at, w: out.image.width, h: out.image.height }, size));
              save();
            } catch (e) {
              if (ctx.signal.aborted) throw e;
              ctx.log(`[warn] slide ${plan.slide.index + 1}: ${logSafe(errorMessage(e))}`);
              fail(plan.slide.slideId, 'LibreOffice could not draw part of this slide');
            }
          }
        });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        // LibreOffice or the pool failed for the whole copy: the slides keep version 1, without `pending`.
        ctx.log(`[warn] LibreOffice could not draw the slides: ${logSafe(errorMessage(e))}`);
        for (const s of slides) fail(s.slideId, 'LibreOffice could not draw this slide');
      }
    }

    // Version 2: one revision, never while live-locked.
    const p = deps.lib.presentations.get(pl.presentationId);
    if (!p) return { presentationId: pl.presentationId, deleted: true };
    if (deps.locked(p.id)) deferWhileLocked(ctx, 'the slides are updated');
    const bySlide = new Map(slides.map((s) => [s.slideId, s]));
    let patched = 0;
    let budget = presentationBytes(p);
    let boxesLeftOut = 0;
    const counts = { art: 0, pages: 0, metafiles: 0, edited: 0 };
    const sections = p.sections.map((sec) => ({
      ...sec,
      slides: sec.slides.map((sl) => {
        const lo = bySlide.get(sl.id);
        if (!lo || !sl.pptx?.pending) return sl;
        const work: SlideWork = { failed: failed.get(sl.id) ?? [] };
        const art = done.get(`${sl.id}:art`);
        if (lo.art && art !== undefined) {
          const box = placed.get(`${sl.id}:art`);
          work.art = art && box ? { mediaId: art, box } : null;
        }
        const page = done.get(`${sl.id}:page`);
        if (page) {
          let boxes = textBoxes.get(lo.index);
          const bytes = boxes?.length ? jsonBytes(boxes) : 0;
          if (boxes?.length && budget + bytes > SIZE_BUDGETS.presentationMax) {
            boxes = undefined;
            boxesLeftOut++;
          } else budget += bytes;
          work.page = { mediaId: page, ...(boxes?.length ? { textBoxes: boxes } : {}) };
        }
        const mf = new Map<string, string>();
        for (const part of [
          ...(lo.metafiles ?? []).map(([m]) => m),
          ...(lo.metafileObjects ?? []).map((m) => m.part),
        ]) {
          const id = done.get(`mf:${part}`);
          if (id) mf.set(part, id);
        }
        if (mf.size) work.metafiles = mf;
        try {
          const next = patchSlide(sl, lo, work, pl.hash);
          patched++;
          if (work.art) counts.art++;
          if (work.page) counts.pages++;
          counts.metafiles += mf.size;
          if (lo.digest && digestOf(sl.objects) !== lo.digest) counts.edited++;
          return next;
        } catch (e) {
          ctx.log(`[warn] slide ${lo.index + 1} could not be updated: ${logSafe(errorMessage(e))}`);
          return sl;
        }
      }),
    }));
    if (boxesLeftOut)
      ctx.log(
        `[warn] ${boxesLeftOut} picture slide(s) without text boxes: the presentation is at its size budget`,
      );
    if (!patched) {
      ctx.log('nothing left to update');
      return { presentationId: p.id, rev: p.rev, ...counts };
    }
    const saved = deps.lib.savePresentation({ ...p, sections } as Presentation, {
      expectedRev: p.rev,
      by: 'pptx-lo',
    });
    deps.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
    ctx.log(
      `version 2: ${counts.art} art picture(s), ${counts.pages} page picture(s), ${counts.metafiles} converted picture(s)` +
        (counts.edited ? `, ${counts.edited} slide(s) edited meanwhile (art added on top)` : ''),
    );
    return { presentationId: saved.id, rev: saved.rev, ...counts };
  };
}

/** Whether the copy printed `got` for the page asked as `want` (same slide, mode and background or part). */
function samePage(got: RenderCopyPage, want: RenderCopyPage): boolean {
  if (got.mode === 'art' && want.mode === 'art') return got.background === want.background;
  if (got.mode === 'picture' && want.mode === 'picture')
    return got.part === want.part && got.background === want.background;
  return got.mode === want.mode;
}

/** The `pptx-reference` job ('Show PowerPoint picture'). */
export function referenceJob(deps: PptxDeps): JobHandler<PptxReferencePayload> {
  return async (ctx) => {
    const pl = ctx.payload;
    const done = new Map(pl.done ?? []);
    const save = () => ctx.setPayload({ ...ctx.payload, done: [...done] });
    const p0 = deps.lib.presentations.get(pl.presentationId);
    if (!p0) {
      ctx.log('the presentation was deleted: nothing to do');
      return { presentationId: pl.presentationId, deleted: true };
    }
    if (deps.locked(p0.id)) deferWhileLocked(ctx, 'LibreOffice will try');
    // Every shown slide of this deck, once (a duplicated slide shares its picture).
    const want = new Map<number, number>();
    for (const sec of p0.sections)
      for (const sl of sec.slides)
        if (sl.pptx?.fileId === pl.hash && sl.pptx.shown !== undefined && !sl.hidden)
          want.set(sl.pptx.index, sl.pptx.shown);
    const pages: RenderCopyPage[] = [...want.keys()]
      .filter((i) => !done.has(i))
      .sort((a, b) => a - b)
      .map((index) => ({ index, mode: 'whole' as const }));
    if (pages.length)
      await printCopy(deps, ctx as JobCtx<unknown>, pl.hash, pages, [], async (pdf, copy, dir) => {
        const page = pageSize(copy.slideSize ?? { cx: 12_192_000, cy: 6_858_000 });
        let k = 0;
        for (const got of copy.pages) {
          k++;
          if (ctx.signal.aborted) throw new Error('cancelled');
          ctx.progress((0.9 * k) / copy.pages.length);
          if (!pdf) break;
          const png = await pdfPage(pdf, k, join(dir, `page-${k}`), {
            ...page,
            format: 'png',
            timeoutMs: deps.cfg.timeouts.pdf,
            signal: ctx.signal,
          });
          const id = await store(deps, png, {
            ...page,
            hasAlpha: false,
            key: `${pl.hash}:reference:${got.index}`,
            name: `${p0.title} – ${(want.get(got.index) ?? got.index) + 1} (PowerPoint)`,
          });
          done.set(got.index, id);
          save();
        }
      });
    const p = deps.lib.presentations.get(pl.presentationId);
    if (!p) return { presentationId: pl.presentationId, deleted: true };
    if (deps.locked(p.id)) deferWhileLocked(ctx, 'the slides are updated');
    let shown = 0;
    const sections = p.sections.map((sec) => ({
      ...sec,
      slides: sec.slides.map((sl) => {
        const id = sl.pptx?.fileId === pl.hash ? done.get(sl.pptx.index) : undefined;
        if (!id || !sl.pptx) return sl;
        shown++;
        return { ...sl, pptx: { ...sl.pptx, refMediaId: id, show: 'picture' as const } };
      }),
    }));
    const saved = deps.lib.savePresentation(
      { ...p, sections },
      { expectedRev: p.rev, by: pl.by ?? 'pptx-reference' },
    );
    deps.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
    ctx.log(`${shown} slide(s) show the PowerPoint picture`);
    return { presentationId: saved.id, rev: saved.rev, slides: shown };
  };
}

// ── The 'Pictures (LibreOffice)' import ─────────────────────────────────────────────────────────────────

/**
 * The 'Pictures (LibreOffice)' import's input: the worker-built render copy of every shown slide, written
 * over `deck` (design/27 §5 "Render copy"; it replaces `pptxForRendering`). Returns what the copy did, for
 * the job log. Throws when the pool cannot run it (`WorkerStartError`) or the deck cannot be read: the
 * caller then converts the deck as it is.
 */
export async function renderCopyForDocument(
  deck: string,
  dir: string,
  signal: AbortSignal,
): Promise<{ pages: number; outlines: number; notes: string[] }> {
  const partsDir = join(dir, 'deck-parts');
  try {
    const d = await extractDeck(deck, partsDir, signal);
    const out = join(dir, 'render-copy.pptx');
    const copy = await cpuPool().run(
      'pptx-render-copy',
      { parts: d.parts, media: d.media, pages: [], out, allShown: true },
      { signal, transfer: transferables(d.parts.values()) },
    );
    await rm(deck, { force: true });
    await rename(out, deck);
    return { pages: copy.pages.length, outlines: copy.outlines, notes: copy.notes };
  } finally {
    await rm(partsDir, { recursive: true, force: true });
  }
}
