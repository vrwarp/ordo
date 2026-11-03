import { parseLyrics, songFromParsed } from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import { describe, expect, it } from 'vitest';
import { groupCues, sectionGoTarget } from '../src/lib/sections.ts';

/** Two songs live in one playlist, so section clicks in the item on screen can differ from the live item. */
function twoSongState() {
  const a = songFromParsed(parseLyrics('Song A\nVerse 1\na1\n\nChorus\nac\n\nVerse 2\na2'));
  const b = songFromParsed(parseLyrics('Song B\nVerse 1\nb1\n\nChorus\nbc'));
  return reduce(initialState(), {
    k: 'goLive',
    resolved: {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'x',
        items: [
          { id: 'ia', kind: 'presentation', presentationId: a.id },
          { id: 'ib', kind: 'presentation', presentationId: b.id },
        ],
      },
      presentations: { [a.id]: a, [b.id]: b },
      media: {},
      fonts: [],
      looks: [],
      files: [],
      manifestId: 'm',
    },
  });
}

describe('section click → cue index (review item 4)', () => {
  it('groups the cues of one item by section in order', () => {
    const s = twoSongState();
    const songA = groupCues(s.cues.filter((c) => c.itemIndex === 0));
    expect(songA.map((g) => g.label)).toEqual(['Verse 1', 'Chorus', 'Verse 2']);
    expect(songA.map((g) => g.cues.length)).toEqual([1, 1, 1]);
  });

  it('targets the first cue of the section in the item shown, not the live item', () => {
    let s = twoSongState();
    // Song B is live (its chorus), song A is shown with "Follow live" off.
    const bChorus = s.cues.find((c) => c.itemIndex === 1 && c.sectionLabel === 'Chorus')!;
    s = reduce(s, { k: 'go', cueIndex: bChorus.index, at: 1 });
    expect(s.live).toBe(bChorus.index);
    const shown = groupCues(s.cues.filter((c) => c.itemIndex === 0));
    const chorusA = shown.find((g) => g.label === 'Chorus')!;
    const target = sectionGoTarget(chorusA)!;
    expect(s.cues[target]).toMatchObject({ itemIndex: 0, sectionLabel: 'Chorus', slideIndexInSection: 0 });
    expect(target).not.toBe(bChorus.index);
    // And a GO with that index lands on song A's chorus.
    const after = reduce(s, { k: 'go', cueIndex: target, at: 2 });
    expect(after.cues[after.live!]).toMatchObject({ itemIndex: 0, sectionLabel: 'Chorus' });
  });

  it('has no target for an empty group', () => {
    expect(sectionGoTarget({ pos: 0, label: 'x', short: '', cues: [] })).toBeUndefined();
  });
});
