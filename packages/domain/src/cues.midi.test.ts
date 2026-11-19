import { describe, expect, it } from 'vitest';
import { expandCues, resolveMidiTrigger } from './cues.ts';
import type { Media, MidiCue, MidiPreset, Playlist, Presentation } from './schemas.ts';

const cueA: MidiCue = { id: 'c1', channel: 1, type: 'noteOn', number: 48, value: 1 };
const cueB: MidiCue = { id: 'c2', channel: 1, type: 'noteOn', number: 49, value: 2 };
const cueC: MidiCue = { id: 'c3', channel: 1, type: 'noteOn', number: 48, value: 3 };
const cueD: MidiCue = { id: 'c4', channel: 1, type: 'noteOn', number: 48, value: 4 };

const presets: MidiPreset[] = [
  { id: 'preset-full', name: 'Lights: Full', color: '#f59e0b', cues: [cueA] },
  { id: 'preset-blue', name: 'Wash: Blue', color: '#3b82f6', cues: [cueB] },
  { id: 'preset-chorus', name: 'Chorus Lift', color: '#a855f7', cues: [cueC] },
];

const bgMedia: Media = {
  id: 'bg-blue',
  rev: 1,
  kind: 'image',
  name: 'Blue Clouds',
  tags: [],
  state: 'ready',
  loop: false,
  isBackground: true,
  original: { hash: 'hash-blue', mime: 'image/jpeg', bytes: 1000, path: 'bg-blue.jpg' },
  midi: { kind: 'preset', presetId: 'preset-blue' },
};

const fgVideo: Media = {
  id: 'vid-announce',
  rev: 1,
  kind: 'video',
  name: 'Announcements',
  tags: [],
  state: 'ready',
  loop: false,
  isBackground: false,
  original: { hash: 'hash-vid', mime: 'video/mp4', bytes: 5000, path: 'vid.mp4' },
  midi: { kind: 'preset', presetId: 'preset-blue' },
};

describe('resolveMidiTrigger', () => {
  it('resolves a preset trigger and attaches presetName', () => {
    expect(resolveMidiTrigger({ kind: 'preset', presetId: 'preset-full' }, presets)).toEqual([
      { ...cueA, presetName: 'Lights: Full' },
    ]);
  });

  it('returns undefined gracefully when presetId is missing', () => {
    expect(resolveMidiTrigger({ kind: 'preset', presetId: 'deleted-id' }, presets)).toBeUndefined();
  });

  it('resolves inline cues without presetName', () => {
    expect(resolveMidiTrigger({ kind: 'cues', cues: [cueD] }, presets)).toEqual([cueD]);
  });
});

describe('expandCues MIDI trigger resolution', () => {
  it('resolves background, item, section, and slide MIDI triggers with legacy slide.midiCues fallback', () => {
    const pres: Presentation = {
      id: 'song-1',
      rev: 1,
      kind: 'song',
      title: 'Amazing Grace',
      meta: { tags: [] },
      archived: false,
      backgroundMediaId: 'bg-blue',
      sections: [
        {
          id: 'sec-v1',
          label: 'Verse 1',
          short: 'V1',
          slides: [
            { id: 's1', objects: [], midi: { kind: 'cues', cues: [cueD] } },
            // Legacy slide.midiCues fallback
            { id: 's2', objects: [], midiCues: [cueC] },
          ],
        },
        {
          id: 'sec-c',
          label: 'Chorus',
          short: 'C',
          midi: { kind: 'preset', presetId: 'preset-chorus' },
          slides: [{ id: 's3', objects: [] }],
        },
      ],
      arrangements: [{ id: 'arr-1', name: 'Default', sectionIds: ['sec-v1', 'sec-c'] }],
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const playlist: Playlist = {
      id: 'pl-1',
      rev: 1,
      name: 'Sunday',
      updatedAt: '2026-01-01T00:00:00Z',
      items: [
        {
          id: 'item-song',
          kind: 'presentation',
          presentationId: 'song-1',
          midi: { kind: 'preset', presetId: 'preset-full' },
        },
        {
          id: 'item-video',
          kind: 'media',
          mediaId: 'vid-announce',
          midi: { kind: 'preset', presetId: 'preset-full' },
        },
        {
          id: 'item-timer',
          kind: 'timer',
          timer: { kind: 'elapsed', label: 'Countdown' },
          midi: { kind: 'preset', presetId: 'preset-full' },
        },
      ],
    };

    const cues = expandCues({
      playlist,
      presentations: { 'song-1': pres },
      media: { 'bg-blue': bgMedia, 'vid-announce': fgVideo },
      midiPresets: presets,
    });

    expect(cues).toHaveLength(5);

    // Slide 1: background + item + explicit slide.midi
    expect(cues[0]!.backgroundMidi).toEqual([{ ...cueB, presetName: 'Wash: Blue' }]);
    expect(cues[0]!.itemMidi).toEqual([{ ...cueA, presetName: 'Lights: Full' }]);
    expect(cues[0]!.sectionMidi).toBeUndefined();
    expect(cues[0]!.midiCues).toEqual([cueD]);

    // Slide 2: legacy slide.midiCues fallback
    expect(cues[1]!.midiCues).toEqual([cueC]);

    // Slide 3 (Chorus): sectionMidi resolved
    expect(cues[2]!.sectionMidi).toEqual([{ ...cueC, presetName: 'Chorus Lift' }]);

    // Foreground media item: Media.midi is NOT fired as backgroundMidi; only item.midi resolves
    expect(cues[3]!.kind).toBe('media');
    expect(cues[3]!.backgroundMidi).toBeUndefined();
    expect(cues[3]!.itemMidi).toEqual([{ ...cueA, presetName: 'Lights: Full' }]);

    // Timer item: item.midi resolves
    expect(cues[4]!.kind).toBe('timer');
    expect(cues[4]!.itemMidi).toEqual([{ ...cueA, presetName: 'Lights: Full' }]);
  });
});
