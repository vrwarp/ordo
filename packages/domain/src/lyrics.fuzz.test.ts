/**
 * Fuzzing of the lyric parser (design/25 "Fuzzing"): random text must never throw, finish in bounded time
 * and produce a well-formed song. Regression tests for every defect the fuzzer found are at the bottom.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expandCues } from './cues.ts';
import {
  LYRIC_LABEL_MAX,
  LYRIC_LINE_MAX,
  LYRIC_META_MAX,
  LYRIC_REPEAT_MAX,
  parseLyrics,
  parseSectionLabel,
  songFromParsed,
} from './lyrics.ts';
import { budgetMs } from './timing.test-util.ts';

/** Lines biased towards what the parser branches on: labels, directives, chords, footers, whitespace. */
const lineArb = fc.oneof(
  { weight: 4, arbitrary: fc.string({ maxLength: 40 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'grapheme', maxLength: 30 }) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom('Verse', 'Chorus', 'Bridge', 'Pre-Chorus', 'Tag', 'V', 'C', 'PC', 'Misc', 'Intro'),
        fc.option(fc.nat({ max: 99999 }), { nil: undefined }),
        fc.constantFrom('', ':', ' x2', ' (x3)', ' 2x', ' (repeat)', ' x99999999', ' repeat 7 times'),
        fc.constantFrom('', '[]', '()'),
      )
      .map(([l, n, rep, br]) => {
        const s = `${l}${n === undefined ? '' : ` ${n}`}${rep}`;
        return br ? `${br[0]}${s}${br[1]}` : s;
      }),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom(
          'title',
          't',
          'artist',
          'ccli',
          'copyright',
          'key',
          'tempo',
          'c',
          'comment',
          'soc',
          'eoc',
          'sov',
          'eov',
          'sob',
          'eob',
          'start_of_verse',
          'start_of_chorus',
          'end_of_chorus',
          'start_of_x',
          'unknown',
        ),
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
      )
      .map(([k, v]) => (v === undefined ? `{${k}}` : `{${k}: ${v}}`)),
  },
  { weight: 1, arbitrary: fc.constantFrom('G C D', '[G]Amazing [C]grace', 'Am  F  |  C  G', 'A', 'Be') },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      'CCLI Song # 1234567',
      '© 2020 Someone',
      'For use solely with',
      'CCLI License # 1',
    ),
  },
  { weight: 2, arbitrary: fc.constantFrom('', ' ', '\t', '   \t  ', '\u00a0', '\u2028', '\uFEFF', '\0') },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 20 }) },
);
const eolArb = fc.constantFrom('\n', '\r\n', '\r');
const textArb = fc
  .tuple(fc.array(fc.tuple(lineArb, eolArb), { maxLength: 60 }), fc.constantFrom('', '\uFEFF'))
  .map(([lines, bom]) => bom + lines.map(([l, e]) => l + e).join(''));

function checkSong(input: string) {
  const song = parseLyrics(input);
  const labels = new Set<string>();
  for (const s of song.sections) {
    expect(s.stanzas.length).toBeGreaterThan(0);
    for (const st of s.stanzas) {
      expect(st.length).toBeGreaterThan(0);
      for (const l of st) {
        expect(l.trim()).toBe(l);
        expect(l.length).toBeGreaterThan(0);
        expect(l.length).toBeLessThanOrEqual(LYRIC_LINE_MAX);
        expect(l).not.toMatch(/[\r\n]/);
      }
    }
    expect(s.label.length).toBeGreaterThan(0);
    expect(s.label.length).toBeLessThanOrEqual(LYRIC_LABEL_MAX);
    expect(s.short.length).toBeLessThanOrEqual(LYRIC_LABEL_MAX);
    expect(labels.has(s.label)).toBe(false);
    labels.add(s.label);
    expect(Object.keys(s).sort()).toEqual(
      s.chords ? ['chords', 'label', 'short', 'stanzas'] : ['label', 'short', 'stanzas'],
    );
  }
  for (const l of song.order) expect(labels.has(l)).toBe(true);
  for (const k of ['title', 'author', 'ccli', 'copyright', 'key'] as const) {
    const v = song[k];
    if (v !== undefined) expect(v.length).toBeLessThanOrEqual(LYRIC_META_MAX);
  }
  if (song.tempo !== undefined) {
    expect(Number.isFinite(song.tempo)).toBe(true);
    expect(song.tempo).toBeGreaterThan(0);
  }
  // The presentation built from it is consistent and expands to cues.
  const p = songFromParsed(song);
  const ids = new Set(p.sections.map((s) => s.id));
  for (const a of p.arrangements) for (const id of a.sectionIds) expect(ids.has(id)).toBe(true);
  for (const s of p.sections) expect(s.slides.length).toBeGreaterThan(0);
  const cues = expandCues({
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'x',
      items: [{ id: 'i', kind: 'presentation', presentationId: p.id }],
    },
    presentations: { [p.id]: p },
    media: {},
  });
  cues.forEach((c, i) => {
    expect(c.index).toBe(i);
  });
  return song;
}

describe('parseLyrics (fuzz)', () => {
  it('never throws and produces a well-formed song for structured random text', () => {
    fc.assert(
      fc.property(textArb, (t) => {
        checkSong(t);
      }),
      { numRuns: 1500 },
    );
  });

  it('never throws on arbitrary unicode and binary-ish strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (t) => {
        checkSong(t);
      }),
      { numRuns: 1500 },
    );
  });

  it('parseSectionLabel: never throws, labels are bounded and re-parse to themselves', () => {
    fc.assert(
      fc.property(fc.oneof(lineArb, fc.string({ unit: 'binary', maxLength: 200 })), (l) => {
        const r = parseSectionLabel(l);
        if (!r) return;
        expect(r.label.length).toBeLessThanOrEqual(LYRIC_LABEL_MAX);
        if (r.repeat !== undefined) {
          expect(Number.isInteger(r.repeat)).toBe(true);
          expect(r.repeat).toBeGreaterThanOrEqual(2);
          expect(r.repeat).toBeLessThanOrEqual(LYRIC_REPEAT_MAX);
        }
        // Round trip: the normalized label is itself a label with the same normal form.
        const again = parseSectionLabel(r.label);
        expect(again).toEqual({ label: r.label, short: r.short });
      }),
      { numRuns: 3000 },
    );
  });
});

describe('parseLyrics regressions found by fuzzing', () => {
  it('bounds a huge repeat count instead of allocating it ("Chorus x99999999")', () => {
    const t0 = Date.now();
    const s = parseLyrics('Chorus x99999999\nla la\n');
    expect(s.order.length).toBeLessThanOrEqual(LYRIC_REPEAT_MAX);
    expect(Date.now() - t0).toBeLessThan(budgetMs(1000));
  });

  it('is linear on long whitespace runs (no regex backtracking blow-up)', () => {
    const lines = [
      `a${' '.repeat(60_000)}b`,
      `Chorus${' '.repeat(60_000)}x`,
      `{title:${' '.repeat(60_000)}x`,
      `x${'\t '.repeat(30_000)}`,
    ];
    for (const l of lines) {
      const t0 = Date.now();
      checkSong(l);
      expect(Date.now() - t0).toBeLessThan(budgetMs(1500));
    }
  });

  it('clamps huge lines, titles and section numbers', () => {
    const s = checkSong(`${'T'.repeat(5000)}\n\nVerse ${'9'.repeat(400)}\n${'w '.repeat(5000)}\n`);
    expect(s.title!.length).toBeLessThanOrEqual(LYRIC_META_MAX);
  });

  it('ignores a non-finite or negative tempo', () => {
    expect(parseLyrics('{tempo: Infinity}\nVerse\nx').tempo).toBeUndefined();
    expect(parseLyrics('{tempo: -5}\nVerse\nx').tempo).toBeUndefined();
    expect(parseLyrics('{tempo: 1e400}\nVerse\nx').tempo).toBeUndefined();
    expect(parseLyrics('{tempo: 72}\nVerse\nx').tempo).toBe(72);
  });

  it('keeps BOM, NUL and line-separator characters out of lyrics and labels', () => {
    const s = checkSong('\uFEFFVerse 1\u2028\nline\u0000 one\n');
    const joined = s.sections[0]!.stanzas.flat().join('');
    expect(joined.includes('\u0000') || joined.includes('\uFEFF')).toBe(false);
  });
});
