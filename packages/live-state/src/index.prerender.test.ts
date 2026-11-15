import {
  DRAW_OVERRIDE_MAX,
  type LiveEvent,
  type LiveState,
  PRERENDERED_MAX,
  type Presentation,
  type ResolvedPlaylist,
  parseLyrics,
  songFromParsed,
} from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from './invariants.ts';
import { initialState, isLiveEventShape, isLiveStateShape, reduce, reduceAll, safeReduce } from './index.ts';

/*
 * design/29 §1.7: during a service a picture the venue PC makes arrives as `prerender.add` (the hub's, for a key
 * of the live service), kept in `state.prerendered` while `resolved` stays as it went live; `prerender.use` (the
 * operator's) makes a slide set to Live draw from its picture until End service, kept in `state.drawOverride`.
 */

const KEY = 'a'.repeat(64);
const FILE = 'b'.repeat(64);

function service(): { resolved: ResolvedPlaylist; song: Presentation } {
  const song = songFromParsed(parseLyrics('Verse 1\na\nb\n\nChorus\nc\nd'), { linesPerSlide: 1 });
  return {
    song,
    resolved: {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'Sunday',
        items: [{ id: 'i', kind: 'presentation', presentationId: song.id }],
      },
      presentations: { [song.id]: song },
      media: {},
      fonts: [],
      looks: [],
      files: [],
      manifestId: 'm',
      prerenderKeys: [KEY],
    } as unknown as ResolvedPlaylist,
  };
}
const live = (): { s: LiveState; song: Presentation } => {
  const { resolved, song } = service();
  return { s: reduce(initialState(), { k: 'goLive', resolved }), song };
};
const slideId = (song: Presentation, n = 0) => song.sections.flatMap((x) => x.slides)[n]!.id;
const add = (
  song: Presentation,
  over: Partial<Extract<LiveEvent, { k: 'prerender.add' }>> = {},
): LiveEvent => ({
  k: 'prerender.add',
  presentationId: song.id,
  slideId: slideId(song),
  key: KEY,
  size: 3840,
  file: FILE,
  ...over,
});

describe('prerender.add (design/29 §1.7)', () => {
  it('keeps the picture in state.prerendered and leaves resolved as it went live', () => {
    const { s, song } = live();
    const next = reduce(s, add(song));
    expect(next.prerendered).toEqual([
      { presentationId: song.id, slideId: slideId(song), key: KEY, size: 3840, file: FILE },
    ]);
    expect(next.resolved).toBe(s.resolved);
    expect(next.seq).toBe(s.seq + 1);
    expect(checkInvariants(next)).toEqual([]);
    // The 1080p copy is a second entry; the same picture again replaces its entry.
    const both = reduceAll(next, [add(song, { size: 1920, file: 'c'.repeat(64) }), add(song)]);
    expect(both.prerendered?.map((p) => p.size)).toEqual([1920, 3840]);
  });

  it('applies only a key of the live service, to one of its slides, while live', () => {
    const { s, song } = live();
    expect(reduce(s, add(song, { key: 'd'.repeat(64) })).prerendered).toBeUndefined();
    expect(reduce(s, add(song, { slideId: 'nope' })).prerendered).toBeUndefined();
    expect(reduce(initialState(), add(song)).prerendered).toBeUndefined();
  });

  it(`is bounded: past ${PRERENDERED_MAX} pictures the oldest go`, () => {
    const { s, song } = live();
    let st = s;
    for (let i = 0; i <= PRERENDERED_MAX; i++)
      st = reduce(st, add(song, { file: i.toString(16).padStart(64, '0') }));
    // One slide, one key, one size: each new file replaces the entry.
    expect(st.prerendered).toHaveLength(1);
    const keys = Array.from(
      { length: PRERENDERED_MAX + 5 },
      (_, i) => `${i.toString(16).padStart(63, '0')}f`,
    );
    const many = reduce(initialState(), {
      k: 'goLive',
      resolved: { ...service().resolved, prerenderKeys: keys, presentations: { [song.id]: song } },
    });
    let m = many;
    for (const key of keys) m = reduce(m, add(song, { key }));
    expect(m.prerendered).toHaveLength(PRERENDERED_MAX);
    expect(m.prerendered?.[0]?.key).toBe(keys[5]);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('is a well-formed event for safeReduce; a malformed one is refused', () => {
    const { s, song } = live();
    expect(isLiveEventShape(add(song))).toBe(true);
    const errors: unknown[] = [];
    const bad = { ...add(song), size: 'big' };
    expect(safeReduce(s, bad, (e) => errors.push(e))).toBe(s);
    expect(errors).toHaveLength(1);
  });
});

describe('prerender.use (design/29 §1.7)', () => {
  const use = (song: Presentation, n = 0): LiveEvent => ({
    k: 'prerender.use',
    presentationId: song.id,
    slideId: slideId(song, n),
  });

  it('draws a slide from its picture until End service', () => {
    const { s, song } = live();
    const next = reduce(s, use(song));
    expect(next.drawOverride).toEqual([{ presentationId: song.id, slideId: slideId(song) }]);
    expect(reduce(next, use(song)).drawOverride).toHaveLength(1);
    expect(reduce(next, use(song, 1)).drawOverride).toHaveLength(2);
    expect(checkInvariants(next)).toEqual([]);
    const ended = reduce(next, { k: 'endService', at: 10 });
    expect(ended.drawOverride).toBeUndefined();
    expect(ended.prerendered).toBeUndefined();
    // A new service starts without the last one's overrides.
    expect(reduce(next, { k: 'goLive', resolved: service().resolved }).drawOverride).toBeUndefined();
    // Only while live, and only for a slide of the service.
    expect(reduce(initialState(), use(song)).drawOverride).toBeUndefined();
    expect(
      reduce(s, { k: 'prerender.use', presentationId: song.id, slideId: 'nope' }).drawOverride,
    ).toBeUndefined();
  });

  it('is journaled: replaying the events gives the same state, which travels with the hand-back', () => {
    const { resolved, song } = service();
    const journal: LiveEvent[] = [
      { k: 'goLive', resolved },
      { k: 'go', cueIndex: 0, at: 1 },
      use(song),
      add(song),
      { k: 'next', at: 2 },
    ];
    const a = reduceAll(initialState(), journal);
    const b = journal.reduce((st, e) => safeReduce(st, JSON.parse(JSON.stringify(e))), initialState());
    expect(b).toEqual(a);
    expect(a.drawOverride).toHaveLength(1);
    expect(isLiveStateShape(JSON.parse(JSON.stringify(a)))).toBe(true);
  });

  it(`is bounded: past ${DRAW_OVERRIDE_MAX} slides a new one is not added`, () => {
    const song = songFromParsed(
      parseLyrics(
        Array.from({ length: DRAW_OVERRIDE_MAX + 2 }, (_, i) => `Verse ${i + 1}\nline ${i}`).join('\n\n'),
      ),
      { linesPerSlide: 1 },
    );
    const resolved = { ...service().resolved, presentations: { [song.id]: song } } as ResolvedPlaylist;
    let st = reduce(initialState(), {
      k: 'goLive',
      resolved: {
        ...resolved,
        playlist: {
          ...resolved.playlist,
          items: [{ id: 'i', kind: 'presentation', presentationId: song.id }],
        },
      },
    });
    for (let i = 0; i < DRAW_OVERRIDE_MAX + 2; i++) st = reduce(st, use(song, i));
    expect(st.drawOverride).toHaveLength(DRAW_OVERRIDE_MAX);
    expect(checkInvariants(st)).toEqual([]);
  });
});
