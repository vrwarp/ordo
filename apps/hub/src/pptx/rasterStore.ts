/**
 * The hub's store step of the pictures of shapes (Q53, C-SR7; the owner's Q56.d: the hub uses the tools it has, and the
 * browser where it can). The converter plans each run of many-point shapes into one picture and hands the hub its RECIPE
 * (`EmitResult.rasters`, never stored, never sent to a screen); this file draws each recipe with the maker `rastersFor`
 * chose (`rasters.ts`: the hub's own headless Chromium running ordo's renderer), stores the PNG as an ordinary ready media
 * item and hands the job what stands in the part map for the picture's placeholder.
 *
 * - **Key.** A picture stands in the job's maps and resume pairs under `rasterMapKey(hash)` behind `RASTER_KEY_PREFIX` (a
 *   NUL, which no part name holds, as the bakes' keys do): the recipe's hash, which is also the item's `source` hash, so a
 *   re-import finds the stored picture without drawing anything and a resumed job never draws one twice.
 * - **Bounds.** At most `RASTER_LIMITS_HUB.perImport` distinct pictures an import (those the bakes made count too), at most
 *   `RASTER_LIMITS_HUB.importBytes` of PNG bytes (256 MiB, Q61: the picture that would pass it is not stored), the import's
 *   decoded-megapixel budget, the loop's wall time (`importMs`), and before each stored picture the disk floor is asked
 *   (`PptxDeps.disk`: a 507 fails the import with its usual message and saves nothing).
 * - **Loop.** ONE picture at a time through `drawRasters` (the maker's: one browser session per call, the abort signal and
 *   `anyServiceLive` checked before every picture, the live watcher during it, every recipe checked by `checkRecipe` before
 *   any browser starts). This file supplies its `accept` callback.
 * - **Failure.** Never an exception for one picture: it is listed in `failed` with ordo's own reason and the job puts the
 *   shapes back (`putBackRaster`, in `assemble`). What a stopped loop left undrawn is in `failed` too, so no picture is
 *   left half made and no image is ever stored with an unmapped id.
 *
 * Imported by the hub's import jobs and the tests only: never on a GO path, never in a service (a grep gate pins it).
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Media } from '@ordo/domain';
import { newId } from '@ordo/domain';
import { plausibleBytes } from '@ordo/importers/pptx-pictures.ts';
import type { RasterRecipe } from '@ordo/pptx-scene/raster.ts';
import { JobDeferred, type JobCtx } from '../jobs.ts';
import { deferDelay } from './fallback.ts';
import { findMedia } from './mediaParts.ts';
import { addReadyPicture, type PictureBudget, PictureError } from './pictures.ts';
import type { RasterFont, RecipeWire } from './raster-recipe.ts';
import {
  anyServiceLive,
  drawRasters,
  RASTER_LIMITS_HUB,
  type RasterAccept,
  type RasterDeps,
  type RasterItem,
  type RasterLoopResult,
} from './rasters.ts';
import type { PptxDeps } from './shared.ts';

/** What a picture's key starts with: a NUL, which no part name of the deck's maps holds. */
export const RASTER_KEY_PREFIX = '\u0000raster:';

/** The key of a picture in the job's part maps and resume pairs. */
export function rasterMapKey(hash: string): string {
  return RASTER_KEY_PREFIX + hash;
}

/** One picture of an import: its key, the recipe's hash and the recipe the converter wrote. */
export type RasterJobItem = { key: string; hash: string; recipe: RasterRecipe };

export type StoreRastersOptions = {
  /** The job's scratch folder: the loop's recipe files and browser profile live under it, each PNG is written here first. */
  dir: string;
  signal: AbortSignal;
  budget: PictureBudget;
  /** Resume pairs [key, media id] (the job's `done.media`); each new pair is appended before `save`. */
  done: [string, string][];
  save(): void;
  /** The media item's name. */
  name(): string;
  tags: string[];
  log(msg: string): void;
  /** Distinct pictures the bakes already made (they share `RASTER_LIMITS_HUB.perImport`). */
  already?: number;
  /** Distinct pictures at most (`RASTER_LIMITS_HUB.perImport`; tests set less). */
  maxPictures?: number;
  /** PNG bytes at most (`RASTER_LIMITS_HUB.importBytes`; tests set less). */
  maxBytes?: number;
  /** The loop's wall time (`RASTER_LIMITS_HUB.importMs`; tests set less). */
  budgetMs?: number;
  /** The maker's loop (the tests pass a stub: no Chromium is needed). */
  draw?: typeof drawRasters;
  /** What the loop reads besides the hub's pacing and the Chromium path (tests: a stub `launch`, a short page). */
  rasterDeps?: Partial<RasterDeps>;
  /** The faces a text recipe registers (default: the library's, as file URLs). */
  fonts?: () => Promise<RasterFont[]>;
};

export type StoreRastersResult = {
  /** Key → media id of every picture stored, found or resumed. */
  media: Map<string, string>;
  /** Keys that were not made, with ordo's own reason (a short word: `rasterReasonWords` says it in plain words). */
  failed: [string, string][];
  made: number;
  reused: number;
  resumed: number;
  /** Why the loop ended before the last picture, when it did ('live', 'aborted', 'budget', 'crash', 'no-browser', 'bytes', ...). */
  stopped?: string;
  /** PNG bytes stored by this call. */
  bytes: number;
};

/** The words of a reason, for the job's log and the import's report (no jargon: the owner's words are 'picture' and 'shape'). */
export function rasterReasonWords(reason: string): string {
  switch (reason) {
    case 'live':
      return 'a service started';
    case 'aborted':
      return 'the import was cancelled';
    case 'budget':
      return 'the import used its time for pictures';
    case 'timeout':
      return 'the picture took too long';
    case 'crash':
      return 'the picture maker stopped';
    case 'no-browser':
      return 'the picture maker did not start';
    case 'font':
      return 'a font for the words in it is missing';
    case 'empty':
      return 'the picture was empty';
    case 'recipe':
      return 'the drawing was refused';
    case 'bytes':
      return `the pictures would pass ${Math.round(RASTER_LIMITS_HUB.importBytes / 1024 / 1024)} MB`;
    case 'count':
      return `more than ${RASTER_LIMITS_HUB.perImport} pictures in one deck`;
    case 'pixels':
      return 'the import used its picture budget';
    case 'refused':
      return 'the picture was refused';
    case 'disk':
      return 'there is no room for it';
    default:
      return 'the picture could not be made';
  }
}

/** The library's faces as the picture page reads them: file URLs of the stored files (uploaded and bundled alike, Q63.b). */
function libraryFonts(deps: Pick<PptxDeps, 'lib' | 'store'>): RasterFont[] {
  return deps.lib.listFonts().map((f) => ({
    family: f.family,
    weight: f.weight,
    style: f.style,
    hash: f.file.hash,
    ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
    url: pathToFileURL(deps.store.abs(f.file.path)).href,
  }));
}

/**
 * Store an import's pictures of shapes, each once, with resume pairs. Never throws for one picture: it is listed in
 * `failed`; throws only for a cancel, and for the disk floor (the import then fails with its usual message and saves nothing).
 */
export async function storeRasters(
  deps: PptxDeps,
  items: readonly RasterJobItem[],
  opts: StoreRastersOptions,
): Promise<StoreRastersResult> {
  const res: StoreRastersResult = { media: new Map(), failed: [], made: 0, reused: 0, resumed: 0, bytes: 0 };
  const have = (m: Media | undefined): m is Media => !!m && m.kind === 'image' && m.state !== 'failed';
  for (const [key, id] of opts.done) {
    if (!key.startsWith(RASTER_KEY_PREFIX)) continue;
    if (have(deps.lib.media.get(id))) {
      res.media.set(key, id);
      res.resumed++;
    }
  }
  const max = opts.maxPictures ?? RASTER_LIMITS_HUB.perImport;
  const maxBytes = opts.maxBytes ?? RASTER_LIMITS_HUB.importBytes;
  let room = Math.max(0, max - (opts.already ?? 0) - res.media.size);
  const todo: RasterJobItem[] = [];
  let over = 0;
  try {
    for (const item of items) {
      if (opts.signal.aborted) throw new Error('cancelled');
      if (res.media.has(item.key)) continue;
      // Found already: the same recipe was drawn by an earlier import (the source hash of its item is the recipe's hash).
      const found = findMedia(
        deps,
        item.hash,
        'source',
        (m) =>
          m.kind === 'image' &&
          m.state === 'ready' &&
          m.width === item.recipe.w &&
          m.height === item.recipe.h,
      )[0];
      if (found) {
        res.media.set(item.key, found.id);
        opts.done.push([item.key, found.id]);
        res.reused++;
        continue;
      }
      if (room <= 0) {
        res.failed.push([item.key, 'count']);
        over++;
        continue;
      }
      room--;
      todo.push(item);
    }
    if (over)
      opts.log(
        `[warn] ${over} picture(s) of shapes past the ${max} one import makes are not made: their shapes are as before`,
      );
    if (!todo.length) return res;

    const byHash = new Map(todo.map((i) => [i.hash, i]));
    let diskError: unknown;
    let capped = 0;
    const accept: RasterAccept = async ({ hash, png, w, h }) => {
      const item = byHash.get(hash);
      if (!item) return { ok: false, reason: 'refused' };
      // The byte cap (Q61): the picture that would pass it is not stored; a smaller one after it still may be.
      if (res.bytes + png.length > maxBytes) {
        capped++;
        return { ok: false, reason: 'bytes' };
      }
      // The disk floor, asked before each picture is stored: a 507 fails the whole import with its usual message.
      try {
        await deps.disk?.assertRoom(plausibleBytes(w, h));
      } catch (e) {
        diskError = e;
        return { ok: false, reason: 'disk', stop: true };
      }
      try {
        opts.budget.spend((w * h) / 1e6);
      } catch {
        return { ok: false, reason: 'pixels' };
      }
      const file = join(opts.dir, `${newId()}.png`);
      try {
        await writeFile(file, png);
        const media = await addReadyPicture(
          deps,
          {
            path: file,
            ext: 'png',
            mime: 'image/png',
            width: w,
            height: h,
            hasAlpha: true,
            sourceHash: hash,
            notes: [],
          },
          { name: opts.name(), tags: opts.tags },
        );
        res.media.set(item.key, media.id);
        opts.done.push([item.key, media.id]);
        res.bytes += png.length;
        res.made++;
        opts.save();
        return { ok: true };
      } catch (e) {
        if (e instanceof PictureError)
          deps.log.warn({ err: e.message.slice(0, 300) }, 'pptx picture of shapes refused by the store');
        return { ok: false, reason: 'refused' };
      } finally {
        await rm(file, { force: true });
      }
    };

    const draw = opts.draw ?? drawRasters;
    const rasterDeps: RasterDeps = {
      jobs: deps.jobs,
      ...(deps.tools.has('chromium') ? { chromium: deps.tools.chromium().exe } : {}),
      sandbox: deps.cfg.chromium.sandbox,
      ...opts.rasterDeps,
    };
    const out: RasterLoopResult = await draw(
      rasterDeps,
      todo.map((i): RasterItem => ({ hash: i.hash, recipe: i.recipe as unknown as RecipeWire })),
      {
        workDir: opts.dir,
        signal: opts.signal,
        fonts: opts.fonts ?? (async () => libraryFonts(deps)),
        accept,
        ...(opts.budgetMs !== undefined
          ? { budgetMs: opts.budgetMs }
          : { budgetMs: RASTER_LIMITS_HUB.importMs }),
        log: (m) => opts.log(m),
      },
    );
    if (opts.signal.aborted) throw new Error('cancelled');
    if (diskError) throw diskError;
    if (capped)
      opts.log(
        `[warn] ${capped} picture(s) of shapes would pass the ${Math.round(maxBytes / 1024 / 1024)} MB one import may store: their shapes are as before`,
      );
    if (out.stopped) res.stopped = out.stopped;
    // Everything neither made nor accepted is put back by the job: tried and failed (named), or left undrawn by a stopped loop.
    for (const item of todo) {
      if (res.media.has(item.key)) continue;
      const why = out.failed.get(item.hash) ?? out.stopped ?? 'refused';
      res.failed.push([item.key, String(why)]);
    }
    if (out.stopped && out.stopped !== 'accept')
      opts.log(
        `[warn] pictures of shapes stopped: ${rasterReasonWords(out.stopped)}; the shapes of the ones not made are as before`,
      );
    const kinds = new Map<string, number>();
    for (const [, why] of res.failed) kinds.set(why, (kinds.get(why) ?? 0) + 1);
    for (const [why, n] of kinds)
      if (why !== 'count' && why !== 'bytes')
        opts.log(
          `[warn] ${n} picture(s) of shapes not made: ${rasterReasonWords(why)}; the shapes are as before`,
        );
  } finally {
    opts.save();
  }
  return res;
}

/**
 * Defer the job while a service is live (Q53, D4): the picture step never runs beside a service, so the job goes back to the
 * queue with the backoff of the other deferrals, before it does any work. The count lives in the payload (`deferrals`).
 */
export function deferForService(ctx: Pick<JobCtx<{ deferrals?: number }>, 'payload' | 'setPayload'>): never {
  const n = ctx.payload.deferrals ?? 0;
  ctx.setPayload({ ...ctx.payload, deferrals: n + 1 });
  const ms = deferDelay(n);
  throw new JobDeferred(
    ms,
    `waiting: a service is live; the pictures of shapes wait for it, so the import tries again in ${Math.round(ms / 1000)} s`,
  );
}

/** Whether a service is live now (the picture step's one question, answered by the maker's helper). */
export function serviceLive(deps: Pick<PptxDeps, 'jobs'>): boolean {
  return anyServiceLive({ jobs: deps.jobs });
}
