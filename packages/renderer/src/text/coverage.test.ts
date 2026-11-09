import { describe, expect, it } from 'vitest';
import {
  GlyphCoverage,
  type ProbeBlank,
  type TextContext,
  coverageScripts,
  shippedStack,
} from './coverage.ts';

/** The blank face as the probe sees it (`registerBlankFace`), loaded. */
const BLANK = { family: '"o-blank-0badf00d"', ready: true } satisfies ProbeBlank;

/**
 * A browser's font fallback in miniature: each family covers some characters and the blank face covers all
 * of them with an empty glyph of no advance. A character is measured in the first family of the stack that
 * covers it, and its metrics are that family's (the advance and an ink box). A stack that falls through
 * every family gets the computer's own answer, which depends on the stack's first family (Chromium draws
 * the .notdef box of the first family where no face has the character).
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
      if (f === BLANK.family) return [0, 0, 0, 0, 0];
      if (covers[f]?.includes(text)) return [100 + i, 1, 90, 70, 2];
    }
    return [list[0]!.length, 0, list[0]!.length, 7, 0];
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
    const cov = new GlyphCoverage(f.metrics, BLANK);
    const ctx = recorder('bold 40px o11111111, o22222222, Inter, sans-serif');
    cov.instrument(ctx);
    cov.begin();
    ctx.fillText('ab x☧ c', 0, 0);
    ctx.strokeText('ab x☧ c', 0, 0);
    const drawn = cov.end();
    expect(ctx.drawn).toEqual(['fill:ab x☧ c', 'stroke:ab x☧ c']); // drawing itself unchanged
    expect(cov.misses(drawn)).toBe('☧');
    const probes = f.calls.length;
    // a, b, x, c and ☧: two measures each (the stack, the blank face alone). The space is skipped.
    expect(probes).toBe(5 * 2);
    // The same characters at another size and on another draw: no probe again.
    ctx.font = 'bold 72px o11111111, o22222222, Inter, sans-serif';
    cov.begin();
    ctx.fillText('cab☧', 0, 0);
    expect(cov.misses(cov.end())).toBe('☧');
    expect(f.calls.length).toBe(probes);
  });

  it('probes a bounded number of new characters per call (slices of the asset worker)', () => {
    const f = fakeFonts({ o11111111: 'abcdefgh' });
    const cov = new GlyphCoverage(f.metrics, BLANK);
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

  it('probes with the stack, the style and the weight, before the blank face and the blank face alone', () => {
    const f = fakeFonts({ o11111111: 'a' });
    const cov = new GlyphCoverage(f.metrics, BLANK);
    cov.begin();
    cov.note('italic 300 12px o11111111, o22222222, sans-serif', 'ab');
    expect(cov.misses(cov.end())).toBe('b');
    expect(f.calls).toEqual([
      'italic 300 100px o11111111, o22222222, "o-blank-0badf00d"|a',
      'italic 300 100px "o-blank-0badf00d"|a',
      'italic 300 100px o11111111, o22222222, "o-blank-0badf00d"|b',
      'italic 300 100px "o-blank-0badf00d"|b',
    ]);
  });

  it("never asks the computer's fonts, whose answer depends on the stack's first family", () => {
    // What the probe of two generic families got wrong on a computer with no face for these characters:
    // each stack fell through to a .notdef box of its first family, so the shipped stack differed from its
    // generic alone and the characters passed for covered.
    const f = fakeFonts({ o11111111: 'Grace' });
    const cov = new GlyphCoverage(f.metrics, BLANK);
    cov.begin();
    cov.note('700 64px o11111111, Inter, sans-serif', 'Grace 中文 ก 🕊');
    expect(cov.misses(cov.end())).toBe('ก中文🕊');
    expect(f.metrics('700 100px o11111111, serif', '中')).not.toEqual(f.metrics('700 100px serif', '中'));
  });

  it('tells a covered mark of no advance by its ink', () => {
    const cov = new GlyphCoverage(
      (font) => (font.includes('o11111111') ? [0, -8, 30, 80, -60] : [0, 0, 0, 0, 0]),
      BLANK,
    );
    cov.begin();
    cov.note('40px o11111111', '\u0301');
    expect(cov.misses(cov.end())).toBe('');
  });

  it('gives no verdict and reports nothing before the blank face is ready', () => {
    const f = fakeFonts({ o11111111: 'a' });
    const blank = { family: BLANK.family, ready: false };
    const cov = new GlyphCoverage(f.metrics, blank);
    cov.begin();
    cov.note('40px o11111111', 'a中');
    const drawn = cov.end();
    expect(cov.probeSome(drawn, 8)).toBe(true); // nothing can be probed yet
    expect(cov.misses(drawn)).toBe('');
    expect(f.calls).toEqual([]);
    blank.ready = true; // loaded: the same text is probed now, nothing was kept before
    expect(cov.probeSome(drawn, 0)).toBe(false);
    expect(cov.misses(drawn)).toBe('中');
    expect(f.calls).toHaveLength(4);
  });

  it('never reports default-ignorable characters, nor measures them', () => {
    const f = fakeFonts({});
    const cov = new GlyphCoverage(f.metrics, BLANK);
    cov.begin();
    // CGJ, Mongolian FVS1, an invisible operator, a Khmer inherent vowel, a reserved ignorable, a musical
    // format control, a variation selector supplement: all hidden by HarfBuzz.
    cov.note('40px o11111111', '\u034F\u180B\u2064\u17B4\uFFF0\u{1D173}\u{E0100}');
    expect(cov.misses(cov.end())).toBe('');
    expect(f.calls).toEqual([]);
  });

  it('reports the default-ignorables a browser draws (Hangul fillers, shorthand format controls, U+180F)', () => {
    const f = fakeFonts({});
    const cov = new GlyphCoverage(f.metrics, BLANK);
    cov.begin();
    const drawn = '\u115F\u1160\u180F\u3164\uFFA0\u{1BCA0}\u{1BCA3}';
    cov.note('40px o11111111', drawn);
    expect(cov.misses(cov.end())).toBe(drawn);
    expect(f.calls).not.toEqual([]);
  });

  it('notes nothing outside a draw, and nothing for text in a family that is not loaded', () => {
    const f = fakeFonts({});
    const cov = new GlyphCoverage(f.metrics, BLANK);
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
    const cov = new GlyphCoverage(f.metrics, BLANK);
    cov.begin();
    cov.note('40px o11111111', ' \t ‍‏️　 ﻿');
    expect(cov.misses(cov.end())).toBe('');
    expect(f.calls).toEqual([]);
  });

  it('forgets every verdict when the faces change, and stays within its bounds', () => {
    const covers: Record<string, string> = { o11111111: '' };
    const f = fakeFonts(covers);
    const cov = new GlyphCoverage(f.metrics, BLANK, { maxVerdicts: 3, maxPerDraw: 2 });
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
    }, BLANK);
    cov.begin();
    cov.note('40px o11111111', '中');
    expect(cov.misses(cov.end())).toBe('');
  });

  it('caps what one report lists, in code point order', () => {
    const cov = new GlyphCoverage(fakeFonts({}).metrics, BLANK);
    cov.begin();
    cov.note('40px o11111111', 'zyxwv');
    expect(cov.misses(cov.end(), 3)).toBe('vwx');
  });
});

describe('scripts of uncovered characters', () => {
  it('names fallback scripts, Latin, emoji, marks and the rest', () => {
    expect(coverageScripts('אa中😀́☧§')).toEqual(['Hani', 'Hebr', 'Latn', 'Zinh', 'Zsye', 'Zyyy']);
    expect(coverageScripts('')).toEqual([]);
  });
});
