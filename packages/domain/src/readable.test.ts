import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { paraLabels } from './bullets.ts';
import { expandCues, firstText } from './cues.ts';
import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import { FALLBACK_SCRIPTS, LABEL_GAP, readableText, textScripts } from './readable.ts';
import { richText } from './rich.test-util.ts';
import { type Presentation, type Slide, TextObject, type TextPara } from './schemas.ts';

const verses = (startAt: number): TextPara => ({ bullet: { auto: 'arabicParenBoth', startAt } });

/** John 3:16-17 as an imported body box: the verse numbers are automatic, not in the text. */
function john(): TextObject {
  return {
    id: 'body',
    type: 'text',
    box: { x: 100, y: 100, w: 1720, h: 880, rotation: 0 },
    text: 'For God so loved the world\nthat he gave his only Son.\n\nFor God did not send his Son',
    style: DEFAULT_LYRIC_STYLE,
    opacity: 1,
    paras: [verses(16), { soft: true }, verses(16), verses(16)],
  };
}

/** `readableText` without its labels: what the round trip must give back. */
function strip(o: TextObject, readable: string): string {
  const labels = paraLabels(o);
  return readable
    .split('\n')
    .map((line, i) => {
      const l = labels[i];
      if (!l) return line;
      expect(line.startsWith(l + LABEL_GAP)).toBe(true);
      return line.slice(l.length + LABEL_GAP.length);
    })
    .join('\n');
}

describe('readableText', () => {
  it('writes verse numbers in front of their verses, a no-break space after each', () => {
    expect(readableText(john())).toBe(
      '(16)\u{a0}For God so loved the world\nthat he gave his only Son.\n\n(17)\u{a0}For God did not send his Son',
    );
  });

  it('round-trips a verse-numbered box through storage and back to its text', () => {
    const stored = TextObject.parse(JSON.parse(JSON.stringify(john())));
    const readable = readableText(stored);
    expect(readable).toBe(readableText(john()));
    expect(strip(stored, readable)).toBe(stored.text);
    // Paragraphs stay where they are, so paras[i] still describes line i.
    expect(readable.split('\n')).toHaveLength(stored.text.split('\n').length);
  });

  it('returns legacy text as it is', () => {
    const legacy: TextObject = { ...john(), paras: undefined };
    expect(readableText(legacy)).toBe(legacy.text);
    expect(readableText({ text: 'a\nb', paras: [] })).toBe('a\nb');
    expect(readableText({ text: 'a\nb', paras: [null, { align: 'left' }] })).toBe('a\nb');
  });

  it('writes bullets and the rich sample as the outputs draw them', () => {
    expect(
      readableText({
        text: 'Welcome\nCoffee after the service\nKids club',
        paras: [null, { bullet: { char: '\u{a7}', fontFamily: 'Wingdings' } }, { bullet: { char: '•' } }],
      }),
    ).toBe('Welcome\n\u{25aa}\u{a0}Coffee after the service\n•\u{a0}Kids club');
    const rich = richText();
    expect(readableText(rich).split('\n')[0]).toBe(`(17)${LABEL_GAP}${rich.text.split('\n')[0]}`);
  });

  it('keeps every paragraph and gives the text back without its labels, whatever the paras', () => {
    const para = fc.oneof(
      fc.constant(null),
      fc.record(
        {
          soft: fc.boolean(),
          level: fc.integer({ min: 0, max: 8 }),
          bullet: fc.oneof(
            fc.constant(null),
            fc.record({ char: fc.constantFrom('•', '-', '\u{f0a7}') }),
            fc.record({
              auto: fc.constantFrom('arabicPeriod', 'romanLcParenR'),
              startAt: fc.integer({ min: 1 }),
            }),
          ),
        },
        { requiredKeys: [] },
      ),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.array(para, { maxLength: 20 }), (text, paras) => {
        const o = { ...john(), text, paras } as TextObject;
        const readable = readableText(o);
        expect(readable.split('\n')).toHaveLength(text.split('\n').length);
        expect(strip(o, readable)).toBe(text);
      }),
    );
  });
});

describe('readable text where people read it', () => {
  const slide = (objects: Slide['objects'], lyricObjectId?: string): Slide => ({
    id: 's1',
    objects,
    ...(lyricObjectId ? { lyricObjectId } : {}),
  });

  it('firstText (cue labels, lyric-only bands, thumbnails) shows the verse numbers', () => {
    expect(firstText(slide([john()]))).toBe(readableText(john()));
    const title: TextObject = { ...john(), id: 'title', text: 'John 3', paras: undefined };
    expect(firstText(slide([title, john()], 'body'))).toBe(readableText(john()));
    expect(firstText(slide([title, john()]))).toBe('John 3');
    expect(firstText(slide([]))).toBe('');
  });

  it('cue labels carry the numbers', () => {
    const p: Presentation = {
      id: 'p',
      rev: 1,
      title: 'John 3',
      kind: 'slides',
      meta: { tags: [] },
      sections: [{ id: 's', label: 'Reading', short: 'R', slides: [slide([john()])] }],
      arrangements: [],
      archived: false,
    };
    const cues = expandCues({
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'Sunday',
        items: [{ id: 'i', kind: 'presentation', presentationId: 'p' }],
      },
      presentations: { p },
      media: {},
    });
    expect(cues[0]!.label.startsWith('(16)\u{a0}For God so loved')).toBe(true);
  });
});

describe('textScripts', () => {
  it('finds the scripts that need a fallback face, and none in Latin text', () => {
    expect([...textScripts('Amazing grace, how sweet the sound \u{2019}\u{2014} ①')]).toEqual([]);
    expect([...textScripts('Ơn Chúa — Việt Nam')]).toEqual([]);
    expect([...textScripts('שָׁלוֹם and سلام')]).toEqual(['Hebr', 'Arab']);
    expect([...textScripts('主の祈り こころ カタカナ 사랑')]).toEqual(['Hani', 'Hira', 'Kana', 'Hang']);
    expect([...textScripts('Αλληλούια, Аллилуия, ሃሌሉያ, ஆமென், ആമേൻ')]).toEqual([
      'Taml',
      'Mlym',
      'Ethi',
      'Grek',
      'Cyrl',
    ]);
    expect([...textScripts('(\u{e53})')]).toEqual(['Thai']);
  });

  it('uses distinct ISO 15924 codes', () => {
    const codes = FALLBACK_SCRIPTS.map(([c]) => c);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z][a-z]{3}$/);
  });
});
