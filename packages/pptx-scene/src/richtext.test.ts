import { readableText, Slide, type TextObject, type TextPara } from '@ordo/domain';
import * as prev from '@ordo/domain/schemas.prev.test-util.ts';
import { describe, expect, it } from 'vitest';
import { charClass, fallbackFonts, scriptClasses, substituteOf } from './fontmap.ts';
import { emitSlides, parseDeck } from './index.ts';
import { MAX_TEXT } from './richtext.ts';
import { body, br, buildDeck, type DeckSpec, para, run, solid, sp, themeXml } from './test-util.ts';

/*
 * Rich text emission (design/27 §3.1, §3.2, §4 "Text bodies", §6, §11): crafted decks through parseDeck and
 * emitSlides, one rule per test. Sizes: 2 logical px per point on a standard slide.
 */

const IN = 914_400;
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const RED = { r: 255, g: 0, b: 0, a: 1 };

/** The text objects of the first slide; every slide must be one `Slide.parse` returns unchanged. */
function texts(spec: DeckSpec): { texts: TextObject[]; notes: string[]; slide: Slide } {
  const out = emitSlides(parseDeck(buildDeck(spec)));
  for (const s of out.slides) expect(Slide.parse(s.slide)).toEqual(s.slide);
  const slide = out.slides[0]!.slide;
  return {
    texts: slide.objects.filter((o): o is TextObject => o.type === 'text'),
    notes: out.slides[0]!.notes,
    slide,
  };
}

const box = (txBody: string, id = 2, extra: Partial<Parameters<typeof sp>[0]> = {}) =>
  sp({ id, x: IN, y: IN, cx: 6 * IN, cy: 3 * IN, txBody, ...extra });
const one = (txBody: string, spec: Partial<DeckSpec> = {}) =>
  texts({ slides: [{ shapes: box(txBody) }], ...spec }).texts[0]!;
const sub = (o: TextObject, i: number) => o.text.split('\n')[i];

describe('box style', () => {
  it('writes the office line model, insets, wrap, anchor, direction and language beside the legacy values', () => {
    const t = one(
      body(
        para(run('Amazing grace', 'sz="3200"')),
        'lIns="182880" tIns="0" rIns="91440" bIns="45720" anchor="b" wrap="none"',
      ),
    );
    const ins = t.style.insets!;
    expect([ins.l, ins.t, ins.r, ins.b].map((v) => Math.round(v * 100) / 100)).toEqual([28.8, 0, 14.4, 7.2]);
    expect(t.style).toMatchObject({
      fontFamily: 'Calibri',
      fontSizePx: 64,
      lineModel: 'office',
      padding: 0, // the smallest inset, for an older build
      wrap: false,
      valign: 'bottom',
      direction: 'ltr',
      lang: 'en-US',
    });
    // The box is the shape's own: neither the insets nor wrap="none" change it.
    expect(t.box).toEqual({ x: 144, y: 144, w: 864, h: 432, rotation: 0 });
    expect(t.runs).toBeUndefined();
    expect(t.paras).toBeUndefined();
  });

  it('keeps the dominant run as the box style, so an older build still draws the text sensibly', () => {
    const t = one(
      body(
        para(
          run('1', 'sz="1600" b="1"') + run('In the beginning was the Word', 'sz="3200"', solid('FF0000')),
        ) +
          para(run('2', 'sz="1600" b="1"') + run('and the Word was with God', 'sz="3200"', solid('FF0000'))),
      ),
    );
    expect(t.style).toMatchObject({ fontSizePx: 64, fontWeight: 400, color: RED });
    expect(t.runs).toEqual([
      { start: 0, end: 1, fontWeight: 700, sizeScale: 0.5, color: { r: 0, g: 0, b: 0, a: 1 } },
      { start: 31, end: 32, fontWeight: 700, sizeScale: 0.5, color: { r: 0, g: 0, b: 0, a: 1 } },
    ]);
    // The previous release (0.5.0) keeps the runs; the box style beside them is the dominant run, what an
    // earlier build without runs drew.
    const old = prev.TextObject.parse(t);
    expect(old.runs).toEqual(t.runs);
    expect(old.style).toMatchObject({ fontSizePx: 64, color: RED });
    expect(old.text).toBe(t.text);
  });

  it('writes normAutofit as shrink with the stored scale, sizes unscaled; spAutoFit as no autofit', () => {
    const fit = (inner: string) =>
      body(para(run('Shrunk', 'sz="4000"'))).replace('<a:bodyPr/>', `<a:bodyPr>${inner}</a:bodyPr>`);
    const shrink = one(fit('<a:normAutofit fontScale="62500" lnSpcReduction="20000"/>'));
    expect(shrink.style).toMatchObject({
      fontSizePx: 80,
      autofit: 'shrink',
      fitScale: { font: 0.625, spacing: 0.8 },
    });
    const plain = one(fit('<a:normAutofit/>'));
    expect(plain.style.autofit).toBe('shrink');
    expect(plain.style.fitScale).toBeUndefined();
    const grow = one(fit('<a:spAutoFit/>'));
    expect(grow.style.autofit).toBeUndefined();
    expect(grow.style.fontSizePx).toBe(80);
  });
});

describe('runs', () => {
  it('marks superscript verse numbers with their baseline', () => {
    const t = one(
      body(
        para(
          run('16', 'sz="2800" baseline="30000"') +
            run(' For God so loved the world', 'sz="2800"') +
            run('17', 'sz="2800" baseline="30000"') +
            run(' For God did not send', 'sz="2800"'),
        ),
      ),
    );
    expect(t.text).toBe('16 For God so loved the world17 For God did not send');
    expect(t.runs).toEqual([
      { start: 0, end: 2, baseline: 0.3 },
      { start: 29, end: 31, baseline: 0.3 },
    ]);
  });

  it('writes mixed bold, italic, colour, size, underline, strike, highlight, caps and spacing', () => {
    const t = one(
      body(
        para(
          run('plain plain plain ', 'dirty="0"') +
            run('bold', 'b="1"') +
            run('it', 'i="1"', solid('FF0000')) +
            run('big', 'sz="3600" u="sng" strike="sngStrike"') +
            run('mark', '', '<a:highlight><a:srgbClr val="FFFF00"/></a:highlight>') +
            run('caps', 'cap="all" spc="300"') +
            run('small', 'cap="small"'),
        ),
      ),
    );
    const at = (s: string) => t.text.indexOf(s);
    expect(t.runs).toEqual([
      { start: at('bold'), end: at('bold') + 4, fontWeight: 700 },
      { start: at('it'), end: at('it') + 2, fontStyle: 'italic', color: RED },
      { start: at('big'), end: at('big') + 3, sizeScale: 2, underline: true, strike: true },
      { start: at('mark'), end: at('mark') + 4, highlight: { r: 255, g: 255, b: 0, a: 1 } },
      { start: at('caps'), end: at('caps') + 4, letterSpacing: 6, caps: 'all' },
      { start: at('small'), end: at('small') + 5, caps: 'small' },
    ]);
    expect(t.style.transform).toBe('none');
  });

  it('writes outlines at half their width, hollow text, and null where the box has one and the run none', () => {
    const ln = `<a:ln w="25400">${solid('0000FF')}</a:ln>`;
    const shadow =
      '<a:effectLst><a:outerShdw dist="25400" dir="5400000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>';
    const t = one(
      body(
        para(
          run('outlined and shadowed text', '', `${ln}${shadow}`) +
            run('hollow', '', `${ln}<a:noFill/>${shadow}`) +
            run('bare'),
        ),
      ),
    );
    expect(t.style.outline).toEqual({ width: 2, color: { r: 0, g: 0, b: 255, a: 1 } });
    expect(t.style.shadow).toMatchObject({ dy: 4, blur: 0 });
    const at = (s: string) => t.text.indexOf(s);
    expect(t.runs).toEqual([
      { start: at('hollow'), end: at('hollow') + 6, color: { r: 0, g: 0, b: 0, a: 0 } },
      { start: at('bare'), end: at('bare') + 4, outline: null, shadow: null },
    ]);
  });

  it('draws each script in its run typeface: Latin, East Asian, complex; weak characters take their neighbours', () => {
    const faces = '<a:latin typeface="Arial"/><a:ea typeface="SimSun"/><a:cs typeface="Times New Roman"/>';
    const t = one(body(para(run('Grace 恩典 and “سلام” «1»', '', faces))));
    expect(t.style.fontFamily).toBe('Arial');
    const at = (s: string) => t.text.indexOf(s);
    // '恩典 ' (with the space after it: weak characters take the script before them) and 'سلام” ' (the
    // curly quotes are weak too); Latin-1 guillemets and digits are Latin, as LibreOffice classes them.
    expect(t.runs).toEqual([
      { start: at('恩'), end: at('and'), fontFamily: 'SimSun' },
      { start: at('س'), end: at('«'), fontFamily: 'Times New Roman' },
    ]);
    expect(t.style.fallbackFonts).toEqual([
      'Liberation Sans',
      'SimSun',
      'Times New Roman',
      'Liberation Serif',
      'Noto Naskh Arabic',
      'Noto Sans SC',
    ]);
  });

  it('gives the theme script font to ea and cs text by language', () => {
    const theme = themeXml().replace(
      '<a:cs typeface=""/></a:minorFont>',
      '<a:cs typeface=""/><a:font script="Arab" typeface="Tahoma"/><a:font script="Hebr" typeface="David"/></a:minorFont>',
    );
    const t = one(body(para(run('שלום עולם', 'lang="he-IL"'))), { theme });
    expect(t.style.fontFamily).toBe('David');
    expect(t.style.lang).toBe('he-IL');
  });

  it('carries the end mark of an empty paragraph, and of a trailing a:br, on its line feed', () => {
    const t = one(
      body(
        para(run('Verse one', 'sz="4000"'), '', 'lang="en-US" sz="4000"') +
          para('', '', 'lang="en-US" sz="1000"') +
          para(run('Verse two', 'sz="4000"') + br, '', 'lang="en-US" sz="2000"'),
      ),
    );
    expect(t.text).toBe('Verse one\n\nVerse two\n');
    expect(t.paras).toEqual([null, null, null, { soft: true }]);
    // The '\n' ending the empty paragraph (10 pt) and the a:br before the empty last line (its end mark, 20 pt).
    expect(t.runs).toEqual([
      { start: 10, end: 11, sizeScale: 0.25 },
      { start: 20, end: 21, sizeScale: 0.5 },
    ]);
  });

  it("writes a 1 pt spacer paragraph's real size scale, below the 4 px floor of box sizes", () => {
    // Dense verse decks separate list items with sz="100" paragraphs: 2 px under 7 pt (14 px) lines.
    const t = one(
      body(
        para(run('Matthew 28:1', 'sz="700"')) +
          para(run(' ', 'sz="100"')) +
          para(run('Mark 16:2', 'sz="700"')),
      ),
    );
    expect(t.text).toBe('Matthew 28:1\n \nMark 16:2');
    expect(t.style.fontSizePx).toBe(14);
    // The run covers the space and the '\n' after it (its paragraph's end), at 2/14 of the box size.
    expect(t.runs).toEqual([{ start: 13, end: 15, sizeScale: 0.142857 }]);
  });

  it('cuts runs and paragraphs with the text at 20,000 characters', () => {
    const long = 'x'.repeat(MAX_TEXT - 3);
    const {
      texts: [t],
      notes,
    } = texts({
      slides: [
        {
          shapes: box(
            body(para(run(long, 'dirty="0"')) + para(run('bold', 'b="1"')) + para(run('more', 'i="1"'))),
          ),
        },
      ],
    });
    expect(t!.text).toHaveLength(MAX_TEXT);
    expect(t!.text.endsWith('\nbo')).toBe(true);
    expect(t!.runs).toEqual([{ start: MAX_TEXT - 2, end: MAX_TEXT, fontWeight: 700 }]);
    expect(notes.join(' ')).toMatch(/cut to 20000/);
  });
});

describe('paragraphs', () => {
  it('turns a:br into soft paragraphs that continue the one before', () => {
    const t = one(body(para(run('Amazing grace') + br + run('how sweet the sound'), 'algn="ctr"')));
    expect(t.text).toBe('Amazing grace\nhow sweet the sound');
    expect(t.style.align).toBe('center');
    expect(t.paras).toEqual([null, { soft: true }]);
  });

  it('writes alignment, levels, margins, spacing and line spacing that differ from the box', () => {
    const p = (text: string, pPr: string, children = '') =>
      `<a:p><a:pPr ${pPr}>${children}</a:pPr>${run(text, 'sz="2000"')}</a:p>`;
    const t = one(
      body(
        p('justified', 'algn="just"') +
          p('distributed', 'algn="dist"') +
          p('indented', `lvl="1" marL="${IN / 2}" indent="-${IN / 4}"`) +
          p(
            'spaced',
            '',
            '<a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:spcAft><a:spcPct val="50000"/></a:spcAft>',
          ) +
          p('exact', '', '<a:lnSpc><a:spcPts val="3000"/></a:lnSpc>') +
          p('a plain paragraph holding most of the text', ''),
      ),
    );
    expect(t.style.align).toBe('left');
    expect(t.paras).toEqual([
      { align: 'justify' },
      { align: 'distribute' },
      { level: 1, indentPx: 72, firstLinePx: -36 },
      { spaceBeforePx: 24, spaceAfterPx: 20, lineSpacing: 1.5 }, // 50 % of the 20 pt main run
      { lineSpacingPx: 60 },
    ]);
  });

  it("sizes a percentage gap by the paragraph's largest run, as LibreOffice does", () => {
    const gap = '<a:pPr><a:spcBef><a:spcPct val="200000"/></a:spcBef></a:pPr>';
    const t = one(
      body(
        para(run('Top of the box with most of the words', 'sz="2000"')) +
          `<a:p>${gap}${run('small ', 'sz="1000"')}${run('BIG', 'sz="4000"')}</a:p>` +
          `<a:p>${gap}${run('BIG ', 'sz="4000"')}${run('small', 'sz="1000"')}</a:p>` +
          // An empty paragraph: its end mark.
          `<a:p>${gap}<a:endParaRPr lang="en-US" sz="3000"/></a:p>`,
      ),
    );
    // 200 % of 40 pt (80 px) whichever run comes first; the empty one 200 % of its 30 pt end mark.
    expect(t.paras!.slice(1).map((p) => p?.spaceBeforePx)).toEqual([160, 160, 120]);
  });

  it('writes the box line spacing from the main paragraph and single spacing where another differs', () => {
    const t = one(
      body(
        `<a:p><a:pPr><a:lnSpc><a:spcPct val="90000"/></a:lnSpc></a:pPr>${run('most of the words are here')}</a:p>` +
          para(run('short')),
      ),
    );
    expect(t.style.lineHeight).toBeCloseTo(1.08);
    expect(t.paras).toEqual([null, { lineSpacing: 1 }]);
  });

  it('maps Wingdings and Symbol bullets to Unicode, keeps other fonts, and writes buNone as null', () => {
    const bu = (children: string) => `<a:pPr marL="342900" indent="-342900">${children}</a:pPr>`;
    const p = (text: string, children: string) => `<a:p>${bu(children)}${run(text)}</a:p>`;
    const t = one(
      body(
        p('square', '<a:buFont typeface="Wingdings" pitchFamily="2" charset="2"/><a:buChar char="§"/>') +
          p('arrow', '<a:buFont typeface="Wingdings"/><a:buChar char="\u{f0d8}"/>') +
          p('dot', '<a:buFont typeface="Symbol"/><a:buChar char="·"/>') +
          p(
            'dash',
            '<a:buClr><a:srgbClr val="FF0000"/></a:buClr><a:buSzPct val="75000"/><a:buFont typeface="Arial"/><a:buChar char="–"/>',
          ) +
          p('none', '<a:buNone/>'),
      ),
    );
    const bullets = (t.paras ?? []).map((x) => x?.bullet);
    expect(bullets).toEqual([
      { char: '\u{25aa}' },
      { char: '\u{27a2}' },
      { char: '\u{2022}' },
      { char: '–', fontFamily: 'Arial', color: RED, sizePct: 0.75 },
      null,
    ]);
    expect(t.paras![0]).toMatchObject({ indentPx: 54, firstLinePx: -54 });
  });

  it('maps Office theme bullets in Wingdings 2, Wingdings 3 and Webdings, and never keeps a private-use one', () => {
    const p = (text: string, font: string, ch: string) =>
      `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="${font}"/><a:buChar char="${ch}"/></a:pPr>${run(text)}</a:p>`;
    const t = one(
      body(
        p('circle', 'Wingdings 2', '\u{f097}') +
          p('triangle', 'Wingdings 3', '\u{f075}') +
          p('small triangle', 'Wingdings 3', '\u{f07d}') +
          p('web', 'Webdings', '\u{f034}') +
          p('unknown code', 'Wingdings 3', '\u{f0ad}') +
          p('icon font', 'Segoe MDL2 Assets', '\u{e700}') +
          p('another symbol font', 'Monotype Sorts', 'u'),
      ),
    );
    expect((t.paras ?? []).map((x) => x?.bullet)).toEqual([
      { char: '\u{25cf}' },
      { char: '\u{25b6}' },
      { char: '\u{25b8}' },
      { char: '\u{25b8}' },
      { char: '\u{2022}' },
      { char: '\u{2022}' },
      { char: '\u{2022}' },
    ]);
    // The labels people read are the same characters.
    expect(readableText(t).split('\n')[0]).toMatch(/^\u{25cf}\s+circle$/u);
  });

  it('numbers verses from startAt: (17), (18) in readable text', () => {
    const num =
      '<a:pPr marL="457200" indent="-457200"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicParenBoth" startAt="17"/></a:pPr>';
    const t = one(
      body(
        `<a:p>${num}${run('For God so loved the world')}</a:p><a:p>${num}${run('For God did not send')}</a:p>`,
      ),
    );
    const auto: TextPara['bullet'] = { auto: 'arabicParenBoth', startAt: 17, fontFamily: 'Calibri Light' };
    expect(t.paras?.map((p) => p?.bullet)).toEqual([auto, auto]);
    expect(readableText(t)).toBe('(17)\u{a0}For God so loved the world\n(18)\u{a0}For God did not send');
  });

  it('writes a buSzPts bullet as a share of the main run, and a picture bullet as •', () => {
    const t = one(
      body(
        `<a:p><a:pPr><a:buSzPts val="1000"/><a:buChar char="•"/></a:pPr>${run('a', 'sz="2000"')}</a:p>` +
          `<a:p><a:pPr><a:buBlip><a:blip r:embed="rId9"/></a:buBlip></a:pPr>${run('b', 'sz="2000"')}</a:p>`,
      ),
    );
    expect(t.paras?.map((p) => p?.bullet)).toEqual([{ char: '•', sizePct: 0.5 }, { char: '\u{2022}' }]);
  });

  it('writes Arabic right-to-left paragraphs with their direction and the complex-script font', () => {
    const cs = '<a:cs typeface="Arial"/>';
    const t = one(
      body(
        para(run('بسم الله الرحمن الرحيم', 'lang="ar-SA"', cs), 'algn="r" rtl="1"') +
          para(run('In the name of God', 'lang="en-US"')),
      ),
    );
    expect(t.style).toMatchObject({ direction: 'rtl', align: 'right', fontFamily: 'Arial', lang: 'ar-SA' });
    expect(t.paras).toEqual([null, { align: 'left', rtl: false }]);
    expect(t.runs).toEqual([
      { start: sub(t, 0)!.length + 1, end: t.text.length, fontFamily: 'Calibri', lang: 'en-US' },
    ]);
    expect(t.style.fallbackFonts).toEqual(['Liberation Sans', 'Carlito', 'Noto Naskh Arabic']);
  });
});

describe('fontmap', () => {
  it("classes characters by LibreOffice's script blocks", () => {
    const cls = (s: string) => charClass(s.codePointAt(0)!);
    expect(['A', '1', '(', 'é', 'Ж', 'Ω'].map(cls)).toEqual([
      'latin',
      'latin',
      'latin',
      'latin',
      'latin',
      'latin',
    ]);
    expect(['א', 'ب', 'क', 'ก'].map(cls)).toEqual(['cs', 'cs', 'cs', 'cs']);
    expect(['漢', 'か', '한', '。', 'Ａ', '𠀀'].map(cls)).toEqual(['ea', 'ea', 'ea', 'ea', 'ea', 'ea']);
    expect([' ', '\u{a0}', '—', '“', '→', '\u{300}', '\u{e000}'].map(cls)).toEqual(Array(7).fill('weak'));
    expect(scriptClasses('“שלום” 1')).toEqual(['cs', 'cs', 'cs', 'cs', 'cs', 'cs', 'cs', 'latin']);
    expect(scriptClasses('  ')).toEqual(['latin', 'latin']);
    expect(scriptClasses('a 𠀀')).toEqual(['latin', 'latin', 'ea', 'ea']);
  });

  it('lists substitutes, East Asian and complex families and script fallbacks, at most 8', () => {
    expect(substituteOf(' calibri ')).toBe('Carlito');
    expect(substituteOf('Comic Sans MS')).toBeUndefined();
    expect(fallbackFonts('Calibri', ['MS Gothic'], [], ['Cambria'], '日本語のテキスト', 'ja-JP')).toEqual([
      'Carlito',
      'MS Gothic',
      'Caladea',
      'Noto Sans JP',
    ]);
    const all = fallbackFonts(
      'Calibri',
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
      ['Arial', 'Georgia'],
      'שלום',
      undefined,
    );
    expect(all).toEqual(['Carlito', 'A', 'B', 'C', 'D', 'E', 'F', 'Liberation Sans']);
  });
});

describe('loCompat (the fidelity harness only)', () => {
  it("writes LibreOffice's policies: own normAutofit re-fitted, no run shadow, no outline on filled text", () => {
    const fit = (bodyPr: string) =>
      body(
        para(
          run(
            'Shadowed outlined',
            '',
            `<a:ln w="25400">${solid('0000FF')}</a:ln>` +
              '<a:effectLst><a:outerShdw dist="25400"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>',
          ) + run(' hollow', '', `<a:ln w="25400">${solid('0000FF')}</a:ln><a:noFill/>`),
        ),
      ).replace('<a:bodyPr/>', bodyPr);
    const master = {
      shapes: sp({
        id: 9,
        ph: 'type="body" idx="1"',
        x: IN,
        y: IN,
        cx: 4 * IN,
        cy: 2 * IN,
        txBody:
          '<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody>',
      }),
    };
    const spec: DeckSpec = {
      master,
      slides: [
        {
          shapes:
            box(fit('<a:bodyPr><a:normAutofit fontScale="80000"/></a:bodyPr>')) +
            sp({ id: 3, ph: 'type="body" idx="1"', txBody: fit('<a:bodyPr/>') }),
        },
      ],
    };
    const [own, inherited] = texts(spec).texts;
    expect(own!.style).toMatchObject({ autofit: 'shrink', fitScale: { font: 0.8, spacing: 1 } });
    expect(own!.style.shadow).toBeDefined();
    expect(inherited!.style.autofit).toBe('shrink'); // PowerPoint's policy: inherited autofit applies
    const out = emitSlides(parseDeck(buildDeck(spec)), { loCompat: true });
    const [a, b] = out.slides[0]!.slide.objects.filter((o): o is TextObject => o.type === 'text');
    expect(a!.style.autofit).toBe('shrink');
    expect(a!.style.fitScale).toBeUndefined();
    expect(a!.style.shadow).toBeUndefined();
    expect(a!.style.outline).toBeUndefined();
    expect(a!.runs).toEqual([
      {
        start: 17,
        end: 24,
        color: { r: 0, g: 0, b: 0, a: 0 },
        outline: { width: 2, color: { r: 0, g: 0, b: 255, a: 1 } },
      },
    ]);
    expect(b!.style.autofit).toBeUndefined();
  });
});

describe('legacy text (richText: false)', () => {
  it('writes only the fields of the previous release', () => {
    const out = emitSlides(
      parseDeck(
        buildDeck({ slides: [{ shapes: box(body(para(run('16', 'baseline="30000"') + run(' text')))) }] }),
      ),
      {
        richText: false,
      },
    );
    const t = out.slides[0]!.slide.objects.find((o): o is TextObject => o.type === 'text')!;
    expect(t.runs).toBeUndefined();
    expect(t.paras).toBeUndefined();
    expect(t.style.lineModel).toBeUndefined();
    expect(prev.TextObject.parse(t)).toEqual(t);
    expect(t.style.color).not.toEqual(WHITE);
  });
});

describe('gradient text (M6)', () => {
  const grad = (a: string, b: string) =>
    `<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="${a}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${b}"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;

  it('paints the box with its dominant run’s gradient, its first stop the legacy colour', () => {
    const {
      texts: [t],
      notes,
    } = texts({
      slides: [
        {
          shapes: box(
            body(
              para(
                run('Glory to God', 'sz="4000"', grad('FF0000', '0000FF')) +
                  run(' in the highest', 'sz="4000"', grad('FF0000', '0000FF')) +
                  run('!', 'sz="4000"', solid('00FF00')) +
                  run('?', 'sz="4000"', grad('FFFF00', '000000')),
              ),
            ),
          ),
        },
      ],
    });
    expect(t!.style.color).toEqual(RED);
    expect(t!.style.paint).toEqual({
      kind: 'linear',
      angle: 90,
      stops: [
        { at: 0, color: RED },
        { at: 1, color: { r: 0, g: 0, b: 255, a: 1 } },
      ],
    });
    // A run in its own colour keeps it; one in another gradient is drawn in that gradient's first colour.
    expect(t!.runs?.map((r) => [t!.text.slice(r.start, r.end), r.color])).toEqual([
      ['!', { r: 0, g: 255, b: 0, a: 1 }],
      ['?', { r: 255, g: 255, b: 0, a: 1 }],
    ]);
    expect(notes.join(' ')).toMatch(/text in a gradient other than its box’s is drawn in its first colour/);
    expect(notes.join(' ')).not.toMatch(/M6/);
  });
});
