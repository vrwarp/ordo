import { CacheApiStore, fillCache } from '@ordo/cache';
import { clock, FallbackHost, fileUrl, HubConnection, hubNow, type RtcSignalIn } from '@ordo/client';
import { type LiveCommand, type LiveEvent, type LiveState, newId, type TimerSpec } from '@ordo/domain';
import { actionToEvent } from '@ordo/live-state';
import { APP_VERSION, type ClientMessage, type OutputHealthEntry } from '@ordo/protocol';
import type { Action } from '@ordo/surfaces';
import { DoublePressGuard } from '../lib/confirm.ts';
import { LiveCore, type LiveNotice } from '../lib/liveCore.ts';
import { applyDelta, jsonStore, loadLibrary, saveSettings, settings } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { refreshSession, useSession } from '../state/session.ts';
import { toast } from '../state/toasts.ts';
import { rememberMessage, useUi } from '../state/ui.ts';
import { log } from './log.ts';

export { APP_VERSION };
/** GO lead: two frames at 60 Hz. */
export const GO_LEAD_MS = 33;
export const MUTE_DB = -96;
const LIVE_KEY = 'live';

type Source = 'keyboard' | 'streamdeck' | 'midi' | 'ui';
type Hooks = {
  launch?: () => void;
  relaunch?: () => void;
  onHealth?: (h: Record<string, OutputHealthEntry>) => void;
  onRtc?: (m: RtcSignalIn) => void;
  onLiveChange?: (s: LiveState) => void;
};

/**
 * The operator's connection to the live service: hub socket, optimistic state, fallback authority,
 * the operator's own service cache, and the single dispatch every UI action, key, Stream Deck and MIDI
 * press goes through.
 */
export class Controller {
  readonly hub: HubConnection;
  readonly fallback = new FallbackHost();
  readonly files = new CacheApiStore('ordo-files');
  core!: LiveCore;
  readonly hooks: Hooks = {};
  private commands = new Map<string, LiveCommand>();
  private clearGuard = new DoublePressGuard(2000);
  private clearTimer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private fillingManifest?: string;
  private fillAbort?: AbortController;
  private lastResolvedId?: string;
  private started = false;

  constructor(readonly role: 'operate' | 'edit') {
    this.hub = new HubConnection({ role, appVersion: APP_VERSION });
    this.fallback.getFile = async (hash) => (await this.files.get(hash).catch(() => undefined)) ?? undefined;
    this.fallback.on('health', ({ outputId, health }) => {
      if (this.core.authority !== 'fallback') return;
      const prev = useLive.getState().health[outputId];
      const entry: OutputHealthEntry = {
        ...health,
        outputId,
        connected: true,
        lastSeen: Date.now(),
        name: prev?.name ?? settings().outputs.find((o) => o.id === outputId)?.name,
      };
      useLive.setState((s) => ({ health: { ...s.health, [outputId]: entry } }));
    });
    this.fallback.on('event', ({ event }) => this.core.externalEvent(event));
    this.fallback.on('ready', ({ outputId, appliedSeq }) =>
      log('info', `fallback ready ${outputId} @${appliedSeq}`),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let seed: LiveState | undefined;
    if (this.role === 'operate') {
      try {
        seed = await jsonStore.get<LiveState>(LIVE_KEY);
      } catch {
        seed = undefined;
      }
    }
    this.core = new LiveCore(
      {
        sendHub: (m) => this.hub.send(m as Omit<ClientMessage, 'v'> as never),
        fallback: this.fallback,
        setClockFallback: (on) => {
          clock.fallback = on;
        },
        newId,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        onChange: () => this.publish(),
        onNotice: (n) => this.notice(n),
      },
      seed?.mode === 'live' ? seed : undefined,
    );
    this.publish();
    const h = this.hub;
    h.on('status', ({ connected }) => {
      log(connected ? 'info' : 'warn', connected ? 'hub connected' : 'hub disconnected');
      this.core.onStatus(connected);
      useLive.setState((s) => ({ hubConnected: connected, everConnected: s.everConnected || connected }));
    });
    h.on('welcome', () => {
      this.core.onWelcome();
      // Deltas may have been missed while away.
      if (useSession.getState().status !== 'ready') void refreshSession();
      void loadLibrary();
    });
    h.on('state', (m) => this.core.onState(m.state));
    h.on('delta', (m) => this.core.onDelta(m));
    h.on('ack', (m) => {
      if (m.id === 'adopt') {
        log(
          m.rejected ? 'warn' : 'info',
          m.rejected ? `hub refused adoption: ${m.rejected}` : `hub adopted state @${m.seq}`,
        );
        return;
      }
      const cmd = this.commands.get(m.id);
      this.core.onAck(m, cmd);
      this.commands.delete(m.id);
    });
    h.on('library', (m) => applyDelta(m));
    h.on('health', (m) => {
      if (this.core.authority === 'fallback') return;
      useLive.setState({ health: m.outputs, clock: { offset: clock.offset, rtt: clock.rtt } });
      this.hooks.onHealth?.(m.outputs);
    });
    h.on('rtc', (m) => this.hooks.onRtc?.(m));
    h.on('bye', (m) => {
      log('warn', `hub said bye: ${m.reason}`);
      if (m.reason !== 'version') toast(`Hub closed the connection: ${m.reason}`, 'warn');
    });
    h.start();
  }

  stop(): void {
    this.hub.stop();
    this.core?.dispose();
    this.fallback.dispose();
  }

  get state(): LiveState {
    return this.core.view;
  }

  // ---- the single dispatch ----

  dispatch = (a: Action, source: Source = 'ui'): void => {
    if (this.role !== 'operate') return;
    if (source !== 'ui') log('info', `${source}: ${a.id}${a.arg !== undefined ? ` ${a.arg}` : ''}`);
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
      case 'audioFadeOut':
        this.submit({ k: 'audio.stop', at: hubNow() + GO_LEAD_MS });
        return;
      case 'clearAll': {
        const now = Date.now();
        if (!this.clearGuard.press(now)) {
          const until = this.clearGuard.pendingUntil(now);
          useLive.setState({ clearAllUntil: until });
          clearTimeout(this.clearTimer);
          this.clearTimer = setTimeout(() => useLive.setState({ clearAllUntil: undefined }), 2050);
          return;
        }
        clearTimeout(this.clearTimer);
        useLive.setState({ clearAllUntil: undefined });
        break;
      }
    }
    const ev = actionToEvent(this.core.view, a, hubNow() + GO_LEAD_MS, {
      messagePresets: settings().surfaces.messagePresets,
      newId,
    });
    if (ev && ev.k !== 'goLive') this.submit(ev);
  };

  submit(cmd: LiveCommand): string {
    const id = this.core.submit(cmd);
    this.commands.set(id, cmd);
    if (this.commands.size > 300) {
      const first = this.commands.keys().next().value;
      if (first !== undefined) this.commands.delete(first);
    }
    return id;
  }

  // ---- convenience commands for the UI ----

  at(): number {
    return hubNow() + GO_LEAD_MS;
  }
  go(cueIndex: number): void {
    this.submit({ k: 'go', cueIndex, at: this.at() });
  }
  select(cueIndex: number): void {
    this.submit({ k: 'select', cueIndex });
  }
  goToSection(sectionIndex: number): void {
    this.submit({ k: 'goToSection', sectionIndex, at: this.at() });
  }
  clear(layer: Extract<LiveEvent, { k: 'clear' }>['layer']): void {
    if (layer === 'all') this.dispatch({ id: 'clearAll' });
    else this.submit({ k: 'clear', layer, at: this.at() });
  }
  goLive(playlistId: string): void {
    useLive.setState({ goLiveError: undefined });
    this.submit({ k: 'goLive', playlistId });
  }
  endService(): void {
    this.submit({ k: 'endService', at: this.at() });
  }
  sendMessage(text: string, ttlMs?: number): void {
    const t = text.trim();
    if (!t) return;
    rememberMessage(t);
    this.submit({
      k: 'message.send',
      id: newId(),
      text: t.slice(0, 500),
      ttlMs: ttlMs || undefined,
      at: hubNow(),
    });
  }
  dismissMessage(id: string): void {
    this.submit({ k: 'message.dismiss', id });
  }
  lowerThird(text: string): void {
    this.submit({ k: 'lowerThird', text, at: this.at() });
  }
  timerStart(timerId: string, spec?: TimerSpec): void {
    this.submit({ k: 'timer.start', timerId, spec, at: hubNow() });
  }
  timerStop(timerId: string): void {
    this.submit({ k: 'timer.stop', timerId, at: hubNow() });
  }
  timerReset(timerId: string): void {
    this.submit({ k: 'timer.reset', timerId, at: hubNow() });
  }
  media(k: 'media.play' | 'media.pause' | 'media.restart'): void {
    this.submit({ k, at: this.at() });
  }
  resolveConflict(choice: 'local' | 'hub'): void {
    useLive.setState({ conflict: undefined });
    this.core.resolveConflict(choice);
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

  // ---- internals ----

  private publish(): void {
    const view = this.core.view;
    useLive.setState({
      state: view,
      authority: this.core.authority,
      reconcile: this.core.reconcile,
      pending: this.core.pendingCount,
    });
    this.hooks.onLiveChange?.(view);
    this.afterChange(view);
  }

  private afterChange(view: LiveState): void {
    if (this.role !== 'operate') return;
    // Persist the live state so a reload with the hub down can continue (design/17).
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void jsonStore.set(LIVE_KEY, this.core.view).catch(() => undefined);
    }, 500);
    const resolved = view.mode === 'live' ? view.resolved : undefined;
    if (resolved && resolved.manifestId !== this.fillingManifest) {
      this.fillingManifest = resolved.manifestId;
      void this.fillOwnCache(resolved.files, resolved.manifestId);
    }
    const rid = resolved?.playlist.id;
    if (rid && rid !== this.lastResolvedId) {
      // Follow the live playlist in the operator view.
      useUi.setState({ selectedPlaylistId: rid, followLive: true });
    }
    this.lastResolvedId = rid;
  }

  /** Fill the operator's Cache API store from the manifest so it can serve files in fallback. */
  private async fillOwnCache(files: { hash: string; bytes: number; mime: string }[], manifestId: string) {
    this.fillAbort?.abort();
    const ac = new AbortController();
    this.fillAbort = ac;
    useLive.setState({ ownCache: { ready: 0, total: files.length, failed: 0, manifestId } });
    try {
      const p = await fillCache(
        this.files,
        files,
        async (hash) => {
          const r = await fetch(fileUrl(hash), { credentials: 'same-origin', signal: ac.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        },
        (pr) => {
          if (!ac.signal.aborted)
            useLive.setState({
              ownCache: { ready: pr.ready, total: pr.total, failed: pr.failed.length, manifestId },
            });
        },
        { concurrency: 3, signal: ac.signal },
      );
      if (p.failed.length) log('warn', `operator cache: ${p.failed.length} files failed`);
    } catch (e) {
      log('warn', `operator cache fill: ${String(e)}`);
    }
  }

  private notice(n: LiveNotice): void {
    switch (n.kind) {
      case 'rejected': {
        log('warn', `hub rejected ${n.command.k}: ${n.reason}`);
        if (n.command.k === 'goLive') useLive.setState({ goLiveError: n.reason });
        else toast(`Hub refused ${n.command.k}: ${n.reason}`, 'warn');
        return;
      }
      case 'unavailable':
        toast(`${n.command.k === 'goLive' ? 'Go live' : n.command.k}: ${n.reason}`, 'warn');
        if (n.command.k === 'goLive') useLive.setState({ goLiveError: n.reason });
        return;
      case 'fallback-on':
        log('warn', 'hub lost: operator is now the authority (fallback bus)');
        toast('Hub unreachable — running from this PC. Outputs follow the operator.', 'warn', 8000);
        return;
      case 'fallback-off':
        log('info', 'hub back: authority returned to the hub');
        toast('Hub reconnected. Service state handed back to the hub.', 'ok');
        return;
      case 'hub-newer':
        log('warn', 'hub state newer than local: took the hub state');
        toast('The hub had newer live state; the operator now follows the hub.', 'warn', 8000);
        return;
      case 'conflict':
        useLive.setState({ conflict: { hubPlaylist: n.hubPlaylist, localPlaylist: n.localPlaylist } });
        return;
    }
  }
}

let current: Controller | undefined;

export function controller(): Controller | undefined {
  return current;
}

export function startController(role: 'operate' | 'edit'): Controller {
  if (current && current.role === role) return current;
  current?.stop();
  current = new Controller(role);
  void current.start();
  return current;
}

/** Dispatch helper usable from components; no-op before login. */
export function dispatch(a: Action, source: Source = 'ui'): void {
  current?.dispatch(a, source);
}
