import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  autoNumberLabel,
  isSymbolFont,
  NumberCounter,
  paraLabels,
  SYMBOL_TO_UNICODE,
  symbolFontChar,
  WINGDINGS_TO_UNICODE,
} from './bullets.ts';
import type { TextPara } from './schemas.ts';

type Bullet = NonNullable<TextPara['bullet']>;
const num = (auto: string, startAt?: number): Bullet => (startAt ? { auto, startAt } : { auto });

/** Labels of paragraphs given as [text, para] pairs. */
function labels(...ps: [string, TextPara | null][]): (string | null)[] {
  return paraLabels({ text: ps.map(([t]) => t).join('\n'), paras: ps.map(([, p]) => p) });
}

describe('autoNumberLabel', () => {
  it('writes every OOXML scheme family in its punctuation (annotate.ts autoNumber)', () => {
    expect(autoNumberLabel('arabicPeriod', 1)).toBe('1.');
    expect(autoNumberLabel('arabicParenR', 2)).toBe('2)');
    expect(autoNumberLabel('arabicParenBoth', 17)).toBe('(17)');
    expect(autoNumberLabel('arabicPlain', 3)).toBe('3');
    expect(autoNumberLabel('arabicMinus', 3)).toBe('- 3 -');
    expect(autoNumberLabel('alphaUcPeriod', 28)).toBe('BB.');
    expect(autoNumberLabel('alphaLcParenR', 1)).toBe('a)');
    expect(autoNumberLabel('alphaLcParenR', 26)).toBe('z)');
    expect(autoNumberLabel('alphaLcParenR', 27)).toBe('aa)');
    expect(autoNumberLabel('romanLcParenBoth', 14)).toBe('(xiv)');
    expect(autoNumberLabel('romanUcPeriod', 4)).toBe('IV.');
    expect(autoNumberLabel('romanUcPlain', 1994)).toBe('MCMXCIV');
    expect(autoNumberLabel('circleNumDbPlain', 2)).toBe('\u{2461}');
    expect(autoNumberLabel('circleNumWdWhitePlain', 20)).toBe('\u{2473}');
    expect(autoNumberLabel('circleNumWdBlackPlain', 1)).toBe('\u{2776}');
    expect(autoNumberLabel('circleNumWdBlackPlain', 12)).toBe('\u{24ec}');
    expect(autoNumberLabel('arabicDbPeriod', 12)).toBe('\u{ff11}\u{ff12}\u{ff0e}');
    expect(autoNumberLabel('thaiNumParenBoth', 3)).toBe('(\u{e53})');
    expect(autoNumberLabel('hindiNumPeriod', 10)).toBe('\u{967}\u{966}.');
  });

  it('reads unknown schemes as arabicPeriod and keeps labels short out of range', () => {
    expect(autoNumberLabel('hebrew2Minus', 2)).toBe('2.');
    expect(autoNumberLabel('', 5)).toBe('5.');
    expect(autoNumberLabel('circleNumDbPlain', 21)).toBe('21');
    expect(autoNumberLabel('romanUcPeriod', 4000)).toBe('4000.');
    expect(autoNumberLabel('alphaLcPlain', 260)).toBe('z'.repeat(10));
    expect(autoNumberLabel('alphaLcPlain', 261)).toBe('261');
    expect(autoNumberLabel('alphaUcParenBoth', 32_767 + 5000)).toBe('(37767)');
  });
});

describe('paraLabels: counting as PowerPoint and LibreOffice do (annotate.ts bulletOf)', () => {
  it('counts verses from startAt by level; empty paragraphs neither count nor break', () => {
    const verse = num('arabicParenBoth', 17);
    const sub = num('alphaLcParenR');
    expect(
      labels(
        ['V17', { bullet: verse }],
        ['', { bullet: verse }],
        ['V18', { bullet: verse }],
        ['Sub-a', { level: 1, bullet: sub }],
        ['Sub-b', { level: 1, bullet: sub }],
        ['V19', { bullet: verse }],
        ['Sub-a again', { level: 1, bullet: sub }],
        ['Unnumbered', { bullet: null }],
        ['Restart', { bullet: num('romanUcPeriod', 4) }],
        ['Char', { bullet: { char: '•' } }],
        ['Plain', null],
      ),
    ).toEqual(['(17)', null, '(18)', 'a)', 'b)', '(19)', 'a)', null, 'IV.', '•', null]);
  });

  it('a deeper paragraph keeps the shallower sequence going', () => {
    const one = num('arabicPeriod');
    expect(
      labels(['a', { bullet: one }], ['b', { level: 2, bullet: { char: '-' } }], ['c', { bullet: one }]),
    ).toEqual(['1.', '-', '2.']);
  });

  it('a shallower paragraph without a number ends the deeper sequences', () => {
    const sub = num('alphaLcPeriod');
    expect(
      labels(['a', { level: 1, bullet: sub }], ['title', null], ['b', { level: 1, bullet: sub }]),
    ).toEqual(['a.', null, 'a.']);
  });

  it('a same-level paragraph without a number ends the sequence: a character, none, or nothing', () => {
    const one = num('arabicPeriod');
    const stops: [TextPara | null, string | null][] = [
      [{ bullet: { char: '•' } }, '•'],
      [{ bullet: null }, null],
      [{}, null],
      [null, null],
      [{ bullet: {} }, null],
    ];
    for (const [stop, label] of stops)
      expect(labels(['a', { bullet: one }], ['b', stop], ['c', { bullet: one }])).toEqual([
        '1.',
        label,
        '1.',
      ]);
  });

  it('a different scheme or start at the same level starts again', () => {
    expect(
      labels(
        ['a', { bullet: num('arabicPeriod') }],
        ['b', { bullet: num('arabicPeriod') }],
        ['c', { bullet: num('arabicParenR') }],
        ['d', { bullet: num('arabicParenR', 5) }],
        ['e', { bullet: num('arabicParenR', 5) }],
        ['f', { bullet: num('arabicParenR') }],
      ),
    ).toEqual(['1.', '2.', '1)', '5)', '6)', '1)']);
  });

  it('an empty paragraph at any level leaves every sequence as it was', () => {
    const one = num('arabicPeriod');
    expect(
      labels(
        ['a', { bullet: one }],
        ['b', { level: 1, bullet: num('alphaLcPeriod') }],
        ['', { bullet: null }],
        ['', null],
        ['c', { level: 1, bullet: num('alphaLcPeriod') }],
        ['d', { bullet: one }],
      ),
    ).toEqual(['1.', 'a.', null, null, 'b.', '2.']);
  });

  it('a soft paragraph is a line of the one before: no label, and its text counts for that paragraph', () => {
    const one = num('arabicPeriod');
    expect(
      labels(
        ['a', { bullet: one }],
        ['a, line 2', { soft: true, bullet: one }],
        ['', { bullet: one }],
        ['b after an empty first line', { soft: true }],
        ['', { bullet: one }],
        ['', { soft: true }],
        ['c', { bullet: one }],
      ),
    ).toEqual(['1.', null, '2.', null, null, null, '3.']);
    // The first paragraph cannot continue anything.
    expect(labels(['a', { soft: true, bullet: one }])).toEqual(['1.']);
  });

  it('an automatic number wins over a character; levels and starts are bounded', () => {
    expect(labels(['a', { bullet: { auto: 'arabicPeriod', char: '•' } }])).toEqual(['1.']);
    const wild = { level: 99, bullet: { auto: 'arabicPeriod', startAt: 1e9 } } as unknown as TextPara;
    expect(labels(['a', wild], ['b', wild])).toEqual(['32767.', '32768.']);
    const nan = { level: Number.NaN, bullet: { auto: 'arabicPeriod', startAt: Number.NaN } } as TextPara;
    expect(labels(['a', nan])).toEqual(['1.']);
  });

  it('paras beyond the paragraphs are ignored and missing ones are no bullet', () => {
    const one = num('arabicPeriod');
    expect(paraLabels({ text: 'a\nb\nc', paras: [{ bullet: one }] })).toEqual(['1.', null, null]);
    expect(paraLabels({ text: 'a', paras: [{ bullet: one }, { bullet: one }] })).toEqual(['1.']);
    expect(paraLabels({ text: 'a\nb', paras: [] })).toEqual([null, null]);
    expect(paraLabels({ text: 'a\nb' })).toEqual([null, null]);
  });

  it('NumberCounter is the counter behind the labels', () => {
    const c = new NumberCounter();
    const verse = num('arabicParenBoth', 17);
    expect([c.next(0, verse, true), c.next(0, verse, false), c.next(0, verse, true)]).toEqual([
      '(17)',
      null,
      '(18)',
    ]);
  });
});

describe('character bullets', () => {
  it('maps the Wingdings and Symbol bullets of design/27 §6 to Unicode', () => {
    const w = (code: number) => symbolFontChar('Wingdings', String.fromCharCode(code));
    expect([0x6c, 0x6e, 0xa7, 0xd8, 0xfc, 0x71, 0x76].map(w)).toEqual([
      '\u{25cf}',
      '\u{25a0}',
      '\u{25aa}',
      '\u{27a2}',
      '\u{2713}',
      '\u{2751}',
      '\u{2756}',
    ]);
    expect(symbolFontChar('Symbol', '\u{b7}')).toBe('\u{2022}');
    // The private-use offset is stripped; family names are matched without case.
    expect(symbolFontChar('wingdings', '\u{f0a7}')).toBe('\u{25aa}');
    expect(symbolFontChar(' SYMBOL ', '\u{f0b7}')).toBe('\u{2022}');
    expect(symbolFontChar('Symbol', 'abg')).toBe('\u{3b1}\u{3b2}\u{3b3}');
    expect(symbolFontChar('Symbol', '1')).toBe('1');
  });

  it('keeps Unicode characters, writes unknown codes as a bullet and maps nothing in other fonts', () => {
    expect(symbolFontChar('Wingdings', '\u{25cf}')).toBe('\u{25cf}');
    expect(symbolFontChar('Wingdings', 'A')).toBe('\u{2022}');
    expect(symbolFontChar('Symbol', '\u{f0c5}')).toBe('\u{2022}');
    expect(symbolFontChar('Wingdings', '\u{f020}')).toBe(' ');
    expect(symbolFontChar('Arial', '\u{a7}')).toBeNull();
    expect(symbolFontChar(undefined, '\u{a7}')).toBeNull();
    expect(symbolFontChar('Wingdings 2', '\u{a7}')).toBeNull();
    expect(isSymbolFont('Wingdings')).toBe(true);
    expect(isSymbolFont('Calibri')).toBe(false);
    for (const [code, ch] of [...WINGDINGS_TO_UNICODE, ...SYMBOL_TO_UNICODE]) {
      expect(code).toBeGreaterThan(0x20);
      expect(code).toBeLessThanOrEqual(0xff);
      expect([...ch]).toHaveLength(1);
    }
  });

  it('labels a symbol-font bullet stored unmapped as Unicode', () => {
    expect(labels(['a', { bullet: { char: '\u{a7}', fontFamily: 'Wingdings' } }])).toEqual(['\u{25aa}']);
    expect(labels(['a', { bullet: { char: '\u{a7}', fontFamily: 'Arial' } }])).toEqual(['\u{a7}']);
  });

  it('never writes a line break, a control or a bidi override into a label', () => {
    const ch = (char: string) => labels(['a', { bullet: { char } }])[0];
    expect(ch('a\nb')).toBe('ab');
    expect(ch('\u{202e}\u{2022}')).toBe('\u{2022}');
    expect(ch('\u{2028}x\u{85}')).toBe('x');
    expect(ch('\u{d800}')).toBeNull();
    expect(ch('  ')).toBeNull();
    expect(ch('\u{1f600}')).toBe('\u{1f600}');
  });
});

describe('paraLabels on any input', () => {
  const bullet = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.record(
      {
        char: fc.string({ maxLength: 10, unit: 'binary' }),
        auto: fc.constantFrom('arabicPeriod', 'alphaLcParenR', 'romanUcPlain', 'circleNumWdBlackPlain', 'x'),
        startAt: fc.oneof(fc.integer({ min: -5, max: 40_000 }), fc.double()),
        fontFamily: fc.constantFrom('Wingdings', 'Symbol', 'Arial'),
      },
      { requiredKeys: [] },
    ),
  );
  const para = fc.oneof(
    fc.constant(null),
    fc.record(
      { level: fc.oneof(fc.integer({ min: -3, max: 20 }), fc.double()), soft: fc.boolean(), bullet },
      { requiredKeys: [] },
    ),
  );
  const text = fc
    .array(fc.constantFrom('', 'a', 'word word', ' ', '\u{5e9}', '\n'), { maxLength: 30 })
    .map((a) => a.join('\n'));

  it('one label or null per paragraph, each a short line of text', () => {
    fc.assert(
      fc.property(text, fc.array(para, { maxLength: 40 }), (t, paras) => {
        const out = paraLabels({ text: t, paras: paras as TextPara[] });
        expect(out).toHaveLength(t.split('\n').length);
        t.split('\n').forEach((p, i) => {
          const l = out[i];
          if (l === null || l === undefined) return;
          expect(p.length > 0 || (paras[i + 1] as TextPara | null)?.soft === true).toBe(true);
          expect(l).not.toMatch(/[\n\r\u{2028}\u{2029}\u{202e}]/u);
          expect(l.trim()).toBe(l);
          expect(l.length).toBeGreaterThan(0);
          expect(l.length).toBeLessThanOrEqual(24);
        });
      }),
    );
  });
});
