import { describe, expect, it } from 'vitest';
import { parseLyrics, songFromParsed } from '@ordo/domain';
import {
  arrangementLabel,
  duplicateAt,
  insertSection,
  moveAt,
  parseArrangement,
  pruneArrangement,
  removeAt,
  upsertArrangement,
} from '../src/lib/arrangement.ts';

const p = songFromParsed(parseLyrics('Verse 1\na\n\nChorus\nb\n\nVerse 2\nc\n\nBridge\nd'));
const [v1, c, v2, b] = p.sections.map((s) => s.id) as [string, string, string, string];

describe('arrangement editing', () => {
  it('inserts, removes, moves and duplicates', () => {
    let a = { id: 'x', name: 'Sunday', sectionIds: [v1, c] };
    a = insertSection(a, v2);
    a = insertSection(a, c);
    expect(arrangementLabel(a, p)).toBe('V1 C V2 C');
    a = insertSection(a, b, 4);
    a = duplicateAt(a, 3);
    expect(arrangementLabel(a, p)).toBe('V1 C V2 C C B');
    a = moveAt(a, 5, 4);
    expect(arrangementLabel(a, p)).toBe('V1 C V2 C B C');
    a = removeAt(a, 0);
    expect(arrangementLabel(a, p)).toBe('C V2 C B C');
    expect(removeAt(a, 99)).toBe(a);
  });
  it('parses typed arrangements', () => {
    const r = parseArrangement('V1 C V2 c B C C X9', p);
    expect(r.sectionIds).toEqual([v1, c, v2, c, b, c, c]);
    expect(r.unknown).toEqual(['X9']);
  });
  it('prunes deleted sections and upserts', () => {
    const a = { id: 'x', name: 'n', sectionIds: [v1, 'gone', c] };
    expect(pruneArrangement(a, p).sectionIds).toEqual([v1, c]);
    const p2 = upsertArrangement(p, a);
    expect(p2.arrangements).toHaveLength(2);
    expect(upsertArrangement(p2, { ...a, name: 'm' }).arrangements[1]?.name).toBe('m');
  });
});
