/**
 * Fuzzing of parseSongFile (design/25 "Fuzzing"): any text, including UTF-16 read as Latin-1 (NULs between
 * characters), BOMs and CRLF, yields a schema-valid song presentation.
 */
import { LYRIC_LABEL_MAX, Presentation as PresentationSchema } from '@ordo/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseSongFile } from './songselect.ts';

/** How a UTF-16LE file looks when decoded byte by byte: a NUL after every ASCII character. */
const utf16ish = (s: string) => `ÿþ${[...s].map((c) => `${c}\u0000`).join('')}`;

function check(text: string, linesPerSlide?: number) {
  const p = parseSongFile(text, { linesPerSlide });
  const r = PresentationSchema.safeParse(p);
  expect(r.success, JSON.stringify(r.error?.issues?.slice(0, 2))).toBe(true);
  const ids = new Set(p.sections.map((s) => s.id));
  for (const a of p.arrangements) for (const id of a.sectionIds) expect(ids.has(id)).toBe(true);
  for (const s of p.sections) {
    expect(s.label.length).toBeLessThanOrEqual(LYRIC_LABEL_MAX);
    expect(s.slides.length).toBeGreaterThan(0);
    for (const sl of s.slides) expect(sl.objects.length).toBe(1);
  }
  return p;
}

describe('parseSongFile (fuzz)', () => {
  it('never throws on arbitrary text and returns a schema-valid song', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 300 }),
          fc.string({ unit: 'grapheme', maxLength: 300 }),
        ),
        fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined }),
        (t, lps) => {
          check(t, lps);
          check(`﻿${t.replace(/\n/g, '\r\n')}`, lps);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('regression: a UTF-16 file decoded as Latin-1 still yields its sections', () => {
    const p = check(utf16ish('Verse 1\r\nAmazing grace\r\n\r\nChorus\r\nHow sweet\r\n'));
    expect(p.sections.map((s) => s.label)).toEqual(['Verse 1', 'Chorus']);
    expect(p.sections[0]!.slides[0]!.objects[0]).toMatchObject({ text: 'Amazing grace' });
    expect(p.title).toBe('Untitled song');
  });
});
