/**
 * The venue's live summary as the compact layout reads it (lib/venueLive.ts; design/28 §2.2): its status is
 * 'unknown' before the first answer, 'ok' after one and 'failing' after two failed polls in a row (the Live now
 * strip's "can't reach ordo"); a poll can be asked for at once (pageshow, online); stopping forgets it all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers: (() => unknown)[] = [];
vi.mock('@ordo/client', () => ({
  api: vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error('no answer queued');
    return next();
  }),
}));

const { pollVenueLiveNow, useVenueLive, VENUE_FAILS, watchVenueLive } = await import(
  '../src/lib/venueLive.ts'
);

const live = (seq: number) => () => ({
  seq,
  mode: 'live',
  playlistId: 'p1',
  playlistName: 'Sunday Service',
  liveLabel: 'Amazing grace how sweet the sound',
  lockedPresentationIds: ['b', 'a'],
});
const fail = () => () => {
  throw Object.assign(new Error('unreachable'), { status: 0 });
};

beforeEach(() => {
  vi.useFakeTimers();
  answers.length = 0;
  (globalThis as { document?: unknown }).document = {
    hidden: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
});

describe('watchVenueLive status', () => {
  it('unknown, then ok, failing after two failures in a row, ok again; stop resets it', async () => {
    expect(useVenueLive.getState().status).toBe('unknown');
    answers.push(live(1), fail(), live(1), fail(), fail(), live(2));
    const stop = watchVenueLive('edit', 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(useVenueLive.getState()).toMatchObject({ status: 'ok', seq: 1 });
    expect(useVenueLive.getState().live).toMatchObject({
      playlistName: 'Sunday Service',
      presentationIds: ['a', 'b'],
    });
    await vi.advanceTimersByTimeAsync(1000);
    // One failure keeps the last answer and its status.
    expect(useVenueLive.getState().status).toBe('ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVenueLive.getState().status).toBe('ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVenueLive.getState().status).toBe('ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(VENUE_FAILS).toBe(2);
    expect(useVenueLive.getState().status).toBe('failing');
    // The last known plan stays (the iPad's lock keeps working); the strip says it cannot tell.
    expect(useVenueLive.getState().live?.playlistName).toBe('Sunday Service');
    answers.splice(0, answers.length, live(2));
    pollVenueLiveNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(useVenueLive.getState()).toMatchObject({ status: 'ok', seq: 2 });
    stop();
    expect(useVenueLive.getState()).toMatchObject({ status: 'unknown', seq: -1, live: undefined });
    // No watch: asking for a poll does nothing.
    answers.push(fail());
    pollVenueLiveNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(1);
  });

  it('a 401 (the hub refused the session) asks who this is at once and never reads as unreachable', async () => {
    // Before: a PIN change read as "Live status unknown: can't reach ordo" for 10 to 15 s, until the socket's
    // refusal brought up the sign-in.
    const refused = () => () => {
      throw Object.assign(new Error('Sign in'), { status: 401 });
    };
    answers.push(live(1), refused(), refused(), refused());
    const asked: number[] = [];
    const stop = watchVenueLive('edit', 1000, { onRefused: () => asked.push(Date.now()) });
    await vi.advanceTimersByTimeAsync(0);
    expect(useVenueLive.getState().status).toBe('ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(asked).toHaveLength(3);
    expect(useVenueLive.getState().status).toBe('ok');
    stop();
    // The regular layout (the iPad's chip) counts a 401 as a failure, as before.
    answers.push(live(1), refused(), refused());
    const ipad = watchVenueLive('edit', 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(useVenueLive.getState().status).toBe('failing');
    ipad();
  });
});
