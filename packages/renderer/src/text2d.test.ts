import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE } from '@ordo/domain';
import { layoutText, wrapLines } from './text2d.ts';

function fakeCtx() {
  // Every glyph is 10px wide at any font; enough to test wrapping and alignment maths.
  return {
    font: '',
    letterSpacing: '0px',
    measureText: (s: string) => ({ width: s.length * 10 }) as TextMetrics,
  } as unknown as CanvasRenderingContext2D;
}

describe('text layout', () => {
  it('wraps words greedily and breaks long words', () => {
    const ctx = fakeCtx();
    expect(wrapLines(ctx, 'aaa bbb ccc', 75)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapLines(ctx, 'abcdefghij', 40)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapLines(ctx, 'one\n\ntwo', 100)).toEqual(['one', '', 'two']);
  });

  it('centres a block and shrinks to fit when asked', () => {
    const ctx = fakeCtx();
    const style = { ...DEFAULT_LYRIC_STYLE, padding: 0, fontSizePx: 100, lineHeight: 1 };
    const box = { x: 0, y: 0, w: 200, h: 100, rotation: 0 };
    const l = layoutText(ctx, 'ab', style, box, 1);
    expect(l.lines[0]).toMatchObject({ x: 90, y: 0, width: 20 });
    const fitted = layoutText(ctx, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', style, box, 1, true);
    expect(fitted.fontSize).toBeLessThan(100);
    expect(fitted.fontSize).toBeGreaterThanOrEqual(50);
  });
});
