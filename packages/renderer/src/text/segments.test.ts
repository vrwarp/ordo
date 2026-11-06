import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LYRIC_STYLE,
  type TextObject,
  type TextRun,
  type TextStyle,
  textScripts,
} from '@ordo/domain';
import { LEGACY_FONT_ENV } from './fonts.ts';
import { itemize } from './itemize.ts';
import { clampTextObject, layoutRich } from './rich.ts';
import { breakOpportunities, graphemeBoundaries } from './breaks.ts';
import { joinsAcross, joiningType, prepare, scriptOf, segText } from './segments.ts';
import { testMeasurer } from './test-util.ts';
import type { PreparedPara } from './types.ts';

/** A clamped rich text object in a `w`-wide box: 20 px text, every character 10 px wide in `testMeasurer`. */
function obj(
  text: string,
  extra: Partial<TextObject> = {},
  style: Partial<TextStyle> = {},
  w = 400,
): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w, h: 200, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      padding: 0,
      fontSizePx: 20,
      lineHeight: 1,
      align: 'left',
      lang: 'und',
      ...style,
    },
    opacity: 1,
    ...extra,
  });
}

/** Each piece of each paragraph as [text, run index, level, breakAfter]. */
function pieces(o: TextObject): [string, number, number, boolean][][] {
  const it = itemize(o);
  return prepare(it).map((pp) =>
    pp.pieces.map((p) => [o.text.slice(p.start, p.end), pp.para.runs[p.sr]!.run, p.level, p.breakAfter]),
  );
}

function prepared(o: TextObject): PreparedPara[] {
  return prepare(itemize(o));
}

/** The text of each laid line, segments in visual order. */
function lineTexts(o: TextObject, w?: number): string[] {
  const l = layoutRich(
    testMeasurer({ em: 0.5 }),
    w === undefined ? o : { ...o, box: { ...o.box, w } },
    LEGACY_FONT_ENV,
  );
  return l.lines.map((line) => line.segs.map((s) => o.text.slice(s.start, s.end)).join(''));
}

const bold = (start: number, end: number): TextRun => ({ start, end, fontWeight: 800 });

describe('pieces', () => {
  it('cuts at style runs and break opportunities, and keeps no-break spaces inside', () => {
    expect(pieces(obj('Le Dieu\u{00A0}!'))).toEqual([
      [
        ['Le ', -1, 0, true],
        ['Dieu\u{00A0}!', -1, 0, false],
      ],
    ]);
    expect(pieces(obj('Holy holy', { runs: [bold(2, 7)] }))).toEqual([
      [
        ['Ho', -1, 0, false],
        ['ly ', 0, 0, true],
        ['ho', 0, 0, false],
        ['ly', -1, 0, false],
      ],
    ]);
    const pp = prepared(obj('a  b'))[0]!;
    expect(pp.pieces.map((p) => [p.start, p.end, p.trail])).toEqual([
      [0, 3, 1],
      [3, 4, 4],
    ]);
  });

  it("never breaks 'Dieu !' across lines", () => {
    // 'Gloire à ' fits on the first line (90 px of 100); 'Dieu !' (60 px) moves down whole.
    expect(lineTexts(obj('Gloire à Dieu\u{00A0}!'), 100)).toEqual(['Gloire à ', 'Dieu\u{00A0}!']);
    expect(lineTexts(obj('Gloire à Dieu !'), 100)).toEqual(['Gloire à ', 'Dieu !']);
  });

  it('cuts at bidi levels and lays out mixed directions in visual order', () => {
    expect(pieces(obj('abc שלום def'))).toEqual([
      [
        ['abc ', -1, 0, true],
        ['שלום', -1, 1, false],
        [' ', -1, 0, true],
        ['def', -1, 0, false],
      ],
    ]);
    expect(lineTexts(obj('abc שלום def'))).toEqual(['abc שלום def']);
    // A right-to-left paragraph: the Latin word at level 2 keeps its order inside the reversed line.
    expect(pieces(obj('שלום abc דבר'))[0]!.map((p) => [p[0], p[2]])).toEqual([
      ['שלום ', 1],
      ['abc', 2],
      [' ', 1],
      ['דבר', 1],
    ]);
    expect(lineTexts(obj('שלום abc דבר'))).toEqual(['דבר abcשלום ']);
    // Hebrew with numbers: the number keeps its digit order (level 2) between the reversed words.
    const he = obj('פרק 23 פסוק 4');
    expect(pieces(he)[0]!.map((p) => [p[0], p[2]])).toEqual([
      ['פרק ', 1],
      ['23', 2],
      [' ', 1],
      ['פסוק ', 1],
      ['4', 2],
    ]);
    expect(lineTexts(he)).toEqual(['4פסוק  23פרק ']);
  });

  it('takes the paragraph direction from paras, the box, then the first strong character', () => {
    const text = 'Amen שלום\nשלום Amen\n123';
    const levels = (o: TextObject) => prepared(o).map((pp) => pp.bidi.level);
    expect(levels(obj(text))).toEqual([0, 1, 0]);
    expect(levels(obj(text, {}, { direction: 'rtl' }))).toEqual([1, 1, 1]);
    expect(levels(obj(text, { paras: [{ rtl: true }, { rtl: false }, null] }))).toEqual([1, 0, 0]);
    expect(levels(obj(text, { paras: [null, null, { rtl: true }] }, { direction: 'ltr' }))).toEqual([
      0, 0, 1,
    ]);
  });

  it('gives a soft line its paragraph direction (one PowerPoint paragraph)', () => {
    const levels = (o: TextObject) => prepared(o).map((pp) => pp.bidi.level);
    expect(levels(obj('Hello\nשלום', { paras: [null, { soft: true }] }))).toEqual([0, 0]);
    expect(levels(obj('Hello\nשלום', { paras: [null, null] }))).toEqual([0, 1]);
    expect(levels(obj('1.\nשלום\nabc', { paras: [null, { soft: true }, { soft: true }] }))).toEqual([
      1, 1, 1,
    ]);
    expect(levels(obj('שלום\nabc\nabc', { paras: [null, { soft: true }, null] }))).toEqual([1, 1, 0]);
  });

  it('breaks Thai and Burmese between words, CJK between ideographs but not before punctuation', () => {
    expect(pieces(obj('สวัสดีครับ', {}, { lang: 'th' }))[0]!.map((p) => [p[0], p[3]])).toEqual([
      ['สวัสดี', true],
      ['ครับ', false],
    ]);
    expect(pieces(obj('မြန်မာစာ', {}, { lang: 'my' }))[0]!.map((p) => p[0])).toEqual(['မြန်မာ', 'စာ']);
    // 30 px lines hold three 10 px characters; 20 px lines hold two, so 、 and 。 pull their ideograph down.
    expect(lineTexts(obj('主啊、我信。阿們'), 30)).toEqual(['主啊、', '我信。', '阿們']);
    expect(lineTexts(obj('主啊、我信。阿們'), 20)).toEqual(['主', '啊、', '我', '信。', '阿們']);
    for (const line of lineTexts(obj('「哈利路亞」，阿們。'), 30))
      expect('」，。'.includes(line[0]!)).toBe(false);
  });
});

describe('line breaking through layoutRich', () => {
  it('wraps Thai at words and breaks a word wider than the line only between clusters', () => {
    expect(lineTexts(obj('พระเจ้าทรงรักโลก', {}, { lang: 'th' }), 80)).toEqual(['พระเจ้า', 'ทรงรัก', 'โลก']);
    // 'க்ஷி' is four code points (40 px here) but one cluster: a 20 px line overflows rather than split it.
    expect(lineTexts(obj('க்ஷிக்ஷி'), 20)).toEqual(['க்ஷி', 'க்ஷி']);
    // The accent (10 px in the test measurer) never parts from its letter.
    expect(lineTexts(obj('ab\u{0301}cd'), 20)).toEqual(['a', 'b\u{0301}', 'cd']);
  });
});

describe('style cuts inside clusters', () => {
  it("moves a cut inside Tamil 'க்ஷி' to the cluster end", () => {
    const o = obj('அக்ஷி', { runs: [bold(0, 3)] });
    const pp = prepared(o)[0]!;
    expect(pp.pieces.map((p) => [o.text.slice(p.start, p.end), pp.para.runs[p.sr]!.run])).toEqual([
      ['அக்ஷி', 0],
    ]);
    expect(pp.movedCuts).toBe(1);
    // The run starting inside the cluster loses that cluster; what follows keeps its own style.
    const o2 = obj('க்ஷிக', { runs: [{ start: 2, end: 5, fontWeight: 300 }] });
    const pp2 = prepared(o2)[0]!;
    expect(pp2.pieces.map((p) => [o2.text.slice(p.start, p.end), pp2.para.runs[p.sr]!.run])).toEqual([
      ['க்ஷி', -1],
      ['க', 0],
    ]);
  });

  it('keeps a letter with its combining marks, and does not move cuts between clusters', () => {
    const o = obj('e\u{0301}x', { runs: [bold(0, 1)] });
    const pp = prepared(o)[0]!;
    expect(pp.pieces.map((p) => [o.text.slice(p.start, p.end), pp.para.runs[p.sr]!.run])).toEqual([
      ['e\u{0301}', 0],
      ['x', -1],
    ]);
    expect(pp.movedCuts).toBe(1);
    const ok = prepared(obj('தமிழ்நாடு', { runs: [bold(0, 5)] }))[0]!;
    expect(ok.movedCuts).toBeUndefined();
    expect(ok.pieces.map((p) => p.end)).toEqual([5, 9]);
  });

  it('never cuts a surrogate pair or an emoji sequence', () => {
    const o = obj('a👨‍👩‍👧b', { runs: [bold(0, 2), { start: 4, end: 10, fontWeight: 300 }] });
    const pp = prepared(o)[0]!;
    expect(pp.pieces.map((p) => [o.text.slice(p.start, p.end), pp.para.runs[p.sr]!.run])).toEqual([
      ['a', 0],
      ['👨‍👩‍👧', 0],
      ['b', 1],
    ]);
  });
});

describe('joining scripts', () => {
  it('adds U+200D on both sides of a cut between two joining letters', () => {
    const text = 'مرحبا'; // meem (D) reh (R) hah (D) beh (D) alef (R)
    expect(segText(text, 0, 3, 'none')).toBe('مرح\u{200D}');
    expect(segText(text, 3, 5, 'none')).toBe('\u{200D}با');
    // Reh joins only to the letter before it: no joiner after it, none before hah.
    expect(segText(text, 0, 2, 'none')).toBe('مر');
    expect(segText(text, 2, 5, 'none')).toBe('حبا');
    // Meem joins forward to reh, which joins back.
    expect(segText(text, 0, 1, 'none')).toBe('م\u{200D}');
    expect(segText(text, 1, 5, 'none')).toBe('\u{200D}رحبا');
    // Whole words and words cut at spaces are untouched.
    expect(segText('سلام عليكم', 0, 5, 'none')).toBe('سلام ');
    expect(segText('سلام عليكم', 5, 10, 'none')).toBe('عليكم');
  });

  it('looks through harakat and joins Syriac, N’Ko, Mongolian and Adlam', () => {
    expect(joinsAcross('بَب', 2)).toBe(true); // beh, fatha | beh
    expect(joinsAcross('ܫܠܡܐ', 2)).toBe(true);
    expect(joinsAcross('ܫܠܡܐ', 3)).toBe(true); // mim joins forward to the right-joining alaph
    expect(joinsAcross('ߒߞߏ', 1)).toBe(true);
    expect(joinsAcross('ᠮᠣᠩᠭᠣᠯ', 3)).toBe(true);
    expect(joinsAcross('𞤀𞤁', 2)).toBe(true);
    expect(joinsAcross('دب', 1)).toBe(false); // dal is right-joining
    expect(joinsAcross('ءب', 1)).toBe(false); // hamza never joins
    expect(joinsAcross('שלום', 2)).toBe(false);
    expect(joinsAcross('ab', 1)).toBe(false);
    expect(joinsAcross('ب1', 1)).toBe(false);
    expect(joiningType(0x0640)).toBe('C');
    expect(joiningType(0x064e)).toBe('T');
    expect(joiningType(0x0627)).toBe('R');
    expect(joiningType(0x0628)).toBe('D');
    expect(joiningType(0x0780)).toBe('U'); // Thaana does not join
  });

  it('measures and draws a style split inside an Arabic word with the joiners', () => {
    const o = obj('مرحبا بكم', { runs: [{ start: 3, end: 5, color: { r: 255, g: 0, b: 0, a: 1 } }] });
    const m = testMeasurer({ em: 0.5 });
    const l = layoutRich(m, o, LEGACY_FONT_ENV);
    expect(m.texts).toContain('مرح\u{200D}');
    expect(m.texts).toContain('\u{200D}با');
    expect(m.texts).not.toContain('بكم\u{200D}');
    // The joiners never change offsets: the segments, right to left.
    const segs = l.lines[0]!.segs;
    expect(segs.map((s) => [s.start, s.end, s.level])).toEqual([
      [6, 9, 1],
      [5, 6, 1],
      [3, 5, 1],
      [0, 3, 1],
    ]);
  });
});

describe('fallback scripts', () => {
  it('names the script of a piece as textScripts does, and cuts between two scripts', () => {
    const o = obj('abc שלוםسلام 漢字かな 한국 हिन्दी தமிழ் ไทย မြန်မာ');
    const pp = prepared(o)[0]!;
    for (const p of pp.pieces) {
      const found = [...textScripts(o.text.slice(p.start, p.end))];
      expect(p.script).toBe(found[0] ?? '');
    }
    expect(pp.pieces.map((p) => [o.text.slice(p.start, p.end), p.script]).slice(0, 3)).toEqual([
      ['abc ', ''],
      ['שלום', 'Hebr'],
      ['سلام', 'Arab'],
    ]);
    expect(scriptOf('a')).toBe('');
    expect(scriptOf('ש')).toBe('Hebr');
    expect(scriptOf('ー')).toBe(''); // Common: takes its neighbours' script
  });

  it('keeps Han and kana in one piece when no break separates them', () => {
    const pp = prepared(obj('漢っ'))[0]!;
    expect(pp.pieces.map((p) => p.script)).toEqual(['Hani']);
  });
});

describe('prepare invariants', () => {
  const parts = [
    'word',
    ' ',
    'שָׁלוֹם',
    'مرحبا',
    'க்ஷி',
    '漢字、',
    'ภาษาไทย',
    '\u{00A0}',
    'e\u{0301}',
    '👨‍👩‍👧',
    '123',
    '\n',
    '\u{202E}',
    '\u{2067}',
    '-',
  ];
  it('covers each paragraph with ordered pieces of one level, cut only where allowed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...parts), { maxLength: 24 }),
        fc.array(fc.record({ start: fc.nat(80), end: fc.nat(80), fontWeight: fc.constant(700) }), {
          maxLength: 8,
        }),
        fc.constantFrom('ltr' as const, 'rtl' as const, 'auto' as const),
        fc.array(fc.option(fc.record({ soft: fc.boolean() }), { nil: null }), { maxLength: 8 }),
        (ps, rawRuns, direction, paras) => {
          const text = ps.join('');
          const runs = [...rawRuns].sort((a, b) => a.start - b.start);
          const o = obj(text, { runs, paras }, { direction });
          for (const pp of prepared(o)) {
            const { start, end } = pp.para;
            const clusters = new Set(graphemeBoundaries(text, start, end));
            const breaks = new Set(breakOpportunities(text, start, end, 'und'));
            let at = start;
            let prevSr = -1;
            for (const p of pp.pieces) {
              expect(p.start).toBe(at);
              expect(p.end).toBeGreaterThan(p.start);
              expect(p.trail).toBeGreaterThanOrEqual(p.start);
              expect(p.trail).toBeLessThanOrEqual(p.end);
              for (let k = p.start; k < p.end; k++)
                expect(pp.bidi.levels ? pp.bidi.levels[k - start] : pp.bidi.level).toBe(p.level);
              for (let k = p.start + 1; k < p.end; k++) expect(breaks.has(k)).toBe(false);
              expect(p.breakAfter).toBe(breaks.has(p.end));
              if (p.start > start && p.sr !== prevSr) expect(clusters.has(p.start)).toBe(true);
              prevSr = p.sr;
              at = p.end;
            }
            expect(at).toBe(end);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
