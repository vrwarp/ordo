import { CacheApiStore, fillCache, type JsonStore } from '@ordo/cache';
import {
  ErrorBudget,
  FallbackHost,
  DEMO,
  fileUrl,
  HubConnection,
  portEndpoint,
  api,
  type ClientMessageBody,
} from '@ordo/client';
import {
  formatBytes,
  type LiveCommand,
  type LiveEvent,
  type LiveState,
  localDigest,
  type ManifestFile,
  newId,
  type ResolvedPlaylist,
  resolvePlaylist,
  type TimerSpec,
} from '@ordo/domain';
import { actionToEvent, checkInvariants, isLiveEventShape, isLiveStateShape } from '@ordo/live-state';
import { type LibrarySnapshot, type OutputHealthEntry, ROUTES, type Settings } from '@ordo/protocol';
import { type Action, renderKeyPixels, renderStripPixels } from '@ordo/surfaces';
import { CORE_BUDGETS } from '../lib/budgets.ts';
import { DoublePressGuard } from '../lib/confirm.ts';
import { SharedDownloads } from '../lib/downloads.ts';
import type { LibraryData } from '../lib/libraryData.ts';
import { type Authority, LiveCore, type LiveNotice, type PendingCommand } from '../lib/liveCore.ts';
import { SearchIndex } from '../lib/search.ts';
import { DualEndpoint } from './dualEndpoint.ts';
import { diffLibrary, LibraryStore } from './libraryStore.ts';
import type {
  CallName,
  CoreStats,
  CoreToMain,
  LiveSlice,
  MainToCore,
  SearchHit,
  Source,
  ViewModelMsg,
  OfflineCheck,
  OfflineEntry,
} from './protocol.ts';

/** GO lead: two frames at 60 Hz. */
export const GO_LEAD_MS = 33;
/** Persisted core state (live state, authority, unconfirmed commands, processed action ids). */
export const CORE_KEY = 'core';
const LEGACY_LIVE_KEY = 'live';
const LIB_KEY = 'library';
/** A window whose bus has been silent this long is offered a fresh port. */
export const REOFFER_MS = 10_000;
/**
 * While the hub refuses the session and this core is the authority, a proven window that has said nothing
 * on the bus for this long has left it for the hub (a restarted hub whose state equalled the window's, so
 * the window followed it; design/17) and shows the hub's older state: it is re-introduced to the bus. A
 * window on the bus reports health every second.
 */
export const RECALL_MS = 3000;
const STALL_WINDOW_MS = 60_000;
const PROCESSED_MAX = 300;
/** A restarted core resumes the fallback authority at once only if it held it this recently. */
const RESUME_AUTHORITY_MS = 2 * 60_000;
/**
 * A service this PC started without the hub is resumed after a restart for at most a service day (the
 * output windows keep their hold as long); older, the hub is followed and nothing starts unasked.
 */
const RESUME_HELD_MS = 8 * 60 * 60 * 1000;

export type CoreSnapshot = {
  /** Hub mode: the confirmed hub state; fallback: the operator's own authoritative state. */
  state: LiveState;
  authority: Authority;
  pending: PendingCommand[];
  /** Ids of actions already applied and persisted (re-sent actions are acknowledged, not re-applied). */
  aids: string[];
  at: number;
  /** A service this PC started without the hub (resumed as the authority whatever its age). */
  held?: boolean;
  /** A held service the hub has an older copy of: its playlist (`LiveCore.staleOnHub`, design/27 §3.4). */
  staleOnHub?: string;
};

const OFFLINE_KEY = 'ordo.offline';

type Post = (m: CoreToMain, transfer?: Transferable[]) => void;

/**
 * The operator's core (design/25): everything that is not DOM. Runs in the core worker; the main thread
 * renders the view model it posts and forwards actions. Nothing here touches window or document.
 */
export class CoreEngine {
  role: 'operate' | 'edit' = 'operate';
  generation = 0;
  hub!: HubConnection;
  readonly fallback = new FallbackHost();
  readonly files = new CacheApiStore('ordo-files');
  core!: LiveCore;
  readonly lib: LibraryStore;
  readonly search = new SearchIndex();
  readonly budgets = new ErrorBudget(CORE_BUDGETS);
  private commands = new Map<string, LiveCommand>();
  private clearGuard = new DoublePressGuard(2000);
  private clearTimer?: ReturnType<typeof setTimeout>;
  private endpoints = new Map<string, DualEndpoint>();
  private health: Record<string, OutputHealthEntry> = {};
  private lastConnected = new Map<string, boolean>();
  private everConnected = false;
  private ownCache: LiveSlice['ownCache'] = { ready: 0, total: 0, failed: 0 };
  /** Playlists downloaded for offline use (persisted) and the download in progress. */
  private offline: Record<string, OfflineEntry> = {};
  private offlineAbort?: { playlistId: string; ac: AbortController };
  private offlinePosted = '';
  private fillingManifest?: string;
  private fillAbort?: AbortController;
  /** The own-cache downloads in flight, shared across fills (a manifest change does not restart them). */
  private readonly downloads = new SharedDownloads<Blob>();
  /** When each window was last re-introduced to the bus by the stale-hub recall (throttle). */
  private readonly recalled = new Map<string, number>();
  private processed: string[] = [];
  private processedSet = new Set<string>();
  private started = false;
  private persistQueued?: Promise<void>;
  private persistFailures = 0;
  private lastTick = Date.now();
  private stallMax = 0;
  private stallMaxAt = 0;
  private stallLogged = false;
  private mainHidden = false;
  private libReady = false;
  private lastChecked?: LiveState;
  private lastCheckedOk = true;
  private invariantFailures: number[] = [];
  /** Windows whose `fallback ready` was logged in hub mode (logged once each). */
  private readyLogged = new Set<string>();
  /** The last core snapshot that passed the invariants (the only kind ever persisted; review item 17). */
  private lastGood?: CoreSnapshot;
  private brokenLogged = false;
  /** The hub refused the credentials (expired session): not a hub loss (review item 5). */
  private hubRefused?: 'unauthorized' | 'forbidden';
  /** Ask the supervisor for a clean restart (set by the worker entry). */
  onFatal?: (reason: string) => void;
  private timers: ReturnType<typeof setInterval>[] = [];
  // view-model bookkeeping
  private vmQueued = false;
  private posted: {
    live?: string;
    resolved?: unknown;
    resolvedRev: number;
    cues?: unknown;
    cuesRev: number;
    health?: Record<string, OutputHealthEntry>;
    budgets?: string;
    stats?: string;
    lib?: LibraryData;
    libRev: number;
  } = { resolvedRev: 0, cuesRev: 0, libRev: -1 };

  private post: Post;
  private store: JsonStore;
  private now: () => number;
  constructor(post: Post, store: JsonStore, now: () => number = () => Date.now()) {
    this.post = post;
    this.store = store;
    this.now = now;
    this.lib = new LibraryStore({
      fetchSnapshot: () => api<LibrarySnapshot>(ROUTES.snapshot),
      fetchSettings: () => api<Settings>(ROUTES.settings),
      cacheGet: () => this.store.get<LibraryData>(LIB_KEY),
      cacheSet: (d) => this.store.set(LIB_KEY, d),
      onChange: () => this.scheduleVm(),
    });
    this.fallback.getFile = async (hash) => (await this.files.get(hash).catch(() => undefined)) ?? undefined;
    this.fallback.on('health', ({ outputId, health }) => {
      if (this.core?.authority !== 'fallback') return;
      const prev = this.health[outputId];
      this.health = {
        ...this.health,
        [outputId]: {
          ...health,
          outputId,
          connected: true,
          lastSeen: this.now(),
          name: prev?.name ?? this.lib.settings.outputs.find((o) => o.id === outputId)?.name,
        },
      };
      this.scheduleVm();
    });
    this.fallback.on('event', ({ event }) => this.core?.externalEvent(event));
    this.fallback.on('ready', ({ outputId, appliedSeq }) => {
      // In hub mode a window answers every port offer with `fallback.ready`: log the first per window and
      // every one while the operator is the authority, not each re-introduction (review item 16).
      if (!this.fallback.active && this.readyLogged.has(outputId)) return;
      this.readyLogged.add(outputId);
      this.log(
        'info',
        `fallback ready ${outputId} @${appliedSeq} via ${this.endpoints.get(outputId)?.active()}`,
      );
    });
  }

  // ------------------------------------------------------------------ lifecycle

  async init(m: Extract<MainToCore, { t: 'init' }>): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.role = m.role;
    this.generation = m.generation;
    this.hub = new HubConnection({ role: m.role, appVersion: m.appVersion });
    // The library copy loads alongside; the UI gets its first library post once it settled.
    void withTimeout(this.lib.loadCached(), 1500).finally(() => {
      this.libReady = true;
      this.scheduleVm();
    });
    let snap: CoreSnapshot | undefined;
    if (this.role === 'operate') snap = await this.loadSnapshot();
    for (const id of snap?.aids ?? []) this.remember(id);
    const seed = snap?.state.mode === 'live' ? snap.state : undefined;
    this.core = new LiveCore(
      {
        sendHub: (msg) => this.hub.send(msg as ClientMessageBody),
        fallback: this.fallback,
        setClockFallback: (on) => {
          this.hub.clock.fallback = on;
        },
        newId,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        onChange: () => this.onCoreChange(),
        onNotice: (n) => this.notice(n),
        resolveLocal: (playlistId) => this.resolveLocal(playlistId),
      },
      seed,
    );
    void withTimeout(this.store.get<Record<string, OfflineEntry>>(OFFLINE_KEY), 1500)
      .then((o) => {
        if (o && typeof o === 'object') {
          for (const [k, v] of Object.entries(o))
            if (v && typeof v === 'object' && v.state !== 'downloading') this.offline[k] = v;
          this.scheduleVm();
        }
      })
      .catch(() => undefined);
    if (DEMO) {
      this.core.activateFallback({ hold: true, quiet: true });
    } else if (seed && snap?.held && this.now() - snap.at < RESUME_HELD_MS) {
      // A service this PC started without the hub: the hub never had it, so take it back.
      this.log('warn', 'core restarted during a service started from this PC: resuming it');
      this.core.resumeHeld(snap.staleOnHub);
    } else if (seed && snap?.held) {
      this.log('warn', 'a service started from this PC was left running too long ago: following the hub');
    } else if (seed && snap?.authority === 'fallback' && this.now() - snap.at < RESUME_AUTHORITY_MS) {
      // We were the authority when the previous core died: take it back at once (no second grace).
      this.log('warn', 'core restarted while running the service from this PC: resuming as the authority');
      this.core.activateFallback();
    } else if (snap?.pending.length) {
      this.core.restorePending(snap.pending);
      this.log('info', `core restored ${snap.pending.length} unconfirmed command(s)`);
    }
    this.wireHub();
    this.hub.start();
    void this.lib.load();
    this.timers.push(
      setInterval(() => this.watch(), 250),
      setInterval(() => this.watchBus(), 2000),
    );
    this.scheduleVm();
    this.post({ t: 'ready', generation: this.generation });
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.fillAbort?.abort();
    this.downloads.abortAll();
    this.hub?.stop();
    this.core?.dispose();
    this.fallback.dispose();
  }

  private async loadSnapshot(): Promise<CoreSnapshot | undefined> {
    try {
      // Validated at entry (design/25): a corrupt record is ignored and the hub state is used instead.
      const s = await withTimeout(this.store.get<CoreSnapshot>(CORE_KEY), 1500);
      if (s && isLiveStateShape(s.state) && checkInvariants(s.state).length === 0)
        return {
          state: s.state,
          authority: s.authority === 'fallback' ? 'fallback' : 'hub',
          pending: Array.isArray(s.pending) ? s.pending.filter((p) => p && isLiveEventShape(p.event)) : [],
          aids: Array.isArray(s.aids) ? s.aids.filter((a) => typeof a === 'string') : [],
          at: Number(s.at) || 0,
          held: s.held === true && s.authority === 'fallback',
          ...(typeof s.staleOnHub === 'string' ? { staleOnHub: s.staleOnHub.slice(0, 200) } : {}),
        };
      if (s) this.log('warn', 'stored core state failed validation; starting from the hub');
      const legacy = await withTimeout(this.store.get<LiveState>(LEGACY_LIVE_KEY), 1000);
      if (isLiveStateShape(legacy)) return { state: legacy, authority: 'hub', pending: [], aids: [], at: 0 };
    } catch {
      /* IndexedDB unavailable: start from the hub */
    }
    return undefined;
  }

  private wireHub(): void {
    const h = this.hub;
    h.on('status', ({ connected }) => {
      this.log(connected ? 'info' : 'warn', connected ? 'hub connected' : 'hub disconnected');
      if (!connected && this.everConnected) this.recordBudget('socket', 'hub socket dropped');
      this.everConnected ||= connected;
      this.core.onStatus(connected);
      this.scheduleVm();
    });
    h.on('lost', ({ sincePongMs }) =>
      this.log(
        'warn',
        `hub liveness failed: no pong for ${Math.round(sincePongMs / 100) / 10} s; socket dropped`,
      ),
    );
    h.on('welcome', (w) => {
      if (this.hubRefused) {
        this.hubRefused = undefined;
        this.log('info', 'hub accepted the operator again');
      }
      this.core.setHubRefused(false);
      this.core.onWelcome();
      this.post({ t: 'hub', e: 'welcome', appVersion: w.appVersion });
      // Deltas may have been missed while away.
      void this.lib.load();
      // A service that went live while the hub was away still needs its files on this PC.
      this.afterChange();
    });
    h.on('state', (m) => this.core.onState(m.state));
    h.on('delta', (m) => this.core.onDelta(m));
    h.on('ack', (m) => {
      if (m.id === 'adopt') {
        this.log(
          m.rejected ? 'warn' : 'info',
          m.rejected ? `hub refused adoption: ${m.rejected}` : `hub adopted state @${m.seq}`,
        );
        return;
      }
      const cmd = this.commands.get(m.id);
      this.core.onAck(m, cmd);
      this.commands.delete(m.id);
    });
    h.on('library', (m) => this.lib.applyDelta(m));
    h.on('health', (m) => {
      if (this.core.authority === 'fallback') return;
      this.health = m.outputs;
      for (const [id, e] of Object.entries(m.outputs)) {
        const was = this.lastConnected.get(id) ?? false;
        this.lastConnected.set(id, e.connected);
        // A window that (re)connected may have reloaded and lost its port: offer a fresh one.
        if (e.connected && !was && this.endpoints.has(id)) this.needPort(id);
      }
      this.scheduleVm();
    });
    h.on('rtc', (m) => this.post({ t: 'rtc', m }));
    h.on('bye', (m) => {
      const auth = m.reason === 'unauthorized' || m.reason === 'forbidden';
      // A refused session is reported once, by the auth event below, not on every reconnect attempt.
      if (auth && this.hubRefused) return;
      this.log('warn', `hub said bye: ${m.reason}`);
      this.post({ t: 'hub', e: 'bye', reason: m.reason });
      if (m.reason !== 'version' && !auth) this.toast(`Hub closed the connection: ${m.reason}`, 'warn');
    });
    // The hub is up but refuses this operator's session: never the fallback authority for that; the host
    // routes to the sign-in view and posts `hub.resume` once signed in.
    h.on('auth', ({ reason }) => {
      this.hubRefused = reason;
      const authority = this.core.authority === 'fallback';
      this.log(
        'warn',
        `hub refused the operator's session (${reason}): sign in again; ${
          authority
            ? 'this PC keeps running the outputs until the hand-back after sign-in'
            : 'the outputs stay on the hub'
        }`,
      );
      this.core.setHubRefused(true);
      // Refused while the authority: a window that followed the restarted hub (its state equalled the
      // window's) would show the hub's older state from now on, since no hand-back can happen until the
      // sign-in. Re-introduce the bus to every window now, and keep recalling quiet ones (watchBus).
      if (authority) for (const id of this.endpoints.keys()) this.recall(id, this.now());
      this.post({ t: 'hub', e: 'auth', reason });
      this.scheduleVm();
    });
  }

  // ------------------------------------------------------------------ messages from the main thread

  handle(m: MainToCore): void {
    switch (m.t) {
      case 'init':
        void this.init(m);
        return;
      case 'action':
        this.onAction(m.aid, m.action, m.source);
        return;
      case 'call':
        this.onCall(m.aid, m.name, m.args);
        return;
      case 'hub.send':
        this.hub.send(m.m);
        return;
      case 'hub.kick':
        this.hub.kick();
        return;
      case 'hub.resume':
        // Signed in again: reconnect now. The grace applies again only if the hub is really gone.
        this.hubRefused = undefined;
        this.core?.setHubRefused(false);
        this.hub.resume();
        this.scheduleVm();
        return;
      case 'bus.port':
        this.onPort(m.outputId, m.port, 'port');
        return;
      case 'bus.relay':
        this.onPort(m.outputId, m.port, 'relay');
        return;
      case 'bus.drop':
        this.fallback.unregister(m.outputId);
        this.endpoints.delete(m.outputId);
        this.scheduleVm();
        return;
      case 'tick':
        this.lastTick = this.now();
        // A hidden page's timers are throttled by the browser: that is not a stall.
        this.mainHidden = !!m.hidden;
        return;
      case 'lib.op': {
        this.flushVm(); // post anything older first, so moving the baseline below loses nothing
        // The baseline moves only once the library was posted in full: before that, the first full post
        // carries the op (the main thread applied it already, so it is not lost there either), and moving
        // it early would make the cached copy, arriving later, look like a removal (review item 26).
        const posted = this.libReady && this.posted.libRev >= 0 && this.posted.lib !== undefined;
        this.lib.applyOp(m.op);
        if (posted) {
          // The main thread applied it already: move the baseline so it is not echoed back.
          this.posted.lib = this.lib.data;
          this.posted.libRev = this.lib.rev;
        }
        return;
      }
      case 'lib.reload':
        void this.lib.load();
        return;
      case 'search':
        this.post({ t: 'search.res', reqId: m.reqId, hits: this.runSearch(m.q, m.f) });
        return;
      case 'deck.key': {
        const px = safe(() => renderKeyPixels(m.face, m.w, m.h));
        this.post({ t: 'deck.res', reqId: m.reqId, px }, px ? [px.buffer] : []);
        return;
      }
      case 'deck.strip': {
        const px = safe(() => renderStripPixels(m.title, m.sub, m.w, m.h));
        this.post({ t: 'deck.res', reqId: m.reqId, px }, px ? [px.buffer] : []);
        return;
      }
      case 'budget.reset':
        this.budgets.reset(m.kind);
        this.scheduleVm();
        return;
      case 'cache.retry':
        this.retryCache();
        return;
      case 'chaos':
        this.chaos(m.c);
        return;
    }
  }

  private chaos(c: Extract<MainToCore, { t: 'chaos' }>['c']): void {
    if (c.k === 'dispatchLater') {
      setTimeout(() => {
        this.log('info', `chaos: worker-side dispatch ${c.action.id}`);
        this.dispatch(c.action, 'streamdeck', newId());
      }, c.delayMs);
    } else if (c.k === 'throw') {
      setTimeout(() => {
        throw new Error(`chaos: ${c.reason}`);
      }, 0);
    } else if (c.k === 'hang') {
      const end = Date.now() + c.ms;
      while (Date.now() < end) {
        /* spin: simulates a stuck core */
      }
    }
  }

  // ------------------------------------------------------------------ actions

  private onAction(aid: string, a: Action, source: Source): void {
    if (this.processedSet.has(aid)) {
      this.post({ t: 'ack', aid });
      return;
    }
    this.dispatch(a, source, aid);
    this.ackAfterPersist(aid);
  }

  private onCall(aid: string, name: CallName, args: unknown[]): void {
    if (this.processedSet.has(aid)) {
      this.post({ t: 'ack', aid });
      return;
    }
    try {
      this.call(name, args, aid);
    } catch (e) {
      this.log('error', `call ${name}: ${String(e)}`);
    }
    this.ackAfterPersist(aid);
  }

  private ackAfterPersist(aid: string): void {
    this.remember(aid);
    if (this.role !== 'operate') {
      this.post({ t: 'ack', aid });
      return;
    }
    void this.persist().finally(() => this.post({ t: 'ack', aid }));
  }

  /** The single dispatch every key, Stream Deck and MIDI press and UI button goes through. */
  dispatch(a: Action, source: Source, aid: string): void {
    if (this.role !== 'operate' || !this.core) return;
    if (source !== 'ui') this.log('info', `${source}: ${a.id}${a.arg !== undefined ? ` ${a.arg}` : ''}`);
    if (a.id === 'clearAll') {
      const now = this.now();
      if (!this.clearGuard.press(now)) {
        const until = this.clearGuard.pendingUntil(now);
        this.post({ t: 'ui', e: { k: 'clearAllUntil', until } });
        clearTimeout(this.clearTimer);
        this.clearTimer = setTimeout(() => this.post({ t: 'ui', e: { k: 'clearAllUntil' } }), 2050);
        return;
      }
      clearTimeout(this.clearTimer);
      this.post({ t: 'ui', e: { k: 'clearAllUntil' } });
    }
    const ev = actionToEvent(this.core.view, a, this.at(), {
      messagePresets: this.lib.settings.surfaces.messagePresets,
      newId,
    });
    if (ev && ev.k !== 'goLive') this.submit(ev, aid);
  }

  submit(cmd: LiveCommand, id?: string): string {
    const sid = this.core.submit(cmd, id);
    this.commands.set(sid, cmd);
    if (this.commands.size > 300) {
      const first = this.commands.keys().next().value;
      if (first !== undefined) this.commands.delete(first);
    }
    return sid;
  }

  /** Hub time for the next GO: now plus the GO lead time from Settings → General (default GO_LEAD_MS). */
  at(): number {
    const lead = this.lib.settings.general.defaultPreRollMs;
    return this.hub.clock.now() + (Number.isFinite(lead) && lead >= 0 ? lead : GO_LEAD_MS);
  }

  private call(name: CallName, args: unknown[], aid: string): void {
    if (this.role !== 'operate') return;
    const n = (i: number) => Number(args[i]);
    const hubNow = this.hub.clock.now();
    switch (name) {
      case 'go':
        this.submit({ k: 'go', cueIndex: n(0), at: this.at() }, aid);
        return;
      case 'select':
        this.submit({ k: 'select', cueIndex: n(0) }, aid);
        return;
      case 'goToSection':
        this.submit({ k: 'goToSection', sectionIndex: n(0), at: this.at() }, aid);
        return;
      case 'clear': {
        const layer = args[0] as Extract<LiveEvent, { k: 'clear' }>['layer'];
        if (layer === 'all') this.dispatch({ id: 'clearAll' }, 'ui', aid);
        else this.submit({ k: 'clear', layer, at: this.at() }, aid);
        return;
      }
      case 'goLive':
        this.submit({ k: 'goLive', playlistId: String(args[0]) }, aid);
        return;
      case 'endService':
        this.submit({ k: 'endService', at: this.at() }, aid);
        return;
      case 'sendMessage': {
        const t = String(args[0] ?? '').trim();
        if (!t) return;
        const ttl = Number(args[1]) || undefined;
        this.submit({ k: 'message.send', id: newId(), text: t.slice(0, 500), ttlMs: ttl, at: hubNow }, aid);
        return;
      }
      case 'dismissMessage':
        this.submit({ k: 'message.dismiss', id: String(args[0]) }, aid);
        return;
      case 'lowerThird':
        this.submit({ k: 'lowerThird', text: String(args[0] ?? ''), at: this.at() }, aid);
        return;
      case 'timerStart':
        this.submit(
          { k: 'timer.start', timerId: String(args[0]), spec: args[1] as TimerSpec | undefined, at: hubNow },
          aid,
        );
        return;
      case 'timerStop':
        this.submit({ k: 'timer.stop', timerId: String(args[0]), at: hubNow }, aid);
        return;
      case 'timerReset':
        this.submit({ k: 'timer.reset', timerId: String(args[0]), at: hubNow }, aid);
        return;
      case 'media': {
        const k = args[0] as 'media.play' | 'media.pause' | 'media.restart';
        if (k === 'media.play' || k === 'media.pause' || k === 'media.restart')
          this.submit({ k, at: this.at() }, aid);
        return;
      }
      case 'resolveConflict':
        this.core.resolveConflict(args[0] === 'local' ? 'local' : 'hub');
        return;
      case 'activateFallback':
        this.core.activateFallback();
        return;
      case 'goLiveLocal':
        this.core.submit({ k: 'goLive', playlistId: String(args[0]) }, aid, { local: true });
        return;
      case 'offlineCheck':
        void this.offlineCheck(String(args[0])).then((result) =>
          this.post({ t: 'ui', e: { k: 'offlineCheck', result } }),
        );
        return;
      case 'offlineDownload':
        void this.offlineDownload(String(args[0]));
        return;
      case 'offlineCancel':
        if (this.offlineAbort?.playlistId === String(args[0])) this.offlineAbort.ac.abort();
        return;
    }
  }

  // ------------------------------------------------------------------ going live without the hub

  /** The cached library as goLive inputs (the same validation the hub applies). */
  private resolveLocal(playlistId: string): ResolvedPlaylist {
    const d = this.lib.data;
    const playlist = d.playlists.find((p) => p.id === playlistId);
    const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
    const pres = byId(d.presentations);
    const media = byId(d.media);
    return resolvePlaylist(
      playlist
        ? {
            playlist,
            presentation: (id) => pres.get(id),
            media: (id) => media.get(id),
            fonts: () => d.fonts,
            looks: d.settings.looks,
            general: d.settings.general,
          }
        : undefined,
      playlistId,
      { digest: localDigest, warn: (m) => this.log('warn', m) },
    );
  }

  /** Whether a playlist can go live from this PC, and which of its files are not here yet. */
  private async offlineCheck(playlistId: string): Promise<OfflineCheck> {
    const base = { playlistId, missing: [] as string[], files: 0, hubConnected: this.hub.connected };
    let resolved: ResolvedPlaylist;
    try {
      resolved = this.resolveLocal(playlistId);
    } catch (e) {
      return { ...base, ok: false, error: (e as Error).message };
    }
    const present = new Set<string>();
    for (const f of resolved.files) if (await this.files.has(f.hash).catch(() => false)) present.add(f.hash);
    const names = new Map<string, string>();
    for (const m of Object.values(resolved.media)) {
      if (m.delivery) names.set(m.delivery.hash, m.name);
      names.set(m.original.hash, m.name);
      if (m.poster) names.set(m.poster.hash, `${m.name} (poster)`);
    }
    for (const f of resolved.fonts)
      names.set(f.file.hash, `${f.family} ${f.weight}${f.style === 'italic' ? ' italic' : ''}`);
    const missing = [
      ...new Set(
        resolved.files
          .filter((f) => !present.has(f.hash))
          .map((f) => names.get(f.hash) ?? f.hash.slice(0, 12)),
      ),
    ];
    return { ...base, ok: true, missing, files: resolved.files.length };
  }

  /**
   * Download a playlist's media and fonts to this PC (the operator's file cache, which the output windows
   * read over the direct link when the hub is away). The operator chooses when; nothing is evicted.
   */
  private async offlineDownload(playlistId: string): Promise<void> {
    let files: ManifestFile[];
    try {
      files = this.resolveLocal(playlistId).files;
    } catch (e) {
      this.setOffline(playlistId, {
        state: 'failed',
        ready: 0,
        total: 0,
        failed: 0,
        bytesReady: 0,
        bytesTotal: 0,
        error: (e as Error).message,
      });
      return;
    }
    this.offlineAbort?.ac.abort();
    const ac = new AbortController();
    this.offlineAbort = { playlistId, ac };
    const total = files.length;
    const bytesTotal = files.reduce((a, f) => a + (Number.isFinite(f.bytes) && f.bytes > 0 ? f.bytes : 0), 0);
    this.setOffline(playlistId, {
      state: 'downloading',
      ready: 0,
      total,
      failed: 0,
      bytesReady: 0,
      bytesTotal,
    });
    try {
      const p = await fillCache(
        this.files,
        files,
        (hash) =>
          this.downloads.run(hash, async (signal) => {
            const r = await fetch(fileUrl(hash), { credentials: 'same-origin', signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.blob();
          }),
        (pr) => {
          if (ac.signal.aborted) return;
          this.setOffline(
            playlistId,
            {
              state: 'downloading',
              ready: pr.ready,
              total,
              failed: pr.failed.length,
              bytesReady: pr.bytesReady,
              bytesTotal,
            },
            false,
          );
        },
        { concurrency: 3, signal: ac.signal },
      );
      if (ac.signal.aborted) {
        this.setOffline(playlistId, {
          state: p.ready === total ? 'ready' : 'partial',
          ready: p.ready,
          total,
          failed: p.failed.length,
          bytesReady: p.bytesReady,
          bytesTotal,
          at: this.now(),
          error: p.ready === total ? undefined : 'Cancelled',
        });
        return;
      }
      this.setOffline(playlistId, {
        state: p.failed.length ? 'partial' : 'ready',
        ready: p.ready,
        total,
        failed: p.failed.length,
        bytesReady: p.bytesReady,
        bytesTotal,
        at: this.now(),
        error: p.failed.length
          ? `${p.failed.length} file(s) could not be downloaded${this.hub.connected ? '' : ' (the hub is unreachable)'}`
          : undefined,
      });
      this.log(
        p.failed.length ? 'warn' : 'info',
        `offline download: ${p.ready}/${total} file(s) for playlist ${playlistId}`,
      );
    } catch (e) {
      this.setOffline(playlistId, {
        state: 'failed',
        ready: 0,
        total,
        failed: total,
        bytesReady: 0,
        bytesTotal,
        error: String(e),
      });
    } finally {
      if (this.offlineAbort?.ac === ac) this.offlineAbort = undefined;
    }
  }

  private setOffline(playlistId: string, e: OfflineEntry, persist = true): void {
    this.offline = { ...this.offline, [playlistId]: e };
    if (persist) {
      const done = Object.fromEntries(
        Object.entries(this.offline).filter(([, v]) => v.state !== 'downloading'),
      );
      void this.store.set(OFFLINE_KEY, done).catch(() => undefined);
    }
    this.scheduleVm();
  }

  // ------------------------------------------------------------------ fallback bus endpoints

  private onPort(outputId: string, port: MessagePort, kind: 'port' | 'relay'): void {
    const ep = portEndpoint(port);
    let d = this.endpoints.get(outputId);
    if (!d) {
      d = new DualEndpoint(this.now);
      if (kind === 'port') d.setPort(ep);
      else d.setRelay(ep);
      this.endpoints.set(outputId, d);
      this.fallback.registerEndpoint(outputId, d);
    } else {
      if (kind === 'port') d.setPort(ep);
      else d.setRelay(ep);
      // The channel may reach a new page: introduce the bus again (hello in fallback, hub-up otherwise).
      this.fallback.reintroduce(outputId);
    }
    this.scheduleVm();
  }

  /** Introduce the fallback bus to a window again (a hello; it answers ready and gets the full state). */
  private recall(outputId: string, now: number): void {
    this.recalled.set(outputId, now);
    this.fallback.reintroduce(outputId);
  }

  private needPort(outputId: string): void {
    const d = this.endpoints.get(outputId);
    if (!d) return;
    d.lastOffer = this.now();
    this.post({ t: 'bus.need', outputId });
  }

  /**
   * Re-offer a port to a window that needs one (review item 16): the window never spoke on its current
   * port (the offer may have reached about:blank), the port is closed, or the bus runs over the relay
   * (its port died with a reload). A proven port that is merely quiet needs nothing in hub mode, where a
   * window has nothing to say on the bus; while the operator is the authority windows report health
   * over it, so a proven port silent for REOFFER_MS is re-offered too. At most one offer per REOFFER_MS.
   */
  private watchBus(): void {
    const now = this.now();
    for (const [id, d] of this.endpoints) {
      if (
        this.fallback.active &&
        this.hubRefused &&
        d.portSpoke() &&
        now - d.lastRx() >= RECALL_MS &&
        now - (this.recalled.get(id) ?? 0) >= RECALL_MS
      ) {
        this.log('warn', `output ${id} went quiet on the bus while the session is refused: re-introduced`);
        this.recall(id, now);
      }
      if (now - d.lastOffer < REOFFER_MS) continue;
      const unproven = !d.portSpoke();
      const closed = !d.portAlive();
      const relay = d.active() === 'window';
      const silentInFallback = this.fallback.active && now - d.lastRx() >= REOFFER_MS;
      if (unproven || closed || relay || silentInFallback) this.needPort(id);
    }
  }

  // ------------------------------------------------------------------ watchdog, budgets

  private watch(): void {
    const now = this.now();
    if (this.mainHidden) this.lastTick = now;
    const stall = now - this.lastTick;
    // Peak over the last minute (the current value is only interesting while the stall lasts).
    if (stall >= this.stallMax || now - this.stallMaxAt > STALL_WINDOW_MS) {
      this.stallMax = stall;
      this.stallMaxAt = now;
    }
    if (stall >= 1000 && !this.stallLogged) {
      this.stallLogged = true;
      this.log(
        'warn',
        'operator main thread stalled for more than 1 s (keys and windows wait; buses do not)',
      );
    } else if (stall < 500 && this.stallLogged) {
      this.stallLogged = false;
      this.log('info', `operator main thread responsive again (stall peak ${Math.round(this.stallMax)} ms)`);
    }
    this.scheduleVm();
  }

  private recordBudget(kind: string, detail: string): void {
    const r = this.budgets.record(kind, detail);
    if (r.exceeded) this.log('error', `error budget exceeded: ${kind} (${r.count} in the window): ${detail}`);
    this.scheduleVm();
  }

  // ------------------------------------------------------------------ state change, persistence

  private onCoreChange(): void {
    this.hub?.setLive?.(this.core?.view.mode === 'live');
    this.assertInvariants();
    this.afterChange();
    this.scheduleVm();
    if (this.role === 'operate') void this.persist();
  }

  /**
   * Invariants as code (design/25): a confirmed hub state that breaks them is resynced; a broken
   * authoritative state (fallback), or one that keeps breaking, asks for a clean restart.
   */
  private assertInvariants(): void {
    const c = this.core;
    if (!c) return;
    const s = c.authority === 'fallback' ? c.view : c.opt.confirmed;
    if (s === this.lastChecked) return;
    this.lastChecked = s;
    const v = checkInvariants(s);
    this.lastCheckedOk = v.length === 0;
    if (!v.length) return;
    this.log('error', `live state invariants failed: ${v.slice(0, 3).join('; ')}`);
    const now = this.now();
    this.invariantFailures = this.invariantFailures.filter((t) => now - t < 60_000);
    this.invariantFailures.push(now);
    if (c.authority === 'fallback' || this.invariantFailures.length > 3) {
      // Nothing broken is persisted (persist() keeps the last good snapshot), so the restarted core
      // resumes from the last state that passed (review item 17).
      this.onFatal?.(`invariants: ${v[0]}`);
      return;
    }
    this.hub.send({ t: 'live.resync' });
  }

  private afterChange(): void {
    if (this.role !== 'operate' || !this.core) return;
    const view = this.core.view;
    const resolved = view.mode === 'live' ? view.resolved : undefined;
    // A locally resolved service has no hub to fetch from: the fill waits for the next welcome (and
    // does not spend the fill budget on a dead origin).
    if (resolved && resolved.manifestId !== this.fillingManifest && this.hub.connected) {
      this.fillingManifest = resolved.manifestId;
      void this.fillOwnCache(resolved.files, resolved.manifestId);
    }
  }

  private snapshot(): CoreSnapshot {
    const c = this.core;
    return {
      state: c.authority === 'fallback' ? c.view : c.opt.confirmed,
      authority: c.authority,
      pending: c.pendingCommands(),
      aids: this.processed.slice(-PROCESSED_MAX),
      at: this.now(),
      held: c.held || undefined,
      staleOnHub: c.held ? c.staleOnHub : undefined,
    };
  }

  /**
   * The snapshot to persist: the current one when its state passes the invariants, otherwise the last
   * good one with a fresh time (so a restart within RESUME_AUTHORITY_MS still resumes the authority from
   * it), or nothing when there never was a good one. A broken state is never written over a good one.
   */
  private goodSnapshot(): CoreSnapshot | undefined {
    const snap = this.snapshot();
    const ok =
      snap.state === this.lastChecked ? this.lastCheckedOk : checkInvariants(snap.state).length === 0;
    if (ok) {
      this.lastGood = snap;
      this.brokenLogged = false;
      return snap;
    }
    if (!this.brokenLogged) {
      this.brokenLogged = true;
      this.log('error', 'live state failed the invariants: keeping the last good snapshot on disk');
    }
    return this.lastGood ? { ...this.lastGood, at: snap.at } : undefined;
  }

  /** Persist the core snapshot (coalesced per task). Resolves once written. */
  persist(): Promise<void> {
    if (this.role !== 'operate' || !this.core) return Promise.resolve();
    if (this.persistQueued) return this.persistQueued;
    this.persistQueued = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        this.persistQueued = undefined;
        const snap = this.goodSnapshot();
        if (!snap) {
          resolve();
          return;
        }
        this.store
          .set(CORE_KEY, snap)
          .catch(() => {
            this.persistFailures++;
          })
          .finally(resolve);
      });
    });
    return this.persistQueued;
  }

  private remember(aid: string): void {
    if (this.processedSet.has(aid)) return;
    this.processedSet.add(aid);
    this.processed.push(aid);
    if (this.processed.length > PROCESSED_MAX) this.processedSet.delete(this.processed.shift()!);
  }

  // ------------------------------------------------------------------ operator service cache

  private retryCache(): void {
    const view = this.core?.view;
    const resolved = view?.mode === 'live' ? view.resolved : undefined;
    this.budgets.reset('cacheFill');
    if (!resolved) return;
    this.fillingManifest = resolved.manifestId;
    void this.fillOwnCache(resolved.files, resolved.manifestId);
  }

  /**
   * Fill the operator's Cache API store from the manifest so it can serve files in fallback. The previous
   * fill's queue stops; of its downloads only those whose file left the manifest are cancelled, the rest
   * keep going and this fill joins them (the output's rule, review 2026-11-04 item 11).
   */
  private async fillOwnCache(files: { hash: string; bytes: number; mime: string }[], manifestId: string) {
    this.fillAbort?.abort();
    const cancelled = this.downloads.retain(new Set(files.map((f) => f.hash)));
    if (cancelled)
      this.log('info', `operator cache: ${cancelled} download(s) cancelled (no longer in the manifest)`);
    if (this.budgets.exceeded('cacheFill')) {
      this.downloads.abortAll();
      this.log('warn', 'operator cache: fill budget exceeded; not retrying until the operator asks');
      // The numbers describe this manifest, not the previous service's finished fill (review item 27).
      this.ownCache = { ready: 0, total: files.length, failed: files.length, manifestId };
      this.scheduleVm();
      return;
    }
    const ac = new AbortController();
    this.fillAbort = ac;
    this.ownCache = { ready: 0, total: files.length, failed: 0, manifestId };
    this.scheduleVm();
    try {
      const p = await fillCache(
        this.files,
        files,
        (hash) =>
          this.downloads.run(hash, async (signal) => {
            const r = await fetch(fileUrl(hash), { credentials: 'same-origin', signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.blob();
          }),
        (pr) => {
          if (ac.signal.aborted) return;
          this.ownCache = { ready: pr.ready, total: pr.total, failed: pr.failed.length, manifestId };
          this.scheduleVm();
        },
        { concurrency: 3, signal: ac.signal },
      );
      if (p.failed.length) {
        this.log('warn', `operator cache: ${p.failed.length} files failed`);
        this.recordBudget('cacheFill', `${p.failed.length} files failed`);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      this.log('warn', `operator cache fill: ${String(e)}`);
      this.recordBudget('cacheFill', String(e));
    }
  }

  // ------------------------------------------------------------------ notices

  private notice(n: LiveNotice): void {
    switch (n.kind) {
      case 'rejected': {
        this.log('warn', `hub rejected ${n.command.k}: ${n.reason}`);
        this.recordBudget('rejected', `${n.command.k}: ${n.reason}`);
        if (n.command.k === 'goLive') this.post({ t: 'ui', e: { k: 'goLiveError', reason: n.reason } });
        else this.toast(`Hub refused ${n.command.k}: ${n.reason}`, 'warn');
        return;
      }
      case 'unavailable':
        this.toast(`${n.command.k === 'goLive' ? 'Go live' : n.command.k}: ${n.reason}`, 'warn');
        if (n.command.k === 'goLive') this.post({ t: 'ui', e: { k: 'goLiveError', reason: n.reason } });
        return;
      case 'fallback-on':
        this.log('warn', 'hub lost: operator is now the authority (fallback bus)');
        this.recordBudget('fallback', 'hub lost while live');
        this.toast('Hub unreachable — running from this PC. Outputs follow the operator.', 'warn', 8000);
        return;
      case 'fallback-off':
        this.log('info', 'hub back: authority returned to the hub');
        this.toast('Hub reconnected. Service state handed back to the hub.', 'ok');
        // A conflict dialog still open (End service pressed while it asked) has nothing left to decide.
        this.post({ t: 'ui', e: { k: 'conflict' } });
        return;
      case 'hub-newer':
        this.log('warn', 'hub state newer than local: took the hub state');
        this.toast('The hub had newer live state; the operator now follows the hub.', 'warn', 8000);
        return;
      case 'conflict':
        this.post({
          t: 'ui',
          e: { k: 'conflict', open: true, hubPlaylist: n.hubPlaylist, localPlaylist: n.localPlaylist },
        });
        return;
      case 'local-live':
        this.log('warn', `went live from this PC without the hub: ${n.playlist}`);
        if (!DEMO)
          this.toast(
            `Live from this PC: ${n.playlist}. The outputs follow this PC until End service.`,
            'warn',
            10_000,
          );
        void this.persist();
        return;
      case 'hub-back-held':
        this.log('info', 'hub back during a service started from this PC: the service stays on this PC');
        this.toast(
          'The hub is back. This service keeps running from this PC until End service.',
          'info',
          10_000,
        );
        return;
      case 'held-ended':
        this.log('info', 'service started from this PC ended');
        this.toast(
          n.hubConnected
            ? 'Service ended. The hub takes over again.'
            : 'Service ended. The hub is still unreachable; this PC stays in charge until it returns.',
          'ok',
          8000,
        );
        void this.persist();
        return;
      case 'adopt-too-large':
        this.log(
          'warn',
          `hand-back refused locally: the live state is ${formatBytes(n.bytes)}, over ${formatBytes(n.max)}; the service stays on this PC until End service`,
        );
        this.toast(
          `The hub is back, but this service is too large to hand back to it (${formatBytes(n.bytes)}). It keeps running from this PC until End service; the hub takes over after that.`,
          'warn',
          12_000,
        );
        // A conflict dialog that led here has nothing left to decide.
        this.post({ t: 'ui', e: { k: 'conflict' } });
        void this.persist();
        return;
    }
  }

  log(level: 'info' | 'warn' | 'error', text: string): void {
    this.post({ t: 'log', level, text: text.slice(0, 500) });
  }

  private toast(text: string, kind: 'info' | 'warn' | 'error' | 'ok', ms?: number): void {
    this.post({ t: 'toast', text, kind, ms });
  }

  // ------------------------------------------------------------------ search

  private runSearch(q: string, f: Parameters<SearchIndex['search']>[1]): SearchHit[] {
    this.search.update(this.lib.data.presentations, this.lib.data.media);
    return this.search.search(q, f).map(({ h: _h, t: _t, ...hit }) => hit);
  }

  // ------------------------------------------------------------------ view model

  private scheduleVm(): void {
    if (this.vmQueued) return;
    this.vmQueued = true;
    queueMicrotask(() => {
      this.vmQueued = false;
      this.flushVm();
    });
  }

  /** Post only the slices that changed since the last post. */
  flushVm(): void {
    if (this.libReady && this.posted.libRev !== this.lib.rev) {
      const prev = this.posted.lib;
      const patch = prev ? diffLibrary(prev, this.lib.data) : null;
      if (!prev || this.posted.libRev < 0) {
        this.post({
          t: 'lib',
          rev: this.lib.rev,
          full: { data: this.lib.data, source: this.lib.source },
          error: this.lib.error,
        });
      } else if (patch) this.post({ t: 'lib', rev: this.lib.rev, patch, error: this.lib.error });
      this.posted.lib = this.lib.data;
      this.posted.libRev = this.lib.rev;
    }
    if (!this.core) return;
    const vm: ViewModelMsg = { t: 'vm' };
    let any = false;
    const view = this.core.view;
    if (view.resolved !== this.posted.resolved) {
      this.posted.resolved = view.resolved;
      this.posted.resolvedRev++;
      vm.resolved = { rev: this.posted.resolvedRev, value: view.resolved };
      any = true;
    }
    if (view.cues !== this.posted.cues) {
      this.posted.cues = view.cues;
      this.posted.cuesRev++;
      vm.cues = { rev: this.posted.cuesRev, value: view.cues };
      any = true;
    }
    const live: LiveSlice = {
      state: { ...view, resolved: undefined, cues: [] },
      resolvedRev: this.posted.resolvedRev,
      cuesRev: this.posted.cuesRev,
      authority: this.core.authority,
      reconcile: this.core.reconcile,
      pending: this.core.pendingCount,
      hubConnected: this.hub.connected,
      everConnected: this.everConnected,
      hubRefused: this.hubRefused,
      ownCache: this.ownCache,
      clock: { offset: this.hub.clock.offset, rtt: this.hub.clock.rtt, fallback: this.hub.clock.fallback },
      held: this.core.held,
    };
    const liveKey = liveSignature(live, view);
    if (liveKey !== this.posted.live) {
      this.posted.live = liveKey;
      vm.live = live;
      any = true;
    }
    if (this.health !== this.posted.health) {
      this.posted.health = this.health;
      vm.health = this.health;
      any = true;
    }
    const ok = JSON.stringify(this.offline);
    if (ok !== this.offlinePosted) {
      this.offlinePosted = ok;
      vm.offline = this.offline;
      any = true;
    }
    const budgets = this.budgets.snapshot();
    const bk = JSON.stringify(budgets.map((b) => [b.kind, b.count, b.exceeded]));
    if (bk !== this.posted.budgets) {
      this.posted.budgets = bk;
      vm.budgets = budgets;
      any = true;
    }
    const stats = this.stats();
    const sk = JSON.stringify({
      ...stats,
      mainThreadStallMs: Math.round(stats.mainThreadStallMs / 250),
      endpoints: Object.fromEntries(
        Object.entries(stats.endpoints).map(([k, v]) => [
          k,
          { ...v, sinceRxMs: Math.round(v.sinceRxMs / 1000) },
        ]),
      ),
    });
    if (sk !== this.posted.stats) {
      this.posted.stats = sk;
      vm.stats = stats;
      any = true;
    }
    if (any) this.post(vm);
  }

  stats(): CoreStats {
    const endpoints: CoreStats['endpoints'] = {};
    for (const [id, d] of this.endpoints) endpoints[id] = d.info(this.fallback.isReady(id));
    return {
      generation: this.generation,
      mainThreadStallMs: Math.max(0, this.now() - this.lastTick),
      mainThreadStallMaxMs: this.stallMax,
      endpoints,
      persistFailures: this.persistFailures,
    };
  }
}

/** Changes in the live slice that matter to the UI (the state object identity covers the reducer). */
function liveSignature(l: LiveSlice, view: LiveState): string {
  return [
    view.seq,
    stateId(view),
    l.resolvedRev,
    l.cuesRev,
    l.authority,
    l.reconcile,
    l.pending,
    l.hubConnected,
    l.everConnected,
    l.hubRefused,
    l.ownCache.ready,
    l.ownCache.total,
    l.ownCache.failed,
    l.ownCache.manifestId,
    Math.round(l.clock.offset),
    Math.round(l.clock.rtt),
    l.clock.fallback,
    l.held,
  ].join('|');
}

const ids = new WeakMap<object, number>();
let nextStateId = 1;
/** Identity of a state object (optimistic views change identity without changing seq). */
function stateId(s: LiveState): number {
  let n = ids.get(s);
  if (!n) {
    n = nextStateId++;
    ids.set(s, n);
  }
  return n;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
