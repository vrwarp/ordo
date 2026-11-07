import { describe, expect, it } from 'vitest';
import { addNote, clean, noteList, SLIDE_NOTES } from './log.ts';

describe('log', () => {
  it("addNote keeps 15 notes and 'and N more'", () => {
    const list: string[] = [];
    for (let i = 1; i <= 16; i++) addNote(list, `note ${i}`);
    // Exactly the schema's 16 fit.
    expect(list).toHaveLength(SLIDE_NOTES);
    expect(list[15]).toBe('note 16');
    addNote(list, 'note 17');
    expect(list).toHaveLength(16);
    expect(list.slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => `note ${i + 1}`));
    expect(list[15]).toBe('and 2 more');
    for (let i = 18; i <= 40; i++) addNote(list, `note ${i}`);
    expect(list).toHaveLength(16);
    expect(list[15]).toBe('and 25 more');
    // A copy goes on counting from its last entry.
    const copy = [...list];
    addNote(copy, 'note 41');
    expect(copy[15]).toBe('and 26 more');
  });

  it('addNote cleans, cuts and de-duplicates notes', () => {
    const list: string[] = [];
    addNote(list, 'a\nb');
    addNote(list, 'a b');
    addNote(list, '');
    addNote(list, 'x'.repeat(500));
    expect(list).toEqual(['a b', `${'x'.repeat(199)}…`]);
    expect(addNote(['k'], 'k', 1)).toEqual(['k']);
    expect(addNote(['k'], 'l', 1)).toEqual(['and 2 more']);
  });

  it('noteList and clean are unchanged', () => {
    const { notes, log } = noteList(3);
    for (const n of ['a', 'b', 'c', 'd', 'a']) log(n);
    expect(notes).toEqual(['a', 'b', '… 2 more']);
    expect(clean('[warn]\u0000x')).toBe('[warn] x');
  });
});
