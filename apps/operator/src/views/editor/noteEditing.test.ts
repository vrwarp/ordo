import { describe, expect, it } from 'vitest';
import { computeBulletBackspace, computeBulletEnter, computeNoteFormatting } from './noteEditing.ts';

describe('computeNoteFormatting', () => {
  describe('highlight (**...**)', () => {
    it('wraps selected text and keeps the inner text selected', () => {
      expect(computeNoteFormatting('Emphasize grace here', 10, 15, 'highlight')).toEqual({
        next: 'Emphasize **grace** here',
        selStart: 12,
        selEnd: 17,
      });
    });

    it('unwraps when clicked a second time with inner text still selected', () => {
      expect(computeNoteFormatting('Emphasize **grace** here', 12, 17, 'highlight')).toEqual({
        next: 'Emphasize grace here',
        selStart: 10,
        selEnd: 15,
      });
    });

    it('unwraps when the selection itself includes the ** markers', () => {
      expect(computeNoteFormatting('Emphasize **grace** here', 10, 19, 'highlight')).toEqual({
        next: 'Emphasize grace here',
        selStart: 10,
        selEnd: 15,
      });
    });

    it('always inserts empty **** with caret inside when collapsed, even mid-word', () => {
      expect(computeNoteFormatting('', 0, 0, 'highlight')).toEqual({
        next: '****',
        selStart: 2,
        selEnd: 2,
      });
      expect(computeNoteFormatting('hello', 2, 2, 'highlight')).toEqual({
        next: 'he****llo',
        selStart: 4,
        selEnd: 4,
      });
    });

    it('toggles off empty **** when clicked again with caret inside', () => {
      expect(computeNoteFormatting('****', 2, 2, 'highlight')).toEqual({
        next: '',
        selStart: 0,
        selEnd: 0,
      });
    });
  });

  describe('cue ([...])', () => {
    it('wraps selected text with [...] instead of deleting it', () => {
      expect(computeNoteFormatting('Play video now', 0, 10, 'cue')).toEqual({
        next: '[Play video] now',
        selStart: 1,
        selEnd: 11,
      });
    });

    it('unwraps when clicked a second time with inner text still selected', () => {
      expect(computeNoteFormatting('[Play video] now', 1, 11, 'cue')).toEqual({
        next: 'Play video now',
        selStart: 0,
        selEnd: 10,
      });
    });

    it('unwraps when the selection itself includes the brackets', () => {
      expect(computeNoteFormatting('[PAUSE]', 0, 7, 'cue')).toEqual({
        next: 'PAUSE',
        selStart: 0,
        selEnd: 5,
      });
    });

    it('always inserts empty [] with caret inside when collapsed, even mid-word', () => {
      expect(computeNoteFormatting('', 0, 0, 'cue')).toEqual({
        next: '[]',
        selStart: 1,
        selEnd: 1,
      });
      expect(computeNoteFormatting('hello', 2, 2, 'cue')).toEqual({
        next: 'he[]llo',
        selStart: 3,
        selEnd: 3,
      });
    });

    it('toggles off empty [] when clicked again with caret inside', () => {
      expect(computeNoteFormatting('[]', 1, 1, 'cue')).toEqual({
        next: '',
        selStart: 0,
        selEnd: 0,
      });
    });
  });

  describe('bullet (• )', () => {
    it('inserts "• " on an empty line with caret AFTER the bullet (not selected)', () => {
      expect(computeNoteFormatting('', 0, 0, 'bullet')).toEqual({
        next: '• ',
        selStart: 2,
        selEnd: 2,
      });
    });

    it('toggles bullet on and off while preserving caret position mid-line', () => {
      const on = computeNoteFormatting('Point one', 5, 5, 'bullet');
      expect(on).toEqual({
        next: '• Point one',
        selStart: 7,
        selEnd: 7,
      });
      expect(computeNoteFormatting(on.next, on.selStart, on.selEnd, 'bullet')).toEqual({
        next: 'Point one',
        selStart: 5,
        selEnd: 5,
      });
    });

    it('toggles bullets across a multi-line selection', () => {
      expect(computeNoteFormatting('One\nTwo', 1, 6, 'bullet')).toEqual({
        next: '• One\n• Two',
        selStart: 3,
        selEnd: 10,
      });
      expect(computeNoteFormatting('• One\n• Two', 3, 10, 'bullet')).toEqual({
        next: 'One\nTwo',
        selStart: 1,
        selEnd: 6,
      });
    });
  });
});

describe('computeBulletEnter', () => {
  it('continues a bullet list on Enter when the line has content', () => {
    expect(computeBulletEnter('• First item', 12, 12)).toEqual({
      next: '• First item\n• ',
      selStart: 15,
      selEnd: 15,
    });
  });

  it('splits a bullet line cleanly when pressing Enter mid-line', () => {
    expect(computeBulletEnter('• First second', 7, 7)).toEqual({
      next: '• First\n•  second',
      selStart: 10,
      selEnd: 10,
    });
  });

  it('exits the bullet list when pressing Enter on an empty bullet line', () => {
    expect(computeBulletEnter('• First\n• ', 10, 10)).toEqual({
      next: '• First\n',
      selStart: 8,
      selEnd: 8,
    });
  });

  it('returns null on a non-bullet line', () => {
    expect(computeBulletEnter('Plain text', 10, 10)).toBeNull();
  });
});

describe('computeBulletBackspace', () => {
  it('removes the entire "• " prefix in one keypress when caret is right after it', () => {
    expect(computeBulletBackspace('• ', 2, 2)).toEqual({
      next: '',
      selStart: 0,
      selEnd: 0,
    });
    expect(computeBulletBackspace('• Item', 2, 2)).toEqual({
      next: 'Item',
      selStart: 0,
      selEnd: 0,
    });
  });

  it('returns null when caret is further into the line', () => {
    expect(computeBulletBackspace('• Item', 4, 4)).toBeNull();
  });
});
