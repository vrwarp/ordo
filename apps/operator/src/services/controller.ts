import { type ClientMessageBody, Emitter, type RtcSignalIn } from '@ordo/client';
import type { LiveEvent, LiveState, ResolvedPlaylist, TimerSpec } from '@ordo/domain';
import { APP_VERSION, type OutputHealthEntry } from '@ordo/protocol';
import type { Action } from '@ordo/surfaces';
import { CoreClient } from '../core/client.ts';
import type { CallName, Source, ViewModelMsg } from '../core/protocol.ts';
import { applyCoreLibrary, connectLibrary, saveSettings, settings } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { refreshSession, useSession } from '../state/session.ts';
import { toast } from '../state/toasts.ts';
import { rememberMessage, useUi } from '../state/ui.ts';
import { RecoveringGate } from '../lib/recovering.ts';
import { log } from './log.ts';
import { thumbs } from './thumbs.ts';

export { APP_VERSION };
/** GO lead: two frames at 60 Hz. */
export const GO_LEAD_MS = 33;
export const MUTE_DB = -96;
const SUPERVISION_MS = 500;

type Hooks = {
  launch?: () => void;
  relaunch?: () => void;
  onHealth?: (h: Record<string, OutputHealthEntry>) => void;
  onRtc?: (m: RtcSignalIn) => void;
  onLiveChange?: (s: LiveState) => void;
};

/** The hub as the main thread sees it: the socket lives in the core worker. */
export class HubProxy extends Emitter<{ welcome: { appVersion: string }; bye: { reason: string } }> {
  constructor(private core: CoreClient) {
    super();
  }
  get connected(): boolean {
    return useLive.getState().hubConnected && this.core.alive;
  }
  send(m: ClientMessageBody): boolean {
    if (!this.connected) return false;
    return this.core.hubSend(m);
  }
}

/** Test mode: `?test=1` in the URL or localStorage `ordo.test` = 1 (chaos hooks on window.__ordo). */
export function testMode(): boolean {
  try {
    if (new URLSearchParams(location.search).get('test') === '1') return true;
    return localStorage.getItem('ordo.test') === '1';
  } catch {
    return false;
  }
}

/**
 * Main-thread facade of the operator core (design/25). The hub socket, live state, fallback bus, library
 * and cache fill run in the core worker; this class turns UI calls into posted actions and the worker's
 * view model into the zustand read models (useLive, useLibrary). Its public API is what it was when the
 * controller ran on the main thread, so views did not change.
 */
export class Controller {
  readonly core: CoreClient;
  readonly hub: HubProxy;
  readonly hooks: Hooks = {};
  private resolved?: ResolvedPlaylist;
  private resolvedRev = -1;
  private cues: LiveState['cues'] = [];
  private cuesRev = -1;
  private lastResolvedId?: string;
  private watch?: ReturnType<typeof setInterval>;
  private recoveringGate = new RecoveringGate(SUPERVISION_MS);
  private offs: (() => void)[] = [];

  constructor(
    readonly role: 'operate' | 'edit',
    factory: () => Worker = () =>
      new Worker(new URL('../core/core.worker.ts', import.meta.url), { type: 'module', name: 'ordo-core' }),
  ) {
    const test = testMode();
    this.core = new CoreClient(role, APP_VERSION, factory, { test });
    this.hub = new HubProxy(this.core);
    const c = this.core;
    connectLibrary({ op: (op) => c.libOp(op), reload: () => c.reloadLibrary() });
    thumbs.supervise(c.sup);
    this.offs.push(
      c.on('vm', (m) => this.applyVm(m)),
      c.on('lib', (m) => applyCoreLibrary(m)),
      c.on('log', ({ level, text }) => log(level, text)),
      c.on('toast', ({ text, kind, ms }) => toast(text, kind, ms)),
      c.on('ui', (e) => {
        if (e.k === 'clearAllUntil') useLive.setState({ clearAllUntil: e.until });
        else if (e.k === 'conflict')
          useLive.setState({ conflict: { hubPlaylist: e.hubPlaylist, localPlaylist: e.localPlaylist } });
        else if (e.k === 'goLiveError') useLive.setState({ goLiveError: e.reason });
      }),
      c.on('welcome', (w) => {
        if (useSession.getState().status !== 'ready') void refreshSession();
        this.hub.emit('welcome', w);
      }),
      c.on('bye', (b) => this.hub.emit('bye', b)),
      // The hub refused the session (expired, logged out elsewhere): not a hub loss. Ask the hub who we
      // are, which routes to the sign-in view; once signed in, the core reconnects at once (review item 5).
      c.on('auth', ({ reason }) => {
        log('warn', `hub refused this operator's session (${reason}); sign in again`);
        void refreshSession();
      }),
      c.on('rtc', (m) => this.hooks.onRtc?.(m)),
      c.on('ready', ({ generation, restart }) => {
        if (restart) {
          log('warn', `operator core recovered (generation ${generation}); state restored, ports re-offered`);
          toast('The operator core restarted and recovered. Nothing was lost.', 'warn', 6000);
        }
        this.updateSupervision();
      }),
      c.on('supervisor', ({ name, reason, gaveUp }) => {
        log(
          gaveUp ? 'error' : 'warn',
          `${name} worker ${gaveUp ? 'stopped (restart budget spent)' : 'restarted'}: ${reason}`,
        );
        this.updateSupervision();
      }),
    );
    // Signed in again after a refusal: reconnect the core's hub socket now instead of at its slow retry.
    let signedIn = signedInRole() !== null;
    this.offs.push(
      useSession.subscribe(() => {
        const now = signedInRole() !== null;
        if (now && !signedIn && useLive.getState().hubRefused) this.core.hubResume();
        signedIn = now;
      }),
    );
    this.watch = setInterval(() => this.updateSupervision(), SUPERVISION_MS);
    if (test) installTestHooks(this);
  }

  stop(): void {
    connectLibrary(undefined);
    clearInterval(this.watch);
    for (const off of this.offs) off();
    this.core.dispose();
  }

  get state(): LiveState {
    return useLive.getState().state;
  }

  // ---- view model → read models ----

  private applyVm(m: ViewModelMsg): void {
    if (m.resolved) {
      this.resolved = m.resolved.value;
      this.resolvedRev = m.resolved.rev;
    }
    if (m.cues) {
      this.cues = m.cues.value;
      this.cuesRev = m.cues.rev;
    }
    const patch: Partial<ReturnType<typeof useLive.getState>> = {};
    if (m.live) {
      const l = m.live;
      // Re-attach the big immutable parts posted by revision (identity is kept for React memos).
      const resolved = l.resolvedRev === this.resolvedRev ? this.resolved : undefined;
      const cues = l.cuesRev === this.cuesRev ? this.cues : [];
      patch.state = { ...l.state, resolved, cues };
      patch.authority = l.authority;
      patch.reconcile = l.reconcile;
      patch.pending = l.pending;
      patch.hubConnected = l.hubConnected;
      patch.everConnected = l.everConnected;
      patch.hubRefused = l.hubRefused;
      patch.ownCache = l.ownCache;
      patch.clock = { offset: l.clock.offset, rtt: l.clock.rtt };
    } else if (m.resolved || m.cues) {
      const s = useLive.getState().state;
      patch.state = { ...s, resolved: this.resolved, cues: this.cues };
    }
    if (m.health) patch.health = m.health;
    if (m.budgets) patch.coreBudgets = m.budgets;
    if (m.stats) patch.core = m.stats;
    useLive.setState(patch);
    if (patch.state) this.afterState(patch.state);
    if (m.health) this.hooks.onHealth?.(m.health);
  }

  private afterState(view: LiveState): void {
    this.hooks.onLiveChange?.(view);
    const rid = view.mode === 'live' ? view.resolved?.playlist.id : undefined;
    // Follow the live playlist in the operator view.
    if (rid && rid !== this.lastResolvedId) useUi.setState({ selectedPlaylistId: rid, followLive: true });
    this.lastResolvedId = rid;
  }

  private updateSupervision(): void {
    const stats = this.core.sup.stats();
    const core = stats.find((s) => s.name === 'core');
    // Gated on the real restart state, with the supervisor's stall correction for late heartbeats.
    const recovering =
      !!core &&
      !core.gaveUp &&
      this.recoveringGate.judge(performance.now(), this.core.recovering, core.sinceHeartbeatMs);
    const cur = useLive.getState();
    const budgets = this.core.budgets.snapshot();
    const key = JSON.stringify([
      stats.map((s) => [s.name, s.generation, s.restarts, s.gaveUp]),
      budgets.map((b) => [b.kind, b.count]),
    ]);
    if (
      cur.recovering !== recovering ||
      cur.supervisionKey !== key ||
      cur.unacknowledged !== this.core.unacknowledged
    )
      useLive.setState({
        recovering,
        workers: stats,
        mainBudgets: budgets,
        supervisionKey: key,
        coreGaveUp: !!core?.gaveUp,
        unacknowledged: this.core.unacknowledged,
      });
  }

  // ---- the single dispatch ----

  /** Every key, Stream Deck and MIDI press and UI button: window and audio actions here, the rest to the core. */
  dispatch = (a: Action, source: Source = 'ui'): void => {
    if (this.role !== 'operate') return;
    switch (a.id) {
      case 'launchOutputs':
        this.hooks.launch?.();
        return;
      case 'relaunchOutputs':
        this.hooks.relaunch?.();
        return;
      case 'audioMute':
        void this.toggleMute();
        return;
      case 'audioMasterUp':
        void this.adjustMaster(3);
        return;
      case 'audioMasterDown':
        void this.adjustMaster(-3);
        return;
    }
    this.core.action(a, source);
  };

  private call(name: CallName, ...args: unknown[]): void {
    if (this.role !== 'operate') return;
    this.core.call(name, ...args);
  }

  // ---- convenience commands for the UI ----

  go(cueIndex: number): void {
    this.call('go', cueIndex);
  }
  select(cueIndex: number): void {
    this.call('select', cueIndex);
  }
  goToSection(sectionIndex: number): void {
    this.call('goToSection', sectionIndex);
  }
  clear(layer: Extract<LiveEvent, { k: 'clear' }>['layer']): void {
    if (layer === 'all') this.dispatch({ id: 'clearAll' });
    else this.call('clear', layer);
  }
  goLive(playlistId: string): void {
    useLive.setState({ goLiveError: undefined });
    this.call('goLive', playlistId);
  }
  endService(): void {
    this.call('endService');
  }
  sendMessage(text: string, ttlMs?: number): void {
    const t = text.trim();
    if (!t) return;
    rememberMessage(t);
    this.call('sendMessage', t, ttlMs || undefined);
  }
  dismissMessage(id: string): void {
    this.call('dismissMessage', id);
  }
  lowerThird(text: string): void {
    this.call('lowerThird', text);
  }
  timerStart(timerId: string, spec?: TimerSpec): void {
    this.call('timerStart', timerId, spec);
  }
  timerStop(timerId: string): void {
    this.call('timerStop', timerId);
  }
  timerReset(timerId: string): void {
    this.call('timerReset', timerId);
  }
  media(k: 'media.play' | 'media.pause' | 'media.restart'): void {
    this.call('media', k);
  }
  resolveConflict(choice: 'local' | 'hub'): void {
    useLive.setState({ conflict: undefined });
    this.call('resolveConflict', choice);
  }
  resync(): void {
    this.core.hubSend({ t: 'live.resync' });
  }

  async toggleMute(): Promise<void> {
    const a = settings().audio;
    if (a.masterDb <= MUTE_DB + 1) {
      await saveSettings('audio', { ...a, masterDb: useUi.getState().unmuteDb ?? 0 });
    } else {
      useUi.setState({ unmuteDb: a.masterDb });
      await saveSettings('audio', { ...a, masterDb: MUTE_DB });
    }
  }

  async adjustMaster(delta: number): Promise<void> {
    const a = settings().audio;
    const base = a.masterDb <= MUTE_DB + 1 ? (useUi.getState().unmuteDb ?? 0) : a.masterDb;
    await saveSettings('audio', { ...a, masterDb: Math.max(-60, Math.min(12, base + delta)) });
  }
}

/** Chaos and inspection hooks for end-to-end tests (design/25 "Chaos in end-to-end tests"). */
function installTestHooks(ctl: Controller): void {
  const w = window as unknown as { __ordo?: Record<string, unknown> };
  w.__ordo = {
    ...(w.__ordo ?? {}),
    state: () => useLive.getState().state,
    live: () => {
      const s = useLive.getState();
      return {
        seq: s.state.seq,
        live: s.state.live,
        authority: s.authority,
        hubConnected: s.hubConnected,
        hubRefused: s.hubRefused,
        reconcile: s.reconcile,
        offers: ctl.core.offerCounts(),
        recovering: s.recovering,
        generation: s.core?.generation,
        endpoints: s.core?.endpoints ?? {},
        mainThreadStallMaxMs: s.core?.mainThreadStallMaxMs,
        unacknowledged: s.unacknowledged,
        workers: s.workers,
      };
    },
    chaos: {
      killWorker: (name: string) => ctl.core.killWorker(name),
      blockMain: (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          /* a long main-thread task */
        }
      },
      /** A GO (or any action) dispatched inside the core worker after `delayMs`, as a Stream Deck would. */
      workerDispatch: (action: Action, delayMs = 0) =>
        ctl.core.chaos({ k: 'dispatchLater', action, delayMs }),
      throwInWorker: (reason = 'test') => ctl.core.chaos({ k: 'throw', reason }),
      /** Drop the core's hub socket now; it reconnects after the backoff. */
      kickHub: () => ctl.core.hubKick(),
    },
  };
}

function signedInRole(): 'operate' | 'edit' | null {
  const r = useSession.getState().me?.role;
  return r === 'operate' || r === 'edit' ? r : null;
}

let current: Controller | undefined;

export function controller(): Controller | undefined {
  return current;
}

export function startController(role: 'operate' | 'edit'): Controller {
  if (current && current.role === role) return current;
  current?.stop();
  current = new Controller(role);
  return current;
}

/** Dispatch helper usable from components; no-op before login. */
export function dispatch(a: Action, source: Source = 'ui'): void {
  current?.dispatch(a, source);
}
