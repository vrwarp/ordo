import { type Presentation, parseLyrics, songFromParsed } from '@ordo/domain';

/**
 * Parse a SongSelect download (ChordPro `.cho`/`.txt` or the lyrics text export) into a song presentation.
 * The same parser powers New song from paste; only the source kind differs.
 */
export function parseSongFile(
  text: string,
  opts: { linesPerSlide?: number; title?: string } = {},
): Presentation {
  // A UTF-8 BOM, or a UTF-16 BOM read as Latin-1 (the NULs between characters are dropped by the parser).
  const clean = text.replace(/^(?:\uFEFF|\u00ff\u00fe|\u00fe\u00ff)/, '');
  const parsed = parseLyrics(clean);
  return songFromParsed(parsed, {
    title: opts.title,
    linesPerSlide: opts.linesPerSlide,
    source: { kind: 'songselect' },
  });
}
