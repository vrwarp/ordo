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
 *    art replaces `ArtInfo.replaces` just under `ArtInfo.before`. On a slide edited meanwhile it replaces
 *    only the objects still exactly as version 1 wrote them (`PptxLoSlide.replaced`), with a note for the
 *    others. `pending` is cleared; version 2 is one new revision.
 * 6. A whole run that fails (soffice killed or timed out, the pool, the disk) is tried again later
 *    (`LO_RETRIES`, deferred with backoff); after the last attempt, and for a page or art that fails on its
 *    own, the slide keeps version 1 marked `Slide.pptx.failed`, which the import card and goLive report.
 *
 * `queueFollowUp`: a save from the editor that brings back slides still `pending` (a version-1 draft saved
 * over version 2, a restored revision) while no follow-up is queued or running gets one, planned from the
 * stored slides and what earlier follow-ups planned and stored, so LibreOffice is not run again for them.
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
  MISSING_LIMITS,
  missingEntry,
  missingKind,
  missingKinds,
  missingLabel,
  newId,
  type Presentation,
  presentationBytes,
  SIZE_BUDGETS,
  Slide,
  type SlideObject,
} from '@ordo/domain';
import { addNote, type SlideRef } from '@ordo/pptx-scene';
import { digestOf } from '@ordo/pptx-scene/emit.ts';
import { digestMatches, importDigest } from './digest.ts';
import { PAGE_BACKGROUNDS, type PageBackground, type RenderCopyPage } from '@ordo/pptx-scene/rendercopy.ts';
import { errorMessage } from '../errors.ts';
import type { Job } from '@ordo/protocol';
import { JobDeferred, type JobCtx, type JobHandler } from '../jobs.ts';
import { pdfPage } from '../media/ffmpeg.ts';
import { run, ToolError } from '../media/tools.ts';
import { cpuPool, transferables } from '../pool.ts';
import { readPpm } from './art.ts';
import { readDeckXml, spillDeckParts } from './deckParts.ts';
import { addReadyPicture, type PreparedPicture } from './pictures.ts';
import { logSafe } from './report.ts';
import {
  CONVERTER_VERSION,
  enqueuePptx,
  PPTX_JOBS,
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
/**
 * Later attempts of a follow-up whose whole LibreOffice run failed (soffice killed or timed out, the pool, the
 * disk): deferred with `deferDelay` backoff. Past them the slides are marked `failed`.
 */
export const LO_RETRIES = 2;
/**
 * Later attempts of a follow-up that finds LibreOffice 'broken' (`HubTools.recheck`: its probe timed out on a
 * slow start, or its version command failed): deferred with `deferDelay` backoff (about half an hour in all),
 * LibreOffice probed again on each. Past them the slides are marked `failed`, as after `LO_RETRIES`.
 */
export const LO_PROBE_RETRIES = 6;

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
 * namespace. `exe`: the soffice the hub found (`HubTools.libreoffice().exe`, an absolute path, or the one
 * `ORDO_LIBREOFFICE` names; design/27 M9). Exported for tests.
 */
export async function sofficeCommand(
  args: string[],
  home: string,
  addressSpaceMb = SOFFICE_ADDRESS_SPACE_MB,
  exe = 'soffice',
): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; sandboxed: boolean }> {
  const sandboxed = await canUnshare();
  const cap = (await canPrlimit())
    ? ['prlimit', `--as=${Math.round(addressSpaceMb) * 1024 * 1024}`, '--']
    : [];
  const ns = sandboxed ? ['unshare', '-rn', '--'] : [];
  const full = [...cap, ...ns, exe, ...args];
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
 * process group; with a throwaway profile in `outDir`. `exe` is `HubTools.libreoffice().exe`: '' (no
 * LibreOffice) throws `ToolError.missing` without starting anything, as a soffice gone from the disk does.
 */
export async function sofficeToPdf(
  input: string,
  outDir: string,
  opts: { timeoutMs: number; signal: AbortSignal; addressSpaceMb?: number; exe: string },
): Promise<string> {
  if (!opts.exe) throw new ToolError('soffice: this hub has no LibreOffice', '', true);
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
    opts.exe,
  );
  await run(c.cmd, c.args, { timeoutMs: opts.timeoutMs, signal: opts.signal, env: c.env, group: true });
  const base = input.slice(input.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  const pdf = (await readdir(outDir)).find((f) => f === `${base}.pdf`);
  if (!pdf) throw new Error('LibreOffice produced no PDF');
  return join(outDir, pdf);
}

// ── The stored deck ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The stored deck's parts for a render copy of `copy.pages` (or of every shown slide): the XML in memory
 * (`readDeckXml`: ≤ 8 MB a part, ≤ 64 MB in all, every other part a placeholder), then a plan call on the
 * pool names the pictures that copy keeps, and only those are spilled under generated names in `dir`
 * (`spillDeckParts`: ≤ 2,000, ≤ 1 GiB). Unreferenced parts, media payloads and fonts are never written.
 */
export async function extractDeck(
  file: string,
  dir: string,
  signal: AbortSignal,
  copy: { pages: RenderCopyPage[]; allShown?: boolean },
): Promise<{ parts: Map<string, Uint8Array>; media: [string, string][]; over: number }> {
  await mkdir(dir, { recursive: true });
  const xml = await readDeckXml(file, dir, signal);
  // Copied, not transferred: the parts stay here for the copy itself.
  const plan = await cpuPool().run(
    'pptx-render-copy',
    {
      parts: xml.parts,
      media: [],
      pages: copy.pages,
      out: '',
      plan: true,
      ...(copy.allShown ? { allShown: true } : {}),
    },
    { signal },
  );
  const spilled = await spillDeckParts(file, dir, plan.need ?? [], signal);
  return { parts: xml.parts, media: [...spilled.files], over: spilled.skippedCount };
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
 * it is now. On an unedited slide (its objects still match `lo.digest`) the art replaces `ArtInfo.replaces`
 * just under `ArtInfo.before`. On an edited one it replaces only the objects still exactly as version 1 wrote
 * them (`lo.replaced`), in the same place; edited or deleted ones stay as they are and are noted, since the
 * art still shows them as they were (without `lo.replaced`, an older plan: the art goes on top, noted).
 * `pending` is cleared; `failed` is set when part of the work failed (`work.failed`).
 */
export function patchSlide(slide: Slide, lo: PptxLoSlide, work: SlideWork, hash: string): Slide {
  // Unedited: the import's objects (those with an origin) as the plan's digest has them; objects added in
  // ordo meanwhile do not count (`digest.ts`).
  const unedited = digestMatches(slide.objects, lo.digest);
  let objects = [...slide.objects];
  const notes: string[] = [];
  let lyricObjectId = slide.lyricObjectId;
  if (work.art && lo.art) {
    const art = artObject(work.art.mediaId, work.art.box);
    if (unedited || lo.replaced) {
      const v1 = new Map(lo.replaced ?? []);
      const same = (id: string) => {
        if (unedited) return true;
        const o = objects.find((x) => x.id === id);
        return !!o && v1.get(id) === digestOf([o]);
      };
      const gone = new Set(lo.art.replaces.filter(same));
      const changed = lo.art.replaces.length - gone.size;
      let at = lo.art.before === undefined ? -1 : objects.findIndex((o) => o.id === lo.art!.before);
      if (at < 0) at = lo.art.before === undefined ? objects.length : Math.min(objects.length, lo.art.at);
      const below = objects.slice(0, at).filter((o) => !gone.has(o.id));
      const above = objects.slice(at).filter((o) => !gone.has(o.id));
      objects = [...below, art, ...above];
      if (lyricObjectId && gone.has(lyricObjectId)) lyricObjectId = undefined;
      if (changed)
        notes.push(
          `edited since the import: the PowerPoint art still shows ${changed} edited or deleted object(s) as they were`,
        );
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
    // Version 1 left it out, so nothing draws it twice: under `before` while that object is there, else on top.
    insertUnder(objects, o, m.before);
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
    if (work.failed?.length) pptx.failed = true;
    else delete pptx.failed;
    // Within the schema's cap, counted in 'and N more' (`addNote`), never cut from the front.
    const all = [...(pptx.notes ?? [])];
    for (const n of notes) addNote(all, logSafe(n));
    if (all.length) pptx.notes = all;
    next.pptx = pptx;
  }
  const parsed = Slide.parse(next);
  // An unedited slide stays unedited: its digest follows what the converter wrote (the objects with an
  // origin: the art and metafiles carry one, objects added in ordo do not).
  if (unedited && parsed.pptx) parsed.pptx.digest = importDigest(parsed.objects);
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
    const deck = await extractDeck(deps.store.abs(file.path), join(dir, 'deck'), ctx.signal, { pages });
    if (deck.over) ctx.log(`[warn] ${deck.over} picture(s) past what a copy may extract are left out`);
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
        exe: deps.tools.has('libreoffice') ? (deps.tools.libreoffice().exe ?? '') : '',
      });
    }
    await rm(join(dir, 'deck'), { recursive: true, force: true });
    await each(pdf, copy, dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * What the follow-up may be given (`PptxImports`): how it queues the re-import of slides LibreOffice will never
 * draw (`withoutLibreOffice`); without it nothing is re-imported (tests).
 */
export type LoJobEnv = {
  reimport?: (presentationId: string, hash: string, slideIds: string[]) => Job | undefined;
};

/** The `pptx-lo` job. */
export function loJob(deps: PptxDeps, env: LoJobEnv = {}): JobHandler<PptxLoPayload> {
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
    // M9: on a hub without LibreOffice (queued before it went away, or a restored revision) nothing will draw
    // these slides: they stop waiting, and the M9 converter redraws the unedited ones. Only a LibreOffice
    // known absent or turned off does that: a 'broken' one (a probe that timed out on a slow start, a version
    // command that failed) is probed again, and the slides keep waiting while it does not answer.
    const lo = await deps.tools.recheck();
    if (lo === 'absent' || lo === 'off')
      return withoutLibreOffice(deps, ctx, env, 'this hub has no LibreOffice');
    let unanswered: string | undefined;
    if (lo !== 'available') {
      const why = logSafe(deps.tools.libreoffice().reason ?? lo, 200);
      const n = ctx.payload.probes ?? 0;
      if (n < LO_PROBE_RETRIES) {
        ctx.setPayload({ ...ctx.payload, probes: n + 1 });
        const ms = deferDelay(n);
        throw new JobDeferred(
          ms,
          `[warn] LibreOffice does not answer on this hub (${why}): trying again in ${Math.round(ms / 1000)} s`,
        );
      }
      unanswered = `LibreOffice did not answer on this hub after ${n + 1} attempts: ${why}`;
      ctx.log(`[warn] ${unanswered}`);
    }
    if (deps.locked(p0.id)) deferWhileLocked(ctx, 'LibreOffice will try');
    // Only slides that still wait: a re-run after the save (a crash, a restart) finds none and adds nothing twice.
    const waiting = new Set(
      p0.sections.flatMap((s) => s.slides.filter((sl) => sl.pptx?.pending).map((sl) => sl.id)),
    );
    const slides = pl.slides.filter((s) => waiting.has(s.slideId));
    const title = p0.title;
    // Waiting slides of this deck the plan does not name (a picture slide duplicated before this ran): a page
    // picture needs only the deck slide; anything else cannot be planned here and is reported.
    const planned = new Set(pl.slides.map((s) => s.slideId));
    const unplanned = new Set<string>();
    for (const sec of p0.sections)
      for (const sl of sec.slides) {
        if (!sl.pptx?.pending || sl.pptx.fileId !== pl.hash || planned.has(sl.id)) continue;
        slides.push({
          slideId: sl.id,
          index: sl.pptx.index,
          ...(sl.pptx.shown !== undefined ? { shown: sl.pptx.shown } : {}),
          class: sl.pptx.class,
          digest: sl.pptx.digest ?? '',
        });
        if (sl.pptx.class !== 'picture') unplanned.add(sl.id);
      }

    // What is still to make: art pairs, page pictures, metafile pairs (each part once).
    const pages: RenderCopyPage[] = [];
    const plans: Plan[] = [];
    const parts = new Set<string>();
    /** The page printing each deck slide whole (a duplicated slide shares it). */
    const whole = new Map<number, number>();
    for (const s of slides) {
      if (s.class === 'hybrid' && s.art?.elements.length && !done.has(`${s.slideId}:art`)) {
        const keep = s.art.elements;
        pages.push({ index: s.index, mode: 'art', background: 'white', keep });
        pages.push({ index: s.index, mode: 'art', background: SECOND, keep });
        plans.push({ kind: 'art', slide: s, white: pages.length - 2, black: pages.length - 1 });
      }
      if (s.class === 'picture' && !done.has(`${s.slideId}:page`)) {
        let page = whole.get(s.index);
        if (page === undefined) {
          pages.push({ index: s.index, mode: 'whole' });
          page = pages.length - 1;
          whole.set(s.index, page);
        }
        plans.push({ kind: 'page', slide: s, page });
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
    for (const id of unplanned) fail(id, 'copied before LibreOffice finished: its PowerPoint art is missing');
    let textBoxes = new Map<number, ExtractedText[]>();

    if ((pages.length || texts.length) && unanswered) {
      // The slides keep version 1, marked `failed`, as after a run that failed `LO_RETRIES` times.
      for (const s of slides) fail(s.slideId, 'LibreOffice could not draw this slide');
    } else if (pages.length || texts.length) {
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
        // soffice is gone (an image without LibreOffice, an uninstall): never retried. The hub knows it from
        // now on, and the slides stop waiting.
        if (e instanceof ToolError && e.missing) {
          deps.tools.markMissing('libreoffice', errorMessage(e));
          return withoutLibreOffice(deps, ctx, env, 'LibreOffice is no longer installed on this hub');
        }
        // LibreOffice or the pool failed for the whole copy: tried again later (what is stored stays), then
        // the slides keep version 1, marked `failed`, which the card and goLive report.
        const why = logSafe(errorMessage(e));
        const n = ctx.payload.retries ?? 0;
        if (n < LO_RETRIES) {
          ctx.setPayload({ ...ctx.payload, done: [...done], placed: [...placed], retries: n + 1 });
          const ms = deferDelay(n);
          throw new JobDeferred(
            ms,
            `[warn] LibreOffice could not draw the slides (${why}): trying again in ${Math.round(ms / 1000)} s`,
          );
        }
        ctx.log(`[warn] LibreOffice could not draw the slides after ${n + 1} attempts: ${why}`);
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
    const counts = { art: 0, pages: 0, metafiles: 0, edited: 0, failed: 0 };
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
          if (lo.digest && !digestMatches(sl.objects, lo.digest)) counts.edited++;
          if (next.pptx?.failed) counts.failed++;
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
        (counts.edited ? `, ${counts.edited} slide(s) edited meanwhile` : '') +
        (counts.failed ? `; LibreOffice could not draw ${counts.failed} slide(s)` : ''),
    );
    return { presentationId: saved.id, rev: saved.rev, ...counts };
  };
}

/** The `pptx-lo` result on a hub without LibreOffice (`withoutLibreOffice`). */
export type PptxLoWithoutResult = {
  presentationId: string;
  rev?: number;
  deleted?: true;
  withoutLibreOffice: true;
  /** Slides that stopped waiting (`pending` cleared, `missing` set). */
  cleared: number;
  /** The re-import that redraws the unedited ones with the M9 converter. */
  reimportJobId?: string;
};

/**
 * What a slide lacks when LibreOffice never draws it (`Slide.pptx.missing`): the kinds its plan recorded
 * (`PptxLoSlide.kinds`; none recorded: nothing, version 1 draws what the art would have), else read from what
 * it waited for (an older plan): its whole page ('slide'), its art ('element': the plan does not say what the
 * art held), its metafile pictures ('metafile').
 */
export function kindsWithoutLibreOffice(plan: PptxLoSlide | undefined, slide: Pick<Slide, 'pptx'>): string[] {
  const out: string[] = [];
  const add = (entry: string) => {
    const kind = missingKind(entry);
    const colon = entry.indexOf(':');
    const e = missingEntry(kind, colon > 0 ? entry.slice(colon + 1) : undefined);
    if (!out.includes(e) && out.length < MISSING_LIMITS.entries) out.push(e);
  };
  for (const k of Array.isArray(plan?.kinds) ? plan.kinds : []) if (typeof k === 'string') add(k);
  for (const k of slide.pptx?.missing ?? []) add(k);
  if (out.length) return out;
  // A plan that recorded its kinds and found none: version 1 draws everything the art would have (`artKinds`).
  if (Array.isArray(plan?.kinds) && !plan.kinds.length) return [];
  const cls = plan?.class ?? slide.pptx?.class;
  if (cls === 'picture') return ['slide'];
  if (cls === 'hybrid' && (!plan || plan.art)) add('element');
  if (plan?.metafiles?.length || plan?.metafileObjects?.length) add('metafile');
  return out.length ? out : ['element'];
}

/**
 * The follow-up on a hub without LibreOffice (design/27 M9; lo-dependencies §4.4, §4.7): a presentation
 * imported while LibreOffice was there, then the hub lost it (the lite image, an uninstall), or a restored
 * revision that brings back waiting slides. Nothing will draw them, so in one save (never while live-locked,
 * ADR 0007) every slide of this deck still `pending` stops waiting: `pending` is cleared and `missing` lists
 * what it lacks (`kindsWithoutLibreOffice`), with a note. In the same transaction the re-import of those
 * slides is queued (`LoJobEnv.reimport`): an unedited one is redrawn by this converter, which draws more of
 * PowerPoint than the one that planned the art (the digest covers the import's objects only, `digest.ts`, so
 * this save does not mark them edited); an edited one is kept as it is. LibreOffice never runs.
 */
export async function withoutLibreOffice(
  deps: PptxDeps,
  ctx: JobCtx<PptxLoPayload>,
  env: LoJobEnv,
  why: string,
): Promise<PptxLoWithoutResult> {
  const pl = ctx.payload;
  const p = deps.lib.presentations.get(pl.presentationId);
  if (!p) {
    ctx.log('the presentation was deleted: nothing to do');
    return { presentationId: pl.presentationId, deleted: true, withoutLibreOffice: true, cleared: 0 };
  }
  if (deps.locked(p.id)) deferWhileLocked(ctx, 'the slides are updated');
  const plans = new Map(pl.slides.map((s) => [s.slideId, s]));
  const cleared: string[] = [];
  const sections = p.sections.map((sec) => ({
    ...sec,
    slides: sec.slides.map((sl) => {
      if (!sl.pptx?.pending || sl.pptx.fileId !== pl.hash) return sl;
      const missing = kindsWithoutLibreOffice(plans.get(sl.id), sl);
      const { pending: _pending, ...pptx } = sl.pptx;
      cleared.push(sl.id);
      // Nothing it waited for is missing (its art only improved on what version 1 draws: flat 3-D past the
      // object budget): version 1 is the slide.
      if (!missing.length) {
        const next = Slide.safeParse({
          ...sl,
          pptx: { ...pptx, ...(pptx.class === 'hybrid' ? { class: 'native' } : {}) },
        });
        return next.success ? next.data : { ...sl, pptx };
      }
      const note = `not drawn: ${why} (${missingKinds(missing).map(missingLabel).join(', ')})`;
      // Within the schema's cap, counted in 'and N more' (`addNote`), never cut from the front.
      const notes = addNote([...(pptx.notes ?? [])], logSafe(note));
      const next = Slide.safeParse({ ...sl, pptx: { ...pptx, missing, notes } });
      return next.success ? next.data : { ...sl, pptx };
    }),
  }));
  if (!cleared.length) {
    ctx.log(`${why}: no slide waits any more`);
    return { presentationId: p.id, rev: p.rev, withoutLibreOffice: true, cleared: 0 };
  }
  const deck =
    p.source?.kind === 'pptx' && p.source.fileId === pl.hash && deps.lib.getFile(pl.hash)
      ? pl.hash
      : undefined;
  let reimportJobId: string | undefined;
  const saved = deps.lib.db.transaction(() => {
    const s = deps.lib.savePresentation({ ...p, sections } as Presentation, {
      expectedRev: p.rev,
      by: 'pptx-lo',
    });
    if (deck) reimportJobId = env.reimport?.(s.id, deck, cleared)?.id;
    return s;
  })();
  deps.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
  ctx.log(
    `${why}: ${cleared.length} slide(s) no longer wait for it` +
      (reimportJobId ? '; ordo redraws the unedited ones (re-import)' : ''),
  );
  return {
    presentationId: saved.id,
    rev: saved.rev,
    withoutLibreOffice: true,
    cleared: cleared.length,
    ...(reimportJobId ? { reimportJobId } : {}),
  };
}

/** Follow-ups of one presentation read when planning a new one (newest first). */
const FOLLOW_UP_HISTORY = 20;

/**
 * Queue a follow-up for the slides of a native import still `pending` after a save from outside the pptx
 * jobs (see the module comment), when none is queued or running for the presentation. Each slide is planned
 * as the newest earlier follow-up planned it (its art, metafiles, version 1's digest), else from the stored
 * slide (a picture-class page needs nothing else); the pictures those follow-ups stored and the library
 * still has are reused. Undefined when there is nothing to do.
 */
export function queueFollowUp(deps: PptxDeps, p: Presentation): Job | undefined {
  const hash = p.source?.kind === 'pptx' && p.source.native ? p.source.fileId : undefined;
  if (!hash) return undefined;
  const pending = p.sections.flatMap((s) =>
    s.slides.filter((sl) => sl.pptx?.pending && sl.pptx.fileId === hash),
  );
  if (!pending.length || !deps.lib.getFile(hash)) return undefined;
  const rows = deps.lib.db
    .prepare(
      `SELECT state, payload FROM jobs WHERE kind = ? AND json_extract(payload, '$.presentationId') = ?
       ORDER BY created_at DESC, id DESC LIMIT ${FOLLOW_UP_HISTORY}`,
    )
    .all(PPTX_JOBS.lo, p.id) as { state: string; payload: string }[];
  if (rows.some((r) => r.state === 'queued' || r.state === 'running')) return undefined;
  const plans = new Map<string, PptxLoSlide>();
  const done = new Map<string, string>();
  const placed = new Map<string, Box>();
  for (const r of rows) {
    let pl: Partial<PptxLoPayload>;
    try {
      pl = JSON.parse(r.payload) as Partial<PptxLoPayload>;
    } catch {
      continue;
    }
    if (pl.hash !== hash) continue;
    for (const s of Array.isArray(pl.slides) ? pl.slides : [])
      if (!plans.has(s.slideId)) plans.set(s.slideId, s);
    for (const [k, v] of Array.isArray(pl.done) ? pl.done : []) if (!done.has(k)) done.set(k, v);
    for (const [k, v] of Array.isArray(pl.placed) ? pl.placed : []) if (!placed.has(k)) placed.set(k, v);
  }
  const slides: PptxLoSlide[] = pending.map(
    (sl) =>
      plans.get(sl.id) ?? {
        slideId: sl.id,
        index: sl.pptx!.index,
        ...(sl.pptx!.shown !== undefined ? { shown: sl.pptx!.shown } : {}),
        class: sl.pptx!.class,
        digest: sl.pptx!.digest ?? '',
      },
  );
  const ids = new Set(slides.map((s) => s.slideId));
  const mine = (k: string) => k.startsWith('mf:') || ids.has(k.slice(0, k.lastIndexOf(':')));
  const reuse = [...done].filter(([k, id]) => mine(k) && (id === '' || deps.lib.media.get(id)));
  const where = [...placed].filter(([k]) => reuse.some(([d]) => d === k));
  const payload: PptxLoPayload = {
    presentationId: p.id,
    hash,
    version: CONVERTER_VERSION,
    slides,
    ...(reuse.length ? { done: reuse } : {}),
    ...(where.length ? { placed: where } : {}),
  };
  // M9: on a hub known to have no LibreOffice the follow-up only clears `pending` and queues the re-import
  // (`withoutLibreOffice`): light work, never behind a transcode. A 'broken' one may answer later (`loJob`
  // probes it again): the follow-up is LibreOffice's heavy work as usual.
  const lo = deps.tools.libreoffice().state;
  return lo === 'absent' || lo === 'off'
    ? deps.jobs.enqueue(PPTX_JOBS.lo, payload, 'light')
    : enqueuePptx(deps.jobs, PPTX_JOBS.lo, payload);
}

/** Whether the copy printed `got` for the page asked as `want` (same slide, mode and background or part). */
function samePage(got: RenderCopyPage, want: RenderCopyPage): boolean {
  if (got.mode === 'art' && want.mode === 'art') return got.background === want.background;
  if (got.mode === 'picture' && want.mode === 'picture')
    return got.part === want.part && got.background === want.background;
  return got.mode === want.mode;
}

/** Why a reference job without a PDF cannot run on a hub without LibreOffice (also the route's 501). */
export const NO_LIBREOFFICE_REFERENCE =
  'This hub has no LibreOffice. Add a PDF exported from PowerPoint instead.';
/** Why a reference job whose LibreOffice stays 'broken' fails (`HubTools.recheck`). */
export const LIBREOFFICE_UNANSWERED =
  'LibreOffice does not answer on this hub. Try again later, or add a PDF exported from PowerPoint instead.';
/** Why a PDF reference job cannot run (also the route's 501). */
export const NO_PDF_TOOLS = 'PDF pictures need poppler-utils (pdftoppm and pdfinfo) on the hub.';
/** pdfinfo's time for one PDF. */
const PDFINFO_MS = 30_000;
/** A PDF page's shape may differ from the slide's by this share (PowerPoint rounds the page to points). */
const PDF_ASPECT_SLACK = 0.01;

/** The `pptx-reference` job ('Show PowerPoint picture'): LibreOffice draws the pictures, or a PDF gives them. */
export function referenceJob(deps: PptxDeps): JobHandler<PptxReferencePayload> {
  return async (ctx) => {
    if (ctx.payload.pdf) return pdfReference(deps, ctx);
    const pl = ctx.payload;
    const done = new Map(pl.done ?? []);
    const save = () => ctx.setPayload({ ...ctx.payload, done: [...done] });
    const p0 = deps.lib.presentations.get(pl.presentationId);
    if (!p0) {
      ctx.log('the presentation was deleted: nothing to do');
      return { presentationId: pl.presentationId, deleted: true };
    }
    if (deps.locked(p0.id)) deferWhileLocked(ctx, 'LibreOffice will try');
    const want = referenceSlides(p0, pl.hash);
    const pages: RenderCopyPage[] = [...want.keys()]
      .filter((i) => !done.has(i))
      .sort((a, b) => a - b)
      .map((index) => ({ index, mode: 'whole' as const }));
    if (pages.length) {
      // M9: queued on a hub that has (or since lost) no LibreOffice: refused in words, never with a tool's output.
      // A 'broken' one is probed again first (`recheck`), and the job waits a little while it does not answer.
      const lo = await deps.tools.recheck();
      if (lo === 'absent' || lo === 'off') throw new Error(NO_LIBREOFFICE_REFERENCE);
      if (lo !== 'available') {
        const n = ctx.payload.probes ?? 0;
        if (n >= LO_RETRIES) throw new Error(LIBREOFFICE_UNANSWERED);
        ctx.setPayload({ ...ctx.payload, probes: n + 1 });
        throw new JobDeferred(deferDelay(n), `[warn] ${LIBREOFFICE_UNANSWERED}`);
      }
      try {
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
              name: `${p0.title} – ${want.get(got.index) ?? got.index + 1} (PowerPoint)`,
            });
            done.set(got.index, id);
            save();
          }
        });
      } catch (e) {
        if (ctx.signal.aborted || !(e instanceof ToolError) || !e.missing) throw e;
        deps.tools.markMissing('libreoffice', errorMessage(e));
        throw new Error(NO_LIBREOFFICE_REFERENCE);
      }
    }
    return saveReferences(deps, ctx, done);
  };
}

/**
 * Every slide of this deck in the presentation, once (a duplicated slide shares its picture), hidden ones
 * too: a click in the grid shows a hidden slide in the service (design/27 §9), and it must draw what the others
 * draw. The render copy prints each page asked for, hidden or not. Named by the shown position.
 */
function referenceSlides(p: Presentation, hash: string): Map<number, string> {
  const want = new Map<number, string>();
  for (const sec of p.sections)
    for (const sl of sec.slides)
      if (sl.pptx?.fileId === hash)
        want.set(
          sl.pptx.index,
          sl.pptx.shown !== undefined ? `${sl.pptx.shown + 1}` : `hidden slide ${sl.pptx.index + 1}`,
        );
  return want;
}

/** The reference pictures stored (`done`) on their slides, in one revision saved as `pptx-reference`. */
function saveReferences(
  deps: PptxDeps,
  ctx: JobCtx<PptxReferencePayload>,
  done: Map<number, string>,
): { presentationId: string; deleted?: true; rev?: number; slides?: number; pictures?: number } {
  const pl = ctx.payload;
  const p = deps.lib.presentations.get(pl.presentationId);
  if (!p) return { presentationId: pl.presentationId, deleted: true };
  if (deps.locked(p.id)) deferWhileLocked(ctx, 'the slides are updated');
  // Every slide gets its picture; only those `showPicture` names (all when absent) switch to it.
  const switched = pl.showPicture ? new Set(pl.showPicture) : undefined;
  let shown = 0;
  let pictures = 0;
  const sections = p.sections.map((sec) => ({
    ...sec,
    slides: sec.slides.map((sl) => {
      const id = sl.pptx?.fileId === pl.hash ? done.get(sl.pptx.index) : undefined;
      if (!id || !sl.pptx) return sl;
      pictures++;
      if (switched && !switched.has(sl.id)) return { ...sl, pptx: { ...sl.pptx, refMediaId: id } };
      shown++;
      return { ...sl, pptx: { ...sl.pptx, refMediaId: id, show: 'picture' as const } };
    }),
  }));
  const saved = deps.lib.savePresentation(
    { ...p, sections },
    // Saved as the job (an editor takes a PowerPoint job's revision over, `adoptJobSaves`); who asked is logged.
    { expectedRev: p.rev, by: 'pptx-reference' },
  );
  deps.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
  ctx.log(
    `${pictures} PowerPoint picture(s)${pl.pdf ? ' from the PDF' : ''}; ${shown} slide(s) show the picture${pl.by ? ` (asked by ${logSafe(pl.by, 100)})` : ''}`,
  );
  return { presentationId: saved.id, rev: saved.rev, slides: shown, pictures };
}

/** A PDF's page count and each page's size in points (turned pages swapped), from `pdfinfo`. */
export async function pdfPages(
  pdf: string,
  signal: AbortSignal,
  maxPages = PPTX_LIMITS.slides,
): Promise<{ pages: number; sizes: [number, number][] }> {
  const first = await run('pdfinfo', [pdf], { timeoutMs: PDFINFO_MS, signal });
  const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(first.stdout)?.[1] ?? Number.NaN);
  if (!Number.isInteger(pages) || pages < 1) throw new Error('The PDF has no pages');
  if (pages > maxPages) return { pages, sizes: [] };
  const all = await run('pdfinfo', ['-f', '1', '-l', String(pages), pdf], { timeoutMs: PDFINFO_MS, signal });
  const sizes: [number, number][] = [];
  const rot = new Map<number, number>();
  for (const m of all.stdout.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)\s*$/gm))
    rot.set(Number(m[1]), Number(m[2]));
  for (const m of all.stdout.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+) pts/gm)) {
    const k = Number(m[1]);
    const w = Number(m[2]);
    const h = Number(m[3]);
    if (!(k >= 1 && k <= pages) || !(w > 0) || !(h > 0)) continue;
    const turned = (rot.get(k) ?? 0) % 180 === 90;
    sizes[k - 1] = turned ? [h, w] : [w, h];
  }
  return { pages, sizes };
}

/** The deck's slide list and size, read on the pool (`pptx-scene` without slides): the deck is untrusted. */
async function deckListing(
  file: string,
  dir: string,
  signal: AbortSignal,
): Promise<{ listed: SlideRef[]; size: { cx: number; cy: number } }> {
  const xml = await readDeckXml(file, dir, signal);
  const out = await cpuPool().run(
    'pptx-scene',
    { parts: xml.parts, pictureSizes: [], range: { from: 0, to: 0 }, options: {} },
    { signal },
  );
  xml.parts.clear();
  return { listed: out.result.listed, size: { cx: out.result.frame.cx, cy: out.result.frame.cy } };
}

/** Why a PDF's pages do not fit the deck (both counts, design/27 M9). */
export function pageCountMismatch(pages: number, shown: number, listed: number): string {
  const slides =
    shown === listed
      ? `the presentation has ${listed} slide${listed === 1 ? '' : 's'}`
      : `the presentation shows ${shown} slide${shown === 1 ? '' : 's'} (${listed} with hidden ones)`;
  return `The PDF has ${pages} page${pages === 1 ? '' : 's'}; ${slides}. Export it from PowerPoint again.`;
}

/**
 * 'Show original' from PowerPoint's own pixels (design/27 M9; lo-dependencies §4.6): the PDF PowerPoint
 * exported (`PptxReferencePayload.pdf`, a stored file) instead of LibreOffice, on any hub with poppler-utils.
 * - Its pages are PowerPoint's default export (one per shown slide) or 'print hidden slides' (one per listed
 *   slide); any other count fails with both counts, and a page not shaped like the slides (within 1 %: notes
 *   pages, handouts) fails too.
 * - Each page this presentation needs is drawn by pdftoppm at the size LibreOffice's pages have (a fixed output
 *   size, so a crafted page size cannot blow memory), stored, and set as `Slide.pptx.refMediaId` as the
 *   LibreOffice source does (resume pairs in `done`).
 * The PDF is released once the pictures are on the slides, or when the job fails for good, unless another
 * queued or running reference job names it (`releaseReferencePdf`; two presentations from one deck may be
 * given the same PDF). A job is only ever aborted by a shutdown (the queue has no cancel), after which it
 * runs again and needs the PDF; one abandoned after repeated crashes releases it in its give-up.
 */
async function pdfReference(
  deps: PptxDeps,
  ctx: JobCtx<PptxReferencePayload>,
): Promise<ReturnType<typeof saveReferences>> {
  const pl = ctx.payload;
  const pdfHash = pl.pdf!;
  const done = new Map(pl.done ?? []);
  const save = () => ctx.setPayload({ ...ctx.payload, done: [...done] });
  const release = () => releaseReferencePdf(deps, pdfHash, ctx.id);
  try {
    const p0 = deps.lib.presentations.get(pl.presentationId);
    if (!p0) {
      ctx.log('the presentation was deleted: nothing to do');
      await release();
      return { presentationId: pl.presentationId, deleted: true };
    }
    if (deps.locked(p0.id)) deferWhileLocked(ctx, 'the PowerPoint pictures are drawn');
    await deps.tools.ready;
    if (!deps.tools.has('pdfinfo')) throw new Error(NO_PDF_TOOLS);
    const pdfRow = deps.lib.getFile(pdfHash);
    if (!pdfRow) throw new Error('The PDF is no longer stored: add it again');
    const deckRow = deps.lib.getFile(pl.hash);
    if (!deckRow) throw new Error('The PowerPoint file is no longer stored');
    const want = referenceSlides(p0, pl.hash);
    const todo = [...want.keys()].filter((i) => !done.has(i)).sort((a, b) => a - b);
    if (todo.length) {
      const pdf = deps.store.abs(pdfRow.path);
      const dir = await deps.store.tmpDir();
      try {
        const { listed, size } = await deckListing(deps.store.abs(deckRow.path), dir, ctx.signal);
        const info = await pdfPages(pdf, ctx.signal);
        const shown = listed.filter((r) => !r.hidden).length;
        // PowerPoint's default export has the shown slides; 'Print hidden slides' every listed one.
        const pageOf =
          info.pages === shown
            ? (r: SlideRef) => (r.shown === undefined ? undefined : r.shown + 1)
            : info.pages === listed.length
              ? (r: SlideRef) => r.index + 1
              : undefined;
        if (!pageOf) throw new Error(pageCountMismatch(info.pages, shown, listed.length));
        const aspect = size.cx / size.cy;
        for (let k = 0; k < info.pages; k++) {
          const s = info.sizes[k];
          if (s && Math.abs(s[0] / s[1] - aspect) <= PDF_ASPECT_SLACK * aspect) continue;
          throw new Error(
            `Page ${k + 1} of the PDF is not shaped like the slides${s ? ` (${Math.round(s[0])} x ${Math.round(s[1])} pt)` : ''}: export the slides themselves, not notes pages or handouts.`,
          );
        }
        const page = pageSize(size);
        const byIndex = new Map(listed.map((r) => [r.index, r]));
        let n = 0;
        for (const index of todo) {
          if (ctx.signal.aborted) throw new Error('cancelled');
          ctx.progress((0.9 * ++n) / todo.length);
          const r = byIndex.get(index);
          const k = r ? pageOf(r) : undefined;
          // A hidden slide has no page in the default export: it keeps no picture.
          if (k === undefined) continue;
          const png = await pdfPage(pdf, k, join(dir, `page-${k}`), {
            ...page,
            format: 'png',
            timeoutMs: deps.cfg.timeouts.pdf,
            signal: ctx.signal,
          });
          const id = await store(deps, png, {
            ...page,
            hasAlpha: false,
            key: `${pdfHash}:reference:${index}`,
            name: `${p0.title} – ${want.get(index) ?? index + 1} (PowerPoint PDF)`,
          });
          done.set(index, id);
          save();
        }
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    const result = saveReferences(deps, ctx, done);
    await release();
    return result;
  } catch (e) {
    // A deferral or a cancel (a restart) runs again and needs the PDF; any other failure is final.
    if (e instanceof ToolError && e.missing) deps.tools.markMissing('pdftoppm', errorMessage(e));
    if (!(e instanceof JobDeferred) && !ctx.signal.aborted) await release();
    if (e instanceof ToolError && e.missing) throw new Error(NO_PDF_TOOLS);
    throw e;
  }
}

/**
 * Remove a reference job's uploaded PDF from the store, unless a queued or running `pptx-reference` job other
 * than `except` names it (`PptxReferencePayload.pdf`), or the library references it (`Store.release`). The
 * check and the removal of the file's row run in one turn of the event loop, so a job queued meanwhile is
 * seen. Never throws.
 */
export async function releaseReferencePdf(
  deps: Pick<PptxDeps, 'lib' | 'store'>,
  pdf: unknown,
  except?: string,
): Promise<void> {
  if (typeof pdf !== 'string' || !pdf) return;
  try {
    const other = deps.lib.db
      .prepare(
        `SELECT 1 FROM jobs WHERE kind = ? AND state IN ('queued','running') AND id IS NOT ?
           AND (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.pdf') END) = ? LIMIT 1`,
      )
      .get(PPTX_JOBS.reference, except ?? null, pdf);
    if (other) return;
    await deps.store.release(pdf);
  } catch {
    // Left in the store: the next reference job given the same PDF releases it.
  }
}

// ── The 'Pictures (LibreOffice)' import ─────────────────────────────────────────────────────────────────

/**
 * The 'Pictures (LibreOffice)' import's input: the worker-built render copy of every shown slide, written
 * over `deck` (design/27 §5 "Render copy"; it replaces `pptxForRendering`). Returns what the copy did, for
 * the job log. Throws when the pool cannot run it (`WorkerStartError`) or the deck cannot be read: the
 * caller then fails the import, since LibreOffice never sees a deck as uploaded (design/21).
 */
export async function renderCopyForDocument(
  deck: string,
  dir: string,
  signal: AbortSignal,
): Promise<{ pages: number; outlines: number; notes: string[] }> {
  const partsDir = join(dir, 'deck-parts');
  try {
    const d = await extractDeck(deck, partsDir, signal, { pages: [], allShown: true });
    const out = join(dir, 'render-copy.pptx');
    const copy = await cpuPool().run(
      'pptx-render-copy',
      { parts: d.parts, media: d.media, pages: [], out, allShown: true },
      { signal, transfer: transferables(d.parts.values()) },
    );
    await rm(deck, { force: true });
    await rename(out, deck);
    const notes = d.over
      ? [...copy.notes, `${d.over} picture(s) past what a copy may extract are left out`]
      : copy.notes;
    return { pages: copy.pages.length, outlines: copy.outlines, notes };
  } finally {
    await rm(partsDir, { recursive: true, force: true });
  }
}
