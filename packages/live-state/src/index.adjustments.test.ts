import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_THEME,
  lyricSlide,
  type LiveEvent,
  type LiveState,
  type Media,
  type Presentation,
  type ResolvedPlaylist,
  type Slide,
} from '@ordo/domain';
import { initialState, isLiveEventShape, reduce, reduceAll } from './index.ts';
import { checkInvariants } from './invariants.ts';

/**
 * Closed-manifest live adjustments (ADR 0015):
 * - item.skip: skips/unskips off-air items; next/prev/nextItem/prevItem step over them; explicit go auto-unskips.
 * - item.arrange: sets/clears per-service sections on off-air presentation items; remaps active cue indices.
 * - item.hideSlides: sets per-service hidden slides on presentation items.
 * - slide.editText: updates native text on off-air slides; refuses on-air and picture slides.
 */

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

const textSlide = (id: string, text: string, over: Partial<Slide> = {}): Slide => {
  const sl = lyricSlide(text, DEFAULT_THEME);
  const firstObj = sl.objects[0]!;
  return {
    ...sl,
    id,
    objects: [{ ...firstObj, id: `${id}-t` }],
    lyricObjectId: `${id}-t`,
    ...over,
  };
};

function song(id: string, sections: { id: string; label: string; slides: Slide[] }[]): Presentation {
  return {
    id,
    rev: 1,
    title: id,
    kind: 'song',
    meta: { tags: [] },
    sections: sections.map((s) => ({ ...s, short: s.label })),
    arrangements: [{ id: `${id}-def`, name: 'Default', sectionIds: sections.map((s) => s.id) }],
    archived: false,
  };
}

function makeFixture(): ResolvedPlaylist {
  const prayer = song('prayer', [{ id: 'p-s0', label: 'P', slides: [textSlide('p1', 'Prayer')] }]);
  const s1 = song('s1', [
    { id: 's1-v1', label: 'V1', slides: [textSlide('s1-1', 'Verse 1'), textSlide('s1-2', 'Verse 1b')] },
    { id: 's1-c', label: 'C', slides: [textSlide('s1-3', 'Chorus')] },
    { id: 's1-v2', label: 'V2', slides: [textSlide('s1-4', 'Verse 2')] },
  ]);
  const s2 = song('s2', [
    { id: 's2-v1', label: 'V1', slides: [textSlide('s2-1', 'Song 2 V1'), textSlide('s2-2', 'Song 2 V1b')] },
    { id: 's2-c', label: 'C', slides: [textSlide('s2-3', 'Song 2 Chorus')] },
  ]);
  return {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: [
        { id: 'i0', kind: 'presentation', presentationId: 'prayer' },
        { id: 'i1', kind: 'presentation', presentationId: 's1' },
        { id: 'i2', kind: 'presentation', presentationId: 's2' },
      ],
    },
    presentations: { prayer, s1, s2 },
    media: { vid: media('vid', 'video') },
    fonts: [],
    looks: [],
    files: [],
    manifestId: 'm1',
  };
}

describe('ADR 0015 closed-manifest live adjustments', () => {
  it('item.skip steps over skipped items on next/prev/nextItem/prevItem and auto-unskips on explicit go', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: makeFixture() },
      { k: 'go', cueIndex: 0, at: 100 }, // prayer (i0) live, s1 (i1, cue 1) armed
    ]);
    expect(s.live).toBe(0);
    expect(s.armed).toBe(1);

    // Skip i1 (s1): armed should jump to i2 (cue 5)
    s = reduce(s, { k: 'item.skip', itemId: 'i1', skipped: true });
    expect(checkInvariants(s)).toEqual([]);
    expect(s.armed).toBe(5);
    expect(s.cues[1]?.skipped).toBe(true);

    // Next jumps straight from i0 to i2 (cue 5)
    s = reduce(s, { k: 'next', at: 200 });
    expect(s.live).toBe(5);
    expect(s.cues[s.live!]?.itemId).toBe('i2');

    // Prev jumps straight back from i2 (cue 5) to i0 (cue 0), stepping over i1
    s = reduce(s, { k: 'prev', at: 300 });
    expect(s.live).toBe(0);

    // nextItem steps over i1 to i2
    s = reduce(s, { k: 'nextItem', at: 400 });
    expect(s.live).toBe(5);

    // prevItem steps over i1 back to i0
    s = reduce(s, { k: 'prevItem', at: 500 });
    expect(s.live).toBe(0);

    // Cannot skip currently active item i0
    const before = s;
    s = reduce(s, { k: 'item.skip', itemId: 'i0', skipped: true });
    expect(s.resolved?.playlist.items[0]?.skipped).toBeUndefined();
    expect(s.cues[0]?.skipped).toBeUndefined();
    expect(s.seq).toBe(before.seq + 1);

    // Explicit go into skipped i1 auto-unskips it and arms cue 2
    s = reduce(s, { k: 'go', cueIndex: 1, at: 600 });
    expect(checkInvariants(s)).toEqual([]);
    expect(s.live).toBe(1);
    expect(s.cues[1]?.skipped).toBeUndefined();
    expect(s.resolved?.playlist.items[1]?.skipped).toBeUndefined();
    expect(s.armed).toBe(2);
  });

  it('item.arrange re-expands off-air song cues and remaps live/armed/layer indices cleanly', () => {
    // Go live on i2 (Song 2, cue 5), then rearrange i1 (Song 1, BEFORE i2) to repeat Chorus twice
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: makeFixture() },
      { k: 'go', cueIndex: 5, at: 100 }, // i2, first slide 's2-1'
    ]);
    expect(s.live).toBe(5);
    expect(s.layers.slide.content?.cueIndex).toBe(5);
    expect(s.layers.slide.content?.slideId).toBe('s2-1');
    expect(s.armed).toBe(6);

    // Add an extra Chorus to i1 (+1 cue before i2)
    s = reduce(s, { k: 'item.arrange', itemId: 'i1', sections: ['s1-v1', 's1-c', 's1-v2', 's1-c'] });
    expect(checkInvariants(s)).toEqual([]);
    expect(s.live).toBe(6);
    expect(s.layers.slide.content?.cueIndex).toBe(6);
    expect(s.layers.slide.content?.slideId).toBe('s2-1');
    expect(s.cues[6]?.slideId).toBe('s2-1');
    expect(s.armed).toBe(7);

    // Arranging the currently active item i2 is refused (no-op)
    const cuesBefore = s.cues.length;
    s = reduce(s, { k: 'item.arrange', itemId: 'i2', sections: ['s2-c'] });
    expect(s.cues.length).toBe(cuesBefore);
    expect(checkInvariants(s)).toEqual([]);

    // Clearing override (null) restores i1 back to original count (-1 cue)
    s = reduce(s, { k: 'item.arrange', itemId: 'i1', sections: null });
    expect(checkInvariants(s)).toEqual([]);
    expect(s.live).toBe(5);
    expect(s.layers.slide.content?.cueIndex).toBe(5);
    expect(s.armed).toBe(6);
  });

  it('item.arrange allows rearranging the next (auto-armed) song while Prayer is ON AIR', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: makeFixture() },
      { k: 'go', cueIndex: 0, at: 100 }, // Prayer ON AIR, s1 cue 1 auto-armed
    ]);
    expect(s.live).toBe(0);
    expect(s.armed).toBe(1);
    expect(s.cues[1]?.slideId).toBe('s1-1');

    // Rearrange s1 to start with Chorus ('s1-c')
    s = reduce(s, { k: 'item.arrange', itemId: 'i1', sections: ['s1-c', 's1-v1'] });
    expect(checkInvariants(s)).toEqual([]);
    expect(s.live).toBe(0);
    expect(s.armed).toBe(1);
    expect(s.cues[1]?.slideId).toBe('s1-3'); // Chorus is now cue 1 and armed!
  });

  it('item.hideSlides skips per-service hidden slides and re-arms', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: makeFixture() },
      { k: 'go', cueIndex: 0, at: 100 },
    ]);
    // Hide first two slides of s1
    s = reduce(s, { k: 'item.hideSlides', itemId: 'i1', hiddenSlides: ['s1-1', 's1-2'] });
    expect(checkInvariants(s)).toEqual([]);
    expect(s.cues[1]?.hidden).toBe(true);
    expect(s.cues[2]?.hidden).toBe(true);
    expect(s.armed).toBe(3); // Chorus
  });

  it('slide.editText updates off-air native slide text and refuses on-air slides', () => {
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved: makeFixture() },
      { k: 'go', cueIndex: 0, at: 100 }, // p1 is ON AIR
    ]);

    // Refused on ON AIR slide p1
    s = reduce(s, {
      k: 'slide.editText',
      presentationId: 'prayer',
      slideId: 'p1',
      objectId: 'p1-t',
      text: 'Changed',
    });
    expect(s.cues[0]?.label).toBe('Prayer');

    // Allowed on off-air slide s1-1
    s = reduce(s, {
      k: 'slide.editText',
      presentationId: 's1',
      slideId: 's1-1',
      objectId: 's1-1-t',
      text: 'Fixed Lyric',
    });
    expect(checkInvariants(s)).toEqual([]);
    expect(s.cues[1]?.label).toBe('Fixed Lyric');
    const obj = s.resolved?.presentations.s1?.sections[0]?.slides[0]?.objects[0];
    expect(obj?.type === 'text' && obj.text).toBe('Fixed Lyric');
  });

  it('isLiveEventShape accepts all four new adjustment events', () => {
    expect(isLiveEventShape({ k: 'item.skip', itemId: 'i1', skipped: true })).toBe(true);
    expect(isLiveEventShape({ k: 'item.arrange', itemId: 'i1', sections: ['a'] })).toBe(true);
    expect(isLiveEventShape({ k: 'item.arrange', itemId: 'i1', sections: null })).toBe(true);
    expect(isLiveEventShape({ k: 'item.hideSlides', itemId: 'i1', hiddenSlides: ['s1'] })).toBe(true);
    expect(
      isLiveEventShape({
        k: 'slide.editText',
        presentationId: 's1',
        slideId: 's1-1',
        objectId: 'o1',
        text: 'Hi',
      }),
    ).toBe(true);
  });

  it('preserves all invariants across arbitrary sequences of navigation and live adjustments', () => {
    const sectionChoices = [
      null,
      ['s1-v1'],
      ['s1-c', 's1-v1', 's1-c'],
      ['s1-v1', 's1-c', 's1-v2', 's1-c'],
      ['s2-c', 's2-v1'],
    ];
    const eventArb: fc.Arbitrary<LiveEvent> = fc.oneof(
      fc.record({ k: fc.constant('next' as const), at: fc.nat(10000) }),
      fc.record({ k: fc.constant('prev' as const), at: fc.nat(10000) }),
      fc.record({ k: fc.constant('nextItem' as const), at: fc.nat(10000) }),
      fc.record({ k: fc.constant('prevItem' as const), at: fc.nat(10000) }),
      fc.record({ k: fc.constant('go' as const), cueIndex: fc.nat(12), at: fc.nat(10000) }),
      fc.record({ k: fc.constant('select' as const), cueIndex: fc.nat(12) }),
      fc.record({
        k: fc.constant('item.skip' as const),
        itemId: fc.constantFrom('i0', 'i1', 'i2'),
        skipped: fc.boolean(),
      }),
      fc.record({
        k: fc.constant('item.arrange' as const),
        itemId: fc.constantFrom('i1', 'i2'),
        sections: fc.constantFrom(...sectionChoices),
      }),
      fc.record({
        k: fc.constant('item.hideSlides' as const),
        itemId: fc.constantFrom('i1', 'i2'),
        hiddenSlides: fc.subarray(['s1-1', 's1-2', 's1-3', 's2-1']),
      }),
      fc.record({
        k: fc.constant('slide.editText' as const),
        presentationId: fc.constant('s1'),
        slideId: fc.constantFrom('s1-1', 's1-3'),
        objectId: fc.constantFrom('s1-1-t', 's1-3-t'),
        text: fc.constantFrom('Updated A', 'Updated B'),
      }),
    );

    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 40 }), (events) => {
        let s: LiveState = reduce(initialState(), { k: 'goLive', resolved: makeFixture() });
        expect(checkInvariants(s)).toEqual([]);
        for (const ev of events) {
          s = reduce(s, ev);
          expect(checkInvariants(s)).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
