import {
  CacheApiStore,
  type FileStore,
  fillCache,
  JsonStore,
  MemoryStore,
  requestPersistence,
} from '@ordo/cache';
import { api, clock, fileUrl, hubNow, OutputLink } from '@ordo/client';
import {
  DEFAULT_GENERAL,
  type Font,
  type GeneralSettings,
  type LiveState,
  type Look,
  type ManifestFile,
  type SlideContent,
} from '@ordo/domain';
import { type OutputConfigRes, type OutputHealth, ROUTES } from '@ordo/protocol';
import {
  FrameStats,
  flipDelay,
  resolveStageLook,
  type StageLayout,
  stageFontFamilies,
  stageLayout,
} from './model.ts';

export const APP_VERSION = '0.1.0';

export type StageSnapshot = {
  state: LiveState;
  ready: boolean;
  look: Look;
  layout: StageLayout;
  general: Pick<GeneralSettings, 'timeZone' | 'clock24h' | 'venueName'>;
  /** Slide content currently displayed (flipped at its `at`). */
  shown: SlideContent | null;
  bus: 'hub' | 'fallback' | 'none';
  /** Bumped when web fonts finish loading so text fitting re-runs. */
  fontsVersion: number;
  outputName?: string;
};

/**
 * Owns the live link, config, fonts, flip timing and health for the stage window. React reads
 * `snapshot` through `subscribe`.
 */
export class StageController {
  readonly link: OutputLink;
  private config?: OutputConfigRes;
  private json = new JsonStore('ordo-stage');
  private store: FileStore;
  private listeners = new Set<() => void>();
  private shown: SlideContent | null = null;
  private shownSeq = -1;
  private flipTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAt = 0;
  private lateFlips = 0;
  private longTasks = 0;
  private frames = new FrameStats();
  private cache = { ready: 0, total: 0 };
  private loadedFonts = new Set<string>();
  private fontsSig = '';
  private fontsVersion = 0;
  private lastError?: string;
  snapshot: StageSnapshot;

  constructor() {
    this.link = new OutputLink({ role: 'stage', appVersion: APP_VERSION });
    this.store = typeof caches !== 'undefined' ? new CacheApiStore('ordo-files') : new MemoryStore();
    this.snapshot = this.build();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): StageSnapshot => this.snapshot;

  private changed() {
    this.snapshot = this.build();
    for (const fn of this.listeners) fn();
  }

  private look(): Look {
    const s = this.link.state;
    return resolveStageLook(this.config?.output.lookId, this.config?.looks, s.resolved?.looks);
  }

  private build(): StageSnapshot {
    const look = this.look();
    const g = this.config?.general ?? DEFAULT_GENERAL;
    return {
      state: this.link.state,
      ready: this.link.mirror.ready,
      look,
      layout: stageLayout(look),
      general: { timeZone: g.timeZone, clock24h: g.clock24h, venueName: g.venueName },
      shown: this.shown,
      bus: this.link.bus,
      fontsVersion: this.fontsVersion,
      outputName: this.config?.output.name,
    };
  }

  async start(): Promise<void> {
    const cached = await this.json
      .get<OutputConfigRes>(`config:${this.link.outputId}`)
      .catch(() => undefined);
    if (cached && !this.config) this.applyConfig(cached);
    this.link.mirror.on('change', () => this.onState());
    this.link.on('bus', ({ bus }) => {
      if (bus === 'hub') void this.loadConfig();
      this.changed();
    });
    this.link.on('library', (m) => {
      if (m.changes.some((c) => c.kind === 'settings' || c.kind === 'font')) void this.loadConfig();
    });
    this.link.hub.on('welcome', () => void this.loadConfig());
    this.link.start();
    void this.loadConfig();
    void requestPersistence();
    this.observeLongTasks();
    this.startFrames();
    setInterval(() => this.sendHealth(), 1000);
  }

  private async loadConfig(): Promise<void> {
    try {
      const cfg = await api<OutputConfigRes>(ROUTES.outputConfig);
      this.applyConfig(cfg);
      void this.json.set(`config:${this.link.outputId}`, cfg).catch(() => undefined);
      this.lastError = undefined;
    } catch (e) {
      this.lastError = `config: ${(e as Error).message}`;
    }
  }

  private applyConfig(cfg: OutputConfigRes) {
    this.config = cfg;
    document.title = `ordo — ${cfg.output.name}`;
    this.ensureFonts();
    this.changed();
  }

  /** Apply a new live state: schedule the slide flip at the layer's `at`. */
  private onState() {
    const s = this.link.state;
    const layer = s.layers.slide;
    if (layer.seq !== this.shownSeq || (layer.content === null) !== (this.shown === null)) {
      this.shownSeq = layer.seq;
      const content = layer.content;
      const delay = flipDelay(layer.at, hubNow());
      if (this.flipTimer) clearTimeout(this.flipTimer);
      this.flipTimer = null;
      if (delay <= 0) {
        this.shown = content;
      } else {
        this.pendingAt = layer.at;
        this.flipTimer = setTimeout(() => {
          this.flipTimer = null;
          if (hubNow() - this.pendingAt > 50) this.lateFlips++;
          this.shown = content;
          this.changed();
        }, delay);
      }
    }
    this.ensureFonts();
    this.changed();
  }

  private fontsFor(): Font[] {
    const families = stageFontFamilies(stageLayout(this.look()));
    const all = [...(this.config?.fonts ?? []), ...(this.link.state.resolved?.fonts ?? [])];
    const byHash = new Map<string, Font>();
    for (const f of all) if (families.has(f.family)) byHash.set(f.file.hash, f);
    return [...byHash.values()];
  }

  private ensureFonts() {
    const fonts = this.fontsFor();
    const sig = fonts
      .map((f) => f.file.hash)
      .sort()
      .join(',');
    if (sig === this.fontsSig) return;
    this.fontsSig = sig;
    void this.loadFonts(fonts);
  }

  private async fetchFile(hash: string): Promise<Blob> {
    const fb = this.link.fallback;
    if (this.link.bus === 'fallback' && fb) {
      const b = await fb.requestFile(hash);
      if (b) return b;
    }
    try {
      const res = await fetch(fileUrl(hash));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (err) {
      if (fb?.available) {
        const b = await fb.requestFile(hash);
        if (b) return b;
      }
      throw err;
    }
  }

  private async loadFonts(fonts: Font[]) {
    const files: ManifestFile[] = fonts.map((f) => ({
      hash: f.file.hash,
      bytes: f.file.bytes,
      mime: f.file.mime,
    }));
    this.cache = { ready: 0, total: files.length };
    const p = await fillCache(
      this.store,
      files,
      (h) => this.fetchFile(h),
      (pr) => {
        this.cache = { ready: pr.ready, total: pr.total };
      },
      { concurrency: 3, retries: 2 },
    ).catch(() => null);
    let added = 0;
    for (const f of fonts) {
      if (this.loadedFonts.has(f.file.hash)) continue;
      try {
        const blob = await this.store.get(f.file.hash);
        if (!blob) continue;
        const face = new FontFace(f.family, await blob.arrayBuffer(), {
          weight: String(f.weight),
          style: f.style,
        });
        await face.load();
        document.fonts.add(face);
        this.loadedFonts.add(f.file.hash);
        added++;
      } catch (e) {
        this.lastError = `font ${f.family}: ${(e as Error).message}`;
      }
    }
    if (p?.failed.length) {
      // Retry later (hub back, or the operator can serve them over the fallback bus).
      setTimeout(() => {
        this.fontsSig = '';
        this.ensureFonts();
      }, 10_000);
    }
    if (added > 0) {
      this.fontsVersion++;
      this.changed();
    }
  }

  private startFrames() {
    const tick = (t: number) => {
      this.frames.frame(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private observeLongTasks() {
    try {
      const po = new PerformanceObserver((list) => {
        this.longTasks += list.getEntries().length;
      });
      po.observe({ type: 'longtask', buffered: true });
    } catch {
      // not supported
    }
  }

  private sendHealth() {
    const s = this.link.state;
    const h: OutputHealth = {
      presented: this.frames.presented,
      missed: this.frames.missed,
      longTasks: this.longTasks,
      lateFlips: this.lateFlips,
      live: s.live,
      cache: this.cache,
      gpuLost: 0,
      videoDropped: 0,
      fps: this.frames.fps,
      appVersion: APP_VERSION,
    };
    if (this.lastError) h.error = this.lastError;
    this.link.sendHealth(h);
  }

  /** For diagnostics in the console: `ordoStage.debug()`. */
  debug(): Record<string, unknown> {
    return {
      outputId: this.link.outputId,
      bus: this.link.bus,
      seq: this.link.state.seq,
      shown: this.shown,
      clockOffset: clock.offset,
      fonts: [...this.loadedFonts],
      cache: this.cache,
      frames: { presented: this.frames.presented, missed: this.frames.missed, fps: this.frames.fps },
    };
  }
}
