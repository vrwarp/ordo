import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type LiveEvent,
  type Presentation,
  type ResolvedPlaylist,
  parseLyrics,
  songFromParsed,
} from '@ordo/domain';
import { OptimisticState, autoAdvance, initialState, reduce, reduceAll } from './index.ts';

function song(text: string): Presentation {
  return songFromParsed(parseLyrics(text), { linesPerSlide: 2 });
}

function fixture(): ResolvedPlaylist {
  const a = song('Verse 1\na\nb\nc\nd\n\nChorus\ne\nf');
  a.backgroundMediaId = 'bg1';
  const b = song('Verse 1\ng\nh');
  b.backgroundMediaId = 'bg2';
  const loop: Presentation = { ...song('Verse 1\nx\n\ny'), kind: 'loop', loop: { defaultSlideMs: 5000 } };
  return {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: [
        { id: 'i0', kind: 'presentation', presentationId: a.id },
        { id: 'i1', kind: 'media', mediaId: 'vid' },
        { id: 'i2', kind: 'presentation', presentationId: b.id },
        { id: 'i3', kind: 'timer', timer: { kind: 'elapsed', label: 'Sermon' } },
        { id: 'i4', kind: 'media', mediaId: 'aud', loop: true },
        { id: 'i5', kind: 'presentation', presentationId: loop.id },
      ],
    },
    presentations: { [a.id]: a, [b.id]: b, [loop.id]: loop },
    media: {
      vid: {
        id: 'vid',
        rev: 1,
        name: 'Video',
        tags: [],
        kind: 'video',
        original: f(),
        state: 'ready',
        loop: false,
        isBackground: false,
      },
      aud: {
        id: 'aud',
        rev: 1,
        name: 'Bed',
        tags: [],
        kind: 'audio',
        original: f(),
        state: 'ready',
        loop: false,
        isBackground: false,
      },
    },
    fonts: [],
    looks: [],
    files: [],
    manifestId: 'm1',
  };
}
function f() {
  return { hash: 'h', bytes: 1, mime: 'x', path: 'p' };
}

describe('reduce', () => {
  it('goes live and pre-arms the first cue', () => {
    const s = reduce(initialState(), { k: 'goLive', resolved: fixture() });
    expect(s.mode).toBe('live');
    expect(s.cues.map((c) => c.kind)).toEqual([
      'slide',
      'slide',
      'slide',
      'media',
      'slide',
      'timer',
      'media',
      'slide',
      'slide',
    ]);
    expect(s.armed).toBe(0);
    expect(s.seq).toBe(1);
  });

  it('next walks slides, sets backgrounds, and pre-arms the following cue', () => {
    let s = reduce(initialState(), { k: 'goLive', resolved: fixture() });
    s = reduce(s, { k: 'next', at: 100 });
    expect(s.live).toBe(0);
    expect(s.armed).toBe(1);
    expect(s.layers.slide.content?.cueIndex).toBe(0);
    expect(s.layers.background.content?.mediaId).toBe('bg1');
    const bgSeq = s.layers.background.seq;
    s = reduce(s, { k: 'next', at: 200 });
    expect(s.layers.background.seq).toBe(bgSeq); // unchanged background is not re-set
    s = reduceAll(s, [
      { k: 'next', at: 300 },
      { k: 'next', at: 400 },
    ]);
    expect(s.live).toBe(3);
    expect(s.layers.media.content?.mediaId).toBe('vid');
    expect(s.layers.slide.content?.cueIndex).toBe(2); // slide stays under the video
    s = reduce(s, { k: 'next', at: 500 });
    expect(s.layers.media.content).toBeNull();
    expect(s.layers.background.content?.mediaId).toBe('bg2');
  });

  it('clears layers independently and clear-all goes black', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: fixture() },
      { k: 'next', at: 1 },
    ]);
    s = reduce(s, { k: 'clear', layer: 'slide', at: 2 });
    expect(s.layers.slide.content).toBeNull();
    expect(s.layers.background.content).not.toBeNull();
    s = reduce(s, { k: 'clear', layer: 'all', at: 3 });
    expect(s.black).toBe(true);
    expect(s.layers.background.content).toBeNull();
    s = reduce(s, { k: 'next', at: 4 });
    expect(s.black).toBe(false);
  });

  it('handles media end rules', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: fixture() },
      { k: 'go', cueIndex: 3, at: 1000 },
    ]);
    s = reduce(s, { k: 'media.ended', cueIndex: 3, at: 5000 });
    expect(s.layers.media.content?.state).toBe('ended');
    s = reduce(s, { k: 'media.restart', at: 6000 });
    expect(s.layers.media.content?.state).toBe('playing');
    s = reduce(s, { k: 'media.pause', at: 7000 });
    expect(s.layers.media.content?.positionMs).toBe(1000);
    s = reduce(s, { k: 'media.play', at: 9000 });
    expect(s.layers.media.content?.startedAt).toBe(8000);
  });

  it('starts timers and audio from playlist items', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: fixture() },
      { k: 'go', cueIndex: 5, at: 10 },
    ]);
    expect(s.timers['i3']?.running).toBe(true);
    s = reduce(s, { k: 'next', at: 20 });
    expect(s.audio.content?.mediaId).toBe('aud');
    expect(s.audio.content?.loop).toBe(true);
    s = reduce(s, { k: 'audio.ended', cueIndex: 6, at: 30 });
    expect(s.audio.content).not.toBeNull(); // looping audio ignores ended
    s = reduce(s, { k: 'timer.stop', timerId: 'i3', at: 1010 });
    expect(s.timers['i3']?.elapsedMs).toBe(1000);
  });

  it('item navigation and sections', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: fixture() },
      { k: 'go', cueIndex: 1, at: 0 },
    ]);
    s = reduce(s, { k: 'nextItem', at: 1 });
    expect(s.live).toBe(3);
    s = reduce(s, { k: 'prevItem', at: 2 });
    expect(s.live).toBe(0);
    s = reduce(s, { k: 'goToSection', sectionIndex: 1, at: 3 });
    expect(s.cues[s.live!]?.sectionLabel).toBe('Chorus');
  });

  it('auto-advances loop presentations with wrap', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: fixture() },
      { k: 'go', cueIndex: 8, at: 100 },
    ]);
    expect(autoAdvance(s)).toEqual({ dueAt: 5100, target: 7 });
    s = reduce(s, { k: 'go', cueIndex: 7, at: 5100 });
    expect(autoAdvance(s)?.target).toBe(8);
  });

  it('messages keep newest first and dismiss', () => {
    let s = reduce(initialState(), { k: 'message.send', id: 'm1', text: 'hi', ttlMs: 1000, at: 5 });
    s = reduce(s, { k: 'message.send', id: 'm2', text: 'yo', at: 6 });
    expect(s.messages.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(s.messages[1]?.expiresAt).toBe(1005);
    s = reduce(s, { k: 'message.dismiss', id: 'm2' });
    expect(s.messages.map((m) => m.id)).toEqual(['m1']);
  });
});

const arbEvent: fc.Arbitrary<LiveEvent> = fc.oneof(
  fc.integer({ min: 0, max: 10_000 }).map((at) => ({ k: 'next' as const, at })),
  fc.integer({ min: 0, max: 10_000 }).map((at) => ({ k: 'prev' as const, at })),
  fc
    .record({ cueIndex: fc.integer({ min: -1, max: 12 }), at: fc.integer({ min: 0, max: 10_000 }) })
    .map((r) => ({ k: 'go' as const, ...r })),
  fc.record({ cueIndex: fc.integer({ min: -1, max: 12 }) }).map((r) => ({ k: 'select' as const, ...r })),
  fc
    .constantFrom('slide', 'lowerThird', 'props', 'media', 'background', 'audio', 'all')
    .map((layer) => ({ k: 'clear' as const, layer, at: 1 })),
  fc.constant({ k: 'logo' as const, at: 2 }),
  fc.constant({ k: 'nextItem' as const, at: 3 }),
  fc.constant({ k: 'prevItem' as const, at: 4 }),
  fc.constant({ k: 'media.play' as const, at: 5 }),
  fc.constant({ k: 'media.pause' as const, at: 6 }),
  fc.constant({ k: 'media.ended' as const, cueIndex: 3, at: 7 }),
  fc.constant({ k: 'goToSection' as const, sectionIndex: 1, at: 8 }),
);

describe('reducer properties', () => {
  it('is deterministic, counts seq, and keeps live/armed in range', () => {
    const resolved = fixture();
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 60 }), (events) => {
        const all: LiveEvent[] = [{ k: 'goLive', resolved }, ...events];
        const a = reduceAll(initialState(), all);
        const b = reduceAll(initialState(), all);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(a.seq).toBe(all.length);
        if (a.live !== undefined) expect(a.cues[a.live]).toBeDefined();
        if (a.armed !== undefined) expect(a.cues[a.armed]).toBeDefined();
      }),
    );
  });

  it('optimistic rebasing converges with the hub', () => {
    const resolved = fixture();
    fc.assert(
      fc.property(fc.array(arbEvent, { maxLength: 30 }), (events) => {
        const hub = { s: reduce(initialState(), { k: 'goLive', resolved }) };
        const op = new OptimisticState(hub.s);
        events.forEach((e, i) => {
          op.propose(String(i), e);
          const from = hub.s.seq;
          hub.s = reduce(hub.s, e);
          expect(op.applyDelta(from, e, String(i))).toBe(true);
        });
        expect(JSON.stringify(op.view)).toBe(JSON.stringify(hub.s));
        expect(op.pendingCount).toBe(0);
      }),
    );
  });
});
