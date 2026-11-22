import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRecipe, type RasterFont, type RecipeWire } from './raster-recipe.ts';
import {
  LIVE_ABORT,
  RASTER_PAGE_MS,
  type RasterDraw,
  RasterBrowser,
  type RasterReason,
} from './rasterPage.ts';

/*
 * The picture maker the hub's import job calls (C-RM2; the owner's Q53 and Q56.d: the hub uses the tools it has,
 * and the browser where it can). This file decides WHICH tool draws a picture (`rastersFor`: the hub's own
 * headless Chromium first, LibreOffice's art as today, today's boxes where there is neither), draws a recipe
 * (`renderRecipe`) and draws a list of recipes one at a time with the live-safety rules (`drawRasters`):
 * - no picture starts while ANY service is live or in its grace after End service (`anyServiceLive`);
 * - a LIVE WATCHER (a timer of at most WATCH_MS) looks at that state from the moment a picture's browser starts
 *   (the launch hears it too) and during the picture and, the moment a service goes live, kills the browser's whole
 *   process group at once: the unfinished picture is 'live' and the rest are left undrawn;
 * - one browser at a time hub-wide and one picture at a time (the driver's single flight), niced and in its own
 *   group (rasterPage.ts), a crashed browser relaunched ONCE.
 * Nothing here stores anything: the planner's store step (rasterStore.ts) supplies `accept`, which takes each
 * finished picture (the byte cap, the disk floor, the media row). Nothing here runs on a GO path or in a service:
 * only the hub's import job, the tests and the measures import this file (a grep gate pins it).
 */

export { RASTER_PAGE_MS };
export type { RasterReason, RasterFont };

/** What one import may make: pictures, wall time and picture bytes (read by the planner's store step; LIMITS.txt). */
export const RASTER_LIMITS_HUB = { perImport: 200, importMs: 300_000, importBytes: 268_435_456 } as const;

/**
 * Whether a hub WITH LibreOffice takes its own picture when it has a Chromium too (Q53.j, rung 3). FALSE, by the planner's
 * measure M-SR5 (shape-raster-2, notes.md 'M-SR5'): on Traffic Dark a hub with LibreOffice scores 0.9869 / 0.9734 / 0.9895 on
 * slides 88 / 89 / 91 with the own pictures against 0.9870 / 0.9946 / 0.9896 with LibreOffice's page in the same run (a drop of 0.0212
 * on 89; the full deck's diagnosis has 0.9987 for 88, a drop of 0.0118 there), none recovered by a named later project (Q51), so a hub
 * with LibreOffice keeps LibreOffice's art as today and says so
 * (`rasterOffReason` 'libreoffice'). The one line to flip if the owner asks for the own picture there (Q53.j).
 */
export const RASTER_WITH_LIBREOFFICE = false;

/** The PDF route (rung 2) exists only if G-SPIKE failed (step 3-alt): it was not built. */
export const RASTER_PDF_ROUTE = false;

/** The live watcher's period: a service that goes live stops a picture within about this long plus the kill. */
export const WATCH_MS = 250;

export type RasterMaker = 'page' | 'pdf' | 'off';

export type RastersForArgs = {
  /** The pre-render switch is on (store-2's `prerender.state`). */
  prerender: boolean;
  /** The hub has LibreOffice. */
  lo: boolean;
  /** The hub has a Chromium that answers (`tools.has('chromium')`). */
  chromium: boolean;
  /** The hub has pdftoppm. */
  poppler: boolean;
  /** 'off' for a per-slide Reset slide (the picture step is skipped on purpose). */
  request?: 'off';
};

/**
 * Which maker draws the pictures of this import, decided ONCE at its start (an import never mixes two): the hub's
 * Chromium ('page'), a PDF route only if it was built ('pdf'), else 'off' (LibreOffice's art as today where there
 * is a LibreOffice, today's boxes elsewhere). A pure function of its arguments.
 */
export function rastersFor(a: RastersForArgs): RasterMaker {
  if (a.request === 'off' || !a.prerender) return 'off';
  if (a.lo && !RASTER_WITH_LIBREOFFICE) return 'off';
  if (a.chromium) return 'page';
  if (RASTER_PDF_ROUTE && a.poppler) return 'pdf';
  return 'off';
}

/**
 * Which report line an 'off' answer needs: 'no-maker' (no Chromium that answers and no LibreOffice: today's boxes
 * and the line 'this computer cannot draw pictures of shapes (it needs Chromium)'), 'libreoffice' (LibreOffice's art
 * draws these shapes as before), undefined for every other answer (a request 'off', the switch off, a maker present).
 */
export function rasterOffReason(a: RastersForArgs): 'no-maker' | 'libreoffice' | undefined {
  if (a.request === 'off' || !a.prerender) return undefined;
  if (rastersFor(a) !== 'off') return undefined;
  return a.lo ? 'libreoffice' : 'no-maker';
}

/** The slice of the hub the loop reads: whether a service is live (apps/hub/src/pacing.ts `holding`). */
export type RasterHub = { jobs: { pacing?: { holding(): boolean } } };

/**
 * Whether ANY service is live or in the grace after End service (`JobPacing.holding`: the live process's mode,
 * for every presentation). A hand-built hub with no pacing object (a test) is not live.
 */
export function anyServiceLive(deps: RasterHub): boolean {
  return deps.jobs.pacing?.holding() === true;
}

/** One browser session as the loop uses it (the driver's `RasterBrowser`, or a stub in the tests). */
export interface RasterSession {
  draw(
    recipeFile: string,
    fonts: RasterFont[],
    o?: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<RasterDraw>;
  close(): Promise<void>;
}

export type RasterDeps = RasterHub & {
  /** The Chromium executable (`HubTools` 'chromium'). */
  chromium?: string;
  /** Keep Chromium's own sandbox (ORDO_CHROMIUM_SANDBOX=1). */
  sandbox?: boolean;
  memoryMb?: number;
  noDevShm?: boolean;
  /** The built page file (tests with a stub browser pass a dummy; the default is `rasterPageFile()`). */
  pageFile?: string;
  /** Starts a session (tests pass a stub; the default is `RasterBrowser.launch`). */
  launch?: (workDir: string, signal: AbortSignal) => Promise<RasterSession>;
};

export type RenderOk = { ok: true; png: Uint8Array; w: number; h: number; ms: number };
export type RenderFail = { ok: false; reason: RasterReason; detail?: string };

/** The faces a recipe needs: those of the families its members name (none when no member has text). */
export function fontsFor(
  recipe: RecipeWire,
  all: readonly RasterFont[],
  base: readonly string[] = [],
): RasterFont[] {
  const want = new Set(base.map((f) => f.toLowerCase()));
  let text = false;
  for (const m of recipe.members) {
    if (m.text) text = true;
    for (const f of m.families ?? []) want.add(f.toLowerCase());
  }
  if (!text) return [];
  return all.filter((f) => want.has(f.family.toLowerCase()));
}

let fileCounter = 0;

/**
 * Draws one recipe: the validator FIRST (a hostile recipe never reaches a browser), the recipe written as a file in
 * the job's scratch folder, the session asked, the file removed. Never throws for one picture; `session` is the
 * caller's (one per loop). `fonts` is the list to register (see `fontsFor`).
 */
export async function renderRecipe(
  _deps: RasterHub,
  session: RasterSession,
  recipe: RecipeWire,
  opts: { workDir: string; fonts: RasterFont[]; signal?: AbortSignal; deadlineMs?: number },
): Promise<RenderOk | RenderFail> {
  const checked = checkRecipe(recipe);
  if (!checked.ok) return { ok: false, reason: 'recipe', detail: checked.reason };
  const file = join(opts.workDir, `recipe-${process.pid}-${++fileCounter}.json`);
  try {
    writeFileSync(file, JSON.stringify(recipe));
    const r = await session.draw(file, opts.fonts, {
      signal: opts.signal,
      deadlineMs: opts.deadlineMs ?? RASTER_PAGE_MS,
    });
    if (!r.ok) return { ok: false, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) };
    if (r.w !== recipe.w || r.h !== recipe.h)
      return { ok: false, reason: 'page', detail: "the picture is not the recipe's size" };
    return r;
  } catch (e) {
    return { ok: false, reason: 'page', detail: String((e as Error).message).slice(0, 200) };
  } finally {
    rmSync(file, { force: true });
  }
}

export type RasterItem = { hash: string; recipe: RecipeWire };

export type RasterAccept = (d: {
  hash: string;
  png: Uint8Array;
  w: number;
  h: number;
  ms: number;
}) => Promise<{ ok: true } | { ok: false; reason: string; stop?: boolean }>;

export type RasterLoopOptions = {
  workDir: string;
  signal: AbortSignal;
  /** Every face of the library and the bundled ones, as file URLs; the loop passes each recipe its families'. */
  fonts: () => Promise<RasterFont[]>;
  /** The planner's store step: takes each finished picture (the byte cap, the disk floor, the media row). */
  accept: RasterAccept;
  /** Families every text recipe registers besides its own (the default face). */
  baseFamilies?: readonly string[];
  /** The wall time of the whole loop (default RASTER_LIMITS_HUB.importMs): checked before every picture. */
  budgetMs?: number;
  log?: (line: string) => void;
  now?: () => number;
  /** A timer that returns its cancel function (default: an unref'd setTimeout). Tests inject fake time. */
  setTimer?: (fn: () => void, ms: number) => () => void;
};

export type RasterLoopResult = {
  made: number;
  /** Items that were tried and not made, with ordo's own reason. Items not in `failed` and not made were left undrawn. */
  failed: Map<string, RasterReason | string>;
  /** Why the loop ended before the last item ('live', 'aborted', 'budget', 'crash', or an `accept` reason), if it did. */
  stopped?: RasterReason | string;
};

const realTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/**
 * THE LOOP: draws `items` in order, ONE AT A TIME, in one browser session made lazily at the first picture and
 * closed in a `finally`. Before every picture it checks the abort signal, the wall-time budget and
 * `anyServiceLive`; from the start of a picture's browser and through the picture the live watcher runs; after every
 * picture the PNG goes to `accept`. A failure of one picture never ends the others, except `stop: true` from
 * `accept`, a service going live, an abort, the budget and a second crash. Never throws for one picture.
 */
export async function drawRasters(
  deps: RasterDeps,
  items: readonly RasterItem[],
  opts: RasterLoopOptions,
): Promise<RasterLoopResult> {
  const failed = new Map<string, RasterReason | string>();
  let made = 0;
  let stopped: RasterReason | string | undefined;
  let session: RasterSession | undefined;
  let crashes = 0;
  let fonts: RasterFont[] | undefined;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? realTimer;
  const started = now();
  const budget = opts.budgetMs ?? RASTER_LIMITS_HUB.importMs;
  const launch =
    deps.launch ??
    ((dir: string, signal: AbortSignal): Promise<RasterSession> => {
      if (!deps.chromium) return Promise.reject(new Error('no Chromium'));
      return RasterBrowser.launch(deps.chromium, dir, {
        signal,
        ...(deps.sandbox !== undefined ? { sandbox: deps.sandbox } : {}),
        ...(deps.memoryMb !== undefined ? { memoryMb: deps.memoryMb } : {}),
        ...(deps.noDevShm !== undefined ? { noDevShm: deps.noDevShm } : {}),
        ...(deps.pageFile !== undefined ? { pageFile: deps.pageFile } : {}),
      });
    });

  const closeSession = async (): Promise<void> => {
    const s = session;
    session = undefined;
    if (s) await s.close().catch(() => undefined);
  };

  try {
    for (let i = 0; i < items.length && stopped === undefined; i++) {
      const item = items[i]!;
      if (opts.signal.aborted) {
        stopped = 'aborted';
        break;
      }
      if (anyServiceLive(deps)) {
        stopped = 'live';
        break;
      }
      if (now() - started > budget) {
        stopped = 'budget';
        break;
      }
      // A recipe the validator refuses never starts a browser.
      const checked = checkRecipe(item.recipe);
      if (!checked.ok) {
        failed.set(item.hash, 'recipe');
        opts.log?.(`picture ${item.hash.slice(0, 8)} not made: recipe refused (${checked.reason})`);
        continue;
      }
      let outcome: RenderOk | RenderFail | undefined;
      for (;;) {
        const picture = new AbortController();
        const joined = () => picture.abort(opts.signal.reason);
        opts.signal.addEventListener('abort', joined, { once: true });
        // THE LIVE WATCHER: a service that goes live while this picture's browser is starting or while the picture
        // is being drawn stops it at once. It is armed BEFORE the launch (a start takes about 0.6 s on a quiet
        // machine and may wait for the one browser slot of the hub): the launch hears the same signal, so the
        // browser is killed within one tick of the live flip, not at the end of its start.
        let cancelWatch: () => void = () => undefined;
        const tick = (): void => {
          if (anyServiceLive(deps)) picture.abort(LIVE_ABORT);
          else cancelWatch = setTimer(tick, WATCH_MS);
        };
        cancelWatch = setTimer(tick, WATCH_MS);
        try {
          if (!session) {
            try {
              session = await launch(opts.workDir, picture.signal);
            } catch (e) {
              if (opts.signal.aborted) {
                stopped = 'aborted';
                break;
              }
              // The watcher cut the start: no picture began, so none is called failed.
              if (picture.signal.aborted) {
                stopped = 'live';
                break;
              }
              // No browser: this picture and every later one.
              opts.log?.(`picture browser did not start: ${String((e as Error).message).slice(0, 200)}`);
              for (let k = i; k < items.length; k++) failed.set(items[k]!.hash, 'no-browser');
              stopped = 'no-browser';
              break;
            }
          }
          fonts ??= await opts.fonts().catch(() => []);
          // A service that went live while the browser was starting (a launch that did not hear the cut, or a flip
          // after the last tick) begins no picture: the browser that came up is closed by the loop's `finally`.
          if (opts.signal.aborted) {
            stopped = 'aborted';
            break;
          }
          if (picture.signal.aborted || anyServiceLive(deps)) {
            stopped = 'live';
            break;
          }
          outcome = await renderRecipe(deps, session, item.recipe, {
            workDir: opts.workDir,
            fonts: fontsFor(item.recipe, fonts, opts.baseFamilies),
            signal: picture.signal,
          });
        } finally {
          cancelWatch();
          opts.signal.removeEventListener('abort', joined);
        }
        if (!outcome.ok && outcome.reason === 'crash') {
          await closeSession();
          crashes++;
          // A crashed browser is relaunched ONCE and the picture tried again; the second crash ends the run.
          if (crashes === 1) continue;
          for (let k = i; k < items.length; k++) failed.set(items[k]!.hash, 'crash');
          stopped = 'crash';
        } else if (
          !outcome.ok &&
          (outcome.reason === 'timeout' || outcome.reason === 'live' || outcome.reason === 'aborted')
        ) {
          // The browser was killed to stop the picture: a fresh one is made for the next, if there is one.
          await closeSession();
        }
        break;
      }
      if (stopped !== undefined || outcome === undefined) break;
      if (!outcome.ok) {
        failed.set(item.hash, outcome.reason);
        opts.log?.(
          `picture ${item.hash.slice(0, 8)} not made: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`,
        );
        if (outcome.reason === 'live' || outcome.reason === 'aborted') stopped = outcome.reason;
        continue;
      }
      let taken: Awaited<ReturnType<RasterAccept>>;
      try {
        taken = await opts.accept({
          hash: item.hash,
          png: outcome.png,
          w: outcome.w,
          h: outcome.h,
          ms: outcome.ms,
        });
      } catch (e) {
        opts.log?.(
          `picture ${item.hash.slice(0, 8)} not kept: ${String((e as Error).message).slice(0, 200)}`,
        );
        taken = { ok: false, reason: 'accept', stop: true };
      }
      if (taken.ok) made++;
      else {
        failed.set(item.hash, taken.reason);
        if (taken.stop) stopped = taken.reason;
      }
    }
  } finally {
    await closeSession();
  }
  return { made, failed, ...(stopped !== undefined ? { stopped } : {}) };
}
