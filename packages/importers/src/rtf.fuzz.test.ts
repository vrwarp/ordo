/**
 * Fuzzing of the RTF reader (design/25 "Fuzzing"): random bytes, random RTF token soup and mutated real
 * ProPresenter (Cocoa) RTF must never throw, finish in linear time and return bounded, well-formed output.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REAL_RTF } from './fuzz-fixtures.test-util.ts';
import { parseRtf, RTF_FONT_NAME_MAX, splitFontName } from './rtf.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

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

  if (r.spans) {
    let prevEnd = 0;
    for (const s of r.spans) {
      expect(Number.isInteger(s.start)).toBe(true);
      expect(Number.isInteger(s.end)).toBe(true);
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(r.text.length);
      // Monotonic non-overlapping ranges
      expect(s.start).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = s.end;

      if (s.fontSizePt !== undefined) {
        expect(Number.isFinite(s.fontSizePt)).toBe(true);
        expect(s.fontSizePt).toBeGreaterThan(0);
      }
      for (const c of [s.color, s.highlight, s.strokeColor]) {
        if (!c) continue;
        for (const v of [c.r, c.g, c.b]) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
        expect(Number.isFinite(c.a)).toBe(true);
        expect(c.a).toBeGreaterThanOrEqual(0);
        expect(c.a).toBeLessThanOrEqual(1);
      }
    }
  }

  if (!r.plain && r.text.length > 0) {
    const lineCount = r.text.split('\n').length;
    expect(r.paras).toBeDefined();
    expect(r.paras!.length).toBe(Math.min(1000, lineCount));
  }
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
    '\\i0',
    '\\ul',
    '\\ulnone',
    '\\strike',
    '\\strike0',
    '\\super',
    '\\sub',
    '\\nosupersub',
    '\\scaps',
    '\\scaps0',
    '\\plain',
    '\\pard',
    '\\qc',
    '\\qr',
    '\\ql',
    '\\qj',
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
      fc.constantFrom(
        'u',
        'uc',
        'f',
        'fs',
        'cf',
        'cb',
        'highlight',
        'expndtw',
        'slleading',
        'li',
        'fi',
        'sb',
        'sa',
        'ca',
        'c',
        'red',
        'green',
        'blue',
        'strokewidth',
        'strokec',
        'b',
        'i',
        'bin',
      ),
      fc.oneof(
        fc.integer({ min: -70000, max: 70000 }).map(String),
        fc.constantFrom('-', '', '99999999999999999999999', '-0', '0', '-50000', '100000'),
      ),
    )
    .map(([w, n]) => `\\${w}${n}`),
  fc.string({ unit: fc.constantFrom(...'0123456789abcdefgAF'), maxLength: 3 }).map((h) => `\\'${h}`),
  fc.string({ maxLength: 8 }),
  // `\binN` followed by raw bytes (any byte, including braces and backslashes), with N sometimes larger
  // than what is left of the document.
  fc
    .tuple(fc.integer({ min: -5, max: 40 }), fc.string({ unit: 'binary', maxLength: 12 }))
    .map(([n, raw]) => `\\bin${n} ${raw}`),
);
const rtfSoup = fc.array(token, { maxLength: 120 }).map((t) => `{\\rtf1${t.join('')}`);

const expandedColorEntry = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('\\cssrgb', '\\csgenericrgb'),
      fc.array(
        fc
          .tuple(
            fc.constant('\\c'),
            fc.oneof(
              fc.integer({ min: -50_000, max: 200_000 }).map(String),
              fc.constantFrom('-', '', '99999999999999999', '0'),
            ),
          )
          .map(([c, n]) => `${c}${n}`),
        { minLength: 1, maxLength: 4 },
      ),
      fc.option(
        fc
          .tuple(
            fc.constant('\\ca'),
            fc.oneof(
              fc.integer({ min: -50_000, max: 200_000 }).map(String),
              fc.constantFrom('-', '', '99999999999999999', '-0', '0'),
            ),
          )
          .map(([ca, n]) => `${ca}${n}`),
        { nil: undefined },
      ),
    )
    .map(([cs, comps, alpha]) => `${cs}${comps.join('')}${alpha ?? ''};`),
  fc
    .tuple(
      fc.constant('\\csgray'),
      fc
        .tuple(
          fc.constant('\\c'),
          fc.oneof(
            fc.integer({ min: -50_000, max: 200_000 }).map(String),
            fc.constantFrom('-', '', '99999999999999999', '0'),
          ),
        )
        .map(([c, n]) => `${c}${n}`),
      fc.option(
        fc
          .tuple(
            fc.constant('\\ca'),
            fc.oneof(
              fc.integer({ min: -50_000, max: 200_000 }).map(String),
              fc.constantFrom('-', '', '99999999999999999', '0'),
            ),
          )
          .map(([ca, n]) => `${ca}${n}`),
        { nil: undefined },
      ),
    )
    .map(([cs, comp, alpha]) => `${cs}${comp}${alpha ?? ''};`),
  fc.constant(';'),
);

const expandedColortbl = fc
  .array(expandedColorEntry, { minLength: 1, maxLength: 5 })
  .map((entries) => `{\\*\\expandedcolortbl;${entries.join('')}}`);

const bulletPrefix = fc.oneof(
  fc.constant('{\\listtext \\bullet\\tab}'),
  fc.constant('{\\listtext •\\tab}'),
  fc.constant('{\\listtext -\\tab}'),
  fc.constant('{\\listtext 1.\\tab}'),
  fc.string({ maxLength: 8 }).map((s) => `{\\listtext ${s.replace(/[{}]/g, '')}\\tab}`),
  fc.constant('{\\pntext \\bullet\\tab}'),
);

const spanTransition = fc.oneof(
  fc.constantFrom(
    '\\b ',
    '\\b0 ',
    '\\i ',
    '\\i0 ',
    '\\ul ',
    '\\ulnone ',
    '\\strike ',
    '\\strike0 ',
    '\\super ',
    '\\sub ',
    '\\nosupersub ',
    '\\scaps ',
    '\\scaps0 ',
    '\\plain ',
    '\\par ',
    '\\pard ',
  ),
  fc
    .tuple(
      fc.constantFrom('cb', 'highlight', 'expndtw', 'slleading', 'li', 'fi', 'sb', 'sa', 'cf', 'fs'),
      fc.oneof(
        fc.integer({ min: -5000, max: 5000 }).map(String),
        fc.constantFrom('-', '', '0', '99999999999999999', '-1'),
      ),
    )
    .map(([w, n]) => `\\${w}${n} `),
);

const richSegment = fc
  .tuple(
    fc.array(spanTransition, { maxLength: 4 }),
    fc.option(bulletPrefix, { nil: undefined }),
    fc.string({ maxLength: 12 }).map((s) => s.replace(/[{}\\;]/g, '')),
  )
  .map(([transitions, bullet, text]) => `${bullet ?? ''}${transitions.join('')}${text}`);

const richRtfSoup = fc
  .tuple(
    fc.option(expandedColortbl, { nil: undefined }),
    fc.array(richSegment, { minLength: 1, maxLength: 20 }),
  )
  .map(
    ([expTbl, segs]) =>
      `{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}{\\colortbl;\\red0\\green0\\blue0;}${expTbl ?? ''}${segs.join('')}}`,
  );

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

  it('expanded color tables, listtext bullets, and multi-span transitions never throw and stay well-formed', () => {
    fc.assert(
      fc.property(richRtfSoup, (s) => {
        checkResult(parseRtf(s));
        checkResult(parseRtf(enc.encode(s)));
      }),
      { numRuns: 1000 },
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
      expect(Date.now() - t0).toBeLessThan(budgetMs(1500));
    }
  });

  it('a huge font table name is cut', () => {
    const r = parseRtf(`{\\rtf1{\\fonttbl\\f0 ${'N'.repeat(10_000)};}\\f0 x}`);
    expect(r.fontName!.length).toBeLessThanOrEqual(RTF_FONT_NAME_MAX);
  });

  it('expandedcolortbl with negative, huge, and sign-only numbers does not produce NaN/Infinity and clamps color', () => {
    for (const s of [
      '{\\rtf1{\\*\\expandedcolortbl;\\cssrgb\\c-5000\\c200000\\c0\\ca-5000;}\\cf1 text}',
      '{\\rtf1{\\*\\expandedcolortbl;\\cssrgb\\c99999999999999999\\c0\\c0\\ca99999999999999999;}\\cf1 text}',
      '{\\rtf1{\\*\\expandedcolortbl;\\csgray\\c-\\ca-;}\\cf1 text}',
      '{\\rtf1{\\*\\expandedcolortbl;\\csgenericrgb\\c20000\\c40000\\c60000;}\\cf1 text}',
    ]) {
      const r = parseRtf(s);
      checkResult(r);
      if (r.color) {
        expect(r.color.r).toBeGreaterThanOrEqual(0);
        expect(r.color.r).toBeLessThanOrEqual(255);
        expect(r.color.g).toBeGreaterThanOrEqual(0);
        expect(r.color.g).toBeLessThanOrEqual(255);
        expect(r.color.b).toBeGreaterThanOrEqual(0);
        expect(r.color.b).toBeLessThanOrEqual(255);
        expect(r.color.a).toBeGreaterThanOrEqual(0);
        expect(r.color.a).toBeLessThanOrEqual(1);
      }
    }
  });

  it('listtext bullet prefixes extract bullets and set hasBulletList', () => {
    const s = '{\\rtf1{\\listtext •\\tab}First item\\par {\\listtext -\\tab}Second item}';
    const r = parseRtf(s);
    checkResult(r);
    expect(r.hasBulletList).toBe(true);
    expect(r.paras).toHaveLength(2);
    expect(r.paras![0]!.bulletChar).toBe('•');
    expect(r.paras![1]!.bulletChar).toBe('-');
  });

  it('multi-span transitions create valid monotonic non-overlapping spans with paragraph styles', () => {
    const s =
      '{\\rtf1\\ansi{\\colortbl;\\red255\\green0\\blue0;\\red0\\green255\\blue0;}' +
      '\\b Bold \\b0\\i Italic \\i0\\ul Underline \\ulnone\\strike Strike \\strike0' +
      '\\super Super \\nosupersub\\sub Sub \\nosupersub\\scaps SmallCaps \\scaps0' +
      '\\cb1 Highlighted \\cf2 Colored \\expndtw20 Tracked \\slleading20 Spaced ' +
      '\\par \\li200\\fi-100\\sb40\\sa60 Hanging and spaced paragraph}';
    const r = parseRtf(s);
    checkResult(r);
    expect(r.spans).toBeDefined();
    expect(r.spans!.length).toBeGreaterThan(1);
    expect(r.paras).toBeDefined();
    expect(r.paras!.length).toBe(2);
    expect(r.paras![1]!.indentPt).toBe(10);
    expect(r.paras![1]!.firstLinePt).toBe(-5);
    expect(r.paras![1]!.spaceBeforePt).toBe(2);
    expect(r.paras![1]!.spaceAfterPt).toBe(3);
  });
});
