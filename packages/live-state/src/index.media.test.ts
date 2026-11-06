import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type {
  LiveEvent,
  LiveState,
  Media,
  Presentation,
  ResolvedPlaylist,
  Slide,
  SlideObject,
} from '@ordo/domain';
import { autoAdvance, initialState, reduce, reduceAll } from './index.ts';
import { checkInvariants } from './invariants.ts';

/** A slide's own video and sound in the reducer (design/27 §8 "Reducer", §14.8). */

const box = { x: 100, y: 100, w: 800, h: 450, rotation: 0 };
const f = { hash: 'h', bytes: 1, mime: 'x', path: 'p' };
const media = (id: string, kind: Media['kind']): Media => ({
  id,
  rev: 1,
  name: id,
  tags: [],
  kind,
  original: f,
  delivery: f,
  state: 'ready',
  loop: false,
  isBackground: false,
});
const video = (id: string, clip: string, play: Record<string, unknown> = {}): SlideObject =>
  ({
    id,
    type: 'image',
    box,
    mediaId: clip,
    fit: 'contain',
    opacity: 1,
    radius: 0,
    play: { mediaId: clip, ...play },
  }) as SlideObject;
const slide = (id: string, objects: SlideObject[] = [], over: Partial<Slide> = {}): Slide => ({
  id,
  objects,
  ...over,
});
const deck = (id: string, slides: Slide[], over: Partial<Presentation> = {}): Presentation => ({
  id,
  rev: 1,
  title: id,
  kind: 'slides',
  meta: { tags: [] },
  sections: [{ id: `${id}-s`, label: 'S', short: 'S', slides }],
  arrangements: [],
  archived: false,
  ...over,
});

/**
 * Cues:
 *   0 talk/a  video 'clip' (autoplay, onEnd advance)
 *   1 talk/b  video 'clip2' (click start, onEnd hold)
 *   2 talk/c  sound 'song' across 3 shown slides (until 4)
 *   3 talk/d
 *   4 talk/e  video 'clip' (onEnd black)
 *   5 talk/f
 *   6 media 'bed' (playlist audio, loops)
 *   7 talk2/x
 *   8 talk2/y sound 'jingle' (click start)
 *   9 media 'movie' (playlist video)
 *  10 loop/1 sound 'music' across 999 shown slides (until 13)
 *  11 loop/2
 *  12 loop/3
 *  13 loop/4
 */
function fixture(): ResolvedPlaylist {
  const talk = deck('talk', [
    slide('a', [video('va', 'clip', { onEnd: 'advance' })]),
    slide('b', [video('vb', 'clip2', { start: 'click' })]),
    slide('c', [], { audio: { mediaId: 'song', slides: 3 } }),
    slide('d'),
    slide('e', [video('ve', 'clip', { onEnd: 'black' })]),
    slide('f'),
  ]);
  const talk2 = deck('talk2', [slide('x'), slide('y', [], { audio: { mediaId: 'jingle', start: 'click' } })]);
  const loop = deck(
    'loop',
    [
      slide('1', [], { audio: { mediaId: 'music', slides: 999, loop: true } }),
      slide('2'),
      slide('3'),
      slide('4'),
    ],
    { kind: 'loop', loop: { defaultSlideMs: 5000 } },
  );
  return {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: [
        { id: 'i0', kind: 'presentation', presentationId: 'talk' },
        { id: 'i1', kind: 'media', mediaId: 'bed', loop: true },
        { id: 'i2', kind: 'presentation', presentationId: 'talk2' },
        { id: 'i3', kind: 'media', mediaId: 'movie' },
        { id: 'i4', kind: 'presentation', presentationId: 'loop' },
      ],
    },
    presentations: { talk, talk2, loop },
    media: Object.fromEntries(
      (
        [
          ['clip', 'video'],
          ['clip2', 'video'],
          ['movie', 'video'],
          ['song', 'audio'],
          ['bed', 'audio'],
          ['jingle', 'audio'],
          ['music', 'audio'],
        ] as const
      ).map(([id, kind]) => [id, media(id, kind)]),
    ),
    fonts: [],
    looks: [],
    files: [],
    manifestId: 'm',
  };
}
const live = (...events: LiveEvent[]): LiveState =>
  reduceAll(reduce(initialState(), { k: 'goLive', resolved: fixture() }), events);
const go = (cueIndex: number, at: number): LiveEvent => ({ k: 'go', cueIndex, at });
const sound = (s: LiveState) => s.audio.content;

describe('a slide video plays in its box on the media layer', () => {
  it('autoplay: the video of the slide goes live with it, with its object and the slide transition', () => {
    const s = live(go(0, 100));
    expect(s.layers.media).toMatchObject({
      content: {
        kind: 'media',
        cueIndex: 0,
        mediaId: 'clip',
        mediaKind: 'video',
        objectId: 'va',
        loop: false,
        onEnd: 'advance',
        state: 'playing',
        startedAt: 100,
        positionMs: 0,
      },
      at: 100,
    });
    expect(s.layers.slide.content?.cueIndex).toBe(0);
    expect(checkInvariants(s)).toEqual([]);
  });

  it('click start: goes live paused at 0, and F8 plays it', () => {
    let s = live(go(1, 100));
    expect(s.layers.media.content).toMatchObject({ objectId: 'vb', state: 'paused', positionMs: 0 });
    s = reduce(s, { k: 'media.play', at: 400 });
    expect(s.layers.media.content).toMatchObject({ state: 'playing', startedAt: 400 });
    s = reduce(s, { k: 'media.pause', at: 900 });
    expect(s.layers.media.content).toMatchObject({ state: 'paused', positionMs: 500 });
  });

  it('re-entering a slide restarts its video, as PowerPoint does', () => {
    let s = live(go(0, 100), go(1, 200), go(0, 300));
    expect(s.layers.media.content).toMatchObject({ mediaId: 'clip', state: 'playing', startedAt: 300 });
    s = reduce(s, go(0, 450));
    expect(s.layers.media.content?.startedAt).toBe(450);
  });

  it('a slide without a video clears it; Clear media leaves the slide showing its poster', () => {
    let s = live(go(0, 100), go(2, 200));
    expect(s.layers.media.content).toBeNull();
    s = reduce(s, go(4, 300));
    s = reduce(s, { k: 'clear', layer: 'media', at: 400 });
    expect(s.layers.media.content).toBeNull();
    expect(s.layers.slide.content?.cueIndex).toBe(4);
  });

  it("clear('slide') also clears the slide's own video and sound, never playlist audio", () => {
    let s = live(go(4, 100));
    s = reduce(s, { k: 'clear', layer: 'slide', at: 200 });
    expect(s.layers.slide.content).toBeNull();
    expect(s.layers.media.content).toBeNull();
    s = live(go(2, 100), go(3, 200), { k: 'clear', layer: 'slide', at: 300 });
    expect(sound(s)).toBeNull();
    s = live(go(6, 100), go(7, 200), { k: 'clear', layer: 'slide', at: 300 });
    expect(sound(s)?.mediaId).toBe('bed');
    // A playlist video on the media layer is not the slide's.
    s = live(go(9, 100), { k: 'clear', layer: 'slide', at: 200 });
    expect(s.layers.media.content?.mediaId).toBe('movie');
    expect(checkInvariants(s)).toEqual([]);
  });

  it('media.ended: advance goes to the next cue, hold keeps the last frame, black shows the poster', () => {
    let s = live(go(0, 100));
    s = reduce(s, { k: 'media.ended', cueIndex: 0, at: 5000 });
    expect(s.live).toBe(1);
    expect(s.layers.media.content).toMatchObject({ cueIndex: 1, objectId: 'vb', state: 'paused' });
    s = reduce(s, { k: 'media.play', at: 6000 });
    s = reduce(s, { k: 'media.ended', cueIndex: 1, at: 9000 });
    expect(s.live).toBe(1);
    expect(s.layers.media.content).toMatchObject({ state: 'ended', positionMs: 3000 });
    s = reduce(s, go(4, 10_000));
    s = reduce(s, { k: 'media.ended', cueIndex: 4, at: 12_000 });
    expect(s.layers.media.content).toBeNull();
    expect(s.layers.slide.content?.cueIndex).toBe(4);
    expect(checkInvariants(s)).toEqual([]);
  });

  it('a playlist media cue takes the media layer; the slide stays under it', () => {
    const s = live(go(8, 100), go(9, 200));
    expect(s.layers.media.content).toMatchObject({ mediaId: 'movie', cueIndex: 9 });
    expect(s.layers.media.content?.objectId).toBeUndefined();
  });
});

describe('a slide sound plays across shown slides', () => {
  it('plays from its slide until untilCue, then stops', () => {
    let s = live(go(2, 100));
    expect(sound(s)).toEqual({
      cueIndex: 2,
      mediaId: 'song',
      loop: false,
      state: 'playing',
      startedAt: 100,
      positionMs: 0,
      slideOwned: true,
      untilCue: 4,
    });
    const playing = sound(s);
    s = reduceAll(s, [go(3, 200), go(4, 300)]);
    expect(sound(s)).toBe(playing);
    s = reduce(s, go(5, 400));
    expect(sound(s)).toBeNull();
    expect(s.audio.at).toBe(400);
  });

  it('stops when the operator steps back before its slide or leaves the item', () => {
    let s = live(go(2, 100), go(1, 200));
    expect(sound(s)).toBeNull();
    s = live(go(2, 100), go(9, 200));
    expect(sound(s)).toBeNull();
    // The next item (a playlist audio cue here) is outside the range too.
    s = live(go(2, 100), { k: 'nextItem', at: 200 });
    expect(s.live).toBe(6);
    expect(sound(s)?.mediaId).toBe('bed');
  });

  it('is never restarted while it plays: stepping back to its slide keeps it running', () => {
    let s = live(go(2, 100), go(3, 200));
    const playing = s.audio;
    s = reduce(s, go(2, 300));
    expect(s.audio).toBe(playing);
    // Once it is paused (or ended and gone), entering its slide starts it again.
    s = reduce(s, { k: 'media.pause', at: 400 });
    expect(sound(s)?.state).toBe('paused');
    s = reduce(s, go(2, 500));
    expect(sound(s)).toMatchObject({ state: 'playing', startedAt: 500, positionMs: 0 });
    s = reduce(s, { k: 'audio.ended', cueIndex: 2, at: 900 });
    expect(sound(s)).toBeNull();
    s = reduce(s, go(2, 1000));
    expect(sound(s)?.startedAt).toBe(1000);
  });

  it('is not restarted while it plays across a loop wrap', () => {
    let s = live(go(10, 0));
    const playing = s.audio;
    expect(sound(s)).toMatchObject({ mediaId: 'music', loop: true, untilCue: 13 });
    let at = 0;
    for (let i = 0; i < 9; i++) {
      const next = autoAdvance(s);
      expect(next).not.toBeNull();
      at = next!.dueAt;
      s = reduce(s, go(next!.target, at));
      expect(s.audio).toBe(playing);
      expect(checkInvariants(s)).toEqual([]);
    }
    expect(s.live).toBe(11); // wrapped twice
  });

  it('click start: goes live paused; F8 plays it when the slide has no video', () => {
    let s = live(go(8, 100));
    expect(sound(s)).toMatchObject({ mediaId: 'jingle', state: 'paused', slideOwned: true, untilCue: 8 });
    s = reduce(s, { k: 'media.play', at: 300 });
    expect(sound(s)).toMatchObject({ state: 'playing', startedAt: 300 });
  });

  it('playlist audio plays on under slides; a slide sound replaces it', () => {
    let s = live(go(6, 100), go(7, 200));
    expect(sound(s)).toMatchObject({ mediaId: 'bed', cueIndex: 6 });
    expect(sound(s)?.slideOwned).toBeUndefined();
    s = reduce(s, go(8, 300));
    expect(sound(s)).toMatchObject({ mediaId: 'jingle', slideOwned: true });
    // The playlist audio does not come back when the slide sound stops.
    s = reduce(s, go(7, 400));
    expect(sound(s)).toBeNull();
  });

  it('a slide video and the playlist audio play together', () => {
    const s = live(go(6, 100), go(0, 200));
    expect(sound(s)?.mediaId).toBe('bed');
    expect(s.layers.media.content?.objectId).toBe('va');
  });
});

describe('invariants with slide media (property)', () => {
  const at = fc.integer({ min: 0, max: 1e7 });
  const cue = fc.integer({ min: 0, max: 14 });
  const ev: fc.Arbitrary<LiveEvent> = fc.oneof(
    at.map((a) => ({ k: 'next' as const, at: a })),
    at.map((a) => ({ k: 'prev' as const, at: a })),
    fc.record({ cueIndex: cue, at }).map((r) => ({ k: 'go' as const, ...r })),
    fc
      .constantFrom('slide', 'lowerThird', 'props', 'media', 'background', 'audio', 'all')
      .map((layer) => ({ k: 'clear' as const, layer, at: 5 })),
    fc.record({ cueIndex: cue, at }).map((r) => ({ k: 'media.ended' as const, ...r })),
    fc.record({ cueIndex: cue, at }).map((r) => ({ k: 'audio.ended' as const, ...r })),
    at.map((a) => ({ k: 'media.play' as const, at: a })),
    at.map((a) => ({ k: 'media.pause' as const, at: a })),
    at.map((a) => ({ k: 'media.restart' as const, at: a })),
    at.map((a) => ({ k: 'audio.stop' as const, at: a })),
    at.map((a) => ({ k: 'nextItem' as const, at: a })),
    at.map((a) => ({ k: 'prevItem' as const, at: a })),
    fc
      .record({ sectionIndex: fc.integer({ min: 0, max: 2 }), at })
      .map((r) => ({ k: 'goToSection' as const, ...r })),
    at.map((a) => ({ k: 'endService' as const, at: a })),
  );

  it('hold after any sequence of events', () => {
    const r = fixture();
    fc.assert(
      fc.property(fc.array(ev, { maxLength: 80 }), (events) => {
        let s = reduce(initialState(), { k: 'goLive', resolved: r });
        for (const e of events) {
          s = reduce(s, e);
          if (e.k === 'endService') s = reduce(s, { k: 'goLive', resolved: r });
          const v = checkInvariants(s);
          if (v.length) throw new Error(`${e.k}: ${v.join('; ')}`);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('report a slide sound left playing outside its range and a video outside its slide', () => {
    const s = live(go(2, 100));
    expect(checkInvariants({ ...s, live: 5 })).toEqual([
      expect.stringContaining('slide sound of cue 2 plays while cue 5 is live'),
    ]);
    const v = live(go(0, 100));
    expect(
      checkInvariants({ ...v, layers: { ...v.layers, slide: { ...v.layers.slide, content: null } } }),
    ).toEqual([expect.stringContaining('the slide layer shows undefined')]);
    const a = sound(s)!;
    expect(checkInvariants({ ...s, audio: { ...s.audio, content: { ...a, mediaId: 'nope' } } })).toEqual([
      'audio references unknown media nope',
      "slide sound nope is not cue 2's sound",
    ]);
  });
});
