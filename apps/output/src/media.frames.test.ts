import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaSlot } from './media.ts';

/**
 * MediaSlot frame delivery for clips playing inside a slide (design/27 §7.2): `hideFrames` (the host's
 * `vclear`) clears the renderer's frame after every frame already delivered and delivers no frame of the
 * hidden key until it plays or another key loads. Fake <video> and VideoFrame; the test fires the events.
 */

class FakeVideo extends EventTarget {
  tagName = 'VIDEO';
  src = '';
  readyState = 0;
  currentTime = 0;
  duration = 10;
  loop = false;
  muted = true;
  paused = true;
  preload = '';
  crossOrigin = '';
  playsInline = false;
  disablePictureInPicture = false;
  videoWidth = 0;
  error: { message: string; code: number } | null = null;
  load(): void {}
  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  removeAttribute(): void {
    this.src = '';
  }
  requestVideoFrameCallback(): number {
    return 1;
  }
  cancelVideoFrameCallback(): void {}
}

class FakeFrame {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

function slot() {
  const el = new FakeVideo();
  const frames: FakeFrame[] = [];
  const clears: number[] = [];
  const s = new MediaSlot(2, el as unknown as HTMLMediaElement, {
    hubNow: () => Date.now(),
    getBlob: async () => undefined,
    fileUrl: (h) => `/files/${h}`,
    onFrame: (_slot, f) => frames.push(f as unknown as FakeFrame),
    onClearFrame: (id) => clears.push(id),
  });
  /** Load `key` to its first frame (the element is ready at once). */
  const load = async (key: string) => {
    el.readyState = 4;
    el.videoWidth = 2;
    await s.load(key, `h-${key}`, false, true);
  };
  return { s, el, frames, clears, load };
}

const playing = (startedAt = Date.now()) => ({
  state: 'playing' as const,
  startedAt,
  positionMs: 0,
  loop: false,
});
const paused = { state: 'paused' as const, startedAt: 0, positionMs: 0, loop: false };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MediaSlot hideFrames (vclear)', () => {
  beforeEach(() => {
    vi.stubGlobal('VideoFrame', FakeFrame);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears the delivered frame once and delivers none of the key until it plays', async () => {
    const t = slot();
    await t.load('k1');
    expect(t.frames).toHaveLength(1);
    t.s.hideFrames('k1');
    expect(t.clears).toEqual([2]);
    // Nothing delivered since: no second clear; a resend (render restart) delivers nothing.
    t.s.hideFrames('k1');
    t.s.resendFrame();
    expect(t.clears).toEqual([2]);
    expect(t.frames).toHaveLength(1);
    // A paused transport keeps it hidden; playing lifts it.
    t.s.apply(paused);
    t.s.resendFrame();
    expect(t.frames).toHaveLength(1);
    t.s.apply(playing());
    t.s.resendFrame();
    expect(t.frames).toHaveLength(2);
    t.s.hideFrames('k1');
    expect(t.clears).toEqual([2, 2]);
  });

  it('a hide sent before its key reaches the slot holds for that load; another key lifts it', async () => {
    const t = slot();
    await t.load('k0');
    // The link hides k1 before its load command arrives: the previous key's frame is cleared too.
    t.s.hideFrames('k1');
    expect(t.clears).toEqual([2]);
    await t.load('k1');
    expect(t.frames).toHaveLength(1); // only k0's first frame
    await t.load('k2');
    expect(t.frames).toHaveLength(2);
    // k1 loaded again later is not hidden any more.
    await t.load('k1');
    expect(t.frames).toHaveLength(3);
  });

  it('a hide at a hub time waits for it, and a later load or transport cancels it', async () => {
    const t = slot();
    await t.load('k1');
    t.s.hideFrames('k1', Date.now() + 40);
    expect(t.clears).toEqual([]);
    await wait(70);
    expect(t.clears).toEqual([2]);
    // Cancelled by the clip playing again (re-entering its slide) ...
    t.s.apply(playing(Date.now() + 1));
    t.s.resendFrame();
    t.s.hideFrames('k1', Date.now() + 40);
    t.s.apply(playing(Date.now() + 2));
    await wait(70);
    expect(t.clears).toEqual([2]);
    // ... and by another load of the slot.
    t.s.hideFrames('k1', Date.now() + 40);
    await t.load('k2');
    await wait(70);
    expect(t.clears).toEqual([2]);
    expect(t.frames.length).toBeGreaterThanOrEqual(3);
  });
});
