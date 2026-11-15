import { describe, expect, it } from 'vitest';
import { parseDeck } from './index.ts';
import type { ShapeElement, TextBody } from './ir.ts';
import { plainText, textChars } from './text.ts';
import {
  body,
  br,
  buildDeck,
  type DeckSpec,
  imageRel,
  para,
  run,
  scheme,
  solid,
  sp,
  themeXml,
} from './test-util.ts';

const IN = 914_400;
const RED = { r: 255, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 255, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

/** The text bodies of the first slide's elements that have text, in order. */
function bodies(spec: DeckSpec): TextBody[] {
  const s = parseDeck(buildDeck(spec)).slides[0]!;
  expect(s.error).toBeUndefined();
  return s.elements.filter((e): e is ShapeElement => e.kind === 'shape' && !!e.text).map((e) => e.text!);
}

const box = (txBody: string, extra: Partial<Parameters<typeof sp>[0]> = {}) =>
  sp({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: IN, txBody, ...extra });

describe('run properties through the chain', () => {
  const master = {
    txStyles:
      '<p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle/>',
    shapes:
      sp({ id: 2, ph: 'type="title"', x: 0, y: 0, cx: IN, cy: IN }) +
      sp({
        id: 3,
        ph: 'type="body" idx="1"',
        x: 0,
        y: 0,
        cx: IN,
        cy: IN,
        txBody: body(para(''), '', '<a:lvl1pPr><a:defRPr i="1"/></a:lvl1pPr>'),
      }),
  };
  const layouts = [
    {
      shapes: sp({
        id: 2,
        ph: 'type="body" idx="1"',
        txBody: body(
          para(''),
          '',
          `<a:lvl1pPr><a:defRPr sz="3200">${solid('0000FF')}</a:defRPr></a:lvl1pPr>`,
        ),
      }),
    },
  ];

  it('gives a title its master titleStyle and the theme major font', () => {
    const [t] = bodies({
      master,
      layouts,
      theme: themeXml({ major: 'Heading Face', minor: 'Body Face', colors: { dk2: '112233' } }),
      slides: [{ shapes: sp({ id: 2, ph: 'type="title"', txBody: body(para(run('Title'))) }) }],
    });
    const st = t!.paras[0]!.runs[0]!.style;
    expect(st).toMatchObject({ sizePt: 44, bold: true, italic: false, latin: 'Heading Face' });
    expect(st.fill).toEqual({ kind: 'solid', color: { r: 0x11, g: 0x22, b: 0x33, a: 1 } });
    expect(t!.paras[0]!.align).toBe('center');
  });

  it('takes each property from the nearest level: own rPr, own lstStyle, layout, master placeholder, txStyles', () => {
    const [a, b] = bodies({
      master,
      layouts,
      theme: themeXml({ minor: 'Body Face' }),
      slides: [
        {
          shapes:
            sp({ id: 2, ph: 'idx="1"', txBody: body(para(run('a', 'sz="1200"'))) }) +
            sp({
              id: 3,
              ph: 'idx="1"',
              txBody: body(
                para(run('b')),
                '',
                `<a:lvl1pPr><a:defRPr>${solid('FF0000')}</a:defRPr></a:lvl1pPr>`,
              ),
            }),
        },
      ],
    });
    const sa = a!.paras[0]!.runs[0]!.style;
    expect(sa).toMatchObject({ sizePt: 12, italic: true, latin: 'Body Face' });
    expect(sa.fill).toEqual({ kind: 'solid', color: BLUE }); // the layout's colour
    const sb = b!.paras[0]!.runs[0]!.style;
    expect(sb.sizePt).toBe(32);
    expect(sb.fill).toEqual({ kind: 'solid', color: RED }); // the shape's own list style
  });

  it('uses defaultTextStyle for a text box, not the master otherStyle, and the theme minor font', () => {
    const [t] = bodies({
      master: {
        txStyles:
          '<p:titleStyle/><p:bodyStyle/><p:otherStyle><a:lvl1pPr><a:defRPr sz="900"/></a:lvl1pPr></p:otherStyle>',
      },
      defaultTextStyle: `<a:lvl1pPr><a:defRPr sz="2400">${solid('00FF00')}</a:defRPr></a:lvl1pPr>`,
      theme: themeXml({ minor: 'Body Face' }),
      slides: [{ shapes: box(body(para(run('x'))), { txBox: true }) }],
    });
    expect(t!.paras[0]!.runs[0]!.style).toMatchObject({
      sizePt: 24,
      latin: 'Body Face',
      fill: { kind: 'solid', color: { r: 0, g: 255, b: 0, a: 1 } },
    });
  });

  it('defaults to 18 pt, the tx1 colour and the theme font when nothing sets them', () => {
    const [t] = bodies({ slides: [{ shapes: box(body(para(run('x')))) }] });
    expect(t!.paras[0]!.runs[0]!.style).toMatchObject({
      sizePt: 18,
      bold: false,
      latin: 'Calibri',
      fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
    });
  });

  it('resolves explicit theme font references and keeps a deck family as written', () => {
    const [t] = bodies({
      theme: themeXml({ major: 'Heading Face' }),
      slides: [
        {
          shapes: box(
            body(
              para(
                run('a', '', '<a:latin typeface="+mj-lt"/>') +
                  run('b', '', '<a:latin typeface="Georgia"/><a:ea typeface="MS Mincho"/>'),
              ),
            ),
          ),
        },
      ],
    });
    const [a, b] = t!.paras[0]!.runs;
    expect(a!.style.latin).toBe('Heading Face');
    expect(b!.style.latin).toBe('Georgia');
    expect(b!.style.ea).toBe('MS Mincho');
  });

  it('puts the shape style font reference between the shape list style and defaultTextStyle', () => {
    const style = `<p:style><a:lnRef idx="0">${scheme('accent1')}</a:lnRef><a:fillRef idx="1">${scheme('accent1')}</a:fillRef><a:effectRef idx="0">${scheme('accent1')}</a:effectRef><a:fontRef idx="major">${scheme('lt1')}</a:fontRef></p:style>`;
    const [plain, own] = bodies({
      theme: themeXml({ major: 'Heading Face', minor: 'Body Face' }),
      defaultTextStyle: `<a:lvl1pPr><a:defRPr sz="1800">${solid(scheme('tx1'))}<a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>`,
      slides: [
        {
          shapes:
            box(body(para(run('x'))), { style }) +
            box(body(para(run('y')), '', `<a:lvl1pPr><a:defRPr>${solid('FF0000')}</a:defRPr></a:lvl1pPr>`), {
              id: 3,
              style,
            }),
        },
      ],
    });
    expect(plain!.paras[0]!.runs[0]!.style).toMatchObject({
      latin: 'Heading Face',
      fill: { kind: 'solid', color: WHITE },
    });
    expect(own!.paras[0]!.runs[0]!.style.fill).toEqual({ kind: 'solid', color: RED });
  });

  it('reads outline, hollow text, shadow, caps, spacing, baseline and underline', () => {
    const [t] = bodies({
      slides: [
        {
          shapes: box(
            body(
              para(
                run(
                  'a',
                  'cap="all" spc="300" baseline="30000" u="sng" strike="sngStrike"',
                  `<a:ln w="25400">${solid('0000FF')}</a:ln><a:noFill/><a:effectLst><a:outerShdw blurRad="38100" dist="25400" dir="2700000"><a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:outerShdw></a:effectLst>`,
                ) + run('b', '', `<a:ln w="25400"><a:noFill/></a:ln>`),
              ),
            ),
          ),
        },
      ],
    });
    const [a, b] = t!.paras[0]!.runs;
    expect(a!.style).toMatchObject({
      caps: 'all',
      spacingPt: 3,
      baseline: 0.3,
      underline: true,
      strike: true,
      fill: { kind: 'none' },
      outline: { width: 25_400, fill: { kind: 'solid', color: BLUE } },
      shadow: { dist: 25_400, blur: 38_100, dir: 45, color: { r: 0, g: 0, b: 0, a: 0.5 } },
    });
    expect(b!.style.outline).toBeUndefined();
    expect(b!.style.shadow).toBeUndefined();
  });

  it('a picture-filled run keeps an opaque fill: the text colour, its outline and a note', () => {
    // The AMOR slide: a run filled with a picture (`a:blipFill` in `a:rPr`), outlined in dark red. ordo
    // paints no text with a picture; the run takes the text colour (tx1, here dk1 112233), as with no fill.
    const blip = '<a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>';
    const ln = `<a:ln w="76200">${solid('AB0043')}</a:ln>`;
    const deck = buildDeck({
      theme: themeXml({ colors: { dk1: '112233' } }),
      slides: [
        {
          rels: [imageRel('rId2', 'image1.png')],
          shapes:
            box(body(para(run('A', 'sz="24000" b="1"', ln + blip)))) +
            // Inherited from the list style; a nearer solid fill still wins; a group fill means nothing on text.
            box(
              body(
                para(run('B', '', ln) + run('C', '', solid('FF0000')) + run('D', '', '<a:grpFill/>')),
                '',
                `<a:lvl1pPr><a:defRPr>${blip}</a:defRPr></a:lvl1pPr>`,
              ),
              { id: 3 },
            ),
        },
      ],
    });
    const s = parseDeck(deck).slides[0]!;
    const [one, two] = s.elements.filter((e): e is ShapeElement => e.kind === 'shape' && !!e.text);
    const ink = { r: 0x11, g: 0x22, b: 0x33, a: 1 };
    const a = one!.text!.paras[0]!.runs[0]!.style;
    expect(a.fill).toEqual({ kind: 'solid', color: ink });
    expect(a.textFill).toBe('picture');
    expect(a.outline).toEqual({
      width: 76_200,
      fill: { kind: 'solid', color: { r: 0xab, g: 0, b: 0x43, a: 1 } },
    });
    const [b, c, d] = two!.text!.paras[0]!.runs;
    expect(b!.style).toMatchObject({ fill: { kind: 'solid', color: ink }, textFill: 'picture' });
    expect(b!.style.outline).toBeDefined();
    expect(c!.style.fill).toEqual({ kind: 'solid', color: RED });
    expect(c!.style.textFill).toBeUndefined();
    expect(d!.style).toMatchObject({ fill: { kind: 'solid', color: ink }, textFill: 'group' });
    // Noted once for the slide, however many runs.
    expect(s.notes.filter((n) => n.startsWith('picture-filled text'))).toEqual([
      'picture-filled text is drawn in the text colour',
    ]);
    expect(s.notes).toContain('text with a group fill is drawn in the text colour');
  });

  it('marks baseline 0 under a non-zero inherited baseline (escZero), where LibreOffice reads the 0 as unset', () => {
    // The Dutch deck: every run sets baseline="0" under a defaultTextStyle of -25000. PowerPoint draws them in
    // place at full size; LibreOffice 24.2 drops the 0 and draws them lowered by 25 % at 58 % (probe decks).
    const [t] = bodies({
      defaultTextStyle: '<a:lvl1pPr><a:defRPr sz="3600" baseline="-25000"/></a:lvl1pPr>',
      slides: [
        {
          shapes: box(
            body(para(run('zero', 'baseline="0"') + run('default') + run('sup', 'baseline="30000"'))),
            { txBox: true },
          ),
        },
      ],
    });
    const [zero, dflt, sup] = t!.paras[0]!.runs;
    expect(zero!.style).toMatchObject({ baseline: 0, escZero: -0.25 });
    expect(dflt!.style.baseline).toBe(-0.25);
    expect(dflt!.style.escZero).toBeUndefined();
    expect(sup!.style.baseline).toBe(0.3);
    expect(sup!.style.escZero).toBeUndefined();
    // A list style's 0 counts as the run's own does; a 0 with nothing farther is no shift for both programs.
    const [listed, alone] = bodies({
      defaultTextStyle: '<a:lvl1pPr><a:defRPr baseline="-25000"/></a:lvl1pPr>',
      slides: [
        {
          shapes:
            box(body(para(run('listed')), '', '<a:lvl1pPr><a:defRPr baseline="0"/></a:lvl1pPr>'), {
              txBox: true,
            }) + box(body(para(run('alone', 'baseline="0"'))), { id: 3 }),
        },
      ],
    });
    expect(listed!.paras[0]!.runs[0]!.style).toMatchObject({ baseline: 0, escZero: -0.25 });
    expect(alone!.paras[0]!.runs[0]!.style.escZero).toBe(-0.25); // a shape: defaultTextStyle too
    const [none] = bodies({ slides: [{ shapes: box(body(para(run('alone', 'baseline="0"')))) }] });
    expect(none!.paras[0]!.runs[0]!.style).toMatchObject({ baseline: 0 });
    expect(none!.paras[0]!.runs[0]!.style.escZero).toBeUndefined();
  });

  it('reads hostile run fills and baselines without throwing, every run with a fill and a bounded baseline', () => {
    // A seeded mix of fill elements (several at once, empty, nested, unknown), baselines and lists styles.
    const parts = [
      '<a:blipFill/>',
      '<a:blipFill><a:blip r:embed="rId404"/><a:blipFill/></a:blipFill>',
      '<a:grpFill/>',
      '<a:noFill/>',
      solid('00FF00'),
      '<a:solidFill/>',
      '<a:gradFill/>',
      '<a:pattFill prst="nope"/>',
      `<a:ln>${'<a:blipFill/>'}</a:ln>`,
      '<a:x/>',
    ];
    const attrs = [
      '',
      'baseline="0"',
      'baseline="-25000"',
      'baseline="1e309"',
      'baseline="NaN"',
      'baseline=""',
    ];
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const runs: string[] = [];
    for (let i = 0; i < 200; i++) {
      let kids = '';
      for (let k = next(4); k > 0; k--) kids += parts[next(parts.length)];
      runs.push(run(`r${i}`, attrs[next(attrs.length)]!, kids));
    }
    const list = `<a:lvl1pPr><a:defRPr ${attrs[2]}>${parts[0]}${parts[2]}</a:defRPr></a:lvl1pPr>`;
    const [t] = bodies({ slides: [{ shapes: box(body(para(runs.join('')), '', list)) }] });
    for (const r of t!.paras[0]!.runs) {
      expect(['solid', 'none', 'gradient', 'pattern']).toContain(r.style.fill.kind);
      expect(Math.abs(r.style.baseline)).toBeLessThanOrEqual(1);
      if (r.style.textFill) expect(r.style.fill.kind).toBe('solid');
    }
  });
});

describe('paragraphs', () => {
  it('reads breaks, fields, alignment, spacing and levels', () => {
    const [t] = bodies({
      slides: [
        {
          shapes: box(
            body(
              para(run('one') + br + run('two'), 'algn="r"') +
                para(
                  `<a:fld id="{1}" type="slidenum"><a:rPr lang="en-US"/><a:t>7</a:t></a:fld>`,
                  'lvl="1" marL="457200" indent="-228600"',
                ) +
                `<a:p><a:pPr algn="just"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef></a:pPr>${run('three')}</a:p>`,
            ),
          ),
        },
      ],
    });
    const [p1, p2, p3] = t!.paras;
    expect(p1!.runs.map((r) => [r.kind, r.text])).toEqual([
      ['text', 'one'],
      ['break', '\n'],
      ['text', 'two'],
    ]);
    expect(p1!.align).toBe('right');
    expect(p2).toMatchObject({ level: 1, marL: 457_200, indent: -228_600 });
    expect(p2!.runs[0]).toMatchObject({ kind: 'field', text: '7' });
    expect(p3).toMatchObject({ align: 'justify', lineSpacing: { pct: 0.9 }, spaceBefore: { pts: 6 } });
    expect(plainText(t!)).toBe('one\ntwo\n7\nthree');
    expect(textChars(t!)).toBe(12);
  });

  it('takes the nearest bullet setting, so a nearer buNone switches an inherited bullet off', () => {
    const lst = `<a:lvl1pPr><a:buFont typeface="Arial"/><a:buChar char="•"/></a:lvl1pPr><a:lvl2pPr><a:buClr>${scheme('accent2')}</a:buClr><a:buSzPct val="80000"/><a:buAutoNum type="romanUcPeriod" startAt="3"/></a:lvl2pPr>`;
    const [t] = bodies({
      slides: [
        {
          shapes: box(
            body(
              para(run('a')) + para(run('b'), 'lvl="1"') + `<a:p><a:pPr><a:buNone/></a:pPr>${run('c')}</a:p>`,
              '',
              lst,
            ),
          ),
        },
      ],
    });
    const [a, b, c] = t!.paras;
    expect(a!.bullet).toEqual({ kind: 'char', char: '•', font: 'Arial' });
    expect(b!.bullet).toEqual({
      kind: 'auto',
      scheme: 'romanUcPeriod',
      startAt: 3,
      color: { r: 0xed, g: 0x7d, b: 0x31, a: 1 },
      sizePct: 0.8,
    });
    expect(c!.bullet).toBeUndefined();
  });
});

describe('body properties', () => {
  it('inherits insets, anchor and wrap from the layout and master placeholders', () => {
    const [t] = bodies({
      master: {
        shapes: sp({
          id: 2,
          ph: 'type="body" idx="1"',
          x: 0,
          y: 0,
          cx: IN,
          cy: IN,
          txBody: body(para(''), 'anchor="b" lIns="0" wrap="none"'),
        }),
      },
      layouts: [{ shapes: sp({ id: 2, ph: 'type="body" idx="1"', txBody: body(para(''), 'anchor="ctr"') }) }],
      slides: [{ shapes: sp({ id: 2, ph: 'idx="1"', txBody: body(para(run('x')), 'tIns="0"') }) }],
    });
    expect(t).toMatchObject({
      insets: { l: 0, t: 0, r: 91_440, b: 45_720 },
      anchor: 'middle',
      wrap: false,
      autofit: { kind: 'none' },
    });
  });

  it("takes a stored autofit scale from the shape's own bodyPr only, the shrink policy from the chain", () => {
    const fit = '<a:normAutofit fontScale="55000" lnSpcReduction="20000"/>';
    const layoutBody = body(para('')).replace('<a:bodyPr/>', `<a:bodyPr>${fit}</a:bodyPr>`);
    const layouts = [{ shapes: sp({ id: 2, ph: 'type="body" idx="1"', txBody: layoutBody }) }];
    // Inherited: the layout's scale was fitted to its prompt text, so the slide's text shrinks from 100 %.
    const [inherited] = bodies({
      layouts,
      slides: [{ shapes: sp({ id: 2, ph: 'idx="1"', txBody: body(para(run('A short line'))) }) }],
    });
    expect(inherited!.autofit).toEqual({ kind: 'shrink', fontScale: 1, lnSpcReduction: 0 });
    // The shape's own normAutofit keeps its stored scale.
    const own = body(para(run('Text'))).replace(
      '<a:bodyPr/>',
      '<a:bodyPr><a:normAutofit fontScale="70000" lnSpcReduction="10000"/></a:bodyPr>',
    );
    const [mine] = bodies({ layouts, slides: [{ shapes: sp({ id: 2, ph: 'idx="1"', txBody: own }) }] });
    expect(mine!.autofit).toEqual({ kind: 'shrink', fontScale: 0.7, lnSpcReduction: 0.1, own: true });
  });

  it('reads autofit, vertical text, columns and warps', () => {
    const [a, b, c] = bodies({
      slides: [
        {
          shapes:
            box(
              body(para(run('a')), 'vert="vert270" numCol="2"').replace(
                '/><a:lstStyle>',
                '><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr><a:lstStyle>',
              ),
            ) +
            box(body(para(run('b'))).replace('<a:bodyPr/>', '<a:bodyPr><a:spAutoFit/></a:bodyPr>'), {
              id: 3,
            }) +
            box(
              body(para(run('c'))).replace(
                '<a:bodyPr/>',
                '<a:bodyPr><a:prstTxWarp prst="textArchUp"/></a:bodyPr>',
              ),
              { id: 4 },
            ),
        },
      ],
    });
    expect(a).toMatchObject({
      vert: 'vert270',
      numCol: 2,
      autofit: { kind: 'shrink', fontScale: 0.625, lnSpcReduction: 0.2 },
    });
    expect(b!.autofit).toEqual({ kind: 'shape' });
    expect(c!.warp).toEqual({ preset: 'textArchUp' });
  });

  it('records anchorCtr as moving text only when a paragraph that draws something is not centred', () => {
    const ctr = 'algn="ctr"';
    const shapes = [
      // Every paragraph centred, an empty and a blank one left-aligned: centring the block changes nothing.
      body(
        para(run('Centred'), ctr) + para('') + para(run('   ')) + para(run('Also centred'), ctr),
        'anchorCtr="1"',
      ),
      // A left-aligned line moves to the middle of the box with the block.
      body(para(run('Centred'), ctr) + para(run('Left')), 'anchorCtr="1"'),
      body(para(run('Right'), 'algn="r"'), 'anchorCtr="true"'),
      body(para(run('Justified'), 'algn="just"'), 'anchorCtr="1"'),
      // Blank text shows when it is underlined or bulleted, and a field shows the value PowerPoint fills in.
      body(para(run('Centred'), ctr) + para(run('  ', 'u="sng"')), 'anchorCtr="1"'),
      body(
        para(run('Centred'), ctr) + `<a:p><a:pPr><a:buChar char="•"/></a:pPr>${run(' ')}</a:p>`,
        'anchorCtr="1"',
      ),
      body(
        para(run('Centred'), ctr) + para('<a:fld id="{1}" type="slidenum"><a:t></a:t></a:fld>'),
        'anchorCtr="1"',
      ),
      // In columns the block can be narrower than the columns, so centred text can move too.
      body(para(run('Centred'), ctr), 'anchorCtr="1" numCol="2"'),
      body(para(run('Centred'), ctr), 'anchorCtr="0"'),
      body(para(run('Left'))),
    ];
    const got = bodies({ slides: [{ shapes: shapes.map((b, i) => box(b, { id: i + 2 })).join('') }] });
    expect(got.map((t) => t.anchorCtr)).toEqual([false, ...Array(7).fill(true), undefined, undefined]);
  });

  it('reads anchorCtr through the bodyPr chain and judges it by the slide’s own paragraphs', () => {
    const layouts = [
      {
        shapes: sp({ id: 2, ph: 'type="body" idx="1"', txBody: body(para(run('Prompt')), 'anchorCtr="1"') }),
      },
    ];
    const [centred, left] = bodies({
      layouts,
      slides: [
        {
          shapes:
            sp({ id: 2, ph: 'idx="1"', txBody: body(para(run('Centred'), 'algn="ctr"')) }) +
            sp({ id: 3, ph: 'idx="1"', txBody: body(para(run('Left'))) }),
        },
      ],
    });
    expect(centred!.anchorCtr).toBe(false);
    expect(left!.anchorCtr).toBe(true);
  });
});
