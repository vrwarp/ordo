import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type TextObject, type TextPara, type TextStyle } from '@ordo/domain';
import { LEGACY_FONT_ENV } from './fonts.ts';
import {
  FIT_SLACK_PX,
  type FitScale,
  autofit,
  fitFactor,
  officeFontPx,
  officeLine,
  searchFit,
} from './office.ts';
import { clampTextObject, layoutRich } from './rich.ts';
import { testMeasurer } from './test-util.ts';
import type { Measurer, ParaStyle, RichLayout } from './types.ts';

/*
 * The office line model and autofit against what the pptx-render commits measured in LibreOffice 24.2
 * (docs/design/20-importers.md "Paragraphs and text boxes", "Shrink on overflow"), and the autofit search
 * against a literal transcription of page.ts `fitBox`.
 */

const para = (p: Partial<ParaStyle> = {}): ParaStyle => ({
  align: 'left',
  level: 0,
  indentPx: 0,
  firstLinePx: 0,
  spaceBeforePx: 0,
  spaceAfterPx: 0,
  lineSpacing: null,
  lineSpacingPx: null,
  bullet: undefined,
  dir: 'auto',
  hidden: false,
  ...p,
});

/** An office-model text object at the origin: 20 px text, every character 10 px wide (`m`). */
function office(
  text: string,
  style: Partial<TextStyle> = {},
  extra: Partial<TextObject> = {},
  box = { w: 200, h: 400 },
): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, ...box, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      padding: 0,
      fontSizePx: 20,
      lineHeight: 1.2,
      align: 'left',
      valign: 'top',
      lineModel: 'office',
      ...style,
    },
    opacity: 1,
    ...extra,
  });
}

const m = () => testMeasurer({ em: 0.5 });
const lay = (o: TextObject, mm: Measurer = m()) => layoutRich(mm, o, LEGACY_FONT_ENV);
/** Height of the laid-out text: from the first line's top to the last line's bottom. */
const textHeight = (l: RichLayout) => l.ink.h;

describe('officeLine: the measured line model', () => {
  it('makes single spacing 1.2 × F with the baseline F below the top, whatever the scale', () => {
    expect(officeLine(40, para(), 1)).toEqual({ height: 48, ascent: 40 });
    // An unset and an explicit 100 % are drawn alike, and the spacing scale leaves both alone (d636c1f).
    expect(officeLine(40, para({ lineSpacing: 1 }), 0.8)).toEqual({ height: 48, ascent: 40 });
    expect(officeLine(40, para(), 0.8)).toEqual({ height: 48, ascent: 40 });
    expect(officeLine(40, para({ lineSpacing: 0 }), 1)).toEqual({ height: 48, ascent: 40 });
  });

  it('puts extra spacing above the line and caps the ascent at 80 % below 100 %', () => {
    expect(officeLine(40, para({ lineSpacing: 1.5 }), 1)).toEqual({ height: 72, ascent: 64 });
    const tight = officeLine(40, para({ lineSpacing: 0.8 }), 1);
    expect(tight.height).toBeCloseTo(38.4, 9);
    expect(tight.ascent).toBeCloseTo(0.8 * 38.4, 9);
    // 95 %: 0.8 × 45.6 = 36.48 < 40, still capped.
    expect(officeLine(40, para({ lineSpacing: 0.95 }), 1).ascent).toBeCloseTo(36.48, 9);
  });

  it('scales proportional and exact spacing by the spacing scale', () => {
    const p = officeLine(40, para({ lineSpacing: 1.5 }), 0.8);
    expect(p.height).toBeCloseTo(57.6, 9);
    expect(p.ascent).toBeCloseTo(40 + (57.6 - 48), 9);
    expect(officeLine(40, para({ lineSpacingPx: 60 }), 0.9)).toEqual({ height: 54, ascent: 40 + 54 - 48 });
    // Exact spacing below single removes space above the line.
    expect(officeLine(40, para({ lineSpacingPx: 40 }), 1)).toEqual({ height: 40, ascent: 32 });
  });

  it("takes the box's lineHeight (a multiple of F) when the paragraph sets no spacing", () => {
    expect(officeLine(40, para(), 1, 1.8)).toEqual({ height: 72, ascent: 64 });
    expect(officeLine(40, para({ lineSpacing: 1 }), 1, 1.8)).toEqual({ height: 48, ascent: 40 });
  });
});

describe('officeFontPx: run sizes as editeng rounds them', () => {
  it('rounds to whole points before and after scaling, at least 1 pt, and leaves full size alone', () => {
    expect(officeFontPx(72, 0.925)).toBe(66); // 36 pt × 92.5 % = 33.3 → 33 pt
    expect(officeFontPx(75, 1)).toBe(75);
    expect(officeFontPx(75, 0.5)).toBe(38); // 37.5 → 38 pt, × 0.5 = 19 pt
    expect(officeFontPx(4, 0.01)).toBe(2); // max(1 pt, …)
  });
});

/**
 * page.ts `fitBox` after its layout calls, transcribed literally: `contentAt(fontScale, spacingScale)` is
 * the laid-out height (page.ts measures it in the DOM), `avail` the box's inner height.
 */
function pageFitBox(contentAt: (font: number, spacing: number) => number, avail: number): FitScale {
  const slack = FIT_SLACK_PX;
  const fit = (fontPct: number, spacingPct: number) => {
    const content = contentAt(fontPct / 100, spacingPct / 100);
    return content - slack > 0 ? avail / (content - slack) : Number.POSITIVE_INFINITY;
  };
  const first = fit(100, 100);
  if (first >= 1) return { font: 1, spacing: 1 };
  let lo = 0;
  let hi = 100;
  let best = { font: 0, spacing: 100, factor: first };
  const OBJECT_PT = 18;
  for (let i = 0; i < 10; i++) {
    const mid = lo + (hi - lo) * 0.5;
    const font = (Math.floor(OBJECT_PT * (mid / 100) * 10) / 10 / OBJECT_PT) * 100;
    let factor = 0;
    for (const spacing of [100, 90, 80]) {
      if (factor >= 1) continue;
      factor = fit(font, spacing);
      if (spacing === 100) {
        if (factor > 1) lo = font;
        else hi = font;
      }
      if ((best.factor < 1 && factor > best.factor) || (factor >= 1 && factor < best.factor))
        best = { font, spacing, factor };
    }
  }
  return { font: best.font / 100, spacing: best.spacing / 100 };
}

const SHRINK: TextStyle = { ...DEFAULT_LYRIC_STYLE, autofit: 'shrink' };

describe("searchFit: LibreOffice's autofit search", () => {
  it('chooses what page.ts fitBox chooses, for any monotone text height', () => {
    // A wrapping text: lines ∝ font scale (stepwise), each line 1.2 × F × p × k plus paragraph spacing × k.
    const model = fc.record({
      chars: fc.integer({ min: 1, max: 4000 }),
      width: fc.integer({ min: 50, max: 2000 }),
      sizePx: fc.integer({ min: 8, max: 200 }),
      p: fc.constantFrom(1, 0.8, 0.9, 1.5, 2),
      paras: fc.integer({ min: 1, max: 12 }),
      spacePx: fc.integer({ min: 0, max: 60 }),
      avail: fc.integer({ min: 20, max: 1080 }),
    });
    fc.assert(
      fc.property(model, (x) => {
        const contentAt = (font: number, spacing: number) => {
          const F = Math.max(4, Math.round(x.sizePx * font));
          const lines = x.paras + Math.ceil((x.chars * F * 0.5) / x.width);
          const pitch = x.p === 1 ? 1.2 * F : 1.2 * F * x.p * spacing;
          return lines * pitch + (x.paras - 1) * x.spacePx * spacing;
        };
        const want = pageFitBox(contentAt, x.avail);
        const got = autofit(
          SHRINK,
          x.avail,
          (f) => contentAt(f.font, f.spacing),
          (f) => contentAt(f.font, f.spacing),
        );
        expect(got).toEqual({ font: Math.max(0.01, want.font), spacing: want.spacing });
      }),
      { numRuns: 300 },
    );
  });

  it('quantises the font scale to tenths of 18 pt and tries 90 and 80 % spacing when 100 % overflows', () => {
    const tried: [number, number][] = [];
    searchFit((font, spacing) => {
      tried.push([font, spacing]);
      return spacing === 80 ? 1.01 : 0.5;
    }, 0.3);
    expect(tried.slice(0, 3)).toEqual([
      [50, 100],
      [50, 90],
      [50, 80],
    ]);
    // 25 % of 18 pt is 4.5 pt; 12.5 % is 2.25 pt, rounded down to 2.2 pt: 12.222… %.
    expect(tried[3]![0]).toBe(25);
    expect(tried[6]![0]).toBeCloseTo((2.2 / 18) * 100, 9);
  });

  it('measures fit with 0.5 mm of slack', () => {
    expect(FIT_SLACK_PX).toBeCloseTo(2.8346, 4);
    expect(fitFactor(100 + FIT_SLACK_PX, 100)).toBeCloseTo(1, 12);
    expect(fitFactor(101 + FIT_SLACK_PX, 100)).toBeLessThan(1);
    expect(fitFactor(1, 100)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('office layout', () => {
  it('does not draw space before the first paragraph or after the last, and scales it by k', () => {
    const paras: TextPara[] = [
      { spaceBeforePx: 30, spaceAfterPx: 10 },
      { spaceBeforePx: 20, spaceAfterPx: 50 },
    ];
    const l = lay(office('a\nb', {}, { paras }));
    expect(l.lines.map((x) => x.top)).toEqual([0, 24 + 10 + 20]);
    expect(textHeight(l)).toBe(24 + 30 + 24);
    // A stored spacing scale that still fits applies to paragraph spacing; single spacing keeps 1.2F.
    const k = lay(office('a\nb', { autofit: 'shrink', fitScale: { font: 1, spacing: 0.5 } }, { paras }));
    expect(k.spacingScale).toBe(0.5);
    expect(k.lines.map((x) => x.top)).toEqual([0, 24 + 15]);
    expect(k.lines[1]!.height).toBe(24);
  });

  it('makes an empty paragraph as tall as its end mark, and a trailing a:br a line', () => {
    const l = lay(office('a\n\nb', {}, { runs: [{ start: 2, end: 3, sizeScale: 2 }] }));
    expect(l.lines.map((x) => x.height)).toEqual([24, 48, 24]);
    expect(l.lines[1]!.baseline - l.lines[1]!.top).toBe(40);
    const br = lay(office('Line\n', {}, { paras: [null, { soft: true }] }));
    expect(br.lines).toHaveLength(2);
    expect(br.lines[1]).toMatchObject({ top: 24, height: 24, segs: [] });
  });

  it('draws raised text at 58 % of its size, moved 30 %, without growing the line', () => {
    const o = office('17 For God', {}, { runs: [{ start: 0, end: 2, baseline: 0.3 }] });
    const line = lay(o).lines[0]!;
    expect(line.height).toBe(24);
    expect(line.baseline).toBe(20);
    expect(line.segs[0]).toMatchObject({ sizePx: 20 * 0.58 });
    expect(line.segs[0]!.shift).toBeCloseTo(-6, 9);
  });

  it('applies proportional spacing per paragraph and the box lineHeight to paragraphs without one', () => {
    const o = office('a\nb\nc', { lineHeight: 0.9 * 1.2 }, { paras: [null, { lineSpacing: 1.5 }, null] });
    const l = lay(o);
    expect(l.lines[0]!.height).toBeCloseTo(21.6, 9);
    expect(l.lines[0]!.baseline - l.lines[0]!.top).toBeCloseTo(0.8 * 21.6, 9);
    expect(l.lines[1]!.height).toBeCloseTo(36, 9);
    expect(l.lines[1]!.baseline - l.lines[1]!.top).toBeCloseTo(20 + 12, 9);
  });
});

describe('autofit', () => {
  const lorem =
    'For God so loved the world that he gave his one and only Son that whoever believes in him shall not perish but have eternal life';

  it('chooses the sizes page.ts fitBox chooses on laid-out text (re-fit from full size)', () => {
    const cases: [string, Partial<TextStyle>, (TextPara | null)[], { w: number; h: number }][] = [
      [lorem, { fontSizePx: 40 }, [], { w: 400, h: 200 }],
      [
        `${lorem}\n${lorem}`,
        { fontSizePx: 36 },
        [null, { lineSpacing: 0.9, spaceBeforePx: 18 }],
        { w: 600, h: 300 },
      ],
      [lorem, { fontSizePx: 72 }, [{ lineSpacing: 1.5 }], { w: 900, h: 260 }],
      [`${lorem}\n\n${lorem}`, { fontSizePx: 54 }, [{ lineSpacingPx: 70 }], { w: 1000, h: 500 }],
      ['short\ntext\nlines\nhere\nand\nmore', { fontSizePx: 60 }, [], { w: 400, h: 330 }],
    ];
    for (const [text, style, paras, box] of cases) {
      const o = office(text, { autofit: 'shrink', ...style }, { paras }, box);
      const l = lay(o);
      // The text laid out at a given scale: a stored fitScale in a box tall enough to hold it.
      const at = (font: number, spacing: number) =>
        textHeight(
          lay(
            office(
              text,
              { ...style, autofit: 'shrink', fitScale: { font, spacing } },
              { paras },
              { w: box.w, h: 4000 },
            ),
          ),
        );
      const want = pageFitBox(at, box.h);
      expect({ font: l.fontScale, spacing: l.spacingScale }).toEqual(want);
      expect(want.font).toBeLessThan(1);
      expect(l.overflow).toBe(false);
    }
  });

  it('keeps the stored scale while the text fits at it, even where it would fit larger', () => {
    const style = { autofit: 'shrink' as const, fitScale: { font: 0.6, spacing: 1 }, fontSizePx: 40 };
    const short = lay(office('A short line', style, {}, { w: 600, h: 300 }));
    expect(short.fontScale).toBe(0.6);
    expect(short.lines[0]!.segs[0]!.sizePx).toBe(24);
    // An edit that still fits keeps the scale.
    const edited = lay(office('A short line, edited', style, {}, { w: 600, h: 300 }));
    expect(edited.fontScale).toBe(0.6);
    // One that no longer fits shrinks further, never back up.
    const long = lay(office(lorem.repeat(6), style, {}, { w: 600, h: 300 }));
    expect(long.fontScale).toBeLessThan(0.6);
    expect(long.overflow).toBe(false);
  });

  it('never returns a font scale larger than the stored one', () => {
    // Double spacing: at 80 % spacing LibreOffice's search finds that a larger font than the stored one fits.
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh';
    const paras = [{ lineSpacing: 2 }];
    const box = { w: 100, h: 40 };
    const fitScale = { font: 0.45, spacing: 1 };
    const at = (font: number, spacing: number) =>
      textHeight(
        lay(
          office(text, { autofit: 'shrink', fitScale: { font, spacing } }, { paras }, { w: box.w, h: 4000 }),
        ),
      );
    expect(fitFactor(at(0.45, 1), box.h)).toBeLessThan(1); // overflows at the stored scale
    expect(pageFitBox(at, box.h)).toEqual({ font: 0.5, spacing: 0.8 }); // what LibreOffice would choose
    const l = lay(office(text, { autofit: 'shrink', fitScale }, { paras }, box));
    expect([l.fontScale, l.spacingScale, l.overflow]).toEqual([0.45, 0.8, false]);
  });

  it('measures the search linearly from the stored scale: only the final size is measured again', () => {
    const base = testMeasurer({ em: 0.5 });
    const sizes = new Set<string>();
    const rec: Measurer = {
      width(font, dir, lang, spacing, text) {
        sizes.add(/(\d+(?:\.\d+)?)px/.exec(font)![1]!);
        return base.width(font, dir, lang, spacing, text);
      },
    };
    const o = office(lorem.repeat(2), { autofit: 'shrink', fontSizePx: 40 }, {}, { w: 500, h: 200 });
    const l = lay(o, rec);
    expect(l.fontScale).toBeLessThan(1);
    expect([...sizes].map(Number).sort((a, b) => a - b)).toEqual([officeFontPx(40, l.fontScale), 40]);
  });

  it('scales nothing without shrink', () => {
    const o = office(lorem, { fitScale: { font: 0.5, spacing: 0.5 } }, {}, { w: 300, h: 50 });
    const l = lay(o);
    expect([l.fontScale, l.spacingScale, l.overflow]).toEqual([1, 1, true]);
  });
});
