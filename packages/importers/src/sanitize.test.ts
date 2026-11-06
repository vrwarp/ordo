import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type Presentation, type TextObject, type TextRun } from '@ordo/domain';
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
});
