import type { Font } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/config.ts';
import { GOOGLE_LIMITS, normalizeUnicodeRange, parseFontCss } from '../src/fonts/google.ts';
import { EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

describe('unicode-range (Font.unicodeRange)', () => {
  it('is stored sorted, merged and compact', () => {
    expect(normalizeUnicodeRange('U+0000-00FF, U+0131, U+0152-0153')).toBe('U+0-FF,U+131,U+152-153');
    expect(normalizeUnicodeRange('u+2000-206f,U+0100-024F,u+0250-02af')).toBe('U+100-2AF,U+2000-206F');
    expect(normalizeUnicodeRange('U+4??, U+20')).toBe('U+20,U+400-4FF');
    // Malformed tokens are dropped; nothing usable or the whole code space is no range at all.
    expect(normalizeUnicodeRange('U+41, bogus, U+ZZ, U+5?6, U+30-20, U+110000')).toBe('U+41');
    expect(normalizeUnicodeRange('nonsense')).toBeUndefined();
    expect(normalizeUnicodeRange('U+0-10FFFF')).toBeUndefined();
    expect(normalizeUnicodeRange('U+0-7F, U+80-10FFFF')).toBeUndefined();
  });

  it('coarsens a range list longer than the bound by merging the closest neighbours', () => {
    // 2,000 single code points two apart: about 14,000 characters.
    const raw = Array.from({ length: 2000 }, (_, i) => `U+${(0x4e00 + i * 2).toString(16)}`).join(', ');
    const out = normalizeUnicodeRange(raw)!;
    expect(out.length).toBeLessThanOrEqual(GOOGLE_LIMITS.rangeChars);
    // Every original code point is still inside a range.
    const ranges = out.split(',').map((t) =>
      t
        .slice(2)
        .split('-')
        .map((h) => Number.parseInt(h, 16)),
    );
    for (let i = 0; i < 2000; i++) {
      const c = 0x4e00 + i * 2;
      expect(ranges.some(([lo, hi = lo]) => c >= lo! && c <= hi!)).toBe(true);
    }
    expect(normalizeUnicodeRange(raw, 11)).toBe('U+4E00-5D9E');
    // Not even one range fits: no range (the face is tried for everything, a wider net).
    expect(normalizeUnicodeRange(raw, 10)).toBeUndefined();
  });
});

/** Google's CSS for a CJK family: `slices` unicode-range subsets for each weight. */
function cjkCss(weights: number[], slices: number): string {
  const blocks: string[] = [];
  for (const w of weights)
    for (let s = 0; s < slices; s++) {
      const lo = 0x4e00 + s * 0x100;
      blocks.push(`/* [${s}] */
@font-face {
  font-family: 'Noto Sans KR';
  font-style: normal;
  font-weight: ${w};
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/notosanskr/v1/${w}-${s}.woff2) format('woff2');
  unicode-range: U+${lo.toString(16)}-${(lo + 0xff).toString(16)};
}`);
    }
  return blocks.join('\n');
}

describe('Google Fonts subsets', () => {
  it('keeps every subset, and fewer weights for families with very many', () => {
    const few = parseFontCss(cjkCss([400, 700], 3));
    expect(few.map((f) => `${f.weights[0]} ${f.unicodeRange}`)).toEqual([
      '400 U+4E00-4EFF',
      '400 U+4F00-4FFF',
      '400 U+5000-50FF',
      '700 U+4E00-4EFF',
      '700 U+4F00-4FFF',
      '700 U+5000-50FF',
    ]);
    // Nine weights of 100 slices: only the ones nearest 400 and 700 are kept.
    const many = parseFontCss(cjkCss([100, 200, 300, 400, 500, 600, 700, 800, 900], 100));
    expect(many.length).toBe(200);
    expect([...new Set(many.map((f) => f.weights[0]))]).toEqual([400, 700]);
    // Still too many: only the regular weight.
    const huge = parseFontCss(cjkCss([300, 500, 800], 300));
    expect(huge.length).toBe(300);
    expect([...new Set(huge.map((f) => f.weights[0]))]).toEqual([300]);
  });

  it('stores each subset as a face and replaces the family’s earlier faces', async () => {
    let css = cjkCss([400], 3);
    const fetched: string[] = [];
    const fakeFetch: FetchLike = async (url) => {
      fetched.push(url);
      const ok = (body: string | Uint8Array) => ({
        ok: true,
        status: 200,
        text: async () => body.toString(),
        arrayBuffer: async () => {
          const b = Buffer.from(body);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        },
      });
      if (url.startsWith('https://fonts.googleapis.com/')) return ok(css);
      // A distinct WOFF2-looking file per URL (only the signature is checked when storing).
      return ok(Buffer.concat([Buffer.from('wOF2'), Buffer.from(url)]));
    };
    hub = await startHub({ fetch: fakeFetch });
    const ed = await login(hub.url, EDIT_PIN);
    // A face from a download made before subsets were kept: the latin part only, without a range.
    const legacy = hub.lib.upsertFont({
      family: 'Noto Sans KR',
      weight: 400,
      style: 'normal',
      file: { hash: 'c'.repeat(64), bytes: 3, mime: 'font/woff2', path: `fonts/${'c'.repeat(64)}.woff2` },
      source: 'google',
    });
    const run = async () => {
      const job = await ed.json<Job>('/fonts/google', { method: 'POST', json: { family: 'Noto Sans KR' } });
      await hub!.jobs.idle();
      expect((await ed.json<Job>(`/jobs/${job.id}`)).state).toBe('done');
      return (await ed.json<Font[]>('/fonts')).filter((f) => f.family === 'Noto Sans KR');
    };
    const first = await run();
    expect(first.map((f) => f.unicodeRange).sort()).toEqual(['U+4E00-4EFF', 'U+4F00-4FFF', 'U+5000-50FF']);
    expect(first.some((f) => f.id === legacy.id)).toBe(false);
    expect(new Set(first.map((f) => f.file.hash)).size).toBe(3);

    // Google drops a slice and adds another: the family is what this download stored.
    css = cjkCss([400], 4).replace(/\/\* \[1\] \*\/\n@font-face \{[^}]*\}/, '');
    const second = await run();
    expect(second.map((f) => f.unicodeRange).sort()).toEqual(['U+4E00-4EFF', 'U+5000-50FF', 'U+5100-51FF']);
    const kept = first.find((f) => f.unicodeRange === 'U+4E00-4EFF')!;
    expect(second.find((f) => f.unicodeRange === 'U+4E00-4EFF')?.id).toBe(kept.id);
    const dropped = first.find((f) => f.unicodeRange === 'U+4F00-4FFF')!;
    expect(hub.lib.getFile(dropped.file.hash)).toBeUndefined();
  });
});
