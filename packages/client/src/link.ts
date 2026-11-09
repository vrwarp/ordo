import type { OutputHealth } from '@ordo/protocol';
import type { LiveState } from '@ordo/domain';
import { Emitter } from './emitter.ts';
import { HubConnection, type RtcSignalIn } from './hub.ts';
import { FALLBACK_SILENCE_MS, FallbackClient } from './fallback.ts';
import { LiveMirror } from './mirror.ts';
import { clock } from './clock.ts';
import { appEnv, operatorOrigin as defaultOperatorOrigin } from './env.ts';
import { setApiToken } from './api.ts';
import type { LibraryDelta } from '@ordo/protocol';
import { DEMO } from './demo.ts';

export type Bus = 'hub' | 'fallback' | 'none';
export type OutputEvent = { k: 'media.ended' | 'audio.ended'; cueIndex: number; at: number };

/** Ended events are kept for resending on a bus change for this long. */
const EVENT_KEEP_MS = 30_000;
const EVENT_KEEP_MAX = 20;
/** How often the fallback bus is checked for silence or a closed opener. */
const WATCH_MS = 1000;
/**
 * Full-state requests (resyncs) a window makes in a minute before it stops asking (review 2026-11-04
 * finding 25): a bus that keeps answering with a malformed state would otherwise be asked forever. Past the
 * budget the window keeps its last good state, reports the error in health and asks once a minute, until a
 * state applies again.
 */
export const RESYNC_BUDGET = 10;
export const RESYNC_WINDOW_MS = 60_000;

/** How often a held window renews the persisted age of its hold while the operator keeps heartbeating. */
const HELD_REFRESH_MS = 60_000;

/**
 * The live link an output or stage window uses: hub WebSocket normally, the operator's postMessage bus
 * when the operator says the hub is gone. Exposes one mirror of the live state either way.
 *
 * The window leaves the fallback bus on its own (design/17) when any of these holds:
 * - the hub socket is up and the hub's state sequence is at or above the applied one (the hub only
 *   reaches that after adopting the operator's state, or when nothing changed while it was away);
 * - no message has arrived from the operator for 5 s (the host heartbeats every 2 s);
 * - the opener window is closed.
 * It also leaves when the operator posts `fallback.hub { hubUp: true }`.
 */
export class OutputLink extends Emitter<{
  bus: { bus: Bus; reason?: string };
  /** `refresh`: the hold is still on (a heartbeat; at most once a minute), so its persisted age can be renewed. */
  held: { held: boolean; refresh?: true };
  library: LibraryDelta;
  rtc: RtcSignalIn;
}> {
  readonly mirror = new LiveMirror();
  readonly hub: HubConnection;
  readonly fallback?: FallbackClient;
  bus: Bus = 'none';
  readonly outputId: string;
  readonly token: string;
  private watch?: ReturnType<typeof setInterval>;
  private resyncTimes: number[] = [];
  /** Set while the resync budget is spent: when it was spent and how many requests were refused since. */
  private resyncSpent?: { at: number; refused: number };
  private recentEvents: { id: string; event: OutputEvent; at: number; sent: boolean }[] = [];
  /**
   * The operator holds the service it started without the hub (design/17 "Going live without the hub").
   * While held the hub's state is never applied, whatever its sequence: the hub does not know this
   * service, and following it would blank the screens. Only the operator's `fallback.hub { hubUp: true }`
   * (or a hold-free introduction) releases it. Survives a silent operator: the window keeps its picture.
   */
  held = false;
  private heldRefreshedAt = 0;

  constructor(opts: {
    role: 'output' | 'stage';
    appVersion: string;
    operatorOrigin?: string;
    /** Test seams. */
    hub?: HubConnection;
    fallback?: FallbackClient | null;
    outputId?: string;
    token?: string;
  }) {
    super();
    const env = typeof location !== 'undefined' ? appEnv() : { domain: '' };
    this.outputId = opts.outputId ?? env.outputId ?? 'unknown';
    this.token = opts.token ?? env.token ?? '';
    setApiToken(this.token);
    this.hub =
      opts.hub ??
      new HubConnection({
        role: opts.role,
        appVersion: opts.appVersion,
        outputId: this.outputId,
        token: this.token,
      });
    if (opts.fallback !== undefined) this.fallback = opts.fallback ?? undefined;
    else if (typeof window !== 'undefined' && window.opener) {
      const operatorOrigin = opts.operatorOrigin ?? defaultOperatorOrigin(env);
      try {
        this.fallback = new FallbackClient(operatorOrigin, this.outputId);
      } catch {
        this.fallback = undefined;
      }
    }

    this.hub.on('status', ({ connected }) => {
      if (connected && this.bus !== 'fallback' && !this.held) this.setBus('hub', 'hub connected');
      if (!connected && this.bus === 'hub') this.setBus('none', 'hub disconnected');
    });
    this.hub.on('state', (m) => {
      if (this.held) return;
      if (this.bus === 'fallback') {
        if (m.seq < this.mirror.state.seq) return; // the hub has not caught up (adopted) yet
        this.leaveFallback('hub caught up');
      }
      this.mirror.applyState(m.state);
    });
    this.hub.on('delta', (m) => {
      if (this.held) return;
      if (this.bus === 'fallback') {
        if (m.fromSeq < this.mirror.state.seq) return;
        this.leaveFallback('hub caught up');
      }
      if (!this.mirror.applyDelta(m)) this.requestResync();
    });
    // A full state that applies answers every outstanding resync: the budget only counts resyncs that the
    // bus failed to answer, so a run of genuine sequence gaps on a flappy bus never starves a later one.
    this.mirror.on('change', ({ event }) => {
      if (event !== undefined) return; // a delta, not a full state
      this.resyncSpent = undefined;
      this.resyncTimes = [];
    });
    this.hub.on('library', (m) => this.emit('library', m));
    this.hub.on('rtc', (m) => this.emit('rtc', m));

    this.fallback?.on('hello', ({ hold }) => {
      this.setHeld(hold);
      this.setBus('fallback', 'operator hello');
      clock.fallback = true;
      this.fallback!.ready(this.mirror.state.seq);
    });
    this.fallback?.on('state', (m) => {
      if (this.bus === 'fallback') this.mirror.applyState(m.state);
    });
    this.fallback?.on('delta', (m) => {
      if (this.bus !== 'fallback') return;
      if (!this.mirror.applyDelta(m)) this.requestResync({ fallbackSeq: this.mirror.state.seq });
    });
    this.fallback?.on('hub', ({ hubUp, hold }) => {
      if (hubUp) {
        if (DEMO) return; // In demo mode there is no WebSocket hub; stay on fallback bus
        this.setHeld(false);
        if (this.bus === 'fallback') this.leaveFallback('operator says hub up');
        else clock.fallback = false;
        return;
      }
      if (this.bus === 'fallback') {
        this.setHeld(hold);
        if (hold && this.held) this.refreshHeld();
      }
    });
  }

  get state(): LiveState {
    return this.mirror.state;
  }

  /** Restore a hold persisted before a reload, so the hub is not followed before the operator re-introduces itself. */
  restoreHeld(held: boolean): void {
    this.setHeld(held);
  }

  private setHeld(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    this.heldRefreshedAt = on ? Date.now() : 0;
    this.emit('held', { held: on });
  }

  /** The hold's age counts from the operator's last word, not from its start (a reload keeps it a day). */
  private refreshHeld(): void {
    const now = Date.now();
    if (now - this.heldRefreshedAt < HELD_REFRESH_MS) return;
    this.heldRefreshedAt = now;
    this.emit('held', { held: true, refresh: true });
  }

  /**
   * Ask the active bus for a full state (hub `live.resync`, or `fallback.ready` on the operator's bus),
   * within the resync budget. Returns false when the budget refused it or no bus could carry it. `fallbackSeq` is the sequence
   * reported to the operator (-1 forces a full state).
   */
  requestResync(opts: { fallbackSeq?: number; now?: number } = {}): boolean {
    const now = opts.now ?? Date.now();
    this.resyncTimes = this.resyncTimes.filter((t) => now - t < RESYNC_WINDOW_MS);
    const last = this.resyncTimes.at(-1);
    if (this.resyncSpent) {
      // Spent: one request a minute until a state applies again.
      if (last !== undefined && now - last < RESYNC_WINDOW_MS) {
        this.resyncSpent.refused++;
        return false;
      }
    } else if (this.resyncTimes.length >= RESYNC_BUDGET) {
      this.resyncSpent = { at: now, refused: 1 };
      console.error('[ordo] live state resync budget spent: keeping the last good state');
      return false;
    }
    let sent = true;
    if (this.bus === 'fallback' && this.fallback) this.fallback.ready(opts.fallbackSeq ?? -1);
    else sent = this.hub.send({ t: 'live.resync' }); // false with the socket down: nothing was asked
    if (sent) this.resyncTimes.push(now);
    return sent;
  }

  /** The health error while the resync budget is spent (also merged into `sendHealth`). */
  get resyncError(): string | undefined {
    const s = this.resyncSpent;
    if (!s) return undefined;
    return `live state: no valid state after ${RESYNC_BUDGET} resyncs in a minute (${s.refused} more refused); showing the last good state, asking once a minute`;
  }

  start(): void {
    this.hub.start();
    if (this.fallback && !this.watch) this.watch = setInterval(() => this.watchFallback(), WATCH_MS);
  }

  stop(): void {
    clearInterval(this.watch);
    this.watch = undefined;
    this.hub.stop();
  }

  /** Silence or a closed opener ends the fallback bus (tests call this directly). */
  watchFallback(now = Date.now()): void {
    if (this.bus !== 'fallback' || !this.fallback) return;
    if (!this.fallback.available) this.leaveFallback('opener closed');
    else if (now - this.fallback.lastTraffic >= FALLBACK_SILENCE_MS) this.leaveFallback('operator silent');
  }

  sendHealth(h: OutputHealth): void {
    const health = { ...h, bus: this.bus === 'fallback' ? ('fallback' as const) : ('hub' as const) };
    const resyncError = this.resyncError;
    if (resyncError && !health.error) health.error = resyncError.slice(0, 300);
    this.hub.send({ t: 'health', health });
    if (this.bus === 'fallback') this.fallback?.sendHealth(health);
  }

  /**
   * Send a live event (outputs only send media.ended / audio.ended). While the operator is the authority
   * (fallback bus) it goes to the operator, otherwise to the hub. With no bus up it is queued and sent
   * when one comes up; recent events are resent on a bus change (both sides de-duplicate by id).
   */
  sendEvent(event: OutputEvent): void {
    const id = `${this.outputId}-${event.k}-${event.cueIndex}-${event.at}`;
    const now = Date.now();
    this.recentEvents = this.recentEvents.filter((e) => now - e.at < EVENT_KEEP_MS && e.id !== id);
    const rec = { id, event, at: now, sent: false };
    this.recentEvents.push(rec);
    if (this.recentEvents.length > EVENT_KEEP_MAX) this.recentEvents.shift();
    this.deliver(rec);
  }

  /** Events not yet delivered to any bus (for tests and diagnostics). */
  get queuedEvents(): number {
    return this.recentEvents.filter((e) => !e.sent).length;
  }

  private deliver(rec: { id: string; event: OutputEvent; sent: boolean }): boolean {
    let ok = false;
    if (this.bus === 'fallback' && this.fallback) ok = this.fallback.sendEvent(rec.event, rec.id);
    else if (this.bus === 'hub') ok = this.hub.send({ t: 'live.event', id: rec.id, event: rec.event });
    if (ok) rec.sent = true;
    return ok;
  }

  private flushEvents(): void {
    const now = Date.now();
    this.recentEvents = this.recentEvents.filter((e) => now - e.at < EVENT_KEEP_MS);
    for (const rec of this.recentEvents) this.deliver(rec);
  }

  private leaveFallback(reason: string): void {
    clock.fallback = false;
    // A held window keeps its picture: it does not ask the hub for a state it would not apply.
    this.setBus(this.hub.connected && !this.held ? 'hub' : 'none', reason);
    if (!this.held) this.hub.send({ t: 'live.resync' });
  }

  private setBus(b: Bus, reason?: string): void {
    if (this.bus === b) return;
    this.bus = b;
    this.emit('bus', { bus: b, reason });
    if (b !== 'none') this.flushEvents();
  }
}
