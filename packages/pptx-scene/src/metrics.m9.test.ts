import * as reader from '@ordo/renderer/text/sfnt/reader.ts';
import { describe, expect, it } from 'vitest';
import { frameOf } from './frame.ts';
import { faceSources, MAX_SCRIPT_LOOKUPS } from './index.ts';
import type { Para, RunStyle } from './ir.ts';
import {
  advanceOf,
  ESTIMATED_ADVANCE,
  type FaceSource,
  heightOf,
  metricsOfTables,
  SFNT_LIMITS,
  sfntMetrics,
} from './metrics.ts';
import { Measure } from './tables.ts';
import { sfntFont } from './test-util.ts';

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
const paraOf = (text: string, sizePt = 18): Para => ({
  runs: [{ kind: 'text', text, style: { ...style, sizePt } }],
  align: 'left',
  level: 0,
  marL: 0,
  indent: 0,
  rtl: false,
  end: { ...style, sizePt },
});

describe('the sfnt move (M9: @ordo/renderer/text/sfnt)', () => {
  it('metrics.ts re-exports the renderer sfnt reader, so FaceMetrics are those of one reader', () => {
    expect(sfntMetrics).toBe(reader.sfntMetrics);
    expect(metricsOfTables).toBe(reader.metricsOfTables);
    expect(SFNT_LIMITS).toBe(reader.SFNT_LIMITS);
    const font = sfntFont({ A: 600, V: 700 }, { kern: { pairs: [['A', 'V', -80]] } });
    const m = reader.sfntMetrics(font)!;
    expect(m.advance(0x41)).toBe(0.6);
    expect(m.kern?.(0x41, 0x56)).toBeCloseTo(-0.08, 9);
  });
});

describe('the M9 measurement seams', () => {
  const face = sfntMetrics(sfntFont({ A: 600, V: 700, ' ': 250 }, { kern: { pairs: [['A', 'V', -80]] } }))!;
  const faces: FaceSource = (family) => (family === 'Carlito' ? face : undefined);

  it('advanceOf measures a line in em through the family, then its fallbacks, kerned, estimated past them', () => {
    expect(advanceOf(faces, 'AV', { family: 'Carlito', bold: false, italic: false })).toBeCloseTo(1.22, 9);
    // A family without a face falls back; a bold face falls back to the regular one.
    expect(
      advanceOf(faces, 'A A', { family: 'Calibri', bold: true, italic: false }, ['Carlito']),
    ).toBeCloseTo(1.45, 9);
    // A character no face has is estimated, and so is everything without faces.
    expect(advanceOf(faces, 'A€', { family: 'Carlito', bold: false, italic: false })).toBeCloseTo(
      0.6 + ESTIMATED_ADVANCE,
      9,
    );
    expect(advanceOf(undefined, 'abc', { family: 'Carlito', bold: false, italic: false })).toBeCloseTo(
      3 * ESTIMATED_ADVANCE,
      9,
    );
    // A source that throws is no face.
    const broken: FaceSource = () => {
      throw new Error('bad font');
    };
    expect(advanceOf(broken, 'A', { family: 'X', bold: false, italic: false })).toBe(ESTIMATED_ADVANCE);
  });

  it("heightOf lays paragraphs out with tables.ts's Measure, at a given size or their own", () => {
    const m = new Measure(frameOf(12_192_000, 6_858_000), faces);
    const own = heightOf(m, [paraOf('A', 18)], 1_000);
    const big = heightOf(m, [paraOf('A', 18)], 1_000, 36);
    expect(own).toBeGreaterThan(0);
    expect(big).toBeCloseTo(2 * own, 6);
    // Narrow enough to wrap, two lines.
    const two = heightOf(m, [paraOf('AV AV AV AV', 18)], 60);
    expect(two).toBeGreaterThan(own * 1.5);
    // Bounded inputs: never NaN or negative.
    expect(heightOf(m, [paraOf('A')], Number.NaN, Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(0);
    expect(heightOf(m, [], 100)).toBe(0);
  });

  it('a FaceSource may answer script faces, asked once per script, checked, bounded', () => {
    let asked = 0;
    const withScript: FaceSource = Object.assign(() => face, {
      script: (code: string) => {
        asked++;
        if (code === 'Bad') throw new Error('bad font');
        return code === 'Hang' ? face : undefined;
      },
    });
    const wrapped = faceSources(withScript)!;
    expect(wrapped.script?.('Hang')).toBe(face);
    expect(wrapped.script?.('Hang')).toBe(face);
    expect(asked).toBe(1);
    expect(wrapped.script?.('Bad')).toBeUndefined();
    for (let i = 0; i < 100; i++) wrapped.script?.(`S${i}`);
    expect(asked).toBe(MAX_SCRIPT_LOOKUPS);
    // A source without it stays without it.
    expect(faceSources(faces)!.script).toBeUndefined();
  });
});
