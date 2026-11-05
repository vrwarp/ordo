import type { LiveCommand, LiveEvent, LiveState, ResolvedPlaylist } from '@ordo/domain';
import { autoAdvance, initialState, OptimisticState, reduce } from '@ordo/live-state';
import type { LiveAck, LiveDeltaMsg } from '@ordo/protocol';

/**
 * The operator's live-state authority logic, free of DOM and sockets so it can be tested with fakes.
 *
 * Normal mode: the hub is the authority. Local commands are proposed on an OptimisticState (applied at
 * once) and sent as `live.event`; hub deltas rebase them; a sequence gap triggers a resync.
 *
 * Fallback mode (design/17): when the hub socket has been down for `graceMs` while a service is live, the
 * operator becomes the authority. It applies events with the shared reducer (seq continues from the last
 * hub seq) and broadcasts deltas to the output windows over the fallback bus. When the hub returns it
 * sends `live.adopt` with its state, waits for the hub's full state, then hands authority back.
 *
 * Held service (design/17 "Going live without the hub"): with the hub unreachable the operator may go live
 * itself (`submit(goLive, id, { local: true })`), resolving the playlist from its cached library. It then
 * holds that service to its end: a hub that comes back is neither handed the service nor followed, and
 * the output windows are told to ignore it (`hold`). After End service the authority returns to the hub
 * as soon as it answers.
 */

export type LiveNotice =
  | { kind: 'rejected'; id: string; reason: string; command: LiveCommand }
  | { kind: 'fallback-on' }
  | { kind: 'fallback-off' }
  | { kind: 'hub-newer' }
  | { kind: 'conflict'; hubPlaylist?: string; localPlaylist?: string }
  | { kind: 'unavailable'; reason: string; command: LiveCommand }
  | { kind: 'local-live'; playlist: string }
  | { kind: 'hub-back-held' }
  | { kind: 'held-ended'; hubConnected: boolean };

export type HubOut =
  | { t: 'live.event'; id: string; event: LiveCommand }
  | { t: 'live.resync' }
  | { t: 'live.adopt'; state: LiveState; force?: boolean };

export interface FallbackPort {
  activate(state: LiveState, opts?: { hold?: boolean }): void;
  setHold?(on: boolean): void;
  deactivate(): void;
  broadcastDelta(d: LiveDeltaMsg, state: LiveState): void;
}

export type Timer = unknown;
/** A live event the operator may apply locally (everything except the hub-resolved goLive). */
export type LocalEvent = Exclude<LiveEvent, { k: 'goLive' }>;

export type LiveCoreDeps = {
  sendHub(m: HubOut): boolean;
  fallback: FallbackPort;
  setClockFallback(on: boolean): void;
  newId(): string;
  setTimer(fn: () => void, ms: number): Timer;
  clearTimer(t: Timer): void;
  onChange(): void;
  onNotice(n: LiveNotice): void;
  /** Resolve a playlist from the cached library for a goLive made without the hub (throws a reason). */
  resolveLocal?(playlistId: string): ResolvedPlaylist;
  graceMs?: number;
  adoptTimeoutMs?: number;
  /** Clock for pending-command ageing (default Date.now). */
  now?: () => number;
};

/** Unconfirmed commands older than this are not re-submitted after a reconnect. */
export const PENDING_TTL_MS = 60_000;
const PENDING_MAX = 100;

export type Authority = 'hub' | 'fallback';
export type PendingCommand = { id: string; event: LocalEvent; at: number };
export type Reconcile = null | 'awaitState' | 'adopting' | 'conflict';

export class LiveCore {
  readonly opt: OptimisticState;
  authority: Authority = 'hub';
  hubConnected = false;
  /**
   * The hub refused this operator's credentials (an expired session): the hub is up and the outputs
   * follow it, so its socket being down is not a hub loss and must not arm the fallback grace (review
   * item 5).
   */
  hubRefused = false;
  reconcile: Reconcile = null;
  /** This PC started the live service without the hub and holds it until End service. */
  held = false;
  private heldNoticeGiven = false;
  /**
   * A held service ended and the authority has not yet returned to the hub: whatever the hub holds when it
   * answers (idle, or a service another operator started through it meanwhile) is the truth. Nothing of
   * this PC's is adopted and no conflict is raised: the hub never had the ended service.
   */
  private afterHeld = false;
  /** The hub's state while a conflict dialog is open. */
  conflictHubState?: LiveState;
  private local: LiveState;
  private graceTimer?: Timer;
  private adoptTimer?: Timer;
  private autoTimer?: Timer;
  private awaitingResync = false;
  /**
   * Commands proposed and not yet confirmed by the hub (no delta carrying the id, no ack), whether or
   * not they could be written to the socket. After a reconnect (every full state) they are proposed
   * again and re-sent with their original ids; the hub acknowledges ids it already journalled without
   * applying them twice, so a command caught in a short blip is neither lost nor duplicated (item 13).
   */
  private pending: { id: string; event: LocalEvent; sent: boolean; at: number }[] = [];
  /** Commands applied locally while reconciling; replayed to the hub after adoption. */
  private replay: LocalEvent[] = [];

  constructor(
    private deps: LiveCoreDeps,
    seed?: LiveState,
  ) {
    this.opt = new OptimisticState(seed ?? initialState());
    this.local = this.opt.view;
    if (seed?.mode === 'live') this.armGrace();
  }

  get view(): LiveState {
    return this.authority === 'fallback' ? this.local : this.opt.view;
  }

  get pendingCount(): number {
    return this.authority === 'fallback' ? 0 : this.opt.pendingCount;
  }

  /**
   * Submit a command. Returns its id. `id` may be given by the caller (an action re-sent after a core
   * restart keeps its id, so the hub de-duplicates it).
   */
  submit(command: LiveCommand, givenId?: string, opts: { local?: boolean } = {}): string {
    if (givenId && this.pending.some((p) => p.id === givenId)) return givenId;
    const id = givenId ?? this.deps.newId();
    if (command.k === 'goLive' && opts.local) {
      this.goLiveLocal(command.playlistId, id, command);
      return id;
    }
    if (this.authority === 'fallback') {
      if (command.k === 'goLive') {
        this.deps.onNotice({ kind: 'unavailable', reason: 'The hub is unreachable', command });
        return id;
      }
      this.applyLocal(command, id);
      if (this.reconcile) this.replay.push(command);
      return id;
    }
    if (command.k === 'goLive') {
      // Cannot be applied optimistically: the hub resolves the playlist.
      if (!this.deps.sendHub({ t: 'live.event', id, event: command }))
        this.deps.onNotice({ kind: 'unavailable', reason: 'Not connected to the hub', command });
      return id;
    }
    this.opt.propose(id, command);
    const sent = this.hubConnected && this.deps.sendHub({ t: 'live.event', id, event: command });
    this.pending.push({ id, event: command, sent, at: this.deps.now?.() ?? Date.now() });
    if (this.pending.length > PENDING_MAX) this.pending.shift();
    this.deps.onChange();
    return id;
  }

  /** Unconfirmed commands, persisted so a core restart does not lose them (design/25). */
  pendingCommands(): PendingCommand[] {
    return this.pending.map((p) => ({ id: p.id, event: p.event, at: p.at }));
  }

  /**
   * Restore unconfirmed commands after a core restart: proposed at once (the operator sees them) and
   * re-sent with their original ids on the next full state, so the hub applies each exactly once.
   */
  restorePending(list: PendingCommand[]): void {
    if (this.authority === 'fallback') return;
    const now = this.deps.now?.() ?? Date.now();
    for (const p of list) {
      if (!p || typeof p.id !== 'string' || !p.event || typeof p.event !== 'object') continue;
      if (now - p.at >= PENDING_TTL_MS || this.pending.some((x) => x.id === p.id)) continue;
      if ((p.event as LiveCommand).k === 'goLive') continue;
      this.opt.propose(p.id, p.event);
      this.pending.push({ id: p.id, event: p.event, sent: false, at: p.at });
    }
    if (this.pending.length > PENDING_MAX) this.pending.splice(0, this.pending.length - PENDING_MAX);
    this.deps.onChange();
  }

  /** An event reported by an output over the fallback bus (media.ended / audio.ended). */
  externalEvent(event: LiveEvent): void {
    if (this.authority !== 'fallback') return;
    if (event.k !== 'media.ended' && event.k !== 'audio.ended') return;
    this.applyLocal(event, this.deps.newId());
  }

  onStatus(connected: boolean): void {
    this.hubConnected = connected;
    if (connected) {
      this.clearGrace();
    } else {
      this.reconcile = this.authority === 'fallback' ? null : this.reconcile;
      if (this.authority === 'hub' && this.view.mode === 'live' && !this.hubRefused) this.armGrace();
    }
    this.deps.onChange();
  }

  /**
   * The hub refused (on) or may accept again (off: a new sign-in) this operator's credentials. While
   * refused the fallback grace is neither armed nor running; when cleared and still disconnected, the
   * normal grace applies again.
   */
  setHubRefused(on: boolean): void {
    if (this.hubRefused === on) return;
    this.hubRefused = on;
    if (on) this.clearGrace();
    else if (!this.hubConnected && this.authority === 'hub' && this.view.mode === 'live') this.armGrace();
    this.deps.onChange();
  }

  onWelcome(): void {
    if (this.authority === 'fallback') this.reconcile = this.held ? null : 'awaitState';
  }

  onState(state: LiveState): void {
    if (this.authority === 'fallback') {
      this.reconcileWith(state);
      return;
    }
    this.awaitingResync = false;
    if (!this.opt.replace(state)) {
      // Malformed hub state: keep what we have and ask again.
      this.awaitingResync = true;
      this.deps.sendHub({ t: 'live.resync' });
      return;
    }
    const now = this.deps.now?.() ?? Date.now();
    this.pending = this.pending.filter((p) => now - p.at < PENDING_TTL_MS);
    for (const p of this.pending) {
      this.opt.propose(p.id, p.event);
      p.sent = this.deps.sendHub({ t: 'live.event', id: p.id, event: p.event });
    }
    this.deps.onChange();
  }

  onDelta(m: Pick<LiveDeltaMsg, 'seq' | 'fromSeq' | 'event' | 'id'>): void {
    if (this.authority === 'fallback' || this.awaitingResync) return;
    if (m.seq <= this.opt.confirmed.seq) return; // duplicate
    if (!this.opt.applyDelta(m.fromSeq, m.event, m.id)) {
      this.awaitingResync = true;
      this.deps.sendHub({ t: 'live.resync' });
      return;
    }
    if (m.id) this.pending = this.pending.filter((p) => p.id !== m.id);
    this.deps.onChange();
  }

  onAck(m: Pick<LiveAck, 'id' | 'seq' | 'rejected'>, command?: LiveCommand): void {
    this.pending = this.pending.filter((p) => p.id !== m.id);
    if (m.rejected) {
      this.opt.reject(m.id);
      this.deps.onNotice({
        kind: 'rejected',
        id: m.id,
        reason: m.rejected,
        command: command ?? { k: 'next', at: 0 },
      });
      this.deps.onChange();
      return;
    }
    if (m.seq !== undefined && this.opt.confirmed.seq >= m.seq) {
      this.opt.ack(m.id);
      this.deps.onChange();
    }
  }

  /** The operator answered the conflict dialog. */
  resolveConflict(choice: 'local' | 'hub'): void {
    if (this.reconcile !== 'conflict') return;
    if (choice === 'local') {
      this.adopt(true);
    } else {
      const hub = this.conflictHubState;
      this.conflictHubState = undefined;
      if (hub) this.leaveFallback(hub);
    }
  }

  /** Force fallback now (used by tests and the diagnostics panel). */
  activateFallback(opts: { hold?: boolean; quiet?: boolean } = {}): void {
    if (this.authority === 'fallback') return;
    this.clearGrace();
    this.local = this.opt.view;
    this.pending = [];
    this.authority = 'fallback';
    this.reconcile = null;
    this.deps.setClockFallback(true);
    this.deps.fallback.activate(this.local, { hold: !!opts.hold });
    this.scheduleAuto();
    if (!opts.quiet) this.deps.onNotice({ kind: 'fallback-on' });
    this.deps.onChange();
  }

  /**
   * Resume a held service after a core restart: authority at once, windows told to keep holding. The
   * state is the persisted one (the hub never had it).
   */
  resumeHeld(): void {
    this.held = true;
    this.afterHeld = false;
    this.heldNoticeGiven = false;
    this.activateFallback({ hold: true, quiet: true });
  }

  /**
   * Go live from this PC (the hub is unreachable). Refused while the hub is connected: then the hub
   * resolves the playlist, as always. The resolved copy is built from the cached library.
   */
  private goLiveLocal(playlistId: string, id: string, command: LiveCommand): void {
    if (this.hubConnected) {
      this.deps.onNotice({
        kind: 'unavailable',
        reason: 'The hub is connected: go live through the hub',
        command,
      });
      return;
    }
    if (this.view.mode === 'live') {
      this.deps.onNotice({ kind: 'unavailable', reason: 'A service is live: end it first', command });
      return;
    }
    if (!this.deps.resolveLocal) {
      this.deps.onNotice({ kind: 'unavailable', reason: 'The hub is unreachable', command });
      return;
    }
    let resolved: ResolvedPlaylist;
    try {
      resolved = this.deps.resolveLocal(playlistId);
    } catch (e) {
      this.deps.onNotice({ kind: 'rejected', id, reason: (e as Error).message, command });
      return;
    }
    if (this.authority === 'fallback') this.deps.fallback.setHold?.(true);
    else this.activateFallback({ hold: true, quiet: true });
    this.held = true;
    this.afterHeld = false;
    this.heldNoticeGiven = false;
    this.applyLocal({ k: 'goLive', resolved }, id);
    this.deps.onNotice({ kind: 'local-live', playlist: resolved.playlist.name });
  }

  dispose(): void {
    this.clearGrace();
    if (this.adoptTimer) this.deps.clearTimer(this.adoptTimer);
    if (this.autoTimer) this.deps.clearTimer(this.autoTimer);
  }

  // ---- internals ----

  private armGrace(): void {
    this.clearGrace();
    this.graceTimer = this.deps.setTimer(() => {
      this.graceTimer = undefined;
      if (!this.hubConnected && !this.hubRefused && this.authority === 'hub' && this.view.mode === 'live')
        this.activateFallback();
    }, this.deps.graceMs ?? 5000);
  }

  private clearGrace(): void {
    if (this.graceTimer !== undefined) this.deps.clearTimer(this.graceTimer);
    this.graceTimer = undefined;
  }

  private applyLocal(event: LiveEvent, id: string): void {
    const prev = this.local;
    this.local = reduce(prev, event);
    this.deps.fallback.broadcastDelta(
      { t: 'live.delta', v: 1, seq: this.local.seq, fromSeq: prev.seq, event, id },
      this.local,
    );
    this.scheduleAuto();
    if (this.held && this.local.mode !== 'live') this.releaseHold();
    this.deps.onChange();
  }

  /**
   * The held service ended. The windows may follow the hub again; when the hub is connected the operator
   * asks for its state and hands the authority back (both idle: nothing to transfer), otherwise it stays
   * the authority until the hub returns.
   */
  private releaseHold(): void {
    this.held = false;
    this.afterHeld = true;
    this.deps.fallback.setHold?.(false);
    this.deps.onNotice({ kind: 'held-ended', hubConnected: this.hubConnected });
    if (this.hubConnected) {
      this.reconcile = 'awaitState';
      this.deps.sendHub({ t: 'live.resync' });
    }
  }

  /** Loop presentations auto-advance; while the operator is the authority it must drive that itself. */
  private scheduleAuto(): void {
    if (this.autoTimer !== undefined) this.deps.clearTimer(this.autoTimer);
    this.autoTimer = undefined;
    if (this.authority !== 'fallback') return;
    const due = autoAdvance(this.local);
    if (!due) return;
    const seqAt = this.local.seq;
    this.autoTimer = this.deps.setTimer(
      () => {
        this.autoTimer = undefined;
        if (this.authority === 'fallback' && this.local.seq === seqAt)
          this.applyLocal({ k: 'go', cueIndex: due.target, at: due.dueAt }, this.deps.newId());
      },
      Math.max(0, due.dueAt - Date.now() - 50),
    );
  }

  private reconcileWith(hub: LiveState): void {
    const local = this.local;
    if (this.held) {
      // The hub never had this service and is not given it mid-service: ignore it until End service.
      this.reconcile = null;
      if (!this.heldNoticeGiven) {
        this.heldNoticeGiven = true;
        this.deps.onNotice({ kind: 'hub-back-held' });
      }
      return;
    }
    if (this.afterHeld) {
      this.afterHeld = false;
      this.replay = [];
      this.leaveFallback(hub);
      return;
    }
    if (hub.mode !== 'live' && local.mode !== 'live') {
      // Nothing is live on either side: nothing to transfer.
      this.replay = [];
      this.leaveFallback(hub);
      return;
    }
    if (this.reconcile === 'adopting') {
      if (this.samePlaylist(hub, local) && hub.seq >= local.seq - this.replay.length) {
        this.leaveFallback(hub);
        return;
      }
      this.enterConflict(hub);
      return;
    }
    if (this.reconcile === 'conflict') {
      this.conflictHubState = hub;
      return;
    }
    // awaitState (or a resync while not yet reconciling)
    this.replay = [];
    if (hub.mode !== 'live') {
      this.adopt(false);
    } else if (this.samePlaylist(hub, local)) {
      if (hub.seq < local.seq) this.adopt(false);
      else {
        // Equal seq: nothing changed on either side, so nothing to tell the operator (review item 43).
        if (hub.seq > local.seq) this.deps.onNotice({ kind: 'hub-newer' });
        this.leaveFallback(hub);
      }
    } else {
      this.enterConflict(hub);
    }
  }

  private samePlaylist(a: LiveState, b: LiveState): boolean {
    if (a.mode !== b.mode) return false;
    if (a.mode !== 'live') return true;
    return a.resolved?.playlist.id === b.resolved?.playlist.id;
  }

  private enterConflict(hub: LiveState): void {
    this.reconcile = 'conflict';
    this.conflictHubState = hub;
    this.deps.onNotice({
      kind: 'conflict',
      hubPlaylist: hub.resolved?.playlist.name,
      localPlaylist: this.local.resolved?.playlist.name,
    });
    this.deps.onChange();
  }

  private adopt(force: boolean): void {
    this.reconcile = 'adopting';
    this.replay = [];
    this.deps.sendHub({ t: 'live.adopt', state: this.local, force: force || undefined });
    if (this.adoptTimer) this.deps.clearTimer(this.adoptTimer);
    this.adoptTimer = this.deps.setTimer(() => {
      this.adoptTimer = undefined;
      if (this.authority === 'fallback' && this.reconcile === 'adopting') {
        // No answer: ask for the hub's state again and re-decide.
        this.reconcile = 'awaitState';
        this.deps.sendHub({ t: 'live.resync' });
      }
    }, this.deps.adoptTimeoutMs ?? 5000);
    this.deps.onChange();
  }

  private leaveFallback(hub: LiveState): void {
    if (this.adoptTimer) this.deps.clearTimer(this.adoptTimer);
    this.adoptTimer = undefined;
    if (this.autoTimer) this.deps.clearTimer(this.autoTimer);
    this.autoTimer = undefined;
    const replay = this.replay;
    this.replay = [];
    this.authority = 'hub';
    this.reconcile = null;
    this.conflictHubState = undefined;
    this.opt.replace(hub);
    this.deps.setClockFallback(false);
    this.deps.fallback.deactivate();
    this.deps.onNotice({ kind: 'fallback-off' });
    for (const e of replay) this.submit(e);
    this.deps.onChange();
  }
}
