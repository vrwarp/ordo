import type { OutputHealth } from '@ordo/protocol';
import type { LiveState } from '@ordo/domain';
import { Emitter } from './emitter.ts';
import { HubConnection, type RtcSignalIn } from './hub.ts';
import { FallbackClient } from './fallback.ts';
import { LiveMirror } from './mirror.ts';
import { clock } from './clock.ts';
import { appEnv, operatorOrigin as defaultOperatorOrigin } from './env.ts';
import { setApiToken } from './api.ts';
import type { LibraryDelta } from '@ordo/protocol';

/**
 * The live link an output or stage window uses: hub WebSocket normally, the operator's postMessage bus
 * when the operator says the hub is gone. Exposes one mirror of the live state either way.
 */
export class OutputLink extends Emitter<{
  bus: { bus: 'hub' | 'fallback' | 'none' };
  library: LibraryDelta;
  rtc: RtcSignalIn;
}> {
  readonly mirror = new LiveMirror();
  readonly hub: HubConnection;
  readonly fallback?: FallbackClient;
  bus: 'hub' | 'fallback' | 'none' = 'none';
  readonly outputId: string;
  readonly token: string;

  constructor(opts: { role: 'output' | 'stage'; appVersion: string; operatorOrigin?: string }) {
    super();
    const env = appEnv();
    this.outputId = env.outputId ?? 'unknown';
    this.token = env.token ?? '';
    setApiToken(this.token);
    this.hub = new HubConnection({
      role: opts.role,
      appVersion: opts.appVersion,
      outputId: this.outputId,
      token: this.token,
    });
    const operatorOrigin = opts.operatorOrigin ?? defaultOperatorOrigin(env);
    if (typeof window !== 'undefined' && window.opener) {
      try {
        this.fallback = new FallbackClient(operatorOrigin, this.outputId);
      } catch {
        this.fallback = undefined;
      }
    }

    this.hub.on('status', ({ connected }) => {
      if (connected && this.bus !== 'fallback') this.setBus('hub');
      if (!connected && this.bus === 'hub') this.setBus('none');
    });
    this.hub.on('state', (m) => {
      if (this.bus === 'fallback') return;
      this.mirror.applyState(m.state);
    });
    this.hub.on('delta', (m) => {
      if (this.bus === 'fallback') return;
      if (!this.mirror.applyDelta(m)) this.hub.send({ t: 'live.resync' });
    });
    this.hub.on('library', (m) => this.emit('library', m));
    this.hub.on('rtc', (m) => this.emit('rtc', m));

    this.fallback?.on('hello', () => {
      this.setBus('fallback');
      clock.fallback = true;
      this.fallback!.ready(this.mirror.state.seq);
    });
    this.fallback?.on('state', (m) => {
      if (this.bus === 'fallback') this.mirror.applyState(m.state);
    });
    this.fallback?.on('delta', (m) => {
      if (this.bus !== 'fallback') return;
      if (!this.mirror.applyDelta(m)) this.fallback!.ready(this.mirror.state.seq); // ask for a full state
    });
    this.fallback?.on('hub', ({ hubUp }) => {
      if (!hubUp) return;
      clock.fallback = false;
      this.setBus(this.hub.connected ? 'hub' : 'none');
      this.hub.send({ t: 'live.resync' });
    });
  }

  get state(): LiveState {
    return this.mirror.state;
  }

  start(): void {
    this.hub.start();
  }

  sendHealth(h: OutputHealth): void {
    const health = { ...h, bus: this.bus === 'fallback' ? ('fallback' as const) : ('hub' as const) };
    this.hub.send({ t: 'health', health });
    if (this.bus === 'fallback') this.fallback?.sendHealth(health);
  }

  /** Send a live event (outputs only send media.ended / audio.ended). Via hub, else via fallback is not possible: the operator observes health. */
  sendEvent(event: { k: 'media.ended' | 'audio.ended'; cueIndex: number; at: number }): void {
    this.hub.send({
      t: 'live.event',
      id: `${this.outputId}-${event.k}-${event.cueIndex}-${event.at}`,
      event,
    });
  }

  private setBus(b: 'hub' | 'fallback' | 'none'): void {
    if (this.bus === b) return;
    this.bus = b;
    this.emit('bus', { bus: b });
  }
}
