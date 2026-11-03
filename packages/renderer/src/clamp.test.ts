import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type Slide } from '@ordo/domain';
import { CLAMP, clampBox, clampLook, clampSlide, clampStyle } from './clamp.ts';

const text = (i: number, t = 'x') => ({
  id: `t${i}`,
  type: 'text' as const,
  box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
  text: t,
  style: DEFAULT_LYRIC_STYLE,
  opacity: 1,
});

describe('render-plan clamps', () => {
  it('bounds font sizes, text and object counts', () => {
    expect(clampStyle({ ...DEFAULT_LYRIC_STYLE, fontSizePx: 1 }).fontSizePx).toBe(CLAMP.minFontPx);
    expect(clampStyle({ ...DEFAULT_LYRIC_STYLE, fontSizePx: 1e9 }).fontSizePx).toBe(CLAMP.maxFontPx);
    const s = clampSlide({
      id: 's',
      objects: Array.from({ length: 300 }, (_, i) => text(i, 'y'.repeat(20_000))),
    });
    expect(s.objects).toHaveLength(CLAMP.maxObjects);
    expect((s.objects[0] as { text: string }).text).toHaveLength(CLAMP.maxTextChars);
  });

  it('keeps boxes within ±2× the canvas and drops garbage objects', () => {
    expect(clampBox({ x: -1e9, y: Number.NaN, w: 1e9, h: -4, rotation: 725 })).toEqual({
      x: -3840,
      y: 0,
      w: 7680,
      h: 0,
      rotation: 5,
    });
    const s = clampSlide({ id: 's', objects: [null, 4, { type: 'video' }, text(1)] } as unknown as Slide);
    expect(s.objects.map((o) => o.id)).toEqual(['t1']);
  });

  it('leaves valid slides and looks drawable as authored', () => {
    const s = clampSlide({ id: 's', objects: [text(1, 'Hello')] });
    expect(s.objects[0]).toMatchObject({
      text: 'Hello',
      style: { fontSizePx: DEFAULT_LYRIC_STYLE.fontSizePx },
    });
    const l = clampLook(LOOK_MAIN);
    expect(l.layers).toEqual(LOOK_MAIN.layers);
    expect(l.transition).toEqual(LOOK_MAIN.transition);
    expect(clampLook(l)).toBe(l);
  });
});
