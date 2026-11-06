/**
 * Editing the plain text of a rich text object (design/27 §11 item 1, §14 item 9): runs and paragraph styles
 * follow every change, and 10,000 random edits keep runs sorted, non-overlapping and in range.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import type { TextObject, TextPara, TextRun } from './schemas.ts';
import { editText, joinText, replaceText } from './textEdit.ts';

function obj(text: string, runs?: TextRun[], paras?: (TextPara | null)[]): TextObject {
  const o: TextObject = {
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    text,
    style: { ...DEFAULT_LYRIC_STYLE, autofit: 'shrink', fitScale: { font: 0.8, spacing: 0.9 } },
    opacity: 1,
  };
  if (runs) o.runs = runs;
  if (paras) o.paras = paras;
  return o;
}

const bold = (start: number, end: number): TextRun => ({ start, end, fontWeight: 700 });
const spans = (o: TextObject) => (o.runs ?? []).map((r) => [r.start, r.end]);
const levels = (o: TextObject) => (o.paras ?? []).map((p) => p?.level ?? null);

describe('editText', () => {
  it('leaves a legacy object legacy: only its text changes', () => {
    const o = obj('Amazing grace');
    const e = editText(o, 'Amazing grace!');
    expect(e).toEqual({ ...o, text: 'Amazing grace!' });
    expect('runs' in e || 'paras' in e).toBe(false);
    expect(editText(o, o.text)).toBe(o);
  });

  it('gives typed text the style of the character before it, or after it at offset 0', () => {
    const o = obj('ab cd', [bold(0, 2), { start: 3, end: 5, color: { r: 1, g: 2, b: 3, a: 1 } }]);
    expect(spans(editText(o, 'abX cd', 3))).toEqual([
      [0, 3],
      [4, 6],
    ]);
    expect(spans(editText(o, 'ab Xcd', 4))).toEqual([
      [0, 2],
      [4, 6],
    ]); // after the unstyled space: unstyled
    expect(spans(editText(o, 'Xab cd', 1))).toEqual([
      [0, 3],
      [4, 6],
    ]);
  });

  it('trims runs inside a deleted range and drops runs deleted whole', () => {
    const o = obj('abcdefgh', [bold(1, 3), bold(4, 6), bold(6, 8)]);
    expect(spans(editText(o, 'abgh'))).toEqual([
      [1, 2],
      [2, 4],
    ]);
    // 'X' replaces 'bcdefg' and takes the style before it ('a': none); only the last run's 'h' is left.
    expect(spans(editText(o, 'aXh', 2))).toEqual([[2, 3]]);
    expect(spans(editText(o, 'abXh', 3))).toEqual([
      [1, 3],
      [3, 4],
    ]); // after 'b', 'X' extends the first run
  });

  it('keeps the box style, so a stored fit scale survives an edit', () => {
    const o = obj('For God so loved', [bold(0, 3)]);
    expect(editText(o, 'For God so loved the world').style).toBe(o.style);
  });

  it('places an ambiguous insertion at the caret', () => {
    const o = obj('aa', [bold(0, 1)]);
    expect(spans(editText(o, 'aaa', 2))).toEqual([[0, 2]]); // typed between the two: after the bold 'a'
    expect(spans(editText(o, 'aaa', 3))).toEqual([[0, 1]]); // typed at the end
    expect(spans(editText(o, 'aaa'))).toEqual([[0, 1]]); // no caret: the rightmost place
  });

  it('copies the style of the paragraph a new line splits', () => {
    const o = obj('one\ntwo', undefined, [{ level: 1 }, { level: 2 }]);
    expect(levels(editText(o, 'o\nne\ntwo', 2))).toEqual([1, 1, 2]);
    expect(levels(editText(o, 'one\ntwo\n', 8))).toEqual([1, 2, 2]);
    // An Enter at the end of 'one' (the caret says so) gives the new line 'one's style, not 'two's.
    expect(levels(editText(o, 'one\n\ntwo', 4))).toEqual([1, 1, 2]);
    expect(levels(editText(o, 'one\n\ntwo', 5))).toEqual([1, 2, 2]);
  });

  it('keeps the first paragraph style when paragraphs are joined, the next one when a line is deleted', () => {
    const o = obj('L1\nL2\nL3', [bold(3, 5)], [{ level: 1 }, { level: 2 }, { level: 3 }]);
    expect(levels(editText(o, 'L1\nL2L3', 5))).toEqual([1, 2]);
    const deleted = editText(o, 'L1\nL3'); // the whole 'L2' line, not '2\nL'
    expect(levels(deleted)).toEqual([1, 3]);
    expect(deleted.runs).toEqual([]);
    expect(
      levels(editText(obj('a\n\nb', undefined, [{ level: 1 }, { level: 2 }, { level: 3 }]), 'a\nb')),
    ).toEqual([1, 3]); // an empty line deleted
  });

  it('pads and trims paragraph styles: missing and trailing null entries are the box defaults', () => {
    const o = obj('a\nb\nc\nd', undefined, [{ level: 4 }]);
    expect(editText(o, 'a\nb\nc\nd\ne').paras).toEqual([{ level: 4 }]);
    expect(editText(o, 'a\nb').paras).toEqual([{ level: 4 }]);
    expect(editText(obj('a\nb', undefined, []), 'a\nb\nc').paras).toEqual([]); // present but empty: stays rich
  });
});

describe('joinText and replaceText', () => {
  it('joins two texts with their runs and paragraph styles', () => {
    const a = obj('ab\ncd', [bold(0, 1)], [{ level: 1 }]);
    const b = obj('ef', [bold(1, 2)], [{ level: 3 }]);
    const j = joinText(a, b);
    expect(j.text).toBe('ab\ncd\nef');
    expect(spans(j)).toEqual([
      [0, 1],
      [7, 8],
    ]);
    expect(levels(j)).toEqual([1, null, 3]);
    expect(joinText(obj('a'), obj('b'))).toEqual({ ...obj('a'), text: 'a\nb' });
  });

  it('cuts a text into its parts as slide splits do', () => {
    const o = obj('a\nbc\nd', [bold(2, 4)], [{ level: 1 }, { level: 2 }, { level: 3 }]);
    const head = replaceText(o, 4, o.text.length, '');
    const tail = replaceText(o, 0, 2, '');
    expect([head.text, spans(head), levels(head)]).toEqual(['a\nbc', [[2, 4]], [1, 2]]);
    expect([tail.text, spans(tail), levels(tail)]).toEqual(['bc\nd', [[0, 2]], [2, 3]]);
  });
});

// ---- properties ----

const unit = fc.constantFrom('a', 'b', ' ', '\n', 'é', '😀', 'ש');
const str = (max: number) => fc.array(unit, { maxLength: max }).map((a) => a.join(''));

/** A text with well-formed runs (each run's fontWeight is its index + 1, to follow it) and paragraph styles. */
const rich = str(40).chain((text) =>
  fc
    .record({
      cuts: fc.uniqueArray(fc.integer({ min: 0, max: text.length }), { maxLength: 12 }),
      paras: fc.array(fc.option(fc.integer({ min: 0, max: 8 }), { nil: null }), {
        maxLength: text.split('\n').length,
      }),
    })
    .map(({ cuts, paras }) => {
      const c = [...cuts].sort((x, y) => x - y);
      const runs: TextRun[] = [];
      for (let i = 0; i + 1 < c.length; i += 2)
        runs.push({ start: c[i]!, end: c[i + 1]!, fontWeight: i / 2 + 1 });
      return obj(
        text,
        runs,
        paras.map((level) => (level === null ? null : { level })),
      );
    }),
);

/** A random change: [start, end) of the text replaced by `insert`. */
const edit = (o: TextObject) =>
  fc
    .record({ a: fc.nat(o.text.length), b: fc.nat(o.text.length), insert: str(8) })
    .map(({ a, b, insert }) => ({ start: Math.min(a, b), end: Math.max(a, b), insert }));

function expectWellFormed(o: TextObject) {
  let at = 0;
  for (const r of o.runs ?? []) {
    expect(Number.isInteger(r.start) && Number.isInteger(r.end)).toBe(true);
    expect(r.start).toBeGreaterThanOrEqual(at);
    expect(r.end).toBeGreaterThan(r.start);
    expect(r.end).toBeLessThanOrEqual(o.text.length);
    at = r.end;
  }
  expect((o.paras ?? []).length).toBeLessThanOrEqual(o.text.split('\n').length);
}

/** The run (its fontWeight marker) over offset i, or 0 for the box style. */
function styleAt(o: TextObject, i: number): number {
  return o.runs?.find((r) => r.start <= i && i < r.end)?.fontWeight ?? 0;
}

describe('edit properties', () => {
  it('10,000 random edits keep runs sorted, non-overlapping and in range', () => {
    fc.assert(
      fc.property(
        rich.chain((o) => fc.tuple(fc.constant(o), edit(o))),
        ([o, { start, end, insert }]) => {
          const next = o.text.slice(0, start) + insert + o.text.slice(end);
          const e = editText(o, next, start + insert.length);
          expect(e.text).toBe(next);
          expectWellFormed(e);
          expect(e.runs!.length).toBeLessThanOrEqual(o.runs!.length);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('keeps the style of every character outside the change; typed text takes its neighbour’s', () => {
    fc.assert(
      fc.property(
        rich.chain((o) => fc.tuple(fc.constant(o), edit(o))),
        ([o, { start, end, insert }]) => {
          const e = replaceText(o, start, end, insert);
          const delta = insert.length - (end - start);
          for (let i = 0; i < start; i++) expect(styleAt(e, i)).toBe(styleAt(o, i));
          for (let i = end; i < o.text.length; i++) expect(styleAt(e, i + delta)).toBe(styleAt(o, i));
          const owner = start > 0 ? styleAt(o, start - 1) : end < o.text.length ? styleAt(o, end) : 0;
          for (let i = start; i < start + insert.length; i++) expect(styleAt(e, i)).toBe(owner);
          // Paragraph styles before the change stay; those after it move with their paragraphs.
          const k = o.text.slice(0, start).split('\n').length - 1;
          const removed = o.text.slice(start, end).split('\n').length - 1;
          const added = insert.split('\n').length - 1;
          const at = (x: TextObject, i: number) => x.paras?.[i] ?? null;
          for (let i = 0; i < k; i++) expect(at(e, i)).toEqual(at(o, i));
          const count = o.text.split('\n').length;
          for (let i = k + removed + 1; i < count; i++) expect(at(e, i + added - removed)).toEqual(at(o, i));
          expectWellFormed(e);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('stays well formed over long sequences of edits, without a caret too', () => {
    fc.assert(
      fc.property(
        rich,
        fc.array(fc.record({ a: fc.nat(60), b: fc.nat(60), insert: str(6), caret: fc.boolean() }), {
          maxLength: 25,
        }),
        (o, edits) => {
          let cur = o;
          for (const { a, b, insert, caret } of edits) {
            const s = Math.min(a, b, cur.text.length);
            const t = Math.min(Math.max(a, b), cur.text.length);
            const next = cur.text.slice(0, s) + insert + cur.text.slice(t);
            cur = editText(cur, next, caret ? s + insert.length : undefined);
            expect(cur.text).toBe(next);
            expectWellFormed(cur);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
