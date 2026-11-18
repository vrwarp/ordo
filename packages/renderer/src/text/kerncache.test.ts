import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type TextObject, type TextStyle } from '@ordo/domain';
import { LEGACY_FONT_ENV } from './fonts.ts';
import { itemize } from './itemize.ts';
import { layoutBox } from './lines.ts';
import { clampTextObject } from './rich.ts';
import { prepare } from './segments.ts';
import type { BulletSpec, Measurer, RichLayout } from './types.ts';

/*
 * Kerning across an office break (lines.ts `kernAfter`) is measured once per piece, not at every step of the
 * shrink-to-fit search: the value at the search's reference scale is the same at every step. Two checks: how
 * many widths a layout asks for does not grow with the steps the search takes, and the layout (lines, widths,
 * segment positions, scales) is what it was before the value was kept, as literal numbers recorded from the
 * code before the change (a test that only compared the layout with itself would prove nothing).
 */

// The widths a layout asks for are counted where its own memo is made (`layoutBox` wraps its measurer in
// `memoMeasurer`: the measurer under it sees each string once, so a count there could never grow), and the
// steps of the search where it asks for a height at a linear scale.
const counts = vi.hoisted(() => ({ requests: [] as string[], steps: 0 }));
vi.mock('./measure.ts', async (orig) => {
  const real = await orig<typeof import('./measure.ts')>();
  return {
    ...real,
    memoMeasurer: (m: Measurer): Measurer => {
      const inner = real.memoMeasurer(m);
      return {
        width(font, dir, lang, spacingPx, text) {
          counts.requests.push(text);
          return inner.width(font, dir, lang, spacingPx, text);
        },
      };
    },
  };
});
vi.mock('./office.ts', async (orig) => {
  const real = await orig<typeof import('./office.ts')>();
  return {
    ...real,
    autofit: (...a: Parameters<typeof real.autofit>) => {
      const [style, innerH, exact, linear, ...rest] = a;
      return real.autofit(
        style,
        innerH,
        exact,
        (f, ref) => {
          counts.steps++;
          return linear(f, ref);
        },
        ...rest,
      );
    },
  };
});

/**
 * Advances of 0.5 em, 0.6 em for digits, and the pair kerning a face has: a hyphen before a digit (-0.06 em),
 * 'J' before 'u' and a comma before a space (-0.03 em). A string is its advances plus the kerning between its
 * neighbours and the letter spacing between its characters, as Canvas measures it.
 */
const KERN: Record<string, number> = { '-': -0.06 };
function kernedMeasurer(): Measurer {
  return {
    width(font, _dir, _lang, spacingPx, text) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
      const chars = [...text];
      let w = 0;
      chars.forEach((ch, i) => {
        w += (/\d/.test(ch) ? 0.6 : 0.5) * size;
        const next = chars[i + 1];
        if (next !== undefined && /\d/.test(next) && KERN[ch] !== undefined) w += KERN[ch]! * size;
        if (ch === 'J' && next === 'u') w -= 0.03 * size;
        if (ch === ',' && next === ' ') w -= 0.03 * size;
      });
      return chars.length ? w + spacingPx * (chars.length - 1) : 0;
    },
  };
}

function obj(text: string, w: number, h: number, style: Partial<TextStyle> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w, h, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      padding: 0,
      fontSizePx: 100,
      lineHeight: 1.2,
      lang: 'es',
      lineModel: 'office',
      autofit: 'shrink',
      align: 'left',
      valign: 'top',
      ...style,
    },
    opacity: 1,
  });
}

const bullet: BulletSpec = {
  text: '•',
  family: 'Inter',
  fallbacks: [],
  weight: 400,
  italic: false,
  sizePct: 1,
  color: { r: 255, g: 255, b: 255, a: 1 },
  lang: '',
  run: -1,
};

type Opts = { rtl?: boolean; bullets?: (BulletSpec | null)[] };
function layout(o: TextObject, opts: Opts = {}): RichLayout {
  const prepared = prepare(itemize(o));
  if (opts.rtl)
    for (const pp of prepared) {
      pp.bidi = { level: 1, levels: null };
      for (const p of pp.pieces) p.level = 1;
    }
  return layoutBox(kernedMeasurer(), o, prepared, opts.bullets ?? [], LEGACY_FONT_ENV);
}

const VERSES =
  'Hebreos 9:23-28, Juan 3:16-17, Romanos 8:1-4, Salmo 23:1-6, Isaias 40:28-31, Mateo 5:3-12, Lucas 15:11-32, ' +
  'Hechos 2:38-47, Genesis 1:1-5, Exodo 20:1-17, Proverbios 3:5-6, Filipenses 4:6-9, Juan 14:1-6, Salmo 91:1-16';

/** What a layout is, rounded to micro-pixels: the scales, and each line's text, box and segment positions. */
function signature(o: TextObject, l: RichLayout) {
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    font: r(l.fontScale),
    spacing: r(l.spacingScale),
    lines: l.lines.map((line) => ({
      text: line.segs.map((s) => o.text.slice(s.start, s.end)).join('|'),
      x: r(line.x),
      w: r(line.w),
      baseline: r(line.baseline),
      segs: line.segs.map((s) => r(s.x)),
    })),
  };
}

const CASES: { name: string; o: TextObject; opts?: Opts }[] = [
  { name: 'a verse list that shrinks', o: obj(VERSES, 1000, 330) },
  { name: 'kerning across a break at a line end', o: obj('Hebreos 9:23-28', 520, 260, { align: 'center' }) },
  { name: 'a bullet paragraph', o: obj(VERSES, 900, 330), opts: { bullets: [bullet] } },
  { name: 'a right-to-left paragraph', o: obj(VERSES, 1000, 330), opts: { rtl: true } },
  { name: 'a long unbroken word', o: obj(`${'Anticonstitucionalmente'.repeat(8)} 9:23-28`, 700, 300) },
];

// Recorded from the code before the value was kept (the same fixtures, laid out at the base commit).
const EXPECTED: Record<string, ReturnType<typeof signature>> = {
  'a verse list that shrinks': {
    font: 0.466667,
    spacing: 1,
    lines: [
      {
        text: 'Hebreos |9:23-|28, |Juan |3:16-|17, |Romanos ',
        x: 0,
        w: 910.34,
        baseline: 46,
        segs: [0, 184, 310.04, 409.86, 523.48, 649.52, 749.34],
      },
      {
        text: '8:1-|4, |Salmo |23:1-|6, |Isaias |40:28-|31, ',
        x: 0,
        w: 899.76,
        baseline: 101.2,
        segs: [0, 98.44, 170.66, 308.66, 434.7, 506.92, 667.92, 821.56],
      },
      {
        text: 'Mateo |5:3-|12, |Lucas |15:11-|32, |Hechos ',
        x: 0,
        w: 865.72,
        baseline: 156.4,
        segs: [0, 138, 236.44, 336.26, 474.26, 627.9, 727.72],
      },
      {
        text: '2:38-|47, |Genesis |1:1-|5, |Exodo |20:1-|17, ',
        x: 0,
        w: 922.76,
        baseline: 211.6,
        segs: [0, 126.04, 225.86, 409.86, 508.3, 580.52, 718.52, 844.56],
      },
      {
        text: 'Proverbios |3:5-|6, |Filipenses |4:6-|9, |Juan ',
        x: 0,
        w: 937.94,
        baseline: 266.8,
        segs: [0, 253, 351.44, 423.66, 676.66, 775.1, 847.32],
      },
      {
        text: '14:1-|6, |Salmo |91:1-|16',
        x: 0,
        w: 517.5,
        baseline: 322,
        segs: [0, 126.04, 198.26, 336.26, 462.3],
      },
    ],
  },
  'kerning across a break at a line end': {
    font: 1,
    spacing: 1,
    lines: [
      { text: 'Hebreos ', x: 85, w: 350, baseline: 100, segs: [85] },
      { text: '9:23-|28', x: 63, w: 394, baseline: 220, segs: [63, 337] },
    ],
  },
  'a bullet paragraph': {
    font: 0.433333,
    spacing: 1,
    lines: [
      {
        text: 'Hebreos |9:23-|28, |Juan |3:16-|17, |Romanos ',
        x: 22,
        w: 870.76,
        baseline: 44,
        segs: [22, 198, 318.56, 414.04, 522.72, 643.28, 738.76],
      },
      {
        text: '8:1-|4, |Salmo |23:1-|6, |Isaias |40:28-|31, ',
        x: 0,
        w: 860.64,
        baseline: 96.8,
        segs: [0, 94.16, 163.24, 295.24, 415.8, 484.88, 638.88, 785.84],
      },
      {
        text: 'Mateo |5:3-|12, |Lucas |15:11-|32, |Hechos ',
        x: 0,
        w: 828.08,
        baseline: 149.6,
        segs: [0, 132, 226.16, 321.64, 453.64, 600.6, 696.08],
      },
      {
        text: '2:38-|47, |Genesis |1:1-|5, |Exodo |20:1-|17, ',
        x: 0,
        w: 882.64,
        baseline: 202.4,
        segs: [0, 120.56, 216.04, 392.04, 486.2, 555.28, 687.28, 807.84],
      },
      {
        text: 'Proverbios |3:5-|6, |Filipenses |4:6-|9, |Juan ',
        x: 0,
        w: 897.16,
        baseline: 255.2,
        segs: [0, 242, 336.16, 405.24, 647.24, 741.4, 810.48],
      },
      {
        text: '14:1-|6, |Salmo |91:1-|16',
        x: 0,
        w: 495,
        baseline: 308,
        segs: [0, 120.56, 189.64, 321.64, 442.2],
      },
    ],
  },
  'a right-to-left paragraph': {
    font: 0.466667,
    spacing: 1,
    lines: [
      {
        text: 'Romanos |17, |3:16-|Juan |28, |9:23-|Hebreos ',
        x: 0,
        w: 915.86,
        baseline: 46,
        segs: [-23, 161, 260.82, 389.62, 503.24, 603.06, 731.86],
      },
      {
        text: '31, |40:28-|Isaias |6, |23:1-|Salmo |4, |8:1-',
        x: 0,
        w: 908.04,
        baseline: 101.2,
        segs: [-21.62, 78.2, 234.6, 395.6, 467.82, 596.62, 734.62, 806.84],
      },
      {
        text: 'Hechos |32, |15:11-|Lucas |12, |5:3-|Mateo ',
        x: 0,
        w: 871.24,
        baseline: 156.4,
        segs: [-23, 138, 237.82, 394.22, 532.22, 632.04, 733.24],
      },
      {
        text: '17, |20:1-|Exodo |5, |1:1-|Genesis |47, |2:38-',
        x: 0,
        w: 931.04,
        baseline: 211.6,
        segs: [-21.62, 78.2, 207, 345, 417.22, 518.42, 702.42, 802.24],
      },
      {
        text: 'Juan |9, |4:6-|Filipenses |6, |3:5-|Proverbios ',
        x: 0,
        w: 943.46,
        baseline: 266.8,
        segs: [-23, 90.62, 162.84, 264.04, 517.04, 589.26, 690.46],
      },
      {
        text: '16|91:1-|Salmo |6, |14:1-',
        x: 0,
        w: 523.02,
        baseline: 322,
        segs: [0, 55.2, 184, 322, 394.22],
      },
    ],
  },
  'a long unbroken word': {
    font: 0.416667,
    spacing: 1,
    lines: [
      { text: 'AnticonstitucionalmenteAnticonsti', x: 0, w: 693, baseline: 42, segs: [0] },
      { text: 'tucionalmenteAnticonstitucionalme', x: 0, w: 693, baseline: 92.4, segs: [0] },
      { text: 'nteAnticonstitucionalmenteAnticon', x: 0, w: 693, baseline: 142.8, segs: [0] },
      { text: 'stitucionalmenteAnticonstituciona', x: 0, w: 693, baseline: 193.2, segs: [0] },
      { text: 'lmenteAnticonstitucionalmenteAnti', x: 0, w: 693, baseline: 243.6, segs: [0] },
      { text: 'constitucionalmente |9:23-|28', x: 0, w: 585.48, baseline: 294, segs: [0, 420, 535.08] },
    ],
  },
};

describe('the kerning across an office break is measured once per piece', () => {
  const run = (h: number) => {
    counts.requests.length = 0;
    counts.steps = 0;
    layout(obj(VERSES, 1000, h));
    // A verse range's joined string ('9:23-28') is asked for only to find the kerning across its break.
    return {
      steps: counts.steps,
      joined: counts.requests.filter((t) => /\d-\d/.test(t)).length,
      all: counts.requests.length,
    };
  };

  it('asks for the same number of widths however many steps the search takes', () => {
    // Box heights whose searches take different numbers of steps (6, 8 and 7).
    const runs = [700, 800, 1200].map(run);
    const steps = runs.map((r) => r.steps);
    expect(Math.min(...steps), 'every box is fitted by the search').toBeGreaterThan(0);
    expect(Math.max(...steps), 'the searches differ in their steps').toBeGreaterThan(Math.min(...steps));
    for (const r of runs) {
      expect(r.joined).toBe(runs[0]!.joined);
      expect(r.all).toBe(runs[0]!.all);
    }
  });
});

describe('the layout does not change', () => {
  for (const c of CASES)
    it(c.name, () => {
      expect(signature(c.o, layout(c.o, c.opts))).toEqual(EXPECTED[c.name]);
    });
});
