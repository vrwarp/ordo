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
 *
 * **A hub without LibreOffice** (`--ask-hub-nolo`, sub-wave 1c): the same `BeforeHub` with `libreoffice: false`
 * starts this checkout's hub with a PATH of the lite tools only (`hub-import.ts` `toolsOnlyPath`: no soffice) and
 * `ORDO_LIBREOFFICE=off`, waits for no follow-up, and scores the slides asked as that hub stores and draws them:
 * `perSlide.noLoHubSsim`, `noLoHubFrom: 'hub'` (or why there is none: `noLoHubFields`). A table slide is scored
 * in its stored form on a REAL hub of each kind this way; the harness's own `noLoSsim` measures table cells with
 * this computer's fontconfig faces where a real hub uses its library's, so it is reported beside, never instead.
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  findOnPath,
  HubSession,
  hubEntry,
  hubSlides,
  importDeck,
  OFFICE_COMMANDS,
  toolsOnlyPath,
} from './hub-import.ts';
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
   * A hub with LibreOffice keeps LibreOffice's page for it (`keepsPage`: its slide budget fitted it by leaving
   * something out; `ImportCore.pageForBudget`), so the hub is asked whatever its class.
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

/**
 * Whether a hub with LibreOffice keeps LibreOffice's page for a slide (`ImportCore.pageForBudget`), from the
 * census's model of its budgets (`hubClasses`): the slide fitted by leaving something out ('plain',
 * 'minimal'). Never for its tables: the owner decided (2026-11-15) that every table is the table object on
 * every hub, and the interim rule that kept the page of a slide whose tables as their M6 group passed 64 KB
 * is gone. The hub itself decides (its page form within 64 KB, the presentation's room): this only says which
 * slides to ask it for.
 */
export function keepsPage(h: { hub: string; hubWhy: string | null; level: string }): boolean {
  if (h.hub === 'picture') return false;
  return h.hubWhy === 'slide' && (h.level === 'plain' || h.level === 'minimal');
}

/** A slide the hub does not show as the native column draws it: `--before hub` asks the hub for it. */
export function needsHub(s: HubBefore | undefined): boolean {
  return s?.hub !== 'native' || !!s.metafiles?.length || !!s.budget;
}

/** A shown slide as `hubBeforeOf` reads it: what the converter emitted of it (`NativeSlide`). */
export type AskedSlide = Pick<NativeSlide, 'art' | 'metafiles' | 'table'>;
/** The census's model of a slide on a hub with LibreOffice (`census.ts` `hubClasses`). */
export type HubModel = { hub: HubBefore['hub']; hubWhy: string | null; level: string };

/**
 * What a hub with LibreOffice shows of a shown slide (`HubBefore`), from its emission `s` and the census's
 * model of it `h`; undefined for a shown slide the converter did not emit (a LibreOffice picture there). A
 * slide holding a table object never keeps LibreOffice's page for its size (`ImportCore.pageForBudget`).
 */
export function hubBeforeOf(s: AskedSlide | undefined, h: HubModel | undefined): HubBefore | undefined {
  if (!s || !h) return undefined;
  const budget = !s.table && keepsPage(h);
  return {
    hub: h.hub,
    ...(s.art ? { art: s.art } : {}),
    ...(s.metafiles ? { metafiles: s.metafiles } : {}),
    ...(budget ? { budget } : {}),
  };
}

/**
 * The shown slides (0-based) `--before hub` asks the hub for: each with a LibreOffice page (`lo[i]`), within
 * `only` when given, that the hub does not show as the native column draws it (`needsHub` of `before(i)`), and
 * each that `extra` names (`--ask-hub`: a slide the hub stores as the native column draws it, asked to measure
 * that on a real hub).
 */
export function askedSet(o: {
  n: number;
  lo: readonly (string | undefined)[];
  before: (i: number) => HubBefore | undefined;
  only?: ReadonlySet<number>;
  extra?: ReadonlySet<number>;
}): Set<number> {
  const asked = new Set<number>();
  for (let i = 0; i < o.n; i++) {
    if (!o.lo[i] || (o.only && !o.only.has(i))) continue;
    if (o.extra?.has(i) || needsHub(o.before(i))) asked.add(i);
  }
  return asked;
}

/** Reasons a slide may hold a PowerPoint table (`--ask-hub-nolo all-tables`; the readout's table slides). */
export const TABLE_REASONS: ReadonlySet<string> = new Set(['table', 'deco:table', 'art:table']);

/** A shown slide holds a PowerPoint table: a table object (`NativeSlide.table`) or a table reason. */
export function isTableSlide(s: Pick<NativeSlide, 'table' | 'reasons'> | undefined): boolean {
  return !!s && (!!s.table || s.reasons.some((r) => TABLE_REASONS.has(r)));
}

/**
 * The shown slides (0-based) `--ask-hub-nolo` asks a hub without LibreOffice for: each with a LibreOffice page
 * (`lo[i]`), within `only` when given, that `extra` names or, with `allTables`, that holds a table (`isTable`).
 */
export function noLoAskedSet(o: {
  n: number;
  lo: readonly (string | undefined)[];
  isTable: (i: number) => boolean;
  allTables?: boolean;
  only?: ReadonlySet<number>;
  extra?: ReadonlySet<number>;
}): Set<number> {
  const asked = new Set<number>();
  for (let i = 0; i < o.n; i++) {
    if (!o.lo[i] || (o.only && !o.only.has(i))) continue;
    if (o.extra?.has(i) || (o.allTables && o.isTable(i))) asked.add(i);
  }
  return asked;
}

/** The fields `--ask-hub-nolo` writes for one shown slide `i` (see the module comment): none when not asked. */
export function noLoHubFields(
  i: number,
  asked: ReadonlySet<number>,
  got: HubScores,
): { noLoHubSsim?: number; noLoHubFrom?: string } {
  if (!asked.has(i)) return {};
  const v = got.scores.get(i);
  if (v !== undefined) return { noLoHubSsim: v, noLoHubFrom: 'hub' };
  return { noLoHubFrom: got.why?.get(i) ?? 'no score' };
}

/**
 * How a `BeforeHub` session is started: with LibreOffice, this process's PATH and the hub's own default
 * (nothing set); without it, a PATH of the lite tools only (found on `from`) and `ORDO_LIBREOFFICE=off`.
 * Throws when a LibreOffice command would still be on that PATH.
 */
export async function hubSessionOptions(o: {
  dir: string;
  libreoffice: boolean;
  from?: string;
}): Promise<{ path?: string; env?: Record<string, string> }> {
  if (o.libreoffice) return {};
  const { path } = await toolsOnlyPath(join(o.dir, 'path'), undefined, o.from);
  for (const c of OFFICE_COMMANDS)
    if (await findOnPath(c, path)) throw new Error(`${c} is on the PATH of the hub without LibreOffice`);
  return { path, env: { ORDO_LIBREOFFICE: 'off' } };
}

/** Past this much data, the hub is replaced by a fresh one before the next deck (disk is the limit). */
export const RECYCLE_BYTES = 400 * 1024 * 1024;
/** One deck's import and LibreOffice follow-up may take this long. */
const IMPORT_TIMEOUT_MS = 900_000;

/**
 * What the hub gave for one deck: a score per shown slide (0-based) it showed, the slides LibreOffice could
 * not draw there (`failed`: the hub showed them without their art, and that is what is scored), notes, and
 * why an asked slide has no score (`why`: 'import failed', 'pending', 'not drawn', 'no hub').
 */
export type HubScores = {
  scores: Map<number, number>;
  failed: Set<number>;
  notes: string[];
  why?: Map<number, string>;
};

/** What a `BeforeHub` asked (the run's summary records it): its kind, its hub entry, LibreOffice's state there. */
export type HubInfo = {
  libreoffice: boolean;
  entry: 'source' | 'dist';
  file: string;
  /** `GET /capabilities`' `libreoffice.state` of the last session started ('available', 'off', ...). */
  state?: string;
  sessions: number;
};

/**
 * `--before hub`'s hub: this checkout's, started on first use with LibreOffice on the PATH, its data under
 * `dir`, replaced by a fresh one when its data passes `RECYCLE_BYTES` or it fails, closed by `close`. With
 * `libreoffice: false` (`--ask-hub-nolo`), a hub without LibreOffice (`hubSessionOptions`), no follow-up.
 * `entry` is the hub module (`hubEntry`: the sources unless the bundle is asked for).
 */
export class BeforeHub {
  private session?: HubSession;
  private started = 0;
  private state?: string;
  private readonly o: { dir: string; entry?: string; libreoffice?: boolean };

  constructor(o: { dir: string; entry?: string; libreoffice?: boolean }) {
    this.o = o;
  }

  private get libreoffice(): boolean {
    return this.o.libreoffice !== false;
  }

  /** What this hub is (`HubInfo`), for the run's summary. */
  info(): HubInfo {
    const file = this.o.entry ?? hubEntry(undefined);
    return {
      libreoffice: this.libreoffice,
      entry: file.endsWith('.js') ? 'dist' : 'source',
      file: file.replace(/^.*?(apps\/hub\/)/, '$1'),
      ...(this.state ? { state: this.state } : {}),
      sessions: this.started,
    };
  }

  private async hub(): Promise<HubSession> {
    if (this.session && this.session.proc.exitCode === null) return this.session;
    await this.session?.close();
    const how = await hubSessionOptions({ dir: this.o.dir, libreoffice: this.libreoffice });
    this.session = await HubSession.start({
      dataDir: join(this.o.dir, `data-${++this.started}`),
      ...(this.o.entry ? { entry: this.o.entry } : {}),
      ...how,
    });
    const caps = await this.session.client
      .maybe<{ libreoffice?: { state?: unknown } }>('capabilities')
      .catch(() => undefined);
    this.state = typeof caps?.libreoffice?.state === 'string' ? caps.libreoffice.state : 'unknown';
    if (!this.libreoffice && this.state !== 'off' && this.state !== 'absent')
      throw new Error(`the hub without LibreOffice says LibreOffice is ${this.state}`);
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
    const why = new Map<number, string>();
    const unscored = (reason: string) => {
      for (const i of o.shown) if (!scores.has(i) && !why.has(i)) why.set(i, reason);
    };
    let reason = 'no hub';
    try {
      const s = await this.hub();
      reason = 'import failed';
      // A hub before M9 takes .pptx uploads only; the converter reads a slide show or template alike.
      const imp = await importDeck(s.client, o.deck, {
        uploadName: 'deck.pptx',
        timeoutMs: IMPORT_TIMEOUT_MS,
        followUp: this.libreoffice,
      });
      if (imp.job.state !== 'done' || !imp.presentationId) {
        notes.push(`the hub's import ${imp.job.state}: ${(imp.job.error ?? '').slice(0, 200)}`);
        unscored(reason);
        return { scores, failed, notes, why };
      }
      reason = 'not drawn';
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
          why.set(shown, 'pending');
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
      if (!slides.length) {
        unscored('not shown by the hub');
        return { scores, failed, notes, why };
      }
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
    unscored(reason);
    return { scores, failed, notes, why };
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
    await rm(this.o.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
