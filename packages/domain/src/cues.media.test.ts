import { describe, expect, it } from 'vitest';
import { expandCues } from './cues.ts';
import { DEFAULT_GENERAL, DEFAULT_LOOKS } from './defaults.ts';
import { type GoLiveInputs, GoLiveRejection, localDigest, resolvePlaylist } from './goLive.ts';
import { referencedMediaIds, slideOnlyMedia } from './resolve.ts';
import type { Media, Playlist, Presentation, Slide, SlideObject } from './schemas.ts';

/** A slide's own video and sound (design/27 §8 "Domain"): cue fields and goLive. */

const box = { x: 100, y: 100, w: 800, h: 450, rotation: 0 };
const file = (c: string) => ({ hash: c.repeat(64), bytes: 10, mime: 'video/mp4', path: 'p' });
function media(id: string, kind: Media['kind'], over: Partial<Media> = {}): Media {
  return {
    id,
    rev: 1,
    name: `Media ${id}`,
    tags: [],
    kind,
    original: file('a'),
    delivery: file('b'),
    ...(kind === 'video' ? { poster: file('c') } : {}),
    state: 'ready',
    loop: false,
    isBackground: false,
    ...over,
  };
}
const image = (id: string, mediaId: string, play?: Record<string, unknown>): SlideObject =>
  ({
    id,
    type: 'image',
    box,
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
    ...(play ? { play } : {}),
  }) as SlideObject;
const text = (id: string, t: string): SlideObject =>
  ({ id, type: 'text', box, text: t, style: { fontFamily: 'Inter', fontSizePx: 40 } }) as SlideObject;
const slide = (id: string, objects: SlideObject[] = [], over: Partial<Slide> = {}): Slide => ({
  id,
  objects,
  ...over,
});
function deck(id: string, sections: Slide[][], over: Partial<Presentation> = {}): Presentation {
  return {
    id,
    rev: 1,
    title: id,
    kind: 'slides',
    meta: { tags: [] },
    sections: sections.map((slides, i) => ({ id: `${id}-s${i}`, label: `S${i}`, short: `S${i}`, slides })),
    arrangements: [],
    archived: false,
    ...over,
  };
}
function playlist(...ids: string[]): Playlist {
  return {
    id: 'pl',
    rev: 1,
    name: 'Sunday',
    items: ids.map((x, i) =>
      x.startsWith('m:')
        ? { id: `i${i}`, kind: 'media', mediaId: x.slice(2) }
        : { id: `i${i}`, kind: 'presentation', presentationId: x },
    ),
  };
}
const byId = <T extends { id: string }>(...xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

describe('expandCues: a slide cue carries its own video', () => {
  const clip = media('clip', 'video', { loop: true });
  it('fills the playing object (the first with play, in z order) for a ready video', () => {
    const p = deck('d', [
      [
        slide('a', [
          text('t', 'Title'),
          image('poster', 'pic', { mediaId: 'clip', start: 'click', onEnd: 'advance', gainDb: -6 }),
          image('second', 'pic', { mediaId: 'other' }),
        ]),
      ],
    ]);
    const [c] = expandCues({
      playlist: playlist('d'),
      presentations: byId(p),
      media: byId(clip, media('other', 'video')),
    });
    expect(c).toMatchObject({
      kind: 'slide',
      label: 'Title',
      mediaId: 'clip',
      mediaKind: 'video',
      loop: true, // the media's own default when play says nothing
      onEnd: 'advance',
      audio: { gainDb: -6 },
      mediaObjectId: 'poster',
      mediaStart: 'click',
      mediaShowWhenStopped: true,
    });
    expect(c?.slideAudio).toBeUndefined();
  });

  it('defaults: autoplay, hold, shown when stopped; muted is the gain floor; play.loop wins', () => {
    const p = deck('d', [
      [
        slide('a', [
          image('o', 'clip', { mediaId: 'clip', loop: false, muted: true, showWhenStopped: false }),
        ]),
      ],
    ]);
    const [c] = expandCues({ playlist: playlist('d'), presentations: byId(p), media: byId(clip) });
    expect(c).toMatchObject({
      mediaId: 'clip',
      loop: false,
      onEnd: 'hold',
      audio: { gainDb: -100 },
      mediaStart: 'auto',
      mediaShowWhenStopped: false,
    });
  });

  it('only for a ready video present in resolved.media', () => {
    const p = deck('d', [
      [slide('a', [image('o', 'pic', { mediaId: 'clip' })])],
      [slide('b', [image('o', 'pic', { mediaId: 'still' })])],
    ]);
    const cues = expandCues({
      playlist: playlist('d'),
      presentations: byId(p),
      media: byId(media('still', 'image')),
    });
    for (const c of cues) {
      expect(c.mediaId).toBeUndefined();
      expect(c.mediaObjectId).toBeUndefined();
      expect(c.audio).toBeUndefined();
    }
  });
});

describe('expandCues: a slide sound plays across shown slides', () => {
  const song = media('song', 'audio');
  const withSound = (slides?: number, over: Record<string, unknown> = {}) =>
    ({ audio: { mediaId: 'song', ...(slides ? { slides } : {}), ...over } }) as Partial<Slide>;

  it('untilCue is the slide itself by default, else the slide reached after `slides` shown slides', () => {
    const p = deck('d', [
      [slide('a', [], withSound()), slide('b', [], withSound(3)), slide('c')],
      [slide('d'), slide('e')],
    ]);
    // A media cue before the deck shifts every index by one.
    const cues = expandCues({
      playlist: playlist('m:song', 'd'),
      presentations: byId(p),
      media: byId(song),
    });
    expect(cues[1]?.slideAudio).toEqual({ mediaId: 'song', start: 'auto', loop: false, untilCue: 1 });
    // b, c (section 0), d (section 1): three shown slides across sections.
    expect(cues[2]?.slideAudio?.untilCue).toBe(4);
  });

  it('stops at the last cue of its playlist item, never in the next item', () => {
    const p = deck('d', [[slide('a', [], withSound(999)), slide('b'), slide('c')]]);
    const q = deck('q', [[slide('x'), slide('y')]]);
    const cues = expandCues({ playlist: playlist('d', 'q'), presentations: byId(p, q), media: byId(song) });
    expect(cues[0]?.slideAudio?.untilCue).toBe(2);
    expect(cues[3]?.slideAudio).toBeUndefined();
  });

  it('counts each occurrence of a repeated section on its own', () => {
    const p = deck('d', [[slide('a', [], withSound(2))], [slide('b')]], {
      arrangements: [{ id: 'arr', name: 'A', sectionIds: ['d-s0', 'd-s1', 'd-s0', 'd-s1'] }],
    });
    const cues = expandCues({ playlist: playlist('d'), presentations: byId(p), media: byId(song) });
    expect(cues.map((c) => c.slideAudio?.untilCue)).toEqual([1, undefined, 3, undefined]);
  });

  it('does not count hidden slides (M3), which stay reachable inside the range', () => {
    const hidden = { hidden: true } as Partial<Slide>;
    const p = deck('d', [[slide('a', [], withSound(2)), slide('h', [], hidden), slide('b'), slide('c')]]);
    const cues = expandCues({ playlist: playlist('d'), presentations: byId(p), media: byId(song) });
    expect(cues[0]?.slideAudio?.untilCue).toBe(2);
  });

  it('click start, loop, gain and mute; a video soundtrack plays too; an image does not', () => {
    const p = deck('d', [
      [
        slide('a', [], withSound(1, { start: 'click', loop: true, gainDb: -3 })),
        slide('b', [], withSound(1, { muted: true, gainDb: 4 })),
        slide('c', [], { audio: { mediaId: 'clip' } }),
        slide('e', [], { audio: { mediaId: 'still' } }),
        slide('f', [], { audio: { mediaId: 'gone' } }),
      ],
    ]);
    const cues = expandCues({
      playlist: playlist('d'),
      presentations: byId(p),
      media: byId(song, media('clip', 'video'), media('still', 'image')),
    });
    expect(cues[0]?.slideAudio).toEqual({
      mediaId: 'song',
      start: 'click',
      loop: true,
      gainDb: -3,
      untilCue: 0,
    });
    expect(cues[1]?.slideAudio?.gainDb).toBe(-100);
    expect(cues[2]?.slideAudio?.mediaId).toBe('clip');
    expect(cues[3]?.slideAudio).toBeUndefined();
    expect(cues[4]?.slideAudio).toBeUndefined();
  });
});

describe('media slides play are referenced and optional at goLive', () => {
  const clip = media('clip', 'video');
  const song = media('song', 'audio');
  const p = deck('d', [
    [
      slide('a', [image('o', 'pic', { mediaId: 'clip' }), image('o2', 'pic', { mediaId: 'unplayed' })]),
      slide('b', [], { audio: { mediaId: 'song', slides: 2 } }),
    ],
  ]);
  const inputs = (lib: Media[], pl = playlist('d'), pres: Presentation = p): GoLiveInputs => ({
    playlist: pl,
    presentation: (id) => (id === pres.id ? pres : undefined),
    media: (id) => lib.find((m) => m.id === id),
    fonts: () => [],
    looks: DEFAULT_LOOKS,
    general: DEFAULT_GENERAL,
  });

  it('referencedMediaIds adds the playing clip and the slide sound, not an object that does not play', () => {
    const ids = referencedMediaIds(playlist('d'), byId(p));
    expect([...ids].sort()).toEqual(['clip', 'pic', 'song']);
    expect([...slideOnlyMedia(playlist('d'), byId(p)).keys()].sort()).toEqual(['clip', 'song']);
  });

  it('a ready clip and sound go live with their files in the manifest', () => {
    const r = resolvePlaylist(inputs([clip, song, media('pic', 'image')]), 'pl', { digest: localDigest });
    expect(Object.keys(r.media).sort()).toEqual(['clip', 'pic', 'song']);
    expect(r.files.map((f) => f.hash)).toContain(clip.delivery!.hash);
    expect(r.degraded).toBeUndefined();
    const cues = expandCues(r);
    expect(cues[0]?.mediaObjectId).toBe('o');
    expect(cues[1]?.slideAudio?.untilCue).toBe(1);
  });

  it('a clip still processing, failed or missing never refuses the service: degraded note, poster shown', () => {
    const lib = [
      { ...clip, state: 'processing' as const, delivery: undefined },
      { ...song, state: 'failed' as const },
      media('pic', 'image'),
    ];
    const r = resolvePlaylist(inputs(lib), 'pl', { digest: localDigest });
    expect(Object.keys(r.media)).toEqual(['pic']);
    expect(r.degraded).toEqual([
      {
        cueIndex: 0,
        presentationId: 'd',
        slideId: 'a',
        reason:
          '"Media clip" (slide video) is still processing; showing its poster; Go live again once it is ready',
      },
      {
        cueIndex: 1,
        presentationId: 'd',
        slideId: 'b',
        reason: '"Media song" (slide sound) failed; the slide shows without it',
      },
    ]);
    const cues = expandCues(r);
    expect(cues[0]?.mediaId).toBeUndefined();
    expect(cues[1]?.slideAudio).toBeUndefined();
    const gone = resolvePlaylist(inputs([media('pic', 'image')]), 'pl', { digest: localDigest });
    expect(gone.degraded?.map((d) => d.reason)).toEqual([
      'slide video clip is missing; showing its poster',
      'slide sound song is missing; the slide shows without it',
    ]);
  });

  it("a poster that is the clip itself (the editor's 'Add video to slide') is optional too", () => {
    const own = deck('d', [[slide('a', [image('o', 'clip', { mediaId: 'clip' })])]]);
    const r = resolvePlaylist(
      inputs([{ ...clip, state: 'processing', delivery: undefined, poster: undefined }], playlist('d'), own),
      'pl',
      { digest: localDigest },
    );
    expect(r.media).toEqual({});
    expect(r.degraded?.map((d) => d.reason)).toEqual([
      '"Media clip" (slide video) is still processing; the slide shows without it; Go live again once it is ready',
    ]);
  });

  it('a clip that something else also draws or plays stays required', () => {
    const lib = [{ ...clip, state: 'processing' as const }, song, media('pic', 'image')];
    expect(() =>
      resolvePlaylist(inputs(lib, playlist('d', 'm:clip')), 'pl', { digest: localDigest }),
    ).toThrow(GoLiveRejection);
    const drawn = deck('d', [[slide('a', [image('o', 'pic', { mediaId: 'clip' }), image('x', 'clip')])]]);
    expect(() => resolvePlaylist(inputs(lib, playlist('d'), drawn), 'pl', { digest: localDigest })).toThrow(
      /still processing/,
    );
  });
});
