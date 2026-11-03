import { type Presentation, parseLyrics, songFromParsed } from '@ordo/domain';

/**
 * Parse a SongSelect download (ChordPro `.cho`/`.txt` or the lyrics text export) into a song presentation.
 * The same parser powers New song from paste; only the source kind differs.
 */
export function parseSongFile(
  text: string,
  opts: { linesPerSlide?: number; title?: string } = {},
): Presentation {
  const clean = text.replace(/^﻿/, '');
  const parsed = parseLyrics(clean);
  return songFromParsed(parsed, {
    title: opts.title,
    linesPerSlide: opts.linesPerSlide,
    source: { kind: 'songselect' },
  });
}
