import type { ShapeObject } from '@ordo/domain';
import { cellRich } from '@ordo/domain/table.ts';
import { describe, expect, it } from 'vitest';
import { frameOf } from './frame.ts';
import { convertDeck } from './index.ts';
import type { Para, RunStyle, TextBody } from './ir.ts';
import type { FaceMetrics, FaceSource } from './metrics.ts';
import { Measure } from './tables.ts';
import { buildDeck, esc, tableFrame, tc } from './test-util.ts';

/*
 * The converter's table measure breaks and sizes lines as the renderer lays out office text (text-lines,
 * sub-wave 1b): table cells are in the office line model, so their rows hold the lines the drawer draws.
 * Every character half an em wide; 18 pt is 36 px on a 16:9 slide 1920 px wide, so a character is 18 px.
 */

const HALF_EM: FaceSource = () => ({ advance: () => 0.5 });
const style: RunStyle = {
  sizePt: 18,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
  baseline: 0,
  spacingPt: 0,
  caps: 'none',
};
/** A paragraph of runs `[text, size in pt]`, its end mark at the first run's size. */
const paraOf = (...runs: [string, number][]): Para => ({
  runs: runs.map(([text, sizePt]) => ({ kind: 'text', text, style: { ...style, sizePt } })),
  align: 'left',
  level: 0,
  marL: 0,
  indent: 0,
  rtl: false,
  end: { ...style, sizePt: runs[0]?.[1] ?? 18 },
});
const body = (...paras: Para[]): TextBody => ({
  paras,
  insets: { l: 0, t: 0, r: 0, b: 0 },
  anchor: 'top',
  wrap: true,
  autofit: { kind: 'none' },
});
const measure = () => new Measure(frameOf(12_192_000, 6_858_000), HALF_EM);

describe("the converter's table measure breaks office text where LibreOffice does", () => {
  it('ends a line after a hyphen before a digit, as the drawer breaks a cell (1000 Years p1)', () => {
    // 11.5 characters wide: 'xxxxxxxx 3-' fits; UAX#14 keeps '3-4yyy' whole, so 'xxxxxxxx ' / '3-4yyy ' /
    // 'zzzzz' (three lines); LibreOffice's break after the hyphen gives 'xxxxxxxx 3-' / '4yyy zzzzz' (two).
    const b = body(paraOf(['xxxxxxxx 3-4yyy zzzzz', 18]));
    const w = 11.5 * 18;
    const m = measure();
    expect(m.height(b, w)).toBeCloseTo(2 * 1.2 * 36, 6);
    expect(m.layout(b, w).baselines).toHaveLength(2);
    expect(m.loLayout(b, w, 'font').drawn.baselines).toHaveLength(2);
    // A quotation mark, a space, an opening bracket: 'the “aa” ' / '[bb] cc' (UAX#14 keeps '“aa” [bb]').
    const q = body(paraOf(['the “aa” [bb] cc', 18]));
    expect(measure().layout(q, 9.5 * 18).baselines).toHaveLength(2);
  });

  it('breaks an address that starts its paragraph after its slashes and before its %, as the drawer does', () => {
    // LibreOffice keeps the break after a slash with no whitespace in the 64 units before it (text-falls probe
    // C): 15.5 characters hold each of 'https://' / 'archive.org/' / 'details/' / 'copticlanguage/' / 'Coptic'
    // / '%20Language/' / 'mode/2up' but never two: seven lines, where a cut by width would make five.
    const url = 'https://archive.org/details/copticlanguage/Coptic%20Language/mode/2up';
    const w = 15.5 * 18;
    expect(measure().layout(body(paraOf([url, 18])), w).baselines).toHaveLength(7);
    // After words in its paragraph every slash is within 64 units of the space and glued: 'see ', three cuts
    // by width ('https://archive' / '.org/details/co' / 'pticlanguage/Co'), 'ptic' at the break before '%',
    // then '%20Language/mod' / 'e/2up' by width: seven lines (six without the '%' break).
    expect(measure().layout(body(paraOf([`see ${url}`, 18])), w).baselines).toHaveLength(7);
  });

  it('moves a dropped slash break the line ends at to its whitespace, or cuts at the width, as the drawer', () => {
    // LibreOffice's i#17155 rule (the renderer's `slashBreak`): 'ab ' / 'cd-ef/gh ' / 'ij' (three lines, two if
    // the line ended at the hyphen) and 'see ' / 'https://aaaa' / '.bb/cccc%2/e' / 'eeeee end' (four, five if
    // the line ended before the '%').
    expect(measure().layout(body(paraOf(['ab cd-ef/gh ij', 18])), 10.5 * 18).baselines).toHaveLength(3);
    const u = body(paraOf(['see https://aaaa.bb/cccc%2/eeeeee end', 18]));
    expect(measure().layout(u, 12.5 * 18).baselines).toHaveLength(4);
  });

  it('reads a tab before a slash as the space the drawer draws it as, so its rows hold the drawn lines', () => {
    // The converter writes a tab as a space (richtext.ts `clean`: tabs are drawn as spaces), so the drawer's
    // slash rule finds whitespace there and glues the slash ('ab ' / 'xxxx/yyyyyyy' cut by width: three lines).
    // The measure reads the run's raw text, tab and all: it must break it the same way, or a cell's fixed row
    // would hold other lines than it draws (review 1b; LibreOffice keeps that slash break, but taking a tab for
    // a feature character needs the converter to keep it apart from a space first: the follow-up list).
    const tab = measure().layout(body(paraOf(['ab\txxxx/yyyyyyy', 18])), 9.5 * 18).baselines;
    const space = measure().layout(body(paraOf(['ab xxxx/yyyyyyy', 18])), 9.5 * 18).baselines;
    expect(tab).toEqual(space);
    expect(space).toHaveLength(3);
  });
});

describe("the converter's table measure sizes each line by its own runs", () => {
  it('makes a short line of a smaller citation that wraps onto it, in all three measures (Matthew 16v18)', () => {
    // 'aaaa ' at 18 pt (18 px a character), then 'bbbb cccc' at 9 pt (9 px): 140 px holds 'aaaa bbbb ', so
    // 'cccc' wraps onto a line of its own. That line is as tall as a 9 pt line, as LibreOffice draws it.
    const w = 140;
    const mixed = body(paraOf(['aaaa ', 18], ['bbbb cccc', 9]));
    const big = body(paraOf(['aaaa', 18]));
    const small = body(paraOf(['cccc', 9]));
    const m = measure();
    // Ordo's rows (the office model's single spacing): 1.2 × 36 + 1.2 × 18.
    expect(m.height(mixed, w)).toBeCloseTo(m.height(big, w) + m.height(small, w), 6);
    expect(m.height(mixed, w)).toBeCloseTo(1.2 * 36 + 1.2 * 18, 6);
    // The block the drawer draws: its second baseline is a 9 pt ascent below the first line.
    const block = m.layout(mixed, w);
    expect(block.height).toBeCloseTo(1.2 * 36 + 1.2 * 18, 6);
    expect(block.baselines[1]! - block.baselines[0]!).toBeCloseTo(1.2 * 36 - 36 + 18, 6);
    // LibreOffice's rows (1/100 mm, the face's own line heights).
    for (const mode of ['font', 'independent'] as const) {
      const lo = m.loLayout(mixed, w, mode);
      expect(lo.height).toBe(m.loLayout(big, w, mode).height + m.loLayout(small, w, mode).height);
      expect(lo.drawn.height).toBe(
        m.loLayout(big, w, mode).drawn.height + m.loLayout(small, w, mode).drawn.height,
      );
    }
  });
});

describe("the converter's table measure keeps the kerning across an office-only break", () => {
  // A face whose '-' is a quarter em and kerns with a following '4' by a quarter em (9 px at 36 px), as Inter's
  // '-2' does: the renderer places '3-' and '4…' on one line as the whole string is shaped (text-falls A).
  const KERNED: FaceSource = () => ({
    advance: (cp: number) => (cp === 0x2d ? 0.25 : 0.5),
    kern: (a: number, b: number) => (a === 0x2d && b === 0x34 ? -0.25 : 0),
  });
  const kerned = () => new Measure(frameOf(12_192_000, 6_858_000), KERNED);

  it("fits 'aa 3-4bbbb' kerned on one line, and measures the line after the break without the pair", () => {
    // 'aa 3-' is 81 px, '4bbbb' 90 px, the pair -9 px: 162 px kerned, 171 apart.
    const b = body(paraOf(['aa 3-4bbbb', 18]));
    for (const w of [165, 162.5]) {
      expect(kerned().layout(b, w).baselines).toHaveLength(1);
      expect(kerned().height(b, w)).toBeCloseTo(1.2 * 36, 6);
      expect(kerned().loLayout(b, w, 'font').drawn.baselines).toHaveLength(1);
    }
    // 85 px: 'aa 3-' / then '4bbbb' alone is 90 px (the pair is across the line end), cut once more: 3 lines.
    expect(kerned().layout(b, 85).baselines).toHaveLength(3);
  });
});

describe("LibreOffice's rows hold its 1/4 em at East Asian/other boundaries (rule G, sub-wave 1c)", () => {
  it("stores slide 20's cell in LibreOffice's 3 lines, its text and ordo's drawn lines as they were", () => {
    // The Korean bulletin's slide 20, column 3, row 2 (gaps-flip B.1 item 4): 380.9 pt of text width; the
    // second line fits without LibreOffice's gaps and does not with them, so '정리한다.' takes a third line.
    const CELL = '기승전결을 명확히 하고, 요점은 가능하다면 3가지 이내로 정리한다.';
    const metrics = (adv: Record<string, number>, ascent: number, descent: number) => {
      const m = new Map([...Object.entries(adv)].map(([c, a]) => [c.codePointAt(0)!, a]));
      return { advance: (cp: number) => m.get(cp), lineHeight: ascent + descent, ascent, descent };
    };
    const hangul = metrics(
      {
        ...Object.fromEntries([...new Set(CELL.replace(/[^가-힣]/g, ''))].map((c) => [c, 1])),
        ' ': 0.299,
      },
      0.963,
      0.297,
    );
    const inter = metrics({ ',': 0.27, '.': 0.28, '3': 0.62, ' ': 0.281 }, 0.969, 0.241);
    const faces: FaceSource = (family) => (family === 'Inter' ? inter : undefined);
    faces.script = (code) => (code === 'Hang' ? hangul : undefined);
    const IN = 914_400;
    const shapes = tableFrame({
      id: 4,
      x: IN / 4,
      y: IN / 4,
      cols: [5_019_760],
      rows: [
        {
          h: 370_840,
          cells: [
            tc(CELL, {
              rPr: 'lang="ko-KR" sz="2400"',
              rPrChildren: '<a:latin typeface="Noto Sans KR"/><a:ea typeface="Noto Sans KR"/>',
            }),
          ],
        },
      ],
    });
    const out = convertDeck(buildDeck({ slides: [{ shapes }] }), { fontFace: faces });
    const t = out.slides[0]!.slide.objects.find((o): o is ShapeObject => o.type === 'shape' && !!o.table)!
      .table!;
    // LibreOffice's row: three lines of WenQuanYi's 1.26 em at 24 pt (30.24 pt each, 60.5 px) and the margins
    // (2 x 3.6 pt), on a slide 1920 px wide: about 196 px (two lines: about 136).
    expect(t.rows[0]!).toBeGreaterThan(190);
    expect(t.rows[0]!).toBeLessThan(200);
    // The stored text is the deck's: no run of its own, no letter spacing (the base style's 0 only).
    const c = cellRich(t, 0)!;
    expect(c.text).toBe(CELL);
    expect([...JSON.stringify(t).matchAll(/"letterSpacing":([^,}]+)/g)].map((m) => m[1])).toEqual(['0']);
    expect(t.cells[0]!.runs ?? []).toHaveLength(0);
  });
});

describe("LibreOffice's rows of the probe hold-out deck's East Asian tables: rule G's gap stays in its character's run", () => {
  /*
   * integrate-1c's probe hold-out deck (slides 2, 8 and 10: Chinese, Korean and weak characters at 24 pt), with
   * LibreOffice 24.2's rows read from its PDF. The faces are this computer's, as the harness and a hub with rule H
   * measure them (the advances, kerning and hhea lines of Liberation Sans, Carlito, Inter and WenQuanYi Zen Hei for
   * these characters): the decks' East Asian families (Microsoft YaHei, Malgun Gothic, Meiryo) are nowhere, so a
   * character falls to Inter, or to the script's face when its run has East Asian letters (LibreOffice's portion
   * face). Rule G's 1/4 em belongs to the boundary character inside its own run: in a run of its own a weak
   * character ('“', ' ', '①', '「') loses its portion's face and is measured in Inter, which makes lines taller
   * than LibreOffice's (rows +0.2 px) and a cell LibreOffice sets on one line wrap (`『聖書』と“Bible”を読む`).
   */
  const faceOf = (
    groups: [string, number][],
    ascent: number,
    descent: number,
    kerning: Record<string, number>,
  ): FaceMetrics => {
    const adv = new Map<number, number>();
    for (const [chars, a] of groups) for (const c of chars) adv.set(c.codePointAt(0)!, a);
    const kern = new Map(
      Object.entries(kerning).map(([p, v]) => [[...p].map((c) => c.codePointAt(0)).join(','), v]),
    );
    return {
      advance: (cp) => adv.get(cp),
      kern: (a, b) => kern.get(`${a},${b}`) ?? 0,
      lineHeight: ascent + descent,
      ascent,
      descent,
    };
  };
  const LIBERATION = faceOf(
    [
      ['012345679undaegpohb', 0.55615234375],
      ['r()“”·', 0.3330078125],
      [' :ft.', 0.27783203125],
      ['yvcsz', 0.5],
      ['SPBA', 0.6669921875],
      ['il‘’', 0.22216796875],
      ['HRNw', 0.72216796875],
      ['OQG', 0.77783203125],
      ['m', 0.8330078125],
      ['W', 0.94384765625],
    ],
    0.9052734375,
    0.2119140625,
    { '11': -0.07421875, ff: -0.01806640625, Wo: -0.01806640625, We: -0.01806640625, '’ ': -0.037109375 },
  );
  const CARLITO = faceOf(
    [
      ['012345679', 0.5068359375],
      ['undphb', 0.525390625],
      ['①②③⑩⑪', 1.328125],
      ['il', 0.2294921875],
      ['.·', 0.25244140625],
      ['()', 0.30322265625],
      ['“”', 0.41845703125],
      ['‘’', 0.24951171875],
      [' ', 0.22607421875],
      ['S', 0.45947265625],
      ['a', 0.47900390625],
      ['y', 0.45263671875],
      ['e', 0.49755859375],
      ['r', 0.3486328125],
      ['v', 0.45166015625],
      ['c', 0.4228515625],
      [':', 0.267578125],
      ['H', 0.623046875],
      ['m', 0.798828125],
      ['R', 0.54296875],
      ['g', 0.470703125],
      ['P', 0.5166015625],
      ['O', 0.662109375],
      ['f', 0.30517578125],
      ['Q', 0.6728515625],
      ['o', 0.52734375],
      ['N', 0.6455078125],
      ['w', 0.71484375],
      ['s', 0.39111328125],
      ['B', 0.5439453125],
      ['t', 0.3349609375],
      ['W', 0.8896484375],
      ['A', 0.57861328125],
      ['z', 0.39501953125],
      ['G', 0.630859375],
    ],
    0.9521484375,
    0.2685546875,
    {
      ay: -0.0185546875,
      rv: 0.00927734375,
      Re: -0.017578125,
      ra: -0.0205078125,
      ye: -0.01220703125,
      ff: -0.009765625,
      fe: -0.02490234375,
      co: -0.00830078125,
      ew: -0.0048828125,
      Wo: -0.0419921875,
      rs: -0.01708984375,
      fa: -0.01953125,
      '“W': 0.0048828125,
      We: -0.03662109375,
      Pe: -0.02001953125,
    },
  );
  const INTER = faceOf(
    [
      ['dpb', 0.6123046875],
      [':.·', 0.2880859375],
      ['①②③', 1.3896484375],
      ['69', 0.6201171875],
      ['uh', 0.59130859375],
      ['yv', 0.56201171875],
      ['il', 0.2421875],
      ['OQ', 0.7646484375],
      ['()', 0.36474609375],
      ['“”', 0.4404296875],
      ['‘’', 0.2607421875],
      ['0', 0.630859375],
      ['1', 0.40673828125],
      ['2', 0.60986328125],
      ['3', 0.61767578125],
      ['4', 0.64599609375],
      ['5', 0.60791015625],
      ['7', 0.56591796875],
      [' ', 0.28125],
      ['S', 0.6416015625],
      ['n', 0.5908203125],
      ['a', 0.5615234375],
      ['e', 0.5830078125],
      ['r', 0.37646484375],
      ['c', 0.5712890625],
      ['H', 0.7431640625],
      ['m', 0.8759765625],
      ['R', 0.6435546875],
      ['g', 0.61328125],
      ['P', 0.638671875],
      ['f', 0.3701171875],
      ['o', 0.599609375],
      ['N', 0.75341796875],
      ['w', 0.818359375],
      ['s', 0.52783203125],
      ['B', 0.654296875],
      ['t', 0.3271484375],
      ['W', 0.9853515625],
      ['A', 0.68994140625],
      ['z', 0.55224609375],
      ['G', 0.74609375],
    ],
    0.96875,
    0.2412109375,
    {
      ay: -0.0146484375,
      rv: 0.015625,
      Hy: 0.0048828125,
      Re: -0.0146484375,
      ea: 0.009765625,
      ye: -0.01953125,
      '7:': -0.03369140625,
      ff: -0.0390625,
      fe: -0.029296875,
      ri: 0.015625,
      ew: -0.01806640625,
      Wo: -0.05078125,
      fa: -0.015625,
      ly: 0.0048828125,
      We: -0.05078125,
      'e”': -0.0244140625,
      'e’': -0.0244140625,
      y·: -0.03955078125,
      '·W': -0.05078125,
      Pe: -0.00537109375,
    },
  );
  const WQY = faceOf(
    [
      [
        '主日崇拜上午开始，请准时入座。诗歌第首《奇异恩典》读经：约翰福音章节祷告（会众同心）报本周三奉献可以使用欢迎新朋友留下联系方式祝阿们주일예배오전시본당에서드립니다찬송장「하나님지으신」성경봉독요한복음절기도같이광고수금회헌은로가능합새족환영축아멘①양②③말씀을함께『聖書』読・礼拝希望平安与你在⑩⑪',
        1,
      ],
      ['012345679', 0.599609375],
      ['undaepohb', 0.5390625],
      [' :f.()', 0.2998046875],
      ['HOQNwG', 0.6591796875],
      ['とをむの', 1.0234375],
      ['SRB', 0.619140625],
      ['il·', 0.2392578125],
      ['yz', 0.419921875],
      ['rt', 0.3193359375],
      ['mW', 0.8193359375],
      ['PA', 0.5595703125],
      ['“”', 0.33203125],
      ['‘’', 0.2216796875],
      ['v', 0.439453125],
      ['c', 0.4794921875],
      ['g', 0.5],
      ['s', 0.51953125],
    ],
    0.962890625,
    0.296875,
    {},
  );
  const faces: FaceSource = (family) =>
    family === 'Liberation Sans'
      ? LIBERATION
      : family === 'Carlito'
        ? CARLITO
        : family === 'Inter'
          ? INTER
          : undefined;
  faces.script = (code) => (['Hani', 'Hira', 'Kana', 'Hang'].includes(code) ? WQY : undefined);
  const PT = 12_700;
  const LINE = (side: string) =>
    `<a:ln${side} w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln${side}>`;
  /** A cell as the probe deck writes it (mkpptx.py): one run at 24 pt, its Latin and East Asian faces, four lines. */
  const cell = (text: string, lang: string, latin: string, ea: string | undefined, anchor = '') =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="${lang}" sz="2400" dirty="0"><a:latin typeface="${latin}"/>${
      ea ? `<a:ea typeface="${ea}"/>` : ''
    }</a:rPr><a:t>${esc(text)}</a:t></a:r><a:endParaRPr lang="ko-KR" sz="2400"/></a:p></a:txBody><a:tcPr${anchor}>${[
      'L',
      'R',
      'T',
      'B',
    ]
      .map(LINE)
      .join('')}</a:tcPr></a:tc>`;
  const rowsOf = (cols: number[], cells: string[][]) => {
    const shapes = tableFrame({
      id: 2,
      x: 20 * PT,
      y: 30 * PT,
      cols: cols.map((w) => w * PT),
      rows: cells.map((cs) => ({ h: 18 * PT, cells: cs })),
    });
    const out = convertDeck(buildDeck({ slides: [{ shapes }] }), { fontFace: faces });
    return out.slides[0]!.slide.objects.find((o): o is ShapeObject => o.type === 'shape' && !!o.table)!.table!
      .rows;
  };
  /** Slides 1-9: the column's Latin face, and the deck's East Asian face or none (the theme's), as mkholdout.py. */
  const langSlide = (lang: string, ea: string, k: number, texts: string[][]) =>
    rowsOf(
      [250, 300, 330],
      texts.map((row, r) =>
        row.map((t, c) =>
          cell(
            t,
            lang,
            ['Arial', 'Calibri', 'Arial'][c]!,
            (r + c + k) % 3 === 0 ? undefined : ea,
            ' anchor="t"',
          ),
        ),
      ),
    );
  const near = (rows: number[], lo: number[]) => {
    expect(rows).toHaveLength(lo.length);
    for (const [i, r] of rows.entries())
      expect(Math.abs(r - lo[i]!), `row ${i}: ${r} against ${lo[i]}`).toBeLessThanOrEqual(0.1);
  };

  it('slides 2 and 8 (Chinese and Korean): every row as LibreOffice draws it, within 0.1 px', () => {
    const zh = langSlide('zh-CN', 'Microsoft YaHei', 1, [
      ['主日崇拜 Sunday Service', '上午10:30开始，请准时入座。', '诗歌 Hymn 第23首《奇异恩典》'],
      ['读经 Reading：约翰福音3章16节', '祷告 Prayer（会众同心）', '报告：本周三 7:30pm 祷告会'],
      ['奉献 Offering 可以使用QR code', '欢迎新朋友 New friends 留下联系方式', '祝福 Benediction 阿们'],
    ]);
    near(zh, [135.4, 135.4, 135.4]);
    const ko = langSlide('ko-KR', 'Malgun Gothic', 7, [
      ['주일 예배 Sunday Worship', '오전 11시 본당에서 드립니다.', '찬송 Hymn 405장 「주 하나님 지으신」'],
      ['성경 봉독: 요한복음 3장 16절', '기도 Prayer (다같이)', '광고: 수요예배 7:30pm 금요기도회 9pm'],
      ['헌금 Offering은 QR code로도 가능합니다', '새가족 New family 환영합니다', '축도 Benediction 아멘'],
    ]);
    near(ko, [135.4, 135.4, 135.4]);
  });

  it('slide 10 (weak characters): `『聖書』と“Bible”を読む` on one line, leading ① and 「 in the East Asian face', () => {
    const weak = (rows: [string, string][][]) =>
      rows.map((row) =>
        row.map(([t, lg]) =>
          cell(
            t,
            { ko: 'ko-KR', ja: 'ja-JP', zh: 'zh-CN' }[lg]!,
            'Arial',
            { ko: 'Malgun Gothic', ja: 'Meiryo', zh: 'Microsoft YaHei' }[lg],
          ),
        ),
      );
    const rows = rowsOf(
      [290, 300, 300],
      weak([
        [
          ['①찬양 ②기도 ③말씀', 'ko'],
          ['「Amazing Grace」을 함께', 'ko'],
          ['“Welcome” 환영합니다', 'ko'],
        ],
        [
          ['『聖書』と“Bible”を読む', 'ja'],
          ['10:30・礼拝・11:45', 'ja'],
          ['‘Hope’ 希望の歌', 'ja'],
        ],
        [
          ['主日·周三 Sunday·Wed', 'zh'],
          ['「平安」Peace 与你同在', 'zh'],
          ['⑩ 奉献 ⑪ 祝福', 'zh'],
        ],
      ]),
    );
    // LibreOffice: 67.7 / 37.5 / 37.5 pt. Row 1's first cell is one line of 274.24 pt in its 275.6 pt.
    near(rows, [135.4, 75.0, 75.0]);
  });
});
