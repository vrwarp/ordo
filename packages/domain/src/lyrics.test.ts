import { describe, expect, it } from 'vitest';
import { parseLyrics, parseSectionLabel, sectionSlideTexts, songFromParsed } from './lyrics.ts';
import { expandCues } from './cues.ts';

describe('parseSectionLabel', () => {
  it('recognises labels and short forms', () => {
    expect(parseSectionLabel('Verse 1')).toEqual({ label: 'Verse 1', short: 'V1' });
    expect(parseSectionLabel('[Chorus]')).toEqual({ label: 'Chorus', short: 'C' });
    expect(parseSectionLabel('C2:')).toEqual({ label: 'Chorus 2', short: 'C2' });
    expect(parseSectionLabel('Pre-Chorus')).toEqual({ label: 'Pre-Chorus', short: 'PC' });
    expect(parseSectionLabel('{c: Bridge}')).toEqual({ label: 'Bridge', short: 'B' });
    expect(parseSectionLabel('Amazing grace')).toBeNull();
  });
});

const SONGSELECT = `Great Song Title

Verse 1
Line one of verse
Line two of verse
Line three of verse
Line four of verse

Chorus
Chorus line one
Chorus line two

Verse 2
Second verse one
Second verse two

Chorus
Chorus line one
Chorus line two

CCLI Song # 1234567
Some Writer
© 2020 Some Publisher
For use solely with the SongSelect® Terms of Use. All rights reserved. www.ccli.com
CCLI License # 99999`;

describe('parseLyrics', () => {
  it('parses a SongSelect text export', () => {
    const s = parseLyrics(SONGSELECT);
    expect(s.title).toBe('Great Song Title');
    expect(s.ccli).toBe('1234567');
    expect(s.copyright).toContain('2020 Some Publisher');
    expect(s.sections.map((x) => x.label)).toEqual(['Verse 1', 'Chorus', 'Verse 2']);
    expect(s.order).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Chorus']);
    expect(s.sections[0]!.stanzas[0]).toHaveLength(4);
  });

  it('parses ChordPro and strips chords', () => {
    const s = parseLyrics(`{title: Song}
{artist: Someone}
{ccli: 555}
{c: Verse 1}
[G]Amazing [C]grace how [G]sweet
That saved a wretch
{c: Chorus}
[D]My chains are gone`);
    expect(s.title).toBe('Song');
    expect(s.author).toBe('Someone');
    expect(s.ccli).toBe('555');
    expect(s.sections[0]!.stanzas[0]).toEqual(['Amazing grace how sweet', 'That saved a wretch']);
    expect(s.sections[0]!.chords?.[0]).toBe('G C G');
    expect(s.sections[1]!.label).toBe('Chorus');
  });

  it('drops chord-only lines', () => {
    const s = parseLyrics('Verse 1\nG   C   D\nHello world');
    expect(s.sections[0]!.stanzas).toEqual([['Hello world']]);
    expect(s.sections[0]!.chords).toEqual(['G   C   D'.trim()]);
  });

  it('treats unlabelled text as Verse 1', () => {
    const s = parseLyrics('\n\n\nfirst\nsecond\n\nthird');
    expect(s.sections[0]!.label).toBe('Verse 1');
  });
});

describe('slides and arrangements', () => {
  it('chunks stanzas by lines per slide', () => {
    expect(sectionSlideTexts({ label: 'V', short: 'V', stanzas: [['a', 'b', 'c', 'd', 'e']] }, 2)).toEqual([
      'a\nb',
      'c\nd',
      'e',
    ]);
  });

  it('builds a song whose default arrangement repeats sections in order', () => {
    const p = songFromParsed(parseLyrics(SONGSELECT), { linesPerSlide: 2 });
    expect(p.sections).toHaveLength(3);
    const labels = p.arrangements[0]!.sectionIds.map((id) => p.sections.find((s) => s.id === id)!.label);
    expect(labels).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Chorus']);
    const cues = expandCues({
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'x',
        items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }],
      },
      presentations: { [p.id]: p },
      media: {},
    });
    // V1 has 4 lines -> 2 slides, chorus 1 slide, V2 1 slide, chorus 1 slide
    expect(cues.map((c) => c.sectionShort)).toEqual(['V1', 'V1', 'C', 'V2', 'C']);
    expect(cues.map((c) => c.arrangementPos)).toEqual([0, 0, 1, 2, 3]);
  });
});
