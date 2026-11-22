/**
 * The keys of pre-rendered slides, computed by the hub when a presentation is saved (design/29 §1.3 "Keys computed
 * at save"). The hub is the authority: a writer's key is never trusted. `keysFor` runs in the routes BEFORE the save,
 * in the CPU pool (`prerender-keys`, slidetasks.ts), and the save writes the rows in its transaction with the saved
 * revision, so a save never returns before its rows exist and the editor's bake never races it. A slide whose row
 * can be copied (the same `sig` as the previous revision's) costs no pool call; a library with no pre-rendered
 * slide pays one pass over the saved slides.
 *
 * `sig` is the digest of what produced a row: the stand-in (without the notes, timing and cues that never draw),
 * the file each drawn picture decodes and the faces of the slide's font chain (the families its head names, the
 * default face and the script fallbacks). Rows are additive per revision: a font or media change adds the new key
 * beside the old one, so a bake that started before the change still lands. The jobs (a font or picture change, a
 * writer that saved without keys, a library that starts with slides lacking rows) are paced one slide at a time
 * and never run while a service is live.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_FONT,
  drawnMediaIds,
  type Presentation,
  SCRIPT_FALLBACK_FONTS,
  type Slide,
  slideMediaIds,
  stillFile,
} from '@ordo/domain';
import { slideUses } from '@ordo/domain/prerender.ts';
import type { Logger } from 'pino';
import type { Change, Library, PrerenderKeyRow } from './library.ts';
import type { CpuPool } from './pool.ts';
import type { HeadRow } from './slidefiles.ts';
import type { PrerenderKeysTaskInput, SlideUses } from './slidetasks.ts';
import type { Store } from './store.ts';

/** A library that starts with pre-rendered slides lacking rows fills them this long after the start. */
export const KEYS_START_DELAY_MS = 120_000;
/** Changes of one burst (a Google font's subsets, an import's media) share one recompute. */
const DEBOUNCE_MS = 300;
/** The pause between two slides of a job: it never holds the library's loop. */
const JOB_PAUSE_MS = 5;
/**
 * The most bytes of slide pages one pool task is given (store-2 step 3b, the Q54 data-safety items): a slide file may be
 * 16 MiB, and a pool worker's heap is 512 MB (pool.ts), so the changed slides of a save are sent in batches of at most
 * this many bytes of pages, a slide alone when it is bigger than the batch.
 */
export const KEYS_PAGES_BYTES_MAX = 32 * 1024 * 1024;

export type KeysOptions = {
  live: () => 'idle' | 'live';
  log: Logger;
  startDelayMs?: number;
  /**
   * false while the hub's switch is off (ORDO_PRERENDER=off, `HubConfig.prerender.store`): `keysFor` returns no row
   * without looking at the presentation, and the jobs (a font or media change, the start-up scan, `fill`) queue and
   * do nothing. Rows already stored stay; the start-up scan of the next start that is not off fills what a save made
   * meanwhile left without rows. Absent: always open.
   */
  open?: () => boolean;
  /** The bytes of pages one pool task may be given (tests lower it; default `KEYS_PAGES_BYTES_MAX`). */
  pagesBytesMax?: number;
};

type Pool = Pick<CpuPool, 'run'>;
type Work = { slide: Slide; head?: HeadRow; media: Record<string, string | null>; sig: string };

const lower = (s: string) => s.trim().toLowerCase();
const FALLBACK_FAMILIES: ReadonlySet<string> = new Set(
  [DEFAULT_FONT, ...Object.values(SCRIPT_FALLBACK_FONTS).flat()].map(lower),
);
/** Fields of a stand-in that never change a pixel of the picture: left out of `sig`. */
const UNDRAWN = ['notes', 'durationMs', 'midiCues', 'midi'] as const;

export class PrerenderKeys {
  private lib: Library;
  private store: Store;
  private pool: () => Pool;
  private opts: KeysOptions;
  private faceCache?: { family: string; hash: string }[];
  private queue = new Set<string>();
  private running = false;
  private stopped = false;
  private timers = new Set<NodeJS.Timeout>();
  private pending = new Set<string>();
  private debounce?: NodeJS.Timeout;
  private idleWaiters: (() => void)[] = [];

  constructor(lib: Library, store: Store, pool: () => Pool, opts: KeysOptions) {
    this.lib = lib;
    this.store = store;
    this.pool = pool;
    this.opts = opts;
  }

  // ── at save ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The rows of the presentation about to be saved: its key and stand-by id per pre-rendered slide. Never throws:
   * a slide whose key cannot be computed now is left to the safety net.
   */
  async keysFor(p: Presentation): Promise<PrerenderKeyRow[]> {
    if (!this.isOpen()) return [];
    const out: PrerenderKeyRow[] = [];
    const todo: Work[] = [];
    let prev: Map<string, ReturnType<Library['prerenderIndex']['keysAt']>> | undefined;
    // The library cannot change between the slides of this loop (nothing in it awaits), so a picture that many slides
    // show is read once: heavy slides share their pictures, and each read is a statement and a parsed row.
    const files = new Map<string, string | null>();
    for (const sec of p.sections ?? [])
      for (const slide of sec.slides) {
        if (!slide.prerender) continue;
        const w = this.plan(slide, files);
        if (!w) continue;
        prev ??= this.previousRows(p.id);
        const hit = prev.get(slide.id)?.find((r) => r.sig === w.sig);
        if (hit) out.push({ slideId: slide.id, key: hit.key, standbyId: hit.standbyId, sig: w.sig });
        else todo.push(w);
      }
    if (todo.length) {
      try {
        out.push(...(await this.compute(todo)));
      } catch (e) {
        this.opts.log.warn(
          { err: (e as Error).message },
          'the keys of a save could not be computed: left to the safety net',
        );
      }
    }
    return out;
  }

  private isOpen(): boolean {
    return this.opts.open?.() ?? true;
  }

  private previousRows(id: string) {
    const idx = this.lib.prerenderIndex;
    const rev = idx.latestKeyRev(id);
    const by = new Map<string, ReturnType<typeof idx.keysAt>>();
    if (rev === undefined) return by;
    for (const r of idx.keysAt(id, rev)) {
      const list = by.get(r.slideId) ?? [];
      list.push(r);
      by.set(r.slideId, list);
    }
    return by;
  }

  /** What one slide's key is made of: its head, the files of its pictures, its font chain, and the sig. */
  private plan(slide: Slide, files?: Map<string, string | null>): Work | undefined {
    const pre = slide.prerender;
    if (!pre) return undefined;
    let head: HeadRow | undefined;
    let uses: SlideUses;
    if (pre.file) {
      head = this.lib.slideFiles.head(pre.file.ref);
      if (!head) return undefined;
      uses = head.uses;
    } else uses = slideUses(slide);
    const ids = new Set<string>([...uses.media, ...drawnMediaIds(slide), ...slideMediaIds(slide)]);
    const media: Record<string, string | null> = {};
    for (const id of [...ids].sort()) {
      let hash = files?.get(id);
      if (hash === undefined) {
        const m = this.lib.media.get(id);
        hash = (m && stillFile(m)?.hash) || null;
        files?.set(id, hash);
      }
      media[id] = hash;
    }
    const chain = new Set([...uses.fonts.map(lower), ...FALLBACK_FAMILIES]);
    const faces = this.faces()
      .filter((f) => chain.has(lower(f.family)))
      .map((f) => [lower(f.family), f.hash])
      .sort((a, b) => (a[0]! + a[1]!).localeCompare(b[0]! + b[1]!));
    const stable: Record<string, unknown> = { ...slide };
    for (const k of UNDRAWN) delete stable[k];
    stable.prerender = {
      why: pre.why,
      live: pre.live,
      ...(pre.file ? { file: pre.file.ref } : {}),
    };
    // The sig only tells whether this slide's inputs are the ones a row was computed from: the text of what the
    // save carries, in the order the library keeps it, hashed natively (a stand-in is up to hundreds of KB and
    // every save looks at each one). Equal text is the same inputs; the same inputs in another key order only
    // cost a recompute by the pool, which works the key from canonical bytes, never a wrong key.
    const sig = createHash('sha256')
      .update(JSON.stringify({ slide: stable, media, faces }))
      .digest('hex');
    return { slide, head, media, sig };
  }

  private faces(): { family: string; hash: string }[] {
    this.faceCache ??= this.lib.listFonts().map((f) => ({ family: f.family, hash: f.file.hash }));
    return this.faceCache;
  }

  /** The pool's keys for `works`, as rows: the pages of file-form slides go in batches of `pagesBytesMax`. */
  private async compute(works: Work[]): Promise<PrerenderKeyRow[]> {
    const max = this.opts.pagesBytesMax ?? KEYS_PAGES_BYTES_MAX;
    const rows: PrerenderKeyRow[] = [];
    let batch: PrerenderKeysTaskInput['slides'] = [];
    let batchWorks: Work[] = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      rows.push(...(await this.runKeys(batch, batchWorks)));
      batch = [];
      batchWorks = [];
      bytes = 0;
    };
    for (const w of works) {
      if (!w.head) {
        batch.push({ slideId: w.slide.id, standIn: w.slide, media: w.media });
        batchWorks.push(w);
        continue;
      }
      const headFile = this.lib.getFile(w.slide.prerender!.file!.ref);
      const files = w.head.pages.map((h) => this.lib.getFile(h));
      if (!headFile || files.some((f) => !f)) continue;
      // The size the files are known to have: the pages are read only for a slide that is next in its batch.
      const size = headFile.bytes + files.reduce((n, f) => n + f!.bytes, 0);
      if (batch.length && bytes + size > max) await flush();
      const [head, ...pages] = await Promise.all([
        readFile(this.store.abs(headFile.path)),
        ...files.map((f) => readFile(this.store.abs(f!.path))),
      ]);
      batch.push({
        slideId: w.slide.id,
        standIn: w.slide,
        head: new Uint8Array(head!.buffer, head!.byteOffset, head!.byteLength),
        pages: pages.map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)),
        media: w.media,
      });
      batchWorks.push(w);
      bytes += size;
    }
    await flush();
    return rows;
  }

  private async runKeys(slides: PrerenderKeysTaskInput['slides'], works: Work[]): Promise<PrerenderKeyRow[]> {
    const out = await this.pool().run('prerender-keys', {
      slides,
      fonts: this.faces(),
    });
    const sigs = new Map(works.map((w) => [w.slide.id, w.sig]));
    const rows: PrerenderKeyRow[] = [];
    for (const k of out.keys) {
      if ('error' in k) {
        this.opts.log.warn(
          { slide: k.slideId, err: k.error },
          'the key of a pre-rendered slide could not be computed',
        );
        continue;
      }
      rows.push({ slideId: k.slideId, key: k.key, standbyId: k.standbyId, sig: sigs.get(k.slideId)! });
    }
    return rows;
  }

  // ── the jobs ────────────────────────────────────────────────────────────────────────────────────────────

  /** Hooks the library's changes and arms the start-up fill. */
  start(): void {
    this.lib.onChange((changes) => this.onChanges(changes));
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.scanAll();
    }, this.opts.startDelayMs ?? KEYS_START_DELAY_MS);
    t.unref();
    this.timers.add(t);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.debounce) clearTimeout(this.debounce);
    this.settle();
  }

  /** The service started or ended: a held job resumes at End service. */
  onLiveMode(mode: 'idle' | 'live'): void {
    if (mode === 'idle') this.kick();
  }

  /** Resolves when no job is queued, waiting for its debounce or running (tests, and a clean stop). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
  private isIdle(): boolean {
    return !this.running && !this.queue.size && !this.debounce && !this.pending.size;
  }
  private settle(): void {
    if (!this.isIdle() && !this.stopped) return;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private onChanges(changes: Change[]): void {
    if (this.stopped || !this.isOpen()) return;
    const ids = new Set<string>();
    let all = false;
    for (const c of changes) {
      if (c.kind === 'font') {
        this.faceCache = undefined;
        all = true;
      } else if (c.kind === 'media') all = true;
      else if (
        c.kind === 'presentation' &&
        !c.deleted &&
        c.entity &&
        this.lacksRows(c.entity as Presentation)
      )
        ids.add(c.id);
    }
    if (all) for (const id of this.lib.prerenderIndex.presentationsWithKeys()) ids.add(id);
    if (ids.size) this.later(ids);
  }

  /** Whether a saved revision has a pre-rendered slide with no row (a writer that saved without keys). */
  private lacksRows(p: Presentation): boolean {
    let have: Set<string> | undefined;
    for (const sec of p.sections ?? [])
      for (const s of sec.slides)
        if (s.prerender && (!s.prerender.file || this.lib.slideFiles.have([s.prerender.file.ref]).size)) {
          have ??= this.lib.prerenderIndex.slidesWithKeys(p.id, p.rev);
          if (!have.has(s.id)) return true;
        }
    return false;
  }

  private scanAll(): void {
    if (!this.isOpen()) return;
    const ids = this.lib.prerenderIndex.presentationsMentioningPrerender();
    if (ids.length) this.later(new Set(ids));
  }

  private later(ids: Set<string>): void {
    if (!this.isOpen()) return;
    for (const id of ids) this.pending.add(id);
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      for (const id of this.pending) this.queue.add(id);
      this.pending.clear();
      this.kick();
    }, DEBOUNCE_MS);
    this.debounce.unref();
  }

  private kick(): void {
    if (this.running || this.stopped || !this.queue.size || this.opts.live() === 'live') {
      this.settle();
      return;
    }
    this.running = true;
    setImmediate(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.size && !this.stopped) {
        if (this.opts.live() === 'live') break;
        const id = this.queue.values().next().value as string;
        this.queue.delete(id);
        await this.fill(id);
      }
    } catch (e) {
      this.opts.log.warn({ err: (e as Error).message }, 'the pre-render keys job failed');
    } finally {
      this.running = false;
      this.settle();
    }
  }

  /** The current revision's missing rows, one slide at a time: a row that exists (same sig) is left alone. */
  private async fill(id: string): Promise<void> {
    if (!this.isOpen()) return;
    const p = this.lib.presentations.get(id);
    if (!p) return;
    const idx = this.lib.prerenderIndex;
    for (const sec of p.sections ?? [])
      for (const slide of sec.slides) {
        if (this.stopped || !slide.prerender) continue;
        const w = this.plan(slide);
        if (!w) continue;
        if (idx.keysAt(id, p.rev).some((r) => r.slideId === slide.id && r.sig === w.sig)) continue;
        const rows = await this.compute([w]);
        if (rows.length) idx.addKeys(id, p.rev, rows);
        await new Promise((r) => setTimeout(r, JOB_PAUSE_MS));
        if (this.opts.live() === 'live') {
          this.queue.add(id);
          return;
        }
      }
  }
}
