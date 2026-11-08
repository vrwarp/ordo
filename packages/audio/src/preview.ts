import { dbToGain } from './math.ts';
import type { SinkAudioContext } from './engine.ts';

/** Operator-side audition on a separate device; never touches the house device. */
export class PreviewPlayer {
  private deviceId?: string;
  private ctx: SinkAudioContext | null = null;
  private el: HTMLAudioElement | null = null;
  private gain: GainNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private _playing = false;
  /** Called when playback starts, ends or stops. */
  onChange?: (playing: boolean) => void;

  constructor(deviceId?: string) {
    this.deviceId = deviceId || undefined;
  }

  /** Change the preview device. Takes effect immediately when the context is open. */
  setDevice(deviceId?: string): void {
    const next = deviceId || undefined;
    if (next === this.deviceId) return;
    this.deviceId = next;
    const ctx = this.ctx;
    if (ctx?.setSinkId) {
      ctx.setSinkId(next ?? '').catch(() => {
        // The preview device is gone: stop rather than play on another device.
        this.stop();
        void ctx.close().catch(() => {});
        if (this.ctx === ctx) this.reset();
      });
    } else if (ctx) {
      this.stop();
      void ctx.close().catch(() => {});
      this.reset();
    }
  }

  private reset() {
    this.ctx = null;
    this.el = null;
    this.gain = null;
    this.source = null;
  }

  private async ensure(): Promise<{ ctx: SinkAudioContext; el: HTMLAudioElement; gain: GainNode }> {
    if (this.ctx && this.el && this.gain) return { ctx: this.ctx, el: this.el, gain: this.gain };
    const id = this.deviceId;
    let ctx: SinkAudioContext;
    try {
      const opts: Record<string, unknown> = { latencyHint: 'interactive' };
      if (id) opts.sinkId = id;
      ctx = new AudioContext(opts as AudioContextOptions) as SinkAudioContext;
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' }) as SinkAudioContext;
      if (id) {
        if (!ctx.setSinkId) {
          void ctx.close();
          throw new Error('this browser cannot select the preview device');
        }
        try {
          await ctx.setSinkId(id);
        } catch (e) {
          void ctx.close();
          throw new Error(`preview device unavailable: ${(e as Error).message}`);
        }
      }
    }
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.addEventListener('ended', () => this.setPlaying(false));
    el.addEventListener('pause', () => this.setPlaying(false));
    el.addEventListener('playing', () => this.setPlaying(true));
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    this.ctx = ctx;
    this.el = el;
    this.gain = gain;
    this.source = source;
    return { ctx, el, gain };
  }

  private setPlaying(p: boolean) {
    if (this._playing === p) return;
    this._playing = p;
    this.onChange?.(p);
  }

  async play(url: string, gainDb = 0): Promise<void> {
    const { ctx, el, gain } = await this.ensure();
    gain.gain.value = dbToGain(gainDb);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    el.pause();
    el.src = url;
    el.currentTime = 0;
    await el.play();
  }

  stop(): void {
    const el = this.el;
    if (!el) return;
    el.pause();
    el.removeAttribute('src');
    el.load();
    this.setPlaying(false);
  }

  get playing(): boolean {
    return this._playing;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => {});
    this.source?.disconnect();
    this.reset();
  }
}
