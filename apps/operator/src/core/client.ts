import {
  type BusEndpoint,
  appEnv,
  broadcastEndpoint,
  clock,
  type ClientMessageBody,
  Emitter,
  ErrorBudget,
  isPortRequest,
  offerPort,
  type RtcSignalIn,
  Supervisor,
  windowEndpoint,
} from '@ordo/client';
import { newId } from '@ordo/domain';
import type { Action, DeckRenderer, KeyFace } from '@ordo/surfaces';
import { MAIN_BUDGETS } from '../lib/budgets.ts';
import type {
  CallName,
  CoreToMain,
  LibOp,
  MainToCore,
  SearchFilter,
  SearchHit,
  Source,
  ViewModelMsg,
} from './protocol.ts';

/** Unacknowledged actions older than this are dropped instead of re-sent after a core restart. */
export const OUTBOX_TTL_MS = 60_000;
const OUTBOX_MAX = 200;
export const TICK_MS = 250;
/** Re-offer a port this long after opening (the first offer may reach about:blank and be dropped). */
const OFFER_RETRY_MS = [1500, 4000, 8000];

type Outgoing = { msg: Extract<MainToCore, { aid: string }>; at: number };

type KnownWindow = {
  win: Window;
  origin: string;
  /** Main-thread side of the legacy relay (window.postMessage ⇄ worker port). */
  relay?: { ep: BusEndpoint; port: MessagePort; unsub: () => void };
  retries: ReturnType<typeof setTimeout>[];
  offers: number;
};

export type CoreClientEvents = {
  vm: ViewModelMsg;
  lib: Extract<CoreToMain, { t: 'lib' }>;
  log: { level: 'info' | 'warn' | 'error'; text: string };
  toast: { text: string; kind: 'info' | 'warn' | 'error' | 'ok'; ms?: number };
  ui: Extract<CoreToMain, { t: 'ui' }>['e'];
  welcome: { appVersion: string };
  bye: { reason: string };
  /** The hub refused the operator's credentials (expired session): sign in again, then `hubResume()`. */
  auth: { reason: 'unauthorized' | 'forbidden' };
  rtc: RtcSignalIn;
  /** The core worker (re)started and restored its state: generation, and whether it is a restart. */
  ready: { generation: number; restart: boolean };
  /** The supervisor restarted (or gave up on) a worker. */
  supervisor: { name: string; reason: string; gaveUp: boolean };
};

export type WorkerFactory = () => Worker;

/**
 * Main-thread host of the operator's core worker (design/25). It owns only what must stay on the main
 * thread: the supervisor, window handles and the MessagePort handoff, and an outbox that keeps every
 * action until the core acknowledges it, so a core that dies between a keypress and its hub send loses
 * nothing: the restarted core gets the action again (same id; the hub de-duplicates).
 */
export class CoreClient extends Emitter<CoreClientEvents> {
  readonly sup: Supervisor;
  readonly budgets = new ErrorBudget(MAIN_BUDGETS);
  generation = -1;
  /** True between a core (re)start and its `ready`. */
  recovering = true;
  private w?: Worker;
  private outbox = new Map<string, Outgoing>();
  private windows = new Map<string, KnownWindow>();
  private tick?: ReturnType<typeof setInterval>;
  private reqId = 1;
  private searches = new Map<number, (hits: SearchHit[]) => void>();
  private deckReqs = new Map<number, (px: Uint8ClampedArray | null) => void>();
  private portRequests?: (ev: MessageEvent) => void;
  private onPageHide?: () => void;

  constructor(
    readonly role: 'operate' | 'edit',
    readonly appVersion: string,
    private factory: WorkerFactory,
    private opts: { test?: boolean; supervisor?: Supervisor } = {},
  ) {
    super();
    this.sup = opts.supervisor ?? new Supervisor();
    this.sup.on('restart', ({ name, reason }) => {
      if (name !== 'core') return;
      this.budgets.record('workerRestart', reason);
      this.emit('supervisor', { name, reason, gaveUp: false });
    });
    this.sup.on('gaveUp', ({ name, reason }) => {
      if (name === 'core') this.recovering = false;
      this.emit('supervisor', { name, reason, gaveUp: true });
    });
    this.sup.add<Worker>({
      name: 'core',
      create: () => this.factory(),
      start: (w, gen) => this.startWorker(w, gen),
      stop: () => {
        this.w = undefined;
        this.recovering = true;
      },
      deadAfterMs: 1500,
      budget: { max: 5, windowMs: 60_000 },
    });
    // The main-thread watchdog tick: the core measures the gaps (mainThreadStallMs).
    const tick = () =>
      this.post({ t: 'tick', at: Date.now(), hidden: typeof document !== 'undefined' && document.hidden });
    this.tick = setInterval(tick, TICK_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', tick);
    if (typeof window !== 'undefined') {
      // A role window whose link worker restarted asks its opener for a fresh bus port.
      this.portRequests = (ev: MessageEvent) => {
        if (!isPortRequest(ev.data)) return;
        const k = this.windows.get(ev.data.outputId);
        if (!k || ev.source !== k.win || ev.origin !== k.origin) return;
        this.offer(ev.data.outputId);
      };
      window.addEventListener('message', this.portRequests);
      // The operator page is going away: release the windows at once (as a closed opener would), rather
      // than leaving them to notice the silence on their ports (design/17: outputs leave the bus).
      this.onPageHide = () => {
        for (const k of this.windows.values()) k.relay?.ep.post({ t: 'fallback.hub', v: 1, hubUp: true });
      };
      window.addEventListener('pagehide', this.onPageHide);
    }
  }

  dispose(): void {
    clearInterval(this.tick);
    if (this.portRequests) window.removeEventListener('message', this.portRequests);
    if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
    for (const id of [...this.windows.keys()]) this.detachWindow(id);
    this.sup.dispose();
  }

  get alive(): boolean {
    return !!this.w && !this.recovering;
  }

  // ---------------------------------------------------------------- worker lifecycle

  private startWorker(w: Worker, gen: number): void {
    this.w = w;
    this.generation = gen;
    this.recovering = true;
    w.addEventListener('message', (ev: MessageEvent) => {
      if (this.sup.worker('core') !== w) return;
      this.onMessage(ev.data as CoreToMain);
    });
    this.post({
      t: 'init',
      role: this.role,
      appVersion: this.appVersion,
      generation: gen,
      test: !!this.opts.test,
    });
    // A new core has no ports: hand it a fresh port (and relay) for every known window.
    for (const id of this.windows.keys()) this.connectWindow(id, true);
    // Re-send what the previous core never acknowledged (it de-duplicates by id).
    const now = Date.now();
    for (const [aid, o] of this.outbox) {
      if (now - o.at > OUTBOX_TTL_MS) this.outbox.delete(aid);
      else this.post(o.msg);
    }
  }

  private onMessage(m: CoreToMain): void {
    if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
    switch (m.t) {
      case 'ready': {
        const restart = this.recovering && m.generation > 0;
        this.recovering = false;
        this.emit('ready', { generation: m.generation, restart });
        return;
      }
      case 'vm':
        if (m.live) {
          clock.offset = m.live.clock.offset;
          clock.rtt = m.live.clock.rtt;
          clock.fallback = m.live.clock.fallback;
        }
        this.emit('vm', m);
        return;
      case 'lib':
        this.emit('lib', m);
        return;
      case 'ack':
        this.outbox.delete(m.aid);
        return;
      case 'log':
        this.emit('log', { level: m.level, text: m.text });
        return;
      case 'toast':
        this.emit('toast', { text: m.text, kind: m.kind, ms: m.ms });
        return;
      case 'ui':
        this.emit('ui', m.e);
        return;
      case 'hub':
        if (m.e === 'welcome') this.emit('welcome', { appVersion: m.appVersion });
        else if (m.e === 'auth') this.emit('auth', { reason: m.reason });
        else this.emit('bye', { reason: m.reason });
        return;
      case 'rtc':
        this.emit('rtc', m.m);
        return;
      case 'search.res':
        this.searches.get(m.reqId)?.(m.hits);
        this.searches.delete(m.reqId);
        return;
      case 'deck.res':
        this.deckReqs.get(m.reqId)?.(m.px);
        this.deckReqs.delete(m.reqId);
        return;
      case 'bus.need':
        this.offer(m.outputId);
        return;
    }
  }

  private post(m: MainToCore, transfer: Transferable[] = []): boolean {
    const w = this.w;
    if (!w) return false;
    try {
      w.postMessage(m, transfer);
      return true;
    } catch {
      return false;
    }
  }

  /** Post a message that must survive a core restart (kept until the core acknowledges it). */
  private postReliable(msg: Extract<MainToCore, { aid: string }>): void {
    this.outbox.set(msg.aid, { msg, at: Date.now() });
    if (this.outbox.size > OUTBOX_MAX) {
      const first = this.outbox.keys().next().value;
      if (first !== undefined) this.outbox.delete(first);
    }
    this.post(msg);
  }

  get unacknowledged(): number {
    return this.outbox.size;
  }

  // ---------------------------------------------------------------- actions

  /** Forward an action to the core (the keydown handler's only job). */
  action(action: Action, source: Source): void {
    this.postReliable({ t: 'action', aid: newId(), action, source });
  }

  call(name: CallName, ...args: unknown[]): void {
    this.postReliable({ t: 'call', aid: newId(), name, args });
  }

  hubSend(m: ClientMessageBody): boolean {
    return this.post({ t: 'hub.send', m });
  }

  hubKick(): void {
    this.post({ t: 'hub.kick' });
  }

  /** Reconnect to the hub now (after a new sign-in cleared a refused session). */
  hubResume(): void {
    this.post({ t: 'hub.resume' });
  }

  libOp(op: LibOp): void {
    this.post({ t: 'lib.op', op });
  }

  reloadLibrary(): void {
    this.post({ t: 'lib.reload' });
  }

  resetBudget(kind: string): void {
    if (kind in MAIN_BUDGETS) this.budgets.reset(kind);
    else this.post({ t: 'budget.reset', kind });
  }

  retryCache(): void {
    this.post({ t: 'cache.retry' });
  }

  chaos(c: Extract<MainToCore, { t: 'chaos' }>['c']): void {
    this.post({ t: 'chaos', c });
  }

  /** Search the core's index. Resolves with null when the core does not answer in time. */
  search(q: string, f: SearchFilter, timeoutMs = 1000): Promise<SearchHit[] | null> {
    const reqId = this.reqId++;
    return new Promise((resolve) => {
      if (!this.post({ t: 'search', reqId, q, f })) {
        resolve(null);
        return;
      }
      const t = setTimeout(() => {
        this.searches.delete(reqId);
        resolve(null);
      }, timeoutMs);
      this.searches.set(reqId, (hits) => {
        clearTimeout(t);
        resolve(hits);
      });
    });
  }

  /** Stream Deck key images rendered in the core worker (null: draw locally). */
  readonly deckRenderer: DeckRenderer = {
    key: (face: KeyFace, w: number, h: number) => this.deckRequest({ t: 'deck.key', reqId: 0, face, w, h }),
    strip: (title: string, sub: string, w: number, h: number) =>
      this.deckRequest({ t: 'deck.strip', reqId: 0, title, sub, w, h }),
  };

  private deckRequest(
    m: Extract<MainToCore, { t: 'deck.key' | 'deck.strip' }>,
  ): Promise<Uint8ClampedArray | null> {
    if (!this.alive) return Promise.resolve(null);
    const reqId = this.reqId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.deckReqs.delete(reqId);
        resolve(null);
      }, 500);
      this.deckReqs.set(reqId, (px) => {
        clearTimeout(t);
        resolve(px);
      });
      if (!this.post({ ...m, reqId })) {
        clearTimeout(t);
        this.deckReqs.delete(reqId);
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------- windows and the port handoff

  /**
   * An output or stage window was opened or re-acquired: hand the core a MessagePort to it (and the
   * legacy relay as a fallback), and offer again shortly in case the first offer reached about:blank.
   */
  attachWindow(outputId: string, win: Window, origin: string): void {
    this.detachWindow(outputId);
    const k: KnownWindow = { win, origin, retries: [], offers: 0 };
    this.windows.set(outputId, k);
    this.connectWindow(outputId, true);
    k.retries = OFFER_RETRY_MS.map((ms) =>
      setTimeout(() => {
        if (this.windows.get(outputId) === k) this.offer(outputId);
      }, ms),
    );
  }

  /**
   * Listen for an output over BroadcastChannel without a window handle (e.g. opened as a tab, or
   * before the window is launched on this origin).
   */
  attachBroadcast(outputId: string, origin: string): void {
    if (this.windows.has(outputId)) return;
    const dummyWin = { closed: false } as unknown as Window;
    const k: KnownWindow = { win: dummyWin, origin, retries: [], offers: 0 };
    this.windows.set(outputId, k);
    this.makeRelay(outputId, k);
  }

  detachWindow(outputId: string): void {
    const k = this.windows.get(outputId);
    if (!k) return;
    for (const t of k.retries) clearTimeout(t);
    this.dropRelay(k);
    this.windows.delete(outputId);
    this.post({ t: 'bus.drop', outputId });
  }

  /** Ports offered to each known window since it was attached (diagnostics and tests). */
  offerCounts(): Record<string, number> {
    return Object.fromEntries([...this.windows].map(([id, k]) => [id, k.offers]));
  }

  hasWindow(outputId: string): boolean {
    return this.windows.has(outputId);
  }

  /** Offer a fresh port to one window and hand it to the core. False when the window is gone. */
  offer(outputId: string): boolean {
    const k = this.windows.get(outputId);
    if (!k) return false;
    if (k.win.closed) {
      this.detachWindow(outputId);
      return false;
    }
    try {
      const port = offerPort(k.win, k.origin, outputId);
      k.offers++;
      if (!this.post({ t: 'bus.port', outputId, port }, [port])) port.close();
      return true;
    } catch {
      return false; // the relay keeps the bus working
    }
  }

  private connectWindow(outputId: string, withRelay: boolean): void {
    const k = this.windows.get(outputId);
    if (!k) return;
    this.offer(outputId);
    if (withRelay) this.makeRelay(outputId, k);
  }

  /**
   * Legacy path: bridge window.postMessage to a worker port, for a window that does not take (or has not
   * yet received) a port. The core prefers the direct port as soon as the window speaks on it.
   */
  private makeRelay(outputId: string, k: KnownWindow): void {
    this.dropRelay(k);
    let winEp: BusEndpoint | undefined;
    try {
      winEp = windowEndpoint(k.win, k.origin);
    } catch {
      /* ignore */
    }
    let bcastEp: BusEndpoint | undefined;
    if (typeof BroadcastChannel !== 'undefined' && !appEnv().domain) {
      try {
        bcastEp = broadcastEndpoint(`ordo-bus-${outputId}`);
      } catch {
        /* ignore */
      }
    }
    if (!winEp && !bcastEp) return;
    const ch = new MessageChannel();
    const port = ch.port1;
    const unsubWin = winEp?.onMessage((m) => {
      try {
        port.postMessage(m);
      } catch {
        /* closed */
      }
    });
    const unsubBcast = bcastEp?.onMessage((m) => {
      try {
        port.postMessage(m);
      } catch {
        /* closed */
      }
    });
    port.onmessage = (ev) => {
      winEp?.post(ev.data);
      bcastEp?.post(ev.data);
    };
    port.start();
    const ep: BusEndpoint = {
      kind: 'window',
      post(m) {
        winEp?.post(m);
        bcastEp?.post(m);
      },
      onMessage(fn) {
        const u1 = winEp?.onMessage(fn);
        const u2 = bcastEp?.onMessage(fn);
        return () => {
          u1?.();
          u2?.();
        };
      },
      alive: () => (winEp?.alive() ?? false) || (bcastEp?.alive() ?? false),
      close() {
        unsubWin?.();
        unsubBcast?.();
        winEp?.close();
        bcastEp?.close();
      },
    };
    k.relay = {
      ep,
      port,
      unsub: () => {
        unsubWin?.();
        unsubBcast?.();
      },
    };
    if (!this.post({ t: 'bus.relay', outputId, port: ch.port2 }, [ch.port2])) this.dropRelay(k);
  }

  private dropRelay(k: KnownWindow): void {
    if (!k.relay) return;
    k.relay.unsub();
    k.relay.ep.close();
    k.relay.port.onmessage = null;
    k.relay.port.close();
    k.relay = undefined;
  }

  // ---------------------------------------------------------------- test hooks

  /** Terminate a worker without telling the supervisor (simulates a crash; heartbeats stop). */
  killWorker(name: string): boolean {
    const w = this.sup.worker(name);
    if (!w) return false;
    w.terminate();
    return true;
  }
}
