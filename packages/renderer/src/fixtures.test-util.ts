import {
  DEFAULT_LYRIC_STYLE,
  type LiveState,
  type Media,
  type Presentation,
  type ResolvedPlaylist,
  type Slide,
  expandCues,
} from '@ordo/domain';

/** Test fixtures: a small resolved playlist and a hand-built live state (no reducer dependency). */

const text = (id: string, t: string): Slide => ({
  id,
  objects: [
    { id: `${id}-t`, type: 'text', box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, text: t, style: DEFAULT_LYRIC_STYLE, opacity: 1 },
  ],
  lyricObjectId: `${id}-t`,
});

const file = (hash: string, mime: string) => ({ hash, bytes: 10, mime, path: `files/${hash}` });

export const media: Record<string, Media> = {
  bgv: {
    id: 'bgv',
    rev: 1,
    name: 'Motion',
    tags: [],
    kind: 'video',
    original: file('o1', 'video/mp4'),
    delivery: file('d1', 'video/mp4'),
    state: 'ready',
    loop: true,
    isBackground: true,
  },
  bgi: {
    id: 'bgi',
    rev: 1,
    name: 'Still',
    tags: [],
    kind: 'image',
    original: file('i1', 'image/png'),
    state: 'ready',
    loop: false,
    isBackground: true,
  },
  vid: {
    id: 'vid',
    rev: 1,
    name: 'Announcements',
    tags: [],
    kind: 'video',
    original: file('o2', 'video/mp4'),
    delivery: file('d2', 'video/mp4'),
    state: 'ready',
    loop: false,
    isBackground: false,
    durationMs: 60_000,
    audio: { gainDb: -3, loudnessLufs: -20 },
  },
  hold: {
    id: 'hold',
    rev: 1,
    name: 'Welcome',
    tags: [],
    kind: 'image',
    original: file('h1', 'image/jpeg'),
    state: 'ready',
    loop: false,
    isBackground: false,
  },
};

const song: Presentation = {
  id: 'song',
  rev: 1,
  title: 'Song',
  kind: 'song',
  meta: { tags: [] },
  sections: [{ id: 'v1', label: 'Verse 1', short: 'V1', slides: [text('s1', 'Line one\nLine two'), text('s2', 'Line three')] }],
  arrangements: [],
  archived: false,
  backgroundMediaId: 'bgv',
};

const talk: Presentation = {
  id: 'talk',
  rev: 1,
  title: 'Talk',
  kind: 'slides',
  meta: { tags: [] },
  sections: [{ id: 'm', label: 'Main', short: 'M', slides: [text('t1', 'Welcome'), { id: 't2', objects: [] }] }],
  arrangements: [],
  archived: false,
};

export const resolved: ResolvedPlaylist = {
  playlist: {
    id: 'pl',
    rev: 1,
    name: 'Sunday',
    items: [
      { id: 'i1', kind: 'presentation', presentationId: 'song' },
      { id: 'i2', kind: 'presentation', presentationId: 'talk' },
      { id: 'i3', kind: 'media', mediaId: 'vid' },
    ],
  },
  presentations: { song, talk },
  media,
  fonts: [],
  looks: [],
  files: [],
  manifestId: 'm1',
};

export function liveState(overrides: Partial<LiveState> = {}): LiveState {
  const cues = expandCues(resolved);
  const empty = { content: null, at: 0, seq: 0 };
  return {
    seq: 1,
    mode: 'live',
    resolved,
    cues,
    layers: { background: empty, slide: empty, lowerThird: empty, media: empty },
    props: { logo: false, at: 0, seq: 0 },
    audio: empty,
    timers: {},
    messages: [],
    black: false,
    ...overrides,
  };
}

/** State with cue `i` (a song or talk slide) live at hub time `at`. */
export function slideLive(i: number, at = 1000): LiveState {
  const s = liveState();
  const c = s.cues[i]!;
  return {
    ...s,
    live: i,
    armed: i + 1,
    layers: {
      ...s.layers,
      slide: {
        content: { kind: 'slide', cueIndex: i, presentationId: c.presentationId!, slideId: c.slideId! },
        at,
        seq: 1,
        transition: c.transition,
      },
      background: c.backgroundMediaId
        ? { content: { kind: 'background', mediaId: c.backgroundMediaId }, at, seq: 1 }
        : s.layers.background,
    },
  };
}
