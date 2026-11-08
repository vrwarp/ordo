import { type Presentation, parseLyrics, songFromParsed } from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import { describe, expect, it } from 'vitest';
import { groupCues, itemGoTarget, sectionGoTarget } from '../src/lib/sections.ts';

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

describe('section and item clicks with hidden slides (design/27 §9)', () => {
  const slide = (id: string, hidden?: true) => ({ id, objects: [], ...(hidden ? { hidden } : {}) });
  const deck: Presentation = {
    id: 'deck',
    rev: 1,
    title: 'Deck',
    kind: 'slides',
    meta: { tags: [] },
    sections: [
      { id: 'a', label: 'Intro', short: 'I', slides: [slide('h1', true), slide('s1')] },
      { id: 'b', label: 'Extras', short: 'E', slides: [slide('x1', true), slide('x2', true)] },
    ],
    arrangements: [],
    archived: false,
  };
  const s = reduce(initialState(), {
    k: 'goLive',
    resolved: {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'x',
        items: [
          { id: 'i0', kind: 'presentation', presentationId: 'deck' },
          { id: 'i1', kind: 'presentation', presentationId: 'deck' },
        ],
      },
      presentations: { deck },
      media: {},
      fonts: [],
      looks: [],
      files: [],
      manifestId: 'm',
    },
  });

  it("a section header goes to the section's first shown slide, else its first slide", () => {
    const [intro, extras] = groupCues(s.cues.filter((c) => c.itemIndex === 1));
    expect(s.cues[sectionGoTarget(intro!)!]).toMatchObject({ itemIndex: 1, slideId: 's1' });
    expect(s.cues[sectionGoTarget(extras!)!]).toMatchObject({ itemIndex: 1, slideId: 'x1', hidden: true });
  });

  it("a playlist item double-click goes to the item's first shown slide, where Next item lands", () => {
    const target = itemGoTarget(s.cues, 1)!;
    expect(s.cues[target]).toMatchObject({ itemIndex: 1, slideId: 's1' });
    const viaNextItem = reduce(reduce(s, { k: 'go', cueIndex: 1, at: 1 }), { k: 'nextItem', at: 2 });
    expect(viaNextItem.live).toBe(target);
    expect(itemGoTarget(s.cues, 5)).toBeUndefined();
  });
});
