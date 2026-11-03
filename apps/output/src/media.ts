/**
 * <video> and <audio> elements of an output window, reused per slot (live and armed per layer).
 * Videos are preloaded to their first frame at arm time, started at the flip time, and deliver every
 * presented frame to the render worker as a VideoFrame via requestVideoFrameCallback.
 */

import type { Transport } from './host-protocol.ts';

export type { Transport };

export type MediaHost = {
  hubNow: () => number;
  getBlob: (hash: string) => Promise<Blob | undefined>;
  fileUrl: (hash: string) => string;
  onFrame?: (slot: number, frame: VideoFrame) => void;
  onEnded?: (slot: MediaSlot) => void;
  onError?: (slot: MediaSlot, error: string) => void;
  log?: (msg: string) => void;
};

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export class MediaSlot {
  key = '';
  hash = '';
  /** Increments with every new source, so stale callbacks are ignored. */
  gen = 0;
  url?: string;
  ready = false;
  loading?: Promise<void>;
  /** The slot must not be reassigned before this hub time (it is the outgoing side of a fade). */
  busyUntil = 0;
  transportSig = '';
  error?: string;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private rvfc?: number;

  constructor(
    readonly id: number,
    readonly el: HTMLMediaElement,
    private host: MediaHost,
  ) {
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    if (this.isVideo) {
      const v = el as HTMLVideoElement;
      v.playsInline = true;
      v.disablePictureInPicture = true;
    }
    el.addEventListener('ended', () => {
      if (!this.el.loop) this.host.onEnded?.(this);
    });
    el.addEventListener('error', () => {
      if (!this.key) return;
      this.error = this.el.error?.message || `media error ${this.el.error?.code ?? ''}`;
      this.host.onError?.(this, this.error);
    });
  }

  get isVideo(): boolean {
    return typeof HTMLVideoElement !== 'undefined'
      ? this.el instanceof HTMLVideoElement
      : (this.el as { tagName?: string }).tagName?.toLowerCase() === 'video';
  }

  /** Loads of this slot that failed, for diagnostics; reset when a load succeeds. */
  failedLoads = 0;

  /**
   * Load `hash` under `key` and preload to the first frame. Resolves when the first frame is available.
   * A load in progress or complete for the same key is shared; a failed one is forgotten, so the next
   * arm of that key tries again (review item 10: a slow NAS read must not poison the cue for the service).
   */
  load(key: string, hash: string, loop: boolean, muted: boolean): Promise<void> {
    if (this.key === key && this.loading) return this.loading;
    this.clearTimers();
    this.key = key;
    this.hash = hash;
    this.ready = false;
    this.error = undefined;
    this.transportSig = '';
    const gen = ++this.gen;
    const el = this.el;
    el.pause();
    el.loop = loop;
    el.muted = muted;
    this.loading = (async () => {
      const blob = await this.host.getBlob(hash).catch(() => undefined);
      if (gen !== this.gen) return;
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = blob ? URL.createObjectURL(blob) : undefined;
      el.src = this.url ?? this.host.fileUrl(hash);
      el.load();
      await waitFor(el, ['canplaythrough', 'canplay'], 20_000, () => el.readyState >= 3);
      if (gen !== this.gen) return;
      if (el.currentTime !== 0) {
        el.currentTime = 0;
        await waitFor(el, ['seeked'], 5000);
      }
      if (gen !== this.gen) return;
      this.ready = true;
      if (this.isVideo) {
        this.sendFrame();
        this.startFrameLoop(gen);
      }
    })();
    const loading = this.loading;
    loading.then(
      () => {
        if (gen === this.gen) this.failedLoads = 0;
      },
      (err: Error) => {
        if (gen !== this.gen) return;
        this.failedLoads++;
        this.error = err.message;
        // Forget the rejected promise: the slot keeps the key (so arm bookkeeping still finds it) but the
        // next load() starts over instead of returning the same rejection.
        this.loading = undefined;
        this.ready = false;
        this.host.onError?.(this, err.message);
      },
    );
    return loading;
  }

  /** Stop and forget the current source. */
  unload(): void {
    this.clearTimers();
    this.gen++;
    this.key = '';
    this.hash = '';
    this.ready = false;
    this.loading = undefined;
    this.transportSig = '';
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }

  get srcId(): string {
    return `${this.gen}`;
  }

  /** Apply a transport state; scheduled against hub time. Idempotent for an unchanged state. */
  apply(t: Transport): void {
    const sig = `${t.state}|${t.startedAt}|${t.positionMs}|${t.loop}`;
    if (sig === this.transportSig || !this.ready) return;
    this.transportSig = sig;
    this.clearTimers();
    this.el.loop = t.loop;
    const el = this.el;
    if (t.state === 'playing') {
      const start = () => {
        const dur = Number.isFinite(el.duration) ? el.duration : 0;
        let pos = Math.max(0, (this.host.hubNow() - t.startedAt) / 1000);
        if (dur > 0) pos = t.loop ? pos % dur : Math.min(pos, dur);
        if (Math.abs(el.currentTime - pos) > 0.25) el.currentTime = pos;
        this.play();
      };
      const delay = t.startedAt - this.host.hubNow();
      if (delay > 2) this.timers.push(setTimeout(start, delay));
      else start();
    } else {
      el.pause();
      if (t.state === 'paused') {
        const pos = t.positionMs / 1000;
        if (Math.abs(el.currentTime - pos) > 0.05) el.currentTime = pos;
      }
    }
  }

  /** Pause at hub time `at` (the outgoing side of a cut or a fade). */
  pauseAt(at: number): void {
    this.transportSig = '';
    this.clearTimers();
    const delay = at - this.host.hubNow();
    if (delay > 2) this.timers.push(setTimeout(() => this.el.pause(), delay));
    else this.el.pause();
  }

  play(): void {
    const p = this.el.play();
    p?.catch((err: Error) => {
      if (err.name === 'AbortError') return;
      if (!this.el.muted) {
        // Autoplay with sound refused (no user activation): keep the picture going muted.
        this.host.log?.(`autoplay with sound refused (${err.message}); playing muted until a click`);
        this.el.muted = true;
        this.error = 'audio blocked by autoplay policy: click the output window';
        this.el.play().catch(() => undefined);
      }
    });
  }

  /** Post the current frame again (a restarted render worker has none for a paused video). */
  resendFrame(): void {
    if (this.ready && this.isVideo) this.sendFrame();
  }

  private sendFrame(): void {
    const v = this.el as HTMLVideoElement;
    if (!this.host.onFrame || v.readyState < 2 || !v.videoWidth) return;
    try {
      this.host.onFrame(this.id, new VideoFrame(v, { timestamp: Math.round(v.currentTime * 1e6) }));
    } catch {
      /* frame not available yet */
    }
  }

  private startFrameLoop(gen: number): void {
    const v = this.el as RvfcVideo;
    if (this.rvfc !== undefined) v.cancelVideoFrameCallback?.(this.rvfc);
    if (!v.requestVideoFrameCallback) {
      // Fallback: poll on timeupdate-ish cadence.
      const tick = () => {
        if (gen !== this.gen) return;
        if (!v.paused) this.sendFrame();
        setTimeout(tick, 16);
      };
      tick();
      return;
    }
    const cb = (_now: number, meta: { mediaTime: number }) => {
      if (gen !== this.gen) return;
      if (this.host.onFrame && v.videoWidth) {
        try {
          this.host.onFrame(this.id, new VideoFrame(v, { timestamp: Math.round(meta.mediaTime * 1e6) }));
        } catch {
          /* skip */
        }
      }
      this.rvfc = v.requestVideoFrameCallback!(cb);
    };
    this.rvfc = v.requestVideoFrameCallback(cb);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  droppedFrames(): number {
    const v = this.el as HTMLVideoElement;
    return this.isVideo && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().droppedVideoFrames : 0;
  }
}

function waitFor(
  el: HTMLMediaElement,
  events: string[],
  timeoutMs: number,
  already?: () => boolean,
): Promise<void> {
  if (already?.()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      for (const e of events) el.removeEventListener(e, ok);
      el.removeEventListener('error', fail);
      if (err) reject(err);
      else resolve();
    };
    const ok = () => done();
    const fail = () => done(new Error(el.error?.message || 'media failed to load'));
    const timer = setTimeout(() => {
      // Loaded enough to show the first frame: carry on rather than fail the arm.
      if (el.readyState >= 2) done();
      else done(new Error(`media load timed out (${events.join('/')})`));
    }, timeoutMs);
    for (const e of events) el.addEventListener(e, ok);
    el.addEventListener('error', fail);
  });
}

/**
 * Two slots per layer. Picks the slot for a key: the one already holding it, else one that holds neither
 * the live nor the armed key and is not busy fading out. Generic so the link worker can run the same
 * rules on its mirror of the host's media slots.
 */
export class SlotPair<S extends { key: string; busyUntil: number } = MediaSlot> {
  constructor(readonly slots: [S, S]) {}

  find(key: string): S | undefined {
    return key ? this.slots.find((s) => s.key === key) : undefined;
  }

  pick(key: string, protect: string[], now: number): S | undefined {
    const have = this.find(key);
    if (have) return have;
    const free = this.slots.filter((s) => !protect.includes(s.key) || !s.key);
    const notBusy = free.filter((s) => s.busyUntil <= now);
    return notBusy.find((s) => !s.key) ?? notBusy[0];
  }
}
