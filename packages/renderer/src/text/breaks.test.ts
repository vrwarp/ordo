import { describe, expect, it, vi } from 'vitest';
import { breakOpportunities, graphemeBoundaries, isBreakSpace, isGlue, officeBreaks } from './breaks.ts';

/** `text` cut at its break opportunities (the whole text is one paragraph); `office`: the office rules. */
function lines(text: string, lang = '', office = false): string[] {
  const out: string[] = [];
  let at = 0;
  for (const b of breakOpportunities(text, 0, text.length, lang, office)) {
    out.push(text.slice(at, b));
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

/** `text` cut into clusters. */
function clusters(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (const b of graphemeBoundaries(text, 0, text.length)) {
    out.push(text.slice(at, b));
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

describe('UAX#14 break opportunities', () => {
  it('breaks after spaces and hyphens, never inside a word', () => {
    expect(lines('Amazing grace, how sweet')).toEqual(['Amazing ', 'grace, ', 'how ', 'sweet']);
    expect(lines('well-known fact')).toEqual(['well-', 'known ', 'fact']);
    expect(lines('John 3:16-17 says')).toEqual(['John ', '3:16-17 ', 'says']);
    expect(lines('a\tb')).toEqual(['a\t', 'b']);
  });

  it('keeps UAX#14 for ordo text: no office rule unless asked', () => {
    // Songs, scripture and slides made in ordo break as before (owner question T1's default).
    expect(lines('Isa. 2:6-10, 24:21-22')).toEqual(['Isa. ', '2:6-10, ', '24:21-22']);
    expect(lines('“every month” [offerings]')).toEqual(['“every ', 'month” [offerings]']);
    expect(lines('and/or https://books.google.as/books')).toEqual([
      'and/',
      'or ',
      'https://',
      'books.google.as/',
      'books',
    ]);
  });

  it('lists offsets inside [start, end) of the whole text, not the paragraph end', () => {
    const text = 'one two\nthree four';
    expect(breakOpportunities(text, 0, 7, '')).toEqual([4]);
    expect(breakOpportunities(text, 8, 18, '')).toEqual([14]);
    expect(breakOpportunities(text, 8, 8, '')).toEqual([]);
    expect(breakOpportunities('x', 0, 1, '')).toEqual([]);
  });

  it("never breaks at a no-break space: the 'Dieu !' split", () => {
    expect(lines('Gloire à Dieu\u{00A0}!')).toEqual(['Gloire ', 'à ', 'Dieu\u{00A0}!']);
    expect(lines('Gloire à Dieu\u{202F}!')).toEqual(['Gloire ', 'à ', 'Dieu\u{202F}!']);
    expect(lines('«\u{00A0}Alléluia\u{00A0}» !')).toEqual(['«\u{00A0}Alléluia\u{00A0}» !']);
    expect(lines('word\u{2060}word')).toEqual(['word\u{2060}word']);
    // After a breaking space a line may end before a no-break space (UAX#14 LB18), as LibreOffice breaks
    // ". \u00A0" (two spaces after a full stop, pasted): the no-break space starts the next line.
    expect(lines('x \u{00A0}y')).toEqual(['x ', '\u{00A0}y']);
    expect(lines('son. \u{00A0}They')).toEqual(['son. ', '\u{00A0}They']);
    expect(lines('10\u{202F}000 people')).toEqual(['10\u{202F}000 ', 'people']);
  });

  it('keeps CJK punctuation with its ideographs and breaks between ideographs (ID, CL, NS, OP)', () => {
    expect(lines('主啊、我信。')).toEqual(['主', '啊、', '我', '信。']);
    expect(lines('「哈利路亞」阿們')).toEqual(['「哈', '利', '路', '亞」', '阿', '們']);
    // Small kana and the prolonged sound mark never start a line.
    expect(lines('ちょっとコーヒー')).toEqual(['ちょっ', 'と', 'コー', 'ヒー']);
    expect(lines('主よ、みもとに')).toEqual(['主', 'よ、', 'み', 'も', 'と', 'に']);
    // Korean breaks at spaces only (keep-all, as LibreOffice and PowerPoint): '이야기를' stays whole.
    expect(lines('주 예수 ')).toEqual(['주 ', '예수 ']);
    expect(lines('이야기를 할 것인지에 대한')).toEqual(['이야기를 ', '할 ', '것인지에 ', '대한']);
    // A Hangul word next to Latin letters or digits stays whole too; ideographs still break.
    expect(lines('3절과 Jesus님')).toEqual(['3절과 ', 'Jesus님']);
    expect(lines('主啊主')).toEqual(['主', '啊', '主']);
  });

  it('breaks Thai, Lao, Khmer and Burmese at dictionary word boundaries', () => {
    expect(lines('สวัสดีครับ ผมชื่อสมชาย', 'th')).toEqual(['สวัสดี', 'ครับ ', 'ผม', 'ชื่อ', 'สมชาย']);
    expect(lines('พระเจ้าทรงรักโลก')).toEqual(['พระเจ้า', 'ทรง', 'รัก', 'โลก']);
    expect(lines('မြန်မာစာ ဘာသာစကား', 'my')).toEqual(['မြန်မာ', 'စာ ', 'ဘာသာစကား']);
    expect(lines('ພາສາລາວ', 'lo')).toEqual(['ພາສາ', 'ລາວ']);
    // Every cut of a Khmer phrase falls between clusters, never before a mark.
    const km = 'ព្រះជាម្ចាស់ស្រឡាញ់ពិភពលោក';
    for (const b of breakOpportunities(km, 0, km.length, 'km')) {
      expect(graphemeBoundaries(km, 0, km.length)).toContain(b);
      expect(/\p{M}/u.test(km[b]!)).toBe(false);
    }
  });

  it('never starts a line with a Thai repetition or abbreviation mark, nor splits letters from digits', () => {
    for (const text of ['ดีๆ มาก', 'กรุงเทพฯ สวย', 'บทที่๓']) {
      const ls = lines(text, 'th');
      for (const l of ls.slice(1)) expect(['ๆ', 'ฯ', '๓'].includes(l[0]!)).toBe(false);
    }
  });

  it('copes with any language tag and keeps breaks sorted and in range', () => {
    const text = 'abc สวัสดีครับ def ผมชื่อ 漢字';
    const ref = breakOpportunities(text, 0, text.length, 'th');
    for (const lang of ['', 'x', '-', 'en--US', 'th-TH', '123456789012345678901234567890']) {
      const bs = breakOpportunities(text, 0, text.length, lang);
      expect(bs).toEqual(ref);
      for (let i = 1; i < bs.length; i++) expect(bs[i]!).toBeGreaterThan(bs[i - 1]!);
    }
  });

  it('handles right-to-left text in logical order', () => {
    expect(lines('שָׁלוֹם עֲלֵיכֶם')).toEqual(['שָׁלוֹם ', 'עֲלֵיכֶם']);
    expect(lines('مرحبا بالعالم 123')).toEqual(['مرحبا ', 'بالعالم ', '123']);
  });
});

describe('break spaces and glue', () => {
  it('hangs breaking spaces only', () => {
    for (const c of [0x20, 0x09, 0x3000, 0x2002, 0x2009, 0x205f, 0x1680]) expect(isBreakSpace(c)).toBe(true);
    for (const c of [0xa0, 0x202f, 0x2007, 0x2060, 0x41, 0x0a, 0x200b]) expect(isBreakSpace(c)).toBe(false);
    for (const c of [0xa0, 0x202f, 0x2060, 0x2007, 0x2011, 0xfeff]) expect(isGlue(c)).toBe(true);
    expect(isGlue(0x20)).toBe(false);
  });
});

describe('cluster boundaries (emergency breaks)', () => {
  it("keeps Tamil 'க்ஷி' and other conjuncts whole", () => {
    expect(clusters('க்ஷி')).toEqual(['க்ஷி']);
    expect(clusters('ஸ்ரீ')).toEqual(['ஸ்ரீ']);
    expect(clusters('க்ஷிகா')).toEqual(['க்ஷி', 'கா']);
    // A pulli that ends a syllable is a boundary: Tamil writes such consonants apart.
    expect(clusters('தமிழ்நாடு')).toEqual(['த', 'மி', 'ழ்', 'நா', 'டு']);
    expect(clusters('क्षि')).toEqual(['क्षि']);
    expect(clusters('ಕ್ಷಿ')).toEqual(['ಕ್ಷಿ']);
    expect(clusters('ক্ষ')).toEqual(['ক্ষ']);
    expect(clusters('ක්\u{200D}ෂ')).toEqual(['ක්\u{200D}ෂ']);
    expect(clusters('ක්ෂ')).toEqual(['ක්', 'ෂ']); // no conjunct without the ZWJ
  });

  it('keeps combining sequences, emoji sequences and surrogate pairs whole', () => {
    expect(clusters('e\u{0301}a')).toEqual(['e\u{0301}', 'a']);
    expect(clusters('שָׁלוֹם')).toEqual(['שָׁ', 'ל', 'וֹ', 'ם']);
    expect(clusters('👨‍👩‍👧x')).toEqual(['👨‍👩‍👧', 'x']);
    expect(clusters('👍🏽🇫🇷')).toEqual(['👍🏽', '🇫🇷']);
    expect(clusters('𝄞a')).toEqual(['𝄞', 'a']);
    expect(clusters('abc')).toEqual(['a', 'b', 'c']);
    expect(graphemeBoundaries('ab\u{0301}c', 1, 4)).toEqual([3]);
  });
});

describe('without Intl.Segmenter', () => {
  it('falls back to code points with attached marks, and no dictionary breaks', async () => {
    const saved = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true, writable: true });
    try {
      vi.resetModules();
      const m = await import('./breaks.ts');
      const cut = (t: string) => {
        const out: string[] = [];
        let at = 0;
        for (const b of m.graphemeBoundaries(t, 0, t.length)) {
          out.push(t.slice(at, b));
          at = b;
        }
        return [...out, t.slice(at)];
      };
      expect(cut('e\u{0301}a👍🏽x')).toEqual(['e\u{0301}', 'a', '👍🏽', 'x']);
      expect(cut('👨‍👩‍👧x')).toEqual(['👨‍👩‍👧', 'x']);
      expect(cut('க்ஷிக')).toEqual(['க்ஷி', 'க']);
      expect(m.breakOpportunities('สวัสดีครับ ผม', 0, 13, 'th')).toEqual([11]);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', saved);
      vi.resetModules();
    }
  });
});

/** `text` cut at the office break opportunities (imported PowerPoint text, table cells, the converter's measure). */
const office = (text: string) => lines(text, '', true);

describe('office break opportunities (LibreOffice 24.2, the text-lines probe deck)', () => {
  it('breaks after a hyphen-minus before a digit (1000 Years: Isa. 2:6-10, 24:21- / 22)', () => {
    expect(office('Isa. 2:6-10, 24:21-22')).toEqual(['Isa. ', '2:6-', '10, ', '24:21-', '22']);
    expect(office('John 3:16-17 says')).toEqual(['John ', '3:16-', '17 ', 'says']);
    // Whatever is before the hyphen: a letter, a space (a minus), a bracket.
    expect(office('Psalm A-1')).toEqual(['Psalm ', 'A-', '1']);
    expect(office('x -5 (-6)')).toEqual(['x ', '-', '5 ', '(-', '6)']);
    // Not after a hyphen that starts the paragraph, not after U+2212 MINUS SIGN, not before a letter
    // beyond UAX#14's own break ('well-known').
    expect(office('-5 x')).toEqual(['-5 ', 'x']);
    expect(office('x \u22125')).toEqual(['x ', '\u22125']);
    expect(office('well-known')).toEqual(['well-', 'known']);
  });

  it('breaks after the spaces between any quotation mark and an opening bracket (Colossians, Matthew)', () => {
    expect(office('“every month” [offerings]')).toEqual(['“every ', 'month” ', '[offerings]']);
    expect(office('this rock?” (Num. 20:10)')).toEqual(['this ', 'rock?” ', '(Num. ', '20:10)']);
    expect(office('earth” [“made new”')).toEqual(['earth” ', '[“made ', 'new”']);
    expect(office('"so"  (see')).toEqual(['"so"  ', '(see']);
    expect(office("'so' (see")).toEqual(["'so' ", '(see']);
    // An initial quote too: LibreOffice breaks 'he said “ (aside)' and 'x“ (y)'.
    expect(office('said “ (aside)')).toEqual(['said ', '“ ', '(aside)']);
    expect(office('x“ (y)')).toEqual(['x“ ', '(y)']);
    // Never without a space, never at a no-break space, never inside the brackets.
    expect(office('word”(Gen.')).toEqual(['word”(Gen.']);
    expect(office('so”\u00A0(see')).toEqual(['so”\u00A0(see']);
    expect(office('[“made”]')).toEqual(['[“made”]']);
  });

  it('never breaks after a slash before a letter or digit (Matthew: the books.google address stays whole)', () => {
    expect(office('see https://books.google.as/books?id=wRY&pg=RA19-PA24')).toEqual([
      'see ',
      'https://books.google.as/books?',
      'id=wRY&pg=RA19-',
      'PA24',
    ]);
    expect(office('and/or 1/2 a/ b AND/OR')).toEqual(['and/or ', '1/2 ', 'a/ ', 'b ', 'AND/OR']);
  });

  it('takes the spaces between a quotation mark and a bracket to be exactly the breaking spaces', () => {
    // The office rule's space class is `isBreakSpace`'s, for every UTF-16 unit but the surrogates.
    const wrong: string[] = [];
    let spaces = 0;
    for (let c = 0; c <= 0xffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const got = officeBreaks(`x”${String.fromCharCode(c)}(y`);
      if (got.length !== (isBreakSpace(c) ? 1 : 0) || (got.length && got[0] !== 3))
        wrong.push(c.toString(16));
      if (got.length) spaces++;
    }
    expect(wrong).toEqual([]);
    expect(spaces).toBe(15); // tab, space, U+1680, U+2000-U+2006, U+2008-U+200A, U+205F, U+3000
    expect(officeBreaks('x” \t\u3000(y')).toEqual([5]);
    // Never a hyphen that starts the paragraph; a quote that does is a quote.
    expect(officeBreaks('-5 x-5')).toEqual([5]);
    expect(officeBreaks('” (y')).toEqual([2]);
  });

  it('reads a letter after a slash whole (a surrogate pair), and keeps breaks before other characters', () => {
    expect(lines('a/\u{1D400}b')).toEqual(['a/', '\u{1D400}b']);
    expect(office('a/\u{1D400}b c/\u{1F600}')).toEqual(['a/\u{1D400}b ', 'c/', '\u{1F600}']);
  });

  it('lists offsets of the whole text and merges with the SA breaks', () => {
    const text = 'one\nIsa. 24:21-22';
    expect(breakOpportunities(text, 4, text.length, '', true)).toEqual([9, 15]);
    expect(breakOpportunities(text, 4, text.length, '', false)).toEqual([9]);
    const th = 'ข้อ 3:16-17 สวัสดีครับ';
    const plain = breakOpportunities(th, 0, th.length, 'th');
    const withOffice = breakOpportunities(th, 0, th.length, 'th', true);
    expect(withOffice).toEqual([...new Set([...plain, th.indexOf('17')])].sort((a, b) => a - b));
  });
});
