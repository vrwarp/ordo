/**
 * Fuzzing of the RTF reader (design/25 "Fuzzing"): random bytes, random RTF token soup and mutated real
 * ProPresenter (Cocoa) RTF must never throw, finish in linear time and return bounded, well-formed output.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REAL_RTF } from './fuzz-fixtures.test-util.ts';
import { parseRtf, RTF_FONT_NAME_MAX, splitFontName } from './rtf.ts';

const enc = new TextEncoder();

function checkResult(r: ReturnType<typeof parseRtf>) {
  expect(typeof r.text).toBe('string');
  expect(r.text).not.toMatch(/^\n|\n$/);
  expect(r.styleRuns).toBeGreaterThanOrEqual(0);
  if (r.fontSizePt !== undefined) {
    expect(Number.isFinite(r.fontSizePt)).toBe(true);
    expect(r.fontSizePt).toBeGreaterThan(0);
    expect(r.fontSizePt).toBeLessThanOrEqual(1000);
  }
  for (const c of [r.color, r.strokeColor]) {
    if (!c) continue;
    for (const v of [c.r, c.g, c.b]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  }
  if (r.strokeWidth !== undefined) {
    expect(Number.isFinite(r.strokeWidth)).toBe(true);
    expect(Math.abs(r.strokeWidth)).toBeLessThanOrEqual(2000);
  }
  if (r.fontName !== undefined) expect(r.fontName.length).toBeLessThanOrEqual(RTF_FONT_NAME_MAX);
  // No lone surrogates in the text.
  expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(r.text)).toBe(false);
}

const token = fc.oneof(
  fc.constantFrom(
    '{',
    '}',
    '\\par ',
    '\\line',
    '\\tab',
    '\\b',
    '\\b0',
    '\\i',
    '\\plain',
    '\\pard',
    '\\qc',
    '\\qr',
    '\\*',
    '\\fonttbl',
    '\\colortbl',
    '\\info',
    '\\pict',
    '\\\\',
    '\\{',
    '\\}',
    '\\~',
    '\\_',
    '\\-',
    "\\'",
    '\\\n',
    ';',
    ' ',
    '\n',
    '\r\n',
    '\\',
  ),
  fc
    .tuple(
      fc.constantFrom('u', 'uc', 'f', 'fs', 'cf', 'red', 'green', 'blue', 'strokewidth', 'strokec', 'b', 'i'),
      fc.oneof(
        fc.integer({ min: -70000, max: 70000 }).map(String),
        fc.constantFrom('-', '', '99999999999999999999999', '-0', '0'),
      ),
    )
    .map(([w, n]) => `\\${w}${n}`),
  fc.string({ unit: fc.constantFrom(...'0123456789abcdefgAF'), maxLength: 3 }).map((h) => `\\'${h}`),
  fc.string({ maxLength: 8 }),
);
const rtfSoup = fc.array(token, { maxLength: 120 }).map((t) => `{\\rtf1${t.join('')}`);

/** Mutations of the real file: delete, duplicate, insert and replace characters. */
const mutated = fc
  .array(
    fc.tuple(
      fc.nat({ max: REAL_RTF.length }),
      fc.constantFrom('del', 'dup', 'ins', 'rep'),
      fc.oneof(token, fc.string({ unit: 'binary', maxLength: 3 })),
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((muts) => {
    let s = REAL_RTF;
    for (const [pos, op, ins] of muts) {
      const p = Math.min(pos, s.length);
      if (op === 'del') s = s.slice(0, p) + s.slice(p + 1 + (pos % 7));
      else if (op === 'dup') s = s.slice(0, p) + s.slice(p, p + 20) + s.slice(p);
      else if (op === 'ins') s = s.slice(0, p) + ins + s.slice(p);
      else s = s.slice(0, p) + ins + s.slice(p + ins.length);
    }
    return s;
  });

describe('parseRtf (fuzz)', () => {
  it('random bytes never throw', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.boolean(), (b, asRtf) => {
        const bytes = asRtf ? new Uint8Array([...enc.encode('{\\rtf1'), ...b]) : b;
        checkResult(parseRtf(bytes));
      }),
      { numRuns: 2000 },
    );
  });

  it('random RTF token soup never throws and stays bounded', () => {
    fc.assert(
      fc.property(rtfSoup, (s) => {
        checkResult(parseRtf(s));
        checkResult(parseRtf(enc.encode(s)));
      }),
      { numRuns: 2000 },
    );
  });

  it('mutated real ProPresenter RTF never throws', () => {
    fc.assert(
      fc.property(mutated, (s) => {
        checkResult(parseRtf(s));
      }),
      { numRuns: 2000 },
    );
  });

  it('splitFontName never throws and returns a usable family', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (n) => {
        const f = splitFontName(n);
        expect(typeof f.family).toBe('string');
        expect([100, 200, 300, 400, 500, 600, 700, 800, 900]).toContain(f.weight);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('parseRtf regressions found by fuzzing', () => {
  it('a negative \\uc does not pull text from the end of the run', () => {
    expect(parseRtf('{\\rtf1\\uc-5\\u8364 hello world}').text).toBe('€hello world');
  });

  it('a huge \\uc skips a bounded number of fallback characters', () => {
    expect(parseRtf('{\\rtf1\\uc99999\\u8364 ?????????? rest}').text.endsWith('rest')).toBe(true);
  });

  it('\\fs- (sign without digits) and absurd sizes do not yield NaN or Infinity', () => {
    expect(parseRtf('{\\rtf1\\fs- x}').fontSizePt).toBe(12);
    expect(parseRtf('{\\rtf1\\fs99999999999999999999999 x}').fontSizePt).toBeLessThanOrEqual(1000);
    expect(parseRtf('{\\rtf1\\fs-40 x}').fontSizePt).toBeGreaterThan(0);
  });

  it('colour table values are clamped to 0..255', () => {
    const r = parseRtf('{\\rtf1{\\colortbl;\\red999\\green-4\\blue12;}\\cf1 x}');
    expect(r.color).toEqual({ r: 255, g: 0, b: 12, a: 1 });
  });

  it('lone surrogates from \\u become U+FFFD', () => {
    expect(parseRtf('{\\rtf1\\uc0\\u55357 x}').text).toBe('�x');
    expect(parseRtf('{\\rtf1\\uc0\\u55357\\u56832 }').text).toBe('😀');
  });

  it('is linear on long runs of spaces and newlines', () => {
    for (const s of [
      `{\\rtf1 a${' '.repeat(80_000)}b}`,
      `{\\rtf1 a${'\\par '.repeat(40_000)}b}`,
      `a${' '.repeat(80_000)}b`,
      `a${'\n'.repeat(80_000)}b`,
    ]) {
      const t0 = Date.now();
      checkResult(parseRtf(s));
      expect(Date.now() - t0).toBeLessThan(1500);
    }
  });

  it('a huge font table name is cut', () => {
    const r = parseRtf(`{\\rtf1{\\fonttbl\\f0 ${'N'.repeat(10_000)};}\\f0 x}`);
    expect(r.fontName!.length).toBeLessThanOrEqual(RTF_FONT_NAME_MAX);
  });
});
