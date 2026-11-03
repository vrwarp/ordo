import { describe, expect, it } from 'vitest';
import {
  isChordLine,
  nextFreeLabel,
  parseLyrics,
  parseSectionLabel,
  sectionSlideTexts,
  songFromParsed,
} from './lyrics.ts';
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

  it('accepts misc, letter suffixes, parentheses and repeat markers (item 22)', () => {
    expect(parseSectionLabel('Misc 1')).toEqual({ label: 'Misc 1', short: 'M1' });
    expect(parseSectionLabel('Verse 1a')).toEqual({ label: 'Verse 1a', short: 'V1a' });
    expect(parseSectionLabel('V2B')).toEqual({ label: 'Verse 2b', short: 'V2b' });
    expect(parseSectionLabel('(Chorus)')).toEqual({ label: 'Chorus', short: 'C' });
    expect(parseSectionLabel('Chorus x2')).toEqual({ label: 'Chorus', short: 'C', repeat: 2 });
    expect(parseSectionLabel('Chorus (x3)')).toEqual({ label: 'Chorus', short: 'C', repeat: 3 });
    expect(parseSectionLabel('[Bridge 2 x2]')).toEqual({ label: 'Bridge 2', short: 'B2', repeat: 2 });
    expect(parseSectionLabel('Bridge 2x')).toEqual({ label: 'Bridge', short: 'B', repeat: 2 });
    expect(parseSectionLabel('Tag (repeat)')).toEqual({ label: 'Tag', short: 'T', repeat: 2 });
    expect(parseSectionLabel('Verse 1:')).toEqual({ label: 'Verse 1', short: 'V1' });
    // Lyrics that merely end in a repeat marker are not labels.
    expect(parseSectionLabel('Sing it again x2')).toBeNull();
    expect(parseSectionLabel('x2')).toBeNull();
    expect(parseSectionLabel('Choruses')).toBeNull();
  });

  it('numbers the next free label', () => {
    expect(nextFreeLabel('Chorus', ['Verse 1', 'Chorus'])).toBe('Chorus 2');
    expect(nextFreeLabel('Chorus', ['Chorus', 'Chorus 2', 'Chorus 3'])).toBe('Chorus 4');
    expect(nextFreeLabel('Verse', ['Verse 1', 'Verse 2a', 'Chorus'])).toBe('Verse 3');
    expect(nextFreeLabel('Verse', [])).toBe('Verse 1');
  });
});

describe('isChordLine', () => {
  it('needs two chord tokens unless the file is a chord chart (item 36)', () => {
    expect(isChordLine('G   C   D')).toBe(true);
    expect(isChordLine('| G | C |')).toBe(true);
    expect(isChordLine('A')).toBe(false);
    expect(isChordLine('Am')).toBe(false);
    expect(isChordLine('A', true)).toBe(true);
    expect(isChordLine('G C Hello')).toBe(false);
    expect(isChordLine('   ')).toBe(false);
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

  it('keeps single-letter lyric lines unless the file has bracket chords (item 36)', () => {
    const plain = parseLyrics('Verse 1\nA\nmighty fortress is our God');
    expect(plain.sections[0]!.stanzas).toEqual([['A', 'mighty fortress is our God']]);
    expect(plain.sections[0]!.chords).toBeUndefined();
    const chart = parseLyrics('Verse 1\nA\n[D]mighty fortress is our God');
    expect(chart.sections[0]!.stanzas).toEqual([['mighty fortress is our God']]);
    expect(chart.sections[0]!.chords).toEqual(['A', 'D']);
  });

  it('understands ChordPro short section directives (item 36)', () => {
    const s = parseLyrics(`{sov}
first verse
{eov}
{soc}
the chorus
{eoc}
{sov}
second verse
{eov}
{sob}
bridge line
{eob}
{soc}
the chorus
{eoc}`);
    expect(s.sections.map((x) => x.label)).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Bridge']);
    expect(s.order).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Bridge', 'Chorus']);
  });

  it('promotes a repeated label with different lyrics to the next free number (item 6)', () => {
    const s = parseLyrics(`Verse 1
one
two

Chorus
sing
loud

Verse 2
three

Chorus
sing
loud

Chorus
something
new

Chorus
sing
loud

Chorus
something
new`);
    expect(s.sections.map((x) => x.label)).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Chorus 2']);
    expect(s.sections[3]!.stanzas).toEqual([['something', 'new']]);
    expect(s.sections[3]!.short).toBe('C2');
    expect(s.order).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Chorus 2', 'Chorus', 'Chorus 2']);
    // A repeat of an identical stanza differing only in case or spacing is still a repeat.
    const t = parseLyrics('Chorus\nSing  loud\n\nChorus\nsing loud');
    expect(t.sections).toHaveLength(1);
    expect(t.order).toEqual(['Chorus', 'Chorus']);
  });

  it('promotes a repeated numbered label and keeps its chords', () => {
    const s = parseLyrics('Verse 1\n[G]alpha\n\nVerse 2\nbeta\n\nVerse 1\n[C]gamma');
    expect(s.sections.map((x) => x.label)).toEqual(['Verse 1', 'Verse 2', 'Verse 3']);
    expect(s.sections[2]!.chords).toEqual(['C']);
    expect(s.order).toEqual(['Verse 1', 'Verse 2', 'Verse 3']);
  });

  it('expands a repeat marker in the order', () => {
    const s = parseLyrics('Verse 1\na\n\nChorus x2\nb\n\nVerse 2\nc\n\n(Chorus)');
    expect(s.sections.map((x) => x.label)).toEqual(['Verse 1', 'Chorus', 'Verse 2']);
    expect(s.order).toEqual(['Verse 1', 'Chorus', 'Chorus', 'Verse 2', 'Chorus']);
    const labels = songFromParsed(s).arrangements[0]!.sectionIds;
    expect(labels).toHaveLength(5);
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
