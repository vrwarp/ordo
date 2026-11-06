import { describe, expect, it } from 'vitest';
import { WidthCache, canvasMeasurer, linearWidth, memoMeasurer, type MeasureCtx } from './measure.ts';
import { testMeasurer } from './test-util.ts';

/** A context that measures 10 px per character plus Canvas's letter spacing after each, and logs its state. */
function stateCtx() {
  const seen: { font: string; direction: string; lang: string; letterSpacing: string; text: string }[] = [];
  const ctx = {
    font: '10px sans-serif',
    direction: 'inherit' as CanvasDirection,
    lang: 'inherit',
    letterSpacing: '0px',
    saved: [] as string[],
    save() {
      this.saved.push(this.font);
    },
    restore() {
      this.font = this.saved.pop() ?? this.font;
    },
    measureText(text: string) {
      seen.push({
        font: this.font,
        direction: this.direction,
        lang: this.lang,
        letterSpacing: this.letterSpacing,
        text,
      });
      const spacing = Number.parseFloat(this.letterSpacing) || 0;
      return { width: [...text].length * (10 + spacing) } as TextMetrics;
    },
  };
  return { ctx, seen };
}

describe('canvasMeasurer', () => {
  it('measures in the segment state: font, direction, language and letter spacing', () => {
    const { ctx, seen } = stateCtx();
    const m = canvasMeasurer(ctx as unknown as MeasureCtx);
    expect(m.width('20px "A"', 'rtl', 'he', 2, 'abc')).toBe(30 + 3 * 2 - 2);
    expect(seen).toEqual([
      { font: '20px "A"', direction: 'rtl', lang: 'he', letterSpacing: '2px', text: 'abc' },
    ]);
    m.width('20px "A"', 'ltr', '', 0, 'abc');
    expect(seen[1]).toMatchObject({ direction: 'ltr', lang: 'inherit', letterSpacing: '0px' });
  });

  it('caches by font, direction, language, spacing and text', () => {
    const { ctx, seen } = stateCtx();
    const m = canvasMeasurer(ctx as unknown as MeasureCtx);
    m.width('20px "A"', 'ltr', 'en', 0, 'abc');
    m.width('20px "A"', 'ltr', 'en', 0, 'abc');
    expect(seen).toHaveLength(1);
    m.width('20px "A"', 'rtl', 'en', 0, 'abc');
    m.width('20px "A"', 'ltr', 'fr', 0, 'abc');
    m.width('20px "A"', 'ltr', 'en', 1, 'abc');
    m.width('21px "A"', 'ltr', 'en', 0, 'abc');
    expect(seen).toHaveLength(5);
    expect(m.width('20px "A"', 'ltr', 'en', 0, '')).toBe(0);
    expect(seen).toHaveLength(5);
  });

  it('restores the context when isolated, and never caches a non-finite width', () => {
    const { ctx } = stateCtx();
    ctx.font = '12px keep';
    canvasMeasurer(ctx as unknown as MeasureCtx, new WidthCache(), true).width('20px "A"', 'ltr', '', 0, 'x');
    expect(ctx.font).toBe('12px keep');
    const bad = { font: '', measureText: () => ({ width: Number.NaN }) as TextMetrics };
    expect(canvasMeasurer(bad as unknown as MeasureCtx).width('20px "A"', 'ltr', '', 0, 'x')).toBe(0);
  });
});

describe('WidthCache', () => {
  it('evicts the least recently used entry', () => {
    const c = new WidthCache(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect([c.get('a'), c.get('b'), c.get('c')]).toEqual([1, undefined, 3]);
  });
});

describe('autofit helpers', () => {
  it('memoMeasurer measures each string once', () => {
    const t = testMeasurer();
    const m = memoMeasurer(t);
    m.width('20px X', 'ltr', '', 0, 'ab');
    m.width('20px X', 'ltr', '', 0, 'ab');
    m.width('20px X', 'rtl', '', 0, 'ab');
    expect(t.calls).toBe(2);
  });

  it('linearWidth scales the glyphs, not the letter spacing', () => {
    const t = testMeasurer({ em: 0.5 });
    for (const spacing of [0, 3, -2]) {
      const at20 = t.width('20px X', 'ltr', '', spacing, 'abcd');
      const at13 = t.width('13px X', 'ltr', '', spacing, 'abcd');
      expect(linearWidth(at20, 20, 13, spacing, 'abcd')).toBeCloseTo(at13, 9);
    }
    expect(linearWidth(40, 20, 20, 0, 'abcd')).toBe(40);
  });
});
