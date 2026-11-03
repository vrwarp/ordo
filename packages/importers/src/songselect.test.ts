import { describe, expect, it } from 'vitest';
import { parseSongFile } from './songselect.ts';

const TEXT_EXPORT = `﻿Blessed Assurance

Verse 1
Blessed assurance Jesus is mine
O what a foretaste of glory divine
Heir of salvation purchase of God
Born of His Spirit washed in His blood

Chorus
This is my story this is my song
Praising my Saviour all the day long

Verse 2
Perfect submission perfect delight
Visions of rapture now burst on my sight

CCLI Song # 22324
Fanny Crosby | Phoebe Palmer Knapp
Public Domain
For use solely with the SongSelect® Terms of Use. All rights reserved. www.ccli.com
CCLI License # 1234567
`;

const CHORDPRO = `{title: Come Thou Fount}
{artist: Robert Robinson}
{ccli: 108389}
{copyright: Public Domain}
{key: D}

{comment: Verse 1}
[D]Come thou fount of [G]every [D]blessing
[D]Tune my heart to [A]sing thy [D]grace

{c: Chorus}
[G]Here's my heart Lord
[D]Take and seal it
`;

describe('parseSongFile', () => {
  it('parses the SongSelect lyrics text export', () => {
    const p = parseSongFile(TEXT_EXPORT);
    expect(p.title).toBe('Blessed Assurance');
    expect(p.kind).toBe('song');
    expect(p.source).toEqual({ kind: 'songselect' });
    expect(p.meta.ccli).toBe('22324');
    expect(p.meta.author).toBe('Fanny Crosby | Phoebe Palmer Knapp');
    expect(p.sections.map((s) => s.label)).toEqual(['Verse 1', 'Chorus', 'Verse 2']);
    // 4-line verse at 2 lines per slide gives 2 slides.
    expect(p.sections[0]!.slides).toHaveLength(2);
    const obj = p.sections[0]!.slides[0]!.objects[0]!;
    expect(obj.type === 'text' && obj.text).toBe(
      'Blessed assurance Jesus is mine\nO what a foretaste of glory divine',
    );
  });

  it('parses ChordPro and keeps chords per section', () => {
    const p = parseSongFile(CHORDPRO, { linesPerSlide: 4 });
    expect(p.title).toBe('Come Thou Fount');
    expect(p.meta).toMatchObject({
      author: 'Robert Robinson',
      ccli: '108389',
      copyright: 'Public Domain',
      key: 'D',
    });
    expect(p.linesPerSlide).toBe(4);
    expect(p.sections.map((s) => s.short)).toEqual(['V1', 'C']);
    expect(p.sections[0]!.chords).toEqual(['D G D', 'D A D']);
    const obj = p.sections[0]!.slides[0]!.objects[0]!;
    expect(obj.type === 'text' && obj.text).toBe(
      'Come thou fount of every blessing\nTune my heart to sing thy grace',
    );
  });

  it('honours an explicit title', () => {
    expect(parseSongFile(CHORDPRO, { title: 'Fount' }).title).toBe('Fount');
  });
});
