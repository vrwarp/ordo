import { describe, expect, it } from 'vitest';
import { GlyphCoverage, type TextContext, coverageScripts, shippedStack } from './coverage.ts';

/**
 * A browser's font fallback in miniature: each family covers some characters, the generics cover all of
 * them. A character is measured in the first family of the stack that covers it, and its metrics are that
 * family's (the advance and an ink box), so a stack that falls through measures like the generic alone.
 */
function fakeFonts(covers: Record<string, string>) {
  const calls: string[] = [];
  const metrics = (font: string, text: string) => {
    calls.push(`${font}|${text}`);
    const list = font
      .replace(/^.*?\d+px\s+/, '')
      .split(',')
      .map((f) => f.trim());
    for (const [i, f] of list.entries()) {
      if (f === 'serif') return [10, 0, 10, 7, 0];
      if (f === 'monospace') return [20, 0, 20, 7, 0];
      if (covers[f]?.includes(text)) return [100 + i, 1, 90, 70, 2];
    }
    return [0, 0, 0, 0, 0];
  };
  return { metrics, calls };
}

function recorder(font: string): TextContext & { drawn: string[] } {
  const drawn: string[] = [];
  return {
    font,
    drawn,
    fillText(text: string) {
      drawn.push(`fill:${text}`);
    },
    strokeText(text: string) {
      drawn.push(`stroke:${text}`);
    },
  };
}

describe('shipped stacks of a drawn font string', () => {
  it('reads the faces the resolver registered from the serialized font (quoted or not)', () => {
    expect(shippedStack('italic bold 48px o1a2b3c4d, Inter, "Segoe UI", Arial, sans-serif')).toEqual({
      style: 'italic',
      weight: '700',
      faces: ['o1a2b3c4d'],
    });
    expect(shippedStack('600 small-caps 12.5px "o1a2b3c4d", "o00ff00ff", sans-serif')).toEqual({
      style: 'normal',
      weight: '600',
      faces: ['o1a2b3c4d', 'o00ff00ff'],
    });
    expect(shippedStack('48px o1a2b3c4d/1.2 serif')).toBeNull(); // no family list after a line height token
    expect(shippedStack('48px/1.2 o1a2b3c4d')).toEqual({
      style: 'normal',
      weight: '400',
      faces: ['o1a2b3c4d'],
    });
  });

  it('has none when the family is not loaded (its own name, the generic chain)', () => {
    expect(shippedStack('48px Calibri, Inter, "Segoe UI", Arial, sans-serif')).toBeNull();
    expect(shippedStack('48px oABCDEF12')).toBeNull(); // not an internal name (upper-case hex)
    expect(shippedStack('garbage')).toBeNull();
  });
});

describe('glyph coverage', () => {
  it('reports what no shipped face covers, once probed per stack', () => {
    const f = fakeFonts({ o11111111: 'abc', o22222222: 'xyz' });
    const cov = new GlyphCoverage(f.metrics);
    const ctx = recorder('bold 40px o11111111, o22222222, Inter, sans-serif');
    cov.instrument(ctx);
    cov.begin();
    ctx.fillText('ab x☧ c', 0, 0);
    ctx.strokeText('ab x☧ c', 0, 0);
    const drawn = cov.end();
    expect(ctx.drawn).toEqual(['fill:ab x☧ c', 'stroke:ab x☧ c']); // drawing itself unchanged
    expect(cov.misses(drawn)).toBe('☧');
    const probes = f.calls.length;
    // a, b, x and c: two measures each (the first pair differs); ☧: all four. The space is skipped.
    expect(probes).toBe(4 * 2 + 4);
    // The same characters at another size and on another draw: no probe again.
    ctx.font = 'bold 72px o11111111, o22222222, Inter, sans-serif';
    cov.begin();
    ctx.fillText('cab☧', 0, 0);
    expect(cov.misses(cov.end())).toBe('☧');
    expect(f.calls.length).toBe(probes);
  });

  it('probes a bounded number of new characters per call (slices of the asset worker)', () => {
    const f = fakeFonts({ o11111111: 'abcdefgh' });
    const cov = new GlyphCoverage(f.metrics);
    const ctx = recorder('40px o11111111, sans-serif');
    cov.instrument(ctx);
    cov.begin();
    ctx.fillText('abcdefgh☧', 0, 0);
    const drawn = cov.end();
    expect(cov.probeSome(drawn, 0)).toBe(false); // lookups only: nothing probed
    expect(f.calls).toHaveLength(0);
    expect(cov.probeSome(drawn, 4)).toBe(false);
    const after4 = f.calls.length;
    expect(after4).toBe(4 * 2);
    expect(cov.probeSome(drawn, 4)).toBe(false);
    expect(cov.probeSome(drawn, 4)).toBe(true); // the ninth, ☧
    const probes = f.calls.length;
    expect(cov.probeSome(drawn, 0)).toBe(true);
    expect(cov.misses(drawn)).toBe('☧');
    expect(f.calls.length).toBe(probes); // misses after probeSome: lookups only
  });

  it('probes with the stack, the style and the weight, before two generics and each alone', () => {
    const f = fakeFonts({ o11111111: 'a' });
    const cov = new GlyphCoverage(f.metrics);
    cov.begin();
    cov.note('italic 300 12px o11111111, sans-serif', 'a');
    expect(cov.misses(cov.end())).toBe('');
    expect(f.calls).toEqual(['italic 300 100px o11111111, serif|a', 'italic 300 100px serif|a']);
    f.calls.length = 0;
    cov.begin();
    cov.note('italic 300 12px o11111111, sans-serif', 'b');
    expect(cov.misses(cov.end())).toBe('b');
    expect(f.calls.map((c) => c.replace('|b', ''))).toEqual([
      'italic 300 100px o11111111, serif',
      'italic 300 100px serif',
      'italic 300 100px o11111111, monospace',
      'italic 300 100px monospace',
    ]);
  });

  it('a face that matches one generic is still told apart by the other', () => {
    // The shipped face has the glyph with exactly the serif's metrics (the same font file).
    const cov = new GlyphCoverage((font) =>
      /o1|serif/.test(font.split('px ')[1]!.split(',')[0]!) ? [10] : [20],
    );
    cov.begin();
    cov.note('40px o11111111', 'q');
    expect(cov.misses(cov.end())).toBe('');
  });

  it('notes nothing outside a draw, and nothing for text in a family that is not loaded', () => {
    const f = fakeFonts({});
    const cov = new GlyphCoverage(f.metrics);
    const ctx = recorder('40px o11111111');
    cov.instrument(ctx);
    cov.instrument(ctx); // once
    ctx.fillText('zzz', 0, 0);
    cov.begin();
    ctx.font = '40px Calibri, Inter, sans-serif';
    ctx.fillText('zzz', 0, 0);
    expect(cov.misses(cov.end())).toBe('');
    expect(f.calls).toEqual([]);
    expect(ctx.drawn).toEqual(['fill:zzz', 'fill:zzz']);
  });

  it('skips spaces, controls, joiners and variation selectors', () => {
    const f = fakeFonts({});
    const cov = new GlyphCoverage(f.metrics);
    cov.begin();
    cov.note('40px o11111111', ' \t ‍‏️　 ﻿');
    expect(cov.misses(cov.end())).toBe('');
    expect(f.calls).toEqual([]);
  });

  it('forgets every verdict when the faces change, and stays within its bounds', () => {
    const covers: Record<string, string> = { o11111111: '' };
    const f = fakeFonts(covers);
    const cov = new GlyphCoverage(f.metrics, { maxVerdicts: 3, maxPerDraw: 2 });
    cov.begin();
    cov.note('40px o11111111', 'αβγδ');
    expect(cov.misses(cov.end())).toBe('αβ'); // two characters per draw
    covers.o11111111 = 'αβ'; // a face with them loaded (under the same name, for the test)
    cov.begin();
    cov.note('40px o11111111', 'αβ');
    expect(cov.misses(cov.end())).toBe('αβ'); // still the verdicts from before
    cov.reset();
    cov.begin();
    cov.note('40px o11111111', 'αβ');
    expect(cov.misses(cov.end())).toBe('');
    cov.begin();
    cov.note('40px o11111111', 'γδ');
    expect(cov.misses(cov.end())).toBe('γδ'); // the fourth verdict dropped the first three
  });

  it('never reports a miss its probe could not measure', () => {
    const cov = new GlyphCoverage(() => {
      throw new Error('no canvas');
    });
    cov.begin();
    cov.note('40px o11111111', '中');
    expect(cov.misses(cov.end())).toBe('');
  });

  it('caps what one report lists, in code point order', () => {
    const cov = new GlyphCoverage(fakeFonts({}).metrics);
    cov.begin();
    cov.note('40px o11111111', 'zyxwv');
    expect(cov.misses(cov.end(), 3)).toBe('vwx');
  });
});

describe('scripts of uncovered characters', () => {
  it('names fallback scripts, Latin, emoji, marks and the rest', () => {
    expect(coverageScripts('אa中😀́☧')).toEqual(['Hani', 'Hebr', 'Latn', 'Zinh', 'Zsye', 'Zyyy']);
    expect(coverageScripts('')).toEqual([]);
  });
});
