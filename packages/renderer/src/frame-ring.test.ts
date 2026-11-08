import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_SLOTS, type VideoFrames } from './compositor.ts';
import { FRAME_RING_DEPTH, FRAME_SYNC_WINDOW_MS, FrameRing, mediaLag, vframeClock } from './frame-ring.ts';

/**
 * Frame selection by media time (design/27 §7.2): the newest frame whose timestamp is due on the vsync
 * being drawn, a 2-deep ring per slot, and every VideoFrame closed exactly once (fake frames count it).
 */

const FRAME_MS = 1000 / 60;
/** 30 fps clip: one frame every 33.3 ms of media time. */
const CLIP_MS = 1000 / 30;

type Fake = { id: string; timestamp: number; closes: number; close(): void };

class Frames {
  readonly made: Fake[] = [];
  make(id: string, mediaMs: number): VideoFrame {
    const f: Fake = {
      id,
      timestamp: Math.round(mediaMs * 1000),
      closes: 0,
      close() {
        f.closes++;
      },
    };
    this.made.push(f);
    return f as unknown as VideoFrame;
  }
  get open(): Fake[] {
    return this.made.filter((f) => f.closes === 0);
  }
  /** Frames closed more than once (a double close hides a use after close). */
  get overClosed(): Fake[] {
    return this.made.filter((f) => f.closes > 1);
  }
}

function setup() {
  const video: VideoFrames = {
    frames: Array.from({ length: MAX_VIDEO_SLOTS }, () => null),
    version: new Int32Array(MAX_VIDEO_SLOTS),
    gen: new Int32Array(MAX_VIDEO_SLOTS).fill(-1),
  };
  const ring = new FrameRing(video);
  const fr = new Frames();
  const shown = (slot = 2) => (video.frames[slot] as unknown as Fake | null)?.id ?? null;
  return { video, ring, fr, shown };
}

/** Hub time `now` such that the media time due on the vsync drawn then is `mediaMs`. */
const nowFor = (startedAt: number, mediaMs: number) => startedAt + mediaMs - FRAME_MS / 2;

describe('mediaLag', () => {
  it('wraps a difference into half a loop either side, and leaves it alone without a loop', () => {
    expect(mediaLag(30, 0)).toBe(30);
    expect(mediaLag(-9_000, 0)).toBe(-9_000);
    expect(mediaLag(9_990, 10_000)).toBeCloseTo(-10);
    expect(mediaLag(-9_990, 10_000)).toBeCloseTo(10);
    expect(mediaLag(30_020, 10_000)).toBeCloseTo(20);
    expect(mediaLag(20, 10_000)).toBe(20);
  });
});

describe('vframeClock', () => {
  const el = (paused: boolean, loop: boolean, duration: number) => ({ paused, loop, duration });
  it('sends a clock only while the element plays its transport', () => {
    expect(vframeClock(el(true, false, 10), 1000)).toEqual({});
    expect(vframeClock(el(false, false, 10), Number.NaN)).toEqual({});
    expect(vframeClock(el(false, false, 10), 1000)).toEqual({ startedAt: 1000 });
    expect(vframeClock(el(false, true, 10), 1000)).toEqual({ startedAt: 1000, loopMs: 10_000 });
    // A looping element whose length is not known yet cannot wrap the clock.
    expect(vframeClock(el(false, true, Number.NaN), 1000)).toEqual({ startedAt: 1000 });
    expect(vframeClock(el(false, true, Number.POSITIVE_INFINITY), 1000)).toEqual({ startedAt: 1000 });
  });
});

describe('FrameRing selection', () => {
  const T0 = 50_000; // hub time of media time 0

  it('presents the newest frame without a clock (paused, not started), and records its generation', () => {
    const { ring, fr, video, shown } = setup();
    ring.push(2, fr.make('a', 1000), 7, Number.NaN, 0, 0, FRAME_MS);
    expect(shown()).toBe('a');
    expect(video.gen[2]).toBe(7);
    expect(video.version[2]).toBe(1);
    // A later frame that the paused element shows (a seek) replaces it at once, however "early" it is.
    ring.push(2, fr.make('b', 5000), 7, Number.NaN, 0, 0, FRAME_MS);
    expect(shown()).toBe('b');
    ring.select(0, FRAME_MS);
    expect(shown()).toBe('b');
    expect(video.version[2]).toBe(2);
    // Other slots are untouched.
    expect(video.frames[0]).toBeNull();
    expect(video.gen[0]).toBe(-1);
  });

  it('presents a single frame whatever the clock says (the first frame before the start time)', () => {
    const { ring, fr, shown } = setup();
    ring.push(2, fr.make('first', 0), 1, T0, 0, T0 - 3000, FRAME_MS);
    expect(shown()).toBe('first');
    ring.select(T0 - 2000, FRAME_MS);
    expect(shown()).toBe('first');
  });

  it('holds a frame that arrives early back until its vsync (the half-frame rule of flipDue)', () => {
    const { ring, fr, shown, video } = setup();
    const a = 1000;
    const b = a + CLIP_MS;
    ring.push(2, fr.make('a', a), 1, T0, 0, nowFor(T0, a), FRAME_MS);
    ring.push(2, fr.make('b', b), 1, T0, 0, nowFor(T0, a + 5), FRAME_MS);
    // b arrived 28 ms of media time before it is due: a stays on screen.
    expect(shown()).toBe('a');
    const v = video.version[2];
    ring.select(nowFor(T0, b) - 1, FRAME_MS);
    expect(shown()).toBe('a');
    expect(video.version[2]).toBe(v);
    // Due on this vsync: now + frameMs/2 >= startedAt + timestamp.
    ring.select(nowFor(T0, b), FRAME_MS);
    expect(shown()).toBe('b');
    expect(video.version[2]).toBe(v! + 1);
  });

  it('presents the older frame while both are early (an element ahead of hub time by more than a frame)', () => {
    const { ring, fr, shown } = setup();
    ring.push(2, fr.make('a', 2000), 1, T0, 0, nowFor(T0, 1950), FRAME_MS);
    ring.push(2, fr.make('b', 2000 + CLIP_MS), 1, T0, 0, nowFor(T0, 1960), FRAME_MS);
    expect(shown()).toBe('a');
    ring.select(nowFor(T0, 2000), FRAME_MS);
    expect(shown()).toBe('a');
    ring.select(nowFor(T0, 2034), FRAME_MS);
    expect(shown()).toBe('b');
  });

  it('presents the newest of late frames and never the older one (an element behind hub time)', () => {
    const { ring, fr, shown } = setup();
    // The element runs 120 ms behind: every frame is already due when it arrives.
    let t = 3000;
    ring.push(2, fr.make('f0', t), 1, T0, 0, nowFor(T0, t + 120), FRAME_MS);
    for (let i = 1; i <= 5; i++) {
      t += CLIP_MS;
      ring.push(2, fr.make(`f${i}`, t), 1, T0, 0, nowFor(T0, t + 120), FRAME_MS);
      expect(shown()).toBe(`f${i}`);
      ring.select(nowFor(T0, t + 125), FRAME_MS);
      expect(shown()).toBe(`f${i}`);
    }
    // The ring holds two: the four older frames were closed as newer ones arrived.
    expect(fr.open.map((f) => f.id)).toEqual(['f4', 'f5']);
    expect(fr.made.slice(0, 4).every((f) => f.closes === 1)).toBe(true);
  });

  it('shows the frames after a restart at once (a backward seek), never the frame from before it', () => {
    const { ring, fr, shown } = setup();
    ring.push(2, fr.make('at50s', 50_000), 1, T0, 0, nowFor(T0, 50_000), FRAME_MS);
    // Shift+F8: the transport restarts at T1 and the element seeks to 0; its first frame is a little early.
    const T1 = T0 + 60_000;
    ring.push(2, fr.make('at0', 0), 1, T1, 0, nowFor(T1, -10), FRAME_MS);
    expect(shown()).toBe('at0');
    ring.select(nowFor(T1, 0), FRAME_MS);
    expect(shown()).toBe('at0');
  });

  it('shows the newest frame when the clock does not describe the element (a seek it has not caught up with)', () => {
    const { ring, fr, shown } = setup();
    ring.push(2, fr.make('at10s', 10_000), 1, T0, 0, nowFor(T0, 10_000), FRAME_MS);
    // The element jumped to 40 s while the frame's clock still says 10 s: far outside the sync window.
    ring.push(2, fr.make('at40s', 40_000), 1, T0, 0, nowFor(T0, 10_020), FRAME_MS);
    expect(shown()).toBe('at40s');
    // A forward seek close to the clock: the older frame is behind by more than the window, never shown.
    const { ring: r2, fr: fr2, shown: shown2 } = setup();
    r2.push(2, fr2.make('old', 1000), 1, T0, 0, nowFor(T0, 1000), FRAME_MS);
    r2.push(2, fr2.make('new', 1400), 1, T0, 0, nowFor(T0, 1390), FRAME_MS);
    expect(shown2()).toBe('new');
    expect(FRAME_SYNC_WINDOW_MS).toBeLessThan(390);
  });

  it('times frames across a loop wrap by the media time modulo the clip length', () => {
    const { ring, fr, shown } = setup();
    const L = 10_000;
    const last = L - CLIP_MS;
    // Three loops in: the element wraps 10 ms early.
    const start = T0 - 3 * L;
    ring.push(2, fr.make('last', last), 1, start, L, nowFor(start, 3 * L + last), FRAME_MS);
    ring.push(2, fr.make('first', 0), 1, start, L, nowFor(start, 3 * L + L - 10), FRAME_MS);
    expect(shown()).toBe('last');
    ring.select(nowFor(start, 4 * L - 1), FRAME_MS);
    expect(shown()).toBe('last');
    ring.select(nowFor(start, 4 * L), FRAME_MS);
    expect(shown()).toBe('first');
    // Wrapped late: the first frame of the new loop is due at once, the last of the old one is not shown.
    const { ring: r2, fr: fr2, shown: shown2 } = setup();
    r2.push(2, fr2.make('last', last), 1, start, L, nowFor(start, 3 * L + last), FRAME_MS);
    r2.push(2, fr2.make('first', 0), 1, start, L, nowFor(start, 4 * L + 40), FRAME_MS);
    expect(shown2()).toBe('first');
    // Without the loop length the same pair would look like a seek back: the newest shows too.
    const { ring: r3, fr: fr3, shown: shown3 } = setup();
    r3.push(2, fr3.make('last', last), 1, start, 0, nowFor(start, 3 * L + last), FRAME_MS);
    r3.push(2, fr3.make('first', 0), 1, start, 0, nowFor(start, 4 * L - 10), FRAME_MS);
    expect(shown3()).toBe('first');
  });

  it('presents the newest frame once paused, even an early one', () => {
    const { ring, fr, shown } = setup();
    ring.push(2, fr.make('a', 1000), 1, T0, 0, nowFor(T0, 1000), FRAME_MS);
    ring.push(2, fr.make('b', 1000 + CLIP_MS), 1, T0, 0, nowFor(T0, 1010), FRAME_MS);
    expect(shown()).toBe('a');
    // Paused (F8) and seeked to its position: the frame comes without a clock.
    ring.push(2, fr.make('paused', 1000 + 2 * CLIP_MS), 1, Number.NaN, 0, nowFor(T0, 1010), FRAME_MS);
    expect(shown()).toBe('paused');
    ring.select(nowFor(T0, 900), FRAME_MS);
    expect(shown()).toBe('paused');
  });

  it('drops the frames of an earlier generation as soon as a frame of the reloaded slot arrives', () => {
    const { ring, fr, shown, video } = setup();
    ring.push(2, fr.make('a1', 1000), 4, T0, 0, nowFor(T0, 1000), FRAME_MS);
    ring.push(2, fr.make('a2', 1000 + CLIP_MS), 4, T0, 0, nowFor(T0, 1000), FRAME_MS);
    expect(shown()).toBe('a1');
    // Another clip loaded into the slot (generation 5), its first frame early by its own clock.
    ring.push(2, fr.make('b0', 0), 5, T0 + 5000, 0, T0 + 4000, FRAME_MS);
    expect(shown()).toBe('b0');
    expect(video.gen[2]).toBe(5);
    expect(fr.open.map((f) => f.id)).toEqual(['b0']);
    expect(ring.size).toBe(1);
  });

  it('clears a slot (vclear): closes its frames and presents nothing', () => {
    const { ring, fr, shown, video } = setup();
    ring.push(2, fr.make('a', 0), 3, Number.NaN, 0, 0, FRAME_MS);
    ring.push(2, fr.make('b', 40), 3, Number.NaN, 0, 0, FRAME_MS);
    ring.push(3, fr.make('c', 0), 1, Number.NaN, 0, 0, FRAME_MS);
    ring.clear(2);
    expect(shown()).toBeNull();
    expect(video.gen[2]).toBe(-1);
    expect(shown(3)).toBe('c');
    expect(fr.open.map((f) => f.id)).toEqual(['c']);
    ring.clear(2);
    ring.clear(-1);
    ring.clear(MAX_VIDEO_SLOTS);
    expect(fr.overClosed).toEqual([]);
    ring.release();
    expect(fr.open).toEqual([]);
    expect(shown(3)).toBeNull();
  });

  it('closes a frame for a slot that does not exist, and keeps a frame posted twice only once', () => {
    const { ring, fr, shown } = setup();
    ring.push(MAX_VIDEO_SLOTS, fr.make('x', 0), 1, Number.NaN, 0, 0, FRAME_MS);
    ring.push(-1, fr.make('y', 0), 1, Number.NaN, 0, 0, FRAME_MS);
    ring.push(1.5, fr.make('z', 0), 1, Number.NaN, 0, 0, FRAME_MS);
    expect(fr.made.map((f) => f.closes)).toEqual([1, 1, 1]);
    const a = fr.make('a', 0);
    ring.push(2, a, 1, Number.NaN, 0, 0, FRAME_MS);
    ring.push(2, a, 1, Number.NaN, 0, 0, FRAME_MS);
    expect(shown()).toBe('a');
    expect(ring.size).toBe(1);
    ring.push(2, fr.make('b', 40), 1, Number.NaN, 0, 0, FRAME_MS);
    ring.push(2, fr.make('c', 80), 1, Number.NaN, 0, 0, FRAME_MS);
    expect(fr.made.find((f) => f.id === 'a')!.closes).toBe(1);
    ring.release();
    expect(fr.open).toEqual([]);
    expect(fr.overClosed).toEqual([]);
  });
});

describe('FrameRing leak accounting', () => {
  type Op =
    | { k: 'push'; slot: number; mediaMs: number; gen: number; clock: boolean; loop: boolean }
    | { k: 'clear'; slot: number }
    | { k: 'select'; dt: number };
  const op: fc.Arbitrary<Op> = fc.oneof(
    {
      arbitrary: fc.record({
        k: fc.constant('push' as const),
        slot: fc.integer({ min: -1, max: MAX_VIDEO_SLOTS }),
        mediaMs: fc.double({ min: -100, max: 20_000, noNaN: true }),
        gen: fc.integer({ min: 0, max: 1 }),
        clock: fc.boolean(),
        loop: fc.boolean(),
      }),
      weight: 6,
    },
    {
      arbitrary: fc.record({ k: fc.constant('clear' as const), slot: fc.integer({ min: -1, max: 4 }) }),
      weight: 1,
    },
    {
      arbitrary: fc.record({
        k: fc.constant('select' as const),
        dt: fc.double({ min: 0, max: 400, noNaN: true }),
      }),
      weight: 3,
    },
  );

  it('opens and closes every frame exactly once, holds at most two per slot, and never presents a closed one', () => {
    fc.assert(
      fc.property(fc.array(op, { minLength: 10, maxLength: 150, size: 'max' }), (ops) => {
        const { ring, fr, video } = setup();
        let now = 1_000_000;
        let n = 0;
        for (const o of ops) {
          if (o.k === 'push')
            ring.push(
              o.slot,
              fr.make(`f${n++}`, o.mediaMs),
              o.gen,
              o.clock ? now - 5000 : Number.NaN,
              o.loop ? 10_000 : 0,
              now,
              FRAME_MS,
            );
          else if (o.k === 'clear') ring.clear(o.slot);
          else ring.select((now += o.dt), FRAME_MS);
          // Every presented frame is open; open frames are exactly those held, at most two per slot.
          for (let s = 0; s < MAX_VIDEO_SLOTS; s++) {
            const f = video.frames[s] as unknown as Fake | null;
            if (f) expect(f.closes).toBe(0);
            expect(video.gen[s] === -1).toBe(f === null);
          }
          expect(fr.open.length).toBe(ring.size);
          expect(ring.size).toBeLessThanOrEqual(MAX_VIDEO_SLOTS * FRAME_RING_DEPTH);
          expect(fr.overClosed).toEqual([]);
        }
        ring.release();
        expect(fr.made.every((f) => f.closes === 1)).toBe(true);
        expect(video.frames.every((f) => f === null)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
