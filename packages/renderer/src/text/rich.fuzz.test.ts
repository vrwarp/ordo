import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TextObject } from '@ordo/domain';
import { CLAMP } from '../clamp.ts';
import { LEGACY_FONT_ENV } from './fonts.ts';
import { SCRIPT_SCALE } from './office.ts';
import { paintRich } from './paint.ts';
import { clampTextObject, layoutRich } from './rich.ts';
import { recordingCtx, testMeasurer } from './test-util.ts';

/**
 * The rich engine on hostile input (design/25, design/27 §12): random text objects with every rich field,
 * within and far beyond the bounds. It never throws, and every position, size and offset it hands to the
 * painter is finite and in range. Every stage owner keeps this passing.
 */

const wild = fc.oneof(
  fc.double({ noNaN: false }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1e308, 0, -0, 1e9),
  fc.constant(undefined),
  fc.string({ maxLength: 3 }),
);
const n = (lo: number, hi: number) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.double({ min: lo, max: hi, noNaN: true }) },
    { weight: 1, arbitrary: wild },
  );
const int = (lo: number, hi: number) =>
  fc.oneof({ weight: 4, arbitrary: fc.integer({ min: lo, max: hi }) }, { weight: 1, arbitrary: wild });
const color = fc.record({ r: n(0, 255), g: n(0, 255), b: n(0, 255), a: n(0, 1) });
const text = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc
    .array(
      fc.constantFrom('word', ' ', '\n', ' ', 'שָׁלוֹם', 'مرحبا', 'க்ஷி', '漢字', '😀', '\t', 'x'.repeat(60)),
      {
        maxLength: 80,
      },
    )
    .map((a) => a.join('')),
  fc.nat({ max: 3000 }).map((k) => 'word '.repeat(Math.ceil(k / 5)).slice(0, k)),
);
const run = fc.record(
  {
    start: int(-5, 400),
    end: int(-5, 400),
    fontFamily: fc.constantFrom('Inter', 'Noto Sans Hebrew', '"; x', ''),
    fontWeight: n(-10, 2000),
    fontStyle: fc.constantFrom('normal', 'italic', 'oblique'),
    sizeScale: n(0, 100),
    color,
    highlight: color,
    underline: fc.boolean(),
    strike: fc.boolean(),
    baseline: n(-2, 2),
    letterSpacing: n(-2000, 2000),
    caps: fc.constantFrom('none', 'all', 'small', 'title'),
    outline: fc.oneof(fc.constant(null), fc.record({ width: n(0, 50), color })),
    shadow: fc.oneof(fc.constant(null), fc.record({ dx: n(-50, 50), dy: n(-50, 50), blur: n(0, 50), color })),
    lang: fc.constantFrom('en', 'he', 'ar', '', 'x"y'),
  },
  { requiredKeys: ['start', 'end'] },
);
const para = fc.oneof(
  fc.constant(null),
  fc.record(
    {
      align: fc.constantFrom('left', 'center', 'right', 'justify', 'distribute', 'thaiDist'),
      soft: fc.boolean(),
      level: int(-1, 12),
      indentPx: n(-3000, 3000),
      firstLinePx: n(-3000, 3000),
      spaceBeforePx: n(-10, 3000),
      spaceAfterPx: n(-10, 3000),
      lineSpacing: n(-1, 20),
      lineSpacingPx: n(-10, 3000),
      bullet: fc.oneof(
        fc.constant(null),
        fc.record({
          char: fc.string({ maxLength: 10 }),
          auto: fc.string({ maxLength: 50 }),
          sizePct: n(0, 10),
        }),
      ),
      rtl: fc.boolean(),
      hidden: fc.boolean(),
    },
    { requiredKeys: [] },
  ),
);
const object = fc
  .record(
    {
      text,
      box: fc.record({
        x: n(-5000, 5000),
        y: n(-5000, 5000),
        w: n(-10, 5000),
        h: n(-10, 5000),
        rotation: n(-720, 720),
      }),
      fontSizePx: n(0, 5000),
      lineHeight: n(0, 20),
      lineModel: fc.constantFrom('ordo', 'office', 'vertical'),
      insets: fc.record({ l: n(-10, 3000), t: n(-10, 3000), r: n(-10, 3000), b: n(-10, 3000) }),
      wrap: fc.boolean(),
      autofit: fc.constantFrom('none', 'shrink', 'grow'),
      fitScale: fc.record({ font: n(0, 2), spacing: n(-1, 2) }),
      valign: fc.constantFrom('top', 'middle', 'bottom'),
      direction: fc.constantFrom('ltr', 'rtl', 'auto', 'ttb'),
      fallbackFonts: fc.array(fc.constantFrom('Carlito', '', 'Noto Naskh Arabic'), { maxLength: 12 }),
      runs: fc.array(run, { maxLength: 30 }),
      paras: fc.array(para, { maxLength: 30 }),
    },
    { requiredKeys: ['text', 'box', 'runs'] },
  )
  .map(
    (r) =>
      ({
        id: 'f',
        type: 'text',
        box: r.box,
        text: r.text,
        opacity: 1,
        runs: r.runs,
        paras: r.paras,
        style: {
          fontFamily: 'Inter',
          fontWeight: 400,
          fontStyle: 'normal',
          fontSizePx: r.fontSizePx,
          color: { r: 255, g: 255, b: 255, a: 1 },
          align: 'center',
          valign: r.valign,
          lineHeight: r.lineHeight,
          letterSpacing: 0,
          padding: 0,
          transform: 'none',
          lineModel: r.lineModel,
          insets: r.insets,
          wrap: r.wrap,
          autofit: r.autofit,
          fitScale: r.fitScale,
          direction: r.direction,
          fallbackFonts: r.fallbackFonts,
        },
      }) as unknown as TextObject,
  );

const finite = (v: number) => Number.isFinite(v);

describe('rich text engine fuzz', () => {
  it('lays out and paints any object within bounds without throwing', () => {
    fc.assert(
      fc.property(object, fc.constantFrom(0.5, 1, 2), (raw, scale) => {
        const o = clampTextObject(raw);
        const l = layoutRich(testMeasurer(), o, LEGACY_FONT_ENV);
        for (const v of [l.fontScale, l.spacingScale, l.ink.x, l.ink.y, l.ink.w, l.ink.h])
          expect(finite(v)).toBe(true);
        let prevTop = Number.NEGATIVE_INFINITY;
        for (const line of l.lines) {
          for (const v of [line.top, line.baseline, line.height, line.x, line.w, line.extraPerSpace])
            expect(finite(v)).toBe(true);
          expect(line.top).toBeGreaterThanOrEqual(prevTop);
          prevTop = line.top;
          expect(line.para).toBeGreaterThanOrEqual(0);
          for (const s of line.segs) {
            expect(s.start).toBeGreaterThanOrEqual(0);
            expect(s.end).toBeGreaterThan(s.start);
            expect(s.end).toBeLessThanOrEqual(o.text.length);
            expect(s.run).toBeLessThan(o.runs?.length ?? 0);
            for (const v of [s.x, s.w, s.sizePx, s.shift]) expect(finite(v)).toBe(true);
            expect(s.sizePx).toBeGreaterThanOrEqual(CLAMP.minFontPx * SCRIPT_SCALE - 1e-9);
            expect(s.sizePx).toBeLessThanOrEqual(CLAMP.maxFontPx);
          }
        }
        paintRich(recordingCtx(), o, l, scale, LEGACY_FONT_ENV);
      }),
      { numRuns: 100 },
    );
  });
});
