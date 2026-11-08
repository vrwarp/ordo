import type { LiveState, MediaContent } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import type { OutputHealthEntry } from '@ordo/protocol';
import { describe, expect, it } from 'vitest';
import { mediaTimes } from '../src/lib/mediaTimes.ts';

function withMedia(p: Partial<MediaContent>): LiveState {
  const s = initialState();
  const content: MediaContent = {
    kind: 'media',
    cueIndex: 0,
    mediaId: 'm',
    mediaKind: 'video',
    loop: false,
    onEnd: 'hold',
    state: 'playing',
    startedAt: 10_000,
    positionMs: 0,
    ...p,
  };
  return { ...s, layers: { ...s.layers, media: { ...s.layers.media, content } } };
}
function health(p: Partial<OutputHealthEntry>): OutputHealthEntry {
  return {
    outputId: 'o',
    connected: true,
    lastSeen: 50_000,
    presented: 0,
    missed: 0,
    longTasks: 0,
    lateFlips: 0,
    cache: { ready: 0, total: 0 },
    gpuLost: 0,
    videoDropped: 0,
    ...p,
  };
}

describe('media remaining time (review item 30)', () => {
  it('moves from the first frame using the reducer position, before any health report', () => {
    const s = withMedia({});
    expect(mediaTimes(s, 10_400, 30_000)).toEqual({ pos: 400, dur: 30_000 });
    expect(mediaTimes(s, 10_000, 30_000)?.pos).toBe(0);
  });

  it('keeps the reducer position when health agrees within the drift window', () => {
    const s = withMedia({});
    // Health said 1300 ms, 200 ms ago; reducer says 1500 ms: in agreement.
    const h = health({ mediaPositionMs: 1300, mediaDurationMs: 30_000, lastSeen: 50_000 });
    expect(mediaTimes(s, 11_500, undefined, h, 50_200)).toEqual({ pos: 1500, dur: 30_000 });
  });

  it('corrects to the output position when they disagree (loop, seek, slow start)', () => {
    const s = withMedia({});
    const h = health({ mediaPositionMs: 500, mediaDurationMs: 30_000, lastSeen: 50_000 });
    // Reducer thinks 25 s have passed (a looped video); the output reports 0.5 s + 0.2 s since.
    expect(mediaTimes(s, 35_000, undefined, h, 50_200)?.pos).toBe(700);
  });

  it('ignores a stale health report and clamps to the duration', () => {
    const s = withMedia({});
    const h = health({ mediaPositionMs: 500, mediaDurationMs: 30_000, lastSeen: 40_000 });
    expect(mediaTimes(s, 50_000, undefined, h, 50_200)?.pos).toBe(30_000);
  });

  it('uses the frozen position while paused and null without media', () => {
    const s = withMedia({ state: 'paused', positionMs: 4200 });
    expect(mediaTimes(s, 99_000, 30_000)?.pos).toBe(4200);
    expect(mediaTimes(initialState(), 1, 1)).toBeNull();
  });
});
