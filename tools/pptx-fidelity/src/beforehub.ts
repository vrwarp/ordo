/**
 * `--before hub` (design/27 §15 M9's exit, the M9 plan §6.2): the score of what a hub with LibreOffice
 * showed of each slide before M9, next to the native column's own score (`nativeSsim`: residual elements
 * draw nothing, so a hybrid slide's art box is blank). Written as `perSlide.beforeHubSsim`, with
 * `beforeHubFrom` saying how it was taken.
 *
 * - **From the hub** (`BeforeHub`, `beforeHubFrom: 'hub'`): every deck with a slide the hub does not store
 *   native (`census.ts` `hubClasses`: hybrid or picture), with pending metafile pictures, or that the
 *   converter did not emit, is imported once through this checkout's hub with LibreOffice present
 *   (`hub-import.ts`: the upload route, the native import, then the LibreOffice follow-up). The hub's
 *   version 2 of those slides (LibreOffice's art over a hybrid slide's box, its page for a picture slide,
 *   its conversion of the metafiles) is fetched with its pictures and geometry files and drawn by the
 *   harness's renderer, as an output draws it, and scored against LibreOffice's page.
 * - **The pixel paste** (`beforeHubPaste`, the labelled fallback; `beforeHubFrom: 'paste'` where it stands
 *   in): LibreOffice's pixels inside those boxes (grown by 2 px before and 3 px after, as the M6 scratch
 *   scorer did) pasted over the native page, which is then scored as the native page is; a picture slide
 *   scores 1. It is kept for every such slide for comparison, and stands in where the hub could not give a
 *   score (its import failed, the slide is still pending, or `--before paste`). It is not a bound of the real
 *   picture either way: inside a box it takes LibreOffice's background, outside it misses the art's spill
 *   (a 3-D extrusion keeps `ART_MARGIN_PX` past the box), and a page of another size is resampled twice.
 * - Any other slide shows what the native column drew: its own score.
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HubSession, hubSlides, importDeck } from './hub-import.ts';
import type { NativeDeck, NativeRenderer, NativeSlide } from './native.ts';
import { pngSize, ssim } from './ssim.ts';

const run = promisify(execFile);

export type Box = { x: number; y: number; w: number; h: number; rotation?: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** What the hub showed of a slide before M9: its class there, the art box and the pending metafiles. */
export type HubBefore = {
  hub: 'native' | 'hybrid' | 'picture';
  art?: Box;
  metafiles?: readonly Box[];
  /**
   * Its slide budget fitted it by leaving something out (`plain`, `minimal`): a hub with LibreOffice keeps
   * LibreOffice's page for it instead (`ImportCore.pageForBudget`), so the hub is asked whatever its class.
   */
  budget?: boolean;
};

/** Regions pasted in one picture at most; past it, their bounding box is pasted. */
export const MAX_PASTES = 32;
/** px a region is grown by before (left, top) and after (right, bottom) its box, at the page's scale. */
const GROW_BEFORE = 2;
const GROW_AFTER = 3;

/** The axis-aligned bounds of a box turned by its rotation (degrees) about its centre. */
export function boundsOf(b: Box): Rect {
  const r = ((b.rotation ?? 0) * Math.PI) / 180;
  if (!r) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const w = b.w * c + b.h * s;
  const h = b.w * s + b.h * c;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

/** The logical regions LibreOffice's pixels are pasted in for a slide (none: the native page as drawn). */
export function pasteRegions(s: HubBefore): Rect[] {
  if (s.hub === 'picture') return [];
  const out: Rect[] = [];
  if (s.hub === 'hybrid' && s.art) out.push(boundsOf(s.art));
  for (const m of s.metafiles ?? []) out.push(boundsOf(m));
  const ok = out.filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0);
  if (ok.length <= MAX_PASTES) return ok;
  const x0 = Math.min(...ok.map((r) => r.x));
  const y0 = Math.min(...ok.map((r) => r.y));
  const x1 = Math.max(...ok.map((r) => r.x + r.w));
  const y1 = Math.max(...ok.map((r) => r.y + r.h));
  return [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }];
}

/** A whole-pixel region of a page. */
export type PxRect = { x: number; y: number; w: number; h: number };

/**
 * A logical region in the px of a page `w` x `h` that shows the slide area `rect` (scale: the page's height
 * over the area's, or its width over the area's where that is smaller, as LibreOffice rounds a page up by a
 * pixel), grown and cut to the page. Undefined when nothing of it is on the page.
 */
export function pagePx(r: Rect, rect: Rect, w: number, h: number): PxRect | undefined {
  const s = Math.min(w / rect.w, h / rect.h);
  if (!(s > 0)) return undefined;
  const x0 = Math.max(0, Math.trunc((r.x - rect.x) * s) - GROW_BEFORE);
  const y0 = Math.max(0, Math.trunc((r.y - rect.y) * s) - GROW_BEFORE);
  const x1 = Math.min(w, Math.trunc((r.x + r.w - rect.x) * s) + GROW_AFTER);
  const y1 = Math.min(h, Math.trunc((r.y + r.h - rect.y) * s) + GROW_AFTER);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

/**
 * Write `dest` (PNG): the page `native` with LibreOffice's pixels of each region (logical px of the slide
 * area `rect`) pasted over it, LibreOffice's page scaled to the native page's where their sizes differ.
 * False, with nothing written, when no region is on the page.
 */
export async function pasteLibreOffice(
  native: string,
  lo: string,
  regions: readonly Rect[],
  rect: Rect,
  dest: string,
): Promise<boolean> {
  const n = await pngSize(native);
  const l = await pngSize(lo);
  if (!n || !l) throw new Error('not a PNG');
  const pastes: { at: PxRect; from: PxRect }[] = [];
  for (const r of regions) {
    const at = pagePx(r, rect, n.w, n.h);
    if (!at) continue;
    // The same region in LibreOffice's px: the native page's px back to the slide area, then onto LibreOffice's.
    const k = Math.min(l.w / n.w, l.h / n.h);
    const fx = Math.min(l.w - 1, Math.max(0, Math.round(at.x * k)));
    const fy = Math.min(l.h - 1, Math.max(0, Math.round(at.y * k)));
    const from = {
      x: fx,
      y: fy,
      w: Math.max(1, Math.min(l.w - fx, Math.round(at.w * k))),
      h: Math.max(1, Math.min(l.h - fy, Math.round(at.h * k))),
    };
    pastes.push({ at, from });
  }
  if (!pastes.length) return false;
  // [c0] the native page; each paste is cut from LibreOffice's page, scaled, and laid over the last result.
  const lo1 = (i: number) => (pastes.length > 1 ? `[s${i}]` : '[1:v]');
  const chains = [
    ...(pastes.length > 1 ? [`[1:v]split=${pastes.length}${pastes.map((_, i) => `[s${i}]`).join('')}`] : []),
    '[0:v]format=rgb24[c0]',
    ...pastes.flatMap((p, i) => [
      `${lo1(i)}crop=${p.from.w}:${p.from.h}:${p.from.x}:${p.from.y},scale=${p.at.w}:${p.at.h}:flags=bicubic,format=rgb24[p${i}]`,
      `[c${i}][p${i}]overlay=${p.at.x}:${p.at.y}:format=rgb[c${i + 1}]`,
    ]),
  ];
  await run(
    'ffmpeg',
    [
      ...['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', native, '-i', lo],
      ...['-filter_complex', chains.join(';'), '-map', `[c${pastes.length}]`, '-frames:v', '1', dest],
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  return true;
}

/**
 * The pixel paste's score of one slide against LibreOffice's page `lo` (see the module comment): 1 for a hub
 * picture slide, `nativeSsim` when there is nothing to paste, else the SSIM of the pasted page (written to
 * `scratch`, which the caller deletes).
 */
export async function pasteSsim(
  s: HubBefore,
  page: { lo: string; native: string; nativeSsim: number; rect: Rect; scratch: string },
): Promise<number> {
  if (s.hub === 'picture') return 1;
  const regions = pasteRegions(s);
  if (!regions.length) return page.nativeSsim;
  if (!(await pasteLibreOffice(page.native, page.lo, regions, page.rect, page.scratch)))
    return page.nativeSsim;
  return ssim(page.lo, page.scratch);
}

/** A slide the hub does not show as the native column draws it: `--before hub` asks the hub for it. */
export function needsHub(s: HubBefore | undefined): boolean {
  return s?.hub !== 'native' || !!s.metafiles?.length || !!s.budget;
}

/** Past this much data, the hub is replaced by a fresh one before the next deck (disk is the limit). */
export const RECYCLE_BYTES = 400 * 1024 * 1024;
/** One deck's import and LibreOffice follow-up may take this long. */
const IMPORT_TIMEOUT_MS = 900_000;

/**
 * What the hub gave for one deck: a score per shown slide (0-based) it showed, the slides LibreOffice could
 * not draw there (`failed`: the hub showed them without their art, and that is what is scored), and notes.
 */
export type HubScores = { scores: Map<number, number>; failed: Set<number>; notes: string[] };

/**
 * `--before hub`'s hub: this checkout's, started on first use with LibreOffice on the PATH, its data under
 * `dir`, replaced by a fresh one when its data passes `RECYCLE_BYTES` or it fails, closed by `close`.
 */
export class BeforeHub {
  private session?: HubSession;
  private started = 0;
  private readonly o: { dir: string; entry?: string };

  constructor(o: { dir: string; entry?: string }) {
    this.o = o;
  }

  private async hub(): Promise<HubSession> {
    if (this.session && this.session.proc.exitCode === null) return this.session;
    await this.session?.close();
    this.session = await HubSession.start({
      dataDir: join(this.o.dir, `data-${++this.started}`),
      ...(this.o.entry ? { entry: this.o.entry } : {}),
    });
    return this.session;
  }

  /**
   * Import `deck` through the hub, wait for its LibreOffice follow-up, and draw the hub's latest version of
   * the shown slides `shown` (0-based) with `renderer` into `work` (deleted afterwards), each scored against
   * LibreOffice's page `lo[shown]`. A slide LibreOffice could not draw in the hub (`pptx.failed`: its
   * follow-up gave up, as the hub's bounded LibreOffice does on some decks) is scored as the hub shows it,
   * without its art, and listed in `failed`. A slide still pending is left out (a note says how many), as is
   * every slide when the import fails. Never throws.
   */
  async score(o: {
    deck: string;
    shown: ReadonlySet<number>;
    lo: readonly string[];
    rect: NativeDeck['slideRect'];
    renderer: NativeRenderer;
    work: string;
  }): Promise<HubScores> {
    const notes: string[] = [];
    const scores = new Map<number, number>();
    const failed = new Set<number>();
    try {
      const s = await this.hub();
      // A hub before M9 takes .pptx uploads only; the converter reads a slide show or template alike.
      const imp = await importDeck(s.client, o.deck, {
        uploadName: 'deck.pptx',
        timeoutMs: IMPORT_TIMEOUT_MS,
        followUp: true,
      });
      if (imp.job.state !== 'done' || !imp.presentationId) {
        notes.push(`the hub's import ${imp.job.state}: ${(imp.job.error ?? '').slice(0, 200)}`);
        return { scores, failed, notes };
      }
      if (imp.followUp && imp.followUp.state !== 'done')
        notes.push(
          `the hub's LibreOffice follow-up ${imp.followUp.state}: ${(imp.followUp.error ?? '').slice(0, 200)}`,
        );
      const h = await hubSlides(s.client, imp.presentationId, o.work);
      notes.push(...h.notes.slice(0, 5));
      let left = 0;
      const slides: NativeSlide[] = [];
      for (const [index, slide] of h.slides.entries()) {
        const shown = slide.hidden ? undefined : slide.pptx?.shown;
        if (shown === undefined || !o.shown.has(shown)) continue;
        if (slide.pptx?.pending) {
          left++;
          continue;
        }
        if (slide.pptx?.failed) failed.add(shown);
        slides.push({
          index,
          shown,
          hidden: false,
          tier: 'T1',
          class: slide.pptx?.class ?? 'native',
          reasons: [],
          convertMs: 0,
          notes: [],
          slide,
          textFeatures: [],
          xmlFeatures: [],
          compat: [],
        });
      }
      if (left) notes.push(`${left} slide(s) still pending in the hub: the paste stands in`);
      if (failed.size)
        notes.push(
          `LibreOffice could not draw ${failed.size} slide(s) in the hub: scored as the hub shows them`,
        );
      if (!slides.length) return { scores, failed, notes };
      const deck: NativeDeck = {
        slides,
        slideRect: o.rect,
        media: h.media,
        geoms: h.geoms as NativeDeck['geoms'],
        notes: [],
        embeddedFonts: false,
        textFeatures: [],
        extractMs: 0,
        parseMs: 0,
        emitMs: 0,
      };
      const drawn = await o.renderer.renderDeck(deck, o.work, { repeats: 0 });
      notes.push(...drawn.notes.slice(0, 5).map((n) => `hub version: ${n}`));
      for (const r of drawn.slides) {
        const lo = o.lo[r.shown];
        if (r.png && lo) scores.set(r.shown, await ssim(lo, join(o.work, r.png)));
      }
      if ((await s.dataBytes()) > RECYCLE_BYTES) {
        await s.close();
        this.session = undefined;
      }
    } catch (e) {
      notes.push(`the hub gave no score: ${(e as Error).message.slice(0, 300)}`);
      await this.session?.close().catch(() => undefined);
      this.session = undefined;
    } finally {
      await rm(o.work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    return { scores, failed, notes };
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
    await rm(this.o.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
