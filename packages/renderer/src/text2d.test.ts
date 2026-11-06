import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type TextObject } from '@ordo/domain';
import { drawObject, layoutText, wrapLines } from './text2d.ts';
import { recordingCtx } from './text/test-util.ts';

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

describe('text object dispatch (design/27 §6)', () => {
  const legacy: TextObject = {
    id: 't',
    type: 'text',
    box: { x: 100, y: 100, w: 800, h: 300, rotation: 0 },
    text: 'Amazing grace',
    style: { ...DEFAULT_LYRIC_STYLE, fontSizePx: 60 },
    opacity: 1,
  };

  it('draws a legacy object through drawText at device size', () => {
    const ctx = recordingCtx();
    drawObject(ctx, legacy, 0.5);
    const fills = ctx.ops.filter((o) => o.op === 'fillText');
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) {
      expect(f.font).toContain(' 30px "Inter"');
      expect(f.transform).toEqual([1, 0, 0, 1, 0, 0]);
    }
  });

  it('draws an object with a rich field through the rich engine, in logical px under the scale', () => {
    const ctx = recordingCtx();
    drawObject(ctx, { ...legacy, runs: [{ start: 0, end: 7, fontWeight: 400 }] }, 0.5);
    const fills = ctx.ops.filter((o) => o.op === 'fillText');
    expect(fills.map((f) => f.args[0])).toContain('Amazing');
    for (const f of fills) {
      expect(f.font).toContain(' 60px "Inter"');
      expect(f.transform).toEqual([0.5, 0, 0, 0.5, 0, 0]);
    }
  });
});
