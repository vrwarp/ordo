import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type Slide, type TextObject } from '@ordo/domain';
import {
  CLAMP,
  clampBox,
  clampFamily,
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

  it('keeps at most 16 distinct run and bullet families and 64 size scales per object', () => {
    const runs = Array.from({ length: 2000 }, (_, i) => ({
      start: i * 5,
      end: i * 5 + 4,
      fontFamily: `Family ${i}`,
      sizeScale: 0.5 + i / 2000,
    }));
    const o = clampObject({
      id: 't',
      type: 'text',
      box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      text: 'x'.repeat(10_000),
      style: DEFAULT_LYRIC_STYLE,
      opacity: 1,
      runs,
      paras: [{ bullet: { char: '•', fontFamily: 'Bullet Face' } }],
    }) as TextObject;
    const families = new Set(o.runs!.map((r) => r.fontFamily).filter((f) => f !== undefined));
    expect(families.size).toBe(CLAMP.maxRunFamilies);
    expect(o.runs![16]!.fontFamily).toBeUndefined(); // the box family
    expect(new Set(o.runs!.map((r) => r.sizeScale)).size).toBe(CLAMP.maxSizeScales);
    expect(o.runs![1999]!.sizeScale).toBe(o.runs![63]!.sizeScale); // the nearest kept scale
    expect(o.paras![0]!.bullet).toEqual({ char: '•' }); // over the budget: the first run's family
    // Case does not make a family distinct.
    const same = clampRuns(
      Array.from({ length: 40 }, (_, i) => ({ start: i, end: i + 1, fontFamily: i % 2 ? 'ARIAL' : 'arial' })),
      40,
      72,
    );
    expect(same.every((r) => r.fontFamily !== undefined)).toBe(true);
  });

  it('keys a family by its cleaned name and keeps one spelling of it, so variants never make a font', () => {
    // Case, surrounding spaces, quotes and control characters: one family, one CSS name, one font lookup.
    const variants = (k: number) =>
      [
        `${' '.repeat(k % 7)}Zq${' '.repeat(k % 5)}`,
        k % 2 ? 'ZQ' : 'zq',
        `"Z\u0001q${'\u0085'.repeat(k % 3)}"`,
        `Z\\q\t`,
      ][k % 4]!;
    const runs = Array.from({ length: 2000 }, (_, k) => ({
      start: k,
      end: k + 1,
      fontFamily: k < 1000 ? variants(k) : `Family ${k % 20}`,
    }));
    const out = clampRuns(runs, 2000, 72);
    const families = new Set(out.map((r) => r.fontFamily));
    expect(out.slice(0, 1000).every((r) => r.fontFamily === 'Zq')).toBe(true);
    // The variants took one place in the budget: fifteen more families fit, and none of them twice.
    expect(families.size).toBe(1 + (CLAMP.maxRunFamilies - 1) + 1); // 'Zq', 15 families, undefined
    expect(out[1000 + 15]!.fontFamily).toBeUndefined();
    // Bullets share the budget and take the spelling a run already has.
    const o = clampObject({
      ...text(0, 'ab'),
      runs: [{ start: 0, end: 1, fontFamily: ' Wingdings ' }],
      paras: [{ bullet: { char: '§', fontFamily: 'WINGDINGS\u0000' } }],
    }) as TextObject;
    expect(o.runs![0]!.fontFamily).toBe('Wingdings');
    expect(o.paras![0]!.bullet!.fontFamily).toBe('Wingdings');
  });

  it('strips every control character from family names, so a font string stays valid', () => {
    expect(clampFamily('A\fB\u0000C\u0085D"E\\F\nG\tH')).toBe('ABCDEFGH');
    expect(clampFamily('\u0001\u0002')).toBe('');
    expect(clampStyle({ ...DEFAULT_LYRIC_STYLE, fontFamily: '\u000c' }).fontFamily).toBe(
      clampStyle({}).fontFamily,
    );
    expect(clampStyle({ ...DEFAULT_LYRIC_STYLE, fontFamily: 'Open\fSans' }).fontFamily).toBe('OpenSans');
  });

  it('caps paragraph styles at the paragraphs and at maxParas', () => {
    expect(clampParas([null, null, null], 'one\ntwo')).toHaveLength(2);
    const many = 'x\n'.repeat(3000);
    expect(clampParas(Array(5000).fill({ level: 1 }), many)).toHaveLength(CLAMP.maxParas);
    expect(clampParas('junk', 'x')).toEqual([]);
  });
});
