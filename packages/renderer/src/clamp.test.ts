import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type Slide, type TextObject } from '@ordo/domain';
import {
  CLAMP,
  clampBox,
  clampLook,
  clampObject,
  clampParas,
  clampRuns,
  clampSlide,
  clampStyle,
  runFontPx,
} from './clamp.ts';
import { isRichText } from './text/rich.ts';

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

describe('rich text clamps (design/27 §3.2)', () => {
  it('adds no rich field to a legacy object, so it keeps drawing through drawText', () => {
    const o = clampObject(text(1, 'Hello')) as TextObject;
    expect(Object.keys(o).sort()).toEqual(['box', 'id', 'opacity', 'style', 'text', 'type']);
    expect(Object.keys(o.style).sort()).toEqual(Object.keys(clampStyle(DEFAULT_LYRIC_STYLE)).sort());
    expect(isRichText(o)).toBe(false);
  });

  it('keeps rich fields, origin and locked, with unknown enum values at their defaults', () => {
    const o = clampObject({
      ...text(1, 'ab\ncd'),
      style: { ...DEFAULT_LYRIC_STYLE, lineModel: 'office', autofit: 'grow', direction: 'ttb', wrap: false },
      runs: [{ start: 0, end: 2, caps: 'title', fontStyle: 'italic' }],
      paras: [{ align: 'thaiDist', level: 99 }, 'junk', null],
      origin: { src: 'pptx', shapeId: 7, role: 'body' },
      locked: true,
    }) as TextObject;
    expect(o.style).toMatchObject({ lineModel: 'office', autofit: 'none', direction: 'auto', wrap: false });
    expect(o.runs).toEqual([{ start: 0, end: 2, caps: 'none', fontStyle: 'italic' }]);
    expect(o.paras).toEqual([{ align: 'left', level: 8 }, null]);
    expect(o).toMatchObject({ origin: { src: 'pptx', shapeId: 7, role: 'body' }, locked: true });
  });

  it('drops unsorted, overlapping and out-of-range runs and bounds effective sizes (property)', () => {
    const wild = fc.oneof(
      fc.integer({ min: -5, max: 300 }),
      fc.constantFrom(Number.NaN, 1.5, Infinity, undefined),
    );
    const run = fc.record({
      start: wild,
      end: wild,
      sizeScale: fc.oneof(fc.double(), fc.constant(undefined)),
    });
    fc.assert(
      fc.property(
        fc.array(run, { maxLength: 40 }),
        fc.nat({ max: 300 }),
        fc.double({ min: 1, max: 5000, noNaN: true }),
        (runs, len, size) => {
          const style = clampStyle({ ...DEFAULT_LYRIC_STYLE, fontSizePx: size });
          const out = clampRuns(runs, len, style.fontSizePx);
          let at = 0;
          for (const r of out) {
            expect(Number.isInteger(r.start) && Number.isInteger(r.end)).toBe(true);
            expect(r.start).toBeGreaterThanOrEqual(at);
            expect(r.end).toBeGreaterThan(r.start);
            expect(r.end).toBeLessThanOrEqual(len);
            at = r.end;
            const px = style.fontSizePx * (r.sizeScale ?? 1);
            expect(px).toBeGreaterThanOrEqual(CLAMP.minFontPx - 1e-9);
            expect(px).toBeLessThanOrEqual(CLAMP.maxFontPx + 1e-9);
            expect(runFontPx(style, r, 0.001)).toBe(CLAMP.minFontPx);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('caps paragraph styles at the paragraphs and at maxParas', () => {
    expect(clampParas([null, null, null], 'one\ntwo')).toHaveLength(2);
    const many = 'x\n'.repeat(3000);
    expect(clampParas(Array(5000).fill({ level: 1 }), many)).toHaveLength(CLAMP.maxParas);
    expect(clampParas('junk', 'x')).toEqual([]);
  });
});
