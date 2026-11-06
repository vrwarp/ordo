import { DEFAULT_LYRIC_STYLE } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { clampStyle } from './clamp.ts';

describe('font family clamp', () => {
  it('removes quotes, backslashes and every control character, so the font shorthand always parses', () => {
    // A form feed is a CSS newline: Canvas would ignore the whole font assignment and keep the last font.
    const family = (f: string) => clampStyle({ ...DEFAULT_LYRIC_STYLE, fontFamily: f }).fontFamily;
    expect(family('A\fB')).toBe('AB');
    expect(family('A\u0000\t\u000b\n\r\u001b\u007f\u0085  B')).toBe('AB');
    expect(family('"Times\\" New Roman')).toBe('Times New Roman');
    expect(family('Noto Sans Hebrew')).toBe('Noto Sans Hebrew');
  });
});
