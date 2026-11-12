import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LYRIC_STYLE,
  type Presentation,
  type SlideObject,
  type TextObject,
  type TextRun,
} from '@ordo/domain';
import { IMPORT_LIMITS, cutText, sanitizePresentation } from './sanitize.ts';

/**
 * design/27 §3.2 and §14.7: runs and paragraph styles are cut together with the text, so whatever an
 * importer writes, the stored object's annotations stay inside its text.
 */

function textObject(text: string, runs: TextRun[], paras: TextObject['paras']): TextObject {
  return {
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    text,
    style: DEFAULT_LYRIC_STYLE,
    opacity: 1,
    runs,
    paras,
  };
}

const paragraphs = (t: string) => t.split('\n').length;

/** Runs are sorted, do not overlap, are not empty and lie inside the text. */
function checkRuns(o: TextObject): void {
  let at = 0;
  for (const r of o.runs ?? []) {
    expect(r.start).toBeGreaterThanOrEqual(at);
    expect(r.end).toBeGreaterThan(r.start);
    expect(r.end).toBeLessThanOrEqual(o.text.length);
    at = r.end;
  }
  expect((o.paras ?? []).length).toBeLessThanOrEqual(paragraphs(o.text));
}

const text = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.array(fc.constantFrom('ab', ' ', '\n', '😀', 'שלום'), { maxLength: 100 }).map((a) => a.join('')),
);
const run = fc
  .record({ start: fc.integer({ min: -3, max: 220 }), len: fc.integer({ min: -3, max: 60 }) })
  .map(({ start, len }) => ({ start, end: start + len }) as TextRun);
const para = fc.oneof(fc.constant(null), fc.record({ level: fc.integer({ min: 0, max: 8 }) }));

describe('sanitize: runs and paragraph styles are cut with the text', () => {
  it('keeps runs sorted, non-overlapping and in range, and paras within the paragraphs (property)', () => {
    fc.assert(
      fc.property(
        text,
        fc.array(run, { maxLength: 40 }),
        fc.array(para, { maxLength: 40 }),
        fc.nat({ max: 220 }),
        (t, runs, paras, cut) => {
          const sorted = [...runs].sort((a, b) => a.start - b.start);
          for (const input of [runs, sorted]) {
            const o = cutText(textObject(t, input, paras), cut);
            expect(o.text.length).toBeLessThanOrEqual(cut);
            checkRuns(o);
            // Every kept run is an input run, its end clamped to the cut.
            for (const r of o.runs ?? [])
              expect(input.some((x) => x.start === r.start && Math.min(x.end, o.text.length) === r.end)).toBe(
                true,
              );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('drops a run that starts at or past the cut and clamps the one across it', () => {
    const o = cutText(
      textObject(
        'hello\nworld',
        [
          { start: 2, end: 9 },
          { start: 9, end: 11 },
        ],
        [{ level: 1 }, { level: 2 }],
      ),
      7,
    );
    expect(o.text).toBe('hello\nw');
    expect(o.runs).toEqual([{ start: 2, end: 7 }]);
    expect(o.paras).toEqual([{ level: 1 }, { level: 2 }]);
    expect(cutText(textObject('a\nb\nc', [], [null, null, null, null]), 3).paras).toEqual([null, null]);
  });

  it('keeps at most 16 distinct run and bullet families and 64 size scales per object', () => {
    const runs: TextRun[] = Array.from({ length: 2000 }, (_, i) => ({
      start: i * 5,
      end: i * 5 + 4,
      fontFamily: `Family ${i}`,
      sizeScale: 0.5 + i / 2000,
    }));
    const o = cutText(
      {
        id: 't',
        type: 'text',
        box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        text: 'x'.repeat(10_000),
        style: DEFAULT_LYRIC_STYLE,
        opacity: 1,
        runs,
        paras: [{ bullet: { char: '•', fontFamily: 'Bullet Face' } }],
      },
      IMPORT_LIMITS.text,
    );
    expect(new Set(o.runs!.map((r) => r.fontFamily).filter(Boolean)).size).toBe(IMPORT_LIMITS.runFamilies);
    expect('fontFamily' in o.runs![16]!).toBe(false);
    expect(new Set(o.runs!.map((r) => r.sizeScale)).size).toBe(IMPORT_LIMITS.sizeScales);
    expect(o.paras![0]!.bullet).toEqual({ char: '•' });
  });

  it('keys a family by its cleaned name, as the render plan does, and stores one spelling of it', () => {
    // Sixteen names the render plan reads as one family (quotes, backslashes, control characters, case and
    // surrounding spaces): they take one place in the budget, so the next family is still kept.
    const variants = [
      'Arial',
      '"Arial"',
      'Ar\u0001ial',
      'Ari\u0085al',
      'Ari\\al',
      'Arial ',
      ' arial ',
      'ARIAL',
      '\tArial',
      'Ar\u000cial',
      'Arial\u0000',
      'aRiAl',
      'Arial  ',
      'Ar"ial',
      '\u007fArial',
      'ArIaL',
    ];
    const runs: TextRun[] = [...variants, 'Georgia', 'Georgia '].map((f, i) => ({
      start: i,
      end: i + 1,
      fontFamily: f,
    }));
    const o = cutText(
      textObject('x'.repeat(40), runs, [{ bullet: { char: '•', fontFamily: '"georgia"' } }]),
      IMPORT_LIMITS.text,
    );
    expect(o.runs!.map((r) => r.fontFamily)).toEqual([...variants.map(() => 'Arial'), 'Georgia', 'Georgia']);
    expect(o.paras![0]!.bullet).toEqual({ char: '•', fontFamily: 'Georgia' });
    // A name that is nothing but what the render plan removes is no family.
    const none = cutText(textObject('xy', [{ start: 0, end: 1, fontFamily: '\u0001"\\ ' }], []), 10);
    expect('fontFamily' in none.runs![0]!).toBe(false);
  });

  it('keeps a 1 pt run (2 px) as the render plan draws it, and floors smaller runs there', () => {
    const o = (runs: TextRun[]) =>
      cutText({ ...textObject('a\n \nb', runs, []), style: { ...DEFAULT_LYRIC_STYLE, fontSizePx: 14 } }, 10);
    // PowerPoint's 1 pt spacer paragraph between 7 pt lines: sizeScale 2/14, not raised to 4 px.
    expect(o([{ start: 2, end: 3, sizeScale: 2 / 14 }]).runs).toEqual([
      { start: 2, end: 3, sizeScale: 2 / 14 },
    ]);
    expect(IMPORT_LIMITS.runFontSizeMin).toBe(2);
    expect(o([{ start: 2, end: 3, sizeScale: 0.01 }]).runs![0]!.sizeScale).toBeCloseTo(2 / 14, 12);
  });

  it('bounds run sizes and keeps legacy objects as they were', () => {
    const p: Presentation = {
      id: 'p',
      rev: 1,
      kind: 'presentation',
      title: 'T',
      meta: { tags: [] },
      sections: [
        {
          id: 's',
          label: 'Slides',
          short: 'S',
          slides: [
            {
              id: 'sl',
              objects: [
                {
                  ...textObject('x'.repeat(12_000), [{ start: 0, end: 12_000, sizeScale: 40 }], [null]),
                  style: { ...DEFAULT_LYRIC_STYLE, fontSizePx: 100 },
                },
                {
                  id: 'plain',
                  type: 'text',
                  box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
                  text: 'plain',
                  style: DEFAULT_LYRIC_STYLE,
                  opacity: 1,
                },
              ],
            },
          ],
        },
      ],
      arrangements: [],
    } as unknown as Presentation;
    const out = sanitizePresentation(p);
    const [rich, plain] = out.sections[0]!.slides[0]!.objects as TextObject[];
    expect(rich!.text).toHaveLength(IMPORT_LIMITS.text);
    expect(rich!.runs).toEqual([{ start: 0, end: IMPORT_LIMITS.text, sizeScale: 10 }]);
    expect(Object.keys(plain!).sort()).toEqual(['box', 'id', 'opacity', 'style', 'text', 'type']);
  });

  it('clamps and preserves TextStyle.lineMask (fill and gradient) and ImageObject.shadow/softEdge', () => {
    const p: Presentation = {
      id: 'p',
      rev: 1,
      kind: 'presentation',
      title: 'Mask and Image Effects',
      meta: { tags: [] },
      sections: [
        {
          id: 's',
          label: 'Slides',
          short: 'S',
          slides: [
            {
              id: 'sl',
              objects: [
                {
                  id: 't-mask-fill',
                  type: 'text',
                  box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
                  text: 'Mask fill',
                  opacity: 1,
                  style: {
                    ...DEFAULT_LYRIC_STYLE,
                    lineMask: {
                      style: 'lineWidth',
                      heightOffsetPx: 5000, // over 2000
                      vOffsetPx: -3000, // under -2000
                      widthOffsetPx: 10000, // over 4000
                      hOffsetPx: -9000, // under -4000
                      fill: { r: 300, g: -10, b: 50, a: 2 },
                    },
                  },
                },
                {
                  id: 't-mask-grad',
                  type: 'text',
                  box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
                  text: 'Mask grad',
                  opacity: 1,
                  style: {
                    ...DEFAULT_LYRIC_STYLE,
                    lineMask: {
                      style: 'maxLineWidth',
                      heightOffsetPx: 20,
                      vOffsetPx: 5,
                      widthOffsetPx: 40,
                      hOffsetPx: 10,
                      gradient: {
                        kind: 'linear',
                        angle: 90,
                        stops: [
                          { at: -1, color: { r: 255, g: 0, b: 0, a: 1 } },
                          { at: 2, color: { r: 0, g: 0, b: 255, a: 1 } },
                        ],
                      },
                    },
                  },
                },
                {
                  id: 't-mask-empty',
                  type: 'text',
                  box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
                  text: 'Mask empty',
                  opacity: 1,
                  style: {
                    ...DEFAULT_LYRIC_STYLE,
                    lineMask: {
                      style: 'fullWidth',
                      heightOffsetPx: 10,
                    } as unknown as NonNullable<typeof DEFAULT_LYRIC_STYLE.lineMask>,
                  },
                },
                {
                  id: 'img-fx',
                  type: 'image',
                  box: { x: 10, y: 10, w: 400, h: 300, rotation: 0 },
                  mediaId: 'm1',
                  fit: 'contain',
                  opacity: 1,
                  radius: 0,
                  shadow: {
                    dx: 1000,
                    dy: -1000,
                    blur: 800,
                    color: { r: 0, g: 0, b: 0, a: 0.5 },
                  },
                  softEdge: 999,
                },
                {
                  id: 'img-no-soft',
                  type: 'image',
                  box: { x: 10, y: 10, w: 400, h: 300, rotation: 0 },
                  mediaId: 'm2',
                  fit: 'contain',
                  opacity: 1,
                  radius: 0,
                  softEdge: 0,
                },
              ],
            },
          ],
        },
      ],
      arrangements: [],
    } as unknown as Presentation;

    const out = sanitizePresentation(p);
    const objs = out.sections[0]!.slides[0]!.objects;

    const t1 = objs[0] as TextObject;
    expect(t1.style.lineMask).toEqual({
      style: 'lineWidth',
      heightOffsetPx: 2000,
      vOffsetPx: -2000,
      widthOffsetPx: 4000,
      hOffsetPx: -4000,
      fill: { r: 255, g: 0, b: 50, a: 1 },
    });

    const t2 = objs[1] as TextObject;
    expect(t2.style.lineMask).toEqual({
      style: 'maxLineWidth',
      heightOffsetPx: 20,
      vOffsetPx: 5,
      widthOffsetPx: 40,
      hOffsetPx: 10,
      gradient: {
        kind: 'linear',
        angle: 90,
        stops: [
          { at: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
          { at: 1, color: { r: 0, g: 0, b: 255, a: 1 } },
        ],
      },
    });

    const t3 = objs[2] as TextObject;
    expect(t3.style.lineMask).toBeUndefined();

    const img1 = objs[3] as Extract<SlideObject, { type: 'image' }>;
    expect(img1.shadow).toEqual({
      dx: 500,
      dy: -500,
      blur: 500,
      color: { r: 0, g: 0, b: 0, a: 0.5 },
    });
    expect(img1.softEdge).toBe(500);

    const img2 = objs[4] as Extract<SlideObject, { type: 'image' }>;
    expect(img2.softEdge).toBeUndefined();
  });

  describe('sanitizePresentation: lineMask, ImageObject and TextObject edge cases', () => {
    it('clamps TextStyle.lineMask offsets and drops lineMask when neither fill nor valid gradient remains', () => {
      const p: Presentation = {
        id: 'p',
        rev: 1,
        kind: 'presentation',
        title: 'LineMask Tests',
        meta: { tags: [] },
        sections: [
          {
            id: 's',
            label: 'Slides',
            short: 'S',
            slides: [
              {
                id: 'sl',
                objects: [
                  {
                    id: 't-nan-offsets',
                    type: 'text',
                    box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
                    text: 'Hostile offsets',
                    opacity: 1,
                    style: {
                      ...DEFAULT_LYRIC_STYLE,
                      lineMask: {
                        style: 'lineWidth',
                        heightOffsetPx: Number.NaN,
                        vOffsetPx: 1e9,
                        widthOffsetPx: -1e9,
                        hOffsetPx: Number.NaN,
                        fill: { r: 100, g: 100, b: 100, a: 1 },
                      },
                    },
                  },
                  {
                    id: 't-invalid-gradient-no-fill',
                    type: 'text',
                    box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
                    text: 'Dropped mask single stop',
                    opacity: 1,
                    style: {
                      ...DEFAULT_LYRIC_STYLE,
                      lineMask: {
                        style: 'fullWidth',
                        heightOffsetPx: 10,
                        gradient: {
                          kind: 'linear',
                          stops: [{ at: 0.5, color: { r: 255, g: 0, b: 0, a: 1 } }],
                        },
                      },
                    },
                  },
                  {
                    id: 't-gradient-stops-clamping',
                    type: 'text',
                    box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
                    text: 'Clamped stops',
                    opacity: 1,
                    style: {
                      ...DEFAULT_LYRIC_STYLE,
                      lineMask: {
                        style: 'maxLineWidth',
                        gradient: {
                          kind: 'linear',
                          angle: Number.NaN,
                          stops: [
                            { at: 5, color: { r: 300, g: -20, b: 50, a: 2 } },
                            { at: -2, color: { r: 10, g: 20, b: 30, a: -0.5 } },
                            ...Array.from({ length: 25 }, (_, i) => ({
                              at: 0.1 + i * 0.02,
                              color: { r: 0, g: 0, b: 0, a: 1 },
                            })),
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
        arrangements: [],
      } as unknown as Presentation;

      const out = sanitizePresentation(p);
      const objs = out.sections[0]!.slides[0]!.objects as TextObject[];

      // Hostile offsets become finite and clamped: NaN -> 0, 1e9 -> 2000, -1e9 -> -4000
      expect(objs[0]!.style.lineMask).toEqual({
        style: 'lineWidth',
        heightOffsetPx: 0,
        vOffsetPx: 2000,
        widthOffsetPx: -4000,
        hOffsetPx: 0,
        fill: { r: 100, g: 100, b: 100, a: 1 },
      });

      // Single stop gradient without fill is dropped
      expect(objs[1]!.style.lineMask).toBeUndefined();

      // Gradient stops: sorted by at, clamped to [0, 1], max 16 stops, color channels clamped
      const lm = objs[2]!.style.lineMask!;
      expect(lm).toBeDefined();
      expect(lm.gradient).toBeDefined();
      expect(lm.gradient!.angle).toBe(0); // NaN angle -> 0
      expect(lm.gradient!.stops.length).toBe(16);
      expect(lm.gradient!.stops[0]).toEqual({
        at: 0, // from -2
        color: { r: 10, g: 20, b: 30, a: 0 },
      });
      expect(lm.gradient!.stops[lm.gradient!.stops.length - 1]).toEqual({
        at: 1, // from 5
        color: { r: 255, g: 0, b: 50, a: 1 },
      });
      for (let i = 0; i < lm.gradient!.stops.length - 1; i++) {
        expect(lm.gradient!.stops[i]!.at).toBeLessThanOrEqual(lm.gradient!.stops[i + 1]!.at);
        expect(lm.gradient!.stops[i]!.at).toBeGreaterThanOrEqual(0);
        expect(lm.gradient!.stops[i]!.at).toBeLessThanOrEqual(1);
      }
    });

    it('clamps and filters ImageObject shadow, softEdge, mask, and crop', () => {
      const p: Presentation = {
        id: 'p',
        rev: 1,
        kind: 'presentation',
        title: 'Image Tests',
        meta: { tags: [] },
        sections: [
          {
            id: 's',
            label: 'Slides',
            short: 'S',
            slides: [
              {
                id: 'sl',
                objects: [
                  {
                    id: 'img-hostile',
                    type: 'image',
                    box: { x: 0, y: 0, w: 200, h: 200, rotation: 0 },
                    mediaId: 'm1',
                    fit: 'contain',
                    opacity: 1,
                    radius: 0,
                    shadow: {
                      dx: Number.NaN,
                      dy: 9999,
                      blur: -100,
                      color: { r: 999, g: -50, b: 100, a: 5 },
                    },
                    softEdge: Number.NaN,
                    crop: { l: -10, t: Number.NaN, r: 50, b: 0.25 },
                    mask: {
                      preset: 'P'.repeat(100),
                      paths: [
                        { d: 'invalid path data', w: 100, h: 100 },
                        { d: 'M 0 0 L 100 100 Z', w: Number.NaN, h: 2e9 },
                      ],
                    },
                  },
                  {
                    id: 'img-huge-soft',
                    type: 'image',
                    box: { x: 0, y: 0, w: 200, h: 200, rotation: 0 },
                    mediaId: 'm2',
                    fit: 'contain',
                    opacity: 1,
                    radius: 0,
                    softEdge: 2500,
                    crop: 'not-an-object' as unknown as NonNullable<
                      Extract<SlideObject, { type: 'image' }>['crop']
                    >,
                  },
                  {
                    id: 'img-negative-soft',
                    type: 'image',
                    box: { x: 0, y: 0, w: 200, h: 200, rotation: 0 },
                    mediaId: 'm3',
                    fit: 'contain',
                    opacity: 1,
                    radius: 0,
                    softEdge: -10,
                    mask: {
                      preset: '',
                      paths: [{ d: 'invalid' }],
                    },
                  },
                ],
              },
            ],
          },
        ],
        arrangements: [],
      } as unknown as Presentation;

      const out = sanitizePresentation(p);
      const objs = out.sections[0]!.slides[0]!.objects as Extract<SlideObject, { type: 'image' }>[];

      // img-hostile:
      // shadow: dx NaN -> 0, dy 9999 -> 500, blur -100 -> 0, color clamped
      expect(objs[0]!.shadow).toEqual({
        dx: 0,
        dy: 500,
        blur: 0,
        color: { r: 255, g: 0, b: 100, a: 1 },
      });
      // softEdge: NaN is <= 0, so dropped
      expect(objs[0]!.softEdge).toBeUndefined();
      // crop: l clamped to -1, t NaN -> 0, r clamped to 1, b 0.25
      expect(objs[0]!.crop).toEqual({ l: -1, t: 0, r: 1, b: 0.25 });
      // mask: preset cut to 40, invalid path dropped, valid path cleanPathData & finite dimensions
      expect(objs[0]!.mask!.preset).toBe('P'.repeat(40));
      expect(objs[0]!.mask!.paths).toHaveLength(1);
      expect(objs[0]!.mask!.paths![0]!.d).toBe('M 0 0 L 100 100 Z');
      expect(objs[0]!.mask!.paths![0]!.w).toBe(0); // NaN -> 0
      expect(objs[0]!.mask!.paths![0]!.h).toBe(1e9); // 2e9 -> 1e9 (PATH_DATA_LIMITS.coord)

      // img-huge-soft:
      // softEdge clamped to 500
      expect(objs[1]!.softEdge).toBe(500);
      // crop non-object deleted
      expect(objs[1]!.crop).toBeUndefined();

      // img-negative-soft:
      // softEdge <= 0 dropped
      expect(objs[2]!.softEdge).toBeUndefined();
      // mask with no valid preset or paths dropped
      expect(objs[2]!.mask).toBeUndefined();
    });

    it('clamps and filters TextObject runs and paras (out-of-range indices, NaN sizeScale/baseline/spaceAfterPx/indentPx)', () => {
      const p: Presentation = {
        id: 'p',
        rev: 1,
        kind: 'presentation',
        title: 'Runs and Paras Tests',
        meta: { tags: [] },
        sections: [
          {
            id: 's',
            label: 'Slides',
            short: 'S',
            slides: [
              {
                id: 'sl',
                objects: [
                  {
                    id: 't-runs-paras',
                    type: 'text',
                    box: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
                    text: 'first line\nsecond line',
                    style: { ...DEFAULT_LYRIC_STYLE, fontSizePx: 20 },
                    opacity: 1,
                    runs: [
                      { start: -5, end: 4 }, // negative start -> dropped
                      { start: 0, end: 3.5 as unknown as number }, // non-integer end -> dropped
                      { start: 0, end: 5, sizeScale: Number.NaN, baseline: Number.NaN }, // NaN scale & baseline -> defaults (1, 0)
                      { start: 3, end: 8 }, // overlapping previous run ending at 5 -> dropped
                      { start: 6, end: 10, sizeScale: 9999 }, // huge sizeScale -> clamped to maxScale (1000/20 = 50)
                      { start: 15, end: 12 }, // end <= start -> dropped
                      { start: 50, end: 60 }, // start >= text.length -> dropped
                    ],
                    paras: [
                      {
                        spaceAfterPx: Number.NaN,
                        indentPx: Number.NaN,
                        spaceBeforePx: Number.NaN,
                        firstLinePx: Number.NaN,
                        lineSpacing: Number.NaN,
                        lineSpacingPx: Number.NaN,
                        level: Number.NaN,
                        bullet: {
                          char: '•',
                          startAt: Number.NaN,
                          sizePct: Number.NaN,
                        },
                      },
                      {
                        spaceAfterPx: 999999, // over LOGICAL_WIDTH (1920)
                        indentPx: -999999, // under -LOGICAL_WIDTH (-1920)
                        lineSpacing: 50, // over 13.2
                      },
                      {
                        level: 3, // extra paragraph beyond the 2 lines in text -> dropped
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        arrangements: [],
      } as unknown as Presentation;

      const out = sanitizePresentation(p);
      const t = out.sections[0]!.slides[0]!.objects[0] as TextObject;

      // Runs: out of range, non-integers, and overlaps dropped
      expect(t.runs).toHaveLength(2);
      expect(t.runs![0]).toEqual({
        start: 0,
        end: 5,
        sizeScale: 1,
        baseline: 0,
      });
      expect(t.runs![1]!.start).toBe(6);
      expect(t.runs![1]!.end).toBe(10);
      expect(t.runs![1]!.sizeScale).toBe(50);

      // Paras: exactly 2 paragraphs kept
      expect(t.paras).toHaveLength(2);
      expect(t.paras![0]).toEqual({
        spaceAfterPx: 0,
        indentPx: 0,
        spaceBeforePx: 0,
        firstLinePx: 0,
        lineSpacing: 1,
        lineSpacingPx: 0,
        level: 0,
        bullet: {
          char: '•',
          startAt: 1,
          sizePct: 1,
        },
      });
      expect(t.paras![1]).toEqual({
        spaceAfterPx: 1920, // LOGICAL_WIDTH
        indentPx: -1920, // -LOGICAL_WIDTH
        lineSpacing: 13.2, // max 13.2
      });
    });
  });
});
