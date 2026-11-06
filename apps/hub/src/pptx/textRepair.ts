/**
 * Legacy text repair (design/27 §11 "Round trip and migration"; M3 item G). PowerPoint presentations
 * imported before M3 hold `imported.textBoxes` matched by list index (`imports.ts`), so after a hidden slide
 * they belong to another page. Text readers trust them only with `imported.textAligned`.
 *
 * The one-shot, resumable `pptx-text-repair` job goes over every pptx-sourced presentation without
 * `source.native` whose deck is still stored, re-extracts the text with pptx-scene keyed by the slide each
 * page actually shows (`pagesOf`), rewrites `textBoxes` with the uniform contain mapping, sets
 * `textAligned` and saves a new revision. Locked presentations are retried after End service; a
 * presentation whose deck is gone keeps today's behaviour (no text fallback).
 *
 * `textAligned` is a tri-state: undefined on a page nobody has checked (a candidate for the repair), `true`
 * once its boxes are its own, `false` when the repair could not read the deck (the old boxes stay for 'Make
 * editable', readers ignore them, and the repair does not try again at every start).
 *
 * The 'Pictures (LibreOffice)' import (`imports.ts` `documentJob`) writes its boxes through `readDeckText`
 * and `pagesOf` too, aligned from the start.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ExtractedText, newId, type Presentation, type PptxRenderer, type Slide } from '@ordo/domain';
import { extractZip } from '@ordo/importers/zip-stream.ts';
import type { EmittedSlide, SlideRef } from '@ordo/pptx-scene';
import type { Job } from '@ordo/protocol';
import { errorMessage } from '../errors.ts';
import type { JobCtx, JobHandler } from '../jobs.ts';
import { cpuPool, WorkerStartError } from '../pool.ts';
import { logSafe } from './report.ts';
import type { PptxDeps, TextRepairPayload } from './shared.ts';
import { enqueuePptx, PPTX_JOBS, PPTX_LIMITS } from './shared.ts';

/** `savedBy` of the revisions the repair writes. */
export const TEXT_REPAIR_BY = 'pptx-text-repair';

/** How often a repair that found presentations live-locked looks again (End service unlocks them). */
export const REPAIR_RETRY_MS = 60_000;

/** Pages a legacy import can have (`Slide.imported.page` is at most 100,000). */
const MAX_PAGES = 100_000;
/** Text boxes per page (`Slide.imported.textBoxes`) and characters per box (the schema's bounds). */
const MAX_BOXES = 1000;
const MAX_BOX_TEXT = 20_000;
/** Decks whose text one repair run keeps (each is text only: a few hundred KB at most). */
const DECK_CACHE = 4;
/** Parts that stay in memory for the parser: XML and relationships; media and fonts are only names. */
const XML_PART = /\.(xml|rels)$/i;

/** What the job reports. */
export type TextRepairResult = {
  /** Presentations saved with aligned text boxes. */
  repaired: number;
  /** Presentations with nothing to do (no deck, deleted, already aligned). */
  skipped: number;
  /** Presentations whose deck could not be read: their pages are marked `textAligned: false`. */
  failed: number;
  /** Presentations that were live-locked: retried after End service. */
  deferred: number;
};

/**
 * Which listed slide (`SlideRef.index`) each page of a legacy picture import shows: for `renderer`
 * 'libreoffice' or unset, pages count shown slides; for 'pptx-preview', shown slides only when the page
 * count equals the shown count, else every listed slide.
 *
 * Page k (0-based, `imported.page - 1`) maps to `out[k]`; -1 when no listed slide is known for it (a slide
 * listed twice prints a page of its own, which `listed` does not repeat, and pages past the deck's end).
 * The shown count is the number of shown listings (the LibreOffice page count), repeats included.
 */
export function pagesOf(
  renderer: PptxRenderer | undefined,
  listed: readonly { index: number; hidden: boolean; shown?: number }[],
  pageCount: number,
): number[] {
  const n = Number.isFinite(pageCount) ? Math.max(0, Math.min(MAX_PAGES, Math.floor(pageCount))) : 0;
  const byShown = new Map<number, number>();
  let shownCount = 0;
  for (const r of listed) {
    if (r.hidden || r.shown === undefined) continue;
    byShown.set(r.shown, r.index);
    shownCount = Math.max(shownCount, r.shown + 1);
  }
  const shown = renderer !== 'pptx-preview' || n === shownCount;
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(shown ? (byShown.get(k) ?? -1) : (listed[k]?.index ?? -1));
  return out;
}

/** A deck's text as `readDeckText` reads it. */
export type DeckText = {
  /** Every slide the deck lists, in order (`convertDeck`'s `listed`). */
  listed: SlideRef[];
  /**
   * Text boxes by `SlideRef.index`: the slide's text objects (and the text baked into its art, once the
   * converter emits art), in the 1920x1080 frame of its page picture (the uniform contain mapping).
   */
  boxes: Map<number, ExtractedText[]>;
};

/** One emitted slide's text as `Slide.imported.textBoxes`: valid boxes only, at most 1,000. */
export function slideBoxes(s: Pick<EmittedSlide, 'slide' | 'art'>): ExtractedText[] {
  const out: ExtractedText[] = [];
  const add = (text: string, box: unknown, size?: number) => {
    if (out.length >= MAX_BOXES || !text.trim()) return;
    const fontSizePx =
      typeof size === 'number' && Number.isFinite(size) ? Math.max(0, Math.min(5000, size)) : undefined;
    const r = ExtractedText.safeParse({
      text: text.slice(0, MAX_BOX_TEXT),
      box,
      ...(fontSizePx !== undefined ? { fontSizePx } : {}),
    });
    if (r.success) out.push(r.data);
  };
  for (const o of s.slide.objects) if (o.type === 'text') add(o.text, o.box, o.style.fontSizePx);
  if (s.art?.text) add(s.art.text, { ...s.art.box, rotation: 0 });
  return out;
}

/**
 * Read a stored deck's text with pptx-scene on the CPU pool (the deck is untrusted: never on the event
 * loop, never inline when the pool cannot start). Only XML and relationship parts are read into memory
 * (each ≤ 8 MB, ≤ 64 MB in all); every other part is spilled under a generated name into a folder under
 * `scratch` and removed at once, since the parser needs only its name. Batches of 150 slides, each with the
 * pool's timeout, within the import's 15 minutes of pool time.
 */
export async function readDeckText(deck: string, scratch: string, signal: AbortSignal): Promise<DeckText> {
  const spill = join(scratch, `text-${newId()}`);
  await mkdir(spill, { recursive: true });
  let parts: Map<string, Uint8Array>;
  try {
    const zip = await extractZip(deck, {
      dir: spill,
      spill: (path, size) => !XML_PART.test(path) || size > PPTX_LIMITS.xmlPartBytes,
      maxInMemoryBytes: PPTX_LIMITS.xmlTotalBytes,
      signal,
    });
    parts = zip.files;
  } finally {
    await rm(spill, { recursive: true, force: true });
  }
  const t0 = Date.now();
  const batch = PPTX_LIMITS.batchSlides;
  let listed: SlideRef[] = [];
  const boxes = new Map<number, ExtractedText[]>();
  for (let from = 0; from === 0 || from < listed.length; from += batch) {
    if (Date.now() - t0 > PPTX_LIMITS.importPoolMs)
      throw new Error(`reading the text took longer than ${PPTX_LIMITS.importPoolMs / 60_000} minutes`);
    const out = await cpuPool().run(
      'pptx-scene',
      { parts, pictureSizes: [], range: { from, to: from + batch }, options: {} },
      { signal },
    );
    if (from === 0) listed = out.result.listed;
    for (const s of out.result.slides) boxes.set(s.index, slideBoxes(s));
  }
  return { listed, boxes };
}

/** Whether a presentation still holds legacy pages the repair has not looked at. */
export function needsTextRepair(p: Pick<Presentation, 'source' | 'sections'>): boolean {
  if (p.source?.kind !== 'pptx' || p.source.native) return false;
  return legacyPages(p).length > 0;
}

/** The pages of a presentation the repair has not looked at (`imported` without `textAligned`). */
function legacyPages(p: Pick<Presentation, 'sections'>): NonNullable<Slide['imported']>[] {
  const out: NonNullable<Slide['imported']>[] = [];
  for (const sec of Array.isArray(p.sections) ? p.sections : [])
    for (const sl of Array.isArray(sec?.slides) ? sec.slides : [])
      if (sl?.imported && typeof sl.imported === 'object' && sl.imported.textAligned === undefined)
        out.push(sl.imported);
  return out;
}

/** The stored deck's file, or undefined when it is gone (its row or the file itself). */
function deckPath(deps: Pick<PptxDeps, 'lib' | 'store'>, hash: string): string | undefined {
  try {
    const f = deps.lib.getFile(hash);
    if (!f) return undefined;
    const abs = deps.store.abs(f.path);
    return existsSync(abs) ? abs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Presentations the repair should visit, oldest first: pptx-sourced, not native, with a page nobody has
 * checked whose deck is still stored. Rows are prefiltered in SQL (only presentations with imported pages
 * are parsed), so the check at every start costs little once the library is repaired.
 */
export function repairCandidates(deps: Pick<PptxDeps, 'lib' | 'store'>): string[] {
  const rows = deps.lib.db
    .prepare(`SELECT id, json FROM presentations WHERE json LIKE '%"imported":{%' ORDER BY created_at, id`)
    .all() as { id: string; json: string }[];
  const out: string[] = [];
  for (const r of rows) {
    let p: Presentation;
    try {
      p = JSON.parse(r.json) as Presentation;
    } catch {
      continue;
    }
    if (!needsTextRepair(p)) continue;
    const decks = new Set(legacyPages(p).map((i) => i.fileId));
    if ([...decks].some((h) => deckPath(deps, h))) out.push(r.id);
  }
  return out;
}

/** Whether a repair job is already queued or running (one at a time). */
function repairActive(deps: Pick<PptxDeps, 'lib'>): boolean {
  return !!deps.lib.db
    .prepare(`SELECT 1 FROM jobs WHERE kind = ? AND state IN ('queued', 'running') LIMIT 1`)
    .get(PPTX_JOBS.textRepair);
}

/**
 * The one-shot trigger: queue the repair when a stored presentation needs it and no repair is queued or
 * running. Called at every start (`ImportService`) and after End service for deferred presentations;
 * once the library is repaired it finds nothing and queues nothing.
 */
export function queueTextRepair(deps: PptxDeps): Job | undefined {
  if (repairActive(deps)) return undefined;
  if (!repairCandidates(deps).length) return undefined;
  return enqueuePptx(deps.jobs, PPTX_JOBS.textRepair, { done: [] });
}

const retries = new WeakMap<object, NodeJS.Timeout>();

/**
 * After a repair that found presentations live-locked: look every `ms` whether any of them is free again
 * (End service unlocks them all) and queue the repair then. One watch per library process; the timer never
 * keeps the process alive and stops for good when the queue is gone (the hub closed).
 */
export function retryAfterService(deps: PptxDeps, ids: readonly string[], ms = REPAIR_RETRY_MS): void {
  if (!ids.length || retries.has(deps)) return;
  const stop = () => {
    clearInterval(timer);
    retries.delete(deps);
  };
  const timer = setInterval(() => {
    try {
      if (ids.every((id) => deps.locked(id))) return;
      stop();
      queueTextRepair(deps);
    } catch (e) {
      stop();
      deps.log.warn({ err: errorMessage(e) }, 'the text repair could not be queued again');
    }
  }, ms);
  timer.unref?.();
  retries.set(deps, timer);
}

type Outcome = 'repaired' | 'skipped' | 'failed' | 'deferred';
type DeckPages = { pages: number[]; boxes: Map<number, ExtractedText[]> } | 'failed';

/** The `pptx-text-repair` job: every candidate once, one revision each (resumable through `done`). */
export function textRepairJob(deps: PptxDeps): JobHandler<TextRepairPayload> {
  return async (ctx) => {
    const done = new Set(Array.isArray(ctx.payload?.done) ? ctx.payload.done : []);
    if (done.size) ctx.log(`resuming: ${done.size} presentation(s) already handled`);
    const todo = repairCandidates(deps).filter((id) => !done.has(id));
    ctx.log(`${todo.length} PowerPoint presentation(s) to repair`);
    const counts = { repaired: 0, skipped: 0, failed: 0 };
    const deferred: string[] = [];
    // Decks read in this run (text only, small): presentations imported from the same deck read it once.
    const decks = new Map<string, DeckText>();
    const scratch = await deps.store.tmpDir();
    try {
      for (let i = 0; i < todo.length; i++) {
        if (ctx.signal.aborted) throw new Error('cancelled');
        const id = todo[i]!;
        const outcome = await repairOne(deps, id, scratch, ctx, decks);
        if (outcome === 'deferred') deferred.push(id);
        else {
          done.add(id);
          counts[outcome]++;
        }
        ctx.setPayload({ done: [...done], ...(deferred.length ? { deferred } : {}) });
        ctx.progress((i + 1) / todo.length);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    if (deferred.length) {
      ctx.log(`${deferred.length} presentation(s) are in the live service: repaired after End service`);
      retryAfterService(deps, deferred);
    }
    const result: TextRepairResult = { ...counts, deferred: deferred.length };
    return result;
  };
}

async function repairOne(
  deps: PptxDeps,
  id: string,
  scratch: string,
  ctx: JobCtx<TextRepairPayload>,
  cache: Map<string, DeckText>,
): Promise<Outcome> {
  const p = deps.lib.presentations.get(id);
  if (!p || !needsTextRepair(p)) return 'skipped';
  if (deps.locked(id)) return 'deferred';
  const title = `“${logSafe(p.title, 80)}”`;
  // The decks its pages come from, each with the highest page still held (pptx-preview's page count).
  const decks = new Map<string, number>();
  for (const imp of legacyPages(p)) decks.set(imp.fileId, Math.max(decks.get(imp.fileId) ?? 0, imp.page));
  const texts = new Map<string, DeckPages>();
  for (const [hash, pageCount] of decks) {
    const path = deckPath(deps, hash);
    if (!path) {
      ctx.log(`[warn] ${title}: its PowerPoint file is no longer stored; its pages keep no text fallback`);
      continue;
    }
    try {
      let t = cache.get(hash);
      if (!t) {
        t = await readDeckText(path, scratch, ctx.signal);
        if (cache.size >= DECK_CACHE) cache.delete(cache.keys().next().value!);
        cache.set(hash, t);
      }
      texts.set(hash, { pages: pagesOf(p.source?.renderer, t.listed, pageCount), boxes: t.boxes });
    } catch (e) {
      // A pool that cannot start, or a cancel, stops the job: it runs again at the next start.
      if (ctx.signal.aborted || e instanceof WorkerStartError) throw e;
      ctx.log(`[warn] ${title}: the PowerPoint file could not be read (${logSafe(errorMessage(e))})`);
      texts.set(hash, 'failed');
    }
  }
  if (!texts.size) return 'skipped';
  // Applied to the current copy, read and saved without a pause: an edit made meanwhile is kept.
  const cur = deps.lib.presentations.get(id);
  if (!cur || !needsTextRepair(cur)) return 'skipped';
  if (deps.locked(id)) return 'deferred';
  let aligned = 0;
  let unread = 0;
  const sections = cur.sections.map((sec) => ({
    ...sec,
    slides: sec.slides.map((sl): Slide => {
      const imp = sl.imported;
      const t = imp && imp.textAligned === undefined ? texts.get(imp.fileId) : undefined;
      if (!imp || !t) return sl;
      if (t === 'failed') {
        unread++;
        return { ...sl, imported: { ...imp, textAligned: false } };
      }
      aligned++;
      const slide = t.pages[imp.page - 1];
      const boxes = slide !== undefined && slide >= 0 ? (t.boxes.get(slide) ?? []) : [];
      const { textBoxes: _legacy, ...rest } = imp;
      return {
        ...sl,
        imported: { ...rest, ...(boxes.length ? { textBoxes: boxes } : {}), textAligned: true },
      };
    }),
  }));
  if (!aligned && !unread) return 'skipped';
  const saved = deps.lib.savePresentation({ ...cur, sections }, { expectedRev: cur.rev, by: TEXT_REPAIR_BY });
  deps.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
  ctx.log(
    `${title}: ${aligned} page(s) keyed by the slide they show` +
      (unread ? `, ${unread} page(s) left without a text fallback` : ''),
  );
  return aligned ? 'repaired' : 'failed';
}
