import { describe, expect, it } from 'vitest';
import { colorContext, colorIn } from './color.ts';
import { NS_A, themeXml } from './test-util.ts';
import {
  langScript,
  MAX_SCRIPT_FONTS,
  MAX_TYPEFACE,
  readTheme,
  SCHEME_COLORS,
  styleEffect,
  styleFont,
  styleLine,
  type Theme,
  themeFont,
  typefaceName,
} from './theme.ts';
import { parseXml, rootOf, type XNode } from './xml.ts';

const parse = (s: string): XNode => rootOf(parseXml(s, 'test'))!;
const theme = (s: string) => readTheme(parse(s));
const hex = (t: Theme, name: string) => {
  const c = t.colors.get(name)!;
  return [c.r, c.g, c.b]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
};

/** A theme part with the given `a:clrScheme` entries and `a:fontScheme` collections. */
function themePart(scheme: string, fonts = ''): string {
  return (
    `<a:theme xmlns:a="${NS_A}"><a:themeElements><a:clrScheme name="t">${scheme}</a:clrScheme>` +
    `<a:fontScheme name="t">${fonts}</a:fontScheme></a:themeElements></a:theme>`
  );
}

const fontCollection = (tag: string, latin: string, ea: string, cs: string, scripts = '') =>
  `<a:${tag}><a:latin typeface="${latin}"/><a:ea typeface="${ea}"/><a:cs typeface="${cs}"/>${scripts}</a:${tag}>`;

describe('readTheme', () => {
  it("gives Office's colours and fonts for a missing theme", () => {
    const t = readTheme(undefined);
    expect(SCHEME_COLORS.map((n) => hex(t, n))).toEqual([
      '000000',
      'FFFFFF',
      '44546A',
      'E7E6E6',
      '4472C4',
      'ED7D31',
      'A5A5A5',
      'FFC000',
      '5B9BD5',
      '70AD47',
      '0563C1',
      '954F72',
    ]);
    expect(t.major.latin).toBe('Calibri Light');
    expect(t.minor.latin).toBe('Calibri');
    expect(t.fills).toEqual([]);
  });

  it('reads every kind of colour element in the scheme, modifiers included', () => {
    const t = theme(
      themePart(
        '<a:dk1><a:sysClr val="windowText" lastClr="1F1F1F"/></a:dk1>' +
          '<a:lt1><a:sysClr val="window"/></a:lt1>' +
          '<a:dk2><a:hslClr hue="0" sat="100000" lum="25000"/></a:dk2>' +
          '<a:lt2><a:prstClr val="ltGray"/></a:lt2>' +
          '<a:accent1><a:srgbClr val="4472C4"><a:lumMod val="75000"/></a:srgbClr></a:accent1>' +
          '<a:accent2><a:scrgbClr r="100000" g="0" b="0"/></a:accent2>' +
          '<a:accent3><a:schemeClr val="accent5"/></a:accent3>' +
          '<a:accent4><a:srgbClr val="nothex"/></a:accent4>',
      ),
    );
    expect(hex(t, 'dk1')).toBe('1F1F1F');
    expect(hex(t, 'lt1')).toBe('FFFFFF');
    expect(hex(t, 'dk2')).toBe('800000');
    expect(hex(t, 'lt2')).toBe('D3D3D3');
    expect(hex(t, 'accent1')).toBe('2F5597');
    expect(hex(t, 'accent2')).toBe('FF0000');
    // A scheme entry cannot refer to the scheme: Office's colour is used.
    expect(hex(t, 'accent3')).toBe('5B9BD5');
    // Unreadable and missing entries keep Office's colours.
    expect(hex(t, 'accent4')).toBe('FFC000');
    expect(hex(t, 'folHlink')).toBe('954F72');
  });

  it('reads the font scheme with its per-script fonts', () => {
    const t = theme(
      themePart(
        '',
        fontCollection(
          'majorFont',
          'Georgia',
          '',
          '',
          '<a:font script="Jpan" typeface="Yu Mincho"/><a:font script="Arab" typeface="Times New Roman"/>',
        ) +
          fontCollection(
            'minorFont',
            '',
            'MS Gothic',
            'Arial',
            '<a:font script="Hebr" typeface="David"/><a:font script="Hebr" typeface="Later"/>' +
              '<a:font script="__proto__" typeface="Proto"/><a:font typeface="NoScript"/><a:font script="Thai"/>',
          ),
      ),
    );
    expect(t.major).toMatchObject({ latin: 'Georgia', ea: '', cs: '' });
    expect([...t.major.scripts]).toEqual([
      ['Jpan', 'Yu Mincho'],
      ['Arab', 'Times New Roman'],
    ]);
    // An empty latin typeface keeps the default; the first entry of a script wins; prototype names are data.
    expect(t.minor).toMatchObject({ latin: 'Calibri', ea: 'MS Gothic', cs: 'Arial' });
    expect([...t.minor.scripts]).toEqual([
      ['Hebr', 'David'],
      ['__proto__', 'Proto'],
    ]);
  });

  it(`cuts typefaces to ${MAX_TYPEFACE} characters and reads at most ${MAX_SCRIPT_FONTS} script fonts`, () => {
    const many = Array.from({ length: 500 }, (_, i) => `<a:font script="S${i}" typeface="F${i}"/>`).join('');
    const t = theme(themePart('', fontCollection('minorFont', 'x'.repeat(1000), '', '', many)));
    expect(t.minor.latin.length).toBe(MAX_TYPEFACE);
    expect(t.minor.scripts.size).toBe(MAX_SCRIPT_FONTS);
  });

  it('keeps the format scheme lists in order, without text nodes', () => {
    const t = readTheme(parse(themeXml()));
    expect(t.fills.map((n) => n.name)).toEqual(['a:solidFill', 'a:solidFill', 'a:solidFill']);
    expect(t.lines.map((n) => n.attrs.w)).toEqual(['6350', '12700', '19050']);
    expect(t.effects.length).toBe(3);
    expect(t.bgFills.length).toBe(3);
  });
});

describe('themeFont', () => {
  const t = theme(
    themePart(
      '',
      fontCollection(
        'majorFont',
        'Georgia',
        '',
        'Times New Roman',
        '<a:font script="Jpan" typeface="Yu Mincho"/>',
      ) +
        fontCollection(
          'minorFont',
          'Calibri',
          '',
          '',
          '<a:font script="Jpan" typeface="Yu Gothic"/><a:font script="Arab" typeface="Arial"/>',
        ),
    ),
  );

  it('resolves theme references and keeps other names', () => {
    expect(themeFont(t, '+mj-lt')).toBe('Georgia');
    expect(themeFont(t, '+mn-lt')).toBe('Calibri');
    expect(themeFont(t, '+mj-cs')).toBe('Times New Roman');
    expect(themeFont(t, 'Arial Black')).toBe('Arial Black');
    expect(themeFont(t, 'x'.repeat(5000))?.length).toBe(MAX_TYPEFACE);
    expect(themeFont(t, '+xx-lt')).toBe('+xx-lt');
    expect(themeFont(t, '+mn-zz')).toBe('+mn-zz');
    expect(themeFont(t, '')).toBeUndefined();
    expect(themeFont(t, undefined)).toBeUndefined();
  });

  it("uses the collection's script font when its ea or cs typeface is empty", () => {
    expect(themeFont(t, '+mn-ea')).toBeUndefined();
    expect(themeFont(t, '+mn-ea', 'Jpan')).toBe('Yu Gothic');
    expect(themeFont(t, '+mj-ea', 'Jpan')).toBe('Yu Mincho');
    expect(themeFont(t, '+mn-cs', 'Arab')).toBe('Arial');
    expect(themeFont(t, '+mj-cs', 'Arab')).toBe('Times New Roman');
    expect(themeFont(t, '+mn-lt', 'Jpan')).toBe('Calibri');
    expect(themeFont(t, '+mn-ea', 'Hang')).toBeUndefined();
    expect(themeFont(t, '+mn-ea', langScript('ja-JP'))).toBe('Yu Gothic');
  });
});

describe('langScript', () => {
  it('maps languages written with the ea or cs font to theme script tags', () => {
    expect(langScript('ja-JP')).toBe('Jpan');
    expect(langScript('ko-KR')).toBe('Hang');
    expect(langScript('zh-CN')).toBe('Hans');
    expect(langScript('zh-TW')).toBe('Hant');
    expect(langScript('zh-Hant-HK')).toBe('Hant');
    expect(langScript('zh')).toBe('Hans');
    expect(langScript('ar-SA')).toBe('Arab');
    expect(langScript('he-IL')).toBe('Hebr');
    expect(langScript('hi-IN')).toBe('Deva');
    expect(langScript('ta-IN')).toBe('Taml');
    expect(langScript('th-TH')).toBe('Thai');
    expect(langScript('mn-Mong-CN')).toBe('Mong');
    expect(langScript('AM_et')).toBe('Ethi');
  });

  it('gives nothing for languages the latin font covers, and for nonsense', () => {
    expect(langScript('en-US')).toBeUndefined();
    expect(langScript('mn-MN')).toBeUndefined();
    expect(langScript('__proto__')).toBeUndefined();
    expect(langScript('ja'.repeat(100))).toBeUndefined();
    expect(langScript('')).toBeUndefined();
    expect(langScript(undefined)).toBeUndefined();
  });
});

describe('style references', () => {
  const t = readTheme(parse(themeXml({ major: 'Georgia', minor: 'Verdana' })));
  const ctx = colorContext(t, undefined);
  const ref = (s: string) => parse(`<r xmlns:a="${NS_A}">${s}</r>`).children[0];

  it('gives a fontRef its collection and colour', () => {
    expect(styleFont(t, ref('<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>'), ctx)).toEqual({
      latin: 'Verdana',
      color: { r: 255, g: 255, b: 255, a: 1 },
    });
    expect(styleFont(t, ref('<a:fontRef idx="major"/>'), ctx)).toEqual({ latin: 'Georgia' });
    expect(styleFont(t, ref('<a:fontRef idx="none"/>'), ctx)).toEqual({});
    expect(styleFont(t, undefined, ctx)).toBeUndefined();
  });

  it('gives an lnRef its theme line and an effectRef its effect style, with phClr', () => {
    const line = styleLine(t, ref('<a:lnRef idx="2"><a:srgbClr val="00FF00"/></a:lnRef>'), ctx);
    expect(line?.ln.attrs.w).toBe('12700');
    expect(colorIn(line?.ln.children[0], line!.ctx)).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(styleLine(t, ref('<a:fillRef idx="2"/>'), ctx)).toBeUndefined();
    expect(styleLine(t, ref('<a:lnRef idx="0"/>'), ctx)).toBeUndefined();
    expect(styleEffect(t, ref('<a:effectRef idx="3"/>'), ctx)?.effect.name).toBe('a:effectStyle');
    expect(styleEffect(t, ref('<a:effectRef idx="9"/>'), ctx)).toBeUndefined();
  });
});

describe('typeface names', () => {
  it('lose control characters (a form feed would break the Canvas font shorthand) and are cut', () => {
    expect(typefaceName('Arial\f')).toBe('Arial');
    expect(typefaceName(' A\u0000r\u0085i al ')).toBe('Arial');
    expect(typefaceName('x'.repeat(MAX_TYPEFACE + 10))).toHaveLength(MAX_TYPEFACE);
    expect(typefaceName(undefined)).toBe('');
    const t = theme(themePart('', fontCollection('majorFont', 'Big\fFace', '', '')));
    expect(t.major.latin).toBe('BigFace');
    expect(themeFont(t, 'Plain\u000b')).toBe('Plain');
    expect(themeFont(t, '+x\f-lt')).toBe('+x-lt');
  });

  it('reads a theme once per root', () => {
    const root = parse(themePart(''));
    expect(readTheme(root)).toBe(readTheme(root));
  });
});
