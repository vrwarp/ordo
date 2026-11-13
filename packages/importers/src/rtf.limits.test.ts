/**
 * Resource bounds of the RTF reader (review 2026-11-04 finding 6): 100 MB of `\par` used to cost 618 MB
 * (a 20 million line string, then split). Output is now bounded while reading and leading blank lines are
 * dropped as they arrive, so the floods below run in a worker whose heap holds little more than the input.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBounded } from './bounded-run.test-util.ts';
import { parseRtf, RTF_TEXT_MAX } from './rtf.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const RTF = fileURLToPath(new URL('./rtf.ts', import.meta.url));

describe('parseRtf resource bounds', () => {
  it('100 MB of \\par after the text runs in a 200 MB heap and keeps the text', async () => {
    const r = await runBounded(
      RTF,
      `const src = '{\\\\rtf1 Amazing grace' + '\\\\par '.repeat(20_000_000) + '}';
       const out = mod.parseRtf(src);
       return { len: src.length, text: out.text };`,
      null,
      200,
    );
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ len: 100_000_021, text: 'Amazing grace' });
  }, 60_000);

  it('100 MB of \\par before the text runs in a 200 MB heap and finds the text', async () => {
    const r = await runBounded(
      RTF,
      `const src = '{\\\\rtf1 ' + '\\\\par '.repeat(20_000_000) + '  how sweet\\\\par the sound}';
       return mod.parseRtf(src).text;`,
      null,
      200,
    );
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) expect(r.value).toBe('  how sweet\nthe sound');
  }, 60_000);

  it('text beyond the bound is dropped while reading', () => {
    const r = parseRtf(`{\\rtf1 ${'word '.repeat(50_000)}}`);
    expect(r.text.length).toBeLessThanOrEqual(RTF_TEXT_MAX);
    expect(r.text.startsWith('word word')).toBe(true);
  });

  it('leading blank lines are dropped as before, keeping leading spaces of the first line', () => {
    expect(parseRtf('{\\rtf1 \\par \\par  \\~\\par    two  \\par}').text).toBe('   two');
    expect(parseRtf('{\\rtf1 \\par\\tab\\par x}').text).toBe('x');
  });

  it('\\binN skips N bytes of binary data, which may hold braces and backslashes', () => {
    expect(parseRtf('{\\rtf1 before {\\pict\\bin6 }{\\x\\}} after}').text).toBe('before  after');
    expect(parseRtf('{\\rtf1 a\\bin3 {{{b}').text).toBe('ab');
    expect(parseRtf('{\\rtf1 a\\bin999 xyz').text).toBe('a');
  });

  it('finishes quickly (< 2s) with bounded spans and paras on 50,000 style switches and bullet paragraphs', () => {
    const flood =
      '{\\rtf1{\\colortbl;\\red255\\green0\\blue0;\\red0\\green0\\blue255;}' +
      '{\\listtext •\\tab}\\cf1 a\\cf2 b\\b bold\\b0 \\i italic\\i0 \\par '.repeat(50_000) +
      '}';
    const t0 = Date.now();
    const r = parseRtf(flood);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(budgetMs(2000));
    expect(r.text.length).toBeLessThanOrEqual(RTF_TEXT_MAX);
    expect((r.spans ?? []).length).toBeLessThanOrEqual(2000);
    expect((r.paras ?? []).length).toBeLessThanOrEqual(1000);
  });

  it('50,000 style switches and bullet paragraphs run in a bounded heap', async () => {
    const r = await runBounded(
      RTF,
      `const src = '{\\\\rtf1{\\\\colortbl;\\\\red255\\\\green0\\\\blue0;\\\\red0\\\\green0\\\\blue255;}' +
         '{\\\\listtext •\\\\tab}\\\\cf1 a\\\\cf2 b\\\\b bold\\\\b0 \\\\par '.repeat(50_000) + '}';
       const out = mod.parseRtf(src);
       return { textLen: out.text.length, spans: out.spans?.length ?? 0, paras: out.paras?.length ?? 0 };`,
      null,
      200,
    );
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      const v = r.value as { textLen: number; spans: number; paras: number };
      expect(v.textLen).toBeLessThanOrEqual(RTF_TEXT_MAX);
      expect(v.spans).toBeLessThanOrEqual(2000);
      expect(v.paras).toBeLessThanOrEqual(1000);
    }
  }, 60_000);
});
