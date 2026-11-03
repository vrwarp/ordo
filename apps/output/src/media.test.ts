import { describe, expect, it } from 'vitest';
import { MediaSlot, SlotPair } from './media.ts';

/**
 * MediaSlot on a fake <video>: the element never loads by itself; the test fires its events. Covers the
 * retry after a failed load (review item 10) and the slot pair's pick rules.
 */

class FakeVideo extends EventTarget {
  tagName = 'VIDEO';
  src = '';
  readyState = 0;
  currentTime = 0;
  duration = Number.NaN;
  loop = false;
  muted = true;
  paused = true;
  preload = '';
  crossOrigin = '';
  playsInline = false;
  disablePictureInPicture = false;
  videoWidth = 0;
  error: { message: string; code: number } | null = null;
  loads = 0;
  load(): void {
    this.loads++;
  }
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

function slot(id = 0) {
  const el = new FakeVideo();
  const errors: string[] = [];
  const s = new MediaSlot(id, el as unknown as HTMLMediaElement, {
    hubNow: () => Date.now(),
    getBlob: async () => undefined,
    fileUrl: (h) => `/files/${h}`,
    onError: (_s, e) => errors.push(e),
  });
  return { s, el, errors };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('MediaSlot load retry (review item 10)', () => {
  it('forgets a failed load so the next arm of the same key tries again', async () => {
    const { s, el, errors } = slot();
    const p1 = s.load('md|1|v|h', 'h', false, true);
    const caught = p1.catch((e: Error) => e.message);
    await tick();
    expect(el.loads).toBe(1);
    el.error = { message: 'PIPELINE_ERROR_READ: slow NAS', code: 2 };
    el.dispatchEvent(new Event('error'));
    expect(await caught).toContain('slow NAS');
    await tick();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(s.failedLoads).toBe(1);
    expect(s.ready).toBe(false);
    expect(s.key).toBe('md|1|v|h'); // the slot still answers for the key (arm bookkeeping)

    // Second arm of the same key: a fresh load, not the cached rejection.
    const p2 = s.load('md|1|v|h', 'h', false, true);
    expect(p2).not.toBe(p1);
    await tick();
    expect(el.loads).toBe(2);
    el.readyState = 4;
    el.dispatchEvent(new Event('canplaythrough'));
    await p2;
    expect(s.ready).toBe(true);
    expect(s.error).toBeUndefined();
    expect(s.failedLoads).toBe(0);
  });

  it('shares a load in progress for the same key and restarts for a new key', async () => {
    const { s, el } = slot();
    const p1 = s.load('k1', 'h1', false, true);
    expect(s.load('k1', 'h1', false, true)).toBe(p1);
    const p2 = s.load('k2', 'h2', true, true);
    expect(p2).not.toBe(p1);
    await tick();
    expect(el.loop).toBe(true);
    await p1; // the superseded load resolves quietly
    el.readyState = 4;
    el.dispatchEvent(new Event('canplay'));
    await p2;
    expect(s.key).toBe('k2');
    expect(s.ready).toBe(true);
  });

  it('resolves at once when the element already has enough data', async () => {
    const { s, el } = slot();
    el.readyState = 3;
    await s.load('k', 'h', false, true);
    expect(s.ready).toBe(true);
    expect(s.loading).toBeDefined();
  });
});

describe('SlotPair.pick', () => {
  it('prefers the slot holding the key, else a free, not busy, unprotected slot', () => {
    const a = slot(0).s;
    const b = slot(1).s;
    const pair = new SlotPair([a, b]);
    expect(pair.pick('x', [], 0)).toBe(a);
    a.key = 'live';
    expect(pair.pick('live', ['live'], 0)).toBe(a);
    expect(pair.pick('next', ['live'], 0)).toBe(b);
    b.key = 'old';
    b.busyUntil = 100;
    expect(pair.pick('next', ['live'], 50)).toBeUndefined();
    expect(pair.pick('next', ['live'], 100)).toBe(b);
  });
});
