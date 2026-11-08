/**
 * Property tests of the editor's text ops (design/27 §14 item 9; M4.md item A): 10,000 random sequences of
 * `editText`, `formatRange`, `resizeRange` and `setParas` over random rich and legacy text objects keep
 * the runs sorted, non-overlapping, inside the text and at most 2,000; every character outside the range
 * an op touches keeps its resolved style; `paras` stays at most one entry per paragraph with no trailing
 * nulls; and a legacy object never turns rich by being typed in.
 */
import { DEFAULT_THEME, type TextObject, type TextPara, type TextRun } from '@ordo/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  editText,
  formatRange,
  type ParaPatch,
  parasTouched,
  RUN_FIELDS,
  type RunPatch,
  resizeRange,
  setParas,
} from '../src/views/editor/ops/text.ts';

const RED = { r: 200, g: 40, b: 40, a: 1 };
const BLUE = { r: 20, g: 60, b: 200, a: 1 };

const unit = fc.constantFrom('a', 'b', ' ', '\n', 'é', '😀', 'ש');
const str = (max: number) => fc.array(unit, { maxLength: max }).map((a) => a.join(''));

/** A small pool of values per field, so equal neighbours (and merges) are common. */
const VALUES: { [K in keyof RunPatch]: RunPatch[K][] } = {
  fontWeight: [700, 400],
  fontStyle: ['italic', 'normal'],
  sizeScale: [0.5, 2, 1.5],
  color: [RED, BLUE],
  highlight: [BLUE],
  underline: [true, false],
  strike: [true],
  baseline: [0.3, -0.25],
  caps: ['all', 'small'],
  outline: [null, { width: 2, color: RED }],
  lang: ['he', 'en'],
  fontFamily: ['Calibri', 'Gentium'],
};
const FIELDS = Object.keys(VALUES) as (keyof RunPatch)[];

/** A run style: a few fields with values from the pool. */
const fieldsArb = fc.uniqueArray(fc.constantFrom(...FIELDS), { minLength: 1, maxLength: 3 }).chain((keys) =>
  fc.tuple(...keys.map((k) => fc.constantFrom(...(VALUES[k] as unknown[])))).map((vals) => {
    const f: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      f[k] = vals[i];
    });
    return f as RunPatch;
  }),
);

/** A format patch: fields set from the pool, or removed (`undefined`). */
const patchArb = fc.uniqueArray(fc.constantFrom(...FIELDS), { minLength: 1, maxLength: 4 }).chain((keys) =>
  fc
    .tuple(...keys.map((k) => fc.oneof(fc.constant(undefined), fc.constantFrom(...(VALUES[k] as unknown[])))))
    .map((vals) => {
      const f: Record<string, unknown> = {};
      keys.forEach((k, i) => {
        f[k] = vals[i];
      });
      return f as RunPatch;
    }),
);

const paraArb: fc.Arbitrary<TextPara | null> = fc.oneof(
  fc.constant(null),
  fc.record(
    {
      align: fc.constantFrom('left', 'center', 'right', 'justify'),
      level: fc.integer({ min: 0, max: 8 }),
      soft: fc.constant(true),
      rtl: fc.boolean(),
      spaceBeforePx: fc.constantFrom(0, 12),
    },
    { requiredKeys: [] },
  ),
);

const paraPatchArb: fc.Arbitrary<ParaPatch> = fc.record(
  {
    align: fc.oneof(
      fc.constant(undefined),
      fc.constantFrom('left' as const, 'center' as const, 'right' as const),
    ),
    level: fc.oneof(fc.constant(undefined), fc.integer({ min: 0, max: 8 })),
    rtl: fc.oneof(fc.constant(undefined), fc.boolean()),
    bullet: fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant({ char: '•' }),
      fc.constant({ auto: 'arabicPeriod', startAt: 17 }),
    ),
    lineSpacing: fc.oneof(fc.constant(undefined), fc.constantFrom(1, 1.5)),
    spaceAfterPx: fc.oneof(fc.constant(undefined), fc.constantFrom(0, 20)),
  },
  { requiredKeys: [] },
);

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** `i` moved off the middle of a surrogate pair, as a textarea's offsets always are. */
const boundary = (s: string, i: number) =>
  i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i)) ? i - 1 : i;

/** A random text object: rich (runs from sorted cuts, paragraph styles) or legacy (neither). */
const objectArb: fc.Arbitrary<TextObject> = str(40).chain((text) =>
  fc
    .record({
      legacy: fc.boolean(),
      cuts: fc.uniqueArray(fc.integer({ min: 0, max: text.length }), { maxLength: 12 }),
      styles: fc.array(fieldsArb, { minLength: 6, maxLength: 6 }),
      paras: fc.array(paraArb, { maxLength: text.split('\n').length }),
    })
    .map(({ legacy, cuts, styles, paras }): TextObject => {
      const o: TextObject = {
        id: 't',
        type: 'text',
        box: { x: 0, y: 0, w: 800, h: 300, rotation: 0 },
        text,
        style: { ...DEFAULT_THEME.textBoxDefaults, fontSizePx: 40 },
        opacity: 1,
      };
      if (legacy) return o;
      const c = [...new Set(cuts.map((x) => boundary(text, x)))].sort((x, y) => x - y);
      const runs: TextRun[] = [];
      for (let i = 0; i + 1 < c.length; i += 2)
        runs.push({ start: c[i]!, end: c[i + 1]!, ...styles[(i / 2) % styles.length] });
      let n = paras.length;
      while (n > 0 && paras[n - 1] === null) n--;
      return { ...o, runs, paras: paras.slice(0, n) };
    }),
);

type Op =
  | { k: 'edit'; a: number; b: number; insert: string }
  | { k: 'format'; a: number; b: number; patch: RunPatch }
  | { k: 'resize'; a: number; b: number; factor: number }
  | { k: 'paras'; a: number; b: number; patch: ParaPatch };

/** Positions are drawn as shares of the text, so they stay meaningful as the text changes. */
const share = fc.double({ min: 0, max: 1, noNaN: true });
const opArb: fc.Arbitrary<{
  op: Op['k'];
  x: number;
  y: number;
  insert: string;
  patch: RunPatch;
  factor: number;
  para: ParaPatch;
}> = fc.record({
  op: fc.constantFrom('edit', 'edit', 'format', 'format', 'resize', 'paras'),
  x: share,
  y: share,
  insert: str(6),
  patch: patchArb,
  factor: fc.constantFrom(1.1, 1 / 1.1, 2, 0.5, 1.25, 0.8),
  para: paraPatchArb,
});

function toOp(
  o: TextObject,
  r: { op: Op['k']; x: number; y: number; insert: string; patch: RunPatch; factor: number; para: ParaPatch },
): Op {
  const at = (s: number) => boundary(o.text, Math.round(s * o.text.length));
  const a = Math.min(at(r.x), at(r.y));
  const b = Math.max(at(r.x), at(r.y));
  if (r.op === 'edit') return { k: 'edit', a, b, insert: r.insert };
  if (r.op === 'format') return { k: 'format', a, b, patch: r.patch };
  if (r.op === 'resize') return { k: 'resize', a, b, factor: r.factor };
  return { k: 'paras', a, b, patch: r.para };
}

/** The formatting of character `i`: the fields of the run over it ({} in the box style), as a string. */
function styleKey(o: TextObject, i: number): string {
  const r = o.runs?.find((x) => x.start <= i && i < x.end);
  const f: Record<string, unknown> = {};
  for (const k of RUN_FIELDS) if (r?.[k] !== undefined) f[k] = r[k];
  return JSON.stringify(f);
}

const paraAt = (o: TextObject, i: number) => JSON.stringify(o.paras?.[i] ?? null);

function expectWellFormed(o: TextObject) {
  let at = 0;
  const runs = o.runs ?? [];
  expect(runs.length).toBeLessThanOrEqual(2000);
  for (const r of runs) {
    expect(Number.isInteger(r.start) && Number.isInteger(r.end)).toBe(true);
    expect(r.start).toBeGreaterThanOrEqual(at);
    expect(r.end).toBeGreaterThan(r.start);
    expect(r.end).toBeLessThanOrEqual(o.text.length);
    at = r.end;
  }
  const paras = o.paras ?? [];
  expect(paras.length).toBeLessThanOrEqual(o.text.split('\n').length);
  if (paras.length) expect(paras[paras.length - 1]).not.toBeNull();
}

/** Apply `op`, checking that everything outside the range it touches is as it was. */
function step(o: TextObject, op: Op): TextObject {
  const len = o.text.length;
  if (op.k === 'edit') {
    const next = o.text.slice(0, op.a) + op.insert + o.text.slice(op.b);
    const e = editText(o, next, op.a + op.insert.length);
    expect(e.text).toBe(next);
    if (o.runs === undefined && o.paras === undefined) {
      expect(e.runs).toBeUndefined();
      expect(e.paras).toBeUndefined();
    }
    const delta = op.insert.length - (op.b - op.a);
    for (let i = 0; i < op.a; i++) expect(styleKey(e, i)).toBe(styleKey(o, i));
    for (let i = op.b; i < len; i++) expect(styleKey(e, i + delta)).toBe(styleKey(o, i));
    return e;
  }
  if (op.k === 'paras') {
    const e = setParas(o, op.a, op.b, op.patch);
    expect(e.text).toBe(o.text);
    expect(e.runs).toBe(o.runs);
    const { first, last } = parasTouched(o, op.a, op.b);
    const count = o.text.split('\n').length;
    for (let i = 0; i < count; i++) if (i < first || i > last) expect(paraAt(e, i)).toBe(paraAt(o, i));
    // The paragraph itself (not its soft lines) has every field the patch sets.
    const head = e.paras?.[first] ?? null;
    for (const [k, v] of Object.entries(op.patch)) {
      if (k === 'lineSpacing' || k === 'lineSpacingPx') continue;
      expect(JSON.stringify((head as Record<string, unknown> | null)?.[k] ?? null)).toBe(
        JSON.stringify(v ?? null),
      );
    }
    for (let i = first + 1; i <= last; i++) {
      const p = e.paras?.[i];
      if (o.paras?.[i]?.soft === true) expect(p?.soft).toBe(true);
    }
    return e;
  }
  const e = op.k === 'format' ? formatRange(o, op.a, op.b, op.patch) : resizeRange(o, op.a, op.b, op.factor);
  expect(e.text).toBe(o.text);
  expect(e.paras).toBe(o.paras);
  for (let i = 0; i < len; i++) if (i < op.a || i >= op.b) expect(styleKey(e, i)).toBe(styleKey(o, i));
  if (op.k === 'format' && op.a < op.b) {
    // Inside: every field of the patch holds, the others are as they were.
    for (let i = op.a; i < op.b; i++) {
      const after = JSON.parse(styleKey(e, i)) as Record<string, unknown>;
      const before = JSON.parse(styleKey(o, i)) as Record<string, unknown>;
      for (const k of RUN_FIELDS) {
        const want = k in op.patch ? op.patch[k] : before[k];
        expect(JSON.stringify(after[k] ?? null), `${k} at ${i}`).toBe(JSON.stringify(want ?? null));
      }
    }
  }
  if (op.k === 'resize' && op.a < op.b) {
    for (let i = op.a; i < op.b; i++) {
      const { sizeScale: s1, ...after } = JSON.parse(styleKey(e, i)) as Record<string, unknown>;
      const { sizeScale: s0, ...before } = JSON.parse(styleKey(o, i)) as Record<string, unknown>;
      expect(after).toEqual(before);
      const want = Math.min(25, Math.max(0.05, ((s0 as number | undefined) ?? 1) * op.factor));
      expect(((s1 as number | undefined) ?? 1) - want).toBeCloseTo(0, 3);
    }
  }
  return e;
}

describe('text op properties (design/27 §14 item 9)', () => {
  it('10,000 random sequences of edits, formats, sizes and paragraph styles keep the invariants', () => {
    fc.assert(
      fc.property(objectArb, fc.array(opArb, { minLength: 1, maxLength: 8 }), (start, ops) => {
        expectWellFormed(start);
        let o = start;
        for (const r of ops) {
          o = step(o, toOp(o, r));
          expectWellFormed(o);
        }
      }),
      { numRuns: 10_000 },
    );
  });

  it('an op that changes nothing returns its input', () => {
    fc.assert(
      fc.property(objectArb, opArb, (o, r) => {
        const op = toOp(o, r);
        if (op.k === 'format') {
          const once = formatRange(o, op.a, op.b, op.patch);
          expect(formatRange(once, op.a, op.b, op.patch)).toBe(once);
        } else if (op.k === 'paras') {
          const once = setParas(o, op.a, op.b, op.patch);
          expect(setParas(once, op.a, op.b, op.patch)).toBe(once);
        }
        expect(formatRange(o, op.a, op.a, { fontWeight: 700 })).toBe(o);
        expect(resizeRange(o, op.a, op.b, 1)).toBe(o);
        expect(editText(o, o.text)).toBe(o);
      }),
      { numRuns: 2000 },
    );
  });
});
