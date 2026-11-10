import { DEFAULT_LYRIC_STYLE, type TextObject, type TextStyle } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  caretPosition,
  drawTextEditingOverlay,
  hitTestText,
  moveCaretVertically,
  paraRangeAt,
  selectionRects,
  toLocalBoxPoint,
  wordRangeAt,
} from './cursor.ts';
import { recordingCtx } from './test-util.ts';

function richObj(text: string, style: Partial<TextStyle> = {}, extra: Partial<TextObject> = {}): TextObject {
  return {
    id: 't1',
    type: 'text',
    box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      padding: 0,
      fontSizePx: 20,
      lineHeight: 1.2,
      align: 'left',
      valign: 'top',
      lang: 'en',
      ...style,
    },
    opacity: 1,
    ...extra,
  };
}

function legacyObj(text: string, style: Partial<TextStyle> = {}): TextObject {
  const {
    lineModel: _lm,
    insets: _in,
    wrap: _w,
    autofit: _af,
    fitScale: _fs,
    justify: _j,
    direction: _d,
    lang: _l,
    fallbackFonts: _ff,
    underline: _u,
    glow: _g,
    paint: _p,
    ...plain
  } = {
    ...DEFAULT_LYRIC_STYLE,
    padding: 0,
    fontSizePx: 20,
    lineHeight: 1.2,
    align: 'left' as const,
    valign: 'top' as const,
    ...style,
  };
  return {
    id: 't2',
    type: 'text',
    box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
    text,
    style: plain,
    opacity: 1,
  };
}

describe('canvas text editing geometry (cursor.ts)', () => {
  it('places the caret accurately across characters in rich text (10px per char at 20px)', () => {
    const ctx = recordingCtx(0.5);
    const o = richObj('Hello');
    expect(caretPosition(ctx, o, 0)).toEqual({ x: 0, y: 0, height: 24, line: 0 });
    expect(caretPosition(ctx, o, 2)).toEqual({ x: 20, y: 0, height: 24, line: 0 });
    expect(caretPosition(ctx, o, 5)).toEqual({ x: 50, y: 0, height: 24, line: 0 });
  });

  it('places the caret accurately in centered and vertically middle-aligned text', () => {
    const ctx = recordingCtx(0.5);
    // 'Hello' is 50px wide in a 200px box -> starts at x = 75.
    // 1 line of height 24px in a 100px box -> starts at y = (100 - 24) / 2 = 38.
    const o = richObj('Hello', { align: 'center', valign: 'middle' });
    expect(caretPosition(ctx, o, 0)).toEqual({ x: 75, y: 38, height: 24, line: 0 });
    expect(caretPosition(ctx, o, 5)).toEqual({ x: 125, y: 38, height: 24, line: 0 });
  });

  it('places the caret on empty lines and trailing newlines', () => {
    const ctx = recordingCtx(0.5);
    const o = richObj('Hi\n', { align: 'center', valign: 'top' });
    // Line 0: 'Hi' (20px wide, x = 90..110, y = 0)
    // Line 1: '' (0px wide, x = 100, y = 24)
    expect(caretPosition(ctx, o, 2)).toEqual({ x: 110, y: 0, height: 24, line: 0 });
    expect(caretPosition(ctx, o, 3)).toEqual({ x: 100, y: 24, height: 24, line: 1 });
  });

  it('computes selection rectangles across multiple runs and lines', () => {
    const ctx = recordingCtx(0.5);
    const o = richObj(
      'Hello\nWorld',
      {},
      {
        runs: [{ start: 0, end: 5, sizeScale: 2 }], // 'Hello' at 40px (20px/char) -> 100px wide, height 48
      },
    );
    const rects = selectionRects(ctx, o, 1, 9); // 'ello\nWor'
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual({ x: 20, y: 0, w: 80, h: 48, line: 0 });
    expect(rects[1]).toEqual({ x: 0, y: 48, w: 30, h: 24, line: 1 });
  });

  it('hit-tests character offsets with mid-glyph snapping on rich and legacy text', () => {
    const ctx = recordingCtx(0.5);
    const rObj = richObj('Hello\nWorld');
    // Character 0 covers x: 0..10 (midpoint 5)
    expect(hitTestText(ctx, rObj, 3, 10)).toBe(0);
    expect(hitTestText(ctx, rObj, 7, 10)).toBe(1);
    expect(hitTestText(ctx, rObj, 24, 10)).toBe(2);
    // Second line (y: 24..48), offset 6 is 'W'
    expect(hitTestText(ctx, rObj, 16, 30)).toBe(8);

    const lObj = legacyObj('Hello\nWorld');
    expect(hitTestText(ctx, lObj, 3, 10)).toBe(0);
    expect(hitTestText(ctx, lObj, 7, 10)).toBe(1);
    expect(hitTestText(ctx, lObj, 16, 30)).toBe(8);
  });

  it('moves caret vertically across soft-wrapped lines', () => {
    const ctx = recordingCtx(0.5);
    // 200px wide box, 10px/char -> 'Hello beautiful' (150px) on line 0, 'world today' on line 1
    const o = richObj('Hello beautiful world today');
    const c0 = caretPosition(ctx, o, 2); // 'He|llo' at x = 20, line 0
    expect(c0.line).toBe(0);
    const down = moveCaretVertically(ctx, o, 2, 1);
    expect(down.offset).toBe(18); // 'wo|rld' at x = 20 on line 1 ('world' starts at 16)
    const up = moveCaretVertically(ctx, o, down.offset, -1, down.preferredX);
    expect(up.offset).toBe(2);
  });

  it('computes word and paragraph ranges for double-click and triple-click', () => {
    const text = 'Grace and peace\nto you all!';
    expect(wordRangeAt(text, 2)).toEqual({ start: 0, end: 5 });
    expect(wordRangeAt(text, 7)).toEqual({ start: 6, end: 9 });
    expect(paraRangeAt(text, 7)).toEqual({ start: 0, end: 15 });
    expect(paraRangeAt(text, 18)).toEqual({ start: 16, end: 27 });
  });

  it('transforms rotated slide coordinates into local box coordinates', () => {
    const box = { x: 100, y: 100, w: 200, h: 100, rotation: 90 };
    // Center is (200, 150)
    expect(toLocalBoxPoint(box, 200, 150)).toEqual({ x: 100, y: 50 });
  });

  it('draws selection highlights and caret overlay onto the canvas context', () => {
    const ctx = recordingCtx(0.5);
    const o = richObj('Praise');
    drawTextEditingOverlay(ctx, o, { start: 1, end: 4, caret: 4, showCaret: true });
    const fillRects = ctx.ops.filter((op) => op.op === 'fillRect');
    expect(fillRects.length).toBeGreaterThanOrEqual(3); // 1 selection rect + 2 caret rects (halo + bar)
  });
});
