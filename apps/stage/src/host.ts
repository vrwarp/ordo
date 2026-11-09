/**
 * The stage window's main thread (design/16, design/25): a host that renders, it does not compute.
 * It owns the DOM side only: the view model store React reads, `document.fonts`, rAF frame statistics,
 * long tasks, the opener handle and its fallback-bus relay, and the supervisor of the link worker.
 */
import {
  acceptPorts,
  appEnv,
  broadcastEndpoint,
  clock,
  isControl,
  operatorOrigin,
  requestPort,
  Supervisor,
  windowEndpoint,
} from '@ordo/client';
import { DEFAULT_GENERAL } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import { FrameStats, stageLayout } from './model.ts';
import type { FontPayload, HostStats, LinkToMain, MainToLink, StageView } from './protocol.ts';
import { buildView } from './view.ts';

/** Reloads requested by the worker within this window count towards the limit below. */
const RELOAD_WINDOW_MS = 60_000;
const RELOAD_MAX = 3;
const RELOAD_KEY = 'ordo-stage-reloads';
/** Main-thread watchdog tick period. */
const TICK_MS = 250;

export function initialView(): StageView {
  return buildView({
    state: initialState(),
    ready: false,
    shown: null,
    layout: stageLayout(undefined),
    general: { timeZone: DEFAULT_GENERAL.timeZone, clock24h: DEFAULT_GENERAL.clock24h },
    bus: 'none',
    now: Date.now(),
    clockOffset: 0,
    clockFallback: false,
  });
}

type Snapshot = { view: StageView; fontsVersion: number; linkDown: boolean };

export class StageHost {
  readonly outputId: string;
  readonly token: string;
  readonly testMode: boolean;
  private snap: Snapshot = { view: initialView(), fontsVersion: 0, linkDown: false };
  private listeners = new Set<() => void>();
  private sup: Supervisor;
  private worker?: Worker;
  private bridgeCleanup?: () => void;
  private frames = new FrameStats();
  private longTasks = 0;
  private loadedFonts = new Set<string>();
  private fontErrors: string[] = [];
  private lastDiag: Record<string, unknown> = {};
  private operatorOrigin: string;
  private closed = false;
  private openerWasClosed = false;
  private stopAccept?: () => void;

  constructor() {
    const env = appEnv();
    this.outputId = env.outputId ?? 'unknown';
    this.token = env.token ?? '';
    this.testMode = new URLSearchParams(location.search).get('test') === '1';
    this.operatorOrigin = operatorOrigin(env);
    this.sup = new Supervisor();
    this.sup.on('restart', ({ name, generation, reason }) => {
      console.warn(`[ordo stage] ${name} worker restarted (generation ${generation}): ${reason}`);
    });
    this.sup.on('gaveUp', ({ name, reason }) => {
      console.error(`[ordo stage] ${name} worker keeps failing: ${reason}`);
      this.update({ linkDown: true });
      // Crash-only: a link that cannot stay up gets a fresh page (rate-limited).
      this.reload(`${name} worker gave up: ${reason}`);
    });
  }

  // ---- React store ----

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  private update(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---- lifecycle ----

  start(): void {
    this.sup.add<Worker>({
      name: 'link',
      create: () =>
        new Worker(new URL('./link.worker.ts', import.meta.url), { type: 'module', name: 'stage-link' }),
      start: (w, generation) => this.startWorker(w, generation),
      stop: () => {
        this.bridgeCleanup?.();
        this.bridgeCleanup = undefined;
        this.worker = undefined;
      },
    });
    if (window.opener) {
      // Fallback-bus ports from the operator go straight into the link worker (newest wins).
      this.stopAccept = acceptPorts(this.operatorOrigin, (port) => {
        if (this.worker) this.post({ t: 'busPort', port }, [port]);
        else port.close();
      });
    }
    setInterval(() => this.sendStats(), 1000);
    setInterval(() => this.checkOpener(), 1000);
    // Main-thread watchdog tick (as in the output): the link worker measures the gaps between ticks and
    // reports the longest since its last health as mainThreadStallMs.
    setInterval(() => this.post({ t: 'tick' }), TICK_MS);
    this.startFrames();
    this.observeLongTasks();
  }

  private startWorker(w: Worker, generation: number): void {
    this.worker = w;
    w.addEventListener('message', (ev) => {
      if (this.worker !== w) return;
      const d = (ev as MessageEvent).data;
      if (isControl(d)) return;
      this.onWorker(d as LinkToMain);
    });
    let bridge: MessagePort | undefined;
    if (window.opener) {
      // Relay window.postMessage from the opener to the worker (operators that do not hand over ports,
      // and the gap until a restarted worker gets a fresh port).
      const ch = new MessageChannel();
      const win = windowEndpoint(() => window.opener as Window | null, this.operatorOrigin);
      const unsub = win.onMessage((m) => ch.port1.postMessage(m));
      ch.port1.onmessage = (ev) => win.post(ev.data);
      this.bridgeCleanup = () => {
        unsub();
        win.close();
        ch.port1.close();
      };
      bridge = ch.port2;
    } else if (typeof BroadcastChannel !== 'undefined' && !appEnv().domain) {
      const ch = new MessageChannel();
      const bcast = broadcastEndpoint(`ordo-bus-${this.outputId}`);
      const unsub = bcast.onMessage((m) => ch.port1.postMessage(m));
      ch.port1.onmessage = (ev) => bcast.post(ev.data);
      this.bridgeCleanup = () => {
        unsub();
        bcast.close();
        ch.port1.close();
      };
      bridge = ch.port2;
    }
    const reloadReason = this.takeReloadReason();
    const init: MainToLink = {
      t: 'init',
      outputId: this.outputId,
      token: this.token,
      testMode: this.testMode,
      generation,
      bridge,
      reloadReason,
      loadedFonts: [...this.loadedFonts],
    };
    w.postMessage(init, bridge ? [bridge] : []);
    if (window.opener && generation > 0) requestPort(this.operatorOrigin, this.outputId);
    if (this.openerWasClosed) this.post({ t: 'opener', closed: true });
  }

  private post(m: MainToLink, transfer: Transferable[] = []): void {
    try {
      this.worker?.postMessage(m, transfer);
    } catch {
      /* the worker is being replaced */
    }
  }

  private onWorker(m: LinkToMain): void {
    switch (m.t) {
      case 'view': {
        // The host's own hub time (message fades) follows the worker's clock estimate.
        clock.offset = m.view.clockOffset;
        clock.fallback = m.view.clockFallback;
        this.update({ view: m.view, linkDown: false });
        if (m.view.title) document.title = `ordo — ${m.view.title}`;
        return;
      }
      case 'font':
        void this.addFont(m.font);
        return;
      case 'diag':
        this.lastDiag = m.diag;
        return;
      case 'reload':
        this.reload(m.reason);
        return;
      case 'close':
        this.close(m.reason);
        return;
    }
  }

  // ---- fonts ----

  private async addFont(f: FontPayload): Promise<void> {
    if (this.loadedFonts.has(f.hash)) {
      this.post({ t: 'fontAck', hash: f.hash, ok: true });
      return;
    }
    try {
      const face = new FontFace(f.family, f.data, { weight: String(f.weight), style: f.style });
      await face.load();
      document.fonts.add(face);
      this.loadedFonts.add(f.hash);
      this.post({ t: 'fontAck', hash: f.hash, ok: true });
      this.update({ fontsVersion: this.snap.fontsVersion + 1 });
    } catch (e) {
      const error = `font ${f.family}: ${(e as Error).message}`;
      this.fontErrors.push(error);
      this.post({ t: 'fontAck', hash: f.hash, ok: false, error });
    }
  }

  // ---- watchdog inputs ----

  private sendStats(): void {
    const stats: HostStats = {
      presented: this.frames.presented,
      missed: this.frames.missed,
      fps: this.frames.fps,
      longTasks: this.longTasks,
      workers: this.sup.stats().map((s) => ({
        name: s.name,
        generation: s.generation,
        restarts: s.restarts,
        lastReason: s.lastReason,
        gaveUp: s.gaveUp,
      })),
      fontErrors: this.fontErrors.splice(0),
    };
    this.post({ t: 'host', stats });
  }

  /** The worker cannot see window.opener: check it here and forward changes. */
  private checkOpener(): void {
    if (!this.stopAccept) return;
    let closed: boolean;
    try {
      closed = !window.opener || (window.opener as Window).closed;
    } catch {
      closed = true;
    }
    if (closed !== this.openerWasClosed) {
      this.openerWasClosed = closed;
      this.post({ t: 'opener', closed });
    }
  }

  private startFrames(): void {
    const tick = (t: number) => {
      this.frames.frame(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private observeLongTasks(): void {
    try {
      const po = new PerformanceObserver((list) => {
        this.longTasks += list.getEntries().length;
      });
      po.observe({ type: 'longtask', buffered: true });
    } catch {
      // not supported
    }
  }

  // ---- crash-only restart ----

  private takeReloadReason(): string | undefined {
    try {
      const raw = sessionStorage.getItem(`${RELOAD_KEY}:reason`);
      sessionStorage.removeItem(`${RELOAD_KEY}:reason`);
      return raw ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reload the page (it paints the last state from IndexedDB before it has a connection). At most three
   * reloads a minute: past that the page stays and the restart budget shows red in health.
   */
  reload(reason: string): void {
    if (this.closed) return;
    let recent: number[] = [];
    try {
      recent = (JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? '[]') as number[]).filter(
        (t) => Date.now() - t < RELOAD_WINDOW_MS,
      );
    } catch {
      recent = [];
    }
    if (recent.length >= RELOAD_MAX) {
      console.error(
        `[ordo stage] not reloading again (${reason}): ${recent.length} reloads in the last minute`,
      );
      return;
    }
    try {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify([...recent, Date.now()]));
      sessionStorage.setItem(`${RELOAD_KEY}:reason`, reason.slice(0, 200));
    } catch {
      /* storage unavailable: reload anyway */
    }
    console.warn(`[ordo stage] reloading: ${reason}`);
    setTimeout(() => location.reload(), 100);
  }

  private close(reason: string): void {
    this.closed = true;
    this.sup.dispose();
    this.stopAccept?.();
    console.warn(`[ordo stage] ${reason}: closing`);
    this.update({ linkDown: true });
    try {
      window.close();
    } catch {
      /* not script-closable */
    }
  }

  // ---- diagnostics and test hooks ----

  telemetry(): Record<string, unknown> {
    return {
      ...this.lastDiag,
      presented: this.frames.presented,
      missed: this.frames.missed,
      fps: this.frames.fps,
      fontsVersion: this.snap.fontsVersion,
      workers: this.sup.stats(),
    };
  }

  view(): StageView {
    return this.snap.view;
  }

  /** `?test=1` only: chaos hooks for the end-to-end suite. */
  chaos() {
    return {
      /** Kill a worker without telling the supervisor (as a crash would); heartbeats stop, it restarts. */
      killWorker: (name: 'link') => {
        if (name !== 'link') return false;
        const w = this.sup.worker<Worker>('link');
        w?.terminate();
        return !!w;
      },
      /** Feed a message to the link worker as if the hub had sent it. */
      inject: (k: 'delta' | 'state', msg: unknown) => this.post({ t: 'chaos', k, msg }),
      /** Make the link worker receive a shape-valid state that violates the live-state invariants. */
      badState: () => this.post({ t: 'chaos', k: 'badState' }),
    };
  }
}
