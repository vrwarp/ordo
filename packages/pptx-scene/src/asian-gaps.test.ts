import { describe, expect, it } from 'vitest';
import { ASIAN_GAP_EM, asianGapsAt, loAsianGaps } from './asian-gaps.ts';
import { frameOf } from './frame.ts';
import type { Para, RunStyle, TextBody } from './ir.ts';
import type { FaceMetrics, FaceSource } from './metrics.ts';
import { Measure } from './tables.ts';

/*
 * Rule G (sub-wave 1c): LibreOffice's 1/4 em between East Asian and other text, in the converter's model of
 * LibreOffice's cell layout only (`asian-gaps.ts`). The rule is the quarter exactly; LibreOffice's measured spread
 * (5.63-6.06 pt at 24 pt) is the probe's (ko-cells step 5), not these tests'.
 */

const style: RunStyle = {
  sizePt: 24,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
  baseline: 0,
  spacingPt: 0,
  caps: 'none',
};
/** A paragraph of runs `[text, size in pt]` (a run '\n' is a line break). */
const paraOf = (...runs: [string, number][]): Para => ({
  runs: runs.map(([text, sizePt]) => ({
    kind: text === '\n' ? 'break' : 'text',
    text,
    style: { ...style, sizePt, latin: 'Noto Sans KR', ea: 'Noto Sans KR', lang: 'ko-KR' },
  })),
  align: 'left',
  level: 0,
  marL: 0,
  indent: 0,
  rtl: false,
  end: { ...style, sizePt: runs[0]?.[1] ?? 24 },
});
/** Each run with extra spacing: [its text, the spacing in pt]. */
const gaps = (p: Para) => p.runs.filter((r) => r.style.spacingPt > 0).map((r) => [r.text, r.style.spacingPt]);
const gapsOf = (text: string, pt = 24) => gaps(loAsianGaps(paraOf([text, pt])));

describe("LibreOffice's 1/4 em at East Asian/other boundaries (rule G)", () => {
  it('puts exactly a quarter of the size on the character before each boundary, both directions', () => {
    expect(ASIAN_GAP_EM).toBe(0.25);
    expect(gapsOf('가a가')).toEqual([
      ['가', 6],
      ['a', 6],
    ]);
    expect(gapsOf('가3가')).toEqual([
      ['가', 6],
      ['3', 6],
    ]);
    expect(gapsOf('漢a漢')).toEqual([
      ['漢', 6],
      ['a', 6],
    ]);
    expect(gapsOf('かaか')).toEqual([
      ['か', 6],
      ['a', 6],
    ]);
    expect(gapsOf('AB가CD')).toEqual([
      ['B', 6],
      ['가', 6],
    ]);
    // The space after Hangul is East Asian: one gap, on it, before 'a'.
    expect(gapsOf('가 a')).toEqual([[' ', 6]]);
  });

  it('puts none inside a portion: weak characters join the portion before them', () => {
    expect(gapsOf('가⑥가')).toEqual([]);
    expect(gapsOf('가・가')).toEqual([]);
    expect(gapsOf('가“나”')).toEqual([]);
    expect(gapsOf('가나다')).toEqual([]);
    expect(gapsOf('Amazing grace')).toEqual([]);
  });

  it('puts one after each leading weak character or run of spaces before Hangul (the lead probe)', () => {
    for (const lead of ['“', '‘', '※', '•', '–', '…', '★', '→', '⑥', '①', ' ', ' '])
      expect(gapsOf(`${lead}가나다`)).toEqual([[lead, 6]]);
    // Two spaces are one leading portion: one gap, on the second.
    expect(asianGapsAt('  가나다')).toEqual([1]);
    expect(gapsOf('  가나다')).toEqual([[' ', 6]]);
    // A leading weak character before Latin is no boundary.
    expect(gapsOf('“abc”')).toEqual([]);
  });

  it('scales with the size of the character before the boundary, and never crosses a line break', () => {
    expect(gapsOf('가a가', 12)).toEqual([
      ['가', 3],
      ['a', 3],
    ]);
    expect(gapsOf('가a가', 36)).toEqual([
      ['가', 9],
      ['a', 9],
    ]);
    // Runs of two sizes: each gap a quarter of its own character's size.
    expect(gaps(loAsianGaps(paraOf(['가', 24], ['a', 48], ['가', 12])))).toEqual([
      ['가', 6],
      ['a', 12],
    ]);
    expect(gaps(loAsianGaps(paraOf(['가', 24], ['\n', 24], ['a', 24])))).toEqual([]);
    // A surrogate pair before a boundary keeps both units in its run.
    expect(gapsOf('𠀀a')).toEqual([['𠀀', 6]]);
  });

  it('never changes the paragraph it is given: the stored text keeps its runs and spacing', () => {
    const p = paraOf(['기승전결을 명확히 하고, 요점은 가능하다면 3가지 이내로 정리한다.', 24]);
    const before = structuredClone(p);
    const g = loAsianGaps(p);
    expect(p).toEqual(before);
    expect(g).not.toBe(p);
    expect(g.runs.map((r) => r.text).join('')).toBe(p.runs[0]!.text);
    const plain = paraOf(['가나다 라마', 24]);
    expect(loAsianGaps(plain)).toBe(plain);
  });
});

/** A face with these advances (em) and a line of `ascent` + `descent`. */
const face = (adv: Record<string, number>, ascent: number, descent: number): FaceMetrics => {
  const m = new Map([...Object.entries(adv)].map(([c, a]) => [c.codePointAt(0)!, a]));
  return { advance: (cp) => m.get(cp), lineHeight: ascent + descent, ascent, descent };
};
const CELL = '기승전결을 명확히 하고, 요점은 가능하다면 3가지 이내로 정리한다.';
/** This computer's Hangul face (WenQuanYi Zen Hei's 1 em letters and its space, its 1.2598 em line). */
const hangul = face(
  { ...Object.fromEntries([...new Set(CELL.replace(/[^가-힣]/g, ''))].map((c) => [c, 1])), ' ': 0.299 },
  0.963,
  0.297,
);
/** ordo's default face for the Latin characters (Inter's widths, about). */
const inter = face({ ',': 0.27, '.': 0.28, '3': 0.62, ' ': 0.281 }, 0.969, 0.241);
const faces: FaceSource = (family) => (family === 'Inter' ? inter : undefined);
faces.script = (code) => (code === 'Hang' ? hangul : undefined);
const body = (p: Para): TextBody => ({
  paras: [p],
  insets: { l: 0, t: 0, r: 0, b: 0 },
  anchor: 'top',
  wrap: true,
  autofit: { kind: 'none' },
});

describe("the Korean bulletin's slide 20 cell in LibreOffice's model (gaps-flip B.1 item 4)", () => {
  it('takes 3 lines with the gaps where it took 2: "정리한다." goes to a third line', () => {
    // Column 3 is 5,019,760 EMU less 2 x 7.2 pt of margins: 380.9 pt of text, 761.7 px on a 1920 px slide.
    const m = new Measure(frameOf(12_192_000, 6_858_000), faces);
    const w = 380.85 * 2;
    const p = paraOf([CELL, 24]);
    expect(m.loLayout(body(p), w, 'font').drawn.baselines).toHaveLength(2);
    expect(m.loLayout(body(loAsianGaps(p)), w, 'font').drawn.baselines).toHaveLength(3);
    // ordo's own drawing has no gap: its lines are those of the text as stored.
    expect(m.layout(body(p), w).baselines).toHaveLength(2);
  });
});
