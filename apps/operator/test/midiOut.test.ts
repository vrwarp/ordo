import type { Cue, LiveState, ResolvedMidiCue } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { midiCuesOnChange, midiDestinationKey } from '../src/lib/midiOut.ts';

function cue(partial: Partial<Cue> & { index: number; itemId: string }): Cue {
  return {
    itemIndex: 0,
    kind: 'slide',
    label: `Slide ${partial.index + 1}`,
    ...partial,
  };
}

function liveState(cues: Cue[], live: number | undefined, mode: LiveState['mode'] = 'live'): LiveState {
  return {
    mode,
    cues,
    live,
    resolved: {
      playlist: { id: 'pl-1', name: 'Sunday', items: [], updatedAt: '2026-01-01T00:00:00Z' },
      presentations: {},
      media: {
        'bg-blue': {
          id: 'bg-blue',
          kind: 'image',
          name: 'Blue Clouds',
          hash: 'h1',
          mime: 'image/jpeg',
          bytes: 100,
          createdAt: '2026-01-01T00:00:00Z',
        },
        'bg-gold': {
          id: 'bg-gold',
          kind: 'image',
          name: 'Gold Rays',
          hash: 'h2',
          mime: 'image/jpeg',
          bytes: 100,
          createdAt: '2026-01-01T00:00:00Z',
        },
      },
      looks: {},
      themes: {},
      timers: {},
      messages: {},
    },
  } as unknown as LiveState;
}

const pb1Cue1: ResolvedMidiCue = {
  id: 'c1',
  channel: 1,
  type: 'noteOn',
  number: 48,
  value: 1,
  presetName: 'Lights: Full',
};
const pb1Cue3: ResolvedMidiCue = {
  id: 'c3',
  channel: 1,
  type: 'noteOn',
  number: 48,
  value: 3,
  presetName: 'Chorus Lift',
};
const pb1Cue4: ResolvedMidiCue = {
  id: 'c4',
  channel: 1,
  type: 'noteOn',
  number: 48,
  value: 4,
  presetName: 'Bridge Hit',
};
const pb2Blue: ResolvedMidiCue = {
  id: 'c5',
  channel: 1,
  type: 'noteOn',
  number: 49,
  value: 2,
  presetName: 'Wash: Blue',
};
const pb2Gold: ResolvedMidiCue = {
  id: 'c6',
  channel: 1,
  type: 'noteOn',
  number: 49,
  value: 3,
  presetName: 'Wash: Gold',
};

describe('midiDestinationKey', () => {
  it('groups note/cc by device, channel, type, and number', () => {
    expect(midiDestinationKey(pb1Cue1)).toBe('|1|noteOn|48');
    expect(midiDestinationKey(pb2Blue)).toBe('|1|noteOn|49');
  });

  it('groups programChange by device and channel regardless of program number', () => {
    expect(midiDestinationKey({ deviceName: 'QuickQ', channel: 1, type: 'programChange', number: 5 })).toBe(
      'quickq|1|programChange',
    );
    expect(midiDestinationKey({ deviceName: ' quickq ', channel: 1, type: 'programChange', number: 9 })).toBe(
      'quickq|1|programChange',
    );
  });
});

describe('midiCuesOnChange', () => {
  it('suppresses MIDI on fromSnapshot, initial hydration, Clear Slide, and unchanged live cue', () => {
    const cues = [
      cue({ index: 0, itemId: 'song-1', arrangementPos: 0, itemMidi: [pb1Cue1], midiCues: [pb1Cue4] }),
    ];
    const idle = liveState([], undefined, 'idle');
    const s0 = liveState(cues, 0);
    const cleared = liveState(cues, undefined);

    expect(midiCuesOnChange(cleared, s0, { fromSnapshot: true })).toEqual([]);
    expect(midiCuesOnChange(idle, s0)).toEqual([]);
    expect(midiCuesOnChange(s0, cleared)).toEqual([]);
    expect(midiCuesOnChange(s0, s0)).toEqual([]);
  });

  it('fires Background -> Item -> Section -> Slide on entering a song when destinations do not collide', () => {
    const cues = [
      cue({
        index: 0,
        itemId: 'song-1',
        arrangementPos: 0,
        sectionLabel: 'Verse 1',
        backgroundMediaId: 'bg-blue',
        backgroundMidi: [pb2Blue],
        itemMidi: [pb1Cue1],
      }),
      cue({
        index: 1,
        itemId: 'song-1',
        arrangementPos: 0,
        sectionLabel: 'Verse 1',
        backgroundMediaId: 'bg-blue',
        backgroundMidi: [pb2Blue],
        itemMidi: [pb1Cue1],
        midiCues: [pb1Cue4],
      }),
    ];

    const start = liveState(cues, undefined);
    const s0 = liveState(cues, 0);
    const s1 = liveState(cues, 1);

    const onEnter = midiCuesOnChange(start, s0);
    expect(onEnter.map((d) => [d.source, d.cue.number, d.cue.value])).toEqual([
      ['Background: Blue Clouds · Wash: Blue', 49, 2],
      ['Item: Slide 1 · Lights: Full', 48, 1],
    ]);

    // Same item, same section, same background -> only slide cue fires
    const onNextSlide = midiCuesOnChange(s0, s1);
    expect(onNextSlide.map((d) => [d.source, d.cue.number, d.cue.value])).toEqual([
      ['Slide: Slide 2 · Bridge Hit', 48, 4],
    ]);
  });

  it('re-fires section lighting on repeated section occurrences (different arrangementPos)', () => {
    const cues = [
      cue({ index: 0, itemId: 'song-1', arrangementPos: 0, sectionLabel: 'Chorus', sectionMidi: [pb1Cue3] }),
      cue({ index: 1, itemId: 'song-1', arrangementPos: 1, sectionLabel: 'Verse 2' }),
      cue({ index: 2, itemId: 'song-1', arrangementPos: 2, sectionLabel: 'Chorus', sectionMidi: [pb1Cue3] }),
    ];

    expect(midiCuesOnChange(liveState(cues, 0), liveState(cues, 1))).toEqual([]);
    const onSecondChorus = midiCuesOnChange(liveState(cues, 1), liveState(cues, 2));
    expect(onSecondChorus).toHaveLength(1);
    expect(onSecondChorus[0]!.source).toBe('Section: Chorus · Chorus Lift');
  });

  it('re-fires background lighting when entering a new song even if it shares the same backgroundMediaId', () => {
    const cues = [
      cue({
        index: 0,
        itemId: 'song-1',
        arrangementPos: 0,
        backgroundMediaId: 'bg-blue',
        backgroundMidi: [pb2Blue],
      }),
      cue({
        index: 1,
        itemId: 'song-2',
        arrangementPos: 0,
        backgroundMediaId: 'bg-blue',
        backgroundMidi: [pb2Blue],
      }),
    ];

    const onNextSong = midiCuesOnChange(liveState(cues, 0), liveState(cues, 1));
    expect(onNextSong).toHaveLength(1);
    expect(onNextSong[0]!.cue).toEqual(pb2Blue);
  });

  it('overrides broader scopes when a narrower scope targets the same MIDI destination key, without deduplicating within a scope', () => {
    const doubleTapSlide: ResolvedMidiCue[] = [
      { id: 'dt1', channel: 1, type: 'noteOn', number: 48, value: 4, delayMs: 0, presetName: 'Double Tap' },
      { id: 'dt2', channel: 1, type: 'noteOn', number: 48, value: 5, delayMs: 500, presetName: 'Double Tap' },
    ];
    const cues = [
      cue({
        index: 0,
        itemId: 'song-1',
        arrangementPos: 0,
        sectionLabel: 'Intro',
        backgroundMediaId: 'bg-blue',
        backgroundMidi: [pb2Blue],
        itemMidi: [pb1Cue1, pb2Gold], // pb2Gold overrides bg pb2Blue; pb1Cue1 is overridden by section/slide
        sectionMidi: [pb1Cue3], // overridden by slide
        midiCues: doubleTapSlide, // both cues in same scope preserved
      }),
    ];

    const dispatches = midiCuesOnChange(liveState(cues, undefined), liveState(cues, 0));
    expect(dispatches.map((d) => [d.cue.number, d.cue.value, d.cue.delayMs ?? 0])).toEqual([
      [49, 3, 0], // Item's pb2Gold replaced Background's pb2Blue
      [48, 4, 0], // Slide's first cue replaced Section's and Item's PB 1
      [48, 5, 500], // Slide's second cue NOT deduplicated
    ]);
  });

  it('overrides broader Program Change cues on the same channel regardless of program number', () => {
    const pcBg: ResolvedMidiCue = { id: 'pc1', channel: 2, type: 'programChange', number: 1, value: 0 };
    const pcItem: ResolvedMidiCue = { id: 'pc2', channel: 2, type: 'programChange', number: 7, value: 0 };
    const cues = [
      cue({
        index: 0,
        itemId: 'song-1',
        arrangementPos: 0,
        backgroundMediaId: 'bg-blue',
        backgroundMidi: [pcBg],
        itemMidi: [pcItem],
      }),
    ];

    const dispatches = midiCuesOnChange(liveState(cues, undefined), liveState(cues, 0));
    expect(dispatches.map((d) => d.cue)).toEqual([pcItem]);
  });
});
